// Stage 2 of docs/ops/tomverse-chat-context-window-rollout.md: what connecting
// a context window would actually block.
//
// A report, not a gate, and deliberately read-only. The stage exists because
// filling lib/models.ts is not behaviour-preserving -- the chat route's guard
// only runs when contextWindowTokens is set, so declaring one switches on a
// rejection that was previously skipped. The rollout requires these numbers
// before any value is connected, and requires them per provider rather than
// all at once.
//
// It measures a live gap too. The guard compares the raw estimate while the
// reservation books the estimate plus tool overhead -- up to 6,400 tokens for a
// turn with provider-native search, really sent. On the models that already
// declare a window the guard is therefore under-counting the request it is
// protecting, and this prints the size of that band.
//
// Windows come from the register first (verified, with provenance) and fall
// back to what lib/models.ts declares today, labelled as such. The catalogue
// numbers carry no recorded source -- that is precisely why the register
// exists -- so a row sourced from the catalogue measures current behaviour, not
// a verified limit.
//
// Usage:
//   npm run report:context-window-impact
//   npm run report:context-window-impact -- --days=7 --json

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { AVAILABLE_MODELS } from "../lib/models.ts";
import {
  buildContextWindowImpact,
  toImpactRow,
} from "../lib/contextWindowImpact.ts";
import { prisma } from "../lib/prisma.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTER = path.join(
  repoRoot,
  "docs",
  "policy",
  "tomverse-chat-context-window-register.yaml"
);

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const found = args.find((entry) => entry.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const asJson = args.includes("--json");
const days = Math.max(1, Number(flag("days", "30")) || 30);
const maxRows = Math.max(1, Number(flag("limit", "200000")) || 200_000);

const register = parse(readFileSync(REGISTER, "utf8"));

// Verified beats catalogue: a number with provenance is the one the rollout is
// deciding about. A catalogue number is reported so the models whose guard is
// already live are not invisible.
const windows = [];
for (const model of AVAILABLE_MODELS) {
  const row = register.models?.find((entry) => entry.modelId === model.id);
  if (row?.status === "verified" && typeof row.contextWindowTokens === "number") {
    windows.push({
      modelId: model.id,
      contextWindowTokens: row.contextWindowTokens,
      source: "verified",
      includesOutput: row.contextWindowIncludesOutput ?? null,
    });
    continue;
  }
  if (typeof model.contextWindowTokens === "number" && model.contextWindowTokens > 0) {
    windows.push({
      modelId: model.id,
      contextWindowTokens: model.contextWindowTokens,
      source: "catalogue",
      includesOutput: null,
    });
  }
}

const since = new Date(Date.now() - days * 86_400_000);

const reservations = await prisma.chatCreditReservation.findMany({
  where: { createdAt: { gte: since } },
  orderBy: { createdAt: "desc" },
  take: maxRows,
  select: {
    modelId: true,
    reservationPayload: true,
    settledInputTokens: true,
    settledOutputTokens: true,
    status: true,
    lastError: true,
    user: { select: { plan: true } },
  },
});

const rows = [];
let unreadablePayloads = 0;
for (const reservation of reservations) {
  const row = toImpactRow(reservation);
  // Counted rather than skipped in silence: a payload this script cannot read
  // is missing traffic, and a share computed over an unstated denominator is
  // the kind of number this rollout exists to avoid.
  if (row) rows.push(row);
  else unreadablePayloads += 1;
}

const report = buildContextWindowImpact(rows, windows);

const pct = (value) => `${(value * 100).toFixed(2)}%`;
const num = (value) => value.toLocaleString("en-US");

if (asJson) {
  console.log(
    JSON.stringify(
      { windowDays: days, since: since.toISOString(), unreadablePayloads, ...report },
      null,
      2
    )
  );
} else {
  console.log(`Context-window impact — last ${days} day(s), since ${since.toISOString()}`);
  console.log(`Reservations read: ${num(report.totalRequests)}`);
  if (unreadablePayloads > 0) {
    console.log(`Payloads unreadable and excluded: ${num(unreadablePayloads)}`);
  }
  console.log("");

  if (report.models.length === 0) {
    console.log("No model with both traffic and a window. Nothing to measure yet.");
  }

  for (const model of report.models) {
    console.log(`${model.modelId}  (window ${num(model.contextWindowTokens)}, ${model.source})`);
    if (model.source === "catalogue") {
      console.log("  window has no recorded source — measures current behaviour, not a verified limit");
    }
    if (model.includesOutput === false) {
      console.log("  provider states the window covers INPUT ONLY — comparing an input+output sum needs a stage 3 decision");
    }
    console.log(`  requests                    ${num(model.requests)}`);
    console.log(`  would block                 ${num(model.blocked)}  (${pct(model.blockedShare)})`);
    console.log(`    already blocked today     ${num(model.blockedRegardlessOfToolOverhead)}`);
    console.log(`    depends on tool overhead  ${num(model.blockedDependsOnToolOverhead)}  (upper bound on new rejections)`);
    const plans = model.blockedByPlan;
    console.log(`  blocked by plan             Guest ${num(plans.Guest)} · Free ${num(plans.Free)} · Pro ${num(plans.Pro)} · Max ${num(plans.Max)}`);
    console.log(`  reserved tokens p95/p99     ${num(model.p95ReservedTokens)} / ${num(model.p99ReservedTokens)}`);
    console.log(`  settled rows over window    ${num(model.settledOverWindow)} of ${num(model.settledRows)} settled`);
    console.log(`  provider length refusals    ${num(model.providerContextErrors)}`);
    console.log("");
  }

  if (report.unmeasurableModels.length > 0) {
    console.log("Traffic with no window to measure against (stage 1 is not finished for these):");
    for (const model of report.unmeasurableModels) {
      console.log(`  ${model.modelId}  ${num(model.requests)} request(s)`);
    }
    console.log("");
  }

  console.log(
    "Not a verdict. `depends on tool overhead` is an upper bound: the reservation stores"
  );
  console.log(
    "the estimate and the tool overhead as one sum, so which of those rows the current"
  );
  console.log(
    "guard already refuses is not derivable from stored data. Closing that band needs the"
  );
  console.log("two recorded separately, and that is a change to the reservation payload.");
}

await prisma.$disconnect();
