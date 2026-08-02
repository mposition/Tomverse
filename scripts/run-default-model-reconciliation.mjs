// Moves stored *selection* state off gpt-5-4-mini and onto gpt-5-6-luna.
//
// Run with the RETIREMENT deploy, not with the default switch. While
// gpt-5-4-mini is still enabled and publicly listed it is a working model that
// some users may have picked deliberately, and rewriting their setting on no
// evidence would be overriding a live choice. Once 5.4 mini is disabled and
// delisted, the same rows become stale pointers that every read path has to
// resolve through the replacement chain on every request -- that is the point
// at which flattening them is a fix rather than an override.
//
// Safe to run repeatedly and safe to run early: it is idempotent, and it makes
// no change at all once no row names the old id. Defaults to a dry run.
//
// Usage:
//   node --import tsx scripts/run-default-model-reconciliation.mjs
//   node --import tsx scripts/run-default-model-reconciliation.mjs --apply
//
// Requires DATABASE_URL. Reads and writes only:
//   * AppSetting["guestDefaultModelId"]  (only when it names the old id)
//   * UserSettings.defaultModel          (only rows exactly equal to the old id)
//   * Conversation.selectedModels        (only rows whose JSON array contains it)
//
// It never touches Message.modelId, ChatCreditReservation, UsageBucket, the
// credit ledger, ModelRegistryEntry.catalogDeleted, or any other model's
// defaults -- historical ids and their frozen pricing snapshots stay exactly
// as they were recorded.

// The application's own client, not a bare `new PrismaClient()`: this project
// connects through a PrismaPg driver adapter, and a client constructed without
// one throws before it ever reaches a query.
import { prisma } from "../lib/prisma.ts";
import {
  emptyCounts,
  rewriteDefaultModel,
  rewriteSelectedModels,
} from "../lib/defaultModelReconciliationCore.ts";

const FROM_MODEL_ID = "gpt-5-4-mini";
const TO_MODEL_ID = "gpt-5-6-luna";
const GUEST_DEFAULT_MODEL_KEY = "guestDefaultModelId";
const CONVERSATION_PAGE_SIZE = 500;

const apply = process.argv.includes("--apply");
const mode = apply ? "APPLY" : "DRY RUN";

if (!process.env.DATABASE_URL?.trim()) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const malformedConversations = [];
const warnings = [];

console.log(
  `Default model reconciliation (${mode}): ${FROM_MODEL_ID} -> ${TO_MODEL_ID}`
);

try {
  // 1. Guest lead model. Guarded on the exact old value so an administrator's
  //    deliberate choice of any other model is left alone.
  const guestSetting = await prisma.appSetting.findUnique({
    where: { key: GUEST_DEFAULT_MODEL_KEY },
    select: { value: true },
  });
  let guestDefaultUpdated = 0;
  if (guestSetting) {
    const decision = rewriteDefaultModel(guestSetting.value, {
      from: FROM_MODEL_ID,
      to: TO_MODEL_ID,
    });
    if (decision.status === "rewritten") {
      if (apply) {
        await prisma.appSetting.update({
          where: { key: GUEST_DEFAULT_MODEL_KEY },
          data: { value: decision.value },
        });
      }
      guestDefaultUpdated = 1;
    }
  }

  // 2. Per-user default model. updateMany on an exact equality filter is
  //    already idempotent: the second run matches zero rows.
  const userDefaultMatches = await prisma.userSettings.count({
    where: { defaultModel: FROM_MODEL_ID },
  });
  if (apply && userDefaultMatches > 0) {
    await prisma.userSettings.updateMany({
      where: { defaultModel: FROM_MODEL_ID },
      data: { defaultModel: TO_MODEL_ID },
    });
  }

  // 3. Conversation selections. `contains` only narrows the rows worth
  //    reading -- every candidate is then parsed as JSON and rewritten entry
  //    by entry, so a value that merely mentions the id inside some other
  //    token is classified by the parser, not by the LIKE.
  const counts = emptyCounts();
  let cursor = null;
  for (;;) {
    const page = await prisma.conversation.findMany({
      where: { selectedModels: { contains: FROM_MODEL_ID } },
      select: { id: true, selectedModels: true },
      orderBy: { id: "asc" },
      take: CONVERSATION_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1].id;

    for (const conversation of page) {
      counts.scanned += 1;
      const decision = rewriteSelectedModels(conversation.selectedModels, {
        from: FROM_MODEL_ID,
        to: TO_MODEL_ID,
      });

      if (decision.status === "malformed") {
        counts.malformed += 1;
        malformedConversations.push({
          conversationId: conversation.id,
          reason: decision.reason,
        });
        continue;
      }
      if (decision.status === "unchanged") {
        counts.unchanged += 1;
        continue;
      }

      counts.rewritten += 1;
      if (decision.warning) {
        warnings.push(`${conversation.id}: ${decision.warning}`);
      }
      if (apply) {
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { selectedModels: decision.value },
        });
      }
    }
  }

  console.log(
    [
      "",
      `  AppSetting.${GUEST_DEFAULT_MODEL_KEY}: ${guestDefaultUpdated} updated` +
        (guestSetting ? "" : " (no row set; falls back to the code default)"),
      `  UserSettings.defaultModel:      ${userDefaultMatches} matched`,
      `  Conversation.selectedModels:    ${counts.scanned} scanned, ` +
        `${counts.rewritten} rewritten, ${counts.unchanged} unchanged, ` +
        `${counts.malformed} malformed`,
      "",
    ].join("\n")
  );

  if (warnings.length > 0) {
    console.warn(`${warnings.length} conversation(s) need a second look:`);
    for (const warning of warnings) console.warn(`  - ${warning}`);
  }

  // Reported, never rewritten. These rows keep whatever they held; a human
  // decides what a value the parser could not understand should become.
  if (malformedConversations.length > 0) {
    console.warn(
      `\n${malformedConversations.length} conversation(s) hold a malformed selectedModels value and were left untouched:`
    );
    for (const entry of malformedConversations) {
      console.warn(`  - ${entry.conversationId} (${entry.reason})`);
    }
  }

  if (!apply) {
    console.log("Dry run only. Re-run with --apply to write these changes.");
  }
} catch (error) {
  console.error("Default model reconciliation failed:", error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
