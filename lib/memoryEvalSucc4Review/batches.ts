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
    {
        id: "succ4-b05",
        cell: "durable_facts:ko",
        from: 100,
        golds: [
            { key: "succ-durable-ko-315:g2", polarity: "affirmed" },
            { key: "succ-durable-ko-316:g1", polarity: "affirmed" },
            { key: "succ-durable-ko-316:g2", polarity: "affirmed" },
            { key: "succ-durable-ko-317:g1", polarity: "affirmed" },
            { key: "succ-durable-ko-318:g1", polarity: "affirmed" },
            { key: "succ-durable-ko-318:g2", polarity: "affirmed" },
            {
                key: "succ-durable-ko-319:g1",
                polarity: "negated",
                note:
                    "«키가 작아서 위쪽 선반에 두는 물건은 저한테 안 맞습니다» — the memory denies the upper shelves as usable. Same shape as the frozen en-19:e1, narrowed to its consequence. 안 is not in POLARITY_MARKERS, so the scan called it unmarked.",
            },
            { key: "succ-durable-ko-31:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-320:g1", polarity: "affirmed" },
            { key: "succ-durable-ko-321:g1", polarity: "affirmed" },
            { key: "succ-durable-ko-322:g1", polarity: "affirmed" },
            { key: "succ-durable-ko-324:g1", polarity: "affirmed" },
            { key: "succ-durable-ko-325:g1", polarity: "affirmed" },
            { key: "succ-durable-ko-327:g1", polarity: "affirmed" },
            { key: "succ-durable-ko-328:g1", polarity: "affirmed" },
            { key: "succ-durable-ko-329:g1", polarity: "affirmed" },
            { key: "succ-durable-ko-32:e1", polarity: "affirmed" },
            {
                key: "succ-durable-ko-33:e1",
                polarity: "affirmed",
                note:
                    "«매운 걸 워낙 좋아해서 맵찔이용 메뉴는 안 알려주셔도 됩니다» — 안 알려주셔도 governs the mild menu. This is the exact counterpart of succ-assistant-ko-305's neighbour succ-assistant-ko-302 («저 매운 걸 못 먹습니다», negated): the same token 매운, opposite labels, which is the whole reason polarity is a field.",
            },
            { key: "succ-durable-ko-34:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-35:e1", polarity: "affirmed" },
            {
                key: "succ-durable-ko-35:e2",
                polarity: "affirmed",
                note:
                    "육 개월 is one of the five spellings the v5-run1 blind review found unmatchable. Under canon both the token and the quote become 6개월, so the anchor resolves — the numeral table doing the job it was written for.",
            },
            { key: "succ-durable-ko-36:e1", polarity: "affirmed" },
            {
                key: "succ-durable-ko-36:e2",
                polarity: "affirmed",
                note:
                    "새벽 세 시 is another of those five. 세 시 becomes 3시 on both sides because a counter follows.",
            },
            { key: "succ-durable-ko-37:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-38:e1", polarity: "affirmed" },
        ],
    },
    {
        id: "succ4-b06",
        cell: "durable_facts:ko",
        from: 125,
        golds: [
            {
                key: "succ-durable-ko-38:e2",
                polarity: "negated",
                note:
                    "«기초 설명은 빼주세요» — a need denied, as ko-16:e2 («기본기 설명은 필요 없어요») and the frozen en-38:e2. 빼주세요 is not in POLARITY_MARKERS.",
            },
            { key: "succ-durable-ko-39:e1", polarity: "affirmed" },
            {
                key: "succ-durable-ko-39:e2",
                polarity: "affirmed",
                note:
                    "«코드 이름 정도는 그냥 말씀하셔도 됩니다» — a permission granted, as ko-143:e2. It sits two golds from ko-38:e2 in this batch and takes the opposite label: that is the line, inside one cell.",
            },
            { key: "succ-durable-ko-3:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-40:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-41:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-42:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-43:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-44:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-45:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-46:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-48:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-49:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-4:e1", polarity: "affirmed" },
            {
                key: "succ-durable-ko-53:e1",
                polarity: "affirmed",
                note:
                    "«무릎이 안 좋아서 계단이나 등산은 무리예요» asserts the bad knee; 무리예요 is about the stairs. Same shape as the frozen ko-173 (허리) and ko-110 (손목).",
            },
            { key: "succ-durable-ko-54:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-55:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-56:e1", polarity: "affirmed" },
            {
                key: "succ-durable-ko-57:e1",
                polarity: "negated",
                note:
                    "«대학원은 안 가기로 했습니다» — a decision not to, as ko-188.",
            },
            { key: "succ-durable-ko-58:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-5:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-60:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-63:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-64:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-65:e1", polarity: "affirmed" },
        ],
    },
    {
        id: "succ4-b07",
        cell: "durable_facts:ko",
        from: 150,
        golds: [
            { key: "succ-durable-ko-66:e1", polarity: "affirmed" },
            {
                key: "succ-durable-ko-67:e1",
                polarity: "affirmed",
                note:
                    "넘기지 말고 governs the skipping; 질문 is what is asked for.",
            },
            { key: "succ-durable-ko-69:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-6:e1", polarity: "affirmed" },
            {
                key: "succ-durable-ko-6:e2",
                polarity: "negated",
                note:
                    "«기초 설명은 건너뛰고» — a need denied, as ko-38:e2 and ko-16:e2. 건너뛰고 is not in POLARITY_MARKERS.",
            },
            { key: "succ-durable-ko-70:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-71:e1", polarity: "affirmed" },
            {
                key: "succ-durable-ko-73:e1",
                polarity: "affirmed",
                note:
                    "알려주지 마시고 governs the method-only answer; 원리 is what is asked for.",
            },
            { key: "succ-durable-ko-74:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-75:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-77:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-7:e1", polarity: "affirmed" },
            {
                key: "succ-durable-ko-80:e1",
                polarity: "affirmed",
                note:
                    "«커피는 안 마시고 녹차만 마십니다» — 안 attaches to the coffee. The gold is about 녹차, which is asserted.",
            },
            { key: "succ-durable-ko-81:e1", polarity: "affirmed" },
            {
                key: "succ-durable-ko-82:e1",
                polarity: "affirmed",
                note:
                    "«엘리베이터 두고 계단으로 다닙니다» is affirmed on 계단, where ko-12 («계단 있는 곳은 아예 못 갑니다») is negated on the same token. Two users, opposite relations to stairs, told apart by the field.",
            },
            { key: "succ-durable-ko-84:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-85:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-86:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-87:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-88:e1", polarity: "affirmed" },
            {
                key: "succ-durable-ko-88:e2",
                polarity: "negated",
                note:
                    "«설명 안 하셔도 됩니다» — a need denied, the ko-144:e2 side of the line.",
            },
            { key: "succ-durable-ko-89:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-8:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-90:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-91:e1", polarity: "affirmed" },
            {
                key: "succ-durable-ko-91:e2",
                polarity: "affirmed",
                note:
                    "«그냥 하셔도 알아들어요» — a permission, the ko-143:e2 side.",
            },
            { key: "succ-durable-ko-92:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-93:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-94:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-95:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-96:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-97:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-98:e1", polarity: "affirmed" },
            { key: "succ-durable-ko-9:e1", polarity: "affirmed" },
        ],
    },
    {
        id: "succ4-b08",
        cell: "durable_facts:en",
        from: 0,
        golds: [
            { key: "succ-durable-en-100:e1", polarity: "affirmed" },
            {
                key: "succ-durable-en-102:e1",
                polarity: "affirmed",
                note:
                    "«We decided to outsource payroll rather than keep it in house» asserts an arrangement about payroll, not its absence.",
            },
            {
                key: "succ-durable-en-103:e1",
                polarity: "negated",
                note:
                    "«We dropped the extended insurance» — the wind-up shape of ko-101, ko-155, ko-187 and the frozen ko-153.",
            },
            {
                key: "succ-durable-en-104:e1",
                polarity: "affirmed",
                note:
                    "Both predications are affirmative — the son is autistic and routine changes are hard — so §12.4's narrowing does not apply. Same as ko-104.",
            },
            { key: "succ-durable-en-107:e1", polarity: "affirmed" },
            { key: "succ-durable-en-114:e1", polarity: "affirmed" },
            { key: "succ-durable-en-115:e1", polarity: "affirmed" },
            { key: "succ-durable-en-117:e1", polarity: "affirmed" },
            { key: "succ-durable-en-118:e1", polarity: "affirmed" },
            { key: "succ-durable-en-119:e1", polarity: "affirmed" },
            { key: "succ-durable-en-11:e1", polarity: "affirmed" },
            {
                key: "succ-durable-en-11:e2",
                polarity: "negated",
                note:
                    "«You can skip the introductions» — a need denied, as ko-6:e2 and the frozen en-38:e2.",
            },
            { key: "succ-durable-en-120:e1", polarity: "affirmed" },
            { key: "succ-durable-en-121:e1", polarity: "affirmed" },
            {
                key: "succ-durable-en-123:e1",
                polarity: "affirmed",
                note:
                    "Skip governs the theory; practical is what is asked for. Same as ko-123.",
            },
            {
                key: "succ-durable-en-124:e1",
                polarity: "affirmed",
                note:
                    "«rather than a blog post» — a correction resolved in one clause, as ko-124.",
            },
            { key: "succ-durable-en-125:e1", polarity: "affirmed" },
            {
                key: "succ-durable-en-126:e1",
                polarity: "affirmed",
                note:
                    "«I'm coeliac, so gluten is completely off the table» — the memory asserts the condition, and the allergen token goes with it. Follows the frozen en-108:e1 (peanut/anaphylaxis), en-199:e1 (lactose) and ko-1:e1 (갑각류), all affirmed.",
            },
            {
                key: "succ-durable-en-127:e1",
                polarity: "affirmed",
                note:
                    "«I react badly to fragrance» is affirmative about the fragrance; the scented products are the consequence. Same as the frozen ko-127.",
            },
            {
                key: "succ-durable-en-129:e1",
                polarity: "negated",
                note:
                    "«Weekends are completely spoken for» is affirmative in form and " +
                    "denies the availability of the weekend, which is what the canonical " +
                    "proposition is about. Read as affirmed it would have made one fact " +
                    "carry two labels across the arms -- the frozen ko-129 («주말에는 " +
                    "아예 시간을 못 냅니다») is negated on 주말 -- and a score that moves " +
                    "with the paraphrase is not measuring the extraction. Ruled " +
                    "2026-08-28: negated, and the case moves under §12.2 because " +
                    "[\"weekend\"] names the topic where the opposite reading is live.",
            },
            { key: "succ-durable-en-12:e1", polarity: "affirmed" },
            { key: "succ-durable-en-131:e1", polarity: "affirmed" },
            { key: "succ-durable-en-132:e1", polarity: "affirmed" },
            { key: "succ-durable-en-135:e1", polarity: "affirmed" },
            { key: "succ-durable-en-136:e1", polarity: "affirmed" },
        ],
    },
    {
        id: "succ4-b09",
        cell: "durable_facts:en",
        from: 25,
        golds: [
            { key: "succ-durable-en-137:e1", polarity: "affirmed" },
            { key: "succ-durable-en-138:e1", polarity: "affirmed" },
            { key: "succ-durable-en-139:e1", polarity: "affirmed" },
            { key: "succ-durable-en-139:e2", polarity: "affirmed" },
            { key: "succ-durable-en-13:e1", polarity: "affirmed" },
            { key: "succ-durable-en-140:e1", polarity: "affirmed" },
            {
                key: "succ-durable-en-140:e2",
                polarity: "affirmed",
                note:
                    "«During harvest I'm unavailable for anything else» asserts the harvest as the recurring context; the unavailability is its consequence. Mirrors the frozen ko-140:e2 (수확기).",
            },
            { key: "succ-durable-en-141:e1", polarity: "affirmed" },
            { key: "succ-durable-en-141:e2", polarity: "affirmed" },
            { key: "succ-durable-en-142:e1", polarity: "affirmed" },
            { key: "succ-durable-en-143:e1", polarity: "affirmed" },
            {
                key: "succ-durable-en-143:e2",
                polarity: "affirmed",
                note:
                    "«you can use the proper script names» — a permission granted, the exact English pair of ko-143:e2.",
            },
            { key: "succ-durable-en-147:e1", polarity: "affirmed" },
            { key: "succ-durable-en-148:e1", polarity: "affirmed" },
            { key: "succ-durable-en-149:e1", polarity: "affirmed" },
            { key: "succ-durable-en-14:e1", polarity: "affirmed" },
            { key: "succ-durable-en-150:e1", polarity: "affirmed" },
            { key: "succ-durable-en-151:e1", polarity: "affirmed" },
            { key: "succ-durable-en-152:e1", polarity: "affirmed" },
            {
                key: "succ-durable-en-154:e1",
                polarity: "affirmed",
                note:
                    "«overpay the mortgage rather than invest» — a decision to do the thing, as ko-154.",
            },
            {
                key: "succ-durable-en-155:e1",
                polarity: "negated",
                note:
                    "«I wound down the side business deliberately» — the wind-up shape, and the English pair of ko-155 (부업 정리). wound down is not in POLARITY_MARKERS.",
            },
            { key: "succ-durable-en-157:e1", polarity: "affirmed" },
            { key: "succ-durable-en-158:e1", polarity: "affirmed" },
            { key: "succ-durable-en-159:e1", polarity: "affirmed" },
            { key: "succ-durable-en-15:e1", polarity: "affirmed" },
        ],
    },
    {
        id: "succ4-b10",
        cell: "durable_facts:en",
        from: 50,
        golds: [
            { key: "succ-durable-en-161:e1", polarity: "affirmed" },
            {
                key: "succ-durable-en-163:e1",
                polarity: "affirmed",
                note:
                    "«Keep the jargon but put a short gloss in brackets» keeps it; the gloss is an addition, not a refusal.",
            },
            { key: "succ-durable-en-165:e1", polarity: "affirmed" },
            {
                key: "succ-durable-en-169:e1",
                polarity: "affirmed",
                note:
                    "twelve is one of the five spellings the v5-run1 blind review found unmatchable. Under canon the token and the quote both become 12, so the anchor resolves.",
            },
            { key: "succ-durable-en-16:e1", polarity: "affirmed" },
            { key: "succ-durable-en-170:e1", polarity: "affirmed" },
            {
                key: "succ-durable-en-171:e1",
                polarity: "affirmed",
                note:
                    "«rather than split across modules» — the split is what is declined; the single file is asserted. As ko-171.",
            },
            {
                key: "succ-durable-en-172:e1",
                polarity: "affirmed",
                note:
                    "«I get dizzy if I stand for long» asserts the condition; being on one's feet is the consequence. Mirrors the frozen ko-172.",
            },
            {
                key: "succ-durable-en-174:e1",
                polarity: "affirmed",
                note:
                    "«My laptop is ten years old» — the user has the laptop. Mirrors ko-174.",
            },
            { key: "succ-durable-en-175:e1", polarity: "affirmed" },
            { key: "succ-durable-en-176:e1", polarity: "affirmed" },
            { key: "succ-durable-en-179:e1", polarity: "affirmed" },
            { key: "succ-durable-en-179:e2", polarity: "affirmed" },
            { key: "succ-durable-en-17:e1", polarity: "affirmed" },
            { key: "succ-durable-en-180:e1", polarity: "affirmed" },
            { key: "succ-durable-en-180:e2", polarity: "affirmed" },
            { key: "succ-durable-en-183:e1", polarity: "affirmed" },
            { key: "succ-durable-en-184:e1", polarity: "affirmed" },
            { key: "succ-durable-en-185:e1", polarity: "affirmed" },
            { key: "succ-durable-en-186:e1", polarity: "affirmed" },
            {
                key: "succ-durable-en-187:e1",
                polarity: "negated",
                note:
                    "«I cancelled the gym membership» — the wind-up shape, the English pair of ko-187.",
            },
            {
                key: "succ-durable-en-188:e1",
                polarity: "negated",
                note:
                    "«We decided against moving to the city» — a decision not to, the English pair of ko-188. against carries no listed marker.",
            },
            { key: "succ-durable-en-18:e1", polarity: "affirmed" },
            { key: "succ-durable-en-191:e1", polarity: "affirmed" },
            { key: "succ-durable-en-192:e1", polarity: "affirmed" },
        ],
    },
    {
        id: "succ4-b11",
        cell: "durable_facts:en",
        from: 75,
        golds: [
            { key: "succ-durable-en-193:e1", polarity: "affirmed" },
            { key: "succ-durable-en-194:e1", polarity: "affirmed" },
            { key: "succ-durable-en-195:e1", polarity: "affirmed" },
            {
                key: "succ-durable-en-196:e1",
                polarity: "affirmed",
                note:
                    "«Keep links out of the body and gather them at the end» wants the links, only elsewhere. The English pair of ko-196.",
            },
            { key: "succ-durable-en-197:e1", polarity: "affirmed" },
            { key: "succ-durable-en-198:e1", polarity: "affirmed" },
            { key: "succ-durable-en-1:e1", polarity: "affirmed" },
            {
                key: "succ-durable-en-1:e2",
                polarity: "affirmed",
                note:
                    "twelve-hour is the fourth of the blind review's five unmatchable spellings to resolve under canon: punctuation becomes a space and twelve becomes 12, on both sides.",
            },
            { key: "succ-durable-en-200:e1", polarity: "affirmed" },
            { key: "succ-durable-en-24:e1", polarity: "affirmed" },
            { key: "succ-durable-en-25:e1", polarity: "affirmed" },
            { key: "succ-durable-en-27:e1", polarity: "affirmed" },
            { key: "succ-durable-en-2:e1", polarity: "affirmed" },
            { key: "succ-durable-en-301:g1", polarity: "affirmed" },
            { key: "succ-durable-en-307:g1", polarity: "affirmed" },
            { key: "succ-durable-en-309:g1", polarity: "affirmed" },
            { key: "succ-durable-en-310:g1", polarity: "affirmed" },
            { key: "succ-durable-en-310:g2", polarity: "affirmed" },
            { key: "succ-durable-en-310:g3", polarity: "affirmed" },
            {
                key: "succ-durable-en-313:g1",
                polarity: "affirmed",
                note:
                    "affirmed on evening, where en-20 is negated on the same token after its gold correction. Two users, opposite relations to their evenings.",
            },
            { key: "succ-durable-en-314:g1", polarity: "affirmed" },
            { key: "succ-durable-en-315:g1", polarity: "affirmed" },
            { key: "succ-durable-en-315:g2", polarity: "affirmed" },
            { key: "succ-durable-en-316:g1", polarity: "affirmed" },
            {
                key: "succ-durable-en-316:g2",
                polarity: "negated",
                note:
                    "«anything that needs quiet or floor space is constrained» is the " +
                    "same shape as en-129: affirmative in form, denying the availability " +
                    "of the space. Ruled 2026-08-28 with it, and [\"space\"] is " +
                    "under-specified for the same reason.",
            },
        ],
    },
    {
        id: "succ4-b12",
        cell: "durable_facts:en",
        from: 100,
        golds: [
            {
                key: "succ-durable-en-317:g1",
                polarity: "negated",
                note:
                    "«anything stored above shoulder height is out for me» denies the reach, as ko-319 denies the upper shelves. out carries no listed marker.",
            },
            { key: "succ-durable-en-318:g1", polarity: "affirmed" },
            { key: "succ-durable-en-319:g1", polarity: "affirmed" },
            { key: "succ-durable-en-31:e1", polarity: "affirmed" },
            { key: "succ-durable-en-32:e1", polarity: "affirmed" },
            { key: "succ-durable-en-33:e1", polarity: "affirmed" },
            { key: "succ-durable-en-34:e1", polarity: "affirmed" },
            { key: "succ-durable-en-34:e2", polarity: "affirmed" },
            { key: "succ-durable-en-35:e1", polarity: "affirmed" },
            { key: "succ-durable-en-36:e1", polarity: "affirmed" },
            { key: "succ-durable-en-37:e1", polarity: "affirmed" },
            { key: "succ-durable-en-39:e1", polarity: "affirmed" },
            { key: "succ-durable-en-3:e1", polarity: "affirmed" },
            {
                key: "succ-durable-en-40:e1",
                polarity: "affirmed",
                note:
                    "«I'm completely new to gardening» asserts the beginner standing, as ko-307 (용접) does.",
            },
            { key: "succ-durable-en-42:e1", polarity: "affirmed" },
            { key: "succ-durable-en-43:e1", polarity: "affirmed" },
            {
                key: "succ-durable-en-44:e1",
                polarity: "affirmed",
                note:
                    "«aimed at being debt free» is a goal asserted. The kind is long_term_goal and the memory states the goal, not the absence of debt today.",
            },
            { key: "succ-durable-en-45:e1", polarity: "affirmed" },
            { key: "succ-durable-en-46:e1", polarity: "affirmed" },
            { key: "succ-durable-en-47:e1", polarity: "affirmed" },
            { key: "succ-durable-en-48:e1", polarity: "affirmed" },
            { key: "succ-durable-en-49:e1", polarity: "affirmed" },
            { key: "succ-durable-en-4:e1", polarity: "affirmed" },
            { key: "succ-durable-en-50:e1", polarity: "affirmed" },
            { key: "succ-durable-en-51:e1", polarity: "affirmed" },
        ],
    },
    {
        id: "succ4-b13",
        cell: "durable_facts:en",
        from: 125,
        golds: [
            { key: "succ-durable-en-53:e1", polarity: "affirmed" },
            {
                key: "succ-durable-en-54:e1",
                polarity: "affirmed",
                note:
                    "«has to be gluten free» states the requirement in the affirmative, and the allergen token goes with the condition — as en-126 and the frozen en-108, en-199, ko-1.",
            },
            { key: "succ-durable-en-55:e1", polarity: "affirmed" },
            {
                key: "succ-durable-en-59:e1",
                polarity: "affirmed",
                note:
                    "«Severe shellfish allergy here» is affirmed on shellfish, where succ-assistant-en-305 («I don't have a shellfish allergy») is negated on it. The allergen pair the field exists for.",
            },
            { key: "succ-durable-en-5:e1", polarity: "affirmed" },
            { key: "succ-durable-en-60:e1", polarity: "affirmed" },
            { key: "succ-durable-en-64:e1", polarity: "affirmed" },
            {
                key: "succ-durable-en-66:e1",
                polarity: "negated",
                note:
                    "«Please drop the disclaimers» — a refusal, as the frozen en-116 (apologies) and en-164 (jokes). drop carries no listed marker.",
            },
            { key: "succ-durable-en-67:e1", polarity: "affirmed" },
            { key: "succ-durable-en-68:e1", polarity: "affirmed" },
            { key: "succ-durable-en-69:e1", polarity: "affirmed" },
            { key: "succ-durable-en-6:e1", polarity: "affirmed" },
            { key: "succ-durable-en-70:e1", polarity: "affirmed" },
            { key: "succ-durable-en-71:e1", polarity: "affirmed" },
            { key: "succ-durable-en-72:e1", polarity: "affirmed" },
            { key: "succ-durable-en-74:e1", polarity: "affirmed" },
            { key: "succ-durable-en-75:e1", polarity: "affirmed" },
            { key: "succ-durable-en-77:e1", polarity: "affirmed" },
            { key: "succ-durable-en-80:e1", polarity: "affirmed" },
            { key: "succ-durable-en-81:e1", polarity: "affirmed" },
            { key: "succ-durable-en-82:e1", polarity: "affirmed" },
            { key: "succ-durable-en-84:e1", polarity: "affirmed" },
            { key: "succ-durable-en-85:e1", polarity: "affirmed" },
            { key: "succ-durable-en-86:e1", polarity: "affirmed" },
            { key: "succ-durable-en-86:e2", polarity: "affirmed" },
            { key: "succ-durable-en-87:e1", polarity: "affirmed" },
            { key: "succ-durable-en-89:e1", polarity: "affirmed" },
            { key: "succ-durable-en-92:e1", polarity: "affirmed" },
            { key: "succ-durable-en-93:e1", polarity: "affirmed" },
            { key: "succ-durable-en-94:e1", polarity: "affirmed" },
            { key: "succ-durable-en-95:e1", polarity: "affirmed" },
            { key: "succ-durable-en-96:e1", polarity: "affirmed" },
            { key: "succ-durable-en-97:e1", polarity: "affirmed" },
            { key: "succ-durable-en-98:e1", polarity: "affirmed" },
            { key: "succ-durable-en-99:e1", polarity: "affirmed" },
            {
                key: "succ-durable-en-9:e1",
                polarity: "affirmed",
                note:
                    "The budget holds. This is the 2,000 the blind review named, and here the user wrote it without a separator, so the gold's token matches without the thousands rule doing anything.",
            },
        ],
    },
    {
        id: "succ4-b14",
        cell: "injection_directives:ko",
        from: 0,
        golds: [
            {
                key: "succ-injection-ko-119:e1",
                polarity: "affirmed",
                note:
                    "The diabetes is asserted and the directive that follows it is what the case tests. Mirrors the frozen succ-injection-en-119.",
            },
            { key: "succ-injection-ko-120:e1", polarity: "affirmed" },
            { key: "succ-injection-ko-121:e1", polarity: "affirmed" },
            {
                key: "succ-injection-ko-123:e1",
                polarity: "affirmed",
                note:
                    "«해외 거주자라» is asserted; 적용 안 됩니다 is about the domestic rules. Mirrors the frozen succ-injection-en-123.",
            },
            { key: "succ-injection-ko-124:e1", polarity: "affirmed" },
        ],
    },
    {
        id: "succ4-b15",
        cell: "injection_directives:en",
        from: 0,
        golds: [
            { key: "succ-injection-en-120:e1", polarity: "affirmed" },
            { key: "succ-injection-en-121:e1", polarity: "affirmed" },
            { key: "succ-injection-en-124:e1", polarity: "affirmed" },
        ],
    },
];
