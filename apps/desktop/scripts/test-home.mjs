import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A throwaway home for Desktop tests. The skills, hooks and MCP servers in the real home of the machine the tests run on (`~/.claude`,
 * `~/.tomverse`, `~/.codex`) would otherwise change the tool list and the behavior the tests assert. The folders are empty and
 * separate, so a test that wants one of them writes it itself. A test that needs a folder the operating system really treats as the
 * person's home (the Windows sandbox keeps a low-integrity process out of the temp folder) reads TOMVERSE_TEST_REAL_HOME.
 */
export function createTestHome(parent = tmpdir()) {
  const root = mkdtempSync(join(parent, "tomverse-test-home-"));
  const folders = { home: join(root, "home"), claude: join(root, "claude"), tomverse: join(root, "tomverse"), codex: join(root, "codex") };
  for (const folder of Object.values(folders)) mkdirSync(folder, { recursive: true });
  return {
    root,
    env: {
      HOME: folders.home,
      USERPROFILE: folders.home,
      CLAUDE_CONFIG_DIR: folders.claude,
      TOMVERSE_HOME: folders.tomverse,
      CODEX_HOME: folders.codex,
      TOMVERSE_TEST_REAL_HOME: process.env.TOMVERSE_TEST_REAL_HOME ?? homedir(),
    },
    remove() { try { rmSync(root, { recursive: true, force: true }); } catch { /* A folder a process still holds is left to the temp cleaner. */ } },
  };
}
