# 발견 큐 → 레지스트리 채택 기능 독립 재검토 (Round 5)

- 검토일: 2026-09-12
- 검토 기준: `git show 4f8a98cd` 및 현재 트리 `e4e97d11`
- 기준 변동: 검토 도중 후속 커밋 `50c60a42`, `e4e97d11`이 차례로 HEAD에 들어와,
  `4f8a98cd` 자체의 결과와 최신 트리의 결과를 구분함
- 이전 검토: `codex-review-round4.md`의 P1-A5, P1-A6, P1-2 동시 중복
- 판정: **수정 후 재검토 필요**
- 요청된 세 건 결과: **현재 트리에서 P1-A5, P1-2, P1-A6 모두 해결**
- 새 발견: **P1 2건은 후속 커밋에서 해결, P2 1건은 현재 미해결** — NUL lock
  key는 `50c60a42`, runtime 유효가격 누락은 `e4e97d11`에서 해결. profile 상속이
  있어도 UI가 가격을 “직접 입력해야 할 값”으로 계속 안내함

결론부터 말하면 요청된 세 건은 최신 트리에서 모두 닫을 수 있다. transaction 안의
순서는 `pair lock → work item row lock → 재검사 → registry create → item transition`으로
바뀌어 자기 신규 행을 중복으로 읽는 원인은 없어졌다. 유효한 pair lock이라면 서로
다른 work item의 같은 pair도 직렬화한다. `4f8a98cd`에는 lock key 구분자로 실제
U+0000/NUL을 넣어 PostgreSQL `text` 파라미터가 실패하는 새 결함이 있었지만,
후속 `50c60a42`와 이를 포함한 현재 트리는 provider enum에 들어올 수 없는 `::`
구분자로 바꿨다.

가격 쪽도 server와 panel 모두 body 숫자가 profile보다 우선하고, body가 `NULL`이면
동일한 runtime 유효가격을 floor 계산에만 사용한다. DB에는 원래 `NULL`이 남으므로
`NULL = profile/schedule/env 상속`, `숫자 = 관리자 override` 의미가 유지된다.
`e4e97d11`은 profile 원본 tier를 읽던 중간 구현도 `resolveModelPricing()`으로 바꿔
현재 schedule revision, long-context tier, 환경 가격/output-cap override를 반영한다.

최신 트리에 남은 것은 P2 운영자 안내 결함 한 건이다. profile fallback이 실제로
있어 Save가 가능해졌는데도 amber unknown 목록은 “공급자 가격표에서 확인해
입력합니다”라고 말한다. 기능을 막지는 않지만, 안내를 그대로 따르면 의도하지 않은
숫자 override를 저장해 tier/schedule 상속을 평탄화한다.

## 판정 요약

| 항목 | 판정 | 핵심 근거 |
|---|---|---|
| P1-A5 transaction의 자기 신규 행 중복 판정 | **해결** | 검사가 create 앞으로 이동해 자기 행을 보지 않고, 현재 lock key도 PostgreSQL-safe함 |
| P1-2 같은 pair의 동시 채택 | **해결** | 같은 exact pair의 transaction advisory lock 뒤에서 duplicate read/create를 순서화함 |
| P1-A6 profile 가격 상속 차단 | **해결** | draft API가 runtime 유효가격을 panel에 주고, 빈 가격 field는 그 값으로 floor만 계산하면서 DB에는 `NULL` 유지 |
| 새 P1-A7 | **`4f8a98cd`에서 발견, 현재 해결** | 후속 `50c60a42`가 실제 NUL을 `::`로 교체해 lock key를 정상 text로 만듦 |
| 새 P1-A8 | **현재 해결** | 후속 `e4e97d11`이 `resolveModelPricing()`으로 runtime과 같은 tier/schedule/env 가격을 사용 |
| 새 P2-A9 | **미해결** | profile이 있어도 unknown 목록은 가격 숫자를 직접 입력하라고 해 상속을 override로 바꾸도록 유도 |

## 요청된 세 건 재검토

### P1-A5. transaction이 자기 신규 행을 중복으로 판정 — 해결

**기존 재현 입력 → 기존 잘못된 출력:** registry에 `(anthropic,
"claude-fable-5-1")`가 없고, exact 관측 pair와 유효한 가격·output cap·credit를 가진
open discovery item을 adoption POST한다 → transaction이 registry row를 먼저 만든
뒤 같은 `tx`의 pair 조회로 그 미커밋 행을 읽어 “already serves” 409를 반환하고
rollback했다.

