# memory-eval vNext — WR-1 Windows unit runner 승인 기록

**decision: yes — WR-D1–WR-D5·WR-F1 보완·추가 독립 검토 부재·잔여 및 별도 착수 조건 승인.**
승인자: mposition. 승인일: 2026-09-10.
기록 작성자: Codex. 작성일: 2026-09-10.
기록 준비 관측: 2026-09-10T06:15:16.722Z. 작성자 관측 시각이지 사람 승인 instant가 아니다.

## 1. 실제 사람 승인과 별도 제출 지시

사용자는 [사람 승인 요청 초안](memory-eval-vnext-oi-f4-runner-approval-request-draft-2026-09-10.md)을
제공받고 다음과 같이 회신했다.

> 승인합니다.
> 승인자: mposition
> 승인일: 2026-09-10
>
> 승인 기록후 커밋/푸시/PR까지 작업해주세요.

이 문서는 그 회신을 승인 요청 초안 §6의 네 항목과 WR-1 두 exact 파일에 결속하는
**별도 authoritative human approval receipt**다. WR-D1–WR-D5의 전체 문언·범위·잔여,
WR-F1 작성자 보완 및 WR-1 추가 독립 검토 없음, config provenance 한계,
Git 계보·CI·실제 착수 재검증·별도 착수 지시 조건을 함께 수용한 것으로 기록한다.
과거 승인의 이름·날짜나 초안 준비 지시를 이번 승인으로 대용하지 않는다.

승인일은 사용자가 제공한 날짜이며 시각·timezone instant는 제공되지 않아 null이다.
인용은 대화 전사이지 원시 채팅 bytes hash·암호학적 서명·작성자 인증 증명이 아니다.
마지막 문장은 이 문서 작업의 commit/push/PR 제출 지시이며 병합·auto-merge·구현 지시가 아니다.

~~~yaml
recordKind: oi_f4_windows_unit_runner_wr1_approval_receipt
recordStatus: human_approved_pending_publication_merge_and_separate_start
isAuthoritativeApprovalReceipt: true
requestId: oi_f4_runner_wr1_exact_approval_request_2026_09_10
repository: mposition/Tomverse
repositoryBasis: 7bce6df0e2ff55d50d24e23c172aa831b09e7c15
packageRevision: WR-1
approvalTargetCommit: 52beb7de9c1cb949677c5db306ffd6425a89ea46
approvedRequestCommit: 52beb7de9c1cb949677c5db306ffd6425a89ea46
initialReviewCommit: 3fb5ac9554ecbe8c3c52a7da0f9bf1739030e7a9
reviewCommit: 3fb5ac9554ecbe8c3c52a7da0f9bf1739030e7a9
revisionIndependentReviewCommit: null
decision: "yes"
approvedBy: mposition
approvedAt: "2026-09-10"
approvedAtInstant: null
acceptedDecisionIds: [WR-D1, WR-D2, WR-D3, WR-D4, WR-D5]
acceptedDecisions:
  WR-D1: "yes"
  WR-D2: "yes"
  WR-D3: "yes"
  WR-D4: "yes"
  WR-D5: "yes"
acceptedAcceptances:
  exactWr1PackageAndAllResiduals: true
  wrF1AuthorDisposition: true
  noAdditionalIndependentReview: true
  disclosedConfigProvenanceLimit: true
  gitCiActualStartRevalidationAndSeparateStartConditions: true
reviewHistory:
  initialVerdict: PASS_WITH_WARNINGS
  initialBlockingFindings: 0
  initialWarningIds: [WR-F1]
  initialReviewRoundsUsed: 1
  confirmationReviewRoundsUsed: 0
  revisionIndependentlyReviewed: false
  revisionIndependentReviewVerdict: null
  wrF1Disposition: author_addressed_human_accepted
  externalFindingClosureDeclared: false
