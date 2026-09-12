# 발견 큐 → 레지스트리 채택 기능 독립 검토 결과

- 검토일: 2026-09-12
- 기준: `git diff origin/develop` 및 프롬프트가 명시한 신규(untracked) 파일
- 판정: **수정 후 재검토 필요**
- 발견: P1 5건, P2 3건

> 참고: `git diff origin/develop` 자체는 untracked 파일을 출력하지 않으므로,
> 프롬프트가 검토 대상으로 명시한 `lib/modelAdoptionDraft.ts`,
> `app/api/admin/model-lifecycle/adoption-draft/route.ts`,
> `tests/model-adoption-draft.test.ts`는 별도로 전문을 읽었다.

## 발견사항

### P1-1. 이미지 생성 후보에도 채택 버튼이 열려 채팅 레지스트리에 저장된다

**재현 입력 → 잘못된 출력:** `action="add"`, `status="discovered"`,
`apiModel="gpt-image-3"`인 이미지 생성 work item을 발견 탭에서 연다 →
`adoptableMember()`가 이를 채택 가능으로 판정하고, 저장 시 이미지 생성 원장이 아닌
`ModelRegistryEntry`에 채팅 모델로 생성한 뒤 work item을 `validation_pending`으로
옮긴다.

`adoptableMember()`는 action과 status만 검사하고 이미 화면이 계산해 둔
`candidate.product`를 검사하지 않는다. 서버도 `action === "add"`만 검사한다.
그러나 이미지 모델 원장은 `AVAILABLE_MODELS / ModelRegistry`와 의도적으로
분리되어 있으며, 전자는 이미지 **출력** 모델, 후자의 `supportsImage`는 이미지
**입력** 능력을 뜻한다. 현재 흐름대로 저장하면 제품 의미와 가격 체계가 모두 다른
행이 채팅 런타임에 들어간다.

- 근거: `components/admin/AdminModelDiscoveryPanel.tsx:142-149, 677-685`
- 근거: `app/api/admin/models/route.ts:110-118, 137-175`
- 제품 경계: `lib/imageModelRegistry.ts:1-8`

### P1-2. 채택 POST가 work item과 모델 사이의 1:1·정체성 불변조건을 강제하지 않는다

**재현 입력 → 잘못된 출력 1:** Anthropic의 `claude-new` add work item ID를
query에 넣고, 본문에는 `provider="openai"`, `apiModel="gpt-other"`,
`id="gpt-other"`를 보낸다 → 요청은 성공하고 `claude-new`의 work item이
`gpt-other`에 연결된 채 승인·검증 대기 상태가 된다.

**재현 입력 → 잘못된 출력 2:** 이미 모델 A에 연결되어
`validation_pending`인 같은 work item으로 서로 다른 ID의 모델 B를 다시 POST한다
→ `adoptionTransitionPath("validation_pending")`가 빈 배열을 반환하므로 전이 검사는
한 번도 실행되지 않고, 모델 B가 새로 생성된 뒤 `modelId`가 B로 덮인다. 모델 A는
채택 이력을 잃은 고아 레지스트리 행으로 남는다. 동시 요청이 없어도 재현된다.

라우트는 work item의 `apiModel`을 읽지만 본문의 `provider`/`apiModel`과 비교하지
않고, 기존 `modelId`도 읽거나 거부하지 않는다. 스키마의 `modelId`는 nullable
일반 컬럼이며 unique/FK가 아니므로 DB도 이 덮어쓰기를 막지 않는다.

- 근거: `app/api/admin/models/route.ts:100-125, 137-175`
- 빈 경로: `lib/modelLifecycleWorkItemCore.ts:529-557`
- DB 형태: `prisma/schema.prisma:2236-2245, 2304-2307`

### P1-3. 채택이 알려진 검증 의무를 기록하지 않아 검증 없이 rollout으로 갈 수 있다

**재현 입력 → 잘못된 출력:** 정상 discovery 생성 경로가 만든
`pendingValidations = null`인 work item을 채택한다 → POST는 상태만
`validation_pending`으로 이동시키고 `pendingValidations`는 계속 null이다. 이어서
`validation_pending → rollout_pending` 전이를 요청하면 DB 경계가 null을 빈 배열로
해석하므로 `workItemTransitionRefusal()`이 `null`을 반환하고 전이가 성공한다.

초안은 가격·access·staging 등 미확정 사항을 이미 알고 있지만 브라우저에만
`unknowns`로 보여 주며, work item에는 어느 것도 저장하지 않는다. 이는
“무엇이 남았는지는 `pendingValidations`로 둔다”와 “검증이 남으면 rollout 금지”라는
기존 lifecycle 불변조건을 무력화한다.

