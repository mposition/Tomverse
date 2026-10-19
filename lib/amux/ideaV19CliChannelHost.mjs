import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, readlink,
  realpath, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";

import { amuxV19CliChannel } from "./ideaV19CliChannels.mjs";
import { AMUX_V19_CLAUDE_MAX_AUTH_PATH,
  verifyAmuxV19ClaudeMaxAuthSource } from "./ideaV19ClaudeMaxAuth.mjs";

const STAGED_ROOT = /^\/tmp\/amux-v4-cli-[A-Za-z0-9-]{1,80}$/;
const AUTH_DIRECTORY = /^\/tmp\/amux-v19-auth-[A-Za-z0-9]{6}$/;
const MAX_INSTALL_ENTRIES = 20_000;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_AUTH_BYTES = 64 * 1024;
// A run must not need a token refresh: the sandbox copy has no refresh secret.
export const AMUX_V19_AUTH_MIN_REMAINING_MS = 6 * 60 * 60 * 1000;
// Codex refreshes its ChatGPT token on its own schedule; a login older than
// this is refused before claim until the operator uses Codex on the host.
export const AMUX_V19_CODEX_MAX_REFRESH_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Stands in for Cursor's refresh token in the sandbox copy; not a credential. */
export const AMUX_V19_CURSOR_REFRESH_PLACEHOLDER = "amux-sandbox-no-refresh";

const unsafe = (what) => new TypeError(`unsafe AMUX v19 ${what}`);
const uid = () => {
  if (process.platform !== "linux" || typeof process.getuid !== "function")
    throw unsafe("channel host");
  return process.getuid();
};
// Every executable file is the runner user's and never group/other writable.
// Directories may be group writable: the runner's group is its private one.
const ownedFile = (stat) => stat.uid === uid() && (stat.mode & 0o022) === 0;
const ownedDirectory = (stat) => stat.uid === uid() && (stat.mode & 0o002) === 0;

// A directory install may hold empty files (measured: a build stamp in
// Cursor's node_modules); a single-file install never does.
async function hashFile(path, { allowEmpty = false } = {}) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid() ||
        stat.size < (allowEmpty ? 0 : 1) || stat.size > MAX_FILE_BYTES)
      throw unsafe("staged CLI");
    const hash = createHash("sha256");
    for await (const part of handle.createReadStream({ autoClose: false })) hash.update(part);
    return hash.digest("hex");
  } finally { await handle.close(); }
}

/** Resolve the CLI the operator installed. A file install is used where it
 * is; a directory install is found through the operator's launcher link. */
export async function resolveAmuxV19ChannelInstall(provider) {
  const channel = amuxV19CliChannel(provider);
  if (!channel?.install) throw unsafe("channel install");
  const install = channel.install;
  if (install.kind === "file") {
    const [stat, real] = await Promise.all([lstat(install.path), realpath(install.path)]);
    const parent = await lstat(install.path.slice(0, install.path.lastIndexOf("/")));
    if (!stat.isFile() || real !== install.path || !ownedFile(stat) ||
        stat.size < 1 || stat.size > MAX_FILE_BYTES ||
        !parent.isDirectory() || !ownedDirectory(parent)) throw unsafe("channel install");
    return Object.freeze({ kind: "file", source: install.path });
  }
  const link = await lstat(install.link);
  if (link.uid !== uid()) throw unsafe("channel install");
  const entry = await realpath(install.link);
  const suffix = `/${install.entry}`;
  const root = entry.endsWith(suffix) ? entry.slice(0, -suffix.length) : "";
  if (!install.root.test(root)) throw unsafe("channel install");
  const [rootStat, realRoot] = await Promise.all([lstat(root), realpath(root)]);
  if (!rootStat.isDirectory() || realRoot !== root || !ownedDirectory(rootStat))
    throw unsafe("channel install");
  return Object.freeze({ kind: "directory", source: root, skip: install.skip });
}

