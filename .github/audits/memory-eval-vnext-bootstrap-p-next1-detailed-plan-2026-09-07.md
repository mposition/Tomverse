# memory-eval vNext — NEXT-1 bootstrap·P 파일별 상세 준비안

**Author:** Codex
**Date:** 2026-09-07
**Status:** Draft — DRAFT_DECISIONS_PENDING_NOT_IMPLEMENTATION_AUTHORIZATION
**Reviewers:** 이 신규 상세안은 독립 검토·사람 정책 승인 전
**Document ID:** MEM-EVAL-VNEXT-BOOTSTRAP-P-NEXT1-1

## Context — 검토된 준비 범위를 상세화하는 단계

사용자의 “네 작성해주세요”에 따라 R의 NEXT-1을 상세화한다. 추가 응답에서 보유했다고 알려준
Railway, Prisma Postgres DB, GitHub Repository, 로컬은 **자원 존재에 대한 사용자 보고**다.
전용 격리 host, 서로 독립된 보관소 두 곳, 별도 key backup이 이미 있다는 답으로 해석하지 않는다.
제품/plan/관리자/계정·접근 경계는 미검증이고 서비스 생성·구매·배포 권한도 받지 않았다.

이것은 기존 계약의 실행 설계 **후보**와 결정 자료다. S3/S4/D 새 wire, 승인 receipt, 최종 P의
exact closure가 아니다. 아래 MUST는 준비 문서가 지킬 조건이며 상위 운영 계약을 바꾸지 않는다.
사람 정책 선택·별도 offline 구현 승인·실제 bootstrap 운영 승인은 각각 남아 있다.

### 고정 identity와 검토 범위

- 현재 branch: codex/memory-eval-vnext-bootstrap-p-scope.
- 검토된 준비 commit R: 2a13acea05805f18528a205d5caeba37f0d800c9.
- 관측한 develop B: 48df8e428061003115aad8d66c27fd1dddd56f7a; R의 유일 parent다.
- R은 로컬 commit이며 develop에 포함되지 않았다. 이 상세화는 R을 읽은 문서 작업이지 R의
  병합·CI 완료나 최종 P 채택을 선언하는 작업이 아니다. 이번에는 branch/ref를 바꾸지 않았다.
- R 원문 두 파일은 보존한다. MD raw SHA-256:
  94c89bef7de4adeecbbea23504a1b684db2bf3384abf894ef43389e29d0ece91.
  JSON raw SHA-256:
  cbd11a79cbc945ef556aeaadd321857dce606d3edeb4960fce2d3d865ad6f893.
- R 최초 검토: PASS_WITH_WARNINGS. 사용자 제공 보고서 raw SHA-256:
  7f8c4e8c2745f715e17f93a455b65abbd29eb60a4e7a266639d24888668db00d.
  이 hash는 **검토 보고서만** 식별한다. 이 상세안의 승인 hash가 아니다.

상위 18개 source의 commit/path/raw SHA-256, R 두 파일, 저장소 보조 파일 identity는
[동반 계획 JSON](evidence/memory-eval-vnext-bootstrap-p-next1-plan-2026-09-07.json)에 기록한다.
S1–S4/A/CA/D/K/H 원문과 승인 receipt는 그대로이고 decision §13 공란을 채우지 않는다.
A=3f14afb29eddc243640fdb0a5a4f604646ade9f0, CA=80842e62925c05af9450e6acc6ceb70b56f67655,
D=159267a80acee97da3a297c637343ea15de725f9, K=6b2465e921c6e8b99ff032a36be8ada61c0ad599,
H=a19ae39d0da61295eb17e1545c74bc5b7e702c1a는 B/R의 조상이다. R/B/H는 P도 C도 아니다.

### F-1–F-3 반영 — 작성자 반영이며 새 확인 검토 결과가 아님

| Finding | 이 상세안에 반영한 것 | 유지하는 경계 |
|---|---|---|
| F-1 | 하위 측정 verifier 동결을 실제 EnvironmentApproval/ClockPolicy 등록 앞에 명시 | 하위 ExecutionClosure digest ≠ 상위 P digest; key/role 등록은 별도 선행 갈래 |
| F-2 | workflow/controller 호출 script X01–X04를 P-08 실행 closure 후보로 분류 | audit/check라는 이름이나 scripts/ 경로로 제외하지 않음 |
| F-3 | 아래 codeProbe는 HEAD 대신 고정 B 40자 SHA로 재실행 | R JSON의 과거 관측 bytes는 수정하지 않음 |

로컬 PC의 PowerShell, H:\Project\ai-chat-hub 저장소 안. Git만 필요하고 production 자격증명 없이 되는 읽기 전용 검색이다.

```powershell
git grep -n -E 'ProtocolImplementation|ApprovedTrustRoot|mem-provenance-checkpoint-1|mem-signature-receipt-1|mem-sealed-object-1' 48df8e428061003115aad8d66c27fd1dddd56f7a -- lib scripts tests .github/workflows
```

이번 재실행은 exit 1, match 0건이었다. token 검색 부재만 말하며 이름이 다른 구현/외부 P가
없다는 증명은 아니다. 최초 검토의 untracked 개수 표현은 계수상 오기다. 이번 시작 상태는
14항목(일반 파일 12개 + .claude/ + .codex/)이며 보고서의 판정이나 원본은 고치지 않는다.
검토자가 재계산하지 않은 historical 122 closure/1,150 case/여섯 digest를 이번에 새로
전수 재계산했다고 주장하지 않는다. 후보 경로와 동결 목록의 교집합 검사는 별개다.

## Functional Requirements — 상세안의 요구

- FR-1: R/B/상위 승인 bytes와 F-1–F-3 반영 근거를 MUST 결속하고 새 승인으로 승격해서는 MUST NOT 된다.
- FR-2: 하위 verifier 동결·실제 정책 등록·최종 P 채택의 부분 선후를 MUST 분리한다.
- FR-3: 미래 파일마다 책임·runtime/test 소속·시험·dependency/side effect·미정 조건을 MUST 기록한다.
- FR-4: 보유 자원의 관측/공식 문서/작성자 후보/사람 미정 결정을 MUST 구별한다.
- FR-5: D proof 공백과 기존 승인 잔여를 MUST 보존하고 구현·운영 권한을 자동 확대해서는 MUST NOT 된다.
- FR-6: 첫 offline 구현 승인 후보와 최종 P 완료·운영 인수 조건을 MUST 구분한다.

