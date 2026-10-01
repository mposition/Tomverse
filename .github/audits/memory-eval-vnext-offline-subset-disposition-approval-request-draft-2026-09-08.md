# memory-eval vNext — 사후 기록·처리방침 승인 요청 초안

**DRAFT / UNSIGNED — 사람 판정 대기. 이 파일 자체는 승인 receipt가 아니다.**
작성자: Codex. 작성일: 2026-09-08. 작성일은 승인일이 아니다.
요청 식별자: offline_subset_posthoc_disposition_approval_request_2026_09_08

사용자의 “네 작성해주세요”는 검토된 OD-R1 두 파일을 보존하면서 확인 검토·ODR-F1 보완과
미결정 처리방침을 묶은 **별도 승인 요청 초안 작성** 지시다. 사람 승인·A/B 선택·F07 변경·
구현 강화·commit/push/PR/병합·activation 허가로 전사하지 않는다.
과거 mposition의 승인자/승인일을 이번 미회신 칸에 복사하지 않는다.

이번 산출물은 이 Markdown 한 파일뿐이다. 검토된 OD-R1 Markdown/JSON과 승인 원문,
구현 I, 원본 snapshot·보고서·전달 프롬프트는 수정하지 않는다.
새 암호 receipt·운영 wire schema·signer/key/등록·구현/시험 시료를 만들지 않는다.

## 1. 요청 대상 — 검토된 raw bytes와 이 별도 보완의 구분

| 대상 | path | Raw SHA-256 | Bytes / LF lines | commit |
|---|---|---|---|---|
| OD-R1 문서 | .github/audits/memory-eval-vnext-offline-subset-review-disposition-draft-2026-09-08.md | aaf16425e8ff5ead15d3e25e71bce809ff15e481717a20f1ad6f08a64eab082a | 41175 / 572 | 없음, untracked |
| OD-R1 근거 JSON | .github/audits/evidence/memory-eval-vnext-offline-subset-review-disposition-2026-09-08.json | 90e55c1f13471b5040103972d8476b8a10b51f67eaadd815a65fe42686693b11 | 173045 / 3022 | 없음, untracked |

[검토된 OD-R1 문서](memory-eval-vnext-offline-subset-review-disposition-draft-2026-09-08.md)와
[검토된 OD-R1 근거 JSON](evidence/memory-eval-vnext-offline-subset-review-disposition-2026-09-08.json)의
raw SHA는 승인 여부와 무관하게 그대로 보존한다. OD-R1 문서가 결속한 evidence hash는
위 JSON의 90e55c1f…이며 원 JSON hash나 보고서 hash가 아니다.

구현 참조 commit I: **54ad04e29aa3390f4d342d152127e99928b4268e**
I의 유일 parent / 구현 basis T: **718aaf974e254e32bcb010ff2c1170a06011eed5**
현재 요청 작성 HEAD=I, branch=codex/memory-eval-vnext-offline-subset-implementation.
I는 두 OD-R1 문서를 포함하지 않으며, **I를 문서 commit/이번 approvalCommit으로 대용하지 않는다.**

아래는 승인 요청 상태표이지 서명 payload가 아니다.

```yaml
recordStatus: draft_unsigned
recordKind: offline_subset_posthoc_disposition_approval_request
requestId: offline_subset_posthoc_disposition_approval_request_2026_09_08
repository: mposition/Tomverse
requestDocumentCommit: null
reviewedDocumentCommit: null
implementationReferenceCommit: "54ad04e29aa3390f4d342d152127e99928b4268e"
implementationBasis: "718aaf974e254e32bcb010ff2c1170a06011eed5"
decision: pending
approvedBy: null
approvedAt: null
approvalReceiptCommit: null
requestedDecisions:
  reviewedRawBytesAndReviewLimits: pending
  oiF1CurrentPosthocEvidence: pending
  oiF1HistoricalTimingGapAsResidual: pending
  odrF1SupplementAndLimits: pending
  oiF2SeparateIdPathDeferral: pending
  oiF3Direction: null
  oiF4SeparateRunnerDeferral: pending
upstreamConditionsPreserved: null
acceptedDispositionIds: []
historicalPreStartTimingProven: false
oiF1ClosureDeclared: false
odrF1ExternalClosure: null
oiF3ExactContractChangeApproved: false
implementationChangeAuthorized: false
gitPublicationAuthorized: false
mergeAuthorized: false
activationAuthorized: false
operationalSigningAuthorized: false
paidExecutionAuthorized: false
```

