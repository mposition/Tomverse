import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
    ALLOWED_MEMORY_CLAIMS,
    FORBIDDEN_MEMORY_CLAIMS,
    MEMORY_MARKETING_DISCLOSURE,
    MEMORY_MARKETING_DISCLOSURE_ID,
    MEMORY_MARKETING_KEYS,
    MEMORY_MARKETING_NAMESPACE,
    findForbiddenMemoryClaims,
    claimsImportOrMemory,
} from "../lib/marketingMemoryClaims.ts";
import { de } from "../locales/de.ts";
import { en } from "../locales/en.ts";
import { es } from "../locales/es.ts";
import { fr } from "../locales/fr.ts";
import { ko } from "../locales/ko.ts";
import { pt } from "../locales/pt.ts";
import { zh } from "../locales/zh.ts";

/**
 * §17 — the release-blocking boundary on what marketing may claim about
 * imported conversations and account memory.
 *
 * The policy named `lib/marketingMemoryClaims.ts` as its single source and
 * then recorded, in the document, that neither it nor an equivalent existed.
 * So the rule was a paragraph two people had to remember while writing a
 * landing page, and the sentence it forbids — "your ChatGPT memory, moved over
 * perfectly" — is the one such a page drifts toward unprompted, because it is
 * the strongest thing the feature sounds like it does.
 *
 * What is asserted here, in order of how much it is worth:
 *
 *   1. the matcher is not vacuous. Every sentence §17 forbids is caught, and
 *      every sentence §17 allows is not. A guard that flags nothing and a
 *      guard that flags everything both read as "passing";
 *   2. no marketing copy in the repository makes a forbidden claim today;
 *   3. marketing copy that talks about import or memory carries the required
 *      disclosure. No such copy exists yet, which is the precondition this
 *      pins: the guard is in place *before* Release B/C copy is written, which
 *      is the only order in which it can prevent anything.
 */

const dictionaries = { en, ko, zh, fr, de, es, pt };

/* ------------------------------------------------ 1. the matcher itself --- */

test("every claim §17 allows passes the matcher", () => {
    // The allowed list is quoted from the policy, so this doubles as the check
    // that a pattern has not been widened until it swallows the approved copy.
    for (const claim of ALLOWED_MEMORY_CLAIMS) {
        assert.deepEqual(
            findForbiddenMemoryClaims(claim.policyWording),
            [],
            `${claim.id} is approved copy and must not be flagged`
        );
    }
    assert.deepEqual(findForbiddenMemoryClaims(MEMORY_MARKETING_DISCLOSURE.ko), []);
    assert.deepEqual(findForbiddenMemoryClaims(MEMORY_MARKETING_DISCLOSURE.en), []);
});

/**
 * One sentence per forbidden category, in both pattern languages, written the
 * way a marketing draft would actually write it.
 */
const FORBIDDEN_EXAMPLES = {
    replicatesMemoryOrPersonality: [
        "ChatGPT에서 쌓은 기억을 그대로 복제해 드립니다.",
        "우리는 당신의 AI 인격을 재현합니다.",
        "We clone your ChatGPT memory into Tomverse.",
        "Your assistant's personality is recreated here.",
    ],
    losslessTransfer: [
        "손실 없이 모든 대화를 이전합니다.",
        "100% 그대로 옮겨 드립니다.",
        "A lossless transfer of everything you have written.",
        "We import everything — nothing is lost.",
    ],
    identicalAnswerGuarantee: [
        "이전과 동일한 답변을 보장합니다.",
        "The same answers, guaranteed, every time.",
        "We guarantee identical responses to the ones you had.",
    ],
    styleCloneGuarantee: [
        "Claude처럼 답변하는 어시스턴트.",
        "당신의 말투를 그대로 재현합니다.",
        "It sounds just like Claude.",
        "Answers exactly like ChatGPT.",
    ],
    providerEndorsement: [
        "OpenAI 공식 제휴 서비스입니다.",
        "Anthropic이 인증한 가져오기.",
        "An official OpenAI partnership.",
        "Certified by Anthropic.",
    ],
    hiddenPromptRecovery: [
        "숨은 프롬프트까지 복원해 드립니다.",
        "내부 지시문을 추출합니다.",
        "We recover the hidden system prompt.",
        "Reveal the underlying prompts behind every answer.",
    ],
};

