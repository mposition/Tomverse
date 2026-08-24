// What the providers say the windows are, for the models Tomverse does not
// declare one for.
//
//   DATABASE_URL=<env> npm run report:model-context-window-evidence
//   DATABASE_URL=<env> npm run report:model-context-window-evidence -- --json
//
// `check:router-context-window` holds 16 enabled models in a ratcheted
// baseline of "declares no context window", and ESTIMATE-03 cannot be approved
// until that list is empty. This report is the input to emptying it: for each
// of those models it prints what the provider's own model-list endpoint said,
// as recorded by the provider catalog monitor.
//
// Read only, and deliberately not a check: it proposes numbers, it does not
// pass or fail. Whether a provider's published figure is the right value for
// `contextWindowTokens` is a judgement -- what this removes is the need to
// recall the figure, which is the part nobody should be doing from memory. A
// window that is too large is worse than none: no window skips the guard and
// stays visible as a gap, while a wrong one passes the guard by inventing
// headroom and the over-limit request reaches the provider regardless.
//
// It reads the deployed database because that is where the observations live.
// Without one there is nothing to report, so it refuses rather than printing
// the catalogue back at the reader as if it were evidence.

import { modelContextWindowEvidence } from "./report-model-context-window-evidence-core.mjs";
import { prisma } from "../lib/prisma.ts";

const json = process.argv.includes("--json");

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL is required. This report reads what the provider catalog monitor\n" +
      "observed; there is no offline source for another provider's published window."
  );
  process.exit(1);
}

try {
  const [rows, catalogEntries] = await Promise.all([
    prisma.modelRegistryEntry.findMany({
      where: { enabled: true, catalogDeleted: false },
      select: {
        id: true,
        provider: true,
        apiModel: true,
        minimumPlan: true,
        contextWindowTokens: true,
      },
      orderBy: [{ provider: "asc" }, { sortOrder: "asc" }],
    }),
    prisma.providerModelCatalogEntry.findMany({
      select: {
        provider: true,
        apiModel: true,
        lifecycle: true,
        lastSeenAt: true,
        metadata: true,
      },
    }),
  ]);

  if (rows.length === 0) {
    console.error(
      "The model registry is empty in this database, so there is nothing to report.\n" +
        "An unseeded environment serves the compiled catalogue instead."
    );
    process.exit(1);
  }

  const models = rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    apiModel: row.apiModel,
    minimumPlan: row.minimumPlan,
    contextWindowTokens: row.contextWindowTokens,
  }));

  const { rows: evidence, declarable, partial, unobserved } =
    modelContextWindowEvidence({ models, catalogEntries });

  if (json) {
    console.log(
      JSON.stringify(
        { reachable: models.length, undeclared: evidence.length, evidence },
        null,
        2
      )
    );
  } else {
    console.log(
      `Context window evidence — ${models.length} reachable model(s), ${evidence.length} declaring no window\n`
    );

    if (evidence.length === 0) {
      console.log("  Every reachable model declares a context window. Nothing to close.");
    }

    if (declarable.length > 0) {
      console.log(`Provider published a context length (${declarable.length})`);
      for (const row of declarable) {
        console.log(
          `  ${row.modelId.padEnd(32)}${row.contextLength.toLocaleString("en-US").padEnd(14)}` +
            `${row.apiModel.padEnd(34)}seen ${row.lastSeenAt?.slice(0, 10) ?? "never"}` +
            (row.lifecycle ? `  [${row.lifecycle}]` : "")
        );
      }
      console.log(
        "\n  ^ these can be declared in lib/models.ts from a figure the provider published\n" +
          "    about its own model. Confirm the number still matches before writing it -- an\n" +
          "    observation has a date on it, and a window can be raised or a model replaced."
      );
      console.log("");
    }

    if (partial.length > 0) {
      console.log(`Provider published an input limit but not a window (${partial.length})`);
      for (const row of partial) {
        console.log(
          `  ${row.modelId.padEnd(32)}input ${row.inputTokenLimit.toLocaleString("en-US")}` +
            (row.outputTokenLimit
              ? `, output ${row.outputTokenLimit.toLocaleString("en-US")}`
              : ", output not published")
        );
      }
      console.log(
        "\n  ^ an input limit is not a context window: it excludes the answer. Declaring it\n" +
          "    as one would understate the room by every reply, and adding the two together is\n" +
          "    a guess about how the provider counts. Read the documentation for these."
      );
      console.log("");
    }

    if (unobserved.length > 0) {
      console.log(`No published figure to read (${unobserved.length})`);
      for (const row of unobserved) {
        console.log(
          `  ${row.modelId.padEnd(32)}${row.provider.padEnd(12)}` +
            (row.observed ? "observed, no window in the response" : "not in the catalog at all")
        );
      }
      const silent = [...new Set(unobserved.map((row) => row.knownSilentSource).filter(Boolean))];
      for (const reason of silent) {
        console.log(`\n  Note: ${reason}`);
      }
      console.log(
        "\n  ^ these need a person to read the provider's documentation. That is the whole\n" +
          "    of the remaining work for them, and it is not something to infer from a\n" +
          "    sibling model: two models from one provider routinely differ."
      );
    }

    console.log(
      "\nDeclaring a window is what removes a model from the baseline in\n" +
        "scripts/check-router-context-window.mjs. Until that list is empty, ESTIMATE-03\n" +
        "stays outstanding and Auto keeps excluding these models from its candidates."
    );
  }
} finally {
  await prisma.$disconnect();
}
