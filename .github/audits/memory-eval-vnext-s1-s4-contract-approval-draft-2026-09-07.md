# Memory eval vNext S1–S4 통합 계약 승인 record 초안 — 2026-09-07

**상태: DRAFT / UNSIGNED — 통합 판정 대기, 승인 효력 없음.**
작성자: Codex. 작성일은 통합 승인일이 아니다.

이 문서는 이미 승인된 S1/S2와 S3/S4의 최종 문서·Git commit·raw SHA-256·기존 승인
receipt를 하나의 판정 대상에 결속하는 초안이다. 계약을 다시 작성하거나 기존 승인을
철회·대체하지 않는다. 기존 부분 승인은 유효하지만 **이번 통합 판정은 아직 pending**이다.
사용자의 통합 기록 작성 지시는 그 결과물의 최종 승인이나 S2 activation 승인이 아니다.

## 1. 통합 판정 대기 기록

아래 priorApprovals의 yes·승인자·승인일·accepted 목록은 기존 receipt에서 읽은 역사적
사실이다. 최상위 decision·approvedBy·approvedAt·accepted 목록은 **이번 통합 판정**을
위한 별도 필드이며, 과거 값을 복사해 채우지 않는다. 두 층의 판정을 혼동하지 않는다.

```yaml
recordStatus: draft_unsigned
recordKind: consolidated_contract_approval
decision: pending
approvedBy: null
approvedAt: null
approvalScope: S1_S4_contracts_only
consolidationOnly: true
repositoryBasis: "6c36a548abf1687d2582566f31fafa51875b77fa"
decisionApprovalCommit: "3f14afb29eddc243640fdb0a5a4f604646ade9f0"
contractApprovalCommit: null
activationApprovalCommit: null
contractDocumentsForDecision:
  - id: S1
    documentCommit: "fa682cc2209fc5b0a9ebd994aa626d00997b0359"
    path: ".github/audits/memory-eval-vnext-s1-scoring-contract-2026-09-06.md"
    sha256: "393497a5acbe7ee47af6947a84204eac7723fdd973bf30afad79c812da4db0e7"
    gitBlobOid: "4dc1ea945850b283ad9654a4bcaf8967e241e863"
    bytes: 65000
    lines: 778
    priorApprovalId: S1_S2
  - id: S2
    documentCommit: "fa682cc2209fc5b0a9ebd994aa626d00997b0359"
    path: ".github/audits/memory-eval-vnext-s2-purpose-contract-2026-09-06.md"
    sha256: "e9a6a086be32e4d12df776015959c7c95be5185af7dc635403e8cd6689f4baa5"
    gitBlobOid: "6ab7c0813818a2575cf20915c9f42ba84b5d28e1"
    bytes: 45965
    lines: 632
    priorApprovalId: S1_S2
  - id: S3
    documentCommit: "4d8a7c317b570e0c30fc5a05438cb7cc78354039"
    path: ".github/audits/memory-eval-vnext-s3-holdout-contract-2026-09-07.md"
    sha256: "66a29c01dd5e2d099817ee799afc960f090e93f900be53b546b8b73f4d3b3d05"
    gitBlobOid: "bd45e60dcaa9a0c7193fda87d6022d0e429ff54c"
    bytes: 61926
    lines: 726
    priorApprovalId: S3_S4
  - id: S4
    documentCommit: "4d8a7c317b570e0c30fc5a05438cb7cc78354039"
    path: ".github/audits/memory-eval-vnext-s4-provenance-contract-2026-09-07.md"
    sha256: "e7bc98a98a6e03b31403061312e5c6abab10e7e27456f1077d3a68362ede67bb"
    gitBlobOid: "761c5debe81e48f25870b9ea36a71c1de8165bd1"
    bytes: 76581
    lines: 847
    priorApprovalId: S3_S4
priorApprovals:
  - id: S1_S2
    receiptCommit: "52caa2cecbd32cab97736993bd57630b1e3e3bc2"
    path: ".github/audits/memory-eval-vnext-s1-s2-contract-approval-2026-09-07.md"
    sha256: "50a2c323054c8cd2a186b9ed5d5e6d206927b8cda1be1990d0796b350388e4c2"
    decision: yes
    approvedBy: "mposition"
    approvedAt: "2026-09-07"
    approvalScope: S1_S2_contracts_only
    reviewedContractCommit: "fa682cc2209fc5b0a9ebd994aa626d00997b0359"
    approvedDraft: ".github/audits/memory-eval-vnext-s1-s2-contract-approval-draft-2026-09-07.md"
    approvedDraftSha256: "f28e58f68d03435d31834373eaeab2171ead71620947ed12a478b9ba8fa56b38"
    acceptedConditionIds: ["P2-N1","C-COORD-1"]
    acceptedResidualIds: ["R-SENS-1","R-GRAM-1","R-DETECTOR-1","R-KO-SUBJECT-1","R-PRELEDGER-1","R-SCOPE-1"]
  - id: S3_S4
    receiptCommit: "025212c4f9bd0dcb2deb4d9ade2925f3bbc6ef92"
    path: ".github/audits/memory-eval-vnext-s3-s4-contract-approval-2026-09-07.md"
    sha256: "811e6a08691e3bacb3ddd9465d4bdf68a40a3b9748177c975e1852733db271cf"
    decision: yes
    approvedBy: "mposition"
    approvedAt: "2026-09-07"
    approvalScope: S3_S4_contracts_only
    reviewedContractCommit: "4d8a7c317b570e0c30fc5a05438cb7cc78354039"
    approvedDraft: ".github/audits/memory-eval-vnext-s3-s4-contract-approval-draft-2026-09-07.md"
    approvedDraftSha256: "fc051930ae6f3343a03f649d7733df3266d517b4a4a01090d81b459e64ac2f0f"
    acceptedConditionIds: ["N-1","N-2"]
    acceptedResidualIds: ["R-S3-ISOLATION","R-S3-CUSTODY","R-S3-HUMAN","R-S3-RETENTION","R-S4-CONTROL-PLANE","R-S4-RACE","R-S4-API","R-S4-CHECKPOINT","R-S4-TIME","R-S4-SPEND","R-S4-PROTECTION","R-S4-LOSS"]
requiredConditionIds: ["P2-N1","C-COORD-1","N-1","N-2"]
requiredResidualIds: ["R-SENS-1","R-GRAM-1","R-DETECTOR-1","R-KO-SUBJECT-1","R-PRELEDGER-1","R-SCOPE-1","R-S3-ISOLATION","R-S3-CUSTODY","R-S3-HUMAN","R-S3-RETENTION","R-S4-CONTROL-PLANE","R-S4-RACE","R-S4-API","R-S4-CHECKPOINT","R-S4-TIME","R-S4-SPEND","R-S4-PROTECTION","R-S4-LOSS"]
acceptedConditionIds: []
acceptedResidualIds: []
upstreamD1D5AndSection12Acknowledged: null
priorApprovalsAndConditionsAcknowledged: null
implementationAuthorized: false
activationAuthorized: false
paidExecutionAuthorized: false
```

