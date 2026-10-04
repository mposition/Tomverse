# memory-eval vNext — OI-F2 ID/path 정책·정정 수용 사람 승인 초안

**DRAFT / UNSIGNED — 사람 판정 대기. authoritative approval receipt가 아니다.**
작성자: Codex. 작성일: 2026-09-09. 작성일은 승인일이 아니다.
이 문서는 고정된 IP-2 두 문서와 검토·정정 이력에 대한 별도 승인 요청이다.
원 패키지의 pending/null을 고치거나 과거 사람 승인을 재사용하지 않는다.

## 1. 요청과 승인 상태

사용자 지시:

> 한 줄 정정과 SHA 재결속, 처리 이력 기록후 커밋후 SHA 고정해서 사람 승인 초안 분비해주세요.

이 지시는 문서 정정·commit·초안 준비 권한이며 IP-D1–IP-D5나 미래 M3 착수 승인이 아니다.
이번에는 기존 패키지 두 파일만 commit했고, 그 뒤 이 초안 한 파일을 별도 로컬 untracked로 작성한다.
푸시·PR·병합·CI dispatch·추가 Claude 호출·구현은 수행하지 않는다.

~~~yaml
recordKind: oi_f2_id_path_policy_and_correction_approval_draft
recordStatus: draft_unsigned_pending_human_approval
requestId: oi_f2_id_path_policy_approval_2026_09_09
repository: mposition/Tomverse
isAuthoritativeApprovalReceipt: false
repositoryBasis: 17b074c600e98e8fe52175ea0cbc6c5860b0c742
approvalTargetCommit: 13a6b088cd88d53d971e66f358e297b8c71c6ad7
postReviewCorrectionCommit: 13a6b088cd88d53d971e66f358e297b8c71c6ad7
reviewedDocumentCommit: 896a8ad756ce2f1a5bf3dff85d238240a8e2f2b8
reviewCommit: 896a8ad756ce2f1a5bf3dff85d238240a8e2f2b8
initialReviewCommit: 1979839dc200687336db3d72526e9a76c860be71
predecessorApprovalReceiptCommit: b98509dcd9ac9c19e389dece4da429301e2510aa
implementationReferenceCommit: e0a8c743695fce278592c29e85d32279fa1f2b85
decision: pending
approvedBy: null
approvedAt: null
humanApprovalResponse: null
requiredDecisionIds: [IP-D1, IP-D2, IP-D3, IP-D4, IP-D5]
acceptedDecisionIds: []
requestedDecisions:
  IP-D1: pending
  IP-D2: pending
  IP-D3: pending
  IP-D4: pending
  IP-D5: pending
requestedAcceptances:
  exactIP2PackageAndReviewLimits: pending
  IP-R1-F1: pending
  pathAndCompatibilityResiduals: pending
  upstreamResidualsAndSeparateStartGates: pending
reviewHistory:
  initialVerdict: PASS_WITH_WARNINGS
  confirmationVerdict: CHANGES_REQUIRED
  resolvedDocumentFindingIds: [IP-F1]
  confirmationRemainingFindingIds: [IP-R1-F1]
  usedConfirmationRounds: 1
  maximumConfirmationRounds: 1
  postCorrectionIndependentlyReviewed: false
  postCorrectionIndependentReviewVerdict: null
thisDraftIndependentlyReviewed: false
policyChangeApprovedNow: false
futureImplementationScopeApprovedNow: false
implementationChangeAuthorizedNow: false
implementationStartAuthorizedNow: false
oiF2ExternalClosureDeclared: false
fullF07OrFullPDeclared: false
gitPublicationAuthorizedByThisDraft: false
prOrMergeAuthorizedByThisDraft: false
ciDispatchAuthorizedByThisDraft: false
activationAuthorized: false
operationalSigningAuthorized: false
paidExecutionAuthorized: false
approvalReceiptCommit: null
requestDocumentCommitAtPreparation: null
~~~

pending/null/빈 목록은 실제 미판정이다. reviewCommit은 검토자가 읽은 **R1**을 가리키고,
approvalTargetCommit은 그 뒤 한 줄 정정·SHA 재결속·이력을 담은 **R2**를 가리킨다.
R2를 독립 검토된 commit이라고 부르거나 R1 보고서가 R2 bytes를 검토했다고 해석하지 않는다.
사람은 아래 R2 exact bytes와 이 차이를 함께 수용할지 결정한다.

