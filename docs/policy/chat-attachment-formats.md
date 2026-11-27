# 채팅 첨부 형식과 압축파일 정책

승인일: 2026-08-22. 이 문서는 **채팅 입력으로 받는 파일**의 단일 기준이다.
어떤 형식을 받는지, 무엇으로 그것을 증명하는지, 압축파일을 어디까지 여는지,
거절을 어떤 코드로 말하는지를 여기서 정한다. 형식 표의 출처는
`lib/chatAttachmentFormats.ts`이고, 압축 한도의 출처는
`lib/chatArchiveLimits.ts`이며, 판정은 `lib/chatAttachmentValidation.ts`와
`lib/chatArchivePlan.ts`가 소유한다.

**이 문서는 출력 형식 정책이 아니다.** `docs/policy/generated-artifacts.md`는
이 앱이 *만들어 내는* 파일을 정하고, 이 문서는 이 앱이 *읽는* 파일을 정한다.
두 표는 모양만 닮았고 공유하지 않는다 — 만들 수 있다는 사실은 업로드를
허용할 근거가 아니다. 외부 대화 가져오기
(`docs/policy/external-conversation-import-and-memory.md`), Assistant
Knowledge, 이미지 생성(`docs/policy/image-generation.md`)도 각각 별개
capability이며 이 표가 넓어져도 함께 넓어지지 않는다.

## 1. 문제

ZIP 첨부는 "지원하지 않는 파일 형식입니다."로 끝났다. 원인은 두 겹이었다.

1. 허용 목록이 네 곳(composer의 `accept`, composer의 자체 검사, 채팅 API의
   `ALLOWED_ATTACHMENT_TYPES`, 게스트 정책)에 각각 적혀 있었고, 손으로만
   맞춰져 있었다. 이미 어긋난 곳이 하나 있었다 — 확장자→MIME 보정이 Office
   6종에만 있었으므로, 브라우저가 MIME을 비워 보낸 `.txt`·`.md`·`.csv`·
   `.json`은 **서버가 보기도 전에** 클라이언트가 거절했다.
2. ZIP은 목록에 넣는다고 읽히지 않는다. 압축 해제·내부 파일 검증·텍스트 추출
   경로가 없었다.

그래서 규칙은 하나다.

> 목록에 있다는 것은 **실제로 읽을 수 있다**는 뜻이다. 읽지 못하는 형식은
> UI에서 지원한다고 표시하지 않는다.

## 2. 형식은 표 하나다

`lib/chatAttachmentFormats.ts`의 `CHAT_ATTACHMENT_FORMATS`가 유일한 출처이며,
다음이 전부 여기서 파생된다.

- 파일 선택기의 `accept`
- 클라이언트의 확장자 → canonical MIME 정규화
- 업로드 준비(PUT)와 finalize(PATCH)의 허용 목록
- 메시지 처리 분기(image / pdf / office / text / archive)
- 게스트 부분집합(`guestAllowed`)
- 사용자에게 보여주는 지원 형식 안내

한 행이 가진 것: 확장자·특수 파일명, canonical MIME, 허용 MIME 별칭, 분류,
파서, magic-byte 검사 방식, 압축파일 내부 허용 여부, 게스트 허용 여부, 모델
이미지 입력 필요 여부, UI 표시 그룹, 프롬프트 머리말.

**순수 모듈이다.** `server-only`도 Node builtin도 Prisma도 없다. 브라우저가
서버와 같은 표를 읽지 못하면 목록이 넷으로 갈라진 그 상태로 되돌아간다.

### 2.1 형식 결정은 이름이 하고 MIME은 힌트다

`resolveChatAttachmentFormat()` 한 곳이 판정한다.

- 확장자가 알려진 형식이면 그것이 답이다.
- 선언된 MIME이 빈 문자열·`application/octet-stream`·`*/*`처럼 정보가 없으면
  무시한다. **이것이 위 1번 회귀의 수정이다.**
- 선언된 MIME이 canonical이거나 등록된 별칭이면 통과한다.
- 텍스트 계열은 브라우저의 일반적 추측인 `text/plain`도 통과한다.
- 이름과 MIME이 **각각 다른 지원 형식**을 가리키면 거절한다. 어느 쪽으로도
  해석하지 않는다 — 확장자를 믿으면 이름만 바꿔 파서에 도달하고, MIME을 믿으면
  파일의 실제 모습을 사용자에게서 숨긴다.
- **확장자가 없으면 거절한다.** `report`가 `application/pdf`라고 주장해도
  받지 않는다. 확장자는 업로드에서 사람이 볼 수 있는 유일한 형식 표시다.

### 2.1.1 연결 프로그램이 답하는 MIME

Windows는 `File.type`을 registry의 `HKCR\<확장자>\Content Type`에서 냅니다.
그 값은 **무엇이 이 파일을 여는가**이지 **이것이 무엇인가**가 아닙니다. Word가
깔려 있으면 모든 `.rtf`가 `application/msword`로, Excel이 깔려 있으면 모든
`.csv`·`.tsv`가 `application/vnd.ms-excel`로 도착합니다. 둘 다 데스크톱에
대해서는 참이고 바이트에 대해서는 거짓입니다.

별칭이 없으면 §2.1의 마지막 규칙이 이것을 "이름과 MIME이 다른 형식을 가리킴"
으로 읽고 **클라이언트에서, 서버가 바이트를 보기 전에** 거절합니다. 이 registry가
없애려던 실패와 같은 모양이 반대쪽에서 온 것입니다 — 이번엔 MIME이 비어서가
아니라 확신을 갖고 틀려서입니다.

대상 쌍은 `lib/chatAttachmentFormats.ts`의 `ASSOCIATION_OWNER_MEDIA_TYPES`에
표로 있고, 각 쌍은 소유 형식의 `mediaTypeAliases`에 들어 있으며
`tests/chatAttachmentFormats.test.mjs`가 그 표를 순회합니다.

