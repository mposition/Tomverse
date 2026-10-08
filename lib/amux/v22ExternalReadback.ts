import "server-only";

import { classifyAmuxV22PrReadback, type AmuxV22ExternalReadback } from
  "@/lib/amux/v22ExternalAuthorityCore";

const API = "https://api.github.com/repos/mposition/Tomverse/pulls";
const BRANCH = /^agent\/engineering\/[a-z0-9-]{1,64}$/;
const SHA = /^[0-9a-f]{40}$/i;
const MAX_RESPONSE_BYTES = 128 * 1024;

type FetchLike = typeof fetch;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

async function boundedJson(response: Response): Promise<unknown> {
  const claimed = response.headers.get("content-length");
  if (claimed && /^\d+$/.test(claimed) && Number(claimed) > MAX_RESPONSE_BYTES)
    throw new Error("oversized");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing_body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error("oversized");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/**
 * Read-only diagnostic for a lost PR-create response. It never grants a retry,
 * approval or merge. GitHub list/search incompleteness stays outcome_unknown.
 */
export async function readAmuxV22PrCreationOutcome(input: {
  branch: string;
  baseSha: string;
  headSha: string;
}, fetchImpl: FetchLike = fetch): Promise<AmuxV22ExternalReadback> {
  if (!BRANCH.test(input.branch) || !SHA.test(input.baseSha) ||
      !SHA.test(input.headSha))
    return { status: "outcome_unknown", reason: "invalid_binding" };
  const token = process.env.AMUX_REVIEW_GITHUB_READ_TOKEN?.trim();
  if (!token) return { status: "outcome_unknown", reason: "readback_unavailable" };
  const url = new URL(API);
  url.searchParams.set("state", "all");
  url.searchParams.set("head", `mposition:${input.branch}`);
  url.searchParams.set("base", "develop");
  url.searchParams.set("per_page", "20");
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET", cache: "no-store", redirect: "error",
      signal: AbortSignal.timeout(8_000),
      headers: { Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!response.ok || response.headers.get("link")?.includes('rel="next"')) {
      await response.body?.cancel().catch(() => undefined);
      return { status: "outcome_unknown", reason: "readback_unavailable" };
    }
    const value = await boundedJson(response);
    if (!Array.isArray(value))
      return { status: "outcome_unknown", reason: "readback_unavailable" };
    const observed = value.map((entry) => {
      const pr = record(entry);
      const base = record(pr?.base);
      const head = record(pr?.head);
      const baseRepo = record(base?.repo);
      const headRepo = record(head?.repo);
      if (!pr || !base || !head ||
          baseRepo?.full_name !== "mposition/Tomverse" ||
          headRepo?.full_name !== "mposition/Tomverse" ||
          base.ref !== "develop" || typeof head.ref !== "string" ||
          typeof base.sha !== "string" || typeof head.sha !== "string" ||
          typeof pr.number !== "number") throw new Error("invalid_pr");
      return { number: pr.number, branch: head.ref,
        baseSha: base.sha, headSha: head.sha };
    });
    return classifyAmuxV22PrReadback({ expectedBranch: input.branch,
      expectedBaseSha: input.baseSha, expectedHeadSha: input.headSha,
      observed });
  } catch {
    return { status: "outcome_unknown", reason: "readback_unavailable" };
  }
}
