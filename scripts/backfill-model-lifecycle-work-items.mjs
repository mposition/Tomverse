// Seeds the model lifecycle queue from the observations already in the
// database.
//
// The next scheduled scan would queue everything a provider still lists, so
// this exists for the rest: a candidate observed in July that the provider has
// since stopped listing has a ProviderModelCatalogEntry row and no work item,
// and nothing would ever create one. Those are the oldest items in the backlog
// and the ones most likely to have been forgotten -- which is the state the
// queue was built to end.
//
// Usage:
//   node --import tsx scripts/backfill-model-lifecycle-work-items.mjs
//   node --import tsx scripts/backfill-model-lifecycle-work-items.mjs --apply
//
// Defaults to a dry run. Only ever creates: it never edits or closes an
// existing work item, so running it twice is a no-op and running it after
// somebody has triaged the queue cannot undo their decisions.
//
// Requires DATABASE_URL.

import { prisma } from "../lib/prisma.ts";
import { recordDiscoveredWorkItems } from "../lib/modelLifecycleWorkItems.ts";
import { newCandidatesForQueue } from "../lib/modelLifecycleWorkItemCore.ts";

const apply = process.argv.includes("--apply");

if (!process.env.DATABASE_URL?.trim()) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

try {
  // Unmapped candidates only. A row that carries a modelRegistryId is a model
  // the catalogue already serves, and a lifecycle_warning is a retirement
  // signal rather than a discovery -- it belongs to a "retire" item somebody
  // opens deliberately, not to an "add" one this script invents.
  const entries = await prisma.providerModelCatalogEntry.findMany({
    where: { status: "candidate", modelRegistryId: null },
    orderBy: { firstSeenAt: "asc" },
    select: { provider: true, apiModel: true, firstSeenAt: true },
  });

  const [catalogue, queued] = await Promise.all([
    prisma.modelRegistryEntry.findMany({
      where: { catalogDeleted: false },
      select: { apiModel: true },
    }),
    prisma.modelLifecycleWorkItem.findMany({ select: { apiModel: true } }),
  ]);

  const fresh = newCandidatesForQueue({
    observed: entries.map((entry) => ({
      provider: entry.provider,
      apiModel: entry.apiModel,
    })),
    catalogueApiModels: catalogue.map((row) => row.apiModel),
    queuedApiModels: queued.map((row) => row.apiModel),
  });

  console.log(
    `Model lifecycle backfill (${apply ? "APPLY" : "DRY RUN"})\n` +
      `  candidate observations : ${entries.length}\n` +
      `  already served or queued: ${entries.length - fresh.length}\n` +
      `  work items to create    : ${fresh.length}\n`
  );

  const firstSeen = new Map(
    entries.map((entry) => [
      `${entry.provider}:${entry.apiModel}`,
      entry.firstSeenAt,
    ])
  );
  for (const candidate of fresh) {
    const seen = firstSeen.get(`${candidate.provider}:${candidate.apiModel}`);
    console.log(
      `  - ${candidate.provider.padEnd(12)} ${candidate.apiModel}` +
        (seen ? `  (first seen ${seen.toISOString().slice(0, 10)})` : "")
    );
  }

  if (!apply) {
    console.log("\nDry run only. Re-run with --apply to create these.");
  } else if (fresh.length > 0) {
    // Each item keeps the date it was really first observed rather than today,
    // so the queue opens with the backlog's true ages -- the twenty-eight-day
    // item has to read as twenty-eight days old or the report understates it.
    let created = 0;
    for (const candidate of fresh) {
      const result = await recordDiscoveredWorkItems({
        observed: [candidate],
        now:
          firstSeen.get(`${candidate.provider}:${candidate.apiModel}`) ??
          new Date(),
      });
      created += result.created;
    }
    console.log(`\nCreated ${created} work item(s).`);
  }
} catch (error) {
  console.error("Model lifecycle backfill failed:", error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
