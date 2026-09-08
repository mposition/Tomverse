# memory-eval vNext — offline subset 한정 구현 승인 기록

**상태: APPROVED — 한정 구현 범위·합성 서명 시험·처리조건에 대한 사람 승인.**
**실제 구현 착수는 아직 허가되지 않았다. §7의 Git 고정·병합·검증과 별도 착수 지시가 남아 있다.**

이 문서는 승인받은 Q 두 문서와 승인 요청 초안의 bytes를 바꾸지 않고 사람 판정을
별도로 보존하는 authoritative human approval receipt다. Codex가 이번 사용자 메시지를
전사했다. 암호학적 SignatureReceipt·TrustAnchor·운영 서명·S2 activation 승인이 아니다.

## 1. 사람 승인 기록

```yaml
recordStatus: approved
recordKind: offline_subset_limited_implementation_human_approval
repository: mposition/Tomverse
decision: "yes"
approvedBy: "mposition"
approvedAt: "2026-09-08"
approvalEvidenceType: explicit_user_message
approvalScope: Q_six_file_offline_subset_with_request_conditions
reviewedPackageCommit: "7e5491f5fa24295912d5da7a6cc5e86ddb637f43"
repositoryBasis: "0c6b3fec7cfb68f5a2fc4e4a492de7905b413bff"
approvedRequest:
  path: ".github/audits/memory-eval-vnext-offline-subset-approval-request-draft-2026-09-08.md"
  rawSha256: "e9ff1e0f2d2335035588dfeeed888c5cd3729add66b79572a1a63dcd68f90351"
  bytes: 21047
  lines: 307
  documentCommitAtReceiptPreparation: null
approvedPackageDocuments:
  - id: Q_MD
    path: ".github/audits/memory-eval-vnext-offline-subset-approval-draft-2026-09-08.md"
    rawSha256: "0b8668d8bf65f139895af13c126d43b1a277d6152582ec3ce857fc763b1310df"
    blobOid: "853ea85ce07f69dc2c3f3b3ca08f803bcb5016f0"
    bytes: 31978
    lines: 418
  - id: Q_JSON
    path: ".github/audits/evidence/memory-eval-vnext-offline-subset-package-2026-09-08.json"
    rawSha256: "7ad37a223dc20eea71a20f539d7778000d1b0ada4e61e6d3d64cffe25dcf6ed2"
    blobOid: "94edbf8c43bf5f652a67831ff3413856678dcd00"
    bytes: 94616
    lines: 2617
acceptedDecisions:
  limitedOfflineImplementation: accepted
  testOnlySyntheticSignatures: accepted
  noAuthorityPromotion: accepted
  deferredRegistrationParser: accepted
implementationAndSyntheticSignatureDecisionsJointlyAccepted: true
dispositionNamespace: offline_subset_initial_review_2026_09_08
acceptedDispositionIds: [OS-F1, OS-F2, OS-F3, OS-F4]
reviewLimitationsAcknowledged: true
upstreamConditionsPreserved: true
externalInitialReview: PASS_WITH_WARNINGS
externalInitialReviewCommit: "7e5491f5fa24295912d5da7a6cc5e86ddb637f43"
externalInitialReviewReportSha256: "a66758772910834953d66afd491d21aae86a470bd9c4244fe9367599eb311104"
requestAndReceiptIndependentlyReviewed: false
limitedImplementationScopeApproved: true
implementationStartAuthorized: false
activationAuthorized: false
operationalSigningAuthorized: false
paidExecutionAuthorized: false
gitPublicationAuthorizedByThisMessage: false
```

승인자가 이 작업의 대화에서 전달한 판정 원문은 다음과 같다.

```text
승인합니다.
승인자: mposition
승인일: 2026-09-08
```

이 메시지는 위 raw SHA로 식별되는 승인 요청 초안을 제시하고, 추가 독립 검토 필요 여부를
설명한 뒤 받은 **그 요청 전체에 대한 승인**으로 기록한다. 네 결정·결합 조건과
OS-F1–OS-F4 처리방침·기존 잔여·착수 조건을 포함한다. YAML의 accepted 표시는 그 맥락을
구조화한 전사이며, 사용자가 항목별 boolean이나 위 SHA를 별도로 타이핑했다는 주장이 아니다.
과거 승인자/날짜, Git author, PR 병합 또는 Claude 판정을 이번 사람 승인의 대용으로 쓰지 않는다.

