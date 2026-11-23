"use client";

import { WandSparkles } from "lucide-react";
import { useStudioCopy } from "./StudioControls";
import type { StudioImageQuote } from "./studioGenerationClient";
import styles from "./studio.module.css";

export function StudioGenerateButton({ label, busy, disabled, onClick }: {
  label: string; busy?: boolean; disabled?: boolean; onClick: () => void;
}) {
  const { copy } = useStudioCopy();
  return <button type="button" className={styles.primary} aria-busy={busy || undefined} disabled={busy || disabled} onClick={onClick}>
    <WandSparkles size={16} aria-hidden />{busy ? copy.generating : label}
  </button>;
}

export function StudioQuoteHint({ quote, error }: { quote?: StudioImageQuote; error?: number }) {
  const { copy, lang } = useStudioCopy();
  if (quote) {
    return <p className={styles.hint}>{copy.generationCredits
      .replace("{model}", quote.model)
      .replace("{credits}", quote.credits.toLocaleString(lang))}</p>;
  }
  if (error) return <p className={styles.hint} role="status">{error === 401 ? copy.signInToGenerate : copy.generationUnavailable}</p>;
  return null;
}
