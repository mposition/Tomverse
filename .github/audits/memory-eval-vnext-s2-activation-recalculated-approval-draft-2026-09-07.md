# memory-eval vNext S2 activation — D/K 반영 재계산·승인 준비 초안

**Status:** DRAFT / BLOCKED_OPERATIONAL_PREREQUISITES / NOT_APPROVED
**Author:** Codex
**Date:** 2026-09-07
**Scope:** 승인된 D/K 반영과 준비 자료 재계산만. 새 계약·구현·activation 승인이 아니다.
**Branch:** codex/memory-eval-vnext-s2-activation-recalculation

## Context — 무엇이 끝났고 무엇이 남았는가

D의 서명·wire 명확화와 K의 사람 정책 수용은 완료됐다. 기존 준비안의 B-S2-01,
B-S2-02는 **계약 정의 수준에서만 해소**됐다. 실제 trust 등록·root·source proof·서명·
activation 승인·resolver·C·checkpoint는 이 패키지에 없다.
따라서 이 초안을 “실행 가능한 최종 승인 요청”으로 제출하거나 승인 칸을 채우지 않는다.

검토에 쓰인 종전 초안·JSON은 정확한 bytes로 보존하고 이번 개정본을 별도로 추가한다.
현재 준비 상태는 이 개정본을 읽되 역사적 관측·승인·검토 결과를 소급 수정하지 않는다.

| 보존한 종전 산출물 | raw SHA-256 |
|---|---|
| .github/audits/memory-eval-vnext-s2-activation-approval-draft-2026-09-07.md | 6a06a68271d827667a9d04784ea2eb74642179147bb96b107a946cfecc79a481 |
| .github/audits/evidence/memory-eval-vnext-s2-activation-package-2026-09-07.json | 06b104bf7b5ea0d7d207d55db3520d2a968a7d3a6d5bf96e8fb1e182aaa4fcc5 |

### 1. Git 기준과 승인 계보

