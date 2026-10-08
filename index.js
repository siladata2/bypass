"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const https = require("node:https");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const AdmZip = require("adm-zip");

const execFileAsync = promisify(execFile);

const CORE_REPO = process.env.SILA_CORE_REPO || "siladata2/Yuda";
const CORE_REF = process.env.SILA_CORE_REF || "main";
const CORE_TOKEN = (process.env.SILA_CORE_TOKEN || "").trim();
const CORE_SHA256 = (process.env.SILA_CORE_SHA256 || "").trim().toLowerCase();

const CORE_DIR = path.join(os.tmpdir(), "sila-md-core");

function log(message) {
console.log("[SILA MD] ${message}");
}

function getArchiveUrl() {
const parts = CORE_REPO.split("/");

if (parts.length !== 2 || !parts[0] || !parts[1]) {
throw new Error("SILA_CORE_REPO lazima iwe owner/repository.");
}

return (
"https://api.github.com/repos/" +
encodeURIComponent(parts[0]) +
"/" +
encodeURIComponent(parts[1]) +
"/zipball/" +
encodeURIComponent(CORE_REF)
);
}

function githubRequest(url, options = {}, redirects = 0) {
return new Promise((resolve, reject) => {
if (redirects > 5) {
reject(new Error("GitHub imeelekeza ombi mara nyingi sana."));
return;
}

const target = new URL(url);

if (
  target.protocol !== "https:" ||
  !["api.github.com", "codeload.github.com"].includes(target.hostname)
) {
  reject(new Error("GitHub URL haijaruhusiwa."));
  return;
}

const headers = {
  "User-Agent": "SILA-MD-Loader/1.0",
  Accept: options.accept || "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28"
};

// Usichapishe token kwenye logs.
// Token inatumwa kwa GitHub API pekee.
if (CORE_TOKEN && target.hostname === "api.github.com") {
  headers.Authorization = `Bearer ${CORE_TOKEN}`;
}

const request = https.get(
  target,
  { headers, timeout: 30000 },
  response => {
    const status = response.statusCode || 0;

    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers.location;
      response.resume();

      if (!location) {
        reject(new Error("GitHub redirect haina location."));
        return;
      }

      resolve(
        githubRequest(
          new URL(location, target).toString(),
          options,
          redirects + 1
        )
      );
      return;
    }

    const chunks = [];
    let size = 0;
    const maxBytes = options.maxBytes || 100 * 1024 * 1024;

    response.on("data", chunk => {
      size += chunk.length;

      if (size > maxBytes) {
        request.destroy(
          new Error("Response imezidi ukubwa unaoruhusiwa.")
        );
        return;
      }

      chunks.push(chunk);
    });

    response.on("end", () => {
      resolve({
        status,
        headers: response.headers,
        body: Buffer.concat(chunks)
      });
    });

    response.on("error", reject);
  }
);

request.on("timeout", () => {
  request.destroy(new Error("Ombi la GitHub limechukua muda mrefu."));
});

request.on("error", reject);

});
}

async function checkGitHubConnection() {
log("========================================");
log("SILA MD PRIVATE CORE CONNECTION CHECK");
log("========================================");

log("Repository: ${CORE_REPO}");
log("Branch/ref: ${CORE_REF}");

if (!CORE_TOKEN) {
throw new Error(
"SILA_CORE_TOKEN haipo. Iweke kwenye Heroku Config Vars."
);
}

log("GitHub token: IPO (thamani imefichwa).");
log("Inathibitisha token dhidi ya GitHub API...");

const userResponse = await githubRequest(
"https://api.github.com/user"
);

if (userResponse.status !== 200) {
throw new Error(
"GitHub haikukubali token. HTTP ${userResponse.status}. " +
userResponse.body.toString("utf8").slice(0, 250)
);
}

let user;

try {
user = JSON.parse(userResponse.body.toString("utf8"));
} catch {
throw new Error("Jibu la GitHub kuhusu akaunti halikusomeka.");
}

log("GitHub token: IMEKUBALIWA. Account: " + (user.login || "haijulikani"));

log("Inakagua ruhusa ya kufikia repository...");

const repoResponse = await githubRequest(
"https://api.github.com/repos/${CORE_REPO}"
);

if (repoResponse.status !== 200) {
throw new Error(
"Repository haijafikiwa. HTTP ${repoResponse.status}. " +
repoResponse.body.toString("utf8").slice(0, 250)
);
}

let repo;

try {
repo = JSON.parse(repoResponse.body.toString("utf8"));
} catch {
throw new Error("Taarifa za repository hazikusomeka.");
}

log("Repository access: IMEFANIKIWA (${repo.full_name || CORE_REPO}).");
log("Private repository: " + (repo.private ? "NDIYO" : "HAPANA"));

const refResponse = await githubRequest(
"https://api.github.com/repos/${CORE_REPO}/commits/${encodeURIComponent(CORE_REF)}"
);

if (refResponse.status !== 200) {
throw new Error(
"Branch/ref "${CORE_REF}" haijathibitishwa. HTTP ${refResponse.status}. " +
refResponse.body.toString("utf8").slice(0, 250)
);
}

log("Branch/ref "${CORE_REF}": IMEPATIKANA.");
}

