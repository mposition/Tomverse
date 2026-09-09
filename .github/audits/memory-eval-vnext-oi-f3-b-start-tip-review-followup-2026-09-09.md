# memory-eval vNext — V 사전검증 독립 검토 후속 정정·발행 결속 기록

## 1. 상태와 효력 범위

**DRAFT — PSV-F1–F4의 사실 정정·처리방침 및 V 발행 이력 전사. 새 승인 receipt가 아니다.**

사용자의 “네. 후속 기록 작성해주세요.” 지시에 따라 Codex가 작성했다.
기존 V의 두 원문을 수정하지 않고 이 별도 기록에서 정정 내용을 설명한다.
새 요구사항·API·호환성 예외·구현 범위·사람 승인을 결정하지 않는다.
문서 작성 지시는 이 문서의 내용에 대한 사람 서명이나 commit/push/PR/병합 지시가 아니다.

이 기록은 quality-documentation-manager의 지적별 disposition·변경 이력 원칙을
한정 적용한다. 의료 QMS 절차·새 승인 체계·전자서명·암호학적 receipt를 도입하지 않는다.
기존 .github/audits/의 한국어 감사 기록과 Git 원문 보존 관례를 따른다.

~~~yaml
recordKind: oi_f3_b_prestart_review_followup
recordStatus: draft_factual_corrections_and_publication_binding
preparedBy: Codex
preparedDate: "2026-09-09"
preparedTimezone: Australia/Brisbane
reviewedRecordCommit: bb9e1cd4638b01a731a145da373d40dd3391f9d0
historicalValidatedTip: 15dd94f7f9e96aa815cca1034f1c1abf24d993a8
reviewReportSha256: 7a36dde69714c87bd09be7e309d63ff1d15ed9eb4a66a107110891c8ee4e1b3a
originalReviewVerdict: PASS_WITH_WARNINGS
originalReviewFindingCounts: {P1: 0, P2: 0, P3: 4}
findingIds: [PSV-F1, PSV-F2, PSV-F3, PSV-F4]
dispositionScope: author_corrections_in_separate_record
originalVBytesEdited: false
approvedPackageOrReceiptBytesEdited: false
thisFollowupIndependentlyReviewed: false
externalFindingClosureDeclared: false
newHumanApproval: false
approvedBy: null
approvedAt: null
implementationStartAuthorizedByThisRecord: false
gitPublicationAuthorizedByCurrentInstruction: false
recordCommitAtPreparation: null
~~~

위 메타데이터는 작성 시점의 사실이다. 이후 별도 제출 지시로 발행되더라도
과거 시점의 null/false를 소급 채우지 않고 실제 Git identity를 외부에서 결속한다.

## 2. 검토 대상·보고서·승인 근거 결속

| 역할 | 고정 identity |
|---|---|
| 검토된 기록 commit V | bb9e1cd4638b01a731a145da373d40dd3391f9d0 |
| V의 유일한 parent / 검증된 tip T | 15dd94f7f9e96aa815cca1034f1c1abf24d993a8 |
| 승인된 PB 수정본 R1 | f84036a4c86f7d3f91dcd9592f8137bb5cb16f6b |
| PB 승인 receipt commit A | 11eac3f29b432ab721fe40ef6acb68918a1758d2 |
| 작성 시 HEAD | V (위 40자 SHA), tracked/index clean |
| 작성 branch | codex/memory-eval-vnext-oi-f3-b-start-tip-revalidation |

| V에 고정된 파일 | raw SHA-256 |
|---|---|
| [사전검증 Markdown](memory-eval-vnext-oi-f3-b-start-tip-revalidation-2026-09-08.md) | a1ab9315829d7db115de1a8b1492ffc6a7fdba55380835bf1fffdb1ca47004dd |
| [사전검증 JSON](evidence/memory-eval-vnext-oi-f3-b-start-tip-revalidation-2026-09-08.json) | af88c5532e4e84a783d3fa89c20cdc489c74689edfb98aa9c6eeadd483fb4577 |

