// The creative short job's Higgsfield calls (owner 2026-11-09: a new,
// different ad every time, made with Higgsfield and ElevenLabs): a 9:16 start
// frame, a 5-second clip from it, and an instrumental music bed. Deterministic:
// a model only wrote the prompts; it never runs this.
//
// Same order as the image path (hf-image-core.mjs), so no outcome is ever
// unknown and resent: earlier unknown calls are looked up first, `generate
// cost` prices the exact request, the ledger admits it and records it before it
// is submitted, `create` without waiting records the job id at once, and a
// timeout leaves the entry unknown with its id.
//
// Its own ledger and cap, apart from the image path's:
//   job/creative-ledger-<yyyymmdd>.json (Brisbane day) and
//   MARKETING_CREATIVE_SHORT_DAILY_CREDIT_CAP; unset, zero or unreadable
//   refuses every call.
// Only these requests are allowed, every priced field at a fixed value:
//   image  gpt_image_2_6, 9:16, one picture
//   video  kling3_0, 9:16, 5 s, std, no sound, from a start frame's job id
//   music  elevenlabs_music_v2_5, instrumental, 10-40 s
import { writeFileSync } from "node:fs";
import path from "node:path";

import { admit, brisbaneDay, resolveUnsettled, settle } from "./higgsfield-cap.mjs";
import { cliRunner, costOf, isPicture, jobIdsOf, outcomeOf, parseJson, resultUrlOf } from "./hf-image-core.mjs";

export const CREATIVE_CAP_ENV = "MARKETING_CREATIVE_SHORT_DAILY_CREDIT_CAP";
export const creativeLedgerPath = (jobDir, day) => path.join(jobDir, `creative-ledger-${day}.json`);

const IMAGE = { model: "gpt_image_2_6", aspect_ratio: "9:16", count: 1 };
const VIDEO = { model: "kling3_0", aspect_ratio: "9:16", duration: 5, mode: "std", sound: "off" };
const MUSIC = { model: "elevenlabs_music_v2_5", force_instrumental: true };
export const MUSIC_SECONDS = Object.freeze({ min: 10, max: 40 });

/**
 * The most one call may cost, by what Higgsfield charged the pilot on
 * 2026-11-09 (frame 0.25, clip 7.5, 26 s music 3.78): a price above it means
 * the request is not the one priced, so it is refused before anything is sent.
 */
export const CALL_CEILING = Object.freeze({ gpt_image_2_6: 0.5, kling3_0: 8, elevenlabs_music_v2_5: 6 });
/** The least each call is counted at, whatever was quoted. */
const MIN_COST = Object.freeze({ gpt_image_2_6: 0.25, kling3_0: 7.5, elevenlabs_music_v2_5: 1 });

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const promptOk = (prompt) => typeof prompt === "string" && prompt.trim().length > 0 && prompt.length <= 2500;

const exactly = (request, fixed, extra) => {
  for (const [key, value] of Object.entries(fixed)) if (request[key] !== value) return `${key}_not_allowed`;
  for (const key of Object.keys(request)) if (!(key in fixed) && !extra.includes(key)) return `field_not_allowed:${key}`;
  return null;
};

/** Why a request may not be sent, or null. */
export function creativeRequestProblem(request) {
  if (!request || typeof request !== "object") return "request_not_an_object";
  if ("use_unlim" in request) return "use_unlim_not_allowed";
  if (request.model === IMAGE.model) return exactly(request, IMAGE, ["prompt"]) ?? (promptOk(request.prompt) ? null : "prompt_missing_or_too_long");
  if (request.model === VIDEO.model) {
    const problem = exactly(request, VIDEO, ["prompt", "start_image"]);
    if (problem) return problem;
    if (!promptOk(request.prompt)) return "prompt_missing_or_too_long";
    return typeof request.start_image === "string" && JOB_ID.test(request.start_image) ? null : "start_image_not_a_job_id";
  }
  if (request.model === MUSIC.model) {
    const problem = exactly(request, MUSIC, ["prompt", "duration"]);
    if (problem) return problem;
    if (!promptOk(request.prompt)) return "prompt_missing_or_too_long";
    const seconds = request.duration;
    return Number.isInteger(seconds) && seconds >= MUSIC_SECONDS.min && seconds <= MUSIC_SECONDS.max ? null : "duration_not_allowed";
  }
  return "model_not_allowed";
}

