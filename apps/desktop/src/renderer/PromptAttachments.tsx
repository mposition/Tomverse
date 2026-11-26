import { X } from "lucide-react";
import type { Language } from "../../../../lib/language";
import { desktopGitCopy } from "../../../../locales/desktopGit";
import { removePromptAttachment, usePromptAttachments } from "./prompt-attachments";
import "./git-panel.css";

/** GitHub text attached to the next instruction: each can be taken off before sending. */
export function PromptAttachmentChips({ scope, language, disabled }: { scope: string; language: Language; disabled?: boolean }) {
  const copy = desktopGitCopy[language];
  const items = usePromptAttachments(scope);
  if (!items.length) return null;
  return <ul className="prompt-attachments" aria-label={copy.attachmentsHeading}>
    {items.map((item) => <li key={item.id}>
      <span title={item.text.slice(0, 400)}>{item.label}</span>
      <button className="icon" type="button" disabled={disabled} aria-label={copy.attachmentRemove.replace("{label}", () => item.label)}
        onClick={() => removePromptAttachment(item.id)}><X size={13} /></button>
    </li>)}
  </ul>;
}
