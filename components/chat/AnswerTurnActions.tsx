"use client";

import { useEffect, useState, useSyncExternalStore, type MouseEventHandler } from "react";
import { GitBranch, RotateCcw, Shuffle, Volume2, VolumeX } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { AnswerCreditsLabel } from "@/components/chat/AnswerCreditsLabel";
import { CHAT_MODEL_PICKER_CLOSED_EVENT } from "@/lib/chatModelPickerEvents";
import { decideArmedRegenerate, regenerateArmRecheckInMs } from "@/lib/chatRegenerateArm";
import {
  getSpeakingId,
  speechSupported,
  stopSpeaking,
  subscribeSpeaking,
  toggleSpeaking,
} from "@/lib/chatSpeech";
import { chatAnswerSurfaceCopy } from "@/locales/chatAnswerSurface";
import { chatTurnToolsCopy } from "@/locales/chatTurnTools";

const ACTION_CLASS =
  "inline-flex min-h-9 items-center gap-1.5 rounded-full px-2 text-[12px] font-semibold text-zinc-500 transition-colors hover:bg-zinc-200/70 hover:text-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-700/60 dark:hover:text-zinc-100";

const noopSubscribe = () => () => {};

/** What can be re-asked from the newest finished answer of a Chat conversation. */
export type AnswerRegenerate = {
  /** The same question again, as an ordinary new turn (credits as any turn). */
  onRegenerate: () => void;
  /** Opens the model picker; the answer is requested again once a model is chosen. */
  onOpenModelPicker?: MouseEventHandler<HTMLButtonElement>;
  currentModelId?: string | null;
  disabled?: boolean;
};

/** Start a new Chat conversation holding the turns up to this answer. */
export type AnswerBranch = {
  onBranch: () => void;
  pending: boolean;
  disabled?: boolean;
};

/**
 * The tools under a finished answer: read it aloud (any answer) and, on the
 * newest answer of a Chat conversation, ask for it again.
 *
 * Regenerating uses the ordinary send path, so it is checked, priced and
 * charged exactly like a question typed into the composer; nothing here calls
 * a model or touches credits itself.
 */
export function AnswerTurnActions({
  messageId,
  content,
  regenerate,
  branch,
  credits,
}: {
  messageId: string;
  content: string;
  regenerate?: AnswerRegenerate;
  branch?: AnswerBranch;
  /** What this answer was charged, once settled; absent shows nothing. */
  credits?: number;
}) {
  const { t, lang } = useLanguage();
  const copy = chatTurnToolsCopy[lang];
  const surfaceCopy = chatAnswerSurfaceCopy[lang];
  const canSpeak = useSyncExternalStore(noopSubscribe, speechSupported, () => false);
  const speakingId = useSyncExternalStore(subscribeSpeaking, getSpeakingId, () => null);
  const speaking = speakingId === messageId;
  const [armed, setArmed] = useState<{ modelId: string; at: number; closedAt: number | null } | null>(
    null
  );
  const waitingForModel = Boolean(regenerate && armed);
  const onRegenerate = regenerate?.onRegenerate;
  const currentModelId = regenerate?.currentModelId;

  useEffect(
    () => () => {
      if (getSpeakingId() === messageId) stopSpeaking();
    },
    [messageId]
  );

  // The wait is for the picker it opened: once that picker is closed, a model
  // picked later from the ordinary picker must not resend the question.
  const waiting = armed !== null;
  useEffect(() => {
    if (!waiting) return;
    const onPickerClosed = () =>
      setArmed((current) => (current && current.closedAt === null ? { ...current, closedAt: Date.now() } : current));
    window.addEventListener(CHAT_MODEL_PICKER_CLOSED_EVENT, onPickerClosed);
    return () => window.removeEventListener(CHAT_MODEL_PICKER_CLOSED_EVENT, onPickerClosed);
  }, [waiting]);

  useEffect(() => {
    if (!armed || !onRegenerate) return;
    const now = Date.now();
    const decision = decideArmedRegenerate({
      armedModelId: armed.modelId,
      currentModelId,
      armedAt: armed.at,
      now,
      pickerClosedAt: armed.closedAt,
    });
    // Acting from a timer callback, not the effect body: the wait ends (and the
    // question is sent again) as an event, one tick after the model changed.
    const timer = window.setTimeout(
      () => {
        setArmed(null);
        if (decision === "fire") onRegenerate();
      },
      decision === "wait"
        ? regenerateArmRecheckInMs({ armedAt: armed.at, now, pickerClosedAt: armed.closedAt })
        : 0
    );
    return () => window.clearTimeout(timer);
  }, [armed, currentModelId, onRegenerate]);

  if (!canSpeak && !regenerate && !branch && credits === undefined) return null;

  return (
    <div data-testid="chat-answer-turn-actions" className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-0.5">
      {canSpeak && (
        <button
          type="button"
          data-testid="chat-speak-answer"
          aria-pressed={speaking}
          onClick={() => toggleSpeaking(messageId, content, lang)}
          className={ACTION_CLASS}
        >
          {speaking ? (
            <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {speaking ? copy.stopSpeaking : copy.speak}
        </button>
      )}
      {regenerate && (
        <>
          <button
            type="button"
            data-testid="chat-regenerate-answer"
            onClick={() => {
              setArmed(null);
              regenerate.onRegenerate();
            }}
            disabled={regenerate.disabled}
            className={ACTION_CLASS}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            {t("chat.regenerate")}
          </button>
          {regenerate.onOpenModelPicker && (
            <button
              type="button"
              data-testid="chat-regenerate-another-model"
              onClick={(event) => {
                setArmed({ modelId: regenerate.currentModelId ?? "", at: Date.now(), closedAt: null });
                regenerate.onOpenModelPicker?.(event);
              }}
              disabled={regenerate.disabled}
              className={ACTION_CLASS}
            >
              <Shuffle className="h-3.5 w-3.5" aria-hidden="true" />
              {copy.retryAnotherModel}
            </button>
          )}
        </>
      )}
      {branch && (
        <button
          type="button"
          data-testid="chat-branch-answer"
          onClick={branch.onBranch}
          disabled={branch.disabled || branch.pending}
          aria-busy={branch.pending}
          className={ACTION_CLASS}
        >
          <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
          {branch.pending ? surfaceCopy.branchWorking : surfaceCopy.branchHere}
        </button>
      )}
      {credits !== undefined && <AnswerCreditsLabel credits={credits} />}
      {waitingForModel && (
        <span
          data-testid="chat-regenerate-waiting"
          className="inline-flex min-h-9 items-center gap-2 px-2 text-[12px] text-zinc-500 dark:text-zinc-400"
        >
          {copy.pickModelToRetry}
          <button
            type="button"
            onClick={() => setArmed(null)}
            className="rounded-full px-2 py-1 text-[12px] font-semibold underline hover:text-zinc-800 dark:hover:text-zinc-100"
          >
            {copy.cancel}
          </button>
        </span>
      )}
    </div>
  );
}
