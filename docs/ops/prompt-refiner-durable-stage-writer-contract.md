# Prompt Refiner durable stage writer 운영 계약

## 1. 불변 식별자

- stage: `prompt-refiner-shadow-v1`
- admission: `prompt-refiner-stage-admission-v1`
- approval TTL: 정확히 60분
- environment: `staging`만
- confirmation: `APPROVE PROMPT REFINER SHADOW STAGE V1 FOR 60 MINUTES`
- 감사 reason은 클라이언트 입력이 아니라 서버 내부 상수 `bounded_staging_shadow_cost_approval`로만 기록한다.

과거 proposal/evidence/corpus/source digest와 reservation/execution contract의 실제 값은
코드와 migration CHECK에 함께 고정된다. 운영자는 값을 request로 교체할 수 없다.

## 2. GET preview

`GET /api/admin/prompt-refiner/shadow-stage`

인증된 owner와 최근 인증을 요구한다. DB mutation, rate-limit 소비, stage/audit 생성은 없다.
서버가 과거 evidence를 replay하고 현재 deployment의 187개 고정 source 파일 raw bytes를 읽어
proposal/runtime-source/execution digest, commit, deployment, 고정 비용·slot·TTL과
`executionAdmitted:false`, `productAdapterReady:false`를 반환한다. 또한 environment,
deployment id, commit SHA, 세 digest, 비용·capacity·TTL 전체의 canonical JSON을 결속한
`previewBindingDigest`를 반환한다. 응답은 `no-store`다.

## 3. POST create-only

`POST /api/admin/prompt-refiner/shadow-stage`

body는 4 KiB 이하 strict JSON이고 다음 다섯 필드만 허용한다.

```json
{
  "proposalDigest": "sha256:<64 hex>",
  "runtimeSourceManifestDigest": "sha256:<64 hex>",
  "executionManifestDigest": "sha256:<64 hex>",
  "previewBindingDigest": "sha256:<64 hex>",
  "confirmation": "APPROVE PROMPT REFINER SHADOW STAGE V1 FOR 60 MINUTES"
}
```

POST는 owner, recent authentication, 전역 CSRF origin 검사와 DB atomic rate limit
(분당 2, 일 10)을 모두 통과해야 한다. 서버는 GET 결과를 신뢰하지 않고 source/evidence를
다시 검증하고 preview binding을 서버에서 재계산한다. 같은 commit/source라도 deployment id,
비용, capacity 또는 TTL이 달라진 오래된 preview는 transaction 진입 전에 409로 거부한다.

## 4. transaction과 idempotency

전용 transaction 순서는 다음과 같다.

1. 고정 advisory transaction lock
2. model registry SHARE lock과 모델/가격 계약 재검증
3. DB clock 취득
4. 기존 stage 조회
5. 없으면 tamper-evident audit insert
6. audit id를 FK로 가진 stage insert
7. 같은 공용 helper로 linked audit HMAC·metadata 결속을 검증하고 성공해야 commit

동일 actor가 같은 deployment/source/execution facts를 approval TTL 안에서 replay하면 기존
stage를 200으로 반환하며 audit을 추가하지 않는다. actor 또는 immutable facts가 다르거나
행이 만료된 뒤 replay하면 409다. 최초 생성은 201이다. audit 또는 stage 쓰기가 실패하면
둘 다 rollback한다.

## 5. 저장 manifest

runtime source manifest v2는 schema version, full commit SHA, 정렬된 고정 경로 각각의 byte
size와 SHA-256 및 검증된 총 byte 수만 담는다. 8 MiB/file과 16 MiB/closure를 모두
fail-closed로 적용한다. execution manifest는 고정 reservation/execution contract,
cost/capacity와 두 false readiness boolean만 담는다. 두 JSON 모두 strict canonical digest로
결속된다. prompt, refined prompt, output, user/conversation/session id, credential, provider
error/body는 담지 않는다.

## 6. DB 강제 계약