**이 별칭은 §2.1의 불일치 규칙을 넓히지 않습니다.** 이름이 여전히 정하므로
`.doc`은 `doc`으로, `.xls`는 `xls`로 그대로 해석되고, `.txt`가
`application/msword`라고 주장하는 것은 계속 거절입니다.

2026-08-23 staging 회차에서 실제 Windows 파일 선택기로 견본을 올리다 발견했습니다.
그 항목(§E)이 존재하는 이유가 정확히 이것이고, 자기 구획의 첫 유료 turn을 쓰기도
전에 값을 했습니다.

### 2.2 추가한 형식

압축: `zip`. 이미지: `gif`(정지 이미지만). 데이터: `tsv`, `jsonl`/`ndjson`,
`yaml`/`yml`, `toml`, `ini`/`conf`, `ics`, `vcf`. 마크업·텍스트: `html`/`htm`,
`xml`, `rst`, `srt`, `vtt`. 소스코드: `py`, `js`/`mjs`/`cjs`, `jsx`, `ts`,
`tsx`, `java`, `c`/`h`, `cpp`/`hpp`/`cc`/`cxx`, `cs`, `go`, `rs`, `rb`, `php`,
`kt`/`kts`, `swift`, `scala`, `r`, `sql`, `sh`/`bash`, `ps1`, `css`, `scss`,
`less`, `vue`, `svelte`, `graphql`/`gql`, `proto`. 확장자 없는 이름:
`Dockerfile`, `Makefile`, `.gitignore`, `.gitattributes`, `.dockerignore`,
`.editorconfig`. Office 97-2003과 RTF: `doc`, `xls`, `ppt`, `rtf`(§4).

기존 형식(png·jpg·webp·pdf·docx·xlsx·pptx·odt·ods·odp·txt·md·csv·json)은
전부 그대로다.

### 2.3 거절 기준은 "열면 실행되는가"다

`REFUSED_ATTACHMENT_EXTENSIONS`는 두 집합의 합이다.

- `OTHER_ARCHIVE_EXTENSIONS` — ZIP 외의 모든 컨테이너. 지원하는 컨테이너 모양은
  하나이고, 이름을 바꿔서 늘리지 않는다.
- `EXECUTABLE_ATTACHMENT_EXTENSIONS` — 프로그램·설치 파일·라이브러리, 그리고
  운영체제가 열자마자 실행하는 형식.

그래서 `.sh`·`.ps1`·`.py`는 **지원**하고 `.exe`·`.msi`·`.bat`은 거절한다. 셸
스크립트는 이 앱에서 텍스트로만 읽히지만 배치 파일은 읽는 사람의 기계에서
더블클릭 한 번 거리에 있다. **어떤 소스코드도 실행·컴파일·동적 import 하지
않는다.**

### 2.4 이 범위에서 뺀 것과 근거

- **RAR·7Z·TAR·GZ 등** — 별개 해제 파이프라인이 필요하다.
- **오디오는 스위치 뒤에서 받는다(§2.4.1). 비디오, HEIC/HEIF·TIFF·BMP, Keynote, PSD/AI는** —
  별개 제품 결정이다. Keynote는 따로 근거가 있다: 확장자 `.key`가 개인 키
  파일의 확장자이기도 해서 거절 목록(§2.3)에 있다. 허용하면 PEM 키가 업로드되어
  저장된 뒤에야 package 검사가 거절하게 되므로, 바꾸는 일은 자격증명 보호에 대한
  결정이다.
- **코드 실행(공급자가 호스팅하는 sandbox 도구)은 넣지 않았다**(운영자 결정 2026-11-27).
  Gemini는 한 요청 안의 실행 횟수 상한을 주지 않고(오류 뒤 재생성 "최대 5회"만 적으며
  `codeExecution` 도구에는 횟수를 묶을 field가 없다) 실행 결과의 크기 상한도 적지 않아서,
  요청 전에 최악 비용을 예약한다는 계약(`docs/policy/credit-and-cost-limits.md`)을 지킬 수
  없다. 2026-11-27에 https://ai.google.dev/gemini-api/docs/code-execution (지금은
  https://aistudio.google.com/docs/code-execution) 에서 확인했다.

#### 2.4.1 오디오 첨부 (운영자 지시 2026-11-27)

`CHAT_AUDIO_ATTACHMENT_ENABLED="true"`일 때만 받는다. 회의 녹음 요약 같은 용도다.

- **형식은 별도 표다**(`CHAT_AUDIO_ATTACHMENT_FORMATS`): `mp3`, `wav`. 위 표에 행으로
  넣지 않으므로 스위치가 꺼져 있으면 `accept`, 업로드
  허용 목록, 게스트 부분집합, 형식 안내가 바이트 단위로 그대로다. 서버가 스위치를
  풀고 composer에는 boolean 하나로 넘긴다(`ChatAudioAttachmentProvider`).
- **길이는 오디오에서 계산한다**(`lib/chatAudioAttachmentCore.ts`). mp3는 프레임을
  파일 끝까지 걸어 더한다. 마지막 프레임 뒤에 남는 바이트에는 프레임 sync(0xFF 다음
  상위 3비트가 1인 byte)가 없어야 한다. sync가 없는 꼬리(ID3v1, 텍스트 APE 태그, 0
  padding)는 어떤 디코더도 재생하지 못하고, sync가 있으면 디코더가 재동기화해 뒤의
  녹음을 재생할 수 있으므로 거절한다 — 짧은 프레임 뒤에 무효 바이트와 긴 녹음을 넣은
  파일이 앞 프레임 길이로 예약되던 문제다(독립 검토 r-20261127-073816-5a1bf4). 잘린
  마지막 프레임은 헤더 뒤에 sync가 없을 때만 한 프레임으로 센다. WAV는 `data` 뒤 PCM
  바이트 전부를 format chunk의 재생 속도로
  나눈다(`blockAlign`·`byteRate`가 서로 맞지 않거나 압축 형식이면 거절). 헤더가 적은
  길이·bitrate·data 크기는 파일 스스로의 주장이라 쓰지 않는다 — 짧게 적힌 헤더는 긴
  녹음을 10분 한도와 초 예산 밑으로 통과시키고, 공급자는 디코딩한 만큼 전부 청구한다
  (독립 검토 2026-11-27). **길이를 계산하지 못한 파일은 거절한다** — 음성 입력은 모르는
  길이를 클립 상한 120초로 예약하지만 첨부에는 그런 상한이 없다.
