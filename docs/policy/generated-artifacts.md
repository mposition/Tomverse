# AI 생성 파일(Generated Artifact) 정책

승인일: 2026-08-21 (MVP). 이 문서는 채팅 답변이 만들어 내는 **실제 파일**의
단일 기준이다. 생성 조건, 명세 검증, 저장, 다운로드 권한, 수명주기, UI 계약을
모두 여기서 정한다. 코드 상수의 출처는 `lib/generatedArtifactCore.ts`이고,
가용성 판단은 `lib/generatedArtifactToolPolicy.ts`가 소유한다. 이 계약을
어기는 변경은 릴리스 차단 사유다.

**이 기능은 "대화 TXT 다운로드"와 다른 기능이다.**
`/api/conversations/{id}/export`는 대화 *기록*을 텍스트로 내보내는 기능이고,
이 문서는 사용자가 요청한 *결과물*을 만드는 기능이다. 두 기능은 코드도, 권한
검사도, 요금 결정도 공유하지 않는다.

## 1. 문제

사용자가 "이 데이터를 엑셀로 만들어 줘"라고 하면 모델은 Python 코드, CSV
코드블록, 또는 수백 줄짜리 Markdown 표로 답했다. 셋 다 사용자가 요청한 것이
아니다. 더 나쁜 경우 모델은 `/mnt/data/report.xlsx` 같은 sandbox 경로나 존재
하지 않는 링크를 제시했고, 그것은 **하지 않은 일을 했다고 말한 것**이다.

그래서 이 도메인의 절대 규칙은 하나다.

> 앱이 실제 파일을 만들지 못했다면, 만들었다고 말하지 않는다.

파일이 없으면 없다고 말하고, 왜 없는지 말하고, 무엇을 하면 얻을 수 있는지
말한다. 코드블록·base64·가짜 경로·가짜 링크는 그 자리를 채우는 대체물이
아니다.

## 2. 언제 파일을 만들 수 있는가

판정은 `planGeneratedArtifactTool()` 한 곳에서만 한다. 결과는 세 가지다.

| mode | tool 등록 | 의미 |
|---|---|---|
| `generate` | 예 | 로그인 계정, 검증된 모델, 저장 가능한 대화 |
| `sign_in_required` | 예(거절 전용) | 게스트 — §7 |
| `off` | 아니오 | 아래 네 가지 이유 중 하나 |

`off`의 이유는 이름이 있다.

- `model_unverified` — 이 모델로 custom tool 호출을 **실제로 확인하지 않았다**.
  `ARTIFACT_TOOL_CAPABILITIES`에 없는 모델은 전부 여기다. "아마 될 것이다"는
  이 registry가 막으려는 상태이고, 모델은 changelog를 읽어서가 아니라 누군가
  돌려 봐서 등록된다.
- `native_search_conflict` — §9 참조.
- `not_a_chat_conversation` — 이미지 대화. 생성 문서는 이미지 도메인과 별개다.
- `no_conversation` — 첨부할 대화도 메시지 ID도 없는 요청.

**중요: `off`도 조용하지 않다.** 모든 turn은 예외 없이 artifact system block을
하나 싣는다. `generate`면 tool 사용법이고, 나머지면 "이 turn에서는 파일을 만들
수 없다, 그렇게 말하고 무엇을 하면 되는지 알려 줘"라는 지시다. 지원되지 않는
모델에서 표만 뱉는 조용한 퇴행은 이 block이 존재하는 이유다.

system block과 tool schema는 **과금 대상 입력 토큰**이며, 예약(reservation)
전에 `estimatedInputTokens`와 `inputEstimate`에 더한다. tool schema는
build 시점에 고정되므로 요청마다 tokenise하지 않고
`ARTIFACT_TOOL_DEFINITION_TOKENS` 상수로 보수적으로 계상한다.

Deep research(`usageClass === "deep-research"`)는 **아예 계획하지 않는다**.
submit-then-poll 작업이라 streaming 경로에 도달하지 않고,
`submitDeepResearchJob`이 메시지 형태를 따로 검증한다.

## 3. 모델은 명세만 만든다

**구조가 있는 형식에서 모델은 바이트를 만들지 않는다.** 스프레드시트·문서·
프레젠테이션·아카이브는 Zod로 검증된 **명세**를 받고, 서버의 생성기가 바이트를
만든다. 모델은 바이너리도 base64도 만들지 않는다.

tool은 형식마다가 아니라 **종류(kind)마다** 하나다. 형식은 명세의 field이고,
`xlsx`와 `csv`는 하나의 명세를 두 가지로 쓴 것이지 서로 다른 요청이 아니다.

| tool | kind | 입력 |
|---|---|---|
| `create_spreadsheet` | spreadsheet | worksheet 배열, sheet 이름, 열 정의, 행 데이터, 선택적 제목·너비·표시 형식 |
| `create_document` | document | 제목·부제와 block의 흐름(heading, paragraph, bullets, numbers, quote, code, table, divider, pageBreak) |
| `create_presentation` | presentation | slide 배열(layout, 제목, 부제, bullet, 발표자 노트) |
| `create_text_file` | text | 파일의 정확한 텍스트 |
| `create_archive` | archive | 아카이브 안의 상대 경로와 각 항목의 텍스트 |

표시 형식은 **이름**으로만 받는다(`ARTIFACT_NUMBER_FORMATS`). raw `numFmt`
코드는 작은 언어이고, 모델에게서 받으면 그 언어를 여기서 파싱해 다른 것을
실어 나르지 않는지 확인해야 한다. 이름 집합은 코드 리뷰로 늘린다.

