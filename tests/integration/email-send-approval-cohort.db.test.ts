import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { prisma } from "@/lib/prisma";
import {
  approvalAddressDigest,
  cohortStanding,
  riskAcceptedApprovalSummary,
  sealRiskAcceptedApproval,
} from "@/lib/emailSendApprovalCohort";
import {
  noticeStateForUser,
  recordNoticeObjection,
  recordNoticeShown,
} from "@/lib/inProductConsentNotice";
import { noticePurposes } from "@/lib/inProductConsentNoticeCore";

/**
 * The ledger's first real writers, against the real database.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md, sections 5.4,
 * 5.6 and 6.
 *
 * The unit tests decide; these show that what the writers produce survives the
 * constraints and triggers S3 installed. Two things in particular cannot be
 * shown any other way: that a sealed approval is genuinely immutable, and that
 * recording a notice twice adds one row rather than raising the append-only
 * trigger. The second is why this file exists at all -- the writer was an
 * upsert first, and an upsert's second branch is an UPDATE the trigger
 * refuses.
 */

const approvedAt = new Date("2026-09-16T00:00:00.000Z");

/**
 * An account that existed when the approval was given.
 *
 * The default date matters: section 5.6 says accounts created after the
 * approval do not enter its cohort by any route, and sealing is a route. A
 * fixture user created at `now()` is one of those, so leaving the column to
 * its default made every seal in this file a case the writer should refuse.
 */
const createUser = (signupAt: Date = new Date(approvedAt.getTime() - 86_400_000)) =>
  prisma.user.create({
    data: {
      email: `cohort-${randomUUID()}@example.test`,
      createdAt: signupAt,
    },
  });

/**
 * The **active** policy version, which is the one a verdict compares against.
 *
 * It used to be the earliest row by `createdAt`, whatever its status, and that
 * quietly broke three cases. The runner shares one database: an earlier suite
 * truncates `EmailPolicyVersion`, the permission-ledger suite then creates a
 * **draft** and leaves it, and this file sealed its approvals against that
 * draft while `noticeStateForUser()` read the active bootstrap version. The
 * two disagreed, `approvalScopeRefusal()` answered
 * `approval_policy_version_mismatch`, and every "the cohort is not offered the
 * notice" assertion saw `offered: true`.
 *
 * Section 7.6 is why the comparison exists -- an approval given under an
 * earlier policy version does not carry forward -- so the fixture has to seal
 * under the version the verdict will use, the way an operator would.
 */
const policyVersionId = async () => {
  const active = await prisma.emailPolicyVersion.findFirst({
    where: { status: "active" },
    select: { id: true },
  });
  if (active) return active.id;
  const created = await prisma.emailPolicyVersion.create({
    data: {
      version: `cohort-test-${randomUUID()}`,
      status: "active",
      activatedAt: new Date(),
      changeSummary: "Created by the send approval cohort integration test.",
    },
  });
  return created.id;
};

/**
 * Give an account a self-declared country.
 *
 * The override sends only under a settled country with a reviewed profile, so
 * a fixture account with no country is one the override would never mail --
 * and the notice is correctly offered to it. The cohort cases below need an
 * account the override *would* mail, which is what this makes.
 */
const settleCountry = (userId: string, country: string) =>
  prisma.userSettings.upsert({
    where: { userId },
    update: {
      country,
      countrySource: "self_declared",
      countryUpdatedAt: new Date(),
    },
    create: {
      userId,
      country,
      countrySource: "self_declared",
      countryUpdatedAt: new Date(),
    },
  });

/** The scope a send is judged under, which every standing query must carry. */
const scopeFor = async () => ({
  purpose: "product_updates",
  policyVersionId: await policyVersionId(),
});

const sealFor = async (users: { id: string; email: string | null }[]) =>
  sealRiskAcceptedApproval({
    approvedById: users[0]!.id,
    approvedByEmail: users[0]!.email!,
    approvedAt,
    reason:
      "Owner decision 2026-09-16: send to the existing accounts with no basis.",
    reviewCondition:
      "Re-decide on the first organic signup, unsubscribe or complaint.",
    policyVersionId: await policyVersionId(),
    purposeKey: "*",
    candidates: users.map((user) => ({
      userId: user.id,
      emailAddress: user.email!,
    })),
  });

test("the seal is the row's own instant, not a date the caller picked", async () => {
  // `sealedAt >= createdAt` where createdAt is the transaction's start on the
  // database's clock. Every value a caller could reasonably pass -- the day
  // the owner decided, or a `new Date()` read just before the transaction
  // opened -- is earlier than that, so the caller does not pass one at all.
  const users = [await createUser()];
  const approval = await sealFor(users);

  assert.deepEqual(approval.sealedAt, approval.createdAt);
  assert.ok(approval.sealedAt! >= approval.approvedAt);
});

test("an approval dated in the future is refused by name", async () => {
  const users = [await createUser()];
  await assert.rejects(
    sealRiskAcceptedApproval({
      approvedById: users[0]!.id,
      approvedByEmail: users[0]!.email!,
      approvedAt: new Date(Date.now() + 86_400_000),
      reason: "Dated tomorrow.",
      reviewCondition: "Never.",
      policyVersionId: await policyVersionId(),
      purposeKey: "*",
      candidates: [
        { userId: users[0]!.id, emailAddress: users[0]!.email! },
      ],
    }),
    /seals_before_approval/
  );
  // Refused by name rather than by a raw CHECK violation, and nothing landed.
  assert.equal(
    await prisma.emailSendApprovalMember.count({
      where: { userId: users[0]!.id },
    }),
    0
  );
});

