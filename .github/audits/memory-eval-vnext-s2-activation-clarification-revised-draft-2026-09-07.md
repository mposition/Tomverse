# memory-eval vNext S2 activation — 서명·wire 계약 명확화안

**Author:** Codex
**Date:** 2026-09-07
**Status:** Draft — F-1–F-6 반영 수정본, 확인 검토·사람 정책 승인 대기
**Reviewers:** Claude 확인 검토 최대 1회 예정; 최종 판정·서명은 사람
**Scope:** B-S2-01 / B-S2-02만. 기존 승인 bytes 보존, 실행 권한 없음.

## Context — 왜 별도 명확화가 필요한가

S2 activation 준비에서 원문·기존 승인·historical 122개와 forward 109개 파일·1,150 cases의
일치는 확인했지만, 실행 가능한 closed schema를 만들려면 두 연결을 더 명시해야 했다.
S2의 detached inclusion signature가 S3/S4의 어떤 purpose·role·body를 뜻하는지, 그리고
LegacySubject 표의 설명형 label과 sourceReceiptDigests가 정확히 어떤 JSON bytes인지다.
최초 독립 검토는 두 공백의 실재를 확인하고 PASS_WITH_WARNINGS(0 P1 / 2 P2 / 4 P3)로
판정했다. 이 수정본은 F-1–F-6에 대한 작성자 대응안이며, closure 확인이나 기존 승인 무효
판정이 아니다. 최초 대상 500줄의 bytes는 별도 원본 파일에 그대로 보존한다.

이 문서는 명확화에 필요한 **새 규범 제안**이다. 단순 오탈자 정정으로 포장하지 않는다.
새 purpose 3개, source receipt 형식, 승인·서명 연결 wrapper를 제안하므로 별도 검토와 사람의
부속 계약 승인이 필요하다. 기존 S1–S4·원결정·통합 승인 원문은 수정하지 않는다.
과거 사람 승인에 암호 서명이 있었던 것으로 소급하지 않고 기존 조건·잔여도 면제하지 않는다.

기준 commit은 75c667054dd6fd1b6adff1e813cf23e3ef43ca00이다.
A = 3f14afb29eddc243640fdb0a5a4f604646ade9f0,
CA = 80842e62925c05af9450e6acc6ceb70b56f67655,
V = 12f83ec2c388a318fe0a79d4f76bd2c0b245dcb1이다.
A는 decision approval, CA는 기존 S1–S4 통합 approval, V는 역사 snapshot이다.
이 셋을 새 부속 계약 승인 commit으로 대체하지 않는다.

### 고정된 규범 원문과 적용 지점

| 원문 | raw SHA-256 | 영향 구간 |
|---|---|---|
| S1 scoring contract 2026-09-06 | 393497a5acbe7ee47af6947a84204eac7723fdd973bf30afad79c812da4db0e7 | lines 408–420: CJSON·raw/domain hash 구분, 변경 없음 |
| S2 purpose contract 2026-09-06 | e9a6a086be32e4d12df776015959c7c95be5185af7dc635403e8cd6689f4baa5 | lines 104–156, 208–285, 434–477: 승인·legacy wire·checkpoint 연결 |
| S3 holdout contract 2026-09-07 | 66a29c01dd5e2d099817ee799afc960f090e93f900be53b546b8b73f4d3b3d05 | lines 304–315, 616–630, 666–678: 기존 envelope 유지, purpose 추가 제안 |
| S4 provenance contract 2026-09-07 | e7bc98a98a6e03b31403061312e5c6abab10e7e27456f1077d3a68362ede67bb | lines 61–67, 95–114, 686–695, 753–788: trust binding·역할 매핑 |

파일 이름은 각각 .github/audits/memory-eval-vnext-s1-scoring-contract-2026-09-06.md,
memory-eval-vnext-s2-purpose-contract-2026-09-06.md,
memory-eval-vnext-s3-holdout-contract-2026-09-07.md,
memory-eval-vnext-s4-provenance-contract-2026-09-07.md이며 모두 같은 audits 디렉터리다.
S1/S2 문서 commit은 fa682cc2209fc5b0a9ebd994aa626d00997b0359,
S3/S4는 4d8a7c317b570e0c30fc5a05438cb7cc78354039다.

### 별도 승인 계층 K — 기존 CA를 고치지 않음

미래 이 문서의 고정 commit을 D, 사람의 명확화 승인 receipt commit을 K라고 부른다.
K에는 Data Models의 ClarificationApproval을 아래 고정 경로의 canonical JSON으로 보존한다.
실제 사람의 승인 발언과 raw document hash를 결속하고, 승인 없이 yes를 만들지 않는다.
K.repositoryId는 "1289709524"로 고정하며, 단독 K 검증에서도 외부에서 검증된 repository
identity와 exact 대조한다. K 자기 선언·repository 이름·caller 입력만으로 귀속을 인정하지 않는다.

.github/audits/evidence/memory-eval-vnext-s2-activation-clarification-approval.json

D는 K의 strict ancestor, CA는 K의 ancestor이며 K는 activationApprovalCommit의 strict
ancestor여야 한다. A·CA·K·activationApprovalCommit은 C의 조상이고 마지막 것은 strict
ancestor다. K 자신을 K receipt body에 넣지 않는다. 이 추가 계층은 **부속 계약 승인**이지
S2 activation 승인이 아니다. A·CA·기존 partial receipt의 효력 범위는 바꾸지 않는다.

K와 문서 D의 exact GitFileRef는 미래 사람 bootstrap 등록 원문에도 함께 고정한다.
그 등록은 아래 purpose→role 3개와 해당 signerId/keyId/trustEpoch의 허용을 명시해야 한다.
검증된 TrustAnchor.registrationReceipt 및 S4 trustPolicyDigest가 이 등록을 결속해야 하며,
body의 K와 bootstrap의 K가 다르면 거부한다. caller가 준 policy나 key는 authority가 아니다.
ProtocolDescriptor.specifications의 S3/S4 두 snapshot이나 S1 descriptor 배열에 이 문서를
몰래 추가하지 않는다. 이 부속 규범은 별도 K와 등록 원문을 통해 명시적으로 결속한다.

### F-2 정책 선택 — 아직 승인되지 않음

사람 approver에게 등록된 Ed25519 key로 activation authorization을 서명하게 하는 것은
기존 S2의 plain 사람 receipt에 없던 **새 정책**이다. 현재 상태는 **pending human decision**이다.
이 문서의 FR-5·서명 표·AC는 이 정책을 택할 경우의 규범 제안이지 이미 부여된 권한이 아니다.

K의 policyAcceptance는 정확히 다음 네 항목을 사람의 실제 발언으로 수용한 경우에만 기록한다.
문서 일반 승인, 과거 A/CA, Claude의 기술 검토, 또는 에이전트의 기본값으로 채우지 않는다.

| Field | 수용할 정책 값 | 사람이 수용하는 내용 |
|---|---|---|
| activationApproverSignature | ed25519_required | 실제 activation 사람 approver가 등록 key/epoch로 wrapper를 서명하며 key 보관·등록 책임이 선행됨 |
| trustBootstrapBeforeActivation | true | 새 purpose 3개·D/K·역할을 bootstrap에서 결속하고 S4 trust root를 activation 전에 준비 |
| sourceEvidenceProfile | exact_15_roles_with_closed_proofs | 아래 15-role 및 closed proof·register 교차 검증 profile 수용 |
| clarificationApprovalLayer | separate_K | 기존 CA를 바꾸지 않고 D를 승인한 별도 K를 추가 |

위 네 field는 성공한 K의 schema만 정의한다. 지금 true/yes를 담은 실제 receipt를 생성하지 않는다.
형식이 유효해도 실제 사람의 수용 누락·다른 선택은 approval_unverifiable이며 서명 요구를
묵시적으로 끄지 않는다. 필수 field 자체의 누락·잘못된 JSON type은 invalid_history다.
사람이 **plain receipt + importer 서명만**을 택하면 이 수정본은 그 대안을 승인한 문서가 아니다.
ActivationAuthorization·approvalReceiptDigest·role·수용 기준을 다시 설계하고 별도 지시를
받아야 한다. 그런 변경을 이번 확인 검토 안에서 자동으로 선택·구현하지 않는다.