## 2. 승인 대상과 원문 보존

정확한 범위는 §1이 결속한 [Q 문서](memory-eval-vnext-offline-subset-approval-draft-2026-09-08.md),
[Q 근거 JSON](evidence/memory-eval-vnext-offline-subset-package-2026-09-08.json),
[승인 요청 초안 전체](memory-eval-vnext-offline-subset-approval-request-draft-2026-09-08.md)를 함께 따른다.
Q의 유일 parent는 M이며 M 대비 두 파일 추가만이다.

요청 초안은 이 receipt 작성 시 아직 untracked이며 문서 commit은 없다. 위 null은 그 시점의
사실이다. Q commit을 요청 초안의 commit으로 대용하지 않는다. 초안의 raw SHA는 승인 당시
그 path의 21,047 bytes만 식별하며, 추후 동일 bytes를 Git에 고정할 때 blob과 commit을 검증한다.

Q와 요청 초안의 DRAFT/UNSIGNED·pending/null·빈 accepted 목록은 작성 당시 상태로 보존한다.
현재 사람 결정은 **이 receipt**에만 기록하며, 승인 사실을 채우려고 원문 hash를 바꾸지 않는다.
Q의 documentCommit=null·commit/push 제외 문언도 역사적 준비 상태다. 이후 별도 제출 지시나
현재 제한 승인을 Q 원문에 소급 삽입하지 않는다.

Q 두 raw SHA, 요청 초안 raw SHA, 보고서 raw SHA, Git blob OID, 검토 commit과 미래 receipt
commit은 각각 자기 대상을 식별한다. 상호 교환하거나 아직 없는 자기 commit SHA를 예측하지 않는다.
아래 accepted는 조건의 사람 수용이지 구현·시험·운영 이행 완료라는 뜻이 아니다.

## 3. 승인한 네 결정과 정확한 파일 범위

| 결정 | 수용 내용 |
|---|---|
| limitedOfflineImplementation | Q §2–§4와 요청 초안 §3–§5의 한정 책임·AC·처리조건 아래 다음 6개 exact 파일만 구현·합성 시험할 범위 |
| testOnlySyntheticSignatures | 미래 T01 내부 volatile 합성 key/signature 생성·검증만. 운영 key·seed 사용, private key 출력/보존, 운영 signer export 금지 |
| noAuthorityPromotion | component equality·유효 서명은 실제 신뢰·사람 승인·activation의 증거가 아님. authorityEstablished=false 유지 |
| deferredRegistrationParser | HD-1 이후 별도 exact 결정 전 registration parser·trust digest 생성·폐기 이력 authority 검증을 제외 |

첫 두 결정을 **결합 승인**했다. 이후 하나라도 철회·보류되면 일부 AC를 조용히 삭제하거나
더 좁은 구현을 자동 진행하지 않는다. 네 항목 전체와 조건이 유지돼야 승인된 6파일 범위가
성립한다. 공개 vector 성공만으로 S3-framed 양성 서명 시험을 대신할 수 없다.

| ID | exact path | 허용 local import |
|---|---|---|
| C01 | lib/memoryEvalVnext/protocol/canonicalJson.ts | 없음 |
| C02 | lib/memoryEvalVnext/protocol/wire.ts | C01 |
| C03 | lib/memoryEvalVnext/protocol/signatures.ts | C01,C02 |
| C04 | lib/memoryEvalVnext/protocol/trust.ts | C01,C02 |
| T01 | tests/memoryEvalVnextWire.test.mjs | C01,C02,C03,C04,T11 |
| T11 | tests/fixtures/memory-eval-vnext/wire-vectors.json | 없음 |

C01은 CJSON encode/strict decode와 raw/domain SHA, C02는 BlobRef/GitFileRef/SignaturePayload/
SignatureReceipt/TrustAnchor 공통 구조, C03은 S3 message·receipt digest·PureEd25519 verify,
C04는 구조·명시 expected 값 equality·명백한 부적합 비교만 맡는다. 세부 책임은 Q 원문 그대로다.
C04 성공에 registration 원문 해석·trust digest 계산·실제 authority를 덧붙이지 않는다.

