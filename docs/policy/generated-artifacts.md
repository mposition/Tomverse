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

- `model_unverified` — 이 모델은 파일 도구를 받지 않는다. 판정 순서는 다음과 같다
  (운영자 결정 2026-11-13).
  1. 카탈로그 행의 관리자 체크(`ModelRegistryEntry.fileToolsOverride`). Admin 모델
     편집 화면의 "파일 생성·플러그인 도구" 체크박스다. 값이 있으면 그것이 답이다.
  2. 없으면 자동 판정(`autoArtifactToolSupport`). 직접 돌려 확인한 모델 목록
     `ARTIFACT_TOOL_CAPABILITIES`에 있으면 그 값을 쓰고, 목록에 없으면 제공사로
     판단한다. 이 저장소의 adapter로 도구 호출을 확인한 OpenAI·Anthropic·Google의
     채팅 모델은 켜진다. 다른 제공사는 꺼진다.
  3. Deep research는 언제나 꺼진다.

  그래서 새 모델은 추가되는 순간 자동 판정 값으로 체크된 채 나타나고, 관리자가
  Tick/Untick할 수 있다. 자동 판정과 같은 값으로 클릭하면 NULL로 저장해 자동을
  따르게 둔다. 고정 목록만 쓰던 때는 카탈로그가 바뀌면서 Auto 후보 27개 중
  하나만 파일을 만들 수 있었다(2026-11-13).
- 파일 도구를 받은 턴에는 §7의 자동 대체(다른 모델로 다시 시도)가 일어나지 않는다
  (`tools_offered`). 도구가 이미 부작용을 냈을 수 있기 때문이다. 체크를 켜면 그
  모델의 턴은 이 복구를 잃는다.
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

### Auto 모델 선택

기존 Auto 라우팅 호출은 허용 후보마다 `canCreateFiles`를 받는다. 이 값은 같은
artifact plan으로 해당 turn의 인증·저장·native search 조건을 적용해 계산한다.
모델은 선택과 함께 `requiresFileGeneration`을 반환하며 별도 분류 호출은 없다.
첨부 읽기, 인라인 코드 설명, 이미지 생성만 하는 요청은 파일 생성과 구분한다.

파일 요청에서는 선택 모델과 fallback 후보 목록을 기존 허용 후보 중 파일 생성
가능한 집합으로 제한한다. 실제 파일 tool을 제공한 turn의 자동 재시도는 기존
`tools_offered` 경계에 따라 중단된다. 모델 응답은 플랜·크레딧·context·장애·검색
조건을 넘지 못한다. Router가 지원하지 않는 모델을 골랐다면 실제 응답은 기록에
그대로 두고, 기존 선택이 지원되면 유지하거나 지원 후보 순서로 교체한다.
의미 라우팅이 꺼졌거나 실패하면 파일 의도를 확정하지 않고 기존 Auto 선택과
자동 재시도를 유지한다. 이 경우 파일 지원 모델 선택은 보장하지 않는다. 파일
요청으로 판정했지만 지원 후보가 없으면 기존 artifact 거절 지시가 이유를 설명하며,
모델을 임의로 추가하거나 기존 필터를 우회하지 않는다. 수동 선택과 Guest 로그인
조건은 유지한다.
파일 요청은 이미지 작업 공간으로 보내는 판단보다 우선한다.

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

PDF 표의 `pdfColumnWeights`는 열마다 1~20의 상대 너비를 지정하는 선택적 표시 값입니다.
모델은 긴 설명 열에 더 큰 값을 지정합니다(예: 항목·설명·금액은 `[1, 4, 1]`).
생략하면 기존처럼 균등 너비이며, PDF 생성기는 각 열의 최소 본문 공간을 확보한 뒤
나머지 폭을 비율대로 배분합니다. 다른 문서 형식은 이 PDF 전용 값을 사용하지 않습니다.

표시 형식은 **이름**으로만 받는다(`ARTIFACT_NUMBER_FORMATS`). raw `numFmt`
코드는 작은 언어이고, 모델에게서 받으면 그 언어를 여기서 파싱해 다른 것을
실어 나르지 않는지 확인해야 한다. 이름 집합은 코드 리뷰로 늘린다.

PDF 문서 표는 선택적 `pdfNumberColumns`에 숫자·금액 열의 0부터 시작하는 인덱스를
명시할 수 있다. 모델이 열의 의미를 정하고, PDF writer는 해당 열의 숫자 값에만
영문 천 단위 구분자를 적용하며 머리글과 셀을 오른쪽 정렬한다. 0과 소수·음수를
유지하고 문자열은 파싱하거나 고치지 않는다. 인덱스는 실제 열 범위 안에서 중복
없이 검증한다. 생략하면 기존 표의 값·정렬을 유지하며 다른 문서 형식에는 적용하지 않는다.

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
| 결과 파일 크기 | 5 MB (변환 결과는 25 MB — §14.4) |
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
| image | `png`, `jpg`, `webp` | `lib/fileConversion.ts` — 모델이 저작하지 않는다. 변환 결과로만 생긴다(§14) |

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
- **PDF는 글꼴을 문서에 넣는다**(`lib/fonts/noto-sans-kr-400-subset.ttf`, OFL).
  범위는 라틴(베트남어 포함)·그리스·키릴, 문장부호·기호·원문자·박스 그리기,
  `㈜ ㎡ ℃`, 가나, 한글 전부, 그리고 KS X 1001·GB 2312·Big5 1급·JIS X 0208의
  한자(약 10,800자)다. 한국어 글꼴에 없는 간체자는 같은 릴리스의 Noto Sans SC에서
  가져온다(`scripts/build-pdf-font-subset.mjs`). 이모지·`✔ ✗`·아랍어·히브리어·
  태국어와 드문 한자는 없다. **글리프 없는 문자 한 글자로 파일 전체를 실패시키지
  않는다**: 대체 상자(□)로 그리고, 바꾼 문자와 횟수를 tool 결과(`note`)에 넣어
  모델이 사용자에게 말하게 한다(zip 안의 PDF와 표 변환도 같다). 보이는 문자의
  25%를 넘게 바꿔야 하면(대부분 상자인 PDF는 불완전한 파일이 아니라 못 읽는
  파일이다) 이전처럼 `UNSUPPORTED_CHARACTERS`로 실패하되, 지원하지 않는 문자
  체계라는 사유와 못 그리는 문자(24종까지)를 적어 모델이 `.docx`를 권하게 한다.
  보이지 않는 문자(variation selector, zero-width, 제어 문자)는 상자 없이
  버리고 세지 않는다.

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
  이 애플리케이션의 origin에서는 어느 쪽도 실행되지 않는다. HTML이 실행되는 곳은 §9의 격리된 미리보기 frame과, 같은 frame을 한 겹 더 감싼 §19의 공유 페이지뿐이다(둘 다 앱 origin 없음).
- **아카이브 경로는 정규화하지 않고 거절한다.** 파일명은 label이라 다듬어도
  여전히 그 파일을 가리키지만, 경로는 **위치**다. `../../etc/passwd`를 조용히
  `etc/passwd`로 옮기면 모델이 말한 곳에 없는 내용을 담은 아카이브가 배달된다.
  절대 경로, 드라이브 문자, `\\`, `.`·`..`·빈 segment, 제어문자, 중복 경로를
  모두 거절한다(`isSafeArchivePath`).
- **깨진 구조는 배달하지 않는다.** JSON·YAML은 파싱해 보고, XML·SVG·HTML은
  균형과 미종료 속성을 검사한다. 파싱되지 않는 설정 파일은 설정 파일이 아니다.
  XML·SVG는 엄격하게 본다(대소문자, 따옴표 없는 속성, 중복 속성, 이스케이프되지
  않은 `&`, 닫히지 않은 요소가 모두 거절 사유다). HTML은 브라우저가 읽는 만큼만
  본다: `<script>`·`<style>`·`<textarea>`·`<title>`의 본문은 닫는 태그까지 글자로
  건너뛰고(그래서 `i < n`이 든 script가 통과한다), 태그를 시작할 수 없는 `<`는
  글자이며, HTML이 생략을 허용하는 닫는 태그(`</li>`·`</p>`·`</td>` 등)는 없어도
  된다. 거절하는 것은 부서진 것이다: 끝나지 않은 태그·주석·raw text 요소, 생략할
  수 없는 요소(`<div><span></div>`)를 가로지르는 닫는 태그, 파일 끝까지 열려 있는
  요소(잘린 page). zip 안의 `.html`도 같은 검사를 거친다.
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
  `discard()`로 객체를 회수한다. 기본값이 "회수"다. **단, 메시지 쓰기의 결과를 알
  수 없을 때**(COMMIT 결과 불명 + 커밋 확인 조회 실패)는 커밋된 행이 그 객체를
  가리킬 수 있으므로 지우지 않고 아래 고아 sweep에 맡긴다(2026-11-27). durable turn은
  attempt의 terminal CAS가 롤백을 확인하면 그때 회수한다.
- **텍스트 없이 파일만 만든 turn**(모델이 본문 없이 끝났거나 tool step이 모두
  소진된 turn)도 파일이 저장소에 하나라도 저장됐으면 답변이다. 빈 본문의
  assistant 메시지와 파일 행을 같은 트랜잭션에 쓰고 `completed`로 정산한다(파일이
  전달됐으므로). 서버는 본문에 어떤 언어의 문장도 써 넣지 않고, 카드 위의 한 문장
  (`chat.artifactOnlyAnswer`)은 화면이 사용자 언어로 그린다. 2026-11-27 변경.
  - 이 turn의 정산은 **저장 결과가 정해진 뒤**에 한다. 본문이 있는 답변은 사용자가
    이미 읽었으므로 저장 전에 정산하지만, 파일만 있는 답변은 메시지와 파일 행이
    생겨야 전달된다. 롤백이 확인되면 파일을 회수하고 `empty`(0 크레딧)로, 커밋됐거나
    결과를 알 수 없으면(파일을 남겨 재조회에 맡긴다) 원래 정산으로 한다.
  - provider가 도중에 끊은 파일만 있는 답변은 파일을 남기되 본문이 있는 끊긴 답변과
    같이 비례 정산(`cancelled`)하고 provider 실패로 기록한다.
- **본문도 저장된 파일도 없고 실패 카드만 있는 turn**(출력 한도에 걸린
  `turn_incomplete`, 생성 실패 등)은 빈 본문의 메시지와 실패 카드 행을 저장해
  §9의 "재조회 후에도 카드가 남는다"를 지킨다. 파일이 전달되지 않았으므로 정산은
  빈 응답과 같은 `empty`(0 크레딧)이고 provider 기록·오류 보고도 빈 응답과 같다.
  화면은 "빈 응답" 오류 대신 카드를 보여 주며, 카드 위에 문장을 붙이지 않는다.
  durable attempt는 메시지 트랜잭션이 `completed`로 끝내므로 재조회와 attempt
  복구가 같은 메시지를 본다. 2026-11-27 변경.
