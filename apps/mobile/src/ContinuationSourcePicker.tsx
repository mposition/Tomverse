import { useEffect, useState } from "react";
import { MAX_PASSAGES, PASSAGE_LENGTH, slicePassage, type Passage } from "../../../lib/continuationPassages";
import { mobileSourceContextCopy } from "../../../locales/mobileSourceContext";
import type { MobileLanguage } from "../../../locales/mobile";
import type { ImportedTranscript } from "./chatTransport";

/** Coordinates only, scoped to the mounted conversation; never persisted in a draft. */
export function ContinuationSourcePicker({ imported, selected, onChoose, language, busy }: {
  imported: ImportedTranscript; selected: Passage[]; onChoose: (value: Passage[]) => void;
  language: MobileLanguage; busy: boolean;
}) {
  const c = mobileSourceContextCopy(language);
  const [positions, setPositions] = useState<Record<number, number>>({});
  useEffect(() => { if (imported.status !== "available" && selected.length) onChoose([]); }, [imported.status, selected.length, onChoose]);
  if (imported.status !== "available") return null;
  return <div className="imported-source-context" data-testid="native-continuation-context">
    <p role="status">{c[selected.length ? "journey.chosen" : "journey.auto"].replaceAll("{count}", String(selected.length))}</p>
    <details><summary>{c["journey.pickSource"]}</summary><p>{c["journey.pickHelp"]}</p>
      {imported.messages.filter(message => Number.isSafeInteger(message.ordinal) && message.content.trim()).map(message => {
        const ordinal = message.ordinal!;
        const picked = selected.find(part => part.ordinal === ordinal);
        const last = Math.max(0, message.content.length - PASSAGE_LENGTH);
        const start = Math.min(last, positions[ordinal] ?? picked?.start ?? last);
        const part = { ordinal, start, end: Math.min(message.content.length, start + PASSAGE_LENGTH) };
        return <fieldset key={message.id} disabled={busy}>
          <label><input type="checkbox" checked={Boolean(picked)} disabled={!picked && selected.length >= MAX_PASSAGES}
            onChange={() => onChoose(picked ? selected.filter(value => value.ordinal !== ordinal) : [...selected, part])} />
            <span>{ordinal + 1}</span></label>
          <p className="imported-source-excerpt">{start > 0 ? "…" : ""}{slicePassage(message.content, part.start, part.end)}{part.end < message.content.length ? "…" : ""}</p>
          {last > 0 && <div>{[-1, 1].map(direction => <button type="button" className="imported-older" key={direction}
            disabled={busy || (direction < 0 ? start === 0 : start === last)} onClick={() => {
              const next = Math.min(last, Math.max(0, start + direction * PASSAGE_LENGTH));
              setPositions(value => ({ ...value, [ordinal]: next }));
              if (picked) onChoose(selected.map(value => value.ordinal === ordinal
                ? { ordinal, start: next, end: Math.min(message.content.length, next + PASSAGE_LENGTH) } : value));
            }}>{c[direction < 0 ? "journey.previousPart" : "journey.nextPart"]}</button>)}</div>}
        </fieldset>;
      })}
      <p>{c["journey.selected"].replaceAll("{count}", String(selected.length))}</p>
      <button type="button" className="imported-older" disabled={busy || !selected.length} onClick={() => onChoose([])}>{c["journey.useAuto"]}</button>
    </details>
  </div>;
}