지원 purpose는 s2_activation_approval→approver, s2_source_evidence→importer,
s2_activation_inclusion→importer 셋이다. 다른 상위 purpose는 첫 subset에서 미지원일 뿐
S3/S4 전체에서 금지된 것으로 재정의하지 않는다.

runtime C01–C04의 network/DB/fs read·write/child process/clock/random/keygen/sign 금지를
유지한다. T01의 test-only 예외는 runtime으로 넘어가지 않는다. T11에는 공개·합성 비운영
시료와 정답만 둔다. 추가 helper·dependency·package/lock·tsconfig·runner/workflow·API·
adapter 변경은 이 승인 밖이며 필요 시 멈추고 별도 exact 권한을 요청한다.

## 4. OS-F1–OS-F4 처리방침 수용

처리방침의 상세 문언은 승인 요청 초안 §4 전체에 결속한다. 아래 표는 수용 색인이지
검토 finding을 수정 완료로 닫거나 Q의 기존 bytes를 교정하는 기록이 아니다.

| ID | accepted disposition | 남은 이행 |
|---|---|---|
| OS-F1 | Q JSON frIds의 NFR 누락을 인정하고 아래 추적성 표를 함께 적용. mdJsonAcAndAllowlistMatched=true를 NFR 전수 일치 증거로 쓰지 않음 | 미래 시험에서 FR/NFR와 증거 연결을 함께 대조. Q JSON 원문 변경 없음 |
| OS-F2 | G05 유지, 미래 T01/T11에 RFC 8032 §7.1 TEST 2/3 공개 publicKey/message/signature 및 변조 거절 시료 추가 | 원문 bytes 대조와 시험은 미래 이행. private seed 복사/보존 없음. S3-framed 합성 envelope 시험 별도 유지 |
| OS-F3 | 한정 구현과 test-only 합성 서명을 결합 승인. T01 안의 volatile test key만 허용 | F12 bytes 구성/primitive 성공은 F21–F23/F25 합성 결속 검증의 대체물이 아님. skip·미실행을 전체 AC-5/6 충족으로 보고하지 않음 |
| OS-F4 | 실제 착수 develop tip에서 support 9개·환경·검사·승인 계보를 재결속 | §7의 사전 조건 충족 전 착수 금지. Q의 M 기준 hash를 덮어쓰지 않음 |

| Q AC / Markdown 위치 | 기존 FR 대응 | 함께 적용할 NFR 대응 |
|---|---|---|
| AC-9 / Q md:282 | FR-6, FR-7 | NFR-2, NFR-3 |
| AC-10 / Q md:288 | FR-2, FR-7 | NFR-4 |
| AC-12 / Q md:300 | FR-1 | NFR-1 |

NFR-5를 포함한 Q의 모든 NFR은 그대로다. NFR 적용 범위를 이 세 AC로 축소하지 않는다.
Q F01–F44의 ID/묶음을 삭제·재번호 매기지 않으며 공개 vector 변형을 더한 leaf test 수가
44개라고 주장하지 않는다. 합성 입력이 모두 맞아도 authorityEstablished=false다.

## 5. 독립 검토 귀속과 한계

최초 독립 검토 대상은 Q, namespace는 offline_subset_initial_review_2026_09_08이다.
사용자 제공 보고서는 **PASS_WITH_WARNINGS — P1 0 / P2 0 / P3 4**를 판정했다.
N-F1의 C04 한정 처리 적합과 OS-F1–OS-F4가 승인 전 Q bytes의 필수 수정은 아니라는 판단은
검토자에게 귀속한다. 사람의 처리조건 수용은 이번 §1의 메시지로 별도 기록한다.

```text
reportPath: C:/Users/Vyper/.codex/attachments/48340331-6727-4995-a9f3-6fc0b2d62327/pasted-text.txt
rawSha256: a66758772910834953d66afd491d21aae86a470bd9c4244fe9367599eb311104
bytes: 11327
reviewCommit: 7e5491f5fa24295912d5da7a6cc5e86ddb637f43
```

