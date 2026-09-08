# Memory eval vNext S1·S2 계약 승인 record 초안 — 2026-09-07

**상태: DRAFT / UNSIGNED — 사람 미승인, 효력 없음.**
작성자: Codex. 작성일은 승인일이 아니다.

이 문서는 검토된 S1·S2 bytes를 바꾸지 않고, 사람이 판정할 정확한 대상·조건·잔여를
한곳에 준비한 **미서명 초안**이다. authoritative approval receipt가 아직 아니다.
초안 작성을 요청한 응답은 최종 계약 승인이나 아래 조건·잔여의 수용 서명이 아니다.
CONFIRMED는 외부 확인 검토 결과이며 사람의 decision을 대신하지 않는다.

## 1. 판정 대기 기록과 정확한 대상

```yaml
recordStatus: draft_unsigned
decision: pending
approvedBy: null
approvedAt: null
approvalScope: S1_S2_contracts_only
reviewedContractCommit: "fa682cc2209fc5b0a9ebd994aa626d00997b0359"
contractDocumentsForDecision:
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
requiredConditionIds: [P2-N1, C-COORD-1]
requiredResidualIds: [R-SENS-1, R-GRAM-1, R-DETECTOR-1, R-KO-SUBJECT-1, R-PRELEDGER-1, R-SCOPE-1]
acceptedConditionIds: []
acceptedResidualIds: []
upstreamD1D5AndSection12Acknowledged: null
```

null·pending·빈 accepted 목록은 **아직 사람 판정이 기록되지 않았다**는 뜻이다.
필요 항목 목록을 채운 것과 사람이 그 목록을 수용한 것은 다르다. 승인자의 이름·날짜는
기존 commit A나 확인 검토자의 이름에서 복사하지 않는다.

위 SHA-256은 각각 명시된 S1·S2 파일의 raw bytes에만 귀속된다. 이 초안 자신의 SHA,
다른 초안·검토 보고서·원래 결정문 SHA를 S1·S2 승인 SHA로 대체하지 않는다.
검토된 S1·S2의 제목·상태 표시·본문을 Approved로 바꾸지 않는다. 최종 사람 승인을
받더라도 그 사실은 별도 기록으로 결속하며, 검토된 bytes와 두 hash를 보존한다.

## 2. 이미 승인된 상위 결정과 commit 구분

다음은 새로 승인받는 항목이 아니라 보존해야 할 기존 근거다.

| 역할 | 정확한 식별자 |
|---|---|
| 원래 결정문 | `.github/audits/memory-eval-vnext-contract-decision-2026-09-05.md` |
| 결정문 raw SHA-256 | `355f8387808b8a7ea86e02ecffc4303562b5ab5c43c27fef0c2bdb2bf57e89da` |
| 원래 authoritative receipt | `.github/audits/memory-eval-vnext-contract-decision-approval-2026-09-06.md` |
| 원래 receipt raw SHA-256 | `838af4d1fee11122b5a2ec6b72d5ed905a59b2b370ec2d7b88e87bdd193291f5` |
| 원래 repository basis | `6263ecdcc1e69585498c19c0a294fef5202f5218` |
| decision commit A / S2의 approvalCommit | `3f14afb29eddc243640fdb0a5a4f604646ade9f0` |
| A를 원래 SHA로 보존한 merge | `c2474837132a4355b750be0229e954ac30eb0ab6` |
| S1·S2 작성 develop basis | `11f11f0d38dea3c28d365503bc7b77ed0d793204` |
| 이번 승인 대상 계약 commit | `fa682cc2209fc5b0a9ebd994aa626d00997b0359` |

원래 결정문은 400줄이고 §13이 빈 상태의 bytes를 승인받았다. 서명 칸을 채우지 않는다.
commit A의 기존 사람 승인은 @mposition / 2026-09-06이며 S1·S2 최종 승인이 아니다.

이 초안은 S2의 `approvalCommit`을 바꾸지 않는다. 나중에 이 기록이 서명·commit되더라도
그 새 SHA는 **S1·S2 부분 계약 승인 기록의 commit**이다. S2가 요구하는 S1–S4 전체 승인
`contractApprovalCommit`이나 별도 `activationApprovalCommit`으로 자동 승격되지 않는다.
미래 승인 기록의 자기 commit SHA를 지금 예측하거나 자기 본문에 써 넣지 않는다.