- 메시지를 쓸 대화가 없는 turn(게스트 등)의 저장된 파일만 예전처럼 빈 응답으로
  보고되고 파일을 남기지 않는다(참조할 메시지가 없으므로 쓰는 순간 도달 불가능한
  객체가 된다). `generated_artifact_discarded_empty_answer`로 따로 기록한다.
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
- **"도표·다이어그램·인포그래픽 요청은 묻지 말고 만든다"는 지시는 2026-10-20에
  삭제됐다.** 그 지시(`IMAGE_ARTIFACT_MAKE_FRAGMENT`)는 규칙 기반 분류기의
  `text_heavy_visual` 판정에 매여 있었고, 분류기를 LLM 판정(image-generation
  정책 §13 ⑥)으로 대체하면서 함께 지웠다. 이제 tool이 등록된 turn은 요청과
  무관하게 같은 제안 문단(`IMAGE_ARTIFACT_FRAGMENT`, `lib/imageCapabilityPrompt.ts`)만
  받는다. "파일을 요청하면 부르라"는 tool 규칙은 그대로다.
- **SVG는 카드 안에서 미리 보여 준다.** 다른 모든 형식은 응용 프로그램이 여는
  문서지만 SVG는 브라우저가 이미 그릴 수 있는 그림이고, 다운로드만 제공하면
  사용자는 원하던 그림인지 확인하려고 대화를 떠나야 한다. 미리보기는 카드
  안에서 **자기 줄 전체**를 차지하며 파일명·버튼 행과 자리를 나누지 않는다.
  - **`<img>`으로만 그린다.** `<img>` 안의 SVG는 브라우저의 secure static
    mode에 들어가 script가 실행되지 않고 외부 자원을 가져오지 않으며 상호작용도
    없다. markup을 DOM에 인라인하거나 `<object>`·`<iframe>`을 쓰면 그 보장이
    사라진다 — `findSvgScript()`의 거절이 이미 있어도 이것은 별개의 층이다.
  - blob의 media type은 **카드가 정한다**. 응답의 것을 그대로 쓰면 route가
    언젠가 다른 type을 답할 때 이 요소가 다른 것이 된다.
  - **실패하면 조용히 미리보기가 없다.** 다운로드 버튼은 그대로이며, 이미
    동작하는 control이 있는 카드에 그림 하나 때문에 두 번째 오류 줄을 더하지
    않는다.
  - `alt`는 그림을 묘사하지 않고 **파일명을 말한다**. 생성된 그림을 묘사할 수
    있는 사람은 없고, 비워 두면 스크린 리더 사용자에게 미리보기가 있다는 사실
    자체가 숨겨진다.
- **HTML은 옆 패널에서 미리 본다.** 준비된 `.html`·`.htm` 카드에는 다운로드 옆에 "미리보기"가 있고,
  데스크톱은 오른쪽 패널, 모바일은 전체 화면 시트로 엽니다. 차트나 간단한 인터랙티브 페이지를 내려받지
  않고 확인하는 것이 목적입니다(`lib/htmlArtifactPreview.ts`, `components/chat/HtmlArtifactPreviewPanel.tsx`).
  모델이 쓴 HTML은 script를 실행할 수 있으므로 **앱 origin에 닿지 못하는 격리**가 전부입니다.
  - `<iframe sandbox="allow-scripts">`**만** 줍니다. `allow-same-origin`이 없어 frame은 불투명 origin이고,
    이 앱의 쿠키·저장소·DOM·API에 닿을 수 없습니다. top navigation·popup·form·modal·download도 없습니다.
  - 내용은 `srcdoc`으로만 넣고 URL로 로드하지 않습니다. 문서 맨 앞에 CSP `<meta>`를 둡니다(page 안의
    `<head>`를 패턴으로 찾아 끼우면 주석 안에 들어갈 수 있으므로 앞에 붙입니다): `default-src 'none'`,
    `connect-src 'none'`, `form-action 'none'`, `base-uri 'none'`, `frame-src 'none'`, `object-src 'none'`,
    script·style·글꼴은 inline과 cdnjs·jsdelivr·unpkg만, 이미지는 inline(`data:`·`blob:`)만, `'unsafe-eval'` 없음,
    `webrtc 'block'`(2026-11-28, 아직 집행하는 브라우저가 없어 아래 WebRTC 가드가 실제 차단이다 — §19.7).
    CSP `<meta>` 바로 뒤, page보다 먼저 WebRTC 가드 script(`HTML_PREVIEW_GUARD_SCRIPT`)가 돈다. 채팅에서는 앱의 nonce 정책을
    상속하므로 가드도 앱 문서의 nonce를 단다(`buildHtmlPreviewSrcdoc(..., { nonce })`).
    이미지 URL에 page의 글을 실어 어느 host로도 보낼 수 없습니다. React 미리보기 문서는 자기 `<head>` 맨 앞에
    더 좁은 정책(`reactPreviewCsp`)을 하나 더 둡니다. 두 정책이 함께 적용되어 고정한 세 파일과 inline script만 실행됩니다.
    그 세 파일은 **이 앱이 직접 제공합니다**(`public/vendor/artifact-preview/`, 아래). 그래서 React 미리보기에는 제3자 host가
    하나도 없고, script URL의 경로나 query에 글을 실어도 이 앱 서버에만 닿습니다. 공통 정책은 앱 origin 중
    `/vendor/artifact-preview/` 경로만 더 허용합니다(`htmlPreviewCsp(origin)`; `srcdoc` frame의 origin은 opaque라 `'self'`로는 안 됩니다).
    한계: 모델이 쓴 HTML page(React가 아닌 것)는 차트·지도 라이브러리를 쓰려고 세 CDN의 script·style·글꼴을 계속 받을 수
    있으므로, 그 page가 CDN 주소에 글을 실어 요청하면 CDN 운영자 로그에는 남을 수 있습니다(다른 host로는 못 보냄).
  - 미리보기는 **frame 안의 frame**입니다. 안쪽이 모델의 page(위 sandbox·CSP)이고 바깥쪽은 우리 문서로
    `frame-src 'none'`**만** 갖습니다(`srcdoc` 자식은 부모의 모든 정책을 상속하므로 다른 지시문을 더하면 page에
    닿습니다). script가 `location`을 바꿔 자기 frame을 임의 주소로 보내는 것은 page 정책으로 막을 수 없는
    유일한 통로인데(`navigate-to`는 출시되지 않았습니다), 브라우저는 frame의 모든 navigation을 그 frame을 담은
    문서의 `frame-src`로 검사하므로 바깥 문서가 요청 전에 거절합니다. 최초 `srcdoc` 로드는 네트워크 navigation이
    아니어서 영향받지 않습니다. 한계: 이 거절은 브라우저의 `frame-src` 의미에 기대며, Browser 창(샌드박스된 네트워크
    문서를 열지 않는 환경)에서는 관찰하지 못했습니다. page가 파일에 담긴 민감 정보를 URL에 실어 보내는 유출은
    이 한 겹과 앱 CSP의 `frame-src`(enforce 모드)에 의존합니다. 안내 문구도 "계정에 접근할 수 없다"까지만
    말합니다.
  - 파일은 다운로드와 **같은 인증된 경로**(`/api/artifacts/{id}`)로 읽으므로 소유자 확인·대화 잠금(423)·
    rate limit이 그대로입니다. 1,000,000바이트를 넘으면 미리보기 대신 다운로드만 권합니다.
  - `srcdoc` 문서는 앱의 CSP(nonce 기반 `script-src`·`style-src`)를 **상속**합니다. 그대로 두면 enforce 모드에서 page의
    inline script·style이 막혀 스타일도 동작도 없는 화면이 됩니다(브라우저에서 확인). 그래서 패널이 앱 문서의 nonce를
    page의 `<script>`·`<style>`·stylesheet `<link>`에 붙입니다(`withEmbedderNonce`, 텍스트 패턴이 아니라 브라우저
    `DOMParser`로). frame에 `allow-same-origin`이 없으므로 nonce는 frame 안에서만 쓰이고 `HTML_PREVIEW_CSP`도 함께
    적용됩니다. `DOMParser` 문서는 브라우저 맥락이 없어 자원을 가져오지 않습니다(img·link·script·iframe·video
    poster·object·@import를 담은 page를 파싱해도 서버에 요청이 오지 않는 것을 확인). inline 이벤트 속성(`onclick="..."`)은 nonce 정책에서 막힌 채로 두며 `addEventListener`는 동작합니다.
    frame 안에서 막힌 요청의 CSP 위반 보고가 앱의 보고 endpoint로 갈 수 있습니다.
  - SVG 카드 미리보기(`<img>`)는 이것과 별개입니다.
  - **답변 안 코드 블록과 React도 같은 패널에서 미리 봅니다**(`TOMVERSE_CHAT_ARTIFACT_WORKSPACE_ENABLED`, 기본 꺼짐).
    스위치는 서버에서 읽어 `ReviewWorkspaceShell` → `ChatPageClient` → `ChatArtifactWorkspaceProvider`로 내려가고,
    provider 밖(공유 페이지 등)에서는 아래 동작이 하나도 나타나지 않습니다. 격리(sandbox·CSP·중첩 frame)는 위와 **같은 것을
    그대로** 쓰며 `lib/chatArtifactPreview.ts`가 frame에 넣을 문서만 만듭니다. 허용 CDN 목록은 넓히지 않았습니다.
    - 답변이 **끝난 뒤** ```` ```html ````·```` ```svg ````·```` ```jsx ````·```` ```tsx ```` 블록에 "미리보기" 버튼이 붙습니다
      (스트리밍 중인 블록에는 붙이지 않습니다). 버튼을 누르기 전에는 아무것도 실행되지 않습니다. 파일이 아니라 답변 본문
      코드이므로 서버를 거치지 않고, 화면에 보이는 코드 텍스트를 그대로 frame에 넣습니다. 한도는 파일과 같은 1,000,000바이트입니다.
    - HTML 블록은 그대로 page이고, SVG 블록은 흰 바탕 가운데에 놓입니다(XML 선언·doctype은 버립니다).
    - **React(`jsx`/`tsx` 블록과 생성된 `.jsx`/`.tsx` 파일)**는 frame 안에서 컴파일합니다. 문서는 React 18.3.1 UMD,
      ReactDOM 18.3.1, Babel standalone 7.26.2를 **이 앱의 `/vendor/artifact-preview/`에서 정확한 버전과 sha384 integrity**로
      불러오고(`REACT_PREVIEW_SCRIPTS`; cdnjs 배포본과 바이트가 같고 테스트가 파일 해시를 고정), frame의 origin이 `null`이라 CORS로
      받으므로 그 경로에만 `Access-Control-Allow-Origin: *`를 둡니다(`next.config.ts`, 공개 라이브러리 파일),
      안쪽 script가 `Babel.transform`(presets `react`, TSX는 `typescript`; plugin `transform-modules-commonjs`)한 결과를
      nonce를 단 `<script>` 요소의 텍스트로 넘깁니다. **`eval`·`new Function`을 쓰지 않으므로 CSP에 `'unsafe-eval'`이 없습니다.**
      채팅 페이지는 아무것도 컴파일하거나 평가하지 않습니다. 기본 export 컴포넌트, 없으면 `App`을 mount하고,
      `import`는 `react`·`react-dom`만 풀립니다(다른 패키지는 패널 안에 "미리보기에서 쓸 수 없다"는 안내). 코드는 문서 안
      `<textarea>`에 HTML escape된 텍스트로 담겨 요소를 닫거나 더할 수 없습니다.
    - **실패는 frame 안의 짧은 안내입니다.** 문법 오류, 실행 오류, 렌더 중 오류(error boundary), 컴포넌트 없음, 라이브러리 로드 실패는
      frame 안 상단에 안내(첫 오류만, 최대 8줄)로 보이고 채팅 화면은 영향받지 않습니다.
    - **"이 화면 고치기"**: 패널 아래 입력란에 바꿀 내용을 적으면, 생성 파일은 기존 "수정본 만들기" 경로(원본 복사본 첨부와 표준
      요청문, 그 아래 입력한 내용)로, 답변 코드 블록은 입력창 맨 위에 "위 코드에서 다음을 고쳐 주세요: …"를 채워 넣고 패널을
      닫습니다. 보내지는 않으며 **새 서버 API가 없습니다**. 입력란은 그 경로가 실제로 있는 곳에만 나타납니다(생성 파일은 계정과 수정본 만들기가 켜진 대화, 코드 블록은 채팅 입력창이 있는 화면).
    - **패널 안에서 직접 고치기**(같은 스위치, 2026-11-28): 패널 위에 "미리보기 / 코드" 전환이 있고, 코드 보기는 위에 원문
      textarea, 아래에 실시간 미리보기입니다(`components/chat/ArtifactPreviewWorkspace.tsx`). HTML 파일·React 파일·코드 블록
      모두 같습니다. 미리보기는 마지막 입력 뒤 400ms가 지나야 다시 그립니다(`ARTIFACT_EDIT_RENDER_DELAY_MS`). 고친 글은
      원문과 **같은 경로**(`buildCodePreviewDocument` → `HtmlArtifactPreviewFrame` → `buildHtmlPreviewSrcdoc`)로만 frame에
      들어가므로 sandbox·CSP·중첩 frame·1,000,000바이트 한도가 그대로입니다. 고친 내용은 이 페이지의 메모리에만 있고
      (`lib/artifactPreviewEditing.ts`, 저장소·서버·대화에 쓰지 않음, 새로고침하면 원래대로), 패널을 닫았다 열면 남아
      있습니다. 파일은 artifact id로, 코드 블록은 답변의 `data-message-id`와 그 답변 안 미리보기 가능한 블록 사이의 위치(`previewableBlockIndex`)와 원문으로 구분하므로 다른
      답변에 같은 코드가 있어도 편집이 섞이지 않습니다. 답변 id가 없는(저장 전) 블록은 편집을 남기지 않습니다. "원래대로", "복사", "내려받기"(파일은 원래 이름, React는 text/plain), 고쳤을 때만 "이 버전으로 계속"이
      있고, 마지막은 고친 코드를 fenced block으로 감싼 요청문을 입력창에 채울 뿐 보내지 않습니다(50,000자 넘으면 내려받기
      안내, `ARTIFACT_CONTINUE_MAX_CHARS`). 스위치가 꺼져 있으면 HTML 파일 패널은 예전처럼 frame만 보입니다.
    - 서버 저장, 여러 모델 나란히 미리보기는 하지 않습니다(§12).
  - 검증: `tests/htmlArtifactPreview.test.mjs`(sandbox·CSP 문자열 고정),
    `tests/chatArtifactPreview.test.mjs`(코드 블록 판정, React 문서의 자체 호스팅 경로·파일 해시·escape, bootstrap에 eval 없음, 모든 문서가 같은
    격리를 거침), `tests/client/htmlArtifactPreviewRender.test.tsx`(frame 속성·버튼 조건),
    `tests/client/chatArtifactWorkspace.test.tsx`(스위치·스트리밍·언어별 버튼, 8개 언어 문구),
    `tests/artifactPreviewEditing.test.mjs`·`tests/client/artifactPreviewWorkspaceRender.test.tsx`(편집: fence·길이 상한·
    내려받기 이름, 스위치 꺼짐이면 frame만, 고친 frame도 같은 sandbox).
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