## 2. 승인 요청 대상 — R2 두 문서의 exact bytes

| 역할 | 고정 Git identity |
|---|---|
| 최종 승인 요청 대상 R2 / IP-2 | 13a6b088cd88d53d971e66f358e297b8c71c6ad7 |
| R2 유일 parent / 확인 검토 대상 R1 | 896a8ad756ce2f1a5bf3dff85d238240a8e2f2b8 |
| R1 유일 parent / 최초 검토 대상 R | 1979839dc200687336db3d72526e9a76c860be71 |
| R 유일 parent / 작성 basis T | 17b074c600e98e8fe52175ea0cbc6c5860b0c742 |
| 작성 branch | codex/memory-eval-vnext-oi-f2-id-path-approval |
| R2 subject | Resolve OI-F2 fixture wording and record review disposition |

| 승인 요청 path | Git blob OID | Git raw SHA-256 | bytes / LF |
|---|---|---|---|
| .github/audits/memory-eval-vnext-oi-f2-id-path-approval-package-draft-2026-09-09.md | ef69b9cc9bd29aaae3d1b9b95995842070a1b52f | 14e0b11f71991c30e4bde14a0b502b1b1cce678a095fbd957e4b62e3ffbce2d0 | 38766 / 517 |
| .github/audits/evidence/memory-eval-vnext-oi-f2-id-path-approval-package-2026-09-09.json | dc5d6ca9693c07d70329278c3393f9eec6e8a4b0 | 12a2b3fb145b2807529450dda8c091d78d4a47bfb80814f368185aecb1cf6ab0 | 139437 / 3234 |

[IP-2 Markdown](memory-eval-vnext-oi-f2-id-path-approval-package-draft-2026-09-09.md)과
[IP-2 JSON](evidence/memory-eval-vnext-oi-f2-id-path-approval-package-2026-09-09.json)이 정책·시험·범위의 원문이다.
표는 Git blob raw bytes를 식별한다. JSON 재직렬화 hash나 보고서 hash가 아니다.
JSON.document.rawSha256은 위 Markdown을 결속하고 JSON 자신의 hash는 이 별도 초안에서 식별한다.

R1→R2는 위 두 파일 M만, 110 insertions / 3 deletions다.
Markdown의 규범 변경은 §5 한 줄이며 revision IP-2 표기와 §11 처리 이력을 추가했다.
JSON semantic 변경은 /document/rawSha256와 /correction 두 pointer뿐이다.
기존 futureCases 전부, authority, requestedDecisions, proposedPolicies, M3, source45/support9,
fixtureProjection, remaining, revision 및 기존 verification은 그대로다.
T→R2도 같은 두 문서 A만이며 구현·test·fixture·dataset·register·prompt·flag 변경이 없다.

R1 원본의 Markdown SHA는
6bda0de06ac52373009f90bc1b3d08f1802186a1d06769b2ea6295db4063d4e4,
JSON SHA는 44ef01e06d0779aad77af68d4bfbe520e5d5bec8c00e0c5c05d4a6aa9b931621이다.
이 값은 검토된 역사적 R1을 식별하며 위 R2 승인 대상 hash로 대체하지 않는다.
R1/R 원본은 각 commit에 보존돼 있고 JSON.correction/sourcePackageFiles와 revision/sourcePackageFiles가
각각 R1/R을 식별한다. 원 decision 400 LF/§13 공란과 기존 승인 계보도 보존한다.

## 3. 검토 결과와 IP-R1-F1 처리 수용 요청

| 보고서 | 실제 검토 대상 | 판정 | 원문 raw SHA-256 | bytes / LF / CR |
|---|---|---|---|---|
| IP 최초 독립 검토 | 1979839dc200687336db3d72526e9a76c860be71 | PASS_WITH_WARNINGS; P1 0/P2 0/P3 1 | 5d7acbe9fb1bbb4f7cf707f20fccadf69ef4df5e2232c37f20a7469bd045ab7c | 21054 / 163 / 0 |
| IP-F1 변경분 확인 검토 | 896a8ad756ce2f1a5bf3dff85d238240a8e2f2b8 | CHANGES_REQUIRED; 새 P3 IP-R1-F1, 승인 차단 아님 | 4b0acdaf0a13f011cc40d80fe5f350053617b30d579e86241dd8fee32817e9f8 | 16454 / 157 / 157 |