pending/null/빈 목록은 미판정이다. “승인 요청 초안을 작성하라”는 답이나 검토자의
CONFIRMED를 decision=yes로 바꾸지 않는다.
OD-R1의 pending/confirmationReview=null는 그 문서 작성 시점 상태로 남긴다.
그 후 받은 확인 검토는 아래 별도 기록으로 결속하며 원 bytes를 갱신하지 않는다.

## 2. 검토 결과의 귀속 — 어디까지 CONFIRMED인가

### 원 OD 초안 최초 검토

| 항목 | 값 |
|---|---|
| 원 OD Markdown SHA | 7041f7f5898ca333ae1d54f3656644d26c736011b32d8e4ad121009406fa233b |
| 원 OD JSON SHA | 0400f4455f620038c990e82872d724ec6a6233ca8c7be6976b772c10d56eee72 |
| 보고서 locator | C:/Users/Vyper/.codex/attachments/8c91b016-4cd6-401a-8e32-0790a509163e/pasted-text.txt |
| 보고서 raw SHA-256 / bytes | 63373d6b845a439908661bec3eb356ce6b885c650f59e28fb68da625fc9edb84 / 10830 |
| 보고된 판정 | PASS_WITH_WARNINGS — P1 0/P2 0/P3 4, OD-F1–OD-F4 |

원본 snapshot 위치·hash는 OD-R1 §12와 JSON.draftRevision.originalDrafts에 있다.
이번에도 raw hash를 확인했다. 로컬 임시 사본이며 장기 보관이나 Git 고정을 의미하지 않는다.

### OD-R1 수정본 확인 검토 — 1회 완료

| 항목 | 값 |
|---|---|
| 대상 | §1의 OD-R1 두 raw SHA, 문서 commit 없음 |
| 회차 | offline_subset_disposition_draft_confirmation_2026_09_08 |
| 보고서 locator | C:/Users/Vyper/.codex/attachments/4038bda6-12ab-4427-8c6a-a21e7cd5b135/pasted-text.txt |
| 보고서 raw SHA-256 / bytes | 573b386a8434cec8f9b63b9f6454532e8cff62b8b525f4ef162efe2ba66dd202 / 9294 |
| 보고된 판정 | CONFIRMED — OD-F1–OD-F4 모두 해결, 의도된 수정과 그 회귀 확인 |
| 남은 새 finding | ODR-F1, P3 — 원 OD 최초 검토 prompt의 보존 기준 hash가 기록에서 누락 |
| A/B 평가 | 사람이 판단할 만큼 구체적이며 필수 문언 누락 없음. 선택은 하지 않음 |

확인 검토자는 7개 package check의 exit/출력 hash와 기존 doc-reference 8건, 세-trap 재현,
원문·지원·구현 및 계보를 대조했다고 보고했다. 이는 **그 보고서에 귀속하는 실행**이다.
이번 요청 작성자의 새 전체 구현 검증이나 운영 proof로 복사하지 않는다.

CONFIRMED는 **검토된 두 문서의 수정 적합성**이다. 다음은 증명/허가하지 않는다.

- “착수 전에 별도 T 재검증 기록이 있었다”는 과거 시점 증명이나 OI-F1 closure.
- 사람의 사후 기록/잔여 수용, OI-F3 A/B 선택, F07 보장 축소 또는 새 구현 범위 승인.
- 이 새 요청 문서나 아래 §3 보완 자체가 Claude 확인 검토를 받았다는 주장.
- I 병합, 최신 develop CI/배포, activation, 실제 signer/운영 권한.

