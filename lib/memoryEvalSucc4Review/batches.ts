/**
 * `succ-4` polarity assignments, batch by batch, for the golds whose anchor the
 * drafting tool found without ambiguity.
 *
 * `.github/audits/memory-eval-gold-contract-2026-08-27.md` §12 and the six
 * conditions approved 2026-08-28. Separate from `readings.ts` because those 121
 * were the golds a reviewer had to settle *before* a standard existed; these
 * are assigned under one that was written down first.
 *
 * ## What "unambiguous anchor" does not mean
 *
 * It means the drafting tool found exactly one user message carrying the fact
 * and one sentence of it covering the tokens. It says nothing about the label.
 * `goldEvidenceFailure()` likewise proves the anchor names a user message, that
 * the quote is a real span of it, and that the quote contains the fact — and
 * nothing about whether the polarity is right.
 *
 * ## The marker scan is routing, and this batch shows why
 *
 * `POLARITY_MARKERS.ko` is `않 · 없 · 아니 · 못`. It does not contain **안**,
 * the ordinary pre-verbal negator, so `아이는 학원 안 보내기로 정했습니다`
 * scanned as unmarked and is plainly a denial. The list is a fixed diagnostic,
 * not an account of how Korean negates, and this batch is the case in hand.
 *
 * ## Keys are generated, never transcribed
 *
 * `caseId:goldId` comes out of the source fixtures. Two earlier slips —
 * `succ-durable-ko-313:e1` for `:g1`, and `succ-durable-ko-199:e1` for `:e2` —
 * were both a hand-copied identifier, and an identifier is not a judgement.
 * `tests/memoryEvalSucc4Review.test.mjs` checks each key against the fixtures
 * and checks the batch against the cell's full key set, so a missing or
 * duplicated gold fails rather than passing quietly.
 */

export type Succ4BatchGold = {
    /** `caseId:goldId`, generated from the fixtures. */
    key: string;
    polarity: "affirmed" | "negated";
    /** Why, where a reader would otherwise have to reconstruct the reading. */
    note?: string;
};

export type Succ4Batch = {
    id: string;
    cell: string;
    /** Offset into the cell's unreviewed golds, sorted by key. */
    from: number;
    golds: readonly Succ4BatchGold[];
};