**현재 순서:** work item adoption이면 pair advisory lock을 먼저 요청하고, item row를
`FOR UPDATE`로 잠근 뒤, 잠긴 item과 같은 transaction client로 pair 존재 여부를
재검사한다. registry create는 그 검사가 통과한 뒤에만 실행된다. 따라서 lock SQL이
정상 실행된다는 전제에서는 duplicate 조회 시점에 자기 신규 행이 없고, P1-A5의
read-own-write 원인은 제거됐다.

- transaction 검사가 create보다 앞: `app/api/admin/models/route.ts:286-327`
- pair 존재 여부를 같은 `tx`로 읽음: `app/api/admin/models/route.ts:125-146`
- 검사가 끝난 뒤 registry row 생성: `app/api/admin/models/route.ts:329-334`

**현재 출력:** 후속 `50c60a42`의 PostgreSQL-safe lock key까지 포함한 현재 트리에서는
pair가 없다는 재검사를 통과한 뒤 row를 만들고 item을 `validation_pending`으로
전환한다. 기존의 자기 행을 볼 순서가 아니므로 기대한 HTTP 201 경로가 복원됐다.

### P1-2. 서로 다른 work item의 같은 pair 동시 채택 — 해결

**기존 재현 입력 → 기존 잘못된 출력:** 서로 다른 두 open work item과 서로 다른
registry `id`가 같은 `(provider, apiModel)`을 동시에 채택한다 → 두 transaction이
서로 다른 item row만 잠그고 둘 다 pair 부재를 읽은 뒤 registry row 두 개를
commit할 수 있었다.

**현재 의도된 interleaving:** 두 요청은 registry `id`나 work item id가 아니라 exact
`(provider, apiModel)`에서 만든 같은 advisory key를 transaction 범위로 잠근다. 첫
요청이 lock 아래에서 pair 부재를 확인하고 create/commit할 때까지 둘째 요청이
기다리고, 그 뒤 둘째의 같은-transaction 조회는 첫 row를 보아 409가 된다. provider는
Zod enum이라 정규화된 소문자이고 API model은 duplicate query와 같은 exact 문자열을
사용하므로, key 범위도 검사 범위와 맞는다. item row lock보다 pair lock을 먼저 잡는
현재 한 건짜리 adoption 흐름에는 서로 반대 순서로 같은 두 lock을 잡는 경로도
발견하지 못했다.

- pair lock을 item lock과 pair 조회보다 먼저 요청: `app/api/admin/models/route.ts:286-326`
- lock 아래 같은 client의 duplicate 조회: `app/api/admin/models/route.ts:125-146`
- item별 row lock: `app/api/admin/models/route.ts:306-321`
- pair unique 제약이 없고 의도적 variant를 허용하는 schema: `prisma/schema.prisma:2136-2175`

**현재 출력:** provider는 `createModelRegistrySchema`의 enum이라 `::`를 포함할 수
없고, API model은 delimiter 뒤의 나머지 exact 문자열이다. 따라서 서로 다른 pair를
같은 연결 문자열로 만드는 경계 이동이 없고, 동일 pair의 두 요청은 같은 64-bit
advisory key를 잡는다. 첫 요청은 201로 commit하고, 기다리던 둘째 요청은 새 statement의
duplicate 조회에서 첫 row를 읽어 “already serves” 409가 된다. pair unique 제약 없이
의도적 일반-admin variant 생성을 보존하면서 adoption 경로만 직렬화한다. 이는
repository가 별도 isolation level을 설정하지 않은 PostgreSQL 기본 READ COMMITTED의
statement별 snapshot을 전제로 한 판정이다.

추가된 테스트도 이 DB 경계를 실행하지 않는다. 기존 row 여부를 boolean으로 직접
주입하는 순수 규칙 테스트만 있고, advisory SQL·명령 순서·두 transaction 경쟁을
검증하는 route/DB 테스트는 없다.

- boolean 주입 중복 테스트: `tests/model-adoption-draft.test.ts:462-469`
- 새 profile 테스트만 추가된 구간: `tests/model-adoption-draft.test.ts:618-685`

### P1-A6. profile 상속용 `NULL` 차단 — 해결

**기존 재현 입력 → 기존 잘못된 출력:** `body.id`에 code pricing profile이 있고
body의 입력·출력 가격을 `null`로 두어 상속하려 한다 → server preflight는 profile을
보지 않고 `price_unknown` 409를 반환했다. 가격 숫자를 복사하면 저장은 되지만 DB
숫자가 관리자 override가 되어 tier/schedule을 평탄화했다.

