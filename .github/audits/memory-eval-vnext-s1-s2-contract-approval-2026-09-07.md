# Memory eval vNext S1·S2 계약 승인 기록 — 2026-09-07

**상태: APPROVED — S1·S2 계약과 명시된 조건·잔여에 대한 사람 승인.**

이 문서는 사람이 승인한 정확한 초안과 S1·S2 bytes를 변경하지 않고 승인 사실을 별도로
보존하는 authoritative approval receipt다. 사용자 대화의 명시적 판정을 Codex가
전사했다. 구현·activation·배포 승인이나 암호학적 전자서명 발급 기록은 아니다.

## 1. 사람 승인 기록

```yaml
recordStatus: approved
decision: yes
approvedBy: "mposition"
approvedAt: "2026-09-07"
approvalEvidenceType: explicit_user_message
approvalScope: S1_S2_contracts_only
reviewedContractCommit: "fa682cc2209fc5b0a9ebd994aa626d00997b0359"
approvedDraft: ".github/audits/memory-eval-vnext-s1-s2-contract-approval-draft-2026-09-07.md"
approvedDraftSha256: "f28e58f68d03435d31834373eaeab2171ead71620947ed12a478b9ba8fa56b38"
approvedContractDocuments:
  - id: S1
    path: ".github/audits/memory-eval-vnext-s1-scoring-contract-2026-09-06.md"
    sha256: "393497a5acbe7ee47af6947a84204eac7723fdd973bf30afad79c812da4db0e7"
    bytes: 65000
    lines: 778
  - id: S2
    path: ".github/audits/memory-eval-vnext-s2-purpose-contract-2026-09-06.md"
    sha256: "e9a6a086be32e4d12df776015959c7c95be5185af7dc635403e8cd6689f4baa5"
    bytes: 45965
    lines: 632
acceptedConditionIds: [P2-N1, C-COORD-1]
acceptedResidualIds: [R-SENS-1, R-GRAM-1, R-DETECTOR-1, R-KO-SUBJECT-1, R-PRELEDGER-1, R-SCOPE-1]
upstreamD1D5AndSection12Acknowledged: true
externalConfirmationReview: "CONFIRMED"
confirmationReviewedCommit: "fa682cc2209fc5b0a9ebd994aa626d00997b0359"
confirmationReportSha256: "e2205f0b9b985bde93d04f67f3f3b054b102811721cbcd218ccec0e21fcfab2d"
decisionApprovalCommit: "3f14afb29eddc243640fdb0a5a4f604646ade9f0"
```

승인자가 이 작업의 대화에서 전달한 판정은 다음과 같다.

```text
승인합니다.
승인자: mposition
승인일: 2026-09-07
```

이 판정은 위 초안을 제시한 뒤 받은 최종 승인이다. 앞서 초안 작성을 요청한 응답과
구분한다. 승인자 표기는 이 판정의 `mposition`을 그대로 기록했으며, 원래 commit A의
승인자 표기나 날짜를 가져온 것이 아니다.

## 2. 승인 대상과 보존하는 bytes

사람의 승인은 위 approvedDraftSha256으로 식별되는 **초안 전체의 대상·조건·잔여·권한
제한** 및 reviewedContractCommit의 S1·S2 두 문서에 결속된다. 초안은 14,881 bytes,
200줄이며 원래 bytes를 보존한다. 초안의 DRAFT/UNSIGNED·pending 표시는 승인 이전의
역사적 상태이고, 현재 판정과 accepted 목록은 **이 확정 receipt**를 따른다. 초안의 조건·
잔여 문언을 새로 바꾸거나 축소한 것이 아니다.

각 SHA-256은 자기 path의 raw bytes에만 귀속된다. 승인된 초안 hash, 두 계약 hash,
확인 검토 보고서 hash, 이 receipt 자신의 hash를 서로 대체하지 않는다.
검토된 S1·S2의 제목·In Review 표시·본문도 바꾸지 않는다. 승인 사실은 이 별도 기록으로
증명하며, 그 문서들의 문언과 hash는 Claude가 확인한 fa682cc2의 대상 그대로다.

원래 결정문과 승인 receipt 역시 그대로다.

| 역할 | 경로 | raw SHA-256 |
|---|---|---|
| 원래 결정문 | `.github/audits/memory-eval-vnext-contract-decision-2026-09-05.md` | `355f8387808b8a7ea86e02ecffc4303562b5ab5c43c27fef0c2bdb2bf57e89da` |
| 원래 approval receipt | `.github/audits/memory-eval-vnext-contract-decision-approval-2026-09-06.md` | `838af4d1fee11122b5a2ec6b72d5ed905a59b2b370ec2d7b88e87bdd193291f5` |

원래 결정문은 §13이 비어 있는 400줄의 승인 bytes를 보존한다. 이 칸을 채우거나 원래
결정의 approvalCommit을 이 새 승인 기록으로 대체하지 않는다.

## 3. 수용한 조건·잔여와 아직 남은 이행

승인된 초안 §4의 조건 두 개와 §5의 잔여 여섯 항목을 **세부 문단까지 전부 수용**한다.
아래는 그 판정의 색인이며 구체 조건은 위 hash로 결속된 초안 문언을 따른다.

