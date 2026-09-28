/**
 * Invariant 10: the end-to-end synthetic check, and what it is allowed to touch.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 7.1
 * (invariant 10), section 7.5 (why the keyring canary is *not* this) and
 * section 12 (S10a, before activation).
 *
 * ## What this is for
 *
 * Section 7.5's canary proves one thing: that a stored key still decrypts a
 * token minted under it. It deliberately calls nothing -- no endpoint, no rate
 * limit, no preference write -- so it cannot tell you that an unsubscribe
 * actually works. Invariant 10 is the one that goes all the way through, and
 * this file holds the four things section 12 asks S10a to settle before the
 * product is switched on: which account, which path, which answers, and what
 * must not have changed.
 *
 * ## The part that is dangerous
 *
 * Every other readiness check in this system reads. This one **writes**: it
 * turns a purpose off, which writes an `EmailPreference`, an
 * `EmailPreferenceTransition` and a suppression cause, and then turns it back on. Run
 * against the wrong subject it would unsubscribe a customer, and the customer's
 * only evidence would be mail that stopped arriving.
 *
 * So the refusals below are the substance of this module, not its preamble.
 * Every one of them is checked before the probe touches anything, and each is
 * its own reason rather than a boolean: an operator who is told "the probe
 * refused" and not which of the seven it was cannot fix it, and will disable
 * the check instead.
 *
 * ## "No customer data changed" is a claim about this request
 *
 * It is tempting to prove it by counting rows before and after, or by reading
 * every row written during the window. Neither proof exists on a running
 * system: a real recipient unsubscribing while the probe runs moves the same
 * counters and lands in the same window, so such a check either fails on honest
 * traffic -- and is disabled within a week -- or passes only on quiet nights.
 *
 * So the claim this file makes is narrower, and it says so rather than implying
 * more: **the probe subject's rows are exactly the ones the path should have
 * written, and each of them really is the probe subject's.** The rows are read
 * scoped to that subject and to the run's window;
 * `writeScopeProblems()` checks the second half and `writeShapeProblems()`
 * the first. What makes that enough is the address: an RFC 2606 reserved name
 * no registrar will ever delegate, so "the probe subject is not a customer" is
 * a fact about the name rather than a promise about the seed.
 *
 * What this does **not** claim is that nothing else changed anywhere while it
 * ran. Nothing could claim that, and a check that appeared to would be read as
 * evidence it is not.
 */

/** The address the probe uses, read from the environment. */
export const SYNTHETIC_PROBE_ADDRESS_ENV = "EMAIL_SYNTHETIC_PROBE_ADDRESS";

/** The switch that lets the probe write at all. */
export const SYNTHETIC_PROBE_ENABLED_ENV = "EMAIL_SYNTHETIC_PROBE_ENABLED";

/**
 * The domains an address may end in to be a probe address.
 *
 * RFC 2606 and RFC 6761 reserve these: no registrar delegates them, so no
 * person can hold a mailbox under one. That is what makes "this address is not
 * a customer's" a fact about the name rather than a promise about the seed.
 *
 * `example.com`, `example.net` and `example.org` are reserved second-level
 * names rather than suffixes, so they are matched whole.
 */
export const RESERVED_PROBE_SUFFIXES = [".invalid", ".test", ".example"] as const;
export const RESERVED_PROBE_DOMAINS = [
  "example.com",
  "example.net",
  "example.org",
] as const;

/**
 * Why a probe run was refused.
 *
 * A closed list, because the operator-facing report names one of these and an
 * unnamed refusal would be a check that failed for a reason nobody can act on.
 */
export const PROBE_REFUSALS = [
  /** `EMAIL_SYNTHETIC_PROBE_ENABLED` is not exactly `"true"`. */
  "probe_disabled",
  /** `EMAIL_SYNTHETIC_PROBE_ADDRESS` is unset or empty. */
  "no_probe_address",
  /** The configured address is not under a reserved name. */
  "address_not_reserved",
  /** No account holds that address. */
  "probe_account_missing",
  /** The account holding it has activity a synthetic account cannot have. */
  "probe_account_not_synthetic",
  /** Unsubscribe is not configured, so the path under test does not exist. */
  "unsubscribe_not_configured",
  /** The probe purpose could not be switched on before the run. */
  "probe_preference_unavailable",
  /** The application URL the probe would call is unset. */
  "no_probe_target",
] as const;

export type ProbeRefusal = (typeof PROBE_REFUSALS)[number];

