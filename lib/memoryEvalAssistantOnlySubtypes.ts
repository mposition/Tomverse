/**
 * Which `assistant_only` cases are subtype 3 or 4, and on what wording.
 *
 * `docs/ops/memory-extraction-eval-dataset.md` §3.3 names four subtypes and
 * asks each cell to hold **at least 30% in subtypes 3 and 4** — the two where
 * a fact really does sit inside the user's own sentence, and which are
 * therefore the hard ones. With 125 cases per cell the floor is 38.
 *
 * Nothing measured that until now. `mem-eval-succ-6`'s first checks compared
 * the subtype weight leaving against the weight arriving and reported the
 * floor itself as unmeasured, which is true and is not the same as met.
 *
 * ## Why this is a declared table and not a classifier
 *
 * A keyword pass over these conversations left 66 of 125 unclassified and
 * missed corrections as plain as "3년 전에 접었고 지금은 전혀 다른 일 합니다".
 * Subtype turns on what the user is *doing* with a sentence — withdrawing it,
 * supposing it, performing it — and that is not a property of the words. So
 * each entry below carries the clause that decided it, and a reader can
 * disagree with any single row by reading that clause.
 *
 * ## This is an AI-produced draft
 *
 * `SUBTYPE_REVIEW` records that. Every row was assigned by reading the case,
 * but the assignment is not a human judgement and the floor is close enough
 * to the count that a few rows decide it. The reviewer named in that record
 * confirms or corrects the table; until they do, `assistantOnlySubtypeFloor()`
 * reports what this draft says and labels it as such.
 *
 * Cases not listed are subtype 1 (the assistant guessed) or 2 (role-play,
 * ghost-writing, a worked sample, a form filled in for its layout). They are
 * not enumerated because the floor is a lower bound on 3 and 4: what matters
 * is that no case is credited to the floor without a reason beside it.
 */

import { createHash } from "node:crypto";

/** A case the draft reads as subtype 3 or 4, with the clause that decided it. */
export type AssistantOnlySubtypeEntry = {
    /** Subtype 3 (the user corrected it) or 4 (the user supposed it). */
    subtype: 3 | 4;
    /** The clause the classification rests on, quoted from the case. */
    ground: string;
};

/**
 * Subtype 3: the user withdraws or corrects something — their own earlier
 * sentence, or a fact the assistant attributed to them.
 *
 * A denial inside a guessing game is not here: "not quite" answers a guess the
 * assistant volunteered, which is subtype 1's whole shape, and counting it
 * twice would let the easiest cases fill the hardest quota.
 *
 * Nor is a third party framed as one from the start ("a friend is looking at
 * emigrating"). Subtype 3 is a *change* of attribution mid-conversation; a
 * question that was never about the user is an ordinary third-party case.
 */
export const ASSISTANT_ONLY_SUBTYPES: Readonly<
    Record<string, AssistantOnlySubtypeEntry>
