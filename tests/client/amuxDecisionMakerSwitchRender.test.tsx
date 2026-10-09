import assert from "node:assert/strict";
import test from "node:test";

import type { ReactNode } from "react";

import {
  AmuxDecisionMakerSwitchView,
  dmSwitchChangesFor,
  parseDmSwitchStateResponse,
  runDmSwitchChange,
  runDmSwitchReread,
  type DmSwitchChange,
  type DmSwitchIo,
  type DmSwitchNotice,
  type DmSwitchPending,
  type DmSwitchUpdate,
} from "@/components/admin/AmuxDecisionMakerSwitchPanel";
import type { AdminApiFailure } from "@/lib/adminApiOutcome";
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
    pending: DmSwitchPending;
    notice: DmSwitchNotice;
    onChange: (change: DmSwitchChange) => void;
    onReread: () => void;
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
    onReread: () => {},
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

  // No state: nothing can be changed, and the only control reads it again.
  let rereads = 0;
  const failed = render({ state: null, onReread: () => (rereads += 1) });
  assert.equal(textOf(byTestId(failed, "amux-dm-switch-unavailable")[0]?.children as ReactNode), m.stateUnavailable);
  assert.equal(buttonsOf(failed).length, 0);
  for (const scope of ["kill_switch", "decision-maker-openai", "decision-maker-anthropic"]) {
    assert.equal(byTestId(failed, `amux-dm-switch-${scope}`).length, 0);
  }
  const reread = byTestId(failed, "amux-dm-switch-reread")[0]!;
  assert.equal(reread.disabled, false);
  (reread.onClick as () => void)();
  assert.equal(rereads, 1);
  // After a change whose re-read failed it says so, rather than "could not be read".
  for (const notice of ["saved_unread", "outcome_unknown_unread"] as const) {
    const unread = render({ state: null, notice });
    assert.equal(textOf(byTestId(unread, "amux-dm-switch-unavailable")[0]?.children as ReactNode), m.rereadFailed);
    assert.equal(buttonsOf(unread).length, 0);
  }
  const reading = render({ state: null, pending: "reading" });
  assert.equal(byTestId(reading, "amux-dm-switch-reread")[0]?.disabled, true);
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
  // A read in flight locks every change too.
  for (const props of buttonsOf(render({ pending: "reading" }))) assert.equal(props.disabled, true);
});

test("the GET body is accepted only in its exact shape", () => {
  assert.deepEqual(parseDmSwitchStateResponse(DEFAULT), DEFAULT);
  assert.deepEqual(parseDmSwitchStateResponse(UNREADABLE), UNREADABLE);
  for (const body of [
    null,
    "off",
    { killSwitch: "off", instances: DEFAULT.instances },
    { killSwitch: false },
    { killSwitch: false, instances: { "decision-maker-openai": "off" } },
    { killSwitch: false, instances: { ...DEFAULT.instances, "decision-maker-openai": "autonomous" } },
    { killSwitch: false, instances: { ...DEFAULT.instances, extra: "off" } },
  ]) {
    assert.equal(parseDmSwitchStateResponse(body), null, JSON.stringify(body));
  }
});

// ---------------------------------------------------------------------------
// The change flow: sent once, and nothing released before the state is re-read
// ---------------------------------------------------------------------------

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const FAILURE = { message: "refused", requiresReauthentication: false, approvalId: null } as unknown as AdminApiFailure;
const NETWORK = { message: "network", requiresReauthentication: false, approvalId: null } as unknown as AdminApiFailure;
const AFTER: typeof DEFAULT = { ...DEFAULT, killSwitch: true };

const flow = async (answer: () => Promise<Response>, readResult: typeof DEFAULT | null) => {
  const log: string[] = [];
  const updates: DmSwitchUpdate[] = [];
  let posts = 0;
  let reads = 0;
  const io: DmSwitchIo = {
    post: async () => {
      posts += 1;
      log.push("post");
      return answer();
    },
    read: async () => {
      reads += 1;
      log.push("read");
      return readResult;
    },
    failureOf: async () => FAILURE,
    networkFailure: () => NETWORK,
  };
  await runDmSwitchChange({ scope: "kill_switch", value: "on" }, io, (changes) => {
    updates.push(changes);
    log.push(`update:${Object.keys(changes).sort().join(",")}`);
  });
  return { log, updates, posts, reads };
};

const released = (updates: DmSwitchUpdate[]) =>
  updates.findIndex((changes) => "pending" in changes && changes.pending === null);

