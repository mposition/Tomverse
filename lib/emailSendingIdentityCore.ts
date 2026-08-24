/**
 * Which domain a message is sent from, and why it has to be that one.
 *
 * Contract: docs/policy/email-notifications.md §5.3, §14.1, §17.3.
 *
 * Pure. The environment reads live in lib/emailSendingIdentity.ts.
 *
 * ## What separating the domains actually buys
 *
 * §5.3 is careful about this, and the care is the point: splitting
 * `mail.tomverse.app` from `news.tomverse.app` separates **domain reputation**
 * and the DMARC policy, and separates nothing else. The sending IP is shared,
 * the provider account status is shared, and the provider's suppression list is
 * shared across every domain in the region (§5.3.1, confirmed). So this module
 * is not a safety boundary -- it is the one layer that genuinely is separable,
 * and it is worth having precisely because the others are not.
 *
 * ## Why the refusal is at send time and not only in a health check
 *
 * A marketing message sent from the transactional domain does not fail. It
 * arrives, it looks right, and the only thing that happened is that a spam
 * complaint about a promotion now lands on the domain that carries login
 * codes. Nothing downstream ever reports it, and by the time it shows up it
 * shows up as "our login emails stopped arriving". A configuration mistake
 * whose only symptom is a slow loss of the thing you were protecting has to be
 * refused where the send happens.
 */

export type SendingStream = "transactional" | "marketing";

/**
 * The stream a classification belongs to.
 *
 * `service` and `legal` travel with transactional: §14.1 gives marketing its
 * own domain and everything else the transactional one. They are separate
 * *classifications* because they retry differently and because only marketing
 * carries an unsubscribe link -- not because they are separately deliverable.
 */
export const streamForClassification = (classification: string): SendingStream =>
  classification === "marketing" ? "marketing" : "transactional";

export type ParsedFromAddress = {
  /** The display name, or null for a bare address. */
  displayName: string | null;
  address: string;
  /** Lower-cased, no trailing dot. */
  domain: string;
};

/**
 * Parse a `Name <local@domain>` or bare `local@domain` header value.
 *
 * Deliberately strict about the shape rather than about the local part: the
 * value is operator-supplied configuration, and the failure this guards is a
 * typo or an empty variable, not a hostile address. Anything it cannot read is
 * returned as unparseable, which every caller treats as fatal.
 */
export const parseFromAddress = (
  value: string | null | undefined
): ParsedFromAddress | null => {
  const raw = value?.trim();
  if (!raw) return null;

  const angled = /^(.*)<([^<>\s]+)>$/.exec(raw);
  const displayName = angled ? angled[1].trim().replace(/^"|"$/g, "") : null;
  const address = (angled ? angled[2] : raw).trim();

  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;
  const domain = address.slice(at + 1).toLowerCase().replace(/\.$/, "");
  // One dot minimum, no spaces, no consecutive dots: enough to catch an
  // unexpanded template or a hostname with no TLD.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    return null;
  }
  if (/\s/.test(address)) return null;

  return { displayName: displayName || null, address, domain };
};

/** Whether `domain` is `parent` or a subdomain of it. */
export const isWithinDomain = (domain: string, parent: string) =>
  domain === parent || domain.endsWith(`.${parent}`);

/**
 * The registrable parent of a sending subdomain, for the DMARC note.
 *
 * A crude two-label reading, and it does not need to be better: it is used to
 * say "also put a DMARC record on this" in a report an operator reads, never to
 * decide anything. A public-suffix list would be the right tool if it were
 * deciding.
 */
export const rootDomainOf = (domain: string) =>
  domain.split(".").slice(-2).join(".");

/**
 * The historical transactional sender, used when nothing is configured.
 *
 * It is the registrable domain rather than a sending subdomain -- the state
 * §17.3 step 1 moves away from -- and it stays that way on purpose. Moving it
 * is a DNS change plus a notice to people whose filters name the current
 * address, not something a deploy may do by editing a default. The health
 * check reports the gap instead.
 */
export const TRANSACTIONAL_FROM_FALLBACK = "Tomverse Review <hello@tomverse.app>";

/**
 * The variables each stream reads, most specific first.
 *
 * Written down once. Three senders used to each carry their own variable and
 * their own literal fallback, which is how the 2026-08-21 cutover moved one of
 * four sending identities and left the other three on the old domain without
 * anything noticing (docs/ops/email-sending-domains.md §1.2).
 */
