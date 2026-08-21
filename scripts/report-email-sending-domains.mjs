// Are the domains we send mail from actually set up to send mail from?
//
//   npm run report:email-domains
//   npm run report:email-domains -- --json
//
// Reads `TRANSACTIONAL_EMAIL_FROM` / `MARKETING_EMAIL_FROM`, asks the provider
// which domains it has and what their DNS records say, and reports the gap.
// Read-only in both directions: it registers nothing, verifies nothing, and
// changes no environment.
//
// Contract: docs/policy/email-notifications.md §14.1, §17.3.
// Runbook: docs/ops/email-sending-domains.md.
//
// ## What it cannot tell you
//
// DMARC. The provider issues the DKIM and SPF records and reports on those;
// it issues no DMARC record and reports on none, so a domain reads "verified"
// with no DMARC policy at all -- which is the record §14.1 asks for first. The
// report says so for every domain rather than staying quiet, because a quiet
// report about a record nobody configured is indistinguishable from a passing
// one.
//
// ## Exit code
//
// Always 0. It is a report, not a gate: whether a domain that is registered
// but unverified is a problem depends on whether somebody is mid-migration,
// and `/api/ready` is where the blocking version of this check lives.

import {
  domainReportFindings,
  parseProviderDomains,
} from "../lib/emailSendingDomainsCore.ts";
import { parseFromAddress } from "../lib/emailSendingIdentityCore.ts";

const json = process.argv.includes("--json");

const TRANSACTIONAL_FALLBACK = "Tomverse Insight <hello@tomverse.app>";

const configured = {
  transactional:
    parseFromAddress(
      process.env.TRANSACTIONAL_EMAIL_FROM ||
        process.env.EMAIL_FROM ||
        TRANSACTIONAL_FALLBACK
    )?.domain ?? null,
  marketing: parseFromAddress(process.env.MARKETING_EMAIL_FROM)?.domain ?? null,
};

const readProviderDomains = async () => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return {
      domains: null,
      error:
        "RESEND_API_KEY is not set, so the provider's domain status could not be read. The configured addresses below are all this run can report.",
    };
  }
  let response;
  try {
    response = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (error) {
    return {
      domains: null,
      error: `The provider could not be reached: ${error instanceof Error ? error.name : "unknown error"}.`,
    };
  }
  if (!response.ok) {
    return {
      domains: null,
      error: `The provider answered ${response.status} when listing domains.`,
    };
  }
  return { domains: parseProviderDomains(await response.json()), error: null };
};

const { domains, error } = await readProviderDomains();

// No findings when the provider was not reached. Derived from an empty list
// they would claim every configured domain is unregistered, and send somebody
// to re-create domains that already exist.
const findings = domains
  ? domainReportFindings({
      transactionalDomain: configured.transactional,
      marketingDomain: configured.marketing,
      providerDomains: domains,
    })
  : [];

if (json) {
  console.log(
    JSON.stringify(
      { configured, providerDomains: domains, providerError: error, findings },
      null,
      2
    )
  );
} else {
  console.log("Email sending domains\n");
  console.log(`  transactional  ${configured.transactional ?? "not configured"}`);
  console.log(`  marketing      ${configured.marketing ?? "not configured"}\n`);

  if (error) {
    console.log(`  ${error}\n`);
  }

  for (const domain of domains ?? []) {
    console.log(
      `  ${domain.name}  [${domain.status}]${domain.region ? `  ${domain.region}` : ""}`
    );
    for (const record of domain.records) {
      console.log(
        `      ${(record.record ?? "—").padEnd(6)} ${(record.type ?? "—").padEnd(4)} ${(record.name ?? "—").padEnd(24)} ${record.status ?? "unknown"}`
      );
    }
    console.log(
      `      ${"DMARC".padEnd(6)} ${"TXT".padEnd(4)} ${`_dmarc.${domain.name}`.padEnd(24)} not issued by the provider — check the zone`
    );
    console.log("");
  }

  if (findings.length === 0) {
    console.log(error ? "  No findings: nothing was read." : "  No findings.");
  }
  for (const finding of findings) {
    console.log(`  [${finding.severity}] ${finding.code}: ${finding.message}`);
  }
  console.log("\n  Records are added at the registrar. See docs/ops/email-sending-domains.md.");
}
