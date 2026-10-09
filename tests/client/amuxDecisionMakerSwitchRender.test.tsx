import assert from "node:assert/strict";
import test from "node:test";

import type { ReactNode } from "react";

import {
  AmuxDecisionMakerSwitchView,
  dmSwitchChangesFor,
  type DmSwitchChange,
  type DmSwitchNotice,
} from "@/components/admin/AmuxDecisionMakerSwitchPanel";
import { adminAmuxDecisionMakerMessages } from "@/lib/adminMessages/amuxDecisionMaker";
import type { DecisionMakerSwitchState } from "@/lib/amux/decisionMakerSwitchCore";

/**
 * AMUX › Execution › Decision Maker (docs/policy/amux-decision-maker.md §8),
 * executed: the hook-free view is called and the element tree it returns is
 * walked, as the other client render tests do. What it may offer is the
 * question -- which changes, to whom, and with which exact body.
 */

const m = adminAmuxDecisionMakerMessages.en;

type Props = Record<string, unknown>;

const propsOf = (node: ReactNode, found: Props[] = []) => {
  if (node === null || node === undefined || typeof node === "boolean") return found;
  if (typeof node === "string" || typeof node === "number") return found;
  if (Array.isArray(node)) {
    for (const child of node) propsOf(child, found);
    return found;
  }
  const element = node as { props?: Props };
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

const byTestId = (node: ReactNode, id: string) =>
  propsOf(node).filter((props) => props["data-testid"] === id);

const buttonsOf = (node: ReactNode) =>
  propsOf(node).filter(
    (props) => typeof props["data-testid"] === "string" && (props["data-testid"] as string).startsWith("amux-dm-switch-set-"),
  );

const DEFAULT: DecisionMakerSwitchState = {
  killSwitch: false,
  instances: { "decision-maker-openai": "off", "decision-maker-anthropic": "off" },
};
const UNREADABLE: DecisionMakerSwitchState = {
  killSwitch: null,
  instances: { "decision-maker-openai": null, "decision-maker-anthropic": null },
};

const render = (
  overrides: Partial<{
    state: DecisionMakerSwitchState | null;
    canChange: boolean;
    pending: DmSwitchChange | null;
    notice: DmSwitchNotice;
    onChange: (change: DmSwitchChange) => void;
  }> = {},
) =>
  AmuxDecisionMakerSwitchView({
    m,
    state: DEFAULT,
    canChange: true,
    pending: null,
    notice: null,
    failure: null,
    onChange: () => {},
    ...overrides,
  }) as ReactNode;

test("each scope offers every allowed value but the one it holds, and an unreadable scope offers them all", () => {
  assert.deepEqual(dmSwitchChangesFor("kill_switch", "off"), [{ scope: "kill_switch", value: "on" }]);
  assert.deepEqual(dmSwitchChangesFor("kill_switch", "on"), [{ scope: "kill_switch", value: "off" }]);
  assert.deepEqual(dmSwitchChangesFor("decision-maker-openai", "off"), [
    { scope: "decision-maker-openai", value: "proposal" },
  ]);
  assert.deepEqual(dmSwitchChangesFor("decision-maker-anthropic", "proposal"), [
    { scope: "decision-maker-anthropic", value: "off" },
  ]);
  assert.deepEqual(dmSwitchChangesFor("kill_switch", null), [
    { scope: "kill_switch", value: "on" },
    { scope: "kill_switch", value: "off" },
  ]);
  assert.deepEqual(dmSwitchChangesFor("decision-maker-openai", null), [
    { scope: "decision-maker-openai", value: "off" },
    { scope: "decision-maker-openai", value: "proposal" },
  ]);
  // No value outside the policy's lists is ever offered.
  for (const scope of ["kill_switch", "decision-maker-openai", "decision-maker-anthropic"] as const) {
    for (const change of dmSwitchChangesFor(scope, null)) {
      assert.notEqual(change.value, "autonomous");
    }
  }
});

test("the default state shows three rows, and a person who may change sees one change each, sending its exact body", () => {
  const sent: DmSwitchChange[] = [];
  const tree = render({ onChange: (change) => sent.push(change) });
  assert.equal(textOf(byTestId(tree, "amux-dm-switch-value-kill_switch")[0]?.children as ReactNode), "Off (off)");
  assert.equal(
    textOf(byTestId(tree, "amux-dm-switch-value-decision-maker-openai")[0]?.children as ReactNode),
    "Off (off)",
  );
  const buttons = buttonsOf(tree);
  assert.deepEqual(
    buttons.map((props) => props["data-testid"]),
    [
      "amux-dm-switch-set-kill_switch-on",
      "amux-dm-switch-set-decision-maker-openai-proposal",
      "amux-dm-switch-set-decision-maker-anthropic-proposal",
    ],
  );
  for (const props of buttons) {
    assert.equal(props.disabled, false);
    (props.onClick as () => void)();
  }
  assert.deepEqual(sent, [
    { scope: "kill_switch", value: "on" },
    { scope: "decision-maker-openai", value: "proposal" },
    { scope: "decision-maker-anthropic", value: "proposal" },
  ]);
  assert.equal(byTestId(tree, "amux-dm-switch-read-only").length, 0);
});

test("a person who may not change sees the state and the reason, and no control", () => {
  const tree = render({ canChange: false, state: { ...DEFAULT, killSwitch: true } });
  assert.equal(buttonsOf(tree).length, 0);
  assert.equal(textOf(byTestId(tree, "amux-dm-switch-read-only")[0]?.children as ReactNode), m.readOnly);
  assert.equal(textOf(byTestId(tree, "amux-dm-switch-value-kill_switch")[0]?.children as ReactNode), "On (on)");
});

test("an unreadable scope says what that means, and a failed read shows no state at all", () => {
  const unreadable = render({ state: UNREADABLE });
  for (const scope of ["kill_switch", "decision-maker-openai", "decision-maker-anthropic"]) {
    assert.equal(textOf(byTestId(unreadable, `amux-dm-switch-value-${scope}`)[0]?.children as ReactNode), m.unreadable);
  }
  assert.equal(buttonsOf(unreadable).length, 6);

  const failed = render({ state: null });
  assert.equal(byTestId(failed, "amux-dm-switch-unavailable").length, 1);
  assert.equal(buttonsOf(failed).length, 0);
  for (const scope of ["kill_switch", "decision-maker-openai", "decision-maker-anthropic"]) {
    assert.equal(byTestId(failed, `amux-dm-switch-${scope}`).length, 0);
  }
});

test("while a change is in flight no other can start, and an unknown outcome is said out loud", () => {
  const pending = { scope: "kill_switch", value: "on" } as const;
  const tree = render({ pending });
  for (const props of buttonsOf(tree)) assert.equal(props.disabled, true);
  assert.equal(textOf(byTestId(tree, "amux-dm-switch-set-kill_switch-on")[0]?.children as ReactNode), m.saving);

  const unknown = render({ notice: "outcome_unknown" });
  const alert = byTestId(unknown, "amux-dm-switch-outcome-unknown")[0];
  assert.equal(alert?.role, "alert");
  assert.equal(textOf(alert?.children as ReactNode), m.outcomeUnknown);
  assert.equal(byTestId(render({ notice: "saved" }), "amux-dm-switch-saved").length, 1);
});