- **완료 판정이 출력 한도(`incompleteReason: "length"`)로 `incomplete`일 때만**
  기록한다(`resolveChatCompletionOutcome`). 정상 종료, 취소, provider가 도중에 끊은
  `interrupted`는 대상이 아니다.
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
  2. **Google Search grounding**은 built-in retrieval tool이며 function
     declaration과 함께 보낼 수 없다. 둘 다 보내면 provider가 400으로 거절한다
     — 파일 요청이 오류가 된다.

  Anthropic의 `web_search_20250305`는 두 문제가 모두 없어 공존한다.

  **2번은 "provider가 Google이면"이 아니다** (2026-08-27 정정). 배타성은
  *grounding*의 성질이지 Gemini의 성질이 아니다. 평범한 function declaration을
  실은 Gemini 요청은 평범하고, Gemini 3는 built-in tool과 custom function을 함께
  쓰는 것도 지원한다. 그럼에도 규칙을 좁히는 근거는 문서가 아니라 **이 앱이 무엇을
  보내는가**다: Google 모델의 웹 검색은 이제 grounding이 아니라 이 앱이 실행하는
  function tool(`web_search`, `lib/appManagedWebSearchTool.ts`)이고,
  `buildWebSearchToolConfig`는 grounding을 **아예 만들지 않는다**. 요청에
  배타적일 대상이 없으므로 파일 생성을 막는 것은 존재하지 않는 이유로 거절하는
  일이 된다.

  그래서 `nativeSearchBlocksArtifactTool()`은 `nativeSearchEnabled`를 본다.
  application-managed 경로에서는 그 값이 false이므로 검색과 파일 생성이
  공존하고, 누군가 grounding을 다시 켜면 Google 모델에서 그 값이 다시 true가
  되어 규칙을 기억하지 않아도 다시 fail-closed가 된다.

  검색과 artifact가 한 turn에 함께 있을 때 `stopWhen`은 두 step 예산 중 큰
  쪽이다. 어느 쪽도 비용 상한이 아니므로(검색의 상한은 session counter, 파일의
  상한은 turn당 artifact 수) 큰 쪽을 택해도 지출 bound가 올라가지 않는다.

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
- 공유 대화 스냅샷은 artifact를 포함하지 않는다. 미리보기 화면 하나의 공유 링크는 §19(기본 꺼짐)다.
- 문서 파일(docx·pptx 등)의 공유 링크, 공유 페이지에서 방문자가 이어서 고치기(remix), 별도 sandbox 도메인,
  공유 페이지 방문 통계, 사이드바의 공유 목록, 공유 내용 moderation.
- 패널에서 고친 내용의 서버 저장, 여러 모델의 결과 나란히 미리보기.
- React 미리보기에서 React 밖의 패키지(차트·아이콘 라이브러리 등)와 Tailwind. 허용 CDN 목록을 넓히지 않고는 불가능하다.

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
- 시스템 지시에 목록으로 알린 첨부인데 서버가 바이트를 읽지 못한 경우(저장본이 사라진
  경우 등)는 "없는 handle"과 다르다. tool은 "첨부는 되어 있지만 열 수 없었다, 새로
  올려 달라고 하라, 첨부하지 않았다고 말하지 말라"고 거절하고 카드는
  `generation_failed`다. 2026-11-13 운영에서 사진 두 장이 목록에는 있고 바이트는 없어
  "No files are attached"가 돌아갔고, 모델이 그 말을 사용자에게 그대로 전했다. 거절
  로그(`generated_artifact_tool_rejected`)에는 고정 실패 코드(`SOURCE_UNREAD`·
  `SOURCE_MISSING`·`ADMISSION_REJECTED` 등)와 "목록에 있던 첨부 수 / 읽은 첨부 수"만
  남긴다. 파일 이름과 내용은 남기지 않는다. 둘이 다르면 route가
  `chat_turn_attachments_unread`도 남긴다.

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

## 14. 사용자가 올린 파일을 변환하기 (`convert_files`)

운영자 결정: 2026-11-12. 사용자가 사진 두 장을 첨부하고 "하나의 PDF로 만들어
달라"고 했을 때, 파일을 만들 수 있는 모델이 "첨부된 이미지를 불러와 PDF로
변환할 수 없다"고 답했다. 모델을 바꿔도 결과는 같았다 — §3의 다섯 tool은 모두
**모델이 쓴 내용**을 받고, 사진은 모델이 쓸 수 있는 내용이 아니기 때문이다.
이 절은 그 공백을 메운다.

### 14.1 규칙

> 변환에서 모델은 바이트를 받지도, 만들지도 않는다.

모델이 내는 것은 §13과 같은 handle(`att_1`, `att_2`)과 지시뿐이다. 읽기·변환·
쓰기는 전부 서버가 한다(`lib/fileConversion.ts`). 명세와 한도, 페이지 선택
문법은 `lib/fileConversionCore.ts`에 있고 파일 없이 테스트할 수 있다.

### 14.2 무엇을 변환하는가

tool은 하나(`convert_files`)이고 `operation`이 다섯 가지다.

| operation | 입력 | 출력 |
|---|---|---|
| `to_pdf` | 이미지(png·jpg·webp·gif)와 PDF, 순서대로 | PDF 하나. 이미지는 한 장에 한 페이지. PDF 합치기, 페이지 추출·순서 변경(`pages: "3,1,2"`)·회전도 같은 호출이다 |
| `split_pdf` | PDF 하나 | 구간별 PDF 묶음(zip). `splitEvery` 또는 source별 `pages` |
| `pdf_to_images` | PDF | 페이지별 png·jpg·webp. 한 장이면 이미지 파일, 여러 장이면 zip |
| `convert_images` | 이미지 | png·jpg·webp로 형식 변환, `maxDimension` 축소, `quality` 압축. 여러 장이면 zip |
| `convert_spreadsheet` | xlsx·csv | xlsx·csv·PDF 표. 워크북은 지정한(없으면 첫) 시트 하나 |

- 휴대폰 사진은 EXIF 방향대로 세운 뒤 페이지에 놓는다. PDF 페이지에는 방향
  메모를 둘 곳이 없다.
- 표 변환에서 **명백한 숫자만** 숫자로 쓴다. `007`, `1e5`, 16자리 번호는 글자로
  남는다. 숫자로 바꿨다가 다시 적었을 때 원래 글자와 똑같지 않은 값
  (`999999999999999.99`, `1.50`)도 글자로 남는다.
- XLSX의 숫자 셀은 **스프레드시트가 화면에 보여 주는 글자 그대로** 쓴다(운영자
  결정 2026-11-12). 0 채움(`000`→`007`)·통화·퍼센트·천 단위·날짜·시각·누적
  시간(`[h]:mm`)·서식 구역의 해석은 직접 만든 해석기가 아니라 SheetJS의 SSF
  (`ssf`, Apache-2.0)가 한다 — Excel의 "CSV로 저장"과 같은 결과다. 그러므로
  `hh:mm` 서식의 초처럼 화면에 보이지 않는 자리는 결과에도 없다. 예외는 둘이다:
  - 기본(General) 서식 숫자는 유효숫자 15자리를 유지한다. SSF의 General은 기본
    열 너비에 맞춰 줄이기 때문이다.
  - 지역 설정을 따르는 내장 짧은 날짜 서식 14·22번은 `yyyy-mm-dd`(·`hh:mm`)로
    쓴다. SSF는 미국식(`11/12/26`)으로 쓰는데, 변환된 파일은 어느 지역에서나
    읽힌다.