## 3. 외부 확인 검토 — 사람 승인과 별개의 관측

- 검토자: Claude. 사용자가 전달한 확인 검토 보고서를 근거로 기록한다.
- requestedCommit = reviewedCommit = `fa682cc2209fc5b0a9ebd994aa626d00997b0359`.
- targetMatched: true. external confirmation review: **CONFIRMED**.
- 원래 P1-1(legacy promptVersion), P1-2(precision 모집단): 보고서 판정 CLOSED.
- 보고서의 새 P1: 없음. 수정 회귀: 발견하지 못함. 새 명시 공백 P2-N1은 아래 조건안으로 남긴다.
- D1–D4 보존을 확인했고 D5는 S1·S2 범위 보존, 나머지 S3·S4 위임으로 PARTIAL이다.
  이를 D5 전체 구현·검증 완료라고 읽지 않는다.
- 예정된 수정본 확인 검토 1회는 완료됐다. 이 초안 작성은 추가 확인 검토가 아니다.

원문은 사용자가 전달한 로컬 첨부이며, 이 파일에 원문 전체를 복제하거나 Git에 보존했다고
주장하지 않는다. 인계 위치와 원문 raw SHA-256은 다음과 같다.

```text
C:/Users/Vyper/.codex/attachments/c9d45ce4-f000-46a7-abf4-bf6761854f48/pasted-text.txt
sha256: e2205f0b9b985bde93d04f67f3f3b054b102811721cbcd218ccec0e21fcfab2d
```

최종 기록 확정 시 에이전트가 원문 bytes·hash와 보존 위치를 확인해 결속한다. 위 hash는
보고서의 무결성 식별자이지 그 보고서의 사람 서명이나 S1·S2 승인 hash가 아니다.
최초 검토 대상 b6610c21 또는 중간 수정본 04f23476의 결과로 이번 확인을 바꾸어 쓰지 않는다.

## 4. 사람이 채택할 조건안 — 아직 수용되지 않음

### P2-N1 — S3의 permitted region 작성 경계

제안하는 승인 조건은 **S3가 sensitive_review gold의 evidence region을 permitted로
표시하지 않는 것**이다. permitted region의 goldId는 bulk_safe gold만 참조하도록
S3 계약·작성 검수 조건에 명시한다. 비허용 영역의 prohibited/unknown 판정은 S1의
기존 규칙에 따르며, 이 조건을 근거로 민감 evidence를 bulk_safe로 재분류하지 않는다.

S1 §5.1의 (c)는 계속 **모든 permitted region의 정확한 NFC slice**를 검사한다.
민감 gold의 region을 조용히 스캔에서 제외하거나 case-local OR를 AND·matching 면제로
바꾸는 안이 아니다. 입력 작성 단계에서 해당 region을 permitted로 만들지 않는 조건이다.
S3는 같은 case의 민감 value 충돌을 seal 전 차단하고 다른 case 중복은 진단으로 분리하는
S1 계약도 그대로 승계해야 한다.

이 조건을 사람이 채택하기 전에는 P2-N1의 사람 결정이 완료됐다고 기록하지 않는다.
채택 후에도 실제 S3 계약에 반영·검증되기 전에는 구현이나 실제 holdout 작성·seal의
완료 조건으로 사용할 수 없다. 현재는 S3를 작성하거나 holdout을 만든 것이 아니다.

### C-COORD-1 — Collision 좌표 해석의 명시

S1의 Collision.start/end는 **target text에 상대적인 NFC scalar occurrence 위치**이며,
target이 permitted_region이면 그 NFC slice의 시작을 0으로 센다.
AuthoringTarget의 region start/end는 **message 안의 절대 NFC scalar 위치**다.
S3는 두 좌표를 같은 것으로 저장·검증하지 않도록 이 구분을 명시적으로 승계한다.
이는 보고서의 부수 P3 문언 제안을 판정 가능한 조건으로 적은 것이며 새 변환·허용 규칙은 아니다.

