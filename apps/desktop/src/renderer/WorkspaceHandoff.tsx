import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { Language } from "../../../../lib/language";
import { desktopFilesCopy } from "../../../../locales/desktopFiles";
import type { WorkspaceHandoff } from "../contract";

function selectableText(node: Node | null) {
  return (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>("[data-handoff-content]");
}

export function useHandoffSelection(source: "chat" | "code" | null, sourceId?: string | null) {
  const [selection, setSelection] = useState<{ source: "chat" | "code"; sourceId: string; excerpt: string } | null>(null);
  useEffect(() => {
    if (!source || !sourceId) return;
    function update() {
      const selected = document.getSelection();
      const anchor = selectableText(selected?.anchorNode ?? null);
      const focus = selectableText(selected?.focusNode ?? null);
      const excerpt = selected?.toString().trim();
      setSelection(excerpt && source && sourceId && anchor === focus && anchor?.dataset.handoffContent === source
        ? { source, sourceId, excerpt } : null);
    }
    update();
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, [source, sourceId]);
  return selection?.source === source && selection.sourceId === sourceId ? selection.excerpt : "";
}

export function HandoffDraft({ handoff, busy, language }: { handoff: WorkspaceHandoff; busy: boolean; language: Language }) {
  const source = handoff.target === "chat" ? "Code" : "Chat";
  const copy = desktopFilesCopy[language];
  return <div className="handoff-draft">
    <details>
      <summary title={handoff.project}>{copy.excerptFrom.replace("{source}", source)}</summary>
      <pre>{handoff.excerpt}</pre>
    </details>
    <small>{copy.creditsNote}</small>
    <button className="icon" type="button" aria-label={copy.removeExcerpt} disabled={busy}
      onClick={() => void window.desktop.removeHandoff(handoff.id)}><X size={14} /></button>
  </div>;
}
