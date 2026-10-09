'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const AdmZip = require('adm-zip');

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 3000);

const CORE_REPO = process.env.SILA_CORE_REPO || 'siladata2/Yuda';
const CORE_REF = process.env.SILA_CORE_REF || 'main';
const CORE_TOKEN = process.env.SILA_CORE_TOKEN || '';
const CORE_SHA256 = (process.env.SILA_CORE_SHA256 || '')
  .trim()
  .toLowerCase();

const SESSION_ID = process.env.SESSION_ID || '';

const WORK_ROOT = path.join(os.tmpdir(), 'sila-md-loader');
const ZIP_PATH = path.join(WORK_ROOT, 'core.zip');
const EXTRACT_PATH = path.join(WORK_ROOT, 'extracted');
const DASHBOARD_PATH = path.join(__dirname, 'sila', 'index.html');

const STARTED_AT = Date.now();

let coreStarted = false;
let coreError = null;
let dashboardServer = null;

function log(...args) {
  console.log('[SILA MD LOADER]', ...args);
}

function json(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });

  res.end(JSON.stringify(data));
}

function text(res, statusCode, message) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });

  res.end(message);
}

function getUptimeSeconds() {
  return Math.floor((Date.now() - STARTED_AT) / 1000);
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  return `${days}d ${hours}h ${minutes}m ${secs}s`;
}

function requestBuffer(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'SILA-MD-Loader',
          ...headers
        },
        timeout: 30000
      },
      (res) => {
        const chunks = [];

        res.on('data', (chunk) => chunks.push(chunk));

        res.on('end', () => {
          const body = Buffer.concat(chunks);

          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            return reject(
              new Error('GitHub redirect haikukubaliwa kwa ombi hili.')
            );
          }

          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(
              new Error(`Ombi la GitHub limeshindwa: HTTP ${res.statusCode}`)
            );
          }

          resolve(body);
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('Ombi limechukua muda mrefu sana.'));
    });

    req.on('error', reject);
  });
}

async function githubApi(url) {
  const headers = {
    Accept: 'application/vnd.github+json'
  };

  if (CORE_TOKEN) {
    headers.Authorization = `Bearer ${CORE_TOKEN}`;
  }

  return requestBuffer(url, headers);
}

function safeRepoPath(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(root, relativePath);

  if (
    resolvedPath !== resolvedRoot &&
    !resolvedPath.startsWith(resolvedRoot + path.sep)
  ) {
    throw new Error('Njia isiyoruhusiwa ndani ya repository.');
  }

  return resolvedPath;
}

async function downloadAndExtractCore() {
  await fsp.mkdir(WORK_ROOT, { recursive: true });

  await fsp.rm(EXTRACT_PATH, {
    recursive: true,
    force: true
  });

  await fsp.mkdir(EXTRACT_PATH, { recursive: true });

  const repoUrl =
    `https://api.github.com/repos/${CORE_REPO}/zipball/${encodeURIComponent(CORE_REF)}`;

  log('Inapakua private core...');

  const zipBuffer = await githubApi(repoUrl);

  if (CORE_SHA256) {
    const actualHash = crypto
      .createHash('sha256')
      .update(zipBuffer)
      .digest('hex')
      .toLowerCase();

    if (actualHash !== CORE_SHA256) {
      throw new Error('SHA256 ya core haifanani na iliyowekwa.');
    }
  }

  await fsp.writeFile(ZIP_PATH, zipBuffer);

  const zip = new AdmZip(ZIP_PATH);
  const entries = zip.getEntries();

  for (const entry of entries) {
    const entryName = entry.entryName.replace(/\\/g, '/');

    if (
      entryName.startsWith('/') ||
      entryName.split('/').includes('..')
    ) {
      throw new Error('ZIP ina njia isiyoruhusiwa.');
    }

    const destination = safeRepoPath(EXTRACT_PATH, entryName);

    if (entry.isDirectory) {
      await fsp.mkdir(destination, { recursive: true });
      continue;
    }

    await fsp.mkdir(path.dirname(destination), {
      recursive: true
    });

    await fsp.writeFile(destination, entry.getData());
  }

  const folders = await fsp.readdir(EXTRACT_PATH, {
    withFileTypes: true
  });

  const repoFolder = folders.find(
    (entry) => entry.isDirectory()
  );

  if (!repoFolder) {
    throw new Error('Haikuweza kupata folder la core ndani ya ZIP.');
  }

  const corePath = path.join(EXTRACT_PATH, repoFolder.name);

  const packagePath = path.join(corePath, 'package.json');
  const indexPath = path.join(corePath, 'index.js');

  if (!fs.existsSync(packagePath)) {
    throw new Error('package.json haipo kwenye core.');
  }

  if (!fs.existsSync(indexPath)) {
    throw new Error('index.js haipo kwenye core.');
  }

  log('Core imepakuliwa na kutolewa kwenye ZIP.');

  return corePath;
}

