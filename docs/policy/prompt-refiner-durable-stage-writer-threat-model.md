# Prompt Refiner durable stage writer 위협 모델

## 1. 보호 자산

- 승인된 과거 evidence/proposal/corpus/source snapshot의 정확한 identity
- 승인 시점 staging 배포의 commit, deployment id와 exact source bytes
- 고정 모델·가격·output cap·retry·timeout·slot·최악 비용 계약
- 승인자와 tamper-evident audit chain
- stage 및 reservation의 slot/cost accounting과 만료 시각
- 고객 content와 provider credential이 이 저장소에 유입되지 않는 경계

## 2. 신뢰 경계

브라우저 request body는 불신 입력이다. 승인자, 승인 시각, 환경, deployment, 모델, 가격,
capacity, TTL과 boolean은 request에서 받지 않는다. 서버 process environment도 사실 선언으로
바로 신뢰하지 않고 `staging`·full commit SHA·deployment id shape를 검사한다. checked-out
파일은 realpath containment, regular-file, size cap 뒤 raw bytes로 읽는다. 최종 시각과
만료는 PostgreSQL `clock_timestamp() AT TIME ZONE 'UTC'`가 소유한다.

과거 evidence도 체크인되었다는 이유만으로 신뢰하지 않는다. strict manifest와 raw digest,
journal/witness replay, corpus/source identity를 기존 proposal core로 다시 검증한다.

## 3. 위협과 통제

