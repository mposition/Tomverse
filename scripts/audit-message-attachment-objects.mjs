// How many stored attachments does object storage no longer hold?
//
//   npm run audit:message-attachments                      (dry run, default)
//   npm run audit:message-attachments -- --limit=2000
//   npm run audit:message-attachments -- --cursor='2026-08-01T00:00:00.000Z|clx...'
//   npm run audit:message-attachments -- --json
//   npm run audit:message-attachments -- --apply --ticket=OPS-123
//
// Read-only by default and read-only in every mode except `--apply`, which
// does exactly one write: setting `unavailableAt` / `unavailableReason` on
// rows storage answered 404 for. It never deletes a row, never deletes an
// object, never rewrites metadata and never touches a message. A file whose
// bytes are gone is still a file the person sent, and the card, the name and
// the size stay in the conversation
// (docs/policy/user-attachment-persistence.md §11).
//
// Bytes are not recoverable from here. This tool counts loss and records it;
// it cannot undo it, and no lifecycle change undoes it either -- a rule that
// is fixed today does not bring back what it deleted yesterday. The only
// recovery for a specific file is the person attaching it again.
//
// What the report contains: attachment id, conversation id, creation time,
// media type, declared size, state, storage status. What it never contains:
// object keys, filenames, message content, prompts, email addresses, signed
// URLs, or any raw SDK payload. That list is enforced by `auditRow` in the
// core module rather than by remembering.
//
// Interruptions are expected on a large table, so every page prints the cursor
// to resume from and `--cursor` picks it back up. Concurrency is deliberately
// low: this is pointed at the bucket that serves production.

import { prisma } from "../lib/prisma.ts";
import { probeR2Object } from "../lib/r2.ts";
import {
  auditRow,
  classifyAttachmentProbe,
  decodeAuditCursor,
  describeAuditSummary,
  emptyAuditSummary,
  encodeAuditCursor,
  mapWithConcurrency,
  probeWithRetry,
} from "./audit-message-attachment-objects-core.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const asJson = args.includes("--json");
const apply = args.includes("--apply");
const ticket = flag("ticket");
const pageSize = Math.min(500, Math.max(1, Number(flag("page-size", "200")) || 200));
const limit = Math.max(1, Number(flag("limit", "5000")) || 5000);
const concurrency = Math.min(8, Math.max(1, Number(flag("concurrency", "4")) || 4));

if (apply && !ticket) {
  console.error(
    "--apply records a permanent observation on user rows. Pass --ticket=<id> so the run is attributable."
  );
  process.exit(1);
}

/*
  Refused rather than crashed.

  Without R2 credentials every probe fails at client construction, and the run
  would report every row as unreachable -- a number that looks like a finding
  and is not one. An audit that cannot reach storage has nothing to say.

  The same four variables `getR2Config` in lib/r2.ts requires, in the same
  combination: R2_ENDPOINT overrides the derived endpoint but does not stand in
  for the account id.
*/
if (
  !process.env.R2_ACCOUNT_ID ||
  !process.env.R2_ACCESS_KEY_ID ||
  !process.env.R2_SECRET_ACCESS_KEY ||
  !process.env.R2_BUCKET_NAME
) {
  console.error(
    "R2 is not configured in this environment. This audit reads live object storage and has nothing to report without it."
  );
  process.exit(1);
}

const summary = emptyAuditSummary();
const findings = [];
let cursor = decodeAuditCursor(flag("cursor"));
let lastCursor = flag("cursor");

try {
  summary.totalRows = await prisma.messageAttachment.count();
} catch (error) {
  console.error(
    `Could not count MessageAttachment rows (${error instanceof Error ? error.name : "unknown"}).`
  );
  process.exit(1);
}

const SELECT = {
  id: true,
  conversationId: true,
  userId: true,
  objectKey: true,
  mediaType: true,
  size: true,
  createdAt: true,
  unavailableAt: true,
};

