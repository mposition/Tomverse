# 외부 어시스턴트 패키지 가져오기 · 변환

- Status: **승인(approved)**
- 승인자: `@mposition`
- 승인일: 2026-08-23
- 승인 범위: 아래 §3의 A1~A4·A7과 §4의 B1~B6, 그리고 이 문서가 확정값으로
  적은 나머지 계약
- 근거 조사: `.github/audits/assistant-package-interoperability-review-2026-08-23.md`
  (rev17). 그 문서는 **조사 보고서**이고, 이 문서가 **계약**입니다. 둘이
  어긋나면 이 문서가 이깁니다.

이 문서는 사용자가 자기 기기에서 고른 로컬 패키지를 읽어 Tomverse Assistant
Profile로 **변환**하는 기능의 릴리스 차단 계약입니다.

**이 문서가 구현보다 먼저 있습니다.** 계약이 먼저 확정되고 코드가 그것을
따르는 순서이므로, 이 문서를 쓴 시점에는 구현 모듈의 경로를 나열하지
않았습니다 — `npm run check:doc-references`가 존재하지 않는 경로를 정당하게
거절하고, 그것을 피하려고 미리 빈 파일을 만드는 것은 게이트를 무력화하는
일입니다. 모듈이 생기는 slice에서 그 경로를 여기 추가합니다.

지금까지 생긴 것은 아래이며, 남은 slice의 모듈은 그 slice가 이 목록에
추가합니다.

| 모듈 | 하는 일 |
|---|---|
| `lib/assistantPackageLimits.ts` | B1–B6 한도, 거절·건너뜀 사유, 확장자 분류 |
| `lib/assistantPackageSecretScan.ts` | A5 scanner. 브라우저와 서버가 같은 것을 import |
| `lib/assistantPackageManifest.ts` | native manifest schema, `portableProfileEquals()` |
| `lib/assistantPackageAdapter.ts` | Agent Skill 변환과 손실 보고 |
| `lib/assistantPackageArchive.ts` | 중앙 디렉터리 판독, 읽기 계획, entry 해제 |
| `lib/assistantPackageReview.ts` | 열린 패키지를 사용자가 검토할 제안으로 |
| `lib/workers/assistantPackageWorker.ts` | 위 둘을 main thread 밖에서 실행 |
| `lib/assistantPackageImportWizard.ts` | 8단계의 상태 기계. 6→7 경계가 여기 있습니다 |
| `lib/assistantPackageImportAccess.ts` | rollout flag. 기본 off, fail-closed |
| `components/assistants/import/AssistantPackageImportWizard.tsx` | 8단계 화면 전부 |
| `app/(site)/(application)/settings/assistants/import/page.tsx` | route. flag가 꺼져 있으면 404 |
| `lib/assistantProfileImportCore.ts` | mode·status·예약 상태 어휘, 두 시계, 삭제 전제 조건 |
| `lib/assistantProfileImportLocks.ts` | profile 잠금과 계정 quota 잠금, 그리고 잠금 순서 |
| `lib/assistantProfileImportService.ts` | 생성·업로드·게시·취소 |
| `lib/assistantProfileImportSweep.ts` | 만료 수거와 stale claim 회수 |
| `lib/assistantProfileImportHttp.ts` | 네 route가 공유하는 flag 검사와 오류 변환 |
| `app/api/assistant-profiles/imports/**` | 위 서비스의 HTTP 표면 |
| `lib/assistantPackageImportClient.ts` | wizard가 부르는 요청들. 실행 순서가 여기 한 곳에 있습니다 |
| `scripts/report-assistant-knowledge-invariants.mjs` | `NOT VALID` 제약의 survey |

이 문서는 아래를 대체하지 않고 그 위에 쌓입니다.

- `AGENTS.md`
- `docs/policy/external-conversation-import-and-memory.md` (릴리스 C의
  Assistant Profile 계약)
- `docs/policy/chat-attachment-formats.md` (형식은 표 하나)
- `docs/policy/user-attachment-persistence.md` (저장 위치를 클라이언트가
  말하지 않음)

## 1. 무엇을 채택했고 무엇을 채택하지 않았는가

