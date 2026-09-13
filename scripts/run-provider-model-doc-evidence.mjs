// Reads provider documentation for the models waiting in the adoption queue,
// once, and prints what it found.
//
// The daily catalogue check already does this after its scan. This exists for
// the one case the daily run does not serve: an operator who wants the
// adoption form prefilled today, without triggering the whole check -- which
// would also advance every model's seen/missing counters and send a second
// daily report.
//
// Usage:
//   npm run maintenance:provider-model-docs
//
// Writes `ProviderModelDocEvidence` rows (one per queued OpenAI/Anthropic
// model, overwritten by each read). Reads nothing but public documentation
// pages; sends no email or Slack message. The output names models and statuses
// only -- no credentials, no database URL.
//
// Requires DATABASE_URL.

import { collectProviderModelDocEvidence } from "../lib/providerModelDocEvidence.ts";
import { prisma } from "../lib/prisma.ts";

if (!process.env.DATABASE_URL?.trim()) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

try {
  const summary = await collectProviderModelDocEvidence(new Date());
  console.log(
    `Provider documentation read: ${summary.byStatus.parsed}/${summary.attempted} parsed` +
      ` (not found ${summary.byStatus.not_found}, fetch failed ${summary.byStatus.fetch_failed},` +
      ` parse failed ${summary.byStatus.parse_failed})`
  );
  for (const failure of summary.failures) {
    console.log(
      `  - ${failure.provider.padEnd(10)} ${failure.apiModel.padEnd(36)} ${failure.status}` +
        (failure.problems.length ? ` (${failure.problems.join(", ")})` : "")
    );
  }
} catch (error) {
  console.error(
    "Provider documentation read failed:",
    error instanceof Error ? error.message : "unknown error"
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