### 1. 생성 순서와 결정 시점 (FR-2)

아래는 실행 명령이 아니라 의존성이다. 현재 완료한 것은 상세 **준비 문서 작성**뿐이다.

1. 별도 offline 구현 범위를 승인받고 해당 구현·합성 시험을 수행한다.
2. 선택된 environment/clock 측정 verifier의 **하위 ExecutionClosure**와 실제 dependency bytes를
   동결한다. 하위 closure는 자기 policy/approval/상위 ProtocolImplementation digest를 포함하지 않는다.
3. 실제 사람 key/role 등록은 별도 운영 권한으로 준비한다. 이 갈래와 2번의 개발을 구분하며
   “모든 code 이전에 모든 정책 등록”을 요구하지 않는다. 과거 승인에 서명을 소급하지 않는다.
4. 동결된 하위 verifier digest와 실제 key/role 등록을 전제로 사람이 EnvironmentApproval과
   ClockPolicy를 승인·등록한다. source/측정 방식이 미정이면 2번의 최종 하위 동결도 미완료다.
5. 실제 등록 원문·D/K를 결속해 trustPolicyDigest를 확정한다.
6. 하위 verifier 파일/dependency를 포함한 **전체 P** 구현·전수 검증·검토·사람 판정을 완료하고
   최종 P를 채택한다. 4–5번 이전에 최종 채택을 완료했다고 부르지 않는다.
7. ProtocolImplementation → ProtocolDescriptor → GenesisRecord → encrypted payload →
   genesis event/signature → 해당 prefix의 Git mirror commit → signed Checkpoint →
   별도 사람 ApprovedTrustRoot 외부 등록 순서를 따른다.

Policy 승인은 body에서 계약이 지정한 approval field를 제외한 digest를 대상으로 한다.
완성 policy digest·승인 대상 digest·하위 verifier digest·P digest를 같은 값처럼 쓰지 않는다.
ProtocolDescriptor.specifications는 S3/S4 snapshot만이다. D/K는 등록 원문과 trustPolicyDigest
경로로 결속하며 descriptor 필드를 넓히지 않는다.

**불완전 P로 genesis를 먼저 만들고 같은 descriptor 아래 dispatch/importer를 나중에 추가하는
계획은 금지한다.** genesis 이후 P 변경은 별도 migration 계약·검토·사람 승인 대상이고 기존
소비 이력을 새 ledger로 초기화하지 않는다. bootstrap grant는 별도 사전 사람 승인의
protocol receipt/evidence 암호화·복구 검증만 허용하며 holdout/provider/review 권한은 없다.

### 2. 구체 파일별 후보 — 아직 생성하지 않음 (FR-3)

총 **47개 경로 후보**: P 실행 후보 34개, 비운영 시험·fixture·감사 도구 13개.
package.json 하나만 기존 파일 변경 후보이고 나머지는 신규 경로 후보다.
R에서 신규 후보의 부재와 historical 122/forward frozen 109 목록 교집합을 검사한다.
경로 교집합은 0개다. **최종 import closure 완전성이나 동결 목록 전체 재계산 결과는 아니다.**

JSON.candidateFiles는 각 행의 신규/변경 구분·sideEffect·blockedBy·dependsOn·testIds를
같은 ID에 결속한다. dependsOn은 설계상 책임 의존성 제안이지 실제 import graph를 측정한
결과가 아니다. P-01–P-10의 상위 원문 대응은 JSON.unitSources와 R의 동일 ID를 따른다.
실제 플랫폼 adapter/helper/schema가 추가로 필요하면 exact 경로와 권한을 다시 확정한다.
디렉터리/wildcard로 미래 추가 파일을 자동 허용하지 않는다.

