// Run locally with Node --import tsx. See docs/ops/chat-presearch-comparison.md.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { latencyDistribution } from "../lib/responseLatencyCore.ts";

const count = z.number().int().nonnegative();
const labels = z.string().regex(/^[a-z0-9_.-]{1,100}$/i);
const search = z.object({
  flagEnabled: z.boolean(), selectionEligible: z.boolean(), planOffered: z.boolean(),
  plannedQueries: count, presearchEntered: z.boolean(), presearchBackendRequests: count,
  evidenceInjected: z.boolean(), injectedSources: count, modelCalls: count,
  modelCallsWithSearchResults: count, finishedSteps: count, toolOnlySearchSteps: count, searchToolCalls: count,
  searchStepsAfterResults: count, answerBackendRequests: count, successfulBackendRequests: count,
  returnedSources: count, sourceCards: count.nullable(), mentionedSources: count.nullable(),
  mentionedInjectedSources: count.nullable(),
});
const pairsSchema = z.array(z.object({ caseId: labels, repeat: count, off: z.uuid(), on: z.uuid() })).min(1);
function validatePairs(value) {
  const parsed = pairsSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid case/repeat/request-ID manifest.");
  const pairs = parsed.data;
  if (new Set(pairs.flatMap(pair => [pair.off, pair.on])).size !== 2 * pairs.length ||
      new Set(pairs.map(pair => JSON.stringify([pair.caseId, pair.repeat]))).size !== pairs.length)
    throw new Error("A request ID or a case/repeat appears more than once.");
  return pairs;
}
const eventSchema = z.object({
  event: z.literal("chat_turn_timing"), traceId: z.uuid(), modelId: labels.nullable(),
  outcome: z.enum(["completed", "failed", "cancelled", "empty", "failed_before_stream"]),
  serverMsToFirstVisibleChunk: count.nullable(), serverMsToSettlement: count, search: search.optional(),
});
const timingSchema = z.object({ id: z.string(), source: z.literal("client"), product: z.literal("chat"),
  mode: z.literal("auto"), outcome: z.enum(["completed", "cancelled", "failed"]),
  timings: z.object({ firstContentMs: count.optional(), completionMs: count }) });

function indexUnique(map, key, row) {
  if (map.has(key) && JSON.stringify(map.get(key)) !== JSON.stringify(row))
    throw new Error("Conflicting observations for a request. Check the exports.");
  map.set(key, row);
}

function distribution(values) {
  const { count, p50Ms, p95Ms } = latencyDistribution(values);
  return { count, p50: p50Ms, p95: p95Ms };
}
function metrics(rows) {
  const keys = ["firstMs", "completionMs", "serverFirstMs", "serverSettlementMs",
    "modelCalls", "modelCallsWithSearchResults", "finishedSteps", "toolOnlySearchSteps", "searchStepsAfterResults",
    "answerBackendRequests", "sourceCards", "mentionedSources"];
  return Object.fromEntries(keys.map(key => {
    const value = row => row[key] ?? row.search[key];
    const observed = rows.filter(r => Number.isFinite(value(r.off)) && Number.isFinite(value(r.on)));
    const target = key === "firstMs" || key === "completionMs" ? {
      within10s: {
        observedPairs: observed.length,
        off: observed.filter(row => value(row.off) <= 10_000).length,
        on: observed.filter(row => value(row.on) <= 10_000).length,
      },
    } : {};
    return [key, { off: distribution(observed.map(r => value(r.off))), on: distribution(observed.map(r => value(r.on))),
      onMinusOff: distribution(observed.map(r => value(r.on) - value(r.off))), ...target }];
  }));
}

