# Prompt Refiner receipt와 관측 계약

상태: **provider-independent 데이터·실행 사전등록·예약 authority 구현, 제품 수집 미연결**.

이 문서는 Prompt Refiner 한 요청에서 무엇을 관측하고 어떤 분모로 읽는지를
정한다. 현재 구현은 strict schema, 결속 검사, 순수 집계와 오프라인 report까지다.
provider adapter, API route, browser event writer, 제품 caller, Router 결합과 rollout
활성화는 없다. `lib/promptRefinerExecutionContract.ts`는 정확한
model/catalog/pricing identity와 4,096 output tokens, 15초 timeout, retry 0,
요청당 24,916 microUSD, 최대 100 dispatch의 단계 2,491,600 microUSD를 동결하지만
그 자체로 실행을 승인하거나 비용을 예약하지 않는다. 정적 pricing profile만
대조하지 않고 실제 비용 경로와 같은 `resolveModelPricing()`으로 100,000-token
요청의 effective input/output rate가 각각 0.2/1.2인지, effective
`maxOutputTokens`가 고정 요청 cap 4,096 이상인지 다시 확인한다. 따라서
`CHAT_MODEL_GPT_5_6_LUNA_*_USD_PER_MILLION` 환경 override나 미래 runtime registry
row가 어느 rate든 바꾸거나 effective output cap을 4,096 미만으로 내리면
`execution_contract_mismatch`로 fail-closed한다. 더 큰 effective cap은 모델·제품
경로의 능력일 뿐 Refiner 요청을 키우지 않는다. 미래 adapter는 resolved maximum이
아니라 계약의 4,096을 명시해야 한다.

resolver 전체를 exact pin으로 오해하지 않는다. checked-in profile의 identity,
routing, processing tier, pricing version/effective date, reasoning billing과 100,000-token
tier는 별도로 exact 검사하며 `priceSchedule`이 생기면 새 계약을 요구한다. 반면
cached-input multiplier는 prompt caching이 disabled라 이 계약의 비용을 바꾸지 않고,
generic `reservationOutputTokens`는 Refiner authority가 사용할 예약량이 아니다. 미래
authority는 이 계약의 4,096-token worst case를 예약해야 하며 generic reservation
cap으로 낮춰 잡을 수 없다.
server-only 원자 예약 authority는 별도 구현됐지만 stage seed/admin writer와 제품
caller가 없고 기존 v1 admission은 의도적으로 그대로다. 따라서 모든 다른 조건이
맞아도 v1은 `reservation_authority_unavailable`로 dispatch 전에 거절하며
`admitted: true` 경로가 없다. 이 authority는 DB transaction 안에서 고정 stage row,
model registry table `SHARE`, reservation row 순서로 잠근다. 따라서 pinned row가 없던
경우를 포함해 admin INSERT/UPDATE/DELETE가 runtime 검증과 consume 사이에 끼어들 수
없다. runtime model row와 effective pricing은 reserve와 consume 모두에서 다시
검증한다. requestId·고정 stage·canonical contract digest·server-minted reservationId를
결속하고 naive timestamp에는 `clock_timestamp() AT TIME ZONE 'UTC'`만 사용하는 만료·
1회 CAS consume·영구 terminal tombstone을
강제한다. 정적
profile 검사 결과를 과거에 캐시한 값이나 caller가 전달한 lease/atomic boolean은 성공
증거가 아니다. 새로 승인된 후속 계약만 authority의 consumed fact를 성공 admission에
연결할 수 있다.

## 0. Durable reservation authority 경계

- stage는 `prompt-refiner-shadow-v1` 한 행으로 제한되며 요청당 24,916 microUSD,
  최대 100개, 총 2,491,600 microUSD를 DB constraint와 transaction에서 함께 지킨다.
- reservation `BEFORE INSERT` trigger는 stage를 잠그고 정확한 계약·초기 상태·5분 TTL을
  검증만 한다. 성공한 행이 보이는 `AFTER INSERT` trigger만 실제 tombstone 집계와 stage
  counter를 결속한다. stage 최초 counter는 0/0이어야 하고 direct stage counter UPDATE는
  집계와 맞을 수 없어 거부된다. direct insert도 같은 예산을 소비하고 101번째·위조
  insert·unique 충돌은 행과 accounting을 함께 rollback한다. terminal timestamp도 DB
  trigger가 단 한 번의 clock으로 쓰며 만료 뒤 consume/release는 expired로 저장한다.