**채택한 것은 "가져오기·변환"이지 "실행 호환"이 아닙니다.**

| 입력 | 판정 |
|---|---|
| Agent Skills 패키지 **ZIP** | 채택 |
| Tomverse native package (`.tomverse-assistant.zip`, 단독 `.json`) | 채택 |
| Gemini Gem · ChatGPT GPT 설정의 paste/import | 범위 밖 |
| `gemini_gems_data.html` 파싱 | 범위 밖 |
| 디렉터리(폴더) 선택 | 범위 밖 |
| 원격 URL import·package fetch | 범위 밖 |

### 1.1 절대 하지 않는 것

이 목록은 범위 조정이 아니라 **금지**입니다. 넓히려면 이 문서를 먼저 고치고
승인을 다시 받습니다.

1. 외부 `scripts/`의 실행. **읽지도 inflate하지도 않습니다.**
2. shell·code execution, 원격 dependency 설치.
3. Actions / OpenAPI / OAuth connector / Apps / MCP 연결의 실행.
4. 인증된 외부 페이지 scraping, 비공개 설정 우회 열람.
5. Google Drive 등 외부 저장소 연결.
6. 외부 URL의 자동 방문, imported source의 자동 업데이트.
7. 외부 모델명의 **자동 Tomverse 모델 치환**.
8. 외부 패키지 원문을 **신뢰된 owner instruction으로 자동 승격**(§3 A1).
9. public marketplace · 공유 · 판매.

## 2. 용어

| 단어 | 뜻 |
|---|---|
| **가져오기(import)** | 외부 산출물을 읽어 사용자에게 보여 주는 것. 아직 어떤 profile version도 게시되지 않은 단계 |
| **변환(convert)** | 읽은 것을 Tomverse 필드에 대응시키는 것. 대응이 없으면 **손실**로 보고 |
| **병합(merge)** | 변환 결과를 이미 존재하는 profile에 합치는 것. 항상 새 immutable revision |
| **실행 호환** | 외부 정의를 그대로 실행하는 것. **채택하지 않음**(§1.1) |
| **`create` mode** | 새 profile을 만드는 가져오기. staging 보유자는 draft `AssistantProfile` |
| **`merge` mode** | 기존 profile에 합치는 가져오기. **새 profile 행을 만들지 않음** |

## 3. 승인된 결정 (A1~A7)

### A1 — imported instruction의 승격 시점

가져온 instruction은 **사용자가 전문을 확인하고 명시적으로 승인한 뒤에만**
owner instruction이 됩니다.

- 승격 사실은 provenance 행과 `userApprovedAt`으로 남깁니다.
- `stagingManifest`에 instruction이 저장돼 있다는 것이 승인됐다는 뜻이
  **아닙니다.** `userApprovedAt`이 `NULL`인 동안 그 문자열은 어떤 prompt에도
  들어가지 않습니다.
- preview는 원문을 **평문으로** 보여 줍니다. Markdown으로 렌더하면 링크가
  클릭 가능해지고 이미지가 로드됩니다.
- **자동 요약·자동 정리를 하지 않습니다.** 요약을 위해 모델을 부르는 순간 그
  모델이 첫 번째 injection 대상이 됩니다.

### A2 — 원본 보존과 provenance 수명

- **원본 ZIP·JSON을 서버에 보존하지 않습니다.** 파싱은 브라우저에서 끝나고,
  서버가 받는 것은 정규화된 manifest와 사용자가 고른 knowledge 바이트뿐입니다.
- **provenance는 profile 수명 동안 보존**합니다. 별도 만료를 두지 않고,
  profile 삭제 cascade로만 사라집니다.

### A3 — license

`license` 정보가 없거나 불명이어도 **거절하지 않고 경고**합니다. preview에
표시하고, 최종 확인 화면에 "가져오는 내용을 사용할 권한이 있는지 확인하셨는지"
를 **문장으로** 둡니다(체크박스는 읽지 않고 눌립니다).

### A4 — flag off 시의 접근 계약

가져오기 flag가 꺼져도:

