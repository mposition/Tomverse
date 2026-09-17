import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
    PROMPT_REFINER_SHADOW_ADMISSION_EVIDENCE_BUNDLE_DIGEST,
    PROMPT_REFINER_SHADOW_ADMISSION_EVIDENCE_VERSION,
    PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_REF,
    PROMPT_REFINER_SHADOW_STAGE_ACKNOWLEDGEMENTS,
    PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_DIGEST,
    PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_VERSION,
    proposePromptRefinerShadowStage,
} from "../lib/promptRefinerShadowAdmissionCore.ts";
import {
    PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
    PROMPT_REFINER_EXECUTION_MODEL_PIN,
    PROMPT_REFINER_MAX_INPUT_TOKENS,
    PROMPT_REFINER_MAX_OUTPUT_TOKENS,
    PROMPT_REFINER_RETRY_COUNT,
    PROMPT_REFINER_TIMEOUT_MS,
    admitPromptRefinerExecution,
} from "../lib/promptRefinerExecutionContract.ts";
import {
    PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
    PROMPT_REFINER_RESERVATION_STAGE_ID,
    PROMPT_REFINER_RESERVATION_TTL_MS,
} from "../lib/promptRefinerReservationCore.ts";
import {
    canonicalBenchmarkJson,
} from "../lib/routerDevelopmentBenchmark.ts";
import { PROMPT_REFINER_VERSION } from "../lib/promptRefinerSuggestion.ts";

const root = resolve(import.meta.dirname, "..");
const evidenceRoot = join(root, "docs", "ops", "prompt-refiner-shadow", "evidence");
const paths = {
    manifest: join(evidenceRoot, "admission-readiness-v1.manifest.json"),
    report: join(evidenceRoot, "admission-readiness-v1.report.json"),
    journal: join(evidenceRoot, "admission-readiness-v1.journal.jsonl"),
    witness: join(
        evidenceRoot,
        "admission-readiness-v1.journal.jsonl.witness.jsonl"
    ),
    corpus: join(root, "docs", "ops", "prompt-refiner-shadow", "corpus-v1.json"),
};

const bytes = (path) => readFileSync(path);
const checkedIn = () => ({
    manifestBytes: bytes(paths.manifest),
    reportBytes: bytes(paths.report),
    journalBytes: bytes(paths.journal),
    witnessBytes: bytes(paths.witness),
    corpusBytes: bytes(paths.corpus),
});
const digest = (value) =>
    createHash("sha256").update(value).digest("hex");
const bundleDigest = (manifest) => {
    const {
        bundleDigest: ignored,
        ...body
    } = manifest;
    void ignored;
    return `sha256:${digest(canonicalBenchmarkJson(body))}`;
};
const manifestFor = (overrides = {}) => {
    const manifest = {
        ...JSON.parse(bytes(paths.manifest).toString("utf8")),
        ...overrides,
    };
    manifest.bundleDigest = bundleDigest(manifest);
    return Buffer.from(JSON.stringify(manifest), "utf8");
};
const evidenceWith = (overrides = {}) => {
    const original = checkedIn();
    const next = { ...original, ...overrides };
    const manifest = JSON.parse(original.manifestBytes.toString("utf8"));
    manifest.files = [
        fileFact(manifest.files[0].name, next.reportBytes),
        fileFact(manifest.files[1].name, next.journalBytes),
        fileFact(manifest.files[2].name, next.witnessBytes),
    ];
    const { bundleDigest: ignored, ...body } = manifest;
    void ignored;
    manifest.bundleDigest = `sha256:${digest(canonicalBenchmarkJson(body))}`;
    next.manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
    return next;
};
const fileFact = (name, value) => ({
    name,
    sizeBytes: value.byteLength,
    sha256: digest(value),
});
const hashPoison = (value) =>
    new Proxy(value, {
        get(target, property) {
            if (property === "byteLength") return target.byteLength;
            return Reflect.get(target, property, target);
        },
    });

