# 발견 큐 → 레지스트리 채택 기능 독립 재검토 (Round 3)

- 검토일: 2026-09-12
- 검토 기준: `git show 7c7e3137` 및 커밋 `7c7e3137`의 현재 트리
- 이전 검토: `codex-review-round2.md`의 부분 해결 3건과 추가 발견 3건
- 판정: **수정 후 재검토 필요**
- 6건 결과: **완전 해결 3건, 부분 해결 3건**
- 추가 발견: **P1 1건** — 새 validation writer의 lost update

`7c7e3137`은 enabled/public 출생과 rollout 이후 stale 채택을 서버의 트랜잭션
내 재검사로 막고, pending validation을 실제로 지울 수 있는 기록형 writer를
추가했다. 이 세 건은 닫혔다. 그러나 provider와 API model의 관측 pair를 두 개의
독립 집합 조건으로 분해했고, `usageClass`만 선택 여부를 추적하면서
`creditWeight` 기본값은 그대로 두었으며, 가변 입력 상한은 런타임과 다른 파서와
`above_every_class` fail-open을 도입했다. 따라서 나머지 세 건은 아직 닫히지
않았다.

## 판정 요약

| 항목 | 판정 | 핵심 근거 |
|---|---|---|
| P1-2 provider 정체성 | 부분 해결 | 단일 mismatch와 순차 중복은 막지만, 관측 pair의 직교 조합과 동시 중복은 허용 |
| P1-4 usageClass/creditWeight 기본값 | 부분 해결 | `usageClass` UI 변경만 추적하고 `creditWeight=1` 및 직접 POST는 그대로 허용 |
| P2-1 가변 입력 상한 | 부분 해결 | 200K 정수 문자열은 반영하지만 런타임과 파서가 다르고 `above_every_class`를 저장 허용 |
| P1-A1 enabled/public 즉시 출생 | 해결 | 최종 POST를 트랜잭션 안에서 재검사하여 enabled/limited/listed를 409로 거부 |
| P1-A2 pendingValidations writer 부재 | 해결 | 기록과 actor가 남는 POST writer 및 UI control 추가; 순차 happy path가 rollout 가능 상태에 도달 |
| P1-A3 rollout 이후 stale 채택 | 해결 | 빈 transition path를 거부하며 잠금 뒤 현재 상태로 다시 검사 |

## 기존 6건 재검토

### P1-2. work item과 provider/API pair 정체성 — 부분 해결

**기존 재현 입력 → 기존 잘못된 출력:** Anthropic work item에
`provider="openai", apiModel="claude-fable-5-1"`을 보내거나, 레지스트리가 이미
서비스하는 `(provider, apiModel)`을 다른 `id`로 다시 채택한다 → 관측되지 않은
provider 행 또는 중복 행이 생성됐다.

**현재의 직접 mismatch 결과:** work item의 `provider`와 `evidence`를 읽고,
`observedProviders`에 없는 body provider를 409로 거부한다. 이미 존재하는 active
pair도 사전 조회에서 409가 된다. 이 두 순차 재현은 고쳐졌다.

그러나 구현은 관측의 `(provider, apiModel)` pair를 보존하지 않는다.
`observedVia`에서 provider 문자열만 뽑고, body API model은 work item family와,
body provider는 provider 집합과 따로 비교한다. 따라서 실제 관측 pair들의 직교
조합이 모두 허용된다.

**현재 재현 입력 → 잘못된 출력:** evidence가
`[(anthropic, "claude-fable-5-1"), (qwen, "ANTHROPIC/CLAUDE-FABLE-5-1")]`이고
work item이 첫 pair를 대표할 때,
`provider="qwen", apiModel="claude-fable-5-1"`을 보낸다 → Qwen은 그 정확한 API
ID를 반환한 적이 없지만 `adoptionPreflightRefusal()`은 `null`이고, Qwen
configuration에 Anthropic 쪽 문자열을 붙인 registry row가 생성된다. 순수 함수
재현에서도 `null`을 확인했다. 테스트 역시 API ID를 포함한 관측 pair 대신
`observedProviders: ["anthropic", "qwen"]`만 넘겨 이 잘못된 직교 조합을 정상으로
고정한다.