documentCommit은 각 기존 승인 receipt가 최종 검토 대상으로 결속한 commit이다.
S1/S2는 fa682cc2…, S3/S4는 4d8a7c31…이며 단일한 새 통합 검토 commit이 있었던
것으로 바꾸어 쓰지 않는다. 각 파일은 해당 documentCommit과 repositoryBasis에서
동일한 Git blob bytes를 갖는다. gitBlobOid는 Git object 식별자이고 sha256은 raw
파일 bytes의 digest다. bytes·lines는 UTF-8/LF 원문의 길이이며 최종 LF를 포함한다.

contractApprovalCommit과 activationApprovalCommit의 null은 아직 이 통합 승인 및
activation 승인 commit을 만들지 않았다는 뜻이다. 미래 자기 commit SHA를 본문에
예측해 넣지 않는다. 이 초안을 commit하더라도 **미승인 초안의 commit**일 뿐이다.

## 2. 불변 원문·기존 승인 근거

아래 경로·commit·raw SHA-256을 함께 보존한다. §1의 네 계약은 현재 통합 판정 대상이며,
아래 원문은 그 판정이 승계할 기존 근거다. 하나의 hash를 다른 문서의 승인 hash로 대용하지 않는다.

| 역할 | 원문을 읽는 commit | 경로 | raw SHA-256 |
|---|---|---|---|
| decision | `3f14afb29eddc243640fdb0a5a4f604646ade9f0` | `.github/audits/memory-eval-vnext-contract-decision-2026-09-05.md` | `355f8387808b8a7ea86e02ecffc4303562b5ab5c43c27fef0c2bdb2bf57e89da` |
| decisionReceipt | `3f14afb29eddc243640fdb0a5a4f604646ade9f0` | `.github/audits/memory-eval-vnext-contract-decision-approval-2026-09-06.md` | `838af4d1fee11122b5a2ec6b72d5ed905a59b2b370ec2d7b88e87bdd193291f5` |
| S1S2Receipt | `52caa2cecbd32cab97736993bd57630b1e3e3bc2` | `.github/audits/memory-eval-vnext-s1-s2-contract-approval-2026-09-07.md` | `50a2c323054c8cd2a186b9ed5d5e6d206927b8cda1be1990d0796b350388e4c2` |
| S1S2Draft | `52caa2cecbd32cab97736993bd57630b1e3e3bc2` | `.github/audits/memory-eval-vnext-s1-s2-contract-approval-draft-2026-09-07.md` | `f28e58f68d03435d31834373eaeab2171ead71620947ed12a478b9ba8fa56b38` |
| S3S4Receipt | `025212c4f9bd0dcb2deb4d9ade2925f3bbc6ef92` | `.github/audits/memory-eval-vnext-s3-s4-contract-approval-2026-09-07.md` | `811e6a08691e3bacb3ddd9465d4bdf68a40a3b9748177c975e1852733db271cf` |
| S3S4Draft | `025212c4f9bd0dcb2deb4d9ade2925f3bbc6ef92` | `.github/audits/memory-eval-vnext-s3-s4-contract-approval-draft-2026-09-07.md` | `fc051930ae6f3343a03f649d7733df3266d517b4a4a01090d81b459e64ac2f0f` |