export const SENDING_IDENTITY_ENV_KEYS = {
  transactional: ["TRANSACTIONAL_EMAIL_FROM", "EMAIL_FROM"],
  marketing: ["MARKETING_EMAIL_FROM"],
} as const satisfies Record<SendingStream, readonly string[]>;

/** Any environment-shaped object. Deliberately not `process.env`: this is pure. */
export type SendingIdentityEnv = Readonly<Record<string, string | undefined>>;

const firstConfigured = (env: SendingIdentityEnv, keys: readonly string[]) => {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return null;
};

/** What the health check reasons over, read from an environment. */
export const sendingIdentityInputFrom = (
  env: SendingIdentityEnv
): SendingIdentityInput => ({
  transactionalFrom:
    firstConfigured(env, SENDING_IDENTITY_ENV_KEYS.transactional) ??
    TRANSACTIONAL_FROM_FALLBACK,
  marketingFrom: firstConfigured(env, SENDING_IDENTITY_ENV_KEYS.marketing),
  nodeEnv: env.NODE_ENV,
});

export type SendingIdentityRefusalCode =
  | "TRANSACTIONAL_FROM_UNPARSEABLE"
  | "MARKETING_FROM_UNPARSEABLE"
  | "MARKETING_FROM_MISSING"
  | "STREAMS_SHARE_A_DOMAIN";

export type ResolvedSendingIdentity =
  | { ok: true; from: string; address: string; domain: string }
  | { ok: false; code: SendingIdentityRefusalCode; message: string };

/**
 * The From header for a stream, or a refusal, from a given environment.
 *
 * Returns rather than throws, because two of its three callers are alerting
 * paths: a delivery channel that threw would take the other channels with it,
 * and the one thing an alert must not do is fail silently because the alert
 * about the failure also failed. `fromAddressForStream` in
 * lib/emailSendingIdentity.ts wraps this and throws, for callers that want it.
 *
 * Pure and environment-agnostic so the GitHub Actions security report can
 * share it: that script runs outside Next.js and cannot import a `server-only`
 * module, and a second copy of this logic is how the identities drifted apart
 * in the first place.
 */
export const resolveSendingIdentity = (
  stream: SendingStream,
  env: SendingIdentityEnv
): ResolvedSendingIdentity => {
  const input = sendingIdentityInputFrom(env);
  const transactional = parseFromAddress(input.transactionalFrom);

  if (stream === "transactional") {
    if (!transactional) {
      return {
        ok: false,
        code: "TRANSACTIONAL_FROM_UNPARSEABLE",
        message: `${SENDING_IDENTITY_ENV_KEYS.transactional[0]} is not a readable address.`,
      };
    }
    return {
      ok: true,
      from: input.transactionalFrom!,
      address: transactional.address,
      domain: transactional.domain,
    };
  }

  if (!input.marketingFrom) {
    return {
      ok: false,
      code: "MARKETING_FROM_MISSING",
      message:
        "Marketing mail has no sending identity of its own (MARKETING_EMAIL_FROM). Sending it from the transactional domain is refused rather than defaulted.",
    };
  }
  const marketing = parseFromAddress(input.marketingFrom);
  if (!marketing) {
    return {
      ok: false,
      code: "MARKETING_FROM_UNPARSEABLE",
      message: "MARKETING_EMAIL_FROM is not a readable address.",
    };
  }
  if (transactional && transactional.domain === marketing.domain) {
    return {
      ok: false,
      code: "STREAMS_SHARE_A_DOMAIN",
      message: `Marketing and transactional mail would both send from ${marketing.domain}. Domain reputation is the one layer that separates the two streams (§5.3).`,
    };
  }
  return {
    ok: true,
    from: input.marketingFrom,
    address: marketing.address,
    domain: marketing.domain,
  };
};

