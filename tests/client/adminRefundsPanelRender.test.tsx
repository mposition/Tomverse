import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { RefundRequestsPanel, type RefundRequestRow } from "@/components/admin/RefundRequestsPanel";
import { adminRefundsMessages } from "@/lib/adminMessages/refunds";

/**
 * The refund queue's first render. The approval dialog is a portal that opens
 * on a click and the approve call is a network write, so both belong to the
 * Playwright journeys (tests/e2e-admin/admin-billing-journeys.spec.ts); what is
 * pinned here is what the operator reads before deciding.
 */

const m = adminRefundsMessages.en;
const NOW = "2026-11-07T03:00:00.000Z";

const router: AppRouterInstance = {
  back: () => {},
  forward: () => {},
  refresh: () => {},
  push: () => {},
  replace: () => {},
  prefetch: () => {},
  bfcacheId: "admin-refunds-render-fixture",
};

const render = (props: Partial<React.ComponentProps<typeof RefundRequestsPanel>> & { rows: RefundRequestRow[] }, search = "") =>
  renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value="/admin/refunds">
        <SearchParamsContext.Provider value={new URLSearchParams(search)}>
          <RefundRequestsPanel {...props} />
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );

const risk = {
  requiresReview: true,
  purchaseCount: 1,
  purchasedCredits: 8000,
  remainingCredits: 7520,
  estimatedUsedCredits: 480,
  purchasedCostMicroUsd: 8_000_000,
  remainingCostMicroUsd: 7_520_000,
  estimatedConsumedCostMicroUsd: 480_000,
  unrecoveredCredits: 0,
  unrecoveredCostMicroUsd: 0,
  billingRiskStatus: "normal",
};

const row = (overrides: Partial<RefundRequestRow> = {}): RefundRequestRow => ({
  id: "refund-1",
  email: "user04@example.com",
  plan: "Pro",
  status: "pending",
  reason: "I barely used it and want to cancel.",
  adminNote: null,
  stripeCustomerId: "cus_secret_1",
  stripeSubscriptionId: "sub_secret_1",
  subscriptionStatus: "active",
  subscriptionBillingInterval: "monthly",
  subscriptionCurrentPeriodEnd: "2026-11-30T00:00:00.000Z",
  stripeRefundId: null,
  stripeRefundStatus: null,
  stripeChargeId: null,
  refundAmountCents: null,
  refundCurrency: null,
  requestedAt: "2026-11-06T00:20:00.000Z",
  reviewedAt: null,
  timelineEvents: [],
  ...overrides,
});

const count = (markup: string, needle: string) => markup.split(needle).length - 1;

test("a pending request shows who, what the customer said, and what is not known yet", () => {
  const out = render({ rows: [row({ creditRisk: risk })], generatedAt: NOW });
  assert.ok(out.includes("user04@example.com"));
  assert.ok(out.includes("Pro · Monthly"));
  // The reason is quoted as the customer wrote it.
  assert.ok(out.includes("I barely used it and want to cancel."));
  assert.match(out, /<blockquote/);
  // The refund amount is set by Stripe at approval: it is Unavailable, with the reason why.
  assert.ok(out.includes(m.stats.amountPending));
  assert.ok(out.includes(m.stats.amountPendingDetail));
  assert.match(out, /data-unread="true"[^>]*>Unavailable</);
  // The credit use bar and the unspent pack credits come from the credit summary.
  assert.ok(out.includes("6%"));
  assert.ok(out.includes("480 of 8,000 credit-pack credits"));
  assert.ok(out.includes("7,520"));
  // A waiting chip measured from the server time, in the day count.
  assert.ok(out.includes("Waiting 1 day"));
  // The first entry of the timeline is the request itself.
  assert.ok(out.includes(m.requestedEvent));
});

test("a request with no credit summary says Unavailable rather than a zero", () => {
  const out = render({ rows: [row({ creditRisk: undefined })] });
  // Amount, share and unspent credits are all unread.
  assert.equal(count(out, 'data-unread="true"'), 3);
  assert.doesNotMatch(out, />0%</);
  assert.ok(!out.includes(m.creditRisk.title));
});

test("a customer who bought no credit pack says so instead of showing a share", () => {
  const out = render({
    rows: [
      row({
        creditRisk: { ...risk, requiresReview: false, purchaseCount: 0, purchasedCredits: 0, remainingCredits: 0, estimatedUsedCredits: 0 },
      }),
    ],
  });
  assert.ok(out.includes(m.stats.noPurchases));
  assert.ok(!out.includes(m.creditRisk.title));
});

const buttonsIn = (markup: string) =>
  markup
    .split("<button")
    .slice(1)
    .map((chunk) => "<button" + chunk.split("</button>")[0]);

test("approval is gated on the credit review and written as a step-up action", () => {
  const out = render({ rows: [row({ creditRisk: risk })] });
  assert.ok(out.includes(m.creditRisk.title));
  assert.ok(out.includes(m.creditRisk.confirm));
  const buttons = buttonsIn(out);
  const approve = buttons.find((button) => button.endsWith(">Approve"));
  const reject = buttons.find((button) => button.endsWith(">Reject"));
  // Approve is disabled until the review is ticked, and carries the step-up marker.
  assert.ok(approve?.includes('disabled=""'));
  assert.ok(approve?.includes('data-step-up="true"'));
  assert.ok(out.includes(m.notePlaceholder));
  // Reject needs no review.
  assert.ok(reject && !reject.includes('disabled=""'));
});

test("with no credit review to do, approval is open", () => {
  const out = render({ rows: [row()] });
  const approve = buttonsIn(out).find((button) => button.endsWith(">Approve"));
  assert.ok(approve && !approve.includes('disabled=""'));
});

