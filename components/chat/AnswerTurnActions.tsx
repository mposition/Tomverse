"use client";

import { useEffect, useState, useSyncExternalStore, type MouseEventHandler } from "react";
import { RotateCcw, Shuffle, Volume2, VolumeX } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { decideArmedRegenerate, REGENERATE_ARM_TTL_MS } from "@/lib/chatRegenerateArm";
import {
  getSpeakingId,
  speechSupported,
  stopSpeaking,
  subscribeSpeaking,
  toggleSpeaking,
} from "@/lib/chatSpeech";
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
}: {
  messageId: string;
  content: string;
  regenerate?: AnswerRegenerate;
}) {
  const { t, lang } = useLanguage();
  const copy = chatTurnToolsCopy[lang];
  const canSpeak = useSyncExternalStore(noopSubscribe, speechSupported, () => false);
  const speakingId = useSyncExternalStore(subscribeSpeaking, getSpeakingId, () => null);
  const speaking = speakingId === messageId;
  const [armed, setArmed] = useState<{ modelId: string; at: number } | null>(null);
  const waitingForModel = Boolean(regenerate && armed);
  const onRegenerate = regenerate?.onRegenerate;
  const currentModelId = regenerate?.currentModelId;

  useEffect(
    () => () => {
      if (getSpeakingId() === messageId) stopSpeaking();
    },
    [messageId]
  );

  useEffect(() => {
    if (!armed || !onRegenerate) return;
    const decision = decideArmedRegenerate({
      armedModelId: armed.modelId,
      currentModelId,
      armedAt: armed.at,
      now: Date.now(),
    });
    // Acting from a timer callback, not the effect body: the wait ends (and the
    // question is sent again) as an event, one tick after the model changed.
    const timer = window.setTimeout(
      () => {
        setArmed(null);
        if (decision === "fire") onRegenerate();
      },
      decision === "wait" ? Math.max(0, REGENERATE_ARM_TTL_MS - (Date.now() - armed.at)) : 0
    );
    return () => window.clearTimeout(timer);
  }, [armed, currentModelId, onRegenerate]);

  if (!canSpeak && !regenerate) return null;

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
                setArmed({ modelId: regenerate.currentModelId ?? "", at: Date.now() });
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
