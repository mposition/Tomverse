# Memory eval vNext S2 — dataset purpose and historical provenance

**Author:** Codex
**Date:** 2026-09-06
**Status:** In Review — 사람 미승인, purpose 전환 미활성
**Reviewers:** Claude 독립 검토 대상; 최종 승인자는 사람
**Document ID:** `MEM-EVAL-VNEXT-S2-1`

## Context — 권한과 역사적 기준

상위 결정문은 `.github/audits/memory-eval-vnext-contract-decision-2026-09-05.md`,
SHA-256 `355f8387808b8a7ea86e02ecffc4303562b5ab5c43c27fef0c2bdb2bf57e89da`다.
authoritative receipt는 `.github/audits/memory-eval-vnext-contract-decision-approval-2026-09-06.md`다.
이 계약의 `approvalCommit`은 반드시 **원래 commit A**
`3f14afb29eddc243640fdb0a5a4f604646ade9f0`이다. 저장소 basis
`6263ecdcc1e69585498c19c0a294fef5202f5218`이나 merge commit으로 대체하지 않는다.
merge commit `c2474837132a4355b750be0229e954ac30eb0ab6`은 A를 조상으로 보존한다.
작성 브랜치는 CI 성공이 확인된 develop tip
`11f11f0d38dea3c28d365503bc7b77ed0d793204`에서 시작했다
([Credit Finance DB](https://github.com/mposition/Tomverse/actions/runs/34026626210),
[Admin Console E2E](https://github.com/mposition/Tomverse/actions/runs/34026626240)).

D1은 succ-9 전체의 미래 사용을 development로 내리되 frozen sample, manifest, approval,
digest와 과거 v8 결론을 보존한다. 현재 `lib/memoryEvalSucc9.ts`의 purpose 상수는
`decision`이고 v8 pair는 revoked다. 이 문서 추가는 어느 값도 바꾸지 않는다.
동반 S1은 `.github/audits/memory-eval-vnext-s1-scoring-contract-2026-09-06.md`다.

이 문서는 schema와 검증 계약이다. ledger나 activation receipt를 생성한 것이 아니다.
S1–S4 사람 승인, 별도 activation 승인, 실제 전환과 불변 검사 뒤에만 scorer 구현으로
간다. S3/S4의 새 holdout state·dispatch·암호화·GitHub REST 세부 계약을 대신하지 않는다.

## Functional Requirements — 요구사항

- FR-1: succ-9 identity·frozen bytes·기존 승인·digest를 MUST 보존한다.
- FR-2: purpose는 `decision → development`로만 MUST 전이한다. 역전환·부분 전환은 MUST NOT 허용한다.
- FR-3: decision approval, 하위 계약 승인, activation 승인을 MUST 서로 다른 권한으로 검증한다.
- FR-4: purpose 기록은 exact-byte append-only hash chain으로 MUST 남긴다.
- FR-5: hash chain뿐 아니라 Git DAG와 신뢰 checkpoint를 MUST 검증한다. 불확정 history는 MUST 거부한다.
- FR-6: `purposeAt(commit)`과 현재 decision admission을 MUST 분리한다. 과거 snapshot으로 current gate를 우회해서는 MUST NOT 된다.
- FR-7: legacy exception은 아래 v8 run/attempt/artifact **하나**만 MUST 허용한다.
- FR-8: historical admissibility와 품질 FAIL·revocation을 MUST 함께 보존한다. 새 run·재채점·예산 권한으로 바꾸어서는 MUST NOT 된다.
- FR-9: caller는 structured refusal를 MUST 처리한다. 누락·오류를 decision default로 바꾸어서는 MUST NOT 된다.
- FR-10: activation 검증은 모든 기존 digest와 전체 1,150-case identity의 전후 일치를 MUST 증명한다.

### 1. 불변 identity와 frozen scope (FR-1, FR-10)

| Field | Pinned value |
|---|---|
| datasetVersion / schema / caseCount | mem-eval-succ-9 / 3 / 1150 |
| datasetDigest | `626f71362046b7d88df9dbb07e2f51fa0e908c78192f74bd837fa88e9ce1d4e6` |
| manifestDigest | `82d9aa48fe96037b7493dae26594a73482d7ba4a915532caffc9be411085f40c` |
| scoringContractVersion | mem-score-v3.5 |
| scoringContractDigest | `2d4bcb696c2dd87d586ab30bb8308c567b3ef3f57b0b17f6ff99e10de0cc33d4` |
| subtypeDigest | `9a4e418c7fd36a4d84b53b99ed41d731c83a5f53d93af117c4c8fd14e05d8ce6` |
| original dataset approvedBy / approvedAt | @mposition / 2026-09-04 |
| original dataset approvedCommit | `25b3f503ed2637d7b160e6a8c5750203d5e60b1d` |
| frozen | true |

기준 snapshot은 실제 v8 evaluated commit `12f83ec2c388a318fe0a79d4f76bd2c0b245dcb1`이다.
activation의 `frozenFiles`는 그 snapshot의 `lib/memoryEvalSucc9.ts`에서 시작하는 모든
repository-owned import의 transitive closure(type-only 포함)를 **정렬된 전체 목록**으로
기록한다. root-relative `@/`와 상대 경로를 repository tree에서 resolve하며 node builtin은
목록 밖, 외부 package는 당시 lockfile identity로 기록한다. unresolved import·동적 경로·
빠진 dependency는 closure refusal다. 파일별 path·Git blob OID·raw SHA-256을 담는다.
그 closure는 case sources, composition/transition/subtype, manifest builder, 기존 scoring
descriptor를 포함한다. 기존 approval record가 참조하는 감사 파일도 frozenFiles에 더한다.
root 이름만 보고 몇 파일을 수동 선택하는 축약은 불가다.

activation 전후와 이후 모든 검증에서 각 frozen file의 bytes와 위 dataset/manifest/scoring
digest가 같아야 한다. 과거 lockfile 자체의 현재 동일성은 요구하지 않되, 과거 snapshot에서
그 digest를 재현할 때는 보존된 dependency identity만 사용한다. dependency drift로
재현할 수 없으면 unknown/refusal이지 새 digest로 재서명하지 않는다.
기존 `MEMORY_EVAL_SUCC9_DATASET_PURPOSE`도 역사적 bytes 일부여서 직접 수정하지 않는다.
향후 current gate가 별도 purpose history를 authority로 읽도록 바꾸는 것이 activation의
명시 scope다. 이 resolver 연결만 후속 승인된 activation 구현 범위이며, scorer 구현이나
register 재승인을 그 변경에 묶지 않는다.

### 2. 권한 세 층과 실제 효력 (FR-2, FR-3)

1. `approvalCommit=A`는 D1–D5 결정 승인이다. 원래 문서·receipt hash와 A의 parent/basis를
   확인하며 A가 contractApprovalCommit·activationApprovalCommit·effectiveCommit의 조상이어야 한다.
2. `contractApprovalCommit`은 사람이 S1–S4 **각각의 최종 문서 commit·경로·SHA-256**을
   승인한 receipt를 담은 commit이다. S1/S2만 서명된 상태는 insufficient_contract_approval다.
3. `activationApprovalCommit`은 실제 succ-9 전환을 별도로 승인한 receipt의 commit이다.
   그 사람 receipt는 operation `activate_succ9_development`, old/new purpose, frozen identity,
   예정 genesisDigest·transitionPayloadDigest·legacySubjectDigest와 허용되는 resolver 연결 변경을
   정확히 명시한다. contractApprovalCommit을 조상으로 갖고 activation commit의 **strict
   ancestor**여야 한다. 같은 commit에서 승인과 실행을 스스로 만들지 않는다.

`effectiveCommit`은 승인된 ledger bundle을 실제로 처음 도입한 commit C다. 레코드에
C 자신의 SHA를 적지 않는다. C의 tree와 부모 tree 비교로 계산하고, 후속 protected-branch
inclusion receipt가 C와 develop merge SHA를 결속한다. timestamp로 발효 시점을 소급 지정하지
않는다. branch-local C에서는 purposeAt(C)=development지만, decision admission은 별도로
신뢰할 protected tip에서 C의 포함을 검증해야 한다. C가 develop에 들어가기 전에는
activation_complete라고 보고하지 않는다.

단 한 번의 C가 genesis·transition·legacy receipt를 함께 추가해야 한다. 반쪽 추가는
refusal다. C는 approvalCommit과 두 별도 승인 commit을 조상으로 가진다. 새로운
`decision` 사용 구간을 만들지 않으며 genesis는 과거 snapshot의 사실을 기술할 뿐이다.

### 3. Planned record format (FR-4)

후속 승인된 activation이 만들 경로는 `docs/ops/memory-eval-purpose/succ-9.jsonl` 하나다.
**현재 파일은 만들지 않는다.** C에서 세 줄을 원자적으로 넣는다. 줄당 S1의 `mem-cjson-1`
object bytes + LF이며 BOM·빈 줄·CRLF는 금지다. 이후 valid operation은 없다.
다른 dataset은 S3/S4가 정할 별개 history이지 이 succ-9 chain에 끼워 넣지 않는다.

각 envelope는 `{payload, recordDigest}`다.
`recordDigest=SHA256(UTF8("mem-purpose-record-1\n") || CJSON(payload))`이며
payload.prevDigest는 직전 recordDigest다. 자신의 digest는 자신의 payload에 없다.

| seq / type | Required payload fields (공통 field 외) | Meaning |
|---|---|---|
| 0 / legacy_snapshot | basisCommit, identity, frozenFiles, frozenFilesDigest | §1의 historical snapshot만, prevDigest=null |
| 1 / purpose_transition | from:decision, to:development, approvalCommit, contractApprovalCommit, activationApprovalCommit, reason:exposed_distribution, identityDigest | seq0 hash에 연결, succ-9 전체 전환 |
| 2 / legacy_run_receipt | subject, historicalVerdict, evidenceSources, sourceReceiptDigests | §5의 정확히 하나인 예외, seq1 hash에 연결 |

공통 fields는 schemaVersion=1, datasetVersion=mem-eval-succ-9, seq, type, prevDigest다.
unknown field·seq gap·중복 type·4번째 줄·identity drift는 모두 invalid history다.
legacy receipt가 transition 뒤에 있는 것은 그 과거 run을 현재로 옮겼다는 뜻이 아니라
현재 chain에 **과거 증거에 대한 제한된 해석 receipt**를 결속하는 것이다.

identityDigest와 frozenFilesDigest는 각각 domain `mem-purpose-identity-1`,
`mem-purpose-frozen-files-1`과 LF 뒤 CJSON bytes로 계산한다. frozenFiles는 repository-relative
POSIX path 순서로 정렬하고 duplicate path를 거부한다. Git file mode도 목록에 담는다.
sourceReceiptDigests는 source 역할 이름 순서로 정렬하며 digest 중복이 아니라 role 중복을
거부한다. artifact 후보/실행 unit을 wildcard array로 확장할 수 없다.

### 4. Git history validation와 purposeAt (FR-5, FR-6, FR-9)

검증 입력은 신뢰할 repository numeric ID와 protected ref identity, immutable current tip T,
complete Git object graph, 그리고 별도 보존된 signed activation checkpoint다. 단순히
caller가 `trusted=true`라고 보낸 값을 신뢰하지 않는다. S4가 API/ref protection·실제 tip·
서명/receipt provenance를 확인해 이 경계에 공급해야 한다. checkpoint는
repositoryId, effectiveCommit C, chainHeadDigest, inclusionCommit, 승인 receipt digest를 묶는다.
한 번 활성화한 repository에서 checkpoint가 사라졌다고 pre-activation mode로 돌아갈 수 없다.
신규 verifier도 승인된 checkpoint bundle을 받지 못하면 current decision 사용을 거부한다.

검증 순서는 다음과 같다.

1. repository/ref identity와 complete history를 확인한다. shallow/missing parent/blob,
   replace/graft history, signature provenance 미확정은 history_unverifiable다.
2. A와 승인 원문 hash를 재검증하고 C 및 checkpoint.inclusionCommit이 T의 조상인지 확인한다.
   원래 A가 squash/rebase로 소실됐거나 C를 force-reset한 tip은 refusal다.
3. C를 최초 bundle introduction으로 유일하게 식별한다. C 부모들에는 해당 ledger가 없어야
   하고 C에는 정확한 세 줄이 있어야 한다. 이미 있는 ledger를 새 C라고 신고할 수 없다.
4. C의 후손이면서 T의 조상인 **모든 commit**의 tree를 읽는다. 각 tree에 동일 ledger와
   frozenFiles가 있어야 한다. 이 구간의 모든 parent-child edge를 검사한다. merge도 부모를
   전부 보되 C를 아직 포함하지 않은 부모의 ledger 부재는 삭제로 세지 않는다. C를 포함한
   부모에서의 삭제·수정·축약·이름 변경은 뒤에서 복원돼도 history_tampered다.
5. hash chain, 세 승인 layer, identity, closure, exact legacy tuple을 검증한다. 독립 branch가
   같은 전환을 다시 기록한 경우 최초 C가 둘이므로 divergent_activation이다. 단순한 동일 C의
   merge 전달은 중복 activation이 아니다.

`purposeAt(dataset, Q, historyContext)` 결과는 다음 폐쇄 규칙으로만 나온다.

- Q가 검증된 C와 같거나 후손이면 `known: development`; Q까지 위 DAG 검증도 필요하다.
- pre-ledger historical special case는 **Q가 §5의 evaluatedCommit과 정확히 같고** exact
  legacy receipt 검증이 성공한 때만 `known: decision, provenance:legacy_exact_run`이다.
- 그 밖의 pre-C commit, C와 무관한 branch, unknown dataset은 `unknown`이다. 이 계약은
  pre-ledger 모든 commit의 purpose를 추정해서 보증하지 않는다.

historyContext의 현재 신뢰 chain이 실패하면 Q가 과거 v8 SHA여도 새로운 검증 성공을
내지 않는다. 이미 보존된 유효한 historical receipt는 훼손하지 않고
`reverification_unavailable`로 보고한다. unknown은 development도 decision도 아니다.

**Current decision admission은 purposeAt(Q)=decision 하나로 열리지 않는다.**
newDecisionAdmission(dataset, evaluatedCommit, T)는 검증된 current T와 evaluatedCommit
양쪽의 purpose, effective activation checkpoint, S4 tuple/권한을 요구한다. succ-9는
active chain이면 항상 dataset_development로 거부한다. chain 미설치/불명도
purpose_history_unavailable로 거부한다. exact legacy exception은 historicalRead 함수에만
존재하며 live/probe/dispatch 경로에 export되는 permission boolean이 아니다.
따라서 frozen=true·옛 purpose 상수 decision·옛 commit checkout·옛 budget을 조합해도
새 succ-9 decision-grade run은 불가다. development probe는 별도 예산/dispatch 승인으로만
가능하며 항상 decisionGrade=false이고 decision programme 증거가 아니다.

### 5. 유일한 legacy allowlist / receipt (FR-7, FR-8)

범위는 아래 tuple 전체의 **논리곱**이다. run ID만 맞는 다른 attempt/artifact/commit은
허용하지 않는다. 현재 문서는 예외의 스키마와 상수를 정하며 actual receipt activation은
§2의 별도 승인 대상이다.

| Subject field | Exact value |
|---|---|
| repositoryId / repository | `1289709524` / `mposition/Tomverse` |
| workflowPath | `.github/workflows/memory-eval-decision-grade.yml` |
| runId / runAttempt | `33953094398` / `1` |
| evaluatedCommit | `12f83ec2c388a318fe0a79d4f76bd2c0b245dcb1` |
| modelId / promptVersion | `gpt-5-6-luna` / `8` |
| promptDigest | `a1d804c6b9359b722c60b1309c7324176f72c54008d2a616fa78dd520a6b44ae` |
| dataset | §1의 exact identity, datasetVersion `mem-eval-succ-9` |
| artifactSchema / datasetSchema | `3` / `3` |
| subjectArtifactId / name | `9966057860` / `mem-eval-run1` |
| archive SHA-256 (GitHub metadata) | `8932f1ae3a48effee8f099c2287a290e1cd02c88f1bf4b2ae5869ef60662f888` |
| subject file name / bytes | `mem-eval-run1.json` / `923959` |
| subject content SHA-256 | `09832eab460e3efc5e1d6998ca13f1100490ac9a5123dad3acbd075ffc3126c0` |
| generatedAt | `2026-09-05T08:21:07.467Z` |
| runOrdinal / mode | `1` / `live` |
| plannedCaseCount / caseCount | `1150` / `1150` |

archive digest는 JSON digest가 아니다. JSON bytes를 직접 hash한 subject content digest와
GitHub archive metadata의 digest를 서로 바꾸어 쓰지 않는다. legacy artifact manifest에
실제로 없는 promptDigest·manifestDigest·runId·runAttempt를 들어 있었다고 주장하지 않는다.
prompt/dataset manifest는 evaluatedCommit의 frozen code·승인 기록에서, run/attempt/artifact
귀속은 GitHub run/artifact 보존 metadata에서 검증하여 evidenceSources에 출처를 구분한다.
subject JSON은 기존 `check:memory-eval-run`의 admissibility 조건도 통과해야 한다.

historicalVerdict는 다음 사실을 함께 담는다.

- datasetPurposeAtRun=decision, datasetFrozen=true, scoringContract=mem-score-v3.5.
- historicalDecisionGrade=true, historicalAdmissible=true, qualityVerdict=FAIL.
- workflowConclusion=failure는 품질 gate의 exit 결과이며 inadmissible과 동의어가 아니다.
- planned/executed case는 1150, provider failure case 1은 명시 보고됐다.
- pairStatusAfterDecision=revoked, ordinal2Executed=false, ordinal2Allowed=false.
- humanDecisionBy=@mposition, humanDecisionAt=2026-09-05.

사람 결론의 저장소 출처는 `docs/ops/memory-extraction-decision-grade-run.md` §10과
`docs/ops/memory-eval-blind-review-run1.md`다. 보존 receipt는 각 출처의 repository-relative
path·당시 content commit·raw SHA-256과 metadata 관측 시각을 함께 pin한다. run 시점
snapshot에는 이후 사람 서명이 아직 없을 수 있으므로 인간 판정 문서를 evaluatedCommit에
있었다고 꾸미지 않는다. record 기준 commit A tree에서 읽은 이 두 문서를 출처로 삼는다.
원본 metadata와 source document bytes를 격리된 보관 bundle에 포함하고 sourceReceiptDigests로
결속해야 한다. artifact 만료 뒤 보존 bytes가 없다면 재검증 불가이지 wildcard 예외가 아니다.

이 예외는 과거 **완료된 증거 읽기**만 허용한다. 새로운 provider contact, run attempt 2,
ordinal 2, 새 prompt, 새 scorer로 v8 수치 덮어쓰기, pair 복권, 예산 재사용을 허용하지 않는다.
현재 v8 register와 budget 기록은 수정하지 않는다. 새 scorer로 development 진단을 하더라도
별도 산출물이며 원래 v8 verdict/contract를 replace하지 못한다.

### 6. Activation 검증과 후속 순서 (FR-3, FR-10)

승인된 후속 작업에서 다음을 **전부** 증명해야 activation_complete다.

1. C 전후 frozenFiles/raw bytes·case order/count·모든 §1 digest 동일.
2. A와 S1–S4 contract approval 및 activation approval가 검증됨.
3. 원자적 세 줄 bundle·hash chain·effective C·protected inclusion·checkpoint가 검증됨.
4. purposeAt(C)=development, purposeAt(current protected tip)=development.
5. frozen=true 상태에서도 새 decision admission 거부; v8 exact legacy read만 성공.
6. register·기존 approval·budget·prompt·release gate·memory flags가 activation 때문에 바뀌지 않음.

그 뒤에만 별도 승인된 scorer 구현·동결이 가능하다. 새 holdout은 S3 순서대로 격리 작성하고,
v9 prompt(S5)는 S1–S4 승인·scorer freeze·holdout seal 뒤 시작한다. S1·S2 문서 승인,
Git merge, CI 성공, 배포 완료 중 어느 하나도 남은 사람 승인을 자동으로 생성하지 않는다.

## Non-Functional Requirements — 비기능 조건

- NFR-1: 검증 과정의 dataset/register/flag write와 provider 호출 수는 MUST 0이다.
- NFR-2: 동일 immutable 입력 bundle의 purpose·refusal code·digest 차이는 MUST 0이다.
- NFR-3: history 일부만 확보한 상태에서 decision 허용을 반환하는 경로는 MUST 0개다.
- NFR-4: 보존 receipt 밖의 mutable API 상태에만 기대는 historical 재검증 성공은 MUST 0건이다.

Performance SLA·UI accessibility·DB indexes: N/A — 읽기 전용 Git/artifact 검증 계약이다.
history 크기나 IO 한도로 완전한 검증을 할 수 없으면 `history_unverifiable`이며 sampling을
허용하지 않는다. 비용·속도를 이유로 parent/attempt/blob 검사를 생략하지 않는다.

## Acceptance Criteria — 전환·history vector

이 절은 후속 구현의 pure verifier에 넣을 명세 입력/정답이다. 실제 ledger·서명·dataset
전환을 지금 생성하지 않는다. A는 원래 승인 commit, C는 미래 유효 introduction,
T는 C를 보존한 protected tip, V는 §5의 evaluatedCommit이라는 **기호**다.

### AC-1: Immutable whole-dataset transition (FR-1, FR-2, FR-10)

Given 1150 cases와 §1 digest·frozenFiles가 C 전후 동일하다.
When 별도 승인된 bundle C를 검증한다.
Then purposeAt(C)=development, frozen=true이고 dataset·manifest digest는 그대로다.
case 하나 수정, 순서 변경, old purpose 상수 수정은 각각 frozen_identity_changed다.
development→decision 또는 일부 case만 전환하는 payload는 invalid_transition이다.

### AC-2: 세 승인 계층 (FR-3)

Given A만 존재하거나 S1/S2만 승인됐다.
When activation을 검증한다.
Then 각각 missing_contract_approval 또는 insufficient_contract_approval다.
S1–S4가 모두 승인돼도 별도 activation 승인 없으면 missing_activation_approval다.
activation 승인 commit이 C 자신이면 approval_not_prior다.
모든 승인이 strict ancestor이고 payload digest까지 같을 때만 이 검사를 통과한다.

### AC-3: Chain tampering (FR-4, FR-5, NFR-2)

Given 유효한 세 줄 ledger가 C에 있다.
When 한 글자 수정, 줄 삭제, seq 재정렬, 4번째 receipt 삽입 또는 같은 seq 중복을 적용한다.
Then 전부 invalid_history다. JSON key 재배치도 canonical bytes 조건을 어기므로 거부한다.
typed payload object를 처음 CJSON으로 직렬화할 때의 key 순서 차이는 같은 digest를 만든다.

### AC-4: Git DAG는 복원으로 지워지지 않음 (FR-5, NFR-3)

Given C→X→Y→T에서 X가 ledger를 삭제하고 Y가 정확히 복원한다.
When T history를 검증한다.
Then history_tampered다. C의 후손 side branch에서 삭제한 뒤 merge로 복구한 경우도 같다.
C가 없는 부모와 C가 있는 부모의 정상 merge는 새 activation이 아니다.
같은 transition을 서로 독립적으로 만든 C1/C2의 합류는 divergent_activation이다.

### AC-5: Historical purpose와 current gate 분리 (FR-6, FR-9)

Given T에는 유효 activation이 있고 V의 정확한 legacy receipt가 있다.
When purposeAt(V)를 조회한다.
Then known decision/legacy_exact_run이고 historicalRead만 가능하다.
When V를 evaluatedCommit으로 새 decision admission을 요청한다.
Then dataset_development로 거절한다. T history를 못 읽으면 purpose_history_unavailable다.
frozen=true와 legacy code의 decision 상수는 refusal를 바꾸지 않는다.

### AC-6: Exact legacy tuple (FR-7, FR-8, NFR-4)

Given §5 tuple·JSON bytes·source receipt가 전부 검증됐다.
When historicalRead를 수행한다.
Then historicalDecisionGrade=true, historicalAdmissible=true, qualityVerdict=FAIL,
pairStatusAfterDecision=revoked, ordinal2Allowed=false다.
attempt=2, 다른 artifactId, 다른 JSON hash, 다른 evaluatedCommit 중 하나라도 바꾸면
legacy_subject_mismatch다. archive hash를 content hash 자리에 넣어도 거부한다.
artifact가 만료돼도 보존된 exact bytes/receipt가 있으면 재현하며, 없으면
legacy_evidence_unavailable이지 새 API 관측을 꾸며 채우지 않는다.

### AC-7: Rewritten ancestry와 cold verifier (FR-5, FR-6)

Given receipt의 approvalCommit을 merge SHA로 대체하거나 A를 squash해서 조상에서 없앴다.
When 검증한다.
Then approval_ancestry_mismatch다. signed checkpoint가 C를 가리키는데 T가 C를 포함하지
않으면 activation_ancestry_mismatch다. checkpoint 없는 새 verifier는 옛 상수를 읽어
decision으로 default하지 않고 purpose_history_unavailable을 반환한다.

### AC-8: 검증은 관측만 (FR-9, FR-10, NFR-1)

Given 거부 대상 payload·깨진 history·provider 실패가 보존된 legacy artifact가 있다.
When verifier를 실행한다.
Then 검사 과정의 provider 호출·원본 write는 0이고 refusal는 typed result다.
legacy provider failure 1건을 지우지 않으며 quality FAIL을 PASS로 고치지 않는다.

## Edge Cases — 외부 의존성의 실패

- EC-1: Git shallow clone, missing blob/parent, replace/graft → history_unverifiable (FR-5).
- EC-2: GitHub/API pagination·identity·protected tip 확정 실패 → purpose_history_unavailable; S4가 복구할 때까지 거부 (FR-6).
- EC-3: 파일 손상·줄바꿈 변환·중복 key·invalid UTF-8 → invalid_history (FR-4).
- EC-4: signature receipt 부재·서명자 불명·권한 scope 불일치 → approval_unverifiable (FR-3).
- EC-5: archive와 JSON의 연결 증거 없음, artifact 만료와 보존 bytes 없음 → legacy_evidence_unavailable (FR-7).
- EC-6: API/ref TOCTOU·force-push → trusted checkpoint와 C ancestry로 거부, 완전한 방지 보장은 S4의 신뢰 잔여로 공시 (FR-5).
- EC-7: branch 동시 activation → 최초 introduction 두 개로 divergent_activation, 자동 병합·하나 선택 금지 (FR-5).

## API Contracts — HTTP N/A, read-only verifier

HTTP endpoint: N/A — 새 API/dispatch route를 만들지 않는다. 아래는 미래 pure verifier 명세다.

```typescript
interface PurposeQuery { datasetVersion: string; atCommit: string; context: HistoryContext }
interface PurposeKnown { kind: "known"; purpose: "decision" | "development"; provenance: "legacy_exact_run" | "verified_activation"; effectiveCommit: string | null }
interface PurposeUnknown { kind: "unknown"; code: RefusalCode; evidencePaths: string[] }
interface AdmissionQuery { datasetVersion: string; evaluatedCommit: string; protectedTip: string; context: HistoryContext }
interface AdmissionResult { allowed: false; decisionGrade: false; code: RefusalCode }
interface LegacyReadQuery { subject: LegacySubject; context: HistoryContext; preservedEvidence: EvidenceBundle }
interface LegacyReadResult { verified: boolean; historicalVerdict: HistoricalVerdict | null; code: RefusalCode | null }
```

`purposeAt(PurposeQuery) → PurposeKnown | PurposeUnknown`;
`newDecisionAdmission(AdmissionQuery) → AdmissionResult`는 **succ-9 전용**이다.
미래 sealed holdout에 대한 allow는 S3/S4가 담당한다.
`historicalRead(LegacyReadQuery) → LegacyReadResult`는 실행 권한을 반환하지 않는다.
exception/IO 오류를 잡아 `allowed=true`로 바꾸는 fallback은 없다.

## Data Models — 정확한 field 의미

모든 object는 closed schema다. schema table와 본문에 없는 key, duplicate JSON key,
숫자 float, 잘못된 UTF-8을 거부한다. canonicalisation은 S1의 mem-cjson-1을 그대로 참조한다.

| Entity | Fields / types | Constraints |
|---|---|---|
| Identity | datasetVersion,schemaVersion,caseCount,datasetDigest,manifestDigest,scoringContractVersion,scoringContractDigest,subtypeDigest,frozen,originalApproval | §1 exact constants; originalApproval={approvedBy,approvedAt,approvedCommit} |
| FrozenFile | path,mode,gitBlobOid,rawSha256 | path 정렬, symlink/경로 이탈 거부; repository file만 |
| RecordEnvelope | payload:PurposePayload,recordDigest:Sha256 | §3 seq별 closed payload |
| HistoryContext | repositoryId,protectedRef,protectedTip,completeGitBundleDigest,activationCheckpoint,approvalEvidenceDigests | S4가 검증해 제공; caller self-attestation 금지 |
| ActivationCheckpoint | repositoryId,effectiveCommit,chainHeadDigest,inclusionCommit,approvalReceiptDigest,signatureReceiptDigest | 외부 보존된 신뢰 anchor, C 이전 tip으로 후퇴 불가 |
| ActivationApproval | operation,approvalCommit,contractApprovalCommit,from,to,identityDigest,genesisDigest,transitionPayloadDigest,legacySubjectDigest,allowedResolverPaths,approvedBy,approvedAt | transitionPayloadDigest는 activationApprovalCommit field를 제외한 예정 payload digest; 자기 hash 순환 금지 |
| LegacySubject | §5 Subject field 전부 | repo/run/artifact ID는 decimal string; runAttempt는 integer 1 |
| EvidenceSource | role,kind:git/github/archive/json,contentSha256,sourceCommit:string/null,path:string/null,observedAt | 어떤 field를 어느 source가 증명하는지는 §5 |
| HistoricalVerdict | datasetPurposeAtRun,datasetFrozen,scoringContract,historicalDecisionGrade,historicalAdmissible,qualityVerdict,workflowConclusion,plannedCaseCount,executedCaseCount,providerFailureCount,pairStatusAfterDecision,ordinal2Executed,ordinal2Allowed,humanDecisionBy,humanDecisionAt | §5 facts 전체, scope=historical_read_only |
| EvidenceBundle | subjectArchiveBytes,subjectJsonBytes,sourceDocuments,metadataReceipts,bundleDigest | 원본 immutable bytes 보존; hosted 재업로드 권한 아님 |
| RefusalCode | §AC·EC 및 본문의 lowercase snake_case codes | 보고하지 않은 임의 성공 default 없음 |

`transitionPayloadDigest`의 domain은 `mem-purpose-transition-intent-1`이고 제외 field는
정확히 activationApprovalCommit 하나다. 나머지 fields·prevDigest·identity·approvalCommit은
모두 서명한다. importer는 실제 activationApprovalCommit에서 그 receipt를 읽고, 실제
transition의 나머지 payload와 재계산 대조하며 그 commit이 C의 strict ancestor인지도 검사한다.
legacySubjectDigest는 `mem-purpose-legacy-subject-1` domain으로 §5 전체 subject를 결속한다.
이 intent digest는 최종 transition recordDigest와 다른 이름·domain을 유지한다.
final bundle의 seq2는 완성된 chainHeadDigest를 서명한 별도 detached inclusion receipt와도
일치해야 한다. 그 서명은 checkpoint가 가리키며 ledger 안에는 넣지 않는다.
sourceReceiptDigests에는 원본 metadata·source 문서에 대한 증거 receipt만 들어가고,
seq2 자신이나 그 detached 서명은 들어가지 않는다. 따라서 digest cycle은 없다.

DB schema·migration·삭제 정책: N/A — 이력은 append-only라 정상 삭제·rollback operation이 없다.
오류가 있으면 기존 history를 고치지 않고 inadmissible로 보존한 뒤 별도 정책 결정이 필요하다.

## Out of Scope — 이번 작성이 하지 않는 것

- OS-1: purpose ledger/receipt 파일 생성과 resolver 구현·activation — S1–S4 승인 뒤 별도 지시 대상이다.
- OS-2: scorer·dataset·manifest·register·v9 prompt·release gate·memoryExtractionEnabled·memoryInjectionEnabled 변경 — 원본 및 runtime 상태를 보존한다.
- OS-3: holdout 작성·seal·opening·materialisation — S3/S4 이후 순서다.
- OS-4: pair·예산·dispatch·provider 호출, v8 재실행·ordinal 2 — 별도 승인 없으며 legacy exception으로 허용되지 않는다.
- OS-5: 다른 legacy run의 일반 import·wildcard allowlist — D1이 요구한 단 하나의 v8 예외 밖이다.

사람 승인: **미승인**. 독립 검토는 승인 receipt가 아니다. 최종 S1/S2 문서 commit과
각 파일 SHA-256에 대한 사람의 별도 승인 뒤에도 S3/S4 및 activation 권한은 남는다.
