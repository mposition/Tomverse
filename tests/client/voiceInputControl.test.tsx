import assert from "node:assert/strict";
import test from "node:test";

import type { ReactNode } from "react";

import {
  VoiceInputButton,
  VoiceInputStatus,
} from "@/components/chat/VoiceInputControl";
import { resolveVoiceInputCopy } from "@/components/chat/voiceInputCopy";
import { ko } from "@/locales/ko";

/**
 * What the voice controls render in each state: docs/policy/voice-input.md §8.3.
 *
 * ## Why the components are called rather than rendered
 *
 * The same reason `tests/client/autoRoutingRender.test.tsx` gives: the unit
 * runner passes `--conditions=react-server`, under which `react-dom/server`
 * refuses to load. These are plain function components, so calling one *is*
 * rendering it for the purpose of these claims — "renders nothing" is `null`,
 * and a component that returns `null` cannot leave a row height behind, which
 * is exactly the mobile-composer property at stake.
 */

/**
 * Real Korean copy, resolved the way the composer resolves it.
 *
 * Not a stub returning the key: half of what these tests check is that the
 * right *sentence* reaches the right state, and a stub would make every state
 * look correct as long as it named some key.
 */
const copy = resolveVoiceInputCopy({
  t: (key: string) => {
    const value = key
      .split(".")
      .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], ko);
    assert.equal(typeof value, "string", `missing key ${key}`);
    return value as string;
  },
});

const walk = (node: ReactNode, visit: (element: Record<string, unknown>) => void) => {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const element = node as { props?: Record<string, unknown> };
  if (!element.props) return;
  visit(element.props);
  walk(element.props.children as ReactNode, visit);
};

const propsOf = (node: ReactNode) => {
  const found: Record<string, unknown>[] = [];
  walk(node, (props) => found.push(props));
  return found;
};

const textOf = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const element = node as { props?: { children?: ReactNode } };
  return element.props ? textOf(element.props.children) : "";
};

const findByTestId = (node: ReactNode, testId: string) =>
  propsOf(node).find((props) => props["data-testid"] === testId) ?? null;

test("the status row renders nothing at rest", () => {
  const rendered = VoiceInputStatus({
    copy,
    state: { status: "idle" },
    elapsedSeconds: 0,
    serverCode: null,
    onCancel: () => {},
    onDismissError: () => {},
  });

  assert.equal(
    rendered,
    null,
    "an idle status row must cost no height above the textarea"
  );
});

test("the recording state shows the elapsed time and a way out", () => {
  const rendered = VoiceInputStatus({
    copy,
    state: { status: "recording", sessionId: 1, elapsedMs: 65_000, stoppedByLimit: false },
    elapsedSeconds: 65,
    serverCode: null,
    onCancel: () => {},
    onDismissError: () => {},
  });

  const text = textOf(rendered);
  // The copy key carries `{time}`; the component substitutes it.
  assert.ok(text.includes("1:05"), `expected an elapsed time, got: ${text}`);
  assert.ok(
    findByTestId(rendered, "voice-input-cancel"),
    "a recording must always offer a way to throw it away"
  );
  assert.ok(text.includes(ko.chat.voicePrivacyNote));
});

test("cancel stays available while the server is working", () => {
  // A user who has changed their mind mid-transcription is entitled to stop
  // waiting; the transcript that arrives afterwards is dropped.
  const rendered = VoiceInputStatus({
    copy,
    state: { status: "transcribing", sessionId: 1, elapsedMs: 3000 },
    elapsedSeconds: 3,
    serverCode: null,
    onCancel: () => {},
    onDismissError: () => {},
  });

  assert.ok(findByTestId(rendered, "voice-input-cancel"));
  assert.ok(textOf(rendered).includes(ko.chat.voiceTranscribing));
});

test("the limit is announced as itself, not as a generic conversion", () => {
  const rendered = VoiceInputStatus({
    copy,
    state: { status: "stopping", sessionId: 1, elapsedMs: 120_000, stoppedByLimit: true },
    elapsedSeconds: 120,
    serverCode: null,
    onCancel: () => {},
    onDismissError: () => {},
  });

  assert.ok(textOf(rendered).includes(ko.chat.voiceLimitReached));
});