동시 중복도 남아 있다. pair 조회는 트랜잭션 client가 아닌 전역 `prisma`로
수행되고, `ModelRegistryEntry`에는 pair unique 제약이 없다.

**동시 재현 입력 → 잘못된 출력:** 서로 다른 두 open work item과 서로 다른 새
registry `id`가 같은 body `(provider, apiModel)`을 채택하고, 두 POST가 모두 기존
pair 조회를 상대 transaction의 commit 전에 수행한다 → 두 조회가 모두 false를
얻고 두 행이 모두 commit될 수 있다. work item의 `FOR UPDATE`는 서로 다른 item만
잠그므로 pair 중복을 직렬화하지 않는다.

- exact 관측 pair에서 API ID를 버리는 변환: `app/api/admin/models/route.ts:58-75`
- 전역 client로 수행하는 비잠금 pair 조회: `app/api/admin/models/route.ts:85-123`
- family와 provider를 독립 비교: `lib/modelAdoptionDraft.ts:442-474`
- pair unique가 없는 registry schema: `prisma/schema.prisma:2136-2175`
- work item 하나만 잠그는 transaction: `app/api/admin/models/route.ts:226-258`
- pair 정보를 제거한 현재 테스트: `tests/model-adoption-draft.test.ts:399-430`

이 항목을 닫으려면 `observedVia`의 정확한 pair 중 하나와 body pair를 대조해야
한다. 중복 불변조건은 애플리케이션 선조회만이 아니라 DB unique 제약 또는 같은
효과의 직렬화로 보호해야 한다.

### P1-4. usageClass/creditWeight의 미정 기본값 — 부분 해결

**기존 재현 입력 → 기존 잘못된 출력:** adoption draft가 두 필드를 미정이라고
표시하지만 운영자가 건드리지 않고 저장한다 → 일반 폼 기본값
`usageClass="standard", creditWeight=1`이 실제 판매·entitlement 결정으로
저장됐다.

이번 수정은 adoption form에서 usage-class `<select>`의 `onChange`가 일어나야
Save 버튼을 활성화한다. 그러나 `creditWeight`를 선택했는지는 전혀 추적하지
않으며, server request에는 “사람이 선택했다”는 증거도 없다.

**현재 재현 입력 → 잘못된 출력:** draft를 연 뒤 `Internal usage class`만
`advanced`로 바꾸고 `Base credit weight`는 건드리지 않은 채 사유를 입력해
저장한다 → `adoptClassChosen=true`가 되어 Save가 활성화되고, 가격과 output cap이
null이므로 server floor는 `price_unknown`/`output_cap_unknown`이 되어 거부하지
않는다. DB에는 사람이 선택하지 않은 `creditWeight=1`이
`usageClass="advanced"`와 함께 저장된다. 같은 body를 UI 없이 직접 POST하면
`usageClass="standard", creditWeight=1`도 그대로 통과한다. 순수 preflight
재현에서 두 경우 모두 refusal `null`을 확인했다.

또한 `<select>`는 placeholder 없이 처음부터 `standard`를 선택한 상태다.
`standard`를 의도적으로 선택하려는 운영자는 같은 option을 다시 눌러도 일반적인
브라우저의 `change` event가 발생하지 않으므로, 다른 class로 바꿨다가 되돌려야
Save가 열린다.

