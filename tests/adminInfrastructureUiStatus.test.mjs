import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { RAILWAY_USAGE_MONITOR_DISABLED_MESSAGE } from "../lib/infrastructureTypes.ts";

// The Admin Infrastructure tab is the operator's only view of these monitors.
// When Railway usage monitoring is switched off for an environment, the tab
// must say so in its own words rather than showing a silent, empty Railway
// card that reads like an outage or a missing token.
//
// This is a source contract rather than a DOM render: the panel is a client
// component that paints its Railway card only after an authenticated
// /api/admin/infrastructure fetch, and the repository has no component-render
// harness. The rendered behaviour it cannot reach is covered by the type
// system (`Record<InfrastructureStatus, string>` is exhaustive) and by
// tests/server-contract/infrastructure-railway-usage-flag.test.ts.

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const panel = read("../components/admin/AdminInfrastructurePanel.tsx");
const types = read("../lib/infrastructureTypes.ts");

const declaredStatuses = () => {
  const union = types.match(
    /export type InfrastructureStatus =([\s\S]*?);/
  )?.[1];
  assert.ok(union, "InfrastructureStatus union was not found.");
  return [...union.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
};

const statusStyleKeys = () => {
  const body = panel.match(
    /const statusStyle: Record<InfrastructureStatus, string> = \{([\s\S]*?)\n\};/
  )?.[1];
  assert.ok(body, "statusStyle map was not found.");
  return [...body.matchAll(/^\s{2}([a-z_]+):/gm)].map((match) => match[1]);
};

test("disabled is a first-class status, separate from unconfigured", () => {
  const statuses = declaredStatuses();
  assert.ok(statuses.includes("disabled"));
  assert.ok(statuses.includes("unconfigured"));
  assert.notEqual(
    RAILWAY_USAGE_MONITOR_DISABLED_MESSAGE,
    "",
    "The operator-facing disabled message must be shared, not re-typed."
  );
});

test("every infrastructure status has a badge style in the admin panel", () => {
  const statuses = declaredStatuses();
  const styled = statusStyleKeys();
  for (const status of statuses) {
    assert.ok(
      styled.includes(status),
      `statusStyle is missing a badge style for "${status}".`
    );
  }
  assert.equal(styled.length, statuses.length);
});

test("the disabled badge is not drawn as an error or a warning", () => {
  const disabledStyle = panel.match(/\n {2}disabled: "([^"]+)",/)?.[1];
  assert.ok(disabledStyle, "No disabled badge style was found.");
  assert.equal(/red|amber/.test(disabledStyle), false);
  assert.match(panel, /if \(status === "disabled"\) return <PauseCircle/);
});

test("the Railway card explains the disabled state to the operator", () => {
  assert.match(panel, /RAILWAY_USAGE_MONITOR_DISABLED_MESSAGE/);
  assert.match(
    panel,
    /data\.railway\.status === "disabled" \?[\s\S]*?data-testid="railway-usage-monitor-disabled"/
  );
  // The notice names the variable that restores monitoring, and never a token.
  assert.match(panel, /RAILWAY_USAGE_MONITOR_ENABLED=false/);
  assert.equal(/RAILWAY_PROJECT_TOKEN|RAILWAY_API_TOKEN/.test(panel), false);
});
