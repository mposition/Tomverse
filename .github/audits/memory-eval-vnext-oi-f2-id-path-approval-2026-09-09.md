# memory-eval vNext — OI-F2 ID/path 정책·정정 수용 승인 기록

**decision: yes — IP-D1–IP-D5와 R2 한 줄 정정·검토 한계·잔여·별도 착수 조건 승인.**
승인자: mposition. 승인일: 2026-09-09.
기록 작성자: Codex. 작성일: 2026-09-09.
작성 시작 관측: 2026-09-09T12:13:35.460Z. 작성자 관측 시각이며 사람 승인 instant가 아니다.

## 1. 실제 사람 회신과 승인 효력

사용자는 [사람 승인 초안](memory-eval-vnext-oi-f2-id-path-approval-request-draft-2026-09-09.md)을
제공받은 뒤 다음과 같이 회신했다.

> 승인합니다.
> 승인자: mposition
> 승인일: 2026-09-09

이 문서는 실제 회신을 초안 §8의 전체 요청 범위에 결속한 **별도 authoritative human approval receipt**다.
R2 두 exact bytes, CHANGES_REQUIRED 보존·IP-R1-F1 한 줄 정정과 R2 독립 재검토 부재,
IP-D1–IP-D5, path/호환성 및 상위 잔여, 별도 착수 조건을 승인한 것으로 기록한다.
초안 준비 지시나 과거 mposition 승인, IP-F1 해소 보고를 사람 승인으로 대체한 것이 아니다.

승인자·승인일은 위 회신에서 옮겼다. 승인 instant는 제공되지 않아 null로 남긴다.
인용과 YAML은 대화 내용 전사이며 채팅 원시 bytes의 hash·암호학적 서명·작성자 인증 증명이 아니다.
패키지와 승인 전 초안의 pending/null은 당시 상태 그대로 보존하고 현재 승인은 이 별도 기록에서 읽는다.

~~~yaml
recordKind: oi_f2_id_path_policy_and_correction_approval_receipt
recordStatus: human_approved_pending_git_publication_and_separate_start
requestId: oi_f2_id_path_policy_approval_2026_09_09
repository: mposition/Tomverse
isAuthoritativeApprovalReceipt: true
repositoryBasis: 17b074c600e98e8fe52175ea0cbc6c5860b0c742
approvalTargetCommit: 13a6b088cd88d53d971e66f358e297b8c71c6ad7
postReviewCorrectionCommit: 13a6b088cd88d53d971e66f358e297b8c71c6ad7
reviewedDocumentCommit: 896a8ad756ce2f1a5bf3dff85d238240a8e2f2b8
reviewCommit: 896a8ad756ce2f1a5bf3dff85d238240a8e2f2b8
initialReviewCommit: 1979839dc200687336db3d72526e9a76c860be71
predecessorApprovalReceiptCommit: b98509dcd9ac9c19e389dece4da429301e2510aa
implementationReferenceCommit: e0a8c743695fce278592c29e85d32279fa1f2b85
approvedRequestPath: .github/audits/memory-eval-vnext-oi-f2-id-path-approval-request-draft-2026-09-09.md
approvedRequestRawSha256: 03f6b934078157473c153ec28fc48c5dc17548427220e092db93de5ab391a612
decision: "yes"
approvedBy: mposition
approvedAt: "2026-09-09"
approvedAtInstant: null
humanApprovalResponse: |
  승인합니다.
  승인자: mposition
  승인일: 2026-09-09
acceptedDecisionIds: [IP-D1, IP-D2, IP-D3, IP-D4, IP-D5]
acceptedDecisions:
  IP-D1: "yes"
  IP-D2: "yes"
  IP-D3: "yes"
  IP-D4: "yes"
  IP-D5: "yes"
acceptedAcceptances:
  exactIP2PackageAndReviewLimits: true
  IP-R1-F1: true
  pathAndCompatibilityResiduals: true
  upstreamResidualsAndSeparateStartGates: true
