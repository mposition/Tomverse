# INI

`parse(text)` returns an object; `stringify(object)` returns text.

Already supported
- `key = value` lines with surrounding whitespace trimmed; blank lines and lines starting with `;` or `#` are ignored; a later duplicate key replaces an earlier one.

To add
- Sections: `[name]` starts a section; the keys that follow go into `result.name`. A dotted name such as `[server.tls]` nests: `result.server.tls`. Keys before the first section go on the top-level object. A section header may be repeated; its keys are merged.
- Inline comments: ` ;` or ` #` (whitespace, then the marker) ends an unquoted value: `port = 80 ; http` gives `80`. A marker with no whitespace before it is part of the value (`color = #fff`).
- Values are typed unless quoted: `true` and `false` (lower case only) become booleans; text matching `-?\d+(\.\d+)?` becomes a number; everything else stays a trimmed string. An empty value (`key =`) is the empty string.
- Quoted strings: `"..."` keeps its content as a string without typing or comment stripping. Inside quotes `\"`, `\\` and `\n` are escapes for a quote, a backslash and a newline.
- Arrays: `tag[] = a` appends to the array `tag` (created on first use); each appended value is typed like any other value.
- `stringify(object)`: scalar keys of an object first, then one section per nested plain object in insertion order (nested sections use dotted names and are written after their parent), arrays as repeated `key[] = value` lines. Strings are written in quotes when needed so that `parse(stringify(x))` equals `x`: when the string is empty, has leading or trailing whitespace, is `true`, `false` or number-like, contains a quote, backslash, newline, ` ;` or ` #`, or starts with `;`, `#` or `[`. `null` and `undefined` values are skipped. Lines end with `\n`.
