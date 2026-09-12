# 발견 큐 → 레지스트리 채택 기능 독립 재검토 (Round 4)

- 검토일: 2026-09-12
- 검토 기준: `git show fe2a1997` 및 커밋 `fe2a1997`의 현재 트리
- 이전 검토: `codex-review-round3.md`의 부분 해결 3건과 추가 발견 P1-A4
- 판정: **수정 후 재검토 필요**
- 요청된 4건 결과: **해결 2건, 부분 해결 2건**
- 새 발견: **P1 2건** — 모든 신규 채택의 자기 중복 판정, 가격 profile 상속 경로 차단

`fe2a1997`은 관측된 `(provider, apiModel)` pair를 끝까지 보존하고, chat runtime과
채택 경로가 한 입력 상한 parser를 쓰게 하며, `above_every_class`를 fail-closed로
바꾸고, validation writer를 lock-before-read로 직렬화했다. 따라서 P2-1과
P1-A4는 닫혔다.

그러나 pair 중복 조회를 transaction client로 옮기면서 조회보다 registry row를
먼저 만들었다. transaction은 자기 write를 읽으므로 정상 채택도 방금 만든 행을
기존 pair로 찾아 항상 rollback한다. 이 순서를 고쳐도 서로 다른 work item을 통한
동일 pair의 동시 채택을 직렬화하는 잠금은 없다. 또한 credit floor는 안전한 숫자
하한만 강제할 뿐 `creditWeight`를 사람이 정했다는 사실을 강제하지 않으며,
가격을 계산할 수 없을 때의 새 일괄 거부는 DB의 `NULL` 가격 상속 계약을 막는다.

## 판정 요약

| 항목 | 판정 | 핵심 근거 |
|---|---|---|
| P1-2 관측 provider/API pair | **부분 해결** | exact pair 대조는 해결; 동시 중복 직렬화는 없고, transaction 내부 조회가 자기 신규 행을 중복으로 읽는 P1-A5를 추가 |
| P1-4 usageClass/creditWeight | **부분 해결** | 계산 불가·하한 미달 저장은 막음; `creditWeight` 명시 선택과 서버 검증 가능한 결정 증거는 여전히 없음 |
| P2-1 가변 입력 상한 | **해결** | runtime·GET·POST가 같은 parser를 사용하고 `above_every_class`도 client/server 양쪽에서 차단 |
| P1-A4 validation writer lost update | **해결** | item row를 `FOR UPDATE`로 잠근 뒤 pending 목록을 읽고 갱신 |

## 기존 4건 재검토

### P1-2. work item의 관측 `(provider, apiModel)` pair — 부분 해결

**기존 재현 입력 → 기존 잘못된 출력:** evidence가
`[(anthropic, "claude-fable-5-1"),
(qwen, "ANTHROPIC/CLAUDE-FABLE-5-1")]`일 때
`provider="qwen", apiModel="claude-fable-5-1"`을 채택한다 → Qwen이 반환한 적 없는
직교 조합인데도 preflight가 `null`을 반환하고 registry row 생성을 허용했다.

**현재 출력:** `observedPairsOf()`가 evidence에서 exact pair를 추출하고,
`adoptionPreflightRefusal()`이 provider는 case-insensitive, API model은 upstream에
보낼 literal 그대로 비교한다. 위 입력은 409이고, Qwen이 실제로 반환한
`(qwen, "ANTHROPIC/CLAUDE-FABLE-5-1")`만 허용된다. 이 부분은 해결됐다.

- evidence에서 exact pair를 보존: `app/api/admin/models/route.ts:70-90`
- 두 필드를 한 pair로 대조: `lib/modelAdoptionDraft.ts:457-475`
- 직교 조합 회귀 테스트: `tests/model-adoption-draft.test.ts:356-370`

하지만 Round 3의 두 번째 절반인 동시 중복은 닫히지 않았다. 같은 `tx`로 조회하는
것은 read와 create의 atomicity를 보장하지 않는다. 같은 pair를 채택하는 두 요청이
서로 다른 work item row를 잠그므로 두 transaction을 직렬화할 공통 lock이 없다.
현재 코드에서는 아래 P1-A5가 모든 채택을 먼저 막아 이 race가 가려질 뿐이다.

