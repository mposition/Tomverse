import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DesktopRemoteView, type RemoteViewProps } from "@/components/remote/DesktopRemoteWorkspace";
import type { DesktopRemoteDevicesResponse } from "@/lib/desktopRemoteControlContract";

const TASK = "00000000-0000-4000-8000-000000000001";
const APPROVAL = "00000000-0000-4000-8000-000000000002";

const data = (over: { remote?: boolean; canAct?: boolean; canFollowUp?: boolean; kind?: "command" | "git"; devices?: [] } = {}): DesktopRemoteDevicesResponse => ({
  ok: true,
  canAct: over.canAct ?? true,
  devices: over.devices ?? [{
    deviceId: "device-1", label: "Work PC", updatedAt: "2026-11-26T04:00:00.000Z",
    snapshot: {
      tasks: [{ key: TASK, kind: "foreground", title: "Fix the login form", status: "approval", progress: ["I updated the form."], changes: 2,
        canStop: true, canFollowUp: over.canFollowUp ?? false }],
      approval: { id: APPROVAL, taskKey: TASK, digest: "a".repeat(64), kind: over.kind ?? "command", tool: "run_command",
        target: over.kind === "git" ? "" : "npm test", files: [], moreFiles: 0, remote: over.remote ?? true },
    },
    commands: [],
  }],
});

const props = (over: Partial<RemoteViewProps> = {}): RemoteViewProps => ({
  language: "en", state: { kind: "ready", data: data() }, deviceId: null, taskKey: null, busy: false, message: null, stopArmed: false, draft: "",
  onSelectDevice: () => {}, onSelectTask: () => {}, onAnswer: () => {}, onStop: () => {}, onDraft: () => {}, onSendFollowUp: () => {}, onSignInAgain: () => {},
  ...over,
});

const disabled = (html: string, testId: string) => new RegExp(`<button[^>]*disabled=""[^>]*data-testid="${testId}"|<button[^>]*data-testid="${testId}"[^>]*disabled=""`).test(html);

test("the PC list names each PC, how many tasks run and whether one waits for an answer", () => {
  const html = renderToStaticMarkup(<DesktopRemoteView {...props()} />);
  assert.match(html, /Your PCs/);
  assert.match(html, /Work PC/);
  assert.match(html, /1 running/);
  assert.match(html, /Waiting for your approval/);
  const empty = renderToStaticMarkup(<DesktopRemoteView {...props({ state: { kind: "ready", data: data({ devices: [] }) } })} />);
  assert.match(empty, /data-testid="remote-empty"/);
  assert.match(renderToStaticMarkup(<DesktopRemoteView {...props({ state: { kind: "unavailable" } })} />), /Remote control is not available/);
});

test("a request answerable from here shows what is approved, with allow once and deny at the bottom", () => {
  const html = renderToStaticMarkup(<DesktopRemoteView {...props({ deviceId: "device-1", taskKey: TASK })} />);
  assert.match(html, /Approval request · Run a command/);
  assert.match(html, /data-testid="remote-approval-target"[^>]*>npm test</);
  assert.match(html, /data-testid="remote-allow-once"/);
  assert.match(html, /data-testid="remote-deny"/);
  assert.match(html, /data-testid="remote-stop"/);
  assert.match(html, /I updated the form\./);
  assert.match(html, /2 files changed/);
  assert.equal(disabled(html, "remote-allow-once"), false);
  // There is no "allow for this run" from another device.
  assert.doesNotMatch(html, /for this run/i);
  // No follow-up box for a task that cannot take one.
  assert.doesNotMatch(html, /data-testid="remote-follow-up"/);
  const followUp = renderToStaticMarkup(<DesktopRemoteView {...props({ deviceId: "device-1", taskKey: TASK, state: { kind: "ready", data: data({ canFollowUp: true }) } })} />);
  assert.match(followUp, /data-testid="remote-follow-up"/);
});

test("a request answered at the PC says so and offers no answer buttons", () => {
  for (const over of [{ remote: false }, { kind: "git" as const, remote: false }]) {
    const html = renderToStaticMarkup(<DesktopRemoteView {...props({ deviceId: "device-1", taskKey: TASK, state: { kind: "ready", data: data(over) } })} />);
    assert.match(html, /data-testid="remote-pc-only"[^>]*>Confirm on the PC/);
    assert.doesNotMatch(html, /data-testid="remote-allow-once"/);
    assert.doesNotMatch(html, /data-testid="remote-deny"/);
  }
});

test("a session that is not recently signed in may only look", () => {
  const html = renderToStaticMarkup(<DesktopRemoteView {...props({ deviceId: "device-1", taskKey: TASK, state: { kind: "ready", data: data({ canAct: false }) } })} />);
  assert.match(html, /data-testid="remote-view-only"/);
  assert.match(html, /Sign in again/);
  assert.equal(disabled(html, "remote-allow-once"), true);
  assert.equal(disabled(html, "remote-deny"), true);
  assert.equal(disabled(html, "remote-stop"), true);
});

test("the screen reads in the account's language", () => {
  const html = renderToStaticMarkup(<DesktopRemoteView {...props({ language: "ko", deviceId: "device-1", taskKey: TASK })} />);
  assert.match(html, /한 번 허용/);
  assert.match(html, /거부/);
  assert.match(html, /작업 멈추기/);
  const pcOnly = renderToStaticMarkup(<DesktopRemoteView {...props({ language: "ko", deviceId: "device-1", taskKey: TASK, state: { kind: "ready", data: data({ remote: false }) } })} />);
  assert.match(pcOnly, /PC에서 확인 필요/);
});

