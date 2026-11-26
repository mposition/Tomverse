"use client";

import { WandSparkles } from "lucide-react";
import { useStudioCopy } from "./StudioControls";
import styles from "./studio.module.css";

export function StudioGenerateButton({ label, busy, disabled, onClick }: {
  label: string; busy?: boolean; disabled?: boolean; onClick: () => void;
}) {
  const { copy } = useStudioCopy();
  return <button type="button" className={styles.primary} aria-busy={busy || undefined} disabled={busy || disabled} onClick={onClick}>
    <WandSparkles size={16} aria-hidden />{busy ? copy.generating : label}
  </button>;
}

// Studio names neither the model nor the credit price on screen (owner decision 2026-11-26); only a
// reason the button cannot be used is shown.
export function StudioQuoteHint({ error }: { error?: number }) {
  const { copy } = useStudioCopy();
  if (error) return <p className={styles.hint} role="status">{error === 401 ? copy.signInToGenerate : copy.generationUnavailable}</p>;
  return null;
}
