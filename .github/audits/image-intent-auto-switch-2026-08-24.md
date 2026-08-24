# 프롬프트 의도가 이미지일 때 자동 전환 — UX·아키텍처 분석 (2026-08-24)

- 대상: 채팅에서 사용자가 "그려 줘 / 인포그래픽으로 / 이미지로"를 요청했을 때
  이미지 생성으로 **자동 전환**하자는 제안
- 성격: **분석·설계 제안이며 구현이 아닙니다.** 코드·DB·정책 문서를 바꾸지
  않았습니다. §8의 계약 개정은 사람이 승인해야 착수할 수 있습니다.
- 증거 표기: `[코드]` 저장소 확인 · `[정책]` 승인된 문서 · `[관측]` 첨부
  스크린샷 · `[측정]` 이 문서에서 계산 · `[확인 불가]` 근거 부족

## 개정 이력

**v6 (2026-08-24, 5차 검토 반영 — `attachmentIntent` 재설계 4건).**

| # | v5의 문제 | v6 |
|---|---|---|
| 1 | `attachmentIntent`의 출처를 `turnAttachmentDescriptors`로 적음 — **descriptor는 C(편집)와 D(분석)를 구분하지 못함** | §5.1에 `classifyImageIntent({ text, attachments })` 도입, **L0·L1이 공유**(B-6). 첨부만 보면 D 요청에도 불필요한 고지가 붙습니다 |
| 2 | 세 문단을 다 싣고 **마지막이 앞을 정정**하는 구조 — 모델에게 상충 지시 | **배타 분기**로 교체. 편집 분기는 handoff·SVG를 처음부터 넣지 않습니다. 상한 382 → **351토큰** |
| 3 | `CORE`의 "cannot generate images"와 artifact 문단의 "create an SVG"가 **한 요청 안에서 모순** | `CORE`를 **raster workflow·인라인 raster**로 한정, A-3이 "내려받는 파일"임을 명시 |
| 4 | 편집 문안이 "앱 어디에서도 지원 안 함"이라고 **범위를 과장** | **image workspace의 한계**로 좁히고, 첨부를 보고 답하는 것은 계속 가능하다고 명시 — D 분류를 막지 않는 장치 |
| 5 | "16조합"이라는 표현이 부정확 | 상태는 **24개**, `artifact`의 두 값이 같은 문안을 내고 편집 분기가 나머지와 무관해 **고유 문안 9개**로 정정 |

**v5 (2026-08-24, 4차 검토 반영 — 정합성 3건 + 구현 확인 항목).**

| # | v4의 문제 | v5 |
|---|---|---|
| 1 | `CORE`가 **항상** "무엇을 하면 얻을 수 있는지 말하라"고 지시 — `hidden` + artifact off에는 안내할 경로가 없어 모델이 지어낼 수 있음 | A-1 문안을 **"주어진 대안만, 없으면 한계만"**으로 교체하고 전 조합 재측정 |
| 2 | C-② 결정이 **문안에 반영되지 않음** — 첨부 편집 요청에도 workspace를 안내할 수 있었음 | **세 번째 축 `attachmentIntent`** 신설(A-4), 조립 순서 고정, 16조합 측정표 |
| 3 | 본문에 v3 수치("190토큰 구간", "고지만 150토큰")가 잔존, 배수 조건을 "도달"로 서술 | §5.1을 **204~382**로 갱신, `> threshold`(**초과**)로 정정 |
| 4 | `upgrade` + artifact `available` 조합 누락 — Free 계정에서 실재 | A-5 표에 포함(1,150B / 288tok) |
| 5 | 구현 정합성 항목이 흩어져 있음 | **부록 B** 신설 — snapshot default-off 보존, `setImageGenerationEnabled()` 무효화, preflight 동일 builder, 품질 주장 금지, 조립 순서 |

**v4 (2026-08-24, 3차 검토 반영 — 설계 공백 2건 + 문안 4건).**

| # | v3의 문제 | v4 |
|---|---|---|
| 1 | 후보 문안이 **가용 상태를 반영하지 않음** — flag off·Guest·Free에게 없는 문을 가리킴 | §5.1에 `imageHandoff`·`artifact` **2축 조립** 도입, 부록 A를 문단 단위로 재작성, 토큰 표를 **상태별 177~293**으로 갱신. `route.ts`가 image flag를 읽지 않는다는 **구현 공백**도 명시 |
| 2 | **C 분류(첨부 편집)의 안내 시점 미정** | §5.4 신설 — C-①·②·③ 비교와 권장(C-②), ①·③은 별도 작업 |
| 3 | 후보 문안에 **ASCII 예외 문장이 없음** (본문에만 있었음) | 부록 A-1 `CORE`에 문장 추가 후 재측정 |
| 4 | 후보 B가 `diagram`·`infographic`까지 workspace로 안내 — L3 보류와 충돌 | 부록 A-2 `available` 문단이 **"텍스트 밀집 도표에는 안내하지 말 것"**을 명시 |
| 5 | 요약이 다시 "구현 비용이 낮다"로 읽힘 | §10에서 **"인계 실행은 낮음 / L1 전체는 중간"**으로 통일 |
| 6 | `lib/models.ts:269` 줄 번호가 리비전에 따라 어긋남 | §1의 참조를 **심볼 기준**으로 바꾸고, 이 문서는 줄 번호를 근거로 쓰지 않는다고 명시 |

**v3 (2026-08-24, 2차 검토 반영 — 보완 6건).**

| # | v2의 문제 | v3 |
|---|---|---|
| 1 | C-3이 artifact 정책 **§13**을 인용 — 그 절은 첨부 템플릿 일괄 생성이라 무관 | §8 C-3을 **§2·§4·§6·§9**로 정정 |
| 2 | L0 토큰 수치를 **재현할 수 없음** (측정 원문 부재) | **부록 A** 신설 — 후보 문안 전문·재현 명령·한국어 문안 주의 |
| 3 | `Draft`가 두 뜻으로 쓰임 (workspace draft ↔ 품질 preset) | §3.4 표를 "Draft **품질 preset**"으로, 용어 주의 문단 추가 |
| 4 | "돌아오면 그 대화는 존재하지 않습니다" — 사실과 다름 | §2 정정: 원래 대화는 남아 있고 **아직 저장 안 된 image draft로 문맥이 바뀐다**. IME 위험은 `[추론]`으로 표기 |
| 5 | "L1 구현 비용이 낮다" — 인계 함수만 본 표현 | §3.3에서 **인계 실행은 낮음 / L1 전체는 중간**으로 분리, 새로 필요한 6가지 명시 |
| 6 | 탐지 예외 2건 누락, `30%`가 정책값처럼 읽힘 | §5.1에 **명시적 ASCII 요청 예외**, §5.3에 **`compositionend` 이후 평가**, `30%`를 실험 가설로 표기 |

**v2 (2026-08-24, 1차 검토 반영 — 조건부 승인 의견 7건).** v1의 다음 오류를
정정했습니다. 각 항목은 본문에 반영돼 있습니다.

