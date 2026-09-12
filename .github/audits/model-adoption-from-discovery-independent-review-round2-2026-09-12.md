# 발견 큐 → 레지스트리 채택 기능 독립 재검토 (Round 2)

- 검토일: 2026-09-12
- 검토 기준: `git show 8dcb44d0` 및 커밋 `8dcb44d0`의 현재 트리
- 이전 검토: `codex-review-findings.md`의 P1 5건, P2 3건
- 판정: **수정 후 재검토 필요**
- 기존 8건 결과: **완전 해결 5건, 부분 해결 3건**
- 추가 발견: **P1 3건** — 후속 수정이 직접 만든 회귀 2건, Round 1에서 놓친
  서버 경계 결함 1건

`8dcb44d0`은 이미지 생성 제품 경계, 재채택 방지, nullable 미정값,
provider 출력 능력 상한 분리, vision 미관측 표시, 채택 사유 기록을 실제 코드와
테스트에 반영했다. 그러나 provider 정체성, non-null 판매 기본값, 가변 입력 상한에
대한 크레딧 계산은 아직 원래 지적을 전부 닫지 못했다. 또한 검증 의무를 새로 쓰는
수정은 정상 채택을 빠져나갈 수 없게 만드는 한편, 이미 rollout 이후인 stale
채택에서는 같은 의무를 우회할 수 있게 한다.

## 기존 8건 재검토

### P1-1. 이미지 생성 후보가 채팅 레지스트리에 저장됨 — 해결

**기존 재현 입력 → 기존 잘못된 출력:** `action="add"`,
`status="discovered"`, `apiModel="gpt-image-3"`인 work item을 채택한다 →
채팅 `ModelRegistryEntry`가 생성됐다.

**현재 결과:** UI는 대표 항목의 `product !== "chat"`이면 채택 링크를 만들지
않는다. draft GET과 최종 POST도 각각 `modelProductSurface()`를 다시 확인하며,
순수 재현에서 `adoptionPreflightRefusal()`은 409를 반환한다. UI 우회로도 저장되지
않으므로 이 지적은 해결됐다.

- UI 경계: `components/admin/AdminModelDiscoveryPanel.tsx:142-153`
- draft GET 경계: `app/api/admin/model-lifecycle/adoption-draft/route.ts:61-71`
- 최종 POST 경계: `lib/modelAdoptionDraft.ts:401-410`,
  `app/api/admin/models/route.ts:117-128, 161-163`
- 회귀 테스트: `tests/model-adoption-draft.test.ts:330-338`

### P1-2. work item과 모델의 1:1·정체성 불변조건 부재 — 부분 해결

원래의 두 재현 중 `apiModel="gpt-other"`를 보내는 경우는 family 불일치로 409가
되고, `modelId`가 이미 있는 같은 item의 재채택도 409가 된다. 트랜잭션 안의
`FOR UPDATE` 후 같은 검사를 반복하므로 동일 item의 동시 재채택도 롤백된다.

하지만 지적의 **provider/API pair 정체성**은 아직 강제되지 않는다.

**재현 입력 → 잘못된 출력:** work item이
`provider="anthropic", apiModel="claude-fable-5-1", modelId=null`일 때 POST
본문을 `provider="openai", apiModel="claude-fable-5-1"`로 보낸다 →
`adoptionPreflightRefusal()`은 `null`을 반환하고, 최종 행은 OpenAI provider로
생성되어 Anthropic work item에 연결된다. 실행 재현에서도 반환값 `null`을
확인했다.

work item 조회와 `FOR UPDATE` 결과 형식 모두 `provider`를 선택하지 않고,
preflight 입력 형식도 `body.apiModel`만 받는다. 비교도 vendor prefix와 날짜 suffix를
버리는 `candidateFamilyIdentity()`뿐이다. 따라서 관측되지 않은 같은-family 문자열
(예: `openai/claude-fable-5-1-20260901`)도 허용된다. 또한 기존 레지스트리에 같은
`(provider, apiModel)` 행이 있어도 다른 `id`로 하나 더 만들 수 있다.
`ModelRegistryEntry`에는 이 pair의 unique 제약이 없다.

