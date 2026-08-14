# A2 — Gemini(Google Takeout) Import 설계

## 상태

- 종류: 릴리스 A2 설계
- 상태: **scope 승인됨 (2026-08-14, `@mposition`). parser 구현 착수만 허용되며
  production 활성화는 별도 승인입니다** — §10
- 상위 정책: `docs/policy/external-conversation-import-and-memory.md`
  (§2 범위표의 A2 행, §4.1 digest, §4.2 중복·재-import, §5.1 파싱 위치,
  §5.6 정규화)
- 최초 작성: 2026-08-13
- 개정: 2026-08-14 — 실제 `내활동.json` 실측으로 §2의 진행 조건이 해소됐고,
  대신 세 가지 새 계약(§2.1 분기, §3.1 archive 인식, §4.1 첨부 누락)이
  생겼습니다.

이 문서는 상위 정책이 "별도 설계·fixture·eval 후 추가"라고 미뤄 둔 그 설계입니다.
계약을 넓히지 않고, A2가 **기존 계약을 만족할 수 있는지**와 만족하지 못한다면
**어디서 멈춰야 하는지**를 정합니다.

## 1. 실측으로 정정된 전제

§2 범위표는 A2 연기 사유를 "locale 의존 HTML 구조"라고 적었습니다. 실제 Takeout
산출물을 확인한 결과 그 전제는 **부분적으로 틀렸고, 더 중요한 문제를 가리고
있었습니다.**

2026-08-13, 실제 Takeout의 `Gemini` 디렉터리 샘플을 확인했습니다.

| 파일 | 내용 |
|---|---|
| `gemini_gems_data.html` | 사용자가 만든 **Gem**(맞춤 Gemini)의 이름과 지시문 |
| `gemini_scheduled_actions_data.html` | 예약 작업. 샘플에서는 빈 `<div></div>` |

**대화 기록이 없습니다.** Takeout의 `Gemini` 항목은 Gems와 예약 작업이고, 대화는
**활동 데이터**로 분류되어 `My Activity → Gemini Apps` 아래에 있습니다. 그리고
My Activity는 내보내기 형식으로 **JSON을 선택할 수 있습니다**.

따라서 세 가지가 달라집니다.

1. **연기 사유의 재검토.** JSON을 받을 수 있다면 "locale 의존 HTML"은 A2를
   막는 이유가 아닙니다. 기존 ChatGPT·Claude 경로도 JSON을 읽으므로
   (`lib/externalImportArchive.ts`의 `CONVERSATION_FILENAMES`) 같은 틀에
   들어갑니다. 다만 **HTML만 가진 사용자**를 어떻게 대할지는 §6에서 정합니다.
   그리고 locale 의존은 사라진 것이 아니라 **자리를 옮겼습니다** — §3.1.
2. **안내 문구가 바뀌어야 합니다.** 사용자가 Takeout에서 "Gemini"를 선택하면
   대화가 아니라 Gems를 받게 됩니다. Wizard의 provider 안내가 "My Activity →
   Gemini Apps, 형식 JSON"을 지목하지 않으면, 대부분의 사용자가 **잘못된 파일을
   올리고 빈 결과를 받습니다.**
3. **활동 기록이 꺼져 있으면 export 자체가 비어 있습니다.** 계정 설정에서
   Gemini Apps Activity가 off면 대화가 저장되지 않으므로 Takeout에도 없습니다.
   이것은 오류가 아니라 정상 상태이며, 그렇게 구분해서 표시해야 합니다.

## 2. 진행을 막던 핵심 질문 — 해소됨

이것이 A2의 실제 난점이었습니다. 초판은 이렇게 적었습니다. ChatGPT·Claude
export는 **대화 단위 문서**를 주므로 §4.1이 요구하는
`rawExternalConversationId`가 원본에 존재하지만, My Activity는 이름 그대로
**시간순 활동 나열**이어서 항목들을 하나의 대화로 묶는 식별자가 payload에
있는지 알 수 없다 — 없다면 시간 근접으로 묶는 것도(추측이므로 export마다 결과가
달라짐) 전체를 하나로 묶는 것도(선택 단위가 사라짐) 받아들일 수 없다.

**2026-08-14, 실제 파일로 확인했고 식별자는 존재합니다.**

