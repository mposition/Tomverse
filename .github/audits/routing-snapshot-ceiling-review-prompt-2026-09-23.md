# 독립 검토 요청 — routing-snapshot ceiling

- 대상 commit: `caf19d6a7` `feat(routing): the ceiling a manifest is published under, added dark`
- 브랜치: `claude/to-develop/routing-snapshot-ceiling` (develop 기준)
- 설계 근거: `.github/audits/multi-provider-routing-deployment-identity-design-2026-09-22.md` §5 끝부분, §14 8번

## 무엇을 했는가

`RoutingIdentityManifest`에 `approvedCeiling INTEGER NOT NULL`을 더하고,
`manifestProblems()`가 상한 초과를 거절합니다. 기본값은 없습니다.

설계 §5의 문장은 이것입니다 — *"활성 registry 자체에 승인된 ceiling을 둡니다.
상한을 넘는 config는 publish를 거절하고 마지막 승인 snapshot을 유지합니다.
크기는 config 승인 시점에 통제하지 실행 시점에 증거를 버려 통제하지 않습니다."*

## 검토해 주셨으면 하는 것

### 1. 이것이 §5가 말한 ceiling이 맞습니까

- `RoutingIdentityManifest`가 "활성 registry"에 해당합니까, 아니면 §5는
  다른 것(예: `ModelDeployment` 행 집합 자체)을 가리킵니까?
- "마지막 승인 snapshot을 유지한다"가 이 구현에서 성립합니까? publish를
  거절하면 이전 version 행이 그대로 남는다는 것이 근거인데, 그 전제가
  맞습니까?
- §5는 **"런타임에서 예상 밖 초과가 나면 overflow 사건으로 기록한다"**고도
  적습니다. 이 커밋에는 그 기록이 없습니다. 지금 있어야 합니까, 아니면
  런타임 경로가 생길 때입니까?

### 2. 저장 대 조회

상한을 행에 저장했습니다. 근거는 "나중 독자가 *그때*의 상한을 묻는다"입니다.

- 이 논거가 성립합니까? 아니면 설정 하나를 읽는 편이 맞습니까?
- 저장하면 상한을 올린 뒤 옛 manifest가 새 상한 아래에 있는 것처럼 보이지
  않게 됩니다. 반대로 저장해서 생기는 문제가 있습니까?

### 3. NOT NULL, 기본값 없음

"상한은 승인이고, 없는 승인은 무제한이 아니다"가 근거입니다.

- 이 fail-closed가 맞습니까?
- 테이블이 비어 있으므로 `NOT NULL`이 비용 없이 들어갑니다. 이미 행이 있는
  테이블이었다면 어떻게 해야 했습니까 — 그 차이를 주석이 정확히 적고
  있습니까?

### 4. 두 번 말하는 것

`manifestProblems()`는 **건네받은 entry 배열**과 비교하고, CHECK는 **저장된
`entryCount`**와 비교합니다.

- 이 둘이 정말 다른 것을 말합니까, 아니면 같은 말의 중복입니까?
- 한쪽만 통과하고 다른 쪽이 거절하는 입력이 있습니까?
- `entryCount`와 entry 실제 개수의 결속은 `manifestProblems()`에만 있습니다
  (CHECK는 한 행만 봅니다). 그 틈이 이 ceiling 검사를 무의미하게 만듭니까?

### 5. 주장이 코드보다 큰 곳

이 작업에서 반복된 결함입니다 — 주석이 강제되지 않는 성질을 주장하는 것.
commit message, migration 주석, schema 주석, 테스트 이름 넷을 확인해
주십시오.

특히 "said twice on purpose, and the two say different things"가 정확합니까.

### 6. 3치 논리

`CHECK ("entryCount" <= "approvedCeiling")` — 두 컬럼 다 `NOT NULL`입니다.
NULL로 평가될 수 있습니까? 이 작업에서 두 번 걸린 부류입니다.

## 판정 형식

`approve` / `approve_with_changes` / `reject`, 발견마다
`blocker` / `major` / `minor`. 사실 주장에는 **파일과 줄**을 대 주십시오.
