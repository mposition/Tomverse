# memory-eval vNext — OI-F4 V 문서 검토 잔여 수용 승인 기록

**decision: yes — PASS_WITH_WARNINGS의 정보성 잔여를 사람이 수용하여 V 문서 검토를 마무리한다.**
승인자: mposition. 승인일: 2026-09-10.
기록 작성자: Codex. 작성일: 2026-09-10.

## 1. 실제 회신과 승인 의미

사용자에게 제시한 질문은 다음과 같다.

> 이 정보성 잔여를 수용하고 `PASS_WITH_WARNINGS`로 문서 검토를 마무리할까요?

사용자는 다음과 같이 회신했다.

> 승인합니다.
> 승인자: mposition
> 승인일: 2026-09-10
>
> 커밋/푸시/PR까지 작업해주세요.

이 문서는 위 회신을 V 두 exact 문서와 최종 독립 확인의 정보성 잔여에 결속하는
**authoritative human acceptance receipt**다. 사람의 문서 검토 수용이지 외부 검토자의
무조건 PASS, 구현 착수 지시, OI-F4 기술적 closure 또는 새 정책 승인이 아니다.
외부 최종 판정은 **PASS_WITH_WARNINGS / 차단 0건**으로 유지한다.
무조건 PASS를 얻지 못했다는 사실과 검토자의 미검증 범위를 숨기거나 소급 변경하지 않는다.

승인일은 사용자가 제공한 날짜다. 정확한 승인 시각·timezone instant는 제공되지 않아 null이다.
위 인용은 대화 전사이며 원시 채팅 bytes hash·암호학적 서명·신원 인증 증명이 아니다.
마지막 문장은 이번 승인 기록과 관련 검토 자료의 commit/push/PR 제출 지시로 분리한다.

~~~yaml
recordKind: oi_f4_start_tip_revalidation_review_acceptance_receipt
recordStatus: human_accepted_with_informational_residuals
isAuthoritativeApprovalReceipt: true
repository: mposition/Tomverse
repositoryBasis: aafdceca3e4270ff146077c02f480ba3fd68c9f4
reviewCommit: 1f34a6fb0d61b8704d656fee7638a93c9ef42c75
approvalTargetCommit: 1f34a6fb0d61b8704d656fee7638a93c9ef42c75
runnerPackageApprovalCommit: 2a8609feeb4ea19c3793e6b968601b060432fa67
decision: "yes"
approvedBy: mposition
approvedAt: "2026-09-10"
approvedAtInstant: null
acceptanceScope: v_document_review_with_disclosed_informational_residuals_only
externalReviewVerdict: PASS_WITH_WARNINGS
externalBlockingFindings: 0
unqualifiedExternalPassAchieved: false
independentReviewSessionsCompleted: 3
acceptedInformationalIds: [V-F3, W-1, X-1]
acceptedEvidenceLimits:
  authorPreparedSingleHostTransport: true
  railwayHistoricalStagingNotIndependentlyRequeried: true
  gitConfigActorAndWholeFileProvenanceUnresolved: true
documentationReviewHumanAcceptanceComplete: true
thisReceiptIndependentlyReviewed: false
newReviewerVerdictIssuedByThisReceipt: false
implementationStartAuthorizedNow: false
oiF4ClosureDeclared: false
fullUnitSuitePassed: false
activationAuthorized: false
additionalPaidReviewAuthorizedByThisReceipt: false
gitPublicationAuthorizedByCurrentUserMessage: true
prSubmissionAuthorizedByCurrentUserMessage: true
mergeAuthorizedNow: false
autoMergeAuthorizedNow: false
approvalReceiptCommit: null
~~~

approvalTargetCommit은 V 두 문서를 식별한다. 아래 검토 보고서 hash를 V 문서 hash로 대용하지 않는다.
이 receipt의 실제 commit은 이 파일을 추가한 Git commit의 40자 SHA로 사후 식별한다.
자기 SHA·미래 CI 성공·병합 결과를 문서 안에 미리 발명하지 않는다.
이 기록은 기존 승인 내용을 변경하지 않는 회신 전사이며, 이 receipt 자체의 독립 검토는 미실시다.