**현재 재현 입력 → 잘못된 출력:** P1-A5의 자기 조회 순서만 단순히
“pair 조회 후 create”로 옮긴 상태를 전제로, 서로 다른 두 open work item과 서로
다른 registry `id`가 같은 `(provider, apiModel)`을 동시에 채택한다 → 두 transaction이
각자 pair 없음과 서로 다른 item lock을 확인한 뒤 두 registry row를 모두 commit할
수 있다. pair 단위 advisory lock도 DB 제약도 없으므로 `tx` 사용만으로는 이 결과가
바뀌지 않는다.

- pair 존재 여부를 읽기만 하고 잠그지 않는 조회: `app/api/admin/models/route.ts:122-143`
- 서로 다른 item이면 공유되지 않는 row lock: `app/api/admin/models/route.ts:259-274`
- pair 제약이 없는 registry schema: `prisma/schema.prisma:2136-2175`
- DB/route 경쟁을 실행하지 않고 boolean을 주입하는 테스트: `tests/model-adoption-draft.test.ts:461-469`

bare `(provider, apiModel)` unique 제약을 채택하지 않은 판단은 맞다. 자세한 근거와
대안은 아래 “DB unique 제약 판단”에 적었다.

### P1-4. `usageClass`/`creditWeight`의 미정 기본값 — 부분 해결

**기존 재현 입력 → 기존 잘못된 출력:** adoption form에서 판매 등급과 크레딧을
정하지 않고 저장한다 → 일반 create form의 기본값
`usageClass="standard", creditWeight=1`이 사람의 가격 결정인 것처럼 저장됐다.

이번 수정은 가격이나 output cap이 없으면 server가 409를 반환하고, 어떤 class도
최악 비용을 덮지 못하는 `above_every_class`도 거부하며, 계산된 floor보다 낮은
`creditWeight`를 client와 server가 모두 막는다. “계산할 수 없는 floor가 1-credit
기본값을 통과시킨다”는 Round 3 재현은 해결됐다.

그러나 floor는 안전 하한이지 “운영자가 이 값을 선택했다”는 증거가 아니다.
UI는 여전히 `usageClass`의 `change`만 `adoptClassChosen`으로 기록하고
`creditWeight` 선택 여부는 기록하지 않는다. 서버 body에도 그 결정을 증명하는
field가 없고, 서버는 숫자가 floor 이상인지만 본다.

**현재 재현 입력 → 잘못된 출력:** floor가 standard/1인 저가 모델
(`input=0.1`, `output=0.4`, `maxOutputTokens=4096`)의 draft를 열고,
`Internal usage class`만 `advanced`로 바꾼 뒤 `Base credit weight`의 기본값 1은
건드리지 않고 사유를 입력한다 → `adoptClassChosen=true`, `1 >= floor.credits`가 되어
Save가 활성화되고 순수 server preflight도 `null`을 반환한다. 즉 사람이
`creditWeight`를 선택하지 않았는데도 `advanced`/1을 유효한 결정으로 본다.
현재 실제 route에서는 P1-A5가 뒤에서 모든 채택을 rollback하므로 DB write만
우연히 가려져 있으며, P1-A5의 순서를 바로잡으면 이 미정 기본값이 다시 저장된다.

`standard`를 의도적으로 선택하는 UX 문제도 남았다. select는 처음부터 standard를
선택한 상태여서 같은 option을 다시 선택하면 일반적인 브라우저에서 `change`가
발생하지 않는다. 다른 class로 갔다가 돌아오지 않으면 의도적인 standard 선택을
표현할 수 없다.