/* -------------------------------------------------------------------------- */
/* Sender roles                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Who the recipient sees the message as being from.
 *
 * Contract: docs/policy/email-notifications.md §14.1a.
 *
 * ## Why this is not `SendingStream`
 *
 * A stream is a delivery path: which domain carries the reputation, which
 * provider account holds the suppression list, which regulator's rules apply.
 * §5.3 spells out how little it separates and why that little is worth having.
 *
 * A role is a *person*. It answers "who is writing to me", which is the
 * question a recipient's filter, folder rule and threading all key on, and it
 * has nothing to do with reputation: a login code and a receipt travel the same
 * path, carry the same DKIM key and share the same complaint list, and still
 * must not look like the same sender. Somebody who files everything from
 * `billing@` into a folder they read once a month has to keep getting login
 * codes in their inbox.
 *
 * Folding the two together is how it was written before: one stream, one From,
 * so `Tomverse Review <hello@...>` sent the login code, the refund decision and
 * the operator alert. Making the role a second axis costs one field and means a
 * new sender identity can never accidentally become a new sending domain --
 * every transactional role is checked to be on the transactional domain, and a
 * role that is not allowed on a stream is refused rather than defaulted.
 */
export type SenderRole =
  | "general"
  | "security"
  | "billing"
  | "support"
  | "operations"
  | "marketing";

export type SenderRoleSpec = {
  /** The one stream this role is allowed on. */
  stream: SendingStream;
  /**
   * The mailbox this role sends as, on the stream's authenticated domain.
   *
   * `null` means the role sends as the stream's configured identity verbatim --
   * `general` is `TRANSACTIONAL_EMAIL_FROM` as the operator wrote it, and
   * `marketing` is `MARKETING_EMAIL_FROM`. Those two are the addresses that
   * already exist in DNS and in people's filters, and deriving them instead
   * would silently move them.
   */
  localPart: string | null;
  /** The display name, alongside a derived local part. */
  displayName: string | null;
  /**
   * Whether a human might reasonably reply to this message.
   *
   * Only used to decide whether a Reply-To is attached (see
   * `replyToForSenderRole`). An operator alert is not user-facing: it goes to
   * an address the team already reads, and a Reply-To on it would send a reply
   * about an incident to the support queue.
   */
  userFacing: boolean;
};

/**
 * Every role, its stream, and the mailbox it sends as.
 *
 * The one table. A role added here is available everywhere and nowhere else --
 * a template names a role, never an address, and `check:sending-identity`
 * fails on a source file that writes one.
 */
export const SENDER_ROLE_SPECS = {
  general: {
    stream: "transactional",
    localPart: null,
    displayName: null,
    userFacing: true,
  },
  security: {
    stream: "transactional",
    localPart: "security",
    displayName: "Tomverse Security",
    userFacing: true,
  },
  billing: {
    stream: "transactional",
    localPart: "billing",
    displayName: "Tomverse Billing",
    userFacing: true,
  },
  support: {
    stream: "transactional",
    localPart: "support",
    displayName: "Tomverse Support",
    userFacing: true,
  },
  operations: {
    // `alerts@` rather than `operations@`: it is the mailbox operators already
    // filter on, and the display name is what a person reads anyway.
    stream: "transactional",
    localPart: "alerts",
    displayName: "Tomverse Operations",
    userFacing: false,
  },
  marketing: {
    stream: "marketing",
    localPart: null,
    displayName: null,
    userFacing: false,
  },
} as const satisfies Record<SenderRole, SenderRoleSpec>;

export const SENDER_ROLES = Object.keys(SENDER_ROLE_SPECS) as SenderRole[];

/** The roles each stream may carry. Derived, so the table cannot disagree. */
export const senderRolesForStream = (stream: SendingStream): SenderRole[] =>
  SENDER_ROLES.filter((role) => SENDER_ROLE_SPECS[role].stream === stream);

export const isSenderRole = (value: unknown): value is SenderRole =>
  typeof value === "string" && value in SENDER_ROLE_SPECS;

/** The stream a role belongs to. Every role belongs to exactly one. */
export const streamForSenderRole = (role: SenderRole): SendingStream =>
  SENDER_ROLE_SPECS[role].stream;

/**
 * Whether this role may be sent on this stream.
 *
 * Fail-closed at the send, not just in a health check, and for the same reason
 * the stream separation is: a `marketing` role on the transactional stream
 * arrives, looks right, and puts a promotion's complaints on the domain that
 * carries login codes. Nothing downstream reports it.
 */
export const senderRoleAllowedOnStream = (
  stream: SendingStream,
  role: SenderRole
) => SENDER_ROLE_SPECS[role].stream === stream;

export type SenderIdentityRefusalCode =
  | SendingIdentityRefusalCode
  | "SENDER_ROLE_UNKNOWN"
  | "SENDER_ROLE_NOT_ON_STREAM";

