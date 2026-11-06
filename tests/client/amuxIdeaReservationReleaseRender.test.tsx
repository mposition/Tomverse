import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AmuxIdeaReservationReleaseView, amuxReservationAmount,
  type AmuxReservationReleasePhase } from "@/components/admin/AmuxIdeaReservationReleasePanel";
import { adminAmuxIdeaProgressMessages } from "@/lib/adminMessages/amuxIdeaProgress";

const m = adminAmuxIdeaProgressMessages.ko.reservationRelease;
const render = (phase: AmuxReservationReleasePhase,
  changes: { refused?: boolean; reauthenticateHref?: string | null; quiet?: boolean } = {}) =>
  renderToStaticMarkup(<AmuxIdeaReservationReleaseView m={m} phase={phase} count={1} amount="US$10.56"
    quiet={changes.quiet} refused={changes.refused ?? false} reauthenticateHref={changes.reauthenticateHref ?? null}
    onRelease={() => {}} onReadBack={() => {}} />);

test("a releasable idea shows one button with what it frees, and no ID field or lookup step", () => {
  const html = render("releasable");
  assert.match(html, /data-testid="amux-reservation-release-action"/);
  assert.ok(html.includes(m.releasable("US$10.56", 1)));
  assert.doesNotMatch(html, /<input|amux-reservation-release-readback/);
});

test("every phase without a release names why, and only an unknown or failed read offers a read-back", () => {
  for (const [phase, text] of [["none", m.none], ["in_use", m.inUse], ["outcome_unknown", m.outcomeUnknown],
    ["disabled", m.disabled], ["already_released", m.alreadyReleased], ["released", m.released(1)],
    ["checking", m.checking], ["sending", m.sending]] as const) {
    const html = render(phase);
    assert.ok(html.includes(text), phase);
    assert.doesNotMatch(html, /amux-reservation-release-action|amux-reservation-release-readback/, phase);
  }
  for (const phase of ["unknown", "unavailable"] as const) {
    const html = render(phase);
    assert.match(html, /amux-reservation-release-readback/);
    assert.doesNotMatch(html, /amux-reservation-release-action/);
  }
  assert.ok(render("checking", { refused: true }).includes(m.refused));
  assert.match(render("unavailable", { reauthenticateHref: "/admin/reauth" }), /href="\/admin\/reauth"/);
});

test("quiet steps show the panel only when there is something to release or a release to check", () => {
  for (const phase of ["releasable", "sending", "released", "unknown"] as const) {
    assert.match(render(phase, { quiet: true }), /data-testid="amux-reservation-release"/, phase);
  }
  for (const phase of ["checking", "none", "in_use", "outcome_unknown", "disabled", "already_released",
    "unavailable"] as const) {
    assert.equal(render(phase, { quiet: true }), "", phase);
  }
  assert.ok(render("checking", { quiet: true, refused: true }).includes(m.refused));
  // A stale sign-in still shows its way back, or a held reservation could never be read.
  const stale = render("unavailable", { quiet: true, reauthenticateHref: "/admin/reauth" });
  assert.match(stale, /href="\/admin\/reauth"/);
  assert.match(stale, /amux-reservation-release-readback/);
});

test("the held amount rounds up to the cent", () => {
  assert.equal(amuxReservationAmount(BigInt(10_560_000)), "US$10.56");
  assert.equal(amuxReservationAmount(BigInt(10_560_001)), "US$10.57");
  assert.equal(amuxReservationAmount(BigInt(1)), "US$0.01");
  assert.equal(amuxReservationAmount(BigInt(21_120_000)), "US$21.12");
});