각 경로는 .github/audits/ 기준이며 위 hash는 V의 Git blob raw bytes에 귀속한다.
V의 parent=T, T..V=두 파일 추가뿐이라는 구조와 두 hash를 다시 확인했다.

독립 검토 보고서:

- 제출자/검토 도구: 사용자가 전달한 Claude 최초 독립 검토 보고서.
- locator: C:/Users/Vyper/.codex/attachments/487641df-ce72-4c70-ba45-facb55d8c31c/pasted-text.txt
- raw SHA-256: 7a36dde69714c87bd09be7e309d63ff1d15ed9eb4a66a107110891c8ee4e1b3a
- 크기: 10,218 bytes. 보고서 원문은 이 파일에 복사·편집하지 않았다.
- 보고서 판정: PASS_WITH_WARNINGS, P1 0/P2 0/P3 4, 새 차단점 없음.
- 보고서는 V의 한정 PASS_WITH_RETAINED_RESIDUALS/preStartRevalidationComplete를
  상위 계약에 맞는 것으로 판단했다. 이는 이 후속 기록의 독립 검토 결과가 아니다.
- 로컬 첨부는 별도 보관 증거다. Git clone만으로 첨부 원문이 제공되는 것은 아니며,
  hash는 내용 식별자이지 서명·작성자 인증·과거 행위의 독립 증명은 아니다.

기존 [PB 승인 receipt](memory-eval-vnext-oi-f3-b-approval-2026-09-08.md)의 raw SHA는
03286ef63c1cba204254592535d1ab7fa7e2e47665fd0eee215e6e910ba0ad32다.
그 승인은 R1의 package Markdown a2241c6f48dc79d43ebf159494bdeadbf06c0e86de6db05fdcff4f00a77be9a9,
package JSON 3e400844dbdda306b5697f40328e673f7d037a5e84cf2124b1193f301a703399를 대상으로 한다.
V·검토 보고서·이 후속 기록의 hash를 승인한 것처럼 읽지 않는다.
기존 S2 approvalCommit 3f14afb29eddc243640fdb0a5a4f604646ade9f0를 이번 A로 치환하지 않는다.

## 3. 지적별 처리방침

| ID | 심각도 | 이 기록에서의 처리 | 확인 수준 |
|---|---|---|---|
| PSV-F1 | P3 | 집계 설명 정정, inventory 경로 필터·optional 정의 보완 | 현재 V checkout에서 독립 재계산 |
| PSV-F2 | P3 | npm 전체 출력 SHA를 당시 비결정적 관측으로 한정 | Claude 관측과 V 원자료 대조; 이번에는 npm ls 미재실행 |
| PSV-F3 | P3 | discovery 목록/digest 산식 명시 | 저장된 목록 산식 재계산 및 runner 선택 규칙 대조 |
| PSV-F4 | P3 | 과거 미발행 상태와 이후 별도 지시에 의한 V 발행을 분리 결속 | Git object·사용자 대화 전사·원격 ref 읽기 관측 |

네 지적은 모두 작성자가 수용해 이 별도 문서에 반영한다.
이는 author-addressed 상태이며 Claude의 확인 검토나 외부 closure 선언이 아니다.
원 V의 판정·관측 bytes·원래 잘못된 설명도 역사 기록으로 그대로 남는다.

### 3.1 PSV-F1 — 927/924 집계와 inventory 산식

정정 대상: V Markdown §5의 “과거 927개 집계…link 3개를 별도로 센 것” 설명,
V JSON /environment/countExplanation 및 /environment/inventoryHashFormat.

현재 V의 lock과 설치 경로를 2026-09-08T23:56:36Z에 다시 읽은 결과:

| 집합 | 개수 | 정의 |
|---|---|---|
| 기존 non-root/non-link 존재 항목 전체 | 927 | lock.packages 중 빈 root key와 link 항목 제외, 해당 package.json 존재 |
| inventory digest 대상 | 924 | 위 항목 중 path가 정확히 node_modules/로 시작 |
| 별도 workspace 디렉터리 항목 | 3 | apps/mobile, packages/chat-core, packages/ui-tokens |
| 별도 workspace link 항목 | 3 | node_modules/@tomverse/mobile, @tomverse/chat-core, @tomverse/ui-tokens |

**927 = node_modules/ 하위 non-link 924 + workspace 디렉터리 3**이다.
link 3개를 927 안에 포함했다는 V 설명은 잘못됐다. link는 별도 항목이며
같은 workspace의 디렉터리와 link를 독립 설치 package로 중복 계산하지 않는다.
설치 누락 3개나 새 설치·삭제가 생겼다는 뜻도 아니다.

V에 기록된 inventory digest의 정확한 재현 규칙은 다음과 같다.
이는 이 digest의 산식 설명이며 새 의존성 허용·필수 누락 판정 규칙이 아니다.

1. T의 package-lock.json Git blob을 strict UTF-8로 JSON.parse한다.
   V의 lock blob은 T와 같다. packages 객체의 원래 property 삽입 순서를 유지한다.
2. Object.entries(lock.packages)를 그 순서대로 순회한다.
3. key path가 node_modules/로 시작하고, entry.link가 truthy가 아니며,
   현재 그 경로의 package.json이 존재하는 항목만 선택한다.
   빈 root key, workspace 디렉터리 key, link, 미설치 항목은 이 digest에 넣지 않는다.
4. 각 행의 property를 다음 순서로 만든다:
   path, expectedVersion, actualVersion, packageJsonSha256, optional.
   path는 lock key(/ 구분자), expectedVersion은 entry.version,
   actualVersion은 실제 package.json의 version,
   packageJsonSha256은 그 파일 raw bytes의 소문자 hex SHA-256이다.
   optional은 Boolean(entry.optional)만 사용하며 devOptional을 OR하지 않는다.
5. 행 또는 key를 추가 정렬하지 않는다. JSON.stringify(rows)의 압축 문자열을
   UTF-8/BOM 없음/끝 LF 없음 bytes로 인코딩한 뒤 SHA-256을 계산한다.

이 규칙으로 924행 digest
b40c13271460a42425d3630abf9c0c444da312f1a4e89a9f2396e00737909f74가 재현됐다.
예를 들어 node_modules/typescript는 devOptional=true이나 entry.optional 부재이므로
이 행의 optional=false다. devOptional을 digest에서 사용하지 않는 것과 dependency의
실제 설치 필수성·플랫폼 제외 판단은 별개다.
이 재계산은 package.json/version inventory이며 전체 설치 파일/tarball 무결성 감사가 아니다.
현재 재현 결과를 과거 설치 상태 자체의 독립 증명으로 소급하지 않는다.

### 3.2 PSV-F2 — npm ls 전체 출력 hash의 의미

정정 대상: V JSON /environment/npmLs/outputSha256, V Markdown §5의 npm 진단 설명.

Claude 보고서는 같은 환경에서 overridden 값이 달라져 두 번의 전체 stdout SHA가
달랐다고 기록한다. 두 번째 값은 V의
371be4a05005ebcb6f3de3629cce2fe154d0469eba06a7d281f70d419c23fd9f와 일치했다.
이번 후속 작업은 npm ls를 다시 실행해 그 비결정성을 직접 재현하지 않았다.

V의 outputSha256은 **그 실행에서 수집한 출력 bytes의 관측 식별자**로만 유지한다.
동일 설치 상태에서 항상 재현되어야 하는 fingerprint, 설치 무결성 gate, 과거/현재
동일 상태의 충분조건으로 사용하지 않는다. 다음 실행의 전체 hash 불일치만으로 실패를
판정하거나 의존성을 설치·제거·dedupe하지 않는다. 과거 bytes/hash도 삭제하지 않는다.