async function installCoreDependencies(corePath) {
  const packagePath = path.join(corePath, 'package.json');

  const packageJson = JSON.parse(
    await fsp.readFile(packagePath, 'utf8')
  );

  const dependencies = packageJson.dependencies || {};

  if (Object.keys(dependencies).length === 0) {
    log('Core haina dependencies za kusakinisha.');
    return;
  }

  log('Inasakinisha dependencies za core...');

  await execFileAsync(
    'npm',
    [
      'install',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--allow-git=all'
    ],
    {
      cwd: corePath,
      timeout: 300000,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        SESSION_ID
      }
    }
  );

  log('Dependencies zimekamilika.');
}

function startDashboardServer() {
  if (dashboardServer) {
    return;
  }

  dashboardServer = http.createServer(async (req, res) => {
    const requestUrl = new URL(
      req.url || '/',
      `http://${req.headers.host || 'localhost'}`
    );

    if (requestUrl.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        service: 'SILA MD Loader',
        uptimeSeconds: getUptimeSeconds(),
        uptime: formatUptime(getUptimeSeconds())
      });
    }

    if (requestUrl.pathname === '/api/status') {
      return json(res, 200, {
        ok: true,
        online: coreStarted && !coreError,
        status: coreError
          ? 'error'
          : coreStarted
            ? 'running'
            : 'starting',
        service: 'SILA MD',
        uptimeSeconds: getUptimeSeconds(),
        uptime: formatUptime(getUptimeSeconds()),
        timestamp: new Date().toISOString(),
        error: coreError
          ? 'Core haikuanza vizuri. Angalia logs za Heroku.'
          : null
      });
    }

    if (requestUrl.pathname === '/') {
      try {
        const html = await fsp.readFile(DASHBOARD_PATH, 'utf8');

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff'
        });

        return res.end(html);
      } catch {
        return text(
          res,
          404,
          'Dashboard haijapatikana. Hakikisha file ipo: sila/index.html'
        );
      }
    }

    if (requestUrl.pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }

    return json(res, 404, {
      ok: false,
      error: 'Route haijapatikana.'
    });
  });

  dashboardServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log(
        `PORT ${PORT} tayari inatumika. Dashboard server haijaanzishwa. ` +
        'Huenda core ina server yake kwenye port hii.'
      );
      return;
    }

    log('Dashboard server error:', err.message);
  });

  dashboardServer.listen(PORT, '0.0.0.0', () => {
    log(`Dashboard inasikiliza kwenye port ${PORT}.`);
  });
}

async function startCore() {
  const corePath = await downloadAndExtractCore();

  await installCoreDependencies(corePath);

  const coreIndexPath = path.join(corePath, 'index.js');

  log('Inaanzisha SILA MD core...');

  /*
   * SESSION_ID inapatikana kwenye process.env kwa core.
   * Usiiandike kwenye logs wala kuionyesha kwenye dashboard.
   */

  try {
    require(coreIndexPath);

    coreStarted = true;
    log('Core entry point imeitwa.');
  } catch (err) {
    coreError = err.message;
    throw err;
  }
}

async function main() {
  /*
   * Kumbuka: kama core yenyewe inachukua PORT ya Heroku,
   * server hii ya dashboard haitapata port hiyo.
   */
  startDashboardServer();

  try {
    await startCore();
  } catch (err) {
    coreError = err.message || 'Core startup failed';
    log('Core imeshindwa kuanza:', coreError);
    process.exitCode = 1;
  }
}

process.on('unhandledRejection', (err) => {
  log(
    'Unhandled rejection:',
    err && err.message ? err.message : String(err)
  );
});

process.on('uncaughtException', (err) => {
  log(
    'Uncaught exception:',
    err && err.message ? err.message : String(err)
  );
});

main();