thisReceiptIndependentlyReviewed: false
prospectivePolicyAndThreeFileScopeApproved: true
implementationChangeAuthorizedNow: false
implementationStartAuthorizedNow: false
oiF4ClosureDeclared: false
fullUnitSuitePassed: false
gitPublicationAuthorizedByCurrentUserMessage: true
prCreationAuthorizedByCurrentUserMessage: true
mergeAuthorizedNow: false
autoMergeAuthorizedNow: false
manualCiDispatchAuthorizedNow: false
activationAuthorized: false
paidExecutionAuthorized: false
approvalReceiptCommit: null
~~~

이 receipt의 실제 approvalReceiptCommit은 이 파일을 추가한 Git commit의 40자 SHA로
사후 식별한다. 자기 commit/hash를 문서 안에 미리 발명하지 않는다.
approvalTargetCommit은 승인된 내용의 Git 결속이지 승인 당시 이미 commit되어 있었다는 주장이 아니다.
승인 당시 대상은 working raw bytes였고, 승인 후 같은 bytes를 아래 commit에 기록했다.

## 2. 승인된 exact bytes와 검토 대상 분리

| 역할 | identity |
|---|---|
| 작성 basis B | 7bce6df0e2ff55d50d24e23c172aa831b09e7c15 |
| 최초 독립 검토 대상 R / WR-0 | 3fb5ac9554ecbe8c3c52a7da0f9bf1739030e7a9 |
| 승인된 수정본 WR-1 및 승인 요청 초안 commit | 52beb7de9c1cb949677c5db306ffd6425a89ea46 |
| WR-1 commit의 유일 parent | 3fb5ac9554ecbe8c3c52a7da0f9bf1739030e7a9 |

| 승인 대상 path | Git blob OID | raw SHA-256 | bytes / LF |
|---|---|---|---|
| .github/audits/memory-eval-vnext-oi-f4-runner-approval-package-draft-2026-09-10.md | ca875ee93ea668c26eed997eb0fc1bb5ca27ef97 | 420f8876d9e6e472345ff5a953ea446db16a862b48b28242fa460de14ac80381 | 31888 / 399 |
| .github/audits/evidence/memory-eval-vnext-oi-f4-runner-approval-package-2026-09-10.json | fb5f6ccd8b10c842a2626790ae5ed95a0aeeda2b | ccc42634c68571878572eb24c4b6b6890fd334712f3c88050eb318ba2fc5ece5 | 128509 / 2702 |

[승인된 패키지](memory-eval-vnext-oi-f4-runner-approval-package-draft-2026-09-10.md)와
[승인된 evidence](evidence/memory-eval-vnext-oi-f4-runner-approval-package-2026-09-10.json)는
승인 요청 표의 raw SHA와 같고 working/Git blob bytes도 같다.
JSON.document.rawSha256은 위 Markdown만 식별한다. JSON 자체·보고서·요청문·receipt hash와 혼용하지 않는다.

승인 전 요청 초안은 같은 WR-1 commit에 원 bytes로 추가했다.

- path: .github/audits/memory-eval-vnext-oi-f4-runner-approval-request-draft-2026-09-10.md
- Git blob OID: a7f4a1f836f15a1cb0f9355cc2718461b8b224de
- raw SHA-256: 37b17d9f0a3dea1450a3f16cc38ed7ab5bb05cd06770b854fbf830cd7b3a7220
- bytes / LF: 10341 / 161

WR-1 commit의 R 대비 변경은 패키지 두 파일 M와 요청 초안 한 파일 A뿐이다.
R 원본은 amend/rebase 없이 Git에 보존한다. 원본 R과 WR-1의 pending/null·미commit 표기는
각 문서 작성 당시 상태로 보존하며, 현재 승인 및 이후 Git 결속은 이 별도 기록에서 읽는다.
WR-1을 독립 검토된 SHA로 표시하거나 원본 R을 수정본 승인 대상 SHA로 대용하지 않는다.

## 3. 검토 결과·WR-F1 보완·수용한 한계

사용자 제공 Claude 최초 독립 검토의 원문 식별자는 다음과 같다.

