# Chat 시작 카탈로그 (Starter Catalog) 계약

- 상태: **구현 완료, 내부 검증 통과, production 비활성.**
  `feature.chatStarterEnabled`는 default-off이고 어느 환경에서도 켜지지 않았다.
- 표: `lib/chatStarterCatalog.ts`
- 판정: `lib/chatStarterAvailability.ts`
- 런타임 capability 해석: `lib/chatStarterCapabilityResolution.ts`
- flag: `lib/chatStarterAccess.ts`
- 표면: `components/chat/ChatStarterGallery.tsx`
- 진실성 gate: `scripts/check-starter-catalog.mjs`
  (`npm run check:starter-catalog`, PR Fast Gate static 단계)

이 계약의 목적은 카드를 예쁘게 만드는 것이 아니다. **기능이 추가되면 표에 행
하나를 더하는 것으로 진입점이 따라 자라고, 기능이 꺼지면 카드가 저절로
사라지는 구조**를 고정하는 것이다. 카드가 남아서 없는 기능을 약속하는 사고가
구조적으로 불가능해야 한다.

## 1. 카드는 결과를 말하고 기능을 말하지 않는다

`outcomeKey`가 가리키는 문장은 **그 사람이 무엇을 얻는지**를 말한다.

| 쓴다 | 쓰지 않는다 |
| --- | --- |
| "18페이지 PDF를 붙여 여러 모델에게 같은 질문 하기" | "파일 첨부 지원" |
| "출처 링크가 함께 붙은 답 받기" | "web search 연동" |
| "답변을 내려받을 수 있는 .xlsx 파일로 만들기" | "Generated Artifact tool" |

기능 이름은 그것이 무엇에 쓰이는지 아무도 말할 수 없을 때 남는 것이다. 신규
사용자가 처음 보는 화면은 그것을 설명할 자리가 아니다.

문구에 걸리는 두 가지 금지는 저장소가 다른 곳에서 이미 강제하는 것과 같다.

- **우월성 주장 금지** (`best` · `optimal` · `smartest` · `최적` · `최고`
  계열). 이유는 `tests/autoRoutingUi.test.mjs`와 같다 — ROUTE-01이 재는 것은
  비열등성이고, 카드는 그보다 강한 주장을 할 자리가 아니다.
- **em dash · en dash 금지** (`components/marketing/landingContent.ts` 규칙).

두 규칙 모두 `npm run check:starter-catalog`가 7개 locale 전부에서 검사한다.

## 2. available / locked / hidden 은 서로 다른 세 가지다

`lib/chatStarterAvailability.ts`의 `chatStarterAvailability()`가 유일한 판정
지점이다.

| 상태 | 뜻 | 화면 |
| --- | --- | --- |
| `available` | 이 사람이 지금 실행할 수 있다 | 카드를 그리고 클릭하면 씨앗을 채운다 |
| `locked` | 기능은 있고, 이 사람이 아직 못 쓴다 | 카드를 그리고 **요구사항을 앞에서 말한다**. 클릭하면 로그인 또는 `/pricing`으로 보낸다 |
| `hidden` | 이 배포에 그 기능이 없다 | 아무것도 그리지 않는다 |

**둘을 섞으면 각각 다른 사람이 손해를 본다.**

- `locked`를 `hidden`으로 그리면, 돈을 내면 쓸 수 있는 기능을 계정이 영영
  모른다. `docs/ui-contracts/image-generation-workspace.md`가 "비노출·마지막
  단계 차단 금지"로 적은 것이 이것이다.
- `hidden`을 `locked`로 그리면, 뒤에 아무것도 없는 잠금을 보여 주게 된다.
  그것은 빌드가 지킬 수 없는 판매 약속이다.

`locked` 카드는 **클릭한 뒤에 거절하지 않는다.** 요구사항은 카드 위에, 문장보다
먼저 있다.

### fail-closed

판정할 수 없는 것은 전부 `hidden`이다. 추측하지 않는다.

| 사유 | 언제 |
| --- | --- |
| `feature_flag_off` | 카드가 이름 댄 flag가 꺼져 있다 |
| `unknown_flag` | 그 flag를 읽는 곳이 이 배포에 없다 (배선 누락) |
| `capability_unavailable` | 이번 요청에서 capability가 해석되지 않았다 |
| `unknown_capability` | `STARTER_CAPABILITIES`에 없는 id |
| `unresolved_plan` | 로그인했지만 플랜이 아직 로드되지 않았다 |