보고서 원문은 로컬 첨부이며 전체가 Git에 들어 있다는 주장이 아니다. 요청 초안과 이 receipt
자체는 Claude의 추가 독립 검토 대상이 아니며 CONFIRMED를 부여하지 않는다. 이 승인 전사는
새 확인 검토가 아니고 D 확인 검토 1/1 소진 상태를 초기화하지 않는다.

요청 초안 §2의 검토 한계를 그대로 수용한다. Q run 0건/PR 없음은 보고 당시 관측이다.
M snapshot의 Git 의존 검사 두 개는 직접 기준선 실행 미완료로 입력 동등성을 추론했다.
M 실제 CI 성공/N PR docs-only skip을 Q 또는 현재 develop CI·배포·운영 readiness로
승격하지 않는다. 실제 구현·keygen/signing·full P closure·운영 proof는 검증되지 않았다.

## 6. 기존 승인·잔여와 미승인 범위 보존

S2 approvalCommit A=3f14afb29eddc243640fdb0a5a4f604646ade9f0,
contractApprovalCommit CA=80842e62925c05af9450e6acc6ceb70b56f67655,
D=159267a80acee97da3a297c637343ea15de725f9,
K=6b2465e921c6e8b99ff032a36be8ada61c0ad599,
H=a19ae39d0da61295eb17e1545c74bc5b7e702c1a 및 Q의 sourceFiles 22개를 보존한다.
이번 receipt는 A/CA/K 또는 별도 activationApprovalCommit을 치환하지 않는다.

원결정 D1–D5·§12, §13 공란의 400줄 승인 bytes, S1/S2 P2-N1·C-COORD-1/R-*,
S3/S4 N-1(controller key 분리)/N-2(no-contact) 및 잔여를 유지한다.
D namespace s2_clarification_confirmation_2026_09_07 N-1–N-3의 요청 header 증명 공백,
exact V 8개 rule 전부 OK, ReplayEnvironment≠독립 network 차단 증명도 보존한다.
importer-attest/새 D EnvironmentAttestation을 채택하지 않는다.

HD-1–HD-8의 전역 pending/null, OP-TRUST, OP-P-ROOT, OP-CUSTODY, OP-SOURCES,
OP-ACTIVATION-APPROVAL, OP-RESOLVER, OP-C-INCLUSION 7개는 그대로다. HD-7의 전체 P
범위·dependency closure 승인을 이번 6파일 승인으로 완료 처리하지 않는다. 상위 AC 54개의
partial 9/deferred 45/fullySatisfied 0, historical 122/forward 109, legacy admissible=true·
quality FAIL·workflow failure·pair revoked·ordinal 2 금지, 15 source roles/4 proof kind/8 rule을
바꾸지 않는다. 미래 subset 구현 완료도 full conformance가 아니다.

요청 초안 §5의 미승인 범위 전체를 유지한다. 특히 다음은 허용하지 않는다.

- scorer/F·ledger/P 전체·resolver·controller·custodian·importer·하위 verifier 또는 운영 adapter 구현
- 실제 운영 key/signature/TrustAnchor 등록, registration parser·trust digest 생성·폐기 이력 운영
- EnvironmentApproval/ClockPolicy·genesis/root/journal/checkpoint/proof·백업 복구 운영
- S2 purpose 전환·activationApprovalCommit/C, dataset/manifest/register 변경
- holdout 작성·검수·seal/open, S5/v9 prompt 작성·활성화
- pair/예산/dispatch/re-run/provider 호출·유료 turn
- production/Railway/DB/보호 설정·release gate·memoryExtractionEnabled·memoryInjectionEnabled 변경
- 6파일 밖 source/config/package/dependency 변경, 자동 PR/merge/배포

하위 verifier 동결→실제 정책 등록→trustPolicyDigest→전체 P 채택→genesis/root,
D<K<activationApprovalCommit<C, S2 전환 검증→F 동결→holdout seal→S5→E/pair/예산/dispatch
순서는 면제되지 않는다. 암호학적 전자서명 발급이나 실제 운영 권한을 과거 승인에 소급하지 않는다.

## 7. 실제 착수 전 필수 조건

