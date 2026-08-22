# Auto UI 배선 — 다음 PR로 넘기는 항목

제품 경계 결정 기록 v1.2 §7의 "숨은 UI 배선" 중 **아직 하지 않은 부분**입니다.
계약: `docs/ui-contracts/auto-model-selection.md`.

## 1. 이번 변경에서 끝난 것

- **제품 판정 공유** — `lib/autoProductBoundary.ts`. 표면 진입 · `offered` ·
  턴 라우팅 셋이 같은 함수를 씁니다. 판정 순서와 회귀 테스트는
  `tests/autoProductBoundary.test.mjs`와
  `tests/integration/conversation-auto-selection-route.db.test.ts`에 있습니다.
- **랜딩 CTA 목적지의 서버 결정** — `lib/productEntryDestination.ts` +
  `lib/landingWorkspaceEntry.ts`. 비적격 방문자를 `/chat`으로 보냈다가 튕기게
  하지 않습니다.
- **AI Review gradient 회수** — `AutoRoutingToggle`이 예약된 cyan→blue→purple을
  쓰고 있었습니다. 두 Auto 컴포넌트가 이제 `check:accent-tokens`의
  `GUARDED_FILES`에 있습니다.

## 2. 아직 하지 않은 것 — 왜 별도 PR인가

`AutoRoutingToggle`과 `AutoRoutedByBadge`는 **여전히 어디에도 마운트되지
않았습니다.** 마운트는 다음을 한 변경에 요구합니다.

1. `autoSelection.offered`를 서버 응답에서 클라이언트 상태로 배선
   (현재 `app/api/conversations/[conversationId]` 응답에만 있고 클라이언트가
   읽지 않습니다).
2. 토글을 `ModelPickerPanel` 상단에 배치 — 이 파일은 **release blocker 계약**
   두 개(`docs/ui-contracts/mobile-chat-composer.md`,
   `docs/ui-contracts/image-generation-workspace.md`)의 대상입니다.
3. 배지를 메시지 헤더에 배치 — **실제 응답한 모델만** 표시해야 하고,
   fallback한 턴에는 렌더링하면 안 됩니다. 데이터(`selectionDisclosure`,
   `X-Chat-Routed-*` 헤더)는 이미 서버에 있으나 클라이언트로 오지 않습니다.
4. e2e 회귀 — bounding-box · overlap · horizontal-overflow · **한국어 IME** ·
   **320px** · **200% 확대**를 desktop과 mobile 프로젝트 양쪽에서.
5. 필수 증거 — `offered: false`에서 **두 컴포넌트가 아무것도 렌더링하지
   않는다**는 테스트. 계약 §1이 존재하는 이유가 "저장하고 아무것도 바꾸지 않는
   토글은 없는 것보다 나쁘다"인데, 지금 그 컴포넌트들은 마운트된 적이 없어
   **계약이 한 번도 실행된 적이 없습니다.**

이것은 Playwright가 실제 앱과 DB를 띄워야 검증되는 작업이고, release blocker
계약 두 개를 건드립니다. 검증 없이 섞으면 그 계약들이 통과했는지 말할 수 없게
됩니다.

## 3. 그 PR이 지켜야 할 것

- `offered=false`면 **아무것도** 렌더링하지 않습니다. disabled 상태도, 회색 행도,
  "곧 제공" 문구도 없습니다.
- Review 대화에서는 `offered`가 **항상** false입니다 — 이미 서버가 그렇게
  답하며, `tests/integration/conversation-auto-selection-route.db.test.ts`가
  고정합니다.
- **readiness나 flag를 켜지 않습니다.** 세 gate는 전부 `pending`이고
  `TOMVERSE_AUTO_ROUTER_UI_ENABLED`는 off입니다.
- 금지어 — better · best · optimal · smartest와 그 번역
  (`tests/autoRoutingUi.test.mjs`가 빌드를 실패시킵니다). "가장 좋은", "최적"도
  같습니다.
- 배지는 **실제 응답한 모델**만 표시합니다. fallback한 턴에는 배지가 없습니다 —
  있으면 일어나지 않은 라우팅 결정을 주장하는 것입니다.
- **Prompt Refiner provider는 표시하지 않습니다.** Refiner는 답변한 모델이
  아니고, 내부 프롬프트 처리 모델을 노출할지는 별도의 UX·보안 결정입니다
  (v1.2가 이 문서에서 제외했습니다).
- Auto에 AI Review 전용 cyan→blue→purple을 재사용하지 않습니다. 신규 accent
  역할이 필요하면 **AGENTS.md 절차대로 token부터**.

## 4. 함께 넘어가는 나머지 §7 항목

- **비적격 신규 사용자의 `/chat` 직접 접근 → Review 이동.** 현재 `/chat`은 여전히
  Review이므로 이동시킬 것이 없습니다. `/chat`이 Chat으로 바뀌는 시점에
  `lib/productSurfaceRoutes.ts`의 규칙과 함께 배선합니다.
- **기존 Chat 사용자의 cohort 이탈 후 접근 유지.** 서버는 이미 이 성질을
  갖습니다 — `chatSurfaceAvailable`("새로 시작할 수 있는가")과 대화 열람이
  분리돼 있고, manual 복귀는 무조건 허용됩니다. 회귀 테스트는 `/chat`이 Chat이
  된 뒤에야 의미가 생깁니다.
- **전역 제품 스위처.** 결정 기록 §7의 합류 조건 뒤입니다. 지금 공개하지
  않습니다.