| 위협 | 통제 |
| --- | --- |
| caller가 승인자·시간·비용·모델·capacity·reason을 위조 | strict 4 KiB body는 세 digest, 서버가 산출한 preview binding digest와 고정 confirmation만 허용; reason을 포함한 나머지는 서버 상수·session·DB clock |
| GET preview와 POST 사이 배포/source/비용 계약 변경 | POST가 exact bytes를 다시 읽고 environment, deployment id, commit SHA, 세 digest, 비용·capacity·TTL의 canonical binding digest를 재계산; 같은 commit/source라도 deployment가 다르거나 caller binding이 다르면 transaction 전 409 |
| production 또는 미식별 배포 승인 | `RAILWAY_ENVIRONMENT_NAME=staging`, full commit SHA, deployment id가 없으면 fail-closed |
| 두 운영자가 동시 승인해 stage/audit 중복 | transaction advisory lock 뒤 existing row 재검사; exact same actor/runtime replay만 idempotent |
| generic admin helper의 audit/stage 원자성 분리 | 전용 짧은 transaction 안에서 audit write와 stage insert를 함께 수행 |
| audit만 남거나 stage만 남음 | stage FK + 같은 transaction; 어느 insert든 실패하면 전체 rollback |
| SQL로 provenance 변경·삭제 | BEFORE trigger가 provenance와 DB-owned 시각을 immutable하게 하고 DELETE를 거부 |
| app-role이 exact public metadata와 임의 64-hex `entryHash`로 audit+stage 직접 INSERT | DB는 구조만 검사한다. writer create/replay와 reserve/consume authority가 같은 helper로 linked audit의 signed payload HMAC, signed metadata↔stage 결속, non-null `previousHash`의 실제 선행 행 존재를 재검증하며 실패는 `stage_authorization_invalid` |
| 거대한 audit chain으로 reserve/consume memory·lock 시간을 무한 증가 또는 unrelated audit writer를 정체 | authority는 stage-linked 행과 그 행이 가리키는 선행 hash 최대 2행만 읽고 global chain scan/table SHARE lock을 하지 않는다 |
| migration이 출처 불명 기존 행을 추측 backfill | 컬럼 추가 전 기존 stage 한 행이라도 있으면 migration abort; seed 없음 |
| 만료된 승인을 서비스가 재사용 | reserve/consume이 DB clock, exact runtime facts, stage expiry를 재검증 |
| 서비스 검사 우회 직접 reservation/consume | DB trigger가 stage approval expiry와 고정 contract를 다시 검사. application reserve/consume은 audit HMAC을 별도로 재검증해 위조 stage가 provider 경계로 진행하지 못하게 한다 |
| model registry 또는 pricing drift | transaction에서 registry SHARE lock 후 exact execution contract 재검증 |
| symlink/path traversal 또는 거대 파일 | import-closure로 검증되는 186개 고정 path allowlist, fd open/fstat, symlink component 거부, bounded read/post-fstat, 파일당 8 MiB 및 전체 16 MiB cap |
| 보안 의존성 source drift 누락 | admin route/reservation/shadow execution/proxy root의 local runtime import 폐쇄를 TypeScript 실제 module resolution과 workspace exports로 재계산하고 TS↔SQL ordered path equality를 강제; type-only만 제외하며 aliased require/module.require/createRequire를 추적한다. `node:module`/`module`의 named·default·namespace `createRequire`는 지원하되 runtime re-export, dynamic namespace, 반환 namespace 직접 체이닝과 다른 module namespace surface는 거부한다. 현재 폐쇄에서 필요한 `process.env`, 직접 `process.cwd()`, 고정 operational state의 정확한 초기화와 Map `get`/`set`, `lib/prisma.ts`의 정확한 `globalForPrisma.prisma` singleton 필드, 검증된 `Reflect.apply` 캡처만 safe form으로 인정한다. Node `global`의 다른 직접·별칭 사용과 constructor/`__proto__`/임의 `prototype` chain, 열거된 Reflect/module/process/globalThis/eval/Function non-literal·간접 loader, unresolved local import를 거부한다. non-static element access는 기본 거부하고 현재 실행 폐쇄의 검토된 데이터 인덱싱만 path·line·column·정확한 source text의 정렬된 SHA-256 snapshot으로 동결한다. 접근의 추가·이동·표현 변경은 snapshot 불일치로 fail-closed하며, 갱신 전 loader/capability escape 여부를 별도 검토하고 negative fixture를 보강한다. 이 snapshot은 검토된 예외의 완전한 구조 목록이지 임의 JavaScript reflection 의미론의 증명이 아니다. snapshot 안의 `value[key]`를 유지한 채 다른 위치의 `key` binding 의미만 바꾸는 residual은 승인된 exact source-file bytes, full commit SHA와 deployment ID의 결속 및 독립 source review로 통제한다. |
| prompt/credential/provider error가 provenance에 유입 | manifest schema는 path/size/hash와 고정 실행 숫자만 허용; audit reason은 request가 아니라 서버 내부 상수 |
| 승인 endpoint 탐색·CSRF·탈취 session | 비관리자 404, owner-only, recent authentication, global origin guard, DB atomic rate limit |
| stage 행 존재가 provider 실행으로 오인 | execution manifest 및 response에서 두 readiness boolean이 false; 새 adapter/caller 없음 |

## 4. 잔여 위험

- DB trigger 자체는 HMAC secret을 알지 못하므로 hash shape만 검사한다. cryptographic
  authorization owner는 application writer create/replay와 reserve/consume의 공용 helper다.
- DB superuser는 trigger를 비활성화하거나 application secret을 탈취할 수 있다. DB integration은
  trigger 비활성화를 오직 expiry fixture를 만드는 데 쓰며, production 운영 권한 분리는 별도
  인프라 통제다.
- exact checkout bytes는 build artifact와 application source의 동일성을 보여 주지만,
  설치된 `node_modules`, package registry 응답, container image attestation까지 증명하지 않는다.
- Railway 환경 변수는 플랫폼 control plane의 진실성에 의존한다. 이 회차는 Railway API를
  호출하거나 deployment attestation을 별도로 검증하지 않는다.
- 승인 행의 보존 기간은 보안·법무 확정 전 `TBD-security-retention-schedule`이다. 권한 TTL
  60분과 감사 증거 retention은 서로 다른 개념이다.
- 이 writer는 actual dispatch를 열지 않으므로 provider 실패, 품질, 의미 보존과 행동상
  injection resistance에 대한 새 증거를 만들지 않는다.