원문 locator:

- 최초: C:/Users/Vyper/.codex/attachments/cdc77e91-891a-4778-af66-570e4652d916/pasted-text.txt
- 확인: C:/Users/Vyper/.codex/attachments/ffd6b2e9-1e21-4c19-b7a0-09e72fa74d90/pasted-text.txt

두 보고서 bytes는 수정·재인코딩·Git 추가하지 않았다. hash는 내용 식별이며 작성자 인증,
암호 서명, 영구 보관 보장이 아니다. 보고서의 검사 실행은 검토자 관측에 귀속한다.

최초 IP-F1은 새 idPathPolicy의 내용 계약과 IP↔AC 양방향 assertion 부재였다.
R1에 IP01–IP20 순서의 20 row, id/acId/verification/expected 네 primitive string,
T01의 독립 고정 기대표와 exact equality, unit15/external5, 양방향 집합·순서 대조,
IP15 expected의 literal 비교를 명시했고 확인자는 **그 문서 finding 해소**를 보고했다.

확인 검토는 바로 위의 “비운영 시료” 문구가 네-field 닫힌 shape와 충돌한다고 지적했다.
이를 P3/승인 비차단 IP-R1-F1로 남겨 전체 판정은 CHANGES_REQUIRED다.

| IP-R1-F1 처리 | exact 내용 |
|---|---|
| 정정 전 | 미래 idPathPolicy는 비운영 시료·기대값·IP01–IP20 추적성만 담는다. |
| 정정 후 | 미래 idPathPolicy는 기대값·IP01–IP20 추적성만 담는다. |
| 기계적 동반 변경 | Markdown raw SHA 재계산 및 JSON.document.rawSha256 재결속 |
| 이력 | Markdown §11 / JSON.correction; R1·보고서 bytes와 실제 판정 결속 |
| 현재 처리 상태 | author_corrected_pending_human_acceptance |

보고서의 “JSON 수정은 필요하지 않음”은 정책·시험 값에 한정해 수용한다.
Markdown을 고친 뒤 기존 결속 SHA를 남기는 것은 무결성 오류이므로 hash 갱신은 필수였다.
추가 field·새 시료·기대값 변경·다른 정책 변경은 없다.

이 한 줄 정정은 작성자가 범위·bytes·검사로 확인했으며 **R2의 외부 확인 판정은 없다**.
사람에게 요청하는 것은 IP-R1-F1 정정과 그 독립 재검토 부재를 알고 R2 exact bytes를 수용하는 결정이다.
원 보고서의 CHANGES_REQUIRED를 CONFIRMED로 고치지 않는다. 확인 검토 1/1 사용을 보존한다.

이 초안은 검토된 정책과 한 줄 정정의 결속·수용 양식이며 새 설계/시험 계약을 만들지 않는다.
따라서 작성자는 이 초안에 추가 독립 검토를 자동 반복할 필요가 없다고 판단했다.
이는 범위 판단이지 초안이나 R2가 독립 검토를 통과했다는 주장이 아니다.
정정 범위를 넘어 새 정책/구현 설계가 필요해지면 별도 지시와 검토 범위로 분리한다.

## 4. 사람이 승인할 IP-D1–IP-D5 — 현재 모두 pending

이 표는 IP-2 §4–§7을 요약한다. 정확한 승인 대상은 §2 두 파일의 전체 해당 계약이다.
다섯 결정과 조건을 한 묶음으로 요청한다. 부분 승인이라면 미승인 부분을 묵시적으로 구현하지 않고
그 부분 승인에 맞는 새 exact 패키지를 준비해야 한다.