## Functional Requirements — 규범 제안

- FR-1: verifier는 위 고정 원문·A·CA, 별도 D/K 승인 계보, K.repositoryId와 명시적
  policyAcceptance 네 항목을 MUST 검증한다.
  본 초안이나 기존 통합 승인만으로 새 purpose를 허용해서는 MUST NOT 된다.
- FR-2: LegacySubject는 Data Models의 정확한 key·type·상수만 MUST 허용한다.
  alias, 생략, 추가 key, 숫자 ID, promptVersion=8 변환은 MUST NOT 허용한다.
- FR-3: sourceReceiptDigests는 정확히 {role,receiptDigest} 배열을 MUST 사용한다.
  role 정렬·고유성·15개 역할의 전수 대응을 MUST 확인한다.
- FR-4: SourceEvidenceReceipt는 exact 원본 bytes와 아래 closed proof·role별 필수 집합을
  MUST 결속한다. register 교차 검증·historical checker 재현을 MUST 검증한다.
  승인된 importer의 s2_source_evidence 서명을 MUST 요구하며 사람 verdict를 만들어서는 MUST NOT 된다.
- FR-5: 실제 activation 사람 승인은 S2 ActivationApproval 전체와 D/K를 묶은
  ActivationAuthorization의 s2_activation_approval 서명으로 MUST 결속한다.
- FR-6: S2 ActivationCheckpoint의 첫 다섯 field를 s2_activation_inclusion 서명으로
  MUST 결속한다. inclusionCommit은 C와 다른 SHA 보존 protected merge commit이어야 MUST 한다.
  이 서명은 최종 seq2 chainHead와 그 protected inclusion 이후에만 MUST 생성한다.
- FR-7: 모든 signature는 S3 envelope·pure Ed25519·trust epoch 규칙을 MUST 승계한다.
  purpose와 role은 아래 세 쌍 이외에 MUST NOT 추론·대체한다.
  새 사람 승인 approvedBy/signerId는 아래 ApproverId 규칙으로 MUST exact 대조한다.
- FR-8: raw source hash·body digest·완성 receipt digest·SignatureReceipt digest를
  MUST 구분하고 Data Models의 domain을 MUST 사용한다.
- FR-9: 서명/receipt/DAG/checkpoint 누락은 S2의 기존 typed refusal로 MUST 거부한다.
  current admission을 decision으로 default하거나 success로 복구해서는 MUST NOT 된다.
- FR-10: C의 세 줄·기존 payload field·109개 전방 목록·legacy FAIL·revoked는 MUST 보존한다.
  이 부속 계약을 이유로 ledger의 네 번째 줄이나 source role wildcard를 만들어서는 MUST NOT 된다.
- FR-11: 명확화 승인 후 activation 패키지를 재계산하고 별도 사람 실행 승인을 MUST 받아야 한다.
  이 문서의 작성·검토·commit·merge만으로 구현 또는 activation을 시작해서는 MUST NOT 된다.

### B-S2-01: purpose·서명자·서명 내용

| 새 purpose | 허용 role | contentDigest 대상 |
|---|---|---|
| s2_activation_approval | 실제 사람 approver | ActivationAuthorization에서 signatureReceiptDigest만 제외 |
| s2_source_evidence | 등록된 importer | SourceEvidenceReceipt에서 signatureReceiptDigest만 제외 |
| s2_activation_inclusion | 등록된 importer | S2 ActivationCheckpoint에서 signatureReceiptDigest만 제외 |

이 표는 S3의 closed purpose 목록과 S4의 역할 매핑에 대한 **명시적 추가 제안**이다.
기존 provenance_checkpoint, technical_closure, dispatch_approval 등을 재사용하지 않는다.
importer가 controller/custodian 권한을 얻거나, 기계 서명이 사람 승인으로 바뀌지 않는다.
한 사람이 여러 역할을 맡더라도 각각의 등록·purpose 권한을 검증하며 역할을 생략하지 않는다.