test("checked-in evidence emits only the fixed content-free proposal", () => {
    const proposal = proposePromptRefinerShadowStage(checkedIn());
    assert.equal(proposal.schemaVersion, PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_VERSION);
    assert.equal(proposal.status, "awaiting_explicit_admin_cost_approval");
    assert.equal(proposal.executionAdmitted, false);
    assert.equal(proposal.currentCheckoutValidated, false);
    assert.equal(proposal.runtimeSourceRevalidationRequired, true);
    assert.equal(
        proposal.evidenceBundleDigest,
        PROMPT_REFINER_SHADOW_ADMISSION_EVIDENCE_BUNDLE_DIGEST
    );
    assert.equal(
        proposal.proposalDigest,
        "sha256:75198565b0bcc1e481c89c6ac8946d11793d28b7afbd96e18d36a03a27f06cc2"
    );
    assert.equal(
        proposal.proposalDigest,
        PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_DIGEST
    );
    assert.equal(proposal.provenance.sourceRef, PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_REF);
    assert.equal(proposal.reservationStage.stageId, PROMPT_REFINER_RESERVATION_STAGE_ID);
    assert.equal(
        proposal.reservationStage.contractDigest,
        PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST
    );
    assert.equal(proposal.reservationStage.perRequestCostMicroUsd, 24_916);
    assert.equal(proposal.reservationStage.maxReservations, 100);
    assert.equal(proposal.reservationStage.costCeilingMicroUsd, 2_491_600);
    assert.equal(
        proposal.reservationStage.reservationTtlMs,
        300_000
    );
    assert.equal(
        proposal.reservationStage.reservationTtlMs,
        PROMPT_REFINER_RESERVATION_TTL_MS
    );
    assert.deepEqual(
        proposal.acknowledgements,
        PROMPT_REFINER_SHADOW_STAGE_ACKNOWLEDGEMENTS
    );
    const serialized = JSON.stringify(proposal);
    for (const forbidden of [
        "approvedBy",
        "approvedAt",
        "sourceText",
        "fixtureOutput",
        "refinedPrompt",
        "providerError",
        '"currentCheckoutValidated":true',
        '"runtimeSourceRevalidationRequired":false',
    ]) {
        assert.equal(serialized.includes(forbidden), false, forbidden);
    }
    assert.deepEqual(
        proposePromptRefinerShadowStage(checkedIn()),
        proposal,
        "the proposal and digest are deterministic"
    );
});

test("the trusted proposal is deeply immutable without freezing shared constants", () => {
    const proposal = proposePromptRefinerShadowStage(checkedIn());
    const before = JSON.stringify(proposal);
    assert.equal(Object.isFrozen(proposal), true);
    assert.equal(Object.isFrozen(proposal.provenance), true);
    assert.equal(Object.isFrozen(proposal.reservationStage), true);
    assert.equal(Object.isFrozen(proposal.acknowledgements), true);
    assert.notEqual(
        proposal.acknowledgements,
        PROMPT_REFINER_SHADOW_STAGE_ACKNOWLEDGEMENTS,
        "the returned array must be a frozen clone, not the exported constant"
    );

    const mutations = [
        () => {
            proposal.status = "mutated";
        },
        () => {
            proposal.provenance = {};
        },
        () => {
            proposal.provenance.corpusDigest = "mutated";
        },
        () => {
            proposal.reservationStage = {};
        },
        () => {
            proposal.reservationStage.costCeilingMicroUsd = 0;
        },
        () => {
            proposal.acknowledgements = [];
        },
        () => {
            proposal.acknowledgements[0] = "mutated";
        },
        () => {
            proposal.acknowledgements.push("mutated");
        },
    ];
    for (const mutate of mutations) {
        assert.throws(mutate, TypeError);
    }
    assert.equal(JSON.stringify(proposal), before);
    assert.equal(
        proposal.proposalDigest,
        PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_DIGEST
    );
    assert.deepEqual(proposePromptRefinerShadowStage(checkedIn()), proposal);
});

test("captured freeze and private acknowledgements resist post-import ambient patches", () => {
    const originalFreeze = Object.freeze;
    const originalIterator = Array.prototype[Symbol.iterator];
    let proposal;
    let thrown;
    try {
        Object.freeze = (value) => value;
        Array.prototype[Symbol.iterator] = function patchedIterator() {
            if (this === PROMPT_REFINER_SHADOW_STAGE_ACKNOWLEDGEMENTS) {
                return originalIterator.call(["attacker_acknowledgement"]);
            }
            return originalIterator.call(this);
        };
        proposal = proposePromptRefinerShadowStage(checkedIn());
    } catch (error) {
        thrown = error;
    } finally {
        Object.freeze = originalFreeze;
        Array.prototype[Symbol.iterator] = originalIterator;
    }
    if (thrown) throw thrown;

    assert.deepEqual(
        proposal.acknowledgements,
        PROMPT_REFINER_SHADOW_STAGE_ACKNOWLEDGEMENTS
    );
    assert.equal(Object.isFrozen(proposal), true);
    assert.equal(Object.isFrozen(proposal.provenance), true);
    assert.equal(Object.isFrozen(proposal.reservationStage), true);
    assert.equal(Object.isFrozen(proposal.acknowledgements), true);
    assert.throws(() => proposal.acknowledgements.push("mutated"), TypeError);
    const { proposalDigest, ...unsigned } = proposal;
    assert.equal(
        `sha256:${digest(canonicalBenchmarkJson(unsigned))}`,
        proposalDigest
    );
});

