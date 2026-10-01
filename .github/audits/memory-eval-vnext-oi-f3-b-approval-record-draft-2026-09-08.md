# memory-eval vNext — PB-R1 exact 승인 기록 초안

**DRAFT / UNSIGNED — 사람이 아직 이 exact 패키지를 승인하지 않았다.**
작성자: Codex. 작성일: 2026-09-08. 이 날짜는 승인일이 아니다.
이 파일은 미래 authoritative human approval receipt의 **초안**이며 현재 권한이 없다.

## 1. 현재 상태와 효력

사용자의 “네 준비해주세요”는 승인 요청문·기록 초안을 준비하라는 지시다.
decision=yes, 승인자/승인일, PB-D1–PB-D5 수용을 뜻하지 않는다.
이전 mposition의 B 방향 선택과 AOD 승인을 새 exact 승인으로 확대하지 않는다.
실제 사람 판정은 미회신이고 아래 pending/null/빈 목록을 그대로 유지한다.

```yaml
recordKind: oi_f3_b_exact_approval_receipt_draft
recordStatus: draft_unsigned_pending_human_exact_approval
requestId: oi_f3_b_exact_approval_request_2026_09_08
isAuthoritativeApprovalReceipt: false
repository: mposition/Tomverse
reviewCommit: "f84036a4c86f7d3f91dcd9592f8137bb5cb16f6b"
originalReviewCommit: "60486e971c94a189ab418c4743f48428a402ea52"
repositoryBasis: "65b82d5670e086ca77f39050ad48e68f56433f0e"
directionReceiptCommit: "42a99c4c5721a25b13894b99533b9800f4fb437b"
implementationReferenceCommit: "54ad04e29aa3390f4d342d152127e99928b4268e"
decision: pending
approvedBy: null
approvedAt: null
humanApprovalResponse: null
acceptedDecisionIds: []
decisionStatus:
  PB-D1: pending
  PB-D2: pending
  PB-D3: pending
  PB-D4: pending
  PB-D5: pending
requiredDecisionIds: [PB-D1, PB-D2, PB-D3, PB-D4, PB-D5]
inseparableDecisionGroup: [PB-D2, PB-D3]
inseparableGroupAccepted: null
reviewLimitsAcknowledged: null
residualsAndStartGateAccepted: null
upstreamConditionsPreservedByHuman: null
exactImplementationPackageApproved: false
newBuiltinUseAuthorizedNow: false
implementationStartAuthorizedNow: false
gitPublicationAuthorizedNow: false
mergeAuthorizedNow: false
activationAuthorized: false
operationalSigningAuthorized: false
paidExecutionAuthorized: false
fullF07Satisfied: false
recordCommitAtPreparation: null
approvalReceiptCommit: null
requestDocumentCommitAtPreparation: null
newDocumentsIndependentlyReviewed: false
externalConfirmationReview:
  reviewCommit: "f84036a4c86f7d3f91dcd9592f8137bb5cb16f6b"
  reportRawSha256: "ac97a495be66615ea2ff3896d5b0dc78dca3b2c250ed97cee1073661deb84a34"
  verdict: CONFIRMED
  appliesTo: R1_package_document_response_only
  usedConfirmationRounds: 1
  maximumConfirmationRounds: 1
```

externalConfirmationReview는 아래 확인 보고서에 대한 관측이며 사람 판정이 아니다.
이 초안은 SignatureReceipt wire·새 signer/key·운영 권한 객체·암호학적 서명이 아니다.
현재 false는 “이 미승인 초안이 권한을 주지 않는다”는 뜻이다. 미래 사람이 전체 exact 범위를
승인해도 publication·실제 착수 Gate·별도 착수 지시가 자동 면제되지 않는다.

## 2. 승인 예정 대상의 exact identity — 승인 완료 표가 아님

아래 두 파일은 R1의 Git blob raw bytes다. 사람에게 승인 요청할 대상이지 이미 승인된 목록이 아니다.

| 대상 | path | Raw SHA-256 | bytes / LF |
|---|---|---|---|
| PB-R1 Markdown | .github/audits/memory-eval-vnext-oi-f3-b-approval-package-draft-2026-09-08.md | a2241c6f48dc79d43ebf159494bdeadbf06c0e86de6db05fdcff4f00a77be9a9 | 43955 / 578 |
| PB-R1 JSON | .github/audits/evidence/memory-eval-vnext-oi-f3-b-approval-package-2026-09-08.json | 3e400844dbdda306b5697f40328e673f7d037a5e84cf2124b1193f301a703399 | 114420 / 2037 |

[패키지 원문](memory-eval-vnext-oi-f3-b-approval-package-draft-2026-09-08.md)과
[근거 JSON](evidence/memory-eval-vnext-oi-f3-b-approval-package-2026-09-08.json)은 그대로 보존한다.
R1 JSON document는 위 Markdown의 raw hash를 결속한다. 원 R의
5465da2fcd13dd920cbfdd7e1cfbc5f05575ce36f4524f726acbcf227007dc53(MD)와
eb15aec4a53c605bc97e82bd9a38b189e0af499e9c2e42b54c5ab089f89c807e(JSON)는
최초 검토 이력이며 이번 승인 예정 두 hash가 아니다.

