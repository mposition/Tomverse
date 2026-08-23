/**
 * The budget every legacy-Office parser is held to, and the errors it raises.
 *
 * Contract: docs/policy/chat-attachment-formats.md.
 *
 * ## Why these parsers are not in a worker
 *
 * `sharp`, `officeparser` and `pdfjs-dist` run in worker threads with a heap
 * ceiling and a deadline (`lib/mediaSecurity.ts`, `lib/officeSecurity.ts`).
 * They are large third-party parsers whose internals this repository does not
 * own, so the only honest bound on them is an external one.
 *
 * That mechanism is not available here. Those workers are built with
 * `eval: true` and reach their parser through `require("sharp")` -- a
 * node_modules package that exists on disk at runtime. A parser written in
 * this repository's own `lib/` has no such path: it is TypeScript that the
 * Next.js server build bundles, and an eval'd worker cannot `require` it.
 *
 * So the bound is internal, and it is the reason this file exists rather than
 * being a handful of constants scattered through four parsers:
 *
 *   * **A deadline**, checked by `tick()` in every loop that a file's own
 *     contents can lengthen -- sector chains, record streams, RTF groups. A
 *     hostile file cannot spin the request thread past it.
 *   * **A byte ceiling**, claimed *before* an allocation, not after. A
 *     container states its own stream sizes, so "read it and then check" is
 *     the wrong order.
 *   * **A character ceiling**, so the extracted text cannot outgrow what the
 *     turn can carry however much the document holds.
 *
 * The trade is deliberate and it is not "less safe by default": these parsers
 * allocate nothing the budget has not agreed to, recurse only to a fixed
 * depth, execute nothing, and read no macro, embedded object or external
 * reference. A worker would add memory isolation over code that already
 * cannot allocate freely.
 */

export type LegacyOfficeErrorCode =
    /** Not the format it claims, or damaged past the point of reading. */
    | "LEGACY_OFFICE_CORRUPT"
    /** Password-protected. Nothing here attempts to decrypt anything. */
    | "LEGACY_OFFICE_ENCRYPTED"
    /** Structurally sound, but no text this product can offer the model. */
    | "LEGACY_OFFICE_NO_TEXT"
    /** The document wants more of the budget than the request has. */
    | "LEGACY_OFFICE_TOO_LARGE"
    /** The deadline passed while parsing. */
    | "LEGACY_OFFICE_TIMEOUT";

export class LegacyOfficeError extends Error {
    constructor(public readonly code: LegacyOfficeErrorCode) {
        super(code);
        this.name = "LegacyOfficeError";
    }
}

export type LegacyParseBudget = {
    /**
     * Called in every loop a file's own contents can lengthen. Throws once
     * the deadline passes or the iteration allowance is spent.
     */
    readonly tick: () => void;
    /** Reserves bytes before they are allocated. Throws when they run out. */
    readonly claimBytes: (bytes: number) => void;
    /** How many characters of output are still allowed. */
    readonly charactersRemaining: () => number;
    /** Records characters produced. Throws when the ceiling is passed. */
    readonly claimCharacters: (count: number) => void;
};

export type LegacyParseLimits = {
    /** Wall-clock, from the moment the budget is created. */
    readonly timeoutMs: number;
    /** Total bytes any parser may pull out of the container. */
    readonly maxBytes: number;
    /** Total characters of extracted text. */
    readonly maxCharacters: number;
    /**
     * A backstop on loop iterations, so a file that somehow satisfies every
     * other bound still cannot run for the whole deadline doing nothing. High
     * enough that no real document reaches it.
     */
    readonly maxIterations: number;
};

/**
 * Numbers chosen against the attachment ceilings that already exist, not
 * invented here: `maxBytes` is twice the per-file upload limit because a
 * container legitimately holds more decompressed stream than file (the mini
 * stream is read once and indexed many times), and `maxCharacters` matches
 * the per-request extracted-text budget in the chat route.
 */
export const DEFAULT_LEGACY_PARSE_LIMITS: LegacyParseLimits = {
    timeoutMs: 12_000,
    maxBytes: 20 * 1024 * 1024,
    maxCharacters: 300_000,
    maxIterations: 5_000_000,
};

/**
 * `now` is injected so a test can prove the deadline fires without waiting
 * for it, and so nothing here reads a clock the caller did not choose.
 */
export function createLegacyParseBudget(
    limits: Partial<LegacyParseLimits> = {},
    now: () => number = () => Date.now()
): LegacyParseBudget {
    const resolved = { ...DEFAULT_LEGACY_PARSE_LIMITS, ...limits };
    const startedAt = now();
    let iterations = 0;
    let bytes = 0;
    let characters = 0;

    const tick = () => {
        iterations += 1;
        if (iterations > resolved.maxIterations) {
            throw new LegacyOfficeError("LEGACY_OFFICE_TOO_LARGE");
        }
        // Checked every 1024 iterations rather than every one: the clock read
        // would otherwise dominate the loop it is protecting.
        if ((iterations & 0x3ff) === 0 && now() - startedAt > resolved.timeoutMs) {
            throw new LegacyOfficeError("LEGACY_OFFICE_TIMEOUT");
        }
    };

    return {
        tick,
        claimBytes: (count) => {
            if (!Number.isFinite(count) || count < 0) {
                throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
            }
            bytes += count;
            if (bytes > resolved.maxBytes) {
                throw new LegacyOfficeError("LEGACY_OFFICE_TOO_LARGE");
            }
            tick();
        },
        charactersRemaining: () => Math.max(0, resolved.maxCharacters - characters),
        claimCharacters: (count) => {
            characters += count;
            if (characters > resolved.maxCharacters) {
                throw new LegacyOfficeError("LEGACY_OFFICE_TOO_LARGE");
            }
        },
    };
}