- 상태만 바꾸는 코드: `app/api/admin/models/route.ts:145-175`
- null을 빈 목록으로 읽는 코드: `lib/modelLifecycleWorkItems.ts:413-452`
- rollout 거부 조건: `lib/modelLifecycleWorkItemCore.ts:180-190`
- 기존 계약: `.github/audits/model-lifecycle-email-2026-08-22.md:885-892, 954-964`

### P1-4. “미정” 필드가 실제로는 일반 생성 폼의 값으로 확정 저장된다

**재현 입력 → 잘못된 출력:** adoption draft가 의도대로 가격·판매 등급·최소
플랜·예약 출력 토큰을 `fields`에서 생략한 상태에서 운영자가 다른 입력 없이
저장한다 → `setForm({ ...emptyForm(), ...data.fields })` 때문에 DB에는
`minimumPlan="Guest"`, `usageClass="standard"`, `creditWeight=1`,
`reservationOutputTokens=1024`, 입력/출력 가격 `0`, cached multiplier `1`이
명시값으로 저장된다.

화면은 같은 순간 이 값들을 “아직 사람이 정해야 하는 값”이라고 말한다. 특히 가격
0과 cached multiplier 1은 `NULL` 상속이 아니라 registry override로 해석되므로,
나중에 가격 profile을 추가해도 이 행은 profile을 상속하지 않는다. `creditWeight`와
reservation도 숫자가 저장되어 향후 정한 class/profile 기본값을 자동으로 따르지
않는다. 새 행이 `coming-soon`/비공개로 태어나는 것은 즉시 노출을 막지만, 미정
값을 확정값으로 바꾸는 데이터 손상까지 막지는 않는다.

- 기본값 주입: `components/admin/AdminModelRegistryPanel.tsx:88-113, 230-244`
- 미정이라고 표시하는 값: `lib/modelAdoptionDraft.ts:242-253`
- 명시값 저장: `lib/modelRegistryAdmin.ts:173-195`
- 0도 override가 되는 해석: `lib/modelPricing.ts:1669-1676, 1712-1728`

### P1-5. provider의 출력 능력 상한을 앱의 매 요청 출력 상한으로 복사한다

**재현 입력 → 잘못된 출력:** provider 목록이 새 모델에
`outputTokenLimit=524288`을 보고한다 → 초안은 이를
`maxOutputTokens=524288`로 채우고 POST는 DB override로 저장한다. 이후 가격
resolver와 chat budget은 이 숫자를 “Tomverse가 매 요청에 요구하는 출력 cap”으로
사용한다. P1-4의 기본 예약값을 그대로 두면 1,024 토큰만 예약하면서 최대
524,288 토큰을 요청할 수 있는 조합도 만들어진다.

기존 가격 계약은 provider capability인 `providerMaxOutputTokens`와 앱 요청 cap인
`maxOutputTokens`를 명시적으로 구분하며, 둘을 합쳐 Kimi K3의 모든 요청을 깨뜨린
과거 사례까지 기록한다. provider catalogue의 `outputTokenLimit`은 전자에 대한
관측이지 후자에 대한 제품·entitlement 결정이 아니다. 현재 DB 폼에는 전자를
저장할 별도 필드가 없으므로 자동 채움 대상이 아니라 unknown으로 남겨야 한다.

- 잘못된 매핑: `lib/modelAdoptionDraft.ts:218-222, 256-264`
- 요청 cap으로 저장: `lib/modelRegistryAdmin.ts:191-192`
- 두 상한의 의미와 과거 실패: `lib/modelPricing.ts:229-257`
- runtime 우선순위: `lib/modelPricing.ts:1693-1709`

### P2-1. 표시되는 “크레딧 하한”이 실제 최악 비용을 덮지 못하는 경우가 있다

**재현 입력 → 잘못된 출력:** 입력 US$5/M, 출력 US$25/M, 출력 cap 8,192를
입력한다 → 함수는 최악 비용 844,800 micro-USD, premium 8크레딧의 cover
960,000 micro-USD를 표시한다. 같은 Anthropic 요청의 첫 5분 prompt-cache write가
입력단가의 1.25배로 청구되면 실제 토큰 비용은
`128000 × 6.25 + 8192 × 25 = 1,004,800 micro-USD`로 표시된 cover를 넘는다.

실행 경로의 provider 비용 예약은 base input/output 외에 cache-write premium과
native-search 비용을 더하지만, 하한 함수 입력에는 provider, cache-write rate,
search 비용, 장문 가격 tier가 없다. 따라서 이 값은 “base token-price 참고치”일
수는 있어도 UI가 말하는 “최악 턴을 덮는 최저 class”나 “그 아래는 원가 이하”는
아니다. 독립 재현에서도 `1,004,800 > 960,000`이 확인됐다.

