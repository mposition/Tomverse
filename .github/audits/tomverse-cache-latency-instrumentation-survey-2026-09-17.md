# 캐시·체감 지연 계측 기준선 조사 — CACHE-01 / CHAT-LATENCY-01 (2026-09-17)

- 상태: **계측 조사 기록.** 코드·과금·flag·Router 실행을 바꾸지 않았습니다. 유료 호출 0회, DB 조회 0회.
- 요청: 권장 순서 5번 — "기존 집계의 공백부터 확인. 캐시 전면 활성화나 과금 변경은 별도".
- 코드 기준: origin/develop `94eb1ded`. 조사는 읽기 전용 탐색 에이전트 두 개가 수행했고,
  핵심 주장 네 개(아래 ✔)를 직접 grep으로 대조했습니다. 나머지 `file:line`은 조사 결과이며
  착수 시 다시 확인합니다.

## 1. CHAT-LATENCY-01 — 지금 기록되는 시간

| 경로 | 첫 답변이 보인 시간 | 완료 시간 |
| --- | --- | --- |
| 단일 Chat | **계산 불가.** `RoutingAttempt.firstVisibleTokenAt`·`RoutingRun.firstTokenMs` 컬럼은 있으나 어떤 호출도 값을 넘기지 않음 ✔ (`app/api/chat/route.ts`의 `completeInstrumentedDispatch` 호출 3곳) | 근사만. `RoutingRun.totalLatencyMs`는 예약 뒤~정산 직후 구간이고, **계측 모드 기본값이 `off`** ✔ (`lib/routingInstrumentationMode.ts:31`). 로그인 사용자는 user→assistant `Message.createdAt` 차이로 근사 가능 |
| 다중 모델 비교 | 계산 불가 | 모델별만. 비교 묶음 id(`comparisonId`)가 클라이언트에만 있어 "N개 답이 모두 끝난 시간"을 서버가 모름 |
| AI Review | `ComparisonReviewRun.durationMs` (비스트리밍이라 첫 결과 = 완료). **캐시된 Review는 run 행이 없어** 분포가 느린 쪽으로 치우침 | 같음. attempt의 `durationMs`에 예약·정산·health 기록이 섞여 모델 지연만 분리 불가 |
| Deep research | 해당 없음 | `PerplexityAsyncJob.submittedAt`→`completedAt`, 단 완료 시각이 클라이언트 poll에 의해 최대 약 5초 늦게 기록됨(추정) |
| 이미지 생성 | 해당 없음 | `ImageGeneration`의 시각 컬럼으로 가능 |
| 첫 성공 turn | 서버 표식 없음. 클라이언트 `first_response_completed` 이벤트뿐(동의 필요, 시간 필드 없음) | 같음 |

**동의 경계:** 클라이언트 이벤트(`ProductAnalyticsEvent`)는 동의가 있어야 전송되므로 AGENTS.md와
M5 계약대로 서버 신뢰성·지연 지표로 쓰지 않습니다. 서버 쪽 근거는 `RoutingRun/Attempt`,
`ComparisonReviewRun/Attempt`, `ChatCreditReservation`, `Message`, `ChatResponseAttempt`, 구조화 로그입니다.

### 지연 계측 공백 (우선순위 제안순)

1. **TTFT를 저장하지 않음** ✔ — 서버는 첫 visible token 시점을 알지만(`visibleTokenEmitted`)
   컬럼에 넘기지 않습니다. 첫 답변 지연 목표·회귀 경보·release gate 지표
   `end_to_end_ttft_increase_percent`의 근거가 없고, Router의 TTFT tie-break도 사실상 비어 있습니다.
2. **유일한 turn 단위 시간이 기본 off** ✔ — production 기준선을 만들 수 없습니다.
3. **요청 수신·스트림 종료 시점 없음** — 실제 대기 시간과 구간별 소요를 분리할 수 없습니다.
4. **Chat 완료 구조화 로그 없음** — Review처럼 DB 없이 보는 경로가 없습니다.
5. **다중 모델 묶음 key가 서버에 없음.**
6. **Review attempt 시간에 내부 처리 혼입**, 7. **캐시된 Review 미기록**,
   8. **Review 1차 결과 준비 시점 없음**, 9. **첫 성공 turn 서버 표식 없음(게스트는 행도 없음)**,
   10. **클라이언트 이벤트에 duration·상관 id 없음**, 11. **Chat 지연 집계·관리자 보고 없음**,
   12. **`decisionMicros`가 완료 시 계측 오버헤드로 덮어써짐**(Router 결정 지연 수치 신뢰 불가).