| ID | 승인 요청 내용 | 유지할 한계 |
|---|---|---|
| IP-D1 | 비어 있지 않은 primitive opaque ID의 모든 문자를 U+0021..U+007E, 94개 ASCII 기호로 제한. C0/space/DEL/non-ASCII 거절 | 11개 지정 field 위치와 isAsciiId만. 대소문자·punctuation 보존, trim/변환/alias 없음. fixed-format ID·다른 상위 문자열 문법 불변 |
| IP-D2 | 지정 상대 path는 기존 NFC Unicode scalar/space 및 상대 문법을 보존하고 C0 U+0000..U+001F와 DEL 거절 | BlobRef.path, GitFileRef.path, TrustAnchor.registrationReceipt.path와 기존 actual/expected consumers. ASCII-only path나 파일 접근 권한 검사가 아님 |
| IP-D3 | 후속 승인 구현을 선택한 실행부터 새 lexical 제한 적용, 과거 bytes/verdict 불변 | 새 제외값은 invalid_input 가능. 자동 migration/repair/legacy fallback/schemaVersion 변경 없음. 기존 허용집합 안 결과·bytes·digest·오류 순서 보존 |
| IP-D4 | 미래 C02/T01/T11 세 파일의 exact 범위와 B19 projection 예외 승인 | 새 builtin/helper export/import/dependency/runner/static gate 없음. C01/C03/C04 및 Proxy/bytes helper bytes 보존 |
| IP-D5 | IP01–IP15 unit + IP16–IP20 external, exact AC·보존·별도 착수 조건과 잔여 수용 | unit/external/전체 CI를 서로 대체하지 않음. 실제 tip 재검증과 별도 착수 지시 전 구현 금지 |

ID 11개 위치는 SignaturePayload 3개, SignatureReceipt.payload 3개, TrustAnchor 2개,
BindingExpectation 3개(purpose/signerId/trustEpoch의 해당 위치)다.
C03/C04는 기존 C02 공유 경로로 제한을 받으며 lexical 성공이 지원 purpose/등록 역할/사람 권한을 뜻하지 않는다.
D의 purpose→role, 신규 activation approver 별도 regex와 exact 등록값 비교를 바꾸지 않는다.

### 4.1 IP-D4의 미래 M3와 fixture 조건

| ID | 미래 변경 path | 허용 범위 |
|---|---|---|
| C02 | lib/memoryEvalVnext/protocol/wire.ts | Only isAsciiId/isRelativePath lexical predicates and directly related comments; existing exports/imports unchanged |
| T01 | tests/memoryEvalVnextWire.test.mjs | Separate IP tests/inventory and exactly scoped B19 projection adjustment |
| T11 | tests/fixtures/memory-eval-vnext/wire-vectors.json | Append idPathPolicy only; original15 values/order immutable |

T11은 현재 15 key이며 idPathPolicy가 없다. 미래에는 한 key만 끝에 추가해 정확히 16 key이고,
기존 15개 값/순서를 보존한다. idPathPolicy는 시료 payload 보관소가 아니라
IP01–IP20의 id/acId/verification/expected 네-field row와 추적성 계약이다.
T01 기대표는 패키지에서 독립 전사한 literal이며 검사 대상 fixture에서 정답을 만들지 않는다.
IP→AC와 AC→IP 목록의 집합·순서를 대조하고 IP15 자신의 expected도 고정 문자열로 비교한다.

| 미래 검사 | 제외 key | 불변 projection SHA-256 |
|---|---|---|
| B19 original14 | 정확히 proxySafety, idPathPolicy | 1d286a257c44d3444de99b945a8276cd680b8b30adc41bf0fc5df32a5f4123ca |
| IP15 original15 | 정확히 idPathPolicy | e59c8ef30d4dae1430e113392d63924e9d2a77cd764edd8297e59ed2d987e652 |

projection은 JSON.parse의 insertion order를 유지해 key를 제외한 뒤 JSON.stringify(no replacer/no space),
UTF-8·추가 LF 없음의 SHA다. mem-cjson-1/domain hash나 파일 raw SHA와 다르다.
현재 T11 raw SHA 136469c95aeeeacdeb0069e457476a273036e5d73964f336f2fbc6f6d4dcc70f는 이번에도 불변이지만,
미래 key 추가 후 raw SHA는 달라진다. 과거 raw SHA를 새 T11의 hash라고 주장하지 않는다.
F44(40 unit/4 external), B24(19 unit/5 external), IP20(15 unit/5 external)을 분리한다.
영구 gate를 새로 만들거나 기존 F41/F/B 완료 집합을 완화하지 않는다.