작성 기준 M은 **19ff015112e6cf908cd8dc057ca41ace8cef4e87**이다.
[PR #1272](https://github.com/mposition/Tomverse/pull/1272)의 SHA 보존 merge commit이며,
parent는 75c667054dd6fd1b6adff1e813cf23e3ef43ca00 및 K다.
M의 tree는 K와 같고, 원격 develop도 2026-09-07T10:58:04.959Z 재조회에서 M이었다.
tracked/index clean 상태에서 이 tip을 기준으로 새 브랜치를 만들었다.

| 계층 | 원래 commit SHA | 의미 |
|---|---|---|
| A | 3f14afb29eddc243640fdb0a5a4f604646ade9f0 | decision approval; S2 approvalCommit 값 유지 |
| CA | 80842e62925c05af9450e6acc6ceb70b56f67655 | S1–S4 통합 계약 승인; contractApprovalCommit 값 유지 |
| D | 159267a80acee97da3a297c637343ea15de725f9 | 승인된 부속 명확화 bytes |
| K | 6b2465e921c6e8b99ff032a36be8ada61c0ad599 | D·네 정책·잔여에 대한 별도 명확화 승인 |
| V | 12f83ec2c388a318fe0a79d4f76bd2c0b245dcb1 | legacy run의 실제 evaluatedCommit; 재현 source 기준 |

A/CA/D/K는 M의 조상이며 D는 K의 strict ancestor다.
미래 K → activationApprovalCommit → C는 strict 선행 관계다.
K나 M을 activationApprovalCommit/C로 대용하지 않는다.

M의 정확한 headSha에 대한 develop CI 두 건은 attempt 1, completed/success로 재확인했다.

- [Admin Console E2E 34112057606](https://github.com/mposition/Tomverse/actions/runs/34112057606)
- [Credit Finance DB Integration 34112057679](https://github.com/mposition/Tomverse/actions/runs/34112057679)

이는 작성 기준 CI 확인이며, S2 operational acceptance·production 상태·trust 적합성의 증거가 아니다.

### 2. D/K의 정확한 결속

| 용도 | path (repository-relative) | raw SHA-256 |
|---|---|---|
| clarification → D | .github/audits/memory-eval-vnext-s2-activation-clarification-revised-draft-2026-09-07.md | 7ce66bb7386c5b55509b054170c1fdedc65cb505b40512823ddb282c83c3ca98 |
| clarificationApproval → K의 authoritative JSON | .github/audits/evidence/memory-eval-vnext-s2-activation-clarification-approval.json | d572d28ec77476bf39cd16685a922aaef4ca1203e92d6da3c83fc5e81d891423 |
| K의 보조 감사 기록 | .github/audits/memory-eval-vnext-s2-activation-clarification-approval-2026-09-07.md | 07216f3d4f8100bcf9693849c94cd74494974c3d045552ca97ced36ef14f9262 |
| 승인 요청 당시 bytes | .github/audits/memory-eval-vnext-s2-activation-clarification-approval-request-draft-2026-09-07.md | 787ec805301528388a08a75375bbc092bf6388625b292c60bb7421ae0f05cd67 |

K의 decision=yes, approvedBy=mposition, approvedAt=2026-09-07은 **D 명확화 승인**이다.
실제 activation 승인자·승인일은 여전히 null이며 K의 값을 복사하지 않는다.
K가 수용한 정책은 ed25519_required, trustBootstrapBeforeActivation=true,
exact_15_roles_with_closed_proofs, separate_K다.

미래 ActivationAuthorization의 clarification/clarificationApproval에는 위 D/K의
각 {commit,path,rawSha256}만 넣는다. K의 Markdown hash나 요청 초안 hash를
authoritative JSON의 rawSha256 대신 넣지 않는다.
D의 Draft/pending 표시는 작성 당시 bytes로 남기며 현재 승인은 별도 K로 읽는다.
원결정 §13 공란과 기존 12개 승인 관련 문서 hash도 보존한다.

## Functional Requirements — 이번 준비 작업의 대응

아래 FR/AC는 **이 재계산 작업의 검증 항목**이며 S1–S4/D의 규범 추가·수정이 아니다.

- FR-1: M 및 A/CA/D/K의 exact bytes·계보를 대조하고, K와 실제 activation 승인을 분리한다.
- FR-2: V의 historical closure·case·manifest와 S2 부록 A를 재계산하며 승인된 canonical digest를 대조한다.
- FR-3: D의 exact 15-role·proof kind 목록과 준비된 raw source를 1:1 대응하고, 미생성 proof/서명을 완료로 기록하지 않는다.
- FR-4: 기존 승인 조건·N-1–N-3·실행 제한을 유지하고 후속 승인 경계를 명시한다.

### 3. 재계산 결과 — bytes와 의미를 분리

V의 lib/memoryEvalSucc9.ts에서 type-only import까지 추적한 repository dependency는
121개다. 원래 dataset 승인 audit 한 개를 더한 historicalFrozenFiles는 122개,
S2 부록 A의 forwardFrozenFiles는 정확히 109개다. historical-only 13개를
전방 동결 목록에 추가하지 않는다. V와 M에서 122개 파일의 mode·blob OID·raw SHA가 같고,
109개 전방 목록의 drift도 0이다.

case 1,150개를 V source에서 재구성하고 buildSucc9Manifest와 pinned manifest를 대조했다.
Node v22.22.2 및 TypeScript 6.0.3의 실행 파일 hash, V lockfile의 TS version/integrity를
결속했다. 이는 로컬 읽기 전용 재계산이지 network 차단 재현이나 hermetic runtime 인증이 아니다.

| digest | domain | 재계산 SHA-256 |
|---|---|---|
| identityDigest | mem-purpose-identity-1 | b2fba31f7e1669d75dbc19f576f37f7a5ab0f974a2f5e56107a0cdcd14290567 |
| frozenFilesDigest | mem-purpose-frozen-files-1 | 7d64cf9be1eed4abab2ec07113304552f58009d81c0279a9a111a8e421483b50 |
| forwardFrozenFilesDigest | mem-purpose-forward-files-1 | 5c2b7ee0c21747c6689cee3f911d1980c3fc317f7b44de6bfe9d84847e9a6900 |
| genesisDigest | mem-purpose-record-1 | a6917fe2278296c87bf199f7ee6bcb6cdb568a851789e20e7cda01694602c681 |
| transitionPayloadDigest | mem-purpose-transition-intent-1 | b28be62b1b598b34fdc19cd10f3e74a881f4d117e1f0140a8c39ce0d21b67ae2 |
| legacySubjectDigest | mem-purpose-legacy-subject-1 | 69a2944927ee9a09bf08706ca65d060b66dbe01dbc45fd19d70f4e3090b07d76 |

여섯 값은 종전 값과 동일하다. LegacySubject는 이제 D가 승인한 정확한 23-key
object와 equality이며 mem-cjson-1 bytes 길이는 1,437이다. 더는 “wire key 승인 대기”가
아니지만, 이 digest의 확정은 실제 activation 승인이 아니다.

H(domain,x)는 SHA256(UTF8(domain + LF) || CJSON(x))다. CJSON에는 최종 LF가 없고,
Git 파일의 raw hash에는 실제 파일의 LF가 포함된다. blob OID·raw SHA·domain digest는 별개다.
transitionPayloadDigest는 seq1 예정 payload에서 **activationApprovalCommit 하나만 제외**한다.
D/K를 seq1이나 S2 ActivationApproval에 새 field로 넣지 않는다. 기존 서명 body를 바꾸지 않고
D의 외부 authorization wrapper에서 결속한다.

### 4. Legacy 원본과 15-role 준비 상태

archive는 45,339 bytes,
SHA-256 8932f1ae3a48effee8f099c2287a290e1cd02c88f1bf4b2ae5869ef60662f888이다.
유일 JSON entry mem-eval-run1.json은 923,959 bytes,
SHA-256 09832eab460e3efc5e1d6998ca13f1100490ac9a5123dad3acbd075ffc3126c0이다.
metadata.size_in_bytes를 ZIP의 실제 byteLength로 취급하지 않는다.

아래 raw source 15개는 기존 관측 시각과 원본 bytes를 유지한 채 재대조했다.
**완성 proof wrapper 0개, 서명 0개, 운영 SourceEvidenceReceipt 0개**다.
각 role의 contentSha256·sourceCommit·path·observedAt·byteLength는 동반 JSON에 있다.

| role | D가 요구하는 유일한 proof kind 집합 |
|---|---|
| historical_admissibility_checker | checker_replay, git_history |
| historical_checker_dependency | git_history |
| historical_dataset_approval | git_history |
| historical_dataset_entry | git_history |
| historical_lockfile | git_history |
| historical_package_script | git_history |
| historical_prompt | git_history |
| historical_tsconfig | git_history |
| human_blind_review | git_history |
| human_final_decision | git_history |
| legacy_artifact | github_capture |
| legacy_run_attempt | github_capture |
| repository | github_capture |
| subject_archive | artifact_entry |
| subject_manifest_model_prompt | artifact_entry |

10개 Git role은 동일 git_history BlobRef를 공유하고 checker_replay도 그것을 참조한다.
subject 두 role은 동일 artifact_entry를 공유한다. github_capture는 세 endpoint별로 다르다.
raw source hash를 sourceReceiptDigests[].receiptDigest에 넣지 않는다.
그 digest는 signatureReceiptDigest가 포함된 **완성 SourceEvidenceReceipt**의 domain hash다.

register는 16번째 role이 아니라 GitHistoryProof의 필수 registerFile이다.
V의 lib/memoryExtractionEvalRegister.ts를 다시 읽어 model/prompt/bound tuple을 대조했다.
mode=100644, blob OID=ce95b46c19f0968d406c93d1ecf8bdf5841768ef,
raw SHA-256=7cb86ea87adb707b649b7f377884ed823fb23f3aa84778b12a2db2ce89c477ca다.
V의 해당 pair는 candidate/evaluation=null이며 A의 나중 FAIL/revoked와 다른 시점의 사실이다.
JSON manifest가 modelId/promptVersion의 직접 출처이고 register는 교차 검증 출처다.
V의 candidate를 A의 revoked로 덮어쓰거나 반대로 해석하지 않는다.

기존 snapshot ZIP 129개 entry와 A의 사람 판정 원문 두 entry를 Git blob에 재대조했다.
그 ZIP은 register가 없고 **native Git bundle이 아니다**. 이 재계산에서 register의
hash를 적었다고 완전한 graph/보관/복구 검증이나 GitHistoryProof가 완성되지 않는다.

과거 check:memory-eval-run의 absolute-path 로그는 종전 준비 실행의 기록으로만 보존한다.
이번에는 D의 고정 .s2-proof-input 경로·network 차단·독립 replay를 실행하지 않았다.
D는 V package script와 원본 input, 실제 runtime·stdout/stderr·exit 및 독립 재현을 요구한다.
이전 exit 0 로그를 새 CheckerReplayProof로 소급 인증하지 않는다.
historicalAdmissible=true와 품질 FAIL/workflow failure/pair revoked/ordinal2 미승인은 그대로다.

## Non-Functional Requirements — 변경·권한·관측 경계

- NFR-1: 종전 초안·JSON, 승인 원문, 원본 source/evidence bytes를 수정하지 않는다.
- NFR-2: UTF-8 fatal decoding·BOM/CRLF/끝 공백 부재와 package script 기준선 대조를 별도 검사한다.
- NFR-3: 원 관측 시각, 재대조 시각, 미래 서명 issuedAt을 혼용하지 않는다.
- NFR-4: private package 경로·key·서명·TrustAnchor·미래 commit·receipt digest를 추정해 채우지 않는다.

## API Contracts — 실행 기능 N/A, 승인 구조만 참조

새 HTTP/CLI/provider 기능은 N/A다. 이 JSON은 사람이 읽는 **준비 schema v2**이며,
S2/D가 받는 operational receipt가 아니다. null은 준비의 미완성을 나타낼 뿐,
closed wire schema에서 필수 null을 허용하도록 계약을 바꾸는 것이 아니다.

미래 authoritative 경로는
.github/audits/evidence/memory-eval-vnext-s2-activation-authorization.json이다.
이번에 만들지 않았다. 완성 7-field wrapper에서 signatureReceiptDigest만 제외한
mem-purpose-activation-approval-1 body에 실제 등록된 사람 approver가 서명해야 한다.
그 사람 approvedBy와 signerId는 @ 없는 canonical handle의 등록 문자열과 exact 일치한다.
역사 @mposition은 바꾸지 않는다. K 승인자 값으로 activation 서명을 대체하지 않는다.

미래 SourceEvidenceReceipt는 등록된 importer가 s2_source_evidence로 서명하고,
inclusion body는 s2_activation_inclusion으로 서명한다. 기존 S3 SignatureReceipt와
pure Ed25519 형식은 바꾸지 않는다. D/K와 세 purpose/role/epoch 권한은 실제 사람
bootstrap 원문·TrustAnchor.registrationReceipt·S4 trustPolicyDigest에 먼저 결속돼야 한다.

## Data Models — 준비 JSON과 미정 값

동반 파일: .github/audits/evidence/memory-eval-vnext-s2-activation-recalculated-package-2026-09-07.json
raw SHA-256: **4220454017eb8886e53d66c532d4da1a3e75d2e759036742b1c84eef1245b23f**

JSON은 122/109개 FrozenFile 전체, 1,150 caseIds, 기존 12문서 계보, D/K GitFileRefs,
예정 genesis/transition, 승인된 LegacySubject, 15-role source 계획, 원본 보존 목록,
기준선 및 이번 검사 결과를 담는다. 이 Markdown hash를 JSON 안에 넣어 순환시키지 않는다.

approvalCandidate는 S2의 15-field body 예정본이며 approvedBy/approvedAt=null이다.
allowedResolverPaths 9개도 기존 **미승인 제안**으로 유지한다. 이 목록은 trust/control-plane P의
전체 구현 범위가 아니며, 필요한 범위를 이 초안에서 자동 승인·추가하지 않는다.

다음 값은 만들지 않거나 null로 남긴다.

- actual activationApprovalCommit, C/effectiveCommit, inclusionCommit
- 실제 승인 body가 있어야 계산할 activationApprovalContentDigest 및 서명까지 있어야 계산할 완성 authorization receipt digest
- sourceReceiptDigests, 실제 seq1/seq2 recordDigest, chainHeadDigest
- inclusion signature, ActivationCheckpoint digest, S4 external root

activationApprovalContentDigest도 승인자/일자 등 전체 승인 body가 없으므로 확정하지 않는다.
승인 후에도 signatureReceiptDigest가 있어야 완성 authorization receipt digest를 계산한다.
SourceEvidenceReceipt와 authorization은 서로의 hash를 요구하지 않지만 둘 다 C보다 먼저 필요하다.

## Acceptance Criteria — 이번 재계산의 검증 결과

### AC-1: 기준과 승인 bytes (FR-1)

**Given** 승인된 D/K와 M.
**When** Git/remote/CI 및 원문 raw bytes를 대조한다.
**Then** A/CA/D/K 조상·M CI 성공·기존 12문서와 D/K 4문서 보존을 확인한다.

### AC-2: 역사 재계산 (FR-2)

**Given** V source와 S2 부록 A.
**When** closure/cases/manifest/CJSON을 재계산한다.
**Then** 122/109/1,150과 여섯 digest가 같고 D의 23-key LegacySubject와 일치한다.

### AC-3: 증거 역할과 미완성 proof (FR-3)

**Given** D의 15-role 표와 보존 bytes.
**When** role/kind/locator/hash 및 register를 대조한다.
**Then** 누락·추가 role 없이 대응하고 운영 proof·서명 완료 수는 0으로 남는다.

### AC-4: 남은 승인 경계 (FR-4)

**Given** K가 수용한 잔여.
**When** 실행 준비도를 판정한다.
**Then** 다음 선행조건이 남아 activationApproved=false이며 승인 요청을 ready로 표시하지 않는다.

### AC-5: 변경 보존과 검사 (NFR-1, NFR-2)

**Given** tracked clean M 기준선.
**When** 변경 후 검사한다.
**Then** 기존 untracked bytes를 보존하고 새 파일은 이 MD/JSON 둘뿐이며 신규 검사 실패가 없다.

현재 결과: 재계산 PASS, 운영 activation readiness BLOCKED, 사람 activation 승인 NOT_APPROVED.
최종 파일·검사 대조 결과는 동반 JSON의 preparationVerification에 기록한다.
check:encoding:strict, check:policy-section-references, check:release-records,
check:memory-eval-succ9, check:memory-extraction-eval, check:memory-eval-freeze는 기준선에서 통과했다.
변경 후 같은 package script 7개를 재실행했으며 출력·종료값이 기준선과 모두 동일했다.
check:doc-references는 기준선의 Windows 경로 관련 8건으로 실패했고 이름별로 대조했다.
저장소 script의 신규 실패는 0건이다. 별도 strict UTF-8·raw hash·D/K wire·role 대조와
git diff --check 및 두 untracked 파일의 no-index 공백 검사도 통과했다.

스킬의 보조 형식 검사는 90/100, 오류 0·경고 5·정보 1, exit 1이었다.
경고는 RFC 키워드, EC 번호, HTTP method/path, data-model 표, OS 번호에 관한 템플릿 요구다.
준비 기록을 새 규범/API spec으로 바꾸거나 승인된 잔여 ID를 고쳐 그 경고를 지우지 않는다.
이 점수와 형식 진단은 계약 승인·운영 적합성·독립 검토 결과가 아니다.

8건은 app/layout.tsx를 참조하는 lib\\documentLanguage.ts, app\\[locale]\\layout.tsx,
scripts\\security-regression-check.mjs, tests\\e2e\\ssr-root-language.spec.ts의 missing 4건과,
같은 네 POSIX 경로의 unused historical 4건이다. raw 실패 이름은 JSON에 남긴다.
audits가 제외되는 doc/policy 검사의 통과를 이 문서의 의미·승인 검증으로 대용하지 않는다.
전체 앱 test/build, D의 운영 acceptance test와 독립 proof replay는 이번에 실행하지 않는다.

## Edge Cases — 수용된 잔여는 면제가 아님

N-1–N-3 namespace는 s2_clarification_confirmation_2026_09_07,
보고서 raw SHA-256은 52ea1b94d745142eef9347aff9e831e0c8364cc83014ec1773571471d1f14b38이다.
CONFIRMED_WITH_WARNINGS 및 확인 검토 1/1 소진을 유지한다. 이번 개정 패키지 자체가
Claude 독립 검토를 받았다는 주장은 하지 않는다. 새 확인 검토 루프를 시작하지 않는다.

- N-1: ApiCapture에는 요청 header가 없고 wrapper.apiVersion 의미에 잔여가 있다.
  종전 준비 로그에 적힌 요청 옵션과 응답 version을 보존하되, 이를 독립 요청 증명으로
  승격하거나 검토자의 importer-attest 해석을 채택하지 않는다.
- N-2: V checker는 일반적으로 8번째 rule에 NOTE를 낼 수 있다.
  exact subject는 실제 독립 재현에서 **8개 모두 OK**여야 한다. exit 0만으로 완화하지 않는다.
- N-3: ReplayEnvironment 세 field는 network 차단 증거가 아니다. 실제 차단 조건과 관측이
  필요하며 runtime/self-attestation을 증거로 대체하거나 EnvironmentAttestation을 신설하지 않는다.

실행 판단에 영향을 주는 모호성 또는 입증되지 않은 필수 조건이 남으면 실행을 중단하고
별도 지시를 구한다. 기존 A/CA의 모든 승인 조건·잔여도 계속 적용한다.

## Out of Scope — 후속 단계와 명시적 중단선

| 남은 단계 | 아직 필요한 것 |
|---|---|
| OP-TRUST | 실제 사람 key/role/epoch/D/K 등록, ProtectionPolicy·bypass disclosure 승인 |
| OP-P-ROOT | 별도 구현 권한의 control-plane P → descriptor → genesis → signed mirror/checkpoint → 외부 ApprovedTrustRoot 등록 |
| OP-CUSTODY | native A/V Git graph, 원본 leaf 보존, 분리 보관·key backup·복구 검증 |
| OP-SOURCES | closed proofs, 15개 importer 서명 source receipt, network 차단 독립 replay; N-1/N-3 실행 영향 해소 |
| OP-ACTIVATION-APPROVAL | 최종 scope/digest 대상 확정, 실제 사람 승인·Ed25519 서명·K 뒤의 별도 승인 commit |
| OP-RESOLVER | 명시적 범위 승인 뒤 resolver 구현과 S2/D offline acceptance 검증 |
| OP-C-INCLUSION | atomic 세 줄 C, SHA 보존 protected merge·CI·detached inclusion 서명·외부 checkpoint 검증 |

표는 필요한 의존성의 목록이며 이번 실행 권한이 아니다.
가장 먼저 필요한 후속 범위는 **S3/S4 bootstrap·control-plane P와 신뢰 등록의 준비 범위 확정**이다.
그 범위의 사람 결정·구현 권한 없이 지금 activation 승인/전환으로 건너뛰지 않는다.

S4 순서는 genesis/root → S2 전환 검증 → scorer F 동결 → holdout 작성/검수/seal →
S5 → E/ExecutionClosure → pair 승인/Programme이다. S1–S4 승인이 있다고 S5를 먼저 시작하지 않는다.

이번 작업에서는 아래 항목을 변경·생성·실행하지 않는다.

- scorer/resolver/validator/controller/custody/importer 구현, test/workflow/DB 변경
- dataset·manifest·register·prompt·기존 승인 bytes 변경, succ-9 purpose 전환
- 운영 ledger/authorization/proof/서명/key/TrustAnchor/checkpoint·외부 보관소 생성
- holdout 작성·봉인·개봉, S5/v9 작성·활성화, pair 승인/복구, ordinal 2
- 예산·dispatch·provider probe·유료 호출·production 자격증명·GitHub protection 변경
- release gate·memoryExtractionEnabled·memoryInjectionEnabled 변경
- stage/commit/push/PR/ready/auto-merge/병합/배포

spec-driven-workflow는 이 준비 작업의 FR/AC 대응과 미충족 조건 표시를 위해 사용했다.
새 기술 spec·test skeleton·구현을 생성하는 단계로 확장하지 않았다.
