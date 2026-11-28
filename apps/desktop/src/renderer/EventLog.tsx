import { useState } from "react";
import type { Language } from "../../../../lib/language";
import { desktopEvidenceCopy } from "../../../../locales/desktopEvidence";

export function EventEntry({ text }: { text: string }) {
  return <details><summary>{text.split("\n")[0]?.slice(0, 100)}</summary><pre>{text}</pre></details>;
}

type LogResult = "diagnosticsSaved" | "diagnosticsCopied" | "diagnosticsSaveFailed" | "diagnosticsCopyFailed";

export function EventLogExport({ language }: { language: Language }) {
  const copy = desktopEvidenceCopy[language];
  const [state, setState] = useState<LogResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function share(action: "save" | "copy") {
    setBusy(true);
    setState(null);
    try {
      const done = action === "save" ? await window.desktop.exportDiagnostics() : await window.desktop.copyDiagnostics();
      if (done) setState(action === "save" ? "diagnosticsSaved" : "diagnosticsCopied");
    } catch {
      setState(action === "save" ? "diagnosticsSaveFailed" : "diagnosticsCopyFailed");
    } finally {
      setBusy(false);
    }
  }

  return <div>
    <button className="soft" type="button" disabled={busy} onClick={() => void share("save")}>{copy.exportDiagnostics}</button>
    <button className="soft" type="button" disabled={busy} onClick={() => void share("copy")}>{copy.copyDiagnostics}</button>
    {state && <p role="status">{copy[state]}</p>}
  </div>;
}
