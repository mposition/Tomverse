import assert from "node:assert/strict";
import test from "node:test";

import type { ReactNode } from "react";

import { MarketingSwitchStrip } from "@/components/admin/AdminMarketingPanel";
import type { MarketingAction } from "@/components/admin/MarketingActions";
import { adminMarketingMessages } from "@/lib/adminMessages/marketing";
import { MARKETING_CONSOLE_SWITCH_CONTROLS } from "@/lib/marketingConsoleSections";

/**
 * The console's switch strip, executed (operator decision 2026-11-04: the
 * landing experiments switch is a console switch like the other three).
 *
 * Same technique as the other client render tests: the component is called and
 * the returned element tree is walked, so the action each switch hands its rail
 * is read directly -- path, method and the exact body the write sends.
 */

const m = adminMarketingMessages.en as unknown as Record<string, string>;

const propsOf = (node: ReactNode, found: Record<string, unknown>[] = []) => {
  if (node === null || node === undefined || typeof node === "boolean") return found;
  if (typeof node === "string" || typeof node === "number") return found;
  if (Array.isArray(node)) {
    for (const child of node) propsOf(child, found);
    return found;
  }
  const element = node as { props?: Record<string, unknown> };
  if (element.props) {
    found.push(element.props);
    propsOf(element.props.children as ReactNode, found);
  }
  return found;
};

const textOf = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const element = node as { props?: { children?: ReactNode } };
  return element.props ? textOf(element.props.children) : "";
};

const actionsOf = (node: ReactNode) =>
  propsOf(node).flatMap((props) =>
    Array.isArray(props.actions) ? (props.actions as MarketingAction[]) : [],
  );

const render = (
  overrides: Partial<{
    switches: Record<string, string>;
    canWrite: boolean;
    configGeneration: number | null;
  }> = {},
) =>
  MarketingSwitchStrip({
    switches: {
      drafts: "off",
      publish: "off",
      autoPublish: "off",
      experiments: "off",
      webhookShadow: "off",
      webhookApplyScope: "no-scope",
      ...overrides.switches,
    } as never,
    canWrite: overrides.canWrite ?? true,
    configGeneration: overrides.configGeneration === undefined ? 7 : overrides.configGeneration,
    section: "queue",
    onDone: () => undefined,
    m,
  });

const experimentsAction = (node: ReactNode) => actionsOf(node).find((a) => a.id === "switch-experiments");

test("every console switch control has a toggle on the strip", () => {
  const ids = actionsOf(render()).map((a) => a.id);
  assert.deepEqual(
    ids,
    MARKETING_CONSOLE_SWITCH_CONTROLS.map((control) => `switch-${control.name}`),
  );
});

test("the experiments switch is turned on by PATCH against the generation shown, after a confirm", () => {
  const action = experimentsAction(render());
  assert.equal(action?.path, "/api/admin/marketing/settings");
  assert.equal(action?.method, "PATCH");
  assert.equal(action?.checked, false);
  assert.ok(action?.confirm, "turning it on is confirmed first");
  assert.deepEqual(action?.body({}), { switch: "experiments", enabled: true, expectedConfigGeneration: 7 });
});

test("the experiments switch is turned off without a confirm: stopping is never gated", () => {
  const action = experimentsAction(render({ switches: { experiments: "on" } }));
  assert.equal(action?.checked, true);
  assert.equal(action?.confirm, undefined);
  assert.deepEqual(action?.body({}), { switch: "experiments", enabled: false, expectedConfigGeneration: 7 });
});

test("experiments has no dependency on the other switches, unlike autonomous", () => {
  const action = experimentsAction(render({ switches: { drafts: "off", publish: "off" } }));
  assert.equal(action?.unavailable, undefined);
  const autonomous = actionsOf(render({ switches: { drafts: "off", publish: "off" } })).find(
    (a) => a.id === "switch-autonomous",
  );
  assert.ok(autonomous?.unavailable);
});

test("a reader, an unreadable switch or an unreadable generation offers no experiments toggle", () => {
  assert.equal(experimentsAction(render({ canWrite: false })), undefined);
  assert.equal(experimentsAction(render({ switches: { experiments: "unreadable" } })), undefined);
  assert.equal(experimentsAction(render({ configGeneration: null })), undefined);
});

test("the experiments row sits with the movable switches and says what off does", () => {
  const text = textOf(render());
  assert.ok(text.includes(m.switchExperiments));
  assert.ok(text.includes(m.switchExperimentsHint));
  // Two read-only states stay folded away; experiments is no longer one of them.
  assert.ok(text.includes(m.switchAdvancedCount.replace("{count}", "2")));
});