- 일반 폼의 두 기본값: `components/admin/AdminModelRegistryPanel.tsx:88-99`
- `usageClass` 하나만 의미하는 선택 state: `components/admin/AdminModelRegistryPanel.tsx:185-193`
- draft overlay와 선택 state reset: `components/admin/AdminModelRegistryPanel.tsx:248-253`
- class 변경만 선택으로 처리하고 weight는 추적하지 않는 control: `components/admin/AdminModelRegistryPanel.tsx:731-733`
- Save의 client-only 조건: `components/admin/AdminModelRegistryPanel.tsx:776-778`
- 가격을 계산할 수 없거나 모든 class를 넘으면 거부하지 않는 server 경계: `lib/modelAdoptionDraft.ts:517-530`
- 두 값을 그대로 DB에 쓰는 변환: `lib/modelRegistryAdmin.ts:173-178`

두 non-null field 모두에 명시적인 adoption 입력을 요구하거나, 서버가 검증할 수
있는 별도 adoption schema/결정값을 두어야 이 항목이 닫힌다.

### P2-1. 가변 입력 상한을 반영한 credit floor — 부분 해결

**기존 재현 입력 → 기존 잘못된 출력:** `CHAT_USER_MAX_INPUT_TOKENS=200000`,
Anthropic US$5/US$25, output cap 8,192 → UI는 128K만 계산해
1,004,800 micro-USD를 표시했고 실제 최악 비용 1,454,800보다 450,000 낮았다.

**현재의 200K 결과:** draft GET과 최종 POST가 설정값 200,000을 floor에 전달해
최악 비용 1,454,800을 계산한다. 기존의 평범한 200K 정수 문자열 재현은
해결됐다.

하지만 새 route 둘은 `Number.parseInt`를 쓰고 실제 chat runtime은 `Number` 뒤
`Number.isSafeInteger`를 쓴다. 런타임이 유효하다고 보는 환경변수를 adoption이
다른 값으로 해석할 수 있다.

**현재 재현 입력 → 잘못된 출력:** `CHAT_USER_MAX_INPUT_TOKENS=1e6`, Anthropic
US$5/US$25, output cap 8,192, `creditWeight=8` → runtime은 1,000,000-token 입력을
허용하지만 두 adoption route는 이를 1 token으로 읽는다. floor는
`worstCaseMicroUsd=204,806.25`, `credits=8`, cover 320,000으로 통과하고, 실제 허용
최악 비용은 6,454,800 micro-USD다. 순수 파서·floor 재현에서 각각
`runtimeParsed=1000000`, `adoptionParsed=1`을 확인했다.

두 번째 fail-open도 있다. `suggestCreditFloor()`가 `above_every_class`를 반환할
때 server는 아무 것도 거부하지 않는다.

**현재 재현 입력 → 잘못된 출력:** `CHAT_USER_MAX_INPUT_TOKENS=400000`, 같은
Anthropic 가격과 cap, `usageClass="standard", creditWeight=1` → UI는
“No usage class covers this price … this model waits”와 2,704,800 micro-USD를
표시하지만 Save는 활성 상태이고 `adoptionPreflightRefusal()`은 `null`이다. 최종
POST는 안전한 floor가 하나도 없는데도 201과 1-credit registry row를 반환할 수
있다. 순수 함수 재현에서 `highLimitFloor.reason="above_every_class"`와 save
refusal `null`을 확인했다.

- 새 GET parser: `app/api/admin/model-lifecycle/adoption-draft/route.ts:118-130`
- 새 POST parser: `app/api/admin/models/route.ts:126-136`
- runtime parser와 실제 상한 선택: `lib/chatSecurity.ts:651-655`, `lib/chatSecurity.ts:851-855`
- `above_every_class` 반환: `lib/modelAdoptionDraft.ts:179-182`
- 정상 floor일 때만 거부하는 server 경계: `lib/modelAdoptionDraft.ts:517-530`
- 기다려야 한다는 UI와 이를 Save 조건에 넣지 않은 버튼: `components/admin/AdminModelRegistryPanel.tsx:696-703`, `components/admin/AdminModelRegistryPanel.tsx:776-778`
- 환경변수 parser를 지나지 않는 200K 단위 테스트: `tests/model-adoption-draft.test.ts:495-510`