test("captured scalar validators resist post-import RegExp exec, test and Number patches", () => {
    const originalTest = RegExp.prototype.test;
    const originalExec = RegExp.prototype.exec;
    const originalSafeInteger = Number.isSafeInteger;
    let validProposal;
    const errors = {};
    const exactScalarPattern = (pattern) =>
        pattern.source === "^[a-f0-9]{40}$" ||
        pattern.source === "^[a-f0-9]{64}$" ||
        pattern.source === "^sha256:[a-f0-9]{64}$";
    try {
        RegExp.prototype.test = function misleadingTest(value) {
            if (exactScalarPattern(this)) return true;
            return Reflect.apply(originalTest, this, [value]);
        };
        RegExp.prototype.exec = function misleadingExec(value) {
            if (exactScalarPattern(this)) {
                return [String(value)];
            }
            return Reflect.apply(originalExec, this, [value]);
        };
        Number.isSafeInteger = () => true;
        validProposal = proposePromptRefinerShadowStage(checkedIn());

        const invalidCases = [
            [
                "source",
                (manifest) => {
                    manifest.sourceRef = "not-a-source";
                },
                "manifest_shape_or_version",
            ],
            [
                "sourceIdentityDigest",
                (manifest) => {
                    manifest.sourceIdentityDigest = "not-a-digest";
                },
                "manifest_shape_or_version",
            ],
            [
                "corpusDigest",
                (manifest) => {
                    manifest.corpusDigest = "not-a-digest";
                },
                "manifest_shape_or_version",
            ],
            [
                "bundleDigest",
                (manifest) => {
                    manifest.bundleDigest = "not-a-digest";
                },
                "manifest_shape_or_version",
            ],
            [
                "fileDigest",
                (manifest) => {
                    manifest.files[0].sha256 = "not-a-digest";
                },
                "evidence_file_digest",
            ],
            [
                "journalDigest",
                (manifest) => {
                    manifest.journalTerminal.entryDigest = "not-a-digest";
                },
                "journal_terminal_entry_digest",
            ],
            [
                "witnessDigest",
                (manifest) => {
                    manifest.witnessTerminal.entryDigest = "not-a-digest";
                },
                "witness_terminal_entry_digest",
            ],
            [
                "integer",
                (manifest) => {
                    manifest.journalTerminal.seq = "33";
                },
                "journal_terminal_seq_integer",
            ],
        ];
        for (const [name, mutate, taxonomy] of invalidCases) {
            const invalid = JSON.parse(
                bytes(paths.manifest).toString("utf8")
            );
            mutate(invalid);
            if (name !== "bundleDigest") {
                invalid.bundleDigest = bundleDigest(invalid);
            }
            try {
                proposePromptRefinerShadowStage({
                    ...checkedIn(),
                    manifestBytes: Buffer.from(JSON.stringify(invalid)),
                });
            } catch (error) {
                errors[name] = error;
            }
            assert.match(
                errors[name]?.message ?? "",
                new RegExp(`^prompt_refiner_shadow_admission_${taxonomy}$`),
                `${name} did not fail at its exact scalar taxonomy`
            );
        }
    } finally {
        RegExp.prototype.test = originalTest;
        RegExp.prototype.exec = originalExec;
        Number.isSafeInteger = originalSafeInteger;
    }

    assert.equal(
        validProposal.proposalDigest,
        PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_DIGEST
    );
});

test("private byte snapshots survive synchronous mutation before decode", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
        TextDecoder.prototype,
        "decode"
    );
    const originalDecode = descriptor.value;
    let mutateOriginals = () => {};
    Object.defineProperty(TextDecoder.prototype, "decode", {
        ...descriptor,
        value(input, options) {
            mutateOriginals();
            return Reflect.apply(originalDecode, this, [input, options]);
        },
    });

    let isolated;
    try {
        isolated = await import(
            "../lib/promptRefinerShadowAdmissionCore.ts?snapshot-toctou"
        );
    } finally {
        Object.defineProperty(TextDecoder.prototype, "decode", descriptor);
    }

    const originals = checkedIn();
    let mutationCount = 0;
    mutateOriginals = () => {
        mutationCount += 1;
        for (const value of Object.values(originals)) value.fill(0);
    };
    const proposal = isolated.proposePromptRefinerShadowStage(originals);
    assert.ok(mutationCount > 0, "the decode boundary must trigger mutation");
    for (const value of Object.values(originals)) {
        assert.equal(value.every((byte) => byte === 0), true);
    }
    assert.equal(
        proposal.proposalDigest,
        PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_DIGEST
    );
});