| 별도 전사 자료 | path | Raw SHA-256 | bytes / LF | 작성 시 commit |
|---|---|---|---|---|
| 승인 요청 초안 | .github/audits/memory-eval-vnext-oi-f3-b-approval-request-draft-2026-09-08.md | 5d030bc3e9defb2e9a4c565ed4952395f25b95e2c16e39e333b4fed587e1b8a5 | 15482 / 204 | 없음, untracked |

[승인 요청 초안](memory-eval-vnext-oi-f3-b-approval-request-draft-2026-09-08.md)은 검토된
패키지의 범위·사람 회신 항목을 전사한 자료다. 그 hash와 아래 보고서 hash를 위 두 패키지
hash 대신 승인했다고 읽지 않는다. 이 기록의 자기 hash/미래 commit을 본문에 넣지 않는다.

R1의 parent는 원 R 하나이며 R..R1은 1 commit/두 파일 M뿐이다. R/AOD/M은 R1의 조상이다.
R1의 pending/null을 수정하지 않고 별도 최종 receipt에 실제 회신을 결속한다.
R1은 이미 고정됐지만 이 초안 자체나 미래 receipt의 approvalReceiptCommit이 아니다.

## 3. 확인 검토 결속과 한계

| 회차 | 검토 대상 | 보고서 raw SHA-256 / bytes | 보고된 판정 |
|---|---|---|---|
| PB 최초 독립 검토 | R 60486e971c94a189ab418c4743f48428a402ea52 | 76989963726c2a1a0b0334269af46588fadd23cbb7a9debfaf1e384149b0b1a7 / 12668 | PASS_WITH_WARNINGS, P1 0/P2 1/P3 3, 차단 0 |
| PB 유일 한정 확인 검토 | R1 f84036a4c86f7d3f91dcd9592f8137bb5cb16f6b | ac97a495be66615ea2ff3896d5b0dc78dca3b2c250ed97cee1073661deb84a34 / 7678 | CONFIRMED, PB-F1–PB-F4 확인, 회귀·새 finding 없음 |

최초 보고서 locator:
C:/Users/Vyper/.codex/attachments/e7f117bd-75ae-4fcf-b48a-dfce11806a92/pasted-text.txt
확인 보고서 locator:
C:/Users/Vyper/.codex/attachments/6e1f7561-d2be-4d39-84a1-cc012340a147/pasted-text.txt

이 경로·hash는 로컬 수신 원문 식별이며 Git 보관·영구 보관·암호 서명 검증을 뜻하지 않는다.
보고서에 있는 7개 검사와 45파일 대조는 검토자 보고에 귀속한다.
R clean-tree 재실행 미수행·동등성 추론, ES2024 도구 접근 한계와 pinned V8 보조 확인,
T01/suite/lint/typecheck/probe/CI·운영 검증 미수행도 함께 보존한다.
이 초안 작성자가 새 전체 구현 검증이나 develop CI 성공을 했다고 전사하지 않는다.

CONFIRMED는 고정 R1의 문서 대응만 확인했다. 이 요청문/기록 초안이나
PB-D1–PB-D5 사람 승인·builtin 실제 사용·구현 착수·F07 충족·activation/full P 완료는 아니다.
확인 검토 회차는 1/1 소진 상태로 보존하고 기존 OD-R1/D 회차도 다시 열지 않는다.

## 4. 미회신 exact 결정과 유지 조건

미래 최종 receipt에는 사람의 실제 **전체 수용** 회신을 전사한다.
현재의 요구 목록을 acceptedDecisionIds로 복사하지 않는다.

| ID | 수용을 요청하는 내용 |
|---|---|
| PB-D1 | C01/C03/C04/T01/T11 5개 exact 파일과 R1 책임만; C02·범위 밖 불변 |
| PB-D2 | 한정 node:util/native predicates·intrinsic private copy·copyByteInput, test-only node:vm; D3와 불가분 |
| PB-D3 | genuine Uint8Array storage/private copy 및 명시된 호환성 예외와 cross-realm 수용; D2와 불가분 |
| PB-D4 | R1의 FR/NFR/AC/B inventory·13 trap/8 hook 이름별 0·음성/회귀/정적/민감도 검증 |
| PB-D5 | 기존 잔여·비운영·실제 tip Gate와 비소급 효력 |

D2 또는 D3 하나만 수용, 어느 하나 거절·보류는 전체 exact 승인 미완료다.
D1/D4/D5도 포함해 다섯 결정 전부가 필요하며 부분 회신으로 구현·새 builtin 권한을 만들지 않는다.
cross-realm 거절 시에는 별도 대체 설계·범위·시험의 검토/승인이 필요하다.
임의 realm/prototype equality 검사나 AC 삭제·의미 축소를 허가하지 않는다.

