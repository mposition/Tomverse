/**
 * Everything the model, a file or a command produced reaches the terminal
 * through `safeText`. Escape sequences can set the clipboard (OSC 52), retitle
 * the window, move the cursor to paint over an approval prompt, or hide text;
 * bidi controls can make a command read differently from what runs. None of
 * that is passed through: each such character is shown as a visible
 * `\u{..}` marker instead, so nothing is silently dropped either.
 */

// C0 controls except tab and newline, DEL, C1 controls, the Unicode bidi
// marks and controls, the Arabic letter mark, and the line/paragraph separators.
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

export const safeText = (text: string): string =>
    text.replace(UNSAFE, (ch) => `\\u{${ch.codePointAt(0)!.toString(16)}}`);

/** One line for prompts and labels: newlines shown, never interpreted. */
export const safeLine = (text: string): string => safeText(text).replace(/\r?\n/g, "\\n");

export type Output = {
    /** Human-facing text: progress, prompts, diffs. stderr in JSON mode. */
    info(text: string): void;
    /** Assistant text as it streams. stdout in human mode. */
    stream(text: string): void;
    /** One JSON event line on stdout (JSON mode only). */
    event(event: Record<string, unknown>): void;
    readonly json: boolean;
};

export const createOutput = (json: boolean, streams = { out: process.stdout, err: process.stderr }): Output => ({
    json,
    info(text) {
        streams.err.write(`${safeText(text)}\n`);
    },
    stream(text) {
        if (json) return;
        streams.out.write(safeText(text));
    },
    event(event) {
        if (!json) return;
        // JSON.stringify escapes every control character, so a JSONL line
        // cannot carry a raw escape sequence either.
        streams.out.write(`${JSON.stringify(event)}\n`);
    },
});

/**
 * A unified-looking diff of one file for the approval screen. Never
 * shortened: what is approved is exactly what is shown, however long. The
 * header counts the removed and added lines so a long one is seen as long.
 */
export const renderFileDiff = (path: string, before: string | null, after: string | null): string => {
    // Lines are compared with their endings. A patch can only write a CR as
    // part of a file's consistent CRLF endings (patch.ts refuses anything
    // else), which the approval states, so the CR is not shown per line.
    const a = before === null ? [] : before.split("\n");
    const b = after === null ? [] : after.split("\n");
    // Only a CR before a newline is a line ending; one at the very end of the
    // file stays in the text, and safeText shows it as \u{d}.
    const shown = (line: string | undefined, last: boolean) => (line === undefined ? "" : !last && line.endsWith("\r") ? line.slice(0, -1) : line);
    // Trim the common head and tail; show what changed with three lines of context.
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA -= 1;
        endB -= 1;
    }
    const counts = `(${endA - start} line(s) removed, ${endB - start} added)`;
    const header = before === null ? `+++ new file ${path} ${counts}` : after === null ? `--- delete ${path} ${counts}` : `*** ${path} ${counts}`;
    const lines: string[] = [header];
    const from = Math.max(0, start - 3);
    for (let i = from; i < start; i += 1) lines.push(`  ${shown(a[i], i === a.length - 1)}`);
    for (let i = start; i < endA; i += 1) lines.push(`- ${shown(a[i], i === a.length - 1)}`);
    for (let i = start; i < endB; i += 1) lines.push(`+ ${shown(b[i], i === b.length - 1)}`);
    for (let i = endA; i < Math.min(a.length, endA + 3); i += 1) lines.push(`  ${shown(a[i], i === a.length - 1)}`);
    return lines.map(safeText).join("\n");
};
