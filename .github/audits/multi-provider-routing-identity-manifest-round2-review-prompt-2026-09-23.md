# 독립 검토 요청 — A-5 manifest, 2라운드

- 대상 commit 둘:
  - `e0e260044` `fix(routing): a manifest publishes its entries, not just their hash`
  - `78c967000` `docs(routing): say what the foreign key adds that the trigger does not`
- 1라운드 판정: **reject**, blocker 2건 + major 2건 + minor 5건.
  요청서는 `.github/audits/multi-provider-routing-identity-manifest-review-prompt-2026-09-23.md`.
- 검토 worktree: `H:\Project\tv-routing-review-20260922`

## 1라운드 지적을 어떻게 닫았는가

**blocker 1 — digest field 목록이 저장소가 이미 identity라 부르는 것보다 좁음.**
`model_deployment_gate_follows_identity()`의 9개 컬럼 중 5개가 빠져 있었고
(`modelRevision`, `quantization`, `tokenizerRevision`, `qualityTier`,
`capabilities`), `ProviderEndpoint`는 통째로 id와 residency class만 봤습니다.

목록을 19개로 넓혔습니다. `qualityGateExpiresAt`, endpoint의
`gatewayProvider`·`servingProvider`·`endpointUrl`·`enabled`를 포함합니다.
`capabilities`는 `canonicalCapabilities()`로 바이트가 됩니다. 테스트가
**trigger의 컬럼 목록을 migration에서 읽어** digest가 덮는지 비교합니다.

**blocker 2 — 행은 digest를 잠글 뿐 재구성이 안 됨.**
`RoutingIdentityManifestEntry`를 만들었습니다. 결정이 의존하는 값은 publish
시점에 복사하고, residency approval은 FK입니다(그 테이블이 append-only이므로
법적 내용이 이미 불변).

**major 3 — `approvedBy` 공백 집합 불일치.** 양쪽 다 여섯 글자 클래스입니다.
**major 4 — `entryCount`가 digest와 무관.** `ManifestInput`에 들어가고
entries와 대조합니다.

**minor** — `manifestDigest`가 entry 전체 인코딩으로 정렬(중복 순서 무관),
`encodeField`의 null이 `-:`(NUL 충돌 해소, `d0231db1b`), FK/trigger 주석 정정,
credential 테스트 이름과 목록 정정("token"은 `tokenizerRevision` 때문에 제외).

## 이번에 검토해 주셨으면 하는 것

### 1. 목록이 이제 충분한가

- 19개가 **여전히 부족합니까?** 결정이 의존하는데 빠진 것이 있습니까?
- 반대로 **과합니까?** 결정이 바뀌지 않는데 digest가 움직이면 불필요한
  재승인이 생깁니다.
- 제외 사유 다섯(`routingPolicyDigest`, `region`, `destinationRegions`,
  `resourceId`, `cloudAccountId`)이 각각 성립합니까? 특히
  `region`/`destinationRegions`를 approval의 파생으로 두는 것이 §15.3과
  맞습니까 — approval이 **없는** endpoint에서는 무엇이 답이 됩니까?
- trigger 목록을 읽는 테스트가 실제로 무엇이든 막습니까? 정규식이 trigger
  본문을 잘못 잘라 컬럼을 덜 찾으면 통과합니다.

### 2. 재구성이 이제 되는가

- entry 행만으로 "그때 무엇이 허용됐는가"에 답이 됩니까? 아직 못 꺼내는 것이
  있습니까?
- `capabilities`를 `TEXT`(canonical JSON)로 둔 것이 맞습니까? `jsonb`면
  바이트가 보존되지 않아 digest가 흔들린다는 것이 논거입니다. 이 논거가
  정확합니까?
- `qualityGateExpiresAt`이 entry에서는 `TIMESTAMP(3)`이고 digest에서는 ISO
  문자열입니다. 두 표현 사이에서 값이 어긋날 수 있습니까?
- FK 셋이 `RESTRICT`입니다. **published manifest가 deployment·endpoint·
  approval의 삭제를 영구히 막습니다.** 이것이 옳습니까, 아니면 기록이 설정
  정리를 막는 상태입니까?

### 3. Cascade 하나

`manifestId`만 `ON DELETE CASCADE`입니다. 주석은 "manifest의 trigger가 DELETE를
막으므로 이 cascade는 실행되지 않는다"고 적습니다.

- 그 주장이 정확합니까? cascade가 실제로 실행되는 경로가 있습니까?
  (`DROP TABLE`, `session_replication_role = replica`, superuser의 trigger
  비활성화)
- 실행된다면 entry의 immutable trigger가 그것을 막습니까, 아니면 두 trigger가
  충돌해 manifest 삭제가 부분 실패로 끝납니까?

### 4. 3치 논리와 인코딩

- 이 migration에 CHECK로 평가되는 식이 있습니까? 있다면 NULL이 될 수 있습니까?
- `encodeField`의 세 모양(`-:`, `2:b1`/`2:b0`, `<len>:<값>`)이 서로 침범할 수
  있습니까?
- `canonicalCapabilities()`가 같은 선언에 다른 문자열을 낼 수 있습니까?
  (`undefined` vs `null`, `NaN`, `Infinity`, 순환 참조, `Date`, 큰 정수)

### 5. 주장이 코드보다 큰 곳

네 라운드 연속으로 나온 결함입니다. commit message, migration 주석, schema
주석, 테스트 이름 21개를 확인해 주십시오. 특히:

- "the entries are stored, not only hashed"가 실제로 저장을 확인합니까,
  아니면 SQL에 이름이 있는지만 봅니까?
- "an entry cannot be rewritten"의 FK 개수 단언(RESTRICT 3, CASCADE 1)이
  의미 있는 것을 고정합니까?
- 1라운드가 지적한 attempt 주석·모듈 헤더·migration의 "what that row held"가
  이제 정확합니까?

## 판정 형식

`approve` / `approve_with_changes` / `reject`, 발견마다
`blocker` / `major` / `minor`. 사실 주장에는 **파일과 줄**을 대 주십시오.