- expiry sweep은 DB clock 만료 조건과 `expiresAt, id` 순서를 SQL에서 적용하고 caller
  `limit`을 `FOR UPDATE`보다 먼저 적용한다. 따라서 limit은 update 수뿐 아니라 lock
  footprint도 제한한다.
- 계약 identity는 stage lifecycle(`approved`, `closed`)과 reservation lifecycle을 모두
  포함한 정렬 canonical JSON의 SHA-256 digest로 결속한다. reserve와
  consume은 runtime registry/pricing drift가 있으면 슬롯을 만들거나 사용하지 않는다.
- 동일 requestId 재요청은 stage와 registry 잠금 뒤 stage 상태/runtime 재검증보다 먼저
  기존 사실을 읽는다. active lease만 성공 fact이며 terminal 행은 명시적 non-success
  결과다. 어떤 경우에도 같은 requestId로 슬롯을 더 만들거나 재사용하지 않는다.
  released/expired/consumed 행도 100개 상한에 남고 삭제·재사용·환급하지 않는다.
- authority table과 반환값에는 prompt, content, user, conversation, provider 오류를
  저장하지 않는다. reserve/consume/release/expire의 content-free fact만 반환한다.
- migration은 stage를 seed하지 않는다. 제품/API/script import도 없으므로 이 구현만
  배포해도 provider/model 호출이나 비용 지출을 만들 수 없다.
- 미래 dispatch는 consume이 검증하고 반환한 reservation의 정확한 contract digest와
  checked-in execution/reservation contract constants를 그대로 사용해야 한다. consume 뒤 registry를
  다시 읽어 모델·가격·cap을 재해석하면 TOCTOU 보호를 무효화하므로 금지한다.

## 1. 하나의 변경 가능한 행 대신 두 개의 불변 사실

실행과 사용자 반응은 서로 다른 시점과 신뢰 경계에서 생긴다.

1. `PromptRefinerExecutionReceipt`는 서버가 쓴다. 어느 provider/model/adapter가
   호출됐는지, suggestion을 만들었는지, 실패 또는 dispatch 전 거절이었는지,
   서버 시각·token·실비용을 기록한다. `retryCount`는 literal `0`만 허용하며 이
   계약에는 재시도가 없다.
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
| `failed` | dispatch 이후 provider/response 검증에서 suggestion을 만들지 못했다 | 포함, 실패 |
| `refused_before_dispatch` | admission/adapter가 provider 호출 전에 거절했다 | 제외 |

`failed`와 `refused_before_dispatch`를 합치지 않는다. provider에 보내지 않은 요청은
provider 신뢰성에 대해 아무 말도 하지 않기 때문이다. 따라서 `failed`는 반드시
dispatch 시각을 가지며 `admission` layer를 쓸 수 없고, dispatch되지 않은
`admission`/`adapter` 실패는 `refused_before_dispatch`로만 기록한다.
`failureLayer`는 `admission`, `adapter`, `provider`, `response_validation` 중 하나이며
성공만 `none`이다.
`adapter` layer는 dispatch 전 `adapter_unavailable` 거절에만 사용하며 dispatch 뒤
adapter 실패로 가장한 receipt는 거부한다.
`failureCode`는 고정 enum이고 provider 오류 본문을 담을 문자열 필드는 없다.
`eligibility_refused`, `execution_not_approved`, `execution_contract_mismatch`,
`reservation_authority_unavailable`, `adapter_unavailable`은 pre-dispatch 전용이고,
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

1. 구현된 사전등록을 독립 검토와 통합 CI로 검증한다. 이는 실행 승인이 아니다.
2. 별도 승인된 작은 shadow가 execution bundle을 생성한다. 사용자에게 UI를
   노출하지 않으므로 disposition은 만들지 않는다.
3. 품질·비용·지연 증거가 승인된 뒤 제품 adapter와 서버 receipt writer를 붙인다.
4. 제안형 UI가 실제로 제공될 때만 disposition API와 선택·stale 관측을 연결한다.
5. 그 뒤에도 Refiner 결과의 Router 결합은 ROUTE-03의 별도 실험이다.

## 9. provider-free shadow harness 관측 경계

