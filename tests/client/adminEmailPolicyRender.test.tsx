import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AdminEmailDomainsView } from "@/components/admin/AdminEmailDomainsPanel";
import { AdminEmailPolicyPanel, AdminEmailPolicyProfileCard } from "@/components/admin/AdminEmailPolicyPanel";
import { adminEmailPolicyMessages } from "@/lib/adminMessages/emailPolicy";
import type { SendingDomainReport } from "@/lib/emailSendingDomains";

/**
 * Email policy (Messaging group): jurisdiction cards and the sending-domain
 * chips. The DMARC chip is never green, because the provider does not report it.
 */

const profile = {
  profileKey: "KR",
  marketingBasis: "opt-in",
  subjectPrefix: "(Ad) ",
  footerBlocks: ["unsubscribe", "address"],
  unsubscribeSlaBusinessDays: 10,
  consentNoticeIntervalMonths: 24,
  quietHours: { start: "21:00", end: "08:00", tz: "Asia/Seoul" },
  impliedConsentDays: null,
  notes: "Confirmed 2026-08-21 against the act.",
  countries: ["KR"],
};

test("a jurisdiction card says its version and status in words, and folds the internals", () => {
  const html = renderToStaticMarkup(
    <AdminEmailPolicyProfileCard profile={profile} version="2026-09-14" status="active" />
  );
  assert.match(html, /data-testid="email-policy-profile-KR"/);
  assert.match(html, /data-tone="ok"[^>]*>In force</);
  assert.match(html, /2026-09-14/);
  assert.match(html, /every 24 months/);
  // The prefix literal and the sources sit inside the closed technical details.
  assert.match(html, /<details[^>]*>[\s\S]*&quot;\(Ad\) &quot;/);
  assert.doesNotMatch(html, /<details[^>]*open/);
});

test("a draft version is drawn as waiting, not as in force", () => {
  const html = renderToStaticMarkup(
    <AdminEmailPolicyProfileCard profile={profile} version="2026-11-01" status="draft" />
  );
  assert.match(html, /data-tone="warn"[^>]*>Draft, waiting for approval</);
  assert.doesNotMatch(html, /data-tone="ok"/);
});

test("before the read returns the policy panel loads and keeps its actions", () => {
  const html = renderToStaticMarkup(<AdminEmailPolicyPanel />);
  assert.match(html, /role="status" aria-label="Loading"/);
  assert.match(html, /data-testid="email-policy-refresh"/);
  assert.match(html, /data-testid="email-policy-create-draft"/);
  assert.doesNotMatch(html, /No policy version exists yet/);
});

const report = (over: Partial<SendingDomainReport> = {}): SendingDomainReport => ({
  checkedAt: "2026-11-07T01:30:00.000Z",
  configured: { transactional: "tomverse.app", marketing: null },
  providerDomains: null,
  providerError: null,
  findings: [],
  ...over,
});

const domainsView = (value: SendingDomainReport) =>
  renderToStaticMarkup(<AdminEmailDomainsView report={value} m={adminEmailPolicyMessages.en.domains} />);

test("a verified domain shows SPF and DKIM ticks and a DMARC chip that is never healthy", () => {
  const html = domainsView(
    report({
      providerDomains: [
        {
          id: "d1",
          name: "tomverse.app",
          status: "verified",
          region: "us-east-1",
          records: [
            { record: "SPF", type: "TXT", name: "send", status: "verified" },
            { record: "DKIM", type: "TXT", name: "resend._domainkey", status: "verified" },
          ],
        },
      ],
    })
  );
  assert.match(html, /data-testid="email-domain-tomverse\.app"/);
  assert.match(html, /data-tone="ok"[^>]*>(?:<svg[\s\S]*?<\/svg>)?SPF</);
  assert.match(html, /data-tone="ok"[^>]*>(?:<svg[\s\S]*?<\/svg>)?DKIM</);
  assert.match(html, /data-tone="unknown"[^>]*>DMARC</);
  assert.doesNotMatch(html, /data-tone="ok"[^>]*>DMARC/);
  assert.match(html, /Transactional/);
});

test("a pending record turns its chip to attention", () => {
  const html = domainsView(
    report({
      providerDomains: [
        {
          id: "d2",
          name: "mail.tomverse.app",
          status: "pending",
          region: null,
          records: [
            { record: "SPF", type: "TXT", name: "send", status: "verified" },
            { record: "DKIM", type: "TXT", name: "resend._domainkey", status: "pending" },
          ],
        },
      ],
    })
  );
  assert.match(html, /data-tone="warn"[^>]*>(?:<svg[\s\S]*?<\/svg>)?DKIM</);
});

test("when the provider was not reached it says so and states no findings", () => {
  const html = domainsView(report({ providerError: "RESEND_API_KEY is not set." }));
  assert.match(html, /data-testid="email-domain-provider-error"/);
  assert.match(html, /<div[^>]*data-testid="email-domain-findings"[^>]*><\/div>/);
  assert.match(html, /data-testid="email-domain-configured-marketing"[\s\S]*not configured/);
  assert.doesNotMatch(html, /Nothing configured to report on/);
});

test("the email policy copy has the same keys in English and Korean", () => {
  const keys = (value: unknown): string[] =>
    Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      item && typeof item === "object" ? keys(item).map((inner) => `${key}.${inner}`) : [key]
    );
  assert.deepEqual(keys(adminEmailPolicyMessages.ko).sort(), keys(adminEmailPolicyMessages.en).sort());
});