test("a sealed approval carries its exact membership", async () => {
  const users = [await createUser(), await createUser()];
  const approval = await sealFor(users);

  assert.ok(approval.sealedAt);
  const summary = await riskAcceptedApprovalSummary({
    approvalId: approval.id,
  });
  assert.equal(summary?.memberCount, 2);
  assert.equal(summary?.revoked, false);
  // Rule 3: the reason and the review condition are on the screen, not only
  // the count. A screen that showed the count alone reads as consent.
  assert.match(summary!.reason, /no basis/);
  assert.ok(summary!.reviewCondition.length > 0);
});

test("a sealed approval cannot be changed afterwards", async () => {
  const users = [await createUser()];
  const approval = await sealFor(users);

  await assert.rejects(
    prisma.emailSendApproval.update({
      where: { id: approval.id },
      data: { reason: "Something else entirely." },
    }),
    /sealed and cannot be changed/
  );
});

test("the address is stored as a digest, never as the address", async () => {
  const users = [await createUser()];
  const approval = await sealFor(users);

  const member = await prisma.emailSendApprovalMember.findFirstOrThrow({
    where: { approvalId: approval.id },
  });
  assert.equal(member.addressDigest, approvalAddressDigest(users[0]!.email!));
  assert.ok(!member.addressDigest.includes("@"));
  assert.equal(member.noticeAnchorSource, "signup_date_deemed");
});

test("the two-year anchor comes from the account, not from the caller", async () => {
  // Rule 5 deems the signup date the date Korea's two-year notice counts
  // from, and the member row is sealed a moment later -- so a date derived
  // wrongly becomes a statutory reference date nothing can correct. A wrong
  // address only takes the account out of the cohort and stops the mail; a
  // wrong anchor sends a notice on the wrong day, silently.
  const signedUp = new Date("2026-02-14T09:30:00.000Z");
  const user = await createUser(signedUp);
  const approval = await sealFor([user]);

  const member = await prisma.emailSendApprovalMember.findFirstOrThrow({
    where: { approvalId: approval.id },
  });
  assert.deepEqual(member.noticeAnchorAt, signedUp);
  assert.equal(member.noticeAnchorSource, "signup_date_deemed");
});

test("an account that signed up after the approval cannot be sealed into it", async () => {
  // Section 5.6: accounts created after the approval do not enter the cohort
  // by any route, and sealing is one. The seal makes it permanent -- the
  // trigger refuses to remove a member afterwards, so taking one account back
  // out means withdrawing the whole approval and every send it covers.
  const early = await createUser();
  const late = await createUser(new Date(approvedAt.getTime() + 86_400_000));

  await assert.rejects(sealFor([early, late]), /signed up after this approval/);
  assert.equal(
    await prisma.emailSendApprovalMember.count({
      where: { userId: { in: [early.id, late.id] } },
    }),
    0
  );
});

test("an approval naming an account that does not exist is refused", async () => {
  const users = [await createUser()];
  await assert.rejects(
    sealRiskAcceptedApproval({
      approvedById: users[0]!.id,
      approvedByEmail: users[0]!.email!,
      approvedAt,
      reason: "Names a ghost.",
      reviewCondition: "Never.",
      policyVersionId: await policyVersionId(),
      purposeKey: "*",
      candidates: [
        { userId: "no-such-account", emailAddress: "ghost@example.test" },
      ],
    }),
    /do not exist/
  );
});

test("the same mailbox in a different case is the same member", async () => {
  const users = [await createUser()];
  const approval = await sealFor(users);

  const standing = await cohortStanding({
    approvalId: approval.id,
    userId: users[0]!.id,
    deliveryEmailAddress: users[0]!.email!.toUpperCase(),
    ...(await scopeFor()),
  });
  assert.deepEqual(standing, { inCohort: true, approvalId: approval.id });
});

test("changing the address after the seal takes the delivery out", async () => {
  const users = [await createUser()];
  const approval = await sealFor(users);

  await prisma.user.update({
    where: { id: users[0]!.id },
    data: { email: `moved-${randomUUID()}@example.test` },
  });

  const standing = await cohortStanding({
    approvalId: approval.id,
    userId: users[0]!.id,
    // The delivery still carries the approved address. That is the case the
    // three-digest rule exists for: the approval was about a mailbox this
    // person has since left.
    deliveryEmailAddress: users[0]!.email!,
    ...(await scopeFor()),
  });
  assert.deepEqual(standing, {
    inCohort: false,
    reason: "current_address_changed",
  });
});

test("a withdrawn approval covers nobody, including its own members", async () => {
  // Section 5.6 rule 6. Reading membership alone would keep sending to the
  // same addresses after the decision had been reversed, with the admin
  // screen's "revoked" sitting next to a send that ignored it.
  const users = [await createUser()];
  const approval = await sealFor(users);

  const before = await cohortStanding({
    approvalId: approval.id,
    userId: users[0]!.id,
    deliveryEmailAddress: users[0]!.email!,
    ...(await scopeFor()),
  });
  assert.equal(before.inCohort, true);

  await prisma.emailSendApprovalRevocation.create({
    data: {
      approvalId: approval.id,
      revokedById: users[0]!.id,
      revokedByEmail: users[0]!.email!,
      revokedAt: new Date(),
      reason: "An organic signup arrived, which is the review condition.",
    },
  });

  assert.deepEqual(
    await cohortStanding({
      approvalId: approval.id,
      userId: users[0]!.id,
      deliveryEmailAddress: users[0]!.email!,
      ...(await scopeFor()),
    }),
    { inCohort: false, reason: "approval_revoked" }
  );
});