## 5. 함께 수용할 잔여와 부여하지 않는 권한

사람 승인 대상에는 다음 명시적 잔여가 포함된다. 기존 계약보다 보장을 확대하지 않는다.

- path의 C1 U+0080..U+009F, U+2028/U+2029, zero-width/bidi/format scalar와
  기타 NFC Unicode는 나머지 조건이 맞으면 계속 수용한다. 선행/후행 space 및 space-only segment도 유지한다.
- ID의 punctuation 허용은 shell/URL/path 실행 권한이 아니다. path의 percent/URL decode,
  NFC/trim/case-fold/슬래시 치환/realpath/OS device-name 처리는 하지 않는다.
  Unicode 시각적 유일성·OS portability·파일 존재·symlink·승인 root·접근 권한 안전성을 보장하지 않는다.
  resolver/보관 계층의 기존 의무를 구현하거나 면제하지 않는다.
- 운영 ID/path corpus·DB·private package 호환성을 조사하지 않았다. 영향 0 선언이 아니다.
  새 제한 밖 과거 object를 검증해야 하는 사용처 발견 시 별도 보존/전환 결정을 요청한다.
- T01의 고정 기대표 전사 정확성은 IP18 외부 감사로 별도 대조해야 한다.
  문서 일관성 계산과 미래 unit/external 통과는 다르다.
- OI-F1 시점 공백 accepted residual/closure=false, OI-F4 별도 runner,
  ODR-F1 외부 closure 부재, BI/BFR 수용 한계·m3/m6 생존·영구 정적 강제 부재를 유지한다.
  상위54 AC partial9/deferred45/full0, HD-1–HD-8/OP 7개와 기존 실행 격리·intrinsics 신뢰 전제도 그대로다.

승인이 이루어져도 다음 권한은 부여하지 않는다.

- 즉시 M3 착수, C02/T01/T11 밖 변경, 새 dependency/builtin/helper export/runner/영구 static gate.
- scorer/ledger/full P/resolver/controller/custodian/importer·등록 parser/trust digest 생성,
  운영 key/signature/genesis/root/journal/checkpoint/backup/attestation.
- dataset/manifest/register, S2 purpose/activation, holdout 작성/seal/open, S5/v9 prompt,
  pair, 예산/dispatch/provider·DB/Railway/production/배포, release gate,
  memoryExtractionEnabled/memoryInjectionEnabled 변경.
- OI-F2 외부 closure·전체 F07/full P 충족 선언, 일반 JavaScript sandbox 보장,
  과거 문서·receipt·보고서 bytes의 소급 수정.
- 이 초안이나 사람 승인만을 근거로 한 push/PR/merge/CI dispatch.

기존 S2 approvalCommit=3f14afb29eddc243640fdb0a5a4f604646ade9f0,
contractApprovalCommit=80842e62925c05af9450e6acc6ceb70b56f67655 및
D<K<activationApprovalCommit<C 순서를 새 R2/미래 receipt로 치환하지 않는다.
원 decision SHA 355f8387808b8a7ea86e02ecffc4303562b5ab5c43c27fef0c2bdb2bf57e89da,
400 LF/§13 공란과 상위 승인 원본은 불변이다.

## 6. 사람 승인 뒤에도 필요한 별도 단계

1. 실제 회신의 결정·승인자·승인일·수용 범위를 별도 authoritative receipt에 기록한다.
   R2 두 path/hash/commit, R1 실제 검토 대상과 보고서 판정, 한 줄 정정,
   이 승인 요청 초안의 exact bytes를 함께 결속한다. 미래 receipt commit을 미리 발명하지 않는다.
2. 승인된 R2 두 파일은 그대로 보존한다. 이 초안의 pending도 과거 초안 이력으로 남긴다.
   실제 receipt가 승인 근거이며 R1/R2 자체가 approvalReceiptCommit은 아니다.