test("evidence files contain no corpus prompt, fixture output, or refined output", () => {
    const corpus = JSON.parse(bytes(paths.corpus).toString("utf8"));
    const evidence = [
        bytes(paths.manifest),
        bytes(paths.report),
        bytes(paths.journal),
        bytes(paths.witness),
    ]
        .map((value) => value.toString("utf8"))
        .join("\n");
    for (const item of corpus.cases) {
        for (const content of [
            item.sourceText,
            item.fixtureOutput,
            item.expected.refinedPrompt,
        ]) {
            if (content) assert.equal(evidence.includes(content), false, item.id);
        }
    }
    for (const forbiddenKey of [
        '"sourceText"',
        '"fixtureOutput"',
        '"refinedPrompt"',
        '"providerError"',
        '"promptDigest"',
    ]) {
        assert.equal(evidence.includes(forbiddenKey), false, forbiddenKey);
    }

    const journal = bytes(paths.journal)
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
    for (const entry of journal) {
        if (!["case_intent", "case_terminal"].includes(entry.event.kind)) continue;
        assert.deepEqual(
            Object.keys(entry.event).filter((key) => /digest/i.test(key)),
            [],
            `${entry.event.caseId} must not carry a per-item content digest`
        );
    }
});

test("manifest and artifacts reject BOM, duplicates, extra keys, tamper and missing files", () => {
    const original = checkedIn();
    assert.throws(
        () =>
            proposePromptRefinerShadowStage({
                ...original,
                manifestBytes: Buffer.concat([
                    Buffer.from([0xef, 0xbb, 0xbf]),
                    original.manifestBytes,
                ]),
            }),
        /manifest_bom/
    );
    const duplicate = original.manifestBytes
        .toString("utf8")
        .replace(
            '"schemaVersion": "prompt-refiner-shadow-admission-evidence-v1",',
            '"schemaVersion": "prompt-refiner-shadow-admission-evidence-v1",\n' +
                '  "schemaVersion": "prompt-refiner-shadow-admission-evidence-v1",'
        );
    assert.throws(
        () =>
            proposePromptRefinerShadowStage({
                ...original,
                manifestBytes: Buffer.from(duplicate, "utf8"),
            }),
        /manifest_json/
    );
    const extra = JSON.parse(original.manifestBytes.toString("utf8"));
    extra.approvedBy = "forbidden";
    assert.throws(
        () =>
            proposePromptRefinerShadowStage({
                ...original,
                manifestBytes: Buffer.from(JSON.stringify(extra), "utf8"),
            }),
        /unexpected_or_missing_fields/
    );
    for (const [field, value] of [
        ["currentCheckoutValidated", true],
        ["runtimeSourceRevalidationRequired", false],
    ]) {
        const forged = JSON.parse(original.manifestBytes.toString("utf8"));
        forged[field] = value;
        assert.throws(
            () =>
                proposePromptRefinerShadowStage({
                    ...original,
                    manifestBytes: Buffer.from(JSON.stringify(forged), "utf8"),
                }),
            /unexpected_or_missing_fields/
        );
    }
    const tamperedReport = Buffer.from(original.reportBytes);
    tamperedReport[10] ^= 1;
    assert.throws(
        () =>
            proposePromptRefinerShadowStage({
                ...original,
                reportBytes: tamperedReport,
            }),
        /artifact_digest_or_size/
    );
    assert.throws(
        () =>
            proposePromptRefinerShadowStage({
                ...original,
                journalBytes: new Uint8Array(),
            }),
        /artifact_digest_or_size/
    );
    assert.throws(
        () =>
            proposePromptRefinerShadowStage({
                ...original,
                witnessBytes: original.journalBytes,
            }),
        /artifact_digest_or_size/
    );
});

test("strict report parsing runs before the checked-manifest byte pin", () => {
    const original = checkedIn();
    const reportText = original.reportBytes.toString("utf8").replace(
        '"purpose": "development-only",',
        '"purpose": "development-only",\n  "purpose": "development-only",'
    );
    const reportBytes = Buffer.from(reportText, "utf8");
    const originalManifest = JSON.parse(original.manifestBytes.toString("utf8"));
    const files = [...originalManifest.files];
    files[0] = fileFact(files[0].name, reportBytes);
    const manifestBytes = manifestFor({ files });
    assert.throws(
        () =>
            proposePromptRefinerShadowStage({
                ...original,
                manifestBytes,
                reportBytes,
            }),
        /report_json/
    );
});