reviewHistory:
  initialVerdict: PASS_WITH_WARNINGS
  confirmationVerdict: CHANGES_REQUIRED
  resolvedDocumentFindingIds: [IP-F1]
  confirmationRemainingFindingIds: [IP-R1-F1]
  usedConfirmationRounds: 1
  maximumConfirmationRounds: 1
  postCorrectionIndependentlyReviewed: false
  postCorrectionIndependentReviewVerdict: null
thisReceiptIndependentlyReviewed: false
policyChangeApproved: true
futureImplementationScopeApproved: true
implementationChangeAuthorizedNow: false
implementationStartAuthorizedNow: false
oiF2ExternalClosureDeclared: false
fullF07OrFullPDeclared: false
gitPublicationAuthorizedByThisReceipt: false
prOrMergeAuthorizedByThisReceipt: false
ciDispatchAuthorizedByThisReceipt: false
activationAuthorized: false
operationalSigningAuthorized: false
paidExecutionAuthorized: false
approvalReceiptCommit: null
requestDocumentCommitAtPreparation: null
~~~

policyChangeApproved/futureImplementationScopeApproved는 **prospective 정책과 조건부 미래 M3 범위 승인**이다.
코드를 지금 바꾸라는 지시가 아니며 실제 착수는 §6의 제출·병합·재검증·별도 지시 뒤에만 가능하다.
OI-F2 정책 결정의 보류는 이 exact 범위에서 해소됐지만 구현 충족·외부 closure·activation은 여전히 별개다.
이 기록은 운영 SignatureReceipt wire·signer/key/등록 객체가 아니며 현재 로컬 파일로 작성했다.
이 receipt 자신의 hash나 미래 approvalReceiptCommit을 본문에 발명하지 않는다.

## 2. 승인된 exact bytes와 실제 검토 대상의 구분

| 역할 | 고정 identity |
|---|---|
| 승인된 최종 두 문서 R2 / IP-2 | 13a6b088cd88d53d971e66f358e297b8c71c6ad7 |
| R2 유일 parent / 실제 확인 검토 대상 R1 | 896a8ad756ce2f1a5bf3dff85d238240a8e2f2b8 |
| R1 유일 parent / 최초 검토 대상 R | 1979839dc200687336db3d72526e9a76c860be71 |
| R 유일 parent / 작성 basis T | 17b074c600e98e8fe52175ea0cbc6c5860b0c742 |

| 승인 대상 path | Git blob OID | raw SHA-256 | bytes / LF |
|---|---|---|---|
| .github/audits/memory-eval-vnext-oi-f2-id-path-approval-package-draft-2026-09-09.md | ef69b9cc9bd29aaae3d1b9b95995842070a1b52f | 14e0b11f71991c30e4bde14a0b502b1b1cce678a095fbd957e4b62e3ffbce2d0 | 38766 / 517 |
| .github/audits/evidence/memory-eval-vnext-oi-f2-id-path-approval-package-2026-09-09.json | dc5d6ca9693c07d70329278c3393f9eec6e8a4b0 | 12a2b3fb145b2807529450dda8c091d78d4a47bfb80814f368185aecb1cf6ab0 | 139437 / 3234 |

[승인된 Markdown](memory-eval-vnext-oi-f2-id-path-approval-package-draft-2026-09-09.md)과
[승인된 JSON](evidence/memory-eval-vnext-oi-f2-id-path-approval-package-2026-09-09.json)의 hash는 Git blob raw bytes다.
JSON.document.rawSha256은 위 R2 Markdown을 식별한다. JSON 자체의 hash, 검토 보고서 hash,
승인 요청 초안 hash를 서로 대체하지 않는다.

승인 요청 초안의 결속:

- path: .github/audits/memory-eval-vnext-oi-f2-id-path-approval-request-draft-2026-09-09.md
- raw SHA-256: 03f6b934078157473c153ec28fc48c5dc17548427220e092db93de5ab391a612
- bytes / LF: 23549 / 335
- 승인 당시 로컬 untracked로 commit 없음. 미판정 양식과 원 bytes 그대로 보존한다.

R1→R2 변경은 두 문서 M뿐이다. 규범 문장 한 줄, revision 표기와 처리 이력을 기록하고
JSON /document/rawSha256와 /correction만 바뀌었다.
T→R2도 같은 두 문서 A뿐이다. 기존 source/test/fixture/dataset/register/prompt/flag는 불변이다.