> = {
    /* ---------------------------------------------------------- ko, 3 -- */
    "succ-assistant-ko-9": { subtype: 3, ground: "잘못 보냈습니다. 다른 사람한테 쓰던 메시지였어요" },
    "succ-assistant-ko-10": { subtype: 3, ground: "3년 전에 접었고 지금은 전혀 다른 일 합니다" },
    "succ-assistant-ko-16": { subtype: 3, ground: "당연히 아니고요, 요즘 거의 안 움직입니다" },
    "succ-assistant-ko-29": { subtype: 3, ground: "지금 보니 결국 안 했네요" },
    "succ-assistant-ko-64": { subtype: 3, ground: "실제 제 경험은 아니고 대회용이에요" },
    "succ-assistant-ko-87": { subtype: 3, ground: "저는 아직 한참 남았고 아버지 얘기입니다" },
    "succ-assistant-ko-88": { subtype: 3, ground: "제 건물은 아니고 상담 건입니다" },
    "succ-assistant-ko-100": { subtype: 3, ground: "친구 프로젝트라 대신 씁니다" },
    "succ-assistant-ko-101": { subtype: 3, ground: "채널 주인은 제가 아니고 의뢰받은 거예요" },
    "succ-assistant-ko-108": { subtype: 3, ground: "제 동은 아니고 어르신 동입니다" },
    "succ-assistant-ko-112": { subtype: 3, ground: "제 상황은 아니고 양식 확인용입니다" },
    "succ-assistant-ko-115": { subtype: 3, ground: "제 경력은 다릅니다" },
    "succ-assistant-ko-119": { subtype: 3, ground: "제 기기는 아니고 양식 예시입니다" },
    "succ-assistant-ko-307": { subtype: 3, ground: "온라인 전제로 말씀하셔서 다시 여쭙니다" },
    "succ-assistant-ko-314": { subtype: 3, ground: "저는 같은 부서였던 적은 없지만" },
    "succ-assistant-ko-315": { subtype: 3, ground: "제 약은 아니고 아버지 거예요" },
    "succ-assistant-ko-316": { subtype: 3, ground: "저 그 업계 사람 아닙니다" },
    "succ-assistant-ko-401": { subtype: 3, ground: "그때는 출장이었습니다. 제 소속은 창원 지사입니다" },
    "succ-assistant-ko-402": { subtype: 3, ground: "저는 서울에서 자라지 않았습니다" },
    "succ-assistant-ko-403": { subtype: 3, ground: "저는 커피를 마시지 않습니다" },
    "succ-assistant-ko-404": { subtype: 3, ground: "제 생활권은 대전이 아닙니다" },
    "succ-assistant-ko-405": { subtype: 3, ground: "저는 법조인이 아닙니다" },
    "succ-assistant-ko-406": { subtype: 3, ground: "저는 글루텐 제한이 없습니다" },
    "succ-assistant-ko-407": { subtype: 3, ground: "저는 배우자가 없어서 그 항목은 해당되지 않습니다" },
    "succ-assistant-ko-501": { subtype: 3, ground: "십 년은 제 동아리 선배 얘기고 저는 첼로를 이번에 처음 시작합니다" },
    "succ-assistant-ko-504": { subtype: 3, ground: "격주라고 말씀드렸는데 매주로 잡으셨네요" },
    "succ-assistant-ko-505": { subtype: 3, ground: "저울을 잘못 봤습니다. 십삼 킬로였어요" },
    "succ-assistant-ko-507": { subtype: 3, ground: "제 차가 아니라 수리 맡긴 동안 빌린 대차예요" },

    /* ---------------------------------------------------------- ko, 4 -- */
    "succ-assistant-ko-4": { subtype: 4, ground: "제가 만약 채식주의자라면" },
    "succ-assistant-ko-21": { subtype: 4, ground: "예를 들어 배우자와 자녀 둘을 둔 사람이" },
    "succ-assistant-ko-54": { subtype: 4, ground: "그때 그 집을 샀더라면 / 안 샀어요" },
    "succ-assistant-ko-55": { subtype: 4, ground: "이번 시험에 붙으면 / 아직 시험 안 봤어요" },
    "succ-assistant-ko-94": { subtype: 4, ground: "만약 지금 이직하면 / 이직 계획은 없고" },
    "succ-assistant-ko-96": { subtype: 4, ground: "유학을 간다고 하면 / 갈 계획은 없습니다" },
    "succ-assistant-ko-317": { subtype: 4, ground: "해외로 이주한다면 / 아직 한국에 있고" },
    "succ-assistant-ko-502": { subtype: 4, ground: "쌍둥이를 키우는 집이라면" },
    "succ-assistant-ko-503": { subtype: 4, ground: "가령 매달 삼백만 원을 베트남으로 보내는 경우라면" },
    "succ-assistant-ko-508": { subtype: 4, ground: "중형견을 키운다고 하면 / 지금 키우는 건 없고" },

    /* ---------------------------------------------------------- en, 3 -- */
    "succ-assistant-en-3": { subtype: 3, ground: "Sorry, I mistyped — I moved away years ago" },
    "succ-assistant-en-9": { subtype: 3, ground: "Ignore that, wrong chat" },
    "succ-assistant-en-19": { subtype: 3, ground: "I don't work at a desk" },
    "succ-assistant-en-28": { subtype: 3, ground: "Seriously though I don't really have any" },
    "succ-assistant-en-29": { subtype: 3, ground: "Never happened, obviously" },
    "succ-assistant-en-64": { subtype: 3, ground: "Not my actual experience — it's for the competition" },
    "succ-assistant-en-87": { subtype: 3, ground: "I'm decades off myself — this is about him" },
    "succ-assistant-en-88": { subtype: 3, ground: "Not my building — I'm advising on it" },
    "succ-assistant-en-93": { subtype: 3, ground: "It isn't economics" },
    "succ-assistant-en-100": { subtype: 3, ground: "It's a friend's project — I'm writing it for him" },
    "succ-assistant-en-101": { subtype: 3, ground: "It isn't my channel, it's a commission" },
    "succ-assistant-en-108": { subtype: 3, ground: "That's his block, not mine" },
    "succ-assistant-en-112": { subtype: 3, ground: "Not my situation — checking the form" },
    "succ-assistant-en-115": { subtype: 3, ground: "My background is different" },
    "succ-assistant-en-310": { subtype: 3, ground: "Obviously not — that's why I'm asking" },
    "succ-assistant-en-313": { subtype: 3, ground: "I've never run one" },
    "succ-assistant-en-314": { subtype: 3, ground: "They're his, not mine" },
    "succ-assistant-en-315": { subtype: 3, ground: "Not me — it's the template" },
    "succ-assistant-en-401": { subtype: 3, ground: "I have never held a driving licence" },
    "succ-assistant-en-402": { subtype: 3, ground: "There is no scanner in this house" },
    "succ-assistant-en-403": { subtype: 3, ground: "French is not my first language" },
    "succ-assistant-en-404": { subtype: 3, ground: "I am not squeamish about numbers" },
    "succ-assistant-en-405": { subtype: 3, ground: "I am not based at head office; the depot is where I sit" },
    "succ-assistant-en-406": { subtype: 3, ground: "Nobody trained me as an electrician" },
    "succ-assistant-en-407": { subtype: 3, ground: "sesame allergy is not something I have" },
    "succ-assistant-en-501": { subtype: 3, ground: "I'm not the chair. I'm typing this one up as a favour" },
    "succ-assistant-en-503": { subtype: 3, ground: "I had the year wrong. Ignore the 2019" },

    /* ---------------------------------------------------------- en, 4 -- */
    "succ-assistant-en-4": { subtype: 4, ground: "If I were a vegetarian" },
    "succ-assistant-en-15": { subtype: 4, ground: "Suppose I quit tomorrow / entirely hypothetical" },
    "succ-assistant-en-21": { subtype: 4, ground: "Say someone bought a flat for 200,000" },
    "succ-assistant-en-53": { subtype: 4, ground: "If I retired to the countryside / I'm still working" },
    "succ-assistant-en-54": { subtype: 4, ground: "What if I'd bought that house / I didn't buy it" },
    "succ-assistant-en-55": { subtype: 4, ground: "If I pass this exam / I haven't sat it yet" },
    "succ-assistant-en-94": { subtype: 4, ground: "If I changed jobs now / No plans to leave" },
    "succ-assistant-en-95": { subtype: 4, ground: "If I registered as self-employed / Still employed" },
    "succ-assistant-en-96": { subtype: 4, ground: "If I studied abroad / I'm not going anywhere" },
    "succ-assistant-en-502": { subtype: 4, ground: "Where a tenant has been in a flat for over ten years" },
    "succ-assistant-en-505": { subtype: 4, ground: "If someone broke a broadband contract halfway through / I'm not going anywhere" },
};

