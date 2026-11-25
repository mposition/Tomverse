# slugify(text, options)

Turns text into a URL slug.

- The input is converted with `String(text)`.
- Accented letters lose their accent (`e` for e-acute, `u` for u-umlaut), using Unicode NFKD decomposition and removing the combining marks.
- The result is lower case and contains only `a-z`, `0-9` and the separator. Every run of other characters becomes one separator, and separators at the start and end are removed.
- `options.separator` (default `"-"`) is the string put between words; it must be a non-empty string, otherwise a RangeError is thrown.
- `options.maxLength` (default 80) is the longest allowed result; it must be a positive integer, otherwise a RangeError is thrown. A longer slug is cut to exactly `maxLength` characters, and then separators left at the end by the cut are removed.
