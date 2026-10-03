// Seals decision F's `risk_accepted` approval around the accounts that existed
// when it was given.
//
//   npm run email:seal-risk-accepted-cohort -- --approved-at <ISO instant> --approved-by <email>
//   npm run email:seal-risk-accepted-cohort -- --approved-at <ISO instant> --approved-by <email> \
//       --apply --confirm-cohort <digest printed by the dry run>
//
// Contract: docs/policy/email-product-news-redesign-draft.md section 5.6, and
// docs/policy/email-policy-amendment-draft.md section 1 (the seal comes before
// the change notice, with decision F's approvedAt).
//
// ## What it does
//
// Without `--apply` it writes nothing. It reads the accounts and prints counts
// and a cohort digest -- never an address or an id. The digest is a SHA-256 of
// the exact scope: approvedAt, the purpose, the address normalisation version
// and every candidate's (userId, address digest) pair, sorted. Section 5.6
// makes that list, not its size, the approval's scope.
//
// With `--apply` it needs `--confirm-cohort` equal to the digest of the cohort
// it computes *inside the sealing transaction*. A member swapped, or an
// address changed, between the dry run and the seal changes the digest, and
// nothing is written.
//
// The transaction is SERIALIZABLE. It rechecks that no sealed, unwithdrawn
// approval for the same purpose exists, reads the accounts, compares the
// digest and seals through `sealRiskAcceptedApproval()`
// (lib/emailSendApprovalCohort.ts), which refuses an account that does not
// exist, has no signup date or signed up after `approvedAt`. Two concurrent
// runs both read "none exists" and both insert; PostgreSQL's serializable
// isolation aborts one of them, so the tool cannot seal twice.
//
// ## What it does not decide
//
// Who is mailed. Membership is the scope; every send still asks the override's
// blockers (section 5.6's table -- objection, withdrawal, suppression, an
// undetermined country, an undecided obligation, the in-product notice's
// promise) at enqueue and at send.
//
// DATABASE_URL must point at the database to seal. The approval and its
// members are permanent; withdrawing is an EmailSendApprovalRevocation, not an
// edit.
import { prisma } from "../lib/prisma.ts";
import {
  approvalAddressDigest,
  sealRiskAcceptedApproval,
} from "../lib/emailSendApprovalCohort.ts";
import { EMAIL_ADDRESS_NORMALIZATION_VERSION } from "../lib/emailSuppressionCore.ts";
import { cohortDigest, coveredAt } from "./seal-risk-accepted-cohort-core.mjs";

const PURPOSE_KEY = "product_updates";

// Section 5.6 in the decision's own terms. Sealed text cannot be corrected, so
// it quotes the recorded decision rather than paraphrasing it.
const REASON =
  "결정 F (소유자 결정 2026-09-16, docs/policy/email-product-news-redesign-draft.md §5.6): " +
  "기존 계정 전원에게 제품 소식 발송, risk_accepted로 기록. 근거는 계정 수가 적고 전원 지인 경로이며 " +
  "순수 유입이 0이라는 판단이고, 법이 허용한다는 판단이 아니다. 범위는 전 법역.";
const REVIEW_CONDITION =
  "순수 유입이 생기거나, 수신거부·불만이 들어오면 다시 판단한다. 승인을 거두면 " +
  "EmailSendApprovalRevocation을 추가하고 이후 판정은 override 없이 한다 (§5.6 규칙 6).";

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const fail = (message) => {
  console.error(message);
  process.exitCode = 1;
};

const ALREADY_SEALED = {
  approvalType: "risk_accepted",
  purposeKey: PURPOSE_KEY,
  sealedAt: { not: null },
  revocations: { none: {} },
};

/** The candidates at `approvedAt`, the counts left out, and the scope's digest. */
const cohortAt = async (db, approvedAt) => {
  const accounts = await db.user.findMany({ select: { id: true, email: true, createdAt: true } });
  const candidates = accounts
    .filter((account) => coveredAt(account, approvedAt))
    .map((account) => ({ userId: account.id, emailAddress: account.email }));
  const digest = cohortDigest({
    approvedAt,
    purposeKey: PURPOSE_KEY,
    addressNormalizationVersion: EMAIL_ADDRESS_NORMALIZATION_VERSION,
    members: candidates.map((candidate) => ({
      userId: candidate.userId,
      addressDigest: approvalAddressDigest(candidate.emailAddress),
    })),
  });
  return {
    total: accounts.length,
    noAddress: accounts.filter((account) => !account.email).length,
    undated: accounts.filter((account) => account.email && !account.createdAt).length,
    later: accounts.filter(
      (account) => account.email && account.createdAt && account.createdAt.getTime() > approvedAt.getTime()
    ).length,
    candidates,
    digest,
  };
};