/** A refusal and the one sentence an operator needs to fix it. */
export const PROBE_REFUSAL_REMEDY: Record<ProbeRefusal, string> = {
  probe_disabled: `Set ${SYNTHETIC_PROBE_ENABLED_ENV}=true in the environment this check runs against. It is off by default because this check writes.`,
  no_probe_address: `Set ${SYNTHETIC_PROBE_ADDRESS_ENV} to the probe account's address.`,
  address_not_reserved: `The probe address must end in one of ${RESERVED_PROBE_SUFFIXES.join(", ")} or be at ${RESERVED_PROBE_DOMAINS.join(", ")}. A deliverable address could be a person's.`,
  probe_account_missing:
    "Create the probe account with that address, with no credits, no conversations and no subscription.",
  probe_account_not_synthetic:
    "The account holding the probe address has activity a synthetic account cannot have. Use a fresh account rather than clearing this one -- an account that was ever a customer's has history this check would write over.",
  unsubscribe_not_configured:
    "Set EMAIL_UNSUBSCRIBE_KEYS. Without it the endpoint answers 503 and the path under test does not exist.",
  no_probe_target: "Set PUBLIC_APP_URL to the deployment this check should call.",
  probe_preference_unavailable:
    "The probe account's service_status preference could not be switched on. Look for a suppression on the probe address that a preference change may not lift -- a hard bounce or a complaint -- and use a fresh probe account rather than clearing it.",
};

const lower = (value: string) => value.trim().toLowerCase();

/** Whether an address is under a name no registrar will delegate. */
export const isReservedProbeAddress = (address: string): boolean => {
  const at = lower(address).lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return false;
  const domain = lower(address).slice(at + 1);
  if (RESERVED_PROBE_DOMAINS.includes(domain as (typeof RESERVED_PROBE_DOMAINS)[number])) {
    return true;
  }
  return RESERVED_PROBE_SUFFIXES.some((suffix) => domain.endsWith(suffix));
};

/** What makes an account too real to be the probe's. */
export type ProbeAccountFacts = {
  /** Any credit lot, spent or not. */
  creditLots: number;
  /** Any conversation, including deleted ones. */
  conversations: number;
  /** Any Stripe customer or subscription id on the account. */
  hasBillingIdentity: boolean;
  /** Any purchase or ledger entry. */
  purchases: number;
};

/**
 * Why this account cannot be the probe's, in the operator's words.
 *
 * Every one of these is something a customer's account has and a synthetic one
 * does not. None of them is "the account is marked synthetic": a flag on a row
 * is set by whoever last edited the row, and the thing being guarded against is
 * exactly an edit that points the probe at somebody.
 */
export const probeAccountProblems = (facts: ProbeAccountFacts): string[] => {
  const problems: string[] = [];
  if (facts.creditLots > 0) problems.push(`it holds ${facts.creditLots} credit lot(s)`);
  if (facts.conversations > 0) {
    problems.push(`it has ${facts.conversations} conversation(s)`);
  }
  if (facts.hasBillingIdentity) problems.push("it has a billing identity");
  if (facts.purchases > 0) problems.push(`it has ${facts.purchases} purchase(s)`);
  return problems;
};

/** One step of the path, and the answer it must give. */
export type ProbeStep = {
  key: string;
  /** What this step proves, for the report. */
  proves: string;
  expectedStatus: number;
  /** The JSON body fields that must be present, and their values. */
  expectedBody: Record<string, unknown>;
};

/**
 * The path, in order, and what each answer means.
 *
 * Four steps rather than one, because the interesting failures are not "the
 * endpoint is down". They are: a token that decrypts but names nothing, a
 * refusal that returns 200, a rate limit that charges a valid unsubscribe, and
 * a write that answers `ok` without writing. Each step below fails a different
 * one of those.
 */
export const PROBE_STEPS: readonly ProbeStep[] = [
  {
    key: "no_token",
    proves:
      "A request with no token is refused, and refused the same way a forged one is -- distinguishing them would make the endpoint an oracle for which tokens are real.",
    expectedStatus: 400,
    expectedBody: { error: "Invalid link." },
  },
  {
    key: "forged_token",
    proves:
      "A token this deployment's keyring cannot open is refused with the same body and status as an absent one.",
    expectedStatus: 400,
    expectedBody: { error: "Invalid link." },
  },
  {
    key: "valid_token",
    proves:
      "A real token turns the named purpose off and says so. This is the step the whole invariant is about: everything above proves the endpoint refuses, and only this one proves it works.",
    expectedStatus: 200,
    expectedBody: { ok: true, scope: "purpose" },
  },
  {
    key: "replayed_token",
    proves:
      "Clicking twice is a success, not an error. A recipient who already unsubscribed and is shown a failure goes looking for a problem that does not exist, and the next thing they reach for is the spam button.",
    expectedStatus: 200,
    expectedBody: { ok: true, scope: "purpose" },
  },
];

/** What one step actually answered. */
export type ProbeObservation = {
  key: string;
  status: number;
  body: unknown;
};

/**
 * What the observed answers got wrong, in the order the steps run.
 *
 * Subset comparison on the body, not equality: the endpoint may add a field
 * without this check having to be edited, and a field it stopped sending is
 * caught either way. The status is exact.
 */
