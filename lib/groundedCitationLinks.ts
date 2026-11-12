import { safeResultUrl } from "./webSearchBackendAdapter";

/** Label only sources in the exact packet selected for this answer attempt. */
export function createGroundedCitationPacket(json: string): { json: string; urls: readonly string[] } | undefined {
  const urls: string[] = [];
  const wrap = (source: { url?: unknown; title?: unknown }) => {
    const url = source?.url;
    if (typeof url !== "string" || typeof source.title !== "string" || safeResultUrl(url) !== url ||
        /[<>\s\\]/u.test(url)) return source;
    let index = urls.indexOf(url);
    if (index === -1) index = urls.push(url) - 1;
    return { ["R" + (index + 1)]: source };
  };
  let packet: unknown;
  try { packet = JSON.parse(json); } catch { return undefined; }
  const labeled = JSON.stringify(packet, (key, value) => {
    if (key === "results" && Array.isArray(value)) return value.map(wrap);
    if (key === "sources" && value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).map(([id, source]) => [id, wrap(source as { url?: unknown })]));
    }
    return value;
  });
  return urls.length ? { json: labeled, urls } : undefined;
}

// Some providers flatten a dated PDF directory while copying an otherwise exact
// source URL. Only register this spelling for an immutable file in this packet.
const datedPdf = /^(https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._~%-]+)*)\/(\d{4})\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\/[\w.~-]+\.pdf(?:#page=[1-9]\d*)?)$/i;

/** Resolve source markers and exact evidence-backed PDF spellings as text arrives. */
export function createGroundedCitationStream(urls: readonly string[]) {
  const links = urls.map((url, i) => ({
    marker: "[[cite:R" + (i + 1) + "]]",
    // Angle destinations also support unbalanced parentheses in real URLs.
    link: "[" + (i + 1) + "](<" + url.replace(/&(?=(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);)/gi, "&amp;") + ">)",
    // A plain repeat cannot bind to a Markdown reference definition supplied by the model.
    number: "(" + (i + 1) + ")",
    emitted: false,
  }));
  const pdfSpellings = new Map<string, string>();
  for (const url of urls) {
    if (url.length > 2048) continue;
    const match = datedPdf.exec(url);
    if (!match) continue;
    const [, prefix, year, month, day, file] = match;
    const spelling = prefix + "/" + year + "-" + month + "-" + day + "/" + file;
    if (!urls.includes(spelling)) pdfSpellings.set(spelling, url);
  }
  const spellings = [...pdfSpellings.keys()];
  const longestSpelling = Math.max(0, ...spellings.map(s => s.length));
  let pending = "";
  let extraBytes = 0;
  let previous = "";
  let escaped = false;
  let codeDelimiter = "";
  let codeRunLength = 0;
  let fence = false;
  let atLineStart = true;
  let indent = 0;
  let delimiter = "";
  let run = 0;
  let runAtMargin = false;
  const longestMarker = Math.max(0, ...links.map(link => link.marker.length));

  function endRun() {
    if (!run) return;
    if (codeDelimiter) {
      const closesCode = fence ? runAtMargin && run >= codeRunLength : run === codeRunLength;
      if (delimiter === codeDelimiter && closesCode) {
        codeDelimiter = "";
        fence = false;
      }
    } else if (delimiter === "`" || (runAtMargin && run >= 3)) {
      codeDelimiter = delimiter;
      codeRunLength = run;
      fence = runAtMargin && run >= 3;
    }
    run = 0;
  }
  return {
    // Pending markers and URL spellings are ASCII. The two date separators are byte-neutral.
    get providerByteAdjustment() { return pending.length - extraBytes; },
    write(chunk: string) {
      const text = pending + chunk;
      pending = "";
      let output = "";
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (run && ch !== delimiter) endRun();
        if (!escaped && (ch === "`" || ch === "~")) {
          if (!run) { delimiter = ch; runAtMargin = atLineStart; }
          run++;
        } else if (!escaped && !codeDelimiter && indent < 4 && ch === "[") {
          const link = links.find(item => text.startsWith(item.marker, i));
          if (link) {
            // A search URL is a citation, never an image. Link each source once to
            // bound output growth, even if a provider repeats the same marker.
            const replacement = (previous === "!" ? " " : "") + (link.emitted ? link.number : link.link);
            link.emitted = true;
            output += replacement;
            extraBytes += Buffer.byteLength(replacement) - link.marker.length;
            i += link.marker.length - 1;
            previous = "]";
            atLineStart = false;
            continue;
          }
          if (text.length - i < longestMarker && links.some(item => item.marker.startsWith(text.slice(i)))) {
            pending = text.slice(i);
            break;
          }
        } else if (!codeDelimiter && indent < 4 && ch === "h" && longestSpelling &&
                   (!previous || /\s/u.test(previous))) {
          const candidate = text.slice(i, i + longestSpelling + 1);
          const exact = spellings.find(s => candidate.startsWith(s) && /\s/u.test(candidate.charAt(s.length)));
          if (exact) {
            output += pdfSpellings.get(exact);
            i += exact.length - 1;
            previous = exact[exact.length - 1];
            atLineStart = false;
            continue;
          }
          if (spellings.some(s => s.startsWith(candidate))) {
            pending = candidate; // Wait for a token boundary or the end of the stream.
            break;
          }
        }
        output += ch;
        previous = ch;
        escaped = !codeDelimiter && !escaped && ch === "\\";
        if (ch === "\n") { atLineStart = true; indent = 0; }
        else if (atLineStart && ch === " ") { indent++; atLineStart = indent <= 3; }
        else if (atLineStart && ch === "\t") { indent = 4; atLineStart = false; }
        else if (atLineStart && ch === ">") { indent = 0; }
        else atLineStart = false;
      }
      return output;
    },
    finish() { const tail = pdfSpellings.get(pending) ?? pending; pending = ""; return tail; },
  };
}