| # | v1의 문제 | v2 |
|---|---|---|
| 1 | 자동 draft 전환과 자동 유료 생성을 **D-3 하나로 묶음** | §2에서 D-3a·D-3b로 분리. draft 전환은 크레딧을 쓰지 않으므로 "되돌릴 수 없다"는 근거가 적용되지 않습니다 |
| 2 | 다중 목적지를 발견해 놓고 L1은 **단일 칩**으로 되돌림 | §5에 의도 4분류 도입, L1 범위를 **명백한 raster 생성**으로 축소 |
| 3 | 계약 개정 대상에 **상위 정책 누락** | §8 C-1이 `docs/policy/image-generation.md` §13과 UI 계약 **둘 다** |
| 4 | Router를 "nothing built yet"으로 서술 — **사실과 다름** | §5.2 정정. 실제는 `task-profile-v2` 존재, 상태는 "wired, not shipped". 결합하지 않는 근거를 **책임·실행 시점 차이**로 교체 |
| 5 | SVG를 기술적 우월 경로처럼 서술 | §6에 trade-off. artifact는 **다운로드 카드**이고 인라인 시각 결과가 아닙니다 |
| 6 | L0 효과 "사라집니다" · 비용 "매우 낮음" | §5.1에서 **best-effort**로 하향, 토큰 비용 `[측정]` |
| 7 | 탐지 규칙이 거칠음 | §5.3 재작성 — 구절 단위 판정, 첨부 처리, dismiss 범위, consent 경로 |

---

## 0. 결론부터

**탐지는 하되, 실행은 사용자가 누릅니다.** 그리고 이 제안이 고치려는 결함은
전환 기능의 부재가 아니라 **채팅이 못 하는 일을 못 한다고 말하지 않는 것**입니다.
둘을 분리하지 않으면 전환 제안이 안 뜬 turn에서 같은 화면이 재현됩니다.

| 층 | 무엇 | 기본값 | 권장 |
|---|---|---|---|
| L0 | 채팅 turn에 **이미지 능력 고지 system block** — 문자 그림 대체 금지 | 도입 | **1순위**, best-effort 방어 |
| L1 | composer에서 **제출 전** 제안 칩 — **명백한 raster 생성 의도에만** | 도입 | 권장 |
| L2 | 답변 이후 "이미지로 만들기" | 보류 | L1 관측 후 |
| L3 | 텍스트 밀집 도표·인포그래픽의 SVG/이미지 선택 UX | 보류 | **L1과 분리해 별도 설계** |
| D-3a | 확인 없이 image **draft만** 자동으로 열기 | **하지 않음** | 비용은 없으나 오탐 시 화면이 통째로 바뀝니다 |
| D-3b | 확인 없이 **generation 제출** | **하지 않음** | 크레딧 소비 — 가격·모델 동의 필요 |
| C | 첨부 편집 요청의 안내 시점 | **L0에서만**(C-②) | ①·③은 별도 작업 — §5.4 |

---

## 1. 관찰 — 무엇이 실제로 실패했나

`[관측]` 사용자: "고혈압에 좋은 음식을 이해하기쉽도록 인포그래픽으로 그려줘"
→ `Grok 4.5`가 **텍스트 상자·화살표로 그린 ASCII 인포그래픽**을 스트리밍.

그 turn의 사실`[코드]`:

이 표의 파일 참조는 **심볼 기준**입니다. 줄 번호는 개정마다 움직이므로
(2차 검토에서 `lib/models.ts:269`와 `:283`이 어긋난 것이 그 예입니다) 이 문서는
줄 번호를 근거로 쓰지 않습니다.

| 항목 | 값 | 근거 |
|---|---|---|
| 모델 | `grok-4-5`, `premium-reasoning`, `creditWeight: 8`, Pro 전용 | `lib/models.ts`의 `grok-4-5` 항목 |
| artifact tool | **비활성** — xAI는 `ARTIFACT_TOOL_CAPABILITIES`에 의도적으로 부재 → `unverified` | `lib/generatedArtifactToolPolicy.ts` |
| 그 turn이 받은 지시 | `offPrompt("model_unverified")` — "다운로드 파일을 만들 수 없다. 파일 경로·링크·base64·저장하는 코드를 쓰지 마라" | 같은 파일 |
| **이미지에 대한 지시** | **없음** | 같은 파일 |

모델은 "파일은 못 만든다"는 말은 들었지만 **"이미지도 못 만든다"는 말은 들은 적이
없고**, 자기가 낼 수 있는 최선의 그림 — 문자 그림 — 을 낸 것입니다. 폭주가 아니라
**지시 공백에 대한 반응**입니다.

그리고 이 모델은 artifact tool도 없으므로, **그 turn에는 SVG라는 대안도 없었습니다.**
이 사실이 §6의 결론을 좌우합니다.

> 결함 정의: 결함은 "이미지를 안 만들어 준 것"이 아니라, **요청한 산출물의 종류가
> 이 화면에서 불가능하다는 사실을 아무도 말해 주지 않은 것**입니다. 사용자는
> 8크레딧을 쓰고, 요청하지 않은 형식의 답을 받고, 왜 그런지도 무엇을 하면 되는지도
> 듣지 못했습니다.

---

## 2. "자동 전환"은 하나의 결정이 아니라 넷입니다

**v1은 D-3을 하나로 묶는 오류를 범했습니다.** image draft 전환은 서버 행도
크레딧 소비도 없습니다`[코드]` — `handleStartImageDraft`
(`app/(site)/(application)/chat/ChatPageClient.tsx:2365`)는 클라이언트 상태만
바꾸고, 계약이 *"Switching to the image draft creates no server row"*로 이를
못박고 있습니다`[정책]`. 따라서 두 결정은 위험도가 다릅니다.

| # | 결정 | 질문 | 되돌릴 수 있나 |
|---|---|---|---|
| D-1 | **탐지** | 이 프롬프트가 이미지 요청인가 | 예 — 틀려도 화면 한 줄 |
| D-2 | **제안** | 무엇을 어떻게 보여 줄 것인가 | 예 |
| D-3a | **자동 draft 전환** | 확인 없이 workspace를 열 것인가 | **예 — 비용 0, 취소 시 채팅 draft·첨부 복원** |
| D-3b | **자동 생성 제출** | 확인 없이 크레딧을 쓸 것인가 | 금전적으로는 환급 가능하나, **동의 없는 지출** |

### D-3a에 반대하는 근거는 비용이 아니라 UX입니다

`AGENTS.md`는 잘못된 과금조차 "되돌릴 수 있음"으로 분류하므로, v1이 D-3a에까지
"되돌릴 수 없다"를 적용한 것은 과잉이었습니다. D-3a를 여전히 권하지 않는 이유는
따로 있습니다.

1. **오탐 1건의 비용이 화면 전체입니다.** 칩은 무시하면 그만이지만, 자동 전환은
   사용자가 타이핑하던 화면을 통째로 갈아치웁니다. 복원 경로가 있어도 "내가 하지
   않은 이동"은 신뢰를 깎습니다.
2. **문맥이 저장되지 않은 곳으로 바뀝니다.** 원래 채팅 대화가 사라지는 것은
   아닙니다 — 서버에 그대로 있고 취소하면 draft와 첨부까지 복원됩니다`[코드]`.
   문제는 화면이 **아직 저장된 적 없는 image draft**로 옮겨 간다는 점이고,
   사용자에게는 자기 대화가 사라진 것처럼 보인다는 점입니다.
3. IME 조합 중 화면 전환은 입력 손실 위험이 있습니다`[추론]` — 확인된 결함이
   아니라, `docs/ui-contracts/mobile-chat-composer.md`가 한국어 IME 회귀 검증을
   절대 조건으로 요구하는 맥락에서 나온 위험 추론입니다.

### D-3b에 반대하는 근거는 계약입니다