**소스 코드·마크업·설정은 의도된 예외이며, 예외가 규칙을 증명한다.** Python
module에는 "그 텍스트"가 아닌 명세가 없다. 그래서 그 형식에서는 모델이 내용을
직접 쓰고, 명세를 안전하게 만들던 것들을 **텍스트에 그대로 적용**한다 —
제한된 크기, 이 애플리케이션이 정한 확장자, 깨지면 쓸모가 없는 형식에 대한
구조 검사(JSON·YAML·XML·SVG), 그리고 렌더링이 아니라 다운로드로만 나가는 전달
경로.

**tool schema를 신뢰하지 않는다.** 같은 스키마를 `execute` 안에서
`admitWorkbookSpecSafely()`·`admitDocumentSpec()`·`admitPresentationSpec()`·
`admitTextFileSpec()`·`admitArchiveSpec()`로 다시 검증한다. provider가
넘겨받은 JSON schema를 강제한다는 보장은 어느 provider도 하지 않는다.

명시적 상한(`ARTIFACT_LIMITS`):

| 항목 | 값 |
|---|---|
| worksheet 수 | 10 |
| sheet당 행 | 10,000 |
| sheet당 열 | 64 |
| 전체 cell | 100,000 |
| 문서 block 수 | 2,000 |
| 목록 항목 | 200 |
| 문서 표 행·열 | 500 · 20 |
| slide 수 | 100 |
| slide당 bullet | 20 |
| 텍스트 파일 문자 수 | 400,000 |
| 아카이브 항목 수 | 100 |
| 아카이브 전체 문자 수 | 2,000,000 |
| cell·block 문자열 | 20,000자 |
| 파일명 | 120자 |
| 결과 파일 크기 | 5 MB |
| 메시지당 artifact | 3 |

각 상한은 서로 다른 자원을 막으므로 어느 하나도 잉여가 아니다. 특히 파일
크기는 **생성 후 실제 바이트로 검사**한다 — cell 수로 추정하지 않는다.
검사는 `lib/generatedArtifactRenderers.ts`의 `bounded()` 한 곳에서 한다.

## 4. 형식

형식은 표 하나에 있다 — `lib/generatedArtifactFormats.ts`의
`ARTIFACT_FORMAT_TABLE`. 한 형식은 다섯 가지 사실이 서로 맞아야 하는 것이므로
(디스크의 확장자, 전송의 media type, 어느 생성기가 만드는가, 내용을 무엇으로
검사하는가, 제공하는가) 그 다섯을 다섯 개의 `switch`로 흩어 두지 않는다.

| kind | 형식 | 생성기 |
|---|---|---|
| spreadsheet | `xlsx`, `csv` | `lib/generatedArtifactXlsx.ts` |
| document | `docx`, `pdf`, `md`, `txt` | `generatedArtifactDocx.ts`, `generatedArtifactPdf.ts`, `generatedArtifactText.ts` |
| presentation | `pptx` | `lib/generatedArtifactPptx.ts` |
| text | `json`, `yaml`, `yml`, `xml`, `toml`, `ini`, `tsv`, `html`, `htm`, `svg`, `css`, `scss`, `less`, `sql`, `graphql`, `proto`, `ts`, `tsx`, `js`, `jsx`, `mjs`, `cjs`, `py`, `rb`, `go`, `rs`, `java`, `kt`, `swift`, `c`, `h`, `cpp`, `hpp`, `cs`, `php`, `sh`, `bash`, `ps1`, `r`, `scala`, `lua`, `pl`, `dart`, `ex`, `exs`, `hs`, `vue`, `svelte`, `dockerfile`, `env` | `lib/generatedArtifactText.ts` |
| archive | `zip` | `lib/generatedArtifactText.ts` |

**형식을 추가하는 일은 세 가지다** — `ARTIFACT_FORMAT_TABLE`의 행 하나,
`lib/generatedArtifactRenderers.ts`의 분기 하나, migration의 `format` CHECK를
넓히는 것. tool 배선도, collector도, 저장도, 다운로드 route도, 카드도 형식별
분기를 갖지 않으며, 이 성질을 지키는 것이 renderer 파일의 존재 이유다.

- **요청한 형식으로 만든다.** xlsx 요청을 csv로, docx 요청을 md로 대체하지
  않는다. csv는 같은 명세에서 파생될 뿐 대체재가 아니고, sheet 하나만 담을 수
  있으므로 다중 sheet 명세를 csv로 요청하면 **실패로 보고**한다(첫 sheet만
  쓰고 나머지를 버리지 않는다).
- **실행되는 형식은 만들지 않는다**(`REFUSED_ARTIFACT_EXTENSIONS`): `exe`,
  `dll`, `com`, `bat`, `cmd`, `msi`, `scr`, `vbs`, `vbe`, `jse`, `wsf`, `wsh`,
  `lnk`, `reg`, `cpl`, `hta`, `pif`와 설치 패키지(`app`, `dmg`, `pkg`, `deb`,
  `rpm`, `jar`, `apk`). 기준은 "두 번 눌렀을 때 열리는가 실행되는가"이지
  "실행될 수 있는가"가 아니다 — 그래서 `.sh`, `.ps1`, `.py`는 지원한다. 같은
  목록이 아카이브 항목에도 적용되므로, 직접 요청이 거절되는 것을 zip으로
  배달할 수 없다.
- **목록에 없는 확장자는 지원하지 않는다고 말한다.** 침묵이 가짜 링크의
  출발점이다.

### OOXML package — 검사기 통과는 열린다는 뜻이 아니다

`xlsx`·`docx`·`pptx`는 zip 안의 XML 묶음이고, 그 묶음이 성립하는지는 **서로 다른
층에서 서로 다르게** 판정된다. 2026-08-22에 PowerPoint가 이 저장소가 만든 deck을
전부 거절했고, 그때 이미 통과한 검사가 이렇다.

| 검사 | 결과 |
|---|---|
| ECMA-376 XSD, 18개 part 전부 | 통과 |
| Microsoft OpenXmlValidator, Office 2007~2021 | 오류 0건 |
| OPC content type·relationship·dangling target | 통과 |
| LibreOffice Impress, python-pptx | 열림 |

