Modules the marketing route sweep is measured against.

The sweep opens a route's imports and asks whether they reach the marketing
store. That question only has an answer for files that exist, so the shapes it
must catch -- a helper two deep, a re-export, a dynamic load -- are real files
here rather than strings in a test. Nothing imports them but
`tests/marketingS2b1Store.test.mjs`.
