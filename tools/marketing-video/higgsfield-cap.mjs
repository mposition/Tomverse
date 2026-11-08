// The spending cap for the media job's Higgsfield image calls. Deterministic
// code, so no model can widen it (owner direction 2026-11-08: Higgsfield is
// paid; the cap sits at the call, not in a prompt).
//
// Every call is admitted here first:
//  - only `gpt_image_2_6`, aspect ratio 4:5, one image, no unlimited mode;
//  - the day's ledger (job/higgsfield-ledger-<yyyymmdd>.json, Brisbane day)
//    plus this call must stay within MARKETING_HIGGSFIELD_DAILY_CREDIT_CAP; a
//    missing, zero or unreadable cap refuses every call;
//  - a call whose outcome is not known (sent, then a timeout or a crash before
//    the answer, or still running) blocks every further call until its job id
//    has been looked up. A call with no job id cannot be looked up, so it
//    blocks the rest of the day: it is never sent again blindly.
// The entry is written before the request leaves, so a crash mid-call is
// counted and blocks, never forgotten.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const HF_MODEL = "gpt_image_2_6";
export const HF_ASPECT_RATIO = "4:5";
/** Credits one gpt_image_2_6 picture costs (owner's trial 2026-11-08: 0.25 per 4:5 picture, generate or edit alike). */
export const HF_IMAGE_COST = 0.25;
export const CAP_ENV = "MARKETING_HIGGSFIELD_DAILY_CREDIT_CAP";

/** The Brisbane day as yyyymmdd (the job runs at 05:00 Brisbane, the previous UTC day). */
export function brisbaneDay(now = new Date()) {
  return now.toLocaleDateString("en-CA", { timeZone: "Australia/Brisbane" }).replaceAll("-", "");
}

/** The cap in credits, or null when calls must be refused (unset, empty, zero, negative, not a number). */
export function dailyCap(env = process.env) {
  const raw = env[CAP_ENV];
  if (typeof raw !== "string" || !/^\d+(?:\.\d+)?$/u.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Why a request may not be sent at all, or null. Only the fields Higgsfield prices are looked at, and every one must be the allowed value. */
export function requestProblem(request) {
  if (!request || typeof request !== "object") return "request_not_an_object";
  if (request.model !== HF_MODEL) return "model_not_allowed";
  if (request.aspect_ratio !== HF_ASPECT_RATIO) return "aspect_ratio_not_allowed";
  if (request.count !== 1) return "count_not_one";
  if ("use_unlim" in request) return "use_unlim_not_allowed";
  for (const key of Object.keys(request)) {
    if (!["model", "aspect_ratio", "count", "prompt", "image_references", "quality", "resolution"].includes(key)) return `field_not_allowed:${key}`;
  }
  if (typeof request.prompt !== "string" || request.prompt.trim().length === 0 || request.prompt.length > 8000) return "prompt_missing_or_too_long";
  if (request.image_references !== undefined) {
    if (!Array.isArray(request.image_references) || request.image_references.length > 8) return "image_references_not_a_short_list";
  }
  return null;
}

export const ledgerPath = (jobDir, day) => path.join(jobDir, `higgsfield-ledger-${day}.json`);

export function readLedger(file) {
  if (!existsSync(file)) return { entries: [] };
  const ledger = JSON.parse(readFileSync(file, "utf8"));
  if (!ledger || !Array.isArray(ledger.entries)) throw new Error(`ledger ${file} is not a ledger`);
  return ledger;
}

function writeLedger(file, ledger) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(ledger, null, 1)}\n`);
  renameSync(temp, file);
}

/** Every entry counts, whatever became of it: a failed call may still have been charged. */
export const spent = (ledger) => ledger.entries.reduce((sum, entry) => sum + (Number(entry.cost) || 0), 0);

/** Entries whose outcome is not known yet. */
export const unsettled = (ledger) => ledger.entries.filter((entry) => entry.status === "sent" || entry.status === "unknown");

/**
 * Admits one call, or refuses it. On admission the entry is in the ledger
 * (status "sent") before anything leaves the box.
 * @returns {{ok: true, entry: object, file: string} | {ok: false, reason: string, detail?: object}}
 */
export function admit({ jobDir, day = brisbaneDay(), env = process.env, request, label, cost: priced }) {
  const problem = requestProblem(request);
  if (problem) return { ok: false, reason: problem };
  // The price Higgsfield quoted, never less than the known price of a picture.
  const cost = Math.max(HF_IMAGE_COST, Number.isFinite(priced) ? priced : 0);
  const cap = dailyCap(env);
  if (cap === null) return { ok: false, reason: "no_daily_cap" };
  const file = ledgerPath(jobDir, day);
  const ledger = readLedger(file);
  const open = unsettled(ledger);
  if (open.length > 0) return { ok: false, reason: "unknown_outcome_pending", detail: { entries: open.map((entry) => entry.id) } };
  const total = spent(ledger);
  // Rounded to cents of a credit, so 0.1 + 0.2 does not refuse a call that fits.
  if (Math.round((total + cost) * 100) > Math.round(cap * 100)) {
    return { ok: false, reason: "daily_cap_reached", detail: { spent: total, cap, cost } };
  }
  const entry = { id: randomUUID(), at: new Date().toISOString(), label: label ?? null, model: request.model, cost, status: "sent", jobId: null };
  ledger.entries.push(entry);
  writeLedger(file, ledger);
  return { ok: true, entry, file };
}

/** Records what became of an admitted call: "done", "failed" (Higgsfield answered it failed) or "unknown" (no answer, or still running). */
export function settle(file, entryId, { status, jobId }) {
  if (!["done", "failed", "unknown"].includes(status)) throw new Error(`settle: bad status ${status}`);
  const ledger = readLedger(file);
  const entry = ledger.entries.find((candidate) => candidate.id === entryId);
  if (!entry) throw new Error(`settle: no entry ${entryId}`);
  entry.status = status;
  if (jobId) entry.jobId = jobId;
  entry.settledAt = new Date().toISOString();
  writeLedger(file, ledger);
  return entry;
}

/**
 * Looks up every unsettled entry that has a job id, through `lookup(jobId)`
 * (which answers "done", "failed" or "unknown"), and records the answers. An
 * entry without a job id stays unsettled: nothing can tell what became of it.
 */
export async function resolveUnsettled(file, lookup) {
  const ledger = readLedger(file);
  for (const entry of unsettled(ledger)) {
    if (!entry.jobId) continue;
    let status = "unknown";
    try {
      status = await lookup(entry.jobId);
    } catch {
      status = "unknown";
    }
    if (status === "done" || status === "failed") settle(file, entry.id, { status, jobId: entry.jobId });
  }
  return unsettled(readLedger(file));
}