test("an approval that does not exist is not a missing account", async () => {
  assert.deepEqual(
    await cohortStanding({
      approvalId: "no-such-approval",
      userId: null,
      deliveryEmailAddress: null,
      ...(await scopeFor()),
    }),
    { inCohort: false, reason: "no_approval" }
  );
});

test("an account that joined after the seal is in no cohort", async () => {
  const users = [await createUser()];
  const approval = await sealFor(users);
  const latecomer = await createUser();

  const standing = await cohortStanding({
    approvalId: approval.id,
    userId: latecomer.id,
    deliveryEmailAddress: latecomer.email!,
    ...(await scopeFor()),
  });
  assert.deepEqual(standing, { inCohort: false, reason: "not_a_member" });
});

// --- the in-product notice ------------------------------------------------

const noticeInput = (user: { id: string; email: string | null }) => ({
  userId: user.id,
  emailAddress: user.email!,
  surface: "in-product-consent-notice",
  copyHash: "sha256:placeholder-until-S2-approves-the-wording",
  // Reported by the caller that rendered the device, never derived here.
  candidates: [
    {
      country: "AU",
      signal: "self_declared",
      ruleVersion: 1,
      copyHash: "sha256:au-device",
    },
  ],
  // What `resolveEmailJurisdiction()` answered. The writer records this rather
  // than working one out of the candidates.
  resolved: {
    countryCode: "AU",
    profileKey: "AU",
    confidence: "high",
    source: "self_declared",
  },
});

test("recording the same render twice leaves one row", async () => {
  const user = await createUser();
  const first = await recordNoticeShown(noticeInput(user));
  const second = await recordNoticeShown(noticeInput(user));

  assert.equal(first.id, second.id);
  assert.equal(
    await prisma.emailPermissionEvent.count({
      where: { userId: user.id, kind: "notice_shown" },
    }),
    1
  );
});

test("a dismissal records that we asked and nothing about refusing", async () => {
  const user = await createUser();
  await recordNoticeShown(noticeInput(user));

  assert.equal(
    await prisma.emailPermissionEvent.count({
      where: { userId: user.id, kind: "objected" },
    }),
    0
  );
  const shown = await prisma.emailPermissionEvent.findFirstOrThrow({
    where: { userId: user.id, kind: "notice_shown" },
  });
  assert.equal(shown.capturedVia, "in_product_notice");
  assert.equal(shown.scopeKey, "marketing");
});

test("a refusal and a render are two separate facts", async () => {
  const user = await createUser();
  await recordNoticeShown(noticeInput(user));
  await recordNoticeObjection(noticeInput(user));

  const kinds = await prisma.emailPermissionEvent.findMany({
    where: { userId: user.id },
    select: { kind: true },
    orderBy: { kind: "asc" },
  });
  assert.deepEqual(
    kinds.map((row) => row.kind),
    ["notice_shown", "objected"]
  );
});

test("a notice event cannot say which words were on the screen later", async () => {
  const user = await createUser();
  const event = await recordNoticeShown(noticeInput(user));

  // The copy hash is evidence, so the row refuses to be corrected after the
  // fact -- including by the writer that made it.
  await assert.rejects(
    prisma.emailPermissionEvent.update({
      where: { id: event.id },
      data: { evidence: { surface: "elsewhere", copyHash: "different" } },
    }),
    /append-only|accepts no change/
  );
});

test("refusing again at a new address records a refusal for that address", async () => {
  // The key was the account alone, and this was the silent failure: the second
  // write collided with the first, returned it, and reported success, leaving
  // the new address with no refusal on it at all.
  const user = await createUser();
  await recordNoticeObjection(noticeInput(user));

  const movedTo = `moved-${randomUUID()}@example.test`;
  await prisma.user.update({ where: { id: user.id }, data: { email: movedTo } });
  await recordNoticeObjection({ ...noticeInput(user), emailAddress: movedTo });

  const objections = await prisma.emailPermissionEvent.findMany({
    where: { userId: user.id, kind: "objected" },
    select: { emailAddress: true },
  });
  assert.equal(objections.length, 2);
  assert.ok(objections.some((row) => row.emailAddress === movedTo));
});

test("a render is still recorded once however the address moves", async () => {
  // The opposite scoping, and on purpose: the notice happened to a person.
  const user = await createUser();
  await recordNoticeShown(noticeInput(user));

  const movedTo = `moved-${randomUUID()}@example.test`;
  await prisma.user.update({ where: { id: user.id }, data: { email: movedTo } });
  await recordNoticeShown({ ...noticeInput(user), emailAddress: movedTo });

  assert.equal(
    await prisma.emailPermissionEvent.count({
      where: { userId: user.id, kind: "notice_shown" },
    }),
    1
  );
});

test("a notice event without a copy hash is refused before it is written", async () => {
  const user = await createUser();
  await assert.rejects(
    recordNoticeShown({ ...noticeInput(user), copyHash: "  " }),
    /hash of the words/
  );
  assert.equal(
    await prisma.emailPermissionEvent.count({ where: { userId: user.id } }),
    0
  );
});

