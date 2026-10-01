/**
 * The verbs two modules have to agree about.
 *
 * `lib/marketingMemoryClaims.ts` builds the forbidden claims out of them and
 * `lib/marketingNegation.ts` uses them to tell a new clause from a noun phrase.
 * They were two hand-written lists, and they drifted: `recover` was a claim
 * verb and not a clause verb, so "We do not store your chats, Tomverse
 * recovers hidden prompts." read as one denial and was reported as nothing.
 *
 * One list, two readers, and a test that fails when a claim names a verb this
 * file does not.
 *
 * Pure: no server-only import, no network, no Prisma.
 */

/** Making a copy of something that is not copied. */
export const MARKETING_REPLICATION_VERBS: readonly string[] = Object.freeze([
  "clone",
  "replicate",
  "reproduce",
  "recreate",
  "transfer",
  "copy",
  "duplicate",
]);

/** Getting back something that was never stored. */
export const MARKETING_RECOVERY_VERBS: readonly string[] = Object.freeze([
  "recover",
  "reveal",
  "extract",
  "reconstruct",
  "restore",
  "retrieve",
  "expose",
  "uncover",
]);

/** Moving a body of data somewhere. */
export const MARKETING_TRANSFER_VERBS: readonly string[] = Object.freeze([
  "transfer",
  "migrate",
  "import",
  "export",
  "port",
  "sync",
]);

/**
 * The third-person forms of a verb, which is the shape a new clause uses.
 *
 * "Tomverse clones your memories" rather than "Tomverse clone your memories".
 * Spelled by rule, with the two English endings that matter: a verb ending in
 * a sibilant takes `es`, a verb ending in a consonant and `y` takes `ies`.
 */
const thirdPerson = (verb: string): string => {
  if (/(?:s|x|z|ch|sh)$/u.test(verb)) return `${verb}es`;
  if (/[^aeiou]y$/u.test(verb)) return `${verb.slice(0, -1)}ies`;
  return `${verb}s`;
};

/**
 * The past and the participle, which are the same word for all of these.
 *
 * "We cloned your memories." is the claim in the past tense and the verb list
 * had only the present, so four sentences saying the thing had been done went
 * unreported. Spelled by rule: a verb ending in `e` takes `d`, one ending in a
 * consonant and `y` takes `ied`, and the rest take `ed`.
 */
const pastTense = (verb: string): string => {
  if (verb.endsWith("e")) return `${verb}d`;
  if (/[^aeiou]y$/u.test(verb)) return `${verb.slice(0, -1)}ied`;
  return `${verb}ed`;
};

/** The `-ing` form. */
const gerund = (verb: string): string =>
  verb.endsWith("e") ? `${verb.slice(0, -1)}ing` : `${verb}ing`;

/**
 * The verbs whose spelling the rules above get wrong.
 *
 * English doubles a final consonant on a stressed last syllable, and no rule
 * short of a pronouncing dictionary knows which. "We transferred your memory."
 * went unreported because the rule spelled it with one `r`, so the ones in
 * these lists that double are written out.
 */
const IRREGULAR: Readonly<Record<string, readonly string[]>> = Object.freeze({
  transfer: Object.freeze(["transferred", "transferring"]),
});

/** Every form of a lemma, so no list can hold one and miss another. */
export const marketingVerbForms = (verb: string): string[] => [
  verb,
  thirdPerson(verb),
  ...(Object.hasOwn(IRREGULAR, verb)
    ? IRREGULAR[verb]
    : [pastTense(verb), gerund(verb)]),
];

/** Everyday verbs a second clause starts with, beyond the claim vocabulary. */
const ORDINARY_CLAUSE_VERBS: readonly string[] = Object.freeze([
  "is", "are", "was", "were", "be", "been", "being",
  "has", "have", "had", "does", "do", "did",
  "can", "could", "will", "would", "may", "might", "shall", "should", "must",
  "keeps", "stores", "holds", "remembers", "learns", "reads", "writes",
  "saves", "deletes", "offers", "provides", "gives", "makes", "lets",
  "helps", "works", "runs", "shares", "sends", "shows", "uses", "supports",
  "includes", "costs", "starts", "comes", "brings", "turns", "builds",
]);

/**
 * Every verb a clause may start with, third-person and plain.
 *
 * A closed list is a guess about language, and the guess it replaces was
 * worse: "any lower-case word ending in s or ed" read the plural noun in
 * "Anthropic services partner" as a verb and cut a real negation in half.
 */
export const MARKETING_CLAUSE_VERBS: readonly string[] = Object.freeze([
  ...new Set([
    ...ORDINARY_CLAUSE_VERBS,
    ...MARKETING_REPLICATION_VERBS.flatMap(marketingVerbForms),
    ...MARKETING_RECOVERY_VERBS.flatMap(marketingVerbForms),
    ...MARKETING_TRANSFER_VERBS.flatMap(marketingVerbForms),
  ]),
  // Longest first, so an alternation does not match `clone` inside `cloned`
  // and then fail the boundary that follows it.
].sort((left, right) => right.length - left.length));