- 실제 reviewCommit: 3fb5ac9554ecbe8c3c52a7da0f9bf1739030e7a9.
- 원본 Markdown raw SHA-256: 7bdc313a124faec6daad5b030faf75f7adb79f1c7cb679f255edb303051f890b.
- 원본 JSON raw SHA-256: 686ad8eda4ba266be3e9ebf8f78a17da3a838cdfb740411b70f99c4b1a2c26e5.
- 보고서 raw SHA-256: d0ea75c475e42e9ca41434547731b9a4a9e1a0e0fa31ab8b7160e16d9f7418a8.
- 보고서 bytes / LF: 23214 / 191.
- 수신 locator: C:/Users/Vyper/.codex/attachments/b937844e-b232-4b75-a44b-69c1bd47bb16/pasted-text.txt.
- 판정: PASS_WITH_WARNINGS, 승인 차단 0건, 비차단 P3 WR-F1 한 건.

보고서 locator는 로컬 수신 위치이지 영구/Git 보관 증명이 아니다.
보고서 검증은 검토자 관측에 귀속하며 이 receipt의 신규 실행 결과로 바꾸지 않는다.

WR-F1은 현행 status pass-through와 제안의 비정상 중단/정규화 차이를 설명하라는 지적이었다.
WR-1은 패키지 §6와 WR13의 MD/JSON expected에 그 차이와 이유·한계를 명시했다.
정상 성공 0과 정상 실패 1–255를 구별하며, 비정상 뒤에도 이미 기록한 최초 nonzero가 있으면
유지하고 없으면 1을 쓰는 기존 제안은 그대로다. OS에서 이미 0으로 잘린 원래 status의
복원 보장은 없다. 실행 정책·16,000 budget·3파일 범위·다른 19개 expected는 바꾸지 않았다.

WR-1 추가 독립 검토는 **미실시**다. 최초 1회·확인 0회를 유지하며,
사람은 작성자 보완과 추가 검토 부재를 함께 수용했다. 기존 PASS_WITH_WARNINGS는 R에만 귀속한다.
WR-1/요청문/이 receipt에 PASS 또는 CONFIRMED를 새로 발급하거나 외부 finding closure를 선언하지 않는다.
JSON의 author_addressed_pending_human_acceptance는 당시 상태로 보존하고
현재 author_addressed_human_accepted는 이 receipt에만 기록한다.

.git/config의 과거 4b07f53f…에서 74daa333…로의 변경 주체·정확한 내용 차이는 여전히 미확인이다.
전체 값과 경위는 승인된 패키지 §11 및 JSON.preservationException을 그대로 수용한다.
이번 승인 기록 준비에서 현재 hash는
74daa3336def61337c3b7bd4f06d9c35051660ef8111ae5f292e04383bd8bbb4로 같았다.
이번 작업 중 보존 확인을 과거 예외 해소·복원·보존 PASS로 소급하지 않는다.

## 4. 승인 범위와 계속 닫힌 권한

정확한 계약은 §2 두 파일 전체다. 아래 요약은 새 권한이나 값을 추가하지 않는다.

| 결정 | 수용한 내용 |
|---|---|
| WR-D1 | Windows 16,000 UTF-16 보수 예산, 최대 prefix 분할, 양쪽 lane 사전 계획, skip/retry 금지 |
| WR-D2 | 기존 discovery/정렬·flags·server/client 경계·순차 실행, 비-Windows 단일 spawn 및 한계 |
| WR-D3 | 일반 실패 누적·최초 nonzero 보존·비정상 중단과 정규화, WR-F1의 설명된 차이·한계 |
| WR-D4 | R01–R03 세 파일, 정확한 import/export 및 소유한 임시 fixture 범위 |
| WR-D5 | WR01–WR20 명세, 실제 Windows/Linux 검증·기존 실패 이름별 대조, 결과 수용/closure 경계 |

미래 조건부 구현 allowlist는 scripts/run-unit-tests.mjs 수정,
scripts/run-unit-tests-core.mjs 신규, tests/unitTestRunner.test.mjs 신규뿐이다.
이 승인은 **즉시 구현 착수 지시가 아니다.** WR01–WR20은 아직 not_run이고,
runner 결함 해소·전체 unit PASS·OI-F4 closure도 아직 선언하지 않는다.
임의 JavaScript sandbox, 모든 OS/경로 길이 지원, child 출력의 비밀 제거 보장으로 확대하지 않는다.