| File ID / unit | 정확한 미래 경로 후보 | 소유할 책임 | 시험 대응 |
|---|---|---|---|
| C01 / P-01 | lib/memoryEvalVnext/protocol/canonicalJson.ts | mem-cjson-1 exact bytes·domain digest | T01 |
| C02 / P-01 | lib/memoryEvalVnext/protocol/wire.ts | S3/S4/D closed record decoding·shape/field 검사 | T01 |
| C03 / P-01 | lib/memoryEvalVnext/protocol/signatures.ts | PureEd25519 bytes/role-purpose/epoch 검증; 운영 signer 아님 | T01 |
| C04 / P-01 | lib/memoryEvalVnext/protocol/trust.ts | 등록 원문·D/K binding·trustPolicyDigest·폐기 이력 검증 | T01, T02 |
| C05 / P-02 | lib/memoryEvalVnext/history/gitGraph.ts | 전 parent DAG·shallow/replace/graft·경로 이력 불변 검사 | T02 |
| C06 / P-02 | lib/memoryEvalVnext/history/protection.ts | closed protection snapshot·bypass·ref 포함 검증; fetch 분리 | T02 |
| C07 / P-02 | lib/memoryEvalVnext/history/trustRoot.ts | 외부 ApprovedTrustRoot·mirror·latest checkpoint 결속 | T02 |
| C08 / P-03 | lib/memoryEvalVnext/controller/stateMachine.ts | genesis부터 seal/open/recovery/review/consumption/invalidation까지 전 event 전이 | T03, T09 |
| C09 / P-03 | lib/memoryEvalVnext/controller/journal.ts | 단일 writer·durable append·lock/fencing·rollback 거부 | T03 |
| C10 / P-03 | lib/memoryEvalVnext/controller/checkpoint.ts | durable prefix→Git mirror commit→controller signature/checkpoint 순서 | T03 |
| C11 / P-03 | lib/memoryEvalVnext/controller/service.ts | 인증 client·custodian 사전 검증·dispatch/opening/recovery orchestration | T03, T06, T09 |
| C12 / P-04 | lib/memoryEvalVnext/custody/sealedObject.ts | AES-256-GCM exact header/AAD·tag 검증 후에만 plaintext 반환 | T04 |
| C13 / P-04 | lib/memoryEvalVnext/custody/keyLifecycle.ts | fresh key allocation/start durable·crash burn·snapshot/seed 재사용 거부 | T04 |
| C14 / P-04 | lib/memoryEvalVnext/custody/grants.ts | bootstrap 제한·journal authority·scope/session/30분·사전 custodian gate | T04, T05 |
| C15 / P-04 | lib/memoryEvalVnext/custody/retention.ts | 독립 cipher store 2곳·분리 key backup·실제 복구 증거 결속 | T04 |
| C16 / P-05 | lib/memoryEvalVnext/environment/verifyEnvironment.ts | 외부 measurement·image/supervisor·session/scope·attester 검증 하위 closure | T05 |
| C17 / P-05 | lib/memoryEvalVnext/environment/verifyClock.ts | 인증 UTC 원 측정·보수 오차 구간·cutoff 하위 closure | T05 |
| C18 / P-05 | lib/memoryEvalVnext/environment/sessionSupervisor.ts | worker 밖 측정·설치 선행·volatile/egress/output 차단·cleanup | T05 |
| C19 / P-06 | lib/memoryEvalVnext/dispatch/authorization.ts | 서명 승인·예산·ordinal·clock·미소비·ref/closure dispatch 적격 검사 | T06 |
| C20 / P-06 | lib/memoryEvalVnext/dispatch/githubTransport.ts | approved API 요청·pagination/capture·인증 controller client·재전송 금지 | T06 |
| C21 / P-06 | lib/memoryEvalVnext/dispatch/attemptClosure.ts | run/attempt 전수 수집·late/duplicate/no-contact·unknown 폐쇄 판정 | T06 |
| C22 / P-07 | lib/memoryEvalVnext/importer/runImport.ts | artifact bridge·subject hash·spend unknown·technical closure·offline import | T07 |
| C23 / P-07 | lib/memoryEvalVnext/importer/invalidation.ts | 후발 증거·영구 소비·최신 invalidation·ordinal 2 조건 | T07, T09 |
| C24 / P-09 | lib/memoryEvalVnext/s2Evidence/proofs.ts | D 15 role/4 proof kind·native A/V graph·V register·checker replay | T08 |
| C25 / P-09 | lib/memoryEvalVnext/s2Evidence/sourceEvidence.ts | leaf→proof→source receipt·importer서명 검증·미래 순환 금지 | T08 |
| C26 / P-09 | lib/memoryEvalVnext/s2Evidence/activation.ts | K<activationApprovalCommit<C·exact scope/digests·detached inclusion 검증; writer 아님 | T08 |
| C27 / P-07 | lib/memoryEvalVnext/s3Verifier.ts | S3 5개 순수 API·S1 exact review 타입·seal/open/recovery/materialisation 검증 | T09 |
| C28 / P-07 | lib/memoryEvalVnext/provenanceVerifier.ts | S4 verifyHistory/importRun 순수 facade·latest trusted context만 발급 | T02, T07, T08, T09 |
| X01 / P-08 | scripts/memory-eval-vnext/controller.mjs | controller service 기동 | T03, T10 |
| X02 / P-08 | scripts/memory-eval-vnext/worker.mjs | 서명 key 없는 인증 worker·전용 workflow entrypoint | T05, T06, T10 |
| X03 / P-08 | scripts/memory-eval-vnext/import-source.mjs | D proof 검증·승인된 importer custody interface 호출 | T08, T10 |
| X04 / P-08 | scripts/memory-eval-vnext/verify-history.mjs | workflow/controller가 사용하는 read-only verifier entrypoint | T02, T10 |
| X05 / P-08 | .github/workflows/memory-eval-vnext-decision-grade.yml | S4 전용 workflow·full action SHA·attested runner·default no dispatch | T06, T10 |
| X06 / P-08 | package.json | P 전용 script 후보 별도 승인; 기존 script/deps 변경·lock 자동확장 없음 | T10 |

C27은 S3의 verifySeal/planOpening/verifyReview/verifyRecovery/verifyMaterialisation 전부를
계획하고 C08은 관련 event 전이를 빠뜨리지 않는다. C28은 S4 verifyHistory/importRun 경계다.
S1의 exact review 타입·이미 승인된 규칙에 대한 검증과 scorer F 구현을 혼동하지 않는다.
후속 설계에서 scorer/validator 연결이 필요한 부분은 고정된 증거/binding 경계를 확인해야 한다.
미래 F/E 코드를 지금 import하거나 임의 callback/plugin을 신뢰해 P 완전성을 주장하지 않는다.
연결 경계가 원문으로 결정되지 않으면 해당 부분과 최종 P 동결을 보류한다.

X01–X04는 실제 실행 진입점이므로 읽기 전용인 X04도 **P-08 closure**다. X05의 transitive
action/runtime과 실제 읽는 schema/config/fixture도 포함한다. C16/C17 하위 closure는 필요한
C01–C03 등의 전이 dependency까지 포함하되 정책 자체/상위 P를 import하지 않도록 분리해야 한다.
C18의 OS supervisor와 journal/key/store 실제 adapter는 환경 선택 전 완성됐다고 부를 수 없다.

