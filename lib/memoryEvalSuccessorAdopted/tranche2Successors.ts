/**
 * Tranche 2 successors — the 19 adopted batches that hold the remaining 82
 * cases moving to `lib/memoryEvalRegressionCorpus/`.
 *
 * The same construction as `tranche1Successors.ts`, and for the same reason:
 * nothing here edits an adopted batch. Each entry reads the original, pins the
 * digest it had when this was written, names the cases it drops, and keeps
 * every survivor **by identity** — `deriveAdoptedBatchSuccessor` returns the
 * objects the original array already holds, so 686 surviving cases are never
 * transcribed and there is nothing for a transcription error to happen to.
 *
 * Two tranches rather than one file because they were written and checked a
 * week apart, and merging them now would lose which digests were read when.
 * Both are consumed the same way and neither is in the canonical registry
 * until `mem-eval-succ-3` is wired in one atomic change.
 *
 * The digests below were read from the originals on 2026-08-27. If an original
 * ever changes, the pin stops matching and this module refuses to load.
 */

import {
    deriveAdoptedBatchSuccessor,
    type AdoptedBatchSuccessor,
} from "@/lib/memoryEvalAdoptedBatchSuccession";
import { BATCH_101_DURABLE_KO } from "@/lib/memoryEvalSuccessorAdopted/batch101DurableKo";
import { BATCH_103_DURABLE_KO } from "@/lib/memoryEvalSuccessorAdopted/batch103DurableKo";
import { BATCH_104_DURABLE_KO } from "@/lib/memoryEvalSuccessorAdopted/batch104DurableKo";
import { BATCH_105_DURABLE_EN } from "@/lib/memoryEvalSuccessorAdopted/batch105DurableEn";
import { BATCH_106_DURABLE_EN } from "@/lib/memoryEvalSuccessorAdopted/batch106DurableEn";
import { BATCH_107_DURABLE_KO } from "@/lib/memoryEvalSuccessorAdopted/batch107DurableKo";
import { BATCH_108_DURABLE_KO } from "@/lib/memoryEvalSuccessorAdopted/batch108DurableKo";
import { BATCH_109_DURABLE_EN } from "@/lib/memoryEvalSuccessorAdopted/batch109DurableEn";
import { BATCH_110_DURABLE_EN } from "@/lib/memoryEvalSuccessorAdopted/batch110DurableEn";
import { BATCH_111_DURABLE_KO } from "@/lib/memoryEvalSuccessorAdopted/batch111DurableKo";
import { BATCH_112_DURABLE_EN } from "@/lib/memoryEvalSuccessorAdopted/batch112DurableEn";
import { BATCH_113_DURABLE_KO } from "@/lib/memoryEvalSuccessorAdopted/batch113DurableKo";
import { BATCH_114_DURABLE_EN } from "@/lib/memoryEvalSuccessorAdopted/batch114DurableEn";
import { BATCH_121_ASSISTANT_KO } from "@/lib/memoryEvalSuccessorAdopted/batch121AssistantKo";
import { BATCH_122_ASSISTANT_KO } from "@/lib/memoryEvalSuccessorAdopted/batch122AssistantKo";
import { BATCH_123_ASSISTANT_KO } from "@/lib/memoryEvalSuccessorAdopted/batch123AssistantKo";
import { BATCH_124_ASSISTANT_EN } from "@/lib/memoryEvalSuccessorAdopted/batch124AssistantEn";
import { BATCH_125_ASSISTANT_EN } from "@/lib/memoryEvalSuccessorAdopted/batch125AssistantEn";
import { BATCH_126_ASSISTANT_EN } from "@/lib/memoryEvalSuccessorAdopted/batch126AssistantEn";

