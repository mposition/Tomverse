# Memory eval vNext S3·S4 계약 승인 기록 — 2026-09-07

**상태: APPROVED — S3·S4 계약과 명시된 조건·잔여에 대한 사람 승인.**

이 문서는 사람이 승인한 정확한 초안과 검토된 S3·S4 bytes를 변경하지 않고 승인 사실을
별도로 보존하는 authoritative approval receipt다. 사용자 대화의 명시적 판정을 Codex가
전사했다. 구현·activation·운영 설정·유료 실행 승인이나 암호학적 전자서명 발급 기록은 아니다.

## 1. 사람 승인 기록

```yaml
recordStatus: approved
decision: yes
approvedBy: "mposition"
approvedAt: "2026-09-07"
approvalEvidenceType: explicit_user_message
approvalScope: S3_S4_contracts_only
reviewedContractCommit: "4d8a7c317b570e0c30fc5a05438cb7cc78354039"
initialReviewCommit: "3f1e1e261951b946e0e066dc510aad160a73d9f8"
repositoryBasis: "f5abaecf77ee56d08cdd7e50ca43c0110d03e6b4"
approvedDraft: ".github/audits/memory-eval-vnext-s3-s4-contract-approval-draft-2026-09-07.md"
approvedDraftSha256: "fc051930ae6f3343a03f649d7733df3266d517b4a4a01090d81b459e64ac2f0f"
approvedContractDocuments:
  - id: S3
    path: ".github/audits/memory-eval-vnext-s3-holdout-contract-2026-09-07.md"
    sha256: "66a29c01dd5e2d099817ee799afc960f090e93f900be53b546b8b73f4d3b3d05"
    bytes: 61926
    lines: 726
  - id: S4
    path: ".github/audits/memory-eval-vnext-s4-provenance-contract-2026-09-07.md"
    sha256: "e7bc98a98a6e03b31403061312e5c6abab10e7e27456f1077d3a68362ede67bb"
    bytes: 76581
    lines: 847
acceptedConditionIds: [N-1, N-2]
acceptedResidualIds: [R-S3-ISOLATION, R-S3-CUSTODY, R-S3-HUMAN, R-S3-RETENTION, R-S4-CONTROL-PLANE, R-S4-RACE, R-S4-API, R-S4-CHECKPOINT, R-S4-TIME, R-S4-SPEND, R-S4-PROTECTION, R-S4-LOSS]
upstreamD1D5AndSection12Acknowledged: true
upstreamS1S2ApprovalAndConditionsAcknowledged: true
externalConfirmationReview: "CONFIRMED"
confirmationReviewedCommit: "4d8a7c317b570e0c30fc5a05438cb7cc78354039"
confirmationReportSha256: "74048dda3c0a4f6cf66853d88dd4abe318ac9a90ebf29046dbe14af30c956188"
decisionApprovalCommit: "3f14afb29eddc243640fdb0a5a4f604646ade9f0"
priorS1S2ApprovalCommit: "52caa2cecbd32cab97736993bd57630b1e3e3bc2"
implementationAuthorized: false
activationAuthorized: false
paidExecutionAuthorized: false
```

승인자가 이 작업의 대화에서 전달한 최종 판정은 다음과 같다.

```text
승인합니다.
승인자: mposition
승인일: 2026-09-07
```

이 판정은 위 approvedDraftSha256과 초안 전체의 조건·잔여를 제시한 뒤 받은 최종 승인이다.
이전의 초안 작성 동의와 구별하며, 승인자 표기와 날짜는 **이번 메시지**에서 전사했다.
과거 A/S1·S2 승인이나 Git commit author를 새 승인 증거로 사용하지 않는다.

## 2. 승인 대상 bytes와 역사적 상태의 보존

승인은 reviewedContractCommit의 S3·S4 두 문서와 approvedDraftSha256으로 식별되는
**초안 전체의 대상·조건·잔여·권한 제한**에 결속된다. 승인된 초안은 20,644 bytes, 244줄이며
원래 bytes를 보존한다. 초안의 DRAFT/UNSIGNED·pending·빈 accepted 목록은 승인 전의
역사적 상태이고, 현재 사람 판정과 수용 범위는 **이 확정 receipt**가 기록한다.

S3·S4의 제목·In Review 표시·본문 및 작성 당시 "확인 검토 미완료" 문구를 고치지 않는다.
그 원문은 Claude가 확인한 4d8a7c31…의 bytes 그대로다. 별도 기록이 후속 검토·승인 사실을
연결하며, 승인 사실을 적으려고 검토된 원문이나 승인받은 초안의 hash를 바꾸지 않는다.