test("every claim §17 forbids is caught, by the right rule", () => {
    for (const [claimId, sentences] of Object.entries(FORBIDDEN_EXAMPLES)) {
        for (const sentence of sentences) {
            const findings = findForbiddenMemoryClaims(sentence);
            assert.ok(
                findings.length > 0,
                `no rule caught: ${sentence}`
            );
            assert.ok(
                findings.some((finding) => finding.claimId === claimId),
                `${sentence} should be caught by ${claimId}, was caught by ${findings
                    .map((finding) => finding.claimId)
                    .join(", ")}`
            );
        }
    }
});

test("every forbidden category has an example and every example a category", () => {
    // Adding a category without an example is how a rule ships untested.
    assert.deepEqual(
        FORBIDDEN_MEMORY_CLAIMS.map((claim) => claim.id).sort(),
        Object.keys(FORBIDDEN_EXAMPLES).sort()
    );
    for (const claim of FORBIDDEN_MEMORY_CLAIMS) {
        assert.ok(claim.patterns.length > 0, `${claim.id} has no patterns`);
        assert.ok(claim.reason.length > 20, `${claim.id} has no stated reason`);
    }
});

test("ordinary product copy about import is not flagged", () => {
    // The feature honestly copies conversations into Tomverse, and the guard
    // has to leave that alone or it will be switched off.
    for (const sentence of [
        "ChatGPT와 Claude에서 내보낸 파일을 가져올 수 있습니다.",
        "가져온 대화는 원문 그대로 보관되며 언제든 삭제할 수 있습니다.",
        "Import your exported conversations from ChatGPT or Claude.",
        "Imported conversations are stored as plain text and can be deleted at any time.",
        "Review each memory before it is used in a new conversation.",
    ]) {
        assert.deepEqual(
            findForbiddenMemoryClaims(sentence),
            [],
            `honest copy was flagged: ${sentence}`
        );
    }
});

test("the disclosure is required by memory and external import, and by nothing else", () => {
    for (const claimed of [
        "검토하고 승인한 기억을 새 대화에 활용합니다.",
        "ChatGPT에서 내보낸 대화를 가져오세요.",
        "Import your conversations from ChatGPT or Claude.",
        "Your approved memories inform every new answer.",
    ]) {
        assert.equal(
            claimsImportOrMemory(claimed),
            true,
            `should require the disclosure: ${claimed}`
        );
    }
    for (const unrelated of [
        // The guest-to-account import on the landing page: a different
        // feature, with no external provider and no memory in it.
        "비회원 대화 가져오기",
        "Bring your guest conversations into your account.",
        // The workspace guide denies memory rather than claiming it.
        "A project is a folder, not a shared prompt library or cross-chat memory.",
        "프로젝트에 포함된 대화들이 서로의 AI 메모리를 자동 공유하지 않습니다.",
    ]) {
        assert.equal(
            claimsImportOrMemory(unrelated),
            false,
            `should not require the disclosure: ${unrelated}`
        );
    }
});

/* --------------------------------------------- 2. the repository's copy --- */

const MARKETING_COPY_FILES = readdirSync(
    new URL("../components/marketing/", import.meta.url),
    { withFileTypes: true }
)
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => join("components/marketing", entry.name));

const STRING_LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

/**
 * The copy inside a TSX file, without the code around it.
 *
 * Scanning raw source does not work, and the way it fails is instructive:
 * `import { useTurnstile } from "@/components/chat/useTurnstile"` reads as
 * "import … chat", which is a page importing conversations. Marketing copy is
 * always a string literal, so taking only those removes the entire class of
 * false positive. Module specifiers are dropped for the same reason.
 */