원인은 **slide master와 notes master가 같은 theme part를 가리킨 것**이었다.
theme part는 reader의 model에서 master 하나의 것이므로, 공유는 작은 package가
아니라 열리지 않는 package다. 확정은 검사기가 아니라 한 곳만 다른 파일 셋을 실제
PowerPoint에서 열어서 했다 — theme을 다시 공유로 되돌린 것만 실패했고, 같은
라운드에서 relationship id를 `rIdCore`로 되돌린 것은 통과했다.

그러므로:

- **master마다 theme part를 하나씩 쓴다.** 합치자는 제안은 검사기와 테스트를
  모두 통과하면서 파일을 못 열게 만든다. `tests/generatedArtifactPptx.test.mjs`가
  분리와, notes 없는 deck에서 `theme2.xml`이 아예 없다는 것을 함께 고정한다 —
  없는 part를 가리키는 content type override는 슬라이드를 읽기 전에 거절된다.
- **placeholder는 선언과 이름이 같이 간다.** `<a:spLocks noGrp="1"/>`를 쓰고
  `<p:nvPr/>`를 비워 두면 placeholder라고 말한 뒤 아무것도 지목하지 않는 shape가
  된다. 자유 도형은 `txBox="1"`로 쓰고, placeholder는 자기 `<p:ph>`를 갖는다.
- **package 형식의 변경은 검사기가 아니라 대상 application에서 확인한다.** 위
  결함은 Microsoft 자기 검사기를 여섯 버전에서 통과했다. 통과 자체는 증거가
  아니며, 회귀 테스트는 확인한 사실을 고정할 뿐 확인을 대신하지 않는다.

## 5. 저장, 전송, 다운로드

### 데이터 모델

`MessageArtifact` — id, messageId, conversationId, userId, ordinal, format,
filename, mediaType, byteSize, status, objectKey, failureCode, modelId,
createdAt.

- `(messageId, ordinal)` unique — **멱등성 키**다. provider가 같은 tool 호출을
  재생해도 같은 쌍을 쓰므로 두 번째 파일이 생기지 않는다.
- `status`는 `ready | failed` 둘뿐이다. `pending`은 없다: 바이트가 저장된
  **뒤에만** 행을 쓰므로, 존재하고 `failed`가 아닌 행에는 반드시 파일이 있다.
- CHECK가 이를 강제한다 — `ready`는 objectKey NOT NULL이고 byteSize > 0,
  `failed`는 objectKey NULL.
- `userId`·`conversationId`는 `message`를 거치지 않고 직접 들고 있다.
  다운로드가 소유권을 **조회의 일부로** 확인하기 위해서다.

### 전송

`objectKey`, 저장소 URL, 서명 URL, provider 원문은 **어떤 경로로도 클라이언트에
가지 않는다.** 클라이언트가 보는 것은 `ChatStreamArtifact` allowlist뿐이다 —
id, ordinal, format, filename, mediaType, byteSize, status, failureCode,
modelId. 서명 URL은 DB에 저장하지 않는다(애초에 만들지 않는다).

- **스트리밍**: 기존 `ChatStreamTrailer`를 확장해 마지막 out-of-band chunk로
  보낸다. tool 결과는 turn이 끝나야 확정되므로 헤더에 실을 수 없다.
  `artifacts` 키는 **파일이 없으면 아예 없다** — 구형 클라이언트는 모르는 키를
  무시하고, 구형 서버는 보내지 않으며 클라이언트는 카드를 그리지 않는다.
  기존 `searchMetadata`·completion 파싱은 그대로 동작한다.
- **재조회**: `GET /api/conversations/{id}`가 이름 지정 select로 같은 필드를
  돌려준다(`include`는 `objectKey`까지 보내므로 쓰지 않는다).
- **생성 중**: `lib/generatedArtifactProgressSignal.ts`의 선행 out-of-band
  chunk. tool 실행 중에는 provider가 토큰을 내지 않아 "느린 모델"과 구분되지
  않기 때문이다.

### 다운로드

`GET /api/artifacts/{artifactId}` 한 곳뿐이다. **모델이 만든 URL은 어떤 경우에도
다운로드 URL이 아니다.**

검증: 로그인 → rate limit → `findFirst({ id, userId })`(소유권이 조회의 일부)
→ conversation 소유자 재확인 → `hasConversationUnlockGrant` → status/objectKey.

- 실패는 전부 **404**다. "없음"과 "남의 것"을 구분할 분기 자체가 없다.
- 잠긴 대화만 예외로 `CONVERSATION_LOCKED`(423)를 답한다. 이미 소유권이 확인된
  뒤이므로 그 문장을 보는 사람은 소유자뿐이고, 이유를 숨기면 unlock 안내를
  잃는다.
- 헤더: 형식 표가 정한 정확한 Content-Type, ASCII `filename`, UTF-8 `filename*`,
  `Content-Disposition: attachment`, `Cache-Control: private, no-store`,
  `X-Content-Type-Options: nosniff`.
- 읽기는 `readOwnR2ObjectBytes`(비파괴)로 한다. `readR2Object`는 메타데이터가
  안 맞으면 객체를 지우는데, 그것은 신뢰할 수 없는 업로드에는 옳고 사용자가
  비용을 치르고 만든 결과물에는 재앙이다.
- 클라이언트는 `lib/browserDownload.ts`의 fetch + blob 경로를 쓴다. navigation은
  실패까지 브라우저에 넘겨서 404가 대화 화면을 날려 버린다.

## 6. 보안