## 2. 고정 대상과 승인 계보

| 역할 | 40자 commit SHA |
|---|---|
| V의 작성 basis / PR #1323 merge tip T | aafdceca3e4270ff146077c02f480ba3fd68c9f4 |
| 재검증 기록 V, 유일 parent = T | 1f34a6fb0d61b8704d656fee7638a93c9ef42c75 |
| 승인된 WR-1 | 52beb7de9c1cb949677c5db306ffd6425a89ea46 |
| 기존 runner 패키지 사람 승인 AWR | 2a8609feeb4ea19c3793e6b968601b060432fa67 |
| PR #1323 동기화 head | 2ce7b59606c582169fa3de07528d93598a259923 |
| 최초 decision approval A | 3f14afb29eddc243640fdb0a5a4f604646ade9f0 |
| S1–S4 통합 승인 CA | 80842e62925c05af9450e6acc6ceb70b56f67655 |

위 상위 commit들은 V의 조상이다. V 자체의 T 대비 변경은 다음 두 파일 A뿐이며,
이후 검토 자료와 이 receipt의 추가를 V 원래 tree의 변경으로 표현하지 않는다.

| 수용 대상 path | V Git blob OID | raw SHA-256 | bytes / LF |
|---|---|---|---|
| [.github/audits/memory-eval-vnext-oi-f4-start-tip-revalidation-2026-09-10.md](memory-eval-vnext-oi-f4-start-tip-revalidation-2026-09-10.md) | 95c1e848182bbcaa4e0abaf63597e1955f3f758d | 452d7b80399d2eff66f5ed32998ba6d1a1a7544af9e5533ec07eb810cc4fc16c | 19606 / 281 |
| [.github/audits/evidence/memory-eval-vnext-oi-f4-start-tip-revalidation-2026-09-10.json](evidence/memory-eval-vnext-oi-f4-start-tip-revalidation-2026-09-10.json) | e46a1271afde8868927fdd032cae859092c03b43 | 20d7e09d66cd1f7f3bd2a3c2c0938e643bd785d7f2194cd6a68d57e70208df87 | 197254 / 3296 |

V JSON.document.rawSha256은 위 Markdown만 가리킨다. JSON 자기 hash,
검토 보고서 hash 또는 이 승인 receipt hash가 아니다. V Git/working bytes는 동일하다.

기존 승인 원문도 별도로 보존한다.

| 상위 문서 | raw SHA-256 |
|---|---|
| [WR-1 패키지](memory-eval-vnext-oi-f4-runner-approval-package-draft-2026-09-10.md) | 420f8876d9e6e472345ff5a953ea446db16a862b48b28242fa460de14ac80381 |
| [WR-1 evidence](evidence/memory-eval-vnext-oi-f4-runner-approval-package-2026-09-10.json) | ccc42634c68571878572eb24c4b6b6890fd334712f3c88050eb318ba2fc5ece5 |
| [WR-1 승인 요청](memory-eval-vnext-oi-f4-runner-approval-request-draft-2026-09-10.md) | 37b17d9f0a3dea1450a3f16cc38ed7ab5bb05cd06770b854fbf830cd7b3a7220 |
| [AWR 승인 receipt](memory-eval-vnext-oi-f4-runner-approval-2026-09-10.md) | c1c919a8cc1b08ebd75ca581283f4af2dd0b66e9d7a16e6759bee683339adc3f |

최초 decision의 Git raw SHA-256은
355f8387808b8a7ea86e02ecffc4303562b5ab5c43c27fef0c2bdb2bf57e89da,
400 LF/§13 공란 그대로다. 과거 승인·상위 잔여와 D<K<activationApprovalCommit<C를 치환하지 않는다.

## 3. 검토 원문·후속 처리 이력의 exact 결속

