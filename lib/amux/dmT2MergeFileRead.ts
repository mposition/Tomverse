import "server-only";

/**
 * The whole text of a Decision Maker approved change's files at the approved
 * head, for the block list merge scope's whole-file check
 * (lib/amux/dmT2MergeCore.ts amuxDmT2MergeFileGate; review
 * r-20261115-112803-cbb35d). Read with the engineering agent's read-only
 * token, which already reads the same pull request's diff and files
 * (lib/engineeringAgentGitHubRead.ts); nothing is written. Every file is read
 * at one commit id, never a branch, so what is judged is what the lane merges.
 * A file that is gone at the head (404), not text, or larger than the bound
 * is `null`, which the gate leaves to a person; any other failure throws and
 * the caller lists nothing this round.
 */

const REPOSITORY = "mposition/Tomverse";
const API_ORIGIN = "https://api.github.com";
const API_VERSION = "2022-11-28";
const TIMEOUT_MS = 8_000;
/** The token's variable (lib/engineeringAgentGitHubRead.ts ENGINEERING_AGENT_GITHUB_READ_TOKEN_ENV). */
const TOKEN_ENV = "ENGINEERING_AGENT_GITHUB_READ_TOKEN";
const SHA = /^[0-9a-f]{40}$/;
export const AMUX_DM_T2_MERGE_FILE_MAX_BYTES = 512 * 1024;
export const AMUX_DM_T2_MERGE_FILE_MAX_COUNT = 20;

type Deps = { env?: Readonly<Record<string, string | undefined>>; fetchImpl?: typeof fetch };

export async function readAmuxDmT2MergeFilesAt(headSha: string, paths: readonly string[],
  deps: Deps = {}): Promise<Map<string, string | null>> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const token = env[TOKEN_ENV]?.trim();
  if (!token) throw new Error("token_missing");
  if (!SHA.test(headSha) || paths.length > AMUX_DM_T2_MERGE_FILE_MAX_COUNT) throw new Error("invalid_input");
  const files = new Map<string, string | null>();
  for (const path of paths) {
    const url = `${API_ORIGIN}/repos/${REPOSITORY}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${headSha}`;
    const response = await fetchImpl(url, {
      method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: "application/vnd.github.raw", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": API_VERSION },
    });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      files.set(path, null);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("http_error");
    }
    const claimed = response.headers.get("content-length");
    if (claimed !== null && /^\d+$/.test(claimed) && Number(claimed) > AMUX_DM_T2_MERGE_FILE_MAX_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      files.set(path, null);
      continue;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > AMUX_DM_T2_MERGE_FILE_MAX_BYTES) {
      files.set(path, null);
      continue;
    }
    try {
      files.set(path, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      files.set(path, null);
    }
  }
  return files;
}