OD-R1 확인 검토 1회는 완료된 회차로 보존한다. 원 I/Q/D 검토 회차와 섞거나 추가 확인을
자동 반복하지 않는다. 이후 실제 계약·구현 범위 변경은 그 변경의 별도 지시·검토 범위 문제다.

## 3. ODR-F1 — 20번째 보존 파일의 별도 식별 보완

OD-R1이 “수정 밖 일반 파일 20개 보존”이라고 썼으나, 원 JSON.git.untracked에는 19개만 있고
추가된 원 OD 최초 검토 prompt의 기준 hash가 없었다. 검토자는 그 20번째의 **존재만 확인**했고,
19개+ignored 3개는 hash 22/22 일치를 보고했다.
문제는 별도 증거 목록의 누락이며 그 검토자가 20번째의 과거 보존까지 확인했다고 고치지 않는다.

검토된 두 문서에 field를 소급 삽입하지 않고, 아래 **작성자 보완**을 함께 읽을 것을 요청한다.

| 필드 | 이번 직접 관측 |
|---|---|
| file | .github/audits/memory-eval-vnext-offline-subset-disposition-independent-review-prompt-2026-09-08.md |
| raw SHA-256 | 7ed8131932280fbd5962c1bc8489b02499494c1ee1d8af65afb58b305c0569e0 |
| bytes / LF lines | 24477 / 338 |
| observedAt | 2026-09-08T08:05:55.297Z |
| method | 파일을 binary Buffer로 읽어 SHA-256 계산. trim/개행 변환/텍스트 재직렬화 없음 |
| authority | 검토 전달 prompt. 승인 원문·운영 receipt가 아님 |
| 보완 상태 | author_evidence_supplement_pending_human_acceptance |
| ODR-F1 외부 closure | 없음. CONFIRMED의 대상으로 소급하지 않음 |

[원 OD 최초 검토 prompt](memory-eval-vnext-offline-subset-disposition-independent-review-prompt-2026-09-08.md)의
현재 bytes를 이 표로 직접 재계산할 수 있다. 검토 당시 대상인 OD-R1 두 raw hash는 바뀌지 않는다.

작성자가 보관한 OD-R1 수정 시작 2026-09-08T07:42:58.284Z의 도구 관측에도
동일 path/hash가 있었다. 다만 이 과거 도구 관측은 **작성자 귀속**이며, 독립 검토 보고서가
인정한 과거 보존 증명으로 승격하지 않는다. 그 과거 baseline 로그 전체는 이 파일에 포함하지
않으므로 이 문서만으로 독립 확인할 수 없다. 위 observedAt의 현재 raw identity와 구별한다.
원 OD 최초 prompt 파일에 사후로 hash를 삽입하거나 새 서명을 만들어 과거 증거를 보충하지 않는다.

따라서 이번 보완이 제공하는 것은 **누락된 현재 파일 식별자와 명시된 과거 관측 한계**다.
사람에게 이 보완과 잔여 한계를 수용할지 요청하며, 검토자의 새 closure 또는 과거 시점 증명을
만들었다고 선언하지 않는다.

보존 집합도 시점별로 분리한다.

- OD-R1 수정 밖: 원 JSON.git.untracked 19개 + 위 prompt 1개 = 일반 파일 20개.
  여기에 원 JSON.git.ignored 문서 3개를 더한 23개가 당시 보존 주장 대상이다.
- 이번 요청 작성 시작: OD-R1 두 파일과 확인 검토 prompt도 포함해 일반 untracked 23개.
  기존 ignored 문서 3개까지 **이번 보존 기준선은 26개**이며 새 요청 파일은 포함하지 않는다.
- 이번 요청 파일 추가 후: 일반 untracked 24개가 된다. .claude/·.codex/ directory 2개는
  별도이며 내부 전체 재귀 조사/해시를 수행했다고 주장하지 않는다.

## 4. 사람이 판단할 처리방침

### OI-F1 — 사후 기록 수용과 과거 시점 공백 수용은 별개

다음 두 항목을 나누어 판단할 것을 요청한다.