정책은 **"가격은 제출 전에 모델별·총액으로 고지"**를 계약으로 못박고 있고`[정책]`,
멀티 모델 비교가 핵심 계약이라 모델 선택은 사용자의 것입니다(§3.5). 환급 가능성이
무단 지출의 근거가 되지는 않습니다.

---

## 3. 현 아키텍처가 이미 정해 놓은 제약

새로 정할 필요 없는, 승인된 사실들입니다.

### 3.1 채팅과 이미지는 같은 대화가 될 수 없습니다

`Conversation.kind`는 UI 구분이 아니라 **서버 authorization 경계**입니다.
`lib/conversationKindGuard.ts` 주석`[코드]`: *"UI non-exposure is not a security
boundary -- every server endpoint checks."* 채팅 endpoint는 이미지 대화를 409로
거절하고 그 반대도 같습니다.

→ **"이 대화에서 이미지를 만든다"는 선택지는 존재하지 않습니다.**

### 3.2 `selectionMode: "auto"`는 이 논의와 무관합니다 — 이름 충돌 주의

Auto는 **Chat 전용 모델 자동 선택**이고(`lib/conversationProduct.ts`,
`AUTO_SELECTION_PRODUCT = "chat"`)`[코드]`, `studio + auto`는 DB CHECK가
거절합니다. 문구 규칙상 Auto는 "더 좋은/최적"을 약속할 수도 없습니다`[정책]`.

→ 이 기능을 **"Auto"로 부르면 안 됩니다.** 예: **"이미지 요청 인계(image intent
handoff)"**.

### 3.3 인계 경로는 이미 구현돼 있습니다

`handleStartImageDraft(draftText, modelId?)``[코드]` — composer 텍스트를 seed로
넘기고, 원래 draft를 `chatDraftBeforeImage`에 보관했다가 취소 시 **첨부까지**
복원하며, 서버 행을 만들지 않습니다.

→ **인계 실행 비용은 낮습니다** — 새 생성 파이프라인이 필요 없고 진입점만
추가하면 됩니다. 다만 **L1 전체의 구현 비용은 "중간"**입니다. 아래가 전부 새로
필요합니다.

| 새로 필요한 것 | 비고 |
|---|---|
| A/B/C/D 분류 모듈 | 순수 모듈 1개 + 사전 |
| dismiss 상태 수명주기 | draft 범위, 재노출 조건 |
| analytics event·property schema | consent 경로 준수 |
| Guest·Free 잠금 분기 | §3.6 |
| locale 문구 (ko/en) | 칩·잠금·안내 |
| desktop·mobile·IME·접근성 테스트 | 계약이 요구하는 회귀 범위 |

v1·v2 초안의 "구현 비용이 낮다"는 인계 함수 재사용만 본 표현이었고, 위 목록이
빠져 있었습니다.

### 3.4 가격 차이가 두 자릿수입니다

| 경로 | 크레딧 |
|---|---:|
| 채팅 1 turn (`grok-4-5`) | 8 |
| 이미지 생성 — **Draft 품질 preset** | 15 |
| 이미지 생성 — Standard 품질 preset | 60~70 |
| 이미지 생성 — Final 품질 preset | 200~250 |
| `grok-imagine` 1K | 75 |

`[정책]` `docs/policy/image-generation.md` §3, §12.1

**용어 주의**: 표의 `Draft`는 **품질 preset**이고, §2의 "image draft 전환"은
**아직 제출되지 않은 작성 상태**입니다. 서로 다른 것이며, 전자만 크레딧을
씁니다. 이 문서에서 preset을 가리킬 때는 항상 "Draft 품질 preset"으로 씁니다.

### 3.5 모델 선택이 프롬프트보다 먼저입니다

*"Model selection sits above the textarea: the price the composer quotes is
decided before the prompt is written."*`[정책]`

### 3.6 Guest·Free는 잠금을 **미리** 봅니다

진입점은 숨기지도 마지막 단계에서 막지도 않고 요구 조건을 클릭 **전에**
말합니다`[정책]`. Guest → 로그인, Free → `/pricing`.

### 3.7 진입점은 **정책과 UI 계약 양쪽에서** 네 곳입니다

- `docs/policy/image-generation.md` §13: *"진입점은 네 곳이다"* + *"두 문서가
  어긋나면 이 정책이 우선한다"*`[정책]`
- `docs/ui-contracts/image-generation-workspace.md`: *"There are exactly four,
  and no standalone 'New image' button"* + *"A second image button anywhere is a
  contract violation, not a convenience"*`[정책]`

→ **제안 칩은 다섯 번째 진입점이며, 개정 대상은 두 문서입니다.** 상위 정책을
그대로 두고 UI 계약만 고치면 **정책이 우선한다는 규정 때문에 개정이 무효**입니다.
v1은 이 문서를 빠뜨렸습니다.

---

## 4. 그래서 무엇을 하지 않는가

| # | 하지 않을 것 | 근거 |
|---|---|---|
| 1 | 확인 없는 generation 제출 (D-3b) | §2, §3.4, §3.5 |
| 2 | 확인 없는 draft 자동 전환 (D-3a) | §2 — 비용이 아니라 UX·IME 근거 |
| 3 | 모든 이미지 의도를 한 목적지로 보내기 | §5 — 의도가 넷입니다 |
| 4 | "Auto"라는 라벨 재사용 | §3.2 |
| 5 | 제안이 떠 있다고 전송을 막기 | 오탐이 채팅을 차단하면 안 됩니다 |
| 6 | 계약 개정 전 구현 | §3.7 |

---

## 5. 권장 설계

### 5.1 L0 — 이미지 능력 고지 system block

`lib/generatedArtifactToolPolicy.ts`가 파일에 대해 하는 일을 이미지에 대해
합니다. 채팅 route는 이미 system block을 조립하고 각각의 토큰을 과금 추정에 더하는
구조라, 세 번째 block이 같은 자리에 들어갑니다
(`app/api/chat/route.ts:1934-1958`)`[코드]`.

블록이 말해야 하는 것:

- 이 대화에서는 **이미지를 생성할 수 없다**
- **ASCII·박스·화살표·이모지 배치로 그림을 대신하지 말 것** — 오늘의 실패 모드를
  이름으로 지목합니다. 단 **표는 표이지 그림이 아니므로** 일반 서식은 계속 허용
- **명시적 요청은 예외입니다.** 사용자가 "ASCII 아트로 그려 줘", "텍스트로
  다이어그램 만들어 줘"처럼 문자 그림 **자체를** 요청하면 금지 대상이 아닙니다.
  이 블록이 막는 것은 *요청받지 않은 대체*이지 문자 그림이라는 형식이 아닙니다.
  예외를 적지 않으면 사용자가 명시적으로 부탁한 것을 거절하게 됩니다
- 사용자가 그림을 요청하면 그 사실을 사용자 언어로 말하고, **그 turn에서 실제로
  가능한 대안만** 제시할 것
- 질문 자체에 대한 답은 계속 해도 된다

#### 단일 문안이 아니라 **상태별 조립**입니다

v3까지의 후보 문안은 "이미지 생성은 도구 메뉴에 있습니다"를 무조건 안내했습니다.
그러면 flag가 꺼진 배포·Guest·Free에게 **없는 문을 가리키게** 됩니다. 계약이
말하는 "실제로 가능한 대안만"을 지키려면 블록은 두 축의 계획 결과로 조립돼야
합니다.