사람의 **한정 구현 범위 승인은 완료**됐지만 다음의 실제 이행은 남아 있다.

1. 별도 사용자 지시로 승인 요청 원문과 이 receipt를 exact bytes로 commit·push·PR에 고정한다.
2. Q/요청 문서/receipt의 원래 commit SHA를 보존하는 **merge commit 방식**으로 develop에
   반영한다. squash/rebase를 자동 선택하지 않는다.
3. 실제 착수 develop tip의 40자 SHA를 고정하고 해당 CI, Q/요청 문서/receipt 및 상위 승인
   ancestry, 승인 원문 raw hash를 다시 검증한다. 현재 Q HEAD나 과거 M CI로 대신하지 않는다.
4. OS-F4에 따라 아래 9개 support 파일을 tip commit/path/blob OID/raw SHA로 재결속하고
   working raw SHA와 구별하여 별도 착수 검증 기록으로 남긴다.
5. M→tip diff, 실제 Node/tsx/설치 dependency와 lock 일치, test discovery·script flags·검사
   적용 범위를 함께 대조한다. 새 dependency/설치·설정 선택 또는 6파일 범위·AC·pure 경계의
   불성립이 발견되면 멈추고 별도 exact 권한을 요청한다.
6. 위 조건을 확인한 tip에서 새 codex/ 브랜치를 만들고 **별도 착수 지시**에 따라 시작한다.

support 9개는 AGENTS.md, package.json, package-lock.json, tsconfig.json,
scripts/run-unit-tests.mjs, scripts/check-text-encoding.mjs, scripts/check-doc-references.mjs,
scripts/check-policy-section-references.mjs, scripts/check-release-records.mjs다.
재결속은 호환성 검증의 대체물이 아니며 최종 P 동결도 아니다. 과거 Q JSON.supportFiles는
작성 당시 M 기준 사실로 보존한다. Git/CI 성공이 나머지 운영 승인이나 이행을 자동 생성하지 않는다.

이번 승인 메시지를 stage·commit·push·PR·ready·auto-merge·병합·배포 지시로 전사하지 않는다.
이 receipt 작성에서는 코드·fixture·합성 key/signature 생성, 운영 API 호출과 구현 착수를 하지 않는다.

## 8. 기록 작성 검증 — 완료 / 기존 기준선 실패 보존

작성 시작 HEAD는 Q이며 tracked/index는 깨끗했다. 기존 untracked 17항목 중 일반 파일
15개의 raw hash를 기준선으로 수집했다. Q 두 blob과 working bytes의 일치, 요청 초안 및
보고서의 raw SHA·길이·strict UTF-8을 대조했다. Codex가 추가한 산출물은 이 receipt 한 개이며
기존 원문이나 .claude/·.codex/에는 쓰지 않았다.

package.json scripts check:encoding:strict, check:policy-section-references,
check:release-records, check:memory-eval-succ9, check:memory-extraction-eval,
check:memory-eval-freeze, check:doc-references를 Q tracked-clean 기준선에서 실행했다.
앞 6개는 exit 0, 마지막은 exit 1이었다. 기존 8건은 app/layout.tsx를 향한
lib/documentLanguage.ts, app/[locale]/layout.tsx, scripts/security-regression-check.mjs,
tests/e2e/ssr-root-language.spec.ts의 missing 4건과 동일 POSIX historical entry의 unused 4건이다.

최초 사후 검사 중 HEAD가 main의 129b02856533c7cca5d7461345e3e706a37c4369로 바뀌어
검증을 중단했다. 그 전환은 이 작업이 실행한 것이 아니었다. 이후 사용자가 다른 세션의
전환이었다고 설명하고 원래 저장소 상태로 돌아가 검증을 마무리하도록 명시적으로 허용했다.
재개 시 tracked/index clean 및 기존 파일 hash를 확인한 뒤 git switch로 원래
codex/memory-eval-vnext-offline-subset-approval 브랜치/Q에 복귀했다. reset·강제 checkout·
stash·삭제를 사용하지 않았으며 검증 재개 권한을 commit·push·구현 권한으로 확대하지 않았다.