- 일반 form의 기본값: `components/admin/AdminModelRegistryPanel.tsx:88-97`
- `usageClass` 하나만 추적하는 state: `components/admin/AdminModelRegistryPanel.tsx:185-192`
- draft가 선택 여부를 false로 초기화: `components/admin/AdminModelRegistryPanel.tsx:248-253`
- class만 선택으로 기록하고 weight는 기록하지 않는 controls: `components/admin/AdminModelRegistryPanel.tsx:731-733`
- floor 숫자만 보는 Save 조건: `components/admin/AdminModelRegistryPanel.tsx:776-778`
- server도 `creditWeight >= floor.credits`만 검사: `lib/modelAdoptionDraft.ts:524-557`
- 두 값을 그대로 DB에 쓰는 변환: `lib/modelRegistryAdmin.ts:173-175`

이 항목을 닫으려면 두 결정을 placeholder/nullable adoption input으로 분리해 각각
명시 선택을 요구하거나, 별도 adoption schema가 “사람이 정한 class와 weight”를
서버가 검증할 수 있게 해야 한다. floor에서 자동으로 값을 채운다면 그것은
`derived`라고 명시하고 사람의 결정이라고 표시하지 않아야 한다.

### P2-1. 가변 입력 상한을 반영한 credit floor — 해결

**기존 재현 입력 → 기존 잘못된 출력:**
`CHAT_USER_MAX_INPUT_TOKENS=1e6`, Anthropic US$5/US$25, output cap 8,192 → runtime은
1,000,000 token을 허용하지만 adoption route는 `parseInt`로 1 token이라 읽어
실제 최악 비용보다 매우 낮은 floor를 통과시켰다. 또는 상한 400,000에서
`suggestCreditFloor()`가 `above_every_class`를 반환해도 POST는 1-credit 저장을
허용했다.

**현재 출력:** `chatUserMaxInputTokens()`가 기존 runtime과 같은 `Number` +
`Number.isSafeInteger` 규칙을 한 곳에 두었다. runtime, draft GET, 최종 POST가 모두
그 helper를 호출하므로 `1e6`은 세 경로 모두 1,000,000이다. 계산 결과가
`above_every_class`이면 Save가 비활성화되고 직접 POST도 409를 반환한다.

- 공유 parser: `lib/chatInputLimits.ts:14-23`
- runtime 사용: `lib/chatSecurity.ts:853-857`
- draft GET 사용: `app/api/admin/model-lifecycle/adoption-draft/route.ts:119-128`
- final POST context 사용: `app/api/admin/models/route.ts:145-154`
- server의 계산 불가·상한 초과 거부: `lib/modelAdoptionDraft.ts:524-549`
- client의 floor 존재 조건: `components/admin/AdminModelRegistryPanel.tsx:776-778`
- `1e6` 및 invalid fallback 회귀 테스트: `tests/model-adoption-draft.test.ts:602-615`

### P1-A4. 동시 validation 완료의 lost update — 해결

**기존 재현 입력 → 기존 잘못된 출력:** pending이
`["pricing","access","staging"]`일 때 두 transaction이 동시에 각각 pricing과
access를 완료한다 → 둘 다 같은 초기 snapshot에서 remainder를 계산해 마지막
UPDATE가 먼저 완료된 validation을 다시 pending으로 복구했고, 성공 event 두 개와
현재 gate가 모순됐다.

**현재 출력:** transaction이 item을 `SELECT ... FOR UPDATE`로 먼저 잠근다. 두 번째
요청은 첫 번째 commit을 기다린 뒤 갱신된 pending 목록을 읽으므로, 순서와 무관하게
최종 pending은 `["staging"]`이고 각 event가 제거한 값과 현재 상태가 일치한다.

- lock-before-read: `app/api/admin/model-lifecycle/validations/route.ts:66-84`
- lock 아래의 UPDATE와 event append: `app/api/admin/model-lifecycle/validations/route.ts:93-111`
- remainder 순수 계산: `lib/modelAdoptionDraft.ts:568-578`

실제 PostgreSQL 동시 요청 재현은 DB 자격증명이 없어 실행하지 않았지만, 같은 row의
`FOR UPDATE`를 snapshot read보다 먼저 잡으므로 Round 3의 lost-update interleaving은
구조적으로 제거됐다.

## 새로 생긴 결함

### P1-A5. 정상 신규 채택이 transaction 안에서 자기 행을 중복으로 찾아 항상 409됨