- provider를 읽지 않는 조회: `app/api/admin/models/route.ts:117-124, 153-160`
- provider 없는 검사 형식과 family-only 비교:
  `lib/modelAdoptionDraft.ts:377-385, 412-419`
- body의 provider가 실제 행에 저장되는 경로:
  `app/api/admin/models/route.ts:140-146`, `lib/modelRegistryAdmin.ts:164-169`
- pair unique가 없는 스키마: `prisma/schema.prisma:2136-2175`
- 재채택 방지 자체는 정상: `lib/modelAdoptionDraft.ts:395-399`

### P1-3. 알려진 검증 의무가 기록되지 않음 — 해결(추가 회귀는 아래 별도 기재)

**기존 재현 입력 → 기존 잘못된 출력:** `pendingValidations=null`인 정상 discovery
item을 채택한 뒤 `validation_pending → rollout_pending`으로 전이한다 → null이 빈
목록으로 읽혀 rollout이 허용됐다.

**현재 결과:** 채택 트랜잭션이 `modelId`와 함께
`["pricing", "access", "staging"]`을 쓰며, 이 목록이 남은 상태의 rollout 요청은
`validations_outstanding`으로 거부된다. 기존 실패 입력 자체는 해결됐다.

- 검증 목록 정의: `lib/modelAdoptionDraft.ts:351-360`
- 원자적 기록: `app/api/admin/models/route.ts:185-195`
- rollout 거부: `lib/modelLifecycleWorkItemCore.ts:186-190`
- 회귀 테스트: `tests/model-adoption-draft.test.ts:364-378`

다만 이 수정이 만든 정상 경로의 dead end와 rollout 이후 우회는 각각 추가 발견
P1-A2와 P1-A3에 적었다.

### P1-4. “미정” 필드가 일반 생성 폼 기본값으로 저장됨 — 부분 해결

가격 3개, `maxOutputTokens`, `reservationOutputTokens`는 명시적 `null`로 overlay되어
더 이상 0/1/1024 override가 되지 않는다. `minimumPlan`도 가장 제한적인 `Pro`로
바뀌었다. 이 부분은 해결됐다.

그러나 `usageClass`와 `creditWeight`는 여전히 draft에서 생략되고 일반 생성 폼의
`standard`와 `1`을 상속한다.

**재현 입력 → 잘못된 출력:** `buildAdoptionDraft()`가 판매 등급과 크레딧을
`unknowns`에만 넣은 상태에서 운영자가 해당 두 입력을 건드리지 않고 저장한다 →
`setForm({ ...emptyForm(), ...data.fields })` 결과가
`usageClass="standard", creditWeight=1`이고, POST가 두 값을 명시값으로 저장한다.
실행 재현에서도 overlay 결과가 정확히 `standard`/`1`이었다.

즉 화면은 “아직 사람이 정해야 하는 값”이라고 표시하지만 DB에는 실제로 아무도
정하지 않은 판매·entitlement 결정을 기록한다. 이 두 컬럼은 non-nullable이므로
단순히 draft에서 키를 생략하는 것으로는 미정을 표현할 수 없다.

- 일반 폼 기본값: `components/admin/AdminModelRegistryPanel.tsx:88-113`
- adoption overlay: `components/admin/AdminModelRegistryPanel.tsx:232-244`
- 두 필드를 미정이라고 표시: `lib/modelAdoptionDraft.ts:306-310`
- draft 반환에는 두 키가 없음: `lib/modelAdoptionDraft.ts:325-344`
- 명시값 저장: `lib/modelRegistryAdmin.ts:173-175`
- 현재 테스트가 생략만 확인하는 위치: `tests/model-adoption-draft.test.ts:125-142`

### P1-5. provider 출력 능력 상한을 요청 상한으로 복사함 — 해결