- migration은 기존 stage가 있으면 중단하고 seed/backfill하지 않는다.
- writer가 UTC로 정규화한 한 DB clock snapshot으로 승인·만료 시각을 audit metadata와 stage 양쪽에
  기록하고, INSERT trigger는 두 값이 정확히 일치하지 않으면 거부한다.
- DB CHECK는 187개 경로의 순서·exact key set·개별/총 크기·lowercase SHA-256 shape와 두 canonical
  digest를 다시 계산하고 execution manifest의 canonical digest도 다시 계산한다.
- 187개 중 178개 TypeScript/JavaScript source는 8개 실행 root에서 현재 parser가 지원하는
  static import/re-export, literal dynamic import, literal `require`, require alias,
  `module.require`와 `createRequire` 호출로 도달하는 local runtime 폐쇄와 같아야 한다.
  `node:module`과 `module`은 같은 builtin으로 취급하고 named·default·namespace import의
  `createRequire`는 추적한다. runtime re-export와 dynamic builtin namespace,
  `createRequire` 외 module namespace surface는 정적으로 안전성을 증명하지 않고 거부한다.
  `require("node:module")` 또는 `module.require("module")`의 반환값에서 곧바로
  `createRequire`/`_load` 등을 호출하는 체인도 별칭 추적을 우회할 수 있으므로 거부한다.
  type-only import는 제외하고, 해석할 수 없는 local 또는 non-literal runtime import도
  테스트에서 거부한다. 나머지 9개는 root/workspace package metadata와
  TypeScript/Prisma/migration 형식을 결속하는 고정 파일이다. 경로 해석은 checked-in
  `tsconfig` compiler option과 workspace package exports를 사용한다. closure 검사는 현재
  실행 폐쇄에서 사용하는 `process.env`, 직접 `process.cwd()`, 고정 operational state용
  `globalThis.__tomverseOperationalState`, `lib/prisma.ts`의 정확한
  `globalForPrisma.prisma` singleton 필드, 검증된 `Reflect.apply` 캡처만 명시적 safe form으로
  인정한다. Node `global`의 다른 직접·별칭 사용은 거부한다. operational state는 현재
  초기화 형태와 두 Map의 `get`/`set`만 허용한다.
  `constructor`/`__proto__`/임의 `prototype` 체인, `Reflect.get(module, "require")`,
  `process.mainModule.require`, eval/Function의 `.call`·`Reflect.apply` 및 그 밖의 정적으로
  증명할 수 없는 loader 사용은 거부한다. 이는 열거한 JavaScript loader/capability 형태를
  보수적으로 차단하는 구조 검사이며 임의 JavaScript reflection 전체에 대한 의미론적 증명은
  아니다. 특히 non-static element access(`value[key]`)는 parser의 기본 경로에서 전부 거부한다.
  현재 실행 폐쇄에 이미 존재하는 데이터 인덱싱만 path·line·column·정확한 source text의 정렬된
  SHA-256 snapshot으로 동결해 허용한다. 접근 하나가 추가되거나 위치·표현이 바뀌어도 gate가
  fail-closed하며, snapshot 갱신은 그 접근이 loader/capability escape를 열지 않는지 별도 검토한
  뒤에만 가능하다. 이 snapshot은 검토된 예외의 완전한 구조 목록이지 임의 JavaScript 의미론에
  대한 증명이 아니다. 특히 snapshot 안의 `value[key]`를 그대로 둔 채 다른 위치의 `key`
  binding 의미만 바꾸는 경우는 이 AST gate 단독으로 검출하지 못한다. 그 residual은 승인된 exact
  source-file bytes, full commit SHA와 deployment ID의 결속 및 독립 source review가 담당한다.
  새 safe form 또는 동적 capability는 closure 계약과 negative fixture를 함께 검토하기 전에는
  허용하지 않는다.
- tamper-evident audit의 actor/action/target와 metadata 전체(digest, cost/capacity,
  승인 시각·만료 시각·TTL, environment/deployment/commit, 서버 고정 reason)가 stage와
  정확히 일치해야 한다.
