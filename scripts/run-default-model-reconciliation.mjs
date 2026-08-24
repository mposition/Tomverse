// Moves stored *selection* state off one retired model and onto its
// replacement. Both are named on the command line: this is the tool for every
// retirement, not for one of them (ML-10).
//
// Run with the RETIREMENT deploy, not with the default switch. While the old
// model is still enabled and publicly listed it is a working model that some
// users may have picked deliberately, and rewriting their setting on no
// evidence would be overriding a live choice. Once it is disabled and
// delisted, the same rows become stale pointers that every read path has to
// resolve through the replacement chain on every request -- that is the point
// at which flattening them is a fix rather than an override.
//
// That timing is checked rather than trusted: --apply reads the registry and
// refuses if --from is still enabled or still listed. It used to be enforced by
// a pair of constants naming one migration, which made the rule true by
// accident for that one and unavailable for the next.
//
// Safe to run repeatedly and safe to run early: it is idempotent, and it makes
// no change at all once no row names the old id. Defaults to a dry run.
//
// Usage:
//   node --import tsx scripts/run-default-model-reconciliation.mjs \
//     --from=<retired model id> --to=<replacement model id>
//   node --import tsx scripts/run-default-model-reconciliation.mjs \
//     --apply --approved-retirement --ticket="<url>" --actor="<name>" \
//     --from=<retired model id> --to=<replacement model id>
//
// A dry run needs nothing: reporting what would change is the safe half and
// stays one command away. A write needs the whole line above, because
// --apply on its own cannot tell "the retirement is shipping in this deploy"
// from "somebody copied a command", and the difference is whether these rows
// are stale pointers or live user choices. It also refuses to run inside CI
// or an npm build/start/deploy/migrate lifecycle step at all.
//
// Requires DATABASE_URL. Reads and writes only:
//   * AppSetting["guestDefaultModelId"]     (only when it names the old id)
//   * UserSettings.defaultModel             (only rows exactly equal to the old id)
//   * UserSettings.newConversationModelIds  (only arrays containing it)
//   * Conversation.selectedModels           (only rows whose JSON array contains it)
//
// Every write is paired with a ModelMigrationRecord in the same transaction.
// Without that the run reports counts to stdout and keeps nothing, so the
// notice telling people their settings moved has no audience it can be honest
// about -- only "everybody" or "nobody".
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
  leadOutOfSync,
  rewriteDefaultModel,
  rewriteNewConversationModelIds,
  rewriteSelectedModels,
} from "../lib/defaultModelReconciliationCore.ts";
import {
  findReconciliationApprovalProblems,
  findReconciliationTargetProblems,
  readReconciliationEnvironment,
} from "../lib/reconciliationApprovalCore.ts";

const GUEST_DEFAULT_MODEL_KEY = "guestDefaultModelId";
const CONVERSATION_PAGE_SIZE = 500;

const apply = process.argv.includes("--apply");
const mode = apply ? "APPLY" : "DRY RUN";

const argValue = (name) => {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3).trim() || null : null;
};

const approval = {
  apply,
  approvedRetirement: process.argv.includes("--approved-retirement"),
  ticket: argValue("ticket"),
  actor: argValue("actor"),
  fromModelId: argValue("from"),
  toModelId: argValue("to"),
  environment: readReconciliationEnvironment(process.env),
};

const refuse = (problems) => {
  console.error(
    `\nRefusing to write. ${problems.length} requirement(s) not met:\n` +
      problems
        .map((problem) => `  - [${problem.code}] ${problem.message}`)
        .join("\n") +
      "\n\nRun without --apply to see what would change. See section 7 of\n" +
      "docs/policy/default-model-luna-migration.md before writing anything."
  );
  process.exit(1);
};

const approvalProblems = findReconciliationApprovalProblems(approval);
if (approvalProblems.length > 0) refuse(approvalProblems);

// A dry run needs the pair too -- without them there is nothing to report on --
// but it needs no approval, so this is the first point both are known good.
if (!approval.fromModelId || !approval.toModelId) {
  console.error(
    "--from=<model id> and --to=<model id> are required, including for a dry run."
  );
  process.exit(1);
}
const FROM_MODEL_ID = approval.fromModelId;
const TO_MODEL_ID = approval.toModelId;

if (!process.env.DATABASE_URL?.trim()) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

// The precondition, read from the registry rather than assumed from a
// constant. Runs before anything is scanned so a refusal costs one query
// rather than a full table walk.
const registryState = async (modelId) => {
  const row = await prisma.modelRegistryEntry.findUnique({
    where: { id: modelId },
    select: { enabled: true, publiclyListed: true, catalogDeleted: true },
  });
  return {
    modelId,
    found: Boolean(row),
    enabled: row?.enabled ?? false,
    publiclyListed: row?.publiclyListed ?? false,
    catalogDeleted: row?.catalogDeleted ?? false,
  };
};

