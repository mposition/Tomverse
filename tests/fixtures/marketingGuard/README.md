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

A case may carry a `claims` array of claim kinds -- `["plan"]`, say. The
harness turns each one into a resolved claim the draft declares, which is what
a case about free wording needs: docs/policy/marketing-automation.md §7.2
rule 4 wants the credit allowance as a
claim rather than as a word somebody typed, so "Start free. Credits never run
out." is a bypass case and the same sentence with a plan claim behind it is
not. Almost every case leaves it out, because the corpus is about the words.

`tests/marketingGuardCorpus.test.mjs` asserts both files against
`guardDraft()`, and fails if any rule id in `lib/marketingGuardRules.ts` is
missing from either file.
