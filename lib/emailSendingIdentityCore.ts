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

export type SendingIdentityProblem = {
  severity: "error" | "warning";
  stream: SendingStream | "both";
  code:
    | "TRANSACTIONAL_FROM_UNPARSEABLE"
    | "MARKETING_FROM_UNPARSEABLE"
    | "STREAMS_SHARE_A_DOMAIN"
    | "TRANSACTIONAL_ON_ROOT_DOMAIN";
  message: string;
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
