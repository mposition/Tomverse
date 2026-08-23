// Does each model a real request can reach declare a context window, in the
// place a real request reads it from?
//
//   npm run check:router-context-window-db
//   npm run check:router-context-window-db -- --json
//
// The database half of `check:router-context-window`, split for the same
// reason `check:model-pricing` and `check:model-pricing-db` are split: one
// proves something about the compiled catalogue, the other about the rows an
// administrator writes long after CI ran. Reads ModelRegistryEntry, writes
// nothing. Without a DATABASE_URL it reports the compiled catalogue instead
// and says so.
//
// ## Why the catalogue check is not enough
//
// `getRuntimeModels` does not merge a registry row with the catalogue entry of
// the same id. When rows exist it builds each model from its row alone
// (`registryRowToModel`), so `contextWindowTokens = NULL` on a row means that
// model has no window at runtime -- whatever lib/models.ts declares for it.
//
// That is the finding this check exists for. A row that clears a window the
// catalogue declares leaves CI green and the model unguarded: the chat route's
// fit runs only when a window is known (`fitChatOutputToContextWindow` returns
// `unbounded` otherwise), so the request is not clamped to a safe default, it
// is not checked at all, and an over-limit request reaches the provider --
// which ESTIMATE-03 forbids at zero tolerance. Auto makes it worse, because
// there nobody chose the model.
//
// ## What it does not do
//
// It does not hold the baseline. The catalogue check owns the ratcheted list
// of models that declare no window today, and a row supplying one at runtime
// is not grounds for removing an entry from it: the catalogue is the floor
// when no row exists, and an environment whose registry has not been seeded
// falls back to exactly that.

import { AVAILABLE_MODELS } from "../lib/models.ts";
import { classifyContextWindows } from "./check-router-context-window-db-core.mjs";

const json = process.argv.includes("--json");
const databaseUrl = process.env.DATABASE_URL?.trim();

const guardedFrom = (models) =>
  models.filter((model) => model.enabled && !model.catalogDeleted);

// `publiclyListed: false` models stay resolvable for existing conversations,
// so a request can still reach a provider through them. Reachability, not
// listing, is what the guard cares about -- the same rule the catalogue check
// applies.
const catalogue = new Map(
  guardedFrom(AVAILABLE_MODELS).map((model) => [model.id, model])
);

let source = "compiled_catalogue";
let models = guardedFrom(AVAILABLE_MODELS);
let note =
  "No DATABASE_URL: this is the compiled catalogue, which is what an unseeded " +
  "environment falls back to. It cannot show a row that cleared a window.";

if (databaseUrl) {
  try {
    const { prisma } = await import("../lib/prisma.ts");
    const { registryRowToModel } = await import("../lib/modelRegistry.ts");
    const rows = await prisma.modelRegistryEntry.findMany({
      orderBy: [{ provider: "asc" }, { sortOrder: "asc" }],
    });
    await prisma.$disconnect().catch(() => undefined);
    if (rows.length > 0) {
      // `getRuntimeModels` skips a row it cannot map and serves the rest, so a
      // check that threw here would report nothing about an environment the
      // application is happily running on.
      const mapped = [];
      const unmappable = [];
      for (const row of rows) {
        try {
          mapped.push(registryRowToModel(row));
        } catch (error) {
          unmappable.push({
            modelId: row.id,
            reason: error instanceof Error ? error.message : "invalid registry row",
          });
        }
      }
      models = guardedFrom(mapped);
      source = "model_registry";
      note =
        `Read ${rows.length} ModelRegistryEntry row(s); ${models.length} are enabled and not catalog-deleted.` +
        (unmappable.length > 0
          ? ` ${unmappable.length} row(s) could not be mapped and are skipped at runtime too: ` +
            unmappable.map((entry) => `${entry.modelId} (${entry.reason})`).join(", ")
          : "");
    } else {
      note =
        "The registry is empty, so the compiled catalogue is reported instead. " +
        "That is also what the application would serve.";
    }
  } catch (error) {
    const message = String(error?.message || error).replaceAll(
      databaseUrl,
      "[redacted]"
    );
    note = `DATABASE_URL was set but unreadable; reporting the compiled catalogue instead: ${message.slice(0, 200)}`;
  }
}

if (models.length === 0) {
  throw new Error("No enabled models in the reported source; refusing to validate an empty set.");
}

