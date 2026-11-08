"use client";

import { useState, type ReactNode } from "react";

export type CopyWorkBriefOutcome = "copied" | "failed";

/**
 * Writes a work brief to the clipboard. Nothing reaches the server: the brief is
 * built in the browser from what the screen already shows. A missing clipboard
 * (an insecure origin, a refused permission) is a failure the button says out loud.
 */
export async function copyWorkBrief(
  clipboard: Pick<Clipboard, "writeText"> | undefined,
  text: string,
): Promise<CopyWorkBriefOutcome> {
  try {
    if (!clipboard) return "failed";
    await clipboard.writeText(text);
    return "copied";
  } catch {
    return "failed";
  }
}

/**
 * "Copy brief" beside an item's AMUX button: the text the AMUX send would make,
 * ready to paste into a local CLI while AMUX itself is not trusted to finish.
 */
export function AdminCopyWorkBriefButton({
  brief,
  labels,
  className,
  testId,
  icon,
}: {
  /** Built on press, so a list does not build every brief on each render. */
  brief: () => string;
  labels: { readonly copy: string; readonly copied: string; readonly failed: string };
  className: string;
  testId: string;
  icon?: ReactNode;
}) {
  const [outcome, setOutcome] = useState<CopyWorkBriefOutcome | null>(null);
  return (
    <>
      <button
        type="button"
        className={className}
        data-testid={testId}
        onClick={async () => setOutcome(await copyWorkBrief(globalThis.navigator?.clipboard, brief()))}
      >
        {icon}
        {outcome === "copied" ? labels.copied : labels.copy}
      </button>
      <span role="status" className={outcome === "failed" ? "text-xs text-red-300" : "sr-only"} data-testid={`${testId}-status`}>
        {outcome === "failed" ? labels.failed : outcome === "copied" ? labels.copied : ""}
      </span>
    </>
  );
}
