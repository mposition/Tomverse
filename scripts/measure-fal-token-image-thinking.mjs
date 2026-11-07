// What does fal bill for one request to a token-billed image endpoint, at the
// thinking level its FAL_ENDPOINT_PROFILES row pins?
//
//   node --import tsx scripts/measure-fal-token-image-thinking.mjs --help
//   node --import tsx scripts/measure-fal-token-image-thinking.mjs \
//     --out=<evidence.json> --repeats=3 --i-accept-the-cost
//   node --import tsx scripts/measure-fal-token-image-thinking.mjs --reread=<evidence.json>
//
// Built for google/nano-banana-2.1, which fal sells "billed on the tokens each
// request actually uses", thinking "billed as output text", with no parameter
// that caps the count (fal.ai/models/google/nano-banana-2.1, read 2026-11-07).
// The row pins `thinking_level: "minimal"`, the cheapest level, and the judge
// keeps the model `worst_case_cost_unbounded` (policy section 12.1, 16.9).
//
// EVERY RUN SPENDS MONEY. Each call is a real 1K generation on a real key --
// about US$0.04 by fal's own example for a short prompt at `medium`, which
// `minimal` is said to undercut (an estimate, not a bound: the bound is the
// question). Nothing is sent without --i-accept-the-cost, and policy section 15
// wants the spend approved by the owner before anyone passes it.
//
// What it does and does not prove:
//
//   * It goes through `buildFalImageRequest`, `falEndpointUrl` and
//     `falPlatformHeaders` -- the adapter's own builders -- because a
//     measurement of a request production does not send prices nothing.
//   * fal reports no token usage in the response. The cost comes from fal's
//     usage API, which has no per-request filter: only an endpoint, a window
//     and minute buckets (fal.ai/docs/platform-apis/v1/models/usage, read
//     2026-11-07). Calls are therefore spaced more than a minute apart and a
//     bucket counts toward a call only when no other call touches it. Cost in
//     a bucket no call touches is other traffic on the endpoint, and it voids
//     the per-call figures rather than being guessed away. The usage API calls
//     its numbers an "estimate"; the report says so.
//   * The usage API needs a key with billing read access (`billing:usage:read`).
//     FAL_BILLING_KEY is used when set, FAL_KEY otherwise; a refusal is
//     recorded. Usage can lag: --reread queries it again from the evidence
//     file and sends no generation.
//   * The largest observed cost is a sample, not a cap. Policy section 12
//     condition 6 prices thinking at the provider's limit, not at what a few
//     prompts happened to spend. This script produces the evidence; whether an
//     observed maximum may ever stand in for a cap is a policy decision, not
//     something its output settles.
//   * Two built-in prompts with different cost axes, because one prompt
//     repeated is one prompt's evidence (section 12.1). The first failed or
//     unreadable call stops the run: later numbers would not be trustworthy
//     and would still be billed.
//
// It cannot enable anything or touch the registry or the database. The API
// keys and prompt text never reach the evidence file (prompts as sha256).

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildFalImageRequest,
  falAssetLengthRefused,
  falAuthorizationHeader,
  falEndpointProfile,
  falEndpointUrl,
  falPlatformHeaders,
  FAL_MAX_ASSET_BYTES,
  isFalAssetUrl,
  parseFalImageResponse,
} from "../lib/falImageRequest.ts";
import { readImageDimensions } from "../lib/imageDimensions.ts";

const FAL_PLATFORM_API = "https://api.fal.ai/v1/models";
const DEFAULT_ENDPOINT = "google/nano-banana-2.1";
const SIZE = "1024x1024";
const MINUTE_MS = 60_000;
/** Slack after a call's response for fal to stamp its usage in the same minute. */
const FINISH_TOLERANCE_MS = 5_000;
const MAX_REPEATS = 10;
/** fal's example cost for a short 1K prompt at `medium` (model page, 2026-11-07). */
const FAL_EXAMPLE_COST_USD = 0.04;