test("journal, witness and corpus are independently bounded and strictly parsed", () => {
    const original = checkedIn();
    const duplicateJournal = Buffer.from(
        original.journalBytes
            .toString("utf8")
            .replace('"seq":0}', '"seq":0,"seq":0}'),
        "utf8"
    );
    assert.throws(
        () => proposePromptRefinerShadowStage(evidenceWith({ journalBytes: duplicateJournal })),
        /journal_json/
    );

    const extraWitness = Buffer.from(
        original.witnessBytes
            .toString("utf8")
            .replace('"seq":0}', '"seq":0,"unexpected":true}'),
        "utf8"
    );
    assert.throws(
        () => proposePromptRefinerShadowStage(evidenceWith({ witnessBytes: extraWitness })),
        /witness_entry_unexpected_or_missing_fields/
    );

    const bomJournal = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        original.journalBytes,
    ]);
    assert.throws(
        () => proposePromptRefinerShadowStage(evidenceWith({ journalBytes: bomJournal })),
        /journal_bom/
    );

    const bomWitness = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        original.witnessBytes,
    ]);
    assert.throws(
        () => proposePromptRefinerShadowStage(evidenceWith({ witnessBytes: bomWitness })),
        /witness_bom/
    );

    const bomReport = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        original.reportBytes,
    ]);
    assert.throws(
        () => proposePromptRefinerShadowStage(evidenceWith({ reportBytes: bomReport })),
        /report_bom/
    );

    const overLimitJournal = Buffer.alloc(1024 * 1024 + 1, 0x20);
    assert.throws(
        () =>
            proposePromptRefinerShadowStage(
                evidenceWith({ journalBytes: overLimitJournal })
            ),
        /journal_byte_limit/
    );

    const bomCorpus = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        original.corpusBytes,
    ]);
    assert.throws(
        () =>
            proposePromptRefinerShadowStage({
                ...original,
                corpusBytes: bomCorpus,
            }),
        /corpus_bom/
    );

    const extraCorpus = JSON.parse(original.corpusBytes.toString("utf8"));
    extraCorpus.unexpected = true;
    assert.throws(
        () =>
            proposePromptRefinerShadowStage({
                ...original,
                corpusBytes: Buffer.from(JSON.stringify(extraCorpus), "utf8"),
            }),
        /unexpected_or_missing_fields/
    );

    const reserializedCorpus = Buffer.from(
        `${original.corpusBytes.toString("utf8")}\n`,
        "utf8"
    );
    assert.throws(
        () =>
            proposePromptRefinerShadowStage({
                ...original,
                corpusBytes: reserializedCorpus,
            }),
        /corpus_digest/
    );
});

test("plain oversized evidence bytes hit each bound before digest or replay", () => {
    const oversizedFields = [
        ["manifestBytes", 64 * 1024 + 1, "manifest_byte_limit"],
        ["reportBytes", 64 * 1024 + 1, "report_byte_limit"],
        ["journalBytes", 1024 * 1024 + 1, "journal_byte_limit"],
        ["witnessBytes", 1024 * 1024 + 1, "witness_byte_limit"],
        ["corpusBytes", 1024 * 1024 + 1, "corpus_byte_limit"],
    ];
    for (const [field, size, taxonomy] of oversizedFields) {
        for (const oversized of [Buffer.alloc(size), new Uint8Array(size)]) {
            assert.throws(
                () =>
                    proposePromptRefinerShadowStage({
                        ...checkedIn(),
                        [field]: oversized,
                    }),
                (error) =>
                    error instanceof Error &&
                    error.message ===
                        `prompt_refiner_shadow_admission_${taxonomy}`,
                `${field} did not stop at its raw byte bound`
            );
        }
    }
});

test("poisoned evidence also fails before artifact hashing or journal replay", () => {
    const oversizedArtifacts = [
        ["reportBytes", Buffer.alloc(64 * 1024 + 1), "report_byte_limit"],
        ["journalBytes", Buffer.alloc(1024 * 1024 + 1), "journal_byte_limit"],
        ["witnessBytes", Buffer.alloc(1024 * 1024 + 1), "witness_byte_limit"],
    ];
    for (const [field, oversized, error] of oversizedArtifacts) {
        const input = evidenceWith({ [field]: oversized });
        input[field] = hashPoison(oversized);
        assert.throws(
            () => proposePromptRefinerShadowStage(input),
            new RegExp(`prompt_refiner_shadow_admission_${error}`),
            `${field} reached hashing instead of its raw byte bound`
        );
    }

    const oversizedManifest = checkedIn();
    oversizedManifest.manifestBytes = Buffer.alloc(64 * 1024 + 1);
    oversizedManifest.reportBytes = hashPoison(oversizedManifest.reportBytes);
    assert.throws(
        () => proposePromptRefinerShadowStage(oversizedManifest),
        /prompt_refiner_shadow_admission_manifest_byte_limit/,
        "manifest preflight must finish before report hashing"
    );

    const oversizedCorpus = checkedIn();
    oversizedCorpus.corpusBytes = hashPoison(Buffer.alloc(1024 * 1024 + 1));
    assert.throws(
        () => proposePromptRefinerShadowStage(oversizedCorpus),
        /prompt_refiner_shadow_admission_corpus_byte_limit/,
        "corpus must be bounded during the shared raw-byte preflight"
    );
});