각 활동 항목의 `details[].url`이 `https://gemini.google.com/app/<16 hex>`
형태이고, 이 hex가 대화 ID입니다. 따라서 **A2는 ChatGPT·Claude와 같은 모양으로
진행합니다.** 위의 세 대안은 모두 불필요하며, 특히 시간 근접 묶기는 앞으로도
금지입니다.

측정한 export는 **한 계정의 한 번의 내보내기 1건**입니다. 아래 수치는 그 표본의
사실이며, 모든 Takeout이 이렇다는 근거가 아닙니다. 구조에 대한 계약은 §5의
"인식하지 못한 구조는 거절" 규칙이 계속 담당합니다.

| 항목 | 값 |
|---|---|
| 활동 항목 | 819 |
| 구분되는 대화 | 50 |
| 대화 ID가 없는 항목 | 2 |
| 첨부 참조 | 183건, 그중 아카이브에 실제 존재 146건 |

항목 하나의 구성은 다음과 같습니다.

| 필드 | 내용 |
|---|---|
| `title` | 사용자 프롬프트 (plain text) |
| `safeHtmlItem[].html` | 모델 답변. markdown이 HTML로 렌더된 것 |
| `time` | ISO 8601 + 밀리초 + `Z` |
| `details[].url` | 이 turn이 속한 대화 링크 |
| `subtitles[]` | Gem 사용 표시, 첨부 개수 문장, 첨부 파일명 |
| `attachedFiles[]`, `imageFile` | 형제 디렉터리의 파일명 문자열 |

즉 **항목 하나 = user 1 + assistant 1**이며, 대화 ID로 묶고 `time`으로 정렬하면
멀티턴 대화가 복원됩니다. 파일 안의 항목 순서는 대화별로는 대체로 시간 역순이지만
**전역으로는 정렬돼 있지 않습니다.** 순서를 파일 순서에 의존하지 않습니다.

### 2.1 분기 — 한 항목이 여러 대화에 속합니다

식별자가 있다는 사실보다 이쪽이 설계에 더 크게 걸립니다.

측정한 export에서 **231개 항목이 2~4개의 대화 ID를 동시에 가집니다.** 그 항목들의
대화 집합은 서로 포함 관계이고(예: 139 ⊂ 140 ⊂ 141, 90 ⊂ 218), 230개의 제목이
`분기된 `으로 시작합니다. Gemini에서 대화를 분기하면 분기점 이전의 turn이 새
대화에도 그대로 남기 때문입니다.

**따라서 `externalMessageStableId`는 대화 scope 안에서 정해져야 합니다.**
provider와 메시지 내용만으로 id를 만들면, 서로 다른 대화 4개에 각각 들어가야 할
같은 turn이 하나로 합쳐지거나 중복으로 오판됩니다. 이것은 파서의 구현 세부가
아니라 §4.2가 정의한 lineage·중복 판정의 전제이므로, 파서를 쓰기 전에 여기서
정합니다.

### 2.2 결정 — 분기는 각각 독립된 대화입니다

**2026-08-14 결정.** 분기된 대화는 각각 독립된 대화로 가져옵니다.

가장 긴 분기 하나만 고르는 대안은 셋 다 틀립니다. 짧은 분기에만 있는 내용을
조용히 잃고, "가장 길다"가 사용자가 실제로 쓰는 분기라는 보장이 없으며, 재-export
때 길이가 달라지면 가져오는 분기가 **바뀝니다**. 마지막 것은 §4.2의 재-import
판정을 직접 깨뜨립니다.

독립 대화 방식은 겹치는 turn만큼 quota를 더 씁니다. 그것을 숨기지 않고 preview에
표시하고 분기별로 해제할 수 있게 하는 것이 정직한 동작입니다.

계약으로 고정합니다.

1. **lineage는 provider가 준 대화 ID로만 만듭니다.** 이 export에서는 분기마다
   자기 16-hex 대화 ID가 있으므로 그 ID가 곧 terminal ID이고, 별도로 합성할
   branch 번호가 없습니다. `externalConversationStableId`의 입력은
   (provider, 계정 scope, 그 대화 ID)입니다.
2. **배열 순번도 분기 길이도 ID에 넣지 않습니다.** 둘 다 export마다 달라질 수
   있는 값이고, ID에 들어가는 순간 재-import가 다른 lineage를 만듭니다.