- **이미 만들어진 profile은 정상 동작**합니다. 가져오기가 만든 것은 평범한
  `AssistantProfile`과 `AssistantProfileVersion`이고, 그것들은
  `feature.assistantProfilesEnabled`가 지배합니다.
- **import wizard와 import API 진입점만** 비활성화됩니다.
- **provenance 행은 보존**합니다. flag와 함께 사라지면 이미 만들어진 profile이
  출처를 잃습니다.
- 기존 profile이나 import 결과를 **삭제하거나 숨기지 않습니다.**

### A5 — secret 탐지

- **게시 차단을 유지**합니다. 경고로 강등하지 않습니다.
- 탐지는 **브라우저와 서버 양쪽**에서 하며, **같은 순수 모듈**
  씁니다(Slice 2가 만드는 순수 scanner module). 두 scanner가 다르면 override
  대조가 성립하지 않습니다.
- 사용자는 오탐을 넘길 수 있습니다. **override는 `approvedDigest`에
  결속**합니다 — `(rule id, 매치 offset, 매치의 SHA-256)`의 정규화된 목록을
  digest 계산에 포함시키고, 서버가 자기 scanner로 같은 목록을 독립적으로 만들어
  대조합니다. 서버가 찾았는데 override에 없는 항목이 하나라도 있으면 **게시
  거절**입니다.
- **매치 문자열 자체는 요청 body·응답·로그 어디에도 넣지 않습니다.** 해시와
  offset만 오갑니다.
- 우리가 자동으로 지우지 않습니다. 자동 마스킹은 "지워졌다"는 잘못된 안심을
  주고, 정규식이 놓친 형태는 그대로 저장됩니다.

### A6 — instruction 안의 URL

- **`PROFILE_INSTRUCTION_RULES`에 URL 금지 문장을 추가하지 않습니다.** 그것은
  손으로 쓴 기존 profile 전부의 동작을 바꾸는 변경이고 이 기능의 범위를
  넘습니다.
- 대신 **사실을 고지**합니다: instruction 안 URL의 **개수와 host 목록**을
  inventory와 손실 보고서에 표시합니다. 전체 URL이 아니라 host입니다 — 경로에
  토큰이 실려 있을 수 있습니다.
- instruction에 URL이 있는 상태에서 `webSearch` 또는 `deepResearch`를 켜려면
  **한 번 더 명시적으로 확인**하게 합니다. 기본값은 둘 다 꺼짐입니다.
- **문구를 구분합니다.** knowledge 안의 URL에는 "방문하지 않습니다"라고 말해도
  됩니다(`KNOWLEDGE_CONTEXT_RULES`가 실제로 그렇게 말합니다). instruction 안의
  URL에는 그렇게 말하면 **거짓**입니다.

### A7 — 기존 knowledge 행의 `extractedBytes`

- **기존 파일을 재처리하지 않습니다.**
- `extractedBytes`가 `NULL`인 행은 합산에서 **그 행의 `extractedCharacters`
  값으로 대체**합니다 — 즉 현재 동작을 유지합니다.
- **신규 파일부터 정확한 UTF-8 byte**(`Buffer.byteLength(text, "utf8")`)를
  기록합니다.
- 소급 재처리는 별도 결정이며 이 승인에 포함되지 않습니다.

## 4. 승인된 수치 (B1~B6)

**이 수치들은 새 역할의 결정이며, 다른 기능의 같은 값에서 상속한 것이
아닙니다.** 한쪽을 바꿔도 다른 쪽이 따라 움직여서는 안 됩니다.