- 계산된 값이 없는 수식 셀이 있으면 변환을 거절한다. 이 리더는 수식을 계산하지
  않으므로 빈칸으로 쓰면 변환된 척하는 빈 셀이 된다.
- 첫 행은 **읽은 그대로** 쓴다. 헤더인지 아닌지는 변환이 정하지 않으며, 빈 칸에
  이름을 지어 넣거나 공백을 다듬지 않는다. 워크북이 파일에서 생략한 빈 행도
  제자리에 되살린다.
- 표 변환은 셀을 **자르지 않는다**. 20,000자를 넘는 셀이 있으면 변환을 거절한다
  (템플릿 batch는 placeholder 값이라 4,000자에서 자르지만, 변환 대상은 사용자의
  데이터다).
- zip 안의 이름은 실제로 쓴 이름 전체와 대소문자 구분 없이 비교해 겹치지 않게
  한다.
- **내용을 다른 형식으로 다시 쓰는 일**(PDF 본문 → Word, Word → PDF)은 변환이
  아니다. 모델이 추출된 내용을 읽고 `create_document`로 다시 쓰며, 레이아웃이
  복사되지 않고 다시 만들어진다고 말한다.

### 14.3 언제 등록되는가

`planGeneratedArtifactTool()`의 `registerFileConversion`. `generate` mode이고,
이 turn에 변환이 읽을 수 있는 파일(이미지·PDF·xlsx·csv)이 하나라도 첨부됐을
때만 tool을 보낸다. batch tool과 같은 이유다 — 쓸 대상이 없는 tool은 과금되는
입력이고, 모델은 결국 없는 handle을 지어낸다. schema 비용은
`FILE_CONVERSION_TOOL_DEFINITION_TOKENS`로 예약에 더한다.

변환 대상은 **그 메시지에 첨부한 파일**이다. 앞선 메시지의 파일을 변환해
달라는 요청에는 tool이 없으므로, `generate` 프롬프트가 "파일을 첨부해 다시
보내 달라고 말하라, 못 한다고 말하지 말라"고 지시한다.

게스트(`sign_in_required`)와 모든 `off` mode에는 등록하지 않는다.

운영 스위치: 환경 변수 `CHAT_FILE_CONVERSION=off`이면 tool과 그 안내 문구가
모두 빠진다. preflight와 chat route가 함께 읽는 `buildChatTurnSystemBlocks`
한 곳에서만 읽으므로 견적과 실제 요청이 어긋나지 않는다. 기본은 켜짐이다 —
새 지출도, 외부 전송도 없고 배포 없이 끌 수 있다.

### 14.4 한도 (`FILE_CONVERSION_LIMITS`)

| 항목 | 값 |
|---|---|
| source 항목 | 20 |
| 만들어지는 PDF의 페이지 | 500 |
| 이미지로 그리는 PDF 페이지 | 30 |
| split 결과 파일 | 100 |
| 입력 이미지 픽셀 | 6,000만 |
| `pdf_to_images` dpi | 50~300, 기본 150 |
| 표 변환 행 · 열 | 10,000 · 64 (PDF 표는 500 · 20) |
| 결과 파일 크기 | 25 MB (`ARTIFACT_LIMITS.maxConvertedOutputBytes`) |

결과 크기 상한이 §3의 5 MB보다 큰 것은 의도다. 5 MB는 모델이 앱에게
**쓰게 할 수 있는** 양의 상한이고, 변환 결과는 사용자가 이미 올린 바이트의
재배열이다. 25 MB는 변환 결과 하나의 상한이며 요청 첨부 합계(100MiB)보다 작으므로,
변환이 요청이 가져온 것보다 많이 저장할 수는 없다. 저장(`putArtifactObject`)과 다운로드
route가 이 값을 함께 쓴다. 이미지를 PDF에 넣을 때는 A4 인쇄 품질(긴 변
2,480px)에서 시작해, 상한을 넘으면 단계적으로 줄인다.

존재하지 않는 페이지는 **거절한다**. 6쪽 파일에 대한 `1-9`를 조용히 6쪽으로
줄이면 사용자가 말하지 않은 문서가 나간다.

### 14.5 형식

출력이 이미지일 수 있으므로 형식 표에 `png`·`jpg`·`webp`(kind `image`)가
추가됐다. **모델이 저작하는 kind가 아니다** — `create_image`에 해당하는
artifact tool은 없고, 이미지 artifact는 변환의 결과로만 생긴다(생성 이미지는
`docs/policy/image-generation.md`의 별개 도메인). migration
`20261112150000_message_artifact_image_formats`가 `format` CHECK를 넓힌다.

### 14.6 보안과 실패

- handle은 요청 계층이 이미 소유권을 확인해 읽어 둔 그 turn의 파일만
  가리킨다(§13과 같은 map). 모델이 경로·URL·key를 보내면 schema에서 거절한다.
- PDF 페이지는 PDFium의 WebAssembly 빌드(`@hyzyla/pdfium`)로 worker thread에서
  그린다. CPU가 무거운 경로가 다른 요청을 멈추면 안 되기 때문이고, 90초 시간
  제한이 있다. **pdf.js를 쓰지 않는다**: pdf.js는 네이티브 모듈
  `@napi-rs/canvas`로 그리는데, 그 모듈을 불러온 worker를 종료하면 worker가 아니라
  **프로세스 전체**가 접근 위반으로 죽었다(2026-11-12, 한 번에 worker 하나로도
  재현). WebAssembly 엔진에는 죽을 네이티브 코드가 없어 시간 초과 때 worker를
  멈춰도 안전하다. 자식 프로세스로 격리하는 방법은 쓰지 않는다 — 게이트가 닿는
  코드에서 `node` 자식 프로세스 실행은 control-plane 분석(`lib/agentControlPlaneSlice.ts`)이
  금지한다.
- 암호가 걸린 PDF는 복사하지 않고 그렇게 말한다.
- 실패는 §8·§9의 카드 규칙을 그대로 따른다: 덜 요청하면 되는 실패는
  `limit_exceeded`, 다른 파일이나 다른 지시가 필요한 실패는 `spec_rejected`,
  그 밖은 `generation_failed`. 실패 사유 문장에는 파일 내용이 들어가지 않는다.
- 같은 지시와 같은 파일의 재호출은 `unchanged`다(hash에 각 handle이 가리킨
  파일의 이름과 크기가 들어간다).

### 14.7 아직 하지 않는 것

- Word·Excel·PowerPoint를 **레이아웃 그대로** PDF로 바꾸는 일. 렌더링 엔진
  (LibreOffice 등)이 서버에 필요하다.
- HEIC 입력(첨부 형식에 없다), PDF 암호 설정·해제, PDF 압축.
- 문서 본문 중간에 첨부 이미지를 넣는 block.
- 앞선 메시지의 첨부를 handle로 가리키는 일.

### 14.8 무엇을 테스트하는가

- `tests/fileConversion.test.mjs`: 실제 바이트로 다섯 operation을 돌리고 결과를
  parser로 다시 연다(페이지 수·크기·회전, zip 항목, 이미지 형식·픽셀, 표 값).
  페이지 선택 문법, 없는 handle·틀린 형식·없는 페이지·읽을 수 없는 PDF 거절.
- `tests/generatedArtifactToolPolicy.test.mjs`: 등록 조건, 프롬프트 문구,
  운영 스위치.
- `tests/server-contract/generated-artifact-collector.test.ts`: 저장·ordinal·
  재호출·실패 카드·answer당 3개 상한·storage 실패.

## 15. Office 문서를 레이아웃 그대로 PDF로 (렌더러 서비스)

운영자 결정: 2026-11-12, 선택지 1(사내 렌더러 서비스). Word·PowerPoint·Excel
파일을 **레이아웃 그대로** PDF로 만드는 일은 이 프로세스 안의 어떤 것도 할 수
없다 — 오피스 제품군이 필요하다. 렌더러는 Gotenberg(LibreOffice를 HTTP API로
감싼 것)이고, Railway의 private network에 **별도 서비스**로 돈다. 사용자의 파일이
Tomverse 밖으로 나가지 않고, 신뢰할 수 없는 문서를 여는 큰 네이티브 프로그램이
앱과 다른 컨테이너에서 돈다.

### 15.1 무엇이 되는가

`convert_files`의 `to_pdf`가 Office 원본을 받는다: `docx`·`pptx`·`xlsx`,
OpenDocument(`odt`·`odp`·`ods`), Office 97-2003(`doc`·`ppt`·`xls`), `rtf`,
한글(`hwp`·`hwpx`), Apple `pages`·`numbers`. 렌더러가 PDF로 그린 뒤 이미지·PDF와 섞어 순서대로 합치고,
페이지 선택(`pages`)과 회전도 그대로 적용된다. 같은 파일을 여러 번 가리켜도 한
번만 그린다.

- `to_pdf`의 xlsx는 **인쇄 모양 그대로**다. 값만 표로 옮기는 것은 지금처럼
  `convert_spreadsheet`(§14)가 한다.
- iWork 변환은 Office보다 충실도가 낮다(Pages·Numbers는 복잡한 서식이 일부 다를 수
  있다). Keynote는 첨부 단계에서 받지 않는다(`chat-attachment-formats.md` §2.4).
- 한글(HWP 5.x·HWPX)은 기본 LibreOffice가 열지 못한다. 렌더러 이미지
  (`apps/office-renderer/Dockerfile`)에 H2Orestart 필터와 한글 글꼴을 넣는다.
  한글 파일의 **내용 읽기**는 렌더러와 무관하게 이 앱의 파서가 한다
  (`docs/policy/chat-attachment-formats.md §4.6`).

### 15.2 스위치와 주소

두 값이 **모두** 있어야 켜진다: `CHAT_OFFICE_TO_PDF=on`, `OFFICE_RENDERER_URL`.
꺼져 있으면 tool 안내에서도 빠지고, Office 원본을 `to_pdf`에 주면
`create_document`로 다시 쓰는 대안을 안내하며 거절한다.

- 주소는 **환경 변수에서만** 온다. 요청이나 모델이 주소를 정할 길은 없다.
- `http:` 주소는 사설망(`*.railway.internal`, localhost)만 허용한다. 주소에 계정
  정보를 넣을 수 없다. Basic 인증은 `OFFICE_RENDERER_USERNAME`·
  `OFFICE_RENDERER_PASSWORD`로 선택한다.
- 렌더러에는 **사용자 파일명을 보내지 않는다**. `document.<확장자>`를 보내며,
  확장자는 서버가 저장한 media type에서 정한다.
- 결과에 대한 검사는 하나다: PDF여야 한다(`%PDF-`). 25 MB를 넘으면 읽기를 멈춘다.
  시간 제한 90초.

### 15.3 보내기 전 측정과 실패

