# Memory eval vNext S3 — holdout authoring, sealing, and opening

**Author:** Codex
**Date:** 2026-09-07
**Status:** In Review — 미승인 계약 초안; 실제 holdout·key·ledger 없음
**Reviewers:** 독립 검토 대기; 최종 승인자는 사람
**Document ID:** `MEM-EVAL-VNEXT-S3-1`

## Context — 승인 계보와 이번 작성 범위

상위 결정은 `.github/audits/memory-eval-vnext-contract-decision-2026-09-05.md`이며
raw SHA-256은 `355f8387808b8a7ea86e02ecffc4303562b5ab5c43c27fef0c2bdb2bf57e89da`다.
그 authoritative receipt는 `.github/audits/memory-eval-vnext-contract-decision-approval-2026-09-06.md`,
원래 A는 `3f14afb29eddc243640fdb0a5a4f604646ade9f0`이다. S1/S2의 최종 판정은
`.github/audits/memory-eval-vnext-s1-s2-contract-approval-2026-09-07.md`가 소유한다.
그 receipt commit은 `52caa2cecbd32cab97736993bd57630b1e3e3bc2`, 승인자는 mposition,
승인일은 2026-09-07이다. S1/S2 본문의 과거 In Review·미승인 표시는 보존된 역사적 bytes다.