/** Different cost axes: dense labelled geometry, and exact multilingual lettering. */
export const PROMPTS = {
  geometry:
    "A technical cutaway diagram of a mechanical wristwatch movement, every gear, jewel, spring " +
    "and screw labelled by name with leader lines, plus a scale bar in millimetres.",
  lettering:
    "A shop sign whose four lines read exactly, in this order: 'Open 7 days', '연중무휴', " +
    "'全年無休', 'Ouvert 7j/7' -- each line in a different typeface, every character spelled correctly.",
};

/** A usage line-item list in micro-USD, or null when any item is not a finite USD amount. */
export const usageCostMicroUsd = (items) => {
  if (!Array.isArray(items)) return null;
  let total = 0;
  for (const item of items) {
    const cost = item?.cost_total;
    if (item?.currency !== "USD" || typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return null;
    total += cost;
  }
  return Math.round(total * 1_000_000);
};

// Buckets were requested in UTC; a timestamp without a zone is read as UTC,
// not as this machine's local time.
const parseBucket = (value) => {
  if (typeof value !== "string") return Number.NaN;
  return Date.parse(/T/.test(value) && !/(Z|[+-]\d\d:?\d\d)$/i.test(value) ? `${value}Z` : value);
};

/**
 * Per-call cost from minute buckets.
 *
 * `calls` carry ISO `startedAt`/`finishedAt`; `buckets` carry an ISO `bucket`
 * (the minute's start) and `costMicroUsd` (null when unreadable). A costed
 * bucket counts toward a call only when its minute overlaps that call and no
 * other; a call is attributed only when it has such a bucket and shares none.
 * The maximum is reported only when every call is attributed and no costed
 * bucket is unexplained or unreadable -- otherwise it is null, never a
 * best guess.
 */
export const attributeUsage = (calls, buckets) => {
  const spans = calls.map((call) => [Date.parse(call.startedAt), Date.parse(call.finishedAt) + FINISH_TOLERANCE_MS]);
  const perCall = calls.map(() => ({ cost: 0, buckets: 0, shared: false }));
  let unexplainedMicroUsd = 0;
  let unreadableBuckets = 0;
  for (const { bucket, costMicroUsd } of buckets) {
    if (costMicroUsd === 0) continue;
    const start = parseBucket(bucket);
    if (costMicroUsd === null || !Number.isFinite(start)) {
      unreadableBuckets += 1;
      continue;
    }
    const hits = spans.flatMap(([from, to], index) => (start < to && start + MINUTE_MS > from ? [index] : []));
    if (hits.length === 0) {
      unexplainedMicroUsd += costMicroUsd;
    } else if (hits.length > 1) {
      for (const index of hits) perCall[index].shared = true;
    } else {
      perCall[hits[0]].cost += costMicroUsd;
      perCall[hits[0]].buckets += 1;
    }
  }
  const perCallMicroUsd = perCall.map((entry) => (entry.buckets > 0 && !entry.shared ? entry.cost : null));
  const clean = unexplainedMicroUsd === 0 && unreadableBuckets === 0;
  const complete = perCallMicroUsd.length > 0 && perCallMicroUsd.every((cost) => cost !== null);
  return {
    perCallMicroUsd,
    unexplainedMicroUsd,
    unreadableBuckets,
    maxObservedMicroUsd: clean && complete ? Math.max(...perCallMicroUsd) : null,
  };
};

/**
 * What a call produced. "image" only for the image that was priced: a parsed
 * response whose asset downloaded, passed the host and size checks and
 * measured 1024x1024. Anything else stops the run (review finding 2026-11-07:
 * a failed download used to stay "image" and the run kept paying).
 */
export const callOutcome = ({ ok, parsed, dimensions }) => {
  if (!ok) return "http_error";
  if (!parsed) return "unparseable";
  const [width, height] = SIZE.split("x").map(Number);
  return dimensions?.width === width && dimensions?.height === height ? "image" : "asset_unusable";
};

const digest = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readUsage = async ({ key, endpoint, start, end }) => {
  const buckets = [];
  let summary = null;
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const params = new URLSearchParams({ endpoint_id: endpoint, start, end, timezone: "UTC", timeframe: "minute", limit: "100" });
    params.append("expand", "time_series");
    params.append("expand", "summary");
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(`${FAL_PLATFORM_API}/usage?${params}`, {
      headers: { Authorization: falAuthorizationHeader(key) },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return { status: response.status, buckets: null, summary: null };
    const payload = await response.json().catch(() => null);
    for (const entry of Array.isArray(payload?.time_series) ? payload.time_series : []) {
      const results = Array.isArray(entry?.results) ? entry.results : [];
      buckets.push({
        bucket: entry?.bucket ?? null,
        costMicroUsd: usageCostMicroUsd(results),
        // What fal counted, by unit: the token split is the useful part.
        lineItems: results.map(({ unit, quantity, unit_price, cost_total, currency }) => ({ unit, quantity, unit_price, cost_total, currency })),
      });
    }
    summary ??= Array.isArray(payload?.summary) ? payload.summary : null;
    cursor = payload?.has_more ? payload?.next_cursor : null;
    if (!cursor) return { status: response.status, source: "estimate", buckets, summary };
  }
  return { status: "too_many_pages", buckets: null, summary: null };
};

const settle = async (report, billingKey) => {
  const calls = report.calls.filter((call) => call.outcome === "image");
  if (calls.length === 0) return;
  const first = Date.parse(report.calls[0].startedAt);
  report.usage = await readUsage({
    key: billingKey,
    endpoint: report.endpoint,
    start: new Date(Math.floor(first / MINUTE_MS) * MINUTE_MS - MINUTE_MS).toISOString(),
    end: new Date().toISOString(),
  });
  // Every call that reached fal, failed ones included: their cost is fal's to report.
  const attribution = report.usage.buckets ? attributeUsage(report.calls, report.usage.buckets) : null;
  const total = report.usage.buckets?.reduce((sum, bucket) => sum + (bucket.costMicroUsd ?? 0), 0) ?? null;
  report.result = {
    sentCalls: report.calls.length,
    images: calls.length,
    stoppedEarly: report.stoppedEarly,
    totalObservedMicroUsd: total,
    ...(attribution ?? { perCallMicroUsd: null, maxObservedMicroUsd: null }),
    verdict: !report.usage.buckets
      ? "usage_unavailable"
      : total === 0
        ? "usage_not_yet_reported"
        : attribution.maxObservedMicroUsd === null
          ? "not_attributable"
          : report.stoppedEarly
            ? "attributed_but_stopped_early"
            : "attributed",
    note: "An observed maximum is a sample, not a cap (policy section 12 condition 6).",
  };
};

const main = async () => {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(`--${name}`);
  const value = (name) => {
    const hit = args.find((arg) => arg.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const VALUED = new Set(["endpoint", "repeats", "prompts", "spacing-seconds", "usage-wait-seconds", "out", "reread"]);
  const VALUELESS = new Set(["help", "i-accept-the-cost"]);
  const unknown = args.filter((arg) => {
    if (!arg.startsWith("--")) return true;
    const name = arg.slice(2).split("=")[0];
    return arg.includes("=") ? !VALUED.has(name) : !VALUELESS.has(name);
  });
  if (unknown.length > 0) {
    // A misspelled flag that silently falls back to a default changes how many
    // paid calls go out (policy section 12.1, 2026-08-14).
    console.error(`Unrecognised argument(s): ${unknown.join(" ")}\nRefused rather than ignored. Nothing was sent.`);
    return 1;
  }
  if (flag("help") || args.length === 0) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split(/\r?\n\r?\nimport /)[0]);
    return 0;
  }

  const apiKey = process.env.FAL_KEY?.trim();
  const billingKey = process.env.FAL_BILLING_KEY?.trim() || apiKey;
  const redact = (text) =>
    [apiKey, billingKey].filter(Boolean).reduce(
      (out, key) => out.replace(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "[redacted-api-key]"),
      String(text)
    );

  const reread = value("reread");
  if (reread) {
    if (!billingKey) {
      console.error("FAL_BILLING_KEY or FAL_KEY is required to read usage.");
      return 1;
    }
    const report = JSON.parse(readFileSync(reread, "utf8"));
    await settle(report, billingKey);
    writeFileSync(reread, `${redact(JSON.stringify(report, null, 2))}\n`, "utf8");
    console.log(JSON.stringify(report.result ?? { verdict: "no_images_to_settle" }, null, 2));
    return report.result?.verdict === "attributed" ? 0 : 1;
  }

  if (!apiKey) {
    console.error("FAL_KEY is not set. Nothing was sent.");
    return 1;
  }
  const endpoint = value("endpoint") ?? DEFAULT_ENDPOINT;
  const profile = falEndpointProfile(endpoint);
  if (profile?.thinking.billing !== "per_token_uncapped") {
    console.error(
      `${endpoint} is not a token-billed endpoint in FAL_ENDPOINT_PROFILES. ` +
        "A flat or unbilled endpoint has nothing for this to measure. Nothing was sent."
    );
    return 1;
  }
  const repeats = Number(value("repeats") ?? 3);
  const promptKeys = (value("prompts") ?? Object.keys(PROMPTS).join(",")).split(",").filter(Boolean);
  const spacingSeconds = Number(value("spacing-seconds") ?? 70);
  const usageWaitSeconds = Number(value("usage-wait-seconds") ?? 180);
  const outPath = value("out");
  const problems = [
    !(Number.isInteger(repeats) && repeats >= 1 && repeats <= MAX_REPEATS) && `--repeats must be 1..${MAX_REPEATS}`,
    promptKeys.some((key) => !Object.hasOwn(PROMPTS, key)) && `--prompts must be from: ${Object.keys(PROMPTS).join(", ")}`,
    // Two calls more than a minute plus the tolerance apart never share a bucket.
    !(spacingSeconds * 1_000 > MINUTE_MS + FINISH_TOLERANCE_MS) && "--spacing-seconds must exceed 65",
    !(usageWaitSeconds >= 0) && "--usage-wait-seconds must be 0 or more",
    !outPath && "--out is required: the evidence file is the point of the run",
  ].filter(Boolean);
  if (problems.length > 0) {
    console.error(`${problems.join("\n")}\nNothing was sent.`);
    return 1;
  }
  const planned = promptKeys.length * repeats;
  if (!flag("i-accept-the-cost")) {
    console.error(
      [
        `Would send ${planned} paid generation(s) to ${endpoint} at ${SIZE}, thinking_level "${profile.thinkingLevel}",`,
        `${spacingSeconds}s apart, then read fal's usage API after ${usageWaitSeconds}s.`,
        `Estimate: about US$${(planned * FAL_EXAMPLE_COST_USD).toFixed(2)} (fal's example US$${FAL_EXAMPLE_COST_USD} per 1K image at medium) -- not a bound.`,
        "",
        "Re-run with --i-accept-the-cost once the owner has approved the spend. Nothing was sent.",
      ].join("\n")
    );
    return 1;
  }

  const template = buildFalImageRequest({ apiModelId: endpoint, prompt: "x", size: SIZE, outputFormat: "png" });
  const url = falEndpointUrl(endpoint, false);
  if (!template || !url) {
    console.error("The request builder refused these parameters. Nothing was sent.");
    return 1;
  }
  const report = {
    ranAt: new Date().toISOString(),
    endpoint,
    thinkingLevel: profile.thinkingLevel,
    size: SIZE,
    requestBody: { ...template, prompt: "sha256:<per call>" },
    platformHeaders: falPlatformHeaders(),
    pricing: null,
    calls: [],
    stoppedEarly: false,
  };
  const write = () => writeFileSync(outPath, `${redact(JSON.stringify(report, null, 2))}\n`, "utf8");
  // Before anything is sent, so an unwritable path costs nothing.
  write();

  // Free: the units and unit prices fal publishes for the endpoint.
  const pricing = await fetch(`${FAL_PLATFORM_API}/pricing?endpoint_id=${encodeURIComponent(endpoint)}`, {
    headers: { Authorization: falAuthorizationHeader(apiKey) },
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  report.pricing = pricing ? { status: pricing.status, body: await pricing.json().catch(() => null) } : { status: "unreachable" };
  write();

  run: for (const promptKey of promptKeys) {
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      if (report.calls.length > 0) await sleep(spacingSeconds * 1_000);
      const prompt = PROMPTS[promptKey];
      const body = buildFalImageRequest({ apiModelId: endpoint, prompt, size: SIZE, outputFormat: "png" });
      const call = { index: report.calls.length, promptKey, promptSha256: `sha256:${digest(prompt)}`, startedAt: new Date().toISOString() };
      report.calls.push(call);
      let response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { Authorization: falAuthorizationHeader(apiKey), "Content-Type": "application/json", ...falPlatformHeaders() },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(180_000),
        });
      } catch (error) {
        call.outcome = "request_failed";
        call.detail = redact(error instanceof Error ? error.message : String(error));
      }
      call.finishedAt = new Date().toISOString();
      if (response) {
        call.httpStatus = response.status;
        call.falHeaders = Object.fromEntries([...response.headers].filter(([name]) => name.startsWith("x-fal-")));
        const payload = response.ok ? await response.json().catch(() => null) : null;
        if (!response.ok) call.detail = redact(await response.text().catch(() => "")).slice(0, 400);
        call.responseShape = payload ? { keys: Object.keys(payload), imageCount: Array.isArray(payload.images) ? payload.images.length : null } : null;
        const parsed = parseFalImageResponse(payload);
        let dimensions = null;
        if (parsed) {
          // Recorded by measurement, never by URL: the link is a public image until it expires.
          const asset = await fetch(parsed.url, { redirect: "manual", signal: AbortSignal.timeout(60_000) }).catch(() => null);
          const usable = asset?.ok && isFalAssetUrl(asset.url) && !falAssetLengthRefused(asset.headers.get("content-length"));
          const bytes = usable ? Buffer.from(await asset.arrayBuffer()) : null;
          dimensions = bytes && bytes.byteLength <= FAL_MAX_ASSET_BYTES ? readImageDimensions(bytes, parsed.mimeType) : null;
          call.asset = { mimeType: parsed.mimeType, measuredWidth: dimensions?.width ?? null, measuredHeight: dimensions?.height ?? null };
          if (!usable) await asset?.body?.cancel().catch(() => undefined);
        }
        call.outcome = callOutcome({ ok: response.ok, parsed: Boolean(parsed), dimensions });
      }
      write();
      console.log(`  call ${call.index} ${promptKey}: ${call.outcome} (${call.httpStatus ?? "no response"})`);
      if (call.outcome !== "image") {
        report.stoppedEarly = true;
        break run;
      }
    }
  }

  console.log(`\nWaiting ${usageWaitSeconds}s for fal's usage to settle...`);
  await sleep(usageWaitSeconds * 1_000);
  await settle(report, billingKey);
  write();
  console.log(JSON.stringify(report.result ?? { verdict: "no_images" }, null, 2));
  console.log(`\nEvidence written to ${outPath}`);
  return report.result?.verdict === "attributed" ? 0 : 1;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
