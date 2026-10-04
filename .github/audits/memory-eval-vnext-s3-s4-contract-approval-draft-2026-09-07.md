# Memory eval vNext S3·S4 계약 승인 record 초안 — 2026-09-07

**상태: DRAFT / UNSIGNED — 사람 미승인, 효력 없음.**
작성자: Codex. 작성일은 승인일이 아니다.

이 문서는 검토된 S3·S4 bytes를 보존하면서 사람이 판정할 대상·조건·잔여를 준비한
**미서명 초안**이다. authoritative approval receipt가 아니며 최종 판정·서명을 대행하지 않는다.
초안 작성을 요청한 응답은 계약 승인이나 아래 조건·잔여의 수용이 아니다.
Claude의 CONFIRMED와 사람의 decision은 별개다. 이 초안 자체는 Claude의 검토 대상이 아니다.

## 1. 판정 대기 기록과 정확한 대상

```yaml
recordStatus: draft_unsigned
decision: pending
approvedBy: null
approvedAt: null
approvalScope: S3_S4_contracts_only
reviewedContractCommit: "4d8a7c317b570e0c30fc5a05438cb7cc78354039"
initialReviewCommit: "3f1e1e261951b946e0e066dc510aad160a73d9f8"
repositoryBasis: "f5abaecf77ee56d08cdd7e50ca43c0110d03e6b4"
contractDocumentsForDecision:
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
externalConfirmationReview: "CONFIRMED"
confirmationReviewedCommit: "4d8a7c317b570e0c30fc5a05438cb7cc78354039"
confirmationReportSha256: "74048dda3c0a4f6cf66853d88dd4abe318ac9a90ebf29046dbe14af30c956188"
requiredConditionIds: [N-1, N-2]
requiredResidualIds: [R-S3-ISOLATION, R-S3-CUSTODY, R-S3-HUMAN, R-S3-RETENTION, R-S4-CONTROL-PLANE, R-S4-RACE, R-S4-API, R-S4-CHECKPOINT, R-S4-TIME, R-S4-SPEND, R-S4-PROTECTION, R-S4-LOSS]
acceptedConditionIds: []
acceptedResidualIds: []
upstreamD1D5AndSection12Acknowledged: null
upstreamS1S2ApprovalAndConditionsAcknowledged: null
decisionApprovalCommit: "3f14afb29eddc243640fdb0a5a4f604646ade9f0"
priorS1S2ApprovalCommit: "52caa2cecbd32cab97736993bd57630b1e3e3bc2"
implementationAuthorized: false
activationAuthorized: false
paidExecutionAuthorized: false
```

pending·null·빈 accepted 목록은 **사람 판정이 아직 없다는 뜻**이다. required 목록의 기재는
수용 서명이 아니다. 승인자와 승인일을 과거 A/S1·S2 승인이나 commit author에서 복사하지 않는다.
N-1/N-2는 위 hash의 확인 검토 보고서에서 나온 P3 ID이며 다른 검토의 같은 이름과 혼동하지 않는다.

각 SHA-256은 해당 path의 raw bytes에만 귀속된다. 두 계약 hash, 이 초안 hash, 검토 보고서
hash, 미래 확정 receipt hash를 서로 대체하지 않는다. S3/S4의 제목·In Review 표시·본문과
작성 당시의 "확인 검토 미완료" 문구도 수정하지 않는다. 그 역사적 상태 이후의 외부 확인과
미래 사람 승인은 별도 기록으로 결속한다. 이 초안에 미래 자기 commit SHA를 예측해 넣지 않는다.

## 2. 기존 승인 계보 — 새 승인 대상과 구별

다음 원문은 이미 승인된 상위 근거이며 이 초안이 수정·재승인하거나 범위를 확대하지 않는다.