렌더러는 **공용 서비스**다. 한 문서가 수 GB로 부풀면 모두의 변환이 멈춘다. 텍스트
리더는 자기가 읽는 부분(HWPX의 본문 section 등)만 풀기 때문에, 그림 항목에 숨긴
압축 폭탄은 그 검사를 지나 LibreOffice에 닿을 수 있다. 그래서 렌더러로 보내기 전에
`lib/officeRenderInput.ts`가 **압축된 모든 부분을 실제로** 입력 4 KB씩 풀어 나온
바이트를 세고 버린다: ZIP 기반 문서(OOXML·ODF·HWPX·iWork)는 모든 항목과 그 안에 다시
압축된 것(문서에 넣은 통합 문서 같은 내부 ZIP, gzip, iWork의 Snappy `.iwa`;
`lib/packageExpansion.ts`), HWP 5.x는 머리의 압축 플래그와 관계없이 모든 스트림(BinData 항목은 따로 압축될 수 있다, 독립 검토 7차). 풀어 나온 바이트의 합이 200 MB를 넘거나 항목이 2만 개를 넘으면 보내지
않고 `spec_rejected`로 거절한다(독립 검토 2026-11-13). 압축을 풀기 전 원래 바이트는 이 합에
넣지 않는다 — 업로드 상한(25 MB)이 그 크기를 묶는다. HWP 컨테이너 읽기는 따로 200 MB 예산을
쓴다. 측정 경로는 나온 조각을 세기만 하고 보관하지 않는다.

| 렌더러 응답 | 카드 |
|---|---|
| (보내기 전) 실제 팽창 200 MB 초과·읽을 수 없는 ZIP | `spec_rejected` |
| 400 (LibreOffice가 문서를 거절) | `spec_rejected` — 손상·암호 파일일 수 있다 |
| 503·시간 초과·연결 실패·그 밖의 응답·PDF가 아닌 응답 | `generation_failed` — 잠시 뒤 다시 |
| 25 MB 초과 | `limit_exceeded` |

### 15.4 배포

`docs/ops/office-renderer.md`. 서비스 생성과 스위치 켜기는 상시 비용이 생기는
배포라 운영자 승인 뒤에 한다.

## 16. 문서에 그림 넣기 (PDF → Office)

운영자 결정: 2026-11-13. 파일을 만들 수 있는 모델(GPT 6 Luna, Claude, Gemini)은
PDF를 원본 그대로 받아 스캔 페이지까지 읽는다. 그래서 "이 PDF를 Word로"는 모델이
읽고 `create_document`로 다시 쓰는 일이고, 빠져 있던 것은 **그림**이었다.

### 16.1 image 블록

`create_document`의 블록에 `image`가 추가됐다.

| field | 뜻 |
|---|---|
| `attachment` | 이 메시지에 첨부된 이미지나 PDF의 handle |
| `page` | PDF일 때 그림이 있는 쪽(1부터). 기본 1 |
| `crop` | 그림 영역. 이미지나 페이지 왼쪽 위 기준 비율(0~1). 생략하면 전체 |
| `caption` | 그림 아래 설명 |
| `widthPercent` | 본문 폭 대비 너비(10~100). 원래 크기(96 dpi)보다 크게 그리지 않는다 |

- **모델은 픽셀을 쓰지 않는다.** handle과 비율 네 개만 낸다. 영역은 모델이 페이지를
  보고 읽어 낸 것이다(LLM 우선 원칙). 서버가 사용자의 바이트에서 그 영역을 잘라
  JPEG(긴 변 1,600px, 품질 82)로 만든다. PDF 페이지는 §14와 같은 PDFium 엔진이
  150 dpi로 그린다.
- 문서당 30개. 그림이 든 문서는 변환 결과와 같은 25 MB 상한을 쓴다(그림이 사용자의
  바이트이기 때문이다).
- docx는 `word/media/`의 JPEG와 inline drawing으로, pdf는 DCTDecode image
  object로 넣는다. md·txt에는 그림 자리를 글로 적는다(`[Image: 설명]`). 링크는
  어느 형식에도 쓰지 않는다.
- **압축파일(archive) 항목에는 쓸 수 없다.** 그 블록은 이 turn의 파일에 닿을 수
  없다.
- 없는 handle, 이미지·PDF가 아닌 파일, 없는 쪽은 §14와 같은 거절 카드가 된다.

### 16.2 비용

`create_document` schema가 커져(약 1,380자) `ARTIFACT_TOOL_DEFINITION_TOKENS`를
2,600에서 3,100으로 올렸다. 그림 자체에 별도 과금은 없다.

### 16.3 아직 하지 않는 것

- 슬라이드(`create_presentation`)와 스프레드시트에 그림 넣기.
- 원본 PDF의 레이아웃을 그대로 Word로 옮기는 일. 상용 엔진도 완벽하지 않은
  "복원"이며, 여기서는 모델이 다시 쓴다.

## 17. 선택한 생성 파일의 내용으로 새 파일 만들기 (P0)

운영자 요청(2026-11-15)에 따라 `GENERATED_ARTIFACT_REVISION_ENABLED` 미설정 시
웹 Chat의 ready 카드에서 수정 입력을 선택할 수 있다. `true`도 켜짐이며 명시적 `false`는
연결을 끈다. 잘못된 값은 켜짐으로 해석하지 않는다. 이 코드 변경은 merge·deploy나
운영 설정 변경을 수행하지 않는다.
켜짐 상태에서 수정 필드를 포함한 파일 도구를 제공하는 인증·저장 가능 turn에는 기존
`ARTIFACT_REVISION_TOOL_DEFINITION_TOKENS` 500토큰 추정 예산이 quote와 Send에 동일하게
추가된다. 이는 실제 스키마 입력의 기존 요율 과금 효과이며 가격·크레딧 정책 변경이나
별도 모델 호출은 아니다. 운영자의 기본 켜짐 지시와 이 효과를 검증 기록에 함께 남긴다.
클릭한 artifact의 opaque ID가 선택 기준이다. 파일명·현재 모델·최신 카드로
원본을 추정하지 않는다. 기존 다운로드와 Native 다운로드는 그대로 유지한다.

서버는 기존 `PUT /api/chat` import 경로에서 계정과 동일 대화, 현재 unlock,
ready 상태, 생성/첨부 형식 표의 교집합, 실제 bytes와 기존 첨부 권한·quota를
확인한다. 원본을 비파괴 bounded read로 읽고 새 private 입력 객체에 복사한 뒤
기존 opaque uploadId를 반환한다. 같은 준비 operation의 재시도는 원본이나 이미
결속된 승자 사본을 삭제하지 않는다. 파일 선택만으로 Message나 모델 호출을
만들지 않는다. 사본의 독립 수명과 미전송 보관 한계는
`user-attachment-persistence.md` §8.1을 따른다.

준비가 성공하면 원래 계정·대화의 최신 draft에 일반 첨부 chip과 짧고 편집 가능한
새 파일 생성 요청문을 앞에 추가한다. 기존 글·첨부와 준비 중 작성문을 보존하고,
동명 입력 충돌·첨부 상한·준비 실패 때 초안을 바꾸지 않는다. 선택은 자동 Send가
아니다. 사용자가 보는 문장을 그대로 저장하고 Auto와 답변 provider에 전달하며
Send 때 숨은 wrapper를 붙이지 않는다. reload는 기존 chip과 요청문으로 복원한다.

지원 범위는 TXT/MD, 기존 생성·첨부 표 모두가 허용하는 text/code/config, 한도 내
CSV와 DOCX/PPTX다. DOCX/PPTX는 기존 Office parser가 추출한 **텍스트 내용으로
새 문서를 만드는 것**이다. 원본 서식·그림·슬라이드 구조 보존 편집이 아니다.
준비 시 nonempty와 strict 추출 한도를 확인하고 Send 시 실제 남은 예산으로 다시
확인한다. 최신 사용자 turn의 일반 Office 첨부에도 strict overflow를 적용한다.
최신 text/CSV도 조용히 자른 채 실행하지 않는다.

로그인 계정의 첨부 상한은 turn당 10개·파일 50MiB·요청 합계 100MiB다(운영자 결정
2026-11-18, `lib/chatAttachmentLimits.ts`). 대화 전체 첨부가 100개를 넘으면 가장
오래된 이전 파일을 이름만 남기고 빼며, 대화를 거부하지 않는다. 요청 전체의
추출 텍스트 300,000자 상한은 없앴다(운영자 결정 2026-11-16). 과거 첨부까지 매 turn
다시 세어, 첨부가 그만큼 쌓인 대화는 새 파일이 없는 메시지까지 모두 거부됐기
때문이다. 지금 turn이 보낼 수 있는 양은 입력 토큰 한도(`CHAT_INPUT_TOKEN_LIMIT`)와
모델 context window가 정한다. 과거 메시지의 첨부는 입력 한도의 절반까지만 다시
싣고, 넘치는 과거 파일은 거부하지 않고 빠졌다는 한 줄을 모델에 남긴다
(`lib/chatAttachmentLimits.ts`). 최신 turn의 파일은 통째로 싣거나, parser 상한
(`CHAT_ATTACHMENT_PARSE_CHARACTERS`)이나 입력 토큰 한도를 넘으면 최종 답변 provider
dispatch 전에 거부한다. 생성 한도와 재입력 한도는 다르므로 모든 생성물이 재입력되거나
무제한 반복 수정된다고 약속하지 않는다. 현재 Auto는 추출보다 먼저 실행될 수 있으므로
이 거부가 Auto 비용까지 0임을 뜻하지 않는다.

실제 `create_*` 실행 결과가 새 파일 성공의 기준이다. text-only 답변은 수정 성공이
아니지만 파일 행이 없다면 가짜 failed 카드를 만들지 않는다. 원본과 새 결과의
카드·다운로드를 모두 유지하며 새 결과를 다시 선택할 수 있다. 기존 모델 capability,
`requiresFileGeneration`, 도구 제공 turn의 fallback 제한과 token/reservation/settlement를
그대로 사용하고 별도 classifier·평가 호출·가격 변경은 추가하지 않는다.

canonical spec·버전 계보·XLSX 구조 보존·Native 수정 선택의 후속 구현은 §18을 따른다.
PDF/ZIP 편집, WYSIWYG와 이미지 생성 workspace 변경은 여전히 이 흐름의 범위 밖이다.

## 18. XLSX 구조 보존, 실제 버전 계보와 Native 수정 선택 (P1)

### 18.1 검증된 WorkbookSpec과 값 수정

`GENERATED_ARTIFACT_REVISION_ENABLED`의 기본 켜짐과 명시적 off를 따른다. 꺼진 상태에서는 새
canonical 내용 보관과 수정 도구 확장을 활성화하지 않는다. XLSX를 성공적으로 만든
경우에만 기존 admission을 통과한 WorkbookSpec을 `{version: 1, kind: "spreadsheet",
spec: ...}` 형태로 저장한다. 전체 직렬화 명세는 기존 300,000자 입력 예산 안이어야
한다. 명세가 너무 큰 생성 결과는 다운로드할 수 있지만 다시 수정할 수 있다고
보장하지 않는다. 파일 생성 한도·입력 한도·업로드 quota를 늘리지 않는다.

꺼진 상태에서는 새 canonical/parent/group을 저장하지 않고 기존 app DTO의 계보 필드도
내보내지 않는다. 이미 보관한 내용과 원래 다운로드는 삭제하지 않는다. 같은 operation의
등록 완료 재시도는 새 I/O나 byte quota 예약이 없지만, 등록 전 동시 시도는 각각 실제
쓰기 bytes를 예약한다. 경합에서 진 사본을 정리해도 그 일일 upload quota를 되돌리지 않는다.

