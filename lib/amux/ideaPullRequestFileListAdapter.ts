import {
  AMUX_V4_PR_FILE_LIST_MAX,
  inspectAmuxPullRequestFileList,
  type AmuxPullRequestFileEntry,
  type AmuxPullRequestFileListResult,
  type AmuxPullRequestObservation,
} from "./ideaPullRequestFileListCore.ts";

/** Dark collector-only adapter. Never import this into the model CLI process. */
const API_ORIGIN = "https://api.github.com";
const API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 8_000;
const COLLECTION_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const GITHUB_MAX_PER_PAGE = 100;
const NAME = /^[A-Za-z0-9_.-]+$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export class AmuxIdeaPullRequestReadError extends Error {
  constructor(readonly code:
    | "invalid_collector_config" | "transport_error" | "http_error"
    | "oversized_response" | "invalid_response" | "wrong_repository") {
    super(code); // Do not include upstream response text, URLs, paths or tokens.
    this.name = "AmuxIdeaPullRequestReadError";
  }
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue : null;
const validId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
const validName = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max &&
  value !== "." && value !== ".." && NAME.test(value);
const fail = (code: AmuxIdeaPullRequestReadError["code"]): never => {
  throw new AmuxIdeaPullRequestReadError(code);
};

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    return fail("http_error");
  }
  if (!response.headers.get("content-type")?.toLowerCase().includes("json")) {
    void response.body?.cancel().catch(() => undefined);
    return fail("invalid_response");
  }
  const reader = response.body?.getReader();
  if (!reader) return fail("invalid_response");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        return fail("oversized_response");
      }
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof AmuxIdeaPullRequestReadError) throw error;
    return fail("transport_error");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail("invalid_response");
  }
}

export type AmuxIdeaPullRequestReaderConfig = {
  owner: string;
  repo: string;
  expectedRepositoryId: number;
  /** Dedicated read-only token: repository metadata and Pull requests read. */
  token: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

/**
 * This returns a witness, not source bytes or transfer permission. A caller
 * must still verify the selected base/head file at its immutable SHA and
 * repeat the complete source check immediately before external transfer.
 */
export async function collectAmuxIdeaPullRequestFileList(
  config: AmuxIdeaPullRequestReaderConfig,
  number: number,
): Promise<AmuxPullRequestFileListResult> {
  if (!config || !validName(config.owner, 64) || !validName(config.repo, 100) ||
      !validId(config.expectedRepositoryId) || !validId(number) ||
      typeof config.token !== "string" || !config.token.trim() ||
      config.token !== config.token.trim() ||
      /[\r\n]/.test(config.token) ||
      AMUX_V4_PR_FILE_LIST_MAX > GITHUB_MAX_PER_PAGE ||
      (config.fetchImpl !== undefined && typeof config.fetchImpl !== "function")) {
    return { status: "hold", reason: "invalid_collector_config" };
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const overallSignal = config.signal
    ? AbortSignal.any([config.signal, AbortSignal.timeout(COLLECTION_TIMEOUT_MS)])
    : AbortSignal.timeout(COLLECTION_TIMEOUT_MS);
  const repositoryPath = `/repos/${config.owner}/${config.repo}`;
  const expectedName = `${config.owner}/${config.repo}`.toLowerCase();

  async function request(path: string): Promise<{ body: unknown; link: string | null }> {
    let response: Response;
    try {
      response = await fetchImpl(`${API_ORIGIN}${path}`, {
        method: "GET",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.any([overallSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${config.token}`,
          "X-GitHub-Api-Version": API_VERSION,
        },
      });
    } catch {
      return fail("transport_error");
    }
    const link = response.headers.get("link");
    return { body: await boundedJson(response), link };
  }

  async function readRepositoryIdentity(): Promise<void> {
    const repository = record((await request(repositoryPath)).body);
    if (!repository || repository.id !== config.expectedRepositoryId ||
        typeof repository.full_name !== "string" ||
        repository.full_name.toLowerCase() !== expectedName) return fail("wrong_repository");
  }

  async function readPullRequest(): Promise<AmuxPullRequestObservation> {
    const pr = record((await request(`${repositoryPath}/pulls/${number}`)).body);
    const base = record(pr?.base);
    const head = record(pr?.head);
    const baseRepo = record(base?.repo);
    const headRepo = record(head?.repo);
    // Closed or merged PRs are still eligible as immutable-source candidates.
    if (!pr || !base || !head || !baseRepo || !headRepo ||
        pr.number !== number || !validId(baseRepo.id) || !validId(headRepo.id) ||
        typeof base.sha !== "string" || !SHA.test(base.sha) ||
        typeof head.sha !== "string" || !SHA.test(head.sha) ||
        !Number.isSafeInteger(pr.changed_files) || (pr.changed_files as number) < 0) {
      return fail("invalid_response");
    }
    return {
      repositoryId: config.expectedRepositoryId,
      number,
      baseRepositoryId: baseRepo.id,
      headRepositoryId: headRepo.id,
      baseSha: base.sha,
      headSha: head.sha,
      changedFiles: pr.changed_files as number,
    };
  }

  try {
    await readRepositoryIdentity();
    const before = await readPullRequest();
    if (before.changedFiles < 1 || before.changedFiles > AMUX_V4_PR_FILE_LIST_MAX ||
        before.baseRepositoryId !== config.expectedRepositoryId ||
        before.headRepositoryId !== config.expectedRepositoryId) {
      return { status: "hold", reason: "pr_snapshot_unverified" };
    }
    const fileResponse = await request(
      `${repositoryPath}/pulls/${number}/files?per_page=${AMUX_V4_PR_FILE_LIST_MAX}&page=1`,
    );
    if (!Array.isArray(fileResponse.body)) return fail("invalid_response");
    const files = fileResponse.body.map((raw: unknown): AmuxPullRequestFileEntry => {
      const file = record(raw);
      if (!file || typeof file.filename !== "string" || typeof file.status !== "string" ||
          (file.previous_filename !== undefined &&
           typeof file.previous_filename !== "string")) return fail("invalid_response");
      return {
        filename: file.filename,
        status: file.status,
        previousFilename: file.previous_filename === undefined ? null : file.previous_filename,
      };
    });
    const after = await readPullRequest();
    await readRepositoryIdentity();
    return inspectAmuxPullRequestFileList(before, {
      page: 1,
      perPage: AMUX_V4_PR_FILE_LIST_MAX,
      // With <=100 declared changes, any pagination Link is unexpected.
      // Reject it instead of parsing a possibly unfamiliar next-link form.
      hasNext: fileResponse.link !== null,
      files,
    }, after);
  } catch (error) {
    return {
      status: "hold",
      reason: error instanceof AmuxIdeaPullRequestReadError
        ? error.code : "pr_collection_unverified",
    };
  }
}