test("the country on the row is the one the caller says it showed", async () => {
  // Never derived. An account that has declared nothing resolves through
  // language and timezone -- `ko` plus `Asia/Seoul` answers `KR` at low
  // confidence -- and this row has no confidence column, so it would have said
  // `KR` flatly and for ever about somebody shown no Korean device.
  const user = await createUser();
  await recordNoticeShown({
    ...noticeInput(user),
    candidates: [
      {
        country: "SG",
        signal: "self_declared",
        ruleVersion: 4,
        copyHash: "sha256:sg-device",
      },
    ],
    resolved: {
      countryCode: "SG",
      profileKey: "SG",
      confidence: "high",
      source: "self_declared",
    },
  });

  const row = await prisma.emailPermissionEvent.findFirstOrThrow({
    where: { userId: user.id, kind: "notice_shown" },
  });
  assert.equal(row.jurisdiction, "SG");
  assert.equal(row.jurisdictionSource, "self_declared");
  assert.deepEqual(row.evidence, {
    surface: "in-product-consent-notice",
    copyHash: "sha256:placeholder-until-S2-approves-the-wording",
    candidates: [
      {
        country: "SG",
        signal: "self_declared",
        ruleVersion: 4,
        copyHash: "sha256:sg-device",
      },
    ],
  });
});

test("a resolution that settles nothing renders nothing, and is still recorded", async () => {
  // Draft section 5.3 wants the IP country kept as a second candidate, and
  // says in the same passage that S0 must amend the approved contract first --
  // which it has not. So today an unresolved account has no rule to render,
  // and the list is empty rather than holding a country no signal placed the
  // person in.
  //
  // It is still recorded. Dismissing the notice has to leave `notice_shown`
  // behind whatever the jurisdiction was, or the notice returns on every
  // sign-in for exactly the people we could not place.
  const user = await createUser();
  await recordNoticeShown({
    ...noticeInput(user),
    candidates: [],
    resolved: {
      countryCode: "ZZ",
      profileKey: "ZZ",
      confidence: "unknown",
      source: "unresolved",
    },
  });

  const row = await prisma.emailPermissionEvent.findFirstOrThrow({
    where: { userId: user.id, kind: "notice_shown" },
  });
  assert.equal(row.jurisdiction, "ZZ");
  assert.equal(row.jurisdictionSource, "unresolved");
  assert.deepEqual((row.evidence as { candidates: unknown[] }).candidates, []);
});

test("an inferred country is rendered on its own, without the IP country", async () => {
  // Section 5.3: an uncertain estimate keeps both and evaluates both, because
  // somebody who might be in Korea has to pass Korea's rule too. The column
  // holds one value, so it holds the true one -- `ZZ` -- and the candidates
  // persist in the evidence. Picking one would have been permanent: this
  // writer returns the existing row rather than adding a second.
  //
  // The column follows the *resolution*, not the number of candidates. Two
  // guesses are not the resolver's `conflict`, which means a billing country
  // and a self-declaration disagreeing -- so this row is `unresolved`.
  const user = await createUser();
  await recordNoticeShown({
    ...noticeInput(user),
    candidates: [
      {
        country: "KR",
        signal: "inferred",
        ruleVersion: 2,
        copyHash: "sha256:kr-device",
      },
    ],
    resolved: {
      countryCode: "KR",
      profileKey: "KR",
      confidence: "low",
      source: "inferred",
    },
  });

  const row = await prisma.emailPermissionEvent.findFirstOrThrow({
    where: { userId: user.id, kind: "notice_shown" },
  });
  // The column folds to the sentinel because an inference does not settle a
  // jurisdiction; the country it did infer stays in the evidence.
  assert.equal(row.jurisdiction, "ZZ");
  assert.equal(row.jurisdictionSource, "unresolved");
  const evidence = row.evidence as { candidates: { country: string }[] };
  assert.deepEqual(
    evidence.candidates.map((candidate) => candidate.country),
    ["KR"]
  );
});

test("a rendered rule no signal pointed at is refused", async () => {
  // The other direction, and the one a settled-only check could not catch: a
  // low-confidence KR with Singapore also on screen, where nothing named
  // Singapore. Display duties are the union of the rendered list, so that row
  // attaches Singapore's prefix to somebody the resolver never placed there.
  const user = await createUser();
  await assert.rejects(
    recordNoticeShown({
      ...noticeInput(user),
      candidates: [
        {
          country: "KR",
          signal: "inferred",
          ruleVersion: 1,
          copyHash: "sha256:kr-device",
        },
        {
          country: "SG",
          signal: "inferred",
          ruleVersion: 1,
          copyHash: "sha256:sg-device",
        },
      ],
      resolved: {
        countryCode: "KR",
        profileKey: "KR",
        confidence: "low",
        source: "inferred",
      },
    }),
    /SG is not a country this resolution involved/
  );
  assert.equal(
    await prisma.emailPermissionEvent.count({ where: { userId: user.id } }),
    0
  );
});