const policyFor = (model) => ({ problem: creativeRequestProblem, minCost: MIN_COST[model] ?? 1, capEnv: CREATIVE_CAP_ENV });

/** The CLI arguments for a request (the flags the pilot used on 2026-11-09). */
export function requestArgs(request) {
  if (request.model === IMAGE.model) return [IMAGE.model, "--prompt", request.prompt, "--aspect_ratio", IMAGE.aspect_ratio, "--json"];
  if (request.model === VIDEO.model) {
    return [VIDEO.model, "--prompt", request.prompt, "--aspect_ratio", VIDEO.aspect_ratio, "--duration", String(VIDEO.duration), "--mode", VIDEO.mode, "--sound", VIDEO.sound, "--start-image", request.start_image, "--json"];
  }
  return [MUSIC.model, "--prompt", request.prompt, "--duration", String(request.duration), "--force_instrumental", "true", "--json"];
}

/** MP4 (an `ftyp` box), or MP3/WAV/M4A for music, by their first bytes. */
export function isMedia(bytes, model) {
  if (!bytes || bytes.length < 12) return false;
  if (model === IMAGE.model) return isPicture(bytes);
  const ftyp = bytes.subarray(4, 8).toString("latin1") === "ftyp";
  if (model === VIDEO.model) return ftyp;
  const id3 = bytes.subarray(0, 3).toString("latin1") === "ID3";
  const mpeg = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  const wav = bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WAVE";
  return id3 || mpeg || wav || ftyp;
}

/**
 * Makes one image, clip or music bed and writes it to `out`.
 * @returns {Promise<{ok: true, jobId: string, cost: number, out: string} | {ok: false, reason: string, detail?: object}>}
 */
export async function makeMedia({ request, out, label, jobDir, env = process.env, cli = cliRunner(env), fetchBytes = defaultFetch, day = brisbaneDay(), today }) {
  const problem = creativeRequestProblem(request);
  if (problem) return { ok: false, reason: problem };
  const file = creativeLedgerPath(jobDir, day);

  const lookup = (jobId) => {
    const got = cli(["generate", "get", jobId, "--json"]);
    return got.status === 0 ? outcomeOf(parseJson(got.stdout)) : "unknown";
  };
  const open = await resolveUnsettled(file, lookup);
  if (open.length > 0) return { ok: false, reason: "unknown_outcome_pending", detail: { entries: open.map((entry) => entry.id) } };

  const priced = cli(["generate", "cost", ...requestArgs(request)]);
  let cost = null;
  try {
    cost = priced.status === 0 ? costOf(parseJson(priced.stdout)) : null;
  } catch {
    cost = null;
  }
  if (cost === null) return { ok: false, reason: "cost_unreadable" };
  const ceiling = CALL_CEILING[request.model];
  if (cost > ceiling) return { ok: false, reason: "cost_above_call_ceiling", detail: { cost, ceiling } };

  const admitted = admit({ jobDir, day, env, request, label, cost, policy: policyFor(request.model), file, today });
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
    // Nothing ties a listed job to this request, so the day is blocked until a person has looked.
    settle(file, entry.id, { status: "unknown" });
    return { ok: false, reason: "create_outcome_unknown", detail: { status: created.status, timedOut: created.timedOut } };
  }
  if (ids.length > 1) {
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
  if (outcome === "unknown") return { ok: false, reason: "wait_outcome_unknown", detail: { jobId } };
  settle(file, entry.id, { status: outcome, jobId });
  if (outcome === "failed") return { ok: false, reason: "job_failed", detail: { jobId } };

  const url = resultUrlOf(job);
  if (!url) return { ok: false, reason: "no_result_url", detail: { jobId } };
  const bytes = await fetchBytes(url);
  if (!isMedia(bytes, request.model)) return { ok: false, reason: "result_not_the_media", detail: { jobId } };
  writeFileSync(out, bytes);
  return { ok: true, jobId, cost, out };
}

/** The reasons that mean a request was submitted (and may have been charged); every other refusal sent nothing. */
export const SENT_REASONS = new Set(["create_outcome_unknown", "more_than_one_job", "wait_outcome_unknown", "job_failed", "no_result_url", "result_not_the_media"]);

async function defaultFetch(url) {
  const response = await fetch(url);
  if (!response.ok) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  return bytes.length > 80 * 1024 * 1024 ? null : bytes;
}
