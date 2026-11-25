# wrap(text, width)

Wraps text to lines of at most `width` characters.

- `width` must be a positive integer, otherwise a RangeError is thrown.
- The text is wrapped line by line: every `\n` in the input stays a line break in the output, and an empty input line stays an empty line.
- Inside a line, words are separated by any run of whitespace (spaces or tabs) and are joined by single spaces. Lines are filled greedily: a word goes on the current line when the line plus a space plus the word is at most `width` characters, otherwise it starts a new line.
- A word longer than `width` is broken into pieces of `width` characters; the last piece stays open for the next word.
- No output line has leading or trailing whitespace.
