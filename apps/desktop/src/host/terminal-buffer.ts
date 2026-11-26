/** Raw terminal output kept per terminal: replayed into a new view, and read as plain text by the agent. */
export const TERMINAL_SCROLLBACK_CHARACTERS = 400_000;

export type TerminalReplay = { data: string; seq: number };

export class ScrollbackBuffer {
  private chunks: string[] = [];
  private size = 0;
  private count = 0;
  private truncated = false;

  constructor(private readonly limit = TERMINAL_SCROLLBACK_CHARACTERS) {}

  /** The number of chunks accepted so far; a replay and the output events after it share this counter. */
  get seq() { return this.count; }

  push(data: string) {
    if (!data) return this.count;
    this.count += 1;
    this.chunks.push(data);
    this.size += data.length;
    while (this.size > this.limit && this.chunks.length) {
      const excess = this.size - this.limit;
      const first = this.chunks[0]!;
      this.truncated = true;
      if (first.length <= excess) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        this.chunks[0] = first.slice(excess);
        this.size -= excess;
      }
    }
    return this.count;
  }

  /** The kept output. After a cut, the first partial line is dropped so a replay never starts inside an escape sequence. */
  replay(): TerminalReplay {
    let data = this.chunks.join("");
    if (this.truncated) {
      const newline = data.indexOf("\n");
      data = newline < 0 ? "" : data.slice(newline + 1);
    }
    return { data, seq: this.count };
  }

  /** The newest `lines` lines as plain text. */
  tail(lines: number) {
    const text = plainTerminalText(this.replay().data).split("\n");
    while (text.length && text.at(-1) === "") text.pop();
    return text.slice(-Math.max(1, lines)).join("\n");
  }

  clear() {
    this.chunks = [];
    this.size = 0;
    this.truncated = false;
  }
}

const escape = String.fromCharCode(27);
const bell = String.fromCharCode(7);
// OSC, DCS/PM/APC/SOS strings end with BEL or ST; they carry titles and hyperlinks, never text to read.
const stringSequence = new RegExp(`${escape}[\\]PX^_][^${bell}${escape}]*(?:${bell}|${escape}\\\\)?`, "g");
const controlSequence = new RegExp(`${escape}\\[([0-?]*)[ -/]*([@-~])`, "g");
const otherEscape = new RegExp(`${escape}(?:[()*+][0-9A-Za-z]|[0-9A-Za-z=<>@\\\\^_])`, "g");

/**
 * What a terminal would show as text, from its raw output: escape sequences are removed, and carriage returns, backspaces, and the
 * column moves and line erases that shells use to redraw a prompt are applied to the line they edit. It does not model a full screen.
 */
export function plainTerminalText(raw: string): string {
  const input = raw.replace(stringSequence, "").replace(otherEscape, "");
  const lines: string[][] = [[]];
  let line = lines[0]!;
  let column = 0;
  let lastRow = 0;
  const newline = () => { line = []; lines.push(line); column = 0; };
  const put = (character: string) => {
    while (line.length < column) line.push(" ");
    line[column] = character;
    column += 1;
  };
  let index = 0;
  const sequences = [...input.matchAll(controlSequence)];
  let next = 0;
  while (index < input.length) {
    const sequence = sequences[next];
    if (sequence && sequence.index === index) {
      next += 1;
      index += sequence[0].length;
      const parameters = sequence[1]!.split(";").map((value) => Number.parseInt(value, 10));
      const first = Number.isFinite(parameters[0]) ? parameters[0]! : undefined;
      switch (sequence[2]) {
        case "G": column = Math.max(0, (first ?? 1) - 1); break;
        case "C": column += first ?? 1; break;
        case "D": column = Math.max(0, column - (first ?? 1)); break;
        case "H": case "f": {
          const row = first ?? 1;
          if (row > lastRow && lastRow > 0 && line.length) newline();
          lastRow = row;
          column = Math.max(0, (Number.isFinite(parameters[1]) ? parameters[1]! : 1) - 1);
          break;
        }
        case "K": {
          const mode = first ?? 0;
          if (mode === 0) line.length = Math.min(line.length, column);
          else if (mode === 2) { line.length = 0; }
          break;
        }
        case "J": if (first === 2 || first === 3) { lastRow = 0; if (line.length) newline(); } break;
        default: break;
      }
      continue;
    }
    const character = input[index]!;
    index += 1;
    if (character === "\n") newline();
    else if (character === "\r") column = 0;
    else if (character === "\b") column = Math.max(0, column - 1);
    else if (character === "\t") put("\t");
    else if (character >= " " && character !== "\x7f") put(character);
    else if (character === escape) continue;
  }
  return lines.map((cells) => cells.join("").replace(/\s+$/, "")).join("\n");
}