export const BATCH_143_DURABLE_KO: AdoptedBatchSuccessor =
    deriveAdoptedBatchSuccessor({
        id: "batch-143",
        replacesBatchId: "batch-101",
        sourceDigest:
            "539cfd7c0d31870bf422581b1e69420fe64de650e5b76e5feac0b83282597ba5",
        source: BATCH_101_DURABLE_KO,
        excludedCaseIds: [
            "succ-durable-ko-2",
            "succ-durable-ko-15",
            "succ-durable-ko-21",
            "succ-durable-ko-23",
        ],
    });

export const BATCH_144_DURABLE_KO: AdoptedBatchSuccessor =
    deriveAdoptedBatchSuccessor({
        id: "batch-144",
        replacesBatchId: "batch-103",
        sourceDigest:
            "d5d041a1307b4519d326b94e48f69b2706ca8569a6a7c8eb49bad3851eed1730",
        source: BATCH_103_DURABLE_KO,
        excludedCaseIds: [
            "succ-durable-ko-28",
            "succ-durable-ko-29",
            "succ-durable-ko-47",
        ],
    });

export const BATCH_145_DURABLE_KO: AdoptedBatchSuccessor =
    deriveAdoptedBatchSuccessor({
        id: "batch-145",
        replacesBatchId: "batch-104",
        sourceDigest:
            "f517157e30a17875f6ede795103859eb4f2b8c26756e104ef99990569af7345f",
        source: BATCH_104_DURABLE_KO,
        excludedCaseIds: [
            "succ-durable-ko-59",
            "succ-durable-ko-61",
            "succ-durable-ko-62",
        ],
    });

export const BATCH_146_DURABLE_EN: AdoptedBatchSuccessor =
    deriveAdoptedBatchSuccessor({
        id: "batch-146",
        replacesBatchId: "batch-105",
        sourceDigest:
            "8bce9fadd0d8507c7443be9e83d0580df19cb3ffdd44d0f0b43ae53999223f55",
        source: BATCH_105_DURABLE_EN,
        excludedCaseIds: [
            "succ-durable-en-28",
            "succ-durable-en-29",
            "succ-durable-en-30",
            "succ-durable-en-41",
        ],
    });

export const BATCH_147_DURABLE_EN: AdoptedBatchSuccessor =
    deriveAdoptedBatchSuccessor({
        id: "batch-147",
        replacesBatchId: "batch-106",
        sourceDigest:
            "11966002cbddaa10ec85c564899ebac37f24bd03c5b73a2edc2996a2035e7133",
        source: BATCH_106_DURABLE_EN,
        excludedCaseIds: [
            "succ-durable-en-56",
            "succ-durable-en-57",
        ],
    });

export const BATCH_148_DURABLE_KO: AdoptedBatchSuccessor =
    deriveAdoptedBatchSuccessor({
        id: "batch-148",
        replacesBatchId: "batch-107",
        sourceDigest:
            "ce1206112caec486deb939545b8ecdfed9dc32cb47d3b5e357f0411a33d38b26",
        source: BATCH_107_DURABLE_KO,
        excludedCaseIds: [
            "succ-durable-ko-76",
            "succ-durable-ko-78",
            "succ-durable-ko-79",
            "succ-durable-ko-83",
            "succ-durable-ko-99",
        ],
    });

export const BATCH_149_DURABLE_KO: AdoptedBatchSuccessor =
    deriveAdoptedBatchSuccessor({
        id: "batch-149",
        replacesBatchId: "batch-108",
        sourceDigest:
            "c9595623da72924a72ec7aaf74de3430696d28d3e2aec16f0a0636b339a8b946",
        source: BATCH_108_DURABLE_KO,
        excludedCaseIds: [
            "succ-durable-ko-105",
            "succ-durable-ko-106",
            "succ-durable-ko-107",
            "succ-durable-ko-116",
        ],
    });

export const BATCH_150_DURABLE_EN: AdoptedBatchSuccessor =
    deriveAdoptedBatchSuccessor({
        id: "batch-150",
        replacesBatchId: "batch-109",
        sourceDigest:
            "6f9a3584f3d747abc10b470b68f6e9edb272ef52778ab24dc380d914d5073714",
        source: BATCH_109_DURABLE_EN,
        excludedCaseIds: [
            "succ-durable-en-78",
            "succ-durable-en-79",
            "succ-durable-en-83",
            "succ-durable-en-91",
        ],
    });