```
intent:       none | edit_or_reference        <- 배타 분기 (가산 축이 아님)
imageHandoff: hidden | sign_in | upgrade | available
artifact:     unavailable | sign_in | available
```

| 입력 | 오늘의 출처 |
|---|---|
| `intent` | **분류기 결과** — 아래 참조 |
| `imageHandoff` | `isImageGenerationEnabled()`(`lib/appSettings.ts`) + `planAllowsImageGeneration(tier)`(`lib/imageGenerationAccess.ts`)`[코드]` |
| `artifact` | `planGeneratedArtifactTool()`의 `mode`·`offReason``[코드]` |

#### `intent`는 첨부가 아니라 **분류 결과**입니다

v5는 이 값을 `turnAttachmentDescriptors`에서 얻는다고 적었는데, descriptor가
아는 것은 **이미지 첨부가 있다는 사실뿐**입니다. 아래 둘의 descriptor는
동일합니다.

| 요청 | 분류 |
|---|---|
| 이미지 첨부 + "배경을 바꿔 줘" | **C** (편집) |
| 이미지 첨부 + "이 사진을 설명해 줘" | **D** (분석 — 채팅이 잘하는 일) |

첨부만 보고 판정하면 **D 요청에도 "편집은 지원하지 않는다"는 불필요한 고지**가
붙습니다. 그래서 입력은 프롬프트와 첨부를 함께 읽은 분류기여야 합니다.

```ts
classifyImageIntent({
  text: latestUserMessage,
  attachments: turnAttachmentDescriptors,
})
```

**이 순수 분류기를 L1(클라이언트)과 L0(서버)이 공유합니다.** §5.3이 말한 "사전과
판정은 한 순수 모듈"이 바로 이것이고, 두 벌을 두면 칩이 뜨는 조건과 블록이 붙는
조건이 서로 다르게 흘러갑니다.

#### 배타 분기이지 가산 축이 아닙니다

v5는 세 문단을 모두 싣고 **마지막 문단이 앞의 안내를 정정**하게 했습니다. 그것은
모델에게 상충하는 지시를 준 뒤 뒤엣것이 이기기를 기대하는 구조입니다. 상호
배제가 안전합니다.

```
if intent == edit_or_reference:
    CORE + EDIT_LIMITATION
else:
    CORE + IMAGE_HANDOFF[state] + ARTIFACT[state]
```

편집 분기에서는 handoff·SVG 문단을 **처음부터 넣지 않습니다.** 결과로 상한이
382 → **351토큰**으로 내려가고, 상태 24개가 만드는 **고유 문안은 9개**뿐입니다
(편집 분기 1 + 그 외 8).

**받아들인 손실 하나**: 편집 분기에서는 artifact가 `available`이어도 SVG를
제안하지 않습니다. 그 turn의 요청은 *첨부에 대한 것*이지 새 도표를 만드는 것이
아니므로 지금은 단순함을 택합니다. 관측에서 "첨부 편집 요청 뒤 SVG를 원했다"가
보이면 그때 되돌아봅니다.

**`hidden` + artifact off에서는 대안이 하나도 없습니다.** 그래서 공통 문단은
"무엇을 하면 얻을 수 있는지 말하라"고 무조건 지시하지 않고, **아래에 주어진
대안만 제시하고 없으면 지어내지 말라**고 지시합니다(부록 A-1).

**`hidden` + artifact off에서는 대안이 하나도 없습니다.** 그래서 공통 문단은
"무엇을 하면 얻을 수 있는지 말하라"고 무조건 지시하지 않고, **아래에 주어진
대안만 제시하고 없으면 지어내지 말라**고 지시합니다(부록 A-1). 그렇게 하지 않으면
안내할 경로가 없는 조합에서 모델이 외부 제품이나 없는 메뉴를 지어냅니다.

**여기에 구현 공백이 하나 있습니다.** `app/api/chat/route.ts`는 오늘 이미지
flag를 읽지 않습니다`[코드]` — 이 값은 chat page의 RSC가 클라이언트로만
내려보냅니다. 플랜 tier는 route가 이미 가지고 있으므로(`accountPlan?.tier`),
새로 필요한 것은 **flag 읽기 한 번**입니다. 다만
`getOperationalFeatureFlags()`는 이 flag를 포함하지 않고
(`aiChatEnabled`·`attachmentsEnabled`·`publicSharingEnabled` 셋뿐)`[코드]`,
`isImageGenerationEnabled()`는 캐시되지 않는 DB 조회입니다. **turn마다 DB를 한 번
더 치지 않도록** 기존 설정 조회나 public snapshot에 합쳐야 합니다. 이것은 L0의
숨은 비용이며, C-5에 넣었습니다.

**artifact tool이 꺼진 turn에서 SVG를 권하면** 이 저장소가 이미 고친 결함 —
"할 수 없는 것을 할 수 있다고 말하기" — 을 다시 만듭니다. 첨부 화면의 turn이
정확히 이 경우입니다(§1).

**두 블록이 같은 turn에 실린다는 점도 계약입니다.** artifact 블록은 이미 자기
사정을 말하므로, 이미지 블록은 artifact가 **available일 때만** SVG를 언급하고
그 외에는 침묵합니다. 로그인·모델 미검증 사유를 두 블록이 각자 설명하면 같은
turn에 같은 말이 두 번 실립니다.

#### 효과 — best-effort이지 강제가 아닙니다

v1의 "그 화면은 사라집니다"는 과장이었습니다. system block은 모델에 대한
**지시**이지 출력 검사기가 아닙니다. artifact 쪽도 같은 한계를 안고 운영되며,
그래서 정확한 표현은 **"재발 가능성을 낮춥니다"**입니다. 결정적 강제를 원하면
답변 본문 검사가 필요하고, 그것은 별개의 프라이버시 결정입니다.

#### 비용 `[측정]`

`estimateTextTokens`는 비CJK 4바이트/토큰입니다(`lib/chatTokenEstimate.ts:112`)`[코드]`.

고유 문안 9개 전체는 §9 부록 A-5에 있습니다. 대표값만 옮기면(비교용: 기존
artifact `offPrompt`는 422바이트 / 106토큰):

| 문안 | 바이트 | 추정 토큰 |
|---|---:|---:|
| `hidden` · artifact off — **최소** | 923 | **231** |
| `upgrade` · artifact **on** (Free의 흔한 상태) | 1,267 | 317 |
| `edit_or_reference` (handoff·artifact 무관) | 1,205 | 302 |
| `available` · artifact on — **최대** | 1,404 | **351** |

turn당 **231~351 토큰**입니다. 하한이 v5(204)보다 오른 것은 `CORE`가 범위를
정확히 말하도록 길어졌기 때문이고(§9 A-1), 상한이 내려간 것은 배타 분기 덕분입니다.

| 개정 | 구조 | 범위 |
|---|---|---:|
| v3 | 단일 문안 | 150~192 |
| v4 | 2축 가산 | 177~293 |
| v5 | 3축 가산 | 204~382 |
| **v6** | **2축 + 배타 분기** | **231~351** |

대표 모델의 입력가로 환산하면:

| 모델 | 입력가 | turn당(최소~최대) | 월 100k turn |
|---|---:|---:|---:|
| `gpt-5-6-luna` | $0.20/1M | 46~70µUSD | 약 $4.6~7.0 |
| `grok-4-5` | $2.00/1M | 462~702µUSD | 약 $46~70 |