pair 조회를 transaction client로 옮긴 변경은 조회 순서를 고려하지 않았다.
transaction은 자기 transaction이 쓴 미커밋 row를 읽는다. 그런데 registry row를
먼저 create하고, 그 뒤 work item을 잠그고, 마지막에 같은 `tx`로
`findFirst({ provider, apiModel, catalogDeleted: false })`를 실행한다. 쿼리에는 방금
만든 `id`를 제외하는 조건도 없다.

**재현 입력 → 잘못된 출력:** registry에 해당 pair가 전혀 없는 정상 discovered
work item에 exact 관측 pair, `coming-soon`, unlisted, 유효한 가격·output cap과
floor 이상의 credit를 담아 adoption POST한다 → transaction 밖 preflight는 통과하고
새 row도 잠시 생성되지만, transaction 안의 pair 조회가 바로 그 신규 row를 찾아
`providerPairRegistered=true`를 만든다. preflight가 “The registry already serves …”
409를 던지고 transaction 전체가 rollback된다. 기대 출력은 registry row 생성,
work item의 `validation_pending` 전환과 201이다. 따라서 현재 트리에서는 어떤 정상
신규 adoption도 완료될 수 없다. transaction 밖의 `create_started` audit만 남는다.

- transaction 안에서 검증보다 먼저 row 생성: `app/api/admin/models/route.ts:246-253`
- 새 row를 제외하지 않는 같은-transaction pair 조회: `app/api/admin/models/route.ts:122-143`
- create 뒤에 수행되는 재검사: `app/api/admin/models/route.ts:255-279`
- 자기 pair를 409로 바꾸는 조건: `lib/modelAdoptionDraft.ts:476-480`
- rollback을 409로 반환: `app/api/admin/models/route.ts:344-350`
- route 순서를 실행하지 않고 `providerPairRegistered`를 수동 주입하는 테스트: `tests/model-adoption-draft.test.ts:461-469`

수정 순서는 pair 단위 공통 lock → 기존 active pair 조회 → registry create → item
transition이어야 한다. 신규 `id` 제외만 추가하면 자기 충돌은 사라지지만 Round 3의
동시 중복 race는 그대로다.

### P1-A6. 채택이 가격 profile 상속용 `NULL`을 거부해 관리자 override를 강제함

이 저장소에서 registry의 가격 숫자는 단순 snapshot이 아니다. 세 가격 컬럼의
`NULL`은 `lib/modelPricing.ts`의 versioned/tiered profile 상속이고, 숫자는
`model_registry_override`이며 tier와 향후 schedule을 평탄화한다. adoption draft도
바로 이 이유로 가격 field를 `null`로 둔다.

이번 수정은 body의 두 가격이 `null`이면 code profile의 유효 가격을 해석하지 않고
무조건 `price_unknown` 409를 반환한다. 따라서 profile을 먼저 추가하고 registry
row는 정상적인 `NULL` 상속으로 만들 수 없으며, 운영자가 현재 숫자를 form에
복사해야만 다음 경계로 갈 수 있다. 복사한 숫자는 “상속”이 아니라 영구적인 관리자
override로 저장되어 long-context tier와 `priceSchedule`을 가린다.

**재현 입력 → 잘못된 출력:** 새 model id에 검증된 code pricing profile과 future
`priceSchedule`을 등록한 뒤, adoption body의
`inputUsdPerMillionTokens=null`, `outputUsdPerMillionTokens=null`로 profile 상속을
요청하고 output cap·class·credit는 유효하게 넣는다 → `adoptionPreflightRefusal()`은
profile을 보지 않고 “needs the provider's input and output prices” 409를 반환한다.
운영자가 현재 base rate 숫자를 복사하면 저장값은 `NULL`이 아닌 숫자가 되어 향후
요청의 `costSource`가 `model_registry_override`가 되고 tier/schedule 가격이 적용되지
않는다.