각 raw SHA-256은 명시된 자기 path의 bytes만 식별한다. 두 계약 hash, 초안 hash,
확인 검토 보고서 hash, 이 receipt 자신의 hash를 교환하지 않는다. CONFIRMED는 두 계약의
검토 판정이지 이 receipt·초안 조건안의 독립 검토나 사람 서명이 아니다.

## 3. 수용한 조건·잔여와 남은 이행

승인된 초안 **§4의 N-1/N-2, §5의 잔여 12개를 세부 문단·관측 처리 표까지 전부 수용**한다.
아래는 판정의 색인이며 구체 제약·운영 비용·실행 차단 경계는 hash로 결속된 초안 문언을 따른다.

| ID | 수용한 사항의 색인 | 판정 |
|---|---|---|
| N-1 | controller 서명 key를 runner에 배포하지 않음. runner gate는 중앙 controller 서비스의 인증된 client이며, 단일 writer/fencing과 증거 검증을 우회해 직접 서명할 수 없음 | accepted |
| N-2 | API 관측으로 미실행을 구별하지 못하면 external_not_executed를 인증하지 않고 contacted_unknown으로 처리. journal grant/intent 0건만으로 API 결손을 면제하지 않으며 S4 §5.1의 필수 증거와 영구 duplicate 규칙 유지 | accepted |
| R-S3-ISOLATION | 사람 projection/격리 검증 의존성, 좁은 분포·민감성 오판·quota 대표성 한계 | accepted |
| R-S3-CUSTODY | 전용 attested ephemeral self-hosted와 hosted plaintext job 배제, 비실행 사람 session의 attestation, fresh key 1회·분리 보관/복구·grant 운영 비용, 동일인 겸직·침해/OS/RAM 잔여. NIST 대조는 인증 아님 | accepted |
| R-S3-HUMAN | gold-withheld/blind 구분, 회수할 수 없는 사람 노출·기억, 실제 미노출 crash의 보수 소비 가능성 | accepted |
| R-S3-RETENTION | 근거 사용 기간의 암호화 보존/별도 key backup과 장기 접근·복구 비용. 유실 시 재검증 불능이며 일반 사용자 자료 수집/무기한 보관 권한 아님 | accepted |
| R-S4-CONTROL-PLANE | P와 E/R/T 및 run.head_sha=T와 evaluatedCommit=E 분리. ledger 수명 동안 protocol 동결, migration 필요 시 실행 정지·별도 계약/승인, 새 ledger로 소비 초기화 금지 | accepted |
| R-S4-RACE | journal/custody/GitHub/provider 사이 비원자성, duplicate 검출 후에도 지출·노출 회수 불가 | accepted |
| R-S4-API | API 관측 범위·늦은 run과 불명 차단 비용, 30초 안정 관측이 미래 duplicate 부재의 증명은 아님 | accepted |
| R-S4-CHECKPOINT | 중앙 single-writer·외부 checkpoint/trust root·장기 증거 보관·복구의 운영 비용. 구성/연속성 증명 전 실행 불가 | accepted |
| R-S4-TIME | check→call race, clock 오차와 외부 UTC source 신뢰 의존성. 실제 source/ClockPolicy의 별도 사람 고정 필요, 증거 없는 시간 판정 불허 | accepted |
| R-S4-SPEND | usage/가격 버전 신뢰 한계, unknown 비용·실패/중복 spend 전건 기록, guardrail과 admissibility 분리 | accepted |
| R-S4-PROTECTION | 초안에 귀속된 당시 보호 설정·관리자 우회 가능성 인지. 미래 ProtectionPolicy/bypassDisclosure는 실제 재조회와 별도 사람 승인이 필요하며 현재 적합 판정 아님 | accepted |
| R-S4-LOSS | dispatch_unknown/창 만료 때문에 실제 provider 접촉 없이도 holdout 손실 가능. 같은 ordinal 재예약·창 연장·재전송·사후 미접촉 확인으로 복구 금지 | accepted |

N-1/N-2의 **사람 수용은 기록됐다. 구현·검증 이행은 남아 있다.** 이 accepted 표시를
controller 서비스 구축·key 배포 정책 적용·API adapter 검증 완료로 읽지 않는다. 기존 S4의
no-contact 경계를 넓히거나 새 API field 조합을 검증 없이 허용하는 근거도 아니다.
조건을 지키려면 실제 계약 개정이 필요해지는 경우 별도 개정으로 다루며, 새 bytes에 기존
CONFIRMED를 소급 적용하지 않는다.

R-S4-PROTECTION 수용은 초안 §5에 기록된 확인 검토자의 2026-09-07T04:11:56Z 관측을
인지한다는 뜻이다. enforce_admins=false, required checks 2건 등 그 당시 값을 현재의
충분한 보호 설정으로 승인한 것이 아니다. R-S4-TIME 수용도 특정 UTC source·인증 방식·
ClockPolicy를 지금 승인한 것이 아니며, 실제 운영 정책의 고정·검증은 별도로 남아 있다.