비교할 진단은 exit=0, error=null, problems의 이름·version·실제 경로를 정규화해 해석한
동일 항목 여부다. V와 Claude 보고서에는 다음 기존 두 항목이 있다.

- extraneous @emnapi/runtime 1.11.3
- extraneous @img/sharp-wasm32 0.35.4

두 physical path가 T lock에 optional=true와 같은 version으로 존재한다는 설명을
보존한다. problems를 숨기지 않으며 logical-tree label과 lock/version mismatch를
구분한다. 전체 stdout hash의 비결정성을 다른 고정 bytes hash까지 일반화하지 않는다.
새 정규화 digest나 임의 성공 판정 알고리즘은 이번에 만들지 않는다.

### 3.3 PSV-F3 — discovery digest 산식

정정 대상: V JSON /execution/discovery/serverListSha256, clientListSha256.

목록의 의미는 기존 scripts/run-unit-tests.mjs의 discovery다.
server는 tests/ 바로 아래 .test.mjs 또는 .test.ts 파일명, client는 tests/client/ 바로
아래 .test.tsx 또는 .test.ts 파일명이다. 재귀 탐색하지 않는다.
각 파일명을 JavaScript 기본 .sort() 순서로 정렬한 다음, / 구분자의 저장소 상대
경로(server는 tests/, client는 tests/client/ 접두사) 목록으로 표현한다.
JSON의 server/client 배열은 이 상대 경로 목록이지 실행 시 절대 경로 argv가 아니다.

산식은 두 목록 각각에 대해 다음과 같다(정의식이지 추가 test 실행 지시가 아니다).

~~~text
listSha256 = lowercaseHex(SHA256(UTF8(list.join("\n") + "\n")))
~~~

BOM 없음, 항목 사이 LF 한 개, 최종 LF 한 개, 따옴표·공백·CR·JSON 배열 문법 없음이다.
저장된 목록의 순서가 discovery와 맞는지 먼저 확인하고 digest를 계산한다.

| 목록 | 항목 수 | 재계산된 SHA-256 |
|---|---|---|
| server | 632 | 33b8d45ae20b1ac169b69c809dd2a3551247426742d8ecab539c7bb1beba7565 |
| client | 4 | 88e7df406f7efb10b2784770fbfda4252555818e796137d3ec9a99bc76d8dd40 |

quoted 절대 Windows 경로를 공백으로 결합한 39,347자 관측은 별도 계산이다.
상대 경로 목록 digest에 절대 경로·quote·공백을 넣지 않는다.
목록 재현은 전체 unit 실행 성공, T01의 40 unit 통과, B19 충족을 뜻하지 않는다.

### 3.4 PSV-F4 — 작성 당시 상태와 이후 발행을 분리

정정 대상: V Markdown §1·§8의 미발행/HEAD=T 표현 및
V JSON /authorization/gitPublicationAuthorized=false.

위 값들은 **V 원고의 사전검증 작업 당시** 상태다. 미래 발행을 금지하는 영구 정책이나
원고 자체가 이후에도 미발행이라는 현재 상태 주장이 아니다.
발행 권한과 관측은 다음처럼 별도로 결속한다.

| 순서 | 근거·행위 | 경계 |
|---|---|---|
| 원고 준비 | T checkout의 한정 사전검증과 두 기록 작성 | 당시 새 commit 없음, Git publication 권한 없음 |
| 별도 사용자 지시 | “해당 검증 커밋 및 푸시해주시고 독립 검토를 위한 프롬프트 작성해주세요.” | 두 검증 기록 발행 및 전달 프롬프트 작성 지시; 구현 지시 아님 |
| V commit | 2026-09-08T13:12:14Z, subject Record OI-F3 B start-tip revalidation, 유일 parent=T, 두 파일 A | 위 V의 실제 Git object로 확인; 원고 bytes 불변 |
| V push | 이전 작업의 push 성공 및 원격 branch=V 확인 기록; 이번에도 같은 ref를 재조회 | 과거 push의 정확한 서버 수신 timestamp를 별도로 입증하는 것은 아님 |
| 이번 사용자 지시 | “네. 후속 기록 작성해주세요.” | 이 한 파일 작성·필요한 한정 검증만; 새 commit/push/PR 지시 없음 |