/** A response whose headers arrived and whose body then broke off. */
const brokenBody = (status: number) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error("connection reset"));
      },
    }),
    { status, headers: { "content-type": "application/json" } },
  );

for (const [label, answer] of [
  ["saved", () => Promise.resolve(json(200, { scope: "kill_switch", value: "on" }))],
  ["an unknown outcome", () => Promise.resolve(json(503, { error: "outcome_unknown" }))],
  ["no answer", () => Promise.reject(new TypeError("fetch failed"))],
  // Not proof of a rollback: the body that would have said so never arrived.
  ["a 503 whose body broke off", () => Promise.resolve(brokenBody(503))],
  ["a 503 that is not the route's", () => Promise.resolve(new Response("<html>Bad gateway</html>", { status: 503 }))],
  ["a 500", () => Promise.resolve(json(500, { error: "internal" }))],
  ["a 502 from a proxy", () => Promise.resolve(new Response("bad gateway", { status: 502 }))],
] as const) {
  test(`${label}: sent once, the state read again, and controls released only after that read`, async () => {
    const { updates, posts, reads, log } = await flow(answer, AFTER);
    assert.equal(posts, 1);
    assert.equal(reads, 1);
    // The read starts after the answer, and the state lands before release.
    assert.ok(log.indexOf("read") > log.indexOf("post"));
    const stateAt = updates.findIndex((changes) => "state" in changes);
    assert.ok(stateAt >= 0);
    assert.deepEqual(updates[stateAt]!.state, AFTER);
    assert.equal(released(updates), updates.length - 1);
    assert.ok(stateAt < released(updates));
    // While the read runs, the pending marker is the read, not nothing.
    assert.ok(updates.some((changes) => changes.pending === "reading"));
    const expected = label === "saved" ? "saved" : "outcome_unknown";
    assert.equal(updates[stateAt]!.notice, expected);
  });

  test(`${label}: a failed re-read leaves no state, and says the state was not read`, async () => {
    const { updates, posts } = await flow(answer, null);
    assert.equal(posts, 1);
    const stateAt = updates.findIndex((changes) => "state" in changes);
    assert.equal(updates[stateAt]!.state, null);
    assert.equal(updates[stateAt]!.notice, label === "saved" ? "saved_unread" : "outcome_unknown_unread");
    assert.ok(stateAt < released(updates));
  });
}

for (const [label, answer] of [
  ["a stale step-up", () => Promise.resolve(json(428, { code: "ADMIN_REAUTHENTICATION_REQUIRED" }))],
  ["a missing permission", () => Promise.resolve(json(403, { error: "Forbidden." }))],
  ["no session", () => Promise.resolve(json(404, { error: "Not found." }))],
  ["a bad body", () => Promise.resolve(json(400, { error: "Invalid request." }))],
  ["a bad body whose answer broke off", () => Promise.resolve(brokenBody(400))],
  ["an oversized body", () => Promise.resolve(json(413, { error: "Too large." }))],
  ["the rate limit", () => Promise.resolve(json(429, { error: "Too many requests." }))],
  ["a rolled-back change", () => Promise.resolve(json(503, { error: "switch_change_failed" }))],
] as const) {
  test(`${label}: nothing was written, so the state shown stands and nothing is re-read`, async () => {
    const { updates, posts, reads } = await flow(answer, AFTER);
    assert.equal(posts, 1);
    assert.equal(reads, 0);
    assert.equal(updates.some((changes) => "state" in changes), false);
    assert.ok(updates.some((changes) => changes.failure === FAILURE));
  });
}

test("an invalid value is said as such, writes nothing and reads nothing", async () => {
  const { updates, reads } = await flow(() => Promise.resolve(json(400, { error: "invalid_change" })), AFTER);
  assert.equal(reads, 0);
  assert.ok(updates.some((changes) => changes.notice === "invalid_change"));
});

test("reading again replaces the state, and a failed read leaves none", async () => {
  const run = async (result: typeof DEFAULT | null) => {
    const updates: DmSwitchUpdate[] = [];
    await runDmSwitchReread({ read: async () => result }, (changes) => updates.push(changes));
    return updates;
  };
  const ok = await run(AFTER);
  assert.deepEqual(ok.find((changes) => "state" in changes), { state: AFTER, notice: null });
  assert.deepEqual(ok.at(-1), { pending: null });
  const failed = await run(null);
  assert.deepEqual(failed.find((changes) => "state" in changes), { state: null });
});