const { entries, cleared, unknownUndeclared, closed, differing, undeclared } =
  classifyContextWindows({ runtime: models, catalogue: [...catalogue.values()] });

if (json) {
  console.log(JSON.stringify({ source, note, entries }, null, 2));
} else {
  console.log(`Router context window (${source})\n  ${note}\n`);
  console.log(
    `  ${"model".padEnd(32)}${"runtime".padEnd(14)}${"catalogue".padEnd(14)}source`
  );
  for (const entry of entries) {
    const runtime = entry.runtimeWindowTokens
      ? entry.runtimeWindowTokens.toLocaleString("en-US")
      : "NONE";
    const catalogued = !entry.inCatalogue
      ? "n/a"
      : entry.catalogueWindowTokens
        ? entry.catalogueWindowTokens.toLocaleString("en-US")
        : "NONE";
    const label = entry.clearedByRow
      ? "CLEARED BY ROW"
      : entry.unknownToCatalogue
        ? "registry only"
        : entry.closedByRow
          ? "declared by row"
          : entry.differs
            ? "differs"
            : "";
    console.log(
      `  ${entry.modelId.padEnd(32)}${runtime.padEnd(14)}${catalogued.padEnd(14)}${label}`
    );
  }
  console.log(
    `\n  ${entries.length} reachable model(s), ${undeclared.length} with no context window at runtime.`
  );
}

const fail = (message) => {
  console.error(`\nFAIL: ${message}`);
  process.exitCode = 1;
};

// 1. The regression the catalogue check cannot see.
for (const entry of cleared) {
  fail(
    `${entry.modelId} (${entry.provider}, ${entry.minimumPlan}) declares ` +
      `${entry.catalogueWindowTokens.toLocaleString("en-US")} tokens in lib/models.ts and NULL in its ` +
      "ModelRegistryEntry row. The row is what a request reads, so this model is unguarded in this " +
      "environment while CI reports it as guarded. Restore contextWindowTokens on the row."
  );
}

// 2. A model no baseline covers, because no baseline knows it exists.
for (const entry of unknownUndeclared) {
  fail(
    `${entry.modelId} (${entry.provider}, ${entry.minimumPlan}) is enabled in the registry, absent from ` +
      "lib/models.ts, and declares no context window. Nothing else checks this model. Declare the " +
      "published window on the row, or add the model to the catalogue so the ratcheted baseline covers it."
  );
}

if (differing.length > 0) {
  // Reported, not fatal. A row correcting a stale catalogue number is a
  // legitimate reason for these to disagree, and this script has no third
  // source to say which one matches the provider's published window. The
  // direction is what a reader needs: a row above the catalogue admits a
  // request the catalogue says will not fit.
  console.error(
    `\n${differing.length} model(s) declare a different window in the registry than in the catalogue:\n` +
      differing
        .map(
          (entry) =>
            `  - ${entry.modelId}: row ${entry.runtimeWindowTokens.toLocaleString("en-US")}, ` +
            `catalogue ${entry.catalogueWindowTokens.toLocaleString("en-US")}` +
            (entry.runtimeWindowTokens > entry.catalogueWindowTokens
              ? " (row is larger -- it admits requests the catalogue says will not fit)"
              : " (row is smaller -- conservative)")
        )
        .join("\n") +
      "\n\nOne of the two is stale. Confirm against the provider's published window and " +
      "correct whichever is wrong, rather than leaving the answer to depend on whether the " +
      "registry happens to be seeded."
  );
}

if (closed.length > 0) {
  console.log(
    `\n${closed.length} model(s) declare no window in the catalogue but do at runtime: ` +
      closed.map((entry) => entry.modelId).join(", ") +
      "\n  These are guarded here and unguarded in any environment whose registry is not seeded, " +
      "so they stay in the catalogue baseline. Declaring the window in lib/models.ts is what removes them."
  );
}

if (process.exitCode) {
  console.error(
    "\nRouter context-window (database) check failed. An undeclared window is an unguarded model, " +
      "not a safe default -- and a row that clears one is invisible to every check that reads the catalogue."
  );
} else if (undeclared.length > 0) {
  console.log(
    `\nOK: no row clears a declared window, and every reachable model with no window is one the ` +
      `catalogue baseline already accounts for (${undeclared.length}).`
  );
} else {
  console.log("\nOK: every reachable model declares a context window at runtime.");
}
