import "server-only";

/**
 * Read-only server-side source snapshot for the approved *development*
 * candidate. It is not the successor runner closure, an exact deployment
 * attestation, a price check, or a durable reservation authority. Those must
 * be added and bound in the same short server transaction before any spend.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { readExactCheckoutFile } from "./promptRefinerStageAdmission";
import {
    PROMPT_REFINER_RUNTIME_SOURCE_FILE_MAX_BYTES,
    PROMPT_REFINER_RUNTIME_SOURCE_TOTAL_MAX_BYTES,
} from "./promptRefinerStageAdmissionCore";
import { parseBenchmarkJson } from "./routerDevelopmentBenchmark";

const CLOSURE_PATH =
    "docs/ops/prompt-refiner-quality-evaluation-vnext-candidate-source-closure.json";
const POLICY_PATH =
    "docs/policy/prompt-refiner-quality-evaluation-vnext-one-shot-v2.md";
const NUMERIC_PATH =
    "docs/ops/prompt-refiner-quality-evaluation-vnext-numeric-spec-draft.md";
const CLOSURE_SHA =
    "a562e32bc47c5800ff9c6e6a42b1873f348c68d6ff7eae592caf9385bf4524c3";
const POLICY_SHA =
    "dacdaab3360b7d848ea622bf83cc6a49c519c8a2f50ed1bc2d8b34a9a5b5ef7b";
const NUMERIC_SHA =
    "a1ebccdbbe10c02725d73686235f379f51abd38f5cf8a6acd9e3ba294edbbfea";
const SHA = /^[0-9a-f]{64}$/;
const SOURCE_PATH = /^(?:docs\/ops|docs\/policy|lib|tests)\/[a-zA-Z0-9/_./-]+\.(?:md|json|ts|mjs)$/;

const digest = (bytes: Uint8Array): string =>
    createHash("sha256").update(bytes).digest("hex");
const fail = (code: string): never => { throw new Error(code); };

/** Pure mapping; exposes only a closed reason, never a path or raw I/O detail. */
export function promptRefinerVnextOneShotSourceReadFailureCode(error: unknown): string {
    // The safe reader's code/status are own data fields. Inspect those exact
    // fields rather than module-instance identity, which test loaders can
    // duplicate; unknown errors still collapse to unavailable.
    if (error instanceof Error &&
        Object.getOwnPropertyDescriptor(error, "status")?.value === 503) {
        const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
        switch (code) {
            // The boundary branch is defensive: every current path is a pinned
            // constant beneath the resolved root, with traversal rejected.
            case "PROMPT_REFINER_STAGE_SOURCE_BOUNDARY":
                return "vnext_one_shot_source_boundary";
            case "PROMPT_REFINER_STAGE_SOURCE_NOT_REGULAR":
                return "vnext_one_shot_source_not_regular";
            case "PROMPT_REFINER_STAGE_SOURCE_CHANGED":
                return "vnext_one_shot_source_changed";
            case "PROMPT_REFINER_STAGE_SOURCE_SIZE":
                return "vnext_one_shot_source_size";
        }
    }
    return "vnext_one_shot_source_unavailable";
}

async function readPinned(
    root: string,
    path: string,
    expected: string,
    remainingBytes: number
): Promise<Uint8Array> {
    // Current SHA-pinned files cannot exhaust this cap; retain the guard for
    // a future closure update and to fail before any additional allocation.
    if (remainingBytes <= 0) return fail("vnext_one_shot_source_total_size");
    let bytes: Uint8Array;
    try {
        bytes = await readExactCheckoutFile(root, path, {
            maxBytes: Math.min(PROMPT_REFINER_RUNTIME_SOURCE_FILE_MAX_BYTES, remainingBytes),
        });
    } catch (error) {
        return fail(promptRefinerVnextOneShotSourceReadFailureCode(error));
    }
    if (digest(bytes) !== expected) return fail("vnext_one_shot_source_drift");
    return bytes;
}

/** No caller-supplied manifest paths or approved hashes are accepted. */
export async function verifyPromptRefinerVnextOneShotDevelopmentSource(
    checkoutRoot: string
): Promise<Readonly<{
    policySha256: string;
    numericSpecSha256: string;
    developmentClosureSha256: string;
    verifiedFileCount: number;
    deploymentAttested: false;
    priceVerified: false;
    reservationVerified: false;
    successorClosureVerified: false;
    dispatchAuthorized: false;
}>> {
    if (typeof checkoutRoot !== "string" || !checkoutRoot.trim()) {
        return fail("vnext_one_shot_source_root_invalid");
    }
    const root = resolve(checkoutRoot);
    let remainingBytes = PROMPT_REFINER_RUNTIME_SOURCE_TOTAL_MAX_BYTES;
    const takePinned = async (path: string, expected: string): Promise<Uint8Array> => {
        const bytes = await readPinned(root, path, expected, remainingBytes);
        remainingBytes -= bytes.byteLength;
        return bytes;
    };
    const closureBytes = await takePinned(CLOSURE_PATH, CLOSURE_SHA);
    const policyBytes = await takePinned(POLICY_PATH, POLICY_SHA);
    let parsed: unknown;
    try {
        parsed = parseBenchmarkJson(Buffer.from(closureBytes).toString("utf8"));
    } catch {
        return fail("vnext_one_shot_source_closure_invalid");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return fail("vnext_one_shot_source_closure_invalid");
    }
    const closure = parsed as Record<string, unknown>;
    // A byte-pinned closure cannot have a different version, scope or file set
    // without a SHA-256 collision. Keep these checks for a future pin update.
    if (closure.version !== "prompt-refiner-vnext-development-source-closure-v1" ||
        closure.scope !== "development_only" ||
        closure.providerDispatchAuthorized !== false ||
        closure.files === null || typeof closure.files !== "object" ||
        Array.isArray(closure.files)) {
        return fail("vnext_one_shot_source_closure_invalid");
    }
    const files = Object.entries(closure.files as Record<string, unknown>);
    if (files.length !== 15 || files.some(([path, hash]) =>
        !SOURCE_PATH.test(path) || path.split("/").includes("..") ||
        typeof hash !== "string" || !SHA.test(hash)
    ) || files.find(([path]) => path === NUMERIC_PATH)?.[1] !== NUMERIC_SHA) {
        return fail("vnext_one_shot_source_closure_invalid");
    }
    let numericBytes: Uint8Array | null = null;
    for (const [path, hash] of files) {
        const bytes = await takePinned(path, hash as string);
        if (path === NUMERIC_PATH) numericBytes = bytes;
    }
    if (numericBytes === null) return fail("vnext_one_shot_source_closure_invalid");
    return Object.freeze({
        policySha256: digest(policyBytes),
        numericSpecSha256: digest(numericBytes),
        developmentClosureSha256: digest(closureBytes),
        // The closure already includes the numeric spec. Count distinct files:
        // its 15 entries, the closure JSON, and the separately approved v2.
        verifiedFileCount: files.length + 2,
        deploymentAttested: false,
        priceVerified: false,
        reservationVerified: false,
        // This module cannot pin its own bytes without an external deployment
        // trust anchor. A separate development-only closure test tracks them;
        // an operational successor must independently attest its full closure.
        successorClosureVerified: false,
        dispatchAuthorized: false,
    });
}