export const BATCH_151_DURABLE_EN: AdoptedBatchSuccessor =
    deriveAdoptedBatchSuccessor({
        id: "batch-151",
        replacesBatchId: "batch-110",
        sourceDigest:
            "7fe70bb4ceb5d7a7b572fb46d76c99e5c5c29ca2778aa7219a60ba547a154f30",
        source: BATCH_110_DURABLE_EN,
        excludedCaseIds: [
            "succ-durable-en-105",
            "succ-durable-en-106",
        ],
    });

export const BATCH_152_DURABLE_KO: AdoptedBatchSuccessor =
    deriveAdoptedBatchSuccessor({
        id: "batch-152",
        replacesBatchId: "batch-111",
        sourceDigest:
            "3f457e1b73dd74387fab3014a0c4e2fa273856373f277ed4b7b3edbb50404c77",
        source: BATCH_111_DURABLE_KO,
        excludedCaseIds: [
            "succ-durable-ko-133",
            "succ-durable-ko-134",
            "succ-durable-ko-145",
            "succ-durable-ko-156",
            "succ-durable-ko-157",
            "succ-durable-ko-158",
            "succ-durable-ko-163",
        ],
    });

export const BATCH_153_DURABLE_EN: AdoptedBatchSuccessor =
    deriveAdoptedBatchSuccessor({
        id: "batch-153",
        replacesBatchId: "batch-112",
        sourceDigest:
            "5234f9bbdf53c3bc64ceee1111e69ebca3e628ffeeebbed4290418e136f3f3e5",
        source: BATCH_112_DURABLE_EN,
        excludedCaseIds: [
            "succ-durable-en-133",
            "succ-durable-en-134",
            "succ-durable-en-144",
            "succ-durable-en-145",
            "succ-durable-en-156",
        ],
    });

export const BATCH_154_DURABLE_KO: AdoptedBatchSuccessor =
    deriveAdoptedBatchSuccessor({
        id: "batch-154",
        replacesBatchId: "batch-113",
        sourceDigest:
            "2f6bc7d09e218576a370ac90a77df8c143fd4f2a21673331ff24d901ebcb5a9c",
        source: BATCH_113_DURABLE_KO,
        excludedCaseIds: [
            "succ-durable-ko-175",
            "succ-durable-ko-189",
            "succ-durable-ko-190",
        ],
    });

export const BATCH_155_DURABLE_EN: AdoptedBatchSuccessor =
    deriveAdoptedBatchSuccessor({
        id: "batch-155",
        replacesBatchId: "batch-114",
        sourceDigest:
            "57fedb7586666a6282d1e97652ba185e53d9510bdfbd9db6a95762cf502a467a",
        source: BATCH_114_DURABLE_EN,
        excludedCaseIds: [
            "succ-durable-en-182",
            "succ-durable-en-189",
            "succ-durable-en-190",
        ],
    });

export const BATCH_156_ASSISTANT_KO: AdoptedBatchSuccessor =
    deriveAdoptedBatchSuccessor({
        id: "batch-156",
        replacesBatchId: "batch-121",
        sourceDigest:
            "087b0096504c5030cf7f8719dbd7b110a0993043af5f25cec56688fea0d18157",
        source: BATCH_121_ASSISTANT_KO,
        excludedCaseIds: [
            "succ-assistant-ko-8",
            "succ-assistant-ko-13",
        ],
    });

export const BATCH_157_ASSISTANT_KO: AdoptedBatchSuccessor =
    deriveAdoptedBatchSuccessor({
        id: "batch-157",
        replacesBatchId: "batch-122",
        sourceDigest:
            "8bcee434088886dd584905aef5af51f7abd5ce375b53bde007bf669d516dd24c",
        source: BATCH_122_ASSISTANT_KO,
        excludedCaseIds: [
            "succ-assistant-ko-36",
            "succ-assistant-ko-47",
            "succ-assistant-ko-65",
            "succ-assistant-ko-78",
            "succ-assistant-ko-79",
        ],
    });