| # | 항목 | 값 | 왜 이 값인가 |
|---|---|---|---|
| **B1** | package container 최대 byte | **64MB** | Agent Skills 업로드의 공식 상한이 비압축 30MB 미만이므로, 압축 컨테이너에 여유 배수를 둔 값 |
| **B2** | package entry 최대 개수 | **2,000** | skill 패키지는 문서와 스크립트 수십 개 규모. 대화 export의 50,000은 다른 문제의 수치 |
| **B3** | 총 압축 해제량 | **128MB** | B1의 배수. 실제로 읽는 것은 텍스트뿐 |
| **B4** | 단일 entry 최대 byte | **32MiB** | knowledge 개별 파일 상한과 같은 물리 제약(서버가 한 번에 메모리로 읽는 크기) |
| **B5** | instruction 최대 문자 | **8,000** | `ASSISTANT_PROFILE_LIMITS.maxInstructionsCharacters`와 **같은 필드**이므로 같은 값이어야 함. 상속이 아니라 동일 대상 |
| **B6** | package에서 가져올 knowledge 파일 최대 | **10** | `maxFilesPerProfile`(20)의 절반. 사용자가 나머지를 손으로 채울 여지를 남김 |

- **상속하지 않는 것**: `EXTERNAL_IMPORT_CLIENT_ARCHIVE_LIMITS`의 1GB /
  50,000 / 250MB는 media로 비대한 **대화 export**를 위한 값입니다.
- 이 수치는 **중앙 상수 module 한 곳**에서 관리하고 UI는 표시용으로만
  미러합니다.

## 5. 형식별 매핑

### 5.1 판정 세 가지

- **자동 변환 가능** — 사용자가 보기만 하면 되고 값은 서버가 결정.
- **사용자 확인 필요** — 서버가 후보를 제안하지만 **고르기 전에는 저장되지
  않음.** 기본적으로 미선택.
- **지원 불가** — 대응 필드가 없음. **손실 보고서에 항목 이름이 나와야 하며,
  개수만 세지 않습니다.**

### 5.2 Agent Skill → Assistant Profile

| 원본 | 대상 | 판정 | 손실·경고 |
|---|---|---|---|
| frontmatter `name` (≤64, slug) | `AssistantProfile.name` (≤60) | 사용자 확인 필요 | 64→60 초과 시. slug는 사람이 읽기 나쁨 |
| frontmatter `description` (≤1024) | `AssistantProfile.description` (≤300) | 사용자 확인 필요 | **큼.** description은 발동 조건을 담는 필드라 대개 300자 초과 |
| `SKILL.md` 본문 | `AssistantProfileVersion.instructions` (≤8,000) | 사용자 확인 필요 | **8,000자 초과 시 자르지 않고 거절.** 자르면 의미가 바뀜 |
| 본문의 상대 링크 | 없음 | 지원 불가 | 링크 대상 파일은 사용자가 knowledge로 따로 골라야 함 |
| `references/**` | `AssistantKnowledgeFile` 후보 | 사용자 확인 필요 | B6·형식 allowlist 밖은 제외 |
| `assets/**` | 형식이 맞으면 knowledge 후보 | 사용자 확인 필요 / 지원 불가 | 이미지·바이너리는 지원 불가 |
| `scripts/**` | **없음** | **지원 불가(금지)** | **최고 경고.** 읽지도 inflate하지도 않고 개수·경로만 표시 |
| frontmatter `allowed-tools` | `toolPolicy`로 **쓰지 않음** | 지원 불가 | `Bash`·`Write` 같은 값이 있으면 경고 |
| frontmatter `license` | 표시만 | 사용자 확인 필요 | A3 |
| 인식하지 못한 frontmatter 키 | 없음 | 지원 불가 | **버리지 않고 개수로 보고** |
| skill version | 없음 | 지원 불가 | provenance에 문자열로만 |

**`display_name`은 매핑 대상이 아닙니다.** 그것은 skill 생성 API 요청의
파라미터이지 `SKILL.md` frontmatter가 아니므로 **로컬 ZIP에 존재하지
않습니다.** 이름 후보는 `name` 하나뿐입니다.

### 5.3 모델·도구·memory

- **모델은 자동 치환하지 않습니다.** 원본이 어떤 모델을 지목하든 손실
  보고서에 적고, 사용자가 Tomverse 모델을 **직접 고릅니다.**
- `toolPolicy`는 **요청**이지 권한이 아닙니다. runtime의
  `resolveProfileTools()` 교집합이 최종 판정을 합니다.
- `memoryPolicy.useAccountMemory`는 **기본 `false`**이며 자동으로 `true`가
  되지 않습니다.
