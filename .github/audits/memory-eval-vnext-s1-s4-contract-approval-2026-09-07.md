# Memory eval vNext S1–S4 통합 계약 승인 기록 — 2026-09-07

**상태: APPROVED — S1–S4 exact 문서와 기존 승인·조건·잔여를 결속하는 사람의 통합 승인.**

이 문서는 승인된 통합 초안과 기존 계약·부분 승인 bytes를 변경하지 않고 최종 사람 판정을
별도로 보존하는 authoritative approval receipt다. Codex가 이번 사용자 메시지를 전사했다.
계약 개정, S2 activation·구현·유료 실행 승인 또는 암호학적 전자서명 발급 기록이 아니다.
사람 승인은 기록됐지만 이 receipt를 담은 Git commit은 아직 만들지 않았다.

## 1. 최종 통합 승인과 정확한 대상

```yaml
recordStatus: approved
recordKind: consolidated_contract_approval
decision: yes
approvedBy: "mposition"
approvedAt: "2026-09-07"
approvalEvidenceType: explicit_user_message
approvalScope: S1_S4_contracts_only
consolidationOnly: true
commitRole: "S1-S4 contract approval receipt (contractApprovalCommit)"
repositoryBasis: "6c36a548abf1687d2582566f31fafa51875b77fa"
decisionApprovalCommit: "3f14afb29eddc243640fdb0a5a4f604646ade9f0"
approvedDraft: ".github/audits/memory-eval-vnext-s1-s4-contract-approval-draft-2026-09-07.md"
approvedDraftSha256: "a08b32663acd36cdc4c7daef7c4790b0b2031939998d0b3f09f4b8f46c9cd138"
approvedDraftBytes: 20392
approvedDraftLines: 281
approvedContractDocuments:
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
upstreamDecision:
  originalRepositoryBasis: "6263ecdcc1e69585498c19c0a294fef5202f5218"
  approvedDocument: ".github/audits/memory-eval-vnext-contract-decision-2026-09-05.md"
  approvedDocumentSha256: "355f8387808b8a7ea86e02ecffc4303562b5ab5c43c27fef0c2bdb2bf57e89da"
  approvalReceipt: ".github/audits/memory-eval-vnext-contract-decision-approval-2026-09-06.md"
  approvalReceiptSha256: "838af4d1fee11122b5a2ec6b72d5ed905a59b2b370ec2d7b88e87bdd193291f5"
acceptedConditionIds: ["P2-N1","C-COORD-1","N-1","N-2"]
acceptedResidualIds: ["R-SENS-1","R-GRAM-1","R-DETECTOR-1","R-KO-SUBJECT-1","R-PRELEDGER-1","R-SCOPE-1","R-S3-ISOLATION","R-S3-CUSTODY","R-S3-HUMAN","R-S3-RETENTION","R-S4-CONTROL-PLANE","R-S4-RACE","R-S4-API","R-S4-CHECKPOINT","R-S4-TIME","R-S4-SPEND","R-S4-PROTECTION","R-S4-LOSS"]
upstreamD1D5AndSection12Acknowledged: true
priorApprovalsAndConditionsAcknowledged: true
implementationAuthorized: false
activationAuthorized: false
paidExecutionAuthorized: false
```

이 초안 전체의 대상·조건·잔여·범위를 제시한 뒤 사용자가 전달한 최종 판정은 다음과 같다.

```text
최종 승인합니다.
승인자: mposition
승인일: 2026-09-07
```

최상위 decision·approvedBy·approvedAt은 **이번 메시지**에서 기록했다. priorApprovals의
같은 승인자·날짜는 각각의 과거 부분 승인 사실이며 이번 서명을 대신하지 않는다.
통합 초안 작성 지시, 독립 검토 필요 여부에 관한 질문, 과거 승인 또는 commit author를
이번 통합 승인 증거로 사용하지 않는다.

## 2. 승인된 초안·계약·부분 승인 원문 보존