const run = async () => {
  const approvedAtArg = flag("--approved-at");
  const approvedBy = flag("--approved-by")?.trim().toLowerCase();
  const apply = args.includes("--apply");
  const confirmCohort = flag("--confirm-cohort");

  if (!approvedAtArg || !approvedBy) {
    return fail("Both --approved-at <ISO instant> and --approved-by <email> are required.");
  }
  // An instant, not a day: which accounts existed depends on the hour.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(approvedAtArg)) {
    return fail("--approved-at must be an ISO instant with a zone, e.g. 2026-09-16T13:59:59Z.");
  }
  const approvedAt = new Date(approvedAtArg);
  if (Number.isNaN(approvedAt.getTime()) || approvedAt.getTime() > Date.now()) {
    return fail("--approved-at must be a real instant in the past.");
  }

  const approver = await prisma.user.findFirst({
    where: { email: { equals: approvedBy, mode: "insensitive" } },
    select: { id: true, email: true },
  });
  if (!approver?.email) return fail("No account has the --approved-by address.");

  const policies = await prisma.emailPolicyVersion.findMany({
    where: { status: "active" },
    select: { id: true },
  });
  if (policies.length !== 1) {
    return fail(`Expected exactly one active email policy version, found ${policies.length}.`);
  }

  const existing = await prisma.emailSendApproval.count({ where: ALREADY_SEALED });
  if (existing > 0) {
    return fail(
      `A sealed, unwithdrawn risk_accepted approval for ${PURPOSE_KEY} already exists (${existing}). Nothing to do.`
    );
  }

  const cohort = await cohortAt(prisma, approvedAt);
  console.log(`approvedAt:              ${approvedAt.toISOString()}`);
  console.log(`purpose:                 ${PURPOSE_KEY}`);
  console.log(`accounts in database:    ${cohort.total}`);
  console.log(`  without an address:    ${cohort.noAddress} (not covered)`);
  console.log(`  without a signup date: ${cohort.undated} (not covered)`);
  console.log(`  signed up later:       ${cohort.later} (not covered)`);
  console.log(`candidates to seal:      ${cohort.candidates.length}`);
  console.log(`cohort digest:           ${cohort.digest}`);

  if (cohort.candidates.length === 0) {
    // An approval covering nobody cannot be told apart from one whose member
    // writes failed (sealRefusal: no_members), so there is nothing to seal.
    return fail("\nNo account existed at --approved-at with an address and a signup date; nothing to seal.");
  }
  if (!apply) {
    console.log(`\nDry run: nothing written. To seal exactly this cohort, rerun with:
  --apply --confirm-cohort ${cohort.digest}`);
    return;
  }
  if (!confirmCohort) return fail("--apply needs --confirm-cohort <digest printed by the dry run>.");

  const sealed = await prisma.$transaction(
    async (tx) => {
      if ((await tx.emailSendApproval.count({ where: ALREADY_SEALED })) > 0) {
        throw new Error(`A sealed, unwithdrawn risk_accepted approval for ${PURPOSE_KEY} already exists.`);
      }
      const current = await cohortAt(tx, approvedAt);
      if (current.digest !== confirmCohort) {
        throw new Error(
          "The cohort is not the one confirmed: an account or an address changed since the dry run. Run the dry run again."
        );
      }
      const approval = await sealRiskAcceptedApproval({
        approvedById: approver.id,
        approvedByEmail: approver.email,
        approvedAt,
        reason: REASON,
        reviewCondition: REVIEW_CONDITION,
        policyVersionId: policies[0].id,
        purposeKey: PURPOSE_KEY,
        candidates: current.candidates,
        client: tx,
      });
      return { approval, members: current.candidates.length };
    },
    { isolationLevel: "Serializable", timeout: 60_000 }
  );
  console.log(`\nSealed at ${sealed.approval.sealedAt?.toISOString()} covering ${sealed.members} account(s).`);
};

run()
  .catch((error) => fail(error instanceof Error ? error.message : String(error)))
  .finally(() => prisma.$disconnect());