R2는 승인 대상 문서 commit이지 이 receipt의 approvalReceiptCommit이 아니다.
reviewCommit은 실제 검토된 R1로 남기며 R2를 독립 검토된 commit으로 바꾸어 적지 않는다.
원본 R/R1은 각 commit에 보존한다. 현재 R2/초안의 pending 상태를 승인 후 소급 수정하지 않는다.

## 3. 검토 결과와 정정 수용

| 회차 | 실제 검토 target | 원문 raw SHA-256 | bytes / LF / CR | 보고된 판정 |
|---|---|---|---|---|
| IP 최초 독립 검토 | 1979839dc200687336db3d72526e9a76c860be71 | 5d7acbe9fb1bbb4f7cf707f20fccadf69ef4df5e2232c37f20a7469bd045ab7c | 21054 / 163 / 0 | PASS_WITH_WARNINGS |
| IP-F1 변경분 한정 확인 | 896a8ad756ce2f1a5bf3dff85d238240a8e2f2b8 | 4b0acdaf0a13f011cc40d80fe5f350053617b30d579e86241dd8fee32817e9f8 | 16454 / 157 / 157 | CHANGES_REQUIRED |

보고서 원문 locator:

- C:/Users/Vyper/.codex/attachments/cdc77e91-891a-4778-af66-570e4652d916/pasted-text.txt
- C:/Users/Vyper/.codex/attachments/ffd6b2e9-1e21-4c19-b7a0-09e72fa74d90/pasted-text.txt

최초 보고는 P1 0/P2 0/P3 1, IP-F1 비차단이었다. 확인자는 IP-F1 문서 계약·양방향 추적 해소를
확인했으나 IP-R1-F1(P3, 승인 차단 아님)을 남겨 전체 판정은 CHANGES_REQUIRED였다.
사람 승인으로 이를 CONFIRMED나 “새 지적 없음”으로 바꾸지 않는다.

수용된 IP-R1-F1 정정은 다음 한 줄이다.

- 이전: 미래 idPathPolicy는 비운영 시료·기대값·IP01–IP20 추적성만 담는다.
- 정정: 미래 idPathPolicy는 기대값·IP01–IP20 추적성만 담는다.

닫힌 id/acId/verification/expected 네-field 계약과 충돌하던 “비운영 시료”만 제거했다.
row/AC/expected/ID/path 값·미래 M3는 그대로다. Markdown bytes 변경에 따른 JSON SHA 재결속은
기계적 동반 변경이며, 보고서의 “JSON 수정 불필요”를 오래된 결속 hash 유지의 근거로 쓰지 않았다.
처리 이력은 R2 Markdown §11과 JSON.correction에 있다.

R2의 한 줄 정정은 작성자가 검증했고 **R2의 추가 독립 확인 판정은 없다**.
사람은 승인 요청 초안에 명시된 정정과 이 한계를 함께 수용했다.
JSON.correction의 author_corrected_pending_human_acceptance는 당시 상태로 보존하고,
이 receipt에서 사람 수용을 기록한다. IP-R1-F1의 독립 외부 closure를 새로 발급한 것은 아니다.

확인 검토 1/1 사용을 유지하고 추가 Claude 검토나 이전 namespace의 회차 초기화를 하지 않았다.
이 receipt는 이미 제시된 정책·정정·한계와 실제 회신의 전사이므로 별도 독립 검토를 열지 않았다.
보고서 bytes 식별은 작성자 인증·영구 보관 증명이 아니며 원문 CRLF도 정규화하지 않았다.
보고서의 검증 실행은 검토자 관측에 귀속하고 새 구현 시험·CI 증거로 전용하지 않는다.

## 4. 승인된 다섯 결정과 미래 범위

정확한 계약은 §2 R2 두 파일과 승인 요청 초안 §4–§6이다. 아래는 그 승인 범위를 요약한 것이며
새 설계/시험이나 기존 문서에 없는 권한을 추가하지 않는다.