중단 당시 check:memory-eval-succ9는 Missing script로 exit 1이었다. policy-section-references는
0 citation/0 policy, memory-extraction-eval은 2 pair, memory-eval-freeze는 seed-11만 보고해
Q 기준선과 다른 입력을 읽었다. 이 결과들은 동일 Q checkout에서의 사후 검증이 아니므로
최종 검증 증거에서 제외한다. 다른 checkout의 실패를 Q 문서 변경의 회귀로 분류하지 않는다.

복귀 후 위 7개 package script를 Q에서 다시 실행해 최초 Q 기준선과 비교했다. 앞 6개
exit 0/마지막 exit 1 및 출력이 모두 동일하며, doc-references의 기존 8건은 이름·내용까지
일치한다. 신규 검사 실패는 0건이다. 기준선 자체의 오류를 고치거나 모든 검사가 통과했다고
표시하지 않는다. 이 결과는 로컬 문서 검증이지 현재 develop CI·배포 검증이 아니다.

### Git blob과 Windows working bytes의 구별

복귀 시 기존 core.autocrlf=true 설정에 따라 Q 두 파일과 source 22개의 working bytes가
CRLF로 checkout됐다. 설정과 승인된 Git blob은 수정하지 않았다. 최초 작성 시점의 LF
working bytes와 같다고 주장하지 않으며, 승인 hash는 §1이 명시한 **Q Git blob raw bytes**에
결속된다. 재계산한 두 blob SHA는 승인값과 정확히 같다.

| Q 대상 | 현재 working raw SHA-256 | Git bytes / working bytes | 차이 |
|---|---|---|---|
| Q_MD | f195a78e4470a8271f7dd8929c88001793c7d3895fd22d77074b61ad6272e224 | 31978 / 32396 | LF 418개에 CR 추가뿐 |
| Q_JSON | a8dccd780ccb8ae905d211e1cb09460be6d5685e39ae6f411ed9b54b09a55916 | 94616 / 97233 | LF 2617개에 CR 추가뿐 |

source 22개는 각각 원 commit과 Q tree의 blob OID/raw SHA가 기록과 일치하며, working
차이는 CRLF checkout 변환뿐이다. support 9개는 Q/M의 Git raw SHA와 과거 기록된 working
raw SHA가 각각 일치한다. 이를 실제 미래 착수 tip에서 요구하는 OS-F4 재결속으로 대용하지
않는다. 원결정 400줄/§13 공란 승인 hash, A/CA/D/K/H/B/R/N/M의 Q ancestry 및 D<K도
재확인했다. Q·상위 문서의 raw hash를 작업 파일 hash로 바꾸지 않는다.

승인 요청 초안은 여전히 21,047 bytes/307줄, raw SHA e9ff1e0f2d2335035588dfeeed888c5cd3729add66b79572a1a63dcd68f90351이며
수정하지 않았다. 이 receipt와 요청 초안의 strict UTF-8·BOM/CR/후행 공백 부재·끝 LF,
YAML 판정·4개 결정·4개 disposition·NFR 대응표·6파일 allowlist·상대 링크·보고서 hash를
별도로 확인했다. git diff --check는 exit 0, 이 receipt의 no-index whitespace 검사는
추가 diff에 따른 exit 1/진단 0건이다. 승인 본문 §1–§7은 재개 전 bytes를 그대로 보존했다.

기존 untracked 17항목의 일반 파일 15개 hash를 보존했으며, 최종 Q status는 그 목록에
이 receipt 하나를 더한 18항목이다. main에서 추가로 보였던 다른 세션의 docs/ops 기록
3개도 복귀 전후 hash를 대조해 보존했다. Q의 ignore 규칙으로 status에서 보이지 않는
것이지 삭제한 것이 아니다. .claude/·.codex/에는 쓰지 않았다.

현재 HEAD=Q, tracked/staged 변경 0이며 구현 6개 파일도 아직 없다. 이번 재개에서는
이 receipt의 검증 구획만 갱신했다. 로컬 검증은 완료했으나 stage·commit·push·PR·구현,
keygen/signing·운영 API 호출·현재 develop CI·배포 검증은 하지 않았다. 사람 승인·로컬
검증·Git 고정·실제 착수 권한을 구별하며 §7의 후속 조건을 그대로 유지한다.