- **그래서 `m4a`·`webm`·`ogg`는 아직 제공하지 않는다.** 공급자는 받지만 길이를
  헤더(`mvhd`, `Info > Duration`, granule)로만 말한다. 회의 녹음에 흔한 `m4a`는 MP4
  sample table(`stsz` 개수 × AAC 프레임 길이 / 샘플 속도)을 세는 판독기가 생기면 연다.
  음성 입력도 같은 헤더를 읽지만 그쪽은 8 MB 클립 상한이 노출을 묶는다.
- **한도**: 파일 25 MB(공급자 상한, 2026-11-27 speech-to-text 안내 확인), 길이
  10분. 설정된 전사 모델의 출력 상한이 2,000 token이고(모델 페이지 2026-11-27
  확인) 기록된 유일한 유료 측정이 분당 190.6 token이므로, 보통 발화는 10분 근처에서
  그 상한에 닿는다. 출력 상한을 거의 다 쓴 전사는 "끝이 잘렸을 수 있음"으로 표시해
  모델에 준다. 긴 녹음을 나눠 전사하려면 오디오 디코딩이 필요해 이번 범위가 아니다.
- **비용은 사용자 크레딧이 아니다.** 음성 입력과 같은 공급자·모델·초 예산을 쓰고,
  음성 입력의 가격 결정(무료, 운영 guardrail만)을 따른다
  (`docs/policy/voice-input.md` §6.1). 주체의 하루 초 예산과 배포 전체 provider 초
  예산을 함께 예약하고, 정산은 음성 route와 같다(provider 초 → 잰 길이 → 결과 불명이면
  예약 유지). OCR도 사용자 크레딧을 쓰지 않는 백엔드 변환이다. 설정된 전사 모델에
  관측된 가격이 없으면 스위치가 켜져도 제공하지 않는다(§6.1.4와 같은 조건).
- **전사는 한 녹음에 한 번이다**(독립 검토 r-20261127-082100-427572, r-20261127-110354-67c5f8).
  녹음의 열쇠는 메시지에 결속된 첨부 행이다(`objectKey`가 유일해 행 하나가 녹음 하나다).
  요청이 첨부 id로 부르든 업로드 id로 부르든 같은 행을 찾고(`resolveRecordingAttachmentId`:
  같은 계정, 같은 저장 객체), 그 행에 claim 행(`MessageAttachmentTextCache`의 `version` 0,
  캐시로는 읽히지 않는다)을 한 문장으로 먼저 잡은 요청만 초 예산을 예약하고 전사해
  전사문을 저장한다. 나머지 요청(다른 모델의 답, 재시도)은 0.5초마다 다시 보고 저장된
  전사문을 읽는다. 전사문 저장과 claim은 `CHAT_ATTACHMENT_TEXT_CACHE`와 무관하다 —
  추출 캐시가 아니라 돈을 낸 결과라서다. 아무 메시지에도 결속되지 않은 업로드는 행이
  없으므로 전사하지 않고 `AUDIO_TRANSCRIPTION_UNAVAILABLE`(409)로 거절한다(composer는
  메시지를 먼저 저장하므로 보통 경로에서는 생기지 않는다). claim은 연장되지 않고
  150초가 지나면 다음 요청이 넘겨받는데, 전사 호출에는 응답 본문까지 포함한 120초 hard
  deadline이 있어 claim이 살아 있는 동안 끝난다(`transcribeWithOpenAi`, 상수 관계는 테스트로
  고정). **claim을 쥔 요청만 유료 호출을 한다**(독립 검토 r-20261127-114544-4444fa): claim을
  쓸 수 없거나(DB 오류) 기다리다 시간이 다 되면 전사하지 않고 재시도할 수 있는
  `AUDIO_TRANSCRIPTION_UNAVAILABLE`(503)로 끝난다 — 이번 메시지면 turn이 그 오류로 답하고,
  이전 메시지면 첨부를 뺀다. 돈을 낸 결과는 claim 위에 저장한다(실패하면 한 번 더). 그래도
  저장하지 못하면 전사문은 이번 turn에 쓰되 claim을 돌려주지 않고 만료될 때까지 두며
  `transcript_store_failed` 로그를 한 줄 남긴다. 그래서 만료 전에는 다른 요청이 다시 돈을 내지
  않는다. **남는 경우**: 저장이 계속 실패하면 claim이 만료된 뒤 다음 요청이 한 번 더 전사한다
  (만료 창마다 최대 한 번). 말소리가 없다는 결과도 저장한다(같은 행, `entries`가
  `{"outcome":"no_text"}`) — 다음 turn이 같은 녹음을 다시 전사하지 않고 `ATTACHMENT_NO_TEXT`로
  답하며, 다른 reader에게는 캐시 미스로 보이고 claim도 이 행을 넘겨받지 않는다. 돈을 내지 않은
  실패(예산 거절, 공급자 거절·장애)는 claim을 돌려주고, 기다리던 요청이 하나씩 차례로 다시
  시도한다. migration은 필요 없다. 전사문과 claim은 첨부 행에서
  cascade로 지워지므로 대화·계정 삭제 규칙이 그대로 적용된다
  (`docs/policy/user-attachment-persistence.md §7.1`). 원본 녹음도 다른 첨부와 같은
  보존 규칙을 따른다.