test("a role without refund access sees locked buttons that name the access", () => {
  const out = render({ rows: [row()], writable: false });
  const locked = buttonsIn(out).filter((button) => button.endsWith(">Approve") || button.endsWith(">Reject"));
  assert.equal(locked.length, 2);
  for (const button of locked) {
    assert.ok(button.includes('disabled=""'));
    assert.ok(button.includes('title="Needs billing access"'));
  }
});

test("Stripe and subscription identifiers stay inside the closed technical details", () => {
  const out = render({ rows: [row({ stripeRefundId: "re_secret_1" })] });
  const details = out.slice(out.indexOf("<details"), out.indexOf("</details>"));
  assert.ok(details.includes("cus_secret_1"));
  assert.ok(details.includes("sub_secret_1"));
  assert.ok(details.includes("re_secret_1"));
  assert.ok(!out.replace(details, "").includes("cus_secret_1"));
  assert.doesNotMatch(details, /<details[^>]*\sopen/);
});

test("a reviewed request shows the refund it made and the Stripe status, with no buttons", () => {
  const out = render(
    {
      rows: [
        row({
          status: "approved",
          stripeRefundId: "re_1",
          stripeRefundStatus: "succeeded",
          refundAmountCents: 2900,
          refundCurrency: "USD",
          reviewedAt: "2026-11-06T02:00:00.000Z",
          adminNote: "Duplicate charge.",
          timelineEvents: [
            {
              id: "e1",
              eventType: "approved",
              message: "Refund request approved. User membership was reset to Free.",
              actorEmail: "billing@example.com",
              createdAt: "2026-11-06T02:00:00.000Z",
            },
          ],
        }),
      ],
      generatedAt: NOW,
    },
    "status=approved"
  );
  assert.ok(out.includes(m.stats.amountDone));
  assert.ok(out.includes("$29.00"));
  assert.ok(out.includes("Refund status: succeeded"));
  assert.ok(out.includes("Reviewed: 2026-11-06 12:00 AEST"));
  assert.ok(out.includes("Refund request approved. User membership was reset to Free."));
  assert.ok(out.includes("billing@example.com"));
  assert.ok(out.includes("Admin note: Duplicate charge."));
  assert.ok(!out.includes(m.notePlaceholder));
  assert.doesNotMatch(out, /Waiting \d/);
});

test("the status tabs count only the rows read and the page says how many that was", () => {
  const out = render({
    rows: [row({ id: "a" }), row({ id: "b", status: "approved" }), row({ id: "c", status: "rejected" }), row({ id: "d", status: "rejected" })],
    rowLimit: 20,
  });
  for (const label of [m.filters.pending(1), m.filters.approved(1), m.filters.rejected(2), m.filters.all(4)]) {
    assert.ok(out.includes(`>${label}</button>`), label);
  }
  assert.ok(out.includes(m.rowLimit(20)));
  assert.match(out, /aria-pressed="true"[^>]*>Pending 1</);
});

test("a tab with nothing on it is an empty state, not a blank page", () => {
  const out = render({ rows: [row({ status: "approved" })] });
  assert.ok(out.includes(m.empty.title));
  assert.match(out, /role="status"/);
});

test("the right column counts approved refunds this month and draws the months it has data for", () => {
  const approved = (id: string, reviewedAt: string, refundAmountCents: number | null) =>
    row({ id, status: "approved", reviewedAt, refundAmountCents, refundCurrency: refundAmountCents === null ? null : "AUD" });
  const out = render(
    {
      rows: [
        approved("a", "2026-11-02T01:00:00.000Z", 2900),
        approved("b", "2026-11-04T01:00:00.000Z", 5800),
        approved("c", "2026-09-04T01:00:00.000Z", 1200),
        approved("d", "2026-11-05T01:00:00.000Z", null),
      ],
      generatedAt: NOW,
    },
    "status=approved"
  );
  assert.ok(out.includes(m.aside.thisMonth));
  assert.ok(out.includes("3 approved, A$87.00"));
  assert.ok(out.includes(m.aside.unknownAmounts(1)));
  // The caption says these are the requests read, not every refund.
  assert.ok(out.includes(m.aside.thisMonthBasis(4)));
  assert.ok(out.includes(m.aside.monthlyBasis(4)));
  assert.match(out, /<svg[^>]*role="img"[^>]*aria-label="Approved refunds in each of the last 6 months"/);
});

test("without the server time there is no month figure and no waiting chip, rather than a guess", () => {
  const out = render({ rows: [row({ status: "approved", reviewedAt: "2026-11-02T01:00:00.000Z" }), row({ id: "p" })] });
  assert.ok(!out.includes(m.aside.thisMonth));
  assert.doesNotMatch(out, /<svg[^>]*role="img"/);
  assert.ok(out.includes(`>${m.status.pending}<`));
});

test("with no approved request in the window the monthly chart is left out", () => {
  const out = render({ rows: [row()], generatedAt: NOW });
  assert.ok(out.includes(m.aside.thisMonthNone));
  assert.ok(!out.includes(m.aside.monthlyTitle));
});

test("both Admin locales carry the same refund messages, and the day count reads naturally", () => {
  const ko = adminRefundsMessages.ko;
  const keys = (value: object, prefix = ""): string[] =>
    Object.entries(value).flatMap(([key, entry]) =>
      typeof entry === "object" && entry !== null ? keys(entry, `${prefix}${key}.`) : [`${prefix}${key}`]
    );
  assert.deepEqual(keys(ko).sort(), keys(m).sort());
  assert.equal(ko.waiting(3), "3일째 기다리는 중");
  assert.equal(m.waiting(3), "Waiting 3 days");
  assert.equal(m.waiting(0), "Requested today");
});
