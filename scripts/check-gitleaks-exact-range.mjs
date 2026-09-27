// Runs the pinned Gitleaks binary against one exact first-parent commit range.
//
// The package runner provisions the official binary outside this repository
// and passes its path through GITLEAKS_BIN. This guard intentionally has no
// download or network fallback: an absent, substituted, or differently built
// binary fails before the repository is scanned.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const GITLEAKS_PIN = Object.freeze({
    version: "8.24.3",
    assetName: "gitleaks_8.24.3_windows_x64.zip",
    checksumsAssetName: "gitleaks_8.24.3_checksums.txt",
    releaseUrl: "https://github.com/gitleaks/gitleaks/releases/tag/v8.24.3",
    assetUrl: "https://github.com/gitleaks/gitleaks/releases/download/v8.24.3/gitleaks_8.24.3_windows_x64.zip",
    checksumsUrl: "https://github.com/gitleaks/gitleaks/releases/download/v8.24.3/gitleaks_8.24.3_checksums.txt",
    archiveSha256: "3f1a35578631dbfe633cc5b49e6c906e55ff14a4bfd7336a10fb27fe33b6dcd2",
    executableSha256: "8f397272f513c00b573f50380c4724e4b3ac759be1de313d907bb968c5d14c09",
});

export const GITLEAKS_RANGE_BASE = "82caecfd8a3dbb4815fd9c232f2b42b2dafcf646";

const sha256File = (path) =>
    createHash("sha256").update(readFileSync(path)).digest("hex");

const sha256Text = (value) =>
    createHash("sha256").update(value, "utf8").digest("hex");

const asRawBuffer = (value) =>
    Buffer.isBuffer(value) ? value : Buffer.from(value ?? "", "utf8");

const uint64Length = (length) => {
    const frame = Buffer.alloc(8);
    frame.writeBigUInt64BE(BigInt(length));
    return frame;
};

export const digestGitleaksScanOutput = ({ stdout, stderr }) => {
    const stdoutBytes = asRawBuffer(stdout);
    const stderrBytes = asRawBuffer(stderr);
    return createHash("sha256")
        .update("tomverse-gitleaks-scan-output-v1\0", "utf8")
        .update(uint64Length(stdoutBytes.length))
        .update(stdoutBytes)
        .update(uint64Length(stderrBytes.length))
        .update(stderrBytes)
        .digest("hex");
};

/**
 * The cross-review package keeps only the final five output lines and then
 * the final 400 characters. This deterministic footer represents all scan
 * output while staying intact inside that evidence window.
 */
export const buildGitleaksFinalSummary = ({
    resolvedPath,
    version,
    executableSha256,
    range,
    status,
    stdout,
    stderr,
}) => {
    const stdoutBytes = asRawBuffer(stdout);
    const stderrBytes = asRawBuffer(stderr);
    const fields = [
        "gitleaks.final",
        `pathSha256=${sha256Text(resolvedPath)}`,
        `version=${version}`,
        `exeSha256=${executableSha256}`,
        `range=${range}`,
        `exit=${Number.isInteger(status) ? status : "null"}`,
        `outSha256=${digestGitleaksScanOutput({ stdout: stdoutBytes, stderr: stderrBytes })}`,
        `stdoutBytes=${stdoutBytes.length}`,
        `stderrBytes=${stderrBytes.length}`,
    ];
    const withoutPath = fields.join(" ");
    const withPath = `${withoutPath} path=${JSON.stringify(resolvedPath)}`;
    const summary = withPath.length <= 400 ? withPath : withoutPath;
    if (summary.length > 400 || summary.includes("\n")) {
        throw new Error(`Gitleaks final summary exceeds its 400-character single-line contract (${summary.length})`);
    }
    return summary;
};

const commandFailure = (label, result) => {
    if (result.error) return `${label} could not start: ${result.error.message}`;
    if (result.signal) return `${label} ended by signal ${result.signal}`;
    return `${label} exited ${String(result.status)}`;
};

class GitleaksScanError extends Error {
    constructor(message) {
        super(message);
        this.summaryPrinted = true;
    }
}