원래 decision의 저장소 basis는 `6263ecdcc1e69585498c19c0a294fef5202f5218`이다.
S2의 approvalCommit은 계속 **A `3f14afb29eddc243640fdb0a5a4f604646ade9f0`**다.
A에 기록된 @mposition / 2026-09-06 승인은 D1–D5와 §12 전체의 기존 승인이지 이번
통합 판정의 서명이 아니다. 원래 decision은 §13이 빈 400줄 bytes를 그대로 유지한다.

S1/S2와 S3/S4의 기존 approvedDraft 전체 문언은 각각의 확정 receipt가 이미 결속했다.
그 초안의 DRAFT/pending 표시와 계약 본문의 In Review·당시 미승인·확인 검토 미완료 표시는
역사적 상태다. 후속 승인 사실은 각 확정 receipt로 읽으며 원문 상태 문구를 수정하지 않는다.
이 초안의 pending 역시 **통합 판정 대기**일 뿐 기존 부분 승인이 사라졌다는 뜻이 아니다.

## 3. 작성 basis·병합·CI 계보

이 초안은 PR #1270의 SHA 보존 merge와 develop CI 완료를 확인한
`6c36a548abf1687d2582566f31fafa51875b77fa`에서 작성한다.
새 브랜치는 `codex/memory-eval-vnext-s1-s4-approval-record`이며 to-develop 경로 조각이 없다.

| 구간 | 확인한 Git 관계 |
|---|---|
| S1/S2 최종 문서 → 부분 승인 | `52caa2cecbd32cab97736993bd57630b1e3e3bc2`의 parent는 `fa682cc2209fc5b0a9ebd994aa626d00997b0359` |
| S1/S2 develop 포함 | `f5abaecf77ee56d08cdd7e50ca43c0110d03e6b4`의 parent는 `11f11f0d38dea3c28d365503bc7b77ed0d793204`와 `52caa2cecbd32cab97736993bd57630b1e3e3bc2` |
| S3/S4 최초 → 수정본 → 부분 승인 | `3f1e1e261951b946e0e066dc510aad160a73d9f8` → `4d8a7c317b570e0c30fc5a05438cb7cc78354039` → `025212c4f9bd0dcb2deb4d9ade2925f3bbc6ef92`, 각각 직접 parent 관계 |
| S3/S4 develop 포함 / 이번 basis | `6c36a548abf1687d2582566f31fafa51875b77fa`의 parent는 `f5abaecf77ee56d08cdd7e50ca43c0110d03e6b4`와 `025212c4f9bd0dcb2deb4d9ade2925f3bbc6ef92` |

