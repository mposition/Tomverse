import { randomBytes } from "node:crypto";

import { collectAmuxGitHubFileCandidate,
  type AmuxGitHubFileCandidateResult } from "./ideaGitHubFileCandidate.ts";
import { prepareAmuxGitHubExcerptPreview } from "./ideaGitHubExcerptPreviewCore.ts";
import { pollAmuxV4CollectionCandidateIds,
  AMUX_V4_COLLECTION_APP_ORIGIN_ENV } from "./ideaLocalCollectionQueuePoll.mjs";

type FetchLike = typeof fetch;
type Credential = { owner: string; repo: string; expectedRepositoryId: number; token: string };
type Claim = { collectionRequestId: string; requestId: string; previewId: string;
  requestDigest: string; leaseGeneration: 1; leaseId: string;
  leaseExpiresAt: string; sourceByteLimit: 8_192; idea: string;
  source: { kind: "repository_file"; repository: string; commitSha: string; path: string };
  collectionVerified: false; transferAuthorized: false };
type Result = { schemaVersion: 1; collectionRequestId: string; requestId: string;
  previewId: string; requestDigest: string; leaseId: string;
  leaseGeneration: 1 } & (
    { outcome: "hold"; reason: "collector_timeout" | "collector_unavailable" |
      "source_unverified" | "source_selection_invalid" | "input_rejected" | "source_too_large" } |
    { outcome: "preview_candidate"; source: {
      sourceIndex: 0; repositoryId: number; refName: string;
      refObjectSha: string; refCommitSha: string; commitSha: string;
      path: string; blobSha: string; fileSha256: string;
      startByte: number; endByte: number; excerptText: string } });

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const REPO = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,100}$/;
const PATH = /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/;
const APP_RESPONSE_MAX = 16_384;
const APP_RESULT_MAX = 16_384;
const APP_TIMEOUT_MS = 5_000;
const CREDENTIAL_TIMEOUT_MS = 5_000;
const COLLECTION_TIMEOUT_MS = 35_000;
const GITHUB_LIMITS = { maxPages: 3, maxRefs: 200,
  maxComparisons: 200, maxTagDepth: 4 } as const;

function pinnedAppOrigin(origin: string): string | null {
  try {
    const input = new URL(origin);
    const pinned = new URL(process.env[AMUX_V4_COLLECTION_APP_ORIGIN_ENV] ?? "");
    if (input.protocol !== "https:" || input.username || input.password ||
        input.pathname !== "/" || input.search || input.hash ||
        pinned.toString() !== input.toString()) return null;
    return input.origin;
  } catch { return null; }
}

async function boundedWork<T>(durationMs: number,
  work: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
  const signal = AbortSignal.timeout(durationMs);
  let onAbort: (() => void) | null = null;
  const expired = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([work(signal), expired]); }
  catch { return null; }
  finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
}

async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json") {
    try { await response.body?.cancel(); } catch { /* No upstream content in diagnostics. */ }
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) return null;
      total += value.byteLength;
      if (total > maxBytes) return null;
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true })
      .decode(Buffer.concat(chunks, total)));
  } catch { return null; }
  finally {
    try { await reader.cancel(); } catch { /* Never log upstream content. */ }
    reader.releaseLock();
  }
}

async function appPost(origin: string, path: string, collectorSecret: string,
  body: object, fetchImpl: FetchLike): Promise<{ status: number; body: unknown } | null> {
  const endpoint = `${origin}${path}`;
  const raw = JSON.stringify(body);
  if (Buffer.byteLength(raw, "utf8") > APP_RESULT_MAX) return null;
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST", redirect: "manual", cache: "no-store",
      signal: AbortSignal.timeout(APP_TIMEOUT_MS),
      headers: { authorization: `Bearer ${collectorSecret}`,
        "x-amux-agent-id": "amux-v4-source-collector",
        "content-type": "application/json" }, body: raw,
    });
    if (response.url && response.url !== endpoint) {
      try { await response.body?.cancel(); } catch { /* No upstream content in diagnostics. */ }
      return null;
    }
    return { status: response.status,
      body: await boundedJson(response, APP_RESPONSE_MAX) };
  } catch { return null; }
}

function validClaim(value: unknown, collectionRequestId: string): value is Claim {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claim = value as Record<string, unknown>;
  const source = claim.source && typeof claim.source === "object" &&
    !Array.isArray(claim.source) ? claim.source as Record<string, unknown> : null;
  const iso = (input: unknown) => typeof input === "string" &&
    Number.isFinite(Date.parse(input));
  return Object.keys(claim).length === 12 &&
    ["collectionRequestId", "requestId", "previewId", "leaseId"].every((key) =>
      typeof claim[key] === "string" && UUID.test(claim[key] as string)) &&
    claim.collectionRequestId === collectionRequestId &&
    typeof claim.requestDigest === "string" && DIGEST.test(claim.requestDigest) &&
    claim.leaseGeneration === 1 && claim.sourceByteLimit === 8_192 &&
    iso(claim.leaseExpiresAt) && Date.parse(claim.leaseExpiresAt as string) > Date.now() &&
    typeof claim.idea === "string" && Buffer.byteLength(claim.idea, "utf8") <= 8_192 &&
    claim.collectionVerified === false && claim.transferAuthorized === false &&
    source !== null && Object.keys(source).length === 4 &&
    source.kind === "repository_file" && typeof source.repository === "string" &&
    REPO.test(source.repository) && typeof source.commitSha === "string" &&
    SHA.test(source.commitSha) && typeof source.path === "string" &&
    PATH.test(source.path);
}