async function copyTree(source, destination, skip) {
  const lines = [];
  let entries = 0;
  const walk = async (relative) => {
    const from = relative ? join(source, relative) : source;
    const to = relative ? join(destination, relative) : destination;
    await mkdir(to, { mode: 0o700 });
    const names = (await readdir(from)).sort();
    for (const name of names) {
      if (!relative && skip.includes(name)) continue;
      entries += 1;
      if (entries > MAX_INSTALL_ENTRIES) throw unsafe("channel install");
      const path = relative ? `${relative}/${name}` : name;
      const stat = await lstat(join(source, path));
      if (stat.isSymbolicLink()) {
        const target = await readlink(join(source, path));
        const resolved = posix.normalize(posix.join(posix.dirname(path), target));
        if (target.startsWith("/") || resolved === ".." || resolved.startsWith("../") ||
            stat.uid !== uid()) throw unsafe("channel install");
        await symlink(target, join(destination, path));
        lines.push(`l ${path} ${target}`);
      } else if (stat.isDirectory()) {
        if (!ownedDirectory(stat)) throw unsafe("channel install");
        lines.push(`d ${path}`);
        await walk(path);
      } else if (stat.isFile()) {
        if (!ownedFile(stat) || stat.size > MAX_FILE_BYTES) throw unsafe("channel install");
        await copyFile(join(source, path), join(destination, path), constants.COPYFILE_EXCL);
        await chmod(join(destination, path), stat.mode & 0o555);
        lines.push(`f ${path} ${(stat.mode & 0o111) !== 0 ? "x" : "-"} ${
          await hashFile(join(destination, path), { allowEmpty: true })}`);
      } else throw unsafe("channel install");
    }
  };
  await walk("");
  return createHash("sha256").update(`${lines.join("\n")}\n`, "utf8").digest("hex");
}

/** Copy the installed CLI into the caller's private staging directory and
 * return the copy's sha256 (a tree manifest digest for a directory install).
 * The digest describes exactly what the sandbox runs and is recorded with the
 * result; it is evidence, not an approval list. */
export async function stageAmuxV19ChannelInstall(provider, cliDirectory) {
  const channel = amuxV19CliChannel(provider);
  if (!channel?.install || typeof cliDirectory !== "string" ||
      !STAGED_ROOT.test(cliDirectory)) throw unsafe("channel install");
  const directory = await lstat(cliDirectory);
  if (!directory.isDirectory() || directory.uid !== uid() ||
      (directory.mode & 0o777) !== 0o700) throw unsafe("channel install");
  const resolved = await resolveAmuxV19ChannelInstall(provider);
  const path = join(cliDirectory, channel.staged);
  if (resolved.kind === "file") {
    await copyFile(resolved.source, path, constants.COPYFILE_EXCL);
    await chmod(path, 0o500);
    return Object.freeze({ path, source: resolved.source, sha256: await hashFile(path) });
  }
  const sha256 = await copyTree(resolved.source, path, resolved.skip);
  const entry = await lstat(join(path, channel.provider === "cursor" ? "index.js" : "bin/codex"));
  if (!entry.isFile()) throw unsafe("channel install");
  return Object.freeze({ path, source: resolved.source, sha256 });
}

export async function removeAmuxV19StagedInstall(path) {
  if (typeof path !== "string" ||
      !STAGED_ROOT.test(path.slice(0, path.lastIndexOf("/")))) throw unsafe("staged CLI");
  await rm(path, { recursive: true, force: true });
}

async function readAuthSource(path) {
  const parent = path.slice(0, path.lastIndexOf("/"));
  const [stat, real, parentStat] = await Promise.all([lstat(path), realpath(path),
    lstat(parent)]);
  if (!stat.isFile() || real !== path || stat.uid !== uid() ||
      (stat.mode & 0o077) !== 0 || stat.nlink !== 1 ||
      stat.size < 1 || stat.size > MAX_AUTH_BYTES ||
      !parentStat.isDirectory() || !ownedDirectory(parentStat)) throw unsafe("channel auth");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.ino !== stat.ino || opened.dev !== stat.dev) throw unsafe("channel auth");
    return await handle.readFile();
  } finally { await handle.close(); }
}

