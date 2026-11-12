// Synthetic fixtures only. The answering model runs on the operator's loopback endpoint.
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ARM_NAMES,
  SCENARIOS,
  EXPERIMENT_VERSION,
  RERANK_MODEL,
  experimentCase,
  armProbe,
  scoreArm,
} from "../lib/scoutMemoryExperiment.ts";
import {
  rankSyntheticDocuments,
  rankMicroUsd,
} from "../lib/scoutMemoryCohere.ts";
import { MEMORY_PROBE_LOCALES } from "../lib/productResearchScoutMemoryCases.ts";
const [endpoint, model, day, path, subset = "all"] = process.argv.slice(2);
if (
  !endpoint ||
  !model ||
  !path ||
  !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
  !["all", "local", "cohere"].includes(subset)
)
  throw Error(
    "Expected loopback endpoint, model, UTC day, report path and optional local/cohere arm filter",
  );
const url = new URL(endpoint);
if (
  url.protocol !== "http:" ||
  url.hostname !== "127.0.0.1" ||
  url.username ||
  url.password
)
  throw Error("Use a loopback endpoint");
const receiptFile = process.env.SCOUT_SYNTHETIC_RERANK_RECEIPTS;
const receipts = receiptFile
  ? JSON.parse(await readFile(receiptFile, "utf8"))
  : null;
const key =
  process.env.PRODUCT_RESEARCH_SCOUT_COHERE_API_KEY ||
  process.env.COHERE_API_KEY ||
  process.env.CO_API_KEY;
const settings = { temperature: 0, max_tokens: 256 };
let report;
try {
  report = JSON.parse(await readFile(path, "utf8"));
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
report ??= {
  version: EXPERIMENT_VERSION,
  model,
  day,
  rerankModel: RERANK_MODEL,
  settings,
  results: [],
};
if (
  report.model !== model ||
  report.day !== day ||
  report.version !== EXPERIMENT_VERSION ||
  report.rerankModel !== RERANK_MODEL ||
  JSON.stringify(report.settings) !== JSON.stringify(settings)
)
  throw Error("Report configuration mismatch");
await mkdir(dirname(path), { recursive: true });
const save = async () => {
  await writeFile(path + ".tmp", JSON.stringify(report, null, 2) + "\n");
  await rename(path + ".tmp", path);
};
for (const locale of MEMORY_PROBE_LOCALES)
  for (const scenario of SCENARIOS) {
    const c = experimentCase(day, locale, scenario);
    const offset =
      (MEMORY_PROBE_LOCALES.indexOf(locale) + SCENARIOS.indexOf(scenario)) % 3;
    for (const arm of [
      ...ARM_NAMES.slice(offset),
      ...ARM_NAMES.slice(0, offset),
    ]) {
      if (
        (subset === "local" && arm === "cohere") ||
        (subset === "cohere" && arm !== "cohere")
      )
        continue;
      const prior = report.results.find(
        (r) => r.arm === arm && r.locale === locale && r.scenario === scenario,
      );
      if (prior) {
        if (prior.sourceDigest !== c.digest)
          throw Error("Fixture changed; use a new report");
        if (prior.status === "complete") continue;
        // Missing credentials never issued a call. Every other unknown outcome requires reconciliation.
        if (
          prior.reason !== "cohere_key_missing" ||
          !(key || receipts?.[c.digest]?.status === 200)
        )
          continue;
        report.results = report.results.filter((r) => r !== prior);
      }
      const row = {
        version: EXPERIMENT_VERSION,
        day,
        locale,
        scenario,
        arm,
        model,
        sourceDigest: c.digest,
        sourceLanguage: c.sourceLanguage,
        status: "started",
        measuredAt: new Date().toISOString(),
      };
      report.results.push(row);
      if (arm === "cohere" && !key && !receipts?.[c.digest]) {
        Object.assign(row, {
          status: "unmeasured",
          reason: "cohere_key_missing",
        });
        await save();
        continue;
      }
      await save();
      try {
        const start = performance.now();
        const captured = arm === "cohere" ? receipts?.[c.digest] : null;
        if (
          captured &&
          (captured.status !== 200 ||
            captured.digest !== c.digest ||
            captured.model !== RERANK_MODEL ||
            !captured.id ||
            !Number.isFinite(captured.retrievalMs) ||
            captured.retrievalMs < 0 ||
            !Array.isArray(captured.indices) ||
            captured.indices.length !== 3 ||
            new Set(captured.indices).size !== 3 ||
            captured.indices.some(
              (i) => !Number.isInteger(i) || i < 0 || i >= c.documents.length,
            ))
        )
          throw Error("invalid_receipt");
        const ranking =
          arm === "cohere"
            ? (captured ??
              (await rankSyntheticDocuments(
                key,
                c.source.question,
                c.documents,
              )))
            : null;
        const probe = armProbe(c, arm, ranking?.indices);
        const prepared = performance.now();
        if (ranking)
          Object.assign(row, {
            rankedOrdinals: ranking.indices,
            rerankTokens: ranking.billedTokens,
            ...(captured ? { providerRequestId: captured.id } : {}),
          });
        const reply = await fetch(new URL("/v1/chat/completions", url), {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(120000),
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: probe.messages,
            ...settings,
          }),
        });
        if (!reply.ok) throw Error("local_http_" + reply.status);
        const body = await reply.json(),
          raw = body.choices?.[0]?.message?.content,
          end = performance.now();
        if (body.model !== model || typeof raw !== "string")
          throw Error("local_answer_invalid");
        Object.assign(row, scoreArm(c, probe, raw), {
          status: "complete",
          promptDigest: probe.promptDigest,
          raw,
          finish: body.choices[0].finish_reason,
          expected: c.source.gold,
          elapsedMs: Math.round(end - start) + (captured?.retrievalMs ?? 0),
          retrievalMs:
            Math.round(prepared - start) + (captured?.retrievalMs ?? 0),
          answerMs: Math.round(end - prepared),
          inputTokens: body.usage?.prompt_tokens ?? null,
          outputTokens: body.usage?.completion_tokens ?? null,
          rerankTokens: ranking?.billedTokens ?? (ranking ? null : 0),
          answerMicroUsd: 0,
          retrievalMicroUsd: ranking ? rankMicroUsd(ranking.billedTokens) : 0,
        });
      } catch (e) {
        row.status = "failed";
        row.reason =
          /^(?:cohere_http_\d+|cohere_invalid_ranking|local_http_\d+|local_answer_invalid)$/.test(
            e.message,
          )
            ? e.message
            : "unknown_outcome";
        await save();
        throw Error(row.reason);
      }
      await save();
      console.log(locale, scenario, arm);
    }
  }
