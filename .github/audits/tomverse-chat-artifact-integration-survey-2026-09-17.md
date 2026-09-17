# AI 생성 파일의 Chat 통합 검증 준비 — CHAT-ART-01 (2026-09-17)

- 상태: **검증 준비 조사 기록.** 코드·정책·flag를 바꾸지 않았습니다. 유료 호출 0회.
- 요청: 권장 순서 6번 — "지원 모델·검색 조합·다운로드·권한·재진입 검증 준비. UI 계약이 준비된 부분부터 통합".
- 코드 기준: origin/develop `94eb1ded`. 읽기 전용 탐색 에이전트가 조사했고,
  `gemini-3-7-flash`가 능력 표에 없다는 점은 직접 grep으로 대조했습니다(✔).
- 정책: `docs/policy/generated-artifacts.md`, Auto: `docs/ui-contracts/auto-model-selection.md`.

## 1. 지원 모델 × 웹 검색 행렬 (로그인, 저장된 대화)

판정 순서는 `planGeneratedArtifactTool()`: 이미지 대화 → 능력 표 미등록(`model_unverified`) →
native 검색 충돌 → 게스트(`sign_in_required`, tool은 등록) → 대화 없음. 웹 검색 `auto`는 은퇴한
저장값이라 `off`와 같게 동작하고, 검색은 `always`일 때만 실행됩니다.

| 활성 모델 | 검색 off | 검색 always | 이유 |
| --- | --- | --- | --- |
| gpt-5-6-sol·terra·luna, gpt-5-5, gpt-5-5-thinking | 파일 가능 | **불가** | OpenAI native 검색이 강제(`toolChoice: "required"`) → `native_search_conflict` |
| gpt-5-4-mini | 가능 | 가능 | 검색 자체가 미검증이라 실행되지 않고 파일 tool 유지 |
| claude-fable-5, opus-4-8, sonnet-5, haiku-4-5 | 가능 | 가능 | Anthropic 검색은 강제가 아니어서 공존 |
| gemini-3-6-flash, gemini-3-1-pro, gemini-2-5-flash | 가능 | 가능 | 앱 관리 검색(Brave)이라 native 충돌 없음 |
| **gemini-3-7-flash** | **불가** | **불가** | 활성·검색 가능이지만 능력 표에 없음 ✔ (`model_unverified`) |
| grok·deepseek·mistral·kimi·minimax·qwen·glm·sonar 계열 | 불가 | 불가 | 미검증 모델 fail-closed (설계대로) |
| sonar-deep-research | — | — | 파일 계획 자체 없음 |

게스트는 검증 모델에서 blocked 카드와 로그인 안내를 받습니다. 다만 검색 충돌 검사가 게스트 검사보다
앞이라 OpenAI 모델 + 검색 on 게스트는 `native_search_conflict`를 받습니다(게스트가 검색을 켤 수
있는지는 미확인).

## 2. 이미 있는 검증

- 다운로드 route(`tests/server-contract/artifact-download-route.test.ts`): 비로그인 401, 남의 파일·없는
  id 404, 잠금 423·해제 후 제공, 저장소 key 비노출, 실패 행·모르는 형식 거절.
- 카드 e2e(`tests/e2e/generated-artifact-card.spec.ts`, mock): 형식별 카드, `/api/artifacts/{id}` 다운로드와
  파일명, 423 문구, 실패·`turn_incomplete`·재시도, 게스트 blocked, 로그인 카드 새로고침 복원(단일 모델),
  320px·좁은 패널, 접근성, 검색+파일 한 답변.
- `turn_incomplete` 기록·collector(게스트 거절, 3개 상한)·DB 통합·durable 복구 카드·정책 분기 unit test.
- 렌더 위치는 `ChatMessageList`의 한 곳이고 패널마다 마운트되므로 단일 답변·Auto·다중 패널이 같은 코드를
  씁니다. Auto 답변에는 `AutoRoutedByBadge`가 함께 붙고 카드의 모델명은 실제 라우팅된 모델입니다.
  파일 카드 전용 UI 계약 문서는 없고 정책 §9가 카드 계약입니다.

## 3. 통합·검증 공백

**유료 호출 없이 가능**

1. **Auto가 파일 생성 능력을 보지 않음** — 파일을 요청한 turn을 미검증 모델로 보낼 수 있습니다.
   후보 단계에서 거절할지·선호할지는 **제품 결정**이 필요합니다(Router 담당과 조율).
2. **Auto 사용자에게 "다른 모델을 고르세요" 안내** — `model_unverified` 블록 문구가 Auto에서는 맞지 않습니다.
3. **gemini-3-7-flash 누락** — 실수인지 실측 대기인지 확인 필요. 활성 OpenAI·Anthropic·Google 모델 중
   의도적으로 뺀 목록을 고정하는 test 제안.
4. **Auto 파일 turn test가 어느 층에도 없음** — route 계약(미검증으로 라우팅 → off 블록, 검증 모델 →
   라우팅된 modelId로 tool 등록)과 Auto 배지+카드 e2e.
5. **새로고침 복원이 실제 데이터 경로로 검증되지 않음** — 대화 GET → `publicChatMessage` artifact 필드 계약 test.
6. **모바일 실제 다운로드 미검증** — `@ui-risk` 실행이 mobile-safari를 제외하고, 다운로드 helper도
   실제 Safari 관측이 없다고 적습니다(실기기는 사람).
7. **Auto UI 계약·정책 §10에 파일 언급 없음.**
8. **starter "스프레드시트" 카드가 선택·라우팅 모델의 파일 능력을 보지 않음.**

**유료 호출 필요 (승인 요청 대상, 이번에 실행하지 않음)**

| 확인 | 호출 수 | 판별하는 것 |
| --- | --- | --- |
| 능력 표 13개 모델 × 검색 off, xlsx 1건씩 | 13 | "검증됨" 표기의 실제 근거(저장소에 실측 기록 없음) |
| Anthropic 4 + Google 3 × 검색 always | 7 | 검색과 파일의 공존 |
| OpenAI 1 × 검색 always | 1 | 파일 tool이 실제로 빠지고 안내가 나오는지 |
| 소계 | **약 21** (파일을 열어 확인까지 하면 사람 확인 포함 약 42건) | |
| Auto 파일 turn (검증 모델·미검증 모델·게스트) | 2~3 | staging에서 Auto가 켜져 있어야 함(현재 꺼짐) |
| gemini-3-7-flash 추가 시 | 약 2 | 표에 넣을 근거 |

## 4. 권장 다음 단위 (구현 승인 아님)

1. **유료 없이:** 공백 3의 "의도적 제외 목록" test, 공백 5의 복원 계약 test, 공백 4의 route 계약 test
   (Auto 경로는 mock 라우팅). UI 계약이 이미 있는 카드 경로라 바로 착수 가능.
2. **결정 필요:** 공백 1·2(Auto 후보 정책과 안내 문구) — Router 담당과 순서 조율.
3. **승인 후:** 위 약 21회 실측으로 능력 표의 근거를 남김.