test("a resolution describing a country the screen never showed is refused", async () => {
  // The two halves of this row come from different places -- the columns from
  // the resolution, the evidence from the candidates -- and nothing used to
  // stop them describing different countries. A send following one would
  // attach the wrong country's display duties, and neither half can be
  // corrected afterwards.
  const user = await createUser();
  await assert.rejects(
    recordNoticeShown({
      ...noticeInput(user),
      candidates: [
        {
          country: "SG",
          signal: "self_declared",
          ruleVersion: 1,
          copyHash: "sha256:sg-device",
        },
      ],
    }),
    /SG is not a country this resolution involved/
  );
  assert.equal(
    await prisma.emailPermissionEvent.count({ where: { userId: user.id } }),
    0
  );
});

test("a named country the screen never rendered is refused, even unsettled", async () => {
  // The check used to run after the fold to `ZZ`, so a low-confidence `KR`
  // rendered against a Singapore device passed: the column said undetermined,
  // the evidence said a Singapore rule applied, and `KR` appeared nowhere in
  // the row. Same failure as a settled mismatch, surviving in the one case the
  // check stopped looking.
  const user = await createUser();
  await assert.rejects(
    recordNoticeShown({
      ...noticeInput(user),
      candidates: [
        {
          country: "SG",
          signal: "inferred",
          ruleVersion: 1,
          copyHash: "sha256:sg-device",
        },
      ],
      resolved: {
        countryCode: "KR",
        profileKey: "KR",
        confidence: "low",
        source: "inferred",
      },
    }),
    /SG is not a country this resolution involved/
  );
  assert.equal(
    await prisma.emailPermissionEvent.count({ where: { userId: user.id } }),
    0
  );
});

test("a conflict has to name the countries that disagreed, and they have to be on the screen", async () => {
  // The column folds to `ZZ` either way, so without the pair nothing in the
  // row says which two countries the conflict was between -- and the display
  // duties of an unresolved pair are the union of theirs.
  const user = await createUser();
  // A conflict always carries the sentinel in the column; the two countries
  // live in `conflicts`, which is where this has to read them.
  const conflicted = {
    countryCode: "ZZ",
    profileKey: "ZZ",
    confidence: "conflict",
    source: "conflict",
  };
  const twoRules = [
    {
      country: "AU",
      signal: "billing",
      ruleVersion: 1,
      copyHash: "sha256:au-device",
    },
    {
      country: "KR",
      signal: "self_declared",
      ruleVersion: 2,
      copyHash: "sha256:kr-device",
    },
  ];

  await assert.rejects(
    recordNoticeShown({
      ...noticeInput(user),
      candidates: twoRules,
      resolved: conflicted,
    }),
    /must name exactly two different countries/
  );

  // One country is not a conflict, and neither is the same one twice.
  for (const conflicts of [["AU"], ["AU", "AU"], ["AU", "KR", "SG"], ["AU", "ZZ"]]) {
    await assert.rejects(
      recordNoticeShown({
        ...noticeInput(user),
        candidates: twoRules,
        resolved: { ...conflicted, conflicts },
      }),
      /must name exactly two different countries/
    );
  }

  // Half a conflict. This used to be accepted, because the settled-singleton
  // rule does not run when the column is `ZZ` -- and a conflict's column is
  // always `ZZ`. The row then claimed a conflict while naming one side, so
  // Korea's prefix would never have attached to this account, and writing it
  // again with both is refused as a different fact.
  await assert.rejects(
    recordNoticeShown({
      ...noticeInput(user),
      candidates: [twoRules[0]!],
      resolved: { ...conflicted, conflicts: ["AU", "KR"] },
    }),
    /KR is a country this resolution involved/
  );

  await recordNoticeShown({
    ...noticeInput(user),
    candidates: twoRules,
    resolved: { ...conflicted, conflicts: ["AU", "KR"] },
  });
  const row = await prisma.emailPermissionEvent.findFirstOrThrow({
    where: { userId: user.id, kind: "notice_shown" },
  });
  assert.equal(row.jurisdiction, "ZZ");
  assert.equal(row.jurisdictionSource, "conflict");
});

test("a settled country is the only rule the screen should have rendered", async () => {
  // Draft section 5.3: two candidates are what an uncertain estimate looks
  // like, and a determinative signal replaces the list rather than joining it.
  // A stray candidate beside a settled country matters because the display
  // duties are the union -- an account settled as Australian with Korea left
  // in the list gets Korea's (광고) prefix, or is refused when two prefixes
  // collide. Permanently: the row is written once.
  const user = await createUser();
  await assert.rejects(
    recordNoticeShown({
      ...noticeInput(user),
      candidates: [
        {
          country: "AU",
          signal: "self_declared",
          ruleVersion: 1,
          copyHash: "sha256:au-device",
        },
        {
          country: "KR",
          signal: "inferred",
          ruleVersion: 2,
          copyHash: "sha256:kr-device",
        },
      ],
    }),
    // The membership check answers first, because nothing named Korea at
    // all. The singleton rule is what would catch a resolution that named a
    // country *alongside* a settled one, which no current resolver output
    // does -- it stays as its own statement rather than as live cover.
    /KR is not a country this resolution involved/
  );
  assert.equal(
    await prisma.emailPermissionEvent.count({ where: { userId: user.id } }),
    0
  );
});