test("intrinsic byte lengths reject spoofed buffers and typed-array proxies", () => {
    const spoofCases = [
        ["manifestBytes", 64 * 1024 + 1, "manifest_byte_limit"],
        ["reportBytes", 64 * 1024 + 1, "report_byte_limit"],
        ["journalBytes", 1024 * 1024 + 1, "journal_byte_limit"],
        ["witnessBytes", 1024 * 1024 + 1, "witness_byte_limit"],
        ["corpusBytes", 1024 * 1024 + 1, "corpus_byte_limit"],
    ];
    for (const [field, size, error] of spoofCases) {
        const spoofedBuffer = Buffer.alloc(size);
        Object.defineProperty(spoofedBuffer, "byteLength", { value: 1 });
        assert.equal(
            spoofedBuffer.byteLength,
            1,
            "the adversarial own property is active"
        );
        assert.throws(
            () =>
                proposePromptRefinerShadowStage({
                    ...checkedIn(),
                    [field]: spoofedBuffer,
                }),
            new RegExp(`prompt_refiner_shadow_admission_${error}`)
        );
    }

    class SpoofedUint8Array extends Uint8Array {
        get byteLength() {
            return 1;
        }
    }
    const spoofedSubclass = new SpoofedUint8Array(2 * 1024 * 1024);
    assert.equal(spoofedSubclass.byteLength, 1);
    assert.throws(
        () =>
            proposePromptRefinerShadowStage({
                ...checkedIn(),
                witnessBytes: spoofedSubclass,
            }),
        /prompt_refiner_shadow_admission_witness_byte_limit/
    );

    const proxyTarget = new Uint8Array(2 * 1024 * 1024);
    const lyingProxy = new Proxy(proxyTarget, {
        get(target, property) {
            if (property === "byteLength") return 1;
            return Reflect.get(target, property, target);
        },
    });
    assert.equal(lyingProxy.byteLength, 1);
    assert.throws(
        () =>
            proposePromptRefinerShadowStage({
                ...checkedIn(),
                journalBytes: lyingProxy,
            }),
        /prompt_refiner_shadow_admission_journal_byte_limit/
    );

    const revoked = Proxy.revocable(new Uint8Array(1), {});
    revoked.revoke();
    assert.throws(
        () =>
            proposePromptRefinerShadowStage({
                ...checkedIn(),
                witnessBytes: revoked.proxy,
            }),
        /prompt_refiner_shadow_admission_witness_byte_limit/
    );

    const throwingGetter = { ...checkedIn() };
    Object.defineProperty(throwingGetter, "reportBytes", {
        get() {
            throw new Error("adversarial getter");
        },
    });
    assert.throws(
        () => proposePromptRefinerShadowStage(throwingGetter),
        /prompt_refiner_shadow_admission_report_byte_limit/
    );

    const asPlainUint8Arrays = Object.fromEntries(
        Object.entries(checkedIn()).map(([field, value]) => [
            field,
            new Uint8Array(value),
        ])
    );
    assert.equal(
        proposePromptRefinerShadowStage(asPlainUint8Arrays).proposalDigest,
        PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_DIGEST
    );
});

test("evidence getters are snapshotted exactly once before validation", () => {
    const safe = checkedIn();
    const limits = {
        manifestBytes: 64 * 1024 + 1,
        reportBytes: 64 * 1024 + 1,
        journalBytes: 1024 * 1024 + 1,
        witnessBytes: 1024 * 1024 + 1,
        corpusBytes: 1024 * 1024 + 1,
    };
    const reads = Object.fromEntries(
        Object.keys(safe).map((field) => [field, 0])
    );
    const changingInput = {};
    for (const field of Object.keys(safe)) {
        Object.defineProperty(changingInput, field, {
            enumerable: true,
            get() {
                reads[field] += 1;
                return reads[field] === 1
                    ? safe[field]
                    : Buffer.alloc(limits[field]);
            },
        });
    }
    assert.equal(
        proposePromptRefinerShadowStage(changingInput).proposalDigest,
        PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_DIGEST
    );
    assert.deepEqual(reads, {
        manifestBytes: 1,
        reportBytes: 1,
        journalBytes: 1,
        witnessBytes: 1,
        corpusBytes: 1,
    });
});

