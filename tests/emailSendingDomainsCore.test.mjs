import assert from "node:assert/strict";
import { test } from "node:test";

import {
  domainReportFindings,
  parseProviderDomains,
} from "../lib/emailSendingDomainsCore.ts";

// Sending domain and DNS status.
// Contract: docs/policy/email-notifications.md §14.1, §17.3.

/** The shape the provider actually returned on 2026-08-21, trimmed. */
const VERIFIED_ROOT = {
  id: "9c1a9e34",
  name: "tomverse.app",
  status: "verified",
  region: "ap-northeast-1",
  records: [
    { record: "DKIM", type: "TXT", name: "resend._domainkey", status: "verified" },
    { record: "SPF", type: "MX", name: "send", status: "verified" },
    { record: "SPF", type: "TXT", name: "send", status: "verified" },
  ],
};

const codes = (input) => domainReportFindings(input).map((finding) => finding.code);

test("a configured domain the provider has never heard of is blocking", () => {
  assert.deepEqual(
    codes({
      transactionalDomain: "mail.tomverse.app",
      marketingDomain: null,
      providerDomains: [VERIFIED_ROOT],
    }),
    ["DOMAIN_NOT_REGISTERED", "MARKETING_DOMAIN_ABSENT"]
  );
});

test("DMARC is reported for every domain and is never a tick", () => {
  // The provider issues DKIM and SPF and reports on those. It issues no DMARC
  // record and reports on none, so a domain reads "verified" with no policy at
  // all -- which is the record §14.1 asks for first.
  const findings = domainReportFindings({
    transactionalDomain: "tomverse.app",
    marketingDomain: null,
    providerDomains: [VERIFIED_ROOT],
  });
  const dmarc = findings.find((finding) => finding.code === "DMARC_NOT_VISIBLE_HERE");
  assert.ok(dmarc);
  assert.equal(dmarc.severity, "info");
  assert.ok(dmarc.message.includes("_dmarc.tomverse.app"));
  // And it names the registrable parent, because that is where `sp=` lives.
  assert.ok(dmarc.message.includes("tomverse.app"));
});

test("the live configuration reports exactly what is outstanding", () => {
  // tomverse.app verified, sending from the registrable domain, no marketing
  // domain. Three statements, none of them a failure, and the middle one is
  // the whole of §17.3 step 1.
  assert.deepEqual(
    codes({
      transactionalDomain: "tomverse.app",
      marketingDomain: null,
      providerDomains: [VERIFIED_ROOT],
    }),
    ["SENDING_FROM_ROOT_DOMAIN", "DMARC_NOT_VISIBLE_HERE", "MARKETING_DOMAIN_ABSENT"]
  );
});

test("a registered but unverified domain blocks, and so does a pending record", () => {
  const pending = {
    ...VERIFIED_ROOT,
    name: "mail.tomverse.app",
    status: "pending",
    records: [
      { record: "DKIM", type: "TXT", name: "resend._domainkey.mail", status: "pending" },
      { record: "SPF", type: "MX", name: "send.mail", status: "verified" },
    ],
  };
  const findings = domainReportFindings({
    transactionalDomain: "mail.tomverse.app",
    marketingDomain: null,
    providerDomains: [pending],
  });
  assert.deepEqual(
    findings.filter((finding) => finding.severity === "error").map((f) => f.code),
    ["DOMAIN_NOT_VERIFIED", "RECORD_NOT_VERIFIED"]
  );
  // Named specifically enough to fix without opening the dashboard.
  const record = findings.find((finding) => finding.code === "RECORD_NOT_VERIFIED");
  assert.ok(record.message.includes("resend._domainkey.mail"));
  assert.ok(record.message.includes("DKIM"));
});

test("the target state is quiet apart from the DMARC note", () => {
  const target = [
    { ...VERIFIED_ROOT, id: "a", name: "mail.tomverse.app" },
    { ...VERIFIED_ROOT, id: "b", name: "news.tomverse.app" },
  ];
  assert.deepEqual(
    codes({
      transactionalDomain: "mail.tomverse.app",
      marketingDomain: "news.tomverse.app",
      providerDomains: target,
    }),
    ["DMARC_NOT_VISIBLE_HERE", "DMARC_NOT_VISIBLE_HERE"]
  );
});

test("both streams on one domain is reported first", () => {
  // It is the finding that makes the others beside the point, so it leads.
  const findings = domainReportFindings({
    transactionalDomain: "mail.tomverse.app",
    marketingDomain: "mail.tomverse.app",
    providerDomains: [{ ...VERIFIED_ROOT, name: "mail.tomverse.app" }],
  });
  assert.equal(findings[0].code, "STREAMS_SHARE_A_DOMAIN");
  assert.equal(findings[0].severity, "error");
});

test("domain matching ignores case and does not match a suffix", () => {
  assert.deepEqual(
    codes({
      transactionalDomain: "TOMVERSE.APP",
      marketingDomain: null,
      providerDomains: [VERIFIED_ROOT],
    }).filter((code) => code === "DOMAIN_NOT_REGISTERED"),
    []
  );
  assert.ok(
    codes({
      transactionalDomain: "nottomverse.app",
      marketingDomain: null,
      providerDomains: [VERIFIED_ROOT],
    }).includes("DOMAIN_NOT_REGISTERED")
  );
});

test("an unexpected provider payload yields nothing rather than throwing", () => {
  // This parses a report an operator reads while something is already wrong. A
  // parser that threw on an unfamiliar field would turn "one record is
  // pending" into "the report is broken".
  assert.deepEqual(parseProviderDomains(null), []);
  assert.deepEqual(parseProviderDomains({}), []);
  assert.deepEqual(parseProviderDomains({ data: "nope" }), []);
  assert.deepEqual(parseProviderDomains({ data: [{ name: "no-id.example" }] }), []);
  assert.deepEqual(
    parseProviderDomains({ data: [{ id: "x", name: "a.example", records: null }] }),
    [{ id: "x", name: "a.example", status: "unknown", region: null, records: [] }]
  );
});

test("the provider payload parses into what the findings need", () => {
  const parsed = parseProviderDomains({ data: [VERIFIED_ROOT] });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].region, "ap-northeast-1");
  assert.equal(parsed[0].records.length, 3);
  assert.deepEqual(parsed[0].records[0], {
    record: "DKIM",
    type: "TXT",
    name: "resend._domainkey",
    status: "verified",
  });
});