1. OD-R1 §1이 열거한 26원문/9지원/6구현·계보/diff·환경·T CI·한정 검사 등의
   **현재 관측에 기초한 사후 기록**을 증거 보완 자료로 수용할지.
2. “실제 착수 전에 별도 T 기록이 있었다”는 사실은 입증되지 않았다는 공백을
   **accepted residual로 남기는 처리방침**을 수용할지.

두 항목을 수용하더라도 historicalPreStartTimingProven=false를 바꾸지 않는다.
receipt §7.4가 과거에 충족됐거나 미기록 사실이 소멸했다고 소급 선언하지 않는다.
현재 증거로 무엇을 수용하고 어떤 시점 공백을 남겼는지를 새 receipt에 정확히 적는다.
OI-F1 전체 closure를 검토자 대신 선언하지 않는다. I를 amend/rebase/squash하지 않는다.

미래 새 착수 tip에서는 착수 전에 원문/support/환경/CI를 정확한 tip에 다시 결속한다.
이번 T 기록은 미래 develop 이동이나 후속 작업의 사전 검증 면제서가 아니다.

### OI-F2 — ID와 path의 exact 결정 보류 유지

현재 Q/S3의 입력 규범과 I bytes를 유지하면서, ID/path 축소를 각각 별도 결정으로 남길지
요청한다. 비공백 ASCII 0x21–0x7e 후보는 space까지 제외하는 축소이며 자동 버그 수정이 아니다.
path에 같은 ASCII 범위를 적용하여 NFC 비ASCII·공백을 함께 제거하지 않는다.
normalize/trim/case-fold, validator 수정, 과거 값 변환을 이번 수용으로 허가하지 않는다.

### OI-F3 — A/B는 미선택, 이번 요청은 방향 결정과 다음 승인 범위의 구분

Q JSON F07의 “accessor 호출 등 사용자 코드를 실행하지 않음”과 I의 Proxy trap 실행 사이에
차이가 남는다. 두 문서가 CONFIRMED됐다는 이유로 I가 광범위한 F07을 충족했다고 선언하지 않는다.

| 선택 | 판단할 방향 | 선택만으로 허용되지 않는 것 |
|---|---|---|
| A — 보장 축소 방향 | property getter/setter·toJSON·custom iterator hook 미호출로 한정하고 caller Proxy trap 실행 방지는 보장하지 않는 **실질 보장 축소**를 별도 exact 계약 변경 대상으로 준비 | F07 자동 수정/면제, 과거 I의 소급 충족, 승인 원문 덮어쓰기, 구현/병합/activation |
| B — 보장 유지·강화 방향 | 기존 no-user-code 보장을 유지하면서 Proxy 거절 등의 강화 범위·실현 가능성·시험을 별도 exact 패키지로 준비 | 새 builtin/helper/API 채택·구현, 같은 6파일 내 무승인 변경, Proxy 거절만으로 모든 경계 해결 선언 |
| 보류 | 방향을 고르지 않고 pending 유지 | 선택에 의존한 후속 계약 변경·구현·I 적합성 선언 |

A/B의 세부 후보는 OD-R1 §8과 JSON.dispositionProposals의 미선택 options 그대로다.
이번 요청에서 A/B를 고르는 것은 **후속 exact 패키지를 어느 방향으로 준비할지**에 대한
판단이다. 이 파일은 아직 exact amendment나 구현 allowlist/AC 승인 패키지가 아니므로,
방향 선택을 oiF3ExactContractChangeApproved=true 또는 implementationChangeAuthorized=true로
전사하지 않는다. 별도 작성 지시 없이 후속 패키지를 자동 시작하지도 않는다.

A를 택하면 영향받는 Q/S1 요구, C01/C02 진입점·입력 전제·잔여 위험·효력 대상 SHA와
원 승인 관계를 exact 변경 문언에 결속하여 별도 승인받아야 한다.
B를 택하면 root/nested/revoked Proxy·bytes 경계 전제, 거절 순서·허용 builtin/helper·
test/AC·음성 case·실현 가능성을 먼저 확정해야 한다. 기존 C01 builtin 허용은
node:crypto hash뿐이며 새 import를 자동 승인하지 않는다.

