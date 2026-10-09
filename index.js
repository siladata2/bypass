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


/* =========================================
   LOGGING
========================================= */

function log(message) {
  console.log('[SILA MD] ' + message);
}


/* =========================================
   HTTPS REQUEST
========================================= */

function requestBuffer(urlString, extraHeaders, redirectsLeft) {
  const remaining =
    typeof redirectsLeft === 'number' ? redirectsLeft : 5;

  return new Promise((resolve, reject) => {
    let url;

    try {
      url = new URL(urlString);
    } catch (error) {
      reject(new Error('URL si sahihi: ' + urlString));
      return;
    }

    if (url.protocol !== 'https:') {
      reject(
        new Error('HTTPS inahitajika kwa maombi haya.')
      );
      return;
    }

    const headers = {
      'User-Agent': 'SILA-MD-Loader/1.0',
      'Accept':
        'application/vnd.github+json, application/zip, */*'
    };

    /*
      Token inatumwa kwa api.github.com pekee.
      Haitumwi kwa host nyingine wakati wa redirect.
    */

    if (extraHeaders && url.hostname === 'api.github.com') {
      Object.assign(headers, extraHeaders);
    }

    const req = https.get(
      url,
      {
        headers: headers,
        timeout: 30000
      },
      (res) => {
        const status = res.statusCode || 0;
        const location = res.headers.location;

        if (
          [301, 302, 303, 307, 308].includes(status) &&
          location
        ) {
          res.resume();

          if (remaining <= 0) {
            reject(
              new Error('Redirect zimezidi kiwango kinachoruhusiwa.')
            );
            return;
          }

          const nextUrl = new URL(location, url).toString();

          requestBuffer(
            nextUrl,
            extraHeaders,
            remaining - 1
          )
            .then(resolve)
            .catch(reject);

          return;
        }

        const chunks = [];

        res.on('data', (chunk) => {
          chunks.push(chunk);
        });

        res.on('end', () => {
          resolve({
            status: status,
            headers: res.headers,
            body: Buffer.concat(chunks)
          });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(
        new Error('Ombi la GitHub limechukua muda mrefu sana.')
      );
    });

    req.on('error', reject);
  });
}


/* =========================================
   GITHUB API
========================================= */

async function githubApi(endpoint) {
  const response = await requestBuffer(
    'https://api.github.com' + endpoint,
    {
      'Authorization': 'Bearer ' + CORE_TOKEN,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  );

  let data = {};

  try {
    data = JSON.parse(
      response.body.toString('utf8')
    );
  } catch (_) {
    data = {};
  }

  return {
    status: response.status,
    data: data
  };
}


/* =========================================
   VALIDATE REPOSITORY NAME
========================================= */

function safeRepoPath(repo) {
  const valid =
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);

  if (!valid) {
    throw new Error(
      'SILA_CORE_REPO lazima iwe katika muundo owner/repository.'
    );
  }

  return repo
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}


/* =========================================
   DOWNLOAD AND EXTRACT PRIVATE CORE
========================================= */

async function downloadAndExtractCore() {
  if (!CORE_TOKEN) {
    throw new Error(
      'SILA_CORE_TOKEN haijawekwa kwenye Heroku Config Vars.'
    );
  }

  if (!SESSION_ID) {
    throw new Error(
      'SESSION_ID haijawekwa kwenye Heroku Config Vars.'
    );
  }

  const repoPath = safeRepoPath(CORE_REPO);

  /*
    1. Thibitisha GitHub token
  */

  log('Inakagua GitHub token...');

  const userResponse = await githubApi('/user');

  if (
    userResponse.status !== 200 ||
    !userResponse.data.login
  ) {
    throw new Error(
      'GitHub token imekataliwa. HTTP ' +
      userResponse.status +
      '. Kagua SILA_CORE_TOKEN na ruhusa zake.'
    );
  }

  log(
    'GitHub token: IMEKUBALIWA. Account: ' +
    (userResponse.data.login || 'haijulikani')
  );


  /*
    2. Thibitisha repository
  */

  const repoResponse = await githubApi(
    '/repos/' + repoPath
  );

  if (repoResponse.status !== 200) {
    throw new Error(
      'Repository haijafunguka. HTTP ' +
      repoResponse.status +
      '. Hakikisha token ina ruhusa ya kusoma repository ' +
      CORE_REPO +
      '.'
    );
  }

  const repo = repoResponse.data;

  log(
    'Private repository: ' +
    (repo.private ? 'NDIYO' : 'HAPANA')
  );


  /*
    3. Thibitisha branch
  */

  const refResponse = await githubApi(
    '/repos/' +
    repoPath +
    '/commits/' +
    encodeURIComponent(CORE_REF)
  );

  if (
    refResponse.status !== 200 ||
    !refResponse.data.sha
  ) {
    throw new Error(
      'Branch/ref ' +
      CORE_REF +
      ' haijathibitishwa. HTTP ' +
      refResponse.status +
      '. Kagua SILA_CORE_REF.'
    );
  }

  log(
    'Branch/ref imekubaliwa: ' +
    CORE_REF +
    ' (' +
    refResponse.data.sha.slice(0, 7) +
    ')'
  );


  /*
    4. Tengeneza temporary folder
  */

  await fsp.rm(WORK_ROOT, {
    recursive: true,
    force: true
  });

  await fsp.mkdir(EXTRACT_PATH, {
    recursive: true
  });


  /*
    5. Pakua private repository archive
  */

  const archiveUrl =
    'https://api.github.com/repos/' +
    repoPath +
    '/zipball/' +
    encodeURIComponent(CORE_REF);

  log('Inapakua core kutoka private repository...');

  const archiveResponse = await requestBuffer(
    archiveUrl,
    {
      'Authorization': 'Bearer ' + CORE_TOKEN,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  );

  if (
    archiveResponse.status !== 200 ||
    !archiveResponse.body ||
    archiveResponse.body.length === 0
  ) {
    throw new Error(
      'Imeshindwa kupakua core. HTTP ' +
      archiveResponse.status +
      '.'
    );
  }


  /*
    6. Hiari: hakiki SHA256
  */

  if (CORE_SHA256) {
    const actualHash = crypto
      .createHash('sha256')
      .update(archiveResponse.body)
      .digest('hex');

    if (actualHash.toLowerCase() !== CORE_SHA256) {
      throw new Error(
        'SHA256 ya archive haifanani na SILA_CORE_SHA256.'
      );
    }

    log('SHA256 ya archive imethibitishwa.');
  }


  /*
    7. Hifadhi na extract ZIP
  */

  await fsp.writeFile(
    ZIP_PATH,
    archiveResponse.body
  );

  const zip = new AdmZip(ZIP_PATH);

  zip.extractAllTo(
    EXTRACT_PATH,
    true
  );

  const entries = await fsp.readdir(
    EXTRACT_PATH,
    {
      withFileTypes: true
    }
  );

  const rootEntry = entries.find(
    (entry) => entry.isDirectory()
  );

  if (!rootEntry) {
    throw new Error(
      'Archive haijaonyesha folder kuu ya core.'
    );
  }

  const coreDir = path.join(
    EXTRACT_PATH,
    rootEntry.name
  );

  const packagePath = path.join(
    coreDir,
    'package.json'
  );

  const indexPath = path.join(
    coreDir,
    'index.js'
  );

  if (!fs.existsSync(packagePath)) {
    throw new Error(
      'package.json haipo ndani ya core iliyopakuliwa.'
    );
  }

  if (!fs.existsSync(indexPath)) {
    throw new Error(
      'index.js haipo ndani ya core iliyopakuliwa.'
    );
  }


  /*
    8. Install dependencies za core
  */

  log(
    'Inasakinisha dependencies za core. ' +
    'Hii inaweza kuchukua dakika kadhaa...'
  );

  try {
    const result = await execFileAsync(
      'npm',
  [
  'install',
  '--omit=dev',
  '--no-audit',
  '--no-fund',
  '--allow-git=all'
],
      {
        cwd: coreDir,
        env: process.env,
        timeout: 15 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024
      }
    );

    if (result.stdout) {
      console.log(result.stdout.trim());
    }

    if (result.stderr) {
      console.log(result.stderr.trim());
    }
  } catch (error) {
    if (error.stdout) {
      console.error(error.stdout.toString());
    }

    if (error.stderr) {
      console.error(error.stderr.toString());
    }

    throw new Error(
      'npm install imeshindwa: ' +
      error.message
    );
  }

  return indexPath;
}


/* =========================================
   HEALTH SERVER FOR HEROKU
========================================= */

function startHealthServer() {
  const server = http.createServer(
    (req, res) => {
      if (
        req.url === '/' ||
        req.url === '/health'
      ) {
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8'
        });

        res.end(
          'SILA MD loader is running.'
        );

        return;
      }

      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8'
      });

      res.end('Not found');
    }
  );

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      log(
        'PORT ' +
        PORT +
        ' tayari inatumika. Health server tofauti haitaanzishwa.'
      );

      return;
    }

    console.error(
      '[SILA MD] Health server error:',
      error
    );
  });

  server.listen(
    PORT,
    '0.0.0.0',
    () => {
      log(
        'Health server inasikiliza kwenye PORT ' +
        PORT +
        '.'
      );
    }
  );
}