package/lock/설치/tsconfig/workflow/release gate, 기존 승인 bytes,
scorer/ledger/protocol/M3/M6·기존 시험/fixture, dataset/manifest/register/purpose activation,
holdout/S5/v9·pair·key/운영 서명·full P 동결·예산/dispatch/provider·운영 DB/서비스·
memoryExtractionEnabled/memoryInjectionEnabled 및 다른 flag 변경 권한은 없다.
Git config·stash·기존 untracked·.env 변경도 허용하지 않는다.

A=3f14afb29eddc243640fdb0a5a4f604646ade9f0,
CA=80842e62925c05af9450e6acc6ceb70b56f67655,
D<K<activationApprovalCommit<C 및 상위 잔여를 WR-1이나 이 receipt로 치환하지 않는다.
원 decision SHA 355f8387808b8a7ea86e02ecffc4303562b5ab5c43c27fef0c2bdb2bf57e89da,
400 LF/§13 공란, 기존 원문·과거 verdict를 보존한다.

## 5. 제출 및 실제 착수의 순서

1. 이번 사람 메시지는 승인 기록과 exact 문서 파일의 commit/push 및 develop 대상 PR 생성을 허용한다.
   대상은 패키지 MD/JSON, 승인 전 요청 초안, 이 receipt 네 파일뿐이다.
   기존 검토 전달 프롬프트와 관련 없는 untracked는 포함하지 않는다.
2. 병합은 이번 지시에 포함되지 않는다. 별도 병합 지시 후 **원 SHA를 보존한 merge commit**으로
   develop에 반영하고 해당 실제 tip의 CI를 확인한다. squash/rebase와 auto-merge는 하지 않는다.
3. 실제 착수 tip에서 support9·runner·전체 발견 목록·실행 환경·승인 ancestry를 재검증한다.
   문서 검사나 옛 B의 CI를 미래 착수 검증으로 대용하지 않고, 일치하는 설치를 반복 재설치하지 않는다.
4. 확인한 tip의 새 codex/ branch와 **별도 명시적 착수 지시** 후에만 세 파일을 구현한다.
   구현 SHA에 실제 시험·독립 검토·사람의 결과 수용을 결속한 뒤 OI-F4 closure 여부를 정한다.

준비 시 원격 develop은 ea9c802d4c96cb0e320e9681bd7476495840a314로 B 이후 전진했다.
이를 WR의 작성 basis로 소급 치환하지 않았고 branch를 rebase/merge하지 않았다.
이 receipt에는 미래 PR 번호·CI 성공·배포·병합 완료를 미리 적지 않는다.

## 6. 이번 기록 검증

문서관리 원칙에 따라 승인된 bytes와 미판정 양식은 불변으로 보존하고 실제 사람 승인만 별도로 기록했다.
의료 QMS 인증·새 운영 wire receipt·암호서명·새 검토자 의무를 도입하지 않는다.

로컬 PC PowerShell, H:/Project/ai-chat-hub의 기존 Node v22.22.2/npm 10.9.7에서
production 자격증명 없이 package.json의 실제 npm script를 실행했다.
OS/PATH/TEMP/user-cache allowlist와 부재 확인한 DOTENV_CONFIG_PATH를 child에만 전달했고
DOTENV_CONFIG_QUIET=true/NEXT_TELEMETRY_DISABLED=1도 child 한정이다.
부모 셸·설치·환경 파일은 수정하지 않았다.

승인된 working 수정본을 2026-09-10T06:15:38.024Z에, commit된 clean WR-1을
2026-09-10T06:16:37.465Z에 검사했다. 아래는 두 경우 동일한 exit/출력 SHA다.
출력 SHA는 stdout raw bytes 뒤 stderr raw bytes를 결합해 계산한다.