방향을 보류하면서 사후 기록만 수용할 수 있다. 그 경우 사람 회신과 receipt에 “방향 보류”를
명시하고 관련 후속 단계는 계속 중단한다. 일반적인 “승인합니다”에서 A/B를 추측하지 않는다.

### OI-F4 — runner는 별도 작업으로 유지

Windows test runner의 ENAMETOOLONG 문제를 기존 6파일 범위 밖 후속 작업으로 남길지
요청한다. 이 판단은 runner 수정/issue 생성/분할 실행 구현 권한이 아니다.
후속 범위를 정할 때 기존 package 진입점·discovery·server/client 분리·flags·누락/중복 방지·
실패 집계/exit 보존을 확인한다. 이번에는 runner·package·config를 변경하지 않는다.

## 5. 기존 승인·잔여·미승인 범위

S2 approvalCommit A=3f14afb29eddc243640fdb0a5a4f604646ade9f0,
통합 계약 승인 CA=80842e62925c05af9450e6acc6ceb70b56f67655,
D=159267a80acee97da3a297c637343ea15de725f9,
K=6b2465e921c6e8b99ff032a36be8ada61c0ad599,
H=a19ae39d0da61295eb17e1545c74bc5b7e702c1a,
Q=7e5491f5fa24295912d5da7a6cc5e86ddb637f43,
기존 scope receipt commit RC=bd69a817006fb45ee88aa399940acec3d4e36470을 보존한다.
이번 요청이나 미래 사후 기록 receipt/I를 A/CA/K/activationApprovalCommit으로 승격하지 않는다.

원 decision의 400줄·§13 공란 및 승인 raw SHA
355f8387808b8a7ea86e02ecffc4303562b5ab5c43c27fef0c2bdb2bf57e89da,
D1–D5/§12, S1/S2 P2-N1·C-COORD-1/R-*, S3/S4 N-1/N-2 및 별도 D namespace 잔여를
보존한다. D 확인 검토 1/1 소진도 유지하며 새 확인 회차로 초기화하지 않는다.
HD-1–HD-8 pending/null, OP 7개, 상위 54 AC partial 9/deferred 45/fullySatisfied 0을 바꾸지 않는다.

수용 시에도 이 요청이 새로 허용하지 않는 것은 다음과 같다.

- scorer/ledger/full P/resolver/controller/운영 adapter 또는 기존 6파일의 구현 변경.
- 새로운 key/signature/TrustAnchor 등록, registration parser·trust digest·폐기 이력 운영.
- EnvironmentApproval/ClockPolicy/genesis/root/journal/checkpoint/proof·백업 복구 운영.
- S2 purpose 전환·activationApprovalCommit/C, dataset/manifest/register 변경.
- holdout 작성·검수·seal/open, S5/v9 prompt 작성·활성화.
- pair/예산/dispatch/re-run/provider 호출·유료 turn.
- production/Railway/DB 접속·설정·배포, release gate 또는
  memoryExtractionEnabled/memoryInjectionEnabled 변경.
- package/lock/config/runner/dependency 변경, commit/push/PR/ready/auto-merge/병합/배포.

하위 verifier 동결→실제 정책 등록→trustPolicyDigest→전체 P 채택→genesis/root,
D<K<activationApprovalCommit<C, S2 전환 검증→F 동결→holdout seal→S5→E/pair/예산/dispatch
순서를 면제하지 않는다. 새 tip 재검증·명시적 착수 지시도 그대로 필요하다.

## 6. 사람 회신 양식 — 미회신, 자동 제출되지 않음

파일을 편집하거나 SHA를 다시 계산할 필요 없이 아래 판단만 대화로 답하면 된다.
아래는 작성자가 서명한 승인 예시가 아니라 **아직 제출되지 않은 요청 양식**이다.

