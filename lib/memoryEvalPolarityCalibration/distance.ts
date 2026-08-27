/**
 * How far a polarity marker is from the fact it is supposed to negate.
 *
 * ## This is a diagnostic, not the scoring contract
 *
 * `.github/audits/memory-eval-gold-contract-2026-08-27.md` §9.3 settled
 * polarity a different way: the gold carries a `polarity` field, v6's output
 * carries one too, and scoring compares the two fields. Nothing reads a
 * polarity out of prose any more, so **no `K` appears in `mem-score-v3` or in
 * `scoringContractDigest`, and no gate reads this file** (§9.4).
 *
 * What it is for now is raising disagreements for a person to look at: a
 * candidate whose own sentence carries a marker beside the fact while its
 * `polarity` field says `affirmed` is worth a human's attention. Nothing rests
 * on the answer, which is why a distance with no margin is tolerable here and
 * was not tolerable as a scoring rule.
 *
 * ## Why it could not be the scoring rule
 *
 * Scanning the whole statement for a marker is not enough: *"사용자는 인천에
 * 살며 이사 계획이 없다"* asserts the opposite of a `negated` gold about 인천
 * and contains 없. The marker is there; it belongs to something else.
 *
 * Proximity was the cheapest rule that separates those and stays
 * deterministic. Measured on the corpus built for it (§9), Korean admitted
 * exactly one value and English admitted none — `does not have access to a
 * printer` is 18 characters and `has two siblings and no children` is 6, so
 * any K catching the first misreads the second. §9.2 has the measurement.
 *
 * The definitions below were fixed before that corpus was written and are
 * unchanged since, apart from the two defects §9.1 records.
 */
import { canon, canonNS } from "@/lib/memoryEvalPolarityCalibration/normalise";

/**
 * Negation markers, per language.
 *
 * Reviewed once and pinned, rather than invented per gold — inventing them per
 * gold is what produced `한양대에 다닌 적 없`, a string only its author would
 * write.
 *
 * `cannot` was added 2026-08-27, after the first calibration run
 * (`.github/audits/memory-eval-gold-contract-2026-08-27.md` §9.1). Once
 * markers are matched as whole words, `not` no longer reaches inside it, and a
 * list of English negations that omits `cannot` is a list with a hole in it.
 * The amendment makes the corpus harder, not easier: it caps `en` from above
 * on `cal-en-aff-4`, where nothing capped it before.
 */
export const POLARITY_MARKERS: Readonly<Record<"ko" | "en", readonly string[]>> =
    {
        ko: ["않", "없", "아니", "못"],
        en: ["not", "never", "no", "without", "cannot"],
    };

/**
 * The string a language's distance is measured in.
 *
 * Not one form for both. Korean spacing is unreliable, so it is measured
 * without spaces; English delimits its words *with* them, and taking them away
 * fabricates markers that span word boundaries — `lives in Ottawa` becomes
 * `livesinottawa`, which contains `not`. That defect made every English
 * affirmative unreachable at every K in the first run.
 *
 * The unit therefore differs by language: Korean counts characters of
 * `canonNS`, English counts characters of `canon`, spaces included. `K` is per
 * language already, so the two never have to be compared.
 */
const measurementForm = (value: string, language: "ko" | "en"): string =>
    language === "ko" ? canonNS(value) : canon(value);

/**
 * Whether a match at `[start, end)` respects the language's own boundaries.
 *
 * English markers must be whole words: `no` inside `know`, `not` inside
 * `nothing`, and `never` inside a name are not negations. Korean has no such
 * boundary to test — its markers are morphemes bound to the stem they negate,
 * which is exactly why they are matched as substrings.
 *
 * This is asked of markers only. Fact values stay substrings in both
 * languages, because a gold may name a stem.
 */
const respectsBoundary = (
    haystack: string,
    start: number,
    end: number,
    language: "ko" | "en"
): boolean => {
    if (language === "ko") return true;
    const before = start === 0 ? "" : haystack[start - 1];
    const after = end >= haystack.length ? "" : haystack[end];
    return !/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after);
};

/** Every index at which `needle` occurs in `haystack`. */
const occurrences = (haystack: string, needle: string): number[] => {
    if (needle === "") return [];
    const out: number[] = [];
    for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
        out.push(at);
    }
    return out;
};

/**
 * The smallest gap between any fact-value occurrence and any marker, measured
 * in characters of the language's own measurement form.
 *
 * `null` when the statement carries no marker, or none of the fact values
 * occurs — in both cases there is no distance to speak of, and the caller
 * decides what that means.
 *
 * The gap is between the two spans and ignores their order: a marker before
 * the fact denies it as readily as one after, and Korean puts it after where
 * English puts it before. Several occurrences resolve to the minimum, because
 * the question is whether a marker sits near the fact, not whether all of them
 * do.
 *
 * Measured from `factValueAll` only. `factValueAny` is expression variation
 * once polarity is a field of its own, so it is not an anchor point.
 */
export function polarityGap(input: {
    statement: string;
    factValueAll: readonly string[];
    language: "ko" | "en";
}): number | null {
    const { language } = input;
    const statement = measurementForm(input.statement, language);

    // Boundaries apply to markers and not to fact values. A marker is a short
    // function word from a closed list, and `no` inside `know` is not one; a
    // fact value is content, and `sibling` is written for `siblings` on
    // purpose — the narrow stem list of
    // `.github/audits/memory-eval-gold-contract-2026-08-27.md` §2.1 is prefix
    // matching, which a boundary test would abolish.
    const spans = (needles: readonly string[], wholeWord: boolean) =>
        needles.flatMap((needle) => {
            const canonical = measurementForm(needle, language);
            return occurrences(statement, canonical)
                .map((at) => ({ start: at, end: at + canonical.length }))
                .filter(
                    (span) =>
                        !wholeWord ||
                        respectsBoundary(statement, span.start, span.end, language)
                );
        });

    const factOccurrences = spans(input.factValueAll, false);
    if (factOccurrences.length === 0) return null;

    const markerOccurrences = spans(POLARITY_MARKERS[language], true);
    if (markerOccurrences.length === 0) return null;

    let smallest = Number.POSITIVE_INFINITY;
    for (const fact of factOccurrences) {
        for (const marker of markerOccurrences) {
            // The gap between the spans, whichever comes first. Overlapping
            // spans give 0 rather than a negative number.
            const gap =
                marker.start >= fact.end
                    ? marker.start - fact.end
                    : fact.start >= marker.end
                      ? fact.start - marker.end
                      : 0;
            if (gap < smallest) smallest = gap;
        }
    }
    return smallest;
}

/**
 * Whether a statement carries the gold's polarity, under a given `K`.
 *
 * `affirmed` is the absence of a nearby marker rather than the presence of an
 * affirmation: languages mark negation and leave assertion unmarked, so there
 * is nothing to look for on the positive side.
 *
 * The boundary is inclusive — `gap <= K` — because it is easier to state and
 * to argue about than a half-open one, and the corpus was labelled against
 * that reading.
 */
export function polarityMatches(input: {
    statement: string;
    factValueAll: readonly string[];
    language: "ko" | "en";
    polarity: "affirmed" | "negated";
    k: number;
}): boolean {
    const gap = polarityGap(input);
    const denied = gap !== null && gap <= input.k;
    return input.polarity === "negated" ? denied : !denied;
}