**현재 출력:** `body.id`에 code pricing profile이 있고
body의 `inputUsdPerMillionTokens`, `outputUsdPerMillionTokens`, `maxOutputTokens`가
`null`인 직접 POST preflight → runtime 유효가격과 output cap으로 floor를 계산해
credit가 충분하면 `null` refusal을 반환한다. `registryInputToData()`는 body의 세
`null`을 그대로 DB `NULL`로 만들므로 profile의 tier/schedule 상속이 유지된다.

반대로 body에 숫자가 있으면 각 `??`의 왼쪽 숫자가 profile보다 먼저 선택되고 DB에도
그 숫자가 저장된다. runtime도 DB 숫자를 profile보다 먼저 읽고
`model_registry_override`로 표시한다. **DB `NULL`/숫자의 override 의미 자체는
흐려지지 않았다.** 새 테스트도 profile 상속과 form 숫자 우선 두 경우를 고정한다.

- runtime 유효 profile 가격을 server context에 제공: `app/api/admin/models/route.ts:97-129`,
  `app/api/admin/models/route.ts:159-195`
- body 숫자 우선, profile fallback: `lib/modelAdoptionDraft.ts:541-558`
- `NULL` 또는 숫자를 그대로 저장: `lib/modelRegistryAdmin.ts:191-195`
- runtime의 DB 숫자 우선 및 costSource: `lib/modelPricing.ts:1669-1674`,
  `lib/modelPricing.ts:1712-1728`
- 상속/override 순수 테스트: `tests/model-adoption-draft.test.ts:618-685`

**기존 UI 재현 입력 → 기존 잘못된 출력:** code profile을 먼저 등록한 새 모델의
adoption draft를 열고, profile 상속을 위해 입력·출력 가격은 빈 값(`null`)으로 둔
채 요청 output cap과 판매 등급/credit 및 사유를 정한다 → server는 profile로 floor를
계산할 수 있지만 panel은 빈 form 숫자만 보아 `price_unknown`을 만들고 Save 버튼을
비활성화했다.

**현재 UI 출력:** adoption-draft API가 해당 draft id에 profile이 있으면
`resolveModelPricing()`으로 유효가격과 output cap을 보내고, panel은 form 값이
`null`일 때만 그 값을 fallback으로 사용한다. 따라서 빈 가격 field를 유지해도 floor와
Save 조건이 계산되고, 전송 body는 여전히 `null`이어서 DB 상속을 보존한다. 운영자가
숫자를 입력하면 form 값이 fallback보다 우선하므로 server와 UI 모두 그 숫자를
override 가격으로 검증한다.

- draft가 가격을 의도적으로 `null`로 생성: `lib/modelAdoptionDraft.ts:337-347`
- draft API의 runtime 유효가격 응답: `app/api/admin/model-lifecycle/adoption-draft/route.ts:121-152`
- panel의 form 우선/profile fallback: `components/admin/AdminModelRegistryPanel.tsx:313-338`
- profile floor가 없을 때만 Save 차단: `components/admin/AdminModelRegistryPanel.tsx:795`

따라서 P1-A6의 server 및 실제 관리자 workflow 차단은 모두 해결됐다. 다만 profile이
있을 때도 가격 입력을 요구하는 기존 unknown 문구가 남은 문제는 아래 P2-A9로
분리한다.

## 새로 생긴 결함

### P1-A7. advisory-lock key의 실제 NUL 때문에 모든 work-item adoption이 500 — 현재 해결

`4f8a98cd`는 pair 경계를 모호하지 않게 하려고 provider와 API model 사이에 실제
U+0000을 넣었다. 해당 commit의 `app/api/admin/models/route.ts`에는 byte offset
11,769에 NUL 바이트가 1개 있으며, 당시 line 282의 template parameter가 runtime에서도
`"provider\u0000apiModel"`이 된다. PostgreSQL 문자열과 `text` 값은 NUL을 허용하지
않으므로 `hashtextextended(text, bigint)`에 도달하기 전에 그 파라미터를 받을 수 없다.

**재현 입력 → 잘못된 출력:** 존재하는 open discovery item에 exact 관측 pair,
유효한 disabled/unlisted body, 충분한 credit와 사유를 넣어
`POST /api/admin/models?workItemId=...`를 `4f8a98cd`에서 호출한다 → 기대 출력은
pair lock 획득 후 registry row/item transition commit과 HTTP 201이다. 당시에는 transaction의 첫
`$executeRaw`가 NUL text 파라미터로 DB 오류를 내고, 오류가 `AdoptionRefused`나
`P2002`가 아니므로 generic `Failed to create model.` HTTP 500으로 끝난다. registry와
work item은 바뀌지 않지만 transaction 밖에 먼저 기록한 `model.registry.create_started`
audit는 남는다.