- draft가 가격 `NULL`의 상속 의미를 명시: `lib/modelAdoptionDraft.ts:206-215`
- draft의 가격 field는 의도적으로 null: `lib/modelAdoptionDraft.ts:336-355`
- raw body 가격만 보고 profile 없이 거부: `lib/modelAdoptionDraft.ts:524-549`
- null 또는 숫자를 그대로 DB에 쓰는 변환: `lib/modelRegistryAdmin.ts:191-195`
- runtime 가격 우선순위와 profile tier 선택: `lib/modelPricing.ts:1621-1655`
- DB 숫자가 profile보다 우선: `lib/modelPricing.ts:1669-1674`
- 숫자를 `model_registry_override`로 분류: `lib/modelPricing.ts:1712-1728`
- 정책의 `NULL` 상속/숫자 override 계약: `docs/policy/credit-and-cost-limits.md:254-267`

floor는 raw form 가격이 아니라 “이 row가 저장된 뒤 runtime이 적용할 유효 가격”으로
계산해야 한다. profile 상속이면 tier별 최악 가격과 적용 중인 schedule revision을
사용하면서 DB 가격은 null로 유지해야 한다.

## `(provider, apiModel)` DB unique 제약 판단

제약 제안을 채택하지 않은 판단은 **맞다**.

`lib/models.ts`에는 아래 두 active registry identity가 의도적으로 같은 provider/API
pair를 공유한다.

- `gpt-5-5`: `openai` / `gpt-5.5` — `lib/models.ts:196`
- `gpt-5-5-thinking`: `openai` / `gpt-5.5` — `lib/models.ts:197`

두 row는 Tomverse의 서로 다른 product variant이고 reasoning/credit 설정이 다르다.
`ModelRegistryEntry`에 bare `@@unique([provider, apiModel])`를 추가하면 기존 데이터가
있는 migration은 실패하고, 새 seed에서는 둘 중 하나를 거부하거나
`skipDuplicates`로 조용히 누락시킨다. `catalogDeleted=false` partial unique도 두
row가 모두 active이므로 같은 문제가 난다. registry identity는 `id`이고 provider/API
pair는 일반적으로 unique가 아니다 (`prisma/schema.prisma:2136-2175`).

다만 이것은 adoption 경로의 “이미 서비스 중인 pair를 discovery로 또 만들지
않는다”는 규칙을 애플리케이션 선조회만으로 충분히 지켜도 된다는 뜻은 아니다.
그 규칙은 경로 한정 규칙이므로, transaction-scoped advisory lock을 exact pair key로
잡은 뒤 기존 row 조회와 create를 같은 transaction에서 순서대로 수행하는 것이
현재 schema와 맞는다. 일반 admin copy 경로의 의도적인 variant 생성은 그 lock/거부
규칙의 대상이 아니어야 한다.

참고로 관측 원장인 `ProviderModelCatalogEntry`에는 실제 관측 identity에 맞는
`@@unique([provider, apiModel])`가 이미 있다 (`prisma/schema.prisma:2180-2199`).
관측 pair와 product registry row의 cardinality가 다르므로 두 테이블에 같은 제약을
복사하면 안 된다.

## 검증과 한계

- `git show fe2a1997`과 현재 트리의 변경 route, pure rule, registry 변환, runtime
  가격·입력 상한, schema, UI와 관련 테스트를 읽음
- `git diff fe2a1997^ fe2a1997 --check` — 통과
- `npm run typecheck` — 통과
- `npm run lint -- <변경된 TS/TSX 8개>` — 통과
- `node --conditions=react-server --import tsx --test --test-reporter=spec tests/model-adoption-draft.test.ts tests/model-lifecycle-work-item-core.test.ts`
  — 80/80 통과

테스트 통과는 P1-A5를 반증하지 않는다. 현재 adoption 테스트는 pure
`adoptionPreflightRefusal()`에 `providerPairRegistered`를 직접 넣고, 실제 route의
`create → findFirst` 순서를 실행하지 않는다. `DATABASE_URL`과 `DIRECT_URL`이 모두
설정되지 않아 PostgreSQL route 통합·동시성 재현은 실행하지 않았다. P1-A5는 같은
transaction의 read-own-write와 현재 명령 순서로, P1-2의 남은 race는 pair 공통
lock/제약 부재로 판정했다.