- `icon`은 이모지 또는 짧은 토큰만 가능하고 **URL·data 참조는 거절**됩니다
  (`profileIdentityProblems()`가 이미 강제).

### 5.4 8단계와 서버 상태의 경계

가져오기는 8단계이고, **7단계가 서버에 무언가를 만드는 첫 지점**입니다.

| # | 단계 | 서버에 생기는 것 |
|---|---|---|
| 1 | source 선택 — 로컬 `.zip` 또는 단독 `.json` | 없음 |
| 2 | 형식 감지 | 없음 |
| 3 | 내용 목록과 위험 경고 | 없음 |
| 4 | 필드별 변환 검토 | 없음 |
| 5 | 손실 보고서 | 없음 |
| 6 | 대상 선택 (새로 만들기 / 기존에 합치기) | 없음 |
| 7 | knowledge 업로드와 처리 대기 | **import 행 + knowledge 행·chunk + 저장소 객체**(`create`면 draft profile도) |
| 8 | 최종 확인 → publish | `AssistantProfileVersion` + provenance 확정 |

- **1~6단계에서 취소하면 지울 것이 없습니다.** 요청이 한 번도 나가지 않았기
  때문입니다. 그러므로 그 사실을 **6→7 전환에서 명시**합니다 — 사용자가 저장이
  시작되는 지점을 모르면 취소가 무엇을 뜻하는지도 알 수 없습니다.
- **이 경계는 한 곳에서만 정합니다.** 경계의 위치에 대한 두 번째 의견이 생기면
  그중 하나는 틀리고, 틀린 쪽이 취소 계약입니다.

### 5.5 staging을 무엇이 보유하는가 — mode가 정합니다

| | `create` | `merge` |
|---|---|---|
| staging 보유자 | **draft `AssistantProfile`**(`currentVersionId = NULL`) | **대상 profile 자신.** 새 profile 행 없음 |
| profile slot | 1개 점유 | **0개** |
| 게시 전 대화 영향 | 없음 — draft로는 대화를 시작할 수 없습니다 | 없음 — manifest에 없으므로 retrieval에서 제외됩니다 |
| 취소 | draft profile 삭제 | **이 import가 만든 파일만** 삭제. 기존 파일·revision은 그대로 |

- **`mode`는 표시 필드가 아니라 취소·만료의 분기입니다.** 값이 틀리면 남이
  만든 profile이 지워지므로, DB CHECK로 어휘를 닫고 **삭제 직전에 전제 조건을
  다시 확인**합니다. 하나라도 어긋나면 아무것도 지우지 않고 구조화 오류를
  남깁니다 — profile을 지우는 것은 되돌릴 수 없고, 사람이 확인하는 것은 되돌릴
  수 있습니다.
- **cross-profile 이전은 없습니다.** version의 manifest는 그 profile이 가진
  파일로만 해석되므로, "A에 올리고 B로 옮긴다"는 표현할 수조차 없습니다.

### 5.6 격리·취소·만료

- **staging 파일은 일반 경로에서 보이지 않습니다.** `AssistantKnowledgeFile.importId`
  가 결속을 들고 있고, 일반 knowledge 목록과 일반 manifest 해석은 `importId`가
  NULL인 파일만 봅니다. publish가 그 값을 NULL로 바꾸는 것이 **승격**입니다.
  이 격리가 없으면, 검토 중인 파일을 다른 탭이 게시할 수 있습니다.
- **활성 staging import가 있는 profile은 일반 publish를 거절합니다.** draft가
  일반 경로로 게시되는 것을 막는 유일한 방법입니다.
- **업로드 key는 서버가 발급을 기억합니다.** key는 무작위 UUID라 key만 보고는
  누가 요청한 것인지 알 수 없으므로, 예약 행이 없으면 finalize는 클라이언트의
  주장만으로 객체를 지울지 판단하게 됩니다. **우리가 발급하지 않은 key의
  객체는 지우지 않습니다.**
- **일반 finalize도 예약을 봅니다.** 그러지 않으면 import가 받은 key를 일반
  경로에 보내는 것만으로 격리 전체가 한 요청에 우회됩니다.
