/**
 * What "Read aloud" says: an answer's prose, without Markdown symbols, code
 * blocks, formulas or link addresses. Pure, so it can be tested without a
 * browser; the speech itself is in lib/chatSpeech.ts.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))/gm;

export function plainTextForSpeech(markdown: string): string {
  let text = markdown.replace(/\r\n?/g, "\n");
  // Code blocks and formulas are shown, not read.
  text = text.replace(FENCE, "\n");
  text = text
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\\\[[\s\S]*?\\\]/g, " ")
    .replace(/\\\([\s\S]*?\\\)/g, " ");
  // Images disappear; links keep their words.
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/<https?:\/\/[^>\s]+>/g, " ").replace(/https?:\/\/\S+/g, " ");
  text = text.replace(/<[^>\n]+>/g, " ");
  // Inline code keeps its words, not its backticks.
  text = text.replace(/`([^`\n]+)`/g, "$1");
  const lines = text.split("\n").map((line) => {
    let value = line
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^\s*>+\s?/, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "")
      .replace(/^\s*([-*_])(?:\s*\1){2,}\s*$/, "");
    // Table rows read as comma-separated cells; the divider row says nothing.
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(value)) return "";
    if (value.includes("|")) value = value.split("|").map((cell) => cell.trim()).filter(Boolean).join(", ");
    return value;
  });
  text = lines.join("\n");
  text = text.replace(/(\*{1,3}|~~|__)(?=\S)([^\n]*?\S)\1/g, "$2");
  return text.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
}

/**
 * Speech engines cut off long utterances (Chromium stops one after roughly
 * fifteen seconds), so the text is read in sentence-sized pieces.
 */
export function splitSpeechChunks(text: string, maxLength = 180): string[] {
  const chunks: string[] = [];
  for (const line of text.split("\n")) {
    const sentences = line.match(/[^.!?。！？]+(?:[.!?。！？]+["')\]”’]*|$)\s*/g) ?? [line];
    let current = "";
    for (const sentence of sentences) {
      if (current && current.length + sentence.length > maxLength) {
        chunks.push(current.trim());
        current = "";
      }
      if (sentence.length > maxLength) {
        for (let start = 0; start < sentence.length; start += maxLength) {
          const piece = sentence.slice(start, start + maxLength).trim();
          if (piece) chunks.push(piece);
        }
        continue;
      }
      current += sentence;
    }
    if (current.trim()) chunks.push(current.trim());
  }
  return chunks.filter(Boolean);
}