| 역할 / path | raw SHA-256 |
|---|---|
| decision / `.github/audits/memory-eval-vnext-contract-decision-2026-09-05.md` | `355f8387808b8a7ea86e02ecffc4303562b5ab5c43c27fef0c2bdb2bf57e89da` |
| decision receipt / `.github/audits/memory-eval-vnext-contract-decision-approval-2026-09-06.md` | `838af4d1fee11122b5a2ec6b72d5ed905a59b2b370ec2d7b88e87bdd193291f5` |
| S1 / `.github/audits/memory-eval-vnext-s1-scoring-contract-2026-09-06.md` | `393497a5acbe7ee47af6947a84204eac7723fdd973bf30afad79c812da4db0e7` |
| S2 / `.github/audits/memory-eval-vnext-s2-purpose-contract-2026-09-06.md` | `e9a6a086be32e4d12df776015959c7c95be5185af7dc635403e8cd6689f4baa5` |
| S1/S2 receipt / `.github/audits/memory-eval-vnext-s1-s2-contract-approval-2026-09-07.md` | `50a2c323054c8cd2a186b9ed5d5e6d206927b8cda1be1990d0796b350388e4c2` |

원래 decision basis는 `6263ecdcc1e69585498c19c0a294fef5202f5218`, commit A는
`3f14afb29eddc243640fdb0a5a4f604646ade9f0`, A 보존 merge는
`c2474837132a4355b750be0229e954ac30eb0ab6`다. S2의 approvalCommit은 계속 A다.
decision은 §13 공란인 400줄의 승인 bytes를 유지한다. 과거 승인을 암호학적 서명으로 소급하지 않는다.

S1/S2의 검토된 최종 문서 commit은 `fa682cc2209fc5b0a9ebd994aa626d00997b0359`,
승인 receipt commit은 `52caa2cecbd32cab97736993bd57630b1e3e3bc2`이며 그 직접 parent가
fa682cc2…다. 기존 사람 승인은 mposition / 2026-09-07이다. 이는 새 S3/S4 승인자·승인일이 아니다.
S3/S4 작성 basis `f5abaecf77ee56d08cdd7e50ca43c0110d03e6b4`의 두 parent는
`11f11f0d38dea3c28d365503bc7b77ed0d793204`와 `52caa2cecbd32cab97736993bd57630b1e3e3bc2`다.
이번 reviewedContractCommit은 최초 S3/S4 검토 commit을 직접 parent로 보존한다.

S1/S2가 수용한 **P2-N1·C-COORD-1**, **R-SENS-1·R-GRAM-1·R-DETECTOR-1·
R-KO-SUBJECT-1·R-PRELEDGER-1·R-SCOPE-1**의 세부 문언을 유지한다. 특히 sensitive_review
gold의 permitted region 금지, bulk_safe gold만 permitted 참조, 모든 permitted slice 검사,
case-local OR/단독 민감성, 상대 Collision 좌표와 절대 message region 좌표 구분은 그대로다.
historical 122개 / forward 109개+ledger / 공유 13개의 역할과 호환성 유지 비용도 바꾸지 않는다.
상위 D1–D5/decision §12의 잔여를 이번 R-S3-*/R-S4-* 목록으로 축소·대체하지 않는다.

## 3. 외부 확인 검토 — 관측 기록, 사람 승인 아님

사용자가 전달한 Claude 확인 검토 보고서는 위 reviewedContractCommit을 대상으로
**CONFIRMED**를 판정했다. 보고서 원본의 인계 위치와 무결성 식별자는 다음과 같다.

```text
C:/Users/Vyper/.codex/attachments/5b088c11-afc4-40a7-98c6-4ec6f06eabad/pasted-text.txt
sha256: 74048dda3c0a4f6cf66853d88dd4abe318ac9a90ebf29046dbe14af30c956188
bytes: 16023
```

이 초안 작성 시 해당 원문 존재·raw hash와 두 계약의 commit/working bytes 일치를 직접
대조했다. 원문 전체를 이 초안에 복제하거나 Git에 보존했다는 주장은 아니다. 최종 기록
확정 시에는 에이전트가 다시 원본과 보존 위치를 대조해 결속한다. 보고서 hash는 사람 서명이 아니다.

