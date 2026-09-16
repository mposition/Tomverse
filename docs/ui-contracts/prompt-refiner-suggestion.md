# Prompt Refiner 제안형 UI 계약

- 상태: **실제 composer 무과금 검증 연결, 제품 미제공**. 서버는 default-off
  rollout과 환경 kill switch, adapter readiness를 합쳐 최종 offer를 정한다.
  현재 준비된 adapter는 loopback Playwright fixture뿐이어서 실제 `ChatInput`의
  상태 전이는 검증되지만 운영 환경은 항상 `off`다. provider 호출, 과금, Router
  입력 변경, Message schema 변경은 아직 연결하지 않았다.
- 사용자 표면: `components/chat/PromptRefinerSuggestionPanel.tsx`
- 요청·결정 계약: `lib/promptRefinerSuggestion.ts`
- 모델 경계: `lib/promptRefinerModelPrompt.ts`
- 실행 사전등록: `lib/promptRefinerExecutionContract.ts`

이 단계의 목적은 모델을 먼저 붙이는 것이 아니라, 모델이 붙었을 때 사용자 원문과
라우팅 입력이 조용히 같은 것으로 취급되지 않도록 경계를 고정하는 것이다.

## 1. 제안이지 자동 전송이 아니다

Refiner는 답을 만들지 않고 현재 composer 문장을 다시 쓰는 제안을 만든다. 결과는
전송 전에 별도 행에 표시되며 사용자는 `이 문장 사용` 또는 `원문 유지`를 선택할
수 있다. 어느 선택도 자체적으로 전송을 시작하지 않는다. 전송 버튼과 IME 규칙은
기존 composer가 계속 소유한다.

`offered=false`는 비활성 teaser가 아니라 아무 UI도 렌더하지 않는다. 실제 호출을
할 수 없는 사용자가 기능을 약속받는 상태를 만들지 않는다.

## 2. 원문과 실행 입력은 서로 다른 자료다

채택 시에도 사용자가 작성한 Message는 원문을 보존해야 한다. Refiner 제안은
Router와 최종 답변 모델이 읽을 `executionPrompt`일 뿐, 사용자의 저작물을
소급해서 바꾸는 값이 아니다.

`resolvePromptRefinerDecision()`은 이를 다음처럼 분리한다.

| 결정 | `persistedUserPrompt` | `executionPrompt` |
| --- | --- | --- |
| 제안 채택 | 사용자가 작성한 원문 | 화면에서 확인한 제안문 |
| 원문 유지 | 사용자가 작성한 원문 | 같은 원문 |

후속 server 연결은 이 결과를 Message 저장과 Router 입력에 각각 연결해야 한다.
제안문을 user Message 본문으로 저장하거나, 원문을 Router에 보내면서 `accepted`로
기록하는 구현은 계약 위반이다.

## 3. 한 요청은 한 draft snapshot에만 속한다

request에는 exact `prompt`와 opaque `requestId`만 들어간다. 응답의 requestId가
다르거나, 응답을 기다리는 동안 사용자가 한 글자라도 바꾸면 그 응답은 stale이다.
stale 제안은 적용 버튼을 남기지 않고 일반 요청 상태로 돌아간다. 음성 입력과 붙여
넣기는 같은 exact-string 검사를 통과해야 한다. 이 문자열 binding과 별도로
`identity + mounted surface + conversation`이 하나의 scope identity다. 대화·계정·surface
중 하나라도 바뀌면 draft 문자열이 byte-identical이어도 in-flight·ready 제안을 모두
폐기하며, 새 scope는 이전 scope의 resolution을 상속하지 않는다.

제안 채택 버튼을 누른 순간에도 draft가 source와 다르면 fail-closed한다. 늦은
응답이 새 입력을 덮어쓰는 복구나 last-write-wins는 허용하지 않는다.

제어 상태는 caller가 소유한다. `onPromptRefinerDecision`을 받은 caller는 채택과
원문 유지 **모두**에서 `ready`를 즉시 벗어나야 한다. 특히 원문 유지는 textarea
값을 바꾸지 않으므로 callback 외에 proposal을 닫을 경로가 없다. 채택 뒤에는
`isPromptRefinerResolutionCurrent()`로 현재 draft가 resolution의
`displayPrompt`와 같은 동안에만 resolution을 유지한다. 사용자가 한 글자라도 더
편집하면 기존 resolution을 폐기하고 그 시점의 draft를 새 사용자 입력으로 다룬다.
이 규칙 없이 예전 `persistedUserPrompt`·`executionPrompt`를 다음 전송에 재사용하면
계약 위반이다.