승인은 approvedDraftSha256으로 식별되는 **통합 초안 전체 문언**과 §1의 네 최종 계약
documentCommit·path·raw SHA-256 및 명시된 기존 승인에 결속된다. 초안은 20,392 bytes,
281줄이며 그 원문을 보존한다. 초안의 pending·빈 accepted 목록·null은 승인 전의 역사적
상태다. 현재 통합 판정은 이 확정 receipt가 기록하며, 승인받은 초안에 서명을 채우지 않는다.

S1/S2의 최종 문서 commit은 fa682cc2…, S3/S4는 4d8a7c31…다. 네 계약의 제목·In Review·
작성 당시 확인 검토 미완료 문구와 raw bytes를 바꾸지 않는다. 각 부분 승인 receipt와 그
approvedDraft도 그대로 유지한다. 이 통합 기록은 기존 승인을 철회·대체하거나 새로운
계약 의미를 추가하지 않는다.

각 sha256은 자기 path의 raw bytes를 식별한다. gitBlobOid는 Git object 식별자이며
raw SHA-256의 대체물이 아니다. 계약·통합 초안·부분 승인 초안·각 receipt·외부 보고서의
hash를 서로 바꾸어 쓰지 않는다. 승인된 초안 §1·§2의 모든 결속을 이 기록에서도 유지한다.
원래 decision의 §13 공란인 400줄 bytes와 A의 기존 승인도 그대로다.

## 3. 조건 4개·잔여 18개와 상위 결정의 수용

승인된 통합 초안 §4를 **모든 세부 문단과 참조 원문까지 전부 수용**한다. 즉 다음의
전체 문언·운영 비용·실행 차단 경계를 그대로 승계하며 ID 목록만 수용한 것으로 축소하지 않는다.

- S1/S2 receipt §3·§5와 그 approvedDraft §4·§5의 모든 세부 문단.
- S3/S4 receipt §3–§5와 그 approvedDraft §4·§5의 모든 세부 문단 및 N-2 관측 처리 표.
- 원래 decision D1–D5, §12 여섯 잔여와 기존 decision receipt의 권한 제한.

조건 4개는 P2-N1·C-COORD-1·N-1·N-2다. 민감 gold의 permitted region 금지,
bulk_safe만 permitted 참조, 모든 permitted slice·case-local OR, 상대 Collision/절대
message 좌표 구분, runner의 controller signing key 부재·중앙 단일 writer/fencing,
API 미실행 증명이 불명확할 때 contacted_unknown 및 영구 duplicate 규칙을 유지한다.
N-2를 새 no-contact whitelist의 허가로 읽지 않는다.

잔여 18개는 §1의 acceptedResidualIds와 통합 초안 §4의 모든 행·문단 그대로다.
R-SENS-1·R-SCOPE-1의 상세 작성 제한·호환성 비용, S3의 격리·custody·사람 노출·보존
비용, S4의 P/E/R/T·race·API·checkpoint·clock·spend·보호 설정·holdout 손실 경계를
다시 해석하거나 좁히지 않는다. 상위 §12의 여섯 잔여를 이 목록으로 대체하지 않는다.

**수용 판정과 이행 완료는 다르다.** S3에 P2-N1·C-COORD-1의 문언이 반영된 것은
실제 validator·holdout 검증 완료가 아니다. N-1/N-2와 외부 운영 의존성의 구현·검증도
남아 있다. R-S4-PROTECTION은 보고서의 당시 설정 관측을 인지한 것이지 현재 적합
판정이 아니며, R-S4-TIME은 특정 UTC source/ClockPolicy의 승인이 아니다.
이행에 실제 계약 개정이 필요해지면 별도 범위로 다루고 기존 CONFIRMED를 새 bytes에 소급하지 않는다.

## 4. 기존 독립 확인 검토와 Git 계보

기존 부분 승인에 연결된 외부 확인은 다음과 같다. 이 기록 작성 시 두 로컬 원 보고서의
존재·raw SHA-256·길이를 다시 대조했다.

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