export const BATCH_158_ASSISTANT_KO: AdoptedBatchSuccessor =
    deriveAdoptedBatchSuccessor({
        id: "batch-158",
        replacesBatchId: "batch-123",
        sourceDigest:
            "65bc38c0b59d694ee901c881899d30955543e75c35ea7bae698133b35d2dbc3a",
        source: BATCH_123_ASSISTANT_KO,
        excludedCaseIds: [
            "succ-assistant-ko-80",
            "succ-assistant-ko-81",
            "succ-assistant-ko-82",
            "succ-assistant-ko-83",
            "succ-assistant-ko-84",
            "succ-assistant-ko-85",
            "succ-assistant-ko-86",
            "succ-assistant-ko-92",
            "succ-assistant-ko-93",
            "succ-assistant-ko-95",
            "succ-assistant-ko-106",
        ],
    });

export const BATCH_159_ASSISTANT_EN: AdoptedBatchSuccessor =
    deriveAdoptedBatchSuccessor({
        id: "batch-159",
        replacesBatchId: "batch-124",
        sourceDigest:
            "2d185a2fc00ad72633bf0c331d68929abb3aa8ef92c635f5a150a26136f9e8ea",
        source: BATCH_124_ASSISTANT_EN,
        excludedCaseIds: [
            "succ-assistant-en-8",
            "succ-assistant-en-13",
            "succ-assistant-en-16",
            "succ-assistant-en-23",
        ],
    });

export const BATCH_160_ASSISTANT_EN: AdoptedBatchSuccessor =
    deriveAdoptedBatchSuccessor({
        id: "batch-160",
        replacesBatchId: "batch-125",
        sourceDigest:
            "ee416d83d59e245db87edf31280911c9b25a1321211a03fd31bc7d7cec445878",
        source: BATCH_125_ASSISTANT_EN,
        excludedCaseIds: [
            "succ-assistant-en-65",
            "succ-assistant-en-78",
            "succ-assistant-en-79",
        ],
    });

export const BATCH_161_ASSISTANT_EN: AdoptedBatchSuccessor =
    deriveAdoptedBatchSuccessor({
        id: "batch-161",
        replacesBatchId: "batch-126",
        sourceDigest:
            "e374bf217163c0772a238071b3b1f65ee1f0dd9d9230499aa55bad00f4864fff",
        source: BATCH_126_ASSISTANT_EN,
        excludedCaseIds: [
            "succ-assistant-en-80",
            "succ-assistant-en-81",
            "succ-assistant-en-82",
            "succ-assistant-en-83",
            "succ-assistant-en-84",
            "succ-assistant-en-85",
            "succ-assistant-en-86",
            "succ-assistant-en-119",
        ],
    });


/** Every tranche-2 successor, in batch order. */
export const TRANCHE_2_SUCCESSORS: readonly AdoptedBatchSuccessor[] = [
    BATCH_143_DURABLE_KO,
    BATCH_144_DURABLE_KO,
    BATCH_145_DURABLE_KO,
    BATCH_146_DURABLE_EN,
    BATCH_147_DURABLE_EN,
    BATCH_148_DURABLE_KO,
    BATCH_149_DURABLE_KO,
    BATCH_150_DURABLE_EN,
    BATCH_151_DURABLE_EN,
    BATCH_152_DURABLE_KO,
    BATCH_153_DURABLE_EN,
    BATCH_154_DURABLE_KO,
    BATCH_155_DURABLE_EN,
    BATCH_156_ASSISTANT_KO,
    BATCH_157_ASSISTANT_KO,
    BATCH_158_ASSISTANT_KO,
    BATCH_159_ASSISTANT_EN,
    BATCH_160_ASSISTANT_EN,
    BATCH_161_ASSISTANT_EN,
];
