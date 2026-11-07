import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AdminCreditLedgerTable } from "@/components/admin/AdminCreditLedgerTable";
import { AdminSignedBars } from "@/components/admin/ui/AdminSignedBars";
import type { AdminCreditLedgerRow } from "@/lib/adminCreditLedgerStats";
import { adminCreditLedgerMessages } from "@/lib/adminMessages/creditLedger";

/**
 * The ledger table's first render and the signed bar chart. Typing in the
 * search box and picking a type chip are browser behaviour; the page-level
 * read and the cards sit in a server component and are pinned by the stats
 * tests and the Playwright read surfaces.
 */

const m = adminCreditLedgerMessages.en;

const entry = (overrides: Partial<AdminCreditLedgerRow> = {}): AdminCreditLedgerRow => ({
  id: "entry-1",
  userId: "user-1",
  userEmail: "oliver@example.com",
  type: "purchase",
  creditsDelta: 5000,
  balanceAfterCredits: 5120,
  fundedCostMicroUsdDelta: 0,
  reservationId: null,
  createdAt: "2026-11-07T00:15:00.000Z",
  ...overrides,
});

const rows = [
  entry(),
  entry({
    id: "entry-2",
    userId: "user-2",
    userEmail: "seoyeon@example.com",
    type: "reserve",
    creditsDelta: -400,
    balanceAfterCredits: 16560,
    fundedCostMicroUsdDelta: -12_000,
    reservationId: "resv_0123456789abcdef",
    createdAt: "2026-11-07T01:40:00.000Z",
  }),
  entry({ id: "entry-3", userId: "user-3", userEmail: null, type: "purchase_grant", creditsDelta: 700, balanceAfterCredits: 700 }),
  entry({ id: "entry-4", type: "payment_refund", creditsDelta: -7520, balanceAfterCredits: 0 }),
];

test("the table lists time in AEST, a customer link, a type chip, the change and the balance", () => {
  const out = renderToStaticMarkup(<AdminCreditLedgerTable rows={rows} />);
  assert.ok(out.includes("2026-11-07 10:15 AEST"));
  assert.ok(out.includes('href="/admin/users/user-1"'));
  assert.ok(out.includes("oliver@example.com"));
  assert.ok(out.includes("+5,000"));
  assert.ok(out.includes("-400"));
  assert.ok(out.includes("5,120"));
  // A customer with no email shows the account id, as the page always did.
  assert.ok(out.includes(">user-3<"));
  // Column heads name the lot, since a ledger entry belongs to a credit lot.
  assert.ok(out.includes(m.columns.balance));
});

test("the reservation is shortened in the table and kept whole on hover, with the funded cost beside it", () => {
  const out = renderToStaticMarkup(<AdminCreditLedgerTable rows={rows} />);
  assert.ok(out.includes('title="resv_0123456789abcdef"'));
  assert.ok(out.includes("Reservation resv_012"));
  assert.ok(!out.includes(">resv_0123456789abcdef<"));
  assert.ok(out.includes("Funded cost -$0.0120"));
});

test("the type chips come from the types present, with a readable word for known ones and the raw type for the rest", () => {
  const out = renderToStaticMarkup(<AdminCreditLedgerTable rows={rows} />);
  const group = out.slice(out.indexOf(`aria-label="${m.filters.label}"`));
  const chips = [...group.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([^<]*)<\/button>/g)].map((match) => match[2]);
  assert.deepEqual(chips, [m.filters.all, "Reserve", "Purchase", "Refund clawback", "purchase_grant"]);
  // Everything shows until a chip is chosen.
  assert.match(group, /aria-pressed="true"[^>]*>All</);
});

test("an empty ledger is an empty state with the search still in place", () => {
  const out = renderToStaticMarkup(<AdminCreditLedgerTable rows={[]} />);
  assert.ok(out.includes(m.empty.title));
  assert.match(out, /role="status"/);
  assert.match(out, /type="search"/);
});

test("the signed chart draws one bar above and one below per day on a shared scale", () => {
  const out = renderToStaticMarkup(<AdminSignedBars up={[100, 0, 50]} down={[25, 0, 100]} label="Flow" />);
  assert.match(out, /<svg[^>]*role="img"[^>]*aria-label="Flow"/);
  assert.equal(out.split("<rect").length - 1, 6);
  const heights = [...out.matchAll(/<rect[^>]*height="([\d.]+)"/g)].map((match) => Number(match[1]));
  // Same scale: the 100 above and the 100 below are as tall as each other, a quarter is a quarter.
  assert.equal(heights[0], heights[5]);
  assert.ok(Math.abs(heights[3] / heights[0] - 0.25) < 0.02);
  // A zero is a hairline, so the day reads as measured and empty.
  assert.equal(heights[1], 1);
});

test("the signed chart draws nothing for input it cannot show honestly", () => {
  assert.equal(renderToStaticMarkup(<AdminSignedBars up={[]} down={[]} label="x" />), "");
  assert.equal(renderToStaticMarkup(<AdminSignedBars up={[1, 2]} down={[1]} label="x" />), "");
  assert.equal(renderToStaticMarkup(<AdminSignedBars up={[-1]} down={[1]} label="x" />), "");
  assert.equal(renderToStaticMarkup(<AdminSignedBars up={[Number.NaN]} down={[1]} label="x" />), "");
});

test("both Admin locales carry the same ledger messages, including a word for every known type", () => {
  const keys = (value: object, prefix = ""): string[] =>
    Object.entries(value).flatMap(([key, entryValue]) =>
      typeof entryValue === "object" && entryValue !== null ? keys(entryValue, `${prefix}${key}.`) : [`${prefix}${key}`]
    );
  assert.deepEqual(keys(adminCreditLedgerMessages.ko).sort(), keys(m).sort());
  assert.equal(adminCreditLedgerMessages.ko.types.payment_refund, "환불 회수");
});
