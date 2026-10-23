"use client";

import { useId, useState } from "react";
import { Download } from "lucide-react";
import { pwaInstallCopy } from "../../locales/pwaInstall";
import type { usePwaInstall } from "./usePwaInstall";

export function PwaInstallMenuItem({ install, language, onPrompt }: {
  install: ReturnType<typeof usePwaInstall>;
  language: string;
  onPrompt?: () => void;
}) {
  const [showInstructions, setShowInstructions] = useState(false);
  const instructionsId = useId();
  if (install.mode === "unavailable") return null;
  const copy = pwaInstallCopy(language);
  return <>
    <button type="button" data-testid="account-install-app"
      aria-expanded={install.mode === "ios" ? showInstructions : undefined}
      aria-controls={install.mode === "ios" && showInstructions ? instructionsId : undefined}
      className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-sm font-bold text-zinc-700 transition hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-zinc-200 dark:hover:bg-zinc-800"
      onClick={() => {
        if (install.mode === "ios") { setShowInstructions((value) => !value); return; }
        void install.requestInstall();
        onPrompt?.();
      }}>
      <Download className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
      <span className="min-w-0">{copy.install}</span>
    </button>
    {install.mode === "ios" && showInstructions &&
      <p id={instructionsId} role="status" className="px-3 py-2 text-xs leading-5 text-zinc-600 dark:text-zinc-400">{copy.iosInstructions}</p>}
  </>;
}