수정 선택은 원본 bytes와 명세의 독립 사용자 입력 사본을 만든다. Send에서는 실제
남은 공유 추출 예산으로 명세를 다시 검사한다. 모델은 기존 `create_spreadsheet`에
요청 범위 `revisionOf: "att_1"`과 바꿀 데이터 셀의 `cellUpdates`를 준다. 행·열은
제목/헤더를 제외한 1부터 시작하는 데이터 위치이며 정확한 sheet 이름을 사용한다.
서버는 대상·타입·범위를 검사하고 기존 명세의 해당 셀 값만 바꾼 뒤 기존 admission과
writer로 새 XLSX를 만든다. 수정하지 않은 sheet 순서·제목·열 정의·데이터 행/셀·
width·명명된 표시 형식·header style·freeze 설정을 그대로 재사용한다.

이는 기존 값 전용 생성 범위의 수정이다. 수식·매크로·차트·pivot·임의의 셀 서식이나
범용 Office round-trip 편집을 추가하지 않는다. 행/열 추가·삭제와 구조 재편은 이 작은
셀 수정 동작으로 자동 추측하지 않는다. 원본은 덮어쓰지 않는다.

이전 XLSX에는 canonical 명세가 없다. 이 경우 기존 OfficeParser와 기존 spreadsheet
grid reader를 재사용하여 지원되는 sheet·typed cell·행/열 위치를 읽는다. 원래 열 너비와
표시 layout처럼 읽을 수 없는 정보는 보존을 약속하지 않는다. 입력 사본의 `fidelity:
"values"`를 유지하고, 앱에는 안전한 `revisionMode: "workbook-values"`만 전달하여
그 한계를 보이는 수정 요청문에 넣는다. 새 canonical 사본은 `revisionMode: "workbook"`
이다. 재시도도 같은 mode를 유지한다. 지원 범위 밖 구조·불완전 추출·한도 초과는
조용히 평탄화하거나 자르지 않고 거절한다.

### 18.2 실제 source와 버전 그룹

`MessageArtifact`는 nullable `canonicalSpec`, `parentArtifactId`, `lineageId`를 가진다.
입력 upload와 attachment에는 별도의 `sourceArtifactId`, `sourceLineageId`,
`sourceConversationId`, `sourceCanonicalSpec`을 둔다. Attachment→Attachment 용도인
`sourceAttachmentId`와 혼용하지 않는다. 명세는 내부 사용자 내용이며 일반 app DTO,
공개 공유·대화 TXT·모델 도구의 권한 필드·로그에 보내지 않는다.

계보는 도구의 명시적 `revisionOf` handle을 서버가 이미 소유권·대화 범위 확인을 마친
현재 입력에 해석한 경우에만 연결한다. 파일명·최신 카드·현재 모델·같은 turn의 존재만으로
부모를 추정하지 않는다. 모델은 DB artifact ID나 lineage ID를 받지 않는다. 일반 새 파일,
text-only 답변, 미실행/거절된 도구 호출에 가짜 수정 관계를 만들지 않는다.

완료된 답변을 저장할 때 source/group을 다시 검증한다. 그 사이 source와 독립 입력
증거가 모두 사라지거나 관계를 확인할 수 없으면 답변과 새 파일은 독립 root로 저장하고
확인되지 않은 parent/group만 버린다. 외부 소유자나 다른 대화의 관계도 만들지 않는다.
DB 자체의 실패를 성공으로 숨기지는 않는다.
최종 stream 카드도 DB에서 읽은 parent/group으로 맞추며 reload와 다른 관계를 표시하지
않는다. 검증되지 않은 관계를 제외한 경우 내용·파일명·ID 없는 사유와 건수만 기록한다.

부모 FK는 `ON DELETE SET NULL`이다. source 삭제는 파생 파일이나 독립 사용자 입력을
삭제하지 않는다. 독립 명세 사본은 기존 입력 첨부와 같은 수명을 따르며, source가 없어도
자기 내용으로 재시도할 수 있다. 안정된 group 식별자는 남은 버전을 묶고, 앱은 사라진
부모를 존재하는 것처럼 표시하지 않는다. 대화/계정 삭제의 기존 cleanup 계약은 유지한다.

`GET /api/artifacts/{artifactId}/versions`는 현재 owner·대화·unlock을 검사하고 같은
사용자·대화·실제 그룹의 ready 파일을 한 번에 최대 50개씩 반환한다. 같은 이름의
다른 파일을 포함하지 않는다. cursor도 같은 범위에서 확인한다. 응답에는 기존 공개
파일 정보와 parent/group/createdAt만 있고 canonical 내용·objectKey·storage URL은 없다.
앱은 실제 부모로 이동하고 각 버전을 다운로드하거나 정확히 선택하여 다시 수정할 수 있다.

### 18.3 Native와 export

Native Chat은 서버의 `generatedFileRevisions` capability를 따라 같은 준비
API·동일 artifact ID·보이는 수정 요청문을 사용한다. 선택은 자동 Send가 아니다. 작성 중인
text·첨부, 준비 중 새 작성문과 원래 대화 scope를 보존하며 상한/동명 충돌 때 사본만 정리한다.
다른 신원으로 전환된 뒤 완료한 준비는 새 신원 초안에 반영하지 않는다. 기존 다운로드는
유지하고, Review나 이미지 workspace로 조용히 연결하지 않는다.

Native 첨부 chip은 기존 device draft의 신원·대화 key 아래 opaque upload 메타데이터로
복원한다. 기존 24시간 local draft TTL과 logout clear를 따른다. 이 TTL은 서버 upload
객체의 만료가 아니다. 사라진 local draft의 unbound 사본 보관 한계는 §17과 입력 첨부
정책을 그대로 따른다. 불명확한 Send 결과의 기존 saved-response 복구를 유지하고 자동으로
재전송하지 않는다. native bearer의 새 versions GET/unbound cleanup DELETE 경로도 같은
revision switch와 기존 Native Chat/Parity gate 아래 owner/unlock/opaque ID 검사로 제한한다.
revision 기본값 변경은 기존 Native gate를 켜지 않는다. 새 device 권한이나 자격증명은 없다.

소유자 계정 JSON export에는 새로 보관한 canonical/source 명세의 내용을 포함한다.
파일 bytes는 여전히 포함하지 않으며, 일반 앱/공유 DTO에 이 내용을 노출하지 않는다.
schema migration과 로컬 검증은 운영 migration·활성화·merge·deploy 승인과 별개다.

## 19. 미리보기 화면 공유 링크 (2026-11-28, 기본 꺼짐)

운영자 지시(2026-11-28)로 만든 기능이다. 미리보기 패널의 "공유"가 그 화면 하나만 보여 주는 공개 읽기 전용 페이지
`/share/a/<token>`을 만든다. 대화 내용은 포함하지 않는다. 대상은 생성된 HTML 파일(`html`·`htm`)과 답변의 HTML·SVG·
React(`jsx`·`tsx`) 코드 블록이고, 문서 파일은 대상이 아니다(§12).

### 19.1 스위치

- `AppSetting` `feature.artifactSharingEnabled`, 값이 정확히 `"true"`일 때만 켜짐, 행이 없으면 꺼짐. Admin › Platform
  settings의 "미리보기 화면 공유" 토글이 쓴다(`lib/artifactShareSettings.ts`). `feature.publicSharingEnabled`가 꺼져 있으면
  이것도 꺼진 것이다(`artifactSharingAvailable`, `lib/artifactShareAccess.ts`).
- 공개 페이지는 요청마다 스위치를 읽는다. 끄면 이미 만든 링크도 모두 "열 수 없음" 404가 된다. 켜는 것은 외부 공개에 대한
  운영자 승인이다(아래 19.5의 잔여 위험을 보고 결정한다).
- 스위치가 꺼져 있어도 소유자는 이미 있는 링크를 보고 중지할 수 있다(공개를 줄이는 쪽이므로).

### 19.2 무엇이 공개되는가

- **브라우저가 보낸 글은 공개되지 않는다.** 서버가 소유자의 원본에서 읽는다(`lib/artifactShareService.ts`): 파일은
  `findFirst({ id, userId, status: "ready" })` 뒤 다운로드와 같은 `readOwnR2ObjectBytes`로 미리보기 상한(행에 적힌 크기가 아님)까지
  읽고, 상한을 넘으면 자르지 않고 크기 초과(413)로, 온전한 UTF-8이 아니면 대체 문자로 바꾸지 않고 거절한다. 코드 블록은 소유자의 assistant
  메시지 본문이 그 코드를 포함할 때만(`answerContainsCode`, 줄바꿈은 LF로 맞춤). 그래서 패널에서 고친 내용(§9)은 구조상
  공유되지 않고, 패널이 공유 카드에 그렇게 적는다.
- 공유 시점의 내용을 `ArtifactShare` 행에 스냅샷으로 저장한다(migration `20261128150000_artifact_share`). 원본 답변을 고쳐도
  공유 페이지는 스냅샷을 보인다. 크기는 미리보기와 같은 1,000,000바이트(CHECK `ArtifactShare_content_size_check`).
- 출처 하나에 링크 하나(`sourceKey` unique: `artifact:<id>` 또는 `code:<messageId>:<블록 위치>:<language>:<sha256>`, 블록 위치는
  답변 안 미리보기 가능한 블록 사이의 순서 `previewableBlockIndex`). 같은 글을 HTML과 JSX로 쓴 두 블록은 다른 링크다. 블록의
  글이 바뀐 뒤 새 링크를 만들면 같은 위치의 이전 링크를 같은 트랜잭션에서 닫는다(`artifact.share.revoke`, 이유 `REPLACED`).
  그래서 패널이 보거나 멈출 수 없는 링크가 그 블록에 남지 않는다. 같은 위치에 다른 글을 동시에 공유하면 두 트랜잭션이 서로의
  아직 커밋되지 않은 행을 볼 수 없어 링크가 둘 남으므로, 만들기 트랜잭션은 맨 앞에서 위치별 advisory lock
  (`pg_advisory_xact_lock(hashtext('artifact-share:' || 블록 위치 접두어))`, 파일은 `artifact:<id>`)을 잡아 한 번에 하나씩
  만든다(검토 반영 2026-11-28, 실제 동시 트랜잭션 DB 테스트). 동시에 두 번 누른 경합(`ArtifactShare_sourceKey_key` unique
  위반)일 때만 먼저 만든 링크를 돌려주고, 다른 실패는 그대로 오류다(`isSourceKeyConflict`). 다시 누르면 같은 링크를,
  만료된 링크는 지우고 새 토큰으로 만든다. 토큰은 `lib/shareTokens.ts`(24바이트 난수), 수명은 대화 공유와 같은
  `SHARE_LINK_TTL_DAYS`(1~365, 기본 30일).
- 중지하면 행을 지운다. **만료된 행도 지운다**: 소유자 상태 조회·공개 읽기·새 공유 만들기에서 만나면 그 자리에서, 나머지는
  매일 유지보수 sweep(`cleanupExpiredData`의 `expired_artifact_shares` 단계, 500행씩 최대 20번)이. 만료된 링크는 패널에
  보이지 않아 소유자가 지울 수 없기 때문이다. 어느 경우든 같은 함수(`removeArtifactShares`)가 지우고 같은 방식으로
  `artifact.share.revoke`(이유 `OWNER_STOPPED` 또는 `EXPIRED`)를 남긴다. 계정·대화·답변 메시지·생성 파일이 지워지면 FK cascade로 함께 지워진다. 계정 내보내기에는
  `shared_pages`로 들어가고 토큰은 뺀다(공개 페이지의 열쇠다). 데이터 도메인 등록부 `artifactShare`.

