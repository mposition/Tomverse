import type { Language } from "../../../../lib/language";
import { desktopEvidenceCopy } from "../../../../locales/desktopEvidence";
import type { Task } from "../contract";
import { splitLinkText } from "../link-text";
import { openLink } from "./WebViewer";

export function AnswerMessage({ text, language }: { text: string; language: Language }) {
  return <div role="group" aria-label={desktopEvidenceCopy[language].modelResponse}>
    {splitLinkText(text).map((part, index) => part.url
      ? <a key={index} className="answer-link" href={part.url} onClick={(event) => { event.preventDefault(); void openLink(part.url!).catch(() => {}); }}>{part.text}</a>
      : part.text)}
  </div>;
}

export function AnswerBasis({ task, language }: { task: Task; language: Language }) {
  if (!task.readOnly || task.status !== "completed" || !task.entries.some((entry) => entry.role === "assistant")) return null;
  const model = task.transmission.at(-1)?.model ?? task.model;
  const copy = desktopEvidenceCopy[language];
  return <p className="notice">
    {copy.readOnly}{model && ` · ${model}`}. {copy.readOnlyHint}
  </p>;
}