- **수식은 만들지 않는다.** 명세에 `formula` 필드가 없고 writer는 `<f>` 요소를
  쓰지 않는다. 식은 코드이고, 모델에게서 받으면 그 파일을 여는 모든 사람이
  실행 표면이 된다. 별도 검증 계약이 생기기 전까지 값은 전부 일반 셀 값이다.
- **formula injection**: `=`, `+`, `-`, `@`, 선행 tab/CR로 시작하는 문자열은
  OOXML에서 `quotePrefix` 스타일로 쓴다. Excel 자신의 "이건 텍스트다" 표시이며
  **값을 바꾸지 않는다**(OOXML inline string은 애초에 수식이 아니다). CSV에는
  그런 구조가 없으므로 `'`를 앞에 붙인다 — 형식마다 다른 처리이고, 그 차이는
  숨기지 않고 여기 적는다.
- **package에 없는 것**: external link, `xl/connections.xml`, 매크로
  (`.xlsm`도 `.docm`도 `.pptm`도 아니다), hyperlink relationship, Word의
  `fldChar`, PowerPoint의 `hlinkClick`, `docProps/custom.xml`. writer가 해당
  part를 아예 쓰지 않으므로 넣을 방법이 없다.
- **SVG에는 script를 넣지 않는다.** 다운로드된 SVG는 `file://`에서 열리고
  그 안의 `<script>`는 제약할 origin 없이 실행된다 — `<script>`,
  `<foreignObject>`, inline event handler, `javascript:`·`data:text/html`
  참조가 있으면 거절한다. HTML은 여기에 걸지 않는다: script가 있는 page가
  "웹 페이지를 만들어 달라"의 의미이고, 그것을 막는 것은 안전하게 만드는 것이
  아니라 형식을 거절하는 것이다. 둘 다 `nosniff`가 붙은 attachment로만 나가므로
  이 애플리케이션의 origin에서는 어느 쪽도 실행되지 않는다.
- **아카이브 경로는 정규화하지 않고 거절한다.** 파일명은 label이라 다듬어도
  여전히 그 파일을 가리키지만, 경로는 **위치**다. `../../etc/passwd`를 조용히
  `etc/passwd`로 옮기면 모델이 말한 곳에 없는 내용을 담은 아카이브가 배달된다.
  절대 경로, 드라이브 문자, `\\`, `.`·`..`·빈 segment, 제어문자, 중복 경로를
  모두 거절한다(`isSafeArchivePath`).
- **깨진 구조는 배달하지 않는다.** JSON·YAML은 파싱해 보고, XML·SVG·HTML은
  균형과 미종료 속성을 검사한다. 파싱되지 않는 설정 파일은 설정 파일이 아니다.
- **파일명**: path separator, `..`, 제어문자, RTL override, Windows 예약어,
  `< > : " | ? * %`를 제거한다. 확장자는 format이 정하며 입력에서 가져오지
  않는다 — `report.xlsx.exe`도 `report.pdf`도 `report.xlsx`가 된다. 한국어
  이름은 그대로 살아서 `filename*`으로 전달된다.
- **XML**: 이스케이프 후, XML 1.0이 담을 수 없는 코드 포인트를 제거한다.
  제어문자 하나가 Excel이 열지 못하는 package를 만든다.
- 모델에게 artifact **id를 주지 않는다**. 모델이 손에 쥔 것은 답변에 인용될 수
  있고, 링크를 인용할 수 있는 모델은 링크를 지어낼 수도 있다.

## 7. 게스트 — MVP에서 지원하지 않는다

**결정: 게스트는 파일을 만들 수 없다.** 저장할 계정이 없고, 짧은 TTL의 게스트
전용 저장 계층은 이 MVP의 범위 밖이다.

조용히 빠지지 않는다. 게스트 turn에도 tool은 등록되며, 호출하면 즉시
`sign_in_required`를 돌려준다(생성도 저장도 하지 않는다). 그 결과가 trailer에
`status: "blocked"` 카드로 실려 UI가 **로그인 CTA**를 보여 준다. 표·코드·
base64로 대신하는 것은 금지다.

게스트 카드는 localStorage 스냅샷에 저장하지 않는다
(`lib/chatMessageSerialization.ts`는 allowlist다). 끝난 요청에 대한 안내이므로
새로고침 후 사라지는 것이 맞다.

## 8. 수명주기와 정합성

R2 쓰기와 DB 쓰기는 한 트랜잭션이 아니다. 그래서 어느 쪽 실패 형태를 받아들일지
먼저 정한다.

- **객체만 있고 행이 없다** → 회수 가능하다. 다운로드는 행을 먼저 읽으므로
  아무도 도달할 수 없고, 아래 두 sweep이 수거한다.
- **행만 있고 객체가 없다** → 회수 불가능하다. 앱이 만들었다고 말한 파일의
  다운로드 버튼이 500을 낸다.

그러므로 **생성은 객체 먼저, 행 나중**이고 **삭제는 행 먼저, tombstone,
객체 나중**이다.

- 행은 assistant 메시지와 **같은 트랜잭션**에서 쓴다. 답변과 파일은 함께
  존재하거나 함께 없다.
- `artifactsPersisted`가 true가 아닌 모든 종료 경로(취소, provider 오류, 클라이언트
  연결 끊김, fallback swap, 메시지 쓰기 실패)는 `releaseSafely()`에서
  `discard()`로 객체를 회수한다. 기본값이 "회수"다.
- **텍스트 없이 tool만 호출한 turn**은 빈 응답으로 보고되고 파일을 남기지
  않는다(참조할 메시지가 없으므로 쓰는 순간 도달 불가능한 객체가 된다).
  `generated_artifact_discarded_empty_answer`로 따로 기록하며, 이 비율이
  0 근처를 벗어나면 지시문이 작동하지 않는다는 뜻이다.
- **삭제**: 대화 삭제, 대화 일괄 삭제, 계정 삭제, 모델별 메시지 초기화 모두
  같은 트랜잭션에서 `MessageArtifactCleanup` tombstone을 남긴다.