SignatureReceipt는 기존 {payload,signatureBase64} 그대로다.
payload의 정확한 field는 schemaVersion=1, purpose, signerId, keyId, trustEpoch,
contentDigest, issuedAt이다. message는 UTF8("mem-signature-1\n") || CJSON(payload)다.
signatureReceiptDigest는 기존 mem-signature-receipt-1 domain으로 완성 SignatureReceipt를
hash한다. signature bytes=64, public key bytes=32와 pure Ed25519 조건은 변경하지 않는다.
primitive의 근거는 [RFC 8032의 Ed25519 정의](https://www.rfc-editor.org/rfc/rfc8032.html#section-5.1)이며,
이 RFC가 프로젝트 purpose·사람 승인·API 사실의 신뢰성을 보증하는 것은 아니다.

### ActivationAuthorization과 checkpoint 연결

activationApprovalCommit에 실제 승인 receipt를 담는 유일한 경로를 다음으로 제안한다.

.github/audits/evidence/memory-eval-vnext-s2-activation-authorization.json

그 파일은 완성 ActivationAuthorization의 CJSON bytes + LF이며 BOM·CRLF·추가 문서·대체
JSON block은 허용하지 않는다. 내부 approval은 S2 ActivationApproval **그대로**다.
wrapper의 signatureReceiptDigest만 제외한 body를 사람 approver가 서명한다.
서명자의 signerId는 approval.approvedBy와 exact 일치하고, 그 사람의 실제 승인 증거와
등록된 trust epoch를 확인한다. issuedAt은 실제 서명 시각이지 과거 승인일로 소급한 시각이 아니다.

새 K.approvedBy, 새 ActivationApproval.approvedBy, 그 activation 서명의 signerId 및
그 approver의 신규 trust 등록 signerId는 **@ 없는 canonical handle**인 ApproverId를 쓴다.
이 부속 계약의 로컬 문법은 ^[A-Za-z0-9][A-Za-z0-9-]{0,38}$ 이며 등록 문자열과 case-sensitive
exact 일치해야 한다. 이번 승인자의 표기는 mposition이다. @ 제거·소문자화·alias 변환을
검증 중 수행하지 않는다. 기존 Identity.originalApproval.approvedBy와
HistoricalVerdict.humanDecisionBy의 @mposition은 역사 bytes 그대로 두며 이 새 문법을 소급
적용하지 않는다. importer 등 다른 역할 전체의 명명 규칙을 재정의하는 조항도 아니다.

S2 ActivationCheckpoint.approvalReceiptDigest는 **완성 ActivationAuthorization**의
mem-purpose-activation-authorization-receipt-1 digest를 뜻한다. human Markdown raw SHA나
내부 approval body hash, SignatureReceipt digest를 이 칸에 대신 넣지 않는다.
완성 wrapper에는 먼저 생성된 서명의 digest가 포함되므로 그 서명 identity까지 결속한다.

S2 detached inclusion receipt는 별도의 네 번째 ledger record가 아니라, 아래
activation inclusion body를 서명한 S3 SignatureReceipt **그 자체**로 정의한다.
ActivationCheckpoint.signatureReceiptDigest가 정확히 그 서명을 가리킨다.

activation inclusion body = {repositoryId,effectiveCommit,chainHeadDigest,inclusionCommit,approvalReceiptDigest}

body의 repositoryId=1289709524, effectiveCommit=C, chainHeadDigest=완성 seq2 recordDigest,
inclusionCommit=원 SHA를 보존하여 C를 포함한 develop merge commit이다.
정확히 inclusionCommit ≠ C이고 C는 inclusionCommit의 strict ancestor이며 inclusionCommit은
둘 이상의 parent를 가진 실제 merge commit이어야 한다. S4의 protected repository/ref 및
관측 검증도 별도로 통과해야 한다. C를 직접 push/fast-forward한 inclusionCommit=C,
squash/rebase로 원 C가 조상에서 사라진 경우는 activation_complete가 될 수 없다.
parent 수만 맞춘 임의 commit도 protected inclusion 증거를 대신하지 못한다.
approvalReceiptDigest는 C의 seq1.activationApprovalCommit에서 읽은 위 완성 wrapper와 일치한다.
S4가 검증한 repository/ref·protected inclusion·complete graph·외부 trust root가 모두 필요하다.
서명만 검증하고 이 관측·DAG 검증을 생략하지 않는다.

S3 SealEvidence.activationCheckpointDigest 등에서 참조할 **완성 여섯 field checkpoint**의
digest는 mem-purpose-activation-checkpoint-1이다. 서명을 만들기 위한 다섯 field body의
mem-purpose-activation-inclusion-1과 구분한다. S4 journal Checkpoint는 별도 타입이며 그대로다.

### 생성 순서와 순환 금지

아래 화살표는 앞 산출물이 먼저 존재해야 한다는 뜻이며 이번 턴에 실행하는 계획이 아니다.

D → 사람 명확화 receipt K → 승인된 trust 등록·S4 root 준비
→ source bytes/proof → source body 서명 → 완성 source receipt
→ activation 사람 승인 body 서명 → 완성 authorization → activationApprovalCommit
→ 실제 세 줄 C → SHA 보존 develop inclusion
→ inclusion body 서명 → 완성 ActivationCheckpoint → 외부 보관·검증

source receipt와 authorization 사이에는 hash 의존성이 없다. 둘 모두 C보다 먼저 확정한다.
세 줄은 seq0 → activationApprovalCommit을 넣은 seq1 → 완성 source receipts를 넣은 seq2다.
seq2에는 자기 recordDigest·자기 서명·inclusion signature·checkpoint가 들어가지 않는다.
C 자신, inclusion commit, 이 문서 D 자신의 SHA도 자신의 bytes에 쓰지 않는다.
외부 checkpoint가 사라졌다고 pre-activation 상태로 돌아가지 않는다.

### B-S2-02: LegacySubject의 정확한 wire object

다음 object가 S2 §5의 모든 subject field에 대한 단 하나의 key mapping이다.
이 부속 계약이 승인되기 전에는 후보이고, 원결정·dataset identity를 수정하지 않는다.
repositoryId/runId/subjectArtifactId는 decimal string, runAttempt/runOrdinal은 정수다.
dataset은 datasetVersion 문자열이 아니라 S2 Identity 전체 object다.

```json
{
  "repositoryId": "1289709524",
  "repository": "mposition/Tomverse",
  "workflowPath": ".github/workflows/memory-eval-decision-grade.yml",
  "runId": "33953094398",
  "runAttempt": 1,
  "evaluatedCommit": "12f83ec2c388a318fe0a79d4f76bd2c0b245dcb1",
  "modelId": "gpt-5-6-luna",
  "promptVersion": "mem-extract-v8",
  "promptDigest": "a1d804c6b9359b722c60b1309c7324176f72c54008d2a616fa78dd520a6b44ae",
  "dataset": {
    "datasetVersion": "mem-eval-succ-9",
    "schemaVersion": 3,
    "caseCount": 1150,
    "datasetDigest": "626f71362046b7d88df9dbb07e2f51fa0e908c78192f74bd837fa88e9ce1d4e6",
    "manifestDigest": "82d9aa48fe96037b7493dae26594a73482d7ba4a915532caffc9be411085f40c",
    "scoringContractVersion": "mem-score-v3.5",
    "scoringContractDigest": "2d4bcb696c2dd87d586ab30bb8308c567b3ef3f57b0b17f6ff99e10de0cc33d4",
    "subtypeDigest": "9a4e418c7fd36a4d84b53b99ed41d731c83a5f53d93af117c4c8fd14e05d8ce6",
    "frozen": true,
    "originalApproval": {
      "approvedBy": "@mposition",
      "approvedAt": "2026-09-04",
      "approvedCommit": "25b3f503ed2637d7b160e6a8c5750203d5e60b1d"
    }
  },
  "artifactSchema": 3,
  "datasetSchema": 3,
  "subjectArtifactId": "9966057860",
  "subjectArtifactName": "mem-eval-run1",
  "archiveSha256": "8932f1ae3a48effee8f099c2287a290e1cd02c88f1bf4b2ae5869ef60662f888",
  "subjectFileName": "mem-eval-run1.json",
  "subjectByteLength": 923959,
  "subjectContentSha256": "09832eab460e3efc5e1d6998ca13f1100490ac9a5123dad3acbd075ffc3126c0",
  "generatedAt": "2026-09-05T08:21:07.467Z",
  "runOrdinal": 1,
  "mode": "live",
  "plannedCaseCount": 1150,
  "caseCount": 1150
}
```

표의 name → subjectArtifactName, archive SHA-256 → archiveSha256,
subject file name / bytes → subjectFileName / subjectByteLength,
subject content SHA-256 → subjectContentSha256으로만 대응한다.
artifact의 datasetSchemaVersion field를 여기의 datasetSchema와 혼동하지 않는다.
artifact 자체는 원본 bytes로 유지하고 이 subject object를 artifact에 써 넣지 않는다.

이 mapping에서 legacySubjectDigest는 mem-purpose-legacy-subject-1 domain으로 계산한
69a2944927ee9a09bf08706ca65d060b66dbe01dbc45fd19d70f4e3090b07d76이어야 한다.
일치는 wire 계산의 정답이지 아직 존재하지 않는 activation 승인·서명 검증 결과가 아니다.

### SourceEvidenceReceipt와 정확한 역할 집합

S2 EvidenceSource의 6개 field {role,kind,contentSha256,sourceCommit,path,observedAt}는
변경하지 않는다. 별도 SourceEvidenceReceipt가 그 source와 실제 보관된 BlobRef·proof를
감싼다. sourceBlob.rawSha256=source.contentSha256이며 byteLength도 직접 검사한다.
sourceBlob.path는 private evidence package 상대 경로, source.path는 원출처 locator다.
두 경로의 문자열이 같아야 하는 것은 아니지만 원본 bytes는 같아야 한다.

sourceReceiptDigests 원소는 {role,receiptDigest} 두 field만 가진다.
receiptDigest=H("mem-purpose-source-receipt-1", 완성 SourceEvidenceReceipt)다.
완성 receipt는 자신의 signatureReceiptDigest를 포함한다. signer는 signatureReceiptDigest를
제외한 body의 mem-purpose-source-evidence-1에 서명하므로 순환이 없다.

seq2.evidenceSources와 sourceReceiptDigests는 role 기준 1:1이며 아래 **15개 정확한 집합**이다.
각 EvidenceSource는 참조 receipt.source와 CJSON equality여야 한다. receipt의 repositoryId와
legacySubjectDigest도 seq2 subject에 일치해야 한다. 같은 원본 hash의 다른 role은 가능하지만,
role 중복·누락·추가는 거부한다. 이 목록 고정도 B-S2-02의 새 규범 제안임을 밝힌다.

| role | kind | sourceCommit / source.path |
|---|---|---|
| historical_admissibility_checker | git | V / scripts/check-memory-eval-run-admissibility.mjs |
| historical_checker_dependency | git | V / lib/memoryEvalSpendCeiling.mjs |
| historical_dataset_approval | git | V / .github/audits/mem-extract-v8-implementation-2026-09-04.md |
| historical_dataset_entry | git | V / lib/memoryEvalSucc9.ts |
| historical_lockfile | git | V / package-lock.json |
| historical_package_script | git | V / package.json |
| historical_prompt | git | V / lib/memoryExtractionPrompt.ts |
| historical_tsconfig | git | V / tsconfig.json |
| human_blind_review | git | A / docs/ops/memory-eval-blind-review-run1.md |
| human_final_decision | git | A / docs/ops/memory-extraction-decision-grade-run.md |
| legacy_artifact | github | null / repos/mposition/Tomverse/actions/artifacts/9966057860 |
| legacy_run_attempt | github | null / repos/mposition/Tomverse/actions/runs/33953094398/attempts/1 |
| repository | github | null / repos/mposition/Tomverse |
| subject_archive | archive | null / legacy-artifact-9966057860.zip |
| subject_manifest_model_prompt | json | null / mem-eval-run1.json |

git source는 V/A tree의 exact blob raw SHA에, github source는 보존 응답 body raw SHA에,
archive/json은 S2 §5의 서로 다른 exact raw SHA에 대조한다. github path는 위 API resource
locator이고 query·leading slash·URL alias를 자동 정규화하여 허용하지 않는다.
관측 시각 observedAt은 원 관측 시각이며 서명의 issuedAt과 다르다. 과거 시각을 지어내지 않는다.

### F-1: proof wire profile — 네 가지 closed kind

proofRefs는 S3 BlobRef의 path ASCII 정렬·고유 배열이다. 각 ref의 bytes는 아래 SourceProof
union 중 정확히 한 object의 **CJSON + LF**다. 확장자나 설명문으로 kind를 추론하지 않는다.
unknown kind/key·중복 kind·다른 형식의 목록/Markdown/ZIP을 proof wrapper로 대신 주면
invalid_history다. 필수 wrapper 또는 그 leaf bytes가 없으면 legacy_evidence_unavailable이다.
native Git bundle·원 API body·ZIP·JSON·stdout/stderr는 wrapper 안 BlobRef의 **raw leaf**이며,
canonical JSON으로 다시 쓰지 않는다. 각 leaf의 path·byteLength·rawSha256을 실제 bytes로 검증한다.

| SourceProof kind | Closed type | 필수 검증 |
|---|---|---|
| git_history | GitHistoryProof | native Git bundle의 A/V 및 필요한 조상·tree·blob, historical 122·support 5·prompt/register·A의 두 판정 원문 |
| github_capture | GithubCaptureProof | S4 ApiCapture 원형, exact 요청/응답·raw body·API version·repository/run/artifact 귀속 |
| artifact_entry | ArtifactEntryProof | exact metadata capture와 ZIP/유일 JSON entry의 6-field binding |
| checker_replay | CheckerReplayProof | git_history + subject bytes + V package script·실행 조건·실제 stdout/stderr·exit 및 독립 offline 재현 |

각 role의 **필수이며 유일한** proof kind 집합은 아래다. 각 kind는 한 번만 나타나며 표 밖
kind의 추가로 누락을 메우지 않는다. 공유 git_history는 10개 git source에서 같은 BlobRef이고,
checker_replay.gitHistoryProof도 그 ref와 같다. 두 artifact_entry ref도 같은 BlobRef다.
github_capture는 세 role마다 해당 endpoint의 capture 한 개다.

| role | proof kinds (exact) |
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

#### GitHistoryProof와 register의 위치 (F-3)

gitBundle은 S4 PrivateEvidencePackage.gitBundle과 같은 **native Git bundle bytes**를 가리킨다.
단순 snapshot ZIP/FrozenFile 목록은 Git object/parent 증거의 대용이 아니다. 격리 검증 환경에서
외부 alternate·replace/graft·shallow·누락된 prerequisite 없이 A와 V의 완전한 reachable graph와
필요 tree/blob을 검증할 수 있어야 한다. bundle 생성·검증 명령을 실행했다는 말만으로는 부족하다.
이 source proof가 **완성 PrivateEvidencePackage 전체**를 참조하는 것은 아니다. 미래 checkpoint/
snapshot/seq2가 아직 없으므로 그 전체를 선행 source 증거로 요구하면 순환이 된다.

historicalFrozenFiles는 S2 FrozenFile의 exact 122개 historical closure이며 V에서 closure를
독립 재계산해 목록·mode·Git blob OID·raw SHA를 대조한다. S2 원문의 109개 forward 목록은
늘리지 않는다. supportFiles는 V의 package.json, package-lock.json, tsconfig.json,
scripts/check-memory-eval-run-admissibility.mjs, lib/memoryEvalSpendCeiling.mjs 다섯 개다.
promptFile은 lib/memoryExtractionPrompt.ts, registerFile은 lib/memoryExtractionEvalRegister.ts로
고정한다. 모든 FrozenFile 배열·단일 항목은 V tree의 실제 blob과 mode/hash가 맞아야 한다.
humanSources는 A의 앞 표 두 판정 문서 GitFileRef이며 path순, exact 2개다.
sourceCommit/path가 가리키는 Git source의 원본과 sourceBlob을 bundle 안 blob bytes에 대조한다.

register는 S2 §5대로 **교차 검증 출처**다. JSON manifest가 modelId/promptVersion의 직접
출처이며, promptDigest는 V prompt 및 V dataset 승인 원문과 대조하고, FAIL/revoked는 A의
사람 결론으로 판단한다. register의 V 당시 모델·prompt 상수가 JSON과 일치하는지 확인하되,
그때의 pair 상태를 나중 A의 최종 revoked로 덮어쓰거나 그 역으로 읽지 않는다.
따라서 별도 historical_register evidenceSource role은 만들지 않지만 registerFile을 필수
git_history 증거로 추가한다. **제외는 top-level role에서만**이며 교차 검증을 면제하지 않는다.
현재 129-file snapshot ZIP에는 register가 없으므로 이 새 proof 요구를 이미 충족했다고
보고하지 않는다. 보존·전환 검증은 별도 승인된 후속 작업이다.

#### GithubCaptureProof / ArtifactEntryProof

GithubCaptureProof.capture는 S4 ApiCapture의 정확한 9개 field다. 이 세 API source에는
requestMethod=GET, requestPath="/" + 앞 표의 source.path, query={}를 요구한다.
이는 source locator와 HTTP path 간 명시적 대응이지 입력 alias를 자동 허용하는 규칙이 아니다.
source.observedAt=capture.requestedAt이며 status=200, sourceBlob.rawSha256은 redaction 전
body hash와 같다. body와 sourceBlob의 raw hash가 달라지는 redaction은 S4의 승인된 원 응답
보존 증거 없이는 수용하지 않는다. signed URL/token을 일반 proof에 복사해서는 안 된다.
wrapper의 apiVersion은 S4가 고정한 요청 version "2026-03-10"이며 실제 사용한 요청 값이다.
responseHeaders의 x-github-api-version-selected도 같은 값이어야 한다. 요청 version을
기록에서 관측하지 못했으면 응답 header만 보고 요청했다고 지어내지 않고 증거 불충분으로 남긴다.
wrapper는 S4 ApiCapture에 requestHeaders 같은 field를 몰래 추가하지 않기 위한 별도 타입이다.

repository/run/artifact 세 capture는 S4의 API provenance 검증과 S2 exact tuple 대조를 모두
통과해야 한다. importer 서명이나 wrapper에 적힌 repositoryId만으로 API 사실을 인증하지 않는다.
ArtifactEntryProof.artifactCapture는 legacy_artifact role의 GithubCaptureProof와 CJSON equality다.
binding의 artifactId는 metadata.id, archiveSha256은 metadata.digest의 sha256 값과 ZIP raw hash,
archiveByteLength는 실제 ZIP bytes의 길이에 일치해야 한다. metadata.size_in_bytes를
실제 archive bytes 길이와 같다고 가정하지 않는다. ZIP의 유일한 file entry 이름·raw hash·
byteLength가 entryName/entryRawSha256/entryByteLength 및 subject JSON sourceBlob과 같아야 한다.
directory entry는 허용하되 file entry는 정확히 mem-eval-run1.json 하나, 중복 이름·경로 이탈·
symlink·암호화 entry는 거부한다. archive와 entry 두 BlobRef도 각각 binding과 일치해야 한다.
고정 subject에서는 archive 45,339 bytes, entry 923,959 bytes이며 hash는 앞 LegacySubject 값이다.
S4 ArtifactBinding에는 entry hash/길이가 없으므로 그 타입만으로 이 bridge를 대체하지 않는다.

#### CheckerReplayProof — 실행 사실과 판정을 분리

gitHistoryProof의 supportFiles에서 읽은 package.json의 check:memory-eval-run scriptText를
그대로 pin한다. V의 값은 node scripts/check-memory-eval-run-admissibility.mjs이며
checker의 repository-owned dependency closure는 lib/memoryEvalSpendCeiling.mjs까지다.
subject는 subject_manifest_model_prompt.sourceBlob과 같은 원본 bytes다. materialization은
격리된 snapshot root 아래 .s2-proof-input/mem-eval-run1.json으로만 두고 Git 원본을 덮지 않는다.
arguments는 ["--artifact=.s2-proof-input/mem-eval-run1.json"]이고 workingDirectory는
논리 root "snapshot"이다. 실제 실행은 그 root에서 V의 npm package script를 사용하며,
추가 flag/loader/pre/post lifecycle hook을 허용하지 않는다. V의 package.json에 해당
pre/post hook이 없다는 것도 bundle에서 확인한다. 현재 HEAD checker로 대신하지 않는다.

runtime은 관측한 Node/npm version, Node executable 및 npm CLI entry raw hash, platform,
architecture를 pin한다. environment는 NODE_OPTIONS·NODE_PATH·npm script-shell override가
모두 없다는 세 field다. 자격증명 값을 보존하지 않으며 provider 자격증명 없이 network를
차단한 환경에서 실행해야 한다. 이 runtime record 자체는 hermetic image나 무접촉 인증이 아니다.
실제 실행 로그 stdout/stderr의 raw bytes와 exitCode=0을 보존하고 observedAt은 실제 재현 시각이다.
검증자는 동일 V source/subject/script 조건으로 offline 재현해 exit 0과 checker의 8개 admissibility
rule 결과가 전부 OK인지 직접 확인한다. 실행하지 못하면 legacy_evidence_unavailable이며,
exitCode=0/로그/서명 자기 주장만으로 성공시키지 않는다. platform/version이 적힌 runtime을
확인·재현할 수 없으면 같은 거부다. 절대 경로·npm 배너가 다른 두 재현 로그의 raw hash가 같을
필요는 없지만 제출 로그의 hash는 보존 bytes와 같아야 하고 rule별 결과·최종 exit는 같아야 한다.
FAIL/revoked는 이 admissibility exit로 PASS가 되지 않는다. 이 형식은 앞으로 생성할 증거의
계약이며, 이전 준비 JSON의 임시 absolute-path 실행 로그를 이 새 proof로 소급 인증하지 않는다.

proof 의존은 raw leaf → git_history/github_capture/artifact_entry → checker_replay →
SourceEvidenceReceipt → seq2로만 진행한다. checker_replay의 gitHistoryProof만 앞 proof를
BlobRef로 참조하며 artifactCapture는 앞 capture를 inline 결속한다. 다른 proof 참조·서명·
receipt graph 확장은 없다. proofRefs와 proof 내부에 seq2·inclusion signature·checkpoint·
자기 receipt/서명·다른 SourceEvidenceReceipt/그 서명을 넣지 않는다. Git bundle도 A/V
역사 증거에 한정해 C나 미래 activation record를 proof 의존성으로 포함시키지 않는다.
현재 Downloads 보관물을 S3/S4 trusted custody로 승격하거나 실제 proof를 생성하는 규정이 아니다.

## Non-Functional Requirements — 측정 가능한 경계

- NFR-1: 같은 canonical 입력의 digest 차이는 MUST 0건이다. duplicate key·invalid UTF-8·
  BOM·float·non-NFC canonical string·unknown field는 MUST 100% 거부한다.
- NFR-2: 검증의 provider contact·원본 dataset/register/flag write는 MUST 0회다.
- NFR-3: unsigned·wrong-purpose·wrong-role·unregistered epoch를 승인으로 수용하는 경로는 MUST 0개다.
- NFR-4: raw hash를 domain digest로 대용하거나 자기 hash/미래 commit에 의존하는 edge는 MUST 0개다.
- NFR-5: UI·성능 SLO·DB migration은 N/A — 외부 authority record의 형식 명확화이며 UI/서비스 구현이 아니다.

## API Contracts — HTTP N/A, 기존 read-only 경계

새 HTTP endpoint·CLI 실행 기능·provider API 변경은 N/A다. S2 purposeAt,
newDecisionAdmission, historicalRead의 입력·출력·refusal 목록은 바꾸지 않는다.
아래는 wire shape 표기이며 구현 code나 실행 가능한 verifier가 아니다.

```typescript
type Sha256 = string; // exactly 64 lowercase hex
type CommitSha = string; // exactly 40 lowercase hex
type ApproverId = string; // local handle grammar above; exact registered value
interface GitFileRef { commit: CommitSha; path: string; rawSha256: Sha256 }
interface SourceReceiptDigest { role: string; receiptDigest: Sha256 }
interface ClarificationPolicyAcceptance {
  activationApproverSignature: "ed25519_required";
  trustBootstrapBeforeActivation: true;
  sourceEvidenceProfile: "exact_15_roles_with_closed_proofs";
  clarificationApprovalLayer: "separate_K";
}
interface ClarificationApproval {
  schemaVersion: 1;
  repositoryId: "1289709524";
  operation: "approve_s2_activation_clarification";
  decision: "yes";
  contractApprovalCommit: CommitSha;
  document: GitFileRef;
  policyAcceptance: ClarificationPolicyAcceptance;
  approvedBy: ApproverId;
  approvedAt: string;
}
interface ActivationAuthorization {
  schemaVersion: 1;
  repositoryId: "1289709524";
  protectedRef: "refs/heads/develop";
  clarification: GitFileRef;
  clarificationApproval: GitFileRef;
  approval: ActivationApproval; // unchanged S2 closed object
  signatureReceiptDigest: Sha256;
}
interface SourceEvidenceReceipt {
  schemaVersion: 1;
  repositoryId: "1289709524";
  legacySubjectDigest: Sha256;
  source: EvidenceSource; // unchanged S2 closed object
  sourceBlob: BlobRef; // unchanged S3 closed object
  proofRefs: BlobRef[];
  signatureReceiptDigest: Sha256;
}
interface GitHistoryProof {
  kind: "git_history";
  gitBundle: BlobRef;
  evaluatedCommit: CommitSha;
  humanDecisionCommit: CommitSha;
  historicalFrozenFiles: FrozenFile[]; // S2 exact 122, path sorted
  supportFiles: FrozenFile[]; // exact 5, path sorted
  promptFile: FrozenFile;
  registerFile: FrozenFile;
  humanSources: GitFileRef[]; // exact 2 at A, path sorted
}
interface GithubCaptureProof {
  kind: "github_capture";
  apiVersion: "2026-03-10";
  capture: ApiCapture; // unchanged S4 9-field object
}
interface ArtifactEntryBinding {
  artifactId: "9966057860";
  archiveSha256: Sha256;
  archiveByteLength: 45339;
  entryName: "mem-eval-run1.json";
  entryRawSha256: Sha256;
  entryByteLength: 923959;
}
interface ArtifactEntryProof {
  kind: "artifact_entry";
  artifactCapture: GithubCaptureProof;
  archive: BlobRef;
  entry: BlobRef;
  binding: ArtifactEntryBinding;
}
interface ReplayRuntime {
  nodeVersion: string;
  nodeExecutableRawSha256: Sha256;
  npmVersion: string;
  npmCliRawSha256: Sha256;
  platform: "win32" | "linux" | "darwin";
  architecture: "x64" | "arm64";
}
interface ReplayEnvironment {
  nodeOptions: null;
  nodePath: null;
  npmScriptShell: null;
}
interface CheckerReplayProof {
  kind: "checker_replay";
  gitHistoryProof: BlobRef;
  subject: BlobRef;
  packageScript: "check:memory-eval-run";
  scriptText: "node scripts/check-memory-eval-run-admissibility.mjs";
  arguments: ["--artifact=.s2-proof-input/mem-eval-run1.json"];
  workingDirectory: "snapshot";
  runtime: ReplayRuntime;
  environment: ReplayEnvironment;
  observedAt: string;
  exitCode: 0;
  stdout: BlobRef;
  stderr: BlobRef;
}
type SourceProof = GitHistoryProof | GithubCaptureProof | ArtifactEntryProof | CheckerReplayProof;

```

성공은 기존 S2 결과 타입으로만 반환한다. 파싱/형식 위반은 invalid_history,
subject 불일치는 legacy_subject_mismatch, evidence 부재는 legacy_evidence_unavailable,
서명·권한·K 확인 실패는 approval_unverifiable다. A/CA 조상 오류는 기존
approval_ancestry_mismatch, activation approval가 C 자신이면 approval_not_prior다.
trust/history 자체 실패는 기존 단계 순서대로 history_unverifiable 또는
purpose_history_unavailable이며, current admission은 S2의 외부 refusal 우선 규칙을 유지한다.
구조적으로 올바른 proof에서 bytes 부재/길이·hash 불일치/필수 proof kind 누락 또는
checker 조건 재현 불가는 legacy_evidence_unavailable, 실제 subject 값의 차이는
legacy_subject_mismatch다. unknown/중복/표 밖 proof kind·field는 invalid_history다.
K.repositoryId 또는 사람 policyAcceptance 내용 불일치는 approval_unverifiable다.
inclusionCommit=C, merge parent 수 부족, C 비조상은 activation_ancestry_mismatch이며
protected inclusion 증거 자체 불충분은 history_unverifiable다. 여러 실패의 우선순위는
계속 S2 단계별 규칙이다. 새 성공 boolean·새 refusal 문자열을 이 문서에서 추가하지 않는다.

## Data Models — closed schema와 digest

모든 object는 명시된 key만 허용한다. 필수 field의 null/생략을 허용하지 않는다.
ReplayEnvironment의 세 explicit null과 기존 S4 ApiCapture의 원문 null 규칙은 예외다.
새 proof의 observedAt은 실제 UTC RFC3339 instant, runtime nodeVersion은 v를 앞에 붙인
관측 semver, npmVersion은 관측 semver다. version/hash를 추정해 채우지 않는다.
S2 EvidenceSource의 sourceCommit/path null 규칙만 기존대로이며 이 exact profile의 path는
위 표처럼 전부 non-null이다. GitFileRef.path는 repository-relative POSIX 경로이며
절대경로·backslash·빈 segment·dot/dotdot·symlink는 거부한다. BlobRef는 S3 그대로다.

| Entity | Fields / constraints |
|---|---|
| GitFileRef | commit,path,rawSha256; exact commit의 blob raw bytes와 SHA 대조; 대상은 일반 file |
| ClarificationApproval | API Contracts의 9개 field; repositoryId exact·외부 검증, CA exact, document=D/path/hash, policyAcceptance 네 선택 명시; approvedBy=ApproverId 실제 사람, approvedAt YYYY-MM-DD; K 고정 경로에 CJSON + LF |
| ClarificationPolicyAcceptance | 위 4개 field exact; 사람이 명시 수용해야만 유효, 현재는 pending human decision |
| ApproverId | 위 로컬 handle 문법·@ 없음·등록값 exact; 과거 @mposition bytes에는 소급하지 않음 |
| ActivationApproval | S2 Data Models 원형 그대로; operation=activate_succ9_development, from=decision,to=development; 두 frozen 목록·digest·allowedResolverPaths exact; approvedBy/approvedAt 실제 사람 |
| ActivationAuthorization | API Contracts의 7개 field; clarification=D, clarificationApproval=K의 고정 receipt; K.document=D 및 K.CA=approval.CA; A/CA 값 보존 |
| LegacySubject | 위 전체 JSON의 23개 key; dataset은 S2 Identity exact; 추가 key/다른 run/다른 schema 불허 |
| EvidenceSource | S2 6개 field 그대로; 위 15개 role/kind/locator/sourceCommit profile |
| SourceEvidenceReceipt | API Contracts의 7개 field; sourceBlob 실제 bytes, proofRefs path 정렬·고유·비순환; importer signature |
| SourceReceiptDigest | role,receiptDigest; 완성 source receipt와 role 일치; 배열 role ASCII 정렬·정확히 15개 |
| SignatureReceipt / TrustAnchor / BlobRef | S3 원형 그대로; purpose 추가 세 개와 등록 역할은 본문 표 |
| ActivationCheckpoint | S2 6개 field 그대로; signatureReceiptDigest는 inclusion signature, approvalReceiptDigest는 완성 authorization digest |
| HistoryContext / S4 Checkpoint | 기존 원형 그대로; 새 trust/history shortcut 없음 |
| GitHistoryProof | 위 9개 field; V/A exact, native bundle + historical 122/support 5/prompt/register/human 2; complete graph 및 raw blob 검증 |
| GithubCaptureProof | kind,apiVersion,capture; GET exact endpoint·200·원본 body 및 S4 provenance 검증 |
| ArtifactEntryBinding | 위 6개 field exact; metadata ↔ ZIP ↔ JSON을 실제 raw bytes로 연결 |
| ArtifactEntryProof | kind,artifactCapture,archive,entry,binding; legacy_artifact capture와 equality |
| ReplayRuntime / ReplayEnvironment | 각각 위 6개/3개 field; 관측 runtime identity, injection override 3개 null; hermetic 보증 아님 |
| CheckerReplayProof | 위 13개 field; 고정 V script·입력·실제 로그·독립 offline 재현 필수 |
| SourceProof | 위 4개 closed kind union; 각 파일 CJSON + LF; proofRefs는 role별 exact kind 집합 |

H(domain,x)=SHA256(UTF8(domain + LF) || mem-cjson-1(x))로 정의한다.
CJSON bytes에는 최종 LF가 없다. Git receipt file 끝의 LF는 raw file hash에만 포함된다.

| Digest 이름 | Domain | 정확한 입력 |
|---|---|---|
| activationApprovalContentDigest | mem-purpose-activation-approval-1 | ActivationAuthorization에서 signatureReceiptDigest **하나만** 제외 |
| activationAuthorizationReceiptDigest | mem-purpose-activation-authorization-receipt-1 | 완성 ActivationAuthorization |
| sourceEvidenceContentDigest | mem-purpose-source-evidence-1 | SourceEvidenceReceipt에서 signatureReceiptDigest **하나만** 제외 |
| sourceReceiptDigest | mem-purpose-source-receipt-1 | 완성 SourceEvidenceReceipt |
| activationInclusionContentDigest | mem-purpose-activation-inclusion-1 | ActivationCheckpoint에서 signatureReceiptDigest **하나만** 제외 |
| activationCheckpointDigest | mem-purpose-activation-checkpoint-1 | 완성 ActivationCheckpoint |
| signatureReceiptDigest | mem-signature-receipt-1 | 기존 완성 SignatureReceipt |
| legacySubjectDigest | mem-purpose-legacy-subject-1 | 위 23-key LegacySubject 전체 |

다른 S2 domain·genesis·transitionIntent는 그대로다. transitionPayloadDigest에서 제외하는
field는 계속 activationApprovalCommit **하나**다. K·wrapper·signature field를 seq1에
추가하지 않는다. 기존 준비안의 identity/frozen/genesis/transition digest는 같은 입력이면
그대로지만, 그것이 새 wrapper·서명이 생성됐다는 뜻은 아니다.

## Acceptance Criteria — 미래 검증의 수용 기준

다음은 문서 검토용 요구사항이며 구현 test를 생성·실행한 결과가 아니다.

### AC-1: 원문과 K 승인 연결 (FR-1, FR-11)
Given 원래 A/CA와 D를 exact bytes로 승인한 K 및 그 K를 명시한 등록 원문이 있다.
When 이 K를 참조한 authorization을 검증한다.
Then D/K/CA의 GitFileRef·내용·조상, K.repositoryId·네 policyAcceptance·실제 사람 수용이
모두 일치할 때만 다음 단계로 간다.

### AC-2: 미승인 purpose 거부 (FR-1, FR-7, NFR-3)
Given 기존 A/CA만 있고 K 또는 명시적인 새 purpose 등록이 없다.
When s2_activation_approval 서명을 제출한다.
Then approval_unverifiable이며 기존 승인이 확장되지 않는다.

### AC-3: LegacySubject wire golden (FR-2, NFR-1)
Given 본문 23-key JSON exact object가 있다.
When mem-purpose-legacy-subject-1 digest를 계산한다.
Then 결과는 69a2944927ee9a09bf08706ca65d060b66dbe01dbc45fd19d70f4e3090b07d76이다.

### AC-4: 설명형 alias 거부 (FR-2)
Given exact subject의 subjectArtifactName을 name으로 치환한 object가 있다.
When schema를 검증한다.
Then invalid_history이며 alias 정규화로 원본 object를 만들지 않는다.

### AC-5: source receipt positive binding (FR-3, FR-4, FR-8)
Given exact 15-role sources와 동일 source bytes/proof를 검증한 importer 서명들이 있다.
When 완성 receipt digest로 seq2의 sourceReceiptDigests를 구성한다.
Then role 순·1:1 source equality·subject digest·서명·원본 검증이 모두 일치한다.

### AC-6: raw hash 대용 거부 (FR-3, FR-8, NFR-4)
Given 유효한 sourceReceiptDigests 한 원소의 receiptDigest를 source.contentSha256으로 바꿨다.
When seq2를 검증한다.
Then invalid_history이며 raw hash가 맞아도 receipt로 인정하지 않는다.

### AC-7: 역할 중복 거부 (FR-3, FR-10)
Given 15개 대신 같은 role을 두 번 넣어 총 16개인 배열이 있다.
When seq2를 검증한다.
Then invalid_history이며 자동 deduplicate하지 않는다.

### AC-8: 사람 승인 대리 거부 (FR-5, FR-7, NFR-3)
Given importer key가 activationApprovalContentDigest에 유효한 암호 서명을 만들었다.
When s2_activation_approval로 검증한다.
Then approval_unverifiable이며 사람이 approvedBy에 적혀 있어도 통과하지 않는다.

### AC-9: signature identity 교환 거부 (FR-6, FR-8)
Given 동일 approval body에 대해 issuedAt이 다른 두 유효 서명과 두 완성 authorization이 있다.
When checkpoint.approvalReceiptDigest를 다른 완성 authorization digest로 바꾸고 이전 inclusion 서명을 유지한다.
Then inclusion 서명이 실패하며 body 내용이 같다는 이유로 통과하지 않는다.

### AC-10: 정확한 사후 inclusion (FR-6, FR-9, FR-10)
Given 승인된 세 줄 C와 다른 SHA의 protected merge commit이 C를 strict ancestor로 가지며,
검증된 S4 trust/DAG와 exact authorization이 있다.
When 다섯 field inclusion body를 importer가 서명하고 완성 checkpoint를 별도 보존한다.
Then chainHeadDigest는 최종 seq2와 같고 signatureReceiptDigest는 그 서명을 가리킨다.

### AC-11: hash 순환 거부 (FR-4, FR-8, NFR-4)
Given SourceEvidenceReceipt.proofRefs가 자기 receipt 또는 최종 seq2를 가리킨다.
When proof 종류와 의존 관계를 검증한다.
Then invalid_history이며 재귀 참조를 끊어서 성공시키지 않는다.

### AC-12: evidence 부재 거부 (FR-4, FR-9)
Given source raw hash만 있고 해당 bytes 또는 필수 capture/checker proof가 없다.
When historicalRead 증거를 재검증한다.
Then legacy_evidence_unavailable이고 현재 HEAD/새 API 추정값으로 보충하지 않는다.

### AC-13: 역사 판정 보존 (FR-4, FR-10, NFR-2)
Given 정확히 보존된 v8 FAIL·revoked·provider failure 1건의 receipt가 있다.
When 새로운 importer가 같은 증거를 읽는다.
Then 원 판정이 유지되고 provider contact·dataset/register/flag write는 0회다.

### AC-14: 실행과 문서 승인 분리 (FR-11)
Given 이 명확화안에 대한 K만 추가됐고 실제 activation 승인 commit과 C는 없다.
When 현재 activation 완료 여부를 묻는다.
Then missing_activation_approval 또는 기존 context 실패이고 activation_complete가 아니다.

### AC-15: 다른 purpose 재사용 거부 (FR-6, FR-7)
Given 같은 key로 만든 purpose=provenance_checkpoint 서명이 있다.
When 이를 S2 ActivationCheckpoint.signatureReceiptDigest에 연결한다.
Then approval_unverifiable이며 S4 Checkpoint를 S2 타입으로 변환하지 않는다.

### AC-16: closed proof 종류 거부 (FR-4, NFR-1)
Given git_history wrapper 대신 FrozenFile 배열 JSON을 proofRefs에 넣었다.
When SourceProof schema를 검증한다.
Then invalid_history이며 파일명이나 같은 hash 목록만으로 native Git 증거로 인정하지 않는다.

### AC-17: role별 필수 proof 누락 (FR-3, FR-4, FR-9)
Given historical_admissibility_checker receipt에 git_history만 있고 checker_replay는 없다.
When exact role→proof kind 표를 대조한다.
Then legacy_evidence_unavailable이며 다른 role의 proof로 묵시 대체하지 않는다.

### AC-18: archive/JSON 연결 치환 (FR-4, FR-8)
Given 유효한 ArtifactEntryProof에서 binding.entryRawSha256을 archiveSha256으로 바꿨다.
When 실제 ZIP entry와 exact subject를 대조한다.
Then legacy_subject_mismatch이며 archive metadata 일치만으로 JSON을 인증하지 않는다.

### AC-19: checker의 주장만으로 통과 금지 (FR-4, FR-9)
Given 제출 replay의 exitCode=0이지만 고정 runtime/script 조건으로 독립 재현이 불가능하다.
When historical admissibility를 재검증한다.
Then legacy_evidence_unavailable이며 원래 quality FAIL은 변경하지 않는다.

### AC-20: register 교차 검증 증거 누락 (FR-4, FR-10)
Given 정확한 15-role receipts가 있지만 git_history.registerFile의 실제 V blob이 없다.
When Git proof를 대조한다.
Then legacy_evidence_unavailable이며 16번째 role 생성이나 현재 register 읽기로 보충하지 않는다.

### AC-21: F-2 정책의 묵시 승인 거부 (FR-1, FR-5, FR-11)
Given D의 일반 승인만 있고 네 정책 항목에 대한 실제 사람의 명시적 수용이 없다.
When 이 전사를 K의 policyAcceptance 값으로 제시한다.
Then approval_unverifiable이며 사람 key 생성/등록이나 activation 서명을 시작하지 않는다.

### AC-22: 직접 inclusion 거부 (FR-6, FR-9)
Given inclusionCommit=C인 direct push/fast-forward checkpoint가 있다.
When activation inclusion을 검증한다.
Then activation_ancestry_mismatch이며 activation_complete가 아니다.

### AC-23: signer handle 자동 변환 거부 (FR-5, FR-7)
Given 새 activation approval의 approvedBy=mposition이고 서명의 signerId=@mposition이다.
When approver identity를 검증한다.
Then approval_unverifiable이며 @를 제거해 통과시키지 않고 과거 @mposition 원문도 고치지 않는다.

### AC-24: K의 repository 재사용 거부 (FR-1)
Given 구조가 유효한 K를 repositoryId가 다른 외부 검증 context에 제출했다.
When K를 단독 검증한다.
Then approval_unverifiable이며 document Git SHA가 있다는 이유로 repository 검증을 생략하지 않는다.

### AC-25: 잘못된 proof kind 추가 거부 (FR-3, FR-4)
Given human_final_decision receipt에 git_history와 불필요한 checker_replay 두 kind가 있다.
When role의 exact proof 집합을 검사한다.
Then invalid_history이며 필수 증거가 있다는 이유로 표 밖 proof를 허용하지 않는다.

## Edge Cases — 외부 실패·거부 우선순위

- EC-1: Git object/parent/D/K receipt 누락·replace/graft·shallow → 기존 history 단계에서 거부;
  현재 worktree bytes로 원문을 대신하지 않는다 (FR-1, FR-9).
- EC-2: GitHub 403/404·만료 artifact·capture 부재 → API 사실/증거 검증 실패;
  권한 부족을 빈 성공으로 바꾸지 않는다 (FR-4, FR-9).
- EC-3: 서명 파일·sourceBlob·proof file 부재/길이 불일치 → evidence 또는 signature 실패;
  locator만으로 성공시키지 않는다 (FR-4, FR-7).
- EC-4: 폐기 key·미등록 epoch·권한 불명 시점 → approval_unverifiable;
  관측 시각을 서명 시각으로 소급하지 않는다 (FR-7).
- EC-5: 두 독립 C 또는 C 이후 삭제·복원·merge edge 위반 → 기존 divergent_activation/
  history_tampered; 이 부속 계약은 그 검증을 바꾸지 않는다 (FR-10).
- EC-6: checkpoint rollback·protected tip 불명 → 기존 current admission fail-closed;
  유효한 과거 raw subject가 새 실행을 허용하지 않는다 (FR-9).
- EC-7: 보존 receipt file의 non-canonical key 순서·array 순서 변조·duplicate key·CRLF·
  unknown field → canonical/schema 규칙 위반; 수정된 bytes로 재서명하지 않는다.
  직렬화 전 typed object의 key 입력 순서 차이는 같은 CJSON/digest여야 한다 (NFR-1).
- EC-8: 무관한 role의 valid signature 또는 source hash/domain 교환 → 거부;
  여러 실패는 S2 기존 단계 및 같은 단계 code ASCII 순서를 따른다 (FR-7, FR-8).
- EC-9: Git bundle 대신 snapshot ZIP, 중복 ZIP file entry, wrapper unknown key,
  미래 checkpoint를 요구하는 proof graph → closed schema/역사 증거 단계에서 거부 (FR-4, FR-9).
- EC-10: K 정책 선택 누락·다른 repository, 새 handle의 @/case 불일치 →
  승인 또는 서명 identity 단계에서 거부하며 값 자동 교정 없음 (FR-1, FR-5, FR-7).
- EC-11: squash/rebase로 C 소실, inclusionCommit=C, parent 1개인 inclusion →
  activation_ancestry_mismatch; 임의 merge도 protected provenance 검증 필요 (FR-6).

## Out of Scope — 여기서는 하지 않는 것

- OS-1: 실제 K·ActivationAuthorization·SourceEvidenceReceipt·서명·checkpoint 생성 —
  이 문서는 형식 제안이며 사람 승인·키 등록·실행 권한이 없다.
- OS-2: 기존 승인 문서 또는 activation 준비안 두 파일의 덮어쓰기 —
  이전 bytes를 보존해 검토자가 새 제안과 원래 후보를 직접 대조할 수 있게 한다.
- OS-3: resolver/scorer·test code·workflow·DB·TrustAnchor 구현 또는 key 생성 —
  별도 승인된 구현 단계다.
- OS-4: 실제 purpose 전환·dataset·manifest·register·prompt 변경, holdout 작성/봉인/개봉,
  S5/v9 작성, pair·예산·dispatch·provider 호출 — 기존 선행 순서를 그대로 지킨다.
- OS-5: release gate·memoryExtractionEnabled·memoryInjectionEnabled 변경 또는 현재 값 추정 —
  운영 관측·변경을 이번 문서 작업으로 하지 않는다.
- OS-6: 완전한 S4 bootstrap/보관 정책 재설계 또는 공급자 API 계약 변경 —
  새 purpose의 D/K/역할 결속만 명시하며 기존 요건을 면제하지 않는다.
- OS-7: commit·push·PR·merge·정식 승인 판정 — 별도 요청 전에는 수행하지 않는다.

### 검토·승인 인계 경계

이번 확인 검토는 exact raw SHA로 고정된 **미커밋 수정 초안**의 설계 검토다.
정식 reviewCommit 또는 승인 receipt를 가진 것으로 보고하지 않는다. 검토 결과는 본문
타당성의 의견이며 운영 verification/사람 승인과 다르다. 대상 bytes가 바뀌면 새 검토 대상이다.

검토에서 수용 가능한 안으로 정리된 뒤, 별도 지시로 D를 commit해 40자 SHA·Git blob hash를
고정하고 그 exact bytes와 검토 보고서를 사람에게 승인 요청한다. K는 그 뒤의 별도 commit이다.
원 SHA 보존 develop merge와 CI 확인 뒤 activation 패키지를 재계산한다.
K 승인도 실제 activation 승인/구현 승인과 구분하며, 별도 activationApprovalCommit → C →
protected inclusion/checkpoint 검증을 거쳐야 한다. 확인 검토는 수정 후 최대 한 번으로 제한하고
남은 차단점이 있으면 반복 검토로 묻지 않고 사람에게 보고한다.

### 최초 검토 대응표 — 작성자 제안, closure 판정 아님

최초 대상은 memory-eval-vnext-s2-activation-clarification-draft-2026-09-07.md,
raw SHA-256 ccb1af8d606cc27fb30b1654712f9e61065b8a2d2e8123d25dd64c91f0c07f65
(33,376 bytes / 500 LF lines)다. 원 파일은 보존하고 이 수정본을 새 hash로 검토한다.

| Finding | 수정본의 대응 | 확인·승인 잔여 |
|---|---|---|
| F-1 / P2 | SourceProof 4 kind·closed field·15-role exact proof 표·Git/metadata/ZIP bridge·checker 재현 조건·AC-16–19/25 | Claude closure 확인 대기; 실제 증거 생성·runtime/custody 구축은 미수행 |
| F-2 / P2 | 새 사람 Ed25519 정책과 대안 영향 명시; K.policyAcceptance 네 선택·AC-21 | pending human decision; 문서 검토를 사람 정책 승인으로 승격 금지 |
| F-3 / P3 | 15-role 유지 이유와 필수 registerFile 교차 검증·AC-20 | 원본 register/122/109는 무변경; 향후 exact proof 보존 필요 |
| F-4 / P3 | inclusionCommit≠C, C strict ancestor, 실제 protected merge parent≥2·AC-22 | SHA 보존 병합·관측 검증은 미래 실행 단계 |
| F-5 / P3 | 새 approver만 @ 없는 exact handle, 과거 @mposition 보존·AC-23 | 실제 key/role 등록은 미수행 |
| F-6 / P3 | K.repositoryId와 단독 외부 context 대조·AC-24 | 실제 K 생성은 미수행 |

최초 보고서의 사실 하나는 구분해 정정한다. 준비 JSON에 evidenceSources가 없다는 설명과 달리,
기존 memory-eval-vnext-s2-activation-package-2026-09-07.json의
legacyReceiptPlan.knownFields.evidenceSources에는 이미 15개가 있다. 해당 파일 raw SHA는
06b104bf7b5ea0d7d207d55db3520d2a968a7d3a6d5bf96e8fb1e182aaa4fcc5이며 변경하지 않았다.
준비 JSON의 후보 목록 존재와 이 명확화안으로 exact 집합을 **규범화하는 새 정책**은 다른
사실이다. 이 정정은 F-1의 closed proof 형식 부족이나 F-2의 승인 필요를 없애지 않는다.
