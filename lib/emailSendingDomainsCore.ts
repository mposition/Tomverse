/**
 * Whether the domains we send from are actually set up to be sent from.
 *
 * Contract: docs/policy/email-notifications.md §14.1, §14.2, §17.3.
 *
 * Pure. The provider call lives in lib/emailSendingDomains.ts.
 *
 * ## The gap this exists to make visible
 *
 * The provider verifies DKIM and SPF, because those are the records it issues.
 * It does not issue a DMARC record and does not report on one, so a domain can
 * read "verified" in the provider's dashboard with no DMARC policy at all --
 * which is the single record §14.1 asks us to add first and the one the bulk
 * sender requirements are actually about. A report that only repeated the
 * provider's status would say everything is fine about the thing nobody
 * configured.
 *
 * So DMARC is reported as *unknown from here*, always, with the zone to check.
 * Claiming to know would be worse than saying nothing: it is a DNS fact this
 * process cannot see, and a green tick nobody verified is how a domain ends up
 * with `p=none` forever.
 */

export type ProviderDomainRecord = {
  /** "DKIM" or "SPF" as the provider labels it. */
  record: string | null;
  /** "TXT" or "MX". */
  type: string | null;
  name: string | null;
  status: string | null;
};

export type ProviderDomain = {
  id: string;
  name: string;
  status: string;
  region: string | null;
  records: ProviderDomainRecord[];
};

export type DomainFinding = {
  severity: "error" | "warning" | "info";
  code:
    | "DOMAIN_NOT_REGISTERED"
    | "DOMAIN_NOT_VERIFIED"
    | "RECORD_NOT_VERIFIED"
    | "SENDING_FROM_ROOT_DOMAIN"
    | "DMARC_NOT_VISIBLE_HERE"
    | "STREAMS_SHARE_A_DOMAIN"
    | "MARKETING_DOMAIN_ABSENT";
  stream: "transactional" | "marketing";
  domain: string | null;
  message: string;
};

export type DomainReportInput = {
  transactionalDomain: string | null;
  marketingDomain: string | null;
  providerDomains: readonly ProviderDomain[];
};

const findDomain = (domains: readonly ProviderDomain[], name: string | null) =>
  name
    ? domains.find((domain) => domain.name.toLowerCase() === name.toLowerCase()) ?? null
    : null;

const isRootDomain = (domain: string) => domain.split(".").length <= 2;

const streamFindings = (
  stream: "transactional" | "marketing",
  domain: string | null,
  providerDomains: readonly ProviderDomain[]
): DomainFinding[] => {
  const findings: DomainFinding[] = [];
  if (!domain) {
    if (stream === "marketing") {
      findings.push({
        severity: "info",
        code: "MARKETING_DOMAIN_ABSENT",
        stream,
        domain: null,
        message:
          "No marketing sending domain is configured. Marketing is production-disabled until the suppression-boundary decision (A18), and the send path refuses rather than falling back to the transactional domain.",
      });
    }
    return findings;
  }

  const registered = findDomain(providerDomains, domain);
  if (!registered) {
    findings.push({
      severity: "error",
      code: "DOMAIN_NOT_REGISTERED",
      stream,
      domain,
      message: `${domain} is configured as the ${stream} sender but is not registered with the provider, so every send from it is refused.`,
    });
    return findings;
  }

  if (registered.status !== "verified") {
    findings.push({
      severity: "error",
      code: "DOMAIN_NOT_VERIFIED",
      stream,
      domain,
      message: `${domain} is registered but its status is "${registered.status}". Sends are refused until its DNS records verify.`,
    });
  }

  for (const record of registered.records) {
    if (record.status && record.status !== "verified") {
      findings.push({
        severity: "error",
        code: "RECORD_NOT_VERIFIED",
        stream,
        domain,
        message: `${domain}: the ${record.record ?? "unnamed"} ${record.type ?? ""} record at "${record.name ?? "?"}" is "${record.status}".`.replace(
          /\s+/g,
          " "
        ),
      });
    }
  }

  if (isRootDomain(domain)) {
    findings.push({
      severity: "warning",
      code: "SENDING_FROM_ROOT_DOMAIN",
      stream,
      domain,
      message: `${domain} is the registrable domain, not a sending subdomain. §14.1 gives each stream its own subdomain so reputation and the DMARC policy are separable; while both streams would sit on one registrable domain, an "sp=" policy cannot tell them apart.`,
    });
  }

  // Always. See the module comment: this is a DNS fact the process cannot see,
  // and the provider's own record set does not include it.
  findings.push({
    severity: "info",
    code: "DMARC_NOT_VISIBLE_HERE",
    stream,
    domain,
    message: `DMARC for ${domain} is not part of the provider's record set and is not checked here. Verify _dmarc.${domain} in the DNS zone, and the "sp=" policy on ${domain.split(".").slice(-2).join(".")}.`,
  });

  return findings;
};

export const domainReportFindings = (input: DomainReportInput): DomainFinding[] => {
  const findings = [
    ...streamFindings("transactional", input.transactionalDomain, input.providerDomains),
    ...streamFindings("marketing", input.marketingDomain, input.providerDomains),
  ];

  if (
    input.transactionalDomain &&
    input.marketingDomain &&
    input.transactionalDomain.toLowerCase() === input.marketingDomain.toLowerCase()
  ) {
    findings.unshift({
      severity: "error",
      code: "STREAMS_SHARE_A_DOMAIN",
      stream: "marketing",
      domain: input.marketingDomain,
      message:
        "Both streams are configured on one domain, which gives up the only layer that separates them (§5.3).",
    });
  }

  return findings;
};

/**
 * Parse the provider's domain list without trusting its shape.
 *
 * Anything unrecognised becomes null rather than throwing: this feeds a report
 * an operator reads while something is already wrong, and a parser that threw
 * on an unexpected field would turn "one record is pending" into "the report
 * is broken".
 */
export const parseProviderDomains = (payload: unknown): ProviderDomain[] => {
  const data = (payload as { data?: unknown })?.data;
  const rows = Array.isArray(data) ? data : Array.isArray(payload) ? payload : [];
  const asString = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : null;

  return rows.flatMap((row) => {
    const entry = row as Record<string, unknown>;
    const id = asString(entry.id);
    const name = asString(entry.name);
    if (!id || !name) return [];
    const records = Array.isArray(entry.records) ? entry.records : [];
    return [
      {
        id,
        name,
        status: asString(entry.status) ?? "unknown",
        region: asString(entry.region),
        records: records.map((record) => {
          const item = record as Record<string, unknown>;
          return {
            record: asString(item.record),
            type: asString(item.type),
            name: asString(item.name),
            status: asString(item.status),
          };
        }),
      },
    ];
  });
};