3. 별도 제출 지시 후 push/PR/CI, 원 SHA를 보존한 merge commit develop 반영과 실제 develop tip CI를 확인한다.
   squash/rebase로 고정 SHA 계보를 끊지 않는다.
4. 실제 착수 tip에서 support9 Git/working bytes, runtime·설치/lock·scope·승인 계보·CI를
   별도 착수 기록으로 재검증한다. 이번 문서 검증은 OS-F4 완료가 아니다.
5. 확인된 tip에서 새 codex/ 구현 브랜치를 준비하고 **별도 명시적 착수 지시** 뒤에만 승인된 M3를 구현한다.

IP-D4의 미래 범위를 승인하는 것과 지금 코드를 바꾸라는 착수 지시는 별개다.
모든 미래 IP group은 여전히 not_run_future_implementation이다.

## 7. 작성자가 직접 확인한 정정·commit 검증

실행 위치: 로컬 PC PowerShell, H:/Project/ai-chat-hub. 기존 Node v22.22.2,
npm 10.9.7, tsx 4.23.13, TypeScript 6.0.3.
production 자격증명 없이 package.json의 실제 npm script를 사용했다.
OS/PATH/TEMP/user-cache allowlist만 child에 전달하고, 부재 확인한 .os-f4-absent-env-file을
DOTENV_CONFIG_PATH로, DOTENV_CONFIG_QUIET=true/NEXT_TELEMETRY_DISABLED=1을 child에만 지정했다.
부모 셸·Git config·설치·lock·환경 파일은 바꾸지 않았다.

| 단계 | HEAD / 대상 | 실제 실행 구간 또는 관측 UTC |
|---|---|---|
| 정정 전 clean 기준선 | R1 | 2026-09-09T12:02:25.398Z–2026-09-09T12:02:54.837Z |
| 문서 직접 검증 | R1 위 수정된 두 working 파일 | 2026-09-09T12:05:14.013Z |
| 정정 후 검사 | R1 위 수정된 두 working 파일 | 2026-09-09T12:05:14.349Z–2026-09-09T12:05:19.005Z |
| 두 파일 commit 확인 | R2 | 2026-09-09T12:05:52.057Z |
| commit 후 clean 검사 | R2 | 2026-09-09T12:05:52.484Z–2026-09-09T12:05:57.398Z |

| npm run script | 전 / 후 / commit 후 exit | 세 회차 동일 output SHA-256 |
|---|---|---|
| check:encoding:strict | 0 / 0 / 0 | 7d5195263cb38b5aa0de4bf8e0ead06774933b4e124616518883574554bcd380 |
| check:policy-section-references | 0 / 0 / 0 | bc9a33ead4deb5a419249fddec5a8f681136d645dbfc2cab1967995cae12059a |
| check:release-records | 0 / 0 / 0 | 5d216eabba9f6eb6762717a31e2bc3c26172d530ed554ab099a9c21a537f3565 |
| check:memory-eval-succ9 | 0 / 0 / 0 | f792af65d17e277fecceedf03b5eaba6484180748d3013de077a027a005e194c |
| check:memory-extraction-eval | 0 / 0 / 0 | 575a56bac68f5e261286b5e00894451bd0fb1b7b5cead22e49d8d8f28315629b |
| check:memory-eval-freeze | 0 / 0 / 0 | 8318af98d6c2a2ce9ca9f2d7c0d9b4acc70cc97ee7555b8dc026a4fb5b10cca1 |
| check:doc-references | 0 / 0 / 0 | fdf56bff206d251401863a06e045c07b7663ae53ea0514976ea99d15686c8375 |

output SHA는 stdout raw bytes 뒤 stderr raw bytes를 결합한 SHA-256이다.
기준선/신규 실패 이름은 0개, 이름별 출력도 7/7 동일했다.
policy reference 기존 unscoped/ambiguous 1421/229와 v4/v6 eval-budget approval 대기 notice는 유지됐다.
작성 기준 T/과거 CI나 검토자의 실행을 위 새 실행으로 대체하지 않았다.

직접 계산한 범위:

