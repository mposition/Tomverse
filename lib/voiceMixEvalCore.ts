/**
 * VOICE-MIX-01: offline scoring for Korean-English mixed dictation.
 *
 * Protocol: docs/ops/voice-mix-eval/README.md.
 *
 * This module never calls a provider and never sees audio. It takes the
 * reviewed script corpus (`docs/ops/voice-mix-eval/corpus.v1.json`), a
 * pre-registered run manifest and the transcripts each arm produced, and
 * reports each measure on its own. Framework-free, like
 * `lib/voiceTranscriptionPortCore.ts`, so every rule can be driven from a test.
 *
 * ## Why no single "recognition rate"
 *
 * The failures this evaluation exists to tell apart have different fixes: a
 * Korean character error, a dropped English clause, "30 -> 60" heard as
 * "60 -> 30", and a hint word the model wrote although nobody said it. One
 * blended percentage would let a hint that fixes product names while inserting
 * them into unrelated sentences look like an improvement.
 *
 * ## Units and alignment
 *
 * A script is read as one ordered sequence of units: each Hangul syllable is a
 * unit, and each Latin or digit word is a unit. The transcript is read the same
 * way, and the two are aligned once, with a Levenshtein alignment that keeps
 * order. Everything positional -- the Korean character error rate, the English
 * word error rate, which segment of a language switch survived, whether a
 * missing English clause came back as Korean -- is read off that one alignment.
 * Scoring each language's projection separately let a transcript that said
 * the two halves in the wrong order score perfectly.
 *
 * Error rates are corpus (micro) rates: total errors over total reference units
 * of that language, never a mean of per-transcript rates.
 *
 * They measure fidelity to the script's spelling. A Korean transliteration an
 * item accepts for a key term ("스테이징" for "staging") keeps the term, and is
 * still an English word error: both statements are true and are reported apart.
 *
 * ## Matching accepted forms
 *
 * A Latin or digit edge of an accepted form must sit on a token boundary, so
 * "30" does not match "300" and "API" does not match "rapid". Hangul is
 * compared without spaces, because Korean spacing and particles vary ("배포하지
 * 마세요" / "배포하지마세요", "API의"); a Hangul form can therefore match inside a
 * longer Hangul word, which is a known limit the corpus avoids by choosing
 * distinctive Hangul forms.
 *
 * ## Pre-registered
 *
 * The unit rules, the omission threshold and the translation rule are fixed
 * here, in code, before any transcript exists. Changing them after seeing
 * results is changing the question; it needs a new `VOICE_MIX_SCORING_VERSION`
 * and a note in the protocol saying why.
 */

export const VOICE_MIX_SCORING_VERSION = "voice-mix-scoring-v3";

/**
 * A segment counts as omitted when fewer than this share of its units are
 * matched, in order, by the alignment. Half: a segment with one misheard word
 * is an accuracy problem, one with most of it missing is a dropped switch.
 */
export const SEGMENT_OMISSION_COVERAGE = 0.5;

/**
 * The comparison the protocol registers (docs/ops/voice-mix-eval/README.md §3).
 * A manifest that departs from it is refused, not scored: fewer takes, fewer
 * repeats, a subset of the holdout or a changed prompt is a different question.
 */
export const VOICE_MIX_PROTOCOL = {
    arms: { control: "no-hint", hinted: "hint" },
    minSpeakers: 2,
    minConditions: 2,
    repeats: 3,
} as const;

export type VoiceMixLanguage = "ko" | "en";

export type VoiceMixAcceptedForms = {
    /** A short label for reports; never compared. */
    label: string;
    /** Every spelling that counts. */
    accept: string[];
};