export const stepProblems = (observed: readonly ProbeObservation[]): string[] => {
  const problems: string[] = [];
  const byKey = new Map(observed.map((entry) => [entry.key, entry]));

  for (const step of PROBE_STEPS) {
    const answer = byKey.get(step.key);
    if (!answer) {
      problems.push(`${step.key}: the step did not run`);
      continue;
    }
    if (answer.status !== step.expectedStatus) {
      problems.push(
        `${step.key}: answered ${answer.status}, expected ${step.expectedStatus}`
      );
    }
    const body = answer.body;
    if (typeof body !== "object" || body === null) {
      problems.push(`${step.key}: the body was not an object`);
      continue;
    }
    for (const [field, value] of Object.entries(step.expectedBody)) {
      const actual = (body as Record<string, unknown>)[field];
      if (actual !== value) {
        problems.push(
          `${step.key}: ${field} was ${JSON.stringify(actual)}, expected ${JSON.stringify(value)}`
        );
      }
    }
  }

  for (const answer of observed) {
    if (!PROBE_STEPS.some((step) => step.key === answer.key)) {
      problems.push(`${answer.key}: an answer for a step that is not in the path`);
    }
  }
  return problems;
};

/** A row the probe's request wrote, as the scope check reads it. */
export type WrittenRow = {
  table: string;
  id: string;
  /** The account the row belongs to, or null where the row has no account. */
  userId: string | null;
  /** The address the row belongs to, normalized, or null. */
  emailAddress: string | null;
};

/**
 * Rows this request wrote that do not belong to the probe subject.
 *
 * The whole of the "no customer data changed" condition, and deliberately not a
 * before-and-after count: on a running system a real recipient unsubscribing
 * during the window moves the same counters, so a count either fails on honest
 * traffic or passes on quiet nights. This is about the rows this request
 * produced, identified by the ids the write path returned.
 *
 * A row with neither an account nor an address is a problem rather than a pass:
 * the probe is supposed to know what it wrote, and a row it cannot attribute is
 * one it cannot say is its own.
 */
export const writeScopeProblems = (
  rows: readonly WrittenRow[],
  subject: { userId: string; emailAddress: string }
): string[] => {
  const address = lower(subject.emailAddress);
  const problems: string[] = [];
  for (const row of rows) {
    if (row.userId === null && row.emailAddress === null) {
      problems.push(`${row.table}:${row.id} belongs to no account and no address`);
      continue;
    }
    if (row.userId !== null && row.userId !== subject.userId) {
      problems.push(`${row.table}:${row.id} belongs to account ${row.userId}`);
      continue;
    }
    if (row.emailAddress !== null && lower(row.emailAddress) !== address) {
      problems.push(`${row.table}:${row.id} belongs to a different address`);
    }
  }
  return problems;
};

/**
 * How many rows of each table one probe run should have produced.
 *
 * The four steps unsubscribe once and then replay the same token, so the second
 * call must write nothing: `already_set` is a success that changes no state. An
 * extra transition, consent record or suppression cause means the replay wrote
 * again, which on a real recipient means a second withdrawal row for one click
 * and a consent history that says they refused twice.
 *
 * This is the half of the condition that can fail. `writeScopeProblems()` runs
 * over rows the caller already scoped to the subject, so on its own it is a
 * predicate that is never true -- and this codebase has been caught before by a
 * predicate that looks exactly like one nobody has broken.
 */
export const EXPECTED_WRITES: Readonly<Record<string, number>> = {
  EmailPreference: 1,
  EmailPreferenceTransition: 1,
  // `service_status` records no consent, so a consent row here is a surprise.
  ConsentRecord: 0,
  SuppressionCause: 1,
};

/** Where the rows written differ from what one unsubscribe should produce. */
export const writeShapeProblems = (rows: readonly WrittenRow[]): string[] => {
  const counted = new Map<string, number>();
  for (const row of rows) counted.set(row.table, (counted.get(row.table) ?? 0) + 1);

  const problems: string[] = [];
  for (const [table, expected] of Object.entries(EXPECTED_WRITES)) {
    const actual = counted.get(table) ?? 0;
    if (actual !== expected) {
      problems.push(`${table}: ${actual} row(s), expected ${expected}`);
    }
  }
  for (const table of counted.keys()) {
    if (!(table in EXPECTED_WRITES)) {
      problems.push(`${table}: written by the path and not named by this check`);
    }
  }
  return problems;
};

/** The verdict one probe run produces. */
export type ProbeVerdict =
  | { ran: false; refusal: ProbeRefusal; remedy: string }
  | { ran: true; passed: boolean; problems: string[] };

/** A run that got as far as calling the path, judged on both conditions. */
export const probeVerdict = (input: {
  observed: readonly ProbeObservation[];
  written: readonly WrittenRow[];
  subject: { userId: string; emailAddress: string };
  /** Whether the preference this probe turned off is actually off now. */
  preferenceDisabled: boolean;
}): ProbeVerdict => {
  const problems = [
    ...stepProblems(input.observed),
    ...writeScopeProblems(input.written, input.subject),
    ...writeShapeProblems(input.written),
  ];
  // Asked separately from the endpoint's own answer, which is the point: a
  // handler that returns `ok` without writing is the failure this step exists
  // to find, and it cannot be found by reading the handler's own report of
  // itself.
  if (!input.preferenceDisabled) {
    problems.push(
      "the endpoint answered ok and the preference is still enabled"
    );
  }
  return { ran: true, passed: problems.length === 0, problems };
};