### 19.3 공유할 수 없는 경우

`artifactShareRefusal`이 한 곳에서 정한다: 스위치 꺼짐(503), 요금제 `allowSharing` false(403), 원본 없음·남의 것·답변에 없는
코드·공유 대상이 아닌 형식(404), 채팅이 아닌 대화, 임시 대화, 잠긴 대화(비밀번호가 있으면 지금 풀려 있어도 거절),
가져온 대화를 이어 간 대화, 비공개 자료를 쓴 Research 답변(manifest에 URL이 아닌 항목이 있거나 현재 revision이
`containsPrivate`), 크기(413), 빈 내용(400, `ARTIFACT_SHARE_EMPTY`; 파일은 행의 기록 크기가 아니라 읽은 바이트로 판정). 게스트는 로그인이 없어 401이다. 판정이 대화 행에서 읽은 사실(잠금, 임시, 종류,
continuation bridge)은 쓰는 SQL 문 안에서 한 번 더 본다(`INSERT … SELECT … WHERE "password" IS NULL AND
"temporaryExpiresAt" IS NULL AND kind가 chat AND NOT EXISTS bridge`). 요금제와 Research는 대화 행의 사실이 아니므로 공개 읽기가
매번 다시 본다.

**공개 읽기는 만들 때의 규칙 전부를 같은 함수로 다시 본다**(2026-11-28 검토 반영). 만들 때와 읽을 때 모두
`shareRefusal`(`lib/artifactShareService.ts`) → `artifactShareRefusal`을 거치고, 사실은 링크 행에서 대화(종류·잠금·임시·
continuation bridge)·답변의 Research run·소유자 요금제를 DB로 따라가 모은다(세션·쿠키는 읽지 않음). 그래서 링크를 만든 뒤에
대화를 잠그거나, 가져온 대화의 이어가기가 되거나, Research run이 비공개 자료를 갖게 되거나(manifest 또는 현재 revision),
소유자 요금제가 공유를 빼거나, 스위치가 꺼지면 다음 요청부터 "열 수 없음" 404다. 행은 지우지 않고 닫기만 하므로(잠금과 같음)
조건이 돌아오면 만료 전까지 다시 열린다. 순서는 스위치(읽기 전) → 링크 행과 대화 사실 → 그것들이 통과할 때만 요금제(user·
plan 두 번)와 Research(run·revision 최대 두 번) 조회이고, 이 모두가 공개 읽기 rate limit 뒤에 있다.

rate limit: 만들기 분당 10·하루 100, 상태 조회 60·2,000, 중지 20·200, 공개 읽기 토큰당 120·5,000(IP 버킷 포함, 대화
공유와 같음). 만들기·중지는 `logSecurityAuditEvent("artifact.share.create" | "artifact.share.revoke")`로 남긴다.
소유자는 패널의 공유 버튼에서 링크·만료일·복사·중지를 본다(사이드바 목록은 없다, §12).

### 19.4 공개 페이지의 격리

route `app/(site)/(application)/share/a/[shareToken]/route.ts`, 문서와 헤더 `lib/artifactSharePage.ts`.

- **정적 응답이다.** 경로의 토큰과 `Accept-Language`(또는 `?lang=`)만 읽고 세션·쿠키·인증 헤더를 읽지 않는다. 같은
  페이지가 로그인한 방문자에게도 바이트 그대로 간다(server-contract 테스트가 세션 resolver·next-auth·`next/headers`를
  호출되면 실패하게 바꿔 확인).
- 구조: 우리 문서(공지 막대, 신고 링크, 처음 열 때 확인 화면, `<template>` 안의 frame 하나, 고정 script 하나 —
  `ARTIFACT_SHARE_GATE_SCRIPT`, §19.7) → `iframe sandbox="allow-scripts" srcdoc=`
  (`buildHtmlPreviewSrcdoc`의 바깥 문서, `frame-src 'none'`) → `iframe sandbox="allow-scripts" srcdoc=`(공유된 화면,
  앞에 `htmlPreviewCsp`와 WebRTC 가드, React는 `reactPreviewCsp`도). 공유된 코드는 우리 문서에 들어가지 않고 escape된 `srcdoc` 안에만
  있다. 문서는 `buildCodePreviewDocument`가 만들므로 채팅 미리보기와 같은 것이다.
- 우리 문서의 CSP(HTTP header, 항상 enforce): `sandbox allow-scripts; ` + `htmlPreviewCsp(origin)` + `; frame-ancestors 'none'`.
  `sandbox` 덕분에 **최상위 문서도 opaque origin**이라(측정: `self.origin === "null"`, `document.cookie`는 SecurityError) 이
  템플릿에 escape 실수가 있어도 앱 origin으로 script가 돌지 않는다. `srcdoc` 아래 문서는 이 정책을 상속하므로, 화면이 쓸 수
  있는 것은 미리보기 정책과의 교집합이고 그보다 넓지 않다. proxy는 이 경로에 CSP·Report-To를 붙이지 않는다
  (`isArtifactSharePagePath`; 붙이면 route의 정책을 덮는다).