const copyIn = (relativePath) => {
    const source = readFileSync(
        new URL(`../${relativePath}`, import.meta.url),
        "utf8"
    );
    return (source.match(STRING_LITERAL) || [])
        .map((literal) => literal.slice(1, -1))
        .filter((value) => !/^[@.]{1,3}\//.test(value))
        .join("\n");
};

test("no marketing copy in the repository makes a forbidden claim", () => {
    assert.ok(MARKETING_COPY_FILES.length > 0, "no marketing files were scanned");
    for (const relativePath of MARKETING_COPY_FILES) {
        const findings = findForbiddenMemoryClaims(copyIn(relativePath));
        assert.deepEqual(
            findings,
            [],
            `${relativePath}: ${findings
                .map((finding) => `${finding.claimId} — "${finding.match}"`)
                .join("; ")}`
        );
    }
});

test("no locale string makes a forbidden claim", () => {
    for (const [language, dictionary] of Object.entries(dictionaries)) {
        const findings = findForbiddenMemoryClaims(JSON.stringify(dictionary));
        assert.deepEqual(
            findings,
            [],
            `${language}: ${findings
                .map((finding) => `${finding.claimId} — "${finding.match}"`)
                .join("; ")}`
        );
    }
});

/* ------------------------------------------------- 3. the disclosure ------ */

/** What the file scan below applies to one file's copy. */
const missingDisclosure = (copy) =>
    claimsImportOrMemory(copy) &&
    !copy.includes(MEMORY_MARKETING_DISCLOSURE_ID) &&
    !copy.includes(MEMORY_MARKETING_DISCLOSURE.en) &&
    !copy.includes(MEMORY_MARKETING_DISCLOSURE.ko);

test("the disclosure rule fires on a page that claims memory without it", () => {
    // Stated directly rather than left to the scan below, because no marketing
    // page claims memory yet: a loop over zero matching files passes whatever
    // the rule says, including nothing. This is what keeps the rule real until
    // Release B/C copy gives the scan something to read.
    assert.equal(
        missingDisclosure("검토하고 승인한 기억을 새 대화에 활용합니다."),
        true
    );
    assert.equal(
        missingDisclosure(
            `검토하고 승인한 기억을 새 대화에 활용합니다.\n${MEMORY_MARKETING_DISCLOSURE.ko}`
        ),
        false
    );
    assert.equal(
        missingDisclosure(
            `Import your conversations from ChatGPT.\n${MEMORY_MARKETING_DISCLOSURE.en}`
        ),
        false
    );
});

test("marketing copy that claims import or memory carries the disclosure", () => {
    // Today nothing does, and that is the state this records: §17 requires the
    // guard to exist before the copy, not alongside it. When Release B/C copy
    // lands, this is the assertion that makes the disclosure part of shipping
    // it rather than a follow-up.
    for (const relativePath of MARKETING_COPY_FILES) {
        assert.equal(
            missingDisclosure(copyIn(relativePath)),
            false,
            `${relativePath} markets import or memory without §17's disclosure`
        );
    }
});

/* ---------------------------------------------- 4. the claim registry ----- */

test("the registry is internally consistent", () => {
    const ids = ALLOWED_MEMORY_CLAIMS.map((claim) => claim.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate allowed-claim id");
    assert.ok(
        !ids.includes(MEMORY_MARKETING_DISCLOSURE_ID),
        "the disclosure is not one of the claims"
    );
    assert.deepEqual(
        [...MEMORY_MARKETING_KEYS].sort(),
        [...ids, MEMORY_MARKETING_DISCLOSURE_ID].sort()
    );
    for (const claim of ALLOWED_MEMORY_CLAIMS) {
        assert.ok(claim.policyWording.trim().length > 0, `${claim.id} has no wording`);
    }
});

test("a memory-marketing namespace may only hold registered keys", () => {
    // This is the half that reaches the five locales the patterns do not: a
    // claim nobody registered cannot acquire a German translation without
    // first acquiring an id above. It is written to hold before the namespace
    // exists as well as after, because that is when the rule has to be true.
    for (const [language, dictionary] of Object.entries(dictionaries)) {
        const namespace = dictionary[MEMORY_MARKETING_NAMESPACE];
        if (!namespace) continue;
        assert.deepEqual(
            Object.keys(namespace).sort(),
            [...MEMORY_MARKETING_KEYS].sort(),
            `${language}'s ${MEMORY_MARKETING_NAMESPACE} keys must be exactly the registered set`
        );
    }
});