| npm run script | exit | stdout+stderr SHA-256 |
|---|---|---|
| check:encoding:strict | 0 | 7d5195263cb38b5aa0de4bf8e0ead06774933b4e124616518883574554bcd380 |
| check:policy-section-references | 0 | 10d32893aa320f1486d353d438877ba14f400e89a5def1ad1a2201606321b700 |
| check:release-records | 0 | 5d216eabba9f6eb6762717a31e2bc3c26172d530ed554ab099a9c21a537f3565 |
| check:memory-eval-succ9 | 0 | f792af65d17e277fecceedf03b5eaba6484180748d3013de077a027a005e194c |
| check:memory-extraction-eval | 0 | 575a56bac68f5e261286b5e00894451bd0fb1b7b5cead22e49d8d8f28315629b |
| check:memory-eval-freeze | 0 | 8318af98d6c2a2ce9ca9f2d7c0d9b4acc70cc97ee7555b8dc026a4fb5b10cca1 |
| check:doc-references | 0 | 35fbd9630118e20e05b94a41c0a5aad3431cf5fd1e0ce5767366287a94656052 |
| test:unit | 1 | 30da9d3e251bc45dce4be788c62aaa860e4b1dd33ff5ce02a6de6df08f323e15 |

7개 문서/정책 script는 모두 통과했다. test:unit의 exit1은 기존 Windows launch 실패이며
동일 argv 직접 spawn은 두 경우 ENAMETOOLONG/status null/signal null/stdout·stderr 0 bytes였다.
이전 clean R 검사와도 이름별 exit/출력 SHA가 같다. 새 assertion 실패나 전체 unit PASS가 아니다.
WR01–WR20/T01·새 runner·POSIX/Windows crash probe·build/E2E·운영 호출은 실행하지 않았다.

commit 전에는 receipt 포함 strict UTF-8/no BOM/LF/후행 공백·YAML·상대 링크·MD hash binding,
Git blob/working hash·승인/검토/요청 대상 구분·diff --check·staged allowlist를 직접 확인한다.
저장소 참조 checker는 audits 전체 의미를 검사하지 않으므로 receipt 내부 링크와 결속을 별도 검증한다.
support9 포함 직접 binding24·보호65와 상위9 ancestry, config/stash/hidden lock/env metadata,
기존 untracked 정규 파일 hash/디렉터리 존재도 전후 대조한다.
디렉터리 내부 전체 bytes를 재귀 hash로 입증하거나 과거 config 예외를 해소했다는 뜻은 아니다.

### 6.1 작성 후 실제 관측

2026-09-10T06:20:12.375Z에 같은 npm script를 재실행했다. 문서/정책 7개는 exit0이고
test:unit은 기존 exit1이며, clean WR-1 및 앞 표와 8개 모두 이름별 출력 SHA가 같았다.
동일 server argv 재현도 ENAMETOOLONG/status null/signal null/stdout·stderr 0 bytes였다.
새 검사 실패는 없고 미래 구현 시험이나 전체 unit 성공을 주장하지 않는다.

2026-09-10T06:20:09.031Z에 실제 회신의 승인 값·권한 경계·원본 R/수정본 WR-1 구분,
승인 대상과 요청 초안의 Git blob/working raw hash·보고서 hash, 직접 binding24·보호65·
상위9와 B/R ancestry, UTF-8/YAML/상대 링크/whitespace를 확인했다.
tracked/index clean이며 기존 untracked37항목 중 승인 요청 초안1개만 앞 commit에서 추적 대상으로
옮겼고 이 receipt1개를 추가해 관측 수는37이다. 나머지36항목의 정규 파일 hash/디렉터리 존재,
config·stash17·hidden lock·env metadata는 이번 준비 기준과 같았다.

일반/staged diff --check는 통과했고 새 receipt의 no-index --check는 빈 NUL 대비 내용 차이만
있으며 공백 오류 출력은 없었다. 이 결과 전사 후 최종 bytes·범위와 staged blob을 다시 확인해
receipt만 별도 commit한다. approved 두 파일과 요청 초안 bytes는 이 결과 기록 때문에 바꾸지 않는다.