## 4. 기존 승인과 확인 검토의 계보

승인된 초안 §2가 결속한 기존 decision/A와 S1/S2 원문·receipt, 상위 D1–D5/§12의 경계를
그대로 유지·인지한다. 기존 P2-N1·C-COORD-1 및 R-SENS-1·R-GRAM-1·R-DETECTOR-1·
R-KO-SUBJECT-1·R-PRELEDGER-1·R-SCOPE-1을 이번 새 잔여 목록으로 대체하거나 축소하지 않는다.

- S2 approvalCommit은 원래 A `3f14afb29eddc243640fdb0a5a4f604646ade9f0`다.
- 기존 S1/S2 최종 문서 commit은 `fa682cc2209fc5b0a9ebd994aa626d00997b0359`다.
- 기존 S1/S2 receipt는 `.github/audits/memory-eval-vnext-s1-s2-contract-approval-2026-09-07.md`,
  raw SHA-256 `50a2c323054c8cd2a186b9ed5d5e6d206927b8cda1be1990d0796b350388e4c2`,
  receipt commit은 `52caa2cecbd32cab97736993bd57630b1e3e3bc2`다.
- 위 승인 SHA와 basis f5abaecf…는 이번 S3/S4 reviewedContractCommit의 조상으로 보존된다.
- 원래 decision의 §13 공란과 400줄 bytes도 보존하며 과거 사람 승인에 Ed25519 서명이
  있었다고 소급하지 않는다.

확인 검토 원문은 아래 로컬 첨부에 있다. 이 기록 작성 시 원문 존재·raw hash·길이를
직접 대조했다. 원문 전체가 Git에 commit됐다는 주장은 아니다.

```text
C:/Users/Vyper/.codex/attachments/5b088c11-afc4-40a7-98c6-4ec6f06eabad/pasted-text.txt
sha256: 74048dda3c0a4f6cf66853d88dd4abe318ac9a90ebf29046dbe14af30c956188
bytes: 16023
```

보고서는 4d8a7c31…에 대해 기존 차단점 해소·차단 회귀 없음·신규 비차단 N-1/N-2를
기록하며 CONFIRMED를 판정했다. 그 판정은 보고서에 귀속된다. 예정된 확인 검토 1회는
끝났고 이번 승인 전사는 추가 검토가 아니다. 최종 사람 판정의 근거는 §1의 사용자 메시지다.

## 5. 권한 제한과 이후 기록

승인된 초안 §6·§7의 제한을 그대로 적용한다. 이 기록은 **S3·S4 계약 판정**을 확정하며
다음 행위의 허가나 완료를 의미하지 않는다.

- scorer·validator·controller·custody·importer·ledger·workflow 구현, 테스트 코드 생성
- succ-9 purpose 전환·activation, dataset·manifest·register 변경
- 실제 holdout/case/gold/key 생성·열람·봉인·개봉·materialisation
- S5/v9 prompt 작성·활성화, pair·예산 승인, dispatch/re-run/provider probe·유료 호출
- release gate, memoryExtractionEnabled, memoryInjectionEnabled 변경
- production·runner·secrets·environment·GitHub protection 설정 변경
- stage·commit·push·PR·ready·auto-merge·병합·배포

이 S3/S4-only 기록은 S2 §2의 **S1–S4 전체 contractApprovalCommit**이나 별도
activationApprovalCommit으로 자동 승격되지 않는다. 미래 전체 승인 기록에서는 기존
S1/S2 receipt와 네 최종 문서의 commit·path·SHA-256, 이번 승인·조건·잔여를 명시적으로
결속해야 한다. 검토 commit 또는 아직 commit하지 않은 이 파일을 그 SHA로 대용하지 않는다.

후속 순서는 **S1–S4 승인 → 별도 S2 activation 승인·전환 및 불변 검증 → 별도 지시된
scorer 구현·동결 → 격리 holdout 작성·검수·seal → S5**이며, 그 뒤 exact pair/programme와
ordinal별 예산·dispatch도 필요한 승인을 별도로 받아야 한다. 계약 승인·Git merge·CI success·
배포 중 하나가 남은 승인이나 실제 이행을 자동 생성하지 않는다.

이 기록 작성 시 stage·commit하지 않았다. 승인된 초안 원본과 이 확정 receipt를 Git 이력에
고정하는 작업은 별도 지시를 기다린다. 그때 원래 A와 승인/검토 SHA를 보존하는 merge commit
정책을 유지하고 squash/rebase를 자동 선택하지 않는다. 이 기록의 자기 commit SHA를 미리
예측해 본문에 쓰지 않는다. 여기서 push·추가 검토·구현·activation을 시작하지 않는다.
