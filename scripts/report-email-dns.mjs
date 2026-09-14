// Do the sending domains' DNS records actually exist, and do they say the
// right thing?
//
//   npm run report:email-dns
//   npm run report:email-dns -- news.tomverse.app
//   npm run report:email-dns -- --json
//
// Read-only. It resolves names and prints what it found; it registers nothing
// and changes no environment.
//
// Contract: docs/policy/email-notifications.md §14.1.
// Runbook: docs/ops/email-sending-domains.md §3.3, §4.1.
//
// ## Why this exists next to `report:email-domains`
//
// That one asks the provider what it thinks. This one asks DNS. They answer
// different questions and can disagree: a domain the provider has never heard
// of can have every record in place (a second provider account is exactly that
// case), and a domain the provider calls verified can have no DMARC policy,
// because the provider neither issues that record nor reports its absence.
//
// ## Why it can run here at all
//
// `docs/ops/email-sending-domains.md` said DNS could not be checked from this
// container. `dig` is indeed absent and DNS-over-HTTPS is refused by the proxy
// (403) -- but Node's own resolver works, and it was never tried. The runbook
// is corrected.
//
// ## Exit code
//
// Always 0. It is a report, not a gate, for the same reason `report:email-domains`
// is: whether a domain with no records yet is a problem depends on whether
// somebody is mid-setup. `/api/ready` holds the blocking checks.

import { promises as dns } from "node:dns";

import { domainDnsReport, sendingDnsNames } from "../lib/emailSendingDnsCore.ts";
import {
  parseFromAddress,
  sendingIdentityInputFrom,
} from "../lib/emailSendingIdentityCore.ts";

const args = process.argv.slice(2);
const json = args.includes("--json");
const named = args.filter((arg) => !arg.startsWith("--"));

// Configured domains by default, so the report describes the deployment rather
// than a list kept here. Named arguments exist because a domain is set up
// *before* its `*_EMAIL_FROM` is deployed -- which is the whole of §4.1 steps
// 1 to 4 -- and a report that could not look at it until afterwards would be
// useless exactly when it is needed.
const identity = sendingIdentityInputFrom(process.env);
const configured = [identity.transactionalFrom, identity.marketingFrom]
  .map((value) => parseFromAddress(value)?.domain ?? null)
  .filter((domain) => domain !== null);

const domains = named.length > 0 ? named : configured;

/** `null` for a name that does not exist, so "absent" and "empty" stay apart. */
const resolve = async (fn, name) => {
  try {
    return await fn(name);
  } catch (error) {
    if (error?.code === "ENOTFOUND" || error?.code === "ENODATA") return null;
    throw error;
  }
};

const answersFor = async (domain) => {
  const names = sendingDnsNames(domain);
  const [dkim, spfTxt, spfMx, dmarc] = await Promise.all([
    resolve((name) => dns.resolveTxt(name), names.dkim),
    resolve((name) => dns.resolveTxt(name), names.spfTxt),
    resolve((name) => dns.resolveMx(name), names.spfMx),
    resolve((name) => dns.resolveTxt(name), names.dmarc),
  ]);
  // `resolveTxt` returns each record as its character strings; a DKIM key is
  // split across several and means nothing until they are joined.
  const flatten = (records) =>
    records === null ? null : records.map((chunks) => chunks.join(""));
  return {
    dkim: flatten(dkim),
    spfTxt: flatten(spfTxt),
    spfMx: spfMx,
    dmarc: flatten(dmarc),
  };
};

if (domains.length === 0) {
  const message =
    "No domain to check: neither TRANSACTIONAL_EMAIL_FROM nor MARKETING_EMAIL_FROM is set, and none was named. Pass one, e.g. `npm run report:email-dns -- news.tomverse.app`.";
  console.log(json ? JSON.stringify({ domains: [], message }, null, 2) : message);
  process.exit(0);
}

const reports = [];
for (const domain of domains) {
  reports.push(domainDnsReport(domain, await answersFor(domain)));
}

if (json) {
  console.log(JSON.stringify({ domains: reports }, null, 2));
  process.exit(0);
}

for (const report of reports) {
  const state = report.ready ? "records in place" : "incomplete";
  console.log(`${report.domain} — ${state}${report.region ? ` (${report.region})` : ""}`);
  for (const finding of report.findings) {
    console.log(`  ${finding.severity === "error" ? "!" : "~"} ${finding.record}: ${finding.message}`);
  }
  console.log("");
}

console.log(
  "DNS only. Whether the provider has accepted the domain is a separate fact, " +
    "in that provider account's console — and for marketing that is a different " +
    "account from the one `report:email-domains` reads."
);