사용자 지시 문구는 이 대화의 전사다. 독립 서명·인증된 GitHub 승인 receipt로
가장하지 않고, 사용자 메시지에 없는 정확한 지시 timestamp도 만들지 않는다.

원격 branch refs/heads/codex/memory-eval-vnext-oi-f3-b-start-tip-revalidation는 이번
읽기 조회에서도 V였다. 당시 함께 조회한 develop은
a2c55d582ae23811b52f3ba943c2c2d363e9f237이었다.
이는 **가변 ref의 이번 관측**이며 최신 develop 지원9/환경/CI를 재검증한 것이 아니다.
V 발행 때 관측한 af730f95…와 이번 값도 구별한다. checkout/fetch/rebase/merge하지 않았다.

## 4. 그대로 남는 권한과 잔여

이 기록과 V 최초 독립 검토의 통과 판정은 새 사람 승인·독립 확인 검토·구현 완료가 아니다.
PB R1 CONFIRMED의 1/1 회차는 그대로 소진 상태이며 PSV 검토로 초기화하지 않는다.
현재 후속 문서에는 독립 확인 검토나 사람이 한 새 승인 판정을 기록하지 않는다.

- 실제 구현 착수에는 별도 명시 지시가 필요하다. T와 다른 tip/환경에서 시작하면
  실제 선택 tip의 지원9·환경·승인 bytes/계보·CI를 다시 결속한다.
- Claude가 권고한 B19의 기존 40 unit 기준선 증거는 실제 착수 지시 이후,
  승인된 변경을 시작하기 전 첫 검증 증거로 확보할 사항으로 남긴다.
  이 권고를 이번에 시험 실행·runner 변경을 승인한 것으로 해석하지 않는다.
  실행 경로가 별도 권한을 요구하면 임의 우회·설정 변경 대신 그 경계를 먼저 해결한다.
- T의 CI 증거는 E2E/DB integration이며 로컬/CI 전체 unit 통과를 주장하지 않는다.
  AC-12/B24 전체 완료=false, B01–B23 미실행, fullF07Satisfied=false를 유지한다.
- 미래 exact5파일 C01 canonicalJson.ts/C03 signatures.ts/C04 trust.ts
  (lib/memoryEvalVnext/protocol/), T01 tests/memoryEvalVnextWire.test.mjs,
  T11 tests/fixtures/memory-eval-vnext/wire-vectors.json만 기존 승인 범위다.
  C02 lib/memoryEvalVnext/protocol/wire.ts는 read-only다.
- OI-F1 timing gap/closure=false, OI-F2 별도 ID/path, OI-F4 별도 runner,
  ODR-F1 외부 closure 없음, 상위54 AC partial9/deferred45/fullySatisfied0은 불변이다.
- source/dataset/manifest/register/prompt/flags/release gate, scorer/ledger/full P,
  key/trust 운영, S2 activation, holdout/S5, pair/예산/dispatch/provider/DB 호출은 범위 밖이다.
  memoryExtractionEnabled/memoryInjectionEnabled 운영값은 조회하지 않았다.
- 원고 작성·검토·발행은 임의 JavaScript sandbox 보장이나 Proxy 거절 구현 충족의 증거가 아니다.

## 5. 이번 작성 작업의 검증