작성 basis는 merge commit `f5abaecf77ee56d08cdd7e50ca43c0110d03e6b4`다.
[develop Admin E2E](https://github.com/mposition/Tomverse/actions/runs/34074519676)와
[develop Credit Finance DB](https://github.com/mposition/Tomverse/actions/runs/34074519699)의
attempt 1 성공을 확인한 뒤 그 tip에서 작성 브랜치를 만들었다. A, 검토 commit
`fa682cc2209fc5b0a9ebd994aa626d00997b0359`, 승인 기록의 원래 SHA가 모두 조상으로 보존됐다.
이 CI 관측은 holdout 실행이나 운영 활성화 승인·배포 실검증이 아니다.

S1은 `.github/audits/memory-eval-vnext-s1-scoring-contract-2026-09-06.md`
(SHA-256 `393497a5acbe7ee47af6947a84204eac7723fdd973bf30afad79c812da4db0e7`),
S2는 `.github/audits/memory-eval-vnext-s2-purpose-contract-2026-09-06.md`
(SHA-256 `e9a6a086be32e4d12df776015959c7c95be5185af7dc635403e8cd6689f4baa5`)다.
동반 S4는 `.github/audits/memory-eval-vnext-s4-provenance-contract-2026-09-07.md`다.
S3는 S1의 변환·grammar·safety 의미를 바꾸지 않고 입력 작성·암호화·사람 opening을 정한다.
아래 요구는 **향후 승인 후 구현할 계약**이며 현재 구현·검증됐다는 주장이 아니다.

## Functional Requirements — 요구사항

- FR-1: 실제 authoring은 S1–S4 승인, 별도 S2 activation 완료, scorer freeze를 MUST 선행한다.
- FR-2: authoring session은 서명된 규범 bundle과 빈 output만 MUST 입력받는다.
- FR-3: decision 자료는 S1 schema-4·exhaustive-only·identity-nfc-1을 MUST 따른다.
- FR-4: cell floor, batch 검수, 다양성 판정 및 provenance를 MUST seal 전에 검증한다.
- FR-5: P2-N1·C-COORD-1과 S1의 단독 민감성·case-local OR·충돌 검사를 MUST 승계한다.
- FR-6: manifest·scoring statement·검수·freeze의 정확한 bytes와 digest를 MUST 결속한다.
- FR-7: 비공개 자료는 아래 AEAD·key custody·nonce 규칙으로만 MUST 운반·보존한다.
- FR-8: sealed/opened/development 및 중단 복구는 단방향 이력으로 MUST 검증한다.
- FR-9: 한 holdout은 정확한 pair의 한 programme에만 MUST 배정한다.
- FR-10: 사람 opening은 별도 승인과 선행 intent를 MUST 요구한다.
- FR-11: S1의 allowed_pending_review multiset 전부에 exact-set receipt를 MUST 요구한다.
- FR-12: full unblind·종료·판정·holdout 기반 조정은 즉시 development 소비를 MUST 일으킨다.
- FR-13: 만료 후 재현에 필요한 암호문·key custody·receipt를 별도 보관소에 MUST 보존한다.
- FR-14: 원문 materialisation은 소비 이후 별도 승인된 위치에만 MUST 기록한다.

### 1. 선행 조건과 isolation (FR-1, FR-2)

실제 작업 순서는 D4 그대로다: S1–S4 사람 승인 → S2 activation 승인·전환·불변 검증 →
scorer 구현·동결 → 격리 authoring·검수·seal → 미노출 세션의 S5 → pair/protocol/budget/
ordinal별 dispatch 승인. 이 문서 작성은 이 순서 중 **하위 계약 작성**일 뿐이다.
S1/S2의 승인 기록은 S2의 contractApprovalCommit이나 activationApprovalCommit이 아니다.

AuthoringBundle은 아래 세 종류 파일과 BundleIndex, detached SignatureReceipt만 담는다.

1. `rules.json`: S1 schema/enum, canonical/token/numeric/grammar, gold/witness/region 규칙,
   identity-nfc-1, 자원 한도와 이 문서의 작성 제약을 담은 AuthoringRulesView.
2. `quota.json`: 8개 cell별 floor와 batch 크기, 검수·중복 제외 규칙인 QuotaProfile.
3. `instructions.md`: 초안 출력 형식, AI 비권위성, isolation·금지 입력·반려 절차만 담는다.

이 이름들은 **미래 bundle 내부 경로**이며 지금 파일을 생성하지 않는다. bundle에 S1/S2
원문 전체, descriptor의 SpecSnapshot/utf8Base64, Git bundle, test corpus를 싣지 않는다.
그 원문에는 역사·검토·노출 정보가 있어 규범이 맞다는 것만으로 허용 입력이 되지 않는다.
AuthoringRulesView는 frozen schema와 S1 Functional Requirements의 규칙, Data Models,
NFR 자원 한도에서 규범만 전사한 파생 view다. 역사 예시·review disposition·v8 provenance를
제외한다. view는 새 grammar authority가 아니며, 원문 각 요구와의 대응표 및 **누락·확장 0건**
검증을 bundle 생성자가 별도 격리 검증소에 보존한다. 사람이 view의 범위·대응표·hash를
승인하기 전에는 authoring input으로 쓸 수 없다. 자동 추출의 정확성을 주장하지 않는다.

Authoring session에는 repository/history/network/persistent memory 접근이 MUST NOT 있다.
빈 세션·별도 작업 디렉터리·도구 allowlist·네트워크 차단을 환경 제어로 검증한다.
단순히 프롬프트에 읽지 말라고 쓰는 것은 isolation 증거가 아니다. 허용 도구는 bundle 읽기와
자기 batch output 쓰기뿐이다. 후속 batch도 새 빈 세션에 같은 규범 bundle만 준다.
반려 수정은 반려 batch를 이어가는 동일 격리 session 내부에서만 한다. 외부 사례/분포/
일반 저장소 검색 결과를 feedback으로 추가하지 않는다. session 유실 시 반려 batch를 폐기하고
새 session에서 새 초안을 만든다. 폐기분을 나중에 decision에 되살리지 않는다.

금지 입력은 v8 artifact/진단, succ-9 본문·일부 재사용, case-ID 노출 목록, 실패 분포,
v9 prompt, 이 결정에 이른 검토 이력이다. 이 작업 대화 자체도 authoring input이 아니다.
동일 사람의 과거 지식을 지웠다고 주장하지 않고 사람 역할 중복은 별도 공시한다.

기계 검증소는 author session과 분리한다. frozen scorer·정확한 descriptor 원문을 소유한
검증소가 새 output에 provider-free S1 검사를 수행하며, author agent가 그 프로세스·메모리·
파일에 접근할 수 없어야 한다. 신규 output 이외 case corpus를 그 검사에 넣지 않는다.
검증소 출력은 해당 batch의 field/ID 기반 오류와 그 사람의 반려 근거만 제한적으로 돌려준다.
S1 descriptor를 규범 view로 대체해 검사하지 않는다. 구현자가 이 분리를 증명하지 못하면
isolation_unverified이며 작성·seal을 시작하지 않는다.

IsolationManifest는 session identity, bundle raw digest, agent 도구/모델/버전, 환경 image
digest, 허용 도구, 차단된 경로·network·memory 정책 digest, 시작/종료 시각, 모든 입력과
output의 raw digest를 기록한다. 환경 제어를 확인한 사람의 SignatureReceipt가 필요하다.
AI가 자체 작성한 `isolated:true`는 증거가 아니다. 외부 model에 authoring input을 보내는
호출도 비용·데이터 처리 승인 없이는 실행하지 않는다. 허용 환경의 구성 자체는 후속 작업이다.

### 2. Dataset schema, batch, sensitivity (FR-3, FR-4, FR-5)

HoldoutDataset의 cases는 모두 S1 Case4다. wrapper와 EvaluateCaseRequest의 evaluationUse=
decision, 각 Case4의 goldCompleteness=exhaustive를 전건 검증한다. evaluationUse를 Case4에
추가하지 않는다. 아래 caseId/goldId는 Case4.id/Gold4.id의 참조 이름이지 새로운 입력 field가
아니다. empty expected인 critical case도 exhaustive 선언을 유지한다.
partial, guessed schema-3 adapter, free-form evidence rewrite는 seal 전 refusal다.
S1이 산출한 scoringStatement의 exact NFC bytes/raw SHA-256을 저장하고 재요약하지 않는다.
case/conversation/message 순서는 원문 의미라 보존한다. case 목록은 caseId ASCII 순서,
gold·template·value 등 set 목록은 S1 지정 ID 순서이며 중복 ID는 거부한다.

QuotaProfile은 durable_facts의 ko/en 각각 200을 하한으로 한다. assistant_only,
sensitive_secrets, injection_directives의 ko/en 각각은 정책
`docs/policy/external-conversation-import-and-memory.md` §12.2의 validator coverage 조건을
같은 frozen validator로 전부 입증한 경우만 125다. 불충족·증거 부재이면 각각 200을 택한다.
모든 critical arm이 완화되면 총 하한 1,150, 전부 미충족이면 1,600이다. 실제 floor는
정책의 arm별 coverage를 대조해 합산하며 일부 arm만 충족하면 그 중간 합계가 된다.
다른 언어의 coverage나 남는 cell 표본으로 부족한 arm을 보충하지 않는다.
floor 완화 증거와 날짜·commit·validatorDigest는 seal receipt에 결속한다. runtime에서도
동일 조건을 확인하며 작성 시 충족만으로 실행 시 검사를 면제하지 않는다.

batch는 한 cell의 25~50 cases다. 아래는 기존
`docs/ops/memory-extraction-eval-dataset.md` §6.1–§6.5를 새 격리 절차에 적용한 것이다.

- 각 cell의 첫 batch 및 도구/모델/버전 변경 뒤 첫 batch는 전건 사람이 검수한다.
  그 채택 전에는 같은 cell의 다음 batch를 생성하지 않는다.
- 나머지는 적어도 ceil(0.2 × batchSize)를 검수한다. 초안 bytes 고정 후 검증소가 생성한
  비공개 256-bit random seed에 따라 `SHA256(seed || UTF8(caseId))` 순서로 표본을 뽑는다.
  동률은 caseId 순이다. 선택 seed·알고리즘·초안 digest·표본 집합을 검수 receipt에 보존한다.
  seed 재선택·caseId 바꾸기·불리한 표본 교체는 금지다.
- 반려/검수수 > 0.05이면 전건 재검수한다. 기본 20% 표본(5~10개)에서 반려 하나가
  나오면 이 조건에 해당한다. 표본 이상을 검수했으면 실제 분자·분모를 기록한다.
- 표본 검수와 **batch 전체 명시적 채택**은 별개다. 채택 receipt가 없는 나머지 80%는
  dataset에 들어가지 않는다. 미해결 반려·사람 사이 adjudication은 seal 전 0건이어야 한다.
- AI는 비권위 초안 생성자, 사람은 판정자다. 실질 수정은 사람이 정답을 쓰지 않고
  반려→동일 격리 AI 재작성→사람 재검수로 처리한다. 서로 다른 사람 판정 충돌에만
  제3의 adjudicator가 필요하며 AI와 사람의 차이는 draft disagreement다.
- 기존 §6.5의 비 OpenAI 계열 초안 우선·같은 계열 사용 시 batch별 사유와 문체 편향 검수를
  승계한다. 현재 특정 초안 모델이나 provider 호출을 승인하지 않는다. 내용 불변 표기 수정도
  최종 채택 bytes에 대한 hash·검수 결속을 다시 확인하며 옛 digest를 재사용하지 않는다.

위 표본 비율은 **S1이 전건 요구하는 증명**을 줄이지 않는다. 모든 gold의 template별
positive/negative witness와 사용자 귀속, 모든 safety partition, 모든 sensitive Value의
standaloneSensitivity에는 해당 bytes를 본 사람의 검수 결속이 있어야 한다. 이를 표본
채택 한 줄에서 자동 생성하지 않는다. BatchReview는 batch 채택 범위와 실제 전건 검수한
gold/value/region ID 집합을 따로 기록한다. 이 추가 작업량은 S1이 이미 요구한 비용이다.

전 batch 내부/사이 exact duplicate와 경미한 paraphrase는 floor에 세지 않는다.
검증소는 신규 holdout 내부의 near-duplicate 목록과 사람의 다양성 판정을 보존한다.
succ-9과의 재사용 검사는 별도 비노출 validator가 수행한다. author에게 기존 case, 일치 ID,
분포를 돌려주지 않고 거부와 신규 batch ID만 알린다. content/분포 노출을 통한 새 scorer
조정은 허용하지 않는다. cell floor는 closed grammar의 대표성을 증명하지 않는다.

**P2-N1:** permitted region의 goldId는 같은 case의 bulk_safe gold만 참조한다.
sensitive_review gold의 evidence region을 permitted로 표시하면 authoring refusal다.
민감 evidence를 bulk_safe로 relabel하거나 S1의 permitted slice 스캔에서 빼지 않는다.
assistant는 전체 prohibited, 나머지 partition도 S1의 gapless/overlap 금지를 그대로 따른다.

**C-COORD-1:** AuthoringTarget.permitted_region의 start/end는 message의 절대 NFC scalar
좌표다. Collision.start/end는 그 target slice 시작을 0으로 센 상대 좌표다.
target=[10,20), collision=[2,5)이면 message=[12,15)다. byte/UTF-16 좌표로 바꾸거나
이미 절대인 좌표에 offset을 다시 더하지 않는다. 이 예는 좌표 산술일 뿐 holdout case가 아니다.

S1 checkAuthoringSafety는 동일 case 민감 ValueRef **OR**를 모든 bulk_safe scoringStatement,
그 evidence quote, **모든 permitted region exact NFC slice**에 적용한다. 단독으로 민감하지
않은 조각의 결합을 각각 standaloneSensitive=true로 허위 표기하지 않는다. 기존 grammar로
유효한 단독 surface를 표현할 수 없으면 거부한다. blockingCollisions 하나면 seal 불가다.
crossCaseOverlaps만 있으면 S1의 sealEligible을 false로 바꾸지 않고 사람의 검토 확인을
추가 기록한다. collision 목록·candidate hash 목록도 공개하지 않는다.

### 3. Manifest와 seal evidence (FR-6)

S1의 CJSON은 mem-cjson-1이고 domain digest는 `SHA256(UTF8(domain + LF) || CJSON(body))`다.
rawSha256은 domain 없는 원본 bytes hash다. 이 구분은 모든 S3/S4 field에 적용한다.
S1 descriptorDigest를 새 S3 hash로 대체하지 않는다. protocolDigest는 S4가 S3/S4 원문을
별도로 결속하므로 S1 descriptor의 S1/S2 두 snapshot에 S3/S4를 임의 추가하지 않는다.

DatasetManifest는 schemaId, holdoutId, datasetVersion, casesIndex, quotaProfileDigest,
scoringContractDigest를 가진다. casesIndex의 각 항목은 caseId, language, category,
caseRawSha256, caseByteLength, scoringStatements[]이고, 마지막 배열은
{goldId,scoringStatementSha256}다. case 파일은 exact strict UTF-8 JSON이며 duplicate key는
거부한다. S1이 NFC view를 파생하되 raw case bytes는 덮어쓰지 않는다. caseId/goldId 순으로
정렬하고, index의 전건과 package의 case 파일 전건이 정확히 일치해야 한다.
manifestDigest의 domain은 `mem-holdout-manifest-1`이다. datasetRawSha256은 별도다.
package에는 `dataset.json`, `manifest.json`, `cases/<caseIdHash>.json`을 보존한다.
caseIdHash=SHA256(UTF8(Case4.id))의 lowercase 64 hex이며 collision은 거부한다. 개별 case
파일은 dataset.json의 cases 배열 안 해당 JSON object의 시작 `{`부터 끝 `}`까지의
**원본 byte span**과 같아야 한다. parser가 다시 직렬화한 bytes로 바꾸지 않는다. 그 span의
hash/길이가 caseRawSha256/caseByteLength다. 입력은 strict parser로 duplicate key를
먼저 거부하고, 문자열 안 brace를 구조로 오인하는 정규식 분할은 허용하지 않는다.

SealEvidence는 exact dataset/manifest, S1 descriptor·implementation freeze receipt,
S1–S4 승인 및 S2 activation checkpoint, bundle/isolation, 전 batch 채택, 단독 민감성 검수,
authoring safety report(domain `mem-authoring-safety-1`), 중복·다양성·quota 근거를 결속한다.
scorer freeze가 최초 authoring 시작보다 앞이라는 기록도 확인한다. 현재 문서에는 미래
datasetVersion·holdoutId·key·seal digest·승인 서명을 채우지 않는다.

authoring 거부는 실행된 programme의 품질 FAIL이 아니다. seal 이전 같은 frozen 규범 안의
재작성은 새 batch bytes에 새 검수를 요구한다. authoring 내용을 보고 scorer를 바꿔야 한다면
그 draft pool은 development로 퇴역시키고 새 freeze와 새 격리 pool을 요구한다. seal 뒤에는
원문·gold·statement·manifest·검수 report의 수정이나 같은 holdout 재봉인을 금지한다.

### 4. AEAD, key custody, signature (FR-7, FR-13)

암호 primitive는 AES-256-GCM, nonce 96 bits, tag 128 bits로 고정한다. tag 축약과 임의
crypto 구현을 허용하지 않는다. primitive 근거는 [NIST SP 800-38D](https://csrc.nist.gov/pubs/sp/800/38/d/final)이며
아래 key 분리·한도·보관은 이 계약의 선택이다. nonce 유일성은 재시작을 포함해야 한다.

각 encrypted object는 **새 256-bit random key를 한 번만** 사용한다. keyId/objectId는
별도 random 128-bit lowercase hex이고 내용에서 유도하지 않는다. 한 key의 nonce는
12 zero bytes 한 번으로 고정한다. 안전성 근거는 nonce randomness가 아니라 key당
encryption 1회다. custody journal에 allocation·encryption 시작을 durable 기록하기 전에는
encrypt하지 않는다. 중단·성공 여부 불명이어도 그 key를 재사용하지 않는다. 전달 재시도는
이미 저장된 동일 암호문 복사뿐이다. 다시 암호화해야 하면 새 objectId와 새 key를 배정한다.
nonce/key 재사용·journal 유실·이중 writer·random source 실패는 crypto_unverifiable다.

EncryptedObject는 CJSON({header,ciphertextBase64,tagBase64}) exact bytes다. header는
{schemaVersion:1,suite:"AES-256-GCM-1",objectId,keyId,role,repositoryId,programmeId,runId,
runAttempt,nonceBase64}이며 AAD는 `UTF8("mem-sealed-object-1\n") || CJSON(header)`다.
programmeId/runId/runAttempt는 seal 당시 미배정이면 **명시적 null**이고 run object에서는
정확한 값이 필수다. role은 holdout/subject/review_sheet/receipt/evidence 중 하나다.
tag/AAD 검증 완료 전 plaintext를 parser·파일·화면에 내보내지 않는다. plaintext digest와
case/candidate 목록은 header나 artifact 이름에 넣지 않고 encrypted body 안에 둔다.

body는 PrivatePackage={schemaVersion:1,kind,binding,files:PrivateFile[]}이고 kind=role이다.
binding은 해당 manifest/run tuple의 private binding, files는 상대 POSIX path·byteLength·
rawSha256·base64를 가진다. 경로순으로 정렬하며 duplicate/path traversal/symlink는 거부한다.
raw bytes를 Base64로 운반하므로 NFD 원문도 손실 없이 보존한다. 외부 CJSON의 NFC 요건을
만족시키려고 raw source를 정규화하지 않는다. body 한도는 256 MiB, 개별 파일 64 MiB,
파일 10,000개다. 초과는 resource_limit이지 부분 암호화/잘라내기 허가가 아니다.

서로 다른 holdout/subject/review_sheet/evidence/receipt object는 key를 공유하지 않는다.
machine dataset/subject 복호화 key는 승인된 단일 실행 환경에만, review_sheet key는
승인된 reviewer 환경에만 전달한다. reviewer에게 subject/holdout full key를 대신 주지 않는다.
기계 검증소에서 gold를 읽는 것과 사람이 gold를 보는 것을 구분한다. full key의 사람 접근은
뒤의 full_unblind 절차를 요구한다. key plaintext는 Git·Actions artifact/log/cache에 0개다.

custodian은 암호문과 key를 별개 접근 경계에 보관하고, 무제한 범용 CI secret으로 key를
주입하지 않는다. 세션·unit·role·objectId가 결속된 KeyGrant가 필요하다. Grant 유효시간은
최대 30분이며 대상이 종료/차단되면 즉시 폐기한다. 실행 환경에는 swap/core dump/telemetry/
stdout capture를 차단하고 비공개 처리용 tmpfs 또는 같은 수준으로 검증된 volatile store만
쓴다. 설치·cache restore 등 제3자 도구 실행은 key 주입 **전**에 끝나야 한다.
보관소·key 관리 방식과 복구를 확인하지 못한 실행 환경은 사용하지 않는다.

SignatureReceipt는 Ed25519(pure, ph/ctx 아님) detached signature다. signature bytes는
64 bytes, trusted public key는 32 bytes이며 [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032.html)의
검증을 제공하는 검토된 구현을 사용한다. signer binding은 별도 사람 승인 TrustAnchor가
소유한다. 호출자가 제공한 public key만으로 신뢰하지 않는다. 기존 A/S1/S2의 사람 승인을
이미 Ed25519로 서명된 기록이었다고 소급 주장하지 않는다. 미래 key bootstrap은 그 원문
승인 receipt·Git ancestry를 보존하고 별도 사람 등록을 받아야 한다.

서명 대상 payload는 {schemaVersion:1,purpose,signerId,keyId,trustEpoch,contentDigest,issuedAt}다.
message는 `UTF8("mem-signature-1\n") || CJSON(payload)`, receipt는 {payload,signatureBase64}다.
signatureReceiptDigest의 domain은 `mem-signature-receipt-1`이다. signer 권한·purpose·시점·
trustEpoch를 검증한다. 기계 서명은 관측 증거이지 사람의 채택/verdict/dispatch 승인이 아니다.
키 폐기·변경은 append-only trust 이력에 남기며 누락된 epoch나 과거 시점의 권한 불명은 거부다.

### 5. 상태와 한 programme 배정 (FR-8, FR-9, FR-12)

authoring 중인 draft는 아직 sealed decision holdout이 아니다. seal 성공은 exact manifest와
SealEvidence가 검증되고 암호문·key 복구가 확인된 한 번의 `holdout_sealed` event다.
S4의 공통 append-only ledger가 상태 이력을 소유한다. 별도의 mutable `state.json`을
권위로 두지 않는다. 상태 전이는 다음 표로 닫는다.

| 현재 상태 | 사건 | 다음 상태 / 허용 범위 |
|---|---|---|
| draft | 검수·서명·암호화·복구 검증 완료 | sealed; 아직 programme 미배정 |
| sealed | programme_bound | sealed; exact pair 한 개에 영구 배정 |
| sealed | 승인된 사람 opening_started | opened; intent를 key release보다 먼저 기록 |
| opened | 같은 bound programme의 redacted review 재개·완결 | opened; 새 pair 배정 없음 |
| sealed 또는 opened | full_unblind / tuning_exposure / programme_end / final_verdict | development; 되돌릴 수 없음 |
| development | materialisation 또는 보존 검증 | development; decision 재사용 없음 |

기계가 비공개 검증/채점을 위해 decrypt하는 것만으로 사람이 opened한 것은 아니다.
다만 기계 환경의 plaintext 유출, 사람 접근 여부 불명, gold/diagnostic 노출은 보수적으로
`tuning_exposure`로 소비한다. 관측 실패를 sealed 유지의 근거로 쓰지 않는다.

programme_bound는 seal 후 S5의 exact prompt와 pair가 승인됐을 때 한 번만 기록한다.
seal 당시 없는 prompt를 가상의 값으로 채우거나 manifest를 나중에 덮어쓰지 않는다.
bind receipt가 holdout manifest/seal digest와 S4 Programme을 연결한다. 같은 model 이름이라도
provider/model version·prompt bytes·scorer·protocol이 다르면 다른 pair/programme다.
취소된 reservation을 핑계로 programme을 바꾸지 않는다. programme을 끝내면 소비한다.

ordinal 1과 독립 ordinal 2는 같은 Programme에 속하되 각각 새 사람 dispatch 승인을 요구한다.
ordinal 2는 API re-run이나 실패 재시도가 아니다. ordinal 1의 S4 technical closure,
완전한 S1 exact-set review, blocking verdict 0건, S1 machine quality gate 충족이 필요하다.
구조 실패·명백한 품질 미달·duplicate contact·불명 provenance·소비된 holdout이면 차단한다.
중간 reviewer에게 gold/metric/실패 분포를 주지 않고 검증소의 `continuationAllowed`만
controller가 읽는다. 이 boolean은 최종 사람 판정이 아니며 S1 기준을 완화하지 않는다.
opened라도 이 조건을 전부 만족하면 이미 bound된 ordinal 2가 가능하다.

### 6. Redacted opening과 exact-set review (FR-10, FR-11)

opening은 S4가 subject의 unit·완전성·기술적 provenance를 closure한 뒤에만 한다.
review 미완료 상태를 이미 품질 승인된 run이라고 부르지 않는다. machine 검증소가
subject에서 만든 review_sheet에는 S1 target candidateKey, exact statement bytes,
그 candidate의 **모든** cited source와 연결 ID만 둔다. gold/expected/metric/진단/무관한
message·category별 요약은 제외한다. source의 exact message bytes와 quote 위치를
연결하므로 reviewer가 근거를 확인할 수 있어야 한다. 민감 source가 포함될 수 있다는
이유로 공개 안전한 자료라고 부르지 않는다. 대상 hash 목록도 encrypted body 안이다.

사람은 ReviewOpenApproval에서 exact RunTuple, sheet 암호문 SHA, reviewer와 환경,
목적=redacted_review를 승인한다. custodian은 그 승인의 서명·권한·S4 closure를 검증하고
`opening_started`와 OpenIntent를 durable 기록한 **뒤** 해당 sheet key만 release한다.
receipt/기록을 쓸 수 없으면 화면을 열지 않는다. intent 후 decrypt 전 crash도 opened다.
OpenReceipt는 실제 성공/실패·노출 범위를 사후 기록하되 intent를 삭제하지 않는다.

reviewer는 전 target의 statement와 모든 cited source를 실제 보고 판정한다. rows는
candidateKey ASCII 순이고 duplicate candidate object의 ordinal도 각각 한 row다.
row.statementSha256은 NFC statement hash가 아니라 S1의 statementRawSha256이다.
빈 집합도 rows=[]와 사람이 확인한 set-complete 서명이 필요하다. row 누락·중복·고아,
다른 tuple, 바뀐 raw hash, 미등록 signer, 다른 reviewer의 위임 없는 서명은 거부한다.
gold 작성자였던 사람은 gold-withheld다. 비노출 이력이 검증된 경우만 gold-blind다.
기존 사람이 알고 있는 내용을 암호화가 지웠다는 뜻이 아니다.

S1의 digest domain/identity를 바꾸지 않고 서명 순환만 다음처럼 끊는다.

1. ReviewRow의 rowDigest는 **rowDigest field를 제외한** 다섯 field
   {candidateKey,statementSha256,verdict,reviewer,reviewedAt}의 `mem-review-row-1` digest다.
2. targetSetDigest는 S1 ReviewTarget[]의 candidateKey 순 배열에 `mem-review-set-1`을
   적용한다. 같은 key 중복은 invalid이고 대상 candidate multiset의 중복 ordinal은 보존한다.
3. ReviewReceipt의 signatureReceiptDigest 한 field만 제외한 body에
   `mem-review-receipt-body-1` digest를 계산한다. rows에는 계산된 rowDigest가 들어간다.
4. reviewer가 그 digest를 purpose=review_complete인 SignatureReceipt로 서명한다.
   그 receipt digest를 ReviewReceipt.signatureReceiptDigest로 채운다.

이는 S1 tuple/판정 규칙의 수정이 아니라 S1이 S3/S4에 위임한 서명 운반 규칙이다.
S4는 완성된 receipt bytes와 detached signature를 보존하고 두 방향을 검증한다.
row.reviewer/reviewedAt은 실제 row 판정자/시각이며 aggregate reviewer는 전건 집합을
확인한 서명자다. 다른 row 판정자가 있으면 각 row의 별도 review_row 서명이 필요하고
그 signer도 같은 환경·비노출 조건을 충족해야 한다. 자동 채움은 사람 판정이 아니다.
`extra_content` 하나면 programme FAIL 및 ordinal 2 차단이다.

### 7. 중단 복구, 소비, materialisation (FR-8, FR-12, FR-14)

OpenIntent 뒤 중단되면 RecoveryReceipt는 같은 tuple·sheet cipher·기존 intent를 결속하고
마지막 durable state와 실제 노출 범위를 확인한다. 동일 sheet의 redacted review를 새
승인 session에서 재개할 수 있지만 sealed로 복귀하지 않는다. 완성 row는 원본 bytes와
서명을 그대로 재검증한다. 미완료 row만 다시 판정하며 receipt 교정은 새 digest로 남긴다.
옛 receipt를 지우거나 API dispatch·provider 재접촉을 opening 복구에 끼워 넣지 않는다.
노출 범위를 증명할 수 없으면 development 소비와 S4 inadmissible 기록이 선행한다.

full gold/diagnostic opening, holdout 기반 scorer/prompt 조정, programme 종료, 최종 사람
판정 중 하나라도 시작하면 `holdout_consumed`와 원인 receipt를 먼저 durable 기록한다.
최종 판정 화면에 gold를 보여 준 다음 기록하는 순서는 허용하지 않는다. 사후 유출 발견은
관측한 시각과 가능한 노출 구간을 기록하고 즉시 소비한다. 기록소 장애면 모든 key grant와
dispatch를 정지하고, 복구 후 append가 확인되기 전까지 진행하지 않는다.

consumption은 품질 PASS/FAIL과 독립적이다. 실패·취소·예산 종료도 programme_end이면
소비되며 미사용 ordinal을 다른 programme에 양도하지 않는다. 원래 manifest의 decision
선언 bytes를 수정하는 대신 S4 history가 현재 사용 목적=development임을 결정한다.
S2의 succ-9 purpose ledger와 새 holdout 이력을 섞거나 과거 purpose를 소급 변경하지 않는다.

MaterialisationApproval은 소비 event digest, exact datasetRawSha256, 승인된 비공개 저장
위치와 접근 정책을 결속한다. 경로는 canonical absolute path로 해석한 뒤 그 승인 root
내부인지 검증하며 기존 다른 bytes를 덮어쓰지 않는다. 새 파일 기록 후 원본과 raw hash를
대조하고 MaterialisationReceipt를 남긴다. crash 뒤 동일 bytes 확인은 가능하되 다른
bytes를 정상 복구라고 인정하지 않는다. Git 게시·공유·dataset/register 편집 승인은 아니다.
materialisation 실패도 consumption을 취소하지 않는다. 원래 암호문·manifest·seal은 보존한다.

### 8. 만료와 보관·cleanup (FR-13)

hosted artifact는 운반 수단이지 유일한 증거 보관소가 아니다. seal/technical closure 전에
독립 접근 경계의 암호화 보관소 두 곳에 exact 암호문, private receipt, manifest, signature,
trust epochs, S4 evidence package를 복제하고 raw digest를 읽어 대조한다. key backup은
각 암호문 보관소와 분리한다. 한 보관소 유실을 가정한 복구 검증을 기록한다. key가 있어도
receipt·trust history·원본 archive가 없으면 완전한 재현으로 인정하지 않는다.

보관 기간은 programme 전체와 그 decision 근거를 사용하는 기간 전부이며 자동 expiry를
설정하지 않는다. 종료 뒤 삭제도 별도 사람 결정·대체 근거 여부를 요구하고, 삭제하면
재검증 불능이라는 사실을 tombstone으로 남긴다. 잊힐 수 없는 사람 노출과 backup의 접근
위험은 잔여다. 이 조항은 사용자 개인정보의 일반 수집/무기한 보관을 허용하지 않는다.
authoring은 합성 자료 전용이며 실제 사용자 conversation을 가져오지 않는다.

session 종료/거부 시 grant 회수, 비공개 임시 저장소 해제, key handle 폐기와 stdout/artifact/
cache allowlist 결과를 CleanupReceipt로 기록한다. 물리 RAM 삭제를 완전히 증명했다고
주장하지 않는다. cleanup 실패·관측 불명은 privacy_incident로 봉쇄하고 상태를 보수적으로
소비한다. 이미 유출된 plaintext는 암호화나 삭제로 회수됐다고 쓰지 않는다.

## Non-Functional Requirements — 비기능 요구

- NFR-1: 모든 문서/raw 입력은 strict UTF-8, duplicate JSON key 거부, digest는 lowercase
  64 hex여야 한다. CJSON은 BOM·공백·끝 LF 없이 S1 규범을 MUST 따른다.
- NFR-2: private 자료·candidate hash 목록·key의 hosted log/artifact/cache 노출은 0건이어야
  한다. opaque routing ID 외의 plaintext 내용은 공개 metadata에 MUST NOT 들어간다.
- NFR-3: 동일 보존 bytes와 신뢰 checkpoint로 동일 state/receipt 검증 결과를 MUST 재현한다.
  API/key/history 누락을 pass로 대체하지 않는다. S4의 as-of cutoff 범위도 보존한다.
- NFR-4: resource 한도 초과, GCM/tag 실패, signer·isolation 불명은 부분 성공 없이 MUST
  거부한다. 복호화 전 ciphertext 크기도 body 한도+인코딩 overhead로 제한한다.
- NFR-5: authoring/검수 전건 증거 비용과 single-person 역할 중복을 MUST 공시한다.
  실행 시간·검수 시간의 성능 SLA는 두지 않으며 비용 승인은 별도다.

## Acceptance Criteria — 구현 후 검증할 수용 기준

이 절은 실행한 테스트 결과가 아니다. 미래 구현은 아래 fixture를 합성 provider-free로
만들고, 실제 holdout을 테스트 fixture나 작성 예시에 사용하지 않아야 한다.

### AC-1: 작성 선행·격리 (FR-1, FR-2, NFR-5)

**Given** S1/S2 승인만 있거나 scorer freeze보다 이른 session, 또는 full S1 원문이 든 bundle.
**When** authoring 시작을 요청한다.
**Then** 각각 prerequisite_missing/isolation_unverified로 거부하고 model 호출은 0회다.
정확한 규범 view·사람 projection 승인·빈 환경 증거가 모두 있을 때만 새 session을 허용한다.

### AC-2: schema·quota·batch (FR-3, FR-4)

**Given** partial case, 한 cell 부족, duplicate로 채운 floor, 미채택 batch 또는 첫 batch 표본만 검수.
**When** seal을 검증한다.
**Then** 모두 거부한다. 첫 batch 전건·다음 batch 고정 seed 표본과 전건 필수 검수·명시적 채택,
모든 cell floor 및 적용된 validator coverage가 있을 때만 해당 gate가 통과한다.

### AC-3: 승인된 민감성·좌표 경계 (FR-5)

**Given** sensitive_review gold의 permitted region, 단독 민감하지 않은 Value, 또는 message
[10,20) target 안 [2,5) collision을 가진 합성 case.
**When** authoring safety와 결속을 검증한다.
**Then** 앞의 두 입력은 거부하고 collision의 message 위치는 [12,15)다. 같은 case의
blockingCollision은 seal을 막고 cross-case-only는 S1 sealEligible을 바꾸지 않는다.

### AC-4: exact bytes와 key 일회성 (FR-6, FR-7, NFR-1, NFR-4)

**Given** raw NFD source와 NFC scoringStatement, 또는 encrypt 시작 뒤 crash한 key allocation.
**When** package 검증/복구를 수행한다.
**Then** 두 원문 hash를 별개로 재현하고 변형 bytes는 거부한다. crash key는 재사용하지
않는다. tag/AAD 한 bit 변경, malformed Base64, 초과 크기는 plaintext 방출 전에 거부한다.

### AC-5: 상태·programme 불변 (FR-8, FR-9)

**Given** sealed 후 한 pair에 bound된 holdout 및 opening intent 직후 crash 이력.
**When** 다른 pair 배정 또는 sealed 복귀를 요청한다.
**Then** 둘 다 거부한다. opened인 같은 pair라도 ordinal 1 closure·전건 review·quality gate와
별도 ordinal 2 승인이 전부 있을 때만 두 번째 독립 실행을 허용한다.

### AC-6: review exact-set과 순환 없는 서명 (FR-10, FR-11)

**Given** 동일 object 두 복제의 target ordinal 0/1 및 그 둘에 대한 사람이 본 source 전부.
**When** review를 완결한다.
**Then** 서로 다른 두 row를 요구한다. 누락/고아/중복, NFC hash로 raw hash 대체, 잘못된
tuple/signature는 거부한다. rows=[]인 빈 target도 서명이 필요하고 extra_content 하나는
ordinal 2를 막는다. row/aggregate self field 제외 규칙으로 digest와 서명을 재계산할 수 있다.

### AC-7: opening 복구와 불명 노출 (FR-8, FR-10, FR-12)

**Given** intent가 durable하고 key release 뒤 UI가 중단됐으며 실제 노출 범위가 알려져 있다.
**When** 같은 sheet를 재개한다.
**Then** opened를 유지하고 새 승인 session에만 grant한다. 범위가 불명이면 development와
inadmissible로 보수 처리하며 provider 재접촉은 0회다. full-unblind grant보다 소비가 먼저다.

### AC-8: 만료·소비 이후 materialisation (FR-13, FR-14, NFR-3)

**Given** hosted archive가 만료됐으나 별도 원본 암호문·key·receipt·trust history가 남아 있다.
**When** 소비 후 승인 위치로 재현한다.
**Then** raw dataset hash와 history를 재현한다. 하나라도 없거나 path가 root 밖/다른 bytes로
점유됐으면 거부한다. materialisation 실패를 sealed 복귀나 decision 재사용으로 바꾸지 않는다.

### AC-9: 비밀성·cleanup (FR-7, FR-13, NFR-2, NFR-4)

**Given** subject/holdout key를 reviewer에게 주려는 grant 또는 candidate hash를 담은 public marker.
**When** grant/upload allowlist를 검증한다.
**Then** key release/upload 전에 차단한다. cleanup 확인 불명은 성공이 아니라 봉쇄·소비이며
실패 출력에도 plaintext를 싣지 않는다.

## Edge Cases — 경계 사례

- EC-1: zero allowed target — review 생략이 아니라 서명된 empty exact-set receipt다.
- EC-2: reviewer가 gold author — gold-withheld만 허용하며 gold-blind로 이름을 바꾸지 않는다.
- EC-3: seal 뒤 case 오타 발견 — 원문 교정·재봉인 불가; 소비하고 별도 새 holdout 절차다.
- EC-4: API 결과는 실패지만 ciphertext 생성 완료 — status만으로 폐기/허용하지 않고 S4 증거를 읽는다.
- EC-5: ledger 쓰기 실패와 UI 성공 가능성 — 신규 grant를 막고 복구 전 상태를 허용으로 해석하지 않는다.
- EC-6: 값 조각 여러 개가 함께만 민감 — R-SENS-1을 유지하며 거짓 standalone 표기를 거부한다.
- EC-7: signing key 분실/교체 — 미확인 epoch는 거부; 새 key로 과거 서명을 소급 생성하지 않는다.
- EC-8: GCM 성공 후 package raw digest 불일치 — 복호화 성공과 내용 진본성을 혼동하지 않고 거부한다.
- EC-9: 검수 중 full diagnostic을 실수로 열음 — review 편의가 아니라 소비 사건이다.

## API Contracts — 비공개 순수 검증 경계

HTTP endpoint/DB 변경은 N/A다. 다음은 미래 구현이 따라야 할 논리적 TypeScript interface다.
함수 호출 자체는 provider/key release/파일 쓰기를 하지 않는다. controller가 검증 결과와
사람 승인을 받은 뒤 S4 journal과 custodian에서 부수효과를 수행한다.

```ts
type Digest = string; // Lowercase SHA-256, exactly 64 hex.
type S3Error = "prerequisite_missing" | "isolation_unverified" | "invalid_dataset"
  | "quota_unmet" | "review_incomplete" | "crypto_unverifiable" | "invalid_receipt"
  | "invalid_transition" | "exposure_unknown" | "resource_limit" | "evidence_missing";
type Result<T> = { ok: true; value: T } | { ok: false; error: S3Error };
interface VerifySealRequest {
  datasetBytes: Uint8Array;
  manifest: DatasetManifest;
  evidence: SealEvidence;
  history: VerifiedHistory; // S4 output, never caller-asserted trust.
}
interface PlanOpeningRequest {
  tuple: RunTuple; // Exact S1 RunTuple, including plaintext subject hash.
  sheetCipherSha256: Digest;
  approval: ReviewOpenApproval;
  history: VerifiedHistory;
}
interface S3Verifier {
  verifySeal(input: VerifySealRequest): Result<{ manifestDigest: Digest }>;
  planOpening(input: PlanOpeningRequest): Result<OpenIntent>;
  verifyReview(input: S1VerifyReviewRequest): Result<{ reviewComplete: true; blockingVerdict: boolean }>;
  verifyRecovery(input: RecoveryReceipt, history: VerifiedHistory): Result<OpenIntent>;
  verifyMaterialisation(input: MaterialisationReceipt, history: VerifiedHistory): Result<Digest>;
}
```

S1VerifyReviewRequest는 S1 VerifyReviewRequest={tuple,target,receipt}의 같은 타입을 지칭한다.
RunTuple, Case4, ReviewTarget, ReviewReceipt, AuthoringSafetyReport와 그 내부 타입은
S1의 정확한 closed schema를 가져오며 새 field/enum을 추가하지 않는다. 공개 API token이
있다는 이유로 VerifiedHistory를 만들 수 없다. S4 trust root 검증의 결과만 전달한다.
verifyReview의 성공만으로 ordinal 2를 허용하지 않는다. continuationAllowed는 S4가 별도로
machine quality·현재 state·provenance를 합친 기술적 적격 지표이고 실제 dispatch에는 새 사람
승인까지 필요하다. extra_content는 유효한
review의 blockingVerdict=true일 수 있고, invalid receipt와 구분한다.

## Data Models — closed records와 digest

아래 listed field는 모두 필수이며 명시한 nullable 외에는 null/unknown/additional field를
거부한다. 공통 Digest는 lowercase 64 hex, Commit은 lowercase 40 hex, ID는 random
128-bit lowercase hex다. GitHub 숫자 ID는 양의 decimal string이고 시각은 UTC
`YYYY-MM-DDTHH:mm:ssZ`다. 문자열 ID는 NFC ASCII, raw source는 Base64 안에 보존한다.
set은 아래 순서, sequence는 사건/원문 순서다. digest self field를 임의 추가하지 않는다.

| Entity | Fields | Constraints / canonical order |
|---|---|---|
| BlobRef | path,byteLength,rawSha256 | private package 상대 POSIX 경로; bytes는 별도 보존; 경로순 |
| PrivateFile | path,byteLength,rawSha256,base64 | BlobRef + 표준 padded Base64; decoded hash/길이 대조 |
| AuthoringRulesView | schemaId,scoringVersion,sourceS1Sha256,sourceS3Sha256,normativeText | 마지막은 승인된 규범 전사 UTF-8 문자열; frozen 규범과 대응표 검증, 새 authority 아님 |
| QuotaProfile | cells,coverageEvidence:BlobRef,batchMin:25,batchMax:50,sampleNumerator:1,sampleDenominator:5,rejectThresholdNumerator:1,rejectThresholdDenominator:20 | cells={language,category,minimum} 8개, language/category ASCII 순; 정수 비율 |
| BundleIndex | schemaVersion:1,rules:BlobRef,quota:BlobRef,instructions:BlobRef,projectionApprovalDigest | 세 파일 exact; index raw hash를 authoring_bundle purpose로 서명 |
| AuthoringBundle | index:BundleIndex,files:PrivateFile[],signature:SignatureReceipt | index의 세 파일 전부, extras 0; files path 순 |
| IsolationManifest | sessionId,bundleIndexSha256,modelId,toolVersion,environmentImageDigest,toolAllowlist,accessPolicy:BlobRef,startedAt,endedAt,inputRefs,outputRefs,signatureReceiptDigest | toolAllowlist ASCII set; refs path 순; 서명은 signatureReceiptDigest 제외 body의 mem-isolation-1 |
| BatchReview | batchId,sessionId,cell,revisionDigest,caseIds,sampleSeedHex,sampledCaseIds,reviewedCaseIds,rejectedCaseIds,goldWitnessRefs,sensitivityRefs,regionRefs,diversityEvidence:BlobRef,adjudicationEvidence:BlobRef,adopted,reviewer,reviewedAt,signatureReceiptDigest | case 집합 ID 순; 전건 때 seed=null; cell={language,category}; refs 실제 S1 전건 검수 증거; 빈 adjudication도 명시 파일; mem-batch-review-1 |
| HoldoutDataset | schemaId,datasetVersion,evaluationUse:decision,cases:Case4[] | schemaId=mem-eval-schema-4; version은 고유 ID 문자열; Case4.id 순; 각 case S1 전건 검사 |
| DatasetManifest | schemaId,holdoutId,datasetVersion,casesIndex,quotaProfileDigest,scoringContractDigest | §3; casesIndex는 caseId 순, scoringStatements는 goldId 순 |
| SealEvidence | dataset:BlobRef,manifest:BlobRef,scoringDescriptor:BlobRef,freezeReceipt:BlobRef,contractApprovalCommit,activationCheckpointDigest,bundle:BlobRef,isolationRefs,batchReviewRefs,safetyReport:BlobRef,reuseReview:BlobRef,quotaEvidence:BlobRef,retentionProof:BlobRef,sealedAt,sealer,signatureReceiptDigest | refs path 순; 모든 연계 hash/서명 검사; mem-holdout-seal-1 |
| EncryptedObject | header,ciphertextBase64,tagBase64 | §4 closed header; tag=16 bytes, nonce=12 zero bytes, fresh key 한 번; raw cipher SHA 별도 |
| PrivatePackage | schemaVersion:1,kind,binding,files:PrivateFile[] | binding은 {scope:holdout,holdoutId,manifestDigest}, {scope:run,tuple:RunTuple,protocolDigest}, {scope:protocol,repositoryId,protocolDigest} union; holdout은 첫째, subject/review_sheet는 둘째만; receipt/evidence는 해당 단계 scope; path 순 |
| SignatureReceipt | payload,signatureBase64 | §4 exact fields/encoding; 자체 receipt digest는 외부 참조 |
| TrustAnchor | trustEpoch,signerId,keyId,publicKeyBase64,roles,validFrom,validUntil,revokedAt,registrationReceipt:BlobRef,previousEpochDigest | roles ASCII set; 시각 null은 무기한/미폐기만; 첫 epoch의 previous=null; 사람 등록 원본 보존 |
| KeyGrant | grantId,keyId,objectId,role,sessionId,unit,issuedAt,expiresAt,approvalDigest,stateCheckpointDigest,signatureReceiptDigest | unit=null은 seal용만, 나머지 S4 RunUnit; max 30분; mem-key-grant-1 |
| ReviewOpenApproval | tuple,sheetCipherSha256,reviewer,environmentPolicyDigest,purpose:redacted_review,approvedAt,signatureReceiptDigest | mem-review-open-approval-1; 실제 승인한 사람 |
| OpenIntent | intentId,tuple,sheetCipherSha256,sessionId,approvalDigest,stateCheckpointDigest,createdAt | mem-open-intent-1; journal durable 이후 key release |
| OpenReceipt | intentDigest,outcome,exposure,observedAt,signatureReceiptDigest | outcome=opened/failed/unknown; exposure=redacted_only/full/unknown; mem-open-observation-1 |
| RecoveryReceipt | previousIntentDigest,tuple,sheetCipherSha256,lastCheckpointDigest,exposure,newApprovalDigest,observedAt,signatureReceiptDigest | exposure=redacted_only/full/unknown; mem-open-recovery-1 |
| MaterialisationApproval | consumptionEventDigest,datasetRawSha256,absoluteRoot,accessPolicyDigest,approvedAt,signatureReceiptDigest | 승인 private root만; mem-materialise-approval-1 |
| MaterialisationReceipt | approvalDigest,consumptionEventDigest,datasetRawSha256,absolutePath,byteLength,completedAt,signatureReceiptDigest | 소비 불변; mem-materialise-1 |
| RetentionProof | objectRefs,keyBackupReceipt:BlobRef,stores,restoreEvidence:BlobRef,verifiedAt,signatureReceiptDigest | stores는 서로 독립인 opaque store ID 정확히 2개, ASCII 순; mem-retention-proof-1 |
| CleanupReceipt | sessionId,revokedGrantIds,volatileStoreReleased,keysReleased,publicAllowlistClean,completedAt,signatureReceiptDigest | 세 boolean 전부 true만 성공; ID 순; mem-cleanup-1 |

표의 mem-* signature body domain은 **signatureReceiptDigest 한 field만 제외한 body**에
적용하고 SignatureReceipt.payload.contentDigest로 결속한다. 표에 domain이 없는 BlobRef는
raw bytes hash다. Boolean/시각을 자기 보고로 신뢰하지 않고 signer 역할·보존된 관측 증거를
검증한다. authoring projection·diversity·사람 의미 판단은 signed strict UTF-8 보고서로
보존하며 기계가 의미의 참을 증명한다는 주장을 하지 않는다. 모든 BlobRef는 private package
정확한 파일과 연결돼야 하고, 파일이 없으면 path만으로 통과할 수 없다.

SignatureReceipt.purpose는 authoring_bundle, isolation, batch_review, holdout_seal,
key_grant, review_open, review_row, review_complete, open_observation, open_recovery,
materialise_approval, materialise, retention_proof, cleanup 및 S4의 명시적 purpose만 허용한다.
trust role은 authoring_reviewer / reviewer / approver / custodian / controller / importer이며,
사람 채택·검토에는 앞의 해당 사람 역할이 필수다. custody의 자기 서명만으로 scope를 늘리지 않는다.
DB entity/index/migration은 N/A — 이 문서는 저장 테이블을 생성하지 않는다.

해시 생성 순서는 dataset/case bytes → manifest → holdout package 암호문 → 그 암호문의
RetentionProof → SealEvidence와 detached seal signature → seal event다. holdout package에
자기 seal receipt/자기 암호문 hash를 넣지 않는다. 각 단계의 receipt는 별도 encrypted
보관물이며 다음 단계가 앞 단계만 가리킨다. RetentionProof에는 자기 자신을 포함하지 않고
이미 생성된 보관물만 열거한다. 완성된 seal receipt도 두 보관소 저장·읽기 확인 후에만 seal
event를 발행하며 그 전달 확인은 후속 관측이다. receipt를 넣으려고 기존 암호문을 다시 만들지 않는다.

## Review disposition — 새 승인에서 결정할 사항

P2-N1·C-COORD-1과 S1/S2가 수용한 R-SENS-1, R-GRAM-1, R-DETECTOR-1,
R-KO-SUBJECT-1, R-PRELEDGER-1, R-SCOPE-1을 변경하지 않는다. 아래는 **새 미승인 선택과
잔여**이며 기존 승인이 자동으로 덮지 않는다. S3/S4 최종 receipt는 exact 문서 SHA와 함께
이를 명시적으로 수용해야 한다.

- R-S3-ISOLATION: 규범 projection의 누락 0건은 사람 검토·환경 통제에 의존한다. 제한된
  grammar의 분포 편향과 단독 민감성 오판은 여전히 남고 floor는 대표성을 증명하지 않는다.
- R-S3-CUSTODY: AES-GCM per-object 일회 key, Ed25519 trust bootstrap, 30분 grant,
  분리된 보관소 두 곳과 복구 검증을 선택했다. custodian/controller 침해·OS side channel·
  RAM 잔존을 완전히 제거하지 못하며 구성 증명 부재는 실행 차단이다.
- R-S3-HUMAN: gold-withheld와 사람이 실제 본 내용을 되돌릴 수 없다는 한계가 남는다.
  conservative opened/consumed 때문에 실제 미노출 crash에서도 holdout을 잃을 수 있다.
- R-S3-RETENTION: 근거 사용 기간의 암호화 보존·별도 key backup은 장기 접근 위험과
  복구 운영 비용을 만든다. 복구 불능이면 과거 성공 표시 대신 재검증 불능을 기록한다.

## Out of Scope — 이번 작성이 하지 않는 것

- OS-1: scorer/ledger/custody/importer 구현, 테스트 코드·schema validator 생성.
- OS-2: 실제 case/gold/authoring bundle/holdout/key 생성, seal/open/materialisation.
- OS-3: succ-9 purpose activation, dataset·manifest·register·release gate 변경.
- OS-4: v9/S5 prompt 작성·활성화, pair·예산·dispatch·provider 호출 승인.
- OS-5: memoryExtractionEnabled 또는 memoryInjectionEnabled 변경, production 실행.
- OS-6: 이 초안의 독립 검토 완료·사람 승인 주장 또는 문서 밖의 승인 서명 대행.