이 두 조건은 검토된 S1·S2 bytes를 변경하지 않고 사람이 채택할 **명시적인 작성 제약**이다.
조건을 숨긴 채 descriptor·manifest·schema를 새로 계산하거나 S1 scoring 의미를 바꾸지 않는다.
본문 변경이 실제로 필요해지면 별도 계약 개정으로 다루고, 바뀐 bytes가 기존 CONFIRMED의
대상이라고 주장하지 않는다.

## 5. 사람이 명시적으로 수용할 잔여 — 여섯 항목 전부 대기

아래는 최종 승인 시 수용할 문구의 초안이지 이미 수용된 사실이 아니다.

| ID | 제안하는 수용 범위와 유지할 경계 | 현재 상태 |
|---|---|---|
| R-SENS-1 | case-local ValueRef OR를 유지한다. 단독 민감성 사람 검수는 틀릴 수 있고 같은 case 사전 충돌 검사도 미래 후보의 false FAIL·누락을 완전히 제거하지 못한다. 다른 case 중복은 진단이며 특이도·분포 검토가 필요하다. 작성 제한과 holdout 소비 비용을 수용할지 판정한다. 세부 제한은 아래 문단과 같다. | pending |
| R-GRAM-1 | closed grammar/identity-nfc-1의 좁은 분포를 수용할지 판정한다. 복합 constraint·decision·recurring_context·long_term_goal 및 자연 발화 상당수를 표현하지 못하고 cell floor는 대표성을 증명하지 않는다. holdout을 보고 grammar를 넓히는 허가가 아니다. | pending |
| R-DETECTOR-1 | 전체 nonempty token sequence detector는 paraphrase 누출을 놓칠 수 있다. detector가 거짓이라는 사실만으로 allowed를 주지 않으며 독립 safety proof·exact-set 사람 검수의 한계까지 수용할지 판정한다. | pending |
| R-KO-SUBJECT-1 | 한국어 K=""의 주어 생략은 parser가 사용자 귀속을 증명하는 것이 아니다. gold/evidence 사람 검수에 의존하고 message 단위 결속의 잔여를 갖는다. user role만으로 귀속을 보장했다고 간주하지 않는다. | pending |
| R-PRELEDGER-1 | 유일한 v8 V 예외 밖의 pre-ledger purpose는 unknown이며 이 resolver로 다른 과거 run의 purpose를 새로 증명할 수 없다. v8 revoked를 근거로 다른 모든 pair도 revoked라고 가정하지 않는다. 이 제한을 수용할지 판정한다. | pending |
| R-SCOPE-1 | 전체 historical snapshot 122개와 전방 동결 109개 + 별도 ledger를 분리하는 범위·증거 보관 비용 및 아래 컴파일·호환성 유지 비용을 수용할지 판정한다. 공유 module 13개의 현재 bytes는 전방 동결하지 않지만 역사 재현에 current helper를 혼입하지 않는다. | pending |

**R-SENS-1의 구체적인 작성 제한:** sensitive gold의 모든 Value는 다른 ValueRef와 결합하지
않아도 그 자체를 사용자 기억이나 근거로 공개했을 때 민감해야 한다. 결합해야만 민감한
조각을 각각 standaloneSensitive=true로 표시할 수 없다. 결합형 사실은 필요한 경우
기존 grammar가 허용하는 하나의 단독 민감 surface(여러 atom으로 된 Value 포함)로
표현 가능해야 한다. 그렇지 않으면 authoring에서 거부한다. 이를 수용하기 위해 grammar를
확장하거나 임의 요약·surface 변환으로 우회하지 않는다. 표현하지 못하는 사실과 좁아지는
작성 분포도 수용 여부의 대상이다.

**R-SCOPE-1의 구체적인 유지 비용:** snapshot-only 공유 module 13개를 후속 변경하더라도
전방 동결 109개 파일, 특히 `lib/memoryEvalSucc9.ts`와 계속 컴파일·계약 호환되어야 한다.
이 유지 비용은 snapshot 증거 저장 비용과 별개다. 호환성이 깨지면 공유 module 변경
측에서 호환을 유지하거나 별도 계약 개정 판단을 받아야 하며, 이 기록만으로 동결된
파일·manifest·기존 digest를 수정할 수 없다. 이 비용 수용은 13개 module의 현재 bytes까지
영구 동결한다는 뜻도, current helper로 과거 결과를 재계산해 대체해도 된다는 뜻도 아니다.
역사적 재현은 S2가 정한 완전한 pinned snapshot·dependency 증거로만 한다.