3. **`externalMessageStableId`는 대화 stable ID를 입력으로 받습니다.** 같은
   turn이 분기 4개에 속하면 저장되는 메시지도 4개이며, 서로 다른 stable ID를
   가집니다.
4. **공유 prefix turn도 실제 저장량과 quota에 그대로 포함합니다.** 겹친다는
   이유로 quota에서 빼면, 사용자가 보는 저장 결과와 청구 근거가 어긋납니다.
5. **preview는 분기 수와 겹치는 turn 수를 표시합니다.** 측정한 export 기준으로는
   819항목 중 231이 겹칩니다.
6. **같은 export를 다시 올리면 같은 분기로 판정합니다.** 대화 ID가 입력의 전부
   이므로 이것은 1·2의 따름 결과입니다.
7. **새 분기가 생겨도 기존 분기의 stable ID는 변하지 않습니다.** 다음 export에
   분기가 추가되면 새 대화 하나가 늘 뿐이고, 기존 대화의 ID·lineage는
   그대로입니다.

분기들 사이의 부모·자식 관계는 대화별 turn 집합의 포함 관계로 **관찰할 수는**
있지만, 그 관계를 identity에 넣지 않습니다. 포함 관계는 사용자가 어느 한쪽을
지우면 사라지는 성질이고, identity가 거기 의존하면 삭제가 남은 대화의 ID를
바꿉니다.

## 3. 코드에서 파서가 들어가는 자리

식별자 문제가 해결됐다는 가정에서, 확장 지점은 좁습니다. 이 목록 자체가
"A2가 기존 틀에 들어간다"는 주장의 근거입니다.

| 지점 | 파일 | 변경 |
|---|---|---|
| provider 열거 | `lib/externalImportAdapters/types.ts` | `ExternalAdapterProvider`에 `"gemini"` 추가 |
| adapter | `lib/externalImportAdapters/gemini.ts` | 신규. 등록은 `index.ts` |
| 인식 | 같은 파일의 `detect()` | **`CONVERSATION_FILENAMES`은 건드리지 않습니다** — §3.1 |
| 파싱 | 브라우저 Web Worker (§5.1) | adapter 호출. **원본 archive는 서버에 올라가지 않습니다** |
| 정규화 | §5.6 | 아래 §4 |
| 안내 문구 | `ProviderGuideStep.tsx` + 7개 locale | §1의 2번 — My Activity·JSON을 지목 |

**adapter 계약이 하나 넓어집니다.** 기존 두 provider는 "최상위 항목 하나 = 대화
하나"라 `parseConversation(entry)`로 충분하지만, Takeout은 항목 하나가 turn
하나이고 그 turn이 **어느 대화들에 속하는지는 전체 목록을 봐야 압니다.** 그래서
선택적 `parseAll(items)`을 추가하고, 있으면 pipeline이 그쪽을 부릅니다. 기존
provider의 경로는 그대로입니다.

### 3.1 archive 인식 — 고정 파일명으로는 찾을 수 없습니다

측정한 export에서 대화 파일의 실제 경로는 다음이었습니다.

```
Takeout/내 활동/Gemini 앱/내활동.json
```

디렉터리도 파일명도 **계정 언어로 번역됩니다.** 영어 계정이면
`Takeout/My Activity/Gemini Apps/MyActivity.json`이 됩니다. JSON 안의 값도
같습니다 — `header`는 `Gemini 앱`, `products`는 `["Gemini 앱"]`,
`activityControls`는 `["Gemini 앱 활동"]`, subtitle은
`이 채팅에 …이 사용되었습니다`·`파일 N개 첨부됨.`입니다.

두 가지가 따라옵니다.

- **`CONVERSATION_FILENAMES`에 이름을 추가하는 것으로는 부족합니다.** 인식은
  경로 문자열이 아니라 **내용 형태**로 해야 합니다 — 최상위가 배열이고, 항목이
  `title`·`time`·`details`를 가지며, `details[].url`이 Gemini 대화 링크인지.
  언어 목록을 늘려 가는 방식은 목록에 없는 locale에서 조용히 "대화 0건"을
  냅니다.
