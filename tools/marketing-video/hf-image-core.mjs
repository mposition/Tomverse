// One Higgsfield picture through the official Higgsfield CLI (`@higgsfield/cli`),
// behind the cap in higgsfield-cap.mjs. Deterministic: a model only wrote the
// prompt file; it never runs this, and no model call has a shell on this path.
//
// Why the CLI and not the HTTP API (checked 2026-11-08 against Higgsfield's own
// docs): the API's model catalogue has no GPT Image 2.6 and bills a separate
// prepaid balance, while the CLI (like Higgsfield's MCP) draws on the web
// plan's credits, the Plus plan the owner took.
//
// Order of a call, so that no outcome is ever unknown and resent:
//  1. every earlier call of the day whose outcome is unknown is looked up by
//     its job id (`generate get`); one that stays unknown, or has no id,
//     refuses this call;
//  1b. each reference picture is uploaded once a day (`upload create`) and
//     passed by its upload id: a local path makes the CLI upload the file
//     again on every command, so `cost` and `create` each uploaded every
//     logo and base picture (324 copies on 2026-11-13 for 41 pictures);
//  2. `generate cost` prices the exact request without submitting it; a price
//     above HF_MAX_CALL_COST, or one that cannot be read, refuses it;
//  3. the ledger admits it (model, ratio, one picture, daily cap) and records
//     it before anything is submitted;
//  4. `generate create` without waiting, so the job id is known and recorded
//     at once; if create answers no id, the call stays unknown with no id
//     and blocks the day; more than one id blocks the day too;
//  5. `generate wait <id> --timeout 20m` (the CLI's own flag: an unknown flag
//     makes it exit at once, which stopped the first run on 2026-11-09); a
//     timeout leaves the entry unknown with its id, for step 1 of the next call.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { admit, brisbaneDay, downloadResult, HF_ASPECT_RATIO, HF_MODEL, ledgerPath, requestProblem, resolveUnsettled, settle } from "./higgsfield-cap.mjs";

/** A picture is priced at 0.25 credits (owner's trial); twice that is a sign the request is not the one priced. */
export const HF_MAX_CALL_COST = 0.5;
const DONE = new Set(["completed", "succeeded", "success", "done"]);
const FAILED = new Set(["failed", "nsfw", "canceled", "cancelled", "error"]);

/** Runs the CLI: `HIGGSFIELD_BIN` (a .mjs is run with node) or `higgsfield` on the PATH. */
export function cliRunner(env = process.env) {
  const bin = env.HIGGSFIELD_BIN || "higgsfield";
  return (args, { timeoutMs = 120_000 } = {}) => {
    const [command, prefix] = /\.m?js$/u.test(bin) ? [process.execPath, [bin]] : [bin, []];
    const out = spawnSync(command, [...prefix, ...args], { encoding: "utf8", timeout: timeoutMs, env: cliEnv(env), maxBuffer: 16 * 1024 * 1024 });
    return { status: out.error ? null : out.status, stdout: out.stdout ?? "", stderr: out.stderr ?? "", timedOut: out.error?.code === "ETIMEDOUT" };
  };
}

/** The CLI gets the box's own login, never the job's submission secret. */
function cliEnv(env) {
  const copy = { ...env };
  delete copy.MARKETING_MEDIA_SUBMIT_SECRET;
  delete copy.MARKETING_APP_URL;
  return copy;
}

/** Every value under `node` (objects and arrays, depth first). */
function* walk(node) {
  yield node;
  if (Array.isArray(node)) for (const item of node) yield* walk(item);
  else if (node && typeof node === "object") for (const value of Object.values(node)) yield* walk(value);
}