/** The trace IDs only join local inputs. Output contains operator case labels and whitelisted measurements. */
export function comparePresearch(pairsInput, logs, timings) {
  const pairs = validatePairs(pairsInput);
  const ids = new Set(pairs.flatMap(pair => [pair.off, pair.on]));
  const events = new Map(), clients = new Map();
  for (const log of logs) {
    let raw = log;
    if (log?.event !== "chat_turn_timing" && typeof log?.message === "string") {
      try { raw = JSON.parse(log.message); } catch { continue; }
    }
    if (raw?.event !== "chat_turn_timing" || !ids.has(raw.traceId)) continue;
    const event = eventSchema.safeParse(raw);
    if (!event.success) throw new Error("Invalid timing event for a matched request.");
    indexUnique(events, raw.traceId, event.data);
  }
  for (const timing of timings) {
    const row = timingSchema.safeParse(timing);
    if (!row.success || !row.data.id.endsWith(":client")) continue;
    const id = row.data.id.slice(0, -":client".length);
    if (ids.has(id)) indexUnique(clients, id, row.data);
  }
  function arm(id, enabled) {
    const event = events.get(id), client = clients.get(id);
    const search = event?.search ?? null;
    const issue = !event ? "missing_event" : !search ? "no_search_observation"
      : search.flagEnabled !== enabled ? "flag_mismatch" : !search.selectionEligible ? "selection_ineligible"
      : event.outcome !== "completed" ? "not_completed"
      : search.modelCalls === 0 || search.finishedSteps === 0 ? "no_completed_sdk_step" : null;
    return { issue, modelId: event?.modelId ?? null, outcome: event?.outcome ?? null,
      serverFirstMs: event?.serverMsToFirstVisibleChunk ?? null, serverSettlementMs: event?.serverMsToSettlement ?? null,
      clientOutcome: client?.outcome ?? null, firstMs: client?.outcome === "completed" ? client.timings.firstContentMs ?? null : null,
      completionMs: client?.outcome === "completed" ? client.timings.completionMs : null, search };
  }
  const rows = pairs.map(pair => ({ caseId: pair.caseId, repeat: pair.repeat, off: arm(pair.off, false), on: arm(pair.on, true) }));
  const matched = rows.filter(r => !r.off.issue && !r.on.issue);
  const sameModel = matched.filter(r => r.off.modelId && r.off.modelId === r.on.modelId);
  return { pairs: pairs.length, eligibleCompletedPairs: matched.length, sameModelPairs: sameModel.length,
    injectedWithSourcesPairs: matched.filter(r => r.on.search.injectedSources > 0).length,
    fewerModelCallsPairs: matched.filter(r => r.on.search.modelCalls < r.off.search.modelCalls).length,
    matched: metrics(matched), matchedSameModel: metrics(sameModel), rows };
}

async function readRecords(path) {
  const text = (await readFile(path, "utf8")).replace(/^\uFEFF/, "").trim();
  if (!text) return [];
  try { return text.startsWith("[") ? JSON.parse(text) : text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
  catch { throw new Error("Expected a JSON array or JSON lines."); }
}

async function readSignedTimings(pairs) {
  const { Client } = await import("pg");
  const { resolvePostgresConnectionConfig } = await import("../lib/postgresConnectionConfigCore.mjs");
  const config = resolvePostgresConnectionConfig(process.env.DATABASE_URL);
  const client = new Client({ connectionString: config.connectionString, options: config.poolOptions,
    connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const ids = pairs.flatMap(pair => [pair.off + ":client", pair.on + ":client"]);
    const result = await client.query('SELECT id, source, product, mode, outcome, timings FROM "ResponseLatencySample" WHERE id = ANY($1::text[])', [ids]);
    await client.query("COMMIT");
    return result.rows;
  } finally { await client.end(); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { values } = parseArgs({ options: { pairs: { type: "string" }, logs: { type: "string" },
    timings: { type: "string" }, db: { type: "boolean" } } });
  if (!values.pairs || !values.logs || Boolean(values.timings) === Boolean(values.db))
    throw new Error("Use --pairs manifest.json --logs logs.jsonl with either --timings timings.json or --db.");
  const pairs = validatePairs(await readRecords(values.pairs));
  const timings = values.db ? await readSignedTimings(pairs) : await readRecords(values.timings);
  console.log(JSON.stringify(comparePresearch(pairs, await readRecords(values.logs), timings), null, 2));
}
