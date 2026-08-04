/**
 * Retrieval v1 tokenizer (policy §9) — the terms stored in
 * `MemoryItem.searchTerms` and the terms a query is matched with.
 *
 * Release B and C use no embeddings: no external embedding provider is
 * called, no memory text leaves for one, and no vector column exists. What
 * makes lexical retrieval work across the languages this product actually
 * runs in is the split below.
 *
 *   * Latin-ish scripts are word-delimited, so words are the unit.
 *   * Chinese, Japanese and Korean are not. Korean in particular agglutinates
 *     — "커피를", "커피는" and "커피가" are the same word to a reader and three
 *     different tokens to a whitespace splitter — so CJK runs are indexed as
 *     character bigrams, which match regardless of the particle attached.
 *
 * Both sides of retrieval MUST use this one function. An index built with one
 * tokenizer and queried with another silently returns nothing, and nothing is
 * indistinguishable from "the user has no relevant memories".
 *
 * Determinism is the other requirement, and it is why the case fold here is
 * `toLowerCase()` and never `toLocaleLowerCase()`: a locale-sensitive fold
 * makes the stored terms depend on the server's locale (Turkish alone maps
 * "I" to "ı"), so the same statement would index differently on two machines
 * and a retrieval miss would depend on which one answered. Invariant folding
 * costs a small amount of Turkish precision and buys an index that means the
 * same thing everywhere.
 *
 * Pure and dependency-free on purpose — this runs in the extraction pipeline,
 * in the memory write paths, in a backfill script and eventually in the query
 * path, and it must give all four the same answer.
 */

/**
 * Bumped when the token set a given text produces changes. Stored per row in
 * `MemoryItem.retrievalVersion`, so rows tokenized by an older algorithm are
 * identifiable and re-indexable rather than silently mixed in.
 */
export const MEMORY_RETRIEVAL_VERSION = 1;

/** Terms shorter than this are noise in Latin scripts ("a", "의", "to"). */
const MIN_LATIN_TERM_LENGTH = 2;

/** A term longer than this is a URL or an identifier, not a word. */
const MAX_TERM_LENGTH = 40;

/**
 * Bounds one row's index entry. Statements are capped well below this by the
 * validator, so the cap is a backstop against a pathological input rather
 * than an everyday trim — but it is deterministic when it does bite: the
 * first N in emission order, never a sample.
 */
export const MEMORY_RETRIEVAL_MAX_TERMS = 64;

// Han, Hiragana, Katakana, Hangul syllables and Hangul Jamo. Deliberately not
// a broad "not Latin" test: Cyrillic and Greek are word-delimited and belong
// with the Latin branch, and bigramming them would bloat the index for no
// recall.
const CJK_PATTERN =
    /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯ᄀ-ᇿ]/;

const isCjk = (character: string) => CJK_PATTERN.test(character);

/**
 * Latin-branch word characters: letters, marks and digits in any script,
 * plus the joiners that hold real words together. Everything else — spaces,
 * punctuation, symbols — is a boundary.
 */
const WORD_CHARACTER = /[\p{L}\p{M}\p{N}]/u;

const isWordCharacter = (character: string) => WORD_CHARACTER.test(character);

/**
 * Splits normalized text into runs, so each run can be tokenized by the rule
 * its script needs. A run is either entirely CJK or entirely not; punctuation
 * and whitespace end whichever run is open.
 */
function segment(text: string): { cjk: boolean; text: string }[] {
    const runs: { cjk: boolean; text: string }[] = [];
    let current: { cjk: boolean; text: string } | null = null;
    for (const character of text) {
        if (!isWordCharacter(character)) {
            current = null;
            continue;
        }
        const cjk = isCjk(character);
        if (!current || current.cjk !== cjk) {
            current = { cjk, text: "" };
            runs.push(current);
        }
        current.text += character;
    }
    return runs;
}

/**
 * Every adjacent character pair in a CJK run, plus the run itself when it is
 * a single character.
 *
 * Bigrams rather than whole runs because a run is a phrase, not a word:
 * "한국어문서" as one term matches only that exact phrase, while its bigrams
 * match a query for "한국어" too. Single characters are kept so a one-character
 * word ("茶") is findable at all — the price is some noise, which scoring
 * handles rather than the tokenizer.
 */
function bigrams(run: string): string[] {
    const characters = [...run];
    if (characters.length === 1) return [characters[0]];
    const terms: string[] = [];
    for (let index = 0; index + 1 < characters.length; index += 1) {
        terms.push(characters[index] + characters[index + 1]);
    }
    return terms;
}

/**
 * The tokens for one piece of text. Order is emission order — first
 * occurrence wins — so the same input always produces the same array, which
 * is what makes a stored index comparable with a freshly computed one.
 */
export function memoryRetrievalTerms(
    text: string,
    { maxTerms = MEMORY_RETRIEVAL_MAX_TERMS }: { maxTerms?: number } = {}
): string[] {
    const normalized = text.normalize("NFC").toLowerCase();
    const seen = new Set<string>();
    const terms: string[] = [];
    const push = (term: string) => {
        if (term.length === 0 || term.length > MAX_TERM_LENGTH) return;
        if (seen.has(term)) return;
        seen.add(term);
        terms.push(term);
    };

    for (const run of segment(normalized)) {
        if (run.cjk) {
            for (const term of bigrams(run.text)) push(term);
            continue;
        }
        // A digit-only token is kept at any length: a year or a version number
        // is exactly the kind of thing a user asks about, and dropping "5"
        // from "GPT-5" would lose the distinguishing part.
        if (run.text.length >= MIN_LATIN_TERM_LENGTH || /^\p{N}+$/u.test(run.text)) {
            push(run.text);
        }
    }

    return terms.length > maxTerms ? terms.slice(0, maxTerms) : terms;
}

/**
 * Whether a stored row's terms still reflect the current algorithm and text.
 *
 * The comparison is order-sensitive on purpose: `memoryRetrievalTerms()` is
 * deterministic, so a row whose terms are a permutation of the expected set
 * was written by something else, and treating it as current would hide that.
 */
export function memoryTermsAreCurrent(
    row: { statement: string; searchTerms: readonly string[]; retrievalVersion: number },
    version = MEMORY_RETRIEVAL_VERSION
): boolean {
    if (row.retrievalVersion !== version) return false;
    const expected = memoryRetrievalTerms(row.statement);
    if (expected.length !== row.searchTerms.length) return false;
    return expected.every((term, index) => term === row.searchTerms[index]);
}
