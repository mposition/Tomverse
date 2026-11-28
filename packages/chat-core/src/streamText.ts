/**
 * Display projection shared by the web client and the locally bundled app.
 *
 * Every out-of-band control on the chat stream is one NUL code point, a
 * `TOMVERSE_<NAME>` label and one JSON object. The projection removes them so
 * answer text never shows one, and it never has to know a label in advance:
 *
 *   * a complete control (label plus a balanced JSON object) is skipped,
 *     whatever its label, so a client older than the server drops a control
 *     it does not know instead of losing the rest of the answer;
 *   * a control that is still arriving (a partial label, or JSON without its
 *     closing brace) is held back, together with everything after it;
 *   * the closing search-metadata trailer is held back for good -- it is the
 *     last thing the server writes and its payload is read elsewhere;
 *   * a NUL that cannot start a control, or a label with no JSON after it, has
 *     no boundary to find, so only the NUL (and the label) is removed and the
 *     text around it stays.
 */

const NUL = String.fromCharCode(0);
const LABEL_PREFIX = "TOMVERSE_";
const TRAILER_LABEL = "TOMVERSE_SEARCH_METADATA";

export type ChatStreamDisplayProjector = {
  /**
   * The answer text for `raw`, which must be the previous argument plus
   * whatever arrived since. Work done for the earlier prefix is not repeated,
   * so feeding a stream chunk by chunk is linear in its length.
   */
  project: (raw: string) => string;
  /**
   * The complete controls (NUL, label and JSON, verbatim) skipped since the
   * previous call, oldest first. Lets a caller read a control's payload
   * without scanning the whole accumulation again.
   */
  takeControls: () => string[];
};

const isLabelCode = (code: number) =>
  (code >= 65 && code <= 90) || (code >= 48 && code <= 57) || code === 95;

/** End (exclusive) of the JSON object that starts at `from`, or -1 if unfinished. */
const jsonObjectEnd = (raw: string, from: number): number => {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = from; i < raw.length; i++) {
    const char = raw[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return i + 1;
  }
  return -1;
};

export function createChatStreamDisplayProjector(): ChatStreamDisplayProjector {
  // Invariant: `text` is the projection of raw[0, offset).
  let text = "";
  let offset = 0;
  let controls: string[] = [];

  const project = (raw: string): string => {
    // Not an append of what was seen: start over rather than mis-project.
    if (raw.length < offset) {
      text = "";
      offset = 0;
      controls = [];
    }
    for (;;) {
      const start = raw.indexOf(NUL, offset);
      if (start < 0) {
        text += raw.slice(offset);
        offset = raw.length;
        return text;
      }
      text += raw.slice(offset, start);
      offset = start;

      const labelStart = start + 1;
      const probe = raw.slice(labelStart, labelStart + LABEL_PREFIX.length);
      if (probe !== LABEL_PREFIX) {
        // Could still turn into a label once more has arrived: hold it back.
        if (probe.length < LABEL_PREFIX.length && LABEL_PREFIX.startsWith(probe)) return text;
        offset = labelStart; // Not a control: drop the NUL, keep the text.
        continue;
      }
      let labelEnd = labelStart + LABEL_PREFIX.length;
      while (labelEnd < raw.length && isLabelCode(raw.charCodeAt(labelEnd))) labelEnd++;
      // The label may still be growing, and the trailer is never shown.
      if (labelEnd === raw.length || raw.startsWith(TRAILER_LABEL, labelStart)) return text;
      if (raw[labelEnd] !== "{") {
        offset = labelEnd; // A label with no payload has no boundary: drop the label.
        continue;
      }
      const end = jsonObjectEnd(raw, labelEnd);
      if (end < 0) return text; // Payload still arriving.
      controls.push(raw.slice(start, end));
      offset = end;
    }
  };

  const takeControls = (): string[] => {
    const taken = controls;
    controls = [];
    return taken;
  };

  return { project, takeControls };
}

export function chatStreamDisplayText(raw: string): string {
  return createChatStreamDisplayProjector().project(raw);
}