상위 결정문 §12의 기존 여섯 잔여도 축소하지 않는다. 닫힌 parse의 false negative,
1인 조직에서 같은 사람이 여러 검수·판정을 맡아 사람 수준 blind를 주장할 수 없는 점,
human extra-content 판단의 오류 가능성, 탐지 전 duplicate spend, GitHub/importer 신뢰,
message 단위 evidence 결속의 한계를 그대로 인지해야 한다. 상위 결정의 기존 수용만으로
위 R-* 여섯 구체 항목까지 자동 수용됐다고 간주하지 않는다.

## 6. 최종 승인하더라도 열리지 않는 권한

이 초안에는 현재 아무 승인 효력이 없다. 나중에 사람이 위 두 계약과 조건·잔여를
명시적으로 승인하더라도 범위는 **S1·S2 계약 판정**뿐이며 다음을 허용하지 않는다.

- scorer·validator·ledger 구현 또는 테스트 코드 생성
- succ-9 purpose 전환이나 activation
- dataset·manifest·register 변경
- 실제 holdout 작성·열람·봉인·개봉
- v9 prompt 작성 또는 활성화
- 예산·dispatch·provider 호출, pair 승인
- release gate 변경
- `memoryExtractionEnabled` 또는 `memoryInjectionEnabled` 변경
- push·PR 생성·ready 전환·auto-merge·병합·배포

S3·S4 문서 작성은 상위 결정의 권한과 별도 작업 지시에 따르며, 이 초안 작성이 그 작업을
시작한 것은 아니다. S1·S2 승인만으로 S3·S4도 승인됐다고 처리하지 않는다.
후속 순서는 원래 결정문 §7.1 그대로다. **S1–S4 승인 → 별도 S2 activation 승인·전환 및
불변 검증 → scorer 구현·동결 → 격리 holdout 작성·검수·seal → S5**를 건너뛰지 않는다.
그 뒤의 pair·protocol·예산 결속과 programme 실행도 각각 필요한 승인을 받아야 한다.

## 7. 최종 사람 판정을 기록할 때

사람이 해야 하는 것은 대상과 조건·잔여에 대한 판정·서명이다. 파일 hash 계산, 증거
대조, 판정 문구 전사, 최종 기록 검사는 에이전트가 준비한다. 서명 값은 추정하지 않는다.

승인으로 확정하려면 사람이 이 문서의 정확한 버전과 위 S1·S2 commit/두 raw SHA를
대상으로, P2-N1·C-COORD-1 조건 및 R-* 여섯 잔여와 상위 D1–D5/§12의 유지에 대해
명시적으로 판정해야 한다. 에이전트는 그 판정에 근거해서만 decision·approvedBy·approvedAt,
acceptedConditionIds·acceptedResidualIds·upstreamD1D5AndSection12Acknowledged를 기록한다.
일부 조건을 거절하거나 개정을 요구하면 원래 초안 전체를 승인한 것으로 처리하지 않는다.

그 전에는 recordStatus=draft_unsigned를 유지한다. 서명 전 문구를 다듬는 것과 검토된
S1·S2 bytes를 바꾸는 것을 혼동하지 않는다. 독립 확인은 fa682cc2의 두 계약에 대한 것이며
이 새 초안 자체를 Claude가 검토·서명했다고 쓰지 않는다. 이 초안의 hash와 전체 문언도
최종 사람 판정에 결속해야 하며, 일부 hash만 맞춘 다른 내용으로 승인 범위를 바꾸지 않는다.

최종 기록 commit은 별도 지시 전에는 만들지 않는다. 후속 S2 검증에서 A를 계속 참조할 수
있도록 원래 A의 ancestry를 보존해야 하며, 미래 승인 이력을 보존하지 않는 squash/rebase를
자동으로 선택하지 않는다. 이 문서는 아직 그 승인 기록 commit도, PR도, activation도 아니다.