- 두 파일 Git/working raw SHA, strict UTF-8/no BOM/CR0/EOF LF 한 개/후행 공백 없음.
- 한 줄·revision·처리 이력 외 Markdown 불변, JSON semantic pointer 두 개만 변경.
  YAML/JSON 사람 미승인 값과 정책/시험/allowlist/잔여 불변, 상대 링크 11회 확인.
- source45/support9 Git·working bytes, 상위 ancestry17개 및 R→R1→R2 계보 보존.
  fixture 원시 bytes 및 original14/original15 projection 불변. 실제 fixture/key/IP test는 만들지 않았다.
- diff --check, stage 전후 정확히 대상 두 경로와 staged blob SHA 확인, commit 후 working/index clean.
- 기존 untracked30 regular-file hash/디렉터리 존재, stash17, core.autocrlf=false,
  .git/config mtime 2026-09-09T08:48:18.806Z 보존.
  세 보호 디렉터리 내부 전체를 재귀 hash로 확인했다는 뜻은 아니다.

현재 R2는 로컬 commit이며 이번에 push/원격 ref·CI 조회/CI dispatch를 수행하지 않았다.
R1/R2 CI 완료나 develop 반영을 주장하지 않는다.
full unit/T01/lint/typecheck/typegen/build/E2E, mutant/fixture prototype, 설치 전체 inventory·lock closure,
운영 corpus/DB/provider·flag 조회는 미실행이다. 향후 실제 착수 검증의 대체가 아니다.

이 초안은 commit 후 작성했으므로 위 세 회차가 초안 최종 bytes의 검사라는 뜻은 아니다.
초안에는 별도로 strict UTF-8·YAML pending/null·target/review/report hash·상대 링크·no-index --check와
원문 보존 검사를 적용하고, 같은 npm script를 작성 후 다시 대조한다.
초안 자신의 hash나 미래 commit을 본문에 넣지 않는다.

## 8. 사람이 회신할 범위

승인 요청은 §2의 **R2 두 exact bytes**, §3의 CHANGES_REQUIRED 보존·IP-R1-F1 한 줄 정정과
R2 독립 재검토 부재, §4의 IP-D1–IP-D5, §5의 잔여/권한 제한, §6의 별도 착수 조건 전체다.
전체 승인인지 부분 승인/보류인지, 실제 승인자와 승인일을 회신하면 작성자가 별도 receipt로 전사한다.
승인일은 실제 사람 회신값만 쓰고 제공되지 않은 instant나 전자서명을 만들지 않는다.

현재 사람 회신은 없다. 승인 초안 준비 지시·과거 mposition 승인·IP-F1 해소를 decision=yes로 대체하지 않는다.
quality-documentation-manager의 원문 보존·처리 이력·관측/승인/착수 분리 원칙을 적용했다.
의료 QMS 인증이나 새 암호서명·운영 wire receipt를 도입하지 않는다.

## 9. 초안 작성 후 검증 관측

2026-09-09T12:10:19.650Z–2026-09-09T12:10:24.239Z에 §7의 npm script 7개를 다시 실행했다.
모두 exit 0이며 정정 전 clean R1 기준선과 이름별 stdout+stderr SHA도 7/7 동일했다.
기준선/신규 실패 이름은 0개다.

2026-09-09T12:10:19.311Z의 직접 대조에서 초안 strict UTF-8/no BOM/CR0/EOF LF 한 개/후행 공백 없음,
YAML의 pending/null·허가 false·R2 승인 대상/R1 검토 대상 구분, 두 패키지와 보고서 raw SHA,
상대 링크 2개 및 no-index --check의 빈 진단을 확인했다.
no-index exit 1은 빈 NUL 입력과 이 비어 있지 않은 초안의 차이이며, 오류를 성공으로 바꾼 것이 아니다.

기존 untracked30항목을 보존하고 이 초안1개만 더해31항목이다. R2 뒤 tracked/index는 깨끗하며
초안은 stage/commit하지 않았다. 기존 source45/support9·fixture/두 projection·상위17 조상·
stash17·Git config 값/mtime도 유지됐다. 보호 디렉터리 내부 전수 hash 보존은 주장하지 않는다.
위는 이 결과 문단 전사 전 관측이며, 전사 후 최종 bytes·미승인 상태·고정 대상·보존 상태도 다시 대조한다.