| ID | 승인된 내용 | 계속 유지하는 경계 |
|---|---|---|
| IP-D1 | 지정 opaque ID의 모든 문자를 U+0021..U+007E로 제한. C0/space/DEL/non-ASCII·빈 값·non-string 거절 | 11개 지정 위치와 isAsciiId만. 대소문자·punctuation 보존, 변환/trim/alias 없음. 다른 상위 문자열·fixed-format ID 불변 |
| IP-D2 | 지정 상대 path의 NFC Unicode/space 및 기존 상대 문법을 보존하면서 C0/DEL 거절 | BlobRef.path, GitFileRef.path, nested registrationReceipt.path 및 기존 actual/expected 소비 경로. 파일 접근 권한 검사가 아님 |
| IP-D3 | 후속 승인 구현을 선택한 실행부터 적용하고 과거 bytes/verdict 불변 | 자동 migration/repair/legacy fallback/version switch 없음. 기존 허용집합 안 결과·bytes·digest·오류 순서 보존 |
| IP-D4 | C02/T01/T11 미래 3파일 한정 범위, idPathPolicy 및 B19 projection 조정 | 새 builtin/helper export/import/dependency/runner/static gate 없음. C01/C03/C04와 Proxy/bytes intrinsic helper bytes 보존 |
| IP-D5 | IP01–IP15 unit / IP16–IP20 external, exact AC·보존·별도 실제 착수 조건과 잔여 | unit/external/전체 suite/CI를 대체하지 않고 실제 tip 재검증·별도 착수 지시 필요 |

미래 M3의 exact path는 다음뿐이다.

- C02: lib/memoryEvalVnext/protocol/wire.ts — isAsciiId/isRelativePath lexical predicate 및 직접 주석.
- T01: tests/memoryEvalVnextWire.test.mjs — 별도 IP inventory/시험과 한정 B19 projection 조정.
- T11: tests/fixtures/memory-eval-vnext/wire-vectors.json — 기존15 key 값/순서 보존, idPathPolicy 한 key만 끝에 추가.

idPathPolicy는 IP01–IP20 순서의 정확히20 row이고 각 row는 id/acId/verification/expected
네 개의 비어 있지 않은 primitive string만 갖는다. T01 독립 고정 기대표는 승인 패키지의 해당 값을
전사하며 fixture에서 정답을 유도하지 않는다. IP↔AC 집합·순서 양방향 검증, unit15/external5 구분,
IP15 자신의 expected literal 비교를 유지한다.

B19 original14는 미래에 proxySafety/idPathPolicy만 제외하며 기대 hash
1d286a257c44d3444de99b945a8276cd680b8b30adc41bf0fc5df32a5f4123ca를 보존한다.
IP15 original15는 idPathPolicy만 제외하며 기대 hash
e59c8ef30d4dae1430e113392d63924e9d2a77cd764edd8297e59ed2d987e652를 보존한다.
JSON insertion order·JSON.stringify(no replacer/no space)·UTF-8/추가 LF 없음 projection 규약은 불변이다.
실제 T11은 여전히15 key이고 idPathPolicy는 없다. 미래 key 추가 후 T11 raw SHA가 달라지는 것을
과거 raw SHA 불변으로 잘못 주장하지 않는다. F44/B24/IP20 inventory와 F41/F/B 완료 집합 보존도 그대로다.

## 5. 수용한 잔여와 부여하지 않는 권한

승인 요청 초안 §5의 잔여 전체와 §6의 별도 착수 조건을 수용했다.

- path C1 U+0080..U+009F, U+2028/U+2029, zero-width/bidi/format scalar,
  기타 NFC Unicode, 선행/후행 space·space-only segment는 나머지 조건이 맞으면 계속 수용한다.
- ID punctuation을 실행/경로 권한으로 쓰지 않는다. path decode/trim/NFC 변환/case-fold/realpath/
  OS alias 처리는 없다. Unicode 시각적 유일성·OS portability·파일 존재·symlink·승인 root·
  접근 안전성을 보장하지 않는다. resolver/보관 계층의 원 의무를 면제하지 않는다.
- 운영 corpus·DB·private package 호환성은 미조사이며 영향0 선언이 아니다.
  새 제한 밖 historical object 사용처가 발견되면 별도 보존/전환 결정을 요청한다.