export type ResolvedSenderIdentity =
  | {
      ok: true;
      role: SenderRole;
      stream: SendingStream;
      from: string;
      address: string;
      domain: string;
      localPart: string;
      displayName: string | null;
    }
  | { ok: false; code: SenderIdentityRefusalCode; message: string };

const localPartOf = (address: string) => address.slice(0, address.lastIndexOf("@"));

/**
 * The From header for one (stream, role) pair, or a refusal.
 *
 * Pure, so the GitHub Actions security report reaches the same answer as the
 * deployment without importing a `server-only` module -- the property that a
 * second copy of these rules destroyed once already
 * (docs/ops/email-sending-domains.md §1.2).
 *
 * A derived role's domain is read from the *configured* transactional address
 * rather than from a variable of its own, which is the whole reason no new
 * environment variable appears here: `security@` is on whatever domain
 * `TRANSACTIONAL_EMAIL_FROM` is authenticated for, always, and a cutover that
 * moves one moves all six.
 */
export const resolveSenderIdentity = (
  stream: SendingStream,
  role: SenderRole,
  env: SendingIdentityEnv
): ResolvedSenderIdentity => {
  if (!isSenderRole(role)) {
    return {
      ok: false,
      code: "SENDER_ROLE_UNKNOWN",
      message: `"${String(role)}" is not a sender role. Roles are ${SENDER_ROLES.join(", ")}.`,
    };
  }
  if (!senderRoleAllowedOnStream(stream, role)) {
    return {
      ok: false,
      code: "SENDER_ROLE_NOT_ON_STREAM",
      message:
        `The "${role}" sender belongs to the ${SENDER_ROLE_SPECS[role].stream} stream ` +
        `and was asked for on the ${stream} one. Refused rather than sent from the ` +
        "other stream's domain (docs/policy/email-notifications.md §14.1a).",
    };
  }

  const base = resolveSendingIdentity(stream, env);
  if (!base.ok) return base;

  const spec = SENDER_ROLE_SPECS[role];
  if (spec.localPart === null) {
    return {
      ok: true,
      role,
      stream,
      from: base.from,
      address: base.address,
      domain: base.domain,
      localPart: localPartOf(base.address),
      displayName: parseFromAddress(base.from)?.displayName ?? null,
    };
  }

  const address = `${spec.localPart}@${base.domain}`;
  return {
    ok: true,
    role,
    stream,
    from: spec.displayName ? `${spec.displayName} <${address}>` : address,
    address,
    domain: base.domain,
    localPart: spec.localPart,
    displayName: spec.displayName,
  };
};

/**
 * The address a reply should go to, or null to send no Reply-To at all.
 *
 * From and mailbox are different things: `security@mail.tomverse.app` is an
 * authenticated sending identity, and nothing in this repository says anyone
 * reads it. `EMAIL_BUSINESS_CONTACT_EMAIL` is the opposite -- it is documented
 * as "the address a recipient can contact about this mail"
 * (docs/ops/email-business-identity.md), it is already printed in the footer of
 * every message that carries one, and the support page publishes it as the way
 * to reach us. So a reply is directed there and nowhere else.
 *
 * Unset means no header, which is exactly what was sent before this existed. A
 * mailbox is not invented to fill the field: a Reply-To pointing at an address
 * nobody reads is worse than none, because the reply is accepted and then lost.
 *
 * Operator alerts and marketing get none. An alert already lands in a mailbox
 * the team reads, and routing a reply about an incident into the support queue
 * helps nobody; marketing's reply path is a §11 decision, not this one.
 */
export const replyToForSenderRole = (
  role: SenderRole,
  env: SendingIdentityEnv
): string | null => {
  if (!isSenderRole(role) || !SENDER_ROLE_SPECS[role].userFacing) return null;
  const configured = env.EMAIL_BUSINESS_CONTACT_EMAIL?.trim();
  if (!configured) return null;
  return parseFromAddress(configured) ? configured : null;
};

/**
 * A sender written as a literal, found in source text.
 *
 * Pure so the shapes can be pinned by a test. The rule that matters is *which*
 * shapes, and the obvious one is wrong: a literal directly after `from:` would
 * have passed on the tree that had the bug, because all four senders wrote
 * `from: process.env.SOMETHING || "Name <addr@domain>"` and the literal sat
 * behind a fallback rather than beside the key.
 *
 * So it matches on the value:
 *
 *   A. `"Display Name <local@domain>"` -- the RFC 5322 From form. A string
 *      shaped like that is a sender or it is nothing.
 *   B. a bare address on one of our own domains, on a line that also says
 *      `from` -- how the SendGrid branch carried its second copy.
 *
 * B is scoped to a `from` line deliberately. Unscoped it flags every address on
 * our domain, and most are not senders: the support address the marketing pages
 * print, the `qa@` and `demo@` identities fixtures sign in as. Failing on those
 * teaches people to add exceptions instead of reading findings.
 */
