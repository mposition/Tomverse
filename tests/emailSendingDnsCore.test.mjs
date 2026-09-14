import assert from "node:assert/strict";
import { test } from "node:test";

import {
  domainDnsReport,
  regionFromFeedbackHost,
  sendingDnsFindings,
  sendingDnsNames,
} from "../lib/emailSendingDnsCore.ts";

// What a sending domain's DNS answers mean.
// Contract: docs/policy/email-notifications.md §14.1.
//
// The failure this guards: a provider console that says "verified" while the
// domain has no DMARC policy at all. The provider issues DKIM and SPF and
// reports on those; it issues no DMARC record and reports on none, so a check
// that trusted the provider would call that domain ready.

const COMPLETE = {
  dkim: ["p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQ"],
  spfTxt: ["v=spf1 include:amazonses.com ~all"],
  spfMx: [{ exchange: "feedback-smtp.ap-northeast-1.amazonses.com", priority: 10 }],
  dmarc: ["v=DMARC1; p=none; rua=mailto:dmarc@tomverse.app; fo=1"],
};

test("the record names follow the provider's own layout", () => {
  assert.deepEqual(sendingDnsNames("news.tomverse.app"), {
    dkim: "resend._domainkey.news.tomverse.app",
    spfTxt: "send.news.tomverse.app",
    spfMx: "send.news.tomverse.app",
    dmarc: "_dmarc.news.tomverse.app",
  });
});

test("a complete domain has no findings", () => {
  assert.deepEqual(sendingDnsFindings(COMPLETE), []);
  assert.equal(domainDnsReport("news.tomverse.app", COMPLETE).ready, true);
});

test("the region is read off the Return-Path host rather than assumed", () => {
  assert.equal(
    domainDnsReport("news.tomverse.app", COMPLETE).region,
    "ap-northeast-1"
  );
  assert.equal(regionFromFeedbackHost("feedback-smtp.eu-west-1.amazonses.com"), "eu-west-1");
  // A trailing dot is how a resolver may hand back an absolute name.
  assert.equal(regionFromFeedbackHost("feedback-smtp.us-east-1.amazonses.com."), "us-east-1");
  assert.equal(regionFromFeedbackHost("mail.example.com"), null);
});

test("a missing DMARC record is an error, not a note", () => {
  // The provider will never report this one, which is why it is not a warning.
  const findings = sendingDnsFindings({ ...COMPLETE, dmarc: null });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].record, "dmarc");
  assert.equal(findings[0].severity, "error");
  assert.equal(domainDnsReport("x.example", { ...COMPLETE, dmarc: null }).ready, false);
});

test("a DMARC policy with no rua is a warning, because nothing is reported back", () => {
  const findings = sendingDnsFindings({
    ...COMPLETE,
    dmarc: ["v=DMARC1; p=none"],
  });
  assert.deepEqual(
    findings.map((finding) => [finding.record, finding.severity]),
    [["dmarc", "warning"]]
  );
  // A warning does not sink the domain: the records are there and mail aligns.
  assert.equal(
    domainDnsReport("x.example", { ...COMPLETE, dmarc: ["v=DMARC1; p=none"] }).ready,
    true
  );
});

test("an SPF record that does not include the provider is reported as such", () => {
  const findings = sendingDnsFindings({
    ...COMPLETE,
    spfTxt: ["v=spf1 include:_spf.purelymail.com ~all"],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].record, "spf_txt");
  // The message quotes what is actually there -- "SPF is wrong" sends an
  // operator to the dashboard to find out what it says.
  assert.match(findings[0].message, /purelymail/);
});

test("an MX pointing somewhere that is not a feedback host is an error", () => {
  const findings = sendingDnsFindings({
    ...COMPLETE,
    spfMx: [{ exchange: "mailserver.purelymail.com", priority: 10 }],
  });
  assert.deepEqual(
    findings.map((finding) => finding.record),
    ["spf_mx"]
  );
});

test("a name that answers without a key is distinguished from one that does not answer", () => {
  const absent = sendingDnsFindings({ ...COMPLETE, dkim: null });
  const empty = sendingDnsFindings({ ...COMPLETE, dkim: ["v=DKIM1; k=rsa"] });
  assert.match(absent[0].message, /No DKIM record/);
  assert.match(empty[0].message, /no record carries a public key/);
});

test("every missing record is reported at once", () => {
  // Learning about one, fixing it, and learning about the next is three trips
  // to the DNS dashboard to learn three facts.
  const findings = sendingDnsFindings({
    dkim: null,
    spfTxt: null,
    spfMx: null,
    dmarc: null,
  });
  assert.deepEqual(
    findings.map((finding) => finding.record),
    ["dkim", "spf_txt", "spf_mx", "dmarc"]
  );
});
