// A re-rooted host for the AMUX Decision Maker launcher's tests
// (lib/amux/decisionMakerLauncherFs.ts `dmTestHost`): the root-owned
// executable and schema, the broker's request root with this request's
// directory, and the vendor account's `0700` home with its kept
// authentication file, all under one temporary directory. Every directory is
// made without group or other write, as the launcher's path checks require.
// Nothing outside the temporary directory is touched.

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { dmPayloadDigest } from "../../lib/amux/decisionMakerBodyCore.ts";
import {
  DM_LAUNCHER_SPECS,
  DM_OUTPUT_SCHEMA_JSON,
  DM_OUTPUT_SCHEMA_PATH,
  DM_REQUEST_ROOT,
  dmRequestPaths,
} from "../../lib/amux/decisionMakerLauncherCore.ts";
import { dmHostPath, dmTestHost } from "../../lib/amux/decisionMakerLauncherFs.ts";

export const REQUEST_ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
export const EVENT_ID = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
export const REQUEST_KEY = Buffer.alloc(32, 7);
export const PAYLOAD = Buffer.from("Synthetic AMUX Decision Maker question for a launcher test.\n", "utf8");

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * `executable` is the stand-in CLI's content, or a function of the root that
 * returns it. `requestDirectory: false` leaves the request directory to the
 * broker (stage S2-3b), which makes it itself.
 */
export const makeLauncherFixture = (
  instance,
  { executable: content = "not a real CLI\n", executableMode = 0o755, hostOptions, requestDirectory = true } = {},
) => {
  const root = mkdtempSync(join(tmpdir(), "amux-dm-launcher-"));
  const executable = typeof content === "function" ? content(root) : content;
  const host = dmTestHost(root, hostOptions);
  const spec = DM_LAUNCHER_SPECS[instance];
  const at = (path) => dmHostPath(host, path);
  const directory = (path, mode = 0o755) => {
    mkdirSync(at(path), { recursive: true, mode });
    chmodSync(at(path), mode);
  };
  const write = (path, content, mode) => {
    mkdirSync(dirname(at(path)), { recursive: true, mode: 0o755 });
    writeFileSync(at(path), content, mode === undefined ? undefined : { mode });
  };

  write(spec.executablePath, executable, executableMode);
  write(DM_OUTPUT_SCHEMA_PATH, DM_OUTPUT_SCHEMA_JSON);
  directory(spec.home, 0o700);
  for (const keep of spec.stateKeep) write(`${spec.home}/${keep.slice(2)}`, '{"synthetic":"auth"}');
  const paths = dmRequestPaths(instance, REQUEST_ID);
  directory(DM_REQUEST_ROOT, 0o711);
  if (requestDirectory) {
    directory(paths.requestDirectory, 0o750);
    writeFileSync(at(`${paths.requestDirectory}/card.json`), '{"synthetic":"card"}');
  }
  mkdirSync(at("/observed"), { recursive: true });

  const evidence = {
    requestId: REQUEST_ID,
    instance,
    recorded: true,
    eventId: EVENT_ID,
    inputPayloadDigest: dmPayloadDigest(REQUEST_KEY, PAYLOAD),
  };

  return {
    root,
    host,
    spec,
    at,
    directory,
    write,
    paths,
    evidence,
    executableSha256: sha256(Buffer.from(executable)),
    input: (overrides = {}) => ({
      instance,
      requestId: REQUEST_ID,
      evidence,
      requestKey: REQUEST_KEY,
      payload: PAYLOAD,
      ...overrides,
    }),
    /** Everything under the home, as home-relative paths. */
    homeEntries: () => listRelative(at(spec.home)),
    dispose: () => {
      // A test may leave a directory without write permission behind.
      restoreWritable(root);
      rmSync(root, { recursive: true, force: true });
    },
  };
};

const listRelative = (directory, prefix = "") =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = `${prefix}${entry.name}`;
    return entry.isDirectory()
      ? [`${relative}/`, ...listRelative(join(directory, entry.name), `${relative}/`)]
      : [relative];
  });

const restoreWritable = (directory) => {
  try {
    if (!statSync(directory).isDirectory()) return;
    chmodSync(directory, 0o700);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) restoreWritable(join(directory, entry.name));
    }
  } catch {
    // Best effort; rmSync reports what is left.
  }
};

/**
 * A stand-in CLI: a Node script run through an absolute shebang, so it needs
 * nothing from the fixed PATH. `ROOT` and `at()` let it reach the re-rooted
 * paths the launcher hands it as policy paths.
 */
export const fakeCli = (root, body) =>
  [
    `#!${process.execPath}`,
    '"use strict";',
    'const fs = require("fs");',
    'const path = require("path");',
    `const ROOT = ${JSON.stringify(root)};`,
    "const at = (p) => path.join(ROOT, ...p.split('/').filter(Boolean));",
    "const argv = process.argv.slice(2);",
    "const touch = (p, c = 'x') => { fs.mkdirSync(path.dirname(at(p)), { recursive: true, mode: 0o700 }); fs.writeFileSync(at(p), c); };",
    body,
    "",
  ].join("\n");