- **어떤 파싱 규칙도 번역된 문장에 의존하지 않습니다.** 첨부 여부는
  `파일 N개 첨부됨.`이 아니라 `attachedFiles`·`imageFile`의 존재로 판정하고,
  Gem 사용 여부는 문장이 아니라 `subtitles[].url`이 `gemini.google.com/gems/`
  인지로 판정합니다.

### 3.2 오늘의 규칙은 실제 Takeout을 통째로 거절합니다

2026-08-14, 실제 아카이브의 디렉터리 목록을 `planArchiveEntries()`에 그대로
넣어 실행했습니다. 결과는 **거절**입니다.

```
ExternalImportArchiveError nested_archive
entry decisions: skip:media 128, skip:unsupported_extension 47,
                 parse:candidate 1, reject:nested_archive 4
```

사용자가 대화에 **`.zip` 파일을 첨부했기 때문**입니다. 첨부는 형제 파일로 함께
내보내지고, `lib/externalImportArchive.ts`는 `.zip` 확장자를 `nested_archive`로
거절하며 `planArchiveEntries()`는 첫 거절에서 아카이브 전체를 던집니다. 대화
JSON은 정상적으로 `parse:candidate`로 잡히는데도 그 앞에서 멈춥니다.

이것은 A2가 아니라 상위 정책 §5.2의 규칙이므로 **A2 예외를 두지 않고 공통
규칙을 바꿨습니다**(2026-08-14 결정). 근거는 다음과 같습니다.

- 우리는 첨부를 **복제하지 않습니다**(§4). 즉 이 `.zip`을 열 계획이 애초에
  없습니다. `nested_archive` 거절이 막으려는 것은 *펼치는 것*인데, 펼치지 않는
  경로에서는 막을 대상이 없습니다.
- 압축 폭탄 방어는 팽창시킬 때만 의미가 있고, media를 `skip`으로 처리하는 지금
  규칙이 이미 같은 원리를 씁니다 — 열지 않으면 크기가 무해합니다.

**완화한 것은 거절 여부 하나뿐이며 보안 한도가 아닙니다.** 해제 깊이는 계속
0이고(내부를 열지도 열거하지도 검사하지도 않음), path traversal · absolute
path · 암호화 entry는 그대로 archive 전체 거절이며, container 크기와 entry 수
한도도 그대로입니다. 최상위에 파싱 가능한 대화 데이터가 없으면 여전히
`no_conversation_data`입니다.

skip 개수는 **자기 이유로** 셉니다(`unsupported_extension`에 섞지 않음). preview
문구는 `externalImport.warningNestedArchives`이며 7개 locale에 있습니다. 자세한
계약은 상위 정책 §5.2를 봅니다.

digest·stable id 함수는 이미 `provider`를 입력으로 받으므로 **바뀌지 않습니다**
(`externalConversationStableId`, `externalMessageStableId`). 새 provider 값이
해시 입력에 들어가므로 다른 provider와 id가 충돌하지 않고, 계정별 scope도
그대로 유지됩니다.

**`EXTERNAL_IMPORT_DIGEST_VERSION`은 올리지 않습니다.** provider 추가는 기존
provider의 digest 계산을 바꾸지 않으며, 버전을 올리면 이미 저장된 ChatGPT·Claude
snapshot이 전부 다른 lineage로 보이게 됩니다.

## 4. 정규화 (§5.6 적용)

- **`user`·`assistant` 두 role만** 저장합니다. Gemini 활동 항목이 검색 질의,
  확장 프로그램 호출, 시스템 안내 같은 것을 함께 담고 있으면 그것은 사용자
  메시지가 아니며, 조용히 변환하지 않고 **warning + count**로 preview에
  표시합니다.
- **Gems는 대화가 아닙니다.** 보내주신 샘플이 보여주듯 Gem은 지시문이고,
  A2 범위 밖입니다. Gem을 "대화"로 저장하면 §5.6이 금지하는 "system·developer를
  사용자 메시지로 위장 저장"에 해당합니다. Assistant Profile(릴리스 C)이 그
  자리이며, 그때도 별도 승인이 필요합니다.
