# memory-eval vNext — bootstrap·control-plane P 준비 범위 초안

**Author:** Codex
**Date:** 2026-09-07
**Status:** Draft — HUMAN_DECISIONS_PENDING; 준비 문서이며 구현·운영 승인 아님
**Reviewers:** 이번 초안의 독립 검토·사람 최종 판정 없음
**Document ID:** MEM-EVAL-VNEXT-BOOTSTRAP-P-SCOPE-1

## Context — 준비 범위와 실행 권한을 분리

D/K를 반영한 S2 activation 재계산 패키지가 SHA 보존 merge로 develop에 들어갔다.
그 패키지의 다음 미충족 항목은 bootstrap·control-plane P·신뢰 등록이다. 사용자의
"네 진행해주세요"는 이 **준비 범위 문서 작성** 지시다. 실제 담당자·key·환경·정책의 선택,
서명, 신뢰 등록, 구현, activation 판정으로 대신 기록하지 않는다.

이 문서는 새 S3/S4/D wire 계약이나 승인 receipt가 아니다. 이미 승인된 요구를 묶음별로
추적하고, 필요한 후속 산출물·권한·검증과 미정 결정을 드러내는 작업 범위 제안이다.
아래 FR/AC는 이 준비 문서의 완전성을 검사하며 운영 프로토콜에 새 허용 조건을 추가하지 않는다.
원문과 충돌하면 승인된 원문·receipt가 우선이고, 충돌을 수정 구현으로 조용히 해결하지 않는다.

### 1. 고정 기준·문서 identity

- repository: mposition/Tomverse, numeric ID 1289709524, protected ref refs/heads/develop.
- 작성 basis B: 48df8e428061003115aad8d66c27fd1dddd56f7a.
- 재계산 패키지 commit H: a19ae39d0da61295eb17e1545c74bc5b7e702c1a.
- B parents: 19ff015112e6cf908cd8dc057ca41ace8cef4e87, H 순서. B와 H의 tree는 같다.
- 새 브랜치: codex/memory-eval-vnext-bootstrap-p-scope. B에서 생성했다.
- A: 3f14afb29eddc243640fdb0a5a4f604646ade9f0 — S2 approvalCommit 유지.
- CA: 80842e62925c05af9450e6acc6ceb70b56f67655 — 통합 S1–S4 계약 승인.
- D: 159267a80acee97da3a297c637343ea15de725f9 — 명확화 문서.
- K: 6b2465e921c6e8b99ff032a36be8ada61c0ad599 — D의 authoritative 승인 JSON.
- A/CA/D/K/H는 B의 조상이며 D는 K의 strict ancestor다. B/H는 activationApprovalCommit도 C도 아니다.