| File ID / unit | 정확한 미래 경로 후보 | 비운영 책임 | 시험 대응 |
|---|---|---|---|
| T01 / P-10 | tests/memoryEvalVnextWire.test.mjs | canonical/closed shape/domain/Ed25519 negative vectors | 시험 파일 자체 |
| T02 / P-10 | tests/memoryEvalVnextHistory.test.mjs | DAG/protection/root/checkpoint trust negatives | 시험 파일 자체 |
| T03 / P-10 | tests/memoryEvalVnextJournal.test.mjs | single-writer/fsync/fencing/crash/whole-event history | 시험 파일 자체 |
| T04 / P-10 | tests/memoryEvalVnextCustody.test.mjs | fresh-key/AEAD/grants/retention/backup recovery | 시험 파일 자체 |
| T05 / P-10 | tests/memoryEvalVnextEnvironment.test.mjs | external measurements/UTC error/window/cleanup | 시험 파일 자체 |
| T06 / P-10 | tests/memoryEvalVnextDispatch.test.mjs | authorization/contact/pagination/late/duplicate attempts | 시험 파일 자체 |
| T07 / P-10 | tests/memoryEvalVnextImporter.test.mjs | artifact/spend/technical closure/latest invalidation | 시험 파일 자체 |
| T08 / P-10 | tests/memoryEvalVnextS2Evidence.test.mjs | D four proof kinds/15 roles/V replay/activation inclusion | 시험 파일 자체 |
| T09 / P-10 | tests/memoryEvalVnextS3Verifier.test.mjs | S3 five APIs/S1 review bindings/ordinal separation | 시험 파일 자체 |
| T10 / P-10 | tests/memoryEvalVnextClosure.test.mjs | actual imports/actions/runtime/files/test discovery | 시험 파일 자체 |
| T11 / P-10 | tests/fixtures/memory-eval-vnext/wire-vectors.json | 합성 public conformance vectors; 실제 승인/holdout/운영 key 없음 | T01 |
| T12 / P-10 | tests/fixtures/memory-eval-vnext/history-scenarios.json | 합성 graph/event/crash scenario와 정답 | T02, T03, T04, T05, T06, T07, T08, T09 |
| T13 / P-10 | scripts/memory-eval-vnext/audit-closure.mjs | 개발 시 inventory 비교 전용; controller/workflow 호출하면 P-08로 편입 후 재동결 | T10 |

저장소의 scripts/run-unit-tests.mjs는 tests/를 비재귀 탐색해 루트의 .test.mjs/.test.ts를
수집한다. 따라서 시험은 위처럼 루트에 두고 fixture만 하위에 둔다. R의 tests/memoryEvalVnext/
가족명을 그대로 실체화하면 현재 test:unit에서 누락된다. runner 변경은 제안하지 않는다.
T13 또는 시험 fixture를 나중에 controller/workflow가 읽으면 P-08/runtime closure로 편입해
최종 동결 전에 검증한다. 운영에서 읽지 않는 시험만 P-10으로 제외할 수 있다.

### 3. HD-1–HD-8: 자원별 후보와 남은 판정 (FR-4)

| 사용자 보고 자원 | 이번에 확인한 것 | 검토할 용도 후보 | 자동으로 충족하지 않는 것 |
|---|---|---|---|
| Railway | 보유 보고 + 공식 volume backup 문서 | 전용 controller/암호문 store 배치 가능성 조사 | 외부 attestation, volatile plaintext 격리, 독립 custodian, 독립 backup 2곳 |
| Prisma Postgres DB | 보유 보고; 관리형 Prisma Postgres인지 ORM+다른 Postgres인지 미확인 | 격리된 저장 adapter 적합성 조사 | S4 journal durability/fencing/rollback 증명, key vault, 별도 custody |
| GitHub Repository | 현재 source/ref·보호 summary 읽기 | source DAG, protected mirror, 읽기 API | 외부 독립 root, 영구 raw leaf 보관, 무우회 강제 정책 |
| 로컬 | 현재 문서/검사 실행 환경 | 문서·합성 offline 시험; 분리된 복구 보관 가능성 조사 | 전용 ephemeral host, 독립 물리 보관소, 별도 key backup |