- 이미지·오디오·첨부는 복제하지 않고 건너뛴 수를 표시합니다(A와 동일).
- **`title`은 프롬프트의 미리보기가 아니라 프롬프트 전문입니다.** 측정한
  export에서 최대 11,799자였습니다. 초판은 제목이 앞부분만 담는다고 보고 별도
  필드 저장을 제안했지만, 그렇게 하면 같은 내용을 두 번 세게 됩니다.
  `title`이 user 메시지 본문이고, 대화 제목은 원본에 없으므로 **만들어 내지
  않습니다.**
- **답변은 HTML입니다.** `safeHtmlItem[].html`은 markdown이 렌더된 결과이며,
  측정한 export의 태그는 `strong`·`p`·`code`·`li`·`h3`·`hr`·`ul`·`td`·`pre`·
  `tr`·`ol`·`em`·`br`·`th`·`h2`·`h4`·`blockquote`·`table`·`a`·`img`로
  한정됐습니다. 저장 형식은 A와 같은 평문·markdown이며 HTML을 그대로 넣지
  않습니다(`lib/externalImportAdapters/geminiHtml.ts`).

  **목록 밖의 태그를 만나면 그 답변 하나를 버리고 셉니다**
  (`skippedUnrecognizedContent`). export 전체를 거절하지 않는 이유는 adapter
  계약이 "한 항목의 손상이 아카이브 전체를 실패시키지 않는다"이기 때문이고,
  §5의 요구는 *조용히* 버리지 않는 것이므로 개수 표시가 그 요구를 만족합니다.
  프롬프트는 평문이라 이해에 의심이 없으므로 남깁니다.
- **대화 제목은 첫 프롬프트를 줄여 만듭니다.** 원본에 제목 필드가 없고, 전부
  "제목 없음"으로 두면 선택 화면에서 대화 50개를 구분할 수 없습니다. Gemini
  자신이 목록에 보여 주는 것도 첫 프롬프트이므로 **지어내는 것이 아니라
  파생**입니다. 80 code point로 자르며, 프롬프트 자체는 첫 user 메시지로 한 번만
  저장되므로 quota를 두 번 세지 않습니다.

### 4.1 첨부는 참조가 남아 있어도 파일이 없을 수 있습니다

측정한 export에서 `attachedFiles` 참조 183건 중 **37건이 아카이브에 존재하지
않았습니다**(`.tsx` 22, `.zip` 7, `.ts` 3, `.md` 3, 그 외 2). 30건은 파일명에
해시 접미사를 그대로 달고 있었으므로 이름 규칙이 어긋난 것이 아니라 Takeout이
파일을 빼고 준 것입니다.

따라서 preview는 **"복제하지 않고 건너뜀"과 "원본에 파일이 없음"을 구분해
셉니다.** 둘을 한 숫자로 합치면, 사용자는 우리가 버린 것과 Google이 주지 않은
것을 구별할 수 없습니다. 어느 쪽도 import를 실패시키지는 않습니다.

## 5. 조용히 틀리지 않기 — 실패 모드

Takeout 구조는 예고 없이 바뀝니다. A2에서 가장 나쁜 결과는 파싱 실패가 아니라
**절반만 맞게 파싱된 결과**입니다.

- 인식하지 못한 구조는 **거절**합니다. 부분 복구를 시도하지 않습니다.
- 파서는 자기 버전을 기록합니다(`EXTERNAL_IMPORT_PARSER_VERSION`, A2에서
  `v3`). 구조 변경은 새 버전이며, 기존 snapshot의 digest는 소급 변경하지
  않습니다.
- "대화 0건"과 "파일을 이해하지 못함"은 **다른 화면**이어야 합니다. 전자는
  활동 기록이 꺼져 있었거나 Gems 파일을 올린 경우이고, 후자는 우리 문제입니다.
- Gems·예약 작업 파일을 올린 경우는 특별히 알아보고, "이 파일에는 대화가 없고
  My Activity에서 받아야 한다"고 **정확히** 안내합니다. 이것이 첫 사용자
  다수가 겪을 경로입니다.
- **대화 ID가 없는 항목은 버리지도, 아무 대화에나 붙이지도 않습니다.** 측정한
  export에서 819건 중 2건이 `details`를 아예 갖고 있지 않았습니다. 어느 대화에
  속하는지 원본이 말하지 않으므로 추정하지 않고, 건너뛴 수를 preview에
  표시합니다.

## 6. HTML만 가진 사용자