- **만료는 두 시계입니다** — 마지막 사용자 행위 기준의 idle, 생성 기준의
  absolute. 두 값은 컬럼이며 `updatedAt`에서 계산하지 않습니다: background
  추출과 실패한 publish도 그 컬럼을 움직이므로, 그것으로 계산한 idle 시계는
  **아무도 없다는 뜻인 사건들이 수명을 연장**하게 됩니다.
- **idle 만료는 absolute를 넘지 않습니다.**

## 6. Native package 형식

### 6.1 형식

**`.tomverse-assistant.zip`** — 최상위에 `assistant.json`(manifest) 하나와
선택적 `knowledge/` 디렉터리. knowledge가 없으면 단독 `.json`도 유효합니다.

### 6.2 manifest가 담는 것과 담지 않는 것

- 담는 것: `schemaVersion`, `producedBy`, profile identity, version 내용
  (instructions · starters · modelIds · toolPolicy · memoryPolicy ·
  knowledge 목록), 사용자·클라이언트가 **주장하는** 과거 출처, package digest.
- **담지 않는 것**: `secrets` · `credentials` · `apiKeys` · `env` · `headers`
  · `auth` 어떤 이름의 필드도 없습니다. schema는 `.strict()`이므로 **추가할
  수도 없습니다.**
- **담지 않는 것**: `r2Key`, 저장소 URL, 서명 URL, 내부 id. knowledge는
  **바이트 자체**로 나가고 위치는 나가지 않습니다.

**`.strict()`가 막는 것과 막지 못하는 것을 구분합니다.** 막는 것은 "전용
자리"입니다 — 이름 붙은 필드가 있으면 거기에 자격증명을 넣는 것이 정상 사용이
됩니다. **막지 못하는 것은 `instructions` 문자열·knowledge 본문·표시 문자열
안의 secret**이고, 그것에 대한 실제 보안 경계는 A5의 서버 scanner입니다.
두 장치는 서로를 대신하지 않습니다.

### 6.3 schemaVersion 정책

| 상태 | 판정 |
|---|---|
| 현재보다 **낮음** | 알려진 migration이 있으면 적용하고 **적용 사실을 preview에 표시**. 없으면 거절 |
| 현재와 **같음** | 정상 |
| 현재보다 **높음** | **거절.** "모르는 필드는 무시하고 진행"은 기대한 것의 일부만 가져오는 조용한 실패 |
| **없음** | 거절. Tomverse 패키지가 아닙니다 |

migration은 **코드로 명시적으로 작성**하며 관용적 파싱으로 흉내 내지 않습니다.

### 6.4 round-trip 계약

> 같은 계정에서 export한 패키지를 즉시 re-import해 만든 `PortableProfile`은,
> export 대상이었던 version의 `PortableProfile`과
> **`portableProfileEquals()`로 동일**해야 한다.

- `portableProfileEquals()`는 identity(정규화 후) · `instructions` ·
  `starters`(순서) · `modelIds`(순서) · `toolPolicy` · `memoryPolicy`를
  비교하고, knowledge는 **`(정규화된 name, digest)`의 다중집합**으로
  비교합니다.
- **`fileId` · `revision` · `retrievalVersion` · `promptFormatVersion`은
  비교하지 않습니다.**
- **`draftsEqual()`이나 publish의 `unchanged` 판정과 합치지 않습니다.**
  `draftsEqual()`은 "이 편집이 revision을 소비할 가치가 있는가"를 묻고 그래서
  `fileId`를 봅니다. `portableProfileEquals()`는 "이 형식이 내용을 잃지
  않았는가"를 묻습니다. 합치면 둘 중 하나가 틀린 답을 합니다.

### 6.5 provenance — 증명할 수 있는 것과 주장인 것

**서버는 원본 패키지를 보지 않습니다.** 브라우저가 정규화한 manifest만
받으므로, 조작된 클라이언트는 원본 형식에 대해 무엇이든 말할 수 있습니다.
그래서 서버가 실제로 증명할 수 있는 것만 권위 있는 필드로 둡니다.

