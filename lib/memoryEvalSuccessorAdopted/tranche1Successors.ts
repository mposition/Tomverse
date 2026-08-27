/**
 * Tranche 1 successors — the six adopted batches that hold the 17 cases the
 * `injection_directives` and `sensitive_secrets` cells move to the regression
 * corpus.
 *
 * Nothing here edits an adopted batch. Each entry reads the original, pins its
 * digest, names the cases it drops, and keeps every survivor **by identity** —
 * `deriveAdoptedBatchSuccessor` returns the same objects the original array
 * holds, so there is no transcription of 208 surviving cases and nothing for a
 * transcription error to happen to.
 *
 * The digests below were read from the originals on 2026-08-27. If an original
 * ever changes, the pin stops matching and this module refuses to load — which
 * is what makes "the adopted files are immutable" a checked claim rather than
 * a convention.
 */

import {
    deriveAdoptedBatchSuccessor,
    type AdoptedBatchSuccessor,
} from "@/lib/memoryEvalAdoptedBatchSuccession";
import { BATCH_115_INJECTION_KO } from "@/lib/memoryEvalSuccessorAdopted/batch115InjectionKo";
import { BATCH_117_INJECTION_KO } from "@/lib/memoryEvalSuccessorAdopted/batch117InjectionKo";
import { BATCH_118_INJECTION_EN } from "@/lib/memoryEvalSuccessorAdopted/batch118InjectionEn";
import { BATCH_120_INJECTION_EN } from "@/lib/memoryEvalSuccessorAdopted/batch120InjectionEn";
import { BATCH_129_SECRET_KO } from "@/lib/memoryEvalSuccessorAdopted/batch129SecretKo";
import { BATCH_132_SECRET_EN } from "@/lib/memoryEvalSuccessorAdopted/batch132SecretEn";

export const BATCH_137_INJECTION_KO: AdoptedBatchSuccessor =
    deriveAdoptedBatchSuccessor({
        id: "batch-137",
        replacesBatchId: "batch-115",
        sourceDigest:
            "f4e050e0a29ffc8dc38a82e930f9161dba9c044ec810824d553b09d4160a5693",
        source: BATCH_115_INJECTION_KO,
        excludedCaseIds: [
            "succ-injection-ko-1",
            "succ-injection-ko-2",
            "succ-injection-ko-3",
            "succ-injection-ko-23",
            "succ-injection-ko-26",
        ],
    });

export const BATCH_138_INJECTION_KO: AdoptedBatchSuccessor =
    deriveAdoptedBatchSuccessor({
        id: "batch-138",
        replacesBatchId: "batch-117",
        sourceDigest:
            "2671ea57ffc602f2df687f8dc4acb796fe308d33a595be0eb87c8d517b621714",
        source: BATCH_117_INJECTION_KO,
        excludedCaseIds: [
            "succ-injection-ko-87",
            "succ-injection-ko-95",
            "succ-injection-ko-125",
        ],
    });

export const BATCH_139_INJECTION_EN: AdoptedBatchSuccessor =
    deriveAdoptedBatchSuccessor({
        id: "batch-139",
        replacesBatchId: "batch-118",
        sourceDigest:
            "4eeb9d656679678f218814ebbdcd4cd52672038194c2efc9799ee8577a7b9322",
        source: BATCH_118_INJECTION_EN,
        excludedCaseIds: ["succ-injection-en-23", "succ-injection-en-26"],
    });

export const BATCH_140_INJECTION_EN: AdoptedBatchSuccessor =
    deriveAdoptedBatchSuccessor({
        id: "batch-140",
        replacesBatchId: "batch-120",
        sourceDigest:
            "655f1fae423b34c670c75fee4e689bb78c93aff6a77b7fc943ff97917351186e",
        source: BATCH_120_INJECTION_EN,
        excludedCaseIds: [
            "succ-injection-en-86",
            "succ-injection-en-87",
            "succ-injection-en-93",
        ],
    });

export const BATCH_141_SECRET_KO: AdoptedBatchSuccessor =
    deriveAdoptedBatchSuccessor({
        id: "batch-141",
        replacesBatchId: "batch-129",
        sourceDigest:
            "54302cffdcabe219ce3fcb25990d78eb93540bba54360ac548f67a3f4d4f9aae",
        source: BATCH_129_SECRET_KO,
        excludedCaseIds: ["succ-secret-ko-91", "succ-secret-ko-121"],
    });

export const BATCH_142_SECRET_EN: AdoptedBatchSuccessor =
    deriveAdoptedBatchSuccessor({
        id: "batch-142",
        replacesBatchId: "batch-132",
        sourceDigest:
            "207c96b0139a5bfdf1202dd369135261ae2939d4a72dd1a86ce27e6c01e900b0",
        source: BATCH_132_SECRET_EN,
        excludedCaseIds: ["succ-secret-en-91", "succ-secret-en-121"],
    });

export const TRANCHE_1_SUCCESSORS: readonly AdoptedBatchSuccessor[] = [
    BATCH_137_INJECTION_KO,
    BATCH_138_INJECTION_KO,
    BATCH_139_INJECTION_EN,
    BATCH_140_INJECTION_EN,
    BATCH_141_SECRET_KO,
    BATCH_142_SECRET_EN,
];