```text
대상: 이 승인 요청 초안과 §1의 OD-R1 두 raw SHA
검토된 bytes·검토 한계·기존 승인/잔여 유지: 미회신
OI-F1 현재 사후 증거 수용: 미회신
OI-F1 과거 시점 공백을 잔여로 수용: 미회신
ODR-F1 작성자 보완과 과거 관측 한계 수용: 미회신
OI-F2 ID/path 별도 결정 보류 유지: 미회신
OI-F3 후속 방향: 미선택 (A / B / 보류)
OI-F4 runner 별도 작업 유지: 미회신
이번 판단은 F07 exact 변경·구현·publication/merge/activation 승인이 아님: 미회신
승인자: 미회신
승인일: 미회신
```

일부 항목만 수용하면 그 항목만 기록한다. 빠진 항목을 accepted로 채우거나 A/B를 추측하지
않는다. 범위를 줄이거나 다른 선택을 요청하면 정확한 범위가 확인될 때까지 해당 부분은 pending이다.
한 번의 일반 승인 회신만으로 미선택 A/B와 별도 구현 권한을 함께 만들어내지 않는다.

## 7. 실제 회신 뒤 별도 authoritative receipt

명시적인 사람 회신을 받은 뒤, **원 OD-R1 bytes와 이 요청의 승인 당시 bytes를 보존**하면서
별도 receipt를 준비한다. 이 초안의 pending 칸이나 검토된 JSON을 수정해 승인을 표현하지 않는다.
향후 receipt에는 최소 다음을 적는다.

- 실제 decision/approvedBy/approvedAt과 항목별 수용·보류, 선택한 OI-F3 방향.
- §1 두 exact path/raw SHA/길이와 아직 없는 문서 commit의 구분.
- 이 요청 초안의 승인 당시 path/raw SHA, 존재하는 경우 실제 commit.
- CONFIRMED 보고서의 대상·path/raw SHA·판정 범위와 ODR-F1 P3 잔여.
- §3의 prompt path/hash/현재 관측 시각·과거 관측 한계와 사람의 보완 수용 범위.
- OI-F1 historicalPreStartTimingProven=false 및 잔여 처리, OI-F3 exact 변경/구현 승인 부재,
  기존 승인·잔여·순서 보존.

이 문서는 자기 최종 raw hash나 미래 receipt/commit SHA를 자기 본문에 미리 넣지 않는다.
문서 raw SHA·Git blob OID·문서 commit·receipt commit·S2 approvalCommit은 서로 다른 식별자다.
사람 승인 receipt는 이 저장소의 감사 문서이며 새 암호 서명 schema를 도입하지 않는다.

이번 회신 이후에도 commit/push/PR/병합은 별도 지시가 필요하다.
Git 고정을 진행하라는 지시가 오면 제출할 **정확한 파일 allowlist**를 먼저 확인한다.
미commit OD-R1 두 파일·이 요청·미래 receipt를 모두 자동으로 stage하거나, 로컬 보고서와
임시 snapshot/기존 전달 prompt를 무관 untracked와 함께 commit하지 않는다.
필요한 감사 자료의 저장소 내 장기 보존 방식도 그때 범위를 정한다.
현재 locator/hash만으로 외부 첨부·임시 사본의 영구 보존을 보장하지 않는다.

허가된 후속 제출에서는 원 I/문서 commit의 SHA를 보존하고 amend/rebase/squash로
과거 승인 계보를 바꾸지 않는다. develop 병합 방식과 해당 tip CI 확인도 별도 지시의
범위로 수행한다. 감사 기록 제출만으로 I의 미결정 F07 적합성을 승인하지 않는다.

## 8. 이번 요청 작성의 관측·검증

작성 시작 관측: 2026-09-08T08:05:55.297Z, HEAD=I, tracked/index clean.
§1 두 파일, 검토 보고서 3개, 전달 prompt 2개 및 원본 snapshot 2개의 raw SHA를 다시 계산했다.
ODR-F1의 prompt 현재 hash는 §3에 직접 기록했다.
검토된 JSON의 26원문·9지원·6구현 hash, 기존 일반 untracked 23개·ignored 문서 3개는
보존 검사 대상으로 삼으며, 이번에는 이 요청 파일만 새로 만든다.