const DISPLAY_NAME_FROM = /["'`][^"'`]*<[^"'`@\s]+@[^"'`>\s]+>["'`]/g;
const OWN_DOMAIN_ADDRESS = /["'`][A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)*tomverse\.app["'`]/;

export type HardCodedSender = { line: number; literal: string };

export const hardCodedSenders = (source: string): HardCodedSender[] => {
  const found: HardCodedSender[] = [];
  const lines = source.split("\n");

  lines.forEach((line, index) => {
    for (const match of line.matchAll(DISPLAY_NAME_FROM)) {
      found.push({ line: index + 1, literal: match[0] });
    }
    if (/\bfrom\b/.test(line)) {
      const match = OWN_DOMAIN_ADDRESS.exec(line);
      // Only when it is not already reported as a display-name form above.
      if (match && !found.some((entry) => entry.line === index + 1)) {
        found.push({ line: index + 1, literal: match[0] });
      }
    }
  });

  return found;
};

/**
 * An address literal on one of our *sending* subdomains, found in source text.
 *
 * A second static rule beside `hardCodedSenders`, and it exists because roles
 * gave the tree five more addresses to hard-code. `hardCodedSenders` matches on
 * the RFC 5322 display-name shape or on a `from` line; a role bypass need be
 * neither -- `const ALERTS = "alerts@mail.tomverse.app"` is enough to route
 * around the resolver, and it looks like an ordinary constant.
 *
 * The rule that separates a sender from every other address in the tree is the
 * *domain*: `tomverse.app` is where the support address, the fixtures and the
 * marketing copy live, while `mail.tomverse.app` and `news.tomverse.app` exist
 * only to send. So an address on a subdomain of `tomverse.app` is a sender, and
 * the resolver is the only thing allowed to produce one.
 *
 * Deliberately not scoped to a `from` line, and deliberately not matching the
 * registrable domain: the first would miss the constant, and the second would
 * flag `support@tomverse.app` in seven locales of legal copy.
 */
const SENDING_SUBDOMAIN_ADDRESS =
  /["'`][A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.tomverse\.app["'`]/g;

export const sendingSubdomainAddresses = (source: string): HardCodedSender[] => {
  const found: HardCodedSender[] = [];
  source.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(SENDING_SUBDOMAIN_ADDRESS)) {
      found.push({ line: index + 1, literal: match[0] });
    }
  });
  return found;
};

/**
 * The functions that actually put a message on the wire.
 *
 * Every one of them takes a `senderRole`, and TypeScript already fails a call
 * that omits it. This list exists for the two places TypeScript does not reach:
 * the `.mjs` scripts, and a future call written with an object spread that
 * happens to type-check while naming no role at all.
 */
export const SEND_ENTRY_POINTS = [
  "deliverEmailOnce",
  "sendTransactionalEmail",
] as const;

/**
 * Send calls in `source` that name no sender role.
 *
 * Scans the balanced argument list of each call rather than a line or a fixed
 * window, because these calls are multi-line object literals and a nested
 * template string or object would end a naive scan early.
 *
 * Returns the line of each offending call. Declarations are skipped -- the
 * `export async function` that defines one of these is not a call -- and so is
 * a caller that spreads an already-typed input, because there the role is
 * present and TypeScript is what proves it.
 */
export const sendCallsMissingSenderRole = (
  source: string
): Array<{ line: number; call: string }> => {
  const found: Array<{ line: number; call: string }> = [];
  for (const name of SEND_ENTRY_POINTS) {
    const opener = new RegExp(`\\b${name}\\s*\\(`, "g");
    for (const match of source.matchAll(opener)) {
      // The declaration of one of these is not a call to it.
      if (/\b(?:function|const|let|var)\s+$/.test(source.slice(0, match.index))) {
        continue;
      }
      const start = match.index + match[0].length;
      let depth = 1;
      let index = start;
      while (index < source.length && depth > 0) {
        const character = source[index];
        if (character === "(") depth += 1;
        else if (character === ")") depth -= 1;
        index += 1;
      }
      // Unbalanced: the file does not parse, and that is not this check's job.
      if (depth !== 0) continue;
      const args = source.slice(start, index - 1);
      if (/\bsenderRole\b/.test(args)) continue;
      found.push({
        line: source.slice(0, match.index).split("\n").length,
        call: name,
      });
    }
  }
  return found.sort((a, b) => a.line - b.line);
};

