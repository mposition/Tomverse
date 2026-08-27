/**
 * How far a polarity marker is from the fact it is supposed to negate.
 *
 * `.github/audits/memory-eval-gold-contract-2026-08-27.md` §②-1 fixes every
 * choice in here, and fixed them **before** the corpus was written. A distance
 * whose definition moves with the measurement is not a measurement.
 *
 * ## Why a distance at all
 *
 * Polarity leaves the token list and becomes a field, so the matcher has to
 * decide whether a statement denies the fact. Scanning the whole statement for
 * a marker is not enough: *"사용자는 인천에 살며 이사 계획이 없다"* asserts the
 * opposite of a `denies` gold about 인천 and contains 없. The marker is there;
 * it belongs to something else.
 *
 * Proximity is the cheapest rule that separates those and stays deterministic.
 * It is not linguistics — it does not know what the marker attaches to — so
 * `K` has to be measured rather than reasoned about, on a corpus built for
 * that and nothing else (§9).
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
 * `affirms` is the absence of a nearby marker rather than the presence of an
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
    polarity: "affirms" | "denies";
    k: number;
}): boolean {
    const gap = polarityGap(input);
    const denied = gap !== null && gap <= input.k;
    return input.polarity === "denies" ? denied : !denied;
}