로컬 PC PowerShell, H:\Project\ai-chat-hub clone 안에서 이미 설치된 Node 22/dependencies로
검사한다. production 자격증명 없이 실행하는 검사이며 package script를 그대로 사용한다.
필수 OS/PATH/TEMP 등만 전달한 allowlisted child에 부재를 확인한
H:/Project/ai-chat-hub/.os-f4-absent-env-file을 DOTENV_CONFIG_PATH로 지정하고,
DOTENV_CONFIG_QUIET=true, NEXT_TELEMETRY_DISABLED=1은 child에만 적용한다.
.env/비밀값을 읽거나 부모 창 환경·설정을 바꾸지 않는다.

| package script | 작성 전 exit | 작성 전 stdout+stderr raw SHA-256 |
|---|---|---|
| check:encoding:strict | 0 | 7d5195263cb38b5aa0de4bf8e0ead06774933b4e124616518883574554bcd380 |
| check:policy-section-references | 0 | a023c1b4064b51f38930616299cf1b1cd344d1d96ff41f3b32025f9f9398682e |
| check:release-records | 0 | 5d216eabba9f6eb6762717a31e2bc3c26172d530ed554ab099a9c21a537f3565 |
| check:memory-eval-succ9 | 0 | f792af65d17e277fecceedf03b5eaba6484180748d3013de077a027a005e194c |
| check:memory-extraction-eval | 0 | 575a56bac68f5e261286b5e00894451bd0fb1b7b5cead22e49d8d8f28315629b |
| check:memory-eval-freeze | 0 | 8318af98d6c2a2ce9ca9f2d7c0d9b4acc70cc97ee7555b8dc026a4fb5b10cca1 |
| check:doc-references | 1 | a71fe18e693b1d3bd8a77f83701bf950e0d8cef5635c3330ba9e85d466d2ac6a |

작성 전은 6개 exit 0, doc-references exit 1/기존 8건이다.
capture는 UTF-8 stdout 다음 stderr를 변환/trim/개행 추가 없이 연결해 hash한 것이다.
철회된 npm ls stdout identity나 과거 commit 직전 로그를 이 표의 근거로 쓰지 않는다.
작성 후 같은 7개 script를 다시 실행했고 6개 exit 0, doc-references exit 1/기존 8건으로
작성 전과 exit·전체 출력 bytes·hash 7/7이 같다. 신규 실패는 0건이다.
이는 I checkout에서 이 요청 문서 작성 전후를 비교한 것이며 T clean-tree 전체 suite나
최신 develop CI를 실행한 결과가 아니다.

doc-reference 기준선은 app/layout.tsx를 향한 lib/documentLanguage.ts,
app/[locale]/layout.tsx, scripts/security-regression-check.mjs,
tests/e2e/ssr-root-language.spec.ts의 Windows missing 4건과 동일 POSIX historical unused 4건이다.
이름·내용·출력 hash로 대조하며 개수만으로 동일 실패라고 하지 않는다.
이 요청 작성에서 기준선 오류를 고치지 않는다.

audit 의미·승인 상태·raw SHA 결속·상대 링크·strict UTF-8/JSON·BOM/CR/후행 공백/끝 LF는
일반 package reference check와 별도로 확인한다. tracked/index diff --check와 새 파일의
no-index --check를 구분한다. no-index exit 1/진단 0건은 추가 diff이지 공백 오류가 아니다.
최종 metadata 전사 후 bytes·링크·hash·보존을 재확인한다.

이번에는 T01/전체 suite/lint/typecheck/88-case harness, 새 Proxy 재현, 설치 inventory·npm ls,
GitHub/CI/develop 상태를 재실행/재조회하지 않는다. 승인 원문·구현이 그대로인 문서 요청
작성 범위이기 때문이다. 보고서의 과거 실행을 이번 직접 실행으로 전사하지 않는다.
운영/provider/DB 호출·keygen/signing·CI dispatch·dependency 설치·Git publication은 없다.