- DB trigger는 공개 구조와 결속만 검증한다. HMAC key를 소유하지 않으므로 `entryHash`의
  진위를 주장하지 않는다. application writer create/replay와 reserve/consume은 같은 helper로
  stage-linked audit 행의 signed payload를 현재·과거 integrity key와 현재·legacy canonical
  형식으로 재검증한다. linked entry의 signed metadata도 stage와 다시 비교한다.
  따라서 app-role이 exact metadata와 임의 64-hex hash로 audit/stage를 직접 삽입해도
  `stage_authorization_invalid`로 실행 권한을 얻지 못한다.
- HMAC 입력에 포함된 `previousHash`가 null이 아니면 그 exact `entryHash`의 선행 audit 행이
  존재해야 한다. 이 검증은 stage-linked 행과 그 선행 hash 최대 2행만 읽고 global chain
  scan/table SHARE lock을 하지 않으므로 unrelated audit write를 정체시키지 않는다. writer는
  새 stage를 commit하기 전 같은 helper를 실행해 생성됐지만 사용할 수 없는 stage를 rollback한다.
- stage provenance, actor, audit linkage와 생성 시각은 UPDATE할 수 없다.
- 허용된 status 변경은 `approved -> closed`뿐이며 DELETE는 금지다.
- reservation insert와 consume trigger는 stage expiry를 DB clock으로 검사한다.
- slot/cost accounting은 영구 reservation tombstone 합계와 같아야 한다.

## 7. reserve/consume 경계

application authority도 매 reserve와 consume 전에 stage-linked audit 행의 HMAC과 결속을 검증하고,
현재 environment/deployment/commit/source manifest와 execution contract를 다시 계산해 저장
stage와 비교한다. audit 위조, 불일치 또는 만료면 fail-closed한다. release와 expiry 정리는
이미 발생한 tombstone의 안전한 종료이므로 새 provider 실행 권한으로 취급하지 않는다.
같은 `requestId`의 active reservation replay도 예외가 아니다. stage 승인·expiry, runtime
source/deployment/execution, model/pricing이 모두 현재일 때만 기존 reservation을 idempotent하게
반환하며, drift 뒤 replay는 과거 reservation을 새 실행 권한으로 되살리지 않는다.

후속 durable run writer는 stage를 exact 16건 run 승인과 dispatch/terminal 기록 경계로 더
좁혔지만 actual provider admission/caller는 여전히 없다. stage나 run 승인이 생겨도 제품 요청,
credential lookup, network, provider call 또는 flag mutation은 발생하지 않는다. 후속 계약은
[`prompt-refiner-durable-run-writer-contract.md`](prompt-refiner-durable-run-writer-contract.md)에
있다.

## 8. 오류와 운영 판단

- 404: admin surface 은닉
- 403: admin이지만 owner 아님
- 428: recent authentication 필요
- 400/413: strict JSON 또는 4 KiB 위반
- 409: stale preview, 환경/source/contract drift, 기존 immutable stage mismatch
- 429: DB-backed rate limit
- 503: runtime identity/source 또는 audit signing key 없음

409는 retry 신호가 아니다. 새 GET으로 facts를 다시 확인하거나 이미 존재하는 immutable
행을 조사한다. migration의 기존-row abort도 삭제/우회하지 말고 provenance를 사람이
판정해야 한다.

## 9. 검증 경로

- pure core: manifest canonicalization, content-free fields, environment/digest/TTL refusal,
  preview binding 결정성·필드별 tamper 감지
- server contract: auth, GET no-write, strict body, no-network, fixed forwarding, CSRF coverage,
  같은 commit/source의 deployment 변경 stale-preview no-write 거부
- finance DB integration: no seed, concurrent one-row/one-audit, mismatch, rollback, direct SQL,
  expiry 및 consume 거부
- 기존 proposal/reservation/execution/Refiner/injection/PLANNER-03 회귀

독립 Claude round 0 package digest는
`sha256:989e42217bfe82d3ff36de280b383d4563f0ab6475ffa2fb51b4b4fae74f5cdc`이고
판정은 `request_changes`다. 지적 수정과 검증 뒤 round 1 제출 대기이며, 이 기록은
독립 검토 통과나 구현 완료를 뜻하지 않는다.