2026-09-07T12:00:56Z preflight에서 해당 B의 두 CI를 다시 확인했다.
[Admin Console E2E](https://github.com/mposition/Tomverse/actions/runs/34118053612)와
[Credit Finance DB Integration](https://github.com/mposition/Tomverse/actions/runs/34118053684)는
모두 attempt 1 success다. 이것은 작성 basis의 GitHub CI 사실이지 bootstrap·protection·배포·
runtime flag 적합 증명이 아니다. 이번에는 운영 환경이나 보호 설정을 새로 조사·변경하지 않았다.

아래 18개 source의 원 commit bytes·B tree bytes·working bytes SHA-256을 대조했다.
원문 In Review/pending 표현과 decision §13 공란은 역사적 bytes로 보존하며 현재 승인 상태는
각 authoritative receipt가 소유한다. 각 hash는 같은 행의 path만 식별한다.

| Ref | Repository path | Source commit | Raw SHA-256 |
|---|---|---|---|
| SREF-01 | .github/audits/memory-eval-vnext-s1-scoring-contract-2026-09-06.md | fa682cc2209fc5b0a9ebd994aa626d00997b0359 | 393497a5acbe7ee47af6947a84204eac7723fdd973bf30afad79c812da4db0e7 |
| SREF-02 | .github/audits/memory-eval-vnext-s2-purpose-contract-2026-09-06.md | fa682cc2209fc5b0a9ebd994aa626d00997b0359 | e9a6a086be32e4d12df776015959c7c95be5185af7dc635403e8cd6689f4baa5 |
| SREF-03 | .github/audits/memory-eval-vnext-s3-holdout-contract-2026-09-07.md | 4d8a7c317b570e0c30fc5a05438cb7cc78354039 | 66a29c01dd5e2d099817ee799afc960f090e93f900be53b546b8b73f4d3b3d05 |
| SREF-04 | .github/audits/memory-eval-vnext-s4-provenance-contract-2026-09-07.md | 4d8a7c317b570e0c30fc5a05438cb7cc78354039 | e7bc98a98a6e03b31403061312e5c6abab10e7e27456f1077d3a68362ede67bb |
| SREF-05 | .github/audits/memory-eval-vnext-contract-decision-2026-09-05.md | 3f14afb29eddc243640fdb0a5a4f604646ade9f0 | 355f8387808b8a7ea86e02ecffc4303562b5ab5c43c27fef0c2bdb2bf57e89da |
| SREF-06 | .github/audits/memory-eval-vnext-contract-decision-approval-2026-09-06.md | 3f14afb29eddc243640fdb0a5a4f604646ade9f0 | 838af4d1fee11122b5a2ec6b72d5ed905a59b2b370ec2d7b88e87bdd193291f5 |
| SREF-07 | .github/audits/memory-eval-vnext-s1-s2-contract-approval-2026-09-07.md | 52caa2cecbd32cab97736993bd57630b1e3e3bc2 | 50a2c323054c8cd2a186b9ed5d5e6d206927b8cda1be1990d0796b350388e4c2 |
| SREF-08 | .github/audits/memory-eval-vnext-s1-s2-contract-approval-draft-2026-09-07.md | 52caa2cecbd32cab97736993bd57630b1e3e3bc2 | f28e58f68d03435d31834373eaeab2171ead71620947ed12a478b9ba8fa56b38 |
| SREF-09 | .github/audits/memory-eval-vnext-s3-s4-contract-approval-2026-09-07.md | 025212c4f9bd0dcb2deb4d9ade2925f3bbc6ef92 | 811e6a08691e3bacb3ddd9465d4bdf68a40a3b9748177c975e1852733db271cf |
| SREF-10 | .github/audits/memory-eval-vnext-s3-s4-contract-approval-draft-2026-09-07.md | 025212c4f9bd0dcb2deb4d9ade2925f3bbc6ef92 | fc051930ae6f3343a03f649d7733df3266d517b4a4a01090d81b459e64ac2f0f |
| SREF-11 | .github/audits/memory-eval-vnext-s1-s4-contract-approval-draft-2026-09-07.md | 80842e62925c05af9450e6acc6ceb70b56f67655 | a08b32663acd36cdc4c7daef7c4790b0b2031939998d0b3f09f4b8f46c9cd138 |
| SREF-12 | .github/audits/memory-eval-vnext-s1-s4-contract-approval-2026-09-07.md | 80842e62925c05af9450e6acc6ceb70b56f67655 | 63c829366e1315f482e7891ee8c59992215bf949eed3f1d0d34ae224f9c06c77 |
| SREF-13 | .github/audits/memory-eval-vnext-s2-activation-clarification-revised-draft-2026-09-07.md | 159267a80acee97da3a297c637343ea15de725f9 | 7ce66bb7386c5b55509b054170c1fdedc65cb505b40512823ddb282c83c3ca98 |
| SREF-14 | .github/audits/evidence/memory-eval-vnext-s2-activation-clarification-approval.json | 6b2465e921c6e8b99ff032a36be8ada61c0ad599 | d572d28ec77476bf39cd16685a922aaef4ca1203e92d6da3c83fc5e81d891423 |
| SREF-15 | .github/audits/memory-eval-vnext-s2-activation-clarification-approval-2026-09-07.md | 6b2465e921c6e8b99ff032a36be8ada61c0ad599 | 07216f3d4f8100bcf9693849c94cd74494974c3d045552ca97ced36ef14f9262 |
| SREF-16 | .github/audits/memory-eval-vnext-s2-activation-clarification-approval-request-draft-2026-09-07.md | 6b2465e921c6e8b99ff032a36be8ada61c0ad599 | 787ec805301528388a08a75375bbc092bf6388625b292c60bb7421ae0f05cd67 |
| SREF-17 | .github/audits/evidence/memory-eval-vnext-s2-activation-recalculated-package-2026-09-07.json | a19ae39d0da61295eb17e1545c74bc5b7e702c1a | 4220454017eb8886e53d66c532d4da1a3e75d2e759036742b1c84eef1245b23f |
| SREF-18 | .github/audits/memory-eval-vnext-s2-activation-recalculated-approval-draft-2026-09-07.md | a19ae39d0da61295eb17e1545c74bc5b7e702c1a | 7b821fde5cefbf9f364263a99f25c11b3852f66692158326ea0955d7ecbbaae0 |

동반 증거 색인은
[evidence JSON](evidence/memory-eval-vnext-bootstrap-p-scope-evidence-2026-09-07.json)이다.
그 JSON 역시 설명용 준비 산출물이며 proof·서명·신뢰 root·승인이 아니다.
이 두 파일 자체의 독립 검토/승인/commit은 아직 없다. 미래 자기 SHA를 미리 넣지 않는다.

### 2. 현재 확인한 구현 경계

B의 tracked lib/scripts/tests/.github/workflows에서 ProtocolImplementation,
ApprovedTrustRoot, mem-provenance-checkpoint-1, mem-signature-receipt-1,
mem-sealed-object-1을 Git grep한 결과는 0건(exit 1)이었다. 이는 특정 token의 검색 관측이며
다른 이름의 구현이나 외부 서비스가 전혀 없다는 증명은 아니다. 운영 P의 존재·적합은 미검증이다.

기존 lib/memoryEvalCanonicalisation.ts는 scoring token 정규화다. 이름이 비슷하다고
mem-cjson-1/서명용 canonical bytes 구현으로 재사용·인증하지 않는다.
기존 .github/workflows/memory-eval-decision-grade.yml은 legacy 경로다.
S4가 예약한 새 workflow와 동일하다고 취급하거나 그 plaintext 경로를 승인 없이 개조하지 않는다.

재계산 패키지의 allowedResolverPaths 9개는 **미서명 S2 resolver 제안**이다.
P를 그 9개에 끼워 넣거나, package.json 한 경로를 이유로 dependency/lockfile 변경 권한을
넓히지 않는다. P의 준비와 S2 activation/resolver 승인은 별도 작업이다.

## Functional Requirements — 준비 작업의 요구

- FR-1: 준비 문서는 B/A/CA/D/K/H 및 승인된 source bytes를 MUST 정확히 결속한다.
- FR-2: 준비 문서는 bootstrap 권한·서명 주체·등록/생성 순서와 P 동결 경계를 MUST 구분한다.
- FR-3: 준비 문서는 P 전체 작업 묶음·현재 파일 allowlist·미래 closure의 차이를 MUST 명시한다.
- FR-4: 준비 문서는 미정인 사람 결정과 에이전트가 준비할 근거를 MUST 분리한다.
- FR-5: 준비 문서는 실제 custody/proof/독립 replay 및 N-1–N-3의 미충족 경계를 MUST 유지한다.
- FR-6: 준비 문서는 미래 검증·실행 중단 조건을 MUST 정의하되 검증 완료로 표시해서는 MUST NOT 된다.
- FR-7: 준비 문서는 단계별 별도 권한과 S2 이후 F/holdout/S5 순서를 MUST 유지한다.

### 3. Bootstrap에서 먼저 결속해야 할 것 (FR-2, FR-4)

이미 정해진 요구와 아직 정하지 않은 실체는 다르다.

- 실제 사람 등록은 기존 A/CA와 exact D/K GitFileRef를 보존하고, TrustAnchor.registrationReceipt
  및 S4 trustPolicyDigest에 결속해야 한다. K 승인자를 미래 모든 signer로 자동 배정하지 않는다.
- TrustAnchor는 역할·public key·keyId·trustEpoch·유효/폐기 시점·previous epoch·사람 등록 원문을
  결속한다. 미래 실제 값은 전부 미정이다. 과거 A/CA/K에 Ed25519 서명이 있었다고 소급하지 않는다.
- S3의 역할 집합 approver/custodian/controller/importer/reviewer/authoring_reviewer를 유지한다.
  D의 s2_activation_approval은 실제 사람 approver, s2_source_evidence와
  s2_activation_inclusion은 등록 importer다. 필요한 역할을 생략하거나 그 역할에 사람을
  미리 배정하지 않는다. 목적별 권한은 S3/S4/D exact 표에서 상세화해야 한다.
- journal event/checkpoint는 controller가 서명한다. custodian은 발급 **전에** 독립 검증하고,
  importer는 사후 검증한다. runner는 controller signing key를 갖지 않는 인증된 client다.
  한 사람이 여러 운영 역할을 맡더라도 독립 통제의 한계는 공시하며 보안 경계를 없애지 않는다.
- genesis 이전 bootstrap grant는 별도 사람 bootstrap 승인에 결속한 protocol receipt/evidence
  암호화·복구 검증에 한정한다. 미래 checkpoint/root를 요구하지 않되 holdout/provider/review
  권한은 0이다. genesis 이후에는 journal authority와 최신 검증 checkpoint가 필요하다.
- 실제 key 생성·등록·grant·서명·정책 승인은 이번 작업에 포함하지 않는다.

S4/S3가 정한 생성 의존성은 다음 순서다. 각 화살표는 앞 산출물이 검증돼야 다음 단계로
갈 수 있다는 의미이며 실행 지시가 아니다.

사람 key/role/policy 등록 → 최종 P/ProtocolImplementation → ProtocolDescriptor →
GenesisRecord → encrypted payload → genesis event·signature → genesis prefix Git mirror commit →
signed Checkpoint → 별도 사람 ApprovedTrustRoot 외부 등록.

사전 bootstrap 승인에 미래 자기 genesis/checkpoint/root hash를 넣지 않는다. 별도 사후 root
등록을 사전 승인으로 합치지도 않는다. 실제 환경·시계 verifier의 하위 closure는 상위 P의
자기 digest를 끌어오지 않는 S3 Data Models 규칙을 유지한다.

### 4. P는 완성된 control-plane의 동결 단위 (FR-2, FR-3)

P는 scorer F나 최종 평가 E가 아니다. S4 §1의 P에는 controller·custodian adapter·verifier·
전용 workflow와 전이적으로 필요한 code/schema/runtime/action/dependency가 모두 들어간다.
P의 protocol descriptor는 common ledger 수명 동안 고정된다.

**genesis 전에는 구현을 여러 commit으로 나눌 수 있지만, genesis용 최소 P를 먼저 동결하고
나중에 dispatch/importer를 같은 descriptor 아래 추가하는 계획은 허용되지 않는다.**
필수 control-plane이 미완성이면 P 최종 동결·genesis를 보류한다. genesis 이후 변경은 별도
migration 계약·검토·사람 승인이 필요하며 새 ledger로 기존 소비를 초기화하지 않는다.

다음은 빠뜨리지 않을 책임 묶음이다. 이름/디렉터리는 작성자의 **후속 상세화 후보**이며
현재 쓰기 권한이나 P.repositoryFiles의 exact 목록이 아니다. wildcard를 approval allowlist로
사용하지 않는다. 실제 파일·entrypoint·dependency bytes·시험 대응표가 확정돼야 HD-7을 판정한다.

| ID | Required responsibility | Approved source | Proposed future path family — not created |
|---|---|---|---|
| P-01 | Closed wire, mem-cjson-1/domain digest, Ed25519 verification and role/epoch authorization | S3 §4/Data Models; S4 Data Models; D B-S2-01/F-1 | lib/memoryEvalVnext/protocol/ |
| P-02 | Complete Git DAG, D/K binding, protection, external trust root and current checkpoint verification | S4 §1–§2, AC-13/AC-15; D K binding | lib/memoryEvalVnext/history/ |
| P-03 | Central controller, durable single-writer journal, fencing, mirror and checkpoint signatures | S4 §3, AC-15; S3/S4 approval N-1 | lib/memoryEvalVnext/controller/ |
| P-04 | Independent custodian adapter, single-use object keys, bootstrap/journal grants and retention/recovery | S3 §4/§4.1/Data Models; S4 §3/§8 | lib/memoryEvalVnext/custody/ |
| P-05 | External environment supervision/measurement and authenticated clock evidence verification | S3 §4/AC-12; S4 NFR-5/AC-16 | lib/memoryEvalVnext/environment/ |
| P-06 | Authorization-gated dispatch and credential/contact control; complete run/attempt enumeration and no-contact refusal | S4 §4–§5, AC-14/AC-17; S3/S4 approval N-2 | lib/memoryEvalVnext/dispatch/ |
| P-07 | Artifact binding, priced/unknown spend evidence, technical closure, offline import and invalidation | S4 §6–§8/API Contracts | lib/memoryEvalVnext/importer/ |
| P-08 | Dedicated workflow, authenticated controller client, runtime/actions/supervisor dependency closure | S4 §1–§3; S3 §4; S3/S4 approval N-1 | .github/workflows/memory-eval-vnext-decision-grade.yml |
| P-09 | D closed proof verification and exact source/signature/activation/inclusion binding, no transition writer | D B-S2-01/B-S2-02/F-1; S2 contract | lib/memoryEvalVnext/s2Evidence/ |
| P-10 | Offline synthetic conformance, negative/crash/replay tests, audit-only command entrypoints and complete closure inventory | S3/S4/D acceptance criteria; S2 invariants | tests/memoryEvalVnext/ and scripts/memory-eval-vnext/ |

P-06/07에는 향후 실행을 통제할 코드가 포함되지만 실제 dispatch·provider 호출 권한은 없다.
P-10의 시험은 향후 별도 승인되더라도 합성 fixture/가짜 provider·가짜 key를 기본으로 하는
offline 경계다. 실제 운영 proof·서명·key를 시험 fixture로 대용하거나 유료 확인을 자동 포함하지 않는다.
테스트 파일 목록과 실제 실행 closure 목록도 구분하며, 실행 시 읽는 fixture/schema/config는
파일 확장자와 관계없이 closure에 포함해야 한다.

현 단계의 **유일한 파일 추가 allowlist**는 다음 두 개다.

- .github/audits/memory-eval-vnext-bootstrap-p-scope-draft-2026-09-07.md
- .github/audits/evidence/memory-eval-vnext-bootstrap-p-scope-evidence-2026-09-07.json

후속 상세 설계에서는 P-01–P-10을 구체 파일별 목록으로 바꾸고 신규/기존 여부, 변경 이유,
FR/AC, private/public 경계, side effect, 상위 closure를 적는다. package.json·lockfile·runtime·
supervisor·외부 action 추가가 필요하면 개별 변경으로 제시한다. 기존 S2 제안은 package.json의
전용 검사 script 추가만 허용하는 제안이므로 이를 dependency 변경 허가로 사용하지 않는다.
historical 122/forward frozen 109와 대조하고 충돌하면 삭제·이름 변경·포괄 예외로 우회하지 않는다.

S4 예약 경로 .github/workflows/memory-eval-vnext-decision-grade.yml와
docs/ops/memory-eval-vnext/ledger.jsonl은 **현재 만들지 않는다**.
common ledger는 S2 succ-9 purpose ledger와 다른 이력이다.
미래 S2 activation authorization JSON도 이번 문서의 output이 아니다.

### 5. 남은 사람 결정과 에이전트 준비 책임 (FR-4)

아래 전부 pending이며 실제 선택값은 null이다. 사용자에게 key나 비밀값을 대화에 붙여 달라고
요구하지 않는다. 문서·계산·후보 비교·검증 스크립트/시료 준비는 별도 권한 범위 안에서 에이전트가
맡고, 사람은 정책 선택·운영 접근 경계·판정과 서명만 한다.

| ID | Pending topic | Agent prepares | Human decides | Blocks until resolved |
|---|---|---|---|---|
| HD-1 | 실제 signer·role·key·epoch 및 등록/폐기 운영 | 역할/purpose 대응표, public key 검산·등록 대상 draft, 겸직·복구·폐기 영향 표 | 실제 담당자와 독립성 한계, key 보관/생성 경로, 유효기간·epoch·등록/폐기 정책 | 실제 TrustAnchor 등록 및 운영 서명 |
| HD-2 | ProtectionPolicy·bypassDisclosure | 읽기 전용 재조회 대상과 exact snapshot 비교 계획, 관리자 우회/적용 경로 차이 표 | 실제 classic/rules/bypass snapshot과 허용 운영 경계 승인 | 보호 정책 고정·신뢰된 genesis/root |
| HD-3 | 암호문 2개 독립 보관소·분리 key backup·복구 | 접근 경계·동일인 관리 위험·raw 자료 목록·복구/단일 key 사용 검증 계획 | 실제 보관 대상/운영자/보존 기간·복구 경계 승인 | 실제 key custody·RetentionProof·폐기/복구 운영 |
| HD-4 | 중앙 journal·controller·독립 custodian/credential 발급 | writer/lock/fsync/fencing 및 중단·복구·rollback 시험 계획, runner key 부재 증명 계획 | 실제 배치·관리 경계·독립 checkpoint 저장·발급 우회 차단 정책 | live journal·controller signing·credential/key grant |
| HD-5 | 비공개 실행·review session 환경 | 전용 ephemeral self-hosted/비실행 session의 image·supervisor·측정 verifier와 원 증거 매핑 | EnvironmentApproval의 실제 환경·policy·attester 및 관리자 잔여 승인 | 실제 plaintext 처리·attestation·grant |
| HD-6 | 인증된 UTC source·ClockPolicy | 인증 trust·측정·원 proof·verifier closure 후보와 S4 오차/경계 시험 계획 | 실제 source·인증 경로·측정 policy/구현 및 drift 상한 승인 | 유효시간·cutoff·grant/dispatch 운영 판정 |
| HD-7 | P 구현 exact scope·dependency closure·검증 권한 | P-01–P-10을 실제 파일별 diff allowlist·외부 dependency/runtime/action digest·FR/AC로 상세화 | 별도 offline 구현/시험 범위와 이후 실제 bootstrap 운영 권한을 각각 결정 | 코드/테스트/workflow 작성 및 최종 P 동결 |
| HD-8 | D N-1/N-3의 실제 실행 증명 공백 | 요청 version 원 관측과 독립 network 차단 사실의 증명 가능성/공백 보고; 새 wire 없이 대조 | 필수 조건을 입증하지 못하거나 계약 의미 변경이 필요하면 별도 범위 결정 | source receipt 발급·activation 실행 판정 |

HD-1–HD-6에서 공급자·장비·서비스가 정해졌다고 가정하지 않는다. 현재 PC/기존 Railway/일반
GitHub runner를 계약 적합 환경으로 자동 선정하지 않는다. 다음 상세화에서 후보 기술을 다룰 때
실제 보유 환경·접근 가능성을 확인하고 현행 공식 문서와 원 측정 근거로 비교해야 한다.
지금은 일반적인 보안 제품 추천이나 새 인프라 구매 승인을 만들지 않는다.

### 6. Custody와 D source proof 준비의 경계 (FR-5)

S3 §4의 AES-256-GCM per-object fresh 256-bit key/단일 암호화, zero nonce 1회, durable
allocation·사용 기록과 snapshot/seed replay 방지는 이미 승인된 요구다. 새 keyId만으로 fresh
key가 증명되지 않으며 backup은 복호화 전용이다. 암호문과 key는 별도 접근 경계, 보관소는
독립인 정확히 2곳, 분리 key backup/restore proof가 필요하다. 어떤 것도 이번에 생성하지 않았다.

실제 plaintext job은 전용 attested ephemeral self-hosted 환경이고, authoring/reviewer 등
비실행 session도 목적별 환경 승인·외부 attestation이 필요하다. grant/attestation 최대 30분,
key 이전 dependency 설치 완료, worker output/swap/dump/telemetry 차단 및 volatile store가
요구된다. label·boolean·worker 자기 서명만으로 통과하지 않는다.

S4 ClockPolicy는 인증 UTC source와 원 측정 bytes·verifier closure를 사람이 고정해야 한다.
RTT 1000ms, age 60000ms, source error 1000ms, maxDriftPpm 100 이하 및 B 5000ms 경계와
보수적 시간 구간 계산을 유지한다. unsigned HTTP Date나 단순 wall clock·임의 offset은 증명이 아니다.
정확한 식·서명 domain은 S4 NFR-5/Data Models가 소유하며 이번에 변경하지 않는다.

D proof는 정확히 15 source roles와 네 closed kind(GitHistoryProof/GithubCaptureProof/
ArtifactEntryProof/CheckerReplayProof)다. 재계산 패키지의 raw hash 일치는 source receipt나
실제 offline replay의 완료가 아니다. 16번째 register role을 추가하지 않고, V의 register 원문은
GitHistoryProof 안에서 반드시 대조한다. ZIP snapshot은 native Git bundle을 대신하지 않는다.

- 미래 native A/V complete Git graph와 exact 원본 leaves/dependencies를 보존해야 한다.
- V = 12f83ec2c388a318fe0a79d4f76bd2c0b245dcb1의 checker·register·runtime/dependencies로
  exact legacy subject를 독립 재현한다. 현재 HEAD의 검사 결과를 V replay로 보고하지 않는다.
- exact subject는 8개 rule 전부 OK여야 한다. exit 0이나 일반 NOTE를 성공으로 완화하지 않는다.
- legacy run 33953094398/attempt 1/artifact 9966057860은 과거 사실이다.
  admissible=true와 품질 FAIL·workflow failure·pair revoked·ordinal 2 금지를 함께 유지한다.
- 실제 proof·서명 receipt는 해당 단계 전제와 사람 권한이 충족된 뒤 별도 작업으로 만든다.
  raw source 준비, retained proof, importer 서명, 사람 activation 승인, C inclusion을 합치지 않는다.

## Non-Functional Requirements — 기록과 검증 경계

- NFR-1: 두 신규 문서는 strict UTF-8, BOM/CRLF/후행 공백 없이 MUST 저장한다. 승인 원문은 bytes 그대로 보존한다.
- NFR-2: tracked source/dataset/register/prompt/flags/workflow와 index를 MUST 변경하지 않는다. 기존 untracked 파일도 보존한다.
- NFR-3: 준비 작업은 production 자격증명·비밀값·유료 provider turn 0개여야 MUST 한다. 로컬 검사와 GitHub 읽기 전용 CI 사실 확인만 했다.
- NFR-4: 관측·계약 요구·작성자 제안·사람 미정 결정을 MUST 분리한다. CI green/문서 hash를 운영 readiness로 승격하지 않는다.
- NFR-5: 미래 P 검증은 FR/AC 누락·미확인 보안 경계를 MUST 차단한다. 이 문서의 대표 시험 목록이 S3/S4/D 전수 AC를 대체하지 않는다.

## API Contracts — 새 API는 N/A

이 산출물은 코드·HTTP endpoint·CLI를 만들지 않으므로 신규 request/response 계약은 N/A다.
미래 ProvenanceVerifier.verifyHistory/importRun은 S4 API Contracts의 순수 검증 경계,
HTTP fetch/dispatch/쓰기/custody는 controller side effect 경계 그대로다.

GitHub API version·요청/응답·pagination·dispatch 계약은 S4 원문을 참조하며 이 준비에서 새
동작 검증을 주장하지 않는다. D의 ApiCapture request-header 잔여를 schema field 추가로
"보완"하지 않는다. 향후 구현 시 공식 문서 재확인과 실제 관측이 다르면 실행 전에 멈춘다.

## Data Models — 준비 색인과 실제 wire를 분리

동반 JSON의 schemaVersion/kind/status는 **설명용 audit inventory**다.
authorization.decision=pending, approvedBy/approvedAt=null이고 구현·bootstrap·activation·
provider·commit/push/PR 권한은 false다. basis/sourceFiles는 관측한 Git·raw bytes identity,
proposedWorkUnits/humanDecisionQueue는 제안과 미정 항목, baseline/preparationValidation은
로컬 검증 기록이다. futureValues의 null은 미생성·미정이고 operative nullable wire가 아니다.

| Field | Type | Constraints |
|---|---|---|
| authorization | explanatory object | 준비 지시만 true; decision=pending, 승인자/날짜 null, 실행 권한 false |
| sourceFiles | identity array | source commit·repository path·rawSha256을 같은 행으로 결속; 18개 |
| proposedWorkUnits | proposal array | P-01–P-10; path family는 exact 파일 allowlist가 아님 |
| humanDecisionQueue | pending decision array | HD-1–HD-8; selectedValue=null; 근거 준비/판정 책임 분리 |
| futureValues | uncreated-value object | 모든 값 null; 실제 protocol record로 전달 금지 |
| preparationValidation | observation object | 준비 검사만 기록; 운영·독립 검토 성공으로 해석 금지 |

ProtocolImplementation, ProtocolDescriptor, GenesisRecord, TrustAnchor, ApprovedTrustRoot,
Checkpoint, ProtectionPolicy, ClockPolicy, EnvironmentApproval/Attestation, SignatureReceipt,
KeyGrant 및 D ActivationAuthorization/SourceEvidenceReceipt/네 proof 종류는 새로 인스턴스화하지
않는다. exact fields·canonicalization·domain은 각각 승인 원문을 따른다.

S3/S4만 포함하는 ProtocolDescriptor.specifications를 S1–S4/D/K 배열로 넓히지 않는다.
D/K는 승인된 등록 원문·TrustAnchor.registrationReceipt·trustPolicyDigest 경로로 결속한다.
S1/S2 scoring descriptor와 S4 protocol descriptor는 다른 구조다.
이번 JSON에 운영 signature/self digest/미래 commit을 만들어 넣지 않는다. DB/schema 변경은 N/A다.

## Acceptance Criteria — 준비 완료와 미래 시험을 구분

### AC-1: 계보·원문 보존 (FR-1, NFR-1)
**Given** B와 18개 고정 source commit/path/hash가 있다.
**When** 원 commit blob/B tree/working bytes와 승인 ancestry를 대조한다.
**Then** 전부 일치하고 원 decision §13은 비어 있으며 새 준비 문서에 사람 승인을 전사하지 않는다.

### AC-2: P 범위와 순서 (FR-2, FR-3)
**Given** 아직 P·root·activation이 미생성이다.
**When** §3–§4의 순서·P-01–P-10·현재 두 파일 allowlist를 읽는다.
**Then** 미래 E/F/holdout/S5 없이 준비할 P와 실행 권한을 구별하며, 불완전 P의 조기 genesis를 허용하지 않는다.

### AC-3: 미정 사람 선택 (FR-4)
**Given** 실제 key/role/정책/환경/source가 아직 선택·승인되지 않았다.
**When** HD-1–HD-8과 JSON을 대조한다.
**Then** 모두 pending/null이고 각 blocked operation 및 에이전트 준비 책임이 있다. 기존 승인자로 빈칸을 채우지 않는다.

### AC-4: Proof·잔여의 비승격 (FR-5, NFR-4)
**Given** raw source hash와 과거 CONFIRMED_WITH_WARNINGS가 존재한다.
**When** source proof와 D N-1–N-3 및 S3/S4 N-1/N-2를 검토한다.
**Then** namespace별 조건을 유지하고 요청 header/차단 환경/8-rule 독립 replay를 완료로 표시하지 않는다.

### AC-5: 검증 계획과 실행 차단 (FR-6, NFR-5)
**Given** 아직 구현·운영 시험 결과가 없다.
**When** 아래 미래 검증 목록을 읽는다.
**Then** 미실행으로 표시하며 누락·unknown을 성공으로 추정하지 않는다. 실제 P 동결 전 전수 AC 추적을 요구한다.

### AC-6: 다음 단계의 별도 권한 (FR-7)
**Given** 이 문서 작성만 지시됐다.
**When** 단계 전환을 판단한다.
**Then** 별도 구현/실제 등록/activation 승인 전 진행하지 않고 F·seal 전 S5를 시작하지 않는다.

### AC-7: 변경 범위와 기준선 (NFR-1, NFR-2, NFR-3)
**Given** B의 tracked/index clean 기준선과 기존 untracked 목록/hash가 있다.
**When** package 검사·strict bytes·whitespace·Git diff/status를 비교한다.
**Then** 추가는 이 두 문서뿐이고 staged 0개, 기존 실패는 이름 단위로 동일, source/기존 untracked bytes 변화는 0이다.

### 미래 P의 최소 검증 묶음 — 전부 미실행 (FR-6)

이 표는 에이전트가 후속 승인된 구현에서 시료·정답·시험 코드를 준비할 목록이며 지금 테스트를
작성·실행했다는 뜻이 아니다. 로컬 합성 검증은 유료 turn 0개로 계획한다.
실제 외부 통제·환경·custody 증명은 별도 운영 권한/측정이 필요하며 합성 시험이 대체하지 못한다.

| Area | Future positive/negative evidence | Upstream target |
|---|---|---|
| Wire/signature | exact bytes·domain·role·epoch·서명자 교체·extra field·null 오류 거부 | S3 §4/Data Models; D AC-1–AC-25 |
| History/protection | 전체 parent graph·replace/graft/shallow 거부·삭제 후 복원·merge-only 변경·정책/bypass 불일치 | S4 §2/AC-13/AC-15; S2 invariants |
| Journal/custodian | double writer·crash before/after append/fsync·fencing rollback·존재하지 않는 mirror·runner 직접 서명 거부 | S4 §3/AC-15; S3/S4 N-1 |
| Crypto/retention | fresh key 단일 사용·복구 snapshot/seed replay 차단·변조 tag/AAD·독립 2개 store 복원·key backup 분리 | S3 AC-4/AC-9, §4/§4.1 |
| Environment/time | 외부 raw 측정·expired/자기 attestation·wall jump·B=5000/5001·보수적 window/cutoff | S3 AC-12; S4 AC-16 |
| Dispatch/closure | fake transport만 사용; 결과 불명 재전송 금지·late/duplicate attempt·no-contact 증거 결손·영구 소비·unknown spend | S4 AC-1–AC-17; S3/S4 N-2 |
| D source replay | exact 15-role/네 proof·V register·native bundle·artifact bridge·8개 OK·실제 network 차단 | D AC-1–AC-25; D N-1/N-2/N-3 |
| P freeze/privacy | 전이 dependency/runtime/action bytes 완전성·P와 E/T 하위 closure 일치·출력 allowlist·offline 재현/최신 invalidation | S4 §1/§8, S3 §4 |

위 영역에서 증명되지 않은 실행 보안·영구 소비·승인/byte 결속은 차단 대상이다.
문서 가독성이나 기존 Windows 경로 검사 문제를 새 운영 허용 근거로 삼지 않는다.

### 이번 문서 작업의 검사 기록

baseline은 문서 추가 전 B의 tracked/index clean 상태에서 package.json script로 실행했다.
check:encoding:strict, check:policy-section-references, check:release-records,
check:memory-eval-succ9, check:memory-extraction-eval, check:memory-eval-freeze가 통과했다.
check:doc-references는 아래 기존 8건으로 exit 1이었다. 추가 후 결과는 동반 JSON의
preparationValidation에 기록하며 이름별 비교·raw bytes 검사와 함께 최종 보고한다.

- missing app/layout.tsx 참조 4건: lib\documentLanguage.ts, app\[locale]\layout.tsx,
  scripts\security-regression-check.mjs, tests\e2e\ssr-root-language.spec.ts.
- unused historical entry 4건: 위 네 경로의 POSIX 표기 각각 → app/layout.tsx.
- scripts/check-doc-references.mjs는 역사 문서인 .github/audits/를 의도적으로 제외한다.
  따라서 script 통과가 이 두 문서의 모든 참조를 검증했다는 주장은 하지 않는다.
  source table/JSON 결속·현재/미래 경로 구별은 별도로 확인한다.

## Edge Cases — 수용은 면제가 아님

- EC-1: S3/S4 receipt의 N-1(중앙 controller key)·N-2(no-contact)와 D 확인 검토의
  N-1–N-3를 이름이 같다는 이유로 합치지 않는다. 통합 CA와 A의 모든 조건·잔여는 유지된다.
- EC-2: D namespace s2_clarification_confirmation_2026_09_07의 N-1은 ApiCapture의 요청
  header/버전 증명 공백이다. 응답 header로 요청 version을 추정하거나 importer-attest 해석을 채택하지 않는다.
- EC-3: 같은 namespace N-2는 exact V subject의 독립 8개 OK 요건이다. 일반 NOTE/exit 0으로 면제하지 않는다.
- EC-4: 같은 namespace N-3의 ReplayEnvironment 세 field는 network 차단 증명이 아니다.
  기존 S3 EnvironmentAttestation은 S3 grant/session 계약에 적용하되, 이를 D replay의 새 proof
  kind/field로 추가하거나 D 차단 환경의 대용 증거로 채택하지 않는다.
- EC-5: 입증 공백이 실행 판단을 바꾸거나 필수 조건을 증명할 수 없으면 실행을 멈추고 별도 범위를
  요청한다. 이번 준비는 새 명확화안이나 독립 확인 검토 추가 회차의 묵시 승인이 아니다.
- EC-6: 기존 D 확인 검토 CONFIRMED_WITH_WARNINGS 및 확인 검토 1/1 소진은 유지한다.
  보고서 hash 52ea1b94d745142eef9347aff9e831e0c8364cc83014ec1773571471d1f14b38은 그 보고서만 식별한다.
  이번 문서/P 구현을 Claude가 검토했다고 주장하지 않는다.
- EC-7: remote tip이 바뀌면 이 문서의 B 관측을 새 tip의 증거로 쓰지 않는다.
  실제 후속 작업은 최신 develop inclusion/CI/ancestry·원문 hash를 재확인한 뒤 별도 브랜치에서 시작한다.
- EC-8: genesis 이후 P가 바뀌거나 신뢰/보존/clock을 증명하지 못하면 멈춘다.
  no-op/unknown을 성공 처리하거나 새 ledger/새 reservation으로 소비를 지우지 않는다.

## Out of Scope — 다음 단계와 중단선

권장 후속 묶음은 다음과 같으며 **어느 행도 이번 지시로 자동 시작하지 않는다**.

| Stage | Required scope/approval and output | Exit boundary |
|---|---|---|
| NEXT-1 | HD-1–HD-8 근거·후보와 P exact 파일별 상세 계획 준비, 사람의 정책 선택 및 별도 offline 구현 권한 | 코드/운영 전 권한 확인; 미정 외부 제품/환경을 자동 선택하지 않음 |
| NEXT-2 | 승인된 범위에서 P 전체 control-plane 구현·합성 검증·파일/의존성 closure 상세화, 별도 지시된 검토와 사람 판정 | 부분 구현 commit을 최종 P로 부르지 않음; 실제 key/등록 운영은 별도 권한 |
| NEXT-3 | 실제 사람 bootstrap key/role/policy 등록 완료를 선행한 최종 P 고정 → descriptor/genesis/mirror/checkpoint → 별도 외부 root 등록 | HD·전수 AC·실제 운영 증거 충족 전 genesis 금지; root는 activation 승인 아님 |
| NEXT-4 | OP-CUSTODY/OP-SOURCES의 실제 proof·15 서명 source·독립 replay, 실제 S2 scope/digest 대상 확정·사람 Ed25519 승인 | K < activationApprovalCommit < C strict ancestry; 승인과 실행 같은 commit 금지 |
| NEXT-5 | 별도 승인 범위의 S2 resolver 구현/검증과 atomic 전환 C, SHA 보존 merge·develop CI·detached inclusion/checkpoint | D inclusion 조건·forward 불변·protected ancestry 전부 확인 |
| NEXT-6 | 별도 scorer 구현·F 동결 → 격리 holdout 작성/검수/seal → S5 → E/Programme/pair/예산/dispatch 승인 | P 동결과 F 동결을 혼동하지 않음; seal 전 S5 금지 |

NEXT-2의 합성 개발과 NEXT-3의 실제 신뢰 등록은 구분한다. 최종 P를 운영 protocol에 채택하는
시점에는 S4가 정한 사전 사람 등록이 먼저다. 미래 policy 측정 verifier의 하위 code closure가
필요하더라도 상위 P/root를 사전 승인에 넣어 hash 순환을 만들지 않는다.
S2 authorization commit이나 C에 P 구축·정책 선택을 몰아 넣지 않는다.

이번 작업에서는 다음을 만들거나 실행하지 않는다.

- OS-1: scorer/resolver/validator/controller/custodian/importer/ledger/workflow 및 test skeleton 구현
- OS-2: key/서명/TrustAnchor/운영 policy·proof·RetentionProof·ClockEvidence·환경 attestation·신뢰 root 생성
- OS-3: dataset·manifest·register·purpose activation·기존 승인 원문 변경
- OS-4: holdout/case/gold 작성·열람·seal/open/materialisation, S5/v9 prompt 작성·활성화
- OS-5: pair·예산·dispatch/re-run·provider probe/유료 호출, 운영 환경·secrets·보호 설정 변경
- OS-6: release gate·memoryExtractionEnabled·memoryInjectionEnabled 변경
- OS-7: stage·commit·push·PR·ready·auto-merge·병합·배포·추가 독립 검토 요청

준비 완료는 운영 준비 완료도 사람 최종 승인도 아니다. 두 문서를 검토할 수 있는 상태로
건넨 뒤 멈춘다. spec-driven-workflow는 FR/AC·미정 선택·중단 경계를 드러내기 위해 사용했고,
구현/테스트 추출 단계로 진행하지 않았다.