5파일 path는 canonicalJson.ts/signatures.ts/trust.ts의 lib/memoryEvalVnext/protocol/ 아래
세 경로, tests/memoryEvalVnextWire.test.mjs,
tests/fixtures/memory-eval-vnext/wire-vectors.json이다. 정확한 전체 path·import/helper/
intrinsic·API 책임은 요청 §3과 R1에 고정되어 있으며 이 약칭을 추가 path로 확장하지 않는다.
C02 lib/memoryEvalVnext/protocol/wire.ts는 읽기 전용이다.
기존 OS-F3 volatile 합성 시험 예외는 확대하지 않는다. 일반 JavaScript sandbox 보장도 없다.

OI-F1 시점 공백 accepted residual/closure=false, OI-F2 별도 ID/path 결정,
OI-F4 별도 runner 범위, ODR-F1 외부 closure 없음, 상위 54 AC 9/45/0을 유지한다.
현재 B01–B24 전부 not_run이며 기존 40 unit/4 external 및 새 B 19 unit/5 external 구분을 보존한다.
이 기록으로 I 당시 F07을 소급 충족시키거나 기존 A/CA/D/K/activationApprovalCommit을 치환하지 않는다.

## 5. 승인해도 면제되지 않는 착수 Gate와 제외 범위

사람 exact 승인 → 실제 회신을 결속한 별도 최종 receipt → 별도 제출/병합 지시 →
원 SHA를 보존한 merge commit으로 develop 반영 → 실제 착수 tip의 CI·승인 bytes·계보 확인 →
support 9개/M→tip diff·Node/V8/tsx·설치 dependency/lock·package flags/test discovery의
별도 사전 검증 → 그 tip의 새 codex/ branch와 **별도 구현 착수 지시** 순서다.
R1/원 R/receipt를 squash/rebase하여 승인 계보를 끊지 않는다.

현재 로컬 검사나 과거 OS-F4 기록은 미래 실제 tip의 재검증을 대신하지 않는다.
새 dependency/설정/범위 선택이 필요하면 자동 변경하지 말고 별도 지시를 구한다.
보강된 F07 판정은 실제 구현 SHA와 AC 전건 검증 evidence에 결속한 후에만 가능하다.

이 기록으로 다음을 승인하지 않는다.

- C02·5파일 밖 구현, dependency/package/lock/config/runner/workflow/새 운영 API 변경.
- scorer/ledger/full P/resolver/controller/운영 adapter, 등록 parser·trust digest/권한 승격.
- operational key/signature/TrustAnchor·정책 등록/폐기·EnvironmentApproval/ClockPolicy·
  genesis/root/journal/checkpoint·백업/복구 운영.
- S2 purpose/activationApprovalCommit/C, dataset/manifest/register, holdout 작성/seal/open,
  S5/v9 prompt 작성·활성화, pair/예산/dispatch/provider 호출·유료 turn.
- production/Railway/DB 접속·설정·배포, release gate,
  memoryExtractionEnabled/memoryInjectionEnabled 변경.
- commit/push/PR/ready/auto-merge/병합/CI dispatch. Git publication은 별도 지시다.

## 6. 실제 회신 뒤 최종 receipt로 기록할 때

이 초안을 현재 승인으로 표시하지 않는다. 명시적인 PB-D1–PB-D5 전체 및 D2/D3 불가분
수용 여부·승인자·승인일을 실제 사람 회신에서 확인한 뒤 별도 최종 receipt를 작성한다.
빠진 항목은 과거 회신에서 복사하지 않는다. 이 초안은 미승인 당시 기록으로 보존하고,
패키지 원문과 요청문도 승인 당시 hash를 유지한다.

최종 receipt에는 R1·두 exact path/raw SHA·요청문 승인 당시 hash·보고서 hash,
실제 decision/approvedBy/approvedAt·수용 범위/잔여/한계와 Gate를 결속한다.
새 최종 receipt commit은 commit 후 외부 Git 이력에서 확인하며 자기 본문에 self hash를 넣지 않는다.
최종 receipt 작성·제출·병합·구현은 이번 초안 준비 완료만으로 자동 시작하지 않는다.

## 7. 이번 작성의 검증 상태

요청 §7의 작성 시작 HEAD=R1과 두 패키지/보고서 identity, 원문/support 45파일,
기존 untracked 23개·ignored 3개를 보존 기준으로 사용한다. 추가 파일은 요청/기록 초안 두 개다.
strict UTF-8/BOM/CR/후행 공백/끝 LF·YAML·path/hash 결속·상대 링크와 Git 변경 범위를 대조한다.
package script의 작성 전/후 결과는 요청 §7에 귀속하며 과거 AOD/R 실행으로 대체하지 않는다.
이 초안 자체는 사람 승인·독립 검토·구현 시험 통과를 주장하지 않는다.
