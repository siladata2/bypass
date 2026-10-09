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

// ================================
// CONFIGURATION
// ================================

const PORT = Number(process.env.PORT || 3000);

const CORE_REPO =
  process.env.SILA_CORE_REPO || 'siladata2/Yuda';

const CORE_REF =
  process.env.SILA_CORE_REF || 'main';

const CORE_TOKEN =
  process.env.SILA_CORE_TOKEN || '';

const CORE_SHA256 =
  (process.env.SILA_CORE_SHA256 || '').trim().toLowerCase();

const SESSION_ID =
  process.env.SESSION_ID || '';

const WORK_ROOT = path.join(
  os.tmpdir(),
  'sila-md-loader'
);

const ZIP_PATH = path.join(
  WORK_ROOT,
  'core.zip'
);

const EXTRACT_PATH = path.join(
  WORK_ROOT,
  'extracted'
);

const DASHBOARD_PATH = path.join(
  __dirname,
  'sila',
  'index.html'
);

const STARTED_AT = Date.now();

let coreStarted = false;
let coreError = null;
let corePath = null;
let dashboardServer = null;

// ================================
// LOGGING
// ================================

function log(...args) {
  console.log('[SILA MD LOADER]', ...args);
}

// ================================
// HTTP HELPERS
// ================================

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });

  res.end(JSON.stringify(data));
}

function sendText(res, statusCode, message) {
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

// ================================
// HTTPS REQUEST WITH REDIRECTS
// ================================

function requestBuffer(url, headers = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      return reject(
        new Error('GitHub redirects zimezidi kikomo.')
      );
    }

    let parsedUrl;

    try {
      parsedUrl = new URL(url);
    } catch {
      return reject(new Error('URL ya GitHub si sahihi.'));
    }

    if (parsedUrl.protocol !== 'https:') {
      return reject(
        new Error('URL ya download lazima itumie HTTPS.')
      );
    }

    const req = https.get(
      parsedUrl,
      {
        headers: {
          'User-Agent': 'SILA-MD-Loader',
          ...headers
        },
        timeout: 30000
      },
      (res) => {
        const status = res.statusCode || 0;

        if (
          [301, 302, 303, 307, 308].includes(status) &&
          res.headers.location
        ) {
          const redirectUrl = new URL(
            res.headers.location,
            parsedUrl
          );

          res.resume();

          if (redirectUrl.protocol !== 'https:') {
            return reject(
              new Error('GitHub imerudisha redirect isiyo salama.')
            );
          }

          const nextHeaders = { ...headers };

          // Linda GitHub token: usiitume kwa host nyingine.
          if (
            redirectUrl.hostname !== parsedUrl.hostname
          ) {
            delete nextHeaders.Authorization;
            delete nextHeaders.authorization;
          }

          return resolve(
            requestBuffer(
              redirectUrl.href,
              nextHeaders,
              redirects + 1
            )
          );
        }

        const chunks = [];

        res.on('data', (chunk) => {
          chunks.push(chunk);
        });

        res.on('end', () => {
          if (status < 200 || status >= 300) {
            return reject(
              new Error(
                `GitHub download imeshindwa: HTTP ${status}`
              )
            );
          }

          resolve(Buffer.concat(chunks));
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(
        new Error('GitHub download imechukua muda mrefu.')
      );
    });

    req.on('error', reject);
  });
}

// ================================
// GITHUB API
// ================================

async function githubApi(url) {
  const headers = {
    Accept: 'application/vnd.github+json'
  };

  if (CORE_TOKEN) {
    headers.Authorization = `Bearer ${CORE_TOKEN}`;
  }

  return requestBuffer(url, headers);
}

// ================================
// PATH SAFETY
// ================================

function safeRepoPath(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(root, relativePath);

  if (
    resolvedPath !== resolvedRoot &&
    !resolvedPath.startsWith(resolvedRoot + path.sep)
  ) {
    throw new Error(
      'ZIP ina njia isiyoruhusiwa.'
    );
  }

  return resolvedPath;
}

// ================================
// DOWNLOAD PRIVATE CORE
// ================================