async function downloadCore() {
log("Inapakua archive ya private core...");

const response = await githubRequest(getArchiveUrl(), {
accept: "application/vnd.github+json",
maxBytes: 100 * 1024 * 1024
});

if (response.status !== 200) {
throw new Error(
"Core download imeshindwa. HTTP ${response.status}. " +
response.body.toString("utf8").slice(0, 250)
);
}

if (!response.body.length) {
throw new Error("GitHub imerudisha archive tupu.");
}

if (CORE_SHA256) {
const actualHash = crypto
.createHash("sha256")
.update(response.body)
.digest("hex");

if (actualHash !== CORE_SHA256) {
  throw new Error("SHA256 haijalingana. Download imekataliwa.");
}

}

log("Core download: IMEFANIKIWA (${response.body.length} bytes).");

return response.body;
}

async function extractCore(archive) {
const tempDir = path.join(
os.tmpdir(),
"sila-md-extract-${process.pid}"
);

await fs.rm(tempDir, { recursive: true, force: true });
await fs.mkdir(tempDir, { recursive: true });

try {
log("Inakagua na kutoa mafaili ya core...");

const zip = new AdmZip(archive);
const entries = zip.getEntries();

if (!entries.length) {
  throw new Error("Archive haina mafaili.");
}

for (const entry of entries) {
  const name = entry.entryName.replace(/\\/g, "/");

  if (name.startsWith("/") || name.split("/").includes("..")) {
    throw new Error("Archive ina njia ya faili isiyoruhusiwa.");
  }
}

zip.extractAllTo(tempDir, true);

const names = await fs.readdir(tempDir);
const directories = [];

for (const name of names) {
  const fullPath = path.join(tempDir, name);
  const stat = await fs.lstat(fullPath);

  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    directories.push(fullPath);
  }
}

if (directories.length !== 1) {
  throw new Error("Muundo wa GitHub archive hautarajiwa.");
}

const root = directories[0];
const packagePath = path.join(root, "package.json");
const indexPath = path.join(root, "index.js");

await fs.access(packagePath);
await fs.access(indexPath);

const packageData = JSON.parse(
  await fs.readFile(packagePath, "utf8")
);

if (!packageData.dependencies) {
  throw new Error("Core package.json haina dependencies.");
}

await fs.rm(CORE_DIR, { recursive: true, force: true });
await fs.cp(root, CORE_DIR, { recursive: true });

log("Core files: ZIMEANDALIWA.");

} finally {
await fs.rm(tempDir, { recursive: true, force: true });
}
}

async function installCoreDependencies() {
log("Inasakinisha dependencies za private core...");
log("Hatua hii inaweza kuchukua dakika kadhaa.");

try {
const result = await execFileAsync(
"npm",
[
"install",
"--omit=dev",
"--no-audit",
"--no-fund"
],
{
cwd: CORE_DIR,
timeout: 10 * 60 * 1000,
maxBuffer: 10 * 1024 * 1024,
env: process.env
}
);

if (result.stdout) {
  console.log(result.stdout.slice(-3000));
}

if (result.stderr) {
  console.log(result.stderr.slice(-3000));
}

log("Core dependencies: ZIMEKAMILIKA.");

} catch (error) {
if (error.stdout) {
console.error(error.stdout.slice(-3000));
}

if (error.stderr) {
  console.error(error.stderr.slice(-3000));
}

throw new Error(
  `Kusakinisha dependencies kumeshindwa: ${error.message}`
);

}
}

async function start() {
log("========================================");
log("       SILA MD WHATSAPP BOT");
log("========================================");

await checkGitHubConnection();

const archive = await downloadCore();

await extractCore(archive);

await installCoreDependencies();

log("SESSION_ID: ${process.env.SESSION_ID ? "IPO" : "HAIPO"}");
log("Thamani ya session haitachapishwa kwenye logs.");

process.chdir(CORE_DIR);

log("Inaanzisha private core...");

require(path.join(CORE_DIR, "index.js"));
}

start().catch(error => {
console.error("[SILA MD] STARTUP FAILED:", error.message);
process.exit(1);
});