test("report-only and cross-snapshot evidence cannot become a proposal", () => {
    const original = checkedIn();
    assert.throws(
        () =>
            proposePromptRefinerShadowStage({
                ...original,
                journalBytes: new Uint8Array(),
                witnessBytes: new Uint8Array(),
            }),
        /artifact_digest_or_size/
    );

    const mixedReport = Buffer.from(
        original.reportBytes
            .toString("utf8")
            .replace(
                PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_REF,
                "0000000000000000000000000000000000000000"
            ),
        "utf8"
    );
    assert.throws(
        () => proposePromptRefinerShadowStage(evidenceWith({ reportBytes: mixedReport })),
        /report_invariant/
    );
});

test("rollback, truncation and evidence-internal source mismatches fail closed", () => {
    const original = checkedIn();
    const journalLines = original.journalBytes.toString("utf8").trimEnd().split("\n");
    const witnessLines = original.witnessBytes.toString("utf8").trimEnd().split("\n");
    journalLines.pop();
    witnessLines.pop();
    const journalBytes = Buffer.from(`${journalLines.join("\n")}\n`, "utf8");
    const witnessBytes = Buffer.from(`${witnessLines.join("\n")}\n`, "utf8");
    const last = JSON.parse(journalLines.at(-1));
    const originalManifest = JSON.parse(original.manifestBytes.toString("utf8"));
    const files = [
        originalManifest.files[0],
        fileFact(originalManifest.files[1].name, journalBytes),
        fileFact(originalManifest.files[2].name, witnessBytes),
    ];
    const head = { seq: last.seq, entryDigest: last.entryDigest };
    const manifestBytes = manifestFor({
        files,
        journalTerminal: head,
        witnessTerminal: head,
    });
    assert.throws(
        () =>
            proposePromptRefinerShadowStage({
                ...original,
                manifestBytes,
                journalBytes,
                witnessBytes,
            }),
        /replay_invariant_or_terminal_head/
    );

    const staleManifest = manifestFor({
        sourceRef: "0000000000000000000000000000000000000000",
    });
    assert.throws(
        () =>
            proposePromptRefinerShadowStage({
                ...original,
                manifestBytes: staleManifest,
            }),
        /report_invariant/
    );
});

test("existing v1 admission stays false even with every caller boolean enabled", () => {
    assert.deepEqual(
        admitPromptRefinerExecution({
            eligible: true,
            mode: "shadow",
            stageApproved: true,
            adapterReady: true,
            contractVersion: PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
            refinerVersion: PROMPT_REFINER_VERSION,
            model: PROMPT_REFINER_EXECUTION_MODEL_PIN,
            maxOutputTokens: PROMPT_REFINER_MAX_OUTPUT_TOKENS,
            timeoutMs: PROMPT_REFINER_TIMEOUT_MS,
            retryCount: PROMPT_REFINER_RETRY_COUNT,
            promptCaching: "disabled",
            tools: "none",
            inputTokenCeiling: PROMPT_REFINER_MAX_INPUT_TOKENS,
        }),
        { admitted: false, reason: "reservation_authority_unavailable" }
    );
});

const allFiles = (directory) =>
    readdirSync(directory).flatMap((name) => {
        const path = join(directory, name);
        return statSync(path).isDirectory() ? allFiles(path) : [path];
    });

test("proposal core has no product, provider, credential, writer, or stage-seed caller", () => {
    const core = readFileSync(
        join(root, "lib", "promptRefinerShadowAdmissionCore.ts"),
        "utf8"
    );
    for (const forbidden of [
        "server-only",
        "@prisma/client",
        "prisma.",
        "process.env",
        "fetch(",
        "reservePromptRefinerExecution",
        "consumePromptRefinerReservation",
        "releasePromptRefinerReservation",
        "approvedBy",
        "approvedAt",
        "admitted: true",
    ]) {
        assert.equal(core.includes(forbidden), false, forbidden);
    }
    const callerRoots = ["app", "components", "scripts", "prisma", "lib"];
    for (const directory of callerRoots) {
        for (const path of allFiles(join(root, directory))) {
            if (!/\.(?:ts|tsx|js|mjs|cjs|prisma)$/.test(path)) continue;
            if (path.endsWith(join("lib", "promptRefinerShadowAdmissionCore.ts"))) {
                continue;
            }
            const content = readFileSync(path, "utf8");
            assert.equal(
                /promptRefinerShadowAdmissionCore|proposePromptRefinerShadowStage/.test(
                    content
                ),
                false,
                path
            );
        }
    }
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.equal(
        Object.values(packageJson.scripts).some((command) =>
            /prompt-refiner-shadow-admission|admission-readiness-v1/.test(command)
        ),
        false
    );
});