| 필드 | 신뢰 수준 |
|---|---|
| `serverReceivedAt` · `approvedDigest` · `digestVersion` · `validatorVersion` · `ingestPath` · `userApprovedAt` | **권위 있음** |
| `declaredSourceKind` · `declaredSourceName` · `declaredSourceUrl` · `declaredPreviousProvenance` | **주장** |

- `declared*`는 **표시 전용**입니다. 중복 판정·재가져오기 판정·digest 비교·
  quota 어디에도 들어가지 않습니다.
- **UI 문구가 주장임을 드러냅니다.** "Agent Skill에서 가져옴"이 아니라
  **"Agent Skill에서 가져왔다고 표시됨"**입니다.
- 시각은 **서버 것만** 씁니다.

## 7. 원격 source 자동 업데이트 금지

- 저장된 `declaredSourceUrl`을 주기적으로 다시 읽지 않습니다.
- "새 버전이 있습니다"를 서버가 먼저 알리지 않습니다.
- 원본이 바뀌었을 때 profile을 갱신하지 않습니다.

자동 업데이트는 **사용자가 한 번 검토한 내용을, 검토 없이 바뀐 내용으로
교체하는 기능**입니다. 재가져오기는 사용자가 새 파일을 다시 고르고 wizard를
처음부터 지나는 것이며, 편의는 하나만 제공합니다 — 이전 대상 profile과 필드
선택을 **기본값으로 제시**하는 것. 값은 제시하지 않습니다.

## 8. 브라우저 검사는 보안 경계가 아닙니다

wizard의 inventory · 형식 감지 · secret 탐지 · 위험 경고 · 필드별 preview는
**전부 브라우저에서** 일어납니다. 브라우저는 사용자의 통제 아래 있고, 조작된
클라이언트는 이 검사를 전부 통과했다고 주장할 수 있습니다.

**서버는 최종 manifest와 모든 선택 항목을 다시 검증합니다.**

| 서버가 다시 하는 것 |
|---|
| instruction 길이·control 문자·정규화 |
| starters 개수·길이 |
| `modelIds`의 존재·활성·plan 허용 |
| `toolPolicy` 요청의 교집합 |
| knowledge 파일의 MIME·magic byte·크기·quota, 그리고 **전원 `ready`** |
| secret scanner 재실행 + override 목록 대조 |
| instruction 안 URL의 개수·host 재산출 |
| `approvedDigest`가 실제 저장 대상과 일치하는지 |
| `expectedRevision`·`expectedTargetIdentityDigest` |
| 소유권 (`userId` in `where`) |

## 9. 로그·telemetry

- 이벤트 속성은 **닫힌 enum**만 씁니다.
- instruction · filename · URL · digest · knowledge 원문 · secret 매치 문자열을
  **넣지 않습니다.**
- 개수도 그대로 넣지 않습니다 — 소수 사용자 환경에서는 식별자에 가깝습니다.
  필요하면 bucket으로 넣습니다.

## 10. 이 문서가 상속하는 확정값

아래는 이 기능이 새로 정하는 것이 아니라 **기존 계약이 이 기능에 적용되는
것**입니다.

| 항목 | 확정값 | 출처 |
|---|---|---|
| profile 수·knowledge quota | 기존 수치 그대로, 예외 없음. 초과는 **부분 저장 없이 전체 거절** | `docs/policy/external-conversation-import-and-memory.md` §14.1 |
| prompt 순서 | §9.1 그대로. 가져온 instruction도 2번 구획 | 같은 문서 §9.1 |
| 버전 고정 | 새 대화는 최신 active version, 기존 대화는 생성 시점 version. **소급 적용 없음** | 같은 문서 §14 |
| knowledge 보존·R2 | DB-first tombstone + 15분 sweep. 활성 파일에 만료 없음 | 같은 문서 §14.2 |
| provenance 저장 위치 | owner-bound 테이블, `userId` index + cascade | 같은 문서 §20 |
| 형식 allowlist | knowledge는 `ASSISTANT_KNOWLEDGE_TYPES` 그대로 | `lib/assistantKnowledgeLimits.ts` |

## 11. 이 계약을 어기는 변경은 릴리스 차단 사유입니다