- **게스트와 압축파일 안의 오디오는 받지 않는다.** 게스트 객체에는 캐시할 행이
  없어 매 turn 다시 전사하게 되고, 압축파일 안의 녹음은 사용자가 열거하지 않은 유료
  호출이다.
- **스위치를 끈 뒤**: 이번 메시지의 녹음은 지원하지 않는 형식으로 거절한다. 이전
  메시지의 녹음은 저장된 전사문이 있으면 쓰고(오디오 스위치와
  `CHAT_ATTACHMENT_TEXT_CACHE` 어느 쪽이 꺼져 있어도 읽는다 — 이미 돈을 낸 결과다), 없으면
  새로 전사하지 않고 "포함되지 않은 이전 첨부"로 알리고 뺀다. 이전 메시지의 전사 실패도 turn을 실패시키지 않는다. 예외는 다른 첨부와
  같다: 저장소 오류, 재시도할 수 있는 DB 오류, 요청 취소는 turn을 멈춘다(그때 초 예산 장부
  쓰기의 결과는 아직 모르므로 삼키지 않는다).
- 오류 코드: `ATTACHMENT_AUDIO_TOO_LONG`, `AUDIO_TRANSCRIPTION_UNAVAILABLE`,
  `AUDIO_TRANSCRIPTION_LIMIT_REACHED`. 말소리가 없으면 `ATTACHMENT_NO_TEXT`.
- **비디오는 받지 않는다.** 할 수 있는 길은 둘이다: 서버에서 오디오 트랙만 뽑아 위
  경로로 전사하거나(ffmpeg 같은 디코더와 그 sandbox가 필요), 비디오 입력을 받는
  모델(Gemini)에 파일로 넘기는 것(모델별 지원·토큰 가격·크기 상한 확인이 필요).
  어느 쪽이든 길이를 먼저 읽는 판독기가 있어야 예약이 정직하다.

### 2.5 Apple iWork: Pages와 Numbers

운영자 결정: 2026-11-13. `.pages`(`application/vnd.apple.pages`)와
`.numbers`(`application/vnd.apple.numbers`)를 받는다. 목적은 **PDF로 바꾸는
것 하나**다 — 렌더러 서비스(`docs/policy/generated-artifacts.md §15`)가
LibreOffice로 레이아웃을 잡는다.

- **읽지 않는다.** 이 앱에는 Apple의 레코드를 읽는 파서가 없다. 모델에게는 파일이
  첨부됐고 내용은 읽을 수 없으며 `convert_files`로 PDF로 만들 수 있다는 한 줄만
  간다.
- **검사는 package의 모양과 실제 크기다**(`lib/iworkPackage.ts`): 유효한 ZIP,
  항목 5,000개 이하, package 밖을 가리키는 경로 없음, iWork 색인 part
  (`Index/Document.iwa` 등) 존재, **실제로 풀었을 때** 200 MB 이하. ZIP이 적어 둔
  크기는 파일 스스로의 주장이라 믿지 않는다 — 모든 항목을 입력 4 KB씩
  풀어(`lib/boundedInflate.ts`) 나온 바이트를 세고 버리며, 넘으면 그 자리에서
  멈추고 거절한다(독립 검토 2026-11-13).
- **ZIP은 중앙 디렉터리로 읽고, 로컬 헤더와 어긋나면 거절한다**(`lib/boundedInflate.ts`).
  읽는 쪽마다 믿는 곳이 달라서(스트리밍 리더는 로컬 헤더, LibreOffice는 중앙
  디렉터리), 둘이 다른 말을 하는 package는 잰 것과 열리는 것이 다를 수 있다.
  항목마다 방식·크기·이름이 두 곳에서 같아야 하고, 디렉터리에 없는 로컬 항목·
  겹치는 항목·적힌 크기와 다르게 풀리는 항목·암호화·stored/DEFLATE 밖의 방식·
  ZIP64는 거절한다(독립 검토 2026-11-13, 6차). 앞에 다른 바이트가 붙은 ZIP(자기
  압축 해제 파일 등)과 항목 사이 빈 곳에 로컬 헤더 서명이 있는 ZIP도 거절한다 —
  LibreOffice는 열 수 있지만, 사무 문서에서는 드물어 일부러 감수하는 호환성 손실이다.
- `.iwa` 틀([0x00][3바이트 길이][Snappy 블록])은 공개 분석 자료를 따른 것이고 아직 실제
  Pages·Numbers 파일로 확인하지 않았다. 틀이 다르면 Snappy 상한을 덜 세지만, 항목 자체를
  ZIP에서 풀어 나온 바이트는 그대로 센다.
- **안에 다시 압축된 것도 같은 합계로 잰다**(`lib/packageExpansion.ts`): 항목 안의
  ZIP(`Index.zip` 등, 깊이 3까지)은 같은 방식으로 걷고, gzip(`index.xml.gz`)은
  조금씩 풀어 세며, 최신 iWork의 Snappy 압축 `.iwa` 레코드는 블록 머리에 적힌
  해제 후 길이를 더한다 — Snappy 해제기는 그 길이를 넘겨 쓰지 않으므로 그 값이
  상한이다. 크기 때문에 거절된 파일은 형식 오류가 아니라 `ATTACHMENT_TOO_LARGE`
  (파일 크기 오류)로 알린다.
- 렌더러가 꺼진 뒤 보낸 turn에서는 모델에게 "지금은 PDF로 바꿀 수 없다, Pages·
  Numbers에서 Word·Excel·PDF로 내보내기를 권하라"고 알린다.
- **렌더러가 꺼져 있으면 업로드 준비 단계에서 거절한다.** 쓸 수 없는 파일을
  저장해 두었다가 보낼 때 알게 하지 않는다.