const jwtExpiryMs = (token) => {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
  try {
    const exp = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))?.exp;
    return Number.isSafeInteger(exp) ? exp * 1000 : null;
  } catch { return null; }
};
const plainObject = (value) => value !== null && typeof value === "object" &&
  !Array.isArray(value);

/** Validate one channel's sign-in file and build the sandbox's copy: only the
 * access credential, never a refresh secret, so a sandboxed CLI can neither
 * rotate nor overwrite the operator's login. Exported for unit tests; the
 * returned secrets feed the output check and are never logged. */
export function inspectAmuxV19ChannelAuth(provider, bytes, now) {
  const channel = amuxV19CliChannel(provider);
  if (!channel?.auth || !Buffer.isBuffer(bytes) || !Number.isSafeInteger(now))
    throw unsafe("channel auth");
  const text = bytes.toString("utf8");
  if (channel.auth === "copilot") {
    // The Copilot CLI writes `//` comment lines above its JSON.
    const config = JSON.parse(text.split("\n")
      .filter((line) => !line.trim().startsWith("//")).join("\n"));
    const user = config?.lastLoggedInUser;
    const token = plainObject(user) && user.host === "https://github.com" &&
      typeof user.login === "string" && /^[A-Za-z0-9-]{1,39}$/.test(user.login)
      ? config.authTokens?.[`${user.host}:${user.login}`]?.token : null;
    if (typeof token !== "string" || !/^gho_[A-Za-z0-9]{20,255}$/.test(token))
      throw unsafe("channel auth");
    return { copy: Buffer.from(token, "utf8"), secrets: [token] };
  }
  const value = JSON.parse(text);
  if (!plainObject(value)) throw unsafe("channel auth");
  if (channel.auth === "codex") {
    const tokens = value.tokens;
    const lastRefresh = Date.parse(value.last_refresh);
    const expiry = plainObject(tokens) ? jwtExpiryMs(tokens.access_token) : null;
    // A subscription channel never runs on an API key (real money).
    if (value.auth_mode !== "chatgpt" ||
        (value.OPENAI_API_KEY !== null && value.OPENAI_API_KEY !== undefined) ||
        !plainObject(tokens) || typeof tokens.id_token !== "string" ||
        typeof tokens.account_id !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(tokens.account_id) ||
        expiry === null || expiry - now < AMUX_V19_AUTH_MIN_REMAINING_MS ||
        !Number.isFinite(lastRefresh) || lastRefresh > now + 60_000 ||
        now - lastRefresh > AMUX_V19_CODEX_MAX_REFRESH_AGE_MS) throw unsafe("channel auth");
    const copy = { auth_mode: "chatgpt", OPENAI_API_KEY: null,
      tokens: { id_token: tokens.id_token, access_token: tokens.access_token,
        refresh_token: "", account_id: tokens.account_id },
      last_refresh: value.last_refresh };
    return { copy: Buffer.from(JSON.stringify(copy), "utf8"),
      secrets: [tokens.access_token, tokens.id_token] };
  }
  // The refresh secret never enters the sandbox, whatever the login holds.
  // Measured inside the v19 sandbox (2026-10-20, Cursor 2026.10.01): with the
  // refreshToken key absent or empty the CLI stops ("Authentication
  // required"); with this fixed non-secret placeholder it answers normally.
  const expiry = jwtExpiryMs(value.accessToken);
  if (typeof value.refreshToken !== "string" || expiry === null ||
      expiry - now < AMUX_V19_AUTH_MIN_REMAINING_MS) throw unsafe("channel auth");
  return { copy: Buffer.from(JSON.stringify({ accessToken: value.accessToken,
    refreshToken: AMUX_V19_CURSOR_REFRESH_PLACEHOLDER }), "utf8"),
  secrets: [value.accessToken] };
}