다음 10개는 검토 당시 또는 사후 관측 당시 bytes로 보존한 관련 자료다.
새 파일명으로 내용을 고쳐 재발급하지 않고 이번 receipt와 함께 Git 이력에 추가한다.
로컬 temp helper/raw-result locator는 그때 사용한 경로이며, 영구 서비스나 원격 재실행 보장은 아니다.

| 역할 | 경로 (.github/audits/ 기준) | raw SHA-256 |
|---|---|---|
| 최초 검토 프롬프트 | [memory-eval-vnext-oi-f4-start-tip-independent-review-prompt-2026-09-10.md](memory-eval-vnext-oi-f4-start-tip-independent-review-prompt-2026-09-10.md) | 57314590d7a96aea15be32ba9aa3f340b5412a5b5ee33f7fd5491af62c7e6bf8 |
| 최초 Claude 보고서 | [memory-eval-vnext-oi-f4-start-tip-independent-review-2026-09-10.md](memory-eval-vnext-oi-f4-start-tip-independent-review-2026-09-10.md) | e654ea05778efe170624e941fc7b14cb304bc8f9f553a242c879943c01fb62ac |
| 최초 실행 및 작성자 관측 | [evidence/memory-eval-vnext-oi-f4-start-tip-review-execution-2026-09-10.json](evidence/memory-eval-vnext-oi-f4-start-tip-review-execution-2026-09-10.json) | b9de45050981e9391ce30ea15caa59a13624e57faf3b5894d33f325b7e712d5a |
| 작성자 경고 후속 근거 | [memory-eval-vnext-oi-f4-start-tip-review-followup-2026-09-10.md](memory-eval-vnext-oi-f4-start-tip-review-followup-2026-09-10.md) | 6a6eb399abcd3edff013c835a83eae51a3cc021c27d6f86988637ffc8520aea9 |
| 1차 확인 프롬프트 | [memory-eval-vnext-oi-f4-start-tip-confirmation-review-prompt-2026-09-10.md](memory-eval-vnext-oi-f4-start-tip-confirmation-review-prompt-2026-09-10.md) | dc1fb55fb252747fcfa52f22b8b11c2c14c206b57da8af4315a73b6fa2f2c8d0 |
| 1차 Claude 확인 보고서 | [memory-eval-vnext-oi-f4-start-tip-confirmation-review-2026-09-10.md](memory-eval-vnext-oi-f4-start-tip-confirmation-review-2026-09-10.md) | 2c4fa62536a9ecfbdd19ad46001e485da50998253e0c3ee8a6b4cc7026b3d560 |
| 작성자 판정 범위 명확화 | [memory-eval-vnext-oi-f4-start-tip-review-scope-clarification-2026-09-10.md](memory-eval-vnext-oi-f4-start-tip-review-scope-clarification-2026-09-10.md) | 3d42f22372b0daff741e777519569850671ca7e75f3b9b85afbca3526b0b1485 |
| 2차 확인 프롬프트 | [memory-eval-vnext-oi-f4-start-tip-scope-review-prompt-2026-09-10.md](memory-eval-vnext-oi-f4-start-tip-scope-review-prompt-2026-09-10.md) | 07a467bc6055e5076dcd36f8fbdc0690478410a306997a5b271ba56fc259f906 |
| 최종 Claude 확인 보고서 | [memory-eval-vnext-oi-f4-start-tip-scope-review-2026-09-10.md](memory-eval-vnext-oi-f4-start-tip-scope-review-2026-09-10.md) | 621948f655804bc7808d3372074f7983774b59e04795efe35862f99607eb7ad8 |
| 후속 2회 실행·방법·보존 기록 | [evidence/memory-eval-vnext-oi-f4-automatic-review-followup-execution-2026-09-10.json](evidence/memory-eval-vnext-oi-f4-automatic-review-followup-execution-2026-09-10.json) | 3fe316433542d583cd3e5b9191a2eb8f68830760dc0b2b73c49802eb286f2a83 |