async function downloadAndExtractCore() {
  if (!CORE_REPO.includes('/')) {
    throw new Error(
      'SILA_CORE_REPO lazima iwe owner/repository.'
    );
  }

  await fsp.mkdir(WORK_ROOT, {
    recursive: true
  });

  await fsp.rm(EXTRACT_PATH, {
    recursive: true,
    force: true
  });

  await fsp.mkdir(EXTRACT_PATH, {
    recursive: true
  });

  const repoUrl =
    `https://api.github.com/repos/${CORE_REPO}/zipball/` +
    encodeURIComponent(CORE_REF);

  log('Inapakua private core...');

  const zipBuffer = await githubApi(repoUrl);

  if (CORE_SHA256) {
    const actualHash = crypto
      .createHash('sha256')
      .update(zipBuffer)
      .digest('hex')
      .toLowerCase();

    if (actualHash !== CORE_SHA256) {
      throw new Error(
        'SHA256 ya core haifanani na iliyowekwa.'
      );
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
      throw new Error(
        'ZIP ina njia isiyoruhusiwa.'
      );
    }

    const destination = safeRepoPath(
      EXTRACT_PATH,
      entryName
    );

    if (entry.isDirectory) {
      await fsp.mkdir(destination, {
        recursive: true
      });

      continue;
    }

    await fsp.mkdir(path.dirname(destination), {
      recursive: true
    });

    await fsp.writeFile(
      destination,
      entry.getData()
    );
  }

  const folders = await fsp.readdir(
    EXTRACT_PATH,
    { withFileTypes: true }
  );

  const repoFolder = folders.find(
    (entry) => entry.isDirectory()
  );

  if (!repoFolder) {
    throw new Error(
      'Folder la core halijapatikana ndani ya ZIP.'
    );
  }

  const extractedCorePath = path.join(
    EXTRACT_PATH,
    repoFolder.name
  );

  const packagePath = path.join(
    extractedCorePath,
    'package.json'
  );

  const indexPath = path.join(
    extractedCorePath,
    'index.js'
  );

  if (!fs.existsSync(packagePath)) {
    throw new Error(
      'package.json haipo kwenye core.'
    );
  }

  if (!fs.existsSync(indexPath)) {
    throw new Error(
      'index.js haipo kwenye core.'
    );
  }

  log('Core imepakuliwa na kutolewa kwenye ZIP.');

  return extractedCorePath;
}

// ================================
// INSTALL DEPENDENCIES
// ================================

async function installCoreDependencies(extractedCorePath) {
  const packagePath = path.join(
    extractedCorePath,
    'package.json'
  );

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
      cwd: extractedCorePath,
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

// ================================
// DASHBOARD SERVER
// ================================

function startDashboardServer() {
  dashboardServer = http.createServer(
    async (req, res) => {
      let requestUrl;

      try {
        requestUrl = new URL(
          req.url || '/',
          `http://${req.headers.host || 'localhost'}`
        );
      } catch {
        return sendText(
          res,
          400,
          'Ombi si sahihi.'
        );
      }

      // Health check ya Heroku
      if (requestUrl.pathname === '/health') {
        return sendJson(res, 200, {
          ok: true,
          service: 'SILA MD Loader',
          uptimeSeconds: getUptimeSeconds(),
          uptime: formatUptime(getUptimeSeconds())
        });
      }

      // Dashboard API
      if (requestUrl.pathname === '/api/status') {
        return sendJson(res, 200, {
          ok: true,
          service: 'SILA MD',
          online: coreStarted && !coreError,
          status: coreError
            ? 'error'
            : coreStarted
              ? 'running'
              : 'starting',
          uptimeSeconds: getUptimeSeconds(),
          uptime: formatUptime(getUptimeSeconds()),
          timestamp: new Date().toISOString(),
          error: coreError
            ? 'Core haikuanza. Angalia logs za Heroku.'
            : null
        });
      }

      // Dashboard HTML
      if (requestUrl.pathname === '/') {
        try {
          const html = await fsp.readFile(
            DASHBOARD_PATH,
            'utf8'
          );

          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff'
          });

          return res.end(html);
        } catch {
          return sendText(
            res,
            404,
            'Dashboard haijapatikana. Hakikisha sila/index.html ipo.'
          );
        }
      }

      if (requestUrl.pathname === '/favicon.ico') {
        res.writeHead(204);
        return res.end();
      }

      return sendJson(res, 404, {
        ok: false,
        error: 'Route haijapatikana.'
      });
    }
  );

  dashboardServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log(
        `PORT ${PORT} tayari inatumika. ` +
        'Dashboard server haijaanzishwa; huenda core ina server yake.'
      );

      return;
    }

    log('Dashboard server error:', err.message);
  });

  dashboardServer.listen(
    PORT,
    '0.0.0.0',
    () => {
      log(
        `Dashboard inasikiliza kwenye port ${PORT}.`
      );
    }
  );
}

// ================================
// START CORE
// ================================

async function startCore() {
  corePath = await downloadAndExtractCore();

  await installCoreDependencies(corePath);

  const coreIndexPath = path.join(
    corePath,
    'index.js'
  );

  log('Inaanzisha SILA MD core...');

  // SESSION_ID haionyeshwi kwenye logs au dashboard.
  try {
    require(coreIndexPath);

    coreStarted = true;

    log('Core entry point imeitwa.');
  } catch (err) {
    coreError = err.message || 'Core startup failed';
    throw err;
  }
}

// ================================
// MAIN
// ================================

async function main() {
  startDashboardServer();

  try {
    await startCore();
  } catch (err) {
    coreError = err.message || 'Core startup failed';

    // Usichapishe token au SESSION_ID.
    log('Core imeshindwa kuanza:', coreError);

    process.exitCode = 1;
  }
}

// ================================
// PROCESS ERROR HANDLERS
// ================================

process.on('unhandledRejection', (err) => {
  log(
    'Unhandled rejection:',
    err && err.message
      ? err.message
      : String(err)
  );
});

process.on('uncaughtException', (err) => {
  log(
    'Uncaught exception:',
    err && err.message
      ? err.message
      : String(err)
  );
});

main();