export const verifyPinnedGitleaksBinary = ({
    gitleaksBin,
    expectedSha256 = GITLEAKS_PIN.executableSha256,
    expectedVersion = GITLEAKS_PIN.version,
    spawn = spawnSync,
}) => {
    if (typeof gitleaksBin !== "string" || gitleaksBin.trim().length === 0) {
        throw new Error("GITLEAKS_BIN is required");
    }

    const resolvedBin = resolve(gitleaksBin);
    if (!isAbsolute(resolvedBin)) {
        throw new Error(`GITLEAKS_BIN did not resolve to an absolute path: ${resolvedBin}`);
    }

    let stat;
    try {
        stat = statSync(resolvedBin);
    } catch {
        throw new Error(`GITLEAKS_BIN does not name a readable file: ${resolvedBin}`);
    }
    if (!stat.isFile()) {
        throw new Error(`GITLEAKS_BIN does not name a file: ${resolvedBin}`);
    }

    const executableSha256 = sha256File(resolvedBin);
    if (executableSha256 !== expectedSha256) {
        throw new Error(
            `Gitleaks executable SHA-256 mismatch: expected ${expectedSha256}, got ${executableSha256}`
        );
    }

    const versionResult = spawn(resolvedBin, ["version"], {
        encoding: "utf8",
        windowsHide: true,
    });
    if (versionResult.status !== 0 || versionResult.error || versionResult.signal) {
        throw new Error(commandFailure("gitleaks version", versionResult));
    }
    const version = String(versionResult.stdout ?? "").trim();
    if (version !== expectedVersion) {
        throw new Error(`Gitleaks ${expectedVersion} required, got ${version || "<empty>"}`);
    }

    return { resolvedBin, executableSha256, version };
};

export const runPinnedGitleaksRange = ({
    gitleaksBin,
    reviewedHead,
    cwd = process.cwd(),
    expectedSha256 = GITLEAKS_PIN.executableSha256,
    expectedVersion = GITLEAKS_PIN.version,
    spawn = spawnSync,
    write = (value) => process.stdout.write(value),
}) => {
    if (!/^[0-9a-f]{40}$/u.test(reviewedHead ?? "")) {
        throw new Error("--reviewed-head must be one lowercase 40-character commit SHA");
    }

    const verified = verifyPinnedGitleaksBinary({
        gitleaksBin,
        expectedSha256,
        expectedVersion,
        spawn,
    });
    const range = `${GITLEAKS_RANGE_BASE}^..${reviewedHead}`;
    const args = [
        "detect",
        "--source=.",
        "--no-banner",
        "--redact",
        "--gitleaks-ignore-path=.gitleaksignore",
        "--exit-code=1",
        `--log-opts=--no-merges --first-parent ${range}`,
    ];

    write(`gitleaks.resolvedPath=${verified.resolvedBin}\n`);
    write(`gitleaks.version=${verified.version}\n`);
    write(`gitleaks.executableSha256=${verified.executableSha256}\n`);
    write(`gitleaks.range=${range}\n`);

    const scanResult = spawn(verified.resolvedBin, args, {
        cwd: resolve(cwd),
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
    });
    const stdout = asRawBuffer(scanResult.stdout);
    const stderr = asRawBuffer(scanResult.stderr);
    const stdoutDisplay = stdout.toString("utf8");
    const stderrDisplay = stderr.toString("utf8");
    if (stdoutDisplay.length > 0) write(stdoutDisplay.endsWith("\n") ? stdoutDisplay : `${stdoutDisplay}\n`);
    if (stderrDisplay.length > 0) write(stderrDisplay.endsWith("\n") ? stderrDisplay : `${stderrDisplay}\n`);
    const summary = buildGitleaksFinalSummary({
        ...verified,
        resolvedPath: verified.resolvedBin,
        range,
        status: scanResult.status,
        stdout,
        stderr,
    });
    write(`${summary}\n`);
    if (scanResult.status !== 0 || scanResult.error || scanResult.signal) {
        throw new GitleaksScanError(commandFailure("gitleaks detect", scanResult));
    }

    return { ...verified, range, args, stdout, stderr, summary };
};

const optionValue = (name) => {
    const prefix = `--${name}=`;
    const matches = process.argv.slice(2).filter((argument) => argument.startsWith(prefix));
    if (matches.length !== 1) throw new Error(`exactly one ${prefix}<value> is required`);
    return matches[0].slice(prefix.length);
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
    try {
        runPinnedGitleaksRange({
            gitleaksBin: process.env.GITLEAKS_BIN,
            reviewedHead: optionValue("reviewed-head"),
        });
    } catch (error) {
        if (!(error instanceof GitleaksScanError && error.summaryPrinted)) {
            console.error(error instanceof Error ? error.message : String(error));
        }
        process.exitCode = 1;
    }
}
