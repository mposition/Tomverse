import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AmuxAttemptUsageAcceptance } from "@/components/admin/AmuxAttemptUsageAcceptance";

// Owner decision 2026-11-10: the execution history marks a run whose usage is
// unknown, offers the owner the acceptance, and shows an accepted run as no
// longer holding its worker while its cost stays unconfirmed.
const render = (attempt: Parameters<typeof AmuxAttemptUsageAcceptance>[0]["attempt"], canAccept = true) =>
  renderToStaticMarkup(<AmuxAttemptUsageAcceptance taskId="task-1" attempt={attempt}
    canAccept={canAccept} date={(value) => value} onAccepted={() => {}} />);

test("a run with complete usage shows nothing", () => {
  assert.equal(render({ id: "a", usageUnknown: false, usageAcceptance: null }), "");
});

test("an unknown run holds its worker and offers the owner the acceptance", () => {
  const html = render({ id: "a", usageUnknown: true, usageAcceptance: null });
  assert.match(html, /data-testid="amux-attempt-usage-unknown"/);
  assert.match(html, /data-testid="amux-attempt-usage-accept"/);
  assert.match(html, /The cost is not treated as zero/);
  assert.doesNotMatch(render({ id: "a", usageUnknown: true, usageAcceptance: null }, false),
    /data-testid="amux-attempt-usage-accept"/);
});

test("an accepted run says how it was accepted and that the cost stays unconfirmed", () => {
  const html = render({ id: "a", usageUnknown: true,
    usageAcceptance: { source: "recovery_approval", acceptedAt: "2026-11-10T00:00:00.000Z" } });
  assert.match(html, /data-testid="amux-attempt-usage-accepted"/);
  assert.match(html, /with the recovery approval, 2026-11-10T00:00:00.000Z/);
  assert.match(html, /the cost stays unconfirmed/);
  assert.doesNotMatch(html, /data-testid="amux-attempt-usage-accept"/);
});
