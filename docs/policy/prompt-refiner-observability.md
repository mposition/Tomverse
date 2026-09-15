# Prompt Refiner receipt와 관측 계약

상태: **provider-independent 데이터 계약 구현, 제품 수집 미연결**.

이 문서는 Prompt Refiner 한 요청에서 무엇을 관측하고 어떤 분모로 읽는지를
정한다. 현재 구현은 strict schema, 결속 검사, 순수 집계와 오프라인 report까지다.
provider adapter, API route, Prisma table, browser event writer, 비용 예약·정산,
Router 결합과 rollout 활성화는 없다.

## 1. 하나의 변경 가능한 행 대신 두 개의 불변 사실

실행과 사용자 반응은 서로 다른 시점과 신뢰 경계에서 생긴다.

1. `PromptRefinerExecutionReceipt`는 서버가 쓴다. 어느 provider/model/adapter가
   호출됐는지, suggestion을 만들었는지, 실패 또는 dispatch 전 거절이었는지,
   서버 시각·token·실비용·retry 수를 기록한다.
2. `PromptRefinerDispositionReceipt`는 서버가 승인한 browser 관측이다. 사용자가
   suggestion을 채택했는지, 원문을 유지했는지, draft/scope 변경 등으로 stale이
   됐는지를 기록한다.

두 번째 기록이 첫 번째 기록을 수정하지 않는다. 결속 키가 일치하는 별도 record로
남기므로 늦은 browser 관측이 provider 결과나 비용을 소급해서 바꿀 수 없다. 한
execution에는 disposition이 최대 하나다. 중복·orphan·request/suggestion 불일치는
집계에서 제외하는 것이 아니라 bundle 전체를 거부한다.

## 2. 실행 outcome과 실패 분류

| outcome | 의미 | provider failure 분모 |
| --- | --- | --- |
| `suggested` | dispatch 뒤 strict response 검증을 통과해 suggestion을 만들었다 | 포함, 성공 |
| `failed` | dispatch 이후 adapter/provider/response 검증에서 suggestion을 만들지 못했다 | 포함, 실패 |
| `refused_before_dispatch` | admission/adapter가 provider 호출 전에 거절했다 | 제외 |

`failed`와 `refused_before_dispatch`를 합치지 않는다. provider에 보내지 않은 요청은
provider 신뢰성에 대해 아무 말도 하지 않기 때문이다. 따라서 `failed`는 반드시
dispatch 시각을 가지며 `admission` layer를 쓸 수 없고, dispatch되지 않은
`admission`/`adapter` 실패는 `refused_before_dispatch`로만 기록한다.
`failureLayer`는 `admission`, `adapter`, `provider`, `response_validation` 중 하나이며
성공만 `none`이다.
`failureCode`는 고정 enum이고 provider 오류 본문을 담을 문자열 필드는 없다.
`adapter_unavailable`과 `cost_guardrail`은 pre-dispatch 전용이고,
`provider_error`, `timeout`, `invalid_response`, `empty_response`, `no_change`,
`unknown_after_dispatch`는 post-dispatch 전용이다. `cancelled`는 dispatch 전후 모두
일어날 수 있으므로 code만으로 단계를 주장하지 않고 `dispatchedAt`과 outcome이 그
lifecycle을 결정한다.

`requestedAt`, `dispatchedAt`, `completedAt`은 모두 서버 시각이다.
`preparationLatencyMs`는 `completedAt - requestedAt`에서 도출한 값과 정확히 같아야
한다. 미래 disposition API의 `observedAt`도 client clock이 아니라 서버가 그
관측을 승인한 시각이어야 한다.

## 3. known 0과 unknown은 다르다

input, cache-read, output, reasoning token과 실제 비용은 nullable이다.

- `0`: provider/정산기가 0이라고 보고했다.
- `null`: 보고되지 않아 모른다.

dispatch하지 않은 receipt는 이 값을 모두 `null`로 둔다. report는 각 항목마다
`population`, `reported`, `missing`, `total`을 함께 보여 준다. 일부 값만 있는
window에서 합계만 출력해 완전한 비용처럼 보이게 하지 않는다. 비용 단위는 정수
microUSD이고 사용자 entitlement인 credit과 섞지 않는다.

## 4. disposition과 stale

명시적 선택은 `accepted`와 `kept_original` 두 개다. 둘 다 성공한 execution의
같은 `suggestionId`에만 붙는다. `stale`은 suggestion 준비 전과 후를 이유 이름에서
구분한다.