`unknown_flag`가 `feature_flag_off`와 별개인 이유: **"꺼져 있다"와 "아무도 그
질문에 답하지 못한다"는 다른 사실**이고, 앞의 것만이 rollout 상태다. 배선이
빠진 flag를 조용히 "꺼짐"으로 읽으면 나중에 그 flag를 켰을 때 카드가 나타나지
않는 이유를 아무도 설명할 수 없다.

`unresolved_plan`이 `Free`가 아닌 이유: 플랜이 로드되기 전 한 프레임 동안 잠금
카드를 보여 주고 곧 풀어 버리면, 제품이 계정에 대해 마음을 바꾼 것처럼 보인다.

**판정 순서도 계약이다.** 존재(`flagKeys` → `capabilities`)를 먼저 보고 권한
(`signedIn` → `minimumPlan`)을 나중에 본다. 순서를 뒤집으면 아무도 실행할 수
없는 기능에 대해 "Pro로 올리세요"가 나온다. 게스트가 플랜 제한 카드에 닿으면
`plan_required`가 아니라 `sign_in_required`다 — 요금제는 두 번째 단계이고,
계정이 없는 사람에게 첫 단계를 건너뛰고 말하지 않는다.

## 3. 화면 상한은 registry 크기와 무관하다

`CHAT_STARTER_MAX_VISIBLE`(현재 6, 허용 범위 4~6)과 선택 순서는
`lib/chatStarterAvailability.ts`가 소유한다. component도 shell도 자기 숫자를
갖지 않는다.

- **registry는 무한히 커져도 된다.** 기능이 늘면 행이 늘고, 그것이 이 표의
  존재 이유다.
- **화면은 커지면 안 된다.** 320px 폭 · 200% 텍스트 배율에서 composer와 함께
  들어가야 하고, 자기 스크롤이 필요할 만큼 긴 목록은 이미 진입점이 아니다.

선택 순서는 `hidden` 제거 → 실행 가능한 카드 먼저 → 잠긴 카드 → 상한으로
자르기다. 각 그룹 안에서는 registry 순서가 유지된다(stable).

**단, 잠긴 카드가 하나라도 있으면 한 자리를 비워 둔다**(`RESERVED_LOCKED_SLOTS`
= 1). 상한을 채우는 것은 실행 가능한 카드 쪽이 양보한다.

처음에는 그러지 않았다. 실행 가능한 카드를 앞세우고 상한에서 자르면 된다고
보았고, "새 대화를 여는 사람은 살 것을 고르는 중이 아니라 할 것을 찾는
중"이라는 것이 근거였다. **e2e spec이 기본 구성에서 그것을 반증했다** — 두
기능 flag가 모두 꺼진 배포의 게스트는 실행 가능한 카드 6개와 잠긴 카드 1개를
갖고, 상한이 그 잠긴 카드를 잘라 **갤러리가 아무 요구사항도 말하지 않았다.**

이것은 순위 취향이 아니라 평범한 경우에 잠금 노출 규칙이 실패한 것이다.
`docs/ui-contracts/image-generation-workspace.md`가 요구하는 것은 요구사항을
**앞에서** 말하는 것이고, 이미 할 수 있는 일만 보여 주는 표면은 그것을 말할 수
없다. 그래서 상한은 잠금이 아니라 실행 가능한 카드 하나를 포기한다.

비율이 아니라 **한 자리**다. 잠금에 닿을 수 있어야 한다는 뜻이지 화면을
가격으로 채우자는 뜻이 아니다. 상한이 1이면 예약하지 않는다 — 균형을 잡을 것이
없고, 유일한 카드가 가격인 첫 화면은 진입점이 아니다.

## 4. 씨앗은 전송이 아니다

카드 클릭은 composer 초안을 채우고 멈춘다. 규칙은
`docs/ui-contracts/prompt-refiner-suggestion.md` §1과 같다 — 상자를 채우는
표면은 출발점을 주는 것이고, 전송하는 표면은 사용자가 읽지 않은 문장에 크레딧을
쓰는 것이다.

- 씨앗은 **기존 초안 경로**(`lib/conversationDraftStore.ts` ·
  `useConversationDrafts`)의 `setInputValue`를 지난다. 두 번째 초안 경로를
  만들지 않는다.
