// Seals decision F's `risk_accepted` approval around the accounts that existed
// when it was given.
//
//   npm run email:seal-risk-accepted-cohort -- --approved-at <ISO instant> --approved-by <email>
//   npm run email:seal-risk-accepted-cohort -- --approved-at <ISO instant> --approved-by <email> \
//       --apply --confirm-count <N>
//
// Contract: docs/policy/email-product-news-redesign-draft.md section 5.6, and
// docs/policy/email-policy-amendment-draft.md section 1 (the seal comes before
// the change notice, with decision F's approvedAt).
//
// ## What it does
//
// Without `--apply` it writes nothing. It reads the accounts, prints counts --
// never an address or an id -- and says what `--apply` would seal. With
// `--apply` it needs `--confirm-count` equal to the candidate count it just
// computed, so the seal covers the population the operator saw and no other.
//
// The seal itself is `sealRiskAcceptedApproval()` (lib/emailSendApprovalCohort.ts):
// one transaction writes the approval, its members and the seal, and refuses an
// account that does not exist, has no signup date or signed up after
// `approvedAt`. This script only chooses the candidates and refuses to run
// twice: a sealed, unwithdrawn approval for the same purpose already covers
// these accounts, and a second one would make "who is covered" two answers.
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
import { sealRiskAcceptedApproval } from "../lib/emailSendApprovalCohort.ts";

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

const run = async () => {
  const approvedAtArg = flag("--approved-at");
  const approvedBy = flag("--approved-by")?.trim().toLowerCase();
  const apply = args.includes("--apply");
  const confirmCount = flag("--confirm-count");

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

  const existing = await prisma.emailSendApproval.count({
    where: {
      approvalType: "risk_accepted",
      purposeKey: PURPOSE_KEY,
      sealedAt: { not: null },
      revocations: { none: {} },
    },
  });
  if (existing > 0) {
    return fail(
      `A sealed, unwithdrawn risk_accepted approval for ${PURPOSE_KEY} already exists (${existing}). Nothing to do.`
    );
  }

  const accounts = await prisma.user.findMany({
    select: { id: true, email: true, createdAt: true },
  });
  const noAddress = accounts.filter((account) => !account.email).length;
  const undated = accounts.filter((account) => account.email && !account.createdAt).length;
  const later = accounts.filter(
    (account) => account.email && account.createdAt && account.createdAt.getTime() > approvedAt.getTime()
  ).length;
  const candidates = accounts
    .filter(
      (account) => account.email && account.createdAt && account.createdAt.getTime() <= approvedAt.getTime()
    )
    .map((account) => ({ userId: account.id, emailAddress: account.email }));

  console.log(`approvedAt:              ${approvedAt.toISOString()}`);
  console.log(`purpose:                 ${PURPOSE_KEY}`);
  console.log(`accounts in database:    ${accounts.length}`);
  console.log(`  without an address:    ${noAddress} (not covered)`);
  console.log(`  without a signup date: ${undated} (not covered)`);
  console.log(`  signed up later:       ${later} (not covered)`);
  console.log(`candidates to seal:      ${candidates.length}`);

  if (!apply) {
    console.log(`\nDry run: nothing written. To seal, rerun with --apply --confirm-count ${candidates.length}.`);
    return;
  }
  if (confirmCount !== String(candidates.length)) {
    return fail(
      `--confirm-count must equal the candidate count (${candidates.length}); the population changed or was not confirmed.`
    );
  }

  const sealed = await sealRiskAcceptedApproval({
    approvedById: approver.id,
    approvedByEmail: approver.email,
    approvedAt,
    reason: REASON,
    reviewCondition: REVIEW_CONDITION,
    policyVersionId: policies[0].id,
    purposeKey: PURPOSE_KEY,
    candidates,
  });
  console.log(`\nSealed at ${sealed.sealedAt?.toISOString()} covering ${candidates.length} account(s).`);
};

run()
  .catch((error) => fail(error instanceof Error ? error.message : String(error)))
  .finally(() => prisma.$disconnect());
