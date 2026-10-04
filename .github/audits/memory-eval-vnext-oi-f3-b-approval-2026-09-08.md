# memory-eval vNext — PB-R1 exact 승인 기록

**decision: yes — PB-D1–PB-D5 전체의 한정 exact 승인.**
승인자: mposition. 승인일: 2026-09-08.
기록 작성자: Codex. 작성일: 2026-09-08.
작성 시작 관측: 2026-09-08T11:29:43.993Z — 작성자 관측 시각이며 사람 승인 시각이 아니다.

## 1. 사람 승인과 기록의 효력

이 문서는 [승인 요청문](memory-eval-vnext-oi-f3-b-approval-request-draft-2026-09-08.md)과
R1 두 exact bytes에 대한 실제 사람 회신을 결속한 **별도 authoritative human approval receipt**다.
사용자는 PB-D1–PB-D5 전체(D2·D3 불가분 포함)의 승인 여부·승인자·승인일을 요청받은 뒤,
다음과 같이 회신했다.

> 전체 승인합니다.
> 승인자: mposition
> 승인일: 2026-09-08

이 전체 승인은 요청문에 명시된 다섯 결정, D2/D3 불가분 조건 및 제한·잔여·검토 한계·
실제 착수 Gate의 수용으로 기록한다. 앞선 “네 준비해주세요”나 과거 B 방향 선택에서
새 승인을 추정한 것이 아니다. 승인자·승인일은 위 실제 회신에서 옮겼다.
위 인용과 아래 YAML은 대화 내용 전사이며 채팅 원시 bytes의 hash·암호 서명 인증이 아니다.
승인 시각은 제공되지 않았으므로 날짜 외 instant를 지어내지 않는다.