**가산 축을 늘리면 상한이 곱으로 오릅니다.** 새 상태는 가능하면 배타 분기로
표현하고, 가산 축은 사용자의 행동을 실제로 바꿀 때만 추가합니다.

`[코드]` `lib/modelPricing.ts` · 월 turn 수는 `[확인 불가]`이므로 100k는 예시입니다.

**주의 — 사용자 크레딧에 미치는 영향은 0이 아닙니다.** 크레딧은 weight 기준이지만
`getInputCreditMultiplier()`가 입력 토큰이 **16,000 · 50,000 · 100,000을 초과할
때**(`> threshold`, 도달이 아니라 초과) 1.5×·2×·3×로 계단을 올립니다
(`lib/models.ts`의 `INPUT_CREDIT_MULTIPLIERS`)`[코드]`. 즉 경계 바로 아래
**231~351토큰 구간**에 있던 turn은 이 블록 때문에 배수가 올라갑니다. 드물지만
존재하며, "비용 없음"이라고 쓰면 안 되는 이유입니다. 완화책은 **최소 문안을 짧게
유지하는 것**(CORE 단독 = 231토큰)이고, 그래서 CORE에 문장을 더하는 것이 가장
비싼 편집입니다 — 모든 문안에 실립니다.

### 5.2 L1 — composer 제안 칩, **명백한 raster 생성 의도에만**

v1은 다중 목적지를 발견해 놓고 단일 칩으로 되돌리는 모순이 있었습니다. 탐지는
최소한 넷을 구분해야 합니다.

| 분류 | 예 | L1 대상 |
|---|---|---|
| **A. raster 생성** | "고양이 그림 그려 줘", "배경 이미지 만들어 줘", "제품 사진 느낌으로" | **예 — 1차 범위** |
| B. 텍스트 밀집 도표 | "인포그래픽으로", "순서도로", "표를 도식으로" | 아니오 → **L3에서 별도 설계** |
| C. 첨부 편집·참조 | 이미지 첨부 + "이거 배경만 바꿔 줘" | 아니오 — **범위 밖임을 말해야 함** |
| D. 기존 이미지 분석 | 이미지 첨부 + "이거 설명해 줘" | 아니오 — 채팅이 맞습니다 |

**첨부 화면의 요청은 B입니다.** 즉 L1이 배포돼도 그 화면은 L0로만 개선되며, B의
답은 L3에서 따로 정합니다. 이것을 A와 묶어 이미지 workspace로 보내면 v1이 지적한
문제를 그대로 반복합니다.

칩의 규칙:

- **언제**: composer에 텍스트가 있고, 제출 **전**, A 신호가 잡혔을 때
- **어디**: composer 위 한 줄. textarea의 가로 행을 침범·중첩·부유하지 않습니다
  (`docs/ui-contracts/mobile-chat-composer.md` 절대 조건)`[정책]`
- **누르면**: `handleStartImageDraft(value)` — 기존 함수
- **잠금**: Guest → 로그인, Free → `/pricing`. 칩은 보이고 요구 조건을 칩 안에서
  말합니다(§3.6)
- **무시 가능**: 칩이 있어도 그냥 전송하면 채팅으로 갑니다
- **색**: `accent-image-*` 만. AI Review gradient는 예약돼 있습니다`[정책]`

### 5.3 탐지 방식과 규칙

| 방식 | 비용 | 지연 | 평가 |
|---|---|---|---|
| **클라이언트 규칙 기반** | 0 | 0ms | **권장** |
| 서버 LLM 분류 호출 | turn마다 추가 과금 | 추가 왕복 | 반대 — 칩 한 줄에 크레딧을 씁니다 |
| Router의 Task Profiler 재사용 | — | — | **지금은 결합하지 않습니다**(아래) |

#### Router와 결합하지 않는 이유 — v1의 서술 정정

v1의 "Router는 nothing built yet"은 **사실과 다릅니다.** 저장소에는
`lib/taskProfileCore.ts`(`TASK_PROFILE_VERSION = "task-profile-v2"`, 규칙 기반
분류)와 `lib/routerDecision.ts`·`routerSelection.ts`·`routerScorePolicy.ts` 등이
존재합니다`[코드]`. 정확한 상태는 **"wired, not shipped"**이고, release-gate
보고서 분류로는 `built, nothing measures it`입니다.

결합하지 않는 실제 근거는 미구현이 아니라 **책임과 실행 시점의 차이**입니다.

| | Task Profiler | L1 탐지 |
|---|---|---|
| 어디서 | 서버, turn 제출 후 | 클라이언트, **타이핑 중** |
| 무엇을 정하나 | 어느 모델로 보낼까 | 이 요청이 이 화면 것이 맞나 |
| 틀리면 | 모델 선택이 나빠짐 | 칩 한 줄 |
| 언제 답해야 하나 | 제출 후 수백 ms 허용 | **입력 중 즉시** |

제출 후에야 나오는 분류는 "제출 전에 다른 곳으로 안내한다"는 L1의 목적을 구조적으로
충족할 수 없습니다. 다만 **어휘는 공유하는 편이 낫습니다** — 훗날 Profiler에
이미지 의도가 들어오면 두 곳이 다른 이름을 쓰지 않도록, 분류 어휘를 하나의 순수
모듈(`lib/imageIntentSignals.ts` 등)에 두고 시작합니다.

#### 규칙 설계 — v1보다 촘촘하게

v1의 규칙은 다음이 위험했습니다.

1. **"설명해 줘"를 부정 신호로 쓰면 안 됩니다.** "**그림으로** 설명해 줘"는 A/B
   의도입니다. 판정은 낱말이 아니라 **구절 단위**로 합니다 — `{그림|이미지|도식|
   일러스트} + {으로|로} + {설명|정리|표현}`은 **긍정**입니다.
2. **첨부가 있으면 "약화"가 아니라 "분기"입니다.** 첨부 + 생성 동사는 C(편집)이고,
   편집은 범위 밖입니다`[정책]`. 이때 칩을 안 띄우고 조용히 채팅으로 보내면
   §1과 같은 결함을 다른 자리에서 반복합니다. **"첨부 이미지 편집은 아직
   지원하지 않습니다"를 명시**해야 하며, 이 안내는 L0 블록의 분기로도 필요합니다.
3. **IME 조합 중에는 평가하지 않습니다.** 자동 전환을 하지 않더라도 칩이
   나타나면 composer 높이가 바뀌고, 한글 조합 중의 레이아웃 이동은 그 자체로
   입력 사고입니다. 판정은 `compositionend` 이후(그리고 짧은 debounce 뒤)에만
   수행합니다.
4. **dismiss 범위를 정의해야 합니다.** "같은 draft"의 정의가 v1에 없었습니다.
   제안: 닫은 시점의 정규화된 텍스트를 기준으로, **길이 30% 이상 변하거나 새 A
   신호가 추가되면** 다시 제안할 수 있고, 그 외에는 억제합니다. 한 draft에서
   재노출은 최대 1회, 전송 후에는 상태를 버립니다.
   **`30%`는 정책값이 아니라 실험 가설입니다**`[추론]` — 근거가 없는 초기값이고,
   §7의 닫기율·재노출률 관측으로 조정할 대상입니다. 문서에 못박지 않습니다.