test("checked manifest names its strict version and exact immutable source", () => {
    const manifest = JSON.parse(bytes(paths.manifest).toString("utf8"));
    assert.equal(
        manifest.schemaVersion,
        PROMPT_REFINER_SHADOW_ADMISSION_EVIDENCE_VERSION
    );
    assert.equal(manifest.sourceRef, PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_REF);
    assert.equal(
        manifest.bundleDigest,
        PROMPT_REFINER_SHADOW_ADMISSION_EVIDENCE_BUNDLE_DIGEST
    );

    const semanticallyEqualButUnreviewedBytes = Buffer.from(
        JSON.stringify(manifest),
        "utf8"
    );
    assert.throws(
        () =>
            proposePromptRefinerShadowStage({
                ...checkedIn(),
                manifestBytes: semanticallyEqualButUnreviewedBytes,
            }),
        /unchecked_manifest_bytes/
    );
});

test("only the admission evidence and implementation paths are pinned to LF", () => {
    const evidencePinned = [
        "docs/ops/prompt-refiner-shadow/evidence/admission-readiness-v1.manifest.json",
        "docs/ops/prompt-refiner-shadow/evidence/admission-readiness-v1.report.json",
        "docs/ops/prompt-refiner-shadow/evidence/admission-readiness-v1.journal.jsonl",
        "docs/ops/prompt-refiner-shadow/evidence/admission-readiness-v1.journal.jsonl.witness.jsonl",
    ];
    const implementationPinned = [
        "lib/promptRefinerShadowAdmissionCore.ts",
        "tests/promptRefinerShadowAdmissionCore.test.mjs",
    ];
    const pinned = [...evidencePinned, ...implementationPinned];
    const attributes = (path) => {
        const result = spawnSync(
            "git",
            ["check-attr", "text", "eol", "--", path],
            { cwd: root, encoding: "utf8", windowsHide: true }
        );
        assert.equal(result.status, 0, result.stderr);
        return Object.fromEntries(
            result.stdout
                .trim()
                .split("\n")
                .map((line) => {
                    const match = /^.+: ([^:]+): (.+)$/.exec(line.trim());
                    assert.ok(match, line);
                    return [match[1], match[2]];
                })
        );
    };
    for (const path of pinned) {
        assert.deepEqual(attributes(path), { text: "set", eol: "lf" }, path);
    }
    assert.deepEqual(
        attributes("docs/ops/prompt-refiner-shadow/evidence/README.md"),
        { text: "unspecified", eol: "unspecified" }
    );
    assert.deepEqual(
        attributes("docs/ops/prompt-refiner-shadow/evidence/nested/example.md"),
        { text: "unspecified", eol: "unspecified" }
    );
    assert.deepEqual(
        attributes("docs/ops/prompt-refiner-shadow/nested/example.md"),
        { text: "unspecified", eol: "unspecified" }
    );

    const temporary = mkdtempSync(join(tmpdir(), "refiner-admission-eol-"));
    const source = join(temporary, "source");
    const clone = join(temporary, "clone");
    try {
        mkdirSync(source);
        writeFileSync(join(source, ".gitattributes"), readFileSync(join(root, ".gitattributes")));
        for (const path of pinned) {
            const target = join(source, path);
            mkdirSync(resolve(target, ".."), { recursive: true });
            writeFileSync(target, readFileSync(join(root, path)));
        }
        execFileSync("git", ["init", "--quiet"], { cwd: source });
        execFileSync("git", ["config", "user.name", "eol-regression"], { cwd: source });
        execFileSync("git", ["config", "user.email", "eol@example.invalid"], { cwd: source });
        execFileSync("git", ["add", ".gitattributes", ...pinned], { cwd: source });
        execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: source });
        execFileSync(
            "git",
            ["-c", "core.autocrlf=true", "clone", "--quiet", "--no-local", source, clone],
            { cwd: temporary }
        );
        for (const path of pinned) {
            assert.deepEqual(
                readFileSync(join(clone, path)),
                readFileSync(join(root, path)),
                `${path} changed bytes in an autocrlf checkout`
            );
        }
    } finally {
        rmSync(temporary, { recursive: true, force: true });
    }
});