test("a resolution's profile is derived, never taken from the caller", async () => {
  // A caller could pass `{ countryCode: "JP", profileKey: "AU" }`. The profile
  // is computed from the code, so the claim buys nothing.
  const user = await createUser();
  await recordNoticeShown({
    ...noticeInput(user),
    candidates: [
      {
        country: "JP",
        signal: "self_declared",
        ruleVersion: 1,
        copyHash: "sha256:jp-device",
      },
    ],
    resolved: {
      countryCode: "JP",
      profileKey: "AU",
      confidence: "high",
      source: "self_declared",
    },
  });

  const row = await prisma.emailPermissionEvent.findFirstOrThrow({
    where: { userId: user.id, kind: "notice_shown" },
  });
  // The country is kept -- section 6.4 gives this column the resolution as it
  // stood, and a profile added later cannot restore a JP that was erased. The
  // refusal for a country with no display duties is the override's job.
  assert.equal(row.jurisdiction, "JP");
  assert.equal(row.jurisdictionSource, "self_declared");
});

test("a retry that changes only the resolution is refused", async () => {
  // Comparing the candidates alone let this through: the first write's
  // jurisdiction stood and the second caller read success, which erased the
  // difference between `conflict` and `unresolved` the moment anything
  // retried.
  const user = await createUser();
  await recordNoticeShown(noticeInput(user));

  // Same candidates, a different resolution. The AU candidate still belongs
  // to the resolution, so this reaches the comparison rather than a refusal.
  await assert.rejects(
    recordNoticeShown({
      ...noticeInput(user),
      resolved: {
        countryCode: "AU",
        profileKey: "AU",
        confidence: "low",
        source: "inferred",
      },
    }),
    /describes something else/
  );
});

test("a retry that changes only the words on the screen is refused", async () => {
  const user = await createUser();
  await recordNoticeShown(noticeInput(user));

  await assert.rejects(
    recordNoticeShown({ ...noticeInput(user), copyHash: "sha256:different" }),
    /describes something else/
  );
});

test("a country that is not a country code is refused", async () => {
  // `" AU"`, `"kr"`, `"Korea"` and `"inferred"` were all accepted, stored
  // raw on an append-only row, and compared against later with `===`.
  const user = await createUser();
  for (const country of [" ", "Korea", "inferred", "AUS"]) {
    await assert.rejects(
      recordNoticeShown({
        ...noticeInput(user),
        candidates: [
          {
            country,
            signal: "self_declared",
            ruleVersion: 1,
            copyHash: "sha256:device",
          },
        ],
      }),
      /is not a country code/
    );
  }
  assert.equal(
    await prisma.emailPermissionEvent.count({ where: { userId: user.id } }),
    0
  );
});

test("a country is normalised before it is written down", async () => {
  const user = await createUser();
  await recordNoticeShown({
    ...noticeInput(user),
    candidates: [
      {
        country: " au ",
        signal: "self_declared",
        ruleVersion: 1,
        copyHash: "sha256:au-device",
      },
    ],
  });
  const row = await prisma.emailPermissionEvent.findFirstOrThrow({
    where: { userId: user.id, kind: "notice_shown" },
  });
  assert.equal(row.jurisdiction, "AU");
});

test("a settled country with nothing rendered is refused", async () => {
  // The relationship is equality, so an empty list is right only when the
  // resolution named nothing. Against a settled AU it is the other side of
  // the same check.
  const user = await createUser();
  await assert.rejects(
    recordNoticeShown({ ...noticeInput(user), candidates: [] }),
    /AU is a country this resolution involved/
  );
  assert.equal(
    await prisma.emailPermissionEvent.count({ where: { userId: user.id } }),
    0
  );
});

test("an account in a sealed cohort is not offered the notice", async () => {
  // Owner decision 2026-09-23, option B: keep the override and leave these
  // accounts out of the notice, because its opening sentence would be false
  // about exactly them.
  const user = await createUser();
  await settleCountry(user.id, "AU");
  assert.deepEqual(await noticeStateForUser({ userId: user.id }), {
    offered: true,
    purposes: noticePurposes(),
  });

  await sealFor([user]);

  assert.deepEqual(await noticeStateForUser({ userId: user.id }), {
    offered: false,
    refusal: "covered_by_approval",
  });
});

test("changing address puts the notice back, because the override stopped", async () => {
  // The first version asked "is there a member row", which is wider than the
  // thing it stood in for. A member who changes address falls out of the
  // override -- no basis on the new mailbox -- and the notice went on hiding
  // from them on every sign-in, for ever, with withdrawing the whole approval
  // the only way back. Section 5.4's consent route closed for exactly the
  // person the override had stopped covering.
  const user = await createUser();
  await settleCountry(user.id, "AU");
  await sealFor([user]);
  assert.equal((await noticeStateForUser({ userId: user.id })).offered, false);

  await prisma.user.update({
    where: { id: user.id },
    data: { email: `moved-${randomUUID()}@example.test` },
  });

  assert.deepEqual(await noticeStateForUser({ userId: user.id }), {
    offered: true,
    purposes: noticePurposes(),
  });
});

test("an approval scoped to one purpose still hides the notice", async () => {
  // The wording says we have not sent product news and will not unless asked.
  // One purpose going out under an override makes that false for this person,
  // and decision B is that the sentence is only shown to people it is true of.
  //
  // The cost is real and was weighed: the purposes that approval does not
  // cover have neither a basis nor this route to one. The preference centre
  // remains -- section 5.6 rule 4's path -- and showing a promise we have
  // already broken is worse than not asking here.
  const user = await createUser();
  await settleCountry(user.id, "AU");
  await sealRiskAcceptedApproval({
    approvedById: user.id,
    approvedByEmail: user.email!,
    approvedAt,
    reason: "Owner decision, newsletter only.",
    reviewCondition: "Re-decide on the first organic signup.",
    policyVersionId: await policyVersionId(),
    purposeKey: "newsletter",
    candidates: [{ userId: user.id, emailAddress: user.email! }],
  });

  assert.deepEqual(await noticeStateForUser({ userId: user.id }), {
    offered: false,
    refusal: "covered_by_approval",
  });
});