Railway 공식 문서는 volume 삭제 시 backup도 삭제되고 복원은 같은 project/environment에서
수행된다고 명시한다. 따라서 자체 backup 두 개를 독립 보관소 둘로 세지 않는 것이 이 문서의
설계 판단이다. [Railway Backups](https://docs.railway.com/volumes/backups)

관리형 Prisma Postgres 문서는 snapshot과 수동 pg_dump를 설명하지만 사용자 DB 제품/plan은
미확인이다. 이 기능을 이미 사용 중이라고 기록하거나 DB snapshot을 S3 cipher/key 분리 복구
증거로 대용하지 않는다. [Prisma Postgres Backups](https://www.prisma.io/docs/postgres/database/backups)

Node 22 crypto의 Ed25519 검증(null algorithm)과 AES-GCM은 primitive 후보로만 검토했다.
GCM은 final 인증 성공 전의 plaintext를 외부에 내보내면 안 된다. 현재 로컬 Node 22.22.2와
공식 22.x 문서를 읽었다는 사실은 P runtime/image/dependency 동결이 아니다. 새 dependency,
실제 key 생성, 암호화는 하지 않았다. [Node 22 crypto](https://nodejs.org/docs/latest-v22.x/api/crypto.html)

2026-09-07T12:41:12.192Z 읽기 전용 GitHub 관측에서 develop=B, protected=true였고 classic
protection의 enforce_admins=false, required_linear_history=false, force push/deletion=false,
required approving review count=0이었다. required checks는 다음 두 이름이었다.

- Security, unit, build, and Chromium smoke tests
- Admin Console E2E (PostgreSQL)

effective rules 첫 페이지는 0개였으나 전체 pagination 완전성은 인증하지 않았다.
원 HTTP capture를 S4 ApiCapture로 보존하지 않았으므로 JSON의 응답 hash/요약을 ProtectionPolicy
증거로 채택하지 않는다. CI green이나 protected=true만으로 HD-2를 승인하지 않는다.
SHA 보존 merge 요구를 linear history/squash/rebase로 바꾸지 않으며 설정 변경은 하지 않았다.

### HD-1: 실제 signer·role·key·epoch 및 등록/폐기 운영

선택: **pending / null**. 작성자 권고: 역할별 key를 분리하는 후보부터 검토. 기존 승인자 mposition을 미래 모든 signer로 자동 배정하지 않음.

- 후보 A: 역할별 분리 key/자격증명과 가능한 독립 관리 경계
- 후보 B: 동일인 다역 운영 + 분리 key/통제 및 단일 관리자 잔여 공개; 독립성 입증 없으면 운영 보류
- 에이전트가 준비할 근거: 역할·purpose·signer·keyId/public key·trustEpoch·유효/폐기 정책 대응표; 실제 key 생성/보관/복구 경로와 등록 원문의 D/K 결속; controller key가 runner에 없고 custodian이 사전 검증한다는 접근 경계.
- 사람이 결정할 것: 실제 담당자와 독립성 한계, key 보관/생성 경로, 유효기간·epoch·등록/폐기 정책.
- 미정일 때 차단: 실제 TrustAnchor 등록 및 운영 서명.

### HD-2: ProtectionPolicy·bypassDisclosure

선택: **pending / null**. 작성자 권고: 현재 보호 상태를 적합으로 선언하지 말고 전체 snapshot/우회 경로를 수집한 뒤 사람이 유지 또는 강화 결정.

- 후보 A: 현 설정의 정확한 snapshot·관리자 우회 한계를 공개하고 승인 심사
- 후보 B: 별도 권한으로 보호/우회 조건을 강화한 뒤 새 snapshot 승인
- 에이전트가 준비할 근거: classic protection + effective rules 전체 페이지 + bypass/actor 권한의 비밀 없는 원 관측; SHA 보존 merge commit 경로 및 required checks 이름/강제 범위; ProtectionPolicy와 bypassDisclosure exact 결속; 이번 summary는 대체물 아님.
- 사람이 결정할 것: 실제 classic/rules/bypass snapshot과 허용 운영 경계 승인.
- 미정일 때 차단: 보호 정책 고정·신뢰된 genesis/root.

### HD-3: 암호문 2개 독립 보관소·분리 key backup·복구

선택: **pending / null**. 작성자 권고: 암호문 운영 copy·독립 복구 copy·분리 key backup을 세 접근 경계로 설계. 현재 충족 여부 unknown.

- 후보 A: Railway 암호문 보관 후보 + 독립 로컬/offline 보관 후보; 같은 디스크/동일 자격증명/동시 삭제 경로이면 미충족
- 후보 B: 두 외부 독립 보관소 후보 + 별도 key backup; 새 자원 비용/접근 권한은 별도 결정
- 에이전트가 준비할 근거: 두 opaque store ID의 실패/삭제/자격증명/관리 경계 매트릭스; 분리 key backup·복호화 전용 복구 및 fresh key allocator rollback 방지 시험; 보존 기간/폐기 정책, 실제 object 두 copy 복원 raw hash 증거; 기존 자원 자동 지정 없음.
- 사람이 결정할 것: 실제 보관 대상/운영자/보존 기간·복구 경계 승인.
- 미정일 때 차단: 실제 key custody·RetentionProof·폐기/복구 운영.

### HD-4: 중앙 journal·controller·독립 custodian/credential 발급

선택: **pending / null**. 작성자 권고: 전용 journal/controller와 독립 custodian 경계를 우선 설계. 기존 앱/production DB를 재사용하지 않음.

- 후보 A: 전용 호스트의 durable append journal + 독립 custodian/외부 checkpoint 보관 후보
- 후보 B: Prisma/Postgres 기반 저장 후보의 계약 적합성부터 조사; 트랜잭션을 S4 fsync/fencing 증명으로 자동 간주하지 않음
- 에이전트가 준비할 근거: single-writer/append/fsync/fencing/crash-after-commit/rollback 정답표; controller와 custodian의 자격증명·grant 승인 경로 및 runner 부재 확인; DB 실제 제품/직접접속/권한/복구모드/독립 checkpoint; 계약 변경 필요하면 별도 중단.
- 사람이 결정할 것: 실제 배치·관리 경계·독립 checkpoint 저장·발급 우회 차단 정책.
- 미정일 때 차단: live journal·controller signing·credential/key grant.

### HD-5: 비공개 실행·review session 환경

선택: **pending / null**. 작성자 권고: 로컬은 문서/합성 시험에 한정. 실제 plaintext 호스트는 외부 attestation과 ephemeral 격리 조건을 입증하기 전 선택하지 않음.

- 후보 A: 별도 전용 self-hosted ephemeral 실행 및 비실행 review 환경 후보
- 후보 B: 보유 Railway/로컬의 격리·supervisor 권한 가능성을 읽기 전용으로 조사; 이름/runner label만으로 채택하지 않음
- 에이전트가 준비할 근거: 승인할 image/supervisor/measurement verifier closure와 attester 신뢰 경로; 외부 측정·egress/volatile/swap/dump/telemetry/output 제한·key 이전 설치 완료; session/scope/challenge nonce/30분 유효·cleanup·관리자 잔여 원 증거.
- 사람이 결정할 것: EnvironmentApproval의 실제 환경·policy·attester 및 관리자 잔여 승인.
- 미정일 때 차단: 실제 plaintext 처리·attestation·grant.

### HD-6: 인증된 UTC source·ClockPolicy

선택: **pending / null**. 작성자 권고: 인증 UTC source와 monotonic 측정 정책을 함께 고정하는 후보를 조사. 소스/라이브러리/서비스는 아직 미선정.

- 후보 A: 인증된 UTC 원 proof를 재검증 가능한 source/측정 구현 후보
- 후보 B: 보유 환경이 원 proof·정확도·인증 경로를 제공하지 못하면 다른 source 조사 또는 운영 보류
- 에이전트가 준비할 근거: source identity/trust chain 또는 public key/측정 원 bytes·verifier 하위 closure; RTT/age/source error/drift 상한의 근거와 전체 유효기간의 보수 오차 구간; wall jump·B=5000/5001·30초 cutoff 경계 시험; HTTP Date/local clock 대용 금지.
- 사람이 결정할 것: 실제 source·인증 경로·측정 policy/구현 및 drift 상한 승인.
- 미정일 때 차단: 유효시간·cutoff·grant/dispatch 운영 판정.

### HD-7: P 구현 exact scope·dependency closure·검증 권한

선택: **pending / null**. 작성자 권고: 첫 구현 승인 후보는 C01–C04/T01/T11의 합성 순수 core로 한정. 이것은 최종 P도 실제 등록도 아님.

- 후보 A: 6개 파일의 offline 순수 core와 합성 시험만 별도 승인 후 구현
- 후보 B: HD-1–HD-6/HD-8 및 외부 dependency/adapter 계획까지 확정한 뒤 더 큰 범위를 별도 승인
- 에이전트가 준비할 근거: 정확한 파일 47개 후보의 책임/side effect/시험/선행 관계와 실제 승인 subset; 승인 subset 전체 상위 AC 매핑·strict error/known-vector 정답, 실제 key가 아닌 합성 시료; 향후 import graph/runtime/action/image/supervisor/dependency integrity; package/lock 변경 별도 allowlist.
- 사람이 결정할 것: 별도 offline 구현/시험 범위와 이후 실제 bootstrap 운영 권한을 각각 결정.
- 미정일 때 차단: 코드/테스트/workflow 작성 및 최종 P 동결.

### HD-8: D N-1/N-3의 실제 실행 증명 공백

선택: **pending / null**. 작성자 권고: D N-1/N-3을 unresolved로 유지하고 입증 가능성부터 확인. 새 proof field나 importer-attest 예외를 만들지 않음.

- 후보 A: 계약을 유지하면서 비밀 없는 요청 version 관측·독립 network 차단 원 증거를 확보 가능한지 조사
- 후보 B: 확보 불가 또는 의미 변경이 필요하면 실행 중단 후 별도 계약/권한 범위 요청
- 에이전트가 준비할 근거: ApiCapture 응답 header와 구분되는 요청 version 사실; N-1 해소를 임의 선언하지 않음; ReplayEnvironment 세 값 외의 독립 차단 사실 가능성; 새 D EnvironmentAttestation 채택 금지; V exact script/원 register/native graph/8개 rule 전부 OK, 기존 D 확인 검토 1/1 소진 유지.
- 사람이 결정할 것: 필수 조건을 입증하지 못하거나 계약 의미 변경이 필요하면 별도 범위 결정.
- 미정일 때 차단: source receipt 발급·activation 실행 판정.

### 4. 첫 offline 구현 후보와 최종 P 인수 조건 (FR-6)

다음 **별도 구현 승인 후보**는 C01–C04, T01, T11의 6개 정확한 파일뿐이다.
mem-cjson-1/closed wire/signature 검증/등록 이력 검증의 순수 core와 합성 public test vector를
대상으로 하고 DB·GitHub network·실제 key·운영 서명·trust 등록·workflow는 제외한다.
합성 key/서명은 테스트 시료일 뿐 운영 receipt가 아니다. 그 시험 코드도 이번에는 만들지 않는다.

HD-1의 실제 담당자나 HD-5/6의 실환경이 미정이어도 이미 승인된 형식의 순수 검증 로직을
합성 시료로 검토할 수 있다는 **범위 분리 제안**이다. 미정 정책의 실제 값/의미를 추정한
분기는 구현하지 않는다. C04의 운영 채택에는 실제 HD-1이 여전히 필요하다.
subset에 해당하는 상위 계약 전수 AC·음성 시료 대응과 exact 권한을 승인 전에 확정한다.

전체 P 채택에는 나머지 runtime·adapter·workflow와 모든 S3/S4/D 관련 AC가 필요하다.
후속 package script 추가는 P 별도 승인 대상이고 H의 S2 resolver 9개 허용 제안으로 승인받은
것처럼 사용하지 않는다. dependency가 필요하면 package-lock.json/tsconfig/외부 runtime 등
**추가 exact 변경 목록과 hash 계획**을 다시 제시한다. 현재 lockfile 변경 권한은 없다.
실제 실행에 기존 파일이 필요하면 변경하지 않아도 closure에 bytes를 포함한다.
현재 47개 후보를 완성된 ProtocolImplementation.repositoryFiles로 복사하지 않는다.

## Non-Functional Requirements — 관측·안전·권한

- NFR-1: 이번 두 문서는 strict UTF-8/BOM 없음/LF/후행 공백 없음이어야 MUST 하며 원 승인 bytes는 보존한다.
- NFR-2: tracked/index 및 기존 untracked는 MUST 보존하고 신규 파일 추가는 아래 두 문서로 한정한다.
- NFR-3: production 연결·비밀 수집·서비스 생성·유료 provider turn은 0이어야 MUST 한다.
- NFR-4: 후보 제품의 문서상 기능과 실제 배치 적합성을 MUST 구별한다. unknown을 성공으로 표시해서는 MUST NOT 된다.
- NFR-5: runtime closure 누락·실제 통제 미증명은 MUST 차단한다. 합성 시험은 실제 운영 입증을 대체하지 않는다.

## API Contracts — 이 준비안은 새 API를 만들지 않음

신규 endpoint/request/response는 N/A다. 기존 S3 S3Verifier의 5개 순수 API와 S4
ProvenanceVerifier.verifyHistory/importRun을 따른다. 실제 I/O/서명/key release/dispatch는
controller/custodian/transport의 side effect로 분리한다. 새 HTTP 계약이나 D proof schema를
추가하지 않는다. 후보 플랫폼의 정확한 API·오류·인증·pagination 계약은 선정 뒤 재확인한다.
이 구획의 N/A를 없애려고 동작하지 않는 endpoint나 가상의 TypeScript interface를 만들지 않는다.

## Data Models — 설명용 계획 색인

| Field | Type | Constraints |
|---|---|---|
| authorization | explanatory object | preparation만 true; decision=pending; approvedBy/approvedAt=null; 구현/운영 false |
| sourceFiles / reviewedPredecessorFiles | identity arrays | 각 commit/path/rawSha256을 함께 대조; 승인 대상 변경 없음 |
| externalReview | scoped report identity | 검토 target은 R만; 새 상세안 독립 검토/승인 false |
| candidateFiles | proposal array | 정확한 경로 47개; 책임·P/test 소속·side effect·dependency·시험·HD 분리 |
| humanDecisionQueue | pending array | HD-1–HD-8, 모든 selectedValue=null; 추천은 사람 결정 아님 |
| resourceReport / protectionObservation | observation objects | 보유/읽기 관측만; 운영 proof/적합 판정 아님 |
| futureOperationalValues | uncreated-value object | 전부 null; 유효한 운영 nullable wire로 전달 금지 |
| validation | local checks object | baseline/추가 후 비교; 구현 시험·독립 replay·운영 인증 아님 |

새 TrustAnchor/EnvironmentApproval/ClockPolicy/SignatureReceipt/RetentionProof/Checkpoint/
ApprovedTrustRoot/ActivationAuthorization/SourceEvidenceReceipt는 생성하지 않는다.
실제 P/closure/self digest/미래 commit도 지어내지 않는다. JSON은 감사용 계획 색인이지
서명할 closed protocol object가 아니다. 신규 DB schema/index/migration도 N/A다.

## Acceptance Criteria — 이 문서의 완료 조건

### AC-1: 원본·판정 범위 결속 (FR-1)

**Given** R 및 상위 18개 source의 고정 identity와 Claude 보고서가 있다.
**When** 신규 문서/JSON과 source bytes·ancestry를 대조한다.
**Then** 원본은 그대로이고 F-1–F-3은 작성자 반영으로만 기록된다. 새 Claude 판정이나 사람 승인은 없다.

### AC-2: 순환 없는 부분 선후 (FR-2)

**Given** environment/clock verifier 하위 구현과 실제 정책은 미정이다.
**When** §1과 JSON.dependencyOrder를 읽는다.
**Then** 하위 동결→실제 정책 등록→trustPolicyDigest→전체 P 채택을 요구하며 자기/미래 digest 순환을 허용하지 않는다.

### AC-3: 파일·실행·시험 소속 (FR-3)

**Given** 47개 후보와 저장소 unit runner의 비재귀 탐색이 있다.
**When** ID·경로·dependency/test 참조·상위 unit·동결 목록 교집합을 검사한다.
**Then** ID/경로가 유일하고 참조가 존재하며 테스트는 루트에서 탐색 가능하다. 실제 호출 script는 P-08이다.

### AC-4: 보유와 적합성 구분 (FR-4)

**Given** 사용자가 네 자원을 보유했다고 보고했지만 실제 접근 경계를 제공하지 않았다.
**When** 자원 표와 HD-1–HD-8을 검토한다.
**Then** 기존 자원을 자동 선정/구매/등록하지 않고 모두 pending/null이다. 사람에게 비밀값이나 준비 시료 작성을 요구하지 않는다.

### AC-5: 잔여·권한 비승격 (FR-5)

**Given** 기존 A/CA/S3S4/D/K 승인에는 조건과 미충족 운영 항목이 남아 있다.
**When** 아래 EC 및 JSON의 residualBoundaries를 읽는다.
**Then** namespace별 조건·D 확인 검토 1/1·proof 공백을 유지하며 15-role/4-kind/8-rule 요건을 바꾸지 않는다.

### AC-6: 첫 subset과 최종 P 분리 (FR-6)

**Given** 첫 offline 후보는 C01–C04/T01/T11이고 나머지 환경/adapter가 미정이다.
**When** 구현 착수 또는 genesis 여부를 결정한다.
**Then** 별도 명시 승인 전 구현은 하지 않으며 부분 코드/검사를 최종 P/운영 readiness로 부르지 않는다.

### AC-7: 실제 변경·기준선 (FR-1, NFR-1, NFR-2, NFR-3)

**Given** 시작 tracked/index clean과 기존 untracked 14항목 목록/일반 파일 hash가 있다.
**When** package scripts, raw bytes, git diff/status를 검사한다.
**Then** 이 두 신규 문서만 추가되고 기존 실패 이름은 동일하다. 운영/코드/dataset/register/flags/기존 승인에는 변경이 없다.

### 미래 구현 시험 대응 — 전부 미실행

아래는 대표 negative/positive 시료 계획이다. 각 T 파일의 상위 AC 전수 전사는 별도 구현 승인 전
보강할 산출물이고 이 표만으로 전수 coverage 완료를 선언하지 않는다. 시료·정답·계산·기록은
에이전트가 준비하고 사람에게 남기는 것은 정책/실제 접근 경계 선택·판정/서명이다.

| Test IDs | Given / When | Then: 미래 기대 결과 | 상위 요구 |
|---|---|---|---|
| T01 | closed record·known vector에 extra/null/domain/role/epoch/서명 변조를 적용 | byte/digest exact만 수용; 잘못된 형식·역할·epoch 거부 | S3 Data Models/§4; S4 Data Models; D AC-1–AC-25 중 관련 항목 |
| T02/T10 | 전체 Git DAG/실행 closure에서 parent·보호·dependency·root 하나를 누락/변조 | trusted context 미발급; shallow/replace/graft/삭제 후 복원·P 불일치 차단 | S4 §1–§2, AC-13/AC-15 |
| T03 | append/fsync/mirror 전후 crash·double writer·fencing rollback·full event history | durable 상태 기준 복구; 존재하지 않는 mirror 참조/중복 서명·불법 전이 거부 | S4 §3/AC-15; S3/S4 승인 N-1 |
| T04 | fresh key 재사용/snapshot 복원·AEAD 변조·한 store/분리 key backup 상실 | 암호화 재시도 key burn·인증 전 plaintext 금지; 실제 복구 미증명 차단 | S3 §4/§4.1, AC-4/AC-9 |
| T05 | 외부 측정 누락/자기 attestation/만료·clock wall jump·B 5000/5001 경계 | 외부 원 proof·정책/closure/session 검증; 보수 시간 창으로 fail closed | S3 AC-12; S4 NFR-5/AC-16 |
| T06 | fake transport에서 불명 dispatch·late/duplicate attempt·no-contact 공백 | 임의 재전송/추가 ordinal 금지; 완전 관측 없으면 폐쇄 미완료 | S4 §4–§5/AC-14/AC-17; S3/S4 승인 N-2 |
| T07/T09 | subject/artifact/hash·review/open/recovery/소비/invalidation 불일치 | 검증 실패와 blocking quality 구분; 소비 복원 금지; review 성공만으로 ordinal 2 불허 | S1 review, S3 5개 API, S4 §6–§8 |
| T08 | D proof 15 role/4 kind의 누락·V register 오용·NOTE·미래 C 순환 | exact V replay 8개 OK 이외 거부; 증거 공백을 서명/hash로 대용하지 않음 | D B-S2-01/B-S2-02/F-1, AC-1–AC-25 |

### 로컬 문서 검사 기록

작성 전 R tracked/index clean 기준선에서 package scripts 6개가 통과했다:
check:encoding:strict, check:policy-section-references, check:release-records,
check:memory-eval-succ9, check:memory-extraction-eval, check:memory-eval-freeze.
check:doc-references는 기존 Windows 경로 관련 8건으로 exit 1이었다.

- missing app/layout.tsx 참조: lib\documentLanguage.ts, app\[locale]\layout.tsx,
  scripts\security-regression-check.mjs, tests\e2e\ssr-root-language.spec.ts 네 개.
- unused historical entry: 위 네 파일의 POSIX 경로 각각 → app/layout.tsx 네 개.

추가 후 동일 script를 사용하고 실패는 이름 단위로 대조한다. 결과는 JSON.validation에 기록한다.
audit 경로는 일반 doc-reference scan 제외이므로 source identity·상대 링크·후보/실재 경로
구별은 별도로 확인한다. strict raw UTF-8/LF/whitespace/JSON 대조와 spec validator도 수행한다.
일반 spec validator의 HTTP endpoint 경고는 이 준비 문서에서 N/A다. 점수는 운영 적합성
증거가 아니다. 미래 P 테스트·122 closure 전수 재계산·V 독립 replay를 실행했다고 하지 않는다.

## Edge Cases — 해석으로 요건을 면제하지 않음

- EC-1: A/CA의 P2-N1·C-COORD-1·기존 R-* 잔여 및 S3/S4 승인 N-1/N-2는 그대로 유지한다.
- EC-2: D namespace s2_clarification_confirmation_2026_09_07의 N-1은 ApiCapture 요청 header
  공백이다. 응답 version header를 요청 증명으로 보거나 importer-attest 해석을 채택하지 않는다.
- EC-3: 같은 D N-2의 V=12f83ec2c388a318fe0a79d4f76bd2c0b245dcb1 replay는 원 register,
  native A/V complete Git graph·원 leaves·V package/lock/tsconfig/checker/support를 사용한다.
  exact check:memory-eval-run script와 --artifact=.s2-proof-input/mem-eval-run1.json을 보존하며
  실제 차단 환경에서 8개 rule 전부 OK가 필요하다. exit 0/NOTE/현재 HEAD 검사로 대용하지 않는다.
- EC-4: 같은 D N-3의 ReplayEnvironment 3개 field는 network 차단 증명이 아니다.
  새 D EnvironmentAttestation/proof field를 만들거나 기존 S3 session attestation으로 대용하지 않는다.
  N-1/N-3 입증이 불가하면 source receipt/activation 실행을 멈추고 별도 방향을 요청한다.
- EC-5: D 확인 검토 1/1 소진은 그대로다. 보고서 hash
  52ea1b94d745142eef9347aff9e831e0c8364cc83014ec1773571471d1f14b38은 그 보고서만 식별한다.
  이 상세화는 D 재검토 회차나 새 명확화·예외 승인 요청이 아니다.
- EC-6: legacy run 33953094398/attempt 1/artifact 9966057860의 admissible=true,
  품질 FAIL·workflow failure·pair revoked·ordinal 2 금지는 함께 보존한다.
  proof graph는 leaf→네 kind proof→checker replay/source receipt→seq 2이며 미래 C/checkpoint/
  inclusion hash를 앞 receipt에 되먹이지 않는다. register를 16번째 source role로 추가하지 않는다.
- EC-7: R이 develop 미포함인 상태에서 이 문서 작성과 구현 착수 조건을 혼동하지 않는다.
  실제 후속 구현은 승인된 준비 문서의 SHA 보존 develop 반영·해당 tip CI·원문/ancestry를
  재확인한 뒤 그 tip의 새 codex/ 브랜치에서 별도 지시로 시작한다.
- EC-8: product 기능·dependency·source 조건이 원문과 충돌하면 추정으로 adapter를 작성하지 않는다.
  필요한 새 exact 경로/권한 또는 계약 판단을 요청하며 승인된 bytes를 덮어쓰지 않는다.

## Out of Scope — 전달 후 중단

이번 유일한 추가 allowlist:

- .github/audits/memory-eval-vnext-bootstrap-p-next1-detailed-plan-2026-09-07.md
- .github/audits/evidence/memory-eval-vnext-bootstrap-p-next1-plan-2026-09-07.json

이번에는 다음을 하지 않는다.

- OS-1: P/scorer/resolver/ledger/validator/controller/custodian/importer/workflow/test skeleton 구현.
- OS-2: 실제 key/서명/정책 등록/암호화/retention/root/proof/attestation/운영 journal 생성.
- OS-3: dataset·manifest·register·purpose activation·S2 resolver 허용 제안·승인 원문 변경.
- OS-4: holdout 작성/검수/seal/open·S5/v9 prompt·pair/예산/dispatch/re-run/provider 호출.
- OS-5: production DB·Railway 설정/secrets·GitHub 보호·release gate·memoryExtractionEnabled/
  memoryInjectionEnabled 변경, 자원 구매/서비스 생성.
- OS-6: stage/commit/push/PR/ready/auto-merge/merge/배포/추가 독립 검토 요청.

다음 사람 판단은 후보 범위·정책 선택 또는 별도 offline 구현 승인이다. 운영 readiness/activation
승인이 아니다. 이후에도 OP-TRUST/P-ROOT/CUSTODY/SOURCES/ACTIVATION-APPROVAL/RESOLVER/
C-INCLUSION 7개가 남는다. 실제 승인 계보는 D < K < activationApprovalCommit < C의 strict
순서와 C의 SHA 보존 merge/inclusion을 유지한다. 그 뒤 별도 scorer F 동결→holdout seal→
S5→E/Programme/pair/예산/dispatch 순서이며 어느 단계도 이번에 시작하지 않는다.

spec-driven-workflow는 파일 책임·FR/AC·미정 결정을 연결하는 데 사용했다.
준비 문서 검증까지 진행하고 구현·test extraction 단계로 넘어가지 않는다.
