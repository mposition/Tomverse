import assert from "node:assert/strict";
import test from "node:test";
import { plainTerminalText, ScrollbackBuffer } from "../src/host/terminal-buffer";

test("scrollback keeps a bounded tail and replays it with the sequence of the last chunk", () => {
  const buffer = new ScrollbackBuffer(50);
  for (let line = 0; line < 30; line += 1) buffer.push(`line ${line}\r\n`);
  const { data, seq } = buffer.replay();
  assert.equal(seq, 30);
  assert.ok(data.length <= 50);
  assert.ok(data.endsWith("line 29\r\n"));
  assert.ok(data.startsWith("line "), "A replay starts on a whole line, never inside an escape sequence.");
  assert.equal(buffer.push(""), 30, "Empty output does not advance the sequence.");
});

test("one chunk larger than the limit is cut to its newest part", () => {
  const buffer = new ScrollbackBuffer(10);
  buffer.push("a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\n");
  assert.ok(buffer.replay().data.length <= 10);
  assert.ok(buffer.replay().data.endsWith("k\n"));
});

test("tail returns the newest lines as plain text without escape sequences", () => {
  const buffer = new ScrollbackBuffer();
  buffer.push("\u001b[2J\u001b[H\u001b]0;title\u0007\u001b[32mgreen\u001b[0m\r\none\r\ntwo\r\nthree\r\n");
  assert.equal(buffer.tail(2), "two\nthree");
  assert.equal(buffer.tail(100), "green\none\ntwo\nthree");
});

test("carriage returns, backspaces and prompt redraws edit the line instead of repeating it", () => {
  assert.equal(plainTerminalText("progress 10%\rprogress 90%\r\ndone"), "progress 90%\ndone");
  assert.equal(plainTerminalText("abc\b\bX"), "aXc");
  // ConPTY redraws the prompt line with a column move and an erase.
  assert.equal(plainTerminalText("PS C:/work> \u001b[1;13H\u001b[Kls\r\nfile.txt\r\n"), "PS C:/work> ls\nfile.txt\n");
  assert.equal(plainTerminalText("keep\u001b[2K\rgone"), "gone");
});

test("a real ConPTY capture keeps the command output and drops the title and cursor sequences", () => {
  const raw = "\u001b[2J\u001b[m\u001b[H\u001b]0;powershell.exe\u0007\u001b[?25hPS C:/w> " +
    "\u001b[?25l\u001b[1;8H> \u001b[93mnode\u001b[m \u001b[90m-p\u001b[m \u001b[36m\"'tv' + (6*7)\"\r\n\u001b[?25h\u001b[mtv42\r\nPS C:/w> ";
  const lines = plainTerminalText(raw).split("\n");
  assert.deepEqual(lines.slice(1), ["tv42", "PS C:/w>"]);
  assert.equal(lines[0], "PS C:/w> node -p \"'tv' + (6*7)\"");
});

test("an unterminated title sequence does not swallow later output", () => {
  assert.equal(plainTerminalText("\u001b]0;never closed"), "");
  assert.equal(plainTerminalText("a\u001b]0;t\u0007b"), "ab");
});