My Activity는 JSON과 HTML 중 선택이며, 기본값이 항상 JSON이라고 가정할 수
없습니다. 첫 릴리스에서는 **JSON만 지원**하고 HTML은 거절하되, 거절 문구가
"형식을 JSON으로 다시 내보내 주세요"라고 말하게 합니다. HTML 파서는 별도
결정이며, locale 의존 구조라는 원래의 우려가 **여기에만** 남습니다.

## 7. Fixture 전략과 개인정보

**실제 사용자의 Takeout을 저장소에 넣지 않습니다.** 2026-08-13에 받은 샘플에는
실제 개인정보(보유 제품 목록과 생활 루틴, 직무 맥락)가 들어 있었고, fixture로
쓰지 않았습니다. git 이력은 영구적이며 §19의 content-free 원칙과도 어긋납니다.

2026-08-14에 받은 전체 export는 더 넓었습니다 — 사업계획서 문서, 소스 코드,
업무 이메일 초안, 사진 91장. 이 문서의 수치는 **구조 분석의 결과일 뿐이며 본문은
저장소에도 이 문서에도 옮기지 않았습니다.** 작업 사본은 저장소 밖 임시
디렉터리에만 두었습니다.

fixture는 다음 중 하나여야 합니다.

- **합성 export**: 테스트 계정에서 만든 대화(멀티턴, 코드 블록, 아주 긴 답변,
  첨부 포함)로 실제 Takeout을 받아 그대로 사용. 가장 좋은 형태입니다.
- **구조만 남긴 축약본**: 키 이름·중첩·타입은 원본 그대로, 값은 자리표시자.

`docs/ops/external-import-staging-checklist.md`가 릴리스 A 검증에서 "개인 데이터가
들어 있으므로 검증 후 파일과 계정 데이터를 정리한다"고 요구한 것과 같은 규칙이며,
A2에서는 그 파일이 **저장소에 들어간다**는 점에서 더 엄격해야 합니다.

## 8. 사람이 정해야 하는 것

1. ~~활동 항목에 대화 식별자가 있는가~~ — **2026-08-14 실측으로 해소**(§2).
2. ~~분기된 대화를 각각 독립된 대화로 가져올지~~ — **2026-08-14 결정됨**(§2.2).
3. HTML 전용 사용자를 첫 릴리스에서 거절하는 것이 맞는지(§6).
4. Gems를 A2에서 명시적 비목표로 유지할지, 릴리스 C로 넘길지(§4).
5. A2 scope 승인 기록 — 상위 정책 §23의 다른 릴리스와 같은 형식.
6. ~~첨부로 들어온 중첩 아카이브를 거절이 아니라 skip으로 바꿀지~~ —
   **2026-08-14 결정됨.** 상위 정책 §5.2에 공통 규칙으로 반영했습니다(§3.2).

## 9. 착수 조건

아래가 모두 갖춰지기 전에는 파서 코드를 쓰지 않습니다.

- [x] 활동 항목의 대화 식별자 확인 (2026-08-14, `details[].url`)
- [x] 분기 대화 처리 결정 (2026-08-14, §2.2 — 분기별 독립 대화)
- [x] 합성 fixture가 저장소에 있음 — `tests/fixtures/geminiTakeout/`.
      `tests/geminiTakeoutFixture.test.mjs`가 분기(중첩·교차 둘 다), 첨부 누락,
      대화 ID 없는 항목, ko/en 구조 동일성을 강제합니다
- [x] 첨부 중첩 아카이브 처리 (2026-08-14, 상위 정책 §5.2 — 열지 않고 skip)
- [x] A2 scope 승인이 기록됨 (2026-08-14, `@mposition` — 상위 정책 frontmatter의
      `approvedScopes: RELEASE_A2_GEMINI_IMPORT`. 승인문은 §10)

**착수 조건은 모두 충족됐습니다.** 다만 이 승인이 여는 것은 **parser 구현
착수뿐**입니다 — production 활성화는 별도 승인이며, 층위는 §10의 표를 봅니다.

증명할 수 없는 구조에 대해 파서를 쓰면, 그것이 §4.1·§5.6을 만족하는지 아무도
말할 수 없습니다. 그 상태로 병합된 파서는 테스트가 초록이어도 계약을 지킨다는
근거가 없습니다.