export function parseJson(text) {
  const trimmed = String(text ?? "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // The CLI may print a line before its JSON.
    const start = trimmed.search(/[[{]/u);
    return start >= 0 ? JSON.parse(trimmed.slice(start)) : null;
  }
}

const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The day's upload ids by the sha256 of the uploaded bytes. A new file each day, so an upload deleted in Higgsfield's library is not used again past that day. */
export const uploadsPath = (jobDir, day) => path.join(jobDir, `higgsfield-uploads-${day}.json`);

/** The id an `upload create --json` answered (`id`, `upload_id` or `media_id`, on the top object or one under it), or null. */
export function uploadIdOf(value) {
  for (const node of walk(value)) {
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    for (const key of ["id", "upload_id", "media_id"]) if (typeof node[key] === "string" && UPLOAD_ID.test(node[key])) return node[key];
  }
  return null;
}

/**
 * Each reference as an upload id. A local file is uploaded only the first time
 * its bytes are seen that day; an id (upload or job) is passed through. Nothing
 * is spent by an upload, and one that fails stops the picture before pricing.
 */
export function referenceIds(references, { jobDir, day, cli }) {
  const file = uploadsPath(jobDir, day);
  let known = {};
  try {
    known = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) ?? {} : {};
  } catch {
    known = {};
  }
  const ids = [];
  for (const reference of references) {
    if (UPLOAD_ID.test(reference)) {
      ids.push(reference);
      continue;
    }
    let bytes;
    try {
      bytes = readFileSync(reference);
    } catch {
      return { ok: false, reason: "reference_unreadable", detail: { file: path.basename(reference) } };
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (!known[hash]) {
      const uploaded = cli(["upload", "create", reference, "--json"]);
      let id = null;
      try {
        id = uploaded.status === 0 ? uploadIdOf(parseJson(uploaded.stdout)) : null;
      } catch {
        id = null;
      }
      if (!id) return { ok: false, reason: "reference_upload_failed", detail: { file: path.basename(reference), status: uploaded.status } };
      known[hash] = id;
      // Before the ledger exists, so the job folder may not yet.
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(known, null, 2)}
`);
    }
    ids.push(known[hash]);
  }
  return { ok: true, ids };
}

/** The job ids a create answered: `id`, `job_id` or `request_id` on the top object or its list. */
export function jobIdsOf(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.jobs) ? value.jobs : [value];
  return list.map((item) => (typeof item === "string" ? item : item?.id ?? item?.job_id ?? item?.request_id)).filter((id) => typeof id === "string" && id.length > 0);
}

/** "done", "failed" or "unknown" for one job object (or a list holding it). */
export function outcomeOf(value) {
  const job = Array.isArray(value) ? value[0] : value?.job ?? value;
  const status = String(job?.status ?? "").toLowerCase();
  if (DONE.has(status)) return "done";
  if (FAILED.has(status)) return "failed";
  return "unknown";
}

/**
 * The full-size picture of a finished job: its `result_url` (the CLI's
 * `generate get/wait --json`, seen on the box 2026-11-09). Never the first URL
 * in the answer: `min_result_url` (a small webp preview) comes before it, and
 * `params.medias` holds the uploaded reference pictures.
 */
export function resultUrlOf(value) {
  const job = Array.isArray(value) ? value[0] : value?.job ?? value;
  const url = job?.result_url;
  return typeof url === "string" && /^https:\/\/\S+$/u.test(url) ? url : null;
}

/** The credits `generate cost --json` answered, or null. */
export function costOf(value) {
  if (typeof value === "number") return value;
  for (const node of walk(value)) {
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    for (const key of ["credits", "cost", "total_credits", "credit_cost", "price"]) {
      const amount = node[key];
      if (typeof amount === "number" && Number.isFinite(amount)) return amount;
      if (typeof amount === "string" && /^\d+(?:\.\d+)?$/u.test(amount)) return Number(amount);
    }
  }
  return null;
}

const requestArgs = (request) => [
  HF_MODEL,
  "--prompt",
  request.prompt,
  "--aspect_ratio",
  HF_ASPECT_RATIO,
  ...(request.image_references ?? []).flatMap((file) => ["--image-references", file]),
  "--json",
];

/**
 * Makes one picture and writes it to `out`.
 * @returns {Promise<{ok: true, jobId: string, cost: number, out: string} | {ok: false, reason: string, detail?: object}>}
 */
export async function makeImage({ prompt, references = [], out, label, jobDir, env = process.env, cli = cliRunner(env), fetchBytes = defaultFetch, day = brisbaneDay() }) {
  let request = { model: HF_MODEL, aspect_ratio: HF_ASPECT_RATIO, count: 1, prompt, ...(references.length > 0 ? { image_references: references } : {}) };
  const problem = requestProblem(request);
  if (problem) return { ok: false, reason: problem };
  const file = ledgerPath(jobDir, day);

  const lookup = (jobId) => {
    const got = cli(["generate", "get", jobId, "--json"]);
    if (got.status !== 0) return "unknown";
    return outcomeOf(parseJson(got.stdout));
  };
  const open = await resolveUnsettled(file, lookup);
  if (open.length > 0) return { ok: false, reason: "unknown_outcome_pending", detail: { entries: open.map((entry) => entry.id) } };

  if (references.length > 0) {
    const uploaded = referenceIds(references, { jobDir, day, cli });
    if (!uploaded.ok) return uploaded;
    request = { ...request, image_references: uploaded.ids };
  }

  const priced = cli(["generate", "cost", ...requestArgs(request)]);
  let cost = null;
  try {
    cost = priced.status === 0 ? costOf(parseJson(priced.stdout)) : null;
  } catch {
    cost = null;
  }
  if (cost === null) return { ok: false, reason: "cost_unreadable" };
  if (cost > HF_MAX_CALL_COST) return { ok: false, reason: "cost_above_call_ceiling", detail: { cost, ceiling: HF_MAX_CALL_COST } };

  const admitted = admit({ jobDir, day, env, request, label, cost });
  if (!admitted.ok) return admitted;
  const { entry } = admitted;

  const created = cli(["generate", "create", ...requestArgs(request)]);
  let ids = [];
  try {
    ids = created.status === 0 ? jobIdsOf(parseJson(created.stdout)) : [];
  } catch {
    ids = [];
  }
  if (ids.length === 0) {
    // Whether a job started is not known, and nothing ties a listed job to
    // this request (a job missing from the list may not be listed yet; a job
    // in it may be an earlier one). So the entry keeps no job id and blocks the
    // rest of the day until a person has looked at Higgsfield's history.
    settle(file, entry.id, { status: "unknown" });
    return { ok: false, reason: "create_outcome_unknown", detail: { status: created.status, timedOut: created.timedOut } };
  }
  if (ids.length > 1) {
    // More than the one picture admitted: every id is kept, each counted at the
    // quoted price, and the day is blocked until a person has looked at them.
    settle(file, entry.id, { status: "unknown", jobIds: ids, cost: entry.cost * ids.length });
    return { ok: false, reason: "more_than_one_job", detail: { jobs: ids.length } };
  }
  const [jobId] = ids;
  settle(file, entry.id, { status: "unknown", jobId });

  const waited = cli(["generate", "wait", jobId, "--timeout", "20m", "--quiet", "--json"], { timeoutMs: 21 * 60_000 });
  let job = null;
  try {
    job = waited.status === 0 ? parseJson(waited.stdout) : null;
  } catch {
    job = null;
  }
  const outcome = job ? outcomeOf(job) : "unknown";
  // What the wait said goes into the report: on 2026-11-12 a wait ended within a
  // minute with an outcome no one could read afterwards.
  if (outcome === "unknown") {
    const job0 = Array.isArray(job) ? job[0] : job?.job ?? job;
    return { ok: false, reason: "wait_outcome_unknown", detail: { jobId, status: waited.status, timedOut: waited.timedOut, jobStatus: job0?.status ?? null, stderr: String(waited.stderr ?? "").trim().slice(-300), stdout: job ? null : String(waited.stdout ?? "").trim().slice(-300) } };
  }
  settle(file, entry.id, { status: outcome, jobId });
  if (outcome === "failed") return { ok: false, reason: "job_failed", detail: { jobId } };

  const url = resultUrlOf(job);
  if (!url) return { ok: false, reason: "no_result_url", detail: { jobId } };
  const bytes = await fetchBytes(url).catch(() => null);
  if (!isPicture(bytes)) return { ok: false, reason: "result_not_a_picture", detail: { jobId } };
  writeFileSync(out, bytes);
  return { ok: true, jobId, cost, out };
}

/** PNG, JPEG or WebP, by their first bytes. */
export function isPicture(bytes) {
  if (!bytes || bytes.length < 12) return false;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const webp = bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP";
  return png || jpeg || webp;
}

const defaultFetch = (url) => downloadResult(url, { maxBytes: 40 * 1024 * 1024 });