A, 두 부분 승인 commit, 네 최종 문서 commit은 모두 이번 basis의 조상으로 보존된다.
basis tree는 승인된 S3/S4 PR head 025212c4…의 tree와 같으며, 직전 develop 대비
추가는 S3/S4 계약·승인 초안·확정 receipt 네 감사 문서뿐이다.

해당 basis의 develop push CI는 다음 두 실행으로 확인했다.

- [Admin Console E2E 34086306122](https://github.com/mposition/Tomverse/actions/runs/34086306122):
  attempt 1 success. production build와 Admin Console E2E를 실제 실행했다.
- [Credit Finance DB Integration 34086306143](https://github.com/mposition/Tomverse/actions/runs/34086306143):
  attempt 1 success. 7개 PostgreSQL 시나리오와 집계가 모두 통과했다.

이 CI는 basis 상태의 검증 근거이지 이 새 초안의 CI·독립 검토·사람 승인이나 운영 적합
판정이 아니다. PR Fast Gate는 pull_request 전용이므로 develop에서 새로 실행됐다고
기록하지 않는다. merge·CI·외부 배포 status는 통합 승인 또는 activation 승인을 만들지 않는다.

## 4. 조건·잔여의 통합 승계 — 축소·대체·새 해석 없음

통합 판정은 다음을 **본문 전체와 함께** 승계할지에 관한 판정이다.

- S1/S2 receipt §3·§5 및 그 approvedDraft **§4·§5의 모든 세부 문단**.
- S3/S4 receipt §3–§5 및 그 approvedDraft **§4·§5의 모든 세부 문단과 N-2 관측 처리 표**.
- 원래 decision D1–D5, §12 여섯 잔여와 기존 decision receipt의 권한 제한.

구체 제약·운영 비용·실행 차단 경계는 §2에서 hash로 고정한 원문 전체를 따른다. 아래는
추적용 색인이고 원문의 대체 요약이 아니다. 각 partial receipt에서 accepted였다는 사실과
이 통합 초안의 required 목록을 분리한다. 현재 통합 accepted 목록은 아직 비어 있다.

| 조건 ID | 기존 수용 출처 | 유지하는 경계의 색인 |
|---|---|---|
| P2-N1 | S1/S2 receipt·draft | sensitive_review gold의 evidence region을 permitted로 표시하지 않음. bulk_safe gold만 permitted 참조. 모든 permitted slice 검사·case-local OR 유지 |
| C-COORD-1 | S1/S2 receipt·draft | Collision.start/end는 target slice 상대 NFC scalar 좌표, AuthoringTarget region은 message 절대 NFC scalar 좌표 |
| N-1 | S3/S4 receipt·draft | controller signing key를 runner에 배포하지 않음. runner gate는 중앙 controller의 인증된 client이며 단일 writer/fencing·증거 검증 우회 및 무검증 대리 서명 금지 |
| N-2 | S3/S4 receipt·draft | API 관측으로 미실행을 구별하지 못하면 contacted_unknown. journal grant/intent 0건이나 빈 steps만으로 external_not_executed를 인증하지 않음. 완전 증거·영구 duplicate 규칙 유지 |

P2-N1·C-COORD-1은 최종 S3의 FR-5·§2에도 명시돼 있음을 대조했다. 이는 계약 문언
승계 확인이지 실제 authoring validator 구현·holdout 검증 완료가 아니다. N-1/N-2의
사람 수용은 S3/S4 receipt에 기록됐지만 구현·검증 이행은 아직 별개다. 통합 기록을
근거로 새 API 조합을 whitelist하거나 기존 CONFIRMED의 대상 bytes를 바꾸지 않는다.

| 잔여 ID | 기존 수용 출처 | 유지하는 잔여의 색인 |
|---|---|---|
| R-SENS-1 | S1/S2 | 단독 민감성·결합형 사실의 표현 한계와 authoring 거부, false FAIL/누락·holdout 소비 비용 |
| R-GRAM-1 | S1/S2 | closed grammar/identity-nfc-1의 좁은 분포, 표현·대표성 한계 |
| R-DETECTOR-1 | S1/S2 | paraphrase 미포착·사람 검수 한계, detector false만으로 allowed 불가 |
| R-KO-SUBJECT-1 | S1/S2 | 한국어 주어 생략의 사용자 귀속은 gold/evidence 사람 검수에 의존 |
| R-PRELEDGER-1 | S1/S2 | 유일한 V 예외 밖 pre-ledger purpose unknown, 모든 pair revoked 추론 금지 |
| R-SCOPE-1 | S1/S2 | historical 122 / forward 109 + ledger / 공유 13개 역할·호환성 비용, pinned snapshot 역사 재현 |
| R-S3-ISOLATION | S3/S4 | projection·격리의 사람 통제 의존, 분포·민감성·quota 대표성 한계 |
| R-S3-CUSTODY | S3/S4 | attested ephemeral self-hosted·사람 session·fresh key·분리 보관·복구 운영 비용과 겸직·OS/RAM 위험 |
| R-S3-HUMAN | S3/S4 | gold-withheld와 blind 구분, 사람 노출·기억 회수 불가와 보수 소비 |
| R-S3-RETENTION | S3/S4 | 증거 사용 기간의 암호화 보존·key backup·장기 접근/복구 비용, 유실 시 재검증 불능 |
| R-S4-CONTROL-PLANE | S3/S4 | P/E/R/T 분리, run.head_sha=T와 evaluatedCommit=E, protocol 수명 동결·migration 미정의 |
| R-S4-RACE | S3/S4 | journal/custody/GitHub/provider 비원자성, duplicate 지출·노출 회수 불가 |
| R-S4-API | S3/S4 | 관측 범위·늦은 run·불명 차단 비용, 30초 안정 관측의 한계 |
| R-S4-CHECKPOINT | S3/S4 | 중앙 single-writer·외부 trust root/checkpoint·장기 보관/복구 의존, 증명 전 실행 불가 |
| R-S4-TIME | S3/S4 | check→call race·clock 오차·UTC source 신뢰, 실제 source/ClockPolicy 별도 고정 |
| R-S4-SPEND | S3/S4 | usage/가격 신뢰 한계, unknown·실패·중복 비용 전건 기록, guardrail과 admissibility 분리 |
| R-S4-PROTECTION | S3/S4 | 기존 보고서의 당시 보호 설정·관리자 우회 가능성, 미래 정책 별도 재조회·사람 승인 |
| R-S4-LOSS | S3/S4 | 실제 provider 접촉 없이도 unknown/만료로 holdout 손실, 재예약·창 연장·재전송으로 복구 금지 |

상위 §12의 여섯 잔여는 별도로 계속 유지한다: 닫힌 parse의 false negative, 1인 조직의
겸직과 사람 수준 blind 부재, human extra-content 판단의 오류, 탐지 전 duplicate spend,
GitHub/importer 신뢰, message 단위 evidence 결속 한계. 위 18개 목록으로 상위 잔여를
대체하거나 D1–D5의 의미를 좁히지 않는다.

잔여를 수용하는 것은 안전 조건 면제나 이행 완료가 아니다. 특히 R-S4-PROTECTION은
기존 확인 보고서의 당시 관측을 인지하는 것이며, 오늘의 보호 설정 적합 판정·설정 변경
승인이 아니다. R-S4-TIME 역시 실제 UTC source/ClockPolicy를 지금 선택하지 않는다.
현재 S3/S4 계약의 구현되지 않은 의존성을 이 통합 문서로 구축·검증됐다고 간주하지 않는다.

## 5. 독립 확인 검토와 이번 통합 판정의 구분

기존 부분 승인에 연결된 외부 확인은 다음과 같다. 이 작업에서 원 보고서의 존재와 raw
SHA-256·길이를 대조했다. 새 독립 검토를 수행·의뢰하거나 API/crypto 사실을 재감사한 것은 아니다.

```yaml
priorConfirmationReviews:
  - scope: S1_S2
    reviewedCommit: "fa682cc2209fc5b0a9ebd994aa626d00997b0359"
    result: CONFIRMED
    reportPath: "C:/Users/Vyper/.codex/attachments/c9d45ce4-f000-46a7-abf4-bf6761854f48/pasted-text.txt"
    reportSha256: "e2205f0b9b985bde93d04f67f3f3b054b102811721cbcd218ccec0e21fcfab2d"
    bytes: 16636
  - scope: S3_S4
    reviewedCommit: "4d8a7c317b570e0c30fc5a05438cb7cc78354039"
    result: CONFIRMED
    reportPath: "C:/Users/Vyper/.codex/attachments/5b088c11-afc4-40a7-98c6-4ec6f06eabad/pasted-text.txt"
    reportSha256: "74048dda3c0a4f6cf66853d88dd4abe318ac9a90ebf29046dbe14af30c956188"
    bytes: 16023
```

위 CONFIRMED는 각각 명시된 reviewedCommit의 S1/S2 또는 S3/S4 bytes에만 귀속된다.
이번 통합 초안·미래 확정 receipt 자체를 Claude가 검토하거나 승인했다는 뜻이 아니다.
각 묶음의 예정된 확인 검토 1회는 완료됐으며 통합 전사는 추가 확인 검토 회차가 아니다.
원 보고서 전체가 Git에 들어 있다는 주장도 하지 않는다. 기존 receipt와 승인 초안은
Git에 보존돼 있지만, 위 보고서 원문은 별도로 지목한 로컬 첨부다.

## 6. contractApprovalCommit의 성립과 별도 권한

이 초안을 제시한 뒤 사람이 네 계약의 exact identity, 기존 두 부분 승인, 조건 4개·잔여
18개 및 상위 D1–D5/§12를 그대로 결속하는 **통합 범위와 초안 전체 문언**을 명시적으로
승인해야 한다. 승인자·승인일은 그 새 판정에서 받아 별도 확정 receipt에 전사한다.
기존 mposition / 2026-09-07을 이번 통합 서명으로 재사용하지 않는다.

승인받은 이 초안의 raw bytes/hash는 보존하고, 확정 receipt는 그 초안 hash 및 §1·§2의
모든 결속을 명시한다. 기존 계약·부분 승인·승인 초안을 수정하지 않는다. 부분 거절이나
조건 변경 요청은 전체 승인으로 처리하지 않으며, 계약 개정이 필요하면 별도 범위로 다룬다.

사람 승인과 별도 commit 지시 후 그 **확정된 S1–S4 통합 receipt를 담은 commit**이
S2 §2의 contractApprovalCommit 후보가 된다. 에이전트가 실제 commit에서 대상·판정·
ancestry를 검증한 뒤 40자 SHA를 후속 승인 기록에서 참조한다. 이 문서 내부의 null을
자기 SHA로 채워 commit hash 순환을 만들지 않는다. 초안 commit·부분 승인 commit·
검토 commit·develop merge SHA를 전체 승인 commit으로 대용하지 않는다.

S2 approvalCommit은 계속 A다. 이후 activationApprovalCommit은 contractApprovalCommit을
조상으로 가진 **별도 사람 승인 receipt의 commit**이어야 하며, 실제 activation commit C의
strict ancestor여야 한다. 승인과 실제 전환을 같은 commit에 함께 넣지 않는다. 향후 Git
반영도 원래 A·문서·승인 SHA를 보존하는 merge commit 방식이며 squash/rebase를 하지 않는다.

이번 작업은 통합 승인 초안 작성에 한정한다. 다음은 시작·승인·완료하지 않는다.

- S2 activation 승인 패키지 및 예정 transition/genesis/legacy payload·digest 작성, 실제 purpose 전환
- scorer·validator·ledger·resolver·controller·custody·importer·workflow 구현 또는 테스트 코드 생성
- dataset·manifest·register·기존 approval·budget·prompt 변경
- 실제 holdout/case/gold/key 작성·열람·봉인·개봉·materialisation
- S5/v9 prompt 작성·활성화, pair·예산 승인, dispatch/re-run/provider probe·유료 호출
- release gate·memoryExtractionEnabled·memoryInjectionEnabled 변경
- production·runner·secrets·environment·GitHub protection 설정 변경
- stage·commit·push·PR·ready·auto-merge·병합·배포

이번 통합 승인이 나중에 확정돼도 구현·activation·유료 실행 승인은 별도로 남는다.
다음 순서는 **통합 계약 승인 기록 고정 → 별도 지시된 S2 activation 승인 준비·사람 승인
→ 승인 이후 전환·불변 검증 및 develop inclusion/checkpoint 확인 → 별도 지시된 scorer
구현·동결 → 격리 holdout 작성·검수·seal → S5**다. 이후 pair/programme·ordinal별
예산·dispatch 승인도 별개다. 이 초안은 위 단계 중 다음 단계를 자동으로 열지 않는다.