test("a cohort member with no settled country is offered the notice", async () => {
  // In the cohort, never mailed -- the override has no country to send under
  // -- and the wording is true of them. Hiding the notice left no basis, no
  // route to one, and no mail.
  const user = await createUser();
  await sealFor([user]);
  assert.deepEqual(await noticeStateForUser({ userId: user.id }), {
    offered: true,
    purposes: noticePurposes(),
  });
});

test("a cohort member in a country with no reviewed profile is offered the notice", async () => {
  // Japan resolves at high confidence with no reviewed profile, so the
  // override's `country_undetermined` stops the send. The preference centre
  // also refuses Japan, so this notice is the only route there is.
  const user = await createUser();
  await settleCountry(user.id, "JP");
  await sealFor([user]);
  assert.deepEqual(await noticeStateForUser({ userId: user.id }), {
    offered: true,
    purposes: noticePurposes(),
  });
});

test("a cohort member outside the marketing countries is offered the notice", async () => {
  // The Netherlands resolves high confidence to the EU profile, so no
  // override blocker fires -- and `marketingJurisdictionVerdict()` refuses it
  // with `marketing_country_not_allowed`. Never mailed. Asking the send's own
  // gate is what catches it; hand-assembling the gate from its parts did not.
  const user = await createUser();
  await settleCountry(user.id, "NL");
  await sealFor([user]);
  assert.deepEqual(await noticeStateForUser({ userId: user.id }), {
    offered: true,
    purposes: noticePurposes(),
  });
});

test("a render cannot be recorded for somebody the override mails", async () => {
  // A route that asks `noticeStateForUser()` first never tries this. The
  // writer refuses anyway, because the row would be permanent evidence that we
  // showed a promise we had already broken.
  const user = await createUser();
  await settleCountry(user.id, "AU");
  await sealFor([user]);
  await assert.rejects(
    recordNoticeShown(noticeInput(user)),
    /wording would be false for it/
  );
  assert.equal(
    await prisma.emailPermissionEvent.count({ where: { userId: user.id } }),
    0
  );
});

test("withdrawing the approval puts the notice back", async () => {
  // A withdrawn approval leaves those accounts with no basis at all, which is
  // precisely who this notice exists for. Scoping the refusal to a sealed and
  // unwithdrawn approval is what makes that work without a second decision.
  const user = await createUser();
  await settleCountry(user.id, "AU");
  const approval = await sealFor([user]);
  assert.equal((await noticeStateForUser({ userId: user.id })).offered, false);

  await prisma.emailSendApprovalRevocation.create({
    data: {
      approvalId: approval.id,
      revokedById: user.id,
      revokedByEmail: user.email!,
      revokedAt: new Date(),
      reason: "An organic signup arrived, which is the review condition.",
    },
  });

  assert.deepEqual(await noticeStateForUser({ userId: user.id }), {
    offered: true,
    purposes: noticePurposes(),
  });
});

test("a withdrawn consent does not count as consent", async () => {
  // `ConsentRecord` is append-only, so asking for any `granted` row found the
  // first one and called somebody who had since withdrawn a consenting
  // subscriber for ever -- never offered the notice again, and recorded as
  // `already_consented`. The in-product notice is the only place an existing
  // account can actually give consent.
  const user = await createUser();
  const policyId = await policyVersionId();

  const before = await noticeStateForUser({ userId: user.id });
  assert.deepEqual(before, { offered: true, purposes: noticePurposes() });

  const consentRow = (action: string, occurredAt: Date) => ({
    userId: user.id,
    emailAddress: user.email!,
    purpose: noticePurposes()[0]!,
    action,
    occurredAt,
    jurisdiction: "AU",
    jurisdictionSource: "self_declared",
    policyVersionId: policyId,
    capturedVia: "preference_center",
  });

  await prisma.consentRecord.create({
    data: consentRow("granted", new Date("2026-09-01T00:00:00.000Z")),
  });
  assert.deepEqual(await noticeStateForUser({ userId: user.id }), {
    offered: false,
    refusal: "already_consented",
  });

  await prisma.consentRecord.create({
    data: consentRow("withdrawn", new Date("2026-09-02T00:00:00.000Z")),
  });
  const after = await noticeStateForUser({ userId: user.id });
  assert.deepEqual(after, { offered: true, purposes: noticePurposes() });
});

test("two inferences that agree still leave the country undetermined", async () => {
  // The column has no confidence field and the row is append-only, so sealing
  // `AU` off two inferences would be a permanent claim the approved contract
  // does not let an inference make. The candidates persist in the evidence.
  const user = await createUser();
  await recordNoticeShown({
    ...noticeInput(user),
    candidates: [
      {
        country: "AU",
        signal: "inferred",
        ruleVersion: 1,
        copyHash: "sha256:au-device",
      },
      {
        country: " au ",
        signal: "inferred",
        ruleVersion: 1,
        copyHash: "sha256:au-device",
      },
    ],
    resolved: {
      countryCode: "AU",
      profileKey: "AU",
      confidence: "low",
      source: "inferred",
    },
  });

  const row = await prisma.emailPermissionEvent.findFirstOrThrow({
    where: { userId: user.id, kind: "notice_shown" },
  });
  assert.equal(row.jurisdiction, "ZZ");
  assert.equal(row.jurisdictionSource, "unresolved");
  const evidence = row.evidence as { candidates: { country: string }[] };
  assert.deepEqual(
    evidence.candidates.map((entry) => entry.country),
    ["AU", "AU"]
  );
});