상한 파싱을 runtime과 하나의 helper로 공유하고, 계산 결과가
`above_every_class`이면 adoption POST 자체를 거부해야 이 항목이 닫힌다.

### P1-A1. 검증 전 enabled/public 즉시 출생 — 해결

**기존 재현 입력 → 기존 잘못된 출력:** 정상 add work item의 adoption POST를
`status="enabled"` 또는 `"limited"`, `publiclyListed=true`로 보낸다 →
pending validations가 남았는데도 즉시 런타임·공개 catalogue 대상인 row가 201로
생성됐다.

**현재 출력:** 최종 POST의 preflight가 enabled/limited를 409로, listed를 409로
거부한다. 같은 검사를 registry row 생성 전과 work item `FOR UPDATE` 뒤에 모두
수행한다. 허용되는 `disabled`/`coming-soon`은 `registryInputToData()`에서
`enabled=false`가 되므로 body의 다른 필드로 활성 상태를 다시 만들 수 없다. 순수
재현에서도 enabled 입력은 409였다.

- 서버 불변조건: `lib/modelAdoptionDraft.ts:496-513`
- transaction 전·후 재검사: `app/api/admin/models/route.ts:208-214`, `app/api/admin/models/route.ts:226-259`
- status에서 enabled를 파생하는 단일 변환: `lib/modelRegistryAdmin.ts:173-178`
- 회귀 테스트: `tests/model-adoption-draft.test.ts:432-447`

### P1-A2. pendingValidations를 지울 writer 부재 — 해결

**기존 재현 입력 → 기존 잘못된 출력:** 채택 후
`pendingValidations=["pricing","access","staging"]`인 item에서 세 검증을 실제로
끝내도 이를 지울 writer가 없어 `validation_pending → rollout_pending`이 영구히
409 `validations_outstanding`이었다.

**현재 출력:** `POST /api/admin/model-lifecycle/validations`가 item의 현재 목록에
있는 이름만 제거하고, actor·note·동일 상태 event와 admin audit를 남긴다. queue
응답이 현재 목록을 내리고 UI가 각 항목의 완료 control을 제공한다. 세 항목을
순차로 지우면 `pendingValidations=[]`가 되어 기존 rollout gate가 통과할 수 있다.
따라서 writer가 전혀 없어 생긴 원래 dead end는 닫혔다.

- 새 writer의 schema·권한·기록: `app/api/admin/model-lifecycle/validations/route.ts:36-116`
- queue projection: `lib/modelLifecycleWorkItems.ts:603-620`, `lib/modelLifecycleWorkItems.ts:724-747`
- UI 호출과 local state 반영: `components/admin/AdminModelDiscoveryPanel.tsx:358-408`, `components/admin/AdminModelDiscoveryPanel.tsx:737-750`
- empty list를 허용하는 기존 rollout gate: `lib/modelLifecycleWorkItemCore.ts:186-190`
- 회귀 테스트는 순차 pure helper만 확인: `tests/model-adoption-draft.test.ts:512-526`

다만 이 writer가 새로 만든 동시성 결함은 아래 P1-A4에 별도로 적었다.

### P1-A3. rollout 이후 stale 채택 — 해결

**기존 재현 입력 → 기존 잘못된 출력:** `modelId=null`,
`status="rollout_pending"`인 stale item을 채택한다 → 빈 transition path가 허용되어
row를 만든 뒤 validations를 너무 늦게 붙였고, item은 그대로 completed로 갈 수
있었다.

**현재 출력:** `adoptionTransitionPath()`가 빈 배열을 주는
`validation_pending`, `rollout_pending`, `communication_pending`을 preflight가
모두 409로 거부한다. 결정에 사용되는 검사는 transaction이 work item을
`FOR UPDATE`로 잠근 뒤 현재 상태를 다시 읽어서 수행되므로, draft 이후 다른
요청이 item을 앞으로 옮긴 stale save도 생성한 registry row와 함께 rollback된다.
순수 재현에서도 `rollout_pending` 입력은 409였다.