세 Claude 보고서는 각 CLI 결과의 result 텍스트와 끝 LF 한 개를 파일로 보관한 것이다.
보고서 파일 hash는 전체 CLI raw-result JSON hash가 아니다. 실행 JSON은 세션·도구·관측·
방법 한계의 작성자 기록이며 독립 검토자의 판정 원문과 구별한다.
작성자 후속 note 두 개 역시 외부 판정이나 사람 승인이 아니다.

| 검토 | session ID | 결과 | list-price equivalent USD |
|---|---|---|---|
| 최초 1회 승인에 따른 검토 | 0734a18a-4242-4e52-b36d-6abb06290df3 | PASS_WITH_WARNINGS, 차단 0 | 3.2222155 |
| 추가 자동 진행 지시에 따른 1차 확인 | 46c3af60-f6f4-44a4-8ac9-0d9fb42d984c | PASS_WITH_WARNINGS, 차단 0 | 3.2689535 |
| 추가 자동 진행 지시에 따른 2차 확인 | 2b7d0f97-1a57-465c-8229-1b7c197f7d4c | PASS_WITH_WARNINGS, 차단 0 | 3.284222 |

세션 수는 총 3회(최초 1 + 후속 2)다. 추가 두 회의 환산 합계는 USD 6.5531755이며
실제 계정 청구 금액을 관측한 값은 아니다. 이번 승인 전사는 새 유료 검토 실행이 아니다.

V와 실행 JSON의 recordCommit:null, publicationPerformed:false, humanApprovalIssued:false,
미commit/untracked/승인 대기 표현은 각각 작성 당시 사실로 불변 보존한다.
현재 사람 수용은 이 receipt에만 결속한다. 과거 문서에 true/PASS/서명을 채우지 않는다.
외부 보고서의 최초 판정이나 당시 미검증을 후속 관측으로 소급 삭제하지 않는다.

## 4. 사람이 수용한 disposition과 남는 한계

| ID / 항목 | 최종 외부 판단과 이번 수용 |
|---|---|
| V-F1 | CLOSED. 시점별 config 차이의 해시 투영 설명을 확인했다는 뜻이다. 변경 actor 규명 또는 과거 전체 bytes 보존 PASS가 아니다. |
| V-F2 | CLOSED. temp 도구 경로 보완 후 수치·목록·환경 metadata를 재관측하고 교차계산했다. 설치 전체 bytes integrity 승인이 아니다. |
| V-F3 | RETAINED_INFORMATIONAL. reviewer 지정 query와 작성자 script 재실행은 구별되지만 모든 transport는 작성자 준비·단일 호스트다. 외부 독립 oracle 부재를 사람이 수용한다. |
| W-1 | RETAINED_INFORMATIONAL. 최초 config 추측 문구는 원문에 남기고 별도 후속 정정과 함께 읽는다. 원문 덮어쓰기 없이 수용한다. |
| W-2 | CLOSED. V head의 PR #1328 CI 11/11 success를 reviewer가 고정 REST GET으로 확인했다. 실제 실행과 docs-only skip을 구별한다. |
| W-3 | CLOSED. helper raw hash 병기를 확인했다. helper가 독립 외부 oracle이라는 뜻은 아니다. |
| X-1 | P3 정보. 1차 확인의 기존 Windows 실패 인용은 운영/구현 잔여와 문서 결함을 혼동할 소지가 있었다. 최종 확인의 구분을 함께 수용하며 1차 verdict는 보존한다. |

CLOSED는 해당 외부 검토의 disposition 전사다. 이 receipt가 새로운 외부 closure를 발급하지 않는다.
사람은 V-F3/W-1/X-1 및 아래 증거력 한계를 명시한 상태로 문서 검토 마무리를 수용했다.

- Railway의 과거 staging snapshot 주장은 이번 Claude 경로에서 독립 재조회되지 않았다.
  현재 active/production 배포 인증을 얻었다는 뜻이 아니다.
- .git/config의 변경 actor·전체 내용/bytes 보존은 미확인이다.
  시점별 section/merge ref 투영이 해시를 재현해도 오래된 provenance 예외는 해소되지 않는다.