export type SendingIdentityProblem = {
  severity: "error" | "warning";
  stream: SendingStream | "both";
  code:
    | "TRANSACTIONAL_FROM_UNPARSEABLE"
    | "MARKETING_FROM_UNPARSEABLE"
    | "STREAMS_SHARE_A_DOMAIN"
    | "TRANSACTIONAL_ON_ROOT_DOMAIN"
    | "SENDER_ROLE_UNRESOLVABLE"
    | "SENDER_ROLE_OFF_DOMAIN"
    | "SENDER_ROLE_LOCAL_PART_UNEXPECTED"
    | "SENDER_ROLE_ACCEPTED_ON_WRONG_STREAM";
  message: string;
  /** Set when the finding is about one role rather than a whole stream. */
  role?: SenderRole;
};

export type SendingIdentityInput = {
  transactionalFrom: string | null | undefined;
  /**
   * Absent on every deployment today, and that is not a problem to report:
   * marketing is production-disabled until the suppression-boundary decision
   * (A18), and `fromAddressForStream("marketing")` refuses to send without it.
   * A health check that warned about it on every deployment would be a warning
   * nobody reads by the time it means something.
   */
  marketingFrom: string | null | undefined;
  /** `process.env.NODE_ENV`. Only the root-domain notice depends on it. */
  nodeEnv?: string | null;
};

/**
 * Everything wrong with the configured sending identities.
 *
 * Errors and warnings are separated the way `getProviderBudgetReadiness` does
 * it, and for the same reason: an error is a state that must refuse traffic,
 * and a warning is a migration somebody has not finished. Conflating them
 * either takes production down for a planned move or hides a real fault behind
 * a list nobody reads.
 */
export const sendingIdentityProblems = (
  input: SendingIdentityInput
): SendingIdentityProblem[] => {
  const problems: SendingIdentityProblem[] = [];
  const transactional = parseFromAddress(input.transactionalFrom);
  const marketing = parseFromAddress(input.marketingFrom);

  if (!transactional) {
    problems.push({
      severity: "error",
      stream: "transactional",
      code: "TRANSACTIONAL_FROM_UNPARSEABLE",
      message:
        "TRANSACTIONAL_EMAIL_FROM is missing or is not a readable address. Every login code and receipt is sent from it.",
    });
  }

  if (input.marketingFrom?.trim() && !marketing) {
    problems.push({
      severity: "error",
      stream: "marketing",
      code: "MARKETING_FROM_UNPARSEABLE",
      message:
        "MARKETING_EMAIL_FROM is set and is not a readable address, so marketing would refuse every send while looking configured.",
    });
  }

  if (transactional && marketing && transactional.domain === marketing.domain) {
    // An error whether or not marketing is enabled: a configuration that would
    // send both from one domain is wrong before it is used, and the moment it
    // is used is the moment the separation was needed.
    problems.push({
      severity: "error",
      stream: "both",
      code: "STREAMS_SHARE_A_DOMAIN",
      message: `Both streams send from ${transactional.domain}. Domain reputation is the one layer that separates (§5.3), and this configuration gives that up.`,
    });
  }

  if (
    transactional &&
    input.nodeEnv === "production" &&
    transactional.domain === rootDomainOf(transactional.domain)
  ) {
    // §17.3 step 3, and the state this repository is actually in: the
    // transactional stream still sends from the registrable domain. A warning
    // rather than an error, because turning it into one would refuse readiness
    // on the deployment that exists today -- taking production down to
    // announce a planned migration.
    problems.push({
      severity: "warning",
      stream: "transactional",
      code: "TRANSACTIONAL_ON_ROOT_DOMAIN",
      message: `Transactional mail sends from the registrable domain ${transactional.domain}. §14.1 moves it to a sending subdomain so its reputation and DMARC policy are its own; until then a marketing domain cannot be separated from it by a subdomain policy.`,
    });
  }

  problems.push(...senderRoleProblems(input));

  return problems;
};