## 4. Refiner가 읽을 수 있는 것은 현재 턴 텍스트뿐이다

`promptRefinerRequestSchema`는 strict object이며 다음 필드를 받지 않는다.

- 대화 history
- 첨부 파일, 파일명 또는 추출 본문
- Memory 및 assistant profile knowledge
- 선택 모델, Router 후보 또는 provider identity
- 도구 및 검색 결과

미래 provider adapter는 `promptRefinerModelMessages()`만 사용한다. 사용자 텍스트는
JSON의 `sourceText` 값으로 인코딩되며, system instruction은 이를 실행할 지시가
아닌 다시 쓸 비신뢰 자료로 취급한다. Refiner는 작업을 답하거나, 숨은 context를
추정하거나, 원문 속 role 변경·도구 호출·비밀 공개 지시를 자기 지시로 실행해서는
안 된다. 이것이 모델 출력이 다음 모델의 지시로 승격되는 경계에서 필요한 최소
주입 방어다.

## 5. provenance와 표시 책임

브라우저에 주는 제안에는 provider나 Refiner model id를 싣지 않는다. 화면도 이를
표시하지 않는다. 이는 답변 출처를 숨기기 위한 것이 아니라 역할을 분리하기
위해서다.

- Refiner receipt: 내부 실행 기록에서 모델·비용·버전·실패를 추적한다.
- 사용자 decision provenance: requestId, suggestionId, refinerVersion,
  `current_user_turn_text_only`, accepted/kept-original을 추적한다.
- 최종 답변 provenance: 실제 답을 만든 provider/model을 기존 답변 badge가
  표시한다.

내부 기록의 형식과 분모는
[`docs/policy/prompt-refiner-observability.md`](../policy/prompt-refiner-observability.md)가
소유한다. 서버 실행 receipt와 사용자 disposition receipt는 별개이며, 어느 쪽에도
원문·제안문·digest·user/conversation/session identity 또는 provider 오류 본문을
담지 않는다. browser response에는 이 receipt도 provider/model attribution도 싣지
않는다.

Refiner 모델을 답변 badge에 넣거나 Refiner 제안을 최종 답변으로 세는 것은 금지다.
브라우저의 `refinerVersion`은 `suggest-vN` 형태의 Tomverse prompt-contract
버전만 허용한다. provider나 model 이름·별칭·release를 이 필드에 인코딩해서
내부 receipt 경계를 우회하면 안 된다.

## 6. 지연·비용·품질 경계

제안은 전송 전에 끝나므로 Refiner 대기 시간은 최종 답변의 TTFT 측정 시작보다
앞에 있다. 그렇다고 지연이 사라진 것은 아니다. 제안 준비 시간은 별도 지표로
측정하고, 사용자가 기다리다 원문을 전송하거나 문장을 바꾼 stale 비율도 보고한다.
성공 지연은 성공 suggestion만의 p50/p95, provider 실패율은 dispatch된 execution만,
stale은 모든 request, 명시적 선택률은 성공 suggestion, 채택률은
accepted+kept-original을 각각 분모로 쓴다. 서로 다른 분모를 한 conversion 수치로
합치지 않고, 빈 분모는 0이 아니라 `null`이다.

이 UI 계약은 PLANNER-02, ROUTE-03 또는 품질 증거를 통과시킨 것이 아니다. 실제
provider adapter와 자동 요청을 활성화하려면 다음이 별도로 필요하다.

