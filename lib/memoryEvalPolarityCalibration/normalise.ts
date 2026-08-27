/**
 * Re-export of the contract's canonicalisation, for the diagnostic corpus.
 *
 * The table used to live here, and from `mem-score-v3` it belongs to the
 * scoring contract instead (`lib/memoryEvalCanonicalisation.ts`,
 * `.github/audits/memory-eval-gold-contract-2026-08-27.md` §1③). A diagnostic
 * may not own a contract term: if this file still held the table, editing it
 * would move scoring while nothing said so.
 *
 * Kept as a file rather than deleted so the calibration module's imports keep
 * naming the thing they mean, and so this note sits where the table used to
 * be for anyone following an older reference.
 */

export {
    APPROVED_STEMS,
    CANON_STEP_ORDER,
    KOREAN_COUNTERS,
    NUMERAL_TABLE,
    canon,
    canonMatch,
    canonNS,
} from "@/lib/memoryEvalCanonicalisation";