| 최초 finding | 보고서의 확인 판정 |
|---|---|
| F-S4-01 (P1) | CLOSED — ledger당 protocol, P/E closure 분리로 genesis 순환 해소 |
| F-S4-02 (P2) | CLOSED — 엄격한 외부 custodian no-contact 증명 경계 |
| F-S3-01 (P2) | CLOSED — opened에서 다른 ordinal sheet 신규 opening |
| F-S4-03 (P2) | CLOSED — controller journal/checkpoint 권한과 독립 검증 역할 |
| F-S3-02 (P2) | 계약 CLOSED / 운영 비용 DISPOSITION_RECORDED |
| F-S4-04 (P3) | DISPOSITION_RECORDED — 보호 설정 관측/미래 승인 분리 |
| F-S3-03 (P3) | CLOSED — GrantScope/GrantAuthority의 비실행 범위 |
| F-S4-05 (P3) | CLOSED — clock 증거·보수 오차 판정 |
| F-S4-06 (P3) | 계약 CLOSED / holdout 손실 DISPOSITION_RECORDED |

보고서는 차단 회귀 없음과 신규 비차단 P3 **N-1/N-2**를 기록했다. 이 둘은 아래 조건안으로
남기며, 이번 초안만으로 사람이 수용했거나 Claude가 조건안을 CLOSED로 판정했다고 쓰지 않는다.
예정된 확인 검토 1회는 완료됐고, 이 초안 작성은 추가 독립/확인 검토가 아니다.

보고서의 NIST PDF 직접 대조·공식 API/runner 확인·검사 결과는 **검토자가 보고한 증거**다.
이 초안 작성자가 API/crypto 검토를 새로 수행하거나 구현을 인증한 것이 아니다. basis의
CI success도 reviewedContractCommit의 CI·배포·운영 승인으로 확대하지 않는다.

## 4. 사람이 채택할 조건안 — N-1/N-2 모두 pending

### N-1 — controller 배치와 서명 key 경계

채택할 조건안은 **controller 서명 key를 runner에 배포하지 않고, runner 측 gate는 중앙
controller 서비스의 인증된 client로 동작**하는 것이다. controller 서비스가 S4의 유일
journal writer이며 exclusive lock·atomic append·fsync·단조 fencing과 checkpoint 서명을
소유한다. runner의 job마다 controller key 복제본을 주어 직접 event/checkpoint에 서명하는
구현은 허용하지 않는다. key를 repository/Actions secret·artifact·log·cache에 운반하는 것도 금지다.

runner의 contact_intent/upload 등 보고는 그 자체가 권위 event/signature가 아니다. controller는
실제 RunUnit·reservation·승인·증거 결속을 확인한 뒤 해당 목적의 기록을 만들고, 요청 payload를
검증 없이 대신 서명하지 않는다. custodian 발급 전 checkpoint 검증과 importer 사후 검증의
역할은 유지하며 중앙 controller 서명도 provider/API 관측의 진실을 자동 보증하지 않는다.

후속 별도 승인된 구현에서 확인할 조건은 runner의 signing key 부재, runner가 임의 checkpoint를
발급할 수 없음, 동시 client 요청도 같은 단일 writer/fencing 경계를 통과함이다. 이는 지금
서비스·key를 만들라는 지시가 아니다. 새 중앙 운영 경계의 비용은 R-S4-CHECKPOINT에 포함한다.

### N-2 — 미실행 API 관측이 불명확하면 unknown

채택할 조건안은 **API 관측에서 실행 전 취소와 실행 여부를 구별하지 못하면
external_not_executed를 인증하지 않고 contacted_unknown으로 처리**하는 것이다.
complete journal의 grant/intent 0건만으로 API 증거 결손을 면제하지 않으며 S4 §5.1의
단일 credential 발급 경계·영구 unit_closed·전 page/attempt/artifact 대조를 전부 유지한다.