CONFIRMED는 각각 명시된 reviewedCommit의 S1/S2 또는 S3/S4 bytes에만 귀속된다.
통합 초안이나 이 확정 receipt를 Claude가 추가 독립 검토·승인했다는 주장이 아니다.
이번 전사는 추가 검토 회차가 아니며, 각 묶음의 예정된 확인 검토 1회는 이미 완료됐다.
보고서 원문 전체가 Git에 보존됐다고 주장하지 않는다. 최종 통합 사람 판정의 근거는 §1이다.

승인된 통합 초안 §3의 Git 관계를 유지한다. A, 두 부분 승인 commit, 네 최종 문서
commit은 repositoryBasis의 조상이다. basis인 develop merge
`6c36a548abf1687d2582566f31fafa51875b77fa`의 두 parent는
`f5abaecf77ee56d08cdd7e50ca43c0110d03e6b4`와
`025212c4f9bd0dcb2deb4d9ade2925f3bbc6ef92`다.
basis의 성공 CI는 초안 §3의 역사적 검증 근거이며 이 receipt의 새 CI·운영 적합 판정이 아니다.

## 5. contractApprovalCommit과 이후 별도 권한

이 receipt는 **S1–S4 전체에 대한 사람의 통합 승인**을 기록한다. S2 §2가 요구하는
contractApprovalCommit은 별도 commit 지시에 따라 이 확정 receipt와 승인된 통합 초안을
Git에 고정한 뒤, 실제 commit의 대상·판정·ancestry를 검증하여 참조한다. 아직 그 commit이
존재한다고 주장하지 않으며, 미래 자기 SHA를 예측해 본문에 넣지 않는다. 초안 commit·
부분 승인 commit·검토 commit·develop merge SHA로 전체 승인 commit을 대용하지 않는다.

S2의 approvalCommit은 계속 A `3f14afb29eddc243640fdb0a5a4f604646ade9f0`이다.
별도 activationApprovalCommit은 contractApprovalCommit을 조상으로 가져야 하며 실제
activation commit C의 strict ancestor여야 한다. 같은 commit에서 승인과 실행을 함께
만들지 않는다. 이 receipt는 activationApprovalCommit이나 실제 전환 bundle이 아니다.

승인된 통합 초안 §6의 제한을 그대로 적용한다. 이번 승인은 다음을 허가·완료하지 않는다.

- S2 activation 승인 패키지, 예정 transition/genesis/legacy payload·digest 작성 또는 실제 purpose 전환
- scorer·validator·ledger·resolver·controller·custody·importer·workflow 구현 및 테스트 코드 생성
- dataset·manifest·register·기존 approval·budget·prompt 변경
- 실제 holdout/case/gold/key 작성·열람·봉인·개봉·materialisation
- S5/v9 prompt 작성·활성화, pair·예산 승인, dispatch/re-run/provider probe·유료 호출
- release gate·memoryExtractionEnabled·memoryInjectionEnabled 변경
- production·runner·secrets·environment·GitHub protection 설정 변경
- stage·commit·push·PR·ready·auto-merge·병합·배포

승인 범위는 통합 계약 판정뿐이다. 후속 순서는 **통합 승인 기록 고정 → 별도 지시된 S2
activation 승인 준비·사람 승인 → 승인 이후 전환·불변 검증 및 develop inclusion/checkpoint
확인 → 별도 지시된 scorer 구현·동결 → 격리 holdout 작성·검수·seal → S5**다.
이후 pair/programme·ordinal별 예산·dispatch도 필요한 승인을 별도로 받는다.

이 기록 작성 시 stage·commit하지 않았다. Git 이력 고정과 이후 push·PR·병합은 별도
지시를 기다린다. 그때 원래 A·문서·승인 SHA를 보존하는 merge commit 정책을 유지하고
squash/rebase를 자동 선택하지 않는다. 여기서 activation 준비·전환·구현을 시작하지 않는다.