- 기대표 전사 정확성은 IP18 외부 감사로 대조한다. 문서 일관성 검사와 미래 IP 시험 통과는 다르다.
- OI-F1 timing gap accepted residual/closure=false, OI-F4 별도 runner, ODR-F1 외부 closure 부재,
  BI/BFR 수용 한계·m3/m6 생존·영구 정적 강제 부재, 상위54 AC partial9/deferred45/full0,
  HD-1–HD-8/OP 7개 및 runtime/intrinsics 신뢰 전제를 유지한다.

즉시 구현, M3 밖 변경, 새 dependency/builtin/helper export/runner/영구 gate,
scorer/ledger/full P/resolver/controller/custodian/importer·등록 parser/trust digest,
운영 key/signature/genesis/root/journal/checkpoint/backup/attestation은 승인하지 않는다.
dataset/manifest/register·S2 purpose/activation·holdout 작성/seal/open·S5/v9 prompt·pair·
예산/dispatch/provider·DB/Railway/production/배포·release gate·두 memory flag 변경 권한도 없다.
OI-F2 외부 closure·전체 F07/full P 충족·일반 JavaScript sandbox 보장을 선언하지 않는다.

원 decision SHA 355f8387808b8a7ea86e02ecffc4303562b5ab5c43c27fef0c2bdb2bf57e89da,
400 LF/§13 공란, 기존 승인 원문·과거 verdict를 보존한다.
S2 approvalCommit=3f14afb29eddc243640fdb0a5a4f604646ade9f0,
contractApprovalCommit=80842e62925c05af9450e6acc6ceb70b56f67655와
D<K<activationApprovalCommit<C를 R2나 이 receipt로 치환하지 않는다.

## 6. 기록 뒤의 별도 단계

현재 사람 승인은 기록했지만 Git publication과 실제 착수는 아직 수행하지 않았다.

1. 별도 제출 지시가 오면 승인 전 초안과 이 최종 receipt의 exact allowlist를 확인해 commit/push/PR/CI를 진행한다.
   기존 untracked 전체를 stage하지 않는다. R/R1/R2 및 승인 원문·보고서는 불변으로 둔다.
2. 별도 병합 지시에 따라 원 SHA를 보존하는 merge commit으로 develop에 반영하고 그 실제 tip의 CI를 확인한다.
   squash/rebase나 다른 SHA의 CI로 승인 계보·검증을 대체하지 않는다.
3. 실제 착수 tip에서 support9 Git/working bytes, runtime·설치/lock·scope·승인 계보·CI를
   별도 착수 기록으로 재검증한다. 이 receipt의 문서 검사는 OS-F4 완료가 아니다.
4. 확인된 tip의 새 codex/ 구현 브랜치와 **별도 명시적 착수 지시** 뒤에만 승인된 M3를 구현한다.

사람 승인만으로 commit/push/PR/ready/auto-merge/merge/CI dispatch나 구현을 시작하지 않는다.
이 receipt가 나중에 commit되면 그 실제 Git SHA가 approvalReceiptCommit이며,
R2/승인 전 초안/미래 SHA를 그 값으로 미리 넣지 않는다.

## 7. 이번 승인 기록의 한정 검증

작성 시작 2026-09-09T12:13:35.460Z, HEAD=R2, branch=codex/memory-eval-vnext-oi-f2-id-path-approval.
tracked/index clean, 기존 untracked31항목(승인 전 초안 포함), stash17이었다.
승인 초안 raw SHA, R2 두 Git/working hash, 검토 보고서2개, source45/support9 및 상위17 조상을
다시 대조했다. 기존 원문을 보존하고 이 receipt 하나만 추가한다.
quality-documentation-manager의 원문 보존·실제 승인 별도 기록·승인과 착수 구분 원칙을 적용했다.
의료 QMS 인증이나 새 암호서명·운영 wire receipt를 도입하지 않는다.