- **타이핑한 내용을 덮어쓰지 않는다.** 초안이 비어 있거나 그 자체가 다른 카드의
  씨앗일 때만 교체한다. 그래서 카드를 두 번 고르면 바뀌고, 사람이 쓴 글은 사라
  지지 않는다.
- `seed.webSearch`는 composer의 web search mode를 `always`로 올린다. 켜기만
  하고 보내지 않는다.
- `seed.attachment`는 **카드 위의 표시로 읽힌다** — 그 질문이 파일을 전제한다고
  카드가 말한다. 클릭이 파일 선택기를 열지는 않는다. 문장을 누른 것에 대한
  응답으로 OS 대화상자가 뜨는 것은 놀람이고, picker는 composer가 이미 소유한다.
- `seed.productKey === "studio"`인 카드는 기존 `handleStartImageDraft()`로
  넘어간다. `fromImageRequest` 없이 부르므로 `imageDraftAutoGenerate`는 false를
  유지한다 — 초안만 채우고 생성은 사람이 누른다.
- **provider 호출 · 크레딧 예약 · 정산 · 대화 row 생성은 이 표면에 없다.**
- **카드는 가격을 말하지 않는다.** 실행하지 않으므로 가격을 말할 자격이 없다.
  유료 플랜이 필요한 것은 `locked` 사유로만 말한다.

## 5. flag 하나, kill switch 하나, 그리고 비활성은 비노출이다

`lib/chatStarterAccess.ts`:

- `CHAT_STARTER_FLAG_KEY = "feature.chatStarterEnabled"` — default-off opt-in.
  행 없음 · NULL · 빈 문자열 · `"true"` 외 어떤 값도 **꺼짐**이다.
- `CHAT_STARTER_KILL_SWITCH_ENV = "CHAT_STARTER_KILL_SWITCH"` — 비어 있지 않은
  어떤 값이든 끈다. DB 왕복 없이 읽으므로 DB가 아플 때도 동작하고, 저장된
  flag의 어떤 값도 이를 되돌리지 못한다.
- 해석은 `lib/imageGenerationAccess.ts` · `lib/voiceInputAccess.ts`와 같다.
  같은 규칙을 세 번째로 적은 것이 아니라, 세 모듈이 같은 모양을 유지한다.

`offered=false`는 **아무것도 렌더하지 않는다.** 비활성 teaser도, 회색 행도,
제목만 남은 빈 구획도 아니다. `docs/ui-contracts/prompt-refiner-suggestion.md`
§1과 같은 이유다 — 실제로 쓸 수 없는 사람에게 기능을 약속하는 상태를 만들지
않는다.

flag와 capability는 **서버에서 해석해 prop으로 건넨다**
(`components/chat/ReviewWorkspaceShell.tsx`). Client Component는
`process.env`를 읽을 수 없으므로 클라이언트 사본은 운영자가 kill switch를 당긴
뒤에도 계속 갤러리를 그린다. 클라이언트로 건너가는 것은 flag key 목록과
capability id 목록뿐이고, 키·backend 이름·예산은 건너가지 않는다.

## 6. 레이아웃 불변식

- **갤러리는 textarea의 가로 행을 쓰지 않는다.** composer 계약
  (`docs/ui-contracts/mobile-chat-composer.md`)이 textarea에 전용 전폭 행을
  주므로, 갤러리는 그 아래 normal flow의 자기 블록이다. `absolute` ·
  negative margin · `transform` · 공유 grid cell을 쓰지 않는다.
- **최근 대화 제목을 카드에 출력하지 않는다.** `ChatWelcomeScreen`이 모바일에서
  제목 대신 개수만 내보내는 이유(공유·대여 단말에서의 노출)가 이 표면에도
  그대로 적용된다. 카드 문구는 전부 locale 문자열이고 사용자 콘텐츠가 아니다.
- **터치 타깃 44px**(`min-h-11`), 320px 폭과 200% 텍스트 배율에서 가로 overflow
  없음, 문장은 잘리지 않고 줄바꿈한다.
- **accent는 역할 token만.** 기능별 카드는 그 기능이 이미 가진 역할을 쓰고
  (이미지 = `accent-image-*`, web search = `accent-web-search-*`, 생성 파일 =
  `accent-generated-artifact-*`), 역할이 없는 카드는 중립(blue/zinc)을 쓴다.
  **이 slice는 새 accent 역할을 만들지 않는다.** AI Review gradient는 예약이며
  AI Review를 설명하는 카드에도 쓰지 않는다.
  `components/chat/ChatStarterGallery.tsx`는 `GUARDED_FILES`에 있다.