**기존 재현 입력 → 기존 잘못된 출력:** 관측의
`outputTokenLimit=524288` → `maxOutputTokens=524288` DB override가 됐다.

**현재 결과:** draft의 `maxOutputTokens`는 항상 `null`이고, 관측값은 쓰이지 않는
`observedCapabilities.providerMaxOutputTokens`에만 들어간다. unknown 문구도 능력
상한과 요청 상한이 별개임을 명시한다. 이 지적은 해결됐다.

- 분리된 타입과 반환: `lib/modelAdoptionDraft.ts:206-236, 274-278, 311-315, 325-345`
- 회귀 테스트: `tests/model-adoption-draft.test.ts:222-234`

### P2-1. 표시된 크레딧 하한이 실제 최악 비용을 덮지 못함 — 부분 해결

이전의 Anthropic 5분 cache-write 재현은 해결됐다. Anthropic provider일 때
`1.25`를 전달하고 UI는 native search, 장문 tier, 별도 reasoning 과금을 제외한다고
명시하므로, 기본 128,000-token 환경에서 이전의 844,800 대 1,004,800 불일치는
사라졌다.

그러나 계산 입력은 런타임 상한과 달리 128,000으로 고정되어 있다.

**재현 입력 → 잘못된 출력:** `CHAT_USER_MAX_INPUT_TOKENS=200000`, Anthropic
입력 US$5/M, 출력 US$25/M, 출력 cap 8,192를 사용한다 → UI 계산은 여전히
128,000 입력을 써서 `worstCaseMicroUsd=1,004,800`, `reasoning` 12크레딧의
cover `1,440,000`을 표시한다. 그러나 실제 허용 최악 입력의 비용은
`200000 × 6.25 + 8192 × 25 = 1,454,800 micro-USD`로 cover보다 14,800 크다.
100,000 초과 입력의 multiplier는 계속 3이므로 추가 credit도 생기지 않는다.

런타임은 환경변수의 임의 positive integer를 받아들이지만 floor는 그 값을 읽지도,
128,000 초과 설정을 거부하지도 않는다. 따라서 제목 그대로 “실제 최악 비용을
덮지 못하는 경우”가 남아 있어 부분 해결이다.

- 고정 입력 상한: `lib/modelAdoptionDraft.ts:41-49, 150-163`
- 런타임의 가변 상한: `lib/chatSecurity.ts:852-855`
- 100K 이후 3배로 고정되는 multiplier: `lib/models.ts:64-68, 438-445`
- Anthropic 1.25배 반영: `components/admin/AdminModelRegistryPanel.tsx:286-307`
- 사용자에게 표시되는 단정과 제외 설명:
  `components/admin/AdminModelRegistryPanel.tsx:660-681`

### P2-2. vision “알 수 없음”을 false로 축약하고 알리지 않음 — 해결

**기존 재현 입력 → 기존 잘못된 출력:** 관측 metadata에 `vision`이 없음 →
`supportsImage=false`만 저장되고 미정 목록에는 아무 표시가 없었다.

**현재 결과:** 폼 컬럼이 boolean이라 draft 값 자체는 여전히 false지만,
`vision`이 boolean이 아니면 “공급자 목록이 말하지 않았다. 미지원으로 두었다”는
unknown이 반드시 추가된다. 명시적 `vision=false`에는 이 경고가 붙지 않는다.
이전 지적이 제시한 최소 해결 조건(미관측을 unknown으로 알림)을 충족한다.

- 3상태 분기와 unknown: `lib/modelAdoptionDraft.ts:274-278, 295-304`
- 회귀 테스트: `tests/model-adoption-draft.test.ts:241-256`

### P2-3. 사람의 이유 대신 행위 설명을 승인 사유로 합성함 — 해결

**기존 재현 입력 → 기존 잘못된 출력:** 이유 입력 없이 저장 → 서버가
`Adopted into the registry as <id>.`를 승인 이유로 합성했다.