- **sweep**: 15분 유지보수 cron이 (a) tombstone queue를 drain하고,
  (b) `ARTIFACT_ORPHAN_TTL_MS`(6시간)보다 오래된 접두사 객체 중 참조하는 행이
  없는 것을 지운다. (b)의 age 필터는 필수다 — 없으면 바이트를 저장하고 아직 행을
  쓰지 않은 진행 중인 turn의 파일을 지운다.
- sweep은 절대 throw하지 않는다. 저장소 장애가 유지보수 run 전체를 실패시키면
  안 된다.

**기존 메시지는 artifacts가 없는 정상 메시지로 계속 읽힌다.** 관계는 추가일 뿐
필수가 아니다.

## 9. UI 계약

- 카드는 **답변 본문 아래** 별도 영역이다. 본문 안이 아니다 — 본문은 "요청하신
  Excel 파일을 만들었습니다" 수준의 한두 문장이고, 표나 생성 코드를 다시 찍는
  것이 이 기능이 없애려는 바로 그것이다.
- 카드 내용: 파일 아이콘, 파일명, "Excel 통합 문서", 파일 크기, 생성 모델,
  다운로드 버튼.
- 상태 세 가지: `ready`(다운로드), `failed`(사유 + "파일 다시 만들기"),
  `blocked`(로그인 CTA). **실패는 채팅 전체를 실패로 만들지 않는다** — 주변
  답변은 진짜이고, 스프레드시트가 안 만들어졌다고 답변을 버리면 사용자가 값을
  치른 것을 버리는 것이다.
- 생성 중에는 "Excel 파일 만드는 중…"을 보여 준다. 단, **해당 패널이 실제로
  스트리밍 중일 때만** 그린다. 취소·실패한 turn이 끝나지 않는 spinner를 남기지
  않는다.
- **후속 수정은 새 버전이다.** 멱등성 키는 명세 내용(hash)이지 파일명이 아니다.
  같은 명세 재호출은 `unchanged`, 다른 명세는 새 artifact다. 기존 파일을
  덮어쓰지 않는다.
- **멀티 모델 비교**: artifact는 `modelId`를 들고 있고 카드가 그 모델 이름을
  표시한다. 세 패널이 각자의 messageId에 각자의 파일을 붙인다.
- **같은 turn에서 자동 복구된 실패는 카드로 보여 주지 않는다.** 모델이 명세를
  거절당하고 고쳐서 다시 호출해 성공하면, 완성된 다운로드 옆에 "만들지
  못했습니다" 카드와 "파일 다시 만들기" CTA가 같이 서게 된다 — 이미 있는 파일을
  다시 만들라는 제안이다. **DB 행은 지우지 않는다**(실패는 모델이 무엇을
  들었는지에 대한 감사 기록이다). 판정은 표시 단계 한 곳
  (`visibleGeneratedArtifacts()`, `lib/generatedArtifactCore.ts`)에서만 하고,
  규칙은 좁게 고정한다.
  - `failed`만 숨긴다. `blocked`는 나중 성공이 답하지 못하는 로그인 요구이고
    `ready`는 사용자가 가질 수 있는 파일이다.
  - 동일성은 **파일명 + 형식 + 실효 모델**이다. 실효 모델은
    `artifact.modelId ?? 패널의 fallbackModelId`이며, 파일명은 trim 후
    소문자로 맞춘다. 다른 이름·다른 형식·다른 모델의 성공은 이 실패를
    지우지 못한다.
  - 그 성공의 `ordinal`이 **더 클 때만** 숨긴다. 배열 순서가 아니라 `ordinal`로
    비교하므로 streaming trailer와 대화 재조회가 같은 카드를 보여 준다.
    `ready` 뒤에 온 `failed`는 그 파일에 대해 turn이 아는 가장 최신 사실이므로
    남는다.
  - `ready`끼리는 합치지 않는다. 같은 이름이라도 위의 "후속 수정은 새
    버전이다"에 따라 각자 카드를 갖는다.
- 파일명 행과 버튼 행은 **카드가 좁을 때** 서로 다른 full-width 행이다
  (`flex-col`이 기본, `@md/artifacts:flex-row`가 확장). 판정 기준은 viewport가
  아니라 **카드가 속한 목록의 너비**다 — 1440px 창 안의 모델 패널은 폭이 300px
  남짓인데 `sm:`은 거기서도 걸려 실패 설명이 몇 글자 폭으로 눌렸다. query
  container는 `GeneratedArtifactList`의 `<ul>`(`@container/artifacts`)이고,
  container가 없으면 어떤 variant도 걸리지 않아 stacked layout으로 남는다.
  텍스트 열은 `min-w-0`이라야 `truncate`가 동작하고, row layout에서는 최소
  너비를 함께 갖는다.
- 버튼은 최소 44px 터치 영역과 `focus-visible` 링을 갖는다.
- 스크린 리더는 하나의 accessible name으로 형식·파일명·크기·상태를 받는다.
- 시각 role은 `accent-generated-artifact-*`(emerald)뿐이다. AI Review의
  cyan→blue→purple gradient는 예약이며 쓰지 않는다.
- 문구는 `locales/*.ts` 7개 언어 전부에 넣는다.

### 시작만 하고 끝나지 못한 tool 호출 — `turn_incomplete`

승인일: 2026-08-23. §1의 규칙("만들지 못했으면 만들었다고 말하지 않는다")의
반대쪽 절반이며, 예외가 아니다.

**증상.** Claude Haiku 4.5가 PPT를 웹페이지로 만들어 달라는 요청에 짧은 사전
설명과 "이제 웹페이지를 만들겠습니다:"까지 쓰고 `create_text_file` 호출을
시작했다가 출력 토큰 상한에 걸렸다. tool은 실행되지 않았으므로 collector에는
아무것도 기록되지 않았고, turn은 일반적인 길이 초과 안내만 남긴 채 끝났다.
**앱이 파일을 만들겠다고 말한 뒤 아무 말도 하지 않은 것**이고, 이는 §1이
금지하는 침묵이다.

