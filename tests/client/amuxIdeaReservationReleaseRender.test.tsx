import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AmuxIdeaReservationReleaseView, amuxReservationAmount,
  type AmuxReservationReleasePhase } from "@/components/admin/AmuxIdeaReservationReleasePanel";
import { adminAmuxIdeaProgressMessages } from "@/lib/adminMessages/amuxIdeaProgress";

const m = adminAmuxIdeaProgressMessages.ko.reservationRelease;
const render = (phase: AmuxReservationReleasePhase, changes: { refused?: boolean; reauthenticateHref?: string | null } = {}) =>
  renderToStaticMarkup(<AmuxIdeaReservationReleaseView m={m} phase={phase} count={1} amount="US$10.56"
    refused={changes.refused ?? false} reauthenticateHref={changes.reauthenticateHref ?? null}
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

test("the held amount rounds up to the cent", () => {
  assert.equal(amuxReservationAmount(BigInt(10_560_000)), "US$10.56");
  assert.equal(amuxReservationAmount(BigInt(10_560_001)), "US$10.57");
  assert.equal(amuxReservationAmount(BigInt(1)), "US$0.01");
  assert.equal(amuxReservationAmount(BigInt(21_120_000)), "US$21.12");
});
