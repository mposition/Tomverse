import assert from "node:assert/strict";
import test from "node:test";

import { prepareMathMarkdown } from "../lib/chatMathDelimiters.ts";

const prep = (value) => prepareMathMarkdown(value);

test("prices are text, never a formula", () => {
  for (const text of [
    "It costs $5 and $10 in total.",
    "Between $5.00 to $10.00 per seat",
    "US$5와 US$10 중에 고르세요.",
    "$100-$200 range, ($10) fee, $5,$10",
    "Save $20 now, then $30 later.",
    "총 $1,200이고 부가세는 $120입니다.",
  ]) {
    assert.equal(prep(text), text, text);
  }
});

test("a price followed by a real formula keeps the price", () => {
  assert.equal(prep("Pay $5, then solve $x$ here."), "Pay $5, then solve $$x$$ here.");
});

test("single-dollar inline math follows the Pandoc rules", () => {
  assert.equal(prep("Euler: $e^{i\\pi}=-1$."), "Euler: $$e^{i\\pi}=-1$$.");
  // Space after the opener or before the closer is not math.
  assert.equal(prep("a $ b $ c"), "a $ b $ c");
  // A closer followed by a digit is a price.
  assert.equal(prep("$x$5"), "$x$5");
  // Escaped dollars are text.
  assert.equal(prep("\\$5 and \\$x\\$"), "\\$5 and \\$x\\$");
});

test("\\( \\) and \\[ \\] become $$ delimiters", () => {
  assert.equal(prep("Inline \\(a+b\\) here"), "Inline $$a+b$$ here");
  assert.equal(prep("Block \\[a^2\\] done"), "Block $$a^2$$ done");
  assert.equal(prep("Lines\n\\[\n\\sum_i i\n\\]\nend"), "Lines\n$$\n\\sum_i i\n$$\nend");
  // A doubled backslash before a bracket is a LaTeX line break, not a delimiter.
  assert.equal(prep("x \\\\[2pt] y"), "x \\\\[2pt] y");
});

test("a display formula alone on one line gets delimiter lines of its own", () => {
  assert.equal(prep("$$ x^2 $$"), "$$\nx^2\n$$");
  assert.equal(prep("  $$ x^2 $$"), "  $$\n  x^2\n  $$");
  // Already in block form: untouched.
  const block = "Intro\n\n$$\n\\int_0^1 x\\,dx\n$$\n";
  assert.equal(prep(block), block);
});

test("an unfinished formula (still streaming) is escaped, not left open", () => {
  assert.equal(prep("Stream $$\\frac{a}{"), "Stream \\$\\$\\frac{a}{");
  assert.equal(prep("Intro\n\n$$\nx^2 +"), "Intro\n\n\\$\\$\nx^2 +");
  // A lone opener is plain text with single-dollar math off.
  assert.equal(prep("Now $x^"), "Now $x^");
});

test("an inline $$ pair does not span a paragraph break", () => {
  assert.equal(prep("cost $$ ends\n\nlater $$ here"), "cost \\$\\$ ends\n\nlater \\$\\$ here");
});

test("code is never touched", () => {
  const fenced = "```js\nconst a = '$x$'; const b = `$$y$$`;\n```";
  assert.equal(prep(fenced), fenced);
  const tilde = "~~~\n\\(x\\) $5 $x$\n~~~";
  assert.equal(prep(tilde), tilde);
  assert.equal(prep("use `$x$` and `\\(y\\)` then $z$"), "use `$x$` and `\\(y\\)` then $$z$$");
  // An unterminated fence runs to the end, as in Markdown.
  const open = "```\n$x$ $$y$$";
  assert.equal(prep(open), open);
  // Prose around a fence is still prepared.
  assert.equal(prep("$a$\n```\n$b$\n```\n$c$"), "$$a$$\n```\n$b$\n```\n$$c$$");
});

test("text without any dollar or bracket delimiter is returned as is", () => {
  const plain = "No formulas here.\n\n- one\n- two";
  assert.equal(prep(plain), plain);
});

test("indented code blocks are never touched", () => {
  const indented = "Example:\n\n    const a = '$x$';\n    echo $y$ \(z\)\n\nThen $w$ here.";
  assert.equal(
    prep(indented),
    "Example:\n\n    const a = '$x$';\n    echo $y$ \(z\)\n\nThen $$w$$ here."
  );
  // A tab indents too, and a block at the very top is code.
  assert.equal(prep("\techo $x$\n\nand $y$"), "\techo $x$\n\nand $$y$$");
  assert.equal(prep("    $x$\n    $y$"), "    $x$\n    $y$");
  // A blank line inside the block does not end it.
  assert.equal(prep("t\n\n    $a$\n\n    $b$\n\n$c$"), "t\n\n    $a$\n\n    $b$\n\n$$c$$");
});

test("an indented line that continues a paragraph or a list item is still prose", () => {
  // Not after a blank line: a lazy continuation, not code.
  assert.equal(prep("para\n    $x$ more"), "para\n    $$x$$ more");
  // Inside a list the deeper indent is a nested paragraph.
  assert.equal(prep("1. step\n\n    solve $x$ now"), "1. step\n\n    solve $$x$$ now");
  assert.equal(prep("- a\n  - nested $x$"), "- a\n  - nested $$x$$");
  // A list ends at the next flush-left paragraph; code after it is code again.
  assert.equal(
    prep("- a\n\nafter $y$\n\n    code $z$"),
    "- a\n\nafter $$y$$\n\n    code $z$"
  );
});

test("code inside a blockquote is never touched", () => {
  const fenced = "> ```\n> price $5 and $x$\n> ```\n\nthen $y$";
  assert.equal(prep(fenced), "> ```\n> price $5 and $x$\n> ```\n\nthen $$y$$");
  const quotedIndented = ">\n>     echo $x$\n\nthen $y$";
  assert.equal(prep(quotedIndented), ">\n>     echo $x$\n\nthen $$y$$");
  // Quoted prose is still prepared.
  assert.equal(prep("> note $x$"), "> note $$x$$");
  // A fence in a quote ends with the quote.
  assert.equal(prep("> ```\n> $a$\nplain $b$"), "> ```\n> $a$\nplain $$b$$");
});

test("a fenced block nested in a list item is never touched", () => {
  const nested = "1. Run:\n\n    ```sh\n    echo $x$\n    ```\n\n2. Then $y$";
  assert.equal(prep(nested), "1. Run:\n\n    ```sh\n    echo $x$\n    ```\n\n2. Then $$y$$");
});