## 10. 무엇이 무엇을 열어 주는가

§9의 항목들이 순서대로 채워지는 것처럼 보이지만, **하나가 채워졌다고 다음이
열리는 것은 아닙니다.** 지금까지의 진행이 어디까지를 허용했는지 적어 둡니다.

| 층 | 현재 상태 | 무엇이 필요한가 |
|---|---|---|
| 상위 archive 규칙 변경(§5.2) | **완료** | 이미 반영·검증됨 |
| 합성 fixture | **완료** | 유지만 하면 됨 |
| Gemini parser 구현 | **금지** | A2 scope 승인 기록 |
| production 활성화 | **금지** | parser 완성과 **별개의** 후속 승인 |
| Release B memory 활성화 | **금지** | A2와 무관한 별도 승인 |

두 가지를 특히 혼동하지 않습니다.

- **archive 규칙이 풀린 것은 파서 허가가 아닙니다.** 그 변경은 provider와
  무관한 공통 버그 수정이며, Gemini를 지원하기로 한 결정이 아닙니다.
- **scope 승인은 착수 허가일 뿐 배포 허가가 아닙니다.** 파서가 완성되어도
  production 활성화는 그 자체로 승인 대상입니다.

### 승인문이 갖춰야 하는 것

"진행하세요"는 승인이 아닙니다. 범위가 적혀 있지 않으면 나중에 무엇이
승인됐는지 아무도 말할 수 없고, 그것이 registry를 두는 이유를 없앱니다.
승인문은 **포함·비포함·허용 범위·승인자·일자**를 모두 담습니다. 형식 예시는
다음과 같습니다.

> A2 scope를 승인합니다. Gemini My Activity JSON만 지원하고, 분기별 독립
> 대화, locale 경로 판정, 중첩 아카이브 미해제·skip, 첨부 누락 표시를 계약으로
> 합니다. HTML, Gems, scheduled actions, 첨부 복제는 범위 밖으로 유지합니다.
> 이 승인은 parser 구현 착수만 허용하며 production 활성화나 Release B memory
> 활성화를 승인하지 않습니다. 승인자: @handle, 승인일: YYYY-MM-DD.

**이런 기록을 받기 전에는 §9의 마지막 항목을 체크하지 않고 승인자도 적지
않습니다.** 검토 의견이나 방향성에 대한 동의는 scope 승인과 다릅니다.

### A2 scope 승인 (2026-08-14, `@mposition`)

승인문은 다음과 같습니다.

> A2 scope를 승인합니다. Gemini My Activity JSON만 지원하고, 분기별 독립 대화,
> locale 경로 판정, 중첩 아카이브 미해제·skip, 첨부 누락 표시를 계약으로
> 합니다. HTML, Gems, scheduled actions, 첨부 복제는 범위 밖으로 유지합니다.
> 이 승인은 parser 구현 착수만 허용하며 production 활성화나 Release B memory
> 활성화를 승인하지 않습니다.

**이 인용 자체는 승인 기록이 아닙니다.** 권한의 근거는 상위 정책
`docs/policy/external-conversation-import-and-memory.md`의 frontmatter이며,
그 문서는 "에이전트는 이 필드를 스스로 기입할 수 없습니다"라고 정합니다.
기록은 `@mposition`이 직접 넣었습니다 — 커밋 `8f4fc95f`가 `approvedScopes`에
`RELEASE_A2_GEMINI_IMPORT`를 추가했고, 그것이 §9의 마지막 항목을 채웁니다.
상위 정책 §23에 승인자·승인일·근거 커밋을 표로 기록했습니다.

`approvedAt: 2026-08-13`은 A·B·C scope 승인일이므로 **그대로 둡니다.** A2
승인일(2026-08-14)은 여기에 적습니다 — 한 필드를 덮어쓰면 앞선 승인의 날짜가
사라지고, 어느 scope가 언제 승인됐는지 말할 수 없게 됩니다.

승인문이 §2.2·§3.1·§3.2·§4.1의 계약과 §4의 Gems 비목표를 그대로 지목하므로,
이 문서에서 바꿔야 할 계약은 없습니다. 범위 밖으로 못 박힌 것은 넷입니다 —
HTML export(§6), Gems(§4), scheduled actions, 첨부 파일 복제.
