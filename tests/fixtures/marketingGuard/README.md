# Guard corpus

Two files, and the difference between them is the point.

`bypass.json` is text written to get past a rule: the same claim in Cyrillic
look-alikes, in leetspeak, spaced out, or phrased around. Every case states the
exact verdict and codes it must get, and a rule with no bypass case is a rule
nobody has tried to defeat.

`benign.json` is text that trips a rule's shape and is not the claim —
`bestow`, `asbestos`, `최고기온`, a legitimate number, the product's own name.
Each case states the verdict it must get, which for free copy is
`approval_required` and never `reject` with a ban-word code. A rule with no
benign case is a rule nobody has checked for false positives, and a filter that
has only ever been tested on what it should catch is a filter that catches
everything.

`tests/marketingGuardCorpus.test.mjs` asserts both files against
`guardDraft()`, and fails if any rule id in `lib/marketingGuardRules.ts` is
missing from either file.