5. **텔레메트리는 기존 consent 경로를 따릅니다.** 프롬프트 원문을 저장하지 않는
   것만으로는 부족하고, `analyticsConsent()`가 `declined`면 전송하지 않는 기존
   경로를 그대로 씁니다(`lib/productAnalyticsClient.ts`)`[코드]`. 남기는 필드는
   `matched`, `intentClass`, `accepted`, `dismissed`, locale 정도입니다.
6. **재현율 우선, 정밀도 양보** — A 분류에 한해서입니다. B·C·D로 판정되면 칩을
   띄우지 않습니다.
7. 사전과 판정은 **한 순수 모듈**에 둡니다. 목록이 갈라지는 것이 이 저장소의
   반복된 사고 원인입니다`[정책]`.

### 5.4 C 분류(첨부 편집)의 안내 시점 — 결정 필요

v3은 "지원하지 않는다고 말해야 한다"고만 적고 **언제 어디서**를 정하지
않았습니다. 그대로 두면 사용자는 **제출하고 채팅 크레딧을 쓴 뒤 L0 답변에서야**
제한을 알게 됩니다. 세 안 중 하나를 골라야 합니다.

| 안 | 동작 | 비용 | 사용자 경험 |
|---|---|---|---|
| **C-①** 제출 전 비동작 안내 칩 | 첨부 + 생성 동사 감지 시 "첨부 이미지 편집은 아직 지원하지 않습니다" 칩 | **L1과 별개의 UI·locale·테스트** | 크레딧 쓰기 전에 앎 |
| **C-②** 제출 허용, L0에서만 고지 | 추가 UI 없음 | 0 | 크레딧 1 turn 쓰고 나서 앎 |
| **C-③** ①에 더해 "첨부를 빼고 text-to-image로" 선택지 제공 | 첨부 제거 + draft 전환을 한 동작으로 | ① + 첨부 제거 흐름·복원 규칙 | 가장 친절하나 **첨부를 지우는 파괴적 동작**이라 확인이 필요 |

**권장은 C-②로 시작**입니다. 근거는 범위입니다 — C는 L1의 대상이 아니고, ①·③은
L1과 무관한 UI·문구·테스트를 새로 요구하므로 "명백한 raster 의도만"이라는 1차
범위 축소와 모순됩니다. L0이 이미 그 turn에서 이유를 말하므로 사용자는 **적어도
침묵당하지는 않습니다.**

다만 C-②는 공짜가 아닙니다. **L0에 배타 분기가 하나 생기고**(§5.1),
`classifyImageIntent`가 C와 D를 갈라 줘야 하며(첨부 유무로는 갈리지 않습니다),
그 분기의 문안이 302토큰입니다(§9 A-4). **추가 UI는 없지만 분류기와 문단은
필요합니다.** 대신 편집 분기에서 handoff·SVG 문단을 빼므로 블록 상한은 오히려
382 → 351토큰으로 내려갑니다.

C-①·③을 고른다면 **별도 작업으로 뺍니다**. L1에 얹으면 L1의 범위가 다시
넓어집니다.

### 5.5 L2 — 답변 이후 액션 (보류)

새 결정 하나를 요구합니다: **무엇을 프롬프트 seed로 쓸 것인가.** 사용자의 마지막
메시지인지 답변 요약인지, 후자면 요약 생성 비용이 듭니다. §3.1에 따라 이 액션은
*지금 이 대화를 떠나는* 동작이므로 라벨에 그 사실이 드러나야 합니다.
→ **L1 관측 후 결정**을 권합니다.

---

## 6. SVG는 "정답"이 아니라 trade-off입니다 — v1 정정

v1은 SVG를 기술적으로 우월한 기본 경로처럼 서술했습니다. 사실 관계를 정리합니다.

`[코드]` SVG는 artifact 형식표에 있습니다(`lib/generatedArtifactFormats.ts:199`).
그러나 결과물은 **다운로드 카드**입니다 — `GeneratedArtifactCard`의 주석이
*"The download card for a file an answer produced"*이고, 응답은
`attachment; filename=...`입니다(`lib/generatedArtifactCore.ts:234`)`[코드]`.
**인라인 시각 결과가 아닙니다.**

| 기준 | SVG artifact | 이미지 workspace |
|---|---|---|
| 한글 글자 정확성 | **유리** — 텍스트가 그대로 들어갑니다 | `[확인 불가]` — 한국어 글자 정확도 미검증`[정책]` |
| 편집 가능성 | **유리** | 불가 |
| 즉시 보이는 시각 결과 | **불리** — 내려받아 열어야 합니다 | **유리** |
| 사진·삽화 표현력 | 불리 | **유리** |
| 크레딧 | 채팅 turn 비용 | 15~250 |
| 가용 조건 | 모델이 `verified`, **로그인**, 저장 가능한 대화, native 검색 비충돌 — 넷 다 필요`[코드]` | flag + Pro·Max |

첨부 화면의 turn은 `grok-4-5`라 **첫 조건부터 실패**했습니다(§1). 즉 "SVG로
줬으면 됐다"는 그 turn에 대해서는 성립하지 않습니다.

→ 따라서 §5.2의 B 분류(텍스트 밀집 도표)는 **L3에서 별도 설계**합니다. 사용자에게
두 갈래를 제시하려면 각 갈래의 가용 여부와 "다운로드 파일 대 화면 이미지"라는 UX
차이를 함께 설명해야 하고, 그것은 칩 한 줄에 담기지 않습니다.

**미결 — 제품 판단**: B 요청의 기본 목적지는 무엇입니까? 제 의견은 "가용하면 SVG를
먼저 제시"이지만, 이는 포지셔닝 결정이지 기술 판정이 아닙니다.

---

## 7. 측정

| 지표 | 의미 | 주의 |
|---|---|---|
| 칩 노출률 | A 의도 turn의 비중 | 원문 저장 금지, consent 경로 준수 |
| 칩 수용률 | 제안이 맞았는가 | 낮으면 A 사전이 넓은 것 |
| 칩 닫기율 | 방해도 | 수용률보다 높으면 재설계 |
| 잠금 칩 클릭 → 전환율 | Free 업그레이드 동기로서의 값 | — |
| B·C·D 오분류 신고 | 분류 경계의 건전성 | 정성 표본 |
| **L0 이후 문자 그림 재발** | 실제로 낮아졌는가 | `[확인 불가]` — 자동 판정 수단 없음. 사람이 표본을 봐야 하고, 만들려면 답변 본문 검사라는 별개 결정이 필요합니다 |

---

## 8. 착수 전에 사람이 해야 할 것

| # | 항목 | 성격 |
|---|---|---|
| C-1 | **두 문서를 함께 개정**: `docs/policy/image-generation.md` §13(진입점 네 곳) + `docs/ui-contracts/image-generation-workspace.md` Entry points. **"제안은 진입점이지 실행이 아니다"**를 규칙으로 명시 | **차단** — 정책이 UI 계약에 우선하므로 한쪽만 고치면 무효 |
| C-2 | 정책에 "확인 없는 자동 draft 전환·자동 생성 제출 금지" 명시 (D-3a·D-3b 각각) | 권장 |
| C-3 | L0 블록이 SVG를 권해도 되는 조건 — `docs/policy/generated-artifacts.md` **§2(가용성)·§4(형식)·§6(보안)·§9(UI 계약)**과의 정합. v2 초안이 §13을 인용했으나 그 절은 첨부 템플릿 일괄 생성이라 무관합니다 | 확인 |
| C-4 | 기능 이름 확정 (`Auto` 금지, §3.2) | 결정 |
| C-5 | L0 블록 **상태별** 문안 확정 후 토큰 재측정(§9), 16k 경계 배수 영향 수용 여부, 그리고 **image flag를 turn마다 DB에서 읽지 않도록** 기존 설정 조회·snapshot에 합치는 방법. 합칠 경우 **부록 B의 B-1·B-2가 함께 따라옵니다** | 결정 |
| C-6 | **C 분류 안내 시점** — C-①(제출 전 칩) / C-②(L0에서만, 권장) / C-③(첨부 제거 + 전환) 중 택일. ①·③은 별도 작업으로 분리 | 결정 |

