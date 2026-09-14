# Prompt Refiner 제안형 UI 계약

- 상태: **composer 연결, 미제공**. `ChatInput`에는 제안 surface와 제어 seam이
  연결되어 있지만 어떤 제품 caller도 아직 `promptRefinerOffered=true`를 주지
  않는다. provider 호출, 과금, Router 입력 변경, Message schema 변경은 이
  회차의 범위가 아니다.
- 사용자 표면: `components/chat/PromptRefinerSuggestionPanel.tsx`
- 요청·결정 계약: `lib/promptRefinerSuggestion.ts`
- 모델 경계: `lib/promptRefinerModelPrompt.ts`

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
stale 제안은 적용 버튼을 남기지 않고 일반 요청 상태로 돌아간다. 음성 입력, 붙여
넣기, 대화 전환도 결과적으로 같은 exact-string 검사를 통과해야 한다.

제안 채택 버튼을 누른 순간에도 draft가 source와 다르면 fail-closed한다. 늦은
응답이 새 입력을 덮어쓰는 복구나 last-write-wins는 허용하지 않는다.

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

Refiner 모델을 답변 badge에 넣거나 Refiner 제안을 최종 답변으로 세는 것은 금지다.

## 6. 지연·비용·품질 경계

제안은 전송 전에 끝나므로 Refiner 대기 시간은 최종 답변의 TTFT 측정 시작보다
앞에 있다. 그렇다고 지연이 사라진 것은 아니다. 제안 준비 시간은 별도 지표로
측정해야 하고, 사용자가 기다리다 원문을 전송하거나 문장을 바꾼 stale 비율도
보고해야 한다.

이 UI 계약은 PLANNER-02, ROUTE-03 또는 품질 증거를 통과시킨 것이 아니다. 실제
provider adapter와 자동 요청을 활성화하려면 다음이 별도로 필요하다.

1. 비용이 고정된 Refiner 모델·출력 cap·timeout·재시도 0 계약
2. request/receipt와 사용자 선택률·stale·실패·지연 계측
3. 원문 대비 제안문 주입·의미 보존 평가
4. 승인된 품질 증거와 release gate disposition
5. server-owned offered 결정과 kill switch

과거 Router benchmark의 비용 승인은 이 호출에 상속되지 않는다.

## 7. 접근성·모바일

- proposal은 textarea와 같은 행에 들어가지 않고 별도 full-width 행을 쓴다.
- 상태는 `role=status`와 polite live region으로 읽힌다.
- 채택과 원문 유지가 둘 다 명시적 버튼이며 색만으로 구분하지 않는다.
- proposal 본문은 줄바꿈·긴 단어를 감싸고 자체 최대 높이 뒤에서 세로 스크롤한다.
- 어떤 상태도 textarea 위에 absolute/fixed overlay로 놓이지 않는다.

## 8. 검증

- `tests/promptRefinerSuggestion.test.mjs`: strict 입력, 주입 형태 JSON encoding,
  request 결속, stale 폐기, 원문/실행 분리
- `tests/client/promptRefinerSuggestionRender.test.tsx`: 미제공 시 null, 7개 언어,
  두 결정, 실패 문구, 내부 모델/우월성 표현 부재
- 기존 mobile composer·IME·zoom 검사는 실제 caller가 offered를 연결하는 다음
  회차에서 prompt-refiner-ready fixture를 추가해 다시 실행한다.