확인 검토 보고서가 남긴 job/steps schema의 관측 한계를 인지한다. 특정 API field 값의
조합을 검증 없이 "미실행" whitelist로 발명하지 않는다. 후속 pinned API adapter는 아래를
구별하여 원 응답과 판정 이유를 보존해야 한다.

| 관측 입력 | 제안하는 처리 제약 |
|---|---|
| job conclusion 또는 started_at만 존재 | terminal 관측과 provider 미접촉 증명을 분리하며 이것만으로 no-contact를 인증하지 않음 |
| runner_id의 존재/부재만 확인 | 배정 metadata만으로 step 실행·미실행을 단정하지 않음 |
| steps 부재/빈 목록 또는 일부 page만 존재 | 0건 실행으로 치환하지 않음; 실행 여부를 구별할 충분한 증거가 없으면 unknown |
| steps의 status/conclusion 등에 실행 증거 또는 모순 존재 | external_not_executed 인증 불가; 실제 contacted/unknown 증거에 따라 S4 분류 |
| 모든 필수 증거가 완전하고 실행 부재를 검증 가능 | S4 §5.1의 다른 조건도 모두 충족할 때만 custodian 외부 인증 가능 |

필드 조합의 실제 구별 가능성과 adapter 동작은 후속 구현 검증에서 입증해야 한다. API가
그 구별을 보장한다고 이 초안이 새로 선언하지 않는다. 구별할 수 있는 정상 경로가 없으면
해당 API 관측에서는 예외를 사용하지 않는다. 재검증 전 provider 호출이나 추가 probe로
미접촉을 확인하려 하지 않는다. unknown과 다른 접촉이 함께 있으면 기존 duplicate_contact의
영구 inadmissible·spend 기록·ordinal 2 차단 규칙을 그대로 적용한다.

위 두 조건은 S4의 권한/증거 경계를 좁혀 명시하는 **승인 조건안**이며 새로운 no-contact
허용 경로나 S1 scoring 변경이 아니다. required에 기록했어도 아직 accepted가 아니다.
실제 계약 본문 변경이 필요하면 별도 개정으로 다루고 새 bytes에 기존 CONFIRMED를 소급하지 않는다.

## 5. 새로 명시적으로 수용할 잔여 — 12개 모두 pending

아래는 S3/S4 Review disposition의 세부 문언과 함께 사람이 수용 여부를 판정할 목록이다.
기존 상위 승인이 자동으로 덮지 않는다. 단순 ID 동의가 아니라 아래 범위·비용·실행 차단
경계를 포함한 이 초안 전체를 최종 판정 대상으로 삼는다.