/**
 * A digest of the table, so a freeze record can bind it.
 *
 * The dataset digest does not cover this file — it fingerprints cases, and the
 * subtype of a case is a judgement *about* a case rather than part of it. That
 * means a freeze pinning only the dataset digest would leave the classification
 * free to move afterwards, and the docs/ops/memory-extraction-eval-dataset.md §3.3 floor is decided by the classification.
 * Two rows re-read differently would take a cell below 38 with every recorded
 * digest still matching.
 *
 * So the manifest carries this alongside the dataset digest, and the freeze
 * record pins both. Ids, subtypes and grounds all go in: a ground rewritten to
 * justify a different subtype is exactly the drift worth catching, and the
 * review status is in because a table signed by nobody is a different artefact
 * from the same rows signed by a reviewer. `method` is in for the same reason
 * as the status — it is the claim about how the reading was done, and a
 * signature covers what was claimed when it was given. Outside the digest, the
 * methodology sentence could be rewritten after a freeze with nothing moving.
 */
export function subtypeTableFingerprintInput(): string {
    const rows = Object.keys(ASSISTANT_ONLY_SUBTYPES)
        .sort()
        .map((id) => {
            const entry = ASSISTANT_ONLY_SUBTYPES[id];
            return `${id}=${entry.subtype}:${entry.ground}`;
        });
    return [
        `status=${SUBTYPE_REVIEW.status}`,
        `reviewer=${SUBTYPE_REVIEW.reviewer ?? "-"}`,
        `reviewedAt=${SUBTYPE_REVIEW.reviewedAt ?? "-"}`,
        `method=${SUBTYPE_REVIEW.method}`,
        `rows=${rows.length}`,
        ...rows,
    ].join("\n");
}

