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

## 2. 마운트 — 완료

`AutoRoutingToggle`과 `AutoRoutedByBadge`가 실제 UI에 연결됐습니다.

| 배선 | 위치 |
|---|---|
| `autoSelection.offered` → 클라이언트 상태 | `ChatPageClient` → 두 shell → `ChatInput` → `ModelPickerPanel` |
| 토글 | `ModelPickerPanel` 목록 **위**, keyboard-scroll 영역 **안** |
| 배지 | `ChatMessageList`의 답변 아래, `msg.routedModelId`가 있을 때만 |
| PATCH | `handleSelectionModeChange` — 낙관적 적용 후 실패 시 되돌림 |
| 문구 | `locales/*.ts`에 `chat.autoSelectionFailed` 7종 추가 |

**`offered`는 확정된 서버 읽기에서만 설정됩니다.** 대화 목록의 낙관적 seeding은
`autoSelection`을 싣지 않으므로, 그것으로 값을 지우면 사이드바에서 대화를 열 때
컨트롤이 깜빡입니다. 대화가 생성되기 전에는 항상 false입니다 — 서버가 그 상태의
`auto`를 거부하므로, 거기 있는 스위치는 아무것도 저장하지 못합니다.

### 검증

- `tests/client/autoRoutingRender.test.tsx` — 13건. `offered: false`가 **`null`**
  임을 직접 확인하고, 7개 언어의 렌더 결과에 금지어(better/best/optimal/smartest,
  "가장 좋은", "최적")와 롤아웃 어휘(bucket/cohort/rollout/salt/readiness/percent/
  flag/%)와 Refiner가 없는지 확인합니다.
- `tests/e2e/auto-routing-toggle.spec.ts` — 9건 × desktop·mobile. **320px +
  200% 확대**, 한국어 초안 보존, composer의 textarea 행 불변, cohort 이탈 상태
  (`selectionMode: "auto"` + `offered: false`)에서 대화가 계속 열리는지.
- 재실행한 release blocker 계약 suite — mobile composer, model picker,
  picker-responsive, limit-state, sidebar drawer. **97 passed.**
- `tests/autoRoutingUi.test.mjs` — 마운트 지점 자체를 고정: wrapper가 조건
  **안**에 있는지(빈 div의 margin이 남지 않도록), 배지가 서버의 routed 표시
  뒤에서만 렌더되는지, 클라이언트가 `routed`를 **유도하지 않는지**.

### 새 테스트 lane

`tests/client/`는 `--conditions=react-server` **없이** 도는 두 번째 프로세스입니다.
그 조건에서는 `react.createContext`가 없어서 lucide-react를 쓰는 컴포넌트가
import 시점에 throw합니다 — 이 저장소에 컴포넌트 렌더 테스트가 하나도 없었고
따라서 **계약이 한 번도 실행된 적이 없었던** 이유입니다. 조건을 전역으로 끄는
대신 프로세스를 나눈 것은 `run-db-integration-tests.mjs`의 선례를 따른 것입니다.

## 3. 마운트가 지킨 것 (앞으로도 지켜야 할 것)

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

## 3.1 이 환경에서 확인하지 못한 것

`mobile-composer-contract.spec.ts`의 **visual golden 2건**은 이 컨테이너에서
911픽셀 차이로 실패합니다. **이 변경 때문이 아닙니다** — `develop`을 그대로
체크아웃해 다시 빌드하고 돌렸을 때 **같은 911픽셀**이 나옵니다. 환경의 Chromium이
build 1194이고 golden은 다른 build에서 기록됐습니다(@playwright/test 1.62.1은
1234를 기대합니다). golden 재기록은 `visual-baseline/**` 브랜치에서 **사람이
diff를 보고** 병합합니다(AGENTS.md).

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