- 실제 NUL이 든 당시 lock parameter: `4f8a98cd:app/api/admin/models/route.ts:281-283`
- create-started audit가 transaction보다 먼저 기록됨: `4f8a98cd:app/api/admin/models/route.ts:257-267`
- 당시 DB 오류가 generic 500으로 매핑됨: `4f8a98cd:app/api/admin/models/route.ts:384-396`

typecheck와 ESLint는 이 제어문자를 잡지 않았고, `4f8a98cd`의 파일을 기본 `rg`로
읽으면 binary로 분류됐다. 후속 `50c60a42`는 이를
`${body.provider}::${body.apiModel}`로 바꿨고, 최신 파일의 NUL byte count는 0이다.
현재 provider enum 값에는 `:`가 없으므로 pair boundary도 모호해지지 않는다.

- 현재 PostgreSQL-safe lock parameter: `app/api/admin/models/route.ts:300-305`
- provider enum: `lib/modelRegistryShared.ts:9-22`

### P1-A8. profile fallback floor가 runtime 환경 가격 override를 무시함 — 현재 해결

runtime 가격 우선순위는 `DB/admin override → 환경 override → 적용 중인 profile
revision/tier → class fallback`이다. `4f8a98cd`의 adoption context는
`getModelPricingProfile()`의 원본 `profile.tiers`와 `profile.maxOutputTokens`만 읽었다.
따라서 DB 가격을 `NULL`로 상속시키는 새 경로에서 실제 요청에 적용될 환경 가격
override와 `priceSchedule`의 현재 revision을 floor가 보지 못했다.

**`4f8a98cd` 재현 입력 → 잘못된 출력:** 현재 `claude-haiku-4-5` profile의 US$1/US$5,
64,000 output cap을 profile fallback으로 주고, 지원되는 환경 override
`CHAT_MODEL_CLAUDE_HAIKU_4_5_INPUT_USD_PER_MILLION=100`과
`CHAT_MODEL_CLAUDE_HAIKU_4_5_OUTPUT_USD_PER_MILLION=100`을 둔다. body 가격/output
cap은 `null`, `creditWeight=4`, 입력 상한은 128,000, Anthropic input multiplier는
1.25로 preflight한다 → `adoptionPreflightRefusal()`은 profile 원가로 최악 비용
480,000 microUSD와 4 credits를 계산해 **`null`(승인)**을 반환한다. 같은 row를
`resolveModelPricing()`에 넣으면 US$100/US$100과
`costSource="registry_env_override"`가 나온다. 실제 같은 turn은 22,400,000
microUSD여서 어떤 adoption class도 덮지 못하며 기대 출력은
`above_every_class` 409다.

**현재 출력:** 후속 `e4e97d11`은 profile 존재만 확인한 뒤
`resolveModelPricing({ estimatedPromptTokens: worstCaseInputTokens })`를 호출한다. 위
환경에서 profile fallback은 US$100/US$100과 env max-output override까지 읽고,
현재 schedule revision 및 worst-input long-context tier도 runtime과 동일하게 고른다.
body 숫자는 이후 `adoptionPreflightRefusal()`의 왼쪽 `??` 값으로 계속 우선하므로 DB
관리자 override 의미도 바뀌지 않는다. 위 입력은 이제 `above_every_class` 409다.

- 당시 원본 profile tier만 선택: `4f8a98cd:app/api/admin/models/route.ts:148-170`
- 현재 runtime 유효가격 helper: `app/api/admin/models/route.ts:97-129`
- 현재 context가 helper 결과를 사용: `app/api/admin/models/route.ts:159-195`
- 환경 override key와 parser: `lib/modelPricing.ts:1544-1555`
- runtime의 current revision 선택과 env 우선: `lib/modelPricing.ts:1646-1674`
- runtime이 env source를 별도로 표시: `lib/modelPricing.ts:1716-1728`

현재 유일한 `priceSchedule`은 같은 가격을 다른 provenance로 재확정한 Sonnet 5
revision이라 오늘 금액 차이는 없지만, helper가 runtime resolver를 사용하므로 향후
실제 가격 변경 revision도 별도 route 수정 없이 같은 시점 규칙을 따른다.