| ID | 수용한 사항 | 판정 |
|---|---|---|
| P2-N1 | S3에서 sensitive_review gold의 evidence region을 permitted로 표시하지 않음. permitted goldId는 bulk_safe만 참조하며 S1의 모든 permitted slice 검사와 case-local OR는 그대로 유지 | accepted |
| C-COORD-1 | Collision.start/end는 target text, region이면 NFC slice에 상대적인 좌표. AuthoringTarget의 region start/end는 message의 절대 NFC scalar 좌표 | accepted |
| R-SENS-1 | 단독 민감성 검수의 오류·남은 false FAIL/누락·작성 제한·holdout 소비 비용. 모든 Value의 단독 민감성 및 결합형 사실이 기존 grammar의 유효한 단일 surface로 표현 불가능하면 authoring 거부 | accepted |
| R-GRAM-1 | closed grammar/identity-nfc-1의 좁은 분포·복합/자연 발화 표현 한계. cell floor가 대표성을 증명하지 않음 | accepted |
| R-DETECTOR-1 | token detector의 paraphrase 미포착 및 사람 검수 한계. detector가 거짓인 것만으로 allowed가 아님 | accepted |
| R-KO-SUBJECT-1 | 한국어 K=""의 사용자 귀속은 parser 증명이 아니라 gold/evidence 사람 검수에 의존 | accepted |
| R-PRELEDGER-1 | 유일한 V 예외 밖 pre-ledger purpose는 unknown. 다른 과거 run의 purpose를 새로 증명하지 못하고 모든 pair가 revoked라고 가정하지 않음 | accepted |
| R-SCOPE-1 | historical 122 / forward 109 + ledger 범위 분리·snapshot 증거 보관 비용, 공유 module 13개의 후속 변경 시 동결 파일과의 컴파일·호환성 유지 비용. current helper의 역사 재현 혼입 금지 | accepted |

상위 D1–D5와 원래 결정문 §12의 기존 여섯 잔여도 유지·인지한다. R-* 수용은 이번 사람
판정으로 명시된 것이며 원래 결정의 승인에서 자동 유도한 것이 아니다.

P2-N1·C-COORD-1의 **사람 선택은 기록됐다.** 그러나 S3 계약에 반영·검증하는 이행은
남아 있다. accepted를 S3 작성 완료·scorer 구현 완료·holdout seal 완료로 읽지 않는다.
R-SCOPE-1의 수용도 공유 module 현재 bytes의 영구 동결이나 동결 파일 수정 허가가 아니다.
S1 scoring 의미·grammar·기존 digest를 바꾸는 변경은 별도 계약 개정으로 다뤄야 한다.

## 4. 확인 검토와 승인 근거의 구분

Claude의 CONFIRMED는 정확히 fa682cc2의 S1·S2에 대한 확인이다. 보고서는 P1 두 건의
closure와 수정 회귀 미발견을 기록하고 P2-N1 및 receipt 수용 항목을 남겼다.
예정된 확인 검토 1회는 완료됐으며 이번 사람 승인 기록은 추가 검토가 아니다.
Claude가 이 확정 receipt 자체를 검토하거나 사람 대신 승인했다고 주장하지 않는다.

확인 검토 원문은 아래 로컬 첨부에 보존돼 있다. 이 기록 작성 시 파일의 존재와 raw hash를
직접 대조했다. 원문 전체가 Git에 commit됐다는 주장은 아니다.

```text
C:/Users/Vyper/.codex/attachments/c9d45ce4-f000-46a7-abf4-bf6761854f48/pasted-text.txt
sha256: e2205f0b9b985bde93d04f67f3f3b054b102811721cbcd218ccec0e21fcfab2d
```

보고서 hash는 외부 검토 자료의 식별자이고, 최종 사람 판정의 근거는 이 작업에서 받은
§1의 승인 메시지다. 문서 hash 일치만으로 사람 서명이나 구현 권한을 추론하지 않는다.

## 5. 권한 제한과 Git 이력

이 승인은 **S1·S2 계약 판정**만 확정한다. 승인된 초안 §6·§7의 제한은 계속 적용된다.

- scorer·validator·ledger 구현 또는 테스트 코드 생성은 하지 않는다.
- succ-9 purpose 전환·activation, dataset·manifest·register 변경은 허용하지 않는다.
- 실제 holdout 작성·열람·봉인·개봉, v9 prompt 작성·활성화는 허용하지 않는다.
- 예산·dispatch·provider 호출·pair 승인·release gate 변경은 허용하지 않는다.
- `memoryExtractionEnabled`·`memoryInjectionEnabled` 변경은 허용하지 않는다.
- stage·commit·push·PR·ready·auto-merge·병합·배포는 이번 승인으로 실행하지 않는다.

S3·S4 문서 작성은 별도 작업 지시에 따르며, S1·S2 승인만으로 S3·S4까지 승인된 것은
아니다. 원래 순서인 **S1–S4 승인 → 별도 S2 activation 승인·전환 및 불변 검증 → scorer
구현·동결 → 격리 holdout 작성·검수·seal → S5**와 그 이후 실행별 승인 경계를 유지한다.

S2가 참조하는 `approvalCommit`은 원래 A `3f14afb29eddc243640fdb0a5a4f604646ade9f0`이다.
A는 merge `c2474837132a4355b750be0229e954ac30eb0ab6` 및 작성 develop basis
`11f11f0d38dea3c28d365503bc7b77ed0d793204`, 검토된 계약 commit의 조상으로 보존돼 있다.
미래의 이 receipt commit은 S1·S2 부분 계약 승인 기록일 뿐, S1–S4 전체를 묶는
`contractApprovalCommit`이나 별도 `activationApprovalCommit`으로 자동 승격되지 않는다.

이 기록 작성 시점에는 아직 stage·commit하지 않았다. Git 이력에 고정하는 작업은 별도
지시를 기다린다. 그때 승인된 초안 원본과 이 receipt의 결속을 함께 보존하고, 원래 A의
ancestry를 잃는 squash/rebase를 자동으로 선택하지 않는다. 자기 commit SHA를 지금
예측해 본문에 넣지 않는다.