| ID | 제안하는 수용 범위와 유지할 경계 | 현재 상태 |
|---|---|---|
| R-S3-ISOLATION | 규범 projection의 무누락·환경 격리는 사람 검토와 통제에 의존한다. 좁은 grammar의 분포 편향·단독 민감성 오판이 남으며 quota floor는 대표성 증명이 아니다. | pending |
| R-S3-CUSTODY | per-object fresh key 1회·분리 보관소 두 곳·복구 검증·30분 grant 및 외부 attestation 운영 비용. plaintext job은 전용 ephemeral self-hosted로 한정하고 hosted를 배제한다. 사람 review/authoring/materialisation session도 목적별 attestation이 필요하다. 같은 사람이 관리·custodian·승인을 겸하는 한계, OS side channel/RAM 잔존/침해 위험을 제거했다고 하지 않는다. 구성·freshness 증명 부재는 실행 차단이며 NIST 대조는 인증이 아니다. | pending |
| R-S3-HUMAN | gold-withheld와 gold-blind를 구별하며 사람의 기억·노출은 되돌릴 수 없다. 보수적인 opened/consumed 전이 때문에 실제 미노출 crash에서도 holdout을 잃을 수 있다. | pending |
| R-S3-RETENTION | decision 근거를 사용하는 기간의 암호화 보존·별도 key backup은 장기 접근 위험과 복구 비용을 만든다. 증거 유실은 재검증 불능이며 새 artifact로 과거 증거를 대체하지 않는다. 실제 사용자 자료의 일반 수집/무기한 보관 권한이 아니다. | pending |
| R-S4-CONTROL-PLANE | P와 E/R/T 분리 및 closure 완전성 검증 비용을 수용할지 판정한다. run.head_sha=T와 RunTuple.evaluatedCommit=E가 다른 선택을 명시적으로 인지한다. E/T control-plane은 P와 일치해야 하며 protocol은 ledger 수명 동안 동결된다. migration 미정의이므로 변경 필요 시 실행 정지·별도 계약/승인을 요구하고 새 ledger로 소비 이력을 초기화하지 않는다. | pending |
| R-S4-RACE | journal/fencing/custody/concurrency는 GitHub·API·admin·provider 간 원자 transaction이 아니다. duplicate 검출로 영구 inadmissible 처리해도 이미 발생한 지출·노출을 회수하지 못한다. | pending |
| R-S4-API | 전 attempt·검색 cap 분할·두 snapshot은 API 관측 범위에 의존하며 숨거나 뒤늦게 나타나는 run이 남는다. N-2의 불명 차단 비용을 인지하고 30초 안정 관측을 미래 duplicate 부재 증명으로 확대하지 않는다. | pending |
| R-S4-CHECKPOINT | 중앙 single-writer controller, 외부 trust root/checkpoint, 장기 key/receipt 보관·복구는 필수 운영 의존성이다. N-1의 key 비배포 경계를 포함하고 아직 구축·검증됐다고 주장하지 않는다. 구성/연속성 증명 전 provider 호출은 없다. | pending |
| R-S4-TIME | protected-tip check→call race와 clock 오차는 절대 동시성을 보장하지 않는다. 외부 UTC source의 인증·정확도 신뢰를 선택하는 비용을 인지하며 실제 source/ClockPolicy는 이후 사람이 별도로 고정해야 한다. 지금 특정 source가 승인됐다는 뜻이 아니다. 증거 없는 오차 자기 선언·창 연장·관측 간격 단축은 불허한다. | pending |
| R-S4-SPEND | reported usage와 검증된 가격 버전을 신뢰하는 한계가 남는다. 불명 비용은 0이 아니고 실패/중복의 spend도 모두 기록한다. 예산 guardrail이 이미 발생한 과금을 취소하거나 decision admissibility를 보장하지 않는다. | pending |
| R-S4-PROTECTION | 아래 보고서의 당시 보호 설정·관리자 우회 가능성을 인지하되 현재 적합 판정이나 그 설정의 영구 승인이 아니다. 미래 ProtectionPolicy는 실제 값을 재조회해 bypassDisclosure와 함께 별도 사람 승인을 받아야 한다. | pending |
| R-S4-LOSS | dispatch_unknown 뒤 유효창 만료까지 유효 unit/claim을 확정하지 못하면 programme_end로 소비한다. **실제 provider 접촉이 없어도 holdout을 잃을 수 있다.** 같은 ordinal 재예약·창 연장·재전송이나 사후 미접촉 확인으로 decision 상태를 복구하지 않는다. | pending |

R-S4-PROTECTION의 구체 관측: 확인 검토 보고서가 **2026-09-07T04:11:56Z**에 재조회했다고
보고한 값은 required checks 2건(strict=true), enforce_admins=false,
required_linear_history=false, allow_force_pushes=false, allow_deletions=false,
PR review 요구 존재, active rules=[]다. 이는 보고서에 귀속된 당시 관측이며 이 초안 작성에서
GitHub 설정을 새로 조회한 결과가 아니다. 관리자 우회 가능성을 숨기지 않고, 원래 SHA를
보존하는 merge 요구를 required_linear_history 강제로 바꾸거나 보호 설정을 수정하지 않는다.

## 6. 판정·이행·실행 권한의 경계