- 준비 중: `draft_changed_while_requesting`, `scope_changed_while_requesting`,
  `request_superseded`, `submitted_before_ready`. 아직 suggestion이 없으므로
  `suggestionId`는 `null`이다.
- 준비 후: `draft_changed_after_ready`, `scope_changed_after_ready`. 성공한
  execution의 exact `suggestionId`가 필요하다.

준비 중 stale은 provider 실행보다 먼저 관측될 수 있고 provider는 그 뒤 성공하거나
실패할 수 있다. 따라서 stale을 실행 outcome으로 바꾸지 않는다. 반대로 채택과 원문
유지는 `completedAt`보다 앞설 수 없다.

## 5. 지표의 정확한 분자와 분모

| 지표 | 분자 | 분모 | 0건일 때 |
| --- | --- | --- | --- |
| suggestion yield | `suggested` | 모든 execution request | `null` |
| dispatched failure | dispatch된 `failed` | dispatch된 execution | `null` |
| failed request | `failed` | 모든 execution request | `null` |
| refusal | `refused_before_dispatch` | 모든 execution request | `null` |
| stale request | `stale` disposition | 모든 execution request | `null` |
| explicit choice | `accepted + kept_original` | `suggested` execution | `null` |
| acceptance | `accepted` | `accepted + kept_original` | `null` |
| keep-original | `kept_original` | `accepted + kept_original` | `null` |

latency는 성공 suggestion의 `preparationLatencyMs` p50/p95와 모든 terminal
execution의 p50/p95를 별도로 낸다. nearest-rank를 쓰고 표본 수를 같이 표시한다.
실패 latency를 성공 latency에 섞거나 빈 표본을 0ms로 표시하지 않는다.

provider/model breakdown은 attribution이 둘 다 있는 receipt만 묶고, 나머지는
`unattributedRequests`로 따로 센다. breakdown은 어떤 모델이 더 낫다는 순위를
만들지 않는다.

## 6. 콘텐츠·개인정보 경계

두 receipt schema에는 다음 필드가 없다.

- prompt 원문·제안문·digest 또는 일부 발췌
- user id, anonymous id, conversation id, session id, IP
- attachment·Memory·profile·tool·Router 정보
- provider 오류 본문

허용되는 문자열은 제한된 id/version/provider/model과 고정 enum뿐이다. schema는
strict이므로 `prompt`, `userId` 같은 추가 필드는 거부된다. 오프라인 report는
receipt/request/suggestion/disposition id를 출력하지 않고 집계와 내부
provider/model attribution만 출력한다.

영속 저장소와 retention은 아직 결정하지 않았다. Prisma 또는 로그 writer를 붙일
때는 삭제·export·telemetry completeness와 운영 조회 권한을 함께 결정해야 한다.
현재 계약이 있다는 사실만으로 무기한 보관을 허용하지 않는다.

## 7. 실행과 주장 경계

`npm run report:prompt-refiner-receipts -- --input=<bundle.json>`은 자격증명과
provider 호출 없이 동결된 bundle을 읽는다. `--json`은 같은 aggregate를 JSON으로
낸다. malformed JSON, 16MiB 초과 입력, 100,000개 초과 배열, lifecycle 모순,
중복·orphan은 fail-closed한다.

이 report는 다음을 판정하지 않는다.

- 제안문의 의미 보존 또는 주입 저항 품질
- PLANNER-01/02, ROUTE-03 또는 다른 release gate 통과
- provider/model 채택, 비용 상한 승인 또는 rollout readiness
- 제품 adapter 활성화

그 판단에는 별도 사전등록·품질 자료·비용 승인과 사람의 disposition이 필요하다.

## 8. 다음 연결 단계

1. 모델, output cap, timeout, retry 0, per-request/stage 비용 상한을 사전등록한다.
2. 별도 승인된 작은 shadow가 execution bundle을 생성한다. 사용자에게 UI를
   노출하지 않으므로 disposition은 만들지 않는다.
3. 품질·비용·지연 증거가 승인된 뒤 제품 adapter와 서버 receipt writer를 붙인다.
4. 제안형 UI가 실제로 제공될 때만 disposition API와 선택·stale 관측을 연결한다.
5. 그 뒤에도 Refiner 결과의 Router 결합은 ROUTE-03의 별도 실험이다.