export type VoiceMixCorpusItem = {
    id: string;
    /** `dev` may be listened to while building the hint; `holdout` may not. */
    split: "dev" | "holdout";
    /** What the speaker reads, verbatim. */
    script: string;
    /** The script cut at its language switches, in order. */
    segments: Array<{ language: VoiceMixLanguage; text: string }>;
    keyTerms: VoiceMixAcceptedForms[];
    /** Meaning that must survive, such as a negation. A lexical proxy, not a semantic judgement. */
    meaning: VoiceMixAcceptedForms[];
    /** Numbers in the order they are spoken; the order is the check. */
    numbers: VoiceMixAcceptedForms[];
};

export type VoiceMixCorpus = {
    version: string;
    /** Terms the hinted arm sends, frozen from the dev scripts before holdout was written. */
    hintVocabulary: string[];
    /** The exact prompt the hinted arm sends. */
    hintPrompt: string;
    items: VoiceMixCorpusItem[];
};

export type VoiceMixTranscript = {
    itemId: string;
    /** The recording: `speaker/condition`, as the manifest names it. */
    take: string;
    /** 1-based transcription repeat of that recording. */
    repeat: number;
    transcript: string;
};

export type VoiceMixRun = {
    arm: string;
    model: string;
    /** Exactly what was sent as the prompt, or null when none was. */
    prompt: string | null;
    entries: VoiceMixTranscript[];
};

export type VoiceMixManifest = {
    corpus: string;
    /** SHA-256 of the corpus file as registered, so the corpus cannot change under the same version. */
    corpusDigest: string;
    scoringVersion: string;
    items: string[];
    takes: string[];
    repeats: number;
    arms: Array<{ arm: string; model: string; prompt: string | null }>;
};

/* ------------------------------------------------------------ tokens ---- */

type UnitKind = "hangul" | "word";
type Unit = { kind: UnitKind; text: string };

const HANGUL = /\p{Script=Hangul}/u;