```yaml
recordKind: oi_f3_b_exact_approval_receipt
recordStatus: approved_exact_package_pending_start_gate
requestId: oi_f3_b_exact_approval_request_2026_09_08
isAuthoritativeApprovalReceipt: true
repository: mposition/Tomverse
reviewCommit: "f84036a4c86f7d3f91dcd9592f8137bb5cb16f6b"
originalReviewCommit: "60486e971c94a189ab418c4743f48428a402ea52"
repositoryBasis: "65b82d5670e086ca77f39050ad48e68f56433f0e"
directionReceiptCommit: "42a99c4c5721a25b13894b99533b9800f4fb437b"
implementationReferenceCommit: "54ad04e29aa3390f4d342d152127e99928b4268e"
decision: "yes"
approvedBy: mposition
approvedAt: "2026-09-08"
humanApprovalResponse: |
  전체 승인합니다.
  승인자: mposition
  승인일: 2026-09-08
acceptedDecisionIds: [PB-D1, PB-D2, PB-D3, PB-D4, PB-D5]
decisionStatus:
  PB-D1: approved
  PB-D2: approved
  PB-D3: approved
  PB-D4: approved
  PB-D5: approved
requiredDecisionIds: [PB-D1, PB-D2, PB-D3, PB-D4, PB-D5]
inseparableDecisionGroup: [PB-D2, PB-D3]
inseparableGroupAccepted: true
reviewLimitsAcknowledged: true
residualsAndStartGateAccepted: true
upstreamConditionsPreservedByHuman: true
exactImplementationPackageApproved: true
limitedBuiltinAndHelperDesignApproved: true
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

externalConfirmationReview는 검토자 판정이고 decision은 별도 사람 판정이다.
이 기록은 SignatureReceipt wire·새 signer/key·운영 권한 객체·암호학적 서명이 아니다.
exactImplementationPackageApproved/limitedBuiltinAndHelperDesignApproved=true는 R1의 한정
설계·파일 범위·시험 계약을 채택했다는 뜻이다. newBuiltinUseAuthorizedNow/
implementationStartAuthorizedNow=false는 실제 사용·구현은 아직 착수 Gate와 별도 지시를
통과하지 않았다는 뜻이며 서로 모순되지 않는다. Git publication·운영·activation 권한도 없다.
과거 R/R1 commit 지시는 그때의 별도 권한으로 보존하며 이번 승인이 추가 publication을 허가하지 않는다.

## 2. 승인 대상의 exact bytes

아래 두 파일은 사람이 승인한 R1의 Git blob raw bytes다. 표의 각 hash는 해당 path 하나만 식별한다.

| 대상 | path | Raw SHA-256 | bytes / LF |
|---|---|---|---|
| PB-R1 Markdown | .github/audits/memory-eval-vnext-oi-f3-b-approval-package-draft-2026-09-08.md | a2241c6f48dc79d43ebf159494bdeadbf06c0e86de6db05fdcff4f00a77be9a9 | 43955 / 578 |
| PB-R1 JSON | .github/audits/evidence/memory-eval-vnext-oi-f3-b-approval-package-2026-09-08.json | 3e400844dbdda306b5697f40328e673f7d037a5e84cf2124b1193f301a703399 | 114420 / 2037 |

[패키지 원문](memory-eval-vnext-oi-f3-b-approval-package-draft-2026-09-08.md)과
[근거 JSON](evidence/memory-eval-vnext-oi-f3-b-approval-package-2026-09-08.json)은 그대로 보존한다.
R1 JSON document는 위 Markdown의 raw hash를 결속한다. 원 R의
5465da2fcd13dd920cbfdd7e1cfbc5f05575ce36f4524f726acbcf227007dc53(MD)와
eb15aec4a53c605bc97e82bd9a38b189e0af499e9c2e42b54c5ab089f89c807e(JSON)는
최초 검토 이력이며 이번 승인 대상 두 hash가 아니다.

| 별도 전사 자료 | path | Raw SHA-256 | bytes / LF | 작성 시 commit |
|---|---|---|---|---|
| 승인 요청 초안 | .github/audits/memory-eval-vnext-oi-f3-b-approval-request-draft-2026-09-08.md | 5d030bc3e9defb2e9a4c565ed4952395f25b95e2c16e39e333b4fed587e1b8a5 | 15482 / 204 | 없음, untracked |
| 승인 전 기록 양식 | .github/audits/memory-eval-vnext-oi-f3-b-approval-record-draft-2026-09-08.md | b044d0b5fcb9ef29026f10594e0281450a37490320aaa19325dbeb0f2d82f49f | 11967 / 191 | 없음, untracked |

[승인 요청 초안](memory-eval-vnext-oi-f3-b-approval-request-draft-2026-09-08.md)은 검토된
패키지의 범위·사람 회신 항목을 전사한 자료다. 그 hash와 아래 보고서 hash를 위 두 패키지
hash 대신 승인했다고 읽지 않는다. 이 기록의 자기 hash/미래 commit을 본문에 넣지 않는다.

[승인 전 기록 초안](memory-eval-vnext-oi-f3-b-approval-record-draft-2026-09-08.md)의 hash는
미승인 당시 양식의 provenance다. 그 문서의 pending 상태를 현재 사람 판정으로 사용하지 않는다.
R1의 parent는 원 R 하나이며 R..R1은 1 commit/두 파일 M뿐이다. R/AOD/M은 R1의 조상이다.
R1·요청문·기록 초안의 pending/null은 작성 당시 사실로 남기고 지금의 사람 승인은 이 기록에만 적는다.
R1은 이 receipt의 approvalReceiptCommit이 아니다. 이 receipt는 현재 untracked이며
향후 허가된 commit 후 실제 SHA를 외부 Git 이력에서 확인한다. 자기 본문에 미리 넣지 않는다.

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
이 기록 작성자가 새 전체 구현 검증이나 develop CI 성공을 했다고 전사하지 않는다.

CONFIRMED는 고정 R1의 문서 대응만 확인했다. 이 요청문/기록 초안/최종 receipt를
독립 검토한 결과는 아니며, CONFIRMED 자체가 사람 승인·builtin 실제 사용·구현 착수·
F07 충족·activation/full P 완료를 뜻하지 않는다. 이번 사람 exact 승인의 출처는 §1의 회신이다.
확인 검토 회차는 1/1 소진 상태로 보존하고 기존 OD-R1/D 회차도 다시 열지 않는다.

## 4. 승인된 exact 결정과 유지 조건

사람의 실제 전체 승인에 따라 아래 다섯 결정을 모두 수용한 것으로 기록한다.
acceptedDecisionIds는 exact 설계·범위·시험 계약의 수용이며 구현/시험 완료 목록이 아니다.

| ID | 승인된 한정 내용 |
|---|---|
| PB-D1 | C01/C03/C04/T01/T11 5개 exact 파일과 R1 책임만; C02·범위 밖 불변 |
| PB-D2 | 한정 node:util/native predicates·intrinsic private copy·copyByteInput, test-only node:vm; D3와 불가분 |
| PB-D3 | genuine Uint8Array storage/private copy 및 명시된 호환성 예외와 cross-realm 수용; D2와 불가분 |
| PB-D4 | R1의 FR/NFR/AC/B inventory·13 trap/8 hook 이름별 0·음성/회귀/정적/민감도 검증 |
| PB-D5 | 기존 잔여·비운영·실제 tip Gate와 비소급 효력 |

이번 회신은 D1/D4/D5뿐 아니라 D2·D3를 불가분 묶음으로 함께 수용했다.
D2 또는 D3만 떼어 채택하거나 하나를 거절·보류하는 다른 조합은 승인하지 않는다.
후속 부분 변경을 이 전체 승인으로 대체하거나 즉시 구현·새 builtin 사용 권한으로 확대하지 않는다.
cross-realm 거절 시에는 별도 대체 설계·범위·시험의 검토/승인이 필요하다.
임의 realm/prototype equality 검사나 AC 삭제·의미 축소를 허가하지 않는다.

| ID | 정확한 미래 변경 path |
|---|---|
| C01 | lib/memoryEvalVnext/protocol/canonicalJson.ts |
| C03 | lib/memoryEvalVnext/protocol/signatures.ts |
| C04 | lib/memoryEvalVnext/protocol/trust.ts |
| T01 | tests/memoryEvalVnextWire.test.mjs |
| T11 | tests/fixtures/memory-eval-vnext/wire-vectors.json |

import/helper/intrinsic·API 책임은 요청 §3과 R1의 한정 목록 그대로다.
C01의 새 node:util은 types.isProxy/types.isUint8Array만, 내부 export는 copyByteInput
하나만이며 C03/C04는 이 helper만 추가 import한다. T01의 node:vm runInNewContext는
상수 cross-realm bytes 시료 전용이다. arbitrary util/vm API·sandbox로 확대하지 않는다.
R1이 한정한 trusted intrinsic/private copy·test-owned structuredClone 전제도 그대로다.
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

## 6. 제출·착수 단계 — 별도 지시 대기

사람 exact 승인과 이 별도 receipt 작성은 완료됐지만 실제 착수 Gate는 아직 수행하지 않았다.
별도 제출 지시가 오면 요청문/승인 전 초안/이 receipt 등 필요한 감사 파일의 exact allowlist를
확인해 commit·push·PR을 준비한다. 기존 untracked 전체나 로컬 보고서/프롬프트를 자동 stage하지 않는다.
현재 로컬 보고서 locator/hash는 장기 보관을 보장하지 않으며, 필요한 원문 보존 범위도 제출
지시 안에서 정한다. 원본 첨부나 임시 사본을 이동·삭제하지 않는다.

제출/병합 역시 별도 지시를 따르고 R/R1 및 receipt의 원 SHA를 보존한다.
SHA 보존 merge commit과 실제 develop tip CI·승인 ancestry/원문 hash, support 9개 및
환경 사전 재검증 뒤 그 tip에서 새 branch를 만들며, 별도 구현 착수 지시를 기다린다.
이 승인이나 단순 PR 병합만으로 code/helper/test/fixture를 시작하지 않는다.

하위 verifier 동결→실제 정책 등록→trustPolicyDigest→전체 P 채택→genesis/root,
D<K<activationApprovalCommit<C, S2 전환 검증→F 동결→holdout seal→S5→E/pair/예산/dispatch
순서는 그대로다. 원 decision의 §13 공란 bytes와 기존 A/CA/D/K/RC/AOD 이력도 바꾸지 않는다.

## 7. 이번 승인 기록 작성의 검증

작성 시작 2026-09-08T11:29:43.993Z, HEAD=R1,
branch=codex/memory-eval-vnext-oi-f3-b-approval-package, tracked/index clean이었다.
R1 두 파일, 승인 요청/기록 초안 두 파일, 최초/확인 보고서 두 파일의 exact raw SHA를
다시 계산했고 승인 요청 당시와 일치했다. 원문/support 45파일의 Git/working bytes와
기존 일반 untracked 25개·ignored 3개를 보존 기준으로 삼았다.
추가 대상은 이 최종 receipt 한 파일뿐이다. .claude/·.codex/는 건드리지 않으며
그 내부를 전수 수집/해시했다고 주장하지 않는다.

로컬 PC PowerShell, H:/Project/ai-chat-hub clone, 기존 Node v22.22.2/V8
12.4.254.21-node.39/win32 x64에서 production 자격증명 없이
OS/PATH/TEMP 등만 allowlisted child에 전달하여 기존 package script를 실행했다.
부재 확인한 .os-f4-absent-env-file을 DOTENV_CONFIG_PATH로, DOTENV_CONFIG_QUIET=true와
NEXT_TELEMETRY_DISABLED=1을 child에만 전달했다. .env·원 창 환경·운영 설정은 바꾸지 않았다.
다음은 npm run <script>의 **이번 receipt 작성 전** 관측이다.

| package script | 작성 전 exit | stdout 뒤 stderr raw SHA-256 |
|---|---|---|
| check:encoding:strict | 0 | 7d5195263cb38b5aa0de4bf8e0ead06774933b4e124616518883574554bcd380 |
| check:policy-section-references | 0 | d0a05f454dbd4dcf0dee7b7063a040f139b439245ce6846a25685ed2886df703 |
| check:release-records | 0 | 5d216eabba9f6eb6762717a31e2bc3c26172d530ed554ab099a9c21a537f3565 |
| check:memory-eval-succ9 | 0 | f792af65d17e277fecceedf03b5eaba6484180748d3013de077a027a005e194c |
| check:memory-extraction-eval | 0 | 575a56bac68f5e261286b5e00894451bd0fb1b7b5cead22e49d8d8f28315629b |
| check:memory-eval-freeze | 0 | 8318af98d6c2a2ce9ca9f2d7c0d9b4acc70cc97ee7555b8dc026a4fb5b10cca1 |
| check:doc-references | 0 | f0c574a06149cbd6be1e8701576fcb3a4cf108ee319f89b99ced64be4d059ef4 |

작성 후 같은 7개 script를 2026-09-08T11:32:24.491Z–2026-09-08T11:32:25.864Z에 실행했다.
전부 exit 0이며 작성 전과 exit·출력 SHA가 7/7 동일하다. 실패 이름·신규 실패는 0건이다.
이는 R1 HEAD와 미추적 receipt의 로컬 문서 검사이며 develop CI나 구현 검증이 아니다.
최종 결과 문단 전사 후에도 raw bytes/hash·승인 상태·보존을 다시 확인한다.
R1 package JSON의 과거 AOD/R 검증 구획과 요청문 작성 시 검증은 원 bytes대로 보존한다.
위 관측은 이번 receipt 작성에 귀속하고 검토자 보고·미래 actual-start 증명을 대신하지 않는다.

strict UTF-8/BOM/CR/후행 공백/끝 LF·YAML parse·사람 회신/다섯 결정/권한 상태·
path/hash/원문 결속·상대 링크·diff --check/no-index --check·파일 보존을 별도로 확인한다.
Git publication/CI 조회·재실행/설치/T01/suite/lint/typecheck/Proxy probe/keygen/signing/
provider·DB·운영 호출은 수행하지 않는다.