- 게스트와 압축파일 내부 항목은 받지 않는다(렌더러 turn이 없고, 읽지 못하는 항목은
  이름조차 모델에게 전할 수 없다).
- 형식 표에 Apple 기기가 보고하는 MIME을 넣었으므로 iPhone·iPad의 파일 선택 창에서
  iCloud Drive의 Pages·Numbers 파일을 고를 수 있다. iCloud Drive를 서버에서 여는
  연동은 Apple이 공개 API를 제공하지 않아 만들지 않는다.

## 3. 업로드 검증은 실제 바이트를 본다

`validateChatAttachmentUpload()`(`lib/chatAttachmentValidation.ts`)가 게스트
업로드와 로그인 finalize 양쪽에서 같은 판정을 한다. 이전에는 로그인 경로가
R2 **메타데이터**(크기와 브라우저가 요청한 Content-Type)만 확인했고, 실제
바이트를 처음 보는 시점은 사용자가 전송을 누른 몇 분 뒤였다.

| 분류 | finalize에서 하는 일 |
|---|---|
| 이미지 | 정규화한다. GIF가 정지 이미지인지 아는 유일한 방법 |
| PDF | 문서를 연다. 텍스트 추출은 전송하는 turn으로 미룬다 |
| Office | ZIP 컨테이너를 검사한다. 텍스트 추출은 turn으로 미룬다 |
| 텍스트 | 엄격 디코딩한다. 이 계열은 그것이 검사의 전부다 |
| Office 97-2003·RTF | 실제로 파싱한다. 이 계열은 "여는 것"이 곧 검증이다(§4) |
| 압축 | 중앙 디렉터리를 전부 읽는다. 압축 해제는 turn으로 미룬다 |

검증에 실패한 R2 객체는 **즉시 삭제**한다. 성공한 것처럼 UI에 표시하지 않는다.

### 3.1 텍스트 디코딩

`lib/chatAttachmentText.ts`가 단독으로 결정한다.

- 알려진 바이너리 시그니처와 NUL 바이트는 텍스트가 아니다.
- UTF-8이 기본. BOM은 제거한다.
- **BOM이 있는 UTF-16 LE/BE는 변환한다.** Windows 편집기가 묻지 않고 쓰는
  형식이고, "당신의 메모는 텍스트가 아니다"는 틀린 답이다.
- **깨진 인코딩은 오류이지 복구 대상이 아니다.** `Buffer.toString("utf8")`은
  잘못된 시퀀스를 U+FFFD로 바꿔 놓으므로, 모델이 그 손상을 내용으로 읽게
  된다. 엄격 디코딩으로 실패시키고 사용자가 조치할 수 있는 문장을 준다.
- 문서에 원래 들어 있던 U+FFFD는 살린다.

### 3.2 구조 검증은 하지 않는다

JSON·YAML·XML이 문법적으로 올바른지 **검사하지 않는다.** 망가진 설정 파일을
올리는 사람은 대개 왜 망가졌는지를 묻고 있다. 이 앱은 그 파일을 파싱하지
않으므로(모델에게 텍스트로 전달할 뿐이다) XXE도 외부 엔터티도 성립하지 않는다.

### 3.3 GIF

`lib/gifStructure.ts`가 블록 구조를 직접 걸어 프레임 수를 센다. `sharp`의
페이지 수는 설치된 libvips가 GIF 지원으로 빌드됐을 때만 나오고, **안전 속성이
네이티브 라이브러리의 빌드 옵션에 달려 있으면 그것은 안전 속성이 아니다.**

애니메이션 GIF는 첫 프레임으로 조용히 대체하지 않고 이름을 대어 거절한다.
정지 GIF는 PNG로 정규화해 전달한다 — 이미지를 받는 모든 공급자가 GIF를 받지는
않고, 이 앱이 보장할 수 있는 것은 "검증한 정지 프레임"뿐이다.

## 4. Office 97-2003과 RTF

`lib/legacyOffice/**`가 읽고 `lib/legacyOfficeText.ts`가 단일 진입점입니다.

이 네 형식은 처음에 **근거를 적고 뺐습니다** — 이 저장소에 안전한 파서가 없고
`officeparser`는 OOXML과 ODF만 읽기 때문입니다. 목록에 넣고 파싱에 실패하는
것은 이 문서가 금지하는 가짜 지원이므로, 파서가 생길 때까지 기다렸습니다.

### 4.1 왜 의존성을 들이지 않았나

유지되는 JavaScript 구현은 네 형식 중 하나씩만 덮고, `.ppt`는 사실상 없습니다.
가장 유력한 스프레드시트 라이브러리는 npm 배포본에 prototype pollution 권고가
있고 수정본은 npm registry가 제공하지 않습니다. 그래서 **CFBF 컨테이너 하나를
공유하는 자체 파서**를 씁니다 — 읽는 코드가 저장소 안에 있으면 감사할 수 있고,
`packages/*`의 의존성 정책과도 충돌하지 않습니다.

### 4.2 형식마다 무엇을 읽는가

| 형식 | 읽는 것 | 읽지 않는 것 |
|---|---|---|
| `.doc` | FIB → piece table(CLX) → 문자 위치 순서의 본문 | 각주·머리글·주석(ccpText 이후), 매크로 저장소 |
| `.xls` | 시트 이름, SST, LABEL/RK/MULRK/NUMBER/BOOLERR, 수식의 **캐시된 결과** | 수식 재계산, 서식·날짜 해석, 매크로 |
| `.ppt` | 슬라이드 본문과 발표자 노트(TextChars/TextBytes atom) | 마스터·유인물 자리표시자, 아웃라인 중복본, Pictures |
| `.rtf` | 본문, `\uN`·`\'hh`·다중 코드페이지 | fonttbl·colortbl·stylesheet·info·pict·object·fldinst |

