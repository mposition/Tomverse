/** Fixed source allowlist for the provider-free Prompt Refiner shadow harness. */
import { createHash } from "node:crypto";

export const PROMPT_REFINER_SHADOW_CORPUS_PATH =
    "docs/ops/prompt-refiner-shadow/corpus-v1.json" as const;
export const PROMPT_REFINER_SHADOW_PACKAGE_LOCK_PATH =
    "package-lock.json" as const;
export const PROMPT_REFINER_SHADOW_PACKAGE_LOCK_MAX_BYTES = 4 * 1024 * 1024;
export const PROMPT_REFINER_SHADOW_OTHER_SOURCE_MAX_BYTES = 1024 * 1024;

export const PROMPT_REFINER_SHADOW_SOURCE_PATHS = Object.freeze([
    ".gitattributes",
    "package.json",
    PROMPT_REFINER_SHADOW_PACKAGE_LOCK_PATH,
    "tsconfig.json",
    PROMPT_REFINER_SHADOW_CORPUS_PATH,
    "lib/promptRefinerShadowHarness.ts",
    "lib/promptRefinerShadowJournal.ts",
    "lib/promptRefinerShadowSource.ts",
    "lib/promptRefinerModelPrompt.ts",
    "lib/promptInjectionAudit.ts",
    "lib/promptRefinerSuggestion.ts",
    "lib/routerDevelopmentBenchmark.ts",
    "scripts/prompt-refiner-shadow-harness.mjs",
] as const);

export const PROMPT_REFINER_SHADOW_SOURCE_IDENTITY_VERSION =
    "prompt-refiner-shadow-source-v1" as const;

export type PromptRefinerShadowSourceIdentity = {
    sourceRef: string;
    identityDigest: string;
    files: Record<string, string>;
};

function fail(code: string): never {
    throw new Error(`prompt_refiner_shadow_${code}`);
}

const sha256 = (value: string): string =>
    createHash("sha256").update(value, "utf8").digest("hex");

export function promptRefinerShadowSourceIdentityDigest(input: {
    sourceRef: string;
    files: Readonly<Record<string, string>>;
}): string {
    const files = Object.fromEntries(
        Object.entries(input.files).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0
        )
    );
    return sha256(
        JSON.stringify({
            schemaVersion: PROMPT_REFINER_SHADOW_SOURCE_IDENTITY_VERSION,
            sourceRef: input.sourceRef,
            files,
        })
    );
}

/**
 * The source ref is operator-selected. Imported data cannot add paths. Exact
 * byte equality deliberately rejects EOL-only drift.
 */
export function validatePromptRefinerShadowSource(input: {
    sourceRef: string;
    anchored: Readonly<Record<string, string>>;
    current: Readonly<Record<string, string>>;
}): PromptRefinerShadowSourceIdentity {
    if (!/^[a-f0-9]{40}$/.test(input.sourceRef)) {
        fail("source_ref_required_full_sha");
    }
    const expectedPaths = [...PROMPT_REFINER_SHADOW_SOURCE_PATHS].sort();
    for (const collection of [input.anchored, input.current]) {
        const actualPaths = Object.keys(collection).sort();
        if (
            actualPaths.length !== expectedPaths.length ||
            actualPaths.some((path, index) => path !== expectedPaths[index])
        ) {
            fail("source_path_allowlist");
        }
    }
    const files: Record<string, string> = {};
    for (const path of expectedPaths) {
        if (input.anchored[path] !== input.current[path]) {
            fail("runtime_source_drift");
        }
        files[path] = sha256(input.current[path]);
    }
    return {
        sourceRef: input.sourceRef,
        identityDigest: promptRefinerShadowSourceIdentityDigest({
            sourceRef: input.sourceRef,
            files,
        }),
        files,
    };
}
