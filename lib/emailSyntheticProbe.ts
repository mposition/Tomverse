import "server-only";

import { prisma } from "@/lib/prisma";
import { createUnsubscribeToken, readUnsubscribeKeyring } from "@/lib/unsubscribeToken";
import { normalizeSuppressionAddress } from "@/lib/emailSuppression";
import {
  PROBE_REFUSAL_REMEDY,
  PROBE_STEPS,
  SYNTHETIC_PROBE_ADDRESS_ENV,
  SYNTHETIC_PROBE_ENABLED_ENV,
  isReservedProbeAddress,
  probeAccountProblems,
  probeVerdict,
  type ProbeObservation,
  type ProbeRefusal,
  type ProbeVerdict,
  type WrittenRow,
} from "@/lib/emailSyntheticProbeCore";

/**
 * Invariant 10, run: the unsubscribe path end to end against a live deployment.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 7.1
 * (invariant 10) and section 12 (S10a). The refusals, the expected answers and
 * the scope condition are in `emailSyntheticProbeCore.ts`; this supplies the
 * facts and performs the calls.
 *
 * ## The purpose it uses
 *
 * `service_status`, not `product_updates`, and the reason is the product's own
 * rule rather than convenience. The probe has to turn a purpose off *and back
 * on*, every run. `product_updates` is consent-required, and switching a
 * consent-required purpose on needs a confirmation (docs/policy/
 * email-double-opt-in.md section 3 rule 1): `setPreference()` refuses it as
 * `confirmation_required` for every caller that has not checked a confirmation
 * token. The first version of this probe used `product_updates` and so failed
 * its own restore on every run.
 *
 * The ways round that are both worse than the change. A confirmation mail to a
 * reserved-name address cannot be delivered, and the bounce would suppress the
 * probe address globally. A path that re-enables a consent purpose without a
 * confirmation -- even one limited to reserved names -- is a way round double
 * opt-in, which is the thing that rule exists to prevent.
 *
 * `service_status` is switchable, is not consent-required, defaults on, and
 * goes through exactly the same endpoint, token, rate limits, preference write,
 * transition and suppression cause. What it does not exercise is the consent
 * record a consent purpose writes on withdrawal; that half of the write path is
 * `setPreference()`'s, and its DB tests (tests/integration/
 * email-preferences-consent.db.test.ts) are what cover it.
 *
 * ## Why it restores
 *
 * The probe turns the purpose off. Leaving it off would make the second run
 * exercise the `already_set` path and never the write again -- the check would
 * pass forever on the strength of one run years ago. So the last thing it does
 * is put the preference back, and it reports a restore that failed as a failure
 * rather than a note: a probe account left unsubscribed is a probe that has
 * stopped checking anything.
 */

/** The purpose the probe turns off and back on. */
export const PROBE_PURPOSE = "service_status";

const refuse = (refusal: ProbeRefusal): ProbeVerdict => ({
  ran: false,
  refusal,
  remedy: PROBE_REFUSAL_REMEDY[refusal],
});

const post = async (
  url: string,
  body: Record<string, string>
): Promise<{ status: number; body: unknown }> => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      // The header a mailbox provider sends for RFC 8058 one-click. Sent here
      // because the path under test is the one real one-click traffic takes,
      // not a convenient approximation of it.
      "User-Agent": "tomverse-invariant-10-probe",
    },
    body: new URLSearchParams(body).toString(),
    redirect: "manual",
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Left null. `stepProblems()` reports "the body was not an object", which is
    // the honest description of an HTML error page from a proxy in front of the
    // app.
  }
  return { status: response.status, body: parsed };
};

