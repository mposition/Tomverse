import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  activatePolicyVersion,
  ensureJurisdictionPolicyDraft,
} from "@/lib/emailJurisdictionPolicy";
import {
  JURISDICTION_MAPPED_COUNTRY_CODES,
  MARKETING_ALLOWED_COUNTRY_CODES,
} from "@/lib/emailJurisdictionCore";
import {
  releaseNotesAuthorityVerdict,
  releaseNotesCountryRuleSeed,
  releaseNotesRuleKey,
} from "@/lib/releaseNotesCountryRuleCore";

/** The seed, for tests that compare stored rows against what it describes. */
const seedRules = () => releaseNotesCountryRuleSeed();
import {
  releaseNotesRuleVersionConflicts,
  releaseNotesRulesForVersion,
} from "@/lib/releaseNotesCountryRules";

// The recipient-authority rules against the tables that hold them.
//
// Contract: docs/policy/email-notifications.md section 5.1.1; draft sections
// 4.1-4.3 and 7.8.
//
// What needs a database is what the tables refuse: a rule version whose content
// changes after anything was approved against it, and a write to a policy
// version that is no longer a draft. An obligation waiver is scoped to
// (ruleKey, ruleVersion), so both are what stop a waiver from applying to a
// rule nobody approved it for.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ReleaseNotesCountryRule", "ReleaseNotesRuleVersion",
      "JurisdictionCountryMap", "JurisdictionProfile",
      "EmailPolicyVersion", "User"
    RESTART IDENTITY CASCADE
  `);

const actor = () => ({
  actorId: randomUUID(),
  actorEmail: `ops-${randomUUID().slice(0, 8)}@example.test`,
});

const draft = async (version = `test-${randomUUID()}`) =>
  (await ensureJurisdictionPolicyDraft({ version })).version;

/** A bare draft version with no seeded rows, for rules written by hand. */
const bareDraft = () =>
  prisma.emailPolicyVersion.create({
    data: { version: `bare-${randomUUID()}`, status: "draft", changeSummary: "test" },
  });

const ruleVersion = (
  overrides: Partial<Prisma.ReleaseNotesRuleVersionUncheckedCreateInput> = {}
): Prisma.ReleaseNotesRuleVersionUncheckedCreateInput => ({
  ruleKey: releaseNotesRuleKey("US"),
  ruleVersion: 1,
  countryCode: "US",
  basis: "opt_out",
  status: "open",
  releaseConditions: [],
  activationGates: [],
  ...overrides,
});

const countryRule = (
  policyVersionId: string,
  overrides: Partial<Prisma.ReleaseNotesCountryRuleUncheckedCreateInput> = {}
): Prisma.ReleaseNotesCountryRuleUncheckedCreateInput => ({
  policyVersionId,
  countryCode: "US",
  ruleKey: releaseNotesRuleKey("US"),
  ruleVersion: 1,
  notes: "test",
  ...overrides,
});

const refuses = async (write: () => Promise<unknown>, pattern: RegExp) => {
  await assert.rejects(write, (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, pattern);
    return true;
  });
};

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

test("a draft carries one rule per mapped country, and its open set is today's allowlist", async () => {
  const version = await draft();
  const rows = await prisma.releaseNotesCountryRule.findMany({
    where: { policyVersionId: version.id },
    select: { countryCode: true, ruleKey: true, rule: { select: { status: true } } },
  });

  assert.deepEqual(
    rows.map((row) => row.countryCode).sort(),
    [...JURISDICTION_MAPPED_COUNTRY_CODES].sort()
  );
  // The allowlist becomes the rule's status (draft section 4.1). Until S9
  // reads the rows, the constant is still the live gate, and the two must say
  // the same thing.
  assert.deepEqual(
    rows
      .filter((row) => row.rule.status === "open")
      .map((row) => row.countryCode)
      .sort(),
    [...MARKETING_ALLOWED_COUNTRY_CODES].sort()
  );
  for (const row of rows) {
    assert.equal(row.ruleKey, releaseNotesRuleKey(row.countryCode));
  }
});

test("a second draft reuses the rule versions rather than restating them", async () => {
  // One row per (ruleKey, ruleVersion), whatever how many policy versions carry
  // it: that is what makes the pair a waiver can be scoped to.
  const first = await draft();
  const second = await draft();
  const countries = releaseNotesCountryRuleSeed().length;

  assert.equal(await prisma.releaseNotesRuleVersion.count(), countries);
  assert.equal(
    await prisma.releaseNotesCountryRule.count({ where: { policyVersionId: first.id } }),
    countries
  );
  assert.equal(
    await prisma.releaseNotesCountryRule.count({ where: { policyVersionId: second.id } }),
    countries
  );
});

test("a verdict over stored rules needs both authorities", async () => {
  const version = await draft();
  const rules = await releaseNotesRulesForVersion({
    policyVersionId: version.id,
    countries: ["US"],
  });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].basis, "opt_out");

  // US is opt_out on the recipient side, and the Australian sender authority
  // still needs consent: without it nothing is allowed.
  const withoutConsent = releaseNotesAuthorityVerdict({
    countries: ["US"],
    rules,
    consent: { express: false, evidenceIds: [] },
  });
  assert.equal(withoutConsent.legalAllowed, false);
  assert.deepEqual(
    withoutConsent.authorities.map((entry) => [entry.authority, entry.verdict, entry.reason]),
    [
      ["recipient", "allow", null],
      ["au_sender", "deny", "no_au_sender_consent"],
    ]
  );

  const withConsent = releaseNotesAuthorityVerdict({
    countries: ["US"],
    rules,
    consent: { express: true, evidenceIds: ["consent-1"] },
  });
  assert.equal(withConsent.legalAllowed, true);
});

test("a rule version's content cannot change, with or without a second row", async () => {
  // The hole the first version had: the clash check excluded the row being
  // written, so a pair with only one row -- the ordinary case -- could have its
  // basis changed under the same version number and there was nothing to
  // disagree with. Now the content has one row and that row is immutable.
  await prisma.releaseNotesRuleVersion.create({ data: ruleVersion() });

  for (const change of [
    { basis: "express_consent", activationGates: [] },
    { status: "closed" },
    { releaseConditions: ["something_else"] },
    { countryCode: "KR" },
    // Renumbering is how the name would be freed without a delete: v1 becomes
    // v2 and nothing says what v1 meant any more, which is the invariant the
    // delete refusal exists for.
    { ruleVersion: 2 },
  ]) {
    await refuses(
      () =>
        prisma.releaseNotesRuleVersion.update({
          where: { ruleKey_ruleVersion: { ruleKey: releaseNotesRuleKey("US"), ruleVersion: 1 } },
          data: change,
        }),
      /a different content is a new version/
    );
  }

  // The gates are content too. Only `inferred_consent` may carry any, so this
  // needs a rule that has some: swapping one non-empty list for another passes
  // every CHECK, and the trigger is the only thing that refuses it.
  await prisma.releaseNotesRuleVersion.create({
    data: ruleVersion({
      ruleKey: releaseNotesRuleKey("AU"),
      countryCode: "AU",
      basis: "inferred_consent",
      activationGates: ["relationship_model_built", "policy_amendment_e_in_force"],
    }),
  });
  await refuses(
    () =>
      prisma.releaseNotesRuleVersion.update({
        where: { ruleKey_ruleVersion: { ruleKey: releaseNotesRuleKey("AU"), ruleVersion: 1 } },
        data: { activationGates: ["something_else_entirely"] },
      }),
    /a different content is a new version/
  );

  // A new version number is how the content changes.
  await prisma.releaseNotesRuleVersion.create({
    data: ruleVersion({
      ruleVersion: 2,
      basis: "express_consent",
    }),
  });
  const stored = await prisma.releaseNotesRuleVersion.findMany({
    where: { ruleKey: releaseNotesRuleKey("US") },
    orderBy: { ruleVersion: "asc" },
    select: { ruleVersion: true, basis: true },
  });
  assert.deepEqual(stored, [
    { ruleVersion: 1, basis: "opt_out" },
    { ruleVersion: 2, basis: "express_consent" },
  ]);
});

test("a rule version cannot be deleted, referenced or not", async () => {
  // Refusing only a referenced delete left the pair reusable: create a rule
  // version, delete the draft that referenced it (its country rules cascade
  // away), delete the orphan, and insert the same pair with a different
  // content. Every CHECK passes, because the row it would have disagreed with
  // is gone. So the name is never freed.
  //
  // The message is asserted, not just the rejection: a foreign key would refuse
  // the referenced delete on its own, so a test that accepted either error
  // passed with no BEFORE DELETE trigger at all -- which is how the first
  // attempt at this test went green without the fix.
  const deleteUs = () =>
    prisma.releaseNotesRuleVersion.delete({
      where: { ruleKey_ruleVersion: { ruleKey: releaseNotesRuleKey("US"), ruleVersion: 1 } },
    });

  const version = await bareDraft();
  await prisma.releaseNotesRuleVersion.create({ data: ruleVersion() });
  await prisma.releaseNotesCountryRule.create({ data: countryRule(version.id) });
  await refuses(deleteUs, /cannot be deleted/);

  // Now unreferenced, which used to be enough.
  await prisma.emailPolicyVersion.delete({ where: { id: version.id } });
  assert.equal(await prisma.releaseNotesCountryRule.count(), 0);
  await refuses(deleteUs, /cannot be deleted/);

  // And the pair still says what it said, so no re-insert can redefine it.
  const stored = await prisma.releaseNotesRuleVersion.findUniqueOrThrow({
    where: { ruleKey_ruleVersion: { ruleKey: releaseNotesRuleKey("US"), ruleVersion: 1 } },
  });
  assert.equal(stored.basis, "opt_out");
  await refuses(
    () => prisma.releaseNotesRuleVersion.create({ data: ruleVersion({ basis: "express_consent" }) }),
    /[Uu]nique|already exists/
  );
});

test("a rule version's provenance is as fixed as its content", async () => {
  // Nothing reads createdAt to decide a send, and a row whose content cannot
  // change while its timestamp can is append-only in the part somebody checked
  // and not in the part they would cite.
  await prisma.releaseNotesRuleVersion.create({ data: ruleVersion() });
  await refuses(
    () =>
      prisma.releaseNotesRuleVersion.update({
        where: { ruleKey_ruleVersion: { ruleKey: releaseNotesRuleKey("US"), ruleVersion: 1 } },
        data: { createdAt: new Date("2020-01-01T00:00:00.000Z") },
      }),
    /a different content is a new version/
  );
});

test("an active version's rules cannot be changed, removed or added to", async () => {
  const version = await draft();
  await activatePolicyVersion({ versionId: version.id, ...actor() });
  const existing = await prisma.releaseNotesCountryRule.findFirstOrThrow({
    where: { policyVersionId: version.id, countryCode: "KR" },
  });

  await refuses(
    () =>
      prisma.releaseNotesCountryRule.update({
        where: { id: existing.id },
        data: { notes: "edited after activation" },
      }),
    /cannot be changed/
  );
  await refuses(
    () => prisma.releaseNotesCountryRule.delete({ where: { id: existing.id } }),
    /cannot be changed/
  );
  await prisma.releaseNotesRuleVersion.create({
    data: ruleVersion({ ruleKey: releaseNotesRuleKey("ZW"), countryCode: "ZW" }),
  });
  await refuses(
    () =>
      prisma.releaseNotesCountryRule.create({
        data: countryRule(version.id, {
          countryCode: "ZW",
          ruleKey: releaseNotesRuleKey("ZW"),
        }),
      }),
    /draft policy version/
  );
});

test("a write racing an activation waits for its lock, and is then refused", async () => {
  // The migration's claim about `FOR SHARE`: a rule written while a draft is
  // being activated either waits and then sees the new status, or holds the
  // activation back until the rule is committed into what was still a draft.
  // Every other test here activates first and writes afterwards, which an
  // ordinary `SELECT` satisfies equally well -- so nothing pinned the lock.
  //
  // The first attempt at this test raced timers, and a review was right that a
  // timer proves nothing: a slow runner could fail a correct implementation, and
  // a write that had not yet reached the trigger would pass and then be refused
  // after the commit, which an ordinary `SELECT` would also do. So the writes
  // run under `lock_timeout` instead, and the lock conflict itself is what is
  // asserted -- with no `FOR SHARE` the trigger takes no lock and there is
  // nothing to time out on.
  const version = await draft();
  await prisma.releaseNotesRuleVersion.create({
    data: ruleVersion({ ruleKey: releaseNotesRuleKey("ZW"), countryCode: "ZW" }),
  });
  const existing = await prisma.releaseNotesCountryRule.findFirstOrThrow({
    where: { policyVersionId: version.id, countryCode: "KR" },
    select: { id: true },
  });

  let lockHeld: () => void = () => {};
  const activationHasLock = new Promise<void>((resolve) => {
    lockHeld = resolve;
  });
  let commitActivation: () => void = () => {};
  const activationHeld = new Promise<void>((resolve) => {
    commitActivation = resolve;
  });
  const activation = prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`
        UPDATE "EmailPolicyVersion"
           SET "status" = 'active', "activatedAt" = now()
         WHERE "id" = ${version.id}
      `;
      // The UPDATE returning is the lock being held, which is a fact rather
      // than an elapsed interval.
      lockHeld();
      await activationHeld;
    },
    { timeout: 20_000 }
  );

  /** Runs one write in its own transaction, refusing to wait for a lock. */
  const underLockTimeout = <T>(write: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'");
      return write(tx);
    });

  // A boolean beside the value, because `undefined` is a throwable value and
  // using it as the sentinel would read a `throw undefined` as no failure.
  let bodyFailed = false;
  let bodyFailure: unknown;
  try {
    // Raced with the transaction itself: if the UPDATE or the transaction
    // start fails before it signals, `activationHasLock` never settles and
    // this would wait for ever without reporting the failure. Whichever
    // settles first wins, and a rejected activation rethrows here.
    await Promise.race([activationHasLock, activation]);

    // Both writes must conflict on the policy version's row. `55P03` is
    // `lock_not_available`; Prisma surfaces the message.
    await refuses(
      () =>
        underLockTimeout((tx) =>
          tx.releaseNotesCountryRule.create({
            data: countryRule(version.id, {
              countryCode: "ZW",
              ruleKey: releaseNotesRuleKey("ZW"),
            }),
          })
        ),
      /lock timeout|lock_not_available|55P03/i
    );
    await refuses(
      () =>
        underLockTimeout((tx) =>
          tx.releaseNotesCountryRule.delete({ where: { id: existing.id } })
        ),
      /lock timeout|lock_not_available|55P03/i
    );
  } catch (error) {
    // Held rather than rethrown here, so the cleanup below always runs and the
    // activation's own failure can be reported beside this one rather than
    // instead of it.
    bodyFailed = true;
    bodyFailure = error;
  } finally {
    // Whatever happened above, the activation must not be left holding its
    // transaction: the suite's TRUNCATE would wait for it.
    commitActivation();
    // The activation is awaited rather than only settled: a rollback or a
    // timeout here is a fact about the test run, not something to swallow.
    // `console.error` does not fail a node:test run, and a rejected COMMIT can
    // mean the server committed and the answer never arrived -- which leaves
    // the rows in the state the assertions after this read as correct, so a
    // green test over an unknown outcome.
    //
    // Throwing from here replaces the body's completion, which the `catch`
    // above has already taken, so the body's failure is rethrown here rather
    // than being lost.
    const [outcome] = await Promise.allSettled([activation]);
    const activationFailed = outcome.status === "rejected";
    // The race means a pre-signal rejection arrives as *both* failures. It is
    // one failure and is reported once.
    const sameFailure = bodyFailed && activationFailed && bodyFailure === outcome.reason;

    if (bodyFailed && activationFailed && !sameFailure) {
      // The outer message carries both, because the default TAP reporter the
      // DB runner uses prints an AggregateError's own message and stack and
      // not the errors inside it.
      throw new AggregateError(
        [bodyFailure, outcome.reason],
        "the test failed (" +
          String(bodyFailure) +
          "), and the held activation did not commit cleanly (" +
          String(outcome.reason) +
          ")"
      );
    }
    if (bodyFailed) throw bodyFailure;
    // Thrown as it is, so its own type, stack and properties survive.
    if (activationFailed) throw outcome.reason;
  }

  // And now that it is committed, the same writes are refused for the reason
  // they were waiting to find out.
  await refuses(
    () =>
      prisma.releaseNotesCountryRule.create({
        data: countryRule(version.id, {
          countryCode: "ZW",
          ruleKey: releaseNotesRuleKey("ZW"),
        }),
      }),
    /draft policy version/
  );
  await refuses(
    () => prisma.releaseNotesCountryRule.delete({ where: { id: existing.id } }),
    /cannot be changed/
  );

  // The active version's rules are the ones it was activated with.
  assert.equal(
    await prisma.releaseNotesCountryRule.count({ where: { policyVersionId: version.id } }),
    seedRules().length
  );
});

test("a rule cannot be moved onto an active policy version", async () => {
  const active = await draft();
  await activatePolicyVersion({ versionId: active.id, ...actor() });
  const stillDraft = await bareDraft();
  await prisma.releaseNotesRuleVersion.create({
    data: ruleVersion({ ruleKey: releaseNotesRuleKey("ZW"), countryCode: "ZW" }),
  });
  const row = await prisma.releaseNotesCountryRule.create({
    data: countryRule(stillDraft.id, {
      countryCode: "ZW",
      ruleKey: releaseNotesRuleKey("ZW"),
    }),
  });

  await refuses(
    () =>
      prisma.releaseNotesCountryRule.update({
        where: { id: row.id },
        data: { policyVersionId: active.id },
      }),
    /draft policy version/
  );
});

test("a draft's rules can be edited, and deleting the draft takes them with it", async () => {
  const version = await bareDraft();
  await prisma.releaseNotesRuleVersion.create({ data: ruleVersion() });
  const row = await prisma.releaseNotesCountryRule.create({ data: countryRule(version.id) });
  await prisma.releaseNotesCountryRule.update({
    where: { id: row.id },
    data: { notes: "edited while a draft" },
  });

  await prisma.emailPolicyVersion.delete({ where: { id: version.id } });
  assert.equal(await prisma.releaseNotesCountryRule.count(), 0);
  // The rule version outlives the draft that referenced it: it is what a
  // waiver may have named, and nothing else says what that version meant. It
  // cannot be deleted afterwards either -- see the test above.
  assert.equal(await prisma.releaseNotesRuleVersion.count(), 1);
});

test("a seed that disagrees with a stored rule version is refused, not silently ignored", async () => {
  // `createMany({ skipDuplicates: true })` would accept an edited seed and leave
  // the stored rule saying the old thing. The draft writer checks instead.
  const seed = releaseNotesCountryRuleSeed();
  await prisma.releaseNotesRuleVersion.create({
    data: ruleVersion({
      ruleKey: releaseNotesRuleKey("KR"),
      countryCode: "KR",
      basis: "opt_out",
      status: "closed",
    }),
  });

  const conflicts = await releaseNotesRuleVersionConflicts(prisma, seed);
  assert.deepEqual(conflicts, ["release_notes.KR v1 (basis, status)"]);
  await assert.rejects(() => ensureJurisdictionPolicyDraft({ version: `x-${randomUUID()}` }), /new rule version/);
});

test("a conflict in either JSON field is a conflict too", async () => {
  // The comparison covers four fields and only two of them were pinned, so
  // dropping the two array comparisons left the suite green while an edited
  // seed would have been accepted in silence.
  const seed = seedRules();
  const au = seed.find((rule) => rule.countryCode === "AU");
  assert.ok(au, "the seed has no Australian rule");

  await prisma.releaseNotesRuleVersion.create({
    data: ruleVersion({
      ruleKey: releaseNotesRuleKey("AU"),
      countryCode: "AU",
      basis: au.basis,
      status: au.status,
      // One item short of what the seed describes.
      releaseConditions: [...au.releaseConditions].slice(1),
      activationGates: [...au.activationGates],
    }),
  });
  assert.deepEqual(await releaseNotesRuleVersionConflicts(prisma, seed), [
    "release_notes.AU v1 (releaseConditions)",
  ]);
  await assert.rejects(
    () => ensureJurisdictionPolicyDraft({ version: `x-${randomUUID()}` }),
    /new rule version/
  );

  await reset();
  await prisma.releaseNotesRuleVersion.create({
    data: ruleVersion({
      ruleKey: releaseNotesRuleKey("AU"),
      countryCode: "AU",
      basis: au.basis,
      status: au.status,
      releaseConditions: [...au.releaseConditions],
      // Reordered, which is a different rule: the order is part of the value.
      activationGates: [...au.activationGates].reverse(),
    }),
  });
  assert.deepEqual(await releaseNotesRuleVersionConflicts(prisma, seed), [
    "release_notes.AU v1 (activationGates)",
  ]);
  await assert.rejects(
    () => ensureJurisdictionPolicyDraft({ version: `x-${randomUUID()}` }),
    /new rule version/
  );
});

test("the row's own shape is checked", async () => {
  const cases: Array<[Partial<Prisma.ReleaseNotesRuleVersionUncheckedCreateInput>, RegExp]> = [
    [{ ruleKey: releaseNotesRuleKey("KR") }, /ruleKey_check/],
    [{ countryCode: "ZZ", ruleKey: releaseNotesRuleKey("ZZ") }, /countryCode_check/],
    [{ countryCode: "us", ruleKey: releaseNotesRuleKey("us") }, /countryCode_check/],
    [{ basis: "implied" }, /basis_check/],
    [{ status: "paused" }, /status_check/],
    [{ ruleVersion: 0 }, /ruleVersion_check/],
    [{ releaseConditions: { a: 1 } }, /shape_check/],
    // A gate only belongs to the basis a gate holds back, and that basis must
    // have one: a rule held back for a reason no code reads, or acted on
    // although approval C says not yet, are the two mistakes this refuses.
    [{ activationGates: ["something"] }, /gates_check/],
    [{ basis: "inferred_consent", activationGates: [] }, /gates_check/],
  ];
  for (const [overrides, pattern] of cases) {
    await refuses(
      () => prisma.releaseNotesRuleVersion.create({ data: ruleVersion(overrides) }),
      pattern
    );
  }

  await prisma.releaseNotesRuleVersion.create({ data: ruleVersion() });
  const version = await bareDraft();
  await refuses(
    () => prisma.releaseNotesCountryRule.create({ data: countryRule(version.id, { notes: "  " }) }),
    /notes_check/
  );
  await refuses(
    () =>
      prisma.releaseNotesCountryRule.create({
        data: countryRule(version.id, { countryCode: "KR" }),
      }),
    /ReleaseNotesCountryRule_ruleKey_check/
  );
});