function validCredential(value: Credential | null, repository: string): value is Credential {
  return !!value && Number.isSafeInteger(value.expectedRepositoryId) &&
    value.expectedRepositoryId > 0 && typeof value.owner === "string" &&
    typeof value.repo === "string" && `${value.owner}/${value.repo}`.toLowerCase() ===
      repository.toLowerCase() && typeof value.token === "string" &&
    value.token.length > 0 && !/[\r\n]/.test(value.token);
}

function resultIdentity(claim: Claim) {
  return { schemaVersion: 1 as const, collectionRequestId: claim.collectionRequestId,
    requestId: claim.requestId, previewId: claim.previewId,
    requestDigest: claim.requestDigest, leaseId: claim.leaseId,
    leaseGeneration: 1 as const };
}

function hold(claim: Claim, reason: Extract<Result, { outcome: "hold" }>["reason"]): Result {
  return { ...resultIdentity(claim), outcome: "hold", reason };
}

/** One manual invocation only. It never starts a process, schedules itself,
 * calls a model or exposes GitHub credentials to the app transport. */
export async function runAmuxV4SourceCollectorOnce(input: {
  origin: string; collectorSecret: string;
  resolveCredential: (repository: string, signal: AbortSignal) => Promise<Credential | null>;
  appFetchImpl?: FetchLike; githubFetchImpl?: FetchLike;
  collectCandidate?: typeof collectAmuxGitHubFileCandidate;
}): Promise<{ kind: "idle" | "refused" | "disabled" | "unavailable" |
  "claim_unknown" | "result_unknown" | "preview_ready" | "hold" }> {
  const origin = pinnedAppOrigin(input.origin);
  if (!origin || typeof input.collectorSecret !== "string" ||
      !SECRET.test(input.collectorSecret) ||
      typeof input.resolveCredential !== "function") return { kind: "refused" };
  const appFetch = input.appFetchImpl ?? fetch;
  const queue = await pollAmuxV4CollectionCandidateIds({ origin,
    collectorSecret: input.collectorSecret, fetchImpl: appFetch });
  if (queue.kind !== "candidates") return { kind: queue.kind };
  const candidate = queue.candidates[0];
  if (!candidate) return { kind: "idle" };
  const claimed = await appPost(origin, "/api/internal/amux/v4/collection-claim",
    input.collectorSecret, { collectionRequestId: candidate.collectionRequestId }, appFetch);
  if (claimed?.status === 409) return { kind: "disabled" };
  if (!claimed || claimed.status !== 200 ||
      !validClaim(claimed.body, candidate.collectionRequestId)) return { kind: "claim_unknown" };
  const claim = claimed.body;
  let result: Result;
  const credential = await boundedWork(CREDENTIAL_TIMEOUT_MS,
    (signal) => input.resolveCredential(claim.source.repository, signal));
  if (!validCredential(credential, claim.source.repository)) {
    result = hold(claim, "source_unverified");
  } else {
    const collected = await boundedWork<AmuxGitHubFileCandidateResult>(
      COLLECTION_TIMEOUT_MS, (signal) => {
      const collect = input.collectCandidate ?? collectAmuxGitHubFileCandidate;
      return collect({ ...credential, fetchImpl: input.githubFetchImpl, signal },
        claim.source.commitSha, claim.source.path, GITHUB_LIMITS);
      });
    if (collected?.status !== "unscanned_candidate") {
      result = hold(claim, collected ? "source_unverified" : "collector_unavailable");
    } else if (collected.file.commitSha !== claim.source.commitSha ||
        collected.file.path !== claim.source.path ||
        collected.file.repositoryId !== credential.expectedRepositoryId ||
        collected.witness.repositoryId !== credential.expectedRepositoryId) {
      result = hold(claim, "source_selection_invalid");
    } else if (collected.file.size > claim.sourceByteLimit ||
        Buffer.byteLength(claim.idea, "utf8") + collected.file.size > claim.sourceByteLimit) {
      result = hold(claim, "source_too_large");
    } else {
      const scanned = prepareAmuxGitHubExcerptPreview(claim.idea,
        "amux-v4-source-collector", [{ candidate: collected, startByte: 0,
          endByte: collected.file.size }], randomBytes(32).toString("hex"));
      const source = scanned.status === "preview_candidate" ? scanned.sources[0] : null;
      result = source ? { ...resultIdentity(claim), outcome: "preview_candidate",
        source: { sourceIndex: 0, ...source } } : hold(claim, "input_rejected");
    }
  }
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > APP_RESULT_MAX) {
    result = hold(claim, "source_too_large");
  }
  const submitted = await appPost(origin, "/api/internal/amux/v4/collection-result",
    input.collectorSecret, result, appFetch);
  // The POST may have committed even if its reply was lost. Never retry here.
  if (!submitted || submitted.status !== 200 ||
      !submitted.body || typeof submitted.body !== "object" || Array.isArray(submitted.body)) {
    return { kind: "result_unknown" };
  }
  const reply = submitted.body as Record<string, unknown>;
  const expectedState = result.outcome === "hold" ? "hold" : "preview_ready";
  if (reply.collectionRequestId !== claim.collectionRequestId ||
      reply.requestId !== claim.requestId || reply.previewId !== claim.previewId ||
      reply.state !== expectedState || reply.collectionVerified !== false ||
      reply.transferAuthorized !== false ||
      (expectedState === "hold" ? reply.resultDigest !== null :
        typeof reply.resultDigest !== "string" || !DIGEST.test(reply.resultDigest))) {
    return { kind: "result_unknown" };
  }
  return { kind: expectedState };
}