export async function runSyntheticUnsubscribeProbe(
  env: NodeJS.ProcessEnv = process.env
): Promise<ProbeVerdict> {
  // Off by default and enabled only by the exact string, like every other
  // switch in this system. This one writes, so a truthy-ish value is not
  // consent.
  if (env[SYNTHETIC_PROBE_ENABLED_ENV] !== "true") return refuse("probe_disabled");

  const configured = (env[SYNTHETIC_PROBE_ADDRESS_ENV] ?? "").trim();
  if (!configured) return refuse("no_probe_address");
  // Before any database read. A misconfigured address must not become a lookup
  // that finds a customer.
  if (!isReservedProbeAddress(configured)) return refuse("address_not_reserved");

  const keyring = readUnsubscribeKeyring(env);
  if (!keyring) return refuse("unsubscribe_not_configured");

  const appUrl = (env.PUBLIC_APP_URL || env.NEXT_PUBLIC_APP_URL || "").trim();
  if (!appUrl) return refuse("no_probe_target");
  const endpoint = new URL("/api/unsubscribe", appUrl).toString();

  const emailAddress = normalizeSuppressionAddress(configured);
  const account = await prisma.user.findFirst({
    where: { email: { equals: configured, mode: "insensitive" } },
    select: {
      id: true,
      email: true,
      stripeCustomerId: true,
      _count: { select: { creditLots: true, conversations: true, creditPurchases: true } },
    },
  });
  if (!account) return refuse("probe_account_missing");

  const problems = probeAccountProblems({
    creditLots: account._count.creditLots,
    conversations: account._count.conversations,
    hasBillingIdentity: Boolean(account.stripeCustomerId),
    purchases: account._count.creditPurchases,
  });
  if (problems.length > 0) return refuse("probe_account_not_synthetic");

  const subject = { userId: account.id, emailAddress };

  // Everything above this line only read. Everything below writes.
  //
  // First, put the purpose on. A previous run that failed between its unsubscribe
  // and its restore would otherwise leave this one exercising the already-set
  // path and never the write -- and reporting that as the endpoint having
  // written nothing. Done before the window opens, so its rows are not counted as
  // the probe's.
  if (!(await restore(account.id))) return refuse("probe_preference_unavailable");
  const token = createUnsubscribeToken(
    { userId: account.id, purpose: PROBE_PURPOSE },
    keyring
  );
  // A token under a version this keyring does not hold. Built by corrupting the
  // version segment rather than by inventing bytes, so the refusal being tested
  // is "this deployment cannot open it" and not "this is not a token".
  const forged = (() => {
    const parts = token.split(".");
    parts[1] = `${parts[1]}-not-a-version`;
    return parts.join(".");
  })();

  const startedAt = new Date();
  const observed: ProbeObservation[] = [];
  for (const step of PROBE_STEPS) {
    const body: Record<string, string> =
      step.key === "no_token"
        ? {}
        : step.key === "forged_token"
          ? { t: forged }
          : { t: token };
    const answer = await post(endpoint, body);
    observed.push({ key: step.key, status: answer.status, body: answer.body });
  }

  // What the request wrote, scoped to the probe subject *and* to the window.
  // Both, not either: the subject alone would sweep up rows this account
  // already had, and the window alone would sweep up a real recipient who
  // unsubscribed while this was running -- which is the failure that gets a
  // check disabled rather than fixed.
  const written = await writtenRows(subject, startedAt);

  const preference = await prisma.emailPreference.findUnique({
    where: { userId_purpose: { userId: account.id, purpose: PROBE_PURPOSE } },
    select: { enabled: true },
  });

  const verdict = probeVerdict({
    observed,
    written,
    subject,
    preferenceDisabled: preference !== null && !preference.enabled,
  });

  const restored = await restore(account.id);
  if (verdict.ran && !restored) {
    return {
      ran: true,
      passed: false,
      problems: [
        ...verdict.problems,
        `the probe account is still unsubscribed from ${PROBE_PURPOSE}; the next run would exercise the already-set path and never the write`,
      ],
    };
  }
  return verdict;
}

/**
 * The rows the probe's request produced.
 *
 * The four tables the unsubscribe write path can touch (`setPreference()` in
 * `lib/emailPreferences.ts`): the preference itself, the append-only
 * transition, the consent record and the suppression cause. The consent record
 * is read even though `service_status` writes none: a consent row appearing for
 * this purpose is exactly the kind of surprise the shape check is for. A fifth
 * table would be a row this check cannot say is its own, which is why the list
 * is written out rather than derived.
 */
const writtenRows = async (
  subject: { userId: string; emailAddress: string },
  since: Date
): Promise<WrittenRow[]> => {
  const [transitions, consents, causes] = await Promise.all([
    prisma.emailPreferenceTransition.findMany({
      where: { userId: subject.userId, occurredAt: { gte: since } },
      select: { id: true, userId: true },
    }),
    prisma.consentRecord.findMany({
      where: { emailAddress: subject.emailAddress, createdAt: { gte: since } },
      select: { id: true, userId: true, emailAddress: true },
    }),
    prisma.suppressionCause.findMany({
      where: { emailAddress: subject.emailAddress, createdAt: { gte: since } },
      select: { id: true, emailAddress: true },
    }),
  ]);

  return [
    ...transitions.map((row: { id: string; userId: string }) => ({
      table: "EmailPreferenceTransition",
      id: row.id,
      userId: row.userId,
      emailAddress: null,
    })),
    ...consents.map((row: { id: string; userId: string | null; emailAddress: string }) => ({
      table: "ConsentRecord",
      id: row.id,
      userId: row.userId,
      emailAddress: row.emailAddress,
    })),
    ...causes.map((row: { id: string; emailAddress: string }) => ({
      table: "SuppressionCause",
      id: row.id,
      userId: null,
      emailAddress: row.emailAddress,
    })),
    // The preference row is updated rather than created, so it has no window to
    // be found in. It is named explicitly, which is also the honest shape: this
    // check knows which preference it changed.
    {
      table: "EmailPreference",
      id: `${subject.userId}:${PROBE_PURPOSE}`,
      userId: subject.userId,
      emailAddress: null,
    },
  ];
};

/**
 * Puts the probe account back.
 *
 * Through the ordinary preference API rather than a direct write, so a
 * restore that the product would refuse is a restore that fails here too --
 * writing the row underneath would hide exactly the kind of hold this system
 * exists to enforce.
 */
const restore = async (userId: string): Promise<boolean> => {
  const { setPreference } = await import("@/lib/emailPreferences");
  const result = await setPreference({
    userId,
    purpose: PROBE_PURPOSE,
    enabled: true,
    capturedVia: "admin",
    source: "admin",
  });
  if (result.changed) return true;
  const preference = await prisma.emailPreference.findUnique({
    where: { userId_purpose: { userId, purpose: PROBE_PURPOSE } },
    select: { enabled: true },
  });
  return preference !== null && preference.enabled;
};