**판정 신호는 두 개이고 서로 다른 곳에서 온다.**

- `tool-input-start`(`streamText`의 `onChunk`) — provider가 tool 호출을
  **시작**했다고 이름을 대는 유일한 시점. toolCallId와 toolName으로 기록한다.
- tool 실행 시작(`onToolExecutionStart`와 각 tool의 `execute` 양쪽) — 그 호출이
  collector에 도달했다는 사실. 도달한 호출은 성공·실패·로그인 거절 중 하나로
  **이미 자기 결과를 기록**했으므로 여기서 다시 세지 않는다.

추적은 `lib/generatedArtifactTurnTracker.ts`가 하고, 기록은
`GeneratedArtifactCollector.recordIncompleteToolCalls()`가 한다.

절대 조건:

- **완료 판정이 `incomplete`(= `length`)일 때만** 기록한다
  (`resolveChatCompletionOutcome`). 정상 종료나 취소는 대상이 아니다.
- **artifact tool 호출이 시작되지 않은 길이 초과는 지금과 같다** — 일반
  incomplete 안내만 보이고 카드는 만들지 않는다.
- **native tool은 절대 세지 않는다.** `web_search`·`google_search`도 같은
  `tool-input-start`를 내지만, 판정 대상은 **이 요청이 실제로 등록한 application
  tool 이름 집합**이며 `providerExecuted`도 함께 거른다. 잘린 검색은 사용자가
  약속받은 파일이 아니다.
- **부분 tool input을 읽지 않는다.** delta frame은 구독하지 않고, 로그에도 DB에도
  남기지 않는다. 검증된 format·filename이 없으므로 카드는 **tool 종류의 기존
  안전한 fallback descriptor**(`FALLBACK_FORMAT`, 파일명 `generated`)로 표시한다.
- **상한을 올리지 않는다.** 메시지당 top-level 3개는 그대로이고, 네 번째 시작
  호출은 호출로 세되 카드는 만들지 않는다. `ARTIFACT_LIMITS`도
  `maxOutputTokens`도 이 결함의 해결책이 아니다.
- **ordinal·modelId·persistence 계약은 그대로다.** 실패 row는 assistant 메시지와
  **같은 트랜잭션**에서 쓰이고(§8), 재조회 후에도 카드가 남는다. 카드 문구는
  기존 `turn_incomplete` locale 항목(`chat.artifactFailedIncomplete`)이고 재시도
  동작도 기존 `failed` 카드와 같다.
- **`wasInvoked`가 참이 된다.** 잘린 turn의 provider response messages에는 끝까지
  쓰이지 못한 `tool_use`가 들어 있고, 그것을 reasoning replay로 저장하면 다음
  turn이 provider에게 거절당한다. 그래서 그 turn은
  `MessageProviderContext`를 남기지 않는다.

**지시문도 함께 고친다**(§2의 system block). 파일을 만들기 전에 "분석 중",
"이제 만들겠습니다" 같은 진행 약속을 본문에 쓰지 않고, tool을 먼저 부른 뒤
`created` 결과를 받고 나서야 한두 문장으로 성공을 알린다. HTML·소스 파일은
반복 블록·군더더기 주석·중복 데이터를 피하고, 한 번의 호출에 담기 어렵다고
판단되면 성공을 예고하거나 불완전한 호출을 시작하지 말고 범위를 줄여 달라고
요청한다. **다만 지시문은 신뢰성의 근거가 아니다** — 위의 lifecycle 판정이
근거이고, 지시문은 그 판정이 발동할 빈도를 줄일 뿐이다.

## 10. 자동 fallback과 web search

- **fallback**: artifact tool을 제공한 turn은 `autoFallbackScope`의
  `toolsOffered`에 걸려 자동 fallback 대상이 아니다. §7이 원래 말하던 이유
  그대로다 — 대화가 참조하게 된 tool 결과를 두 번째 모델의 답변이 설명할 수
  없다. 그래서 오늘 collector가 살아 있는 채로 swap에 도달하는 경로는 없고,
  swap 지점의 `discard()`는 그 범위가 넓어질 때를 위한 방어다.
- **web search 충돌**: 두 가지 서로 다른 비호환이 있고 둘 다 취향 문제가
  아니다.
  1. OpenAI native search를 강제하면 `toolChoice: "required"`가 나가는데, 이는
     "**어떤** tool이든 호출하라"는 뜻이다. tool이 둘이면 모델이 스프레드시트를
     쓰고 검색을 건너뛰어도 조건을 만족한다 — "항상 검색"이 조용히 "항상"이
     아니게 된다. 검색이 이긴다: 사용자가 명시적으로 켰고, 파일 요청에는
     분명한 대안(검색을 끄고 다시 묻기)이 있다.
  2. Google Search grounding은 function declaration과 배타적이다. 둘 다 보내면
     provider가 400으로 거절한다 — 파일 요청이 오류가 된다.

  Anthropic의 `web_search_20250305`는 두 문제가 모두 없어 공존한다.

## 11. 요금

**기존 billing의 `allowDownloads` entitlement를 재사용하지 않는다.**
그 권한은 대화 TXT 내보내기의 것이고, 다른 기능의 권한을 빌려 쓰면 한쪽 요금제
결정이 다른 쪽을 조용히 움직인다.

MVP 결정: **로그인한 모든 계정이 요금제와 무관하게 파일을 만들 수 있다.**
비용은 이미 정확히 과금되고 있다 — system block과 tool schema는 입력 토큰,
tool 호출 후의 두 번째 step은 출력 토큰이며, 둘 다 기존 reservation·settlement를
지난다. 파일 생성 자체에 별도 크레딧을 매기지 않는다. 요금제별 차등이 필요해지면
그때 별도 제품 결정으로 이 절을 고쳐 쓴다.