1. 비용이 고정된 Refiner 모델·출력 cap·timeout·재시도 0 계약
   (provider-independent 사전등록과 server-only 원자 예약 authority는 구현됨. 단,
   stage seed/admin writer·제품 caller가 없고 v1 admission은 변경하지 않아 항상
   `reservation_authority_unavailable`로 dispatch 전에 거절하며 실제 adapter·dispatch
   권한은 없음. authority는 stage→model registry table `SHARE`→reservation 순서로
   잠그고 requestId·stage·canonical contract digest·server reservationId를 결속하며
   잠금 뒤 DB clock 만료·1회 consume·영구 tombstone을 강제함. BEFORE INSERT는 검증·잠금만,
   AFTER INSERT는 성공한 tombstone 집계와 counter 결속만 맡으며 stage는 반드시 0/0에서
   시작함. direct stage counter UPDATE, direct/unique/101번째 insert 우회는 거부 또는 함께
   rollback됨. naive timestamp의 clock은 명시적 UTC이며 terminal timestamp도 DB가
   소유하고 늦은 consume/release는 expired가 됨. expiry sweep의 SQL limit은 update와
   row-lock footprint를 함께 제한함.
   기존 request는 active와 terminal을 구분하며 terminal은 usable lease가 아님.
   정적 profile과 `resolveModelPricing()`의 effective input/output rate가 모두 exact
   pin과 일치하고 effective output cap은 4,096 이상이어야 함. 더 큰 capability에도
   adapter는 계약 cap 4,096을 명시하며 generic cached/reservation 설정을 이 계약의
   비용·예약량으로 바꾸지 않음. reserve와 consume은 모두 runtime row를 전달해
   critical path 안에서 이 gate를 다시 통과함. 미래 dispatch는 consume 결과의 exact
   digest와 checked-in execution/reservation contract constants를 사용하고 registry를 다시
   읽어 재해석하지 않음)
2. request/receipt와 사용자 선택률·stale·실패·지연 계측 (provider-independent
   schema와 오프라인 집계는 구현됨; writer·저장소·제품 수집은 미구현)
3. 원문 대비 제안문 주입·의미 보존 평가
4. 승인된 품질 증거와 release gate disposition
5. server-owned offered 결정과 kill switch

5번의 구조는 현재 구현됐다. `feature.promptRefinerEnabled`는 literal `"true"`만
허용하는 default-off AppSetting이며, `PROMPT_REFINER_KILL_SWITCH`에 공백이 아닌
값이 하나라도 있으면 rollout보다 먼저 꺼진다. 그러나 rollout 허용만으로는 UI가
나오지 않는다. 같은 서버 요청에서 실제 adapter readiness까지 참이어야 하며,
현재 그 조건을 만족하는 것은 `isE2EFixtureMode()` 안의 무과금 fixture뿐이다.
애플리케이션에는 rollout writer를 두지 않았다. 따라서 이 구조가 생겼다는 사실은
활성화 승인이나 유료 adapter 승인이 아니다.
제품 adapter가 하나도 없는 현재는 AppSetting을 매 화면마다 조회하지 않는다.
`isPromptRefinerEnabled()`는 model-facing adapter가 준비된 뒤 그 readiness 경계
안에서만 호출할 rollout reader다. `promptRefinerProductAdapterReady()`가 현재 false를
답하므로 이 reader는 실행되지 않고 DB 왕복도 없다. 이는 등록을 만족시키기 위한
가짜 활성 경로가 아니라, 제품 adapter가 생길 때 readiness 구현과 함께 바꿀 단일
서버 seam이다. fixture는 같은 strict default-off·kill switch 해석을 고정된 opt-in
값에 적용한다.

과거 Router benchmark의 비용 승인은 이 호출에 상속되지 않는다.

## 7. 접근성·모바일

- proposal은 textarea와 같은 행에 들어가지 않고 별도 full-width 행을 쓴다.
- 상태는 `role=status`와 polite live region으로 읽힌다. 요청 버튼이 사라진 뒤
  **새 requesting·failed·ready 상태 identity가 도착한 경우에만** 해당 status나
  retry 버튼이 스크롤을 움직이지 않고 포커스를 이어받는다. identity는 status와
  requestId, ready인 경우 suggestionId까지 합친 값이다. 이미 결속된 상태로 처음
  mount됐거나 draft 편집 뒤 같은 identity가 다시 보이는 경우에는 textarea
  포커스를 빼앗지 않는다. 결정을 마치면 textarea로 포커스를 돌린다.
- 채택과 원문 유지가 둘 다 명시적 버튼이며 색만으로 구분하지 않는다.
- 모든 Refiner 버튼은 데스크톱과 모바일 모두 최소 44px 높이다. 빈 입력, 16,000자
  초과, 32KiB 초과와 composer 잠금은 화면 문구와 접근 가능한 이름으로 이유를
  함께 제공한다. 글자 조합 중에는 매 음절마다 행 높이가 바뀌지 않도록 기본 화면
  문구를 유지하고, 비활성 control의 접근 가능한 이름에만 조합 중 이유를 넣는다.