미결 질문:

1. **B(텍스트 밀집 도표)의 기본 목적지는 SVG입니까 이미지입니까?** (§6)
2. L1 칩을 **Guest·Free에게도 띄웁니까?** 계약의 잠금 노출 원칙은 그렇다고 답하지만,
   부르지 않은 자리에 뜨는 업그레이드 유도라는 반론이 있습니다.
3. L3(B 분류 UX)를 이번 범위에 넣습니까, 별도 작업으로 뺍니까?
4. **C 분류에 제출 전 안내를 붙입니까?**(§5.4) 붙이지 않으면 사용자는 채팅 1 turn을
   쓰고 나서 제한을 알게 됩니다 — 받아들일 수 있는 비용인지의 판단입니다.

---

## 9. 부록 A — L0 블록 측정 원문과 재현 절차

§5.1의 231~351토큰은 아래 **후보 문안**을 잰 값입니다. 문안이 바뀌면 수치도
바뀌므로 C-5(재측정)와 함께 읽습니다. 이 문안은 **측정을 재현하기 위한 초안**이며
확정된 제품 문구가 아닙니다.

블록은 고정 문안 하나가 아니라 **배타 분기 + 공통 문단 + 상태별 문단**으로
조립합니다(§5.1). 문단 사이는 빈 줄(`\n\n`) 하나로 잇습니다 — 이 빈 줄을 빼면
바이트가 맞지 않습니다.

```
if intent == edit_or_reference:  CORE + EDIT_LIMITATION
else:                            CORE + IMAGE_HANDOFF[state] + ARTIFACT[state]
```

### A-1. 공통 문단 `CORE` (923 bytes / 231 tokens) — 항상 실림

```text
# Images

This chat cannot run the raster image-generation workflow, and cannot
return a generated raster image inside the message. If the user asks for
a picture, an illustration, a diagram or an infographic, say plainly what
this chat can and cannot produce, in the user's language.

Offer only an alternative described below. If no alternative is provided,
state the limitation without inventing or recommending another path.

Never substitute a drawing made of text characters -- no ASCII art, no
box-drawing or arrow diagrams standing in for a picture, no emoji layout
pretending to be a chart. A text approximation of a requested image is a
silent substitution, not an answer. The one exception is an explicit
request for text art itself ("draw it in ASCII art"), which you may honour.

You may still answer the question itself in words, and you may still use
ordinary formatting -- a table is a table, not a drawing.
```

**첫 문단이 v5에서 바뀐 부분입니다.** v5는 "You cannot generate images in this
conversation"이라고 넓게 말했는데, 같은 요청에 SVG 문단이 함께 실립니다 —
**SVG도 이미지이므로 모델이 받는 지시가 서로 모순**입니다. 이제 `CORE`가 부정하는
것은 **raster 생성 workflow와 메시지 안에 그려지는 raster 이미지**로 한정되고,
파일로 내려받는 SVG는 A-3 문단이 따로 설명합니다.

두 번째 문단은 **주어진 대안만 제시하고, 없으면 한계만 말하라**입니다. 대안이
하나도 없는 조합(`hidden` + artifact off)에서 "무엇을 하면 얻을 수 있는지 말하라"고
지시하면 모델이 외부 제품이나 없는 메뉴를 지어냅니다.

문자 그림 금지의 **예외**도 문안 안에 있습니다.

### A-2. `imageHandoff` 문단 — 편집 분기가 아닐 때만

**`hidden`** — 문단 없음. flag가 꺼진 배포에서는 그 기능이 아무에게도 존재하지
않으므로 언급 자체가 없습니다.

**`sign_in`** (109 bytes / 28 tokens)

```text
Image generation exists in this app but requires signing in. Say that
much and no more about how to reach it.
```

**`upgrade`** (124 bytes / 31 tokens)

```text
Image generation exists in this app but is included only in the paid
plans. Say that much and no more about how to reach it.
```

**`available`** (261 bytes / 66 tokens)

```text
For a photo or an illustration, image generation is a separate workspace
in this app, reachable from the composer's tools menu. Point the user
there for those. A text-heavy chart or infographic is outside that
path's current scope -- do not point there for one.
```

마지막 두 줄이 **B 분류를 L3까지 보류한다는 결정을 문안으로 옮긴 것**입니다.
표현은 "잘 만들지 못한다"가 아니라 **"이 경로의 현재 범위 밖"**입니다 — 전자는
검증되지 않은 품질 주장이고, 이 저장소는 근거 없는 품질 문구를 문구 검사로
막습니다`[정책]`.

### A-3. `artifact` 문단 — 편집 분기가 아니고 `available`일 때만 (216 bytes / 54 tokens)

```text
For a chart or diagram whose text must be exact, you can instead create a
downloadable SVG file with the file tool. That is a file the user
downloads, not a picture drawn inside the message; say so when you offer
it.
```

두 번째 문장이 `CORE`와의 정합을 유지합니다 — `CORE`가 부정한 것은 *메시지 안에
그려지는 raster 이미지*이고, 이것은 *내려받는 파일*이라 서로 다른 것입니다.

`unavailable`·`sign_in`에서는 **문단 없음** — artifact 블록이 같은 turn에서 이미
자기 사정을 말합니다(§5.1).

### A-4. `EDIT_LIMITATION` — 편집 분기일 때만 (280 bytes / 70 tokens)

```text
This turn carries an image the user attached. The image-generation
workspace cannot edit an attached image or use one as a reference; it
starts from text only. Say that plainly rather than sending the user
there. You may still look at the attachment and answer questions about it.
```

**범위가 v5에서 좁혀졌습니다.** v5는 "not supported anywhere in this app"이라고
했는데, 정책이 확정한 것은 **image workspace가 text-to-image 전용**이라는
사실뿐입니다`[정책]`. 채팅 모델은 첨부 이미지를 볼 수 있고(`inputCapabilities.
image`), artifact 가능 모델이라면 본 내용을 바탕으로 파일을 만들 여지도
있습니다`[코드]`. 마지막 문장이 그 여지를 닫지 않으며, 이것이 D 분류(분석)를
막지 않는 장치입니다.

이 문단이 실리는 turn에는 A-2·A-3 문단을 **넣지 않습니다.**

### A-5. 문안별 측정값

상태 조합은 `imageHandoff` 4 × `artifact` 3 × `intent` 2 = **24개**이지만,
`artifact`의 `unavailable`과 `sign_in`은 같은 문안(문단 없음)을 내고 편집
분기는 나머지 두 축과 무관하므로 **고유 문안은 9개**입니다.

| 분기 | `imageHandoff` | `artifact` | 바이트 | 토큰 |
|---|---|---|---:|---:|
| `none` | `hidden` | off | 923 | **231** |
| `none` | `hidden` | on | 1,141 | 286 |
| `none` | `sign_in` | off | 1,034 | 259 |
| `none` | `sign_in` | on | 1,252 | 313 |
| `none` | `upgrade` | off | 1,049 | 263 |
| `none` | `upgrade` | on | 1,267 | 317 |
| `none` | `available` | off | 1,186 | 297 |
| `none` | `available` | on | 1,404 | **351** |
| `edit_or_reference` | — | — | 1,205 | 302 |

