# Tiny templates

`render(template, data)` returns a string.

Already supported
- `{{name}}` and `{{user.name}}`: the value, HTML-escaped. A missing value renders as an empty string.
- `{{{name}}}`: the value without escaping.

To add
- `{{#each items}}...{{/each}}`: repeats the body for every element of the array `items`. A missing value or a non-array renders nothing. Inside the body a name is looked up on the current element first and then in the outer data; `{{this}}` is the element itself; `{{@index}}` is its 0-based position (in nested loops, the innermost loop's index).
- `{{#if value}}...{{/if}}` and `{{#if value}}...{{else}}...{{/if}}`: renders the first part when the value is truthy and the `else` part otherwise. Falsy values are `false`, `null`, `undefined`, `0`, the empty string and the empty array.
- Blocks may be nested in any combination, including `each` inside `each`.
- A block that is never closed, or a closing tag without an opening tag, throws an Error whose message contains the word "unclosed" or "unexpected" respectively.