- 산식: `lib/modelAdoptionDraft.ts:85-144`
- 과도한 UI 단정: `components/admin/AdminModelRegistryPanel.tsx:640-660`
- 실제 예약 비용 구성: `lib/chatSecurity.ts:720-742, 744-782`

### P2-2. 이미지 입력 능력의 “알 수 없음”을 `false`로 바꾸고 미정 목록에도 넣지 않는다

**재현 입력 → 잘못된 출력:** 이미지 입력을 지원하지만 provider `/models` 응답이
vision 필드를 제공하지 않는 새 채팅 모델을 관측한다 → parser가 `vision=null`을
저장하고 draft는 `supportsImage=false`를 반환한다. `unknowns`에도 이미지 입력
확인 항목이 없으므로 운영자는 미확정 사실을 명시적 미지원으로 저장한다.

provider parser가 `null`을 별도 값으로 보존하는 이유를 draft가 지운다. 명시적
`vision=false`와 필드 부재를 구분하거나, 적어도 null일 때 unknown으로 알려야 한다.

- provider의 3상태 관측: `lib/providerModelCatalogCore.ts:262-280`
- null을 false로 축약: `lib/modelAdoptionDraft.ts:218-240, 256-265`

### P2-3. 사람의 승인 사유가 없는 요청에 서버가 행위 설명을 사유로 합성한다

**재현 입력 → 잘못된 출력:** 운영자가 채택 폼을 저장하되 채택 사유는 입력하지
않는다(폼에 해당 입력란도 없다) → 서버가 `decision="approve"`와
`decisionReason="Adopted into the registry as <id>."`를 생성해 `approved` 홉을
통과시킨다.

저장 버튼을 누른 주체가 사람이므로 다중 홉 자체는 “automation may create,
never decide” 규칙을 위반하지 않는다. 문제는 기존 불변조건이 요구한 것은 나중에
검토 가능한 **이유**인데, 합성 문자열은 수행한 일을 반복할 뿐 이유를 남기지
않는다는 점이다. 주석이 “form values are the why”라고 주장하지만 work item의
append-only event에는 폼 snapshot이 없고 registry 행은 이후 수정 가능하므로 그
값들도 당시 승인 근거가 될 수 없다.

- 합성된 note/decision reason: `app/api/admin/models/route.ts:145-164`
- 기존 DB 계약의 목적: `prisma/migrations/20260822120000_model_lifecycle_work_item/migration.sql:121-130`
- event에 폼 snapshot 없음: `prisma/schema.prisma:2310-2329`

## 설계 전제별 추가 판정

- **일반 “새 모델 추가” 기본값:** `emptyForm()` 자체는 바뀌지 않았고 adoption
  응답을 overlay하는 경로에만 `coming-soon`/비공개가 적용된다. 채택이 아닌 기존
  생성 흐름의 기본값 회귀는 찾지 못했다.
- **트랜잭션/잠금:** registry create, 각 상태 전이, `modelId` 연결은 같은 Prisma
  transaction 안에 있고 `transitionWorkItems(..., { tx })`가 같은 row lock을 다시
  잡는 것 자체에서 부분 적용이나 교착 근거는 찾지 못했다. 다만 전이 경로를
  transaction 밖의 상태로 계산하며 빈 경로에서는 lock을 전혀 잡지 않는 문제가
  P1-2의 재채택·덮어쓰기 경로를 만든다.
- **registry ID 충돌:** soft-deleted 행까지 `takenIds`에 넣는 처리와 DB unique
  race의 `P2002` 응답은 적절하다. 그러나 서로 다른 registry ID로 같은
  provider/API 모델을 중복 생성하거나 한 work item을 재채택하는 의미상 충돌은
  P1-2처럼 막지 못한다.

## 실행한 검증

- `npm run typecheck` — 통과
- `node --conditions=react-server --import tsx --test --test-reporter=spec tests/model-adoption-draft.test.ts tests/model-lifecycle-work-item-core.test.ts` — 53/53 통과
- 순수 함수 재현 — cache-write 포함 비용 `1,004,800 > 960,000`, vision 누락 시
  `supportsImage=false`이고 이미지 관련 unknown 없음,
  `adoptionTransitionPath("validation_pending")=[]`, pending 목록이 비었을 때
  rollout 거부값 `null` 확인

현재 테스트는 순수 함수의 정상 경로만 다루고 POST route/DB 경계는 다루지 않으므로,
위의 제품 분류, 정체성 일치, 재채택, explicit override, pending validation 문제를
검출하지 못한다.