`.doc`인데 내용이 RTF인 파일은 **RTF로 읽습니다.** Word가 25년째 그렇게
저장하고 메일 시스템이 확장자를 바꾸므로, 시그니처로 거절하는 것은 기술적으로
옳고 쓸모없습니다. 반대로 `.docx`를 `.doc`으로 바꾼 파일은 맞는 파서가 따로
있으므로 불일치로 거절합니다.

### 4.3 절대 조건

- **복호화하지 않습니다.** `.doc`의 FIB `fEncrypted`, `.xls`의 `FILEPASS`,
  `.ppt`의 `Current User` 토큰과 `CryptSession10Container`를 각각 확인하고
  `ATTACHMENT_ENCRYPTED`로 거절합니다. 암호를 묻는 UI는 첨부에 존재할 수 없고,
  암호문을 반쯤 읽는 것은 거절보다 나쁩니다.
- **매크로 저장소·임베디드 객체·그림을 열지 않습니다.** 각 파서는 이름으로
  스트림을 열고, RTF는 `\object`·`\objdata`·`\pict`를 구조로 건너뜁니다.
- **실행·평가·네트워크·디스크 접근이 없습니다.**
- **읽었는데 아무 텍스트도 없으면 거절**입니다. 빈 문자열을 파일 내용인 것처럼
  모델에 넘기지 않습니다.

### 4.4 워커가 아니라 예산인 이유

`sharp`·`officeparser`·`pdfjs`는 워커에서 heap 상한과 deadline을 걸고 돌립니다.
이 저장소가 내부를 소유하지 않는 큰 third-party 파서이므로 외부 경계가 유일하게
정직한 한도이기 때문입니다.

그 방식을 여기서는 쓸 수 없습니다. 그 워커들은 `eval: true`로 만들어져
`require("sharp")` — 런타임에 디스크에 존재하는 node_modules 패키지 — 로 파서에
닿습니다. 저장소 `lib/`의 파서에는 그런 경로가 없습니다. Next.js 서버 빌드가
번들하는 TypeScript이고, eval된 워커는 그것을 `require`할 수 없습니다.

그래서 한도를 내부에 둡니다(`lib/legacyOffice/budget.ts`).

- **deadline** — 파일 내용이 길이를 정하는 모든 루프에서 `tick()`이 검사합니다.
- **byte 상한** — 할당 **전에** 청구합니다. 컨테이너가 자기 스트림 크기를
  스스로 말하므로 "읽고 나서 검사"는 순서가 틀립니다.
- **문자 상한** — 문서가 아무리 커도 turn이 감당할 수 있는 만큼만.
- **iteration backstop** — 다른 모든 한도를 만족시키면서도 deadline 내내 도는
  파일을 위한 마지막 방어선.

교환은 의도적이며 "기본적으로 덜 안전"이 아닙니다. 이 파서들은 예산이 승인하지
않은 것을 할당하지 않고, 고정 깊이까지만 재귀하며, 아무것도 실행하지 않고,
매크로·임베디드 객체·외부 참조를 읽지 않습니다. 워커는 이미 자유롭게 할당할 수
없는 코드에 메모리 격리를 더하는 것입니다.

### 4.5 테스트는 진짜 문서로 합니다

정상 경로는 LibreOffice가 만든 실제 파일(`tests/fixtures/legacyOffice/`)로
검증합니다. 자기 writer가 만든 파일로만 검증한 바이너리 파서는 둘이 서로
동의한다는 사실만 증명합니다. 거절 경로 — 순환하는 sector chain, 파일 끝을
넘는 스트림, 암호화된 워크북 — 는 정상 파일을 쓰는 어떤 도구도 만들 수 없으므로
테스트 안에서 바이트 단위로 만듭니다(`tests/support/compoundFile.mjs`).

### 4.6 한글(HWP 5.x, HWPX)

운영자 결정: 2026-11-13 — 한국 사용자를 위해 HWP를 덮어야 한다. `.hwp`
(`application/x-hwp`)와 `.hwpx`(`application/hwp+zip`)를 이 절의 다른 형식과
같은 길로 받는다: **이 저장소의 파서가 본문 텍스트를 읽는다**
(`lib/legacyOffice/hwp.ts`). 렌더러 없이 읽히므로 "이 공문 요약해 줘"가 바로
된다. 렌더러는 PDF로 레이아웃을 잡을 때만 쓴다(`docs/policy/generated-artifacts.md §15`).

- **HWP 5.x**: compound file. `FileHeader`의 속성으로 압축(raw DEFLATE)·암호·
  배포용·DRM을 판별한다. 암호·배포용·DRM 문서는 본문이 암호화돼 있으므로
  `ATTACHMENT_ENCRYPTED`로 거절한다 — 깨진 글자를 모델에게 주지 않는다. 본문은
  `BodyText/Section0..N`의 레코드 중 PARA_TEXT(태그 0x43)를 문단으로 읽는다.
  제어 문자는 명세의 폭대로 건너뛴다(char 1단위, inline·extended 8단위). 탭·줄바꿈·
  하이픈·고정 공백은 글자로 옮긴다.
- **HWPX**: ZIP 안의 `Contents/section*.xml`에서 `<hp:t>`를 문단(`<hp:p>`)
  단위로 잇는다. 표 칸은 한 줄씩이다. ZIP 자체이므로 압축파일 안의 항목으로는 받지
  않는다(압축파일 안의 압축파일).
- **읽는 것은 글자뿐이다.** 그림·필드·서식은 읽지 않는다. HWP 3.x(한글 97)는
  두 컨테이너 어느 쪽도 아니어서 거절된다.