로컬 PC PowerShell, H:/Project/ai-chat-hub의 기존 Node v22.22.2/npm 10.9.7/tsx 4.23.13/TypeScript 6.0.3에서
production 자격증명 없이 package.json의 실제 npm script를 사용했다.
OS/PATH/TEMP/user-cache allowlist만 child에 전달하고 부재 확인한 .os-f4-absent-env-file을
DOTENV_CONFIG_PATH로, DOTENV_CONFIG_QUIET=true/NEXT_TELEMETRY_DISABLED=1을 child에만 지정했다.
부모 셸·설치·lock·Git config·환경 파일은 바꾸지 않았다.

아래는 작성 전 clean R2 기준선이다. 실행 구간 2026-09-09T12:13:35.965Z–2026-09-09T12:13:40.634Z.
출력 SHA는 stdout raw bytes 뒤 stderr raw bytes를 결합한 SHA-256이다.

| npm run script | 작성 전 exit | 출력 SHA-256 |
|---|---|---|
| check:encoding:strict | 0 | 7d5195263cb38b5aa0de4bf8e0ead06774933b4e124616518883574554bcd380 |
| check:policy-section-references | 0 | bc9a33ead4deb5a419249fddec5a8f681136d645dbfc2cab1967995cae12059a |
| check:release-records | 0 | 5d216eabba9f6eb6762717a31e2bc3c26172d530ed554ab099a9c21a537f3565 |
| check:memory-eval-succ9 | 0 | f792af65d17e277fecceedf03b5eaba6484180748d3013de077a027a005e194c |
| check:memory-extraction-eval | 0 | 575a56bac68f5e261286b5e00894451bd0fb1b7b5cead22e49d8d8f28315629b |
| check:memory-eval-freeze | 0 | 8318af98d6c2a2ce9ca9f2d7c0d9b4acc70cc97ee7555b8dc026a4fb5b10cca1 |
| check:doc-references | 0 | fdf56bff206d251401863a06e045c07b7663ae53ea0514976ea99d15686c8375 |

작성 후 이름별 exit/출력 SHA를 대조하고 receipt의 strict UTF-8/no BOM/CR0/EOF LF 한 개/후행 공백,
YAML 실제 회신·승인/권한 경계·target/review/request/report hash·상대 링크·no-index --check를 확인한다.
새 untracked 파일은 일반/staged diff만으로 내용 검사를 했다고 주장하지 않는다.
기존31항목의 regular-file hash/디렉터리 존재와 source45/support9·fixture·Git 상태도 다시 대조한다.
세 보호 디렉터리 내부 전체의 byte 보존을 재귀 hash로 입증한다는 뜻은 아니다.

T01/전체 unit/lint/typecheck/typegen/build/E2E·mutant/fixture prototype·운영 corpus·DB/provider·flag 조회,
설치 inventory/lock closure·원격 ref/CI 조회나 dispatch는 수행하지 않는다.
이 기록은 새 구현 시험·CI·실제 착수 재검증이 아니다.

### 7.1 작성 후 실제 관측

2026-09-09T12:17:47.971Z–2026-09-09T12:17:52.748Z에 같은 npm script7개를 재실행했다.
모두 exit0이며 작성 전 기준선과 이름별 stdout+stderr SHA도 7/7 동일했다.
기준선/작성 후/신규 실패 이름은 모두0개다. 기존 policy reference notice와 eval-budget 대기도 동일했다.

2026-09-09T12:17:47.566Z에 실제 회신/YAML 승인 값·권한 경계, R2 승인 대상/R1 검토 대상 구분,
승인 전 초안과 두 패키지·두 보고서 hash, source45/support9·상위17 조상·fixture/두 projection 보존,
strict UTF-8/no BOM/CR0/EOF LF 한 개/후행 공백 없음과 상대 링크3개를 확인했다.
tracked/index clean, 기존 untracked31항목에 이 receipt1개만 더해32항목이며 stash/config도 그대로다.

일반·staged diff --check는 exit0이고 새 receipt의 no-index --check는 exit1/빈 stdout·stderr였다.
이는 빈 NUL 입력과 비어 있지 않은 새 파일의 차이이지 모든 exit1을 성공으로 처리하는 규칙이 아니다.
receipt는 stage하지 않았으며 bytes/YAML/결속을 별도로 검사했다.
이 결과 문단 전사 후에도 최종 bytes·승인 범위·원문 및 작업 트리 보존을 다시 대조한다.
