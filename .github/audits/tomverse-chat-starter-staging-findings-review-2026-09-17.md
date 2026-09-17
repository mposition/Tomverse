# Chat 시작 카탈로그 staging 검증 발견 — 분석과 후속 작업 (2026-09-17)

- 작성일: 2026-09-17.
- 상태: 분석과 작업 후보 등록만 했습니다. 제품 코드 수정·flag 변경·배포 승인이 아닙니다.
- 연결: [통합 작업 목록](./tomverse-product-idea-backlog.md)의 CHAT-ONBOARD-01과 F의
  "starter staging 검증 후속" 표.

## 1. 요청과 출처

> 검증중 발견/관측한것들중 분석후 작업이 필요한 부분들은 해당 작업 목록에 분석후에 입력해주세요.

- 검증 기록: develop PR [#1510](https://github.com/mposition/Tomverse/pull/1510),
  `docs/ops/chat-starter-catalog-staging-verification-records/2026-09-16__c45871f158cb8f2f32ae7442ac7123613b354201.md`.
  판정 **통과**, 서명 mposition, 2026-09-17. 차단 구획 A·B·C에서 실패는 없었고,
  아래 발견은 기록에서 모두 비차단으로 정리했습니다.
- 관측 환경: staging `c45871f1`(PR #1501 병합). 실기기 Galaxy S25+ · Android 16 ·
  Edge 153.0.4234.32, PC Edge 153.0.4234.31, 로그인 계정은 Free 플랜.
- 코드 분석 기준: origin/develop `de346b81`. 작업 트리의 미커밋 변경은 쓰지 않고
  `git show origin/develop:<path>`로 읽었습니다. 아래 `file:line`은 이 커밋 기준입니다.
- 관측은 실행자 보고와 캡처입니다. 원인 중 **추정**이라고 적은 것은 실기기에서
  확인하지 않은 가설입니다.

## 2. 결론

작업이 필요한 것은 **여덟 묶음**입니다. 기록의 발견 11건과 검증 도중 확인한 문서·계측
공백을 원인이 같은 것끼리 묶었습니다. `--` 문구 한 건은 작업 불필요로 판단했습니다(§4).

| 제안 ID | 무엇 | 우선순위 제안 | 기록 발견 |
| --- | --- | --- | --- |
| STARTER-COMPARE-01 | "세 모델 비교" 카드가 로그인 계정에서 1개 모델로 열림 | CHAT-ONBOARD-01 하위 **P1** | 1 |
| COMPOSER-REFLOW-01 | 페이지 확대·낮은 높이에서 보내기 버튼·카드·주의 문구에 닿지 못함 | CHAT-01 하위 **P1** (접근성) | 9, 10 |
| CONT-TITLE-LOCALE-01 | 이어온 대화 제목이 새로고침 사이 한국어↔영어로 바뀜 | 병행 **P2** (버그) | 3 |
| STARTER-LOCK-COPY-01 | 잠긴 카드를 누른 뒤 도착 화면이 그 기능을 말하지 않음 | CHAT-ONBOARD-01 하위 **P2** | 4, 5 |
| MOBILE-KB-INSET-01 | 키보드가 열린 Edge에서 입력란 아래 빈 띠 | CHAT-01 하위 **P2** | 8 |
| STARTER-LAYOUT-01 | 카드 아래 안내 문장이 첫 화면에서 잘림, 한국어 단어 중간 줄바꿈 | CHAT-ONBOARD-01 하위 **P3** | 6, 7 |
| STARTER-FINDER-01 | 카드가 채운 문장이 Model Finder의 크레딧 안내를 띄움 | CHAT-ONBOARD-01 하위 **P3** (결정 필요) | 2 |
| STARTER-CHECKLIST-02 | 체크리스트 전제·E-3 조건·음성 flag 읽는 곳, 설정 감사 로그의 이전 값 | 운영 **P3** | F-3 참고, 판정 참고 목록 |

- 우선순위는 제안입니다. 주 투자 순위 Chat → Code 내부 대체 → Native → Memory → MCP는
  바꾸지 않습니다.
- 어느 것도 이번 staging 판정을 뒤집지 않으며, 시작 카탈로그의 production 활성화에
  새 차단 조건을 더하지 않습니다. 차단 기준은 AGENTS.md의 "되돌릴 수 없는가"이고,
  여기 항목은 모두 고쳐서 배포하면 끝나는 것입니다.
- 다만 STARTER-COMPARE-01은 **production에서 flag를 켜기 전에 고치는 편이 낫습니다.**
  갤러리의 첫 카드이고 Tomverse의 핵심 경험을 약속하는데, 로그인 사용자가 그대로
  보내면 답이 하나만 옵니다.

## 3. 항목별 분석

### 3.1 STARTER-COMPARE-01 — "세 모델 비교" 카드가 모델 선택을 바꾸지 않음

- **관측:** 로그인 Free 계정에서 "세 모델 답 나란히 비교"를 누르면 문장만 채워지고
  모델 선택은 "1 개 모델" 그대로입니다. 게스트는 기본이 3개라 어긋나지 않습니다.
- **원인:** `StarterSeed.suggestedModelIds` 필드는 있지만(`lib/chatStarterCatalog.ts:143`)
  어느 항목도 쓰지 않습니다. `compare-answers` seed는 문장 key와 `productKey`뿐입니다
  (224-227). 이 필드를 읽는 곳은 이미지 draft 분기 하나입니다
  (`app/(site)/(application)/chat/ChatPageClient.tsx:7199`). chat 카드의
  `handleStarterSeed`(7157-7207)는 문장과 웹 검색만 바꿉니다.
- **약속 범위:** 7개 locale 모두 "세/three/三/três/drei/trois/tres"를 약속합니다
  (`locales/en.ts:2237-2241`, `ko.ts:2226` 외). `check:starter-catalog`는 key 존재와
  우월성·dash만 검사하므로 이 어긋남을 잡지 못합니다.
- **계약:** `docs/ui-contracts/chat-starter-catalog.md` §4는 클릭이 바꿀 수 있는 것으로
  초안 문장·웹 검색·첨부 표시·studio handoff를 나열하고, 모델 선택은 언급하지 않습니다.
  §1은 짧은 라벨과 outcome 문장이 모두 참인 약속이어야 한다고 요구합니다.
- **결정이 필요한 것:** 어느 쪽으로 고칠지는 제품 결정입니다.
  1. 클릭이 모델을 3개로 맞춤: 계약 §4에 "모델 선택"을 추가하는 개정입니다. 사용자가
     고른 조합을 덮어쓰는 것이 되므로, 이미 2개 이상이면 그대로 두는지, 무엇으로
     채우는지(`newConversationModelIds`와의 관계), 되돌릴 수 있는지를 정해야 합니다.
     `Conversation.selectedModels`는 되돌릴 수 없는 상태로 분류돼 있으므로 새 대화
     초안 단계에서만 바꾸는지가 중요합니다.
  2. 모델은 두고 안내: 1개 모델일 때 "비교하려면 모델을 더 고르세요"를 카드나
     composer에 띄웁니다. 계약 변경은 작지만 한 번 더 조작해야 합니다.
  3. 문구를 바꿈: "세 모델"을 빼고 "여러 모델"로 약속을 줄입니다. 가장 작지만 카드의
     가치를 흐립니다.
- **완료 조건:** 로그인 1개 모델 계정·게스트 3개·이미 2개 선택 상태에서 카드 클릭 후
  보이는 모델 수가 라벨 약속과 맞음을 E2E로 고정합니다. 타이핑한 초안 보존(C-3)은
  그대로 유지합니다.

### 3.2 COMPOSER-REFLOW-01 — 확대·낮은 높이에서 입력란이 화면을 차지함

- **관측 (Edge Default zoom):** 150%(약 275 CSS px 폭)에서는 카드 문장은 온전하지만
  입력란 아래 주의 문구가 "민감정…"에서 끊깁니다. 200%(약 206px)에서는 카드 영역이
  약 80px로 줄어 카드가 보이지 않고 주의 문구가 "있…"에서 끊깁니다. 300%(약 137px)
  에서는 크레딧·마이크·보내기 버튼이 화면 밖에 있고 스크롤도 되지 않아 **글을 보낼 수
  없습니다.**
- **원인:**
  - 주의 문구가 `min-w-0 truncate` 한 줄입니다(`components/chat/AiDisclaimerNotice.tsx:53`).
    잘리는 부분이 "민감정보 입력 금지"라는 안전 안내입니다.
  - 헤더와 dock은 `shrink-0`, 환영 영역만 `min-h-0 flex-1`이라 높이가 줄면 환영 영역이
    먼저 사라집니다(`components/chat/MobileChatShell.tsx:1184, 1496-1498, 1623-1626`).
  - 페이지 확대는 root 16px를 그대로 두므로 입력란의 rem 최소 높이
    (`ChatInput.tsx:3628-3632`)와 44px 버튼이 CSS px로 줄지 않습니다.
  - composer root가 `overflow-hidden`(`ChatInput.tsx:3048`), shell이 `overflow-x-hidden`
    이라 오른쪽으로 밀린 버튼은 스크롤로도 닿지 않습니다.
  - 낮은 높이 규칙이 composer에는 없습니다. `useCompactBottomDock`
    (`components/chat/useVisualViewport.ts:18-19,45-52`)은 비교 action rail만 접고, drawer의
    `useShortViewport`에 해당하는 규칙이 입력란·주의 문구·환영 영역에는 없습니다.
- **테스트 공백:** 모바일 입력란 계약은 320/360/390/430px 폭, root 32px로 흉내 낸 200%
  글자 크기, 195×340 한 경우(페이지 확대 대응)만 고정합니다
  (`docs/ui-contracts/mobile-chat-composer.md:62,206-223`,
  `tests/e2e/mobile-composer-contract.spec.ts:685-693`). 195×340도 보내기 버튼이 보이는지만
  보고 환영 영역·주의 문구는 보지 않습니다. 137px 폭, 300px 안팎 높이, 가로 모드의
  composer는 테스트가 없습니다.
- **범위 판단:** 계약이 보장하는 폭(320px)보다 좁은 조건이라 계약 위반으로 적지는
  않습니다. 그러나 저시력 사용자가 쓰는 브라우저 확대에서 **채팅 자체를 못 하는**
  증상이고, 가로 모드·분할 화면 같은 낮은 높이에서도 같은 구조가 드러날 수 있어 P1로
  제안합니다.
- **완료 조건 후보:** 어떤 확대에서도 보내기 버튼에 한 번의 세로 스크롤로 닿음, 주의
  문구가 말줄임 대신 줄바꿈되거나 다른 곳에서 전문을 볼 수 있음, 낮은 높이에서 카드에
  닿을 경로가 있음. drawer 계약처럼 측정은 중심점 `elementFromPoint`로 합니다. 새
  기준 크기(예: 137×300, 568×320)를 계약과 spec에 함께 추가합니다.

### 3.3 CONT-TITLE-LOCALE-01 — 이어온 대화 제목 언어가 바뀜

- **관측:** UI가 한국어인 두 캡처에서 같은 대화 제목이 "Claude에서 이어온 대화 · 202…"와
  "Continued from Claude · 20…"로 달랐습니다.
- **원인 (코드 분석, 재현 전):** 제목은 DB에 영어로 저장되지 않고 화면에서 locale로
  만듭니다(`lib/continuationDisplayTitle.ts:36`, `lib/continuationTitleContext.ts:118-127,194-217`).
  목록 API도 번역하지 않습니다(`app/api/conversations/route.ts:158-240`). 문제는 요청 순서입니다.
  1. `LanguageProvider`가 `initialLang`(기본 `en`)으로 시작하고, 저장된 언어를
     `setTimeout(0)` 뒤에 적용합니다(`components/LanguageProvider.tsx:81,109-120`).
     `/api/user/settings` 응답도 `setLang`을 부릅니다(`ChatPageClient.tsx:3108`).
  2. `fetchConversations`가 `t`에 의존하고(2920, 2983) 응답 처리 안에서 그때의 `t`로
     제목 문자열을 만듭니다(2950-2966).
  3. `t`가 바뀌면 목록 요청이 한 번 더 나가고(3016, 3150), 두 요청을 취소하거나
     순서를 보장하지 않습니다. 영어로 시작한 요청이 늦게 도착하면 영어 제목이 남습니다.
- **관계:** CONT-TITLE-01(완료)은 원문 삭제 후 제목 안정화였고 이 경합과는 다른 결함입니다.
- **완료 조건 후보:** 목록 응답은 원시 데이터로 두고 표시 문자열은 렌더 시점에 만들거나,
  늦게 도착한 이전 locale 응답을 버립니다. 첫 렌더 locale이 `en`이고 저장 언어가 `ko`인
  조건에서 응답 순서를 뒤집는 테스트로 고정합니다.

### 3.4 STARTER-LOCK-COPY-01 — 잠금 뒤 도착 화면이 그 기능을 말하지 않음

- **게스트 로그인 모달:** 잠긴 ".xlsx 파일로 받기"를 누르면 `handleStarterLocked`
  (`ChatPageClient.tsx:7217-7223`)가 boolean 하나만 켭니다. 모달(7766-7805)은 다중 모델
  선택용 문구 "Want more model choices and saved work?"를 쓰고, 문구가 locale 파일이 아닌
  `guestTrialCopy` 상수(397-440)에 있으며, 이유를 받을 자리가 없습니다. 버튼
  "Log in and continue this conversation"은 빈 초안에서도 같습니다. 분석 태그도
  `cta_location: "guest_multi_model"`(7790)로 남아 시작 카드 유입과 구분되지 않습니다.
- **요금제 페이지:** Free가 이미지 카드를 누르면 `/pricing`으로 가지만, 플랜 혜택
  목록은 locale별로 컴포넌트에 하드코딩돼 있고(`components/marketing/PricingPageContent.tsx`,
  en Pro 597-603, ko 654-656) 어느 플랜에도 이미지 생성이 없습니다. 실제 권한은
  `planAllowsImageGeneration`(`lib/imageGenerationAccess.ts:23-24`)이 Pro·Max에 허용합니다.
- **"Review로 돌아가기":** 마케팅 헤더의 로그인 CTA가 locale별 고정 문구
  (`components/marketing/MarketingChrome.tsx:80,100`)이고 목적지는 항상 `/chat`(242)입니다.
  이름이 목적지와 다릅니다.
- **완료 조건 후보:** 잠금 사유별로 모달 제목·본문이 누른 기능을 말함, 요금제 페이지가
  이미지 생성의 플랜 경계를 표시함(가격 표 변경이므로 문구 검토 필요), 헤더 CTA 이름이
  실제 목적지를 말함.

### 3.5 MOBILE-KB-INSET-01 — 키보드가 열렸을 때 입력란 아래 빈 띠

- **관측:** Edge에서 키보드를 올리면 주의 문구와 주소 표시줄 사이에 약 100px 빈 띠가
  남습니다.
- **원인 (추정):** 루트 viewport가 `interactiveWidget: "resizes-content"`
  (`lib/rootMetadata.ts:88-91`)라 키보드가 열리면 레이아웃이 이미 줄어듭니다. 그런데 shell이
  `useKeyboardInset()`만큼 `paddingBottom`을 또 줍니다(`MobileChatShell.tsx:1056-1058,
  1179-1184`, `components/chat/useVisualViewport.ts:66-73`). 훅 주석은 이 경우 inset이 0이라고 가정하지만,
  Edge가 주소 표시줄을 키보드 위에 붙이면 차이가 48px 이상 남아 이중 보정이 될 수 있습니다.
  별도로 safe-area 여백이 dock에 두 번 들어갑니다(`AiDisclaimerNotice.tsx:51`,
  `ChatInput.tsx:3048`).
- **테스트 공백:** 키보드 테스트는 `visualViewport.height`만 절반으로 줄이고
  `innerHeight`는 그대로 둡니다(`tests/e2e/mobile-composer-contract.spec.ts:600-620`).
  레이아웃이 함께 줄어드는 브라우저 조건은 없습니다.
- **완료 조건 후보:** 실기기(Edge·Chrome·Samsung Internet)에서 원인 확정 → 두 viewport가
  함께 줄어드는 조건의 spec 추가 → 빈 띠 제거. 입력란 계약의 키보드 조건을 깨지 않아야 합니다.

### 3.6 STARTER-LAYOUT-01 — 안내 문장 잘림과 한국어 줄바꿈

- **안내 문장:** 카드 아래 문장은 갤러리의 일부입니다(`ChatStarterGallery.tsx:260-266`).
  환영 영역 스크롤러에는 아래 여백이 그룹의 `py-6`뿐이고 scroll-padding이 없어
  (`ChatWelcomeScreen.tsx:78-82`), 내용이 영역보다 조금 크면 마지막 줄이 dock 경계에
  걸립니다. 스크롤하면 보입니다. spec은 이 문장이 보이는지 검사하지 않습니다
  (`tests/e2e/chat-starter-catalog.spec.ts:244-300`).
- **한국어 줄바꿈:** 라벨이 `min-w-0 break-words`이고 `break-keep`이 없습니다
  (`ChatStarterGallery.tsx:228`). 저장소에는 한국어 단어 단위 줄바꿈 관례
  `displayHeadingClass()`(`lib/displayHeading.ts:1-42`)가 있고 인사말은 이미 씁니다.
  전역 규칙으로 넣는 것은 두 번 되돌려졌으므로 이 surface에만 적용합니다.
- **완료 조건 후보:** 첫 화면에서 안내 문장이 dock에 걸리지 않거나 잘리지 않는 위치에
  있음, ko 라벨이 단어 중간에서 끊기지 않음. 잘림 금지 계약은 그대로 유지합니다.

### 3.7 STARTER-FINDER-01 — 카드가 채운 문장이 크레딧 안내를 띄움

- **관측:** 출처 카드를 누르면 "Research 모델도 적합합니다 · 기본 16크레딧"이 뜹니다.
- **원인:** Model Finder가 초안 문장의 키워드(`출처`, `sources` 등)를 보고 추천합니다
  (`lib/modelFinder.ts:424-441`, `ChatInput.tsx:1450-1475,3169-3191`). 같은 문장을 직접
  타이핑해도 똑같이 뜹니다. 카드와 무관한 기능입니다.
- **계약:** "카드는 가격을 말하지 않는다"(§4)는 카드 표면에 대한 규칙이라 위반은 아닙니다.
- **결정이 필요한 것:** 카드는 웹 검색을 켜서 출처 있는 답을 약속했는데, 곧바로 다른 유료
  모델로 바꾸라는 안내가 붙습니다. 카드가 채운 초안에서는 추천을 끌지, 둘 수 있는
  정보로 볼지 정해야 합니다. 첫 성공 흐름의 중복·이탈을 보는 CHAT-ONBOARD-01의 판단
  대상입니다. 결정 전에는 수정하지 않습니다.

### 3.8 STARTER-CHECKLIST-02 — 체크리스트와 감사 로그의 공백

- **SHA 전제:** 체크리스트는 `4f300e21`(#1433) 이후만 요구합니다
  (`docs/ops/chat-starter-catalog-staging-checklist.md:108`). 시작 화면을 다시 바꾼
  #1460(`705b65ad`) 이전 빌드도 통과합니다.
- **E-3:** "OS 글자 크기"만 적혀 있습니다(171). 이번 회차는 모바일 브라우저의 페이지
  확대로 실행했고, 둘은 CSS 폭에 미치는 영향이 다릅니다. 어느 쪽을 볼지, 배율 기준을
  계약의 320px과 어떻게 맞출지 적어야 합니다.
- **음성 flag 읽는 곳:** 체크리스트는 Admin 플랫폼 설정에서 음성 입력 flag를 읽으라고
  하지만(110), develop의 플랫폼 설정 화면과 저장 경로에는 이 flag가 없고 의도적으로
  writer가 없습니다(`lib/appSettings.ts:331-345`, `tests/appSettingWriters.test.mjs:114-123`).
  실행자는 Admin 화면에서 ON을 읽었다고 보고했으나 어느 화면인지는 기록되지 않았습니다.
  이 불일치는 확인이 필요합니다.
- **감사 로그:** `app_settings.update_started/completed`는 요청 본문 전체를 metadata로
  남기고 이전 값은 읽지 않습니다(`app/api/admin/app-settings/route.ts:177-213`). 그래서 한
  행만으로 어느 flag가 바뀌었는지 알 수 없습니다. 2026-08-21 assistant profile 기록에서도
  같은 공백이 지적됐습니다.
- **완료 조건 후보:** 체크리스트 전제를 #1460 이후로, E-3에 페이지 확대 조건과 기준을
  추가, 음성 flag를 읽는 실제 경로 명시. 체크리스트를 고치면 `templateRevision`을
  `_record-template.md`와 함께 올립니다
  (`scripts/check-staging-verification-records.mjs:95-116`). 감사 metadata에 변경 전후 차이를
  남길지는 Admin 감사 설계 결정이라 별도로 판단합니다.

## 4. 작업 불필요로 판단한 것

- **영어 주의 문구의 ` -- `** (기록 발견 11): `chat.aiDisclaimer`의 en·de·es·fr·pt에 있지만,
  locale 전반에서 쓰이는 표기 관례입니다(`locales/en.ts:211, 510, 884-889` 외).
  dash 금지 규칙은 시작 카드와 랜딩 문구에만 적용됩니다. 이 한 줄만 고칠 근거가 없어
  작업으로 등록하지 않습니다. 저장소 전체 문장부호 규칙을 정하는 일은 별도 결정입니다.
  zh의 실제 em dash(`——`)도 같은 이유로 검사 대상이 아닙니다.

## 5. 한계

- 원인 중 CONT-TITLE-LOCALE-01의 요청 경합과 MOBILE-KB-INSET-01의 이중 보정은 코드
  분석에 근거한 추정이며, 실기기나 테스트로 재현하지 않았습니다.
- production 화면·운영 flag·사용 빈도는 조회하지 않았습니다.
- 시작 카탈로그는 main에 아직 없습니다. main 이식 PR이 진행 중이며, 위 `file:line`은
  develop 기준이라 main에서는 다를 수 있습니다.