- 헤더: `Cache-Control: private, no-store, max-age=0`, `CDN-Cache-Control`·`Cloudflare-CDN-Cache-Control: no-store`,
  `X-Robots-Tag: noindex, nofollow, noarchive`(대화 공유와 같음), `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, 강력한 기능을 모두 끈 `Permissions-Policy`, `Cross-Origin-Opener-Policy: unsafe-none`.
  마지막은 HTML이 sandbox flag와 `unsafe-none`이 아닌 COOP를 함께 받은 navigation을 network error로 정하기 때문이다(사이트
  전체의 `same-origin-allow-popups`를 이 경로만 바꿈; Chromium 159는 둘을 함께 받아도 열었다). next.config.ts의 경로 규칙과
  route가 같은 값을 둘 다 쓴다(`lib/artifactSharePageHeaders.ts`).
- 공지 막대("사용자가 만든 콘텐츠이며 Tomverse가 만든 것이 아닙니다. 비밀번호나 결제 정보를 입력하지 마세요")와 신고
  링크(`/support`)는 frame 밖 위에 있다. frame 안의 화면은 자기 상자 밖을 그릴 수 없으므로 가리지 못한다(흉내는 frame 안에서만).
- 거절은 모두 같은 "열 수 없음" 404 페이지다(script·frame 없음, CSP `sandbox; default-src 'none'; …`).

### 19.5 브라우저 측정과 잔여 위험

2026-11-28, Playwright Chromium 159, 실제 `buildArtifactSharePage`와 헤더를 띄운 로컬 서버에 악의적 HTML을 넣고 다른
포트의 "공격자" HTTP 서버와 UDP 소켓으로 관찰했다. 막힌 것(공격자 HTTP 요청 0건): `top.location` 대입(SecurityError),
`target=_top`·`_blank` 링크 클릭, `window.open`(null), 폼 전송, `fetch`·XHR·`sendBeacon`·WebSocket·EventSource, 외부 `<script>`·
`<img>`·stylesheet·CSS `url()`·`prefetch`, Worker, 자기 frame의 `location` 이동과 `<meta refresh>`(frame이 오류 페이지가 되고
요청은 나가지 않음 — 바깥 문서의 `frame-src 'none'`), `alert`(대화상자 없음), 다운로드, clipboard·fullscreen, 쿠키·
localStorage·부모와 최상위 DOM 접근(SecurityError). 공지 막대는 frame 위에 있고, 신고 링크는 최상위 문서를 `/support`로
옮기며 Referer를 보내지 않았다. React 공유는 앱 origin의 고정 파일을 받아 실제로 그려졌다.

남는 것:

- **WebRTC(처음 측정, 2026-11-28 오전).** `RTCPeerConnection`의 STUN/TURN 요청이 sandbox frame에서 임의의 host·port로
  나갔다. CSP `connect-src`는 WebRTC를 다루지 않고, CSP3의 `webrtc 'block'`은 Chromium 159가 적용하지 않았다. 운영자 결정으로
  §19.7의 가드를 넣은 뒤에는 공개 페이지와 채팅 미리보기 모두 측정한 모든 경로에서 UDP 패킷이 0개다. 남는 위험은 §19.7 끝에 적었다.
- 세 CDN의 script·style·글꼴은 계속 받을 수 있으므로 화면이 CDN 주소에 글을 실으면 CDN 운영자 로그에 남을 수 있다(§9와 같음).
- 별도 sandbox 도메인이 없다. 최상위 문서까지 opaque origin이라 PR #4311에서 남긴 "navigation으로 내보내기는 `frame-src`에
  의존"은 측정으로 막힘을 확인했지만, 그 한 겹이 브라우저의 `frame-src` 의미에 기댄다는 점은 같다. DNS prefetch
  (`<link rel=dns-prefetch>`)는 측정하지 않았다.
- 채팅과 달리 nonce가 없으므로 공유 페이지에서는 inline 이벤트 속성(`onclick="…"`)도 실행된다(`'unsafe-inline'`). 네트워크
  통로를 더하지는 않는다.
- 내용 moderation은 없다. 모델에게 피싱 화면을 만들게 한 뒤 공유할 수 있다. 신고 링크와 스위치가 대응 수단이다.

### 19.6 테스트

`tests/artifactShare.test.mjs`(스위치 조합, 거절 순서와 코드, 공유 가능 언어, 답변 포함 검사, 공개 페이지 CSP가 미리보기
정책과 지시문별로 같고 `sandbox`·`frame-ancestors`만 더함, frame sandbox, 공유 코드가 우리 문서에 없음, React 문서, 크기,
헤더, 확인 화면과 `<template>`, 가드가 frame 문서 맨 앞), `tests/htmlArtifactPreview.test.mjs`(`webrtc 'block'`, 가드 위치와
nonce, 가드가 잠그는 이름, `attachShadow` wrapper와 파서 잠금, `shadowrootmode` 이름 바꾸기의 경계와 그리는 순간에만 적용), `tests/robotsRoute.test.mjs`(광고 크롤러), `tests/integration/artifact-share.db.test.ts`(migration
스키마: 생성·재사용·만료·중지·남의 것 거절·잠금 경합·cascade·계정 삭제와 내보내기·CHECK·같은 블록 동시 공유가 링크 하나를 남김·선언형 shadow root가 든 스냅샷이 원문 그대로),
`tests/server-contract/artifact-share-page-route.test.ts`(세션 미사용, 헤더, 같은 404, proxy 예외, 확인 화면이 먼저).

### 19.7 스크립트를 허용하고 보강한다 (운영자 결정 2026-11-28)

공유 페이지는 스크립트를 허용하는 방식을 유지하고 네 가지를 더한다. 참고: 타 플랫폼 중 WebRTC를 실제로 막는 곳은 없었고
(Claude만 CSP에 `webrtc 'block'`을 선언), 실제 악용은 광고 크롤러를 통해 공유 페이지로 사람을 보내 다운로드나 명령 실행을
유도한 것이었다.

1. **CSP `webrtc 'block'`.** `htmlPreviewCsp`에 넣어 공개 페이지의 응답 CSP와 모든 frame 문서의 meta CSP(채팅 미리보기
   포함)에 들어간다. Chromium 159는 "Unrecognized Content-Security-Policy directive 'webrtc'"라고 무시하고 나머지 지시문은
   계속 집행한다(측정: 같은 정책 아래 fetch·XHR·beacon은 `connect-src 'none'`, 이미지는 `img-src`, Worker는 `worker-src`로
   막혀 공격자 HTTP 요청 0건). 브라우저가 구현하는 날부터 적용된다.
2. **WebRTC 가드**(`HTML_PREVIEW_GUARD_SCRIPT`, `lib/htmlArtifactPreview.ts`). frame 문서의 CSP meta 바로 뒤, page보다 먼저
   돈다. 하는 일:
   - `HTML_PREVIEW_WEBRTC_GLOBALS`와 이름이 RTC·webkitRTC·mozRTC로 시작하는 모든 전역을 window에서 쓰기·재정의·삭제가
     안 되는 `undefined`로 고정한다.
   - `navigator.mediaDevices`와 옛 `getUserMedia` 이름도 Navigator 프로토타입과 인스턴스에서 같은 방식으로 고정한다.
   - 새 realm으로 가는 중첩 frame(`iframe,frame,frameset,object,embed,portal,fencedframe`)은 넣는 즉시 mutation observer가
     지운다. observer는 page가 실행되기 전에 잡아 둔 함수만 쓰므로, page가 나중에 프로토타입을 바꿔도 무력화되지 않는다.
   - `contentWindow`·`contentDocument`는 `undefined`로 고정한다.
   - 다른 realm으로 가는 길은 이미 막혀 있다: popup은 sandbox, Worker는 `worker-src 'none'`, 다른 문서로의 이동(data:·blob:)은
     바깥 문서의 `frame-src 'none'`이 막는다.
   - 채팅 미리보기에도 같은 함수로 들어간다. 앱 CSP가 nonce 기반이라 가드는 앱 문서의 nonce를 단다.
3. **광고 크롤러 차단.** `AdsBot-Google`·`AdsBot-Google-Mobile`·`adidxbot`은 `*` 그룹을 읽지 않으므로 이름을 단 그룹을 둔다
   (`AD_LANDING_CRAWLERS`, `app/robots.ts`). 그룹은 `*`와 같은 비공개 경로를 받고, 거기에 `/share`가 있어 대화 공유(`/share/<token>`)와
   공개 페이지(`/share/a/<token>`)가 모두 막힌다. 공개 페이지(`/`, `/pricing` 등)는 열려 있어 사이트의 광고는 그대로 랜딩한다.
   정식 도메인이 아닌 배포(staging)는 기존대로 `*` 한 그룹만 둔다(광고 대상이 아님).
4. **처음 열 때 확인 화면.** 공개 페이지는 frame을 바로 그리지 않고 "다른 사람이 만든 화면입니다. Tomverse가 만들거나 확인한 것이
   아닙니다. 비밀번호·결제 정보·인증 코드를 입력하지 마세요"와 "화면 보기" 버튼을 보인다(8개 언어,
   `locales/artifactWorkspace.ts` `page.gateNotice`·`gateOpen`). frame은 `<template>` 안에 있어 렌더·로드되지 않는다.
   버튼을 누르면 같은 응답 안의 고정 script(`ARTIFACT_SHARE_GATE_SCRIPT`)가 frame을 페이지로 옮긴다. 확인 기록은 남기지 않고
   매번 보이며, 응답은 여전히 세션을 읽지 않는 정적 응답이다. 상단 공지 막대와 신고 링크는 그대로다.

**측정**(2026-11-28 오후, Playwright Chromium 159.0.8154.6). 우회 시도마다 다른 UDP 포트로 STUN을 보내게 해, 패킷이 어느
시도에서 나왔는지 구분했다.

| 시도 | 결과 | UDP 패킷 |
|---|---|---|
| 대조군: 가드 없는 sandbox frame, 같은 CSP(`webrtc 'block'` 포함) | STUN 전송 | 4 |
| `new RTCPeerConnection` | TypeError | 0 |
| `window["RTCPeer"+"Connection"]` | TypeError | 0 |
| `webkitRTCPeerConnection` | TypeError | 0 |
| `Reflect.construct(window.RTCPeerConnection, …)` | TypeError | 0 |
| `Object.getPrototypeOf`로 window 프로토타입 사슬 탐색 | 없음 | 0 |
| `delete` 후 `Object.defineProperty`로 재정의 | TypeError, 여전히 undefined | 0 |
| `document.createElement("iframe")` 후 바로 `contentWindow` | `undefined` | 0 |
| 같은 iframe을 `window[n]`으로 | SecurityError | 0 |
| 정적 `<iframe srcdoc>`, 동적 srcdoc, `innerHTML` iframe, `javascript:` URL iframe, `<object data=data:…>` | 삽입 즉시 제거(남은 frame 0) | 0 |
| iframe `onload` 뒤 `contentWindow` | TypeError | 0 |
| `document.open()`/`write()`로 문서 교체 | 같은 window, 가드 유지 | 0 |
| `location`을 data:·blob: URL로 | frame이 오류 페이지(`frame-src 'none'`) | 0 |
| `window.open` | null(sandbox) | 0 |
| blob Worker | `worker-src` 위반으로 생성 거부 | 0 |

- 같은 실행에서 공격자 HTTP 요청은 0건이었다.
- 확인 화면: 버튼을 누르기 전에는 frame 0개, UDP 0개. 누른 뒤에는 정상 HTML(inline script)·SVG·React 공유가 모두 그려졌다.
- 채팅 미리보기(Next dev 서버, `CSP_MODE=enforce`): 가드가 nonce를 달고 실행됐고(`typeof RTCPeerConnection === "undefined"`),
  정상 HTML이 그려졌으며 STUN 시도의 UDP 패킷은 0개였다.

**그림자 DOM 보강**(검토 반영 2026-11-28). observer는 document의 tree만 보는데 shadow root는 그 tree에 속하지 않아, shadow root
안에 넣은 frame은 지워지지 않고 새 realm에서 STUN을 보냈다(보강 전 측정: 16개 경로에서 패킷). 다음을 더했다.
- `Element.prototype.attachShadow`를 바꿀 수 없는(non-configurable) wrapper로 바꾼다. 새 root(open·closed, 중첩, custom element
  생성자 안)마다 observer가 그 root를 보게 하고, 이미 들어 있는 frame을 지운다.
- `attachShadow`를 거치지 않고 shadow root를 만드는 파서를 `undefined`로 고정한다: `Element`·`ShadowRoot`의 `setHTMLUnsafe`·
  `setHTML`, `Document.parseHTMLUnsafe`·`parseHTML`, `document.write`·`writeln`(write의 파서도 선언형 shadow root를 만든다 —
  측정. 속성 이름을 두 번의 write로 나눠 넣는 것도 막힌다).
- `MediaDevices.prototype`의 `getUserMedia`·`getDisplayMedia`·`enumerateDevices` 등도 같은 방식으로 고정한다.
- page 자신의 markup은 어떤 script보다 먼저 파싱되므로, frame을 만들 때 `shadowrootmode`(옛 이름 `shadowroot`) 속성 이름을
  `data-tomverse-…`로 바꾼다(`neutralizeDeclarativeShadowRoots`). HTML tokenizer가 속성 이름으로 읽는 자리(공백·`/`·따옴표
  바로 뒤에서 시작해 공백·`/`·`>`·`=`에서 끝남, 대소문자 무시)만 바꾸고, `host.shadowRoot`나 `data-shadowrootmode` 같은 더 긴
  이름은 그대로 둔다. 저장된 스냅샷과 공개 읽기 응답은 원문 그대로이고(DB 테스트), 그리는 순간에만 바뀐다.

**부모가 model HTML을 고치지 않는다는 원칙의 두 번째 예외.** 부모는 model HTML을 해석하거나 다시 쓰지 않는다. 예외는 둘이다:
채팅에서 앱 nonce를 다는 `withEmbedderNonce`(브라우저 파서 사용)와 이 속성 이름 바꾸기다. 해석하지 않는 다른 방법을 먼저
찾았으나 없었다: 파서는 `attachShadow`를 부르지 않고 선언형 root를 붙이고, closed root는 script로 닿을 수 없으며, 선언형 shadow
DOM을 끄는 CSP·Document-Policy 지시문이 없다(Chromium 159). 문자열 치환이라 본문 산문에 따로 선 `shadowrootmode` 낱말도
바뀐다. **동작 변화:** 선언형 shadow DOM을 쓰는 page는 그 template 내용이 그려지지 않는다(inert template). `attachShadow`로 만드는
web component는 그대로 그려진다.

| 시도 (Chromium 159.0.8154.6, 시도마다 다른 UDP 포트) | 대조군(가드·이름 바꾸기 없음) | 가드 |
|---|---|---|
| `attachShadow` open·closed 후 `innerHTML`, closed root에 `appendChild`, 문서에 넣기 전 root에 넣기 | 각 4 | 0 |
| 중첩 shadow root, custom element 생성자 안의 closed root | 각 4 | 0 |
| `Element.setHTMLUnsafe`·`ShadowRoot.setHTMLUnsafe`·`Document.parseHTMLUnsafe`로 선언형 root | 각 4 | 0 |
| page markup의 `<template shadowrootmode>` open·closed, 따옴표 바로 뒤, `/`와 대문자 | 각 4 | 0 |
| page markup의 옛 이름 `shadowroot` | 0(Chromium 159는 옛 이름을 지원하지 않음) | 0 |
| `document.write`로 선언형 root, 속성 이름을 두 번의 write로 나눔 | 각 4 | 0 |
| `DOMParser`·`createContextualFragment`·`innerHTML`로 선언형 root | 0(이 파서들은 root를 만들지 않음, 측정) | 0 |
| `insertAdjacentHTML`·`outerHTML`·`createContextualFragment`·`DOMParser` 후 `adoptNode`·template `importNode`·template을 closed root에 복제 | 각 4 | 0 |
| 새 frame의 window를 같은 task 안에서 `window[0]`·`frames[0]`로(`iceCandidatePoolSize` 포함, observer 재삽입 반복) | 0(SecurityError, 자식 frame은 다른 opaque origin) | 0 |
| `MediaDevices.prototype.getUserMedia` | 0 | 0(`undefined`) |

정상 내용: `attachShadow`를 쓰는 web component는 그대로 그려졌다(`component-ok`). 선언형 shadow DOM page는 template 내용이
보이지 않았다(위 동작 변화).

**남는 위험.**
- 브라우저가 `webrtc 'block'`을 집행하지 않는 동안은 2번 가드가 WebRTC를 막는 유일한 수단이다.
- 가드는 같은 realm 안의 JavaScript 방어라서, 측정하지 않은 새 realm 경로(브라우저에 새로 생기는 frame 종류, 아직 없는 API)가
  생기면 뚫릴 수 있다. 그래서 전역 이름은 RTC 접두어로 넓게 잠그고, frame은 종류를 나열해 지우며, shadow root를 만드는 길은 `attachShadow` 하나만 남긴다.
- DNS prefetch(`<link rel=dns-prefetch>`)와 CDN 로그 경로는 §19.5 그대로다.