- proposal 본문은 줄바꿈·긴 단어를 감싸고 자체 최대 높이 뒤에서 세로 스크롤한다.
- 어떤 상태도 textarea 위에 absolute/fixed overlay로 놓이지 않는다.

## 8. 검증

- `tests/promptRefinerSuggestion.test.mjs`: strict 입력, 주입 형태 JSON encoding,
  request 결속, stale 폐기, 원문/실행 분리
- `tests/client/promptRefinerSuggestionRender.test.tsx`: 미제공 시 null, 7개 언어,
  두 결정, 44px target, disabled reason, ready live status, 실패 문구,
  내부 모델/우월성 표현 부재
- `tests/e2e/prompt-refiner-chat-input.spec.ts`: `/chat`의 실제 `ChatPageClient` →
  mobile shell → `ChatInput` 경로에서 default-off, 두 결정 뒤 textarea
  focus 복귀, accepted fixture의 submit 거부, 편집·새 채팅의 pending response
  폐기, invalid response 실패·retry, 16,000자 경계, IME 차단, 320px + 200% text,
  200% zoom 상당 viewport, 44px action과 가로 overflow 부재를 검사한다.
- `tests/e2e/prompt-refiner-focus.spec.ts`: E2E 전용 fixture에서 초기 mount가
  textarea focus를 빼앗지 않는지, 새 requesting·failed·ready 도착에는 한 번씩
  focus가 이동하는지, draft를 바꿨다가 같은 source로 되돌려도 같은 제안이
  textarea caret를 다시 빼앗지 않는지, 잠긴 failed 상태에서 실패한 focus가 잠금
  해제 후 다시 전달되는지, 그 사이 상태가 숨겨졌다면 예약 focus가 만료되는지
  desktop·mobile Chromium DOM으로 검사한다. fixture route는
  `isE2EFixtureMode()` 밖에서 404이며 provider·Router·과금 경로가 없다.

static render test 자체는 focus effect를 실행하지 않는다. 격리 fixture는 panel의
mount·requesting·failed·ready·동일 상태 재등장 focus를 검증한다. 다만 실제 `ChatInput`
fixture caller는 두 decision 뒤 textarea로 focus를 돌리는 경로와 mobile composer
전체의 IME·320px·200% 조합을 검증한다. 이 caller는 서버가 loopback + auth bypass +
database bypass를 모두 확인하고 전용 cookie를 받은 경우에만 `e2e_fixture` mode를
내린다. 실제 provider를 쓰는 product mode는 타입에도 없으며, AppSetting row만으로
그 mode를 만들 수 없다.
fixture에서 채택한 resolution은 synthetic 문장을 user Message로 오인하지 않도록
submit을 fail-closed한다. 제품 caller는 원문/실행문 분리와 receipt 영속화를 먼저
구현해야 이 guard를 제품 mode로 대체할 수 있다.

`npm run check:prompt-injection`의 PLANNER-03 report는 memory·attachment·profile과
함께 `promptRefinerModelMessages()`를 `prompt-refiner` 명시적 surface로 실행한다.
동일 adversarial corpus의 모든 항목에 대해 system 규칙이 먼저인지, 독립적으로
고정한 보안 규칙 여섯 줄만 정확한 순서로 있는지, 메시지가 정확히 2개인지, user 메시지가
`inputScope + sourceText`만 가진 canonical JSON인지, 원문 bytes가 그대로
복원되는지를 검사한다. 역할 순서·필수 규칙·JSON 경계·추가 context 채널을 일부러
깨뜨린 회귀 테스트가 감사기가 실제로 실패하는지도 고정한다.

이는 **builder의 구조적 PLANNER-03 증거**일 뿐 실제 모델이 모든 주입문을 무시한다는
품질 인증이나 provider adapter 승인, Refiner 활성화 또는 Router 결합 승인이 아니다.
실제 caller는 이 builder를 단독 입력 경로로 사용해야 하고, 비용·receipt·의미 보존·
model-output 평가 등 §6의 나머지 조건은 별도로 충족해야 한다.
