import { lstat, realpath } from "node:fs/promises";

const PROFILE_ROOT = "/home/tommy/.amux-cli-profiles";
const PROFILE = `${PROFILE_ROOT}/claude-max`;
export const AMUX_V19_CLAUDE_MAX_AUTH_PATH = `${PROFILE}/oauth-token`;

/** The v19 CLI receives only its dedicated Max token. The v4 API-key profile
 * remains separate and cannot be substituted by the host or the caller. */
export async function verifyAmuxV19ClaudeMaxAuthSource(authPath) {
  if (process.platform !== "linux" ||
      typeof process.getuid !== "function" ||
      authPath !== AMUX_V19_CLAUDE_MAX_AUTH_PATH) {
    throw new TypeError("invalid AMUX v19 Claude Max auth source");
  }
  const [root, profile, auth, realRoot, realProfile, realAuth] = await Promise.all([
    lstat(PROFILE_ROOT), lstat(PROFILE), lstat(authPath),
    realpath(PROFILE_ROOT), realpath(PROFILE), realpath(authPath),
  ]);
  const uid = process.getuid();
  if (!root.isDirectory() || root.uid !== uid ||
      (root.mode & 0o777) !== 0o700 || realRoot !== PROFILE_ROOT ||
      !profile.isDirectory() || profile.uid !== uid ||
      (profile.mode & 0o777) !== 0o700 || realProfile !== PROFILE ||
      !auth.isFile() || auth.nlink !== 1 || auth.uid !== uid ||
      (auth.mode & 0o777) !== 0o600 || auth.size < 1 || auth.size > 4_096 ||
      realAuth !== authPath) {
    throw new TypeError("unsafe AMUX v19 Claude Max auth source");
  }
}