const targets = findReconciliationTargetProblems({
  apply,
  from: await registryState(FROM_MODEL_ID),
  to: await registryState(TO_MODEL_ID),
});
if (targets.problems.length > 0) {
  await prisma.$disconnect();
  refuse(targets.problems);
}
for (const warning of targets.warnings) console.warn(`  ! ${warning}`);

const malformedConversations = [];
const warnings = [];

console.log(
  `Default model reconciliation (${mode}): ${FROM_MODEL_ID} -> ${TO_MODEL_ID}` +
    (apply ? `\n  approved by ${approval.actor} under ${approval.ticket}` : "")
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

  // 2. Per-user settings: the representative model and the new-conversation
  //    combination, which are two independent decisions
  //    (docs/policy/default-model-luna-migration.md §1.2) and have to move in
  //    one transaction per row. An updateMany would be shorter and could not
  //    write the migration record beside the change it describes.
  const affected = await prisma.userSettings.findMany({
    where: {
      OR: [
        { defaultModel: FROM_MODEL_ID },
        { newConversationModelIds: { array_contains: FROM_MODEL_ID } },
      ],
    },
    select: { userId: true, defaultModel: true, newConversationModelIds: true },
  });

  let userDefaultMatches = 0;
  let combinationRewritten = 0;
  let combinationMalformed = 0;
  let leadMismatches = 0;

  for (const row of affected) {
    const defaultDecision = rewriteDefaultModel(row.defaultModel, {
      from: FROM_MODEL_ID,
      to: TO_MODEL_ID,
    });
    const combination = rewriteNewConversationModelIds(
      row.newConversationModelIds,
      { from: FROM_MODEL_ID, to: TO_MODEL_ID }
    );

    if (defaultDecision.status === "rewritten") userDefaultMatches += 1;
    if (combination.status === "rewritten") combinationRewritten += 1;
    if (combination.status === "malformed") {
      combinationMalformed += 1;
      warnings.push(
        `${row.userId}: newConversationModelIds is ${combination.reason} and was left untouched`
      );
    }
    if (combination.warning) {
      warnings.push(`${row.userId}: ${combination.warning}`);
    }

    const nextDefault =
      defaultDecision.status === "rewritten" ? defaultDecision.value : row.defaultModel;
    const nextModels =
      combination.status === "rewritten" ? combination.models : null;

    // Reported, never corrected: which model leads the combination is the
    // user's choice, and reordering it to match defaultModel would be making
    // that choice for them.
    if (leadOutOfSync(nextModels ?? null, nextDefault)) {
      leadMismatches += 1;
      warnings.push(
        `${row.userId}: combination lead ${nextModels[0]} and defaultModel ${nextDefault} disagree`
      );
    }

    if (!apply) continue;
    if (defaultDecision.status !== "rewritten" && nextModels === null) continue;

    await prisma.$transaction(async (tx) => {
      await tx.userSettings.update({
        where: { userId: row.userId },
        data: {
          ...(defaultDecision.status === "rewritten"
            ? { defaultModel: defaultDecision.value }
            : {}),
          ...(nextModels ? { newConversationModelIds: nextModels } : {}),
        },
      });
      const records = [];
      if (defaultDecision.status === "rewritten") {
        records.push("user_settings_default_model");
      }
      if (nextModels) records.push("new_conversation_model_ids");
      for (const field of records) {
        await tx.modelMigrationRecord.create({
          data: {
            userId: row.userId,
            field,
            fromModelId: FROM_MODEL_ID,
            toModelId: TO_MODEL_ID,
            ticket: approval.ticket,
            actorEmail: approval.actor,
          },
        });
      }
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
      select: { id: true, userId: true, selectedModels: true },
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
        await prisma.$transaction(async (tx) => {
          await tx.conversation.update({
            where: { id: conversation.id },
            data: { selectedModels: decision.value },
          });
          // The conversation carries the owner, so the notice can be addressed
          // to a person rather than to a row.
          if (conversation.userId) {
            await tx.modelMigrationRecord.create({
              data: {
                userId: conversation.userId,
                conversationId: conversation.id,
                field: "conversation_selected_models",
                fromModelId: FROM_MODEL_ID,
                toModelId: TO_MODEL_ID,
                ticket: approval.ticket,
                actorEmail: approval.actor,
              },
            });
          }
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
      `  UserSettings.newConversation:   ${combinationRewritten} rewritten, ` +
        `${combinationMalformed} malformed, ${leadMismatches} lead mismatch`,
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