`upgrade` + artifact `on`은 **Free 계정의 실재 상태**입니다 — 이미지 생성에는
업그레이드가 필요하지만 파일 생성은 쓸 수 있습니다.

### A-6. 재현 명령

`estimateTextTokens`는 비CJK 구간을 4바이트/토큰으로 셉니다
(`lib/chatTokenEstimate.ts`, `ACTIVE_ESTIMATOR_VERSION =
"generic_multilingual_v1"`). 위 문안은 전부 ASCII이므로 다음이 성립합니다.

```bash
# 조립한 문안을 block.txt에 저장한 뒤
wc -c block.txt
node -e 'console.log(Math.ceil(require("fs").statSync("block.txt").size/4))'
```

저장소 함수로 직접 재는 편이 정확합니다.

```bash
npx tsx -e 'import{estimateTextTokens}from"./lib/chatTokenEstimate";\
import{readFileSync}from"fs";\
console.log(estimateTextTokens(readFileSync("block.txt","utf8")))'
```

**한국어 문안을 쓰면 수치가 달라집니다** — 한글은 별도 계수로 계산되므로 위
4바이트 근사가 성립하지 않습니다. 최종 문안이 정해지면 실제 함수로 다시 재고,
§5.1 표와 C-5를 함께 갱신합니다.

**주의**: 이 블록은 turn마다 실려 나가므로, 문안을 늘리는 것은 문서 편집이 아니라
**단가 인상**입니다. 특히 `CORE`는 모든 문안에 실리므로 가장 비싼 편집 대상입니다.

---

## 10. 부록 B — 구현 시 확인할 것

설계가 아니라 **구현자가 놓치기 쉬운 정합성 항목**입니다. 각 항목은 저장소에서
확인한 사실을 근거로 합니다.

| # | 항목 | 근거 |
|---|---|---|
| B-1 | **image flag를 public snapshot에 합칠 때 default-off 의미를 보존할 것.** `getOperationalFeatureFlags()`의 셋은 default-**on** kill switch(`enabledFromValue`: `"false"`가 아니면 켜짐)이고, 이미지 flag는 그 반대입니다(`imageGenerationEnabledFromValue`: `"true"`일 때만 켜짐). **같은 해석 함수를 재사용하면 행이 없는 배포에서 기능이 켜진 것으로 읽힙니다.** | `lib/appSettings.ts`, `lib/imageGenerationAccess.ts``[코드]` |
| B-2 | **`setImageGenerationEnabled()`가 snapshot을 무효화하도록 할 것.** 오늘 이 함수는 `invalidatePublicSnapshot()`을 부르지 않습니다 — 같은 파일의 `updateGuestDefaultModel()`은 부릅니다. snapshot에 넣기 전이라 지금은 결함이 아니지만, 넣는 순간 **관리자가 끈 기능이 TTL 동안 계속 안내되는** 상태가 됩니다. | `lib/appSettings.ts``[코드]` |
| B-3 | **전송 route와 `/api/chat/preflight`가 같은 builder·같은 토큰 값을 쓰도록 할 것.** 오늘 preflight는 artifact 블록을 아예 세지 않습니다(`app/api/chat/preflight/route.ts`에 artifact 관련 코드 없음). **즉 이 어긋남은 이미 존재하고**, 이미지 블록을 route에만 추가하면 그 격차가 커집니다. 표시·예약·실제 전송의 입력 배수가 달라질 수 있습니다. | `app/api/chat/route.ts`, `app/api/chat/preflight/route.ts``[코드]` |
| B-4 | **품질 주장을 문안에 넣지 말 것.** A-2의 `available` 문단은 "범위 밖"으로 씁니다. | §9 A-2 |
| B-5 | **정정이 아니라 배제로 조립할 것.** 편집 분기에서는 handoff·SVG 문단을 **넣지 않습니다.** 세 문단을 다 싣고 마지막이 이기기를 기대하는 구조는 모델에게 상충 지시를 주는 것입니다. | §5.1, §9 A-4 |
| B-6 | **분류기를 L0·L1이 공유할 것.** `classifyImageIntent({ text, attachments })` 하나를 서버 블록과 클라이언트 칩이 함께 씁니다. 두 벌이면 칩이 뜨는 조건과 블록이 붙는 조건이 갈라집니다. 특히 **첨부 유무만으로 C와 D를 가르면 안 됩니다** — descriptor는 둘을 구분하지 못합니다. | §5.1 |
| B-7 | **`CORE`가 부정하는 범위를 SVG와 어긋나게 두지 말 것.** "이미지를 만들 수 없다"와 "SVG 파일을 만들 수 있다"가 한 요청에 같이 들어가면 모순입니다. raster workflow·인라인 raster로 한정합니다. | §9 A-1·A-3 |

---

## 11. 요약

- 자동 **탐지**는 타당합니다. **인계 실행 비용은 낮지만**(기존
  `handleStartImageDraft` 재사용) **L1 전체의 구현 비용은 "중간"**입니다 — 분류
  모듈·dismiss 수명주기·analytics schema·잠금 분기·locale·테스트가 새로
  필요합니다(§3.3).
- 자동 **draft 전환(D-3a)**은 비용이 아니라 **오탐 시 화면 강탈·IME 위험**을 근거로
  권하지 않습니다. 자동 **생성 제출(D-3b)**은 가격 고지 계약과 충돌합니다.
- 이 제안이 겨냥한 화면은 전환 기능이 아니라 **고지 부재**의 결과이며, 같은 결함을
  파일에 대해서는 이미 해결해 두었습니다. **L0이 1순위**이되 효과는 best-effort이고
  turn당 **231~351토큰**의 실비가 들며, 문안은 단일 고정이 아니라
  **배타 분기(`intent`) + 2축(`imageHandoff`·`artifact`)**으로 조립해야
  합니다(§5.1) — 상태 24개, 고유 문안 9개. 대안이 하나도 없는 조합에서는
  **없는 경로를 지어내지 말라**고 지시해야 합니다.
- L1은 **명백한 raster 생성 의도로 범위를 좁혀** 시작하고, 첨부 화면 같은 텍스트
  밀집 인포그래픽은 **L3에서 SVG/이미지 선택 UX로 따로** 설계합니다.
- 착수 전 **`image-generation.md` §13과 UI 계약 둘 다** 개정해야 하고, 구현에서는
  **부록 B의 7건**(snapshot default-off 보존, 관리자 토글의 snapshot 무효화,
  preflight와 전송 route의 동일 builder, 품질 주장 금지, 정정이 아닌 배제,
  L0·L1 분류기 공유, `CORE` 범위와 SVG의 정합)을 확인합니다.
- **관측된 사례는 B 분류입니다.** 따라서 L0만 배포하면 재발 **가능성을 낮출 뿐**이고,
  L3(텍스트 밀집 도표의 SVG/이미지 선택 UX)가 마련되기 전까지 첨부 화면의 요청은
  **결정적으로 해결되지 않습니다.** L0을 1순위로 두는 것은 그것이 완결이어서가
  아니라, 그때까지의 turn에서 사용자가 최소한 이유와 대안을 듣게 하기 위해서입니다.