- 예산은 §4.4와 같다(시간·바이트·글자 수). 압축 해제(HWP 섹션의 DEFLATE,
  HWPX의 ZIP 항목)는 **입력 4 KB씩** 한다(`lib/boundedInflate.ts`). DEFLATE는 많아야
  약 1,032배로 늘어나므로 한 걸음의 출력은 몇 MB를 넘지 않고, 나온 바이트를 그때마다
  예산에 청구한다. 한 번에 다 푸는 호출(`inflateSync`·`unzipSync`)은 출력 전체를
  할당한 뒤에야 예산을 보게 되므로 이 파서들에서 쓰지 않는다 —
  `scripts/security-regression-check.mjs`가 고정한다. ZIP이 적어 둔 크기는 믿지
  않는다.
- **검증 범위**: 정상 경로는 한컴오피스가 저장한 실제 파일로 확인한다 —
  `tests/fixtures/legacyOffice/sample-hancom.hwp`(HWP 5.0, 압축 본문·표·그림)와
  `sample-hancom.hwpx`(규정 문서, 조문·표·수식 필드·서식). 한컴이 파일 안에 남긴
  미리보기 글(`PrvText`, `Preview/PrvText.txt`)을 답안으로 삼아 그 단어가 모두 같은
  순서로 읽히는지 보고, 미리보기가 닿지 않는 뒷부분은 줄 수와 마지막 줄로
  고정한다(`tests/hwpText.test.mjs`). 공격·경계 사례는 명세대로 바이트를 짜서 만든다.

## 5. 압축파일

### 5.1 순서가 계약이다

**중앙 디렉터리를 먼저 읽고, 거절하거나 항목을 고르고, 그 다음에만 푼다.**

local header는 크기를 말하지 않을 수 있다(general-purpose 비트 3). 스트리밍
생산자 — Google Takeout을 포함해 — 는 0을 쓰고 실제 크기를 데이터 뒤
descriptor에 둔다. local header를 믿는 리더는 항목의 크기를 **이미 푼 뒤에야**
알게 되고, 그것은 압축 폭탄에 대해 정확히 한 발 늦다.

압축 해제 후에는 **나온 바이트를 디렉터리가 약속한 크기와 대조**한다. 예산은
디렉터리를 기준으로 승인됐으므로 스트림을 거기에 묶는다. 어긋나면 거절이지
크기 조정이 아니다.

디스크에 쓰지 않는다. 워커 메모리에서 풀므로 정리할 임시 디렉터리가 없고,
경로 검사 이전에 이미 Zip Slip이 착지할 곳이 없다.

### 5.2 한도

`lib/chatArchiveLimits.ts`. 외부 대화 가져오기의 한도
(`lib/externalImportLimits.ts`)와 **의도적으로 다르다.** 그쪽은 사용자 기기의
브라우저에서 1GB Takeout을 열고 컨테이너를 서버에 보내지 않는다. 이쪽은 이미
모델 예약을 들고 있는 채팅 요청 안에서 **서버가** 푼다. 같은 파일 형식,
반대의 비용 모델.

| | 로그인 | 게스트 |
|---|---|---|
| 압축파일 크기 | 50MB | 5MB |
| 전체 엔트리 수 | 100 | 100 |
| 실제 분석 파일 수 | 20 | 5 |
| 단일 항목 해제 크기 | 50MB | 5MB |
| 총 해제 크기 | 200MB | 20MB |
| 압축률 | 100:1 | 100:1 |
| 중첩 깊이 | 0 | 0 |
| 내부 PDF의 유료 OCR | 3건 | 0건 |
| 경로 길이 / 세그먼트 | 1024 / 255 | 1024 / 255 |

**내부 PDF의 OCR 상한이 있는 이유.** 혼자 첨부된 PDF는 한 사람의 한 번의
의도적 행위이고 OCR을 쓰는 것이 기능이 동작하는 모습이다. 사용자가 열거하지
않은 컨테이너 안에서 스캔본 20장이 도착하는 것은 같은 모양의 다른 사건이며,
페이지당 비용은 요청의 어디에서도 묻지 않은 실제 돈이다. 상한을 넘은 이미지형
PDF는 청구되지 않고 "읽을 수 있는 텍스트 없음"으로 제외 보고된다.

처리 timeout 15초, 워커 heap 상한 320MB.

### 5.3 반드시 막는 것

