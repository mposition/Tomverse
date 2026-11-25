import { Trash2 } from "lucide-react";
import type { Language } from "../../../../lib/language";
import { desktopCodeBrowserCopy } from "../../../../locales/desktopCodeBrowser";
import type { ElementPick } from "../browser-contract";
import { MAX_ELEMENT_COMMENTS, serializeElementComments } from "../element-comment";
import "./element-comments.css";

export type Pin = { pick: ElementPick; comment: string };

/** The elements the person picked in the page, each with a comment; they go into the next message together. */
export function ElementComments({ language, pins, onChange, onAttach }: {
  language: Language;
  pins: Pin[];
  onChange: (pins: Pin[]) => void;
  onAttach: (block: string) => void;
}) {
  const copy = desktopCodeBrowserCopy[language];
  if (!pins.length) return null;
  return <section className="element-comments" aria-label={copy.pinsHeading}>
    <h3>{copy.pinsHeading} ({pins.length})</h3>
    <ol>
      {pins.map((pin, index) => <li key={pin.pick.id}>
        {pin.pick.thumbnail && <img src={pin.pick.thumbnail} alt={copy.thumbnailAlt} />}
        <div>
          <code title={pin.pick.url}>{pin.pick.selector}</code>
          {pin.pick.text && <span>{pin.pick.text}</span>}
          <textarea rows={2} aria-label={copy.commentLabel + " " + (index + 1)} placeholder={copy.commentPlaceholder} value={pin.comment}
            onChange={(event) => onChange(pins.map((item) => item === pin ? { ...item, comment: event.currentTarget.value } : item))} />
        </div>
        <button type="button" className="icon" aria-label={copy.removePin} onClick={() => onChange(pins.filter((item) => item !== pin))}><Trash2 size={14} /></button>
      </li>)}
    </ol>
    {pins.length >= MAX_ELEMENT_COMMENTS && <p role="status">{copy.pinsFull}</p>}
    <button type="button" className="primary" onClick={() => {
      onAttach(serializeElementComments(pins.map(({ pick, comment }) => ({ pick, comment }))));
      onChange([]);
    }}>{copy.addToMessage} ({pins.length})</button>
  </section>;
}
