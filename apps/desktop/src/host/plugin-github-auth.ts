import { PluginError } from "../../../tomverse-cli/src/runtime.js";
import type { GitAuth } from "../../../tomverse-cli/src/runtime.js";
import { ghPassthroughEnv, readGhStatus, type GhRunner } from "./github-cli";

/**
 * A private github.com repository, read with the GitHub sign-in the person already has in the GitHub CLI (the same one the Git and pull
 * request features use). Desktop does not ask for, receive, store or log a token: git is told to ask `gh auth git-credential` for it, and
 * only for github.com. All that is built here is the command that names `gh` and the names of the settings `gh` itself reads. The caller
 * has already asked the person whether to use their sign-in for this download.
 */
export async function githubGitAuth(input: { run: GhRunner | null; program: string | null; env?: NodeJS.ProcessEnv }): Promise<GitAuth> {
  if (!input.run || !input.program) throw new PluginError("The GitHub CLI (gh) is not installed. Install it and sign in with “gh auth login”, then try again.");
  const status = await readGhStatus(input.run);
  if (status.state === "missing") throw new PluginError("The GitHub CLI (gh) is not installed. Install it and sign in with “gh auth login”, then try again.");
  if (status.state !== "ready") throw new PluginError("You are not signed in to GitHub. Run “gh auth login”, then try again.");
  // Forward slashes work for git's own shell on Windows, and the single quotes keep a folder name with a space in one piece.
  const program = input.program.replace(/\\/g, "/");
  if (/['\u0000-\u001f]/.test(program)) throw new PluginError("The GitHub CLI is in a folder this app cannot use for sign-in.");
  return { credentialHelper: `!'${program}' auth git-credential`, env: ghPassthroughEnv(input.env ?? process.env) };
}
