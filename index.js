"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const https = require("node:https");
const AdmZip = require("adm-zip");

const CORE_REPO =
    process.env.SILA_CORE_REPO || "siladata2/Yuda";

const CORE_REF =
    process.env.SILA_CORE_REF || "main";

const CORE_TOKEN =
    process.env.SILA_CORE_TOKEN || "";

const CORE_SHA256 = String(
    process.env.SILA_CORE_SHA256 || ""
).trim().toLowerCase();

const RUNTIME_ROOT = path.join(
    os.tmpdir(),
    "sila-md-core"
);

function getArchiveUrl() {
    const parts = CORE_REPO.split("/");

    if (
        parts.length !== 2 ||
        !parts[0] ||
        !parts[1]
    ) {
        throw new Error(
            "SILA_CORE_REPO must be owner/repository"
        );
    }

    return (
        "https://api.github.com/repos/" +
        `${encodeURIComponent(parts[0])}/` +
        `${encodeURIComponent(parts[1])}/zipball/` +
        encodeURIComponent(CORE_REF)
    );
}

function download(url, redirects = 0) {
    if (redirects > 5) {
        return Promise.reject(
            new Error("Too many download redirects")
        );
    }

    return new Promise((resolve, reject) => {
        const headers = {
            "User-Agent": "SILA-MD-Loader/1.0",
            "Accept": "application/vnd.github+json"
        };

        if (CORE_TOKEN) {
            headers.Authorization = `Bearer ${CORE_TOKEN}`;
        }

        const request = https.get(
            url,
            { headers },
            (response) => {
                const status = response.statusCode || 0;

                if (
                    [301, 302, 303, 307, 308].includes(status) &&
                    response.headers.location
                ) {
                    const nextUrl = new URL(
                        response.headers.location,
                        url
                    );

                    response.resume();

                    if (
                        nextUrl.protocol !== "https:" ||
                        ![
                            "api.github.com",
                            "codeload.github.com"
                        ].includes(nextUrl.hostname)
                    ) {
                        return reject(
                            new Error("Unexpected redirect host")
                        );
                    }

                    return resolve(
                        download(nextUrl.href, redirects + 1)
                    );
                }

                if (status !== 200) {
                    response.resume();

                    return reject(
                        new Error(
                            `GitHub download failed: HTTP ${status}`
                        )
                    );
                }

                const chunks = [];

                response.on("data", (chunk) => {
                    chunks.push(chunk);
                });

                response.on("end", () => {
                    resolve(Buffer.concat(chunks));
                });

                response.on("error", reject);
            }
        );

        request.setTimeout(30000, () => {
            request.destroy(
                new Error("Core download timed out")
            );
        });

        request.on("error", reject);
    });
}

async function installCore(archive) {
    if (CORE_SHA256) {
        const actual = crypto
            .createHash("sha256")
            .update(archive)
            .digest("hex");

        if (
            !/^[a-f0-9]{64}$/.test(CORE_SHA256) ||
            actual !== CORE_SHA256
        ) {
            throw new Error(
                "Core archive SHA-256 verification failed"
            );
        }
    }

    const tempRoot = path.join(
        os.tmpdir(),
        `sila-md-extract-${process.pid}`
    );

    await fs.rm(RUNTIME_ROOT, {
        recursive: true,
        force: true
    });

    await fs.rm(tempRoot, {
        recursive: true,
        force: true
    });

    await fs.mkdir(tempRoot, {
        recursive: true,
        mode: 0o700
    });

    try {
        const zip = new AdmZip(archive);
        const entries = zip.getEntries();

        if (!entries.length) {
            throw new Error("Downloaded archive is empty");
        }

        // Reject paths that could escape the extraction directory.
        for (const entry of entries) {
            const name = entry.entryName.replace(/\\/g, "/");

            if (
                name.startsWith("/") ||
                name.split("/").includes("..")
            ) {
                throw new Error(
                    "Unsafe path found in core archive"
                );
            }
        }

        zip.extractAllTo(tempRoot, true);

        const topLevel = await fs.readdir(tempRoot, {
            withFileTypes: true
        });

        const directories = topLevel.filter(
            (entry) => entry.isDirectory()
        );

        if (directories.length !== 1) {
            throw new Error(
                "Unexpected private core archive structure"
            );
        }

        const extractedRoot = path.join(
            tempRoot,
            directories[0].name
        );

        const coreIndex = path.join(
            extractedRoot,
            "index.js"
        );

        await fs.access(coreIndex);

        await fs.cp(extractedRoot, RUNTIME_ROOT, {
            recursive: true,
            force: true
        });
    } finally {
        await fs.rm(tempRoot, {
            recursive: true,
            force: true
        });
    }
}

async function start() {
    console.log("================================");
    console.log("       SILA MD PRIVATE CORE");
    console.log("================================");

    if (!CORE_TOKEN) {
        throw new Error(
            "Missing SILA_CORE_TOKEN environment variable"
        );
    }

    console.log(`Core repository: ${CORE_REPO}`);
    console.log(`Core branch: ${CORE_REF}`);

    const archive = await download(getArchiveUrl());

    await installCore(archive);

    process.chdir(RUNTIME_ROOT);

    console.log("Private core downloaded successfully.");
    console.log("Starting SILA MD...");

    require(path.join(RUNTIME_ROOT, "index.js"));
}

start().catch((error) => {
    console.error(
        "[SILA MD STARTUP ERROR]",
        error.message
    );

    process.exitCode = 1;
});