- 빈 path 거부: `lib/modelAdoptionDraft.ts:475-495`
- 잠금 뒤 현재 상태 재검사: `app/api/admin/models/route.ts:226-259`
- 경계 상태 회귀 테스트: `tests/model-adoption-draft.test.ts:482-493`

## 이번 수정이 새로 만든 결함

### P1-A4. 동시 validation 완료가 서로를 덮어써 완료 기록과 실제 gate가 모순됨

새 writer는 transaction을 사용하지만 item을 읽기 전에 row lock을 잡지 않는다.
반면 기존 lifecycle transition writer는 바로 이 문제를 막기 위해 전체 대상에
`FOR UPDATE`를 잡은 뒤 상태와 pending 목록을 읽는다.

**재현 입력 → 잘못된 출력:** 초기 목록이
`["pricing","access","staging"]`일 때 두 admin 탭이 동시에 하나는
`completed=["pricing"]`, 다른 하나는 `completed=["access"]`로 POST하고, 두
transaction이 UPDATE 전에 같은 초기 snapshot을 읽는다 → 하나는
`["access","staging"]`, 다른 하나는 `["pricing","staging"]`을 계산해 둘 다
성공 event를 기록한다. 마지막 UPDATE가 앞선 결과를 통째로 덮으므로 최종 DB에는
이미 “Validation satisfied” event가 있는 `pricing` 또는 `access`가 다시 pending으로
남는다. 두 200 응답·event는 둘 다 성공이라고 하지만 gate의 실제 상태는 둘 중
하나만 반영한다.

이는 fail-open보다는 fail-closed 방향이지만, append-only 감사 기록과 현재 상태가
서로 모순되고 운영자가 완료한 검증을 다시 처리해야 한다. 같은 item을 먼저
`SELECT ... FOR UPDATE`로 잠근 뒤 목록을 읽거나, 조건부 update와 충돌 재시도를
써야 한다.

- 잠금 없이 snapshot을 읽고 전체 JSON을 덮는 새 writer: `app/api/admin/model-lifecycle/validations/route.ts:65-84`
- 둘 다 성공했다고 기록하는 append-only event: `app/api/admin/model-lifecycle/validations/route.ts:85-99`
- 기존 transition writer의 올바른 lock-before-read 선례: `lib/modelLifecycleWorkItems.ts:402-423`
- 동시 route 동작을 다루지 않는 현재 테스트: `tests/model-adoption-draft.test.ts:512-526`

## 검증과 한계

- `git show 7c7e3137`과 현재 트리의 관련 route, state machine, registry 변환,
  queue projection, schema, UI 및 테스트를 읽음
- `git diff 7c7e3137^ 7c7e3137 --check` — 통과
- `npm run typecheck` — 통과
- `npm run lint -- <변경된 TS/TSX 8개>` — 통과
- `npm run check:accent-tokens` — 통과
- `node --conditions=react-server --import tsx --test --test-reporter=spec tests/model-adoption-draft.test.ts tests/model-lifecycle-work-item-core.test.ts`
  — 75/75 통과
- 순수 함수·파서 재현 — 관측되지 않은 provider/API 직교 조합 refusal `null`,
  `advanced` + 손대지 않은 `creditWeight=1` refusal `null`, enabled 및 stale rollout
  각각 409, 400K `above_every_class`의 save refusal `null`, `1e6`의 runtime/adoption
  파싱 결과 1,000,000/1을 확인

`DATABASE_URL`과 `DIRECT_URL`이 모두 설정되지 않아 실제 PostgreSQL route 통합
재현은 실행하지 않았다. 따라서 P1-2의 두 POST 동시 commit과 P1-A4의 lost update는
현재 코드의 transaction/lock 순서 및 DB 제약으로 판정했다. 현재 추가된 테스트는
route/DB를 실행하지 않고 pure helper만 검사하므로 이 두 경쟁 상태를 검출하지
못한다.
