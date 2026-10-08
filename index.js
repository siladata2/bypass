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
const CORE_TOKEN = process.env.SILA_CORE_TOKEN || "";
const CORE_SHA256 = (process.env.SILA_CORE_SHA256 || "").trim().toLowerCase();

const CORE_DIR = path.join(os.tmpdir(), "sila-md-core");

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

function download(url, redirects = 0) {
return new Promise((resolve, reject) => {
if (redirects > 5) {
return reject(new Error("GitHub imeelekeza mara nyingi sana."));
}

const target = new URL(url);

if (
  target.protocol !== "https:" ||
  !["api.github.com", "codeload.github.com"].includes(target.hostname)
) {
  return reject(new Error("Anwani ya download haijaruhusiwa."));
}

const headers = {
  "User-Agent": "SILA-MD-Loader/1.0",
  Accept: "application/vnd.github+json"
};

// Tuma token kwa GitHub API pekee, si kwa codeload redirect.
if (CORE_TOKEN && target.hostname === "api.github.com") {
  headers.Authorization = `Bearer ${CORE_TOKEN}`;
}

const request = https.get(target, { headers, timeout: 30000 }, response => {
  const status = response.statusCode || 0;

  if ([301, 302, 303, 307, 308].includes(status)) {
    const location = response.headers.location;
    response.resume();

    if (!location) {
      return reject(new Error("GitHub haikutoa redirect address."));
    }

    return resolve(
      download(new URL(location, target).toString(), redirects + 1)
    );
  }

  if (status !== 200) {
    response.resume();
    return reject(
      new Error(`GitHub download imeshindwa. HTTP ${status}.`)
    );
  }

  const chunks = [];
  let totalBytes = 0;
  const maxBytes = 100 * 1024 * 1024;

  response.on("data", chunk => {
    totalBytes += chunk.length;

    if (totalBytes > maxBytes) {
      request.destroy(new Error("Archive imezidi ukubwa wa 100 MB."));
      return;
    }

    chunks.push(chunk);
  });

  response.on("end", () => resolve(Buffer.concat(chunks)));
  response.on("error", reject);
});

request.on("timeout", () => {
  request.destroy(new Error("GitHub download imechukua muda mrefu."));
});

request.on("error", reject);

});
}

async function extractCore(archive) {
if (CORE_SHA256) {
const actualHash = crypto
.createHash("sha256")
.update(archive)
.digest("hex");

if (actualHash !== CORE_SHA256) {
  throw new Error("SHA256 haijalingana. Archive imekataliwa.");
}

}

const tempDir = path.join(
os.tmpdir(),
"sila-md-extract-${process.pid}"
);

await fs.rm(tempDir, { recursive: true, force: true });
await fs.mkdir(tempDir, { recursive: true });

try {
const zip = new AdmZip(archive);
const entries = zip.getEntries();

if (!entries.length) {
  throw new Error("Archive ya core haina mafaili.");
}

for (const entry of entries) {
  const entryName = entry.entryName.replace(/\\/g, "/");

  if (
    entryName.startsWith("/") ||
    entryName.split("/").includes("..")
  ) {
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

const extractedRoot = directories[0];
const packagePath = path.join(extractedRoot, "package.json");
const indexPath = path.join(extractedRoot, "index.js");

await fs.access(packagePath);
await fs.access(indexPath);

const packageData = JSON.parse(
  await fs.readFile(packagePath, "utf8")
);

if (!packageData.dependencies) {
  throw new Error("Core package.json haina dependencies.");
}

await fs.rm(CORE_DIR, { recursive: true, force: true });
await fs.cp(extractedRoot, CORE_DIR, { recursive: true });

} finally {
await fs.rm(tempDir, { recursive: true, force: true });
}
}

async function installDependencies() {
console.log("📦 SILA MD: Inasakinisha dependencies za bot...");

await execFileAsync(
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

console.log("✅ Dependencies zimekamilika.");
}

async function start() {
console.log("==================================");
console.log("       SILA MD WHATSAPP BOT");
console.log("==================================");

if (!CORE_TOKEN) {
throw new Error(
"SILA_CORE_TOKEN haijawekwa kwenye Environment Variables."
);
}

console.log("📁 Core repository: ${CORE_REPO}");
console.log("🌿 Branch/ref: ${CORE_REF}");
console.log("⬇️ Inapakua private core...");

const archive = await download(getArchiveUrl());

console.log("📂 Inatoa mafaili ya core...");
await extractCore(archive);

await installDependencies();

process.chdir(CORE_DIR);

console.log("🚀 Inaanzisha SILA MD core...");

require(path.join(CORE_DIR, "index.js"));
}

start().catch(error => {
console.error("❌ SILA MD STARTUP FAILED:", error.message);
process.exit(1);
});