## 12. 아직 만들지 않은 것

이 목록에 있던 "DOCX / PPTX / PDF / JSON / TXT / Markdown 생성기"는 §4의 형식
표가 그 형식들을 담게 되면서 사실이 아니게 됐다. 목록에서 지운다 — 만들지 않은
것의 목록이 만든 것을 담고 있으면 그 목록은 읽을 수 없다.

- 게스트 artifact(§7).
- 사용자가 만든 파일을 대화 밖에서 다시 찾는 목록 화면.
- 수식, 차트, 조건부 서식, 피벗.
- artifact 공유 링크. 공유 대화 스냅샷은 artifact를 포함하지 않는다.

## 13. 첨부된 템플릿에서 여러 문서 만들기

승인일: 2026-08-22. §3의 규칙("구조가 있는 형식에서 모델은 명세만 만들고
바이트는 서버가 만든다")의 연장이며, 예외가 아니다.

### 13.1 무엇이 막고 있었는가

"이 계약서 양식으로 10명분 만들어 줘"는 거절됐다. 원인은 GPT-5.6 Luna의 출력
토큰 제한이 **아니었다**. 세 가지가 겹친 것이다.

1. **메시지당 artifact 3개**(`maxArtifactsPerMessage`). 이 상한은 한 turn이
   요청할 수 있는 작업량을 묶는 것이며, batch 하나를 위해 올리면 모든 요청에
   대해 올라간다. 그래서 올리지 않는다.
2. **ZIP 안에 텍스트 항목만** 들어갈 수 있었다. `.docx`에는 "그 텍스트"가 없으
   므로 여러 문서를 한 번에 배달할 형태가 존재하지 않았다.
3. **업로드된 DOCX는 텍스트만 추출**된다. 그 텍스트로 문서를 다시 쓰면 원본의
   서식·표·헤더·푸터·섹션·이미지가 전부 사라진다 — 받는 사람 입장에서는 그것이
   문서다.

그리고 system prompt가 `3 files per answer`라고 말했다. 모델은 그 문장을
"10개는 불가능하다"로 읽었고, 그것은 정확한 독해였다.

### 13.2 결정

- **상한은 그대로다.** top-level artifact 3개, archive 항목 100개, 전체 크기
  제한 모두 변경 없음.
- **archive가 서버 렌더링 문서를 담는다.** `create_archive`의 항목은 이제 둘 중
  하나다 — 모델이 쓴 텍스트(`path`, `format`, `content`) 또는 서버가 렌더링하는
  문서(`path`, `documentFormat`, `blocks`). 후자는 top-level `create_document`와
  **같은 writer**를 쓴다.
- **`create_document_batch`**가 새로 생긴다. 첨부된 DOCX 템플릿을 첨부된
  스프레드시트의 행마다 한 번씩 채워 **하나의 ZIP**으로 돌려준다. 결과는
  `archive` artifact 하나이므로 3개 상한을 건드리지 않는다.
- **system prompt를 고친다.** 3은 *top-level 첨부* 상한이고, archive는 그중
  하나이며 100개를 담는다는 것을 명시한다. `N files per answer`라는 문장은
  사라졌고 `tests/generatedArtifactToolPolicy.test.mjs`가 그것을 고정한다.
- **batch tool은 turn에 DOCX가 있을 때만 등록**한다. 입력이 없는 tool은
  요청이 쓸 데 없는 과금 입력이고, 그럼에도 제공하면 모델은 결국 지어낸
  handle로 부른다. schema 비용은 `ARTIFACT_BATCH_TOOL_DEFINITION_TOKENS`로
  따로 계상한다.

### 13.3 모델은 파일을 만지지 않는다

**모델이 tool에 넣을 수 있는 것은 handle 두 개와 이름 규칙뿐이다.**

- `templateAttachment`, `dataAttachment`는
  `/^att_[1-9][0-9]{0,2}$/`만 통과한다. bytes·base64·XML·objectKey·로컬 경로를
  담을 field가 schema에 **없고**, `.strict()`이므로 추가할 수도 없다.
- handle은 요청 범위이며 어떤 route도 가리키지 않는다
  (docs/policy/user-attachment-persistence.md §6).
- handle → 바이트 매핑은 요청 처리 중 서버 메모리에만 있고, 소유권 해석이 끝난
  뒤에 만들어진다. 모델이 없는 handle을 대면 tool은 **실제로 붙어 있는 handle
  목록을 알려 주고 거절**한다 — 지어내지 말라고 말하는 것이 지어낸 파일을 만드는
  것보다 낫다.

### 13.4 템플릿 보존 — 무엇을, 어디까지

`lib/docxTemplate.ts`는 **part를 복사**한다. 텍스트를 다시 쓰지 않는다. 그래서
아래는 바이트 단위로 그대로 남는다.

| 보존 | 근거 |
|---|---|
| styles, theme, fonts | part를 건드리지 않는다 |
| 표(테두리·너비·스타일) | `word/document.xml`의 `<w:tbl>` 구조가 그대로 |
| header / footer | 치환 대상이지만 구조는 유지, 텍스트만 바뀜 |
| section 설정(용지·여백·머리글 참조) | `<w:sectPr>` 그대로 |
| 이미지 | `word/media/*`와 relationship 그대로 |
| numbering, footnotes, endnotes | part 그대로 |
| 문서 속성(`docProps/core.xml`) | 그대로 |

바뀌는 바이트는 **`<w:t>` 안의 문자뿐**이다. part가 추가되지도, relationship이
생기지도, content type이 선언되지도 않는다.

**의도적으로 지원하지 않는 것**(거절이지 무시가 아니다):

- 매크로(`vbaProject.bin`, macroEnabled content type) — `TEMPLATE_MACRO_REFUSED`
- OLE·ActiveX·embeddings·`<w:object>` — `TEMPLATE_OLE_REFUSED`
- external relationship(`TargetMode="External"`), 원격 이미지 —
  `TEMPLATE_EXTERNAL_REFERENCE_REFUSED`
- `<w:altChunk>` — `TEMPLATE_ALT_CHUNK_REFUSED`
- 외부를 읽는 field code(DDE, INCLUDETEXT, INCLUDEPICTURE, LINK) —
  `TEMPLATE_FIELD_CODE_REFUSED`
- 경로 traversal·절대 경로·비정상 ZIP entry — `TEMPLATE_UNSAFE_ENTRY`

**제거가 아니라 거절인 이유**: 문제 있는 part만 떼어 내면 사용자가 올린 것과
다른 문서가, 그것이라고 말하는 이름을 달고 배달된다.

또한 지원하지 않는 것(거절 대상은 아님): 조건 분기(`{{#if}}`), 반복
(`{{#each}}`), 이미지 치환, 표 행 반복, content control(`<w:sdt>`) 바인딩.
템플릿 한 개에서 문서 한 개, placeholder는 문자열 치환뿐이다.

### 13.5 placeholder는 문단 단위로 찾는다

Word는 맞춤법 경계·언어 태그·입력 순서 때문에 run을 쪼갠다. 실제 파일에서
`{{이름}}`은 보통 이렇게 생겼다.

```xml
<w:r><w:t>{{</w:t></w:r><w:r><w:t>이름</w:t></w:r><w:r><w:t>}}</w:t></w:r>
```

그래서 raw XML에 대한 문자열 치환은 **아무것도 찾지 못한다.** 치환은
`<w:p>` 단위로, 그 문단의 `<w:t>` 텍스트를 이어 붙인 문자열에서 찾고, 같은
run들에 되돌려 쓴다. 값은 placeholder가 **시작된** run의 서식을 물려받는다 —
Word에서 선택 영역 위에 타이핑했을 때와 같은 결과다.

- 값의 `&`·`<`·`>`는 escape되고, XML 1.0이 담을 수 없는 코드 포인트는 제거된다.
- 값의 줄바꿈은 `<w:br/>`이 된다.
- 치환된 run에는 `xml:space="preserve"`가 붙는다(값이 공백으로 시작·끝날 수 있다).

### 13.6 조용히 불완전한 문서를 만들지 않는다

- `requiredPlaceholders`에 이름 댄 열의 값이 비면 **배치 전체가 실패**한다.
  오류 메시지는 몇 번째 행인지 말한다.
- 치환 후에도 `{{...}}`가 남으면 실패한다. 이 검사는 *출력*에 대해 하므로,
  값 자체가 `{{`를 담고 있던 경우도 잡힌다.
- 부분 성공은 없다. 절반만 채워진 계약서 묶음이 배달되면 사람은 그것을 보내고,
  빠진 항목은 받는 쪽이 발견한다.

### 13.7 데이터는 서버가 읽는다

`lib/spreadsheetDataRows.ts`가 업로드된 `.xlsx`/`.csv`를 레코드로 읽는다.
첫 행이 header이고 그 셀 이름이 placeholder 이름이다.

- **모델이 값을 옮겨 적지 않는다.** 첨부 파이프라인이 만드는 추출 텍스트는 셀
  경계도 열 정체성도 없다. 그것을 보고 생년월일을 다시 타이핑하는 것이 이
  기능에서 가장 조용하게 틀리는 지점이다.
- 날짜는 Excel이 **화면에 보여 주는 날**로 읽는다. 직렬값 32936은 1990-03-04
  이다. epoch는 1899-12-30이며, 이는 Excel 자신의 1900년 윤년 버그를 재현한다.
  1900-01-01~1900-02-28(직렬 1~59)은 하루 이르게 읽히며, 이는 고치지 않고
  적어 둔 결정이다.
- 상한: 행 500, 열 64, 셀 값 4,000자. archive 항목 100개가 실질적 상한이다.

### 13.8 출력 경로

`YYYYMMDD/<sanitized-name>.docx`.

- 날짜는 생성 시각(UTC)이며 주입 가능하다 — 경로를 단언하는 테스트가 시계에
  좌우되면 안 된다.
- 이름은 `filenameTemplate`을 행 값으로 치환한 뒤
  `sanitizeArtifactFilename(..., "docx")`를 통과한 것이다. 경로 구분자·`..`·
  제어문자·Windows 예약어는 여기서 사라진다.
- 중복 이름은 **결정적으로** 처리한다: 첫 번째는 그대로, 이후는 `-2`, `-3`.
  같은 입력은 항상 같은 이름 집합을, 같은 순서로 만든다.
- 완성된 경로는 `isSafeArchivePath()`를 다시 통과해야 한다.

### 13.9 무엇을 테스트하는가

- 10행 XLSX + DOCX 템플릿 → ZIP 안 DOCX 10개, 행별 값과 파일명 정확성,
  **다른 행의 값이 섞이지 않음**.
- 여러 run에 분리된 placeholder 치환(본문·header·footer).
- styles·theme·이미지·relationship·content types가 **바이트 동일**.
- 표·section·drawing 유지.
- 생성된 모든 DOCX를 `officeparser`(이 앱이 업로드 파일을 읽을 때 쓰는 파서)로
  다시 열어 텍스트 확인.
- 매크로·OLE·external relationship·altChunk·field code·ZIP traversal 거절.
- 101번째 archive 항목 거절, 100번째 통과.
- 네 번째 top-level artifact 거절 유지.
- 기존 텍스트 ZIP과 단일 DOCX 생성 회귀 없음.
