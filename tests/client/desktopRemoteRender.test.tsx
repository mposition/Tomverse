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