### P2-A9. profile 상속이 있어도 unknown 목록이 가격 숫자 입력을 요구함

기능은 profile fallback으로 Save를 허용하지만, draft의 `unknowns`는 profile 존재
여부와 무관하게 “입력·출력 단가 — 공급자 공식 가격표에서 확인해 입력합니다”를
넣는다. panel은 이 목록을 “아직 사람이 정해야 하는 값” 아래 그대로 보여 주고,
profile 가격을 사용 중이라는 표시는 하지 않는다.

**재현 입력 → 잘못된 출력:** code pricing profile이 있는 새 model id로 adoption
draft를 연다 → floor는 inherited runtime 가격으로 정상 표시되고 빈 가격 field로
저장할 수 있지만, 같은 화면의 필수 unknown 목록은 운영자에게 입력·출력 가격을
직접 입력하라고 말한다. 운영자가 지시대로 profile 숫자를 복사하면 body 숫자가
fallback보다 우선하고 DB에도 숫자가 저장되어 `costSource="model_registry_override"`가
되며 long-context tier와 향후 schedule이 평탄화된다. 기대 출력은 profile 상속이
확인됐음을 명시하고 가격을 unknown/직접 입력 대상으로 나열하지 않는 것이다.

같은 화면은 “long-context price tiers ... are not in this figure”라고도 계속 말하지만,
inherited profile 경로의 `profilePrice`는 worst accepted input 크기로 tier를 이미
선택한다. 즉 계산은 고쳐졌으나 그 계산의 출처와 포함 범위를 설명하는 문구가 둘 다
옛 동작을 가리킨다.

- profile 여부와 무관한 가격 unknown: `lib/modelAdoptionDraft.ts:317-325`
- unknown을 “아직 사람이 정해야 하는 값”으로 표시: `components/admin/AdminModelRegistryPanel.tsx:669-678`
- 빈 값은 profile을 상속하지만 입력 숫자는 우선: `components/admin/AdminModelRegistryPanel.tsx:313-320`
- 포함한 long-context tier를 제외했다고 안내: `components/admin/AdminModelRegistryPanel.tsx:706-711`
- 숫자를 DB override로 저장: `lib/modelRegistryAdmin.ts:191-195`

## 검증과 한계

- `git show 4f8a98cd`, 후속 `git show 50c60a42`, `git show e4e97d11`과 현재 트리의
  route, draft rule, admin panel, registry 변환, runtime pricing, schema와 관련
  테스트를 읽음
- `git diff 4f8a98cd^ 4f8a98cd --check` — 통과
- `npm run typecheck` — 통과
- 관련 6개 파일 ESLint — 통과
- `npm run check:model-pricing` — 통과: explicit profile 36, fallback/unpriced/register
  warning 0
- `tests/model-adoption-draft.test.ts` +
  `tests/modelRegistryPricingInheritance.test.ts` — 52/52 통과
- `tests/modelPricing.test.mjs`까지 포함한 최신 관련 묶음 — 79/79 통과. 최초
  `4f8a98cd` 실행에서는 입력 상한 literal을 옛 `lib/chatSecurity.ts`에서 찾는 기존
  test debt 때문에 78/79였고, 후속 `50c60a42`가 probe를 실제 소유 모듈
  `lib/chatInputLimits.ts`로 옮긴 뒤 green이 됨
- `DATABASE_URL`과 `DIRECT_URL`이 없어 실제 route/두 PostgreSQL transaction 경쟁은
  실행하지 않았다. P1-A7은 `4f8a98cd` source byte를 직접 검사해 NUL 1개와 offset을
  확인했고, 현재 트리에서는 NUL 0개를 확인했다. P1-A8은 현재 모듈을 환경 override와
  함께 실행해 잘못된 480,000 microUSD 승인과 runtime 100/100 불일치를 재현했다.
  `e4e97d11` 방식대로 resolver 결과를 preflight에 합성한 최신 재실행은 같은 입력에
  US$22.400 `above_every_class` 409를 반환했다. route helper 자체의 회귀 테스트는
  아직 없다.

현재 추가 테스트는 server 순수 규칙 세 건만 다룬다. 이 변경의 위험 경계인 실제
advisory SQL, `lock → read → create` 순서, 두 connection 경쟁, 그리고 profile 상속
draft의 UI Save/안내 조건을 실행하는 회귀 테스트가 없어 `4f8a98cd`의 P1-A7/P1-A8과
현재 남은 P2-A9를 검출하지 못했다.