/* =========================================
   START CORE
========================================= */

async function main() {
  log('Loader inaanza...');

  log(
    'Core repository: ' +
    CORE_REPO
  );

  log(
    'Core branch/ref: ' +
    CORE_REF
  );

  /*
    Usichapishe SESSION_ID yenyewe kwenye logs.
  */

  log(
    'SESSION_ID: ' +
    (SESSION_ID ? 'IMEWEKWA' : 'HAIJAWEKWA')
  );


  /*
    Pakua core na dependencies zake
  */

  const coreIndexPath =
    await downloadAndExtractCore();

  log(
    'Core imepakuliwa na dependencies zimewekwa.'
  );


  /*
    Anzisha index.js ya bot
  */

  try {
    require(coreIndexPath);

    log(
      'Core index.js imeanzishwa.'
    );
  } catch (error) {
    console.error(
      '[SILA MD] Imeshindwa kuanzisha core:',
      error && error.stack ? error.stack : error
    );

    throw error;
  }


  /*
    Anzisha health server ya Heroku
  */

  startHealthServer();
}


/* =========================================
   ERROR HANDLING
========================================= */

process.on(
  'unhandledRejection',
  (reason) => {
    console.error(
      '[SILA MD] Unhandled rejection:',
      reason
    );

    process.exitCode = 1;
  }
);

process.on(
  'uncaughtException',
  (error) => {
    console.error(
      '[SILA MD] Uncaught exception:',
      error && error.stack ? error.stack : error
    );

    process.exit(1);
  }
);


/* =========================================
   RUN LOADER
========================================= */

main().catch((error) => {
  console.error(
    '[SILA MD] STARTUP FAILED:',
    error && error.stack ? error.stack : error
  );

  process.exit(1);
});