/** NFKC, lower-case, punctuation and symbols to spaces, whitespace collapsed. */
export const normalizeVoiceMixText = (text: string): string =>
    text
        .normalize("NFKC")
        .toLowerCase()
        .replace(/'/gu, "")
        .replace(/[\p{P}\p{S}]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();

/** Hangul syllables and Latin/digit words, in order. Everything else is a separator. */
const unitsOf = (text: string): Unit[] => {
    const units: Unit[] = [];
    for (const match of normalizeVoiceMixText(text).matchAll(/\p{Script=Hangul}|[\p{Script=Latin}0-9]+/gu)) {
        const value = match[0];
        units.push({ kind: HANGUL.test(value) ? "hangul" : "word", text: value });
    }
    return units;
};

/**
 * The matching form of a text: Hangul runs joined without separators, every
 * other boundary a `|`, wrapped in `|`. "이 API의 timeout" -> "|이|api|의|timeout|".
 */
const boundaryForm = (text: string): string => {
    let out = "|";
    let previous: UnitKind | null = null;
    for (const unit of unitsOf(text)) {
        if (!(previous === "hangul" && unit.kind === "hangul")) out += out.endsWith("|") ? "" : "|";
        out += unit.text;
        previous = unit.kind;
    }
    return out.endsWith("|") ? out : `${out}|`;
};

/** Where an accepted form first occurs in a boundary form, respecting Latin/digit edges; -1 if nowhere. */
const findForm = (haystack: string, form: string): number => {
    const needle = boundaryForm(form).slice(1, -1);
    if (needle.length === 0) return -1;
    const startsHangul = HANGUL.test(needle[0]);
    const endsHangul = HANGUL.test(needle[needle.length - 1]);
    let from = 0;
    for (;;) {
        const index = haystack.indexOf(needle, from);
        if (index < 0) return -1;
        const before = haystack[index - 1];
        const after = haystack[index + needle.length];
        const startOk = startsHangul ? true : before === "|";
        const endOk = endsHangul ? true : after === "|";
        if (startOk && endOk) return index;
        from = index + 1;
    }
};

export const containsVoiceMixForm = (text: string, form: string) => findForm(boundaryForm(text), form) >= 0;

/* --------------------------------------------------------- alignment ---- */

/** Levenshtein distance over any sequence. */
export const editDistance = <T>(reference: readonly T[], hypothesis: readonly T[]): number =>
    alignUnits(
        reference.map((value) => ({ kind: "word" as const, text: String(value) })),
        hypothesis.map((value) => ({ kind: "word" as const, text: String(value) }))
    ).filter((op) => op.type !== "match").length;

type AlignOp =
    | { type: "match"; ref: number; hyp: number }
    | { type: "sub"; ref: number; hyp: number }
    | { type: "del"; ref: number }
    | { type: "ins"; hyp: number };

/** One order-keeping minimum-edit alignment, deterministic on ties (match/sub, then del, then ins). */
const alignUnits = (reference: readonly Unit[], hypothesis: readonly Unit[]): AlignOp[] => {
    const rows = reference.length;
    const cols = hypothesis.length;
    const cost: number[][] = Array.from({ length: rows + 1 }, (_, r) =>
        Array.from({ length: cols + 1 }, (_, c) => (r === 0 ? c : c === 0 ? r : 0))
    );
    for (let r = 1; r <= rows; r += 1) {
        for (let c = 1; c <= cols; c += 1) {
            const same = reference[r - 1].text === hypothesis[c - 1].text ? 0 : 1;
            cost[r][c] = Math.min(cost[r - 1][c - 1] + same, cost[r - 1][c] + 1, cost[r][c - 1] + 1);
        }
    }
    const ops: AlignOp[] = [];
    let r = rows;
    let c = cols;
    while (r > 0 || c > 0) {
        if (r > 0 && c > 0) {
            const same = reference[r - 1].text === hypothesis[c - 1].text;
            if (cost[r][c] === cost[r - 1][c - 1] + (same ? 0 : 1)) {
                ops.push(same ? { type: "match", ref: r - 1, hyp: c - 1 } : { type: "sub", ref: r - 1, hyp: c - 1 });
                r -= 1;
                c -= 1;
                continue;
            }
        }
        if (r > 0 && cost[r][c] === cost[r - 1][c] + 1) {
            ops.push({ type: "del", ref: r - 1 });
            r -= 1;
            continue;
        }
        ops.push({ type: "ins", hyp: c - 1 });
        c -= 1;
    }
    return ops.reverse();
};

/* ----------------------------------------------------------- scoring ---- */

export type VoiceMixItemScore = {
    itemId: string;
    take: string;
    repeat: number;
    split: "dev" | "holdout";
    /** Whether the script contains a hint vocabulary term (the prompted-target stratum). */
    hintTargetInScript: boolean;
    korean: { errors: number; units: number };
    english: { errors: number; units: number };
    keyTermsFound: number;
    keyTermsTotal: number;
    missingKeyTerms: string[];
    meaningFound: number;
    meaningTotal: number;
    missingMeaning: string[];
    /** null when the item has fewer than two numbers. */
    numbersInOrder: boolean | null;
    missingNumbers: string[];
    /**
     * `transliterated`: an omitted English segment whose key term came back in
     * one of the item's accepted Hangul spellings ("staging" -> "스테이징"). That is
     * a spelling the item accepts, so it is not counted as a translation.
     */
    segments: Array<{
        language: VoiceMixLanguage;
        units: number;
        matched: number;
        omitted: boolean;
        transliterated: boolean;
        likelyTranslated: boolean;
    }>;
    insertedHintTerms: string[];
};

export const scoreVoiceMixTranscript = (corpus: VoiceMixCorpus, entry: VoiceMixTranscript): VoiceMixItemScore => {
    const item = corpus.items.find((candidate) => candidate.id === entry.itemId);
    if (!item) throw new Error(`transcript names an item the corpus does not have: ${entry.itemId}`);

    const heard = boundaryForm(entry.transcript);
    const found = (forms: VoiceMixAcceptedForms) =>
        forms.accept.map((form) => findForm(heard, form)).filter((index) => index >= 0);

    const missingKeyTerms = item.keyTerms.filter((term) => found(term).length === 0).map((term) => term.label);
    const missingMeaning = item.meaning.filter((term) => found(term).length === 0).map((term) => term.label);
    const numberPositions = item.numbers.map((number) => {
        const positions = found(number);
        return positions.length === 0 ? -1 : Math.min(...positions);
    });
    const missingNumbers = item.numbers.filter((_, index) => numberPositions[index] < 0).map((number) => number.label);
    const numbersInOrder =
        item.numbers.length < 2
            ? null
            : missingNumbers.length === 0 &&
              numberPositions.every((position, index) => index === 0 || position > numberPositions[index - 1]);

    // One ordered reference sequence, each unit tagged with its segment.
    const reference: Unit[] = [];
    const segmentOf: number[] = [];
    item.segments.forEach((segment, index) => {
        for (const unit of unitsOf(segment.text)) {
            reference.push(unit);
            segmentOf.push(index);
        }
    });
    const hypothesis = unitsOf(entry.transcript);
    const ops = alignUnits(reference, hypothesis);

    const korean = { errors: 0, units: reference.filter((unit) => unit.kind === "hangul").length };
    const english = { errors: 0, units: reference.filter((unit) => unit.kind === "word").length };
    const bucket = (kind: UnitKind) => (kind === "hangul" ? korean : english);
    const matchedBySegment = item.segments.map(() => 0);
    const hangulInSegmentSpan = item.segments.map(() => 0);
    let lastRef = -1;
    for (const op of ops) {
        if (op.type === "match") {
            matchedBySegment[segmentOf[op.ref]] += 1;
            lastRef = op.ref;
        } else if (op.type === "sub") {
            bucket(reference[op.ref].kind).errors += 1;
            if (hypothesis[op.hyp].kind === "hangul") hangulInSegmentSpan[segmentOf[op.ref]] += 1;
            lastRef = op.ref;
        } else if (op.type === "del") {
            bucket(reference[op.ref].kind).errors += 1;
            lastRef = op.ref;
        } else {
            // An insertion is charged to the language of what was inserted, and
            // located in the segment it follows (or the first one).
            bucket(hypothesis[op.hyp].kind).errors += 1;
            if (hypothesis[op.hyp].kind === "hangul") {
                hangulInSegmentSpan[lastRef < 0 ? 0 : segmentOf[lastRef]] += 1;
            }
        }
    }

    const segments = item.segments.map((segment, index) => {
        const units = unitsOf(segment.text).length;
        const matched = matchedBySegment[index];
        // Omitted when fewer than half of the segment's units matched; exactly
        // half is not omitted.
        const omitted = units > 0 && matched / units < SEGMENT_OMISSION_COVERAGE;
        const segmentForm = boundaryForm(segment.text);
        const transliterated =
            omitted &&
            segment.language === "en" &&
            item.keyTerms.some(
                (term) =>
                    term.accept.some((form) => !HANGUL.test(form) && findForm(segmentForm, form) >= 0) &&
                    term.accept.some((form) => HANGUL.test(form) && findForm(heard, form) >= 0)
            );
        // A missing English clause replaced, in its own place, by Korean at
        // least as long as the clause had words -- unless that Korean is the
        // accepted transliteration of its term.
        const likelyTranslated =
            omitted && segment.language === "en" && !transliterated && hangulInSegmentSpan[index] >= units;
        return { language: segment.language, units, matched, omitted, transliterated, likelyTranslated };
    });

    const scriptForm = boundaryForm(item.script);
    const insertedHintTerms = corpus.hintVocabulary.filter(
        (term) => findForm(heard, term) >= 0 && findForm(scriptForm, term) < 0
    );

    return {
        itemId: item.id,
        take: entry.take,
        repeat: entry.repeat,
        split: item.split,
        hintTargetInScript: corpus.hintVocabulary.some((term) => findForm(scriptForm, term) >= 0),
        korean,
        english,
        keyTermsFound: item.keyTerms.length - missingKeyTerms.length,
        keyTermsTotal: item.keyTerms.length,
        missingKeyTerms,
        meaningFound: item.meaning.length - missingMeaning.length,
        meaningTotal: item.meaning.length,
        missingMeaning,
        numbersInOrder,
        missingNumbers,
        segments,
        insertedHintTerms,
    };
};

/* -------------------------------------------------------- aggregation ---- */

export type VoiceMixStratum = "all" | "hint-target" | "hint-absent";

export type VoiceMixAggregate = {
    scoringVersion: string;
    split: "dev" | "holdout" | "all";
    stratum: VoiceMixStratum;
    transcripts: number;
    /** Corpus rates: total errors / total reference units. null with no units. */
    koreanCharErrorRate: { rate: number | null; errors: number; units: number };
    englishWordErrorRate: { rate: number | null; errors: number; units: number };
    keyTerms: { found: number; total: number };
    meaning: { found: number; total: number };
    numberOrder: { kept: number; total: number };
    omittedSegments: { ko: { omitted: number; total: number }; en: { omitted: number; total: number } };
    likelyTranslated: { segments: number; transliterated: number; omittedEnglishSegments: number };
    hintInsertion: { transcripts: number; terms: number };
};

const rate = (errors: number, units: number) => (units === 0 ? null : Math.round((errors / units) * 10_000) / 10_000);
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

export const aggregateVoiceMixScores = (
    scores: VoiceMixItemScore[],
    split: "dev" | "holdout" | "all",
    stratum: VoiceMixStratum = "all"
): VoiceMixAggregate => {
    const chosen = scores.filter(
        (score) =>
            (split === "all" || score.split === split) &&
            (stratum === "all" || score.hintTargetInScript === (stratum === "hint-target"))
    );
    const segments = chosen.flatMap((score) => score.segments.filter((segment) => segment.units > 0));
    const koErrors = sum(chosen.map((score) => score.korean.errors));
    const koUnits = sum(chosen.map((score) => score.korean.units));
    const enErrors = sum(chosen.map((score) => score.english.errors));
    const enUnits = sum(chosen.map((score) => score.english.units));
    const ordered = chosen.filter((score) => score.numbersInOrder !== null);
    const bySegmentLanguage = (language: VoiceMixLanguage) => {
        const ofLanguage = segments.filter((segment) => segment.language === language);
        return { omitted: ofLanguage.filter((segment) => segment.omitted).length, total: ofLanguage.length };
    };
    return {
        scoringVersion: VOICE_MIX_SCORING_VERSION,
        split,
        stratum,
        transcripts: chosen.length,
        koreanCharErrorRate: { rate: rate(koErrors, koUnits), errors: koErrors, units: koUnits },
        englishWordErrorRate: { rate: rate(enErrors, enUnits), errors: enErrors, units: enUnits },
        keyTerms: { found: sum(chosen.map((s) => s.keyTermsFound)), total: sum(chosen.map((s) => s.keyTermsTotal)) },
        meaning: { found: sum(chosen.map((s) => s.meaningFound)), total: sum(chosen.map((s) => s.meaningTotal)) },
        numberOrder: { kept: ordered.filter((s) => s.numbersInOrder === true).length, total: ordered.length },
        omittedSegments: { ko: bySegmentLanguage("ko"), en: bySegmentLanguage("en") },
        likelyTranslated: {
            segments: segments.filter((segment) => segment.likelyTranslated).length,
            transliterated: segments.filter((segment) => segment.transliterated).length,
            omittedEnglishSegments: segments.filter((segment) => segment.language === "en" && segment.omitted).length,
        },
        hintInsertion: {
            transcripts: chosen.filter((score) => score.insertedHintTerms.length > 0).length,
            terms: sum(chosen.map((score) => score.insertedHintTerms.length)),
        },
    };
};

/* --------------------------------------------------------- integrity ---- */

/**
 * Structural checks on the corpus itself, run before any scoring: an answer key
 * that does not match its own script scores every transcript wrong.
 */
export const voiceMixCorpusProblems = (corpus: VoiceMixCorpus): string[] => {
    const problems: string[] = [];
    const ids = new Set<string>();
    for (const item of corpus.items) {
        if (ids.has(item.id)) problems.push(`${item.id}: duplicate id`);
        ids.add(item.id);
        const scriptUnits = unitsOf(item.script).map((unit) => unit.text).join(" ");
        const segmentUnits = item.segments.flatMap((segment) => unitsOf(segment.text)).map((unit) => unit.text).join(" ");
        if (scriptUnits !== segmentUnits) problems.push(`${item.id}: segments do not add up to the script`);
        for (const segment of item.segments) {
            const units = unitsOf(segment.text);
            const wrong = units.some((unit) => (segment.language === "ko") !== (unit.kind === "hangul"));
            if (wrong) problems.push(`${item.id}: a ${segment.language} segment carries units of the other language`);
        }
        const script = boundaryForm(item.script);
        for (const forms of [...item.keyTerms, ...item.meaning, ...item.numbers]) {
            if (forms.accept.length === 0) problems.push(`${item.id}: ${forms.label} accepts nothing`);
            for (const form of forms.accept) {
                if (boundaryForm(form) === "|") problems.push(`${item.id}: ${forms.label} has a form that normalises to nothing`);
            }
            if (!forms.accept.some((form) => findForm(script, form) >= 0)) {
                problems.push(`${item.id}: no accepted form of ${forms.label} appears in the script`);
            }
        }
    }
    for (const split of ["dev", "holdout"] as const) {
        if (!corpus.items.some((item) => item.split === split)) problems.push(`no ${split} items`);
    }
    // The hint may only name what the dev scripts already say.
    const devScripts = corpus.items.filter((item) => item.split === "dev").map((item) => boundaryForm(item.script));
    for (const term of corpus.hintVocabulary) {
        if (!devScripts.some((script) => findForm(script, term) >= 0)) {
            problems.push(`hint term ${term} does not come from a dev script`);
        }
        if (findForm(boundaryForm(corpus.hintPrompt), term) < 0) problems.push(`hint prompt does not carry ${term}`);
    }
    return problems;
};

/**
 * Whether a set of arm runs is exactly what the manifest registered: every
 * item x take x repeat once per arm, nothing extra, the model and the prompt as
 * registered, and the same recordings in every arm. A partial or curated run
 * is refused rather than scored.
 */
export const voiceMixRunProblems = (
    corpus: VoiceMixCorpus,
    corpusDigest: string,
    manifest: VoiceMixManifest,
    runs: VoiceMixRun[]
): string[] => {
    const problems: string[] = [];
    if (manifest.corpus !== corpus.version) problems.push(`manifest is for ${manifest.corpus}, corpus is ${corpus.version}`);
    if (manifest.corpusDigest !== corpusDigest) problems.push("manifest was registered against a different corpus file");

    // The registered protocol, before anything about the runs.
    const holdout = corpus.items.filter((item) => item.split === "holdout").map((item) => item.id).sort();
    if (JSON.stringify([...manifest.items].sort()) !== JSON.stringify(holdout)) {
        problems.push("manifest items must be exactly the corpus holdout items");
    }
    const speakers = new Set(manifest.takes.map((take) => take.split("/")[0]));
    const conditions = new Set(manifest.takes.map((take) => take.split("/")[1]));
    if (manifest.takes.some((take) => !/^[^/]+\/[^/]+$/.test(take))) problems.push("takes must be speaker/condition");
    if (new Set(manifest.takes).size !== manifest.takes.length) problems.push("takes repeat");
    if (speakers.size < VOICE_MIX_PROTOCOL.minSpeakers) {
        problems.push(`at least ${VOICE_MIX_PROTOCOL.minSpeakers} speakers are registered`);
    }
    if (conditions.size < VOICE_MIX_PROTOCOL.minConditions) {
        problems.push(`at least ${VOICE_MIX_PROTOCOL.minConditions} conditions are registered`);
    }
    if (manifest.takes.length !== speakers.size * conditions.size) problems.push("every speaker records every condition");
    if (manifest.repeats !== VOICE_MIX_PROTOCOL.repeats) problems.push(`repeats must be ${VOICE_MIX_PROTOCOL.repeats}`);
    const control = manifest.arms.find((arm) => arm.arm === VOICE_MIX_PROTOCOL.arms.control);
    const hinted = manifest.arms.find((arm) => arm.arm === VOICE_MIX_PROTOCOL.arms.hinted);
    if (manifest.arms.length !== 2 || !control || !hinted) problems.push("the arms are exactly no-hint and hint");
    if (control && control.prompt !== null) problems.push("the no-hint arm sends no prompt");
    if (hinted && hinted.prompt !== corpus.hintPrompt) problems.push("the hint arm sends exactly the corpus hintPrompt");
    if (control && hinted && control.model !== hinted.model) problems.push("both arms use the same model");
    for (const arm of manifest.arms) {
        if (typeof arm.model !== "string" || arm.model.trim() === "") problems.push(`arm ${String(arm.arm)} registers no model`);
    }
    if (manifest.scoringVersion !== VOICE_MIX_SCORING_VERSION) {
        problems.push(`manifest registered ${manifest.scoringVersion}, scorer is ${VOICE_MIX_SCORING_VERSION}`);
    }
    for (const id of manifest.items) {
        if (!corpus.items.some((item) => item.id === id)) problems.push(`manifest names unknown item ${id}`);
    }
    if (!Number.isSafeInteger(manifest.repeats) || manifest.repeats < 1) problems.push("manifest repeats must be a positive whole number");
    const expected = new Set<string>();
    for (const item of manifest.items) {
        for (const take of manifest.takes) {
            for (let repeat = 1; repeat <= manifest.repeats; repeat += 1) expected.add(`${item}::${take}::${repeat}`);
        }
    }
    const registeredArms = new Set(manifest.arms.map((arm) => arm.arm));
    for (const arm of manifest.arms) {
        if (!runs.some((run) => run.arm === arm.arm)) problems.push(`arm ${arm.arm} has no run`);
    }
    const seenArms = new Set<string>();
    for (const run of runs) {
        if (seenArms.has(run.arm)) problems.push(`arm ${run.arm} appears twice`);
        seenArms.add(run.arm);
        const registered = manifest.arms.find((arm) => arm.arm === run.arm);
        if (!registered || !registeredArms.has(run.arm)) {
            problems.push(`arm ${run.arm} is not in the manifest`);
            continue;
        }
        if (typeof run.model !== "string" || run.model.trim() === "") problems.push(`arm ${run.arm} names no model`);
        if (run.model !== registered.model) problems.push(`arm ${run.arm} ran ${run.model}, registered ${registered.model}`);
        if (run.prompt !== registered.prompt) problems.push(`arm ${run.arm} sent a prompt other than the registered one`);
        const seen = new Set<string>();
        for (const entry of run.entries) {
            const key = `${entry.itemId}::${entry.take}::${entry.repeat}`;
            if (seen.has(key)) problems.push(`arm ${run.arm}: duplicate ${key}`);
            seen.add(key);
            if (!expected.has(key)) problems.push(`arm ${run.arm}: unregistered ${key}`);
        }
        for (const key of expected) {
            if (!seen.has(key)) problems.push(`arm ${run.arm}: missing ${key}`);
        }
    }
    return problems;
};