test("a self-declared country settles the column", async () => {
  // Draft section 5.3 states it from the other end: self_declared replaces the
  // candidate list, so an inference sitting alongside it does not make a
  // conflict. The country is normalised on the way in.
  const user = await createUser();
  await recordNoticeShown({
    ...noticeInput(user),
    candidates: [
      {
        country: "AU",
        signal: "inferred",
        ruleVersion: 1,
        copyHash: "sha256:au-device",
      },
      {
        country: " au ",
        signal: "self_declared",
        ruleVersion: 1,
        copyHash: "sha256:au-device",
      },
    ],
  });

  const row = await prisma.emailPermissionEvent.findFirstOrThrow({
    where: { userId: user.id, kind: "notice_shown" },
  });
  assert.equal(row.jurisdiction, "AU");
  assert.equal(row.jurisdictionSource, "self_declared");
});

test("a retry carrying different candidates is refused, not silently dropped", async () => {
  // One row per account, append-only, so the first write is permanent.
  // Returning it for a retry that named a second country discarded that
  // country while the caller read success -- and the candidate list is exactly
  // what section 5.3 says must follow the person to the send snapshot.
  const user = await createUser();
  const first = await recordNoticeShown(noticeInput(user));

  // A second candidate the resolution does involve, so the membership checks
  // pass and the comparison is what refuses it.
  await assert.rejects(
    recordNoticeShown({
      ...noticeInput(user),
      candidates: [
        ...noticeInput(user).candidates,
        {
          country: "KR",
          signal: "inferred",
          ruleVersion: 2,
          copyHash: "sha256:kr-device",
        },
      ],
      resolved: {
        countryCode: "KR",
        profileKey: "KR",
        confidence: "low",
        source: "inferred",
      },
    }),
    /AU is not a country this resolution involved/
  );

  const rows = await prisma.emailPermissionEvent.findMany({
    where: { userId: user.id, kind: "notice_shown" },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, first.id);
});

test("a retry carrying the same candidates is still idempotent", async () => {
  // This is the case that failed before the comparison was made canonical:
  // the stored candidates come back from `jsonb` with their keys reordered,
  // so a byte comparison called an identical retry a different fact and threw.
  // Only a round trip through PostgreSQL shows it -- the unit tests never
  // store anything.
  const user = await createUser();
  const first = await recordNoticeShown(noticeInput(user));
  const second = await recordNoticeShown(noticeInput(user));
  assert.equal(first.id, second.id);
});

test("a changed address is seen in the same snapshot as the approval", async () => {
  // Two of the three facts can move -- the approval can be withdrawn and
  // `User.email` can change -- and no ordering of separate reads makes both of
  // them last. Whichever came second to last left a window, and for the address
  // that window let a delivery go to a mailbox the account had already left.
  const users = [await createUser()];
  const approval = await sealFor(users);

  await prisma.user.update({
    where: { id: users[0]!.id },
    data: { email: `moved-${randomUUID()}@example.test` },
  });

  assert.deepEqual(
    await cohortStanding({
      approvalId: approval.id,
      userId: users[0]!.id,
      deliveryEmailAddress: users[0]!.email!,
      ...(await scopeFor()),
    }),
    { inCohort: false, reason: "current_address_changed" }
  );
});

test("an approval sealed for one purpose does not cover another", async () => {
  // `approvalStandingRefusal()` looked at the seal and the withdrawal only, so
  // a decision taken about one kind of mail silently covered every other kind.
  const users = [await createUser()];
  const approval = await sealRiskAcceptedApproval({
    approvedById: users[0]!.id,
    approvedByEmail: users[0]!.email!,
    approvedAt,
    reason: "Owner decision, newsletter only.",
    reviewCondition: "Re-decide on the first organic signup.",
    policyVersionId: await policyVersionId(),
    purposeKey: "newsletter",
    candidates: [
      { userId: users[0]!.id, emailAddress: users[0]!.email! },
    ],
  });

  const query = {
    approvalId: approval.id,
    userId: users[0]!.id,
    deliveryEmailAddress: users[0]!.email!,
    policyVersionId: await policyVersionId(),
  };

  assert.deepEqual(
    await cohortStanding({ ...query, purpose: "newsletter" }),
    { inCohort: true, approvalId: approval.id }
  );
  assert.deepEqual(await cohortStanding({ ...query, purpose: "promotions" }), {
    inCohort: false,
    reason: "approval_purpose_mismatch",
  });
});

test("an approval sealed with no reason is refused", async () => {
  const users = [await createUser()];
  await assert.rejects(
    sealRiskAcceptedApproval({
      approvedById: users[0]!.id,
      approvedByEmail: users[0]!.email!,
      approvedAt,
      reason: "   ",
      reviewCondition: "Re-decide on the first organic signup.",
      policyVersionId: await policyVersionId(),
      purposeKey: "*",
      candidates: [
        { userId: users[0]!.id, emailAddress: users[0]!.email! },
      ],
    }),
    /no_reason/
  );
});