직접 수행한 재계산과 검토 보고서의 관측을 §3에서 구별했다.
기존 결속 대상41개(문서35·protocol/test/fixture6)의 V Git raw hash를 다시 대조했다.
지원9·V 두 파일·기존 untracked24/ignored3·검토 보고서 등 총80개 고유 파일의
working raw hash를 작성 전 보존 기준선으로 수집했다.
.claude/·.codex/ 디렉터리 전체를 재귀 수집하거나 수정하지 않았다.

작성 전 V tracked-clean 상태에서 package.json의 다음 script7개를 그대로 실행했다.
전부 exit0, 기준선 실패 이름0이다. 이 후속 기록은 원격 최신 tip 재검증이 아니다.

| npm script | 작성 전 | 작성 후 | 출력 SHA-256 (전후 동일) |
|---|---|---|---|
| check:encoding:strict | 0 | 0 | 7d5195263cb38b5aa0de4bf8e0ead06774933b4e124616518883574554bcd380 |
| check:policy-section-references | 0 | 0 | d8946376913edc36b8e1689a247a0d5fe8cfac046f0b8938fb7d599115a9f775 |
| check:release-records | 0 | 0 | 5d216eabba9f6eb6762717a31e2bc3c26172d530ed554ab099a9c21a537f3565 |
| check:memory-eval-succ9 | 0 | 0 | f792af65d17e277fecceedf03b5eaba6484180748d3013de077a027a005e194c |
| check:memory-extraction-eval | 0 | 0 | 575a56bac68f5e261286b5e00894451bd0fb1b7b5cead22e49d8d8f28315629b |
| check:memory-eval-freeze | 0 | 0 | 8318af98d6c2a2ce9ca9f2d7c0d9b4acc70cc97ee7555b8dc026a4fb5b10cca1 |
| check:doc-references | 0 | 0 | 802e87ecace9622f4c5c8a928ce9604a192300c7a80a4dfae05db21bbd0cd62d |

검사 위치는 로컬 PC의 PowerShell, H:/Project/ai-chat-hub이며 기존 설치를 사용했다.
production 자격증명 없이 child 환경 allowlist와 존재하지 않는 DOTENV_CONFIG_PATH를
사용했다. 환경변수는 해당 child에만 적용했고 .env·provider/DB 비밀을 읽지 않았다.
npm/tsx의 통상 cache·로그 외 설치·설정·keygen·signing·운영 호출은 하지 않았다.

작성 후 같은 script7개를 실행해 전부 exit0, 출력 SHA 전후7/7 동일을 확인했다.
기준선/작성 후 실패 이름은 모두0이며 새 실패도0이다.
표의 출력 SHA는 해당 실행 stdout bytes 뒤에 stderr bytes를 붙여 계산했다.
이는 위 npm ls 전체 출력과 다른 검사별 관측이며 영구 결정성을 보장하는 값은 아니다.
audit 문서는 doc-reference/policy 일반 검사에서 제외되고 release-records는 release-*만
검사하므로 별도 fatal UTF-8·fenced YAML parse·상대 링크·hash/산식 대조·whitespace 검사를 했다.
untracked인 새 파일은 일반 git diff에 나타나지 않으므로 no-index --check로도 검사한다.

2026-09-09T00:03:58Z 본문 작성 후 보존/수동 검사 통과: 보호80개 raw hash 불변,
HEAD=V, tracked/index clean, 추가 파일은 이 Markdown 한 개뿐이었다.
fatal UTF-8/YAML, 상대 링크3개, 기존 hash10종, discovery 목록·산식, diff --check와
신규 파일 no-index --check가 통과했다. 이 결과 전사 뒤에도 같은 검사를 재확인한다.
이 파일 외 신규 산출물은 만들지 않았으며 stage/commit/push/PR/구현은 수행하지 않았다.
이 문서의 후속 발행도 별도 지시를 받아 수행하며, 작성 시점의 미발행 상태는 과거 사실로 보존한다.
