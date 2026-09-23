# 독립 검토 요청 — 세 번째 workspace package가 Prompt Refiner 계약에 허용되는가

**이것은 diff 검토가 아니라 접근 가능성 검토입니다.** 코드를 쓰기 전에 묻습니다.

- 브랜치: `claude/to-develop/router-core-package` (develop 기준)
- 이미 한 것: `packages/router-core` 복원, `tsconfig.json` paths, `next.config.ts`
  transpilePackages, `lib/routerSelection.ts`가 package를 쓰도록 변경
- 아직 안 한 것: Prompt Refiner closure 계약 갱신 — **이 검토의 대상**

## 배경

`packages/router-core`는 `lib/routerSelection.ts`에 있던 순위 정련 구성을
framework-neutral package로 옮긴 것입니다. 제품 결정(어떤 기준이 있고 무엇을
읽고 epsilon이 얼마인지)은 앱에 남고, 구성만 package에 있습니다.

PR #1615에서 이것만 되돌렸습니다. 이유는 아래입니다.

## 문제

Prompt Refiner의 runtime source closure가 **workspace package를 열거**합니다
(`tests/promptRefinerRuntimeSourceClosure.test.mjs`의 `fixedNonImportPaths`는
`workspacePackageDirectories.map(... package.json).sort()`를 전개합니다).

그래서 refiner가 이 package를 import 하지 않아도
`packages/router-core/package.json`이 closure에 들어가고, 파일 수가 188에서
움직입니다.

**188은 네 곳에 고정돼 있습니다.**

1. `lib/promptRefinerStageAdmissionCore.ts`의
   `PROMPT_REFINER_RUNTIME_SOURCE_FILE_COUNT`와 순서 있는 경로 배열
2. `prisma/schema.prisma`의 주석
3. `prisma/migrations/20260918130000_prompt_refiner_stage_admission/migration.sql`의
   `expected_paths CONSTANT TEXT[]` (187개) — **이미 적용됨**
4. `prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql`
   — **이미 적용됨.** 여기에 둘이 있습니다:
   - v3 wrapper 함수 (v2 목록 + 자기 마이그레이션 1개 = 188)
   - stage 행 `prompt-refiner-shadow-v2`의 `executionManifest`를 고정하는 CHECK,
     그 안에 `"runtimeSource":{"fileCount":188,...}`

## 이 검토가 묻는 것

### 1. stage 행의 `fileCount`는 역사적 기록입니까, 현재 값입니까?

`20260921100000` 마이그레이션 첫 줄은 **"완료된 v1/v3 stage, reservation, run,
attempt를 변경하지 않고"** 라고 적습니다. 그 문장대로라면 `fileCount: 188`은
그 stage가 승인된 시점의 closure 크기이고, 움직이면 안 됩니다.

그런데 `tests/promptRefinerRuntimeSourceClosure.test.mjs` 1355–1363행이 그것을
**현재 TypeScript 상수에 묶습니다**:

```js
const executionManifestFileCount = migration.match(
  /"schemaVersion":"prompt-refiner-shadow-execution-manifest-v2"[\s\S]*?"runtimeSource":\{"fileCount":(\d+),/
);
assert.equal(
  Number(executionManifestFileCount[1]),
  PROMPT_REFINER_RUNTIME_SOURCE_FILE_COUNT,
  "migration executionManifest runtimeSource.fileCount differs from the TypeScript runtime source contract"
);
```

**둘 중 하나는 틀렸거나, 제가 무언가를 놓쳤습니다.** 어느 쪽입니까?

- 역사적 기록이라면, 테스트의 그 단언이 과합니다. package 추가는 TS 상수와
  새 wrapper만 움직이고 stage 행은 그대로여야 합니다.
- 현재 값이라면, 이미 적용된 마이그레이션 안의 CHECK와 그것이 고정하는 행을
  둘 다 바꿔야 합니다.

### 2. 적용된 마이그레이션을 어떻게 다루는 것이 맞습니까?

`20260921100000`은 production에 적용돼 있습니다(추정 — 확인해 주십시오).
파일을 편집하면 Prisma checksum이 바뀌어 배포가 실패합니다.

그러면 새 마이그레이션이 필요한데, 테스트 5의 정규식은 **파일 경로를 하드코딩**해
`20260921100000`에서 읽습니다. 새 마이그레이션을 쓰면 그 테스트도 고쳐야 합니다.

**테스트가 최신 마이그레이션을 읽도록 고치는 것이 이 계약의 의도에 맞습니까,
아니면 그 하드코딩이 의도적인 봉인입니까?**

### 3. 새 마이그레이션 자신도 closure에 들어갑니까?

`fixedNonImportPaths`는 마이그레이션 둘을 **손으로** 나열합니다. v3는 자기
마이그레이션을 목록에 넣었습니다(187 → 188).

같은 규칙이면 v4 마이그레이션도 들어가 **188 → 190**(package 1 + 마이그레이션 1)
입니다. 189가 아닙니다.

**맞습니까?** 그리고 그 규칙의 근거는 무엇입니까 — 계약을 정의하는 파일이
계약이 덮는 집합에 들어가는 것이 의도입니까?

### 4. 그래서 이 package는 지금 추가해도 됩니까?

솔직한 배경: **두 번째 client가 없습니다.** `docs/policy/shared-packages.md`
§7은 "이미 공유되는 코드를 옮겨서 seed 하라"고 적습니다. router-core는 아직
한 곳에서만 쓰입니다.

얻는 것: 순위 정련 구성이 framework-neutral 경계 안에 들어가고, ESLint가
`next`·`@/*`·`node:*` import를 막고, tsconfig가 `window`·`process`를 막습니다.
PACKAGE-01이 재측정됩니다.

치르는 것: 다른 워크스트림의 봉인 계약을 움직이고, 승인된 stage 행을 건드릴
수도 있습니다.

**이 교환이 지금 성립합니까?** 대안 셋 중 무엇을 권합니까?

- (a) 지금 package를 추가하고 계약을 갱신한다
- (b) 두 번째 client(`chat-ui`, `api-client`, 또는 mobile)가 생길 때까지
      `lib/routerSelection.ts`에 둔다
- (c) 다른 방법이 있다 — closure가 workspace package를 열거하지 않게 하거나,
      package를 workspace 밖에 두거나

(c)가 가능하다면 구체적으로 어디를 어떻게 바꿔야 하는지 적어 주십시오.

### 5. 제가 놓친 결속이 더 있습니까?

188이 고정된 곳을 네 개 찾았습니다. **다섯 번째가 있습니까?** 특히 런타임에
manifest를 만들어 admission에 쓰는 경로가 있다면, 그쪽은 어떻게 됩니까.

## 판정 형식

이번에는 approve/reject가 아니라 **권고**를 주십시오. (a)/(b)/(c) 중 하나와
그 근거, 그리고 (a)라면 정확히 무엇을 어느 순서로 바꿔야 하는지.

사실 주장에는 **파일과 줄**을 대 주십시오. 제가 위에서 한 주장 가운데 틀린
것이 있으면 그것부터 지적해 주십시오 — 특히 "적용된 마이그레이션"이라는 추정과
"190" 계산입니다.