## 7. 항목 추가 절차

**세 가지뿐이다.**

1. `lib/chatStarterCatalog.ts`의 `CHAT_STARTER_CATALOG`에 행 하나.
2. `outcomeKey`와 `seed.promptSeedKey`를 **7개 locale 전부**에.
3. `evidence`에 그 약속을 실제로 수행하는 모듈의 경로.

그 밖에는 없다. 아이콘은 `accentRole`과 `taskProfile.kind`에서 파생되므로 따로
등록하지 않는다 — 네 번째 항목은 사람이 잊는 항목이다.

### 그 안에서 지켜야 하는 것

- `requires.flagKeys`는 **기존 모듈이 export하는 상수를 import**해서 쓴다.
  문자열 리터럴을 새로 적지 않는다. 오타 난 리터럴은 화면에 아무 말도 남기지
  않은 채 영원히 숨겨진 카드가 되고, 오타 난 import는 commit 전에 타입 에러가
  된다. gate가 `lib/chatStarterCatalog.ts` 안의 `"feature.…"` 리터럴을 거절한다.
- `taskProfile.kind`는 `lib/taskProfileCore.ts`의 `TASK_KINDS`를 쓴다. 새 축을
  발명하지 않는다 — `MODEL_FINDER_TASKS`와 이미 조심스럽게 분리되어 있는 두
  어휘에 세 번째를 더하지 않는다.
- `seed.productKey`는 `CONVERSATION_PRODUCT_KEYS`(`chat` · `review` · `studio`)
  안에서 고른다.
- 새 capability가 필요하면 `STARTER_CAPABILITIES`에 id와 **해석하는 모듈·export
  이름**을 함께 등록하고, `lib/chatStarterCapabilityResolution.ts`에 해석을
  더한다. 등록되지 않은 id를 요구하는 카드는 `hidden`이다.

### 무엇이 일부러 빠져 있는가

- **Prompt Refiner 카드 없음.** 이름 댈 `AppSetting` flag 상수가 저장소에
  없다(`docs/ui-contracts/prompt-refiner-suggestion.md`가 "연결됨, 미제공"으로
  기록). 요구사항을 적을 수 없는 카드는 무조건 제공되는 카드가 되고, flag key를
  리터럴로 적으면 gate는 통과하고 약속은 거짓이 된다.
- **Deep Research 카드 없음.** 같은 이유로 flag 상수가 없다.

## 8. gate가 검사하는 것과 검사하지 않는 것

`npm run check:starter-catalog`가 fail-closed로 검사한다.

1. 모든 `flagKeys`가 `lib/`의 어떤 모듈이 실제로 export하는 flag 상수 값인가.
2. `lib/chatStarterCatalog.ts` 코드에 `"feature.…"` 리터럴이 없는가.
3. 모든 capability가 실재하는 모듈의 실재하는 export로 해석되는가.
4. 모든 `evidence` 경로가 실재하는 파일인가.
5. 모든 `outcomeKey` · `promptSeedKey`가 7개 locale 전부에 있는가.
6. 문구에 우월성 주장과 em dash · en dash가 없는가.
7. 화면 상한이 4~6 안에 있는가.

**검사하지 않는 것: 기능이 실제로 동작하는가.** 정적 검사는 그것을 말할 수
없다. 이 gate가 말하는 것은 누군가가 실재하는 flag 상수 · 실재하는 해석기 ·
실재하는 파일 · 일곱 개의 실재하는 번역을 이름 대야 했고, 넷이 아직 거기 있다는
것뿐이다. 썩는 부분이 그쪽이므로 gate가 붙드는 것도 그쪽이다.

## 9. 이 계약을 어기면

이 slice는 어떤 release gate도 통과시키지 않고 provider도 부르지 않으므로,
위반이 **되돌릴 수 없는** 범주(AGENTS.md "검증 범위는 되돌릴 수 없는 것에
비례")에 드는 것은 하나뿐이다.

- **없는 기능을 약속하는 카드** — 사용자가 그 약속을 믿고 한 결정(가입·결제)은
  고쳐서 배포한다고 회수되지 않는다. 그래서 gate가 있고, 그래서 판정이
  fail-closed다. 이것은 릴리스 차단이다.

나머지(문구·아이콘·순서·상한 조정)는 고쳐서 배포하면 끝나는 것이며 차단이
아니다.