export function subtypeTableDigest(): string {
    return createHash("sha256")
        .update(subtypeTableFingerprintInput(), "utf8")
        .digest("hex");
}

/** Who has confirmed the table above, and who has not. */
export const SUBTYPE_REVIEW = {
    /**
     * `ai_draft` until a person signs it. The floor is decided by a handful of
     * rows either way, so an unreviewed table cannot settle whether docs/ops/memory-extraction-eval-dataset.md §3.3 is
     * met — it can only say what a careful reading found.
     */
    status: "ai_draft" as "ai_draft" | "human_confirmed",
    reviewer: null as string | null,
    reviewedAt: null as string | null,
    method:
        "Every assistant_only case in mem-eval-succ-6 was read in full; the clause " +
        "quoted in each row is the one the subtype rests on.",
} as const;

export type AssistantOnlyFloorReport = {
    cell: string;
    total: number;
    /** ⌈30% of `total`⌉. */
    floor: number;
    subtype3: readonly string[];
    subtype4: readonly string[];
    hard: number;
    meetsFloor: boolean;
    /** How many more subtype 3/4 cases the cell needs. Zero when it clears. */
    shortfall: number;
};

/**
 * The docs/ops/memory-extraction-eval-dataset.md §3.3 floor for each `assistant_only` cell, under the table above.
 *
 * Reports rather than gates, and the distinction is the point: a gate here
 * would fail the build over an AI's reading of 250 conversations. What a
 * shortfall means is that somebody has to decide — confirm the table, correct
 * it, or change the sample — and none of those is a thing a check can do.
 */
export function assistantOnlySubtypeFloor(
    cases: readonly { id: string; category: string; language: string }[]
): readonly AssistantOnlyFloorReport[] {
    const byCell = new Map<string, string[]>();
    for (const testCase of cases) {
        if (testCase.category !== "assistant_only") continue;
        const cell = `${testCase.category}:${testCase.language}`;
        byCell.set(cell, [...(byCell.get(cell) ?? []), testCase.id]);
    }
    return [...byCell.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([cell, ids]) => {
            const of = (subtype: 3 | 4) =>
                ids.filter((id) => ASSISTANT_ONLY_SUBTYPES[id]?.subtype === subtype);
            const subtype3 = of(3);
            const subtype4 = of(4);
            const hard = subtype3.length + subtype4.length;
            const floor = Math.ceil(ids.length * 0.3);
            return {
                cell,
                total: ids.length,
                floor,
                subtype3,
                subtype4,
                hard,
                meetsFloor: hard >= floor,
                shortfall: Math.max(0, floor - hard),
            };
        });
}

/**
 * Rows naming a case the dataset does not hold.
 *
 * The table is written by hand against case ids, so a renamed or replaced case
 * would leave a row pointing at nothing and quietly lower the count. This is
 * the one part of the subtype question a check can settle, so it is a failure
 * rather than a note.
 */
export function unknownSubtypeRows(
    cases: readonly { id: string }[]
): readonly string[] {
    const ids = new Set(cases.map((testCase) => testCase.id));
    return Object.keys(ASSISTANT_ONLY_SUBTYPES).filter((id) => !ids.has(id));
}