Zip Slip과 `..`, 절대경로, Windows 드라이브(`C:/x`와 `C:x` 양쪽)와 UNC(`//`),
`\`와 `/` 혼합 경로, NUL 문자, 정규화 후 중복 파일명, 심볼릭 링크(POSIX host의
`S_IFLNK`), ZIP 폭탄, 데이터 디스크립터로 감춘 크기, 디렉터리와 스트림의 크기
불일치, 암호화 ZIP(비트 0과 비트 6), ZIP64(sentinel과 EOCD locator 양쪽),
store/deflate 이외의 압축 방식, 손상·절단, 지나치게 긴 경로.

중복 판정은 구분자와 Unicode를 정규화하되 **대소문자는 접지 않는다.**
대소문자를 구분하는 트리는 `README.md`와 `readme.md`를 정당하게 가지며, 그것을
거절하는 것은 평범한 소스 아카이브를 거절하는 일이다.

### 5.4 내부 항목: 치명 vs 제외

**전체 거절(치명).** 읽는 사람이 실행할 수 있는 프로그램·설치 파일
(`EXECUTABLE_ATTACHMENT_EXTENSIONS` 중 아래 예외를 뺀 것), 인증서·개인키·
자격증명(`ARCHIVE_FATAL_EXTENSIONS`, `ARCHIVE_FATAL_FILENAMES`). 개인키는 종류가
다른 문제다 — 올린 사람은 그것을 모델에 건넬 생각이 거의 확실히 없었고, 조용히
빼는 것은 감사하지 않은 디렉터리를 보냈다고 믿게 두는 일이다.

**빌드 산출물은 예외다**(`ARCHIVE_TOLERATED_BINARY_EXTENSIONS`: `jar`, `node`,
`class`, `pyc`, `pyo`). 직접 업로드로는 계속 거절하지만 압축파일 안에서는
**제외**로 끝난다. Gradle wrapper는 `.jar`이고 `node_modules`는 `.node`로
가득하며 Java 트리는 읽어 주기를 바라는 `.java` 옆에 `.class`를 두고, 모든
Python 트리는 `__pycache__`를 가지고 있다. 이것들로 업로드 전체를 실패시키는
것은 이 기능이 읽으려고 존재하는 평범한 소스 아카이브를 거절하는 일이고, 빼도
사용자가 잃는 것이 없다 — 컴파일된 모듈에는 어차피 텍스트가 없다. 두 질문이
다르다는 것이 요점이다: **직접 첨부**는 여전히 거절이고, **아카이브 안에서
발견**은 아카이브를 거절할 이유가 아니다.

**제외(비치명).** 지원하지 않는 형식, 중첩 압축파일, 디렉터리, 빈 파일, 파일
수 상한 초과, 읽기 실패. 소스 트리는 이 앱이 읽지 못하는 이미지와 파서가 없는
lock 파일을 늘 가지고 있고, 그것을 빼는 데 드는 비용은 사용자에게 없다.

처리 가능한 파일이 **하나도** 없으면 압축파일 전체를 거절한다.

### 5.5 내부 항목은 일반 첨부와 같은 문을 지난다

`ingestAttachmentFile()` 하나가 직접 첨부와 압축 내부 파일을 모두 처리한다.
그래서 컨테이너가 이미지 개수 상한, base64 payload 상한, 추출 텍스트 예산
(가장 큰 모델 문맥 창에서 계산), OCR 허용량을 우회하는 길이 되지 않는다.

내부 파일 이름은 `압축파일명/경로` 형태로 전달되고, 각각 자기 fence 안에 놓인다
(`lib/attachmentContextPrompt.ts`). 순서는 경로 기준 정렬로 결정적이다. 무엇을
읽었고 무엇을 읽지 못했는지는 `archive listing` 블록으로 모델에게 명시한다 —
없으면 "보내신 파일들"에 대한 답이 조용히 부분집합을 설명하고, 양쪽 다 어느
부분집합인지 모른다.

**압축 내부의 지시문은 사용자 지시가 아니다.** 기존 attachment prompt-injection
경계를 그대로 쓴다.

## 6. 모델 호환성

- 텍스트·코드·Office·압축파일은 서버가 추출한 공통 텍스트로 전달한다. 특정
  공급자의 원본 파일 지원에 의존하지 않는다.
- PDF는 기존 로컬 추출 → OCR → 네이티브 PDF fallback 정책을 그대로 쓴다.
- 이미지는 정규화한 뒤 이미지 입력을 지원하는 모델에만 전달한다. 압축 내부
  이미지도 같은 개수·payload 제한에 포함된다.
- **확장자만 바꾼 원본 ZIP을 공급자에게 보내지 않는다.**
- **이전 메시지의 파일은 거절 사유가 아니다.** 이미지 입력이 없는 모델로 바꾼 뒤의
  이전 이미지, 파싱 실패·timeout, OCR·압축 해제 거절은 그 파일만 "이번 답변에
  포함되지 않음"(`earlier attachment, not included`)으로 모델에 알리고 뺀다. 이번에
  보내는 메시지의 파일은 위 규칙대로 거절하며(`ATTACHMENT_MODEL_UNSUPPORTED`,
  `PDF_OCR_UNAVAILABLE`, 코드 없던 파서 실패는 `ATTACHMENT_UNREADABLE`), 사용자에게는
  `lib/chatAttachmentErrorCopy.ts`의 문장으로 보인다. 이전 파일을 생략했다는 사실을
  사용자에게 알리는 UI는 아직 없다(알려진 한계).

## 7. 오류는 코드로 말한다

서버는 `code`를 반환하고 클라이언트는
`lib/chatAttachmentErrorCopy.ts`가 정한 locale key로 번역한다. 로그인 업로드
경로는 이전에 서버의 답을 버리고 모든 원인에 "다시 시도해 주세요"를 보여
줬는데, 넷 중 셋에게 그것은 틀린 조언이었다.

**오류에 항목 경로·파서 메시지·R2 key·파일 내용은 실리지 않는다.** 경로는
올린 사람이 고른 텍스트이고 오류는 그것을 되돌려 주는 자리가 아니다. 로그에는
오류 코드, 크기, 개수, 처리 시간 같은 비민감 메타데이터만 남긴다.

압축파일 코드는 `CHAT_ARCHIVE_ERROR_CODES`가 소유하며, 코드가 늘고 문장이 없는
상태는 `tests/chatAttachmentErrorCopy.test.mjs`가 막는다.

채팅 전송 단계(`components/chat/ChatApp.tsx`)는 서버의 영어 문장 대신 이 표의 문장을
쓰는 코드를 `CHAT_SEND_LOCALIZED_ATTACHMENT_CODES`로 명시한다(현재
`ATTACHMENT_UNREADABLE`·`ATTACHMENT_MODEL_UNSUPPORTED`·`PDF_OCR_UNAVAILABLE`). 표 전체를
전송 단계에 연결하지 않는 것은 나머지 코드가 업로드 단계의 표면에서 처리되기 때문이다.

## 8. 변경 규칙

1. **텍스트 형식 추가는 표에 한 행**이다. 그 밖의 어디에도 형식별 분기를
   만들지 않는다.
2. 파서가 필요한 형식은 행 하나 + `lib/chatAttachmentValidation.ts`의 분기
   하나다.
3. 새 거절 코드는 `lib/chatAttachmentErrorCopy.ts`의 항목과 7개 locale의
   문장을 함께 가져야 한다.
4. 한도를 바꾸는 것은 이 문서를 바꾸는 것이다. 값 옆에 근거가 없는 상수는
   "조정"된다.
5. 이 계약을 어기는 변경은 릴리스 차단 사유다.