**현재 결과:** UI에 필수 사유 입력이 생겼고 4자 미만이면 버튼과 서버가 모두
거부한다. `approved` 홉을 지날 때 사람이 입력한 문자열 자체가
`decision.reason`으로 저장된다. 정상 discovery 재현은 더 이상 합성 이유로
승인되지 않는다.

- 입력과 UI 차단: `components/admin/AdminModelRegistryPanel.tsx:640-657, 763-765`
- 서버 차단: `app/api/admin/models/route.ts:102-115`
- 승인 이벤트에 실제 이유 전달: `app/api/admin/models/route.ts:169-180`

## Round 2 추가 발견

커밋이 feature 전체와 후속 수정을 한 snapshot으로 담고 있어 Git만으로 수정 전
중간본을 복원할 수는 없다. 아래 A2·A3은 이전 보고 뒤 추가된
`pendingValidations` write에서 직접 발생한다. A1은 이전 보고가 안전하다고 본
coming-soon/private 값이 서버 불변조건이 아니라 편집 가능한 client 기본값에
불과했다는 Round 1 누락이며, 후속 수정에서 새로 생겼다고 단정하지 않는다.

### P1-A1. 채택 POST가 검증 전 모델을 enabled/public으로 즉시 출생시킬 수 있다

**재현 입력 → 잘못된 출력:** 정상 `discovered` chat work item의 채택 폼에서
`Runtime status=Enabled`, `Publicly listed=true`를 선택하고, 기본
`usageClass="standard"`, `creditWeight=1`, 가격은 null인 채 사유만 입력해 저장한다
→ create schema는 이 payload를 성공으로 판정하고 POST는 201을 반환한다. work
item에는 `pricing/access/staging`이 남아 있지만 레지스트리 행은 이미
`enabled=true`, `status="enabled"`, `publiclyListed=true`여서 런타임 선택 대상이
된다. 순수 schema 재현에서도 이 입력의 `safeParse().success === true`를 확인했다.

draft가 coming-soon/private를 **제안**할 뿐 최종 adoption POST는 그 불변조건을
검사하지 않는다. 화면에도 status와 공개 여부를 같은 저장 전에 바꾸는 control이
그대로 열려 있다. 따라서 검증 목록을 기록한 P1-3 수정과 무관하게 실제 모델은
검증 전에 서비스될 수 있다.

- 같은 폼에서 enabled/public 선택 가능:
  `components/admin/AdminModelRegistryPanel.tsx:716-725`
- 변경된 전체 form을 POST: `components/admin/AdminModelRegistryPanel.tsx:367-389`
- premium만 가격 필수이고 standard/null은 허용:
  `lib/modelRegistryAdmin.ts:82-107, 145-147`
- body 상태를 그대로 생성: `app/api/admin/models/route.ts:140-146`,
  `lib/modelRegistryAdmin.ts:173-178`
- 런타임 enabled/public 해석: `lib/modelRegistry.ts:46-71, 323-336`

### P1-A2. 새 pending validations를 완료 처리할 writer가 없어 정상 채택이 영구 정지한다

**재현 입력 → 잘못된 출력:** 정상 discovery item을 채택해
`validation_pending`과 `["pricing","access","staging"]`에 도달하고, 세 검증을
실제로 마친 뒤 관리자 lifecycle API로 `to="rollout_pending"`을 요청한다 →
항상 409 `validations_outstanding`이 반환된다. 현재 트리에는 목록 항목을 완료하거나
지울 UI/API/script writer가 하나도 없으므로 같은 요청은 영구히 성공할 수 없다.

`pendingValidations`의 기존 사용처는 읽기와 rollout 거부뿐이고, 이번 채택 POST가
저장소 전체의 유일한 값 writer다. lifecycle PATCH schema도 `to`, `decision`,
`note`만 받는다. Registry 폼의 `Validate` 버튼은 provider configuration PUT만
호출하여 work item을 전혀 갱신하지 않는다. 원래 null을 fail-open으로 읽던 문제를
고치면서 happy path 전체를 dead end로 바꾼 회귀다.