## 2. CACHE-01 — prompt cache 계측

- 명시적 캐시는 **Anthropic 직접 호출의 `chat_turn` 경로 하나**입니다(5분). 그 밖의 Anthropic 경로
  (native search·fallback·Review·요약·verify-item)는 marker를 끕니다.
- OpenAI·Gemini·DeepSeek·Moonshot 등은 공급자 쪽 자동 캐시이고, SDK가 주는 cache read(OpenAI는
  write 포함)를 `settleChatUsage`까지 전달하는 경로에서만 반영됩니다. DeepSeek은 전용 어댑터가
  `prompt_cache_hit_tokens`를 변환합니다.
- 캐시 토큰은 `ChatCreditReservation`·`ChatAttemptUsage`·`ProviderDailyUsage`에 저장됩니다.
  `unpricedCacheWriteTokens`는 `pricingSnapshot` JSON 안에만 있습니다.

### 캐시 계측 공백

1. **앱 데이터로 캐시 적중률을 보는 곳이 없음** ✔ — `lib/providerMonitoring.ts`는 캐시 컬럼을
   읽지 않고, 관리자 API에도 없습니다. 유일한 보고는 Anthropic Admin API(일×모델)라 OpenAI·Gemini·
   DeepSeek 등은 저장만 되고 분석되지 않습니다.
2. **경로별로 나눌 수 없음** — 예약 `source`가 `chat | comparison_review` 둘뿐이라 Review·요약·
   verify-item을 구분하지 못하는데, 캐시 정책은 경로별입니다.
3. **제목 생성·probe·provider 검증이 cache read를 버림** — 정가로 기록되고 일별 캐시 수치를 희석.
4. **기억 추출은 캐시 필드 자체가 없음.**
5. **미가격 cache write가 보이지 않음** — MiniMax는 Anthropic SDK를 쓰지만 write 요율이 없어,
   write 토큰이 오면 $0으로 기록되고 집계되지 않습니다(공급자 동작은 추정).
6. **비용 버킷 보정 도구가 write를 무시** — Anthropic write turn이 1.0×로 기대되어 1.25× 청구가
   과다 청구처럼 보입니다.
7. **조정 재생 시 비용 구성 컬럼이 0으로 들어가 총액과 불일치.**
8. 검증 안 된 cache 배율 1(Groq·Qwen plus/flash·Mistral 일부·Gemini 1개 tier), 9. 실패·sweep된
   attempt가 cache를 null이 아닌 0으로 저장, 10. 평가 도구가 write 비용을 누락(현재 경로 off),
   11. 1시간 캐시·검색 turn 캐시 판단에 필요한 호출 간격·반복 write 측정 없음.

## 3. 권장 다음 단위 (구현 승인 아님)

| 순서 | 단위 | 이유 | 과금·실행 영향 |
| --- | --- | --- | --- |
| 1 | TTFT 저장(지연 공백 1)과 Chat 완료 구조화 로그(4) | 컬럼·시점이 이미 있어 배선만 필요, 모든 지연 결정의 전제 | 없음(기록만). 요청 공용 파일이라 핵심 담당과 순서 조율 |
| 2 | 계측 모드를 staging에서 `observe`로 켜고 기준선 수집(2) | 코드 변경 없이 운영 유사 기준선 | flag·환경변수 변경은 사람 결정 |
| 3 | 캐시 적중률 읽기 전용 보고서(캐시 공백 1·2) — 기존 컬럼을 provider×model×source로 집계 | 저장된 데이터를 처음으로 읽음 | 없음(보고 전용) |
| 4 | 비용 버킷 보정의 write 반영(6)과 재생 시 비용 구성 컬럼(7) | 보고 수치가 틀리게 나옴 | 청구 금액 불변, 보고·보정만 |
| 5 | 제목·probe·검증·기억 추출의 cache read 전달(3·4) | 정가 과대 기록 | 비용 기록이 줄어드는 방향 — 과금 계약 검토 필요 |

전 공급자 캐시 강제 활성화, 1시간 TTL, 청구 산식 변경은 이 조사 범위 밖이며 위 1~3의 측정 뒤 별도 결정입니다.