export const SUCC4_BATCHES: readonly Succ4Batch[] = [
    {
        id: "succ4-b01",
        cell: "durable_facts:ko",
        from: 0,
        golds: [
            { key: "succ-durable-ko-100:e1", polarity: "affirmed" },
            {
                key: "succ-durable-ko-101:e1",
                polarity: "negated",
                note:
                    "«종신보험은 해지하기로 결정했습니다» — a decision whose object is a " +
                    "cancellation. The memory says the user will not hold the policy, so " +
                    "보험 is denied of them. Follows the frozen reading of " +
                    "succ-durable-ko-153 («티비를 없애기로 하고 이미 처분했습니다»), " +
                    "which is negated on 티비; deciding this one the other way would " +
                    "split the same shape across two labels.",
            },
            {
                key: "succ-durable-ko-102:e1",
                polarity: "negated",
                note:
                    "«아이는 학원 안 보내기로 정했습니다». The scan called this unmarked " +
                    "because 안 is not in POLARITY_MARKERS, and it is a plain denial of " +
                    "학원. Same shape as ko-101.",
            },
            { key: "succ-durable-ko-103:e1", polarity: "affirmed" },
            {
                key: "succ-durable-ko-104:e1",
                polarity: "affirmed",
                note:
                    "당뇨 holds of the father, not the user, and the constraint on shared " +
                    "meals holds of the user. Both predications are affirmative, so §12.4's " +
                    "narrowing does not apply — there is no denied consequence here.",
            },
            { key: "succ-durable-ko-108:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-10:e1", polarity: "affirmed" },
            {
                key: "succ-durable-ko-110:e1",
                polarity: "affirmed",
                note:
                    "피해야 governs 타이핑, not 손목. The fact value is the condition, and " +
                    "the memory asserts the user has it.",
            },
            { key: "succ-durable-ko-114:e1", polarity: "affirmed" },
            {
                key: "succ-durable-ko-115:e1",
                polarity: "affirmed",
                note: "안 됩니다 attaches to 연락; the fact value 명절 is asserted.",
            },
            { key: "succ-durable-ko-117:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-119:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-11:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-120:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-121:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-122:e1", polarity: "affirmed" },
            {
                key: "succ-durable-ko-123:e1",
                polarity: "affirmed",
                note: "지 마시고 governs 이론; 실무 is what the memory asks for.",
            },
            {
                key: "succ-durable-ko-124:e1",
                polarity: "affirmed",
                note:
                    "«블로그 말고 공식 문서를 인용해 주세요» is a correction resolved " +
                    "inside one clause, and 공식 문서 is the affirmed side of it — the " +
                    "shape §10.2 rule 6 admits.",
            },
            {
                key: "succ-durable-ko-125:e1",
                polarity: "affirmed",
                note: "줄이지 말고 governs the abbreviating; 변수명 is asserted.",
            },
            { key: "succ-durable-ko-131:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-132:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-135:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-136:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-137:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-138:e1", polarity: "affirmed" },
        ],
    },
    {
        id: "succ4-b02",
        cell: "durable_facts:ko",
        from: 25,
        golds: [
            { key: "succ-durable-ko-139:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-139:e2", polarity: "affirmed" },
            { key: "succ-durable-ko-13:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-140:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-141:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-142:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-143:e1", polarity: "affirmed" },
            {
                key: "succ-durable-ko-143:e2",
                polarity: "affirmed",
                note:
                    "«서체 이름은 그냥 쓰셔도 됩니다» is a permission granted, not a need " +
                    "denied. Follows the frozen reading of succ-durable-en-146:e2 («water " +
                    "safety terminology is fine as-is»), which is affirmed.",
            },
            { key: "succ-durable-ko-144:e1", polarity: "affirmed" },
            {
                key: "succ-durable-ko-144:e2",
                polarity: "negated",
                note:
                    "Same quote as e1 and the opposite label, because they are different " +
                    "predications: 정비 is the user's field (affirmed), and «부품 이름은 " +
                    "설명 안 하셔도 됩니다» denies the need to explain 부품. Follows the " +
                    "frozen readings of en-38:e2, en-88:e2 and en-181:e2, all «no need to " +
                    "explain X» and all negated. The pair with ko-143:e2 is the line: a " +
                    "permission granted is affirmed, a need denied is negated.",
            },
            { key: "succ-durable-ko-146:e1", polarity: "affirmed" },
            {
                key: "succ-durable-ko-146:e2",
                polarity: "affirmed",
                note: "«그대로 쓰셔도 됩니다» — a permission, as ko-143:e2.",
            },
            { key: "succ-durable-ko-147:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-148:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-149:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-14:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-150:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-151:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-152:e1", polarity: "affirmed" },
            {
                key: "succ-durable-ko-154:e1",
                polarity: "affirmed",
                note:
                    "«투자보다 대출 상환을 먼저 하기로 정했습니다» — a decision whose " +
                    "object is doing the thing, unlike ko-155. 상환 holds of the user.",
            },
            {
                key: "succ-durable-ko-155:e1",
                polarity: "negated",
                note:
                    "«부업은 다 정리하기로 했습니다» — a decision to wind them up, so the " +
                    "user will not have 부업. Same shape as ko-101, ko-102 and the frozen " +
                    "ko-153.",
            },
            { key: "succ-durable-ko-160:e1", polarity: "affirmed" },
            {
                key: "succ-durable-ko-164:e1",
                polarity: "negated",
                note:
                    "«유머는 넣지 말고 진지하게만 답해 주세요». Follows the frozen reading " +
                    "of en-164:e1 («No jokes, please»). The scan called it unmarked: 말고 " +
                    "is not in POLARITY_MARKERS either.",
            },
            { key: "succ-durable-ko-165:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-166:e1", polarity: "affirmed" },
        ],
    },
    {
        id: "succ4-b03",
        cell: "durable_facts:ko",
        from: 50,
        golds: [
            {
                key: "succ-durable-ko-167:e1",
                polarity: "negated",
                note:
                    "«이모지는 쓰지 말아 주세요» — follows the frozen en-167:e1 («Please " +
                    "don't use emoji»). 말아 is not in POLARITY_MARKERS, so the scan " +
                    "called it unmarked.",
            },
            { key: "succ-durable-ko-168:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-169:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-16:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-170:e1", polarity: "affirmed" },
            {
                key: "succ-durable-ko-171:e1",
                polarity: "affirmed",
                note: "나누지 말고 governs the splitting; 한 파일 is what is asked for.",
            },
            {
                key: "succ-durable-ko-174:e1",
                polarity: "affirmed",
                note:
                    "The user has a ten-year-old laptop; 안 돌아갑니다 is about the " +
                    "programs. Follows the frozen en-58:e1 («My internet at home is " +
                    "barely faster than dial-up»).",
            },
            { key: "succ-durable-ko-176:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-177:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-178:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-179:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-179:e2", polarity: "affirmed" },
            { key: "succ-durable-ko-17:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-180:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-180:e2", polarity: "affirmed" },
            { key: "succ-durable-ko-181:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-182:e1", polarity: "affirmed" },
            {
                key: "succ-durable-ko-182:e2",
                polarity: "affirmed",
                note: "«그냥 말씀하셔도 알아들어요» — a permission, as ko-143:e2.",
            },
            { key: "succ-durable-ko-183:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-184:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-185:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-186:e1", polarity: "affirmed" },
            {
                key: "succ-durable-ko-187:e1",
                polarity: "negated",
                note:
                    "«헬스장은 끊기로 했습니다» — the wind-up shape of ko-101, ko-102, " +
                    "ko-155 and the frozen ko-153.",
            },
            {
                key: "succ-durable-ko-188:e1",
                polarity: "negated",
                note: "«서울로는 안 올라가기로 결정했습니다» — a decision not to.",
            },
            { key: "succ-durable-ko-18:e1", polarity: "affirmed" },
        ],
    },
    {
        id: "succ4-b04",
        cell: "durable_facts:ko",
        from: 75,
        golds: [
            { key: "succ-durable-ko-191:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-192:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-194:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-195:e1", polarity: "affirmed" },
            {
                key: "succ-durable-ko-196:e1",
                polarity: "affirmed",
                note:
                    "«링크는 본문에 섞지 말고 맨 끝에 모아 주세요» — 섞지 말고 governs the mixing. The links are wanted, only placed differently. Same shape as ko-171.",
            },
            { key: "succ-durable-ko-197:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-198:e1", polarity: "affirmed" },
            {
                key: "succ-durable-ko-199:e1",
                polarity: "affirmed",
                note:
                    "The 일본어 goal. This gold is where an earlier hand-copied id put ko-199:e1 on the negated list when the reading was of ko-199:e2 (회화는 거의 못 합니다). It was left unresolved at that correction, and this is its first actual reading.",
            },
            {
                key: "succ-durable-ko-19:e1",
                polarity: "affirmed",
                note:
                    "안 되네요 governs 자료 정리; the memory asserts the user is writing a climate paper.",
            },
            { key: "succ-durable-ko-1:e1", polarity: "affirmed" },
            {
                key: "succ-durable-ko-22:e1",
                polarity: "affirmed",
                note:
                    "«매매 말고 전세로 가기로 결정했어요» — a correction resolved inside one clause, with 전세 on the affirmed side. Same shape as ko-124.",
            },
            { key: "succ-durable-ko-24:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-26:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-27:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-302:g1", polarity: "affirmed" },
            { key: "succ-durable-ko-303:g1", polarity: "affirmed" },
            { key: "succ-durable-ko-304:g1", polarity: "affirmed" },
            {
                key: "succ-durable-ko-305:g1",
                polarity: "affirmed",
                note:
                    "어렵습니다 is about the typing; 관절염 is asserted of the user. Same shape as ko-110.",
            },
            { key: "succ-durable-ko-306:g1", polarity: "affirmed" },
            { key: "succ-durable-ko-308:g1", polarity: "affirmed" },
            { key: "succ-durable-ko-30:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-310:g1", polarity: "affirmed" },
            { key: "succ-durable-ko-311:g1", polarity: "affirmed" },
            { key: "succ-durable-ko-312:g1", polarity: "affirmed" },
            { key: "succ-durable-ko-315:g1", polarity: "affirmed" },
        ],
    },
];