/**
 * Everything wrong with the *role* addresses this configuration would produce.
 *
 * Separate from `sendingIdentityProblems` above only in how it is written --
 * that function calls this one, so `/api/ready` gains these findings without a
 * second wiring. What it checks is what a role can get wrong that a stream
 * cannot:
 *
 *   - a role that does not resolve to an address at all;
 *   - a transactional role that resolved onto a domain other than the one
 *     `TRANSACTIONAL_EMAIL_FROM` authenticates, which would send unsigned mail
 *     from a domain we do not control the DKIM key for;
 *   - a local part that is not the one the role's spec names, which means the
 *     table and the resolver have drifted;
 *   - a role accepted on a stream it does not belong to, i.e. the fail-closed
 *     combination check has stopped failing closed.
 *
 * The last two cannot happen while the resolver is the only way to get an
 * address, which is exactly why they are worth asserting on a running
 * deployment: they are the shape of "somebody added a shortcut".
 */
export const senderRoleProblems = (
  input: SendingIdentityInput
): SendingIdentityProblem[] => {
  const problems: SendingIdentityProblem[] = [];
  const env: SendingIdentityEnv = {
    ...(input.transactionalFrom
      ? { TRANSACTIONAL_EMAIL_FROM: input.transactionalFrom }
      : {}),
    ...(input.marketingFrom ? { MARKETING_EMAIL_FROM: input.marketingFrom } : {}),
  };
  const transactionalDomain = parseFromAddress(input.transactionalFrom)?.domain ?? null;

  for (const role of senderRolesForStream("transactional")) {
    const resolved = resolveSenderIdentity("transactional", role, env);
    if (!resolved.ok) {
      // A transactional From that does not parse is already reported once by
      // `sendingIdentityProblems`; repeating it per role would turn one fault
      // into five lines and bury the rest.
      if (resolved.code === "TRANSACTIONAL_FROM_UNPARSEABLE") continue;
      problems.push({
        severity: "error",
        stream: "transactional",
        code: "SENDER_ROLE_UNRESOLVABLE",
        role,
        message: `The "${role}" sender does not resolve: ${resolved.message}`,
      });
      continue;
    }
    if (transactionalDomain && resolved.domain !== transactionalDomain) {
      problems.push({
        severity: "error",
        stream: "transactional",
        code: "SENDER_ROLE_OFF_DOMAIN",
        role,
        message:
          `The "${role}" sender resolved to ${resolved.domain}, not the authenticated ` +
          `transactional domain ${transactionalDomain}. Mail from it would carry no ` +
          "DKIM signature we hold a key for.",
      });
    }
    const expected = SENDER_ROLE_SPECS[role].localPart;
    if (expected !== null && resolved.localPart !== expected) {
      problems.push({
        severity: "error",
        stream: "transactional",
        code: "SENDER_ROLE_LOCAL_PART_UNEXPECTED",
        role,
        message:
          `The "${role}" sender resolved to ${resolved.localPart}@, and its role table ` +
          `says ${expected}@. A recipient's filter keys on the mailbox, so the two ` +
          "cannot differ.",
      });
    }
  }

  // The fail-closed combination rule, asserted rather than assumed. One
  // direction each: a marketing role must not be accepted on the transactional
  // stream, and no transactional role on the marketing one.
  const crossings: Array<[SendingStream, SenderRole]> = [
    ["transactional", "marketing"],
    ...senderRolesForStream("transactional").map(
      (role) => ["marketing", role] as [SendingStream, SenderRole]
    ),
  ];
  for (const [stream, role] of crossings) {
    if (resolveSenderIdentity(stream, role, env).ok) {
      problems.push({
        severity: "error",
        stream,
        code: "SENDER_ROLE_ACCEPTED_ON_WRONG_STREAM",
        role,
        message:
          `The "${role}" sender was accepted on the ${stream} stream. Streams and ` +
          "roles are separate axes and a role belongs to exactly one stream " +
          "(docs/policy/email-notifications.md §14.1a).",
      });
    }
  }

  return problems;
};

export const sendingIdentityReadiness = (input: SendingIdentityInput) => {
  const problems = sendingIdentityProblems(input);
  const errors = problems.filter((problem) => problem.severity === "error");
  return {
    ready: errors.length === 0,
    errors,
    warnings: problems.filter((problem) => problem.severity === "warning"),
  };
};