현재 이 초안에는 아무 승인 효력이 없다. 나중에 사람이 S3/S4 exact bytes와 N-1/N-2 및
위 잔여를 명시적으로 수용하더라도 그것은 **계약 판정**이며 조건의 구현·검증 완료가 아니다.
N-1/N-2를 구현 단계에서 충족해야 한다는 조건은 구현을 지금 시작하라는 허가가 아니다.

다음은 이 초안 작성이나 향후 이 범위의 계약 승인만으로 허용하지 않는다.

- scorer·validator·controller·custody·importer·ledger·workflow 구현, 테스트 코드 생성
- succ-9 purpose 전환·activation, dataset·manifest·register 변경
- 실제 holdout/case/gold/key 생성·열람·봉인·개봉·materialisation
- S5/v9 prompt 작성·활성화
- pair·예산 승인, dispatch/re-run/provider probe·유료 호출
- release gate, memoryExtractionEnabled, memoryInjectionEnabled 변경
- production·runner·secrets·environment·GitHub protection 설정 변경
- stage·commit·push·PR·ready·auto-merge·병합·배포

S2 §2의 **S1–S4 전체 contractApprovalCommit**은 각 최종 문서 commit·path·SHA-256을
결속한 사람 receipt를 담아야 한다. 이 미승인 초안이나 기존 S1/S2 부분 승인, S3/S4 검토
commit을 그 SHA로 대용하지 않는다. 미래 전체 승인 기록을 확정할 때는 기존 S1/S2 승인
receipt와 네 문서의 exact identity, 이번 조건·잔여의 사람 판정을 명시적으로 연결해야 한다.
이 S3/S4-only 초안이 자동으로 전체 승인 receipt가 되거나 별도 activationApprovalCommit을
생성한 것으로 처리하지 않는다. S2 approvalCommit은 그때도 원래 A다.

후속 순서는 상위 결정/S2 그대로다: **S1–S4 승인 → 별도 S2 activation 승인·전환 및
불변 검증 → 별도 지시된 scorer 구현·동결 → 격리 holdout 작성·검수·seal → S5**.
그 이후 exact pair/programme·ordinal별 budget/dispatch도 각각 필요한 승인을 받아야 한다.
계약 승인, Git merge, CI success, 배포 중 하나로 나머지 승인을 추론하지 않는다.

## 7. 최종 사람 판정과 확정 기록을 준비할 때

사람이 판정할 대상은 §1의 commit/두 raw SHA와 **이 초안 전체 문언**, N-1/N-2 조건안,
12개 잔여 및 상위 D1–D5/§12·기존 S1/S2 승계 경계다. 일부 거절·변경 요청은 전체 수용이 아니다.
이 초안 자체의 최종 raw hash는 사람에게 제시하고 미래 확정 receipt에서 결속한다.
자기 hash를 이 파일 안에 넣어 순환을 만들지 않는다.

사람의 명시적 승인과 승인자·승인일을 받은 뒤에만 에이전트가 별도 확정 receipt에 판정을
전사한다. 그때도 검토된 S3/S4와 승인받은 초안 원본은 보존하고, accepted 목록은 실제 판정한
범위만 기록한다. Claude의 CONFIRMED는 정확히 4d8a7c31…의 두 계약을 가리키며 이 초안의
새 조건 문언까지 검토·서명했다는 주장은 금지다. 단순 초안 작성 동의를 승인 증거로 쓰지 않는다.

hash 계산·계보 대조·원 보고서 보존 확인·전사·기록 검사는 에이전트가 준비한다. 사람에게
서명을 지어내거나 기술 검산을 떠넘기지 않는다. 최종 기록 commit과 push/PR/병합은 별도
지시가 있을 때만 수행한다. 원래 A와 승인/검토 SHA를 보존하는 merge commit 정책을 유지하며
squash/rebase를 자동 선택하지 않는다. 여기서 추가 확인 검토나 구현을 시작하지 않는다.