const withPasskeys = (passkey: DesktopRemoteDevicesResponse["passkey"], over: Parameters<typeof data>[0] = {}): DesktopRemoteDevicesResponse => ({ ...data(over), passkey });
const KEYS = [{ id: "00000000-0000-4000-8000-0000000000aa", label: "My phone", createdAt: "2026-11-20T01:00:00.000Z", lastUsedAt: null }];

test("a file change shows its line counts and, when the PC sent them, the redacted changed lines", () => {
  const response = data();
  const device = response.devices[0]!;
  device.snapshot.approval = { ...device.snapshot.approval!, kind: "files", target: "", files: [
    { path: "src/a.ts", action: "update", added: 3, removed: 1, preview: ["- const x = 1;", "+ const x = 2;"] },
    { path: ".env", action: "update", omitted: "secret" },
    { path: "src/old.ts", action: "update" },
  ] };
  const html = renderToStaticMarkup(<DesktopRemoteView {...props({ deviceId: "device-1", taskKey: TASK, state: { kind: "ready", data: response } })} />);
  assert.match(html, /data-testid="remote-approval-counts"[^>]*>3 added, 1 removed</);
  assert.match(html, /data-testid="remote-approval-preview"[^>]*>- const x = 1;\n\+ const x = 2;</);
  assert.match(html, /Changed lines \(redacted/);
  assert.match(html, /data-testid="remote-approval-omitted"[^>]*>This file may hold credentials: no preview</);
  // A file from a PC that sent no counts shows only its path.
  assert.equal((html.match(/data-testid="remote-approval-counts"/g) ?? []).length, 1);
});

test("passkeys: the panel lists the account's passkeys and offers adding; nothing appears while the server offers none", () => {
  const none = renderToStaticMarkup(<DesktopRemoteView {...props({ state: { kind: "ready", data: data() } })} />);
  assert.doesNotMatch(none, /data-testid="remote-passkeys"/);
  const off = renderToStaticMarkup(<DesktopRemoteView {...props({ state: { kind: "ready", data: withPasskeys({ enabled: false, passkeys: [] }) } })} />);
  assert.doesNotMatch(off, /data-testid="remote-passkeys"/);
  const empty = renderToStaticMarkup(<DesktopRemoteView {...props({ state: { kind: "ready", data: withPasskeys({ enabled: true, passkeys: [] }) } })} />);
  assert.match(empty, /data-testid="remote-passkey-none"/);
  assert.match(empty, /data-testid="remote-passkey-add"/);
  assert.equal(disabled(empty, "remote-passkey-add"), true, "a name is needed first");
  const some = renderToStaticMarkup(<DesktopRemoteView {...props({ passkeyName: "Laptop", state: { kind: "ready", data: withPasskeys({ enabled: true, passkeys: KEYS }) } })} />);
  assert.match(some, /My phone/);
  assert.match(some, /Not used yet/);
  assert.equal(disabled(some, "remote-passkey-add"), false);
  const armed = renderToStaticMarkup(<DesktopRemoteView {...props({ removeArmed: KEYS[0]!.id, state: { kind: "ready", data: withPasskeys({ enabled: true, passkeys: KEYS }) } })} />);
  assert.match(armed, /Tap again to remove/);
  const viewOnly = renderToStaticMarkup(<DesktopRemoteView {...props({ state: { kind: "ready", data: { ...withPasskeys({ enabled: true, passkeys: KEYS }), canAct: false } } })} />);
  assert.equal(disabled(viewOnly, "remote-passkey-remove"), true);
  const five = renderToStaticMarkup(<DesktopRemoteView {...props({ state: { kind: "ready", data: withPasskeys({ enabled: true, passkeys: Array.from({ length: 5 }, (_, index) => ({ ...KEYS[0]!, id: `00000000-0000-4000-8000-0000000001${index}0`, label: `Key ${index}` })) }) } })} />);
  assert.doesNotMatch(five, /data-testid="remote-passkey-add"/);
});

test("passkeys: an account that has one is told that allow once and follow-ups are confirmed with it; deny and stop are not", () => {
  const withKey = props({ deviceId: "device-1", taskKey: TASK, state: { kind: "ready", data: withPasskeys({ enabled: true, passkeys: KEYS }, { canFollowUp: true }) } });
  const html = renderToStaticMarkup(<DesktopRemoteView {...withKey} />);
  assert.match(html, /data-testid="remote-passkey-needed"[^>]*>Confirm with your passkey</);
  assert.match(html, /data-testid="remote-follow-up-send"[^>]*>Send · Confirm with your passkey</);
  assert.match(html, /data-testid="remote-deny"/);
  assert.match(html, /data-testid="remote-stop"/);
  const without = renderToStaticMarkup(<DesktopRemoteView {...props({ deviceId: "device-1", taskKey: TASK, state: { kind: "ready", data: withPasskeys({ enabled: true, passkeys: [] }, { canFollowUp: true }) } })} />);
  assert.doesNotMatch(without, /data-testid="remote-passkey-needed"/);
  // Switched off at the server: no passkey is asked for even if one was registered before.
  const switchedOff = renderToStaticMarkup(<DesktopRemoteView {...props({ deviceId: "device-1", taskKey: TASK, state: { kind: "ready", data: withPasskeys({ enabled: false, passkeys: [] }) } })} />);
  assert.doesNotMatch(switchedOff, /data-testid="remote-passkey-needed"/);
});
