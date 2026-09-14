// What a sending domain's DNS has to say, and what its answers mean.
//
// Pure, so the verdicts can be tested without a resolver. The script owns the
// lookups; everything about *what an answer means* is here.
//
// Contract: docs/policy/email-notifications.md §14.1.
// Runbook: docs/ops/email-sending-domains.md §3.1-3.3, §4.1.

/** The records a Resend sending subdomain carries, by the name they live at. */
export const sendingDnsNames = (domain: string) => ({
  dkim: `resend._domainkey.${domain}`,
  spfTxt: `send.${domain}`,
  spfMx: `send.${domain}`,
  dmarc: `_dmarc.${domain}`,
});

export type DnsAnswers = {
  /** TXT records, each already joined from its character strings. */
  dkim: string[] | null;
  spfTxt: string[] | null;
  spfMx: { exchange: string; priority: number }[] | null;
  dmarc: string[] | null;
};

export type DnsFinding = {
  record: "dkim" | "spf_txt" | "spf_mx" | "dmarc";
  severity: "error" | "warning";
  message: string;
};

/**
 * The SES bounce host the provider issues, with its region.
 *
 * Matched rather than compared to a fixed string because the region is a
 * per-domain choice. It is reported, not judged: region is a question of
 * latency and where data sits, and **not** a suppression boundary -- that is
 * the team (docs/ops/a18-resend-suppression-boundary.md §1.1).
 */
const FEEDBACK_HOST = /^feedback-smtp\.([a-z0-9-]+)\.amazonses\.com\.?$/i;

export const regionFromFeedbackHost = (exchange: string): string | null =>
  FEEDBACK_HOST.exec(exchange.trim())?.[1] ?? null;

/**
 * Everything wrong with one sending domain's DNS.
 *
 * DMARC is a finding of its own rather than folded in with the rest, for the
 * reason `report:email-domains` gives: the provider issues DKIM and SPF and
 * reports on them, and issues no DMARC record at all. A domain the provider
 * calls verified can have no DMARC policy, and that is the record §14.1 asks
 * for first.
 */
export const sendingDnsFindings = (answers: DnsAnswers): DnsFinding[] => {
  const findings: DnsFinding[] = [];

  const dkim = answers.dkim?.find((value) => value.includes("p="));
  if (!dkim) {
    findings.push({
      record: "dkim",
      severity: "error",
      message: answers.dkim
        ? "The DKIM name answers, but no record carries a public key (p=)."
        : "No DKIM record. Mail from this domain cannot be signed.",
    });
  }

  const spf = answers.spfTxt?.find((value) => value.startsWith("v=spf1"));
  if (!spf) {
    findings.push({
      record: "spf_txt",
      severity: "error",
      message: "No SPF record on the Return-Path subdomain.",
    });
  } else if (!spf.includes("include:amazonses.com")) {
    findings.push({
      record: "spf_txt",
      severity: "error",
      message: `SPF does not include amazonses.com, so the provider cannot send as this domain: "${spf}".`,
    });
  }

  const mx = answers.spfMx?.[0];
  if (!mx) {
    findings.push({
      record: "spf_mx",
      severity: "error",
      message:
        "No MX on the Return-Path subdomain, so bounces have nowhere to go and SPF cannot align.",
    });
  } else if (!regionFromFeedbackHost(mx.exchange)) {
    findings.push({
      record: "spf_mx",
      severity: "error",
      message: `The Return-Path MX is ${mx.exchange}, which is not a provider feedback host.`,
    });
  }

  const dmarc = answers.dmarc?.find((value) => value.startsWith("v=DMARC1"));
  if (!dmarc) {
    findings.push({
      record: "dmarc",
      severity: "error",
      // An error rather than a warning: §14.1 asks for it first, and the
      // provider will never tell you it is missing.
      message:
        "No DMARC record. The provider does not issue one and does not report its absence.",
    });
  } else if (!/\brua=/.test(dmarc)) {
    findings.push({
      record: "dmarc",
      severity: "warning",
      message:
        "DMARC has no rua= address, so the aggregate reports the two-week observation needs are never sent.",
    });
  }

  return findings;
};

export type DomainDnsReport = {
  domain: string;
  region: string | null;
  findings: DnsFinding[];
  ready: boolean;
};

export const domainDnsReport = (
  domain: string,
  answers: DnsAnswers
): DomainDnsReport => {
  const findings = sendingDnsFindings(answers);
  return {
    domain,
    region: answers.spfMx?.[0]
      ? regionFromFeedbackHost(answers.spfMx[0].exchange)
      : null,
    findings,
    ready: findings.every((finding) => finding.severity !== "error"),
  };
};