- 새 목록을 쓰는 유일한 경로: `app/api/admin/models/route.ts:185-195`
- 목록을 읽어 거부만 하는 DB 경계: `lib/modelLifecycleWorkItems.ts:413-452`
- clear 입력이 없는 lifecycle schema와 PATCH:
  `app/api/admin/model-lifecycle/route.ts:48-75, 125-157`
- work item과 무관한 Validate 버튼:
  `components/admin/AdminModelRegistryPanel.tsx:348-365`
- 거부 규칙: `lib/modelLifecycleWorkItemCore.ts:186-190`

### P1-A3. rollout 이후 stale 채택에는 검증 의무가 너무 늦게 붙어 그대로 완료된다

**재현 입력 → 잘못된 출력:** `modelId=null`, `status="rollout_pending"`,
`communicationRequired=false`인 add work item으로 채택 POST를 보낸다 →
preflight가 허용하고 `adoptionTransitionPath("rollout_pending")`이 빈 배열을
반환하므로 행은 생성되지만 상태는 rollout_pending에 그대로 남는다. 그 뒤에야
`pendingValidations=["pricing","access","staging"]`이 기록된다. 이어
`rollout_pending → completed`를 요청하면 `workItemTransitionRefusal()`은 `null`을
반환하고 완료를 허용한다. 실행 재현에서 빈 path와 완료 refusal `null`을 모두
확인했다.

이 상태는 crafted DB row가 필요하지 않다. 기존 전이 API는 `modelId`나 구현 증거를
검사하지 않고, 기존 null pending 목록이면 validation에서 rollout으로 이동할 수
있다. 또는 한 탭에서 adoption draft를 연 뒤 다른 탭에서 item을 앞으로 옮긴 stale
save로도 도달한다. UI가 validation 이후 채택 버튼을 숨기는 것만으로 최종 POST의
경쟁 상태를 막을 수 없다.

- rollout/communication에 빈 path를 주는 코드:
  `lib/modelLifecycleWorkItemCore.ts:529-557`
- 빈 path도 허용하는 preflight: `lib/modelAdoptionDraft.ts:421-431`
- 상태를 되돌리지 않고 뒤늦게 validations를 기록:
  `app/api/admin/models/route.ts:165-195`
- pending 목록은 `to === "rollout_pending"`일 때만 검사하고 완료에는 무시:
  `lib/modelLifecycleWorkItemCore.ts:186-203`
- UI만 validation 이후 버튼을 숨김:
  `components/admin/AdminModelDiscoveryPanel.tsx:142-153`

## 검증과 한계

- `git show 8dcb44d0`, 현재 트리 및 관련 정책·스키마를 읽음
- `git diff 8dcb44d0^ 8dcb44d0 --check` — 통과
- `npm run typecheck` — 통과
- `npm run lint -- <변경된 TS/TSX 7개>` — 통과
- `npm run check:accent-tokens` — 통과
- `node --conditions=react-server --import tsx --test --test-reporter=spec tests/model-adoption-draft.test.ts tests/model-lifecycle-work-item-core.test.ts`
  — 53/53 통과
- 순수 함수·schema 재현 — provider mismatch refusal `null`, 관측되지 않은
  same-family API model refusal `null`, adoption form overlay `standard`/`1`,
  enabled/public payload schema 허용, rollout adoption path `[]`, outstanding
  validations를 가진 rollout item의 completed refusal `null`, 200K 입력에서 floor
  cover가 실제 비용보다 14,800 micro-USD 부족함을 확인

`DATABASE_URL`과 `DIRECT_URL`이 모두 설정되지 않아 실제 PostgreSQL route 통합
테스트는 실행하지 않았다. 다만 위 POST 결과는 순수 preflight/schema의 실행 결과와
트랜잭션의 직접 데이터 흐름으로 확인했다. 현재 추가된 테스트는 route/DB 경계를
실행하지 않고, same-family 문자열 허용을 오히려 정상 계약으로 고정하며, draft를
실제 `emptyForm()`에 overlay한 결과와 pending validation의 완료 경로를 검사하지
않는다.