- reviewer가 고른 query의 두 번째 계산 경로와 runner 원문 대조는 확보했으나,
  모든 transport가 작성자 준비·단일 호스트인 신뢰 가정은 남는다.
- 최종 보고서가 명시한 재조회·도구 소스 열람 생략 등 세션별 미검증도 그대로 수용한다.
  설치 metadata 일치와 설치 파일 전체 integrity·Prisma 생성물·운영 readiness는 다른 사실이다.

기존 Windows ENAMETOOLONG, cache-wiring 1건 실패는 **운영/구현 잔여이지 V 문서 결함이 아니다**.
이를 해결했다고 주장하거나 미래 assertion 실패를 미리 기존 실패로 분류하지 않는다.
정보성 잔여의 사람 수용은 미검증 사실의 검증 완료 전환이나 OI-F4 기술적 closure가 아니다.

## 5. 제출 범위와 계속 닫힌 권한

이번 commit 범위는 이 receipt 1개와 §3의 기존 관련 자료 10개, 총 11개 A뿐이다.
V 두 원문은 이미 V에 들어 있으며 byte 변경 없이 보존한다. PR 전체 추가 범위는
T 기준 V의 2개와 이번 11개를 합친 13개 감사 문서/JSON이다.
기존 develop 대상 [PR #1328](https://github.com/mposition/Tomverse/pull/1328)에 반영하며
중복 PR, rebase/amend, auto-merge 또는 병합을 수행하라는 지시가 아니다.

AWR의 WR-D1–WR-D5 및 실제 착수 조건은 불변이다. 이번 승인은 별도 명시적 구현 착수 지시가 아니다.
미래 구현 allowlist는 scripts/run-unit-tests.mjs 수정, scripts/run-unit-tests-core.mjs 신규,
tests/unitTestRunner.test.mjs 신규 세 파일뿐이며 이번에는 모두 변경하지 않는다.
후속 병합 지시가 있다면 원 SHA를 보존한 merge commit 및 해당 develop tip CI 확인이 필요하다.
실제 착수 tip·지원 파일·환경이 달라지면 그 차이를 재검증하고 별도 착수 지시 후 구현한다.
동일한 설치/관측을 이유 없이 반복 재설치하거나, 현재 develop을 과거 T로 치환하지 않는다.

다음 권한은 계속 닫혀 있다.

- package/lock/설치/tsconfig/workflow/release gate·source·test/fixture 변경.
- scorer/ledger/protocol/M3/M6, dataset/manifest/register 또는 succ-9 purpose 전환·activation.
- holdout 작성·봉인·개봉, S5/v9 prompt·pair·key/운영 서명·full P 동결.
- 예산·dispatch·provider 호출, 운영 DB/서비스, memoryExtractionEnabled/memoryInjectionEnabled 및 기타 flag 변경.
- Git config·stash·관련 없는 기존 untracked·.env 변경.
- 전체 Windows unit PASS, OI-F4 closure, production 검증 완료 선언.

검토 제출용 프롬프트 3개만 이번 이력에 포함한다. 이는 모델 동작용 v9/제품 prompt 변경이 아니다.
원문 보고서·실행 기록 보존과 이번 승인 전사 외에 새 계약·구현 권한을 만들지 않는다.

## 6. 이번 기록 준비의 관측과 검증

2026-09-10T09:45:04.272Z에 HEAD=V, 해당 codex/ branch, tracked/staged clean을 확인했다.
기존 untracked 46항목 중 §3 자료 10개만 추적 대상으로 옮기며 관련 없는 36항목은 보존한다.
정규 파일 hash·디렉터리 존재를 대조하며 디렉터리 내부 전체 bytes 재귀 검증이라고 부르지 않는다.
보호65·상위 승인4, hidden lock, stash, 환경 파일 크기/mtime 및 미래 두 파일 부재를 확인했다.
.env 내용이나 비밀값을 읽지 않았다.

이번 시작의 config SHA-256은
25bb2a4abe6f336420897bdd37fe09ab102a575154566813fa4548845d008496이다.
이번 준비 전후 보존 확인은 과거 config 변경 actor/provenance 예외 해소와 구별한다.

로컬 PC PowerShell, H:/Project/ai-chat-hub의 기존 Node 22.22.2/npm 10.9.7로
package.json의 실제 npm script를 production 자격증명 없이 실행했다.
OS/PATH/TEMP/user-cache allowlist 및 부재 확인한 DOTENV_CONFIG_PATH를 child에만 전달했다.
부모 환경·설치·운영 서비스에는 쓰지 않았고 재설치도 하지 않았다.

2026-09-10T09:45:46.845Z clean tracked V 기준선 결과다.
출력 SHA는 stdout raw bytes 뒤 stderr raw bytes를 결합한 SHA-256이다.

| npm run script | exit | stdout+stderr SHA-256 |
|---|---|---|
| check:encoding:strict | 0 | 7d5195263cb38b5aa0de4bf8e0ead06774933b4e124616518883574554bcd380 |
| check:policy-section-references | 0 | 186e01d8fe6404117146063d01f13379d3de76a45d49a6a7970dcfc5cfb255ac |
| check:release-records | 0 | 5d216eabba9f6eb6762717a31e2bc3c26172d530ed554ab099a9c21a537f3565 |
| check:memory-eval-succ9 | 0 | f792af65d17e277fecceedf03b5eaba6484180748d3013de077a027a005e194c |
| check:memory-extraction-eval | 0 | 575a56bac68f5e261286b5e00894451bd0fb1b7b5cead22e49d8d8f28315629b |
| check:memory-eval-freeze | 0 | 8318af98d6c2a2ce9ca9f2d7c0d9b4acc70cc97ee7555b8dc026a4fb5b10cca1 |
| check:doc-references | 0 | 5a51c6dd0e6fa0c87b9270a5771589f97f3f9aa8a5b2d2dcd4358576d084fc39 |
| test:unit | 1 | 30da9d3e251bc45dce4be788c62aaa860e4b1dd33ff5ce02a6de6df08f323e15 |

문서 검사 7개는 통과했고 test:unit은 기존 Windows launch exit1/배너만 출력했다.
동일 argv 직접 spawn도 ENAMETOOLONG/status null/signal null/출력 0 bytes/server654로 재현했다.
원 시험의 실패를 성공으로 바꾸지 않았으며 전체 unit assertion 실행 완료도 아니다.
cache-wiring/T01의 이번 새 실행은 없고 §3 검토 기록의 결과를 그 세션에 귀속한다.

문서 checker는 감사 문서 의미 전체를 검사하지 않으므로 이 receipt의 YAML·상대 링크,
대상별 raw SHA·승인과 외부 판정 구분, strict UTF-8/no BOM/LF, staged allowlist를 별도 확인한다.
문서관리 원칙의 원문 보존·별도 승인 전사만 적용하며 의료 QMS 인증·새 승인자 의무를 도입하지 않는다.

### 6.1 작성 후 대조

2026-09-10T09:49:36.956Z에 receipt 포함 동일 npm script 8개를 재실행했다.
문서 7개 exit0, test:unit 기존 exit1이며 모두 위 clean tracked V 기준선과
이름별 exit·stdout+stderr SHA가 같았다. 동일 argv 진단도 같은 ENAMETOOLONG이다.
새 문서 검사 실패·새 assertion 실패를 관측하지 않았다.

2026-09-10T09:50:08.258Z에 이번 시작과 비교하여 관련 없는 36항목의 정규 파일 hash/디렉터리 존재,
보호65·config·stash·hidden lock·환경 파일 크기/mtime 보존, 미래 두 파일 부재를 확인했다.
관련 검토 자료 10개의 원 hash와 V/WR 원문의 Git/working hash도 일치한다.
처음 diff --check에서 발견한 새 receipt의 EOF 빈 줄 1개만 정리했고 원문 보고서는 수정하지 않았다.
최종 stage는 위 11파일 A로만 제한하여 raw/Git blob hash·공백·범위를 다시 확인한 뒤 제출한다.
