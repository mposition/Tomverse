# 독립 검토 요청 — routing-snapshot ceiling, 3라운드

- 브랜치: `claude/to-develop/routing-snapshot-ceiling`
- 2라운드 판정: **approve_with_changes**, major 1 · minor 2.

## 2라운드 지적과 대응

**major — 상한은 manifest 행의 정수 둘에 걸리고 entry 행에는 걸리지 않았습니다.**
manifest(entryCount 2, ceiling 2)를 넣은 뒤 entry를 셋 넣으면 모든 검사가
통과했습니다. manifest는 UPDATE가 거절되므로 entryCount는 2에 남습니다.

대응: entry에 **slot**을 두었습니다(migration §3).

- `slot INTEGER NOT NULL`, `CHECK (slot >= 0)`, `UNIQUE (manifestId, slot)`
- BEFORE INSERT trigger `routing_identity_manifest_entry_fits_its_manifest`가
  `NEW.slot >= 그 manifest의 entryCount`이면 거절하고, manifest가 없으면
  따로 거절합니다
- 결과: 한 manifest의 entry 수 ≤ entryCount ≤ approvedCeiling(§2의 CHECK)

지적에서 제안한 "manifest 행을 잠근 뒤 COUNT"를 쓰지 않은 이유: REPEATABLE
READ에서는 잠금을 얻은 뒤에도 트랜잭션 snapshot이 상대의 entry를 보지 못해 두
INSERT가 모두 통과할 수 있다고 판단했습니다. slot은 읽는 행(manifest)이
불변이고 중복은 unique index가 정하므로 격리 수준과 무관하다고 봤습니다.
테스트는 trigger에 `COUNT(`가 없음을 고정합니다.

한계로 적은 것: entry 수를 entryCount **이하**로 묶을 뿐, entryCount에
**도달**하게 만들지는 않습니다. 모자란 manifest는 여전히 보고만 됩니다.

**minor 1** — 142행 "must precede" → "may not be dated after (the same instant
is allowed)".

**minor 2** — schema에 `@@index([ceilingApprovalId])` 추가(migration 130–131과
일치). entry에 `@@unique([manifestId, slot])` 추가.

테스트 이름: "the database refuses …" → "the migration installs a refusal …"
으로 바꾸고, migration 텍스트를 읽는 것이지 PostgreSQL 실행이 아니라고 주석에
적었습니다.

marketing pipeline fingerprint를 다시 고정했습니다(schema 전체를 감시).

## 이번에 봐 주셨으면 하는 것

1. **slot이 major를 닫습니까?** 특히
   - 같은 slot을 두 트랜잭션이 동시에 넣을 때, 그리고 서로 다른 slot 둘이
     entryCount를 넘지 않는 범위에서 동시에 들어올 때 — 격리 수준별로
   - trigger가 manifest를 읽는 시점: 같은 트랜잭션에서 manifest와 entry를 함께
     넣는 경우(manifest INSERT가 먼저) trigger가 그 manifest를 봅니까?
   - `NOT FOUND` 분기와 FK의 관계는 2라운드에서 확인한 ceiling trigger와
     같습니까?
2. **slot이 digest에 없는 것이 문제입니까?** slot은 저장 위치이지 배포의
   정체성이 아니라고 봤습니다.
3. **3치 논리**: `NEW.slot`, `entryCount` 모두 NOT NULL입니다. trigger가 NOT NULL
   검사보다 먼저 돌 때 NULL slot은 어떻게 됩니까?
4. **주장이 코드보다 큰 곳**이 남았습니까? migration §3 주석, schema 주석,
   `lib/routingIdentityManifest.ts`의 새 주석, 테스트 이름.

## 판정 형식

`approve` / `approve_with_changes` / `reject`, 발견마다
`blocker` / `major` / `minor`. 사실 주장에는 **파일과 줄**을 대 주십시오.
