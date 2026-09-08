"use client";

import { Loader2, Mic, Square, X } from "lucide-react";

import type { VoiceInputCopy } from "@/components/chat/voiceInputCopy";
import { VOICE_CLIP_MAX_SECONDS } from "@/lib/voiceInputFormats";
import type { VoiceRecorderState } from "@/lib/voiceRecorderMachine";

/**
 * The composer's microphone, and the row that says what it is doing.
 *
 * Contract: docs/policy/voice-input.md §8.3, and
 * docs/ui-contracts/mobile-chat-composer.md, which this must not break.
 *
 * ## Two exports, because the contract has two places
 *
 * The mobile composer contract's anatomy is a status row, then the textarea's
 * own full-width row, then the actions row. A voice control is both a button
 * and a running status, and putting the status beside the button would put it
 * in the actions row where it would grow, wrap and eventually push Send out of
 * a 320px composer.
 *
 * So the *button* goes in the actions row with the other 44px controls, and
 * the *status* goes in the status row above the textarea, where the web-search
 * and deep-research chips already live. Neither ever enters the textarea's
 * row, overlays it, or takes width from it — the invariant that makes a change
 * here a release blocker.
 *
 * ## Copy arrives as a prop
 *
 * `components/chat/voiceInputCopy.ts` resolves it. These stay plain functions
 * of their arguments, which is the only way the unit lane can execute them —
 * see that file, and `tests/client/voiceInputControl.test.tsx`.
 *
 * ## No accent role
 *
 * Voice input claims none of the reserved hues (AGENTS.md, "Accent colour
 * roles"). Recording uses `red`, which is a status colour owned by its own
 * convention and outside the guarded set; everything else is the neutral
 * zinc/blue palette. A new role token would have been a colour decision this
 * feature does not need and a fourth thing to keep in step.
 */

const formatElapsed = (seconds: number) => {
  const clamped = Math.max(0, Math.min(seconds, VOICE_CLIP_MAX_SECONDS));
  const minutes = Math.floor(clamped / 60);
  return `${minutes}:${String(clamped % 60).padStart(2, "0")}`;
};

export type VoiceInputButtonProps = {
  state: VoiceRecorderState;
  copy: VoiceInputCopy;
  isMobileShell: boolean;
  /** The composer's own disabled state — a sending turn, a locked chat. */
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
};

export function VoiceInputButton({
  state,
  copy,
  isMobileShell,
  disabled,
  onStart,
  onStop,
}: VoiceInputButtonProps) {
  const isRecording = state.status === "recording";
  const isPending =
    state.status === "permission_pending" ||
    state.status === "stopping" ||
    state.status === "transcribing";

  // One button with two meanings rather than two buttons, because at any
  // moment exactly one of them is available and a permanently disabled Stop
  // would be a control that never does anything. The accessible name changes
  // with the meaning, so a screen reader is never told "record" about a
  // control that stops.
  const label = isRecording ? copy.stop : copy.start;

  return (
    <button
      type="button"
      data-testid="composer-voice-button"
      data-voice-status={state.status}
      onClick={isRecording ? onStop : onStart}
      // Disabled while the machine is between states: pressing again would be
      // a second recording started on top of one that has not finished
      // releasing the microphone.
      disabled={disabled || isPending}
      aria-label={label}
      title={label}
      aria-describedby={
        state.status === "recording" ? "voice-input-status" : undefined
      }
      aria-pressed={isRecording}
      className={`flex shrink-0 touch-manipulation items-center justify-center rounded-full border transition disabled:cursor-not-allowed disabled:opacity-50 ${
        isMobileShell ? "h-11 w-11" : "h-10 w-10"
      } ${
        isRecording
          ? "border-red-300 bg-red-50 text-red-600 hover:bg-red-100 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400"
          : "border-zinc-300 bg-zinc-50 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white"
      }`}
    >
      {isPending ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : isRecording ? (
        <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
      ) : (
        <Mic className="h-5 w-5" aria-hidden="true" />
      )}
    </button>
  );
}

export type VoiceInputStatusProps = {
  state: VoiceRecorderState;
  copy: VoiceInputCopy;
  elapsedSeconds: number;
  serverCode: string | null;
  onCancel: () => void;
  onDismissError: () => void;
};

/**
 * The row above the textarea. Renders nothing at rest, so it costs no height
 * in the state the composer is in almost all of the time.
 */
export function VoiceInputStatus({
  state,
  copy,
  elapsedSeconds,
  serverCode,
  onCancel,
  onDismissError,
}: VoiceInputStatusProps) {
  if (state.status === "idle") return null;

  if (state.status === "error") {
    // The server's own code wins over the machine's generic one: the machine
    // knows the request failed, the server knows why, and "microphone is
    // blocked" and "you have reached today's limit" have nothing in common
    // except that both arrive here.
    const sentence = copy.errorFor(serverCode || state.code);
    return (
      <div
        data-testid="voice-input-error"
        data-voice-error-code={serverCode || state.code}
        className="flex w-full min-w-0 flex-wrap items-center gap-2 rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300"
        // `alert`, not a polite live region: this replaces a control the user
        // just pressed, and they are waiting for exactly this answer.
        role="alert"
      >
        <span className="min-w-0 flex-1 break-words">{sentence}</span>
        <button
          type="button"
          data-testid="voice-input-error-dismiss"
          onClick={onDismissError}
          aria-label={copy.dismissError}
          title={copy.dismissError}
          // 44px hit area through an inset pseudo-element rather than a 44px
          // box: a full-size button here would set the row's height and push
          // the textarea down on a short viewport.
          className="relative shrink-0 rounded p-1 before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] hover:bg-red-100 dark:hover:bg-red-900/40"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    );
  }

  const message =
    state.status === "permission_pending"
      ? copy.requestingPermission
      : state.status === "transcribing"
        ? copy.transcribing
        : state.status === "stopping" && state.stoppedByLimit
          ? copy.limitReached
          : state.status === "stopping"
            ? copy.transcribing
            : copy.recording.replace(
                "{time}",
                formatElapsed(elapsedSeconds)
              );

  return (
    <div
      data-testid="voice-input-status-row"
      data-voice-status={state.status}
      className="flex w-full min-w-0 flex-wrap items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300"
    >
      <span
        id="voice-input-status"
        // Polite rather than assertive: the elapsed time updates every second,
        // and an assertive region would interrupt a screen-reader user
        // continuously for the whole recording.
        aria-live="polite"
        className="flex min-w-0 items-center gap-1.5"
      >
        {state.status === "recording" ? (
          <span
            aria-hidden="true"
            className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-600"
          />
        ) : (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
        )}
        <span className="truncate font-medium">{message}</span>
      </span>

      {/*
        Cancel is a separate control from the button in the actions row, and
        stays available through transcribing: stop means "use this", cancel
        means "throw it away", and a single control that meant both depending
        on how long you held it would be the one place in this flow where a
        mistake is unrecoverable.
      */}
      <button
        type="button"
        data-testid="voice-input-cancel"
        onClick={onCancel}
        aria-label={copy.cancel}
        title={copy.cancel}
        className="relative shrink-0 rounded-full border border-zinc-300 px-2 py-0.5 font-semibold text-zinc-600 transition before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        {copy.cancel}
      </button>

      {/*
        Where the audio goes, said where the recording happens rather than only
        in the privacy policy (docs/policy/voice-input.md §11.4). The same rule
        the attachment contract applies to guest files: a promise about data
        belongs at the point the data is created.
      */}
      <span className="w-full text-[11px] text-zinc-500 dark:text-zinc-400">
        {copy.privacyNote}
      </span>
    </div>
  );
}
