# 독립 검토 요청 — A-5 원자적 config manifest

- 대상 commit: `f40ddb00a` `feat(routing): the atomic config manifest (A-5), added dark`
- 검토 worktree: `H:\Project\tv-routing-review-20260922`
- 직전 라운드: health 표본 grain 컬럼,
  `.github/audits/multi-provider-routing-health-grain-review-prompt-2026-09-23.md`.
  그 라운드의 major(주석은 네 컬럼을 지킨다고 했는데 `DARK_COLUMNS`에 없던 것)와
  minor 네 건은 `d5fcfd1eb`에서 닫았습니다. `DARK_COLUMNS`는 이제 컬럼별
  면제 목록을 갖습니다.

## 무엇을 했는가

설계 §14의 5번입니다. manifest 이전에는 네 가지가 금지돼 있습니다 — config
writer 활성화, canary 기록, eligibility 판정, deployment 단위 결정.

- `RoutingIdentityManifest` 테이블 (dark, immutable, version unique, digest 비unique)
- `RoutingAttempt`에 `identityManifestId` + `identityManifestDigest` 두 컬럼
- `lib/routingIdentityManifest.ts` — 순수, `node:crypto`만 import

## 검토해 주셨으면 하는 것

### 1. digest가 실제로 무엇을 약속하는가

`MANIFEST_DIGEST_FIELDS`가 손으로 쓴 아홉 개 목록입니다.

- **결정이 의존하는데 목록에 없는 field가 있습니까?** 있다면 manifest는
  "아무것도 안 움직였다"고 말하면서 결정이 바뀔 수 있습니다. 설계 §2.1의
  identity 경계 규칙과 대조해 주십시오.
- 반대로 **결정이 의존하지 않는데 들어간 field**가 있습니까? 그것은 결정이
  바뀌지 않았는데 digest가 움직이는 것이고, 불필요한 재승인을 만듭니다.
- `encodeField`의 인코딩이 충돌을 만들 수 있습니까? 특히 `\u0000`을 null의
  표현으로 쓰는데, field 값 자체가 `\u0000`을 담을 수 있습니까?
- 길이 접두가 붙은 뒤에도 두 서로 다른 entry 집합이 같은 digest를 낼 수
  있습니까?

### 2. immutable이 실제로 immutable인가

- trigger 둘(`UPDATE OR DELETE` row, `TRUNCATE` statement)이 덮지 않는 경로가
  있습니까?
- `RoutingAttempt`의 FK가 `ON DELETE RESTRICT`입니다. trigger가 이미 DELETE를
  막는데 FK가 또 막는 것이 중복입니까, 아니면 다른 것을 막습니까?
- manifest 행이 바뀌지 않는다는 것과, **그 행이 가리키는 설정이 바뀌지
  않는다**는 것은 다릅니다. 이 커밋이 둘을 혼동하는 곳이 있습니까?
  (entry들은 저장되지 않습니다 — digest만 저장됩니다.)

### 3. entry를 저장하지 않는 결정

manifest 행은 `digest`와 `entryCount`만 갖고 deployment 목록 자체는 갖지
않습니다.

- 이것이 "그때 무엇이 허용돼 있었나"에 답할 수 있게 합니까? digest만으로는
  **검증은 되지만 재구성은 안 됩니다.** 설계 §4.4가 요구하는 것이 어느
  쪽입니까?
- 재구성이 필요하다면 무엇을 더 저장해야 합니까? 저장하면 개인정보·비밀값
  경계에 닿는 것이 있습니까?

### 4. 3치 논리, 다시

- `RoutingAttempt_identity_manifest_binding_check`의 두 갈래가 NULL로 평가될
  수 있습니까?
- `"digest" ~ '^[0-9a-f]{64}$'`는 NOT NULL 컬럼이고,
  `"identityManifestDigest" IS NULL OR ... ~ ...`는 nullable입니다. 양쪽 다
  맞습니까?
- `approvedBy` 공백 검사가 `manifestProblems()`와 **같은 집합**을 거절합니까?
  (앞선 라운드에서 `btrim`/`trim()`이 갈라진 적이 있습니다. 여기서는
  character class를 썼습니다.)

### 5. credential 부재

설계의 hard invariant입니다 — credential은 deployment의 endpoint·region·
residency·model version·capability를 재정의할 수 없습니다.

- manifest가 credential에 닿는 경로가 하나라도 있습니까?
- `endpointResidencyClass`와 `residencyApprovalVersion`이 manifest에 있는데,
  그 둘이 credential에서 유도될 수 있는 값입니까?
- 테스트 "credentials are not part of identity"가 실제로 무엇이든 막습니까?

### 6. 주장이 코드보다 큰 곳

이 작업에서 세 라운드 연속으로 나온 결함입니다. commit message, migration
주석, schema 주석, 테스트 이름 16개를 각각 확인해 주십시오.

특히 commit message의 "four things wait on it"이 정확합니까? 설계 §14 5번을
읽고 대조해 주십시오.

## 판정 형식

`approve` / `approve_with_changes` / `reject`, 발견마다
`blocker` / `major` / `minor`. 사실 주장에는 **파일과 줄**을 대 주십시오.
