"use client";

import { useCallback, useState } from "react";
import { Check, ThumbsDown, ThumbsUp, Type } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import {
  applyImageSignalToState,
  sendImageGenerationSignal,
  type ImageGenerationUserSignalKind,
} from "@/lib/imageGenerationSignalsCore";
import type { ImageGenerationSignalKind } from "@/lib/imageRoutingCore";

/**
 * What a person says about one generated image, recorded for the image routing
 * measurement (POST /api/images/generations/[id]/signal). Every control here
 * is quiet: it flips optimistically and, if the server refuses, flips back
 * without a message. A signal is never worth interrupting a person for.
 */

const controlClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-xl border px-3 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-60";
const idleClass =
  "border-zinc-200 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";
const pressedClass =
  "border-accent-image-300 bg-accent-image-50 text-accent-image-800 dark:border-accent-image-800 dark:bg-accent-image-950/40 dark:text-accent-image-200";

/** Thumbs up, thumbs down and "I wanted a text answer" for one succeeded image. */
export function ImageFeedbackButtons({ generationId }: { generationId: string }) {
  const { t } = useLanguage();
  const [active, setActive] = useState<ImageGenerationSignalKind[]>([]);
  const [busy, setBusy] = useState(false);

  const press = async (kind: ImageGenerationUserSignalKind) => {
    if (busy) return;
    const previous = active;
    const nextActive = !previous.includes(kind);
    setBusy(true);
    setActive(applyImageSignalToState(previous, kind, nextActive));
    const accepted = await sendImageGenerationSignal(generationId, kind, nextActive);
    if (!accepted) setActive(previous);
    setBusy(false);
  };

  const items: { kind: ImageGenerationUserSignalKind; label: string; icon: React.ReactNode; testId: string }[] = [
    {
      kind: "helpful",
      label: t("chat.imageSignalHelpful"),
      icon: <ThumbsUp className="h-4 w-4" aria-hidden="true" />,
      testId: "image-signal-helpful",
    },
    {
      kind: "not_helpful",
      label: t("chat.imageSignalNotHelpful"),
      icon: <ThumbsDown className="h-4 w-4" aria-hidden="true" />,
      testId: "image-signal-not-helpful",
    },
  ];
  const wantedText = active.includes("wanted_text");

  return (
    <div
      role="group"
      aria-label={t("chat.imageSignalGroupLabel")}
      data-testid="image-signal-feedback"
      className="mt-2 flex flex-wrap items-center gap-2"
    >
      {items.map((item) => (
        <button
          key={item.kind}
          type="button"
          data-testid={item.testId}
          aria-pressed={active.includes(item.kind)}
          aria-label={item.label}
          title={item.label}
          disabled={busy}
          onClick={() => void press(item.kind)}
          className={`${controlClass} ${active.includes(item.kind) ? pressedClass : idleClass}`}
        >
          {item.icon}
        </button>
      ))}
      <button
        type="button"
        data-testid="image-signal-wanted-text"
        aria-pressed={wantedText}
        disabled={busy}
        onClick={() => void press("wanted_text")}
        className={`${controlClass} ${wantedText ? pressedClass : idleClass}`}
      >
        <Type className="h-4 w-4" aria-hidden="true" />
        {t("chat.imageSignalWantedText")}
      </button>
    </div>
  );
}

/**
 * The one result a person chose in a comparison, per group. Choosing another
 * moves the choice; a refused choice goes back to what it was.
 */
export function useImageResultSelection() {
  const [selection, setSelection] = useState<Record<string, string>>({});

  const select = useCallback(
    async (groupKey: string, generationId: string) => {
      const previous = selection[groupKey];
      if (previous === generationId) return;
      setSelection((current) => ({ ...current, [groupKey]: generationId }));
      const accepted = await sendImageGenerationSignal(generationId, "selected", true);
      if (accepted) return;
      setSelection((current) => {
        const next = { ...current };
        if (previous) next[groupKey] = previous;
        else delete next[groupKey];
        return next;
      });
    },
    [selection]
  );

  return { selection, select };
}

/** "Choose this result" under one model's image in a multi-model comparison. */
export function ImageSelectButton({
  selected,
  onSelect,
}: {
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useLanguage();
  return (
    <button
      type="button"
      data-testid="image-signal-select"
      aria-pressed={selected}
      onClick={onSelect}
      className={`${controlClass} self-start ${selected ? pressedClass : idleClass}`}
    >
      {selected ? <Check className="h-4 w-4" aria-hidden="true" /> : null}
      {selected ? t("chat.imageSignalSelected") : t("chat.imageSignalSelect")}
    </button>
  );
}