/** Metadata and shape check of one channel's sign-in before a claim. It
 * starts no CLI and keeps nothing. */
export async function verifyAmuxV19ChannelAuthSource(provider, now = Date.now()) {
  const channel = amuxV19CliChannel(provider);
  if (!channel) throw unsafe("channel auth");
  if (channel.pinned) {
    await verifyAmuxV19ClaudeMaxAuthSource(AMUX_V19_CLAUDE_MAX_AUTH_PATH);
    return;
  }
  const bytes = await readAuthSource(channel.authSource);
  try {
    const inspected = inspectAmuxV19ChannelAuth(provider, bytes, now);
    inspected.copy.fill(0);
  } finally { bytes.fill(0); }
}

/** Write the sandbox's read-only credential copy into a fresh private
 * directory. The caller removes it with removeAmuxV19StagedAuth after the run. */
export async function stageAmuxV19ChannelAuth(provider, now = Date.now()) {
  const channel = amuxV19CliChannel(provider);
  if (!channel?.auth) throw unsafe("channel auth");
  const bytes = await readAuthSource(channel.authSource);
  let inspected;
  try { inspected = inspectAmuxV19ChannelAuth(provider, bytes, now); }
  finally { bytes.fill(0); }
  const directory = await mkdtemp("/tmp/amux-v19-auth-");
  try {
    await chmod(directory, 0o700);
    const file = join(directory, channel.auth === "copilot" ? "auth-token" : "auth.json");
    await writeFile(file, inspected.copy, { flag: "wx", mode: 0o400 });
    return Object.freeze({ directory, file, secrets: Object.freeze(inspected.secrets) });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally { inspected.copy.fill(0); }
}

/** Immediately before bwrap: both private copies are still the runner's. */
export async function verifyAmuxV19StagedChannel(staged) {
  const cliDirectory = staged?.installPath?.slice(0, staged.installPath.lastIndexOf("/"));
  if (!STAGED_ROOT.test(cliDirectory ?? "") ||
      !AUTH_DIRECTORY.test(staged?.authDirectory ?? "")) throw unsafe("staged channel");
  const [cli, authDirectory, authFile] = await Promise.all([lstat(cliDirectory),
    lstat(staged.authDirectory), lstat(staged.authFile)]);
  if (!cli.isDirectory() || cli.uid !== uid() || (cli.mode & 0o777) !== 0o700 ||
      !authDirectory.isDirectory() || authDirectory.uid !== uid() ||
      (authDirectory.mode & 0o777) !== 0o700 ||
      !authFile.isFile() || authFile.uid !== uid() || authFile.nlink !== 1 ||
      (authFile.mode & 0o777) !== 0o400 ||
      staged.authFile.slice(0, staged.authFile.lastIndexOf("/")) !== staged.authDirectory)
    throw unsafe("staged channel");
}

export async function removeAmuxV19StagedAuth(staged) {
  if (!AUTH_DIRECTORY.test(staged?.directory ?? "")) throw unsafe("staged auth");
  try { await unlink(staged.file); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await rmdir(staged.directory);
}

/** One cheap check at the credential boundary: an answer that repeats any
 * part of a staged credential is never released. JWT checks cover the
 * signature segment; the header is not secret and is shared by all JWTs. */
export function amuxV19OutputRevealsSecret(text, secrets) {
  if (typeof text !== "string" || !Array.isArray(secrets)) return true;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 16) continue;
    if (text.includes(secret)) return true;
    const parts = secret.split(".");
    const body = parts.length === 3 ? parts[2] : secret;
    for (let start = 0; start + 24 <= body.length; start += 12)
      if (text.includes(body.slice(start, start + 24))) return true;
  }
  return false;
}