test("the elapsed time never runs past the limit on screen", () => {
  const rendered = VoiceInputStatus({
    copy,
    state: { status: "recording", sessionId: 1, elapsedMs: 999_999, stoppedByLimit: false },
    elapsedSeconds: 9999,
    serverCode: null,
    onCancel: () => {},
    onDismissError: () => {},
  });

  assert.ok(textOf(rendered).includes("2:00"));
});

test("the server's own refusal code wins over the machine's generic one", () => {
  const rendered = VoiceInputStatus({
    copy,
    state: {
      status: "error",
      code: "VOICE_TRANSCRIPTION_FAILED",
      serverCode: "VOICE_OPERATIONAL_LIMIT_REACHED",
    },
    elapsedSeconds: 0,
    serverCode: "VOICE_OPERATIONAL_LIMIT_REACHED",
    onCancel: () => {},
    onDismissError: () => {},
  });

  const text = textOf(rendered);
  assert.ok(
    text.includes(ko.chat.voiceErrorLimitReached),
    `expected the limit sentence, got: ${text}`
  );
  assert.ok(!text.includes(ko.chat.voiceErrorTranscriptionFailed));
});

test("an error is announced and can be dismissed", () => {
  const rendered = VoiceInputStatus({
    copy,
    state: { status: "error", code: "VOICE_PERMISSION_DENIED", serverCode: null },
    elapsedSeconds: 0,
    serverCode: null,
    onCancel: () => {},
    onDismissError: () => {},
  });

  const error = findByTestId(rendered, "voice-input-error");
  assert.ok(error);
  assert.equal(error.role, "alert");
  assert.equal(error["data-voice-error-code"], "VOICE_PERMISSION_DENIED");
  assert.ok(findByTestId(rendered, "voice-input-error-dismiss"));
  assert.ok(textOf(rendered).includes(ko.chat.voiceErrorPermissionDenied));
});

test("the button names what it will do, and says so to assistive tech", () => {
  const idle = VoiceInputButton({
    copy,
    state: { status: "idle" },
    isMobileShell: false,
    disabled: false,
    onStart: () => {},
    onStop: () => {},
  });
  const recording = VoiceInputButton({
    copy,
    state: { status: "recording", sessionId: 1, elapsedMs: 0, stoppedByLimit: false },
    isMobileShell: false,
    disabled: false,
    onStart: () => {},
    onStop: () => {},
  });

  const idleProps = findByTestId(idle, "composer-voice-button");
  const recordingProps = findByTestId(recording, "composer-voice-button");

  assert.equal(idleProps?.["aria-label"], ko.chat.voiceStart);
  assert.equal(idleProps?.["aria-pressed"], false);
  assert.equal(recordingProps?.["aria-label"], ko.chat.voiceStop);
  assert.equal(recordingProps?.["aria-pressed"], true);
  assert.equal(
    recordingProps?.["aria-describedby"],
    "voice-input-status",
    "a recording button must point at the status it is describing"
  );
});

test("the button keeps a 44px touch target on the mobile shell", () => {
  const mobile = findByTestId(
    VoiceInputButton({
      copy,
      state: { status: "idle" },
      isMobileShell: true,
      disabled: false,
      onStart: () => {},
      onStop: () => {},
    }),
    "composer-voice-button"
  );

  // 11 × 4px = 44px, the floor the mobile composer contract sets.
  assert.match(String(mobile?.className), /h-11 w-11/);
});

test("the button is unavailable while the machine is between states", () => {
  for (const state of [
    { status: "permission_pending" as const, sessionId: 1 },
    { status: "stopping" as const, sessionId: 1, elapsedMs: 0, stoppedByLimit: false },
    { status: "transcribing" as const, sessionId: 1, elapsedMs: 0 },
  ]) {
    const props = findByTestId(
      VoiceInputButton({
        copy,
        state,
        isMobileShell: false,
        disabled: false,
        onStart: () => {},
        onStop: () => {},
      }),
      "composer-voice-button"
    );
    assert.equal(props?.disabled, true, state.status);
  }
});

test("a disabled composer disables the microphone", () => {
  const props = findByTestId(
    VoiceInputButton({
      copy,
      state: { status: "idle" },
      isMobileShell: false,
      disabled: true,
      onStart: () => {},
      onStop: () => {},
    }),
    "composer-voice-button"
  );

  assert.equal(props?.disabled, true);
});