/*
  Two predictable ways this tool is run before it can work, each with its own
  remedy and neither obvious from the stack trace it would otherwise print.

  It is run from an operator's laptop against production, which is exactly the
  situation where the checkout and the deployed schema drift apart: a Prisma
  client generated before the availability columns existed raises a *client*
  validation error naming a field, and a database that has not had the
  migration applied raises a *server* error naming a column. They look alike in
  a stack trace and the fixes are opposite -- one is `npm ci`, the other is a
  deploy nobody should perform from here.

  One cheap probe, so the answer is a sentence instead of a trace.
*/
try {
  await prisma.messageAttachment.findFirst({ select: { id: true, unavailableAt: true } });
} catch (error) {
  const name = error instanceof Error ? error.name : "unknown";
  const text = error instanceof Error ? error.message : "";
  if (/Unknown field .?unavailableAt/.test(text)) {
    console.error(
      [
        "This checkout's Prisma client predates the attachment availability columns.",
        "Fix it here, in this clone:",
        "",
        "  git pull",
        "  npm ci        # postinstall regenerates the Prisma client",
        "",
        "Nothing was read and nothing was written.",
      ].join("\n")
    );
    process.exit(1);
  }
  const code = (error && typeof error === "object" && "code" in error && error.code) || "";
  if (code === "P2022" || /column .*unavailableAt.* does not exist/i.test(text)) {
    console.error(
      [
        "The database has no attachment availability columns, so the migration",
        "20260828090000_message_attachment_availability has not been applied there yet.",
        "",
        "That is a deployment step, not something to run from here: deploy the",
        "release that carries the migration and let its own migrate step apply it.",
        "Never run `prisma migrate dev` against production.",
        "",
        "Nothing was read and nothing was written.",
      ].join("\n")
    );
    process.exit(1);
  }
  console.error(`Could not read MessageAttachment (${name}${code ? ` ${code}` : ""}).`);
  process.exit(1);
}

try {
  while (summary.examined < limit) {
    const page = await prisma.messageAttachment.findMany({
      // Keyset pagination, not offset: rows are being inserted while this
      // runs, and an offset silently skips or repeats under insertion.
      where: cursor
        ? {
            OR: [
              { createdAt: { gt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { gt: cursor.id } },
            ],
          }
        : {},
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: Math.min(pageSize, limit - summary.examined),
      select: SELECT,
    });
    if (page.length === 0) break;

    const states = await mapWithConcurrency(page, concurrency, async (row) => {
      const probe = await probeWithRetry(() => probeR2Object(row.objectKey));
      return { row, probe, state: classifyAttachmentProbe(probe, row) };
    });

    for (const { row, probe, state } of states) {
      summary.examined += 1;
      summary[state] += 1;
      if (row.unavailableAt) summary.alreadyMarkedUnavailable += 1;
      if (state !== "available") findings.push(auditRow(row, state, probe));
    }

    if (apply) {
      const toMark = states.filter(
        (entry) => entry.state === "missing" && !entry.row.unavailableAt
      );
      for (const entry of toMark) {
        // `updateMany` with `unavailableAt: null` in the where: first write
        // wins, so the timestamp keeps saying when this was discovered rather
        // than when it was last re-confirmed, and two overlapping runs cannot
        // fight over it.
        const result = await prisma.messageAttachment.updateMany({
          where: { id: entry.row.id, unavailableAt: null },
          data: {
            unavailableAt: new Date(),
            unavailableReason: "storage_object_missing",
            availabilityCheckedAt: new Date(),
          },
        });
        summary.markedThisRun += result.count;
      }
      // Every examined row gets its check time recorded, so a later run can
      // tell "looked and found it" from "never looked".
      await prisma.messageAttachment.updateMany({
        where: { id: { in: states.map((entry) => entry.row.id) } },
        data: { availabilityCheckedAt: new Date() },
      });
    }

    const tail = page[page.length - 1];
    cursor = { createdAt: tail.createdAt, id: tail.id };
    lastCursor = encodeAuditCursor(tail);
    if (!asJson) {
      console.log(
        `... examined ${summary.examined} (missing ${summary.missing}, unreachable ${summary.temporarily_unreachable}) resume: --cursor='${lastCursor}'`
      );
    }
  }
} finally {
  await prisma.$disconnect().catch(() => {});
}

if (asJson) {
  console.log(
    JSON.stringify(
      { mode: apply ? "apply" : "dry-run", ticket, summary, findings, resumeCursor: lastCursor },
      null,
      2
    )
  );
} else {
  console.log("");
  console.log(apply ? `Mode: apply (ticket ${ticket})` : "Mode: dry run (nothing written)");
  for (const line of describeAuditSummary(summary)) console.log(line);
  if (findings.length > 0) {
    console.log("");
    console.log("attachmentId conversationId createdAt mediaType state storageStatus");
    for (const finding of findings) {
      console.log(
        [
          finding.attachmentId,
          finding.conversationId,
          finding.createdAt,
          finding.mediaType,
          finding.state,
          finding.storageStatus ?? "-",
        ].join(" ")
      );
    }
  }
  if (lastCursor) console.log(`\nResume with: --cursor='${lastCursor}'`);
  console.log(
    "\nMissing bytes cannot be restored from here. Fixing a lifecycle rule stops"
  );
  console.log(
    "future loss; it does not undo past loss. Recovery for a specific file is the"
  );
  console.log("person attaching it again (docs/ops/r2-object-lifecycle.md).");
}
