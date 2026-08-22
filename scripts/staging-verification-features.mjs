// Which features keep a staging verification checklist, and where.
//
// The checklist/record split was built for external import, with its two paths
// written into the checker and the generator as constants. Image generation
// needs the same guarantee and cannot have it by copying the scripts -- a
// second copy is a second thing to keep in step, and the whole reason the split
// exists is that a document went stale while looking current.
//
// So the paths move here and the scripts loop. Adding a feature is one entry
// plus its two files, and `tests/stagingVerificationFeatures.test.mjs` refuses
// an entry whose files are not there.
//
// `key` is what `--feature` takes on the command line. `label` is what a
// failure message calls it, so an operator reading one line of CI output knows
// which checklist is wrong without matching paths by eye.

export const STAGING_VERIFICATION_FEATURES = [
    {
        key: "external-import",
        label: "external conversation import (release A)",
        checklist: "docs/ops/external-import-staging-checklist.md",
        records: "docs/ops/staging-verification-records",
    },
    {
        key: "image-generation",
        label: "image generation v2 (multi-model)",
        checklist: "docs/ops/image-generation-staging-checklist.md",
        records: "docs/ops/image-generation-staging-verification-records",
    },
    {
        key: "generated-artifacts",
        label: "generated artifacts (real files)",
        checklist: "docs/ops/generated-artifacts-staging-checklist.md",
        records: "docs/ops/generated-artifacts-staging-verification-records",
    },
    {
        key: "assistant-profile",
        label: "assistant profiles (release C)",
        checklist: "docs/ops/assistant-profile-staging-checklist.md",
        records: "docs/ops/assistant-profile-staging-verification-records",
    },
    {
        key: "assistant-knowledge",
        label: "assistant knowledge files (release C)",
        checklist: "docs/ops/assistant-knowledge-staging-checklist.md",
        records: "docs/ops/assistant-knowledge-staging-verification-records",
    },
    {
        key: "chat-attachment",
        label: "chat attachment formats (archives, legacy Office, GIF)",
        checklist: "docs/ops/chat-attachment-staging-checklist.md",
        records: "docs/ops/chat-attachment-staging-verification-records",
    },
];

export const stagingVerificationFeature = (key) => {
    const feature = STAGING_VERIFICATION_FEATURES.find(
        (entry) => entry.key === key
    );
    if (!feature) {
        throw new Error(
            `Unknown staging verification feature: ${key}. ` +
                `Known: ${STAGING_VERIFICATION_FEATURES.map((entry) => entry.key).join(", ")}`
        );
    }
    return feature;
};