`npm run shadow:prompt-refiner`는 체크인된 `prompt-refiner-shadow-corpus-v1`
합성 fixture 16개만 처리한다. corpus version·content digest·배열 순서와 실행 source의
full commit SHA 및 고정 allowlist exact bytes를 함께 고정한다. provider/model/API,
credential lookup, 예약 authority, stage writer, 제품 caller와 연결하지 않으므로
`providerCalls = 0`, `costMicroUsd = 0`은 알려진 사실이다.
sourceRef와 정렬된 allowlist file-hash map의 canonical identity digest는 journal과
witness 최초 header에 함께 기록하며 resume 때 exact match를 강제한다. allowlist와
`.gitattributes` 자체의 LF pin은 Windows `core.autocrlf=true` 정상 checkout도 같은
Git bytes로 만든다. Git child는 caller env보다 우선한 `GIT_NO_LAZY_FETCH=1`,
`GIT_NO_REPLACE_OBJECTS=1`과 비대화형 설정 아래에서만 실행하고 commit·allowlist blob의
로컬 존재를 먼저 확인한다. replace ref는 고정 SHA 해석에 관여할 수 없고,
partial/blobless promisor clone의 누락 객체를 원격에서 가져오는 것도 허용하지 않는다.
source cap은 corpus 전용 cap, `package-lock.json` 4 MiB, 나머지 allowlist 1 MiB이고,
Git capture는 8 MiB로 제한한다. blob 크기를 먼저 검사하므로 cap 초과는 모호한 child
buffer 실패가 아니라 `source_file_byte_limit`으로 기록된다.

source identity에는 sourceRef, pinned repository paths와 `package-lock.json` bytes가
들어간다. 설치된 `node_modules`의 실제 bytes, package-manager cache, install 환경·명령,
registry 응답 또는 install attestation은 포함하지 않는다. 이 provider-free 결과는
dependency installation provenance나 설치 결과 동일성의 증거가 아니다.

모델 모양의 fixture output은 `parseBenchmarkJson()`의 syntax·duplicate key·complexity
제한, `strictBenchmarkObject(["refinedPrompt"])`의 exact field 검사, 기존 prompt
byte/character bound 순서로 fail-closed한다. repair, coercion, fence 제거 또는 부분
salvage는 없다. audit output과 journal에는 사용자 prompt·fixture output·proposal
bytes 또는 그 **per-item content digest**, 사용자·conversation·session 정보와 provider
오류문을 쓰지 않는다. 체크인된 합성 집합의 `corpusDigest`와 source identity hash는
재현 provenance로 저장하며 사용자 콘텐츠 receipt로 취급하지 않는다.

하네스 관측은 다음 두 값을 섞지 않는다.

- structural boundary: sourceText가 canonical JSON data message 밖으로 벗어났는지의
  구조 검사다.
- behavioral fixture outcome: 로컬 fixture output 파싱 결과가 동결 expected와 같은지의
  deterministic 회귀 검사다.

structural violation 0은 실제 모델의 instruction compliance 또는 행동상 prompt
injection resistance를 증명하지 않는다. behavioral match도 실제 모델 품질을 측정하지
않는다. 각 값은 독립 population과 분자를 가진다.

journal은 intent-before-evaluation, SHA-256 chain, 별도 registration witness, `wx` lock,
append 후 `fsync`와 strict terminal state를 사용한다. terminal 없는 intent는 unknown으로
남겨 재평가하지 않는다. clean interruption과 `case_limit` stop만 재개 가능하고,
structural/behavioral mismatch, truncation, chain/witness disagreement, duplicate/conflicting
terminal 또는 stale lock은 자동 복구하지 않는다. 로컬 witness는 악의적인 관리자나 두
파일의 동시 rollback을 막는 외부 원장이 아니므로 실제 실행 권한의 대체물이 아니다.
마지막 정상 terminal 뒤 complete event 전 중단은 별도 resume event 없이 검증된 terminal
집합에서 complete를 확정하고, 마지막 case mismatch는 remaining 0인 non-resumable stop으로
정상 재생한다. `max-cases`는 부호 없는 ASCII 10진 정수 표기만 받는다.

세부 운영 계약과 정확한 digest는
[`prompt-refiner-shadow-harness.md`](../ops/prompt-refiner-shadow-harness.md)에 있다.
이 하네스가 completed라는 사실은 실제 shadow 실행, 품질 승인, release gate, 제품 연결
또는 rollout 승인이 아니다.
