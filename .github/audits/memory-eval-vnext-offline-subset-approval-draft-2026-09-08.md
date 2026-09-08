# memory-eval vNext — N-F1 반영 및 첫 offline subset 승인 요청 초안

**Author:** Codex
**Date:** 2026-09-08
**Status:** In Review — DRAFT_OFFLINE_SUBSET_APPROVAL_PENDING
**Reviewers:** 이 패키지의 독립 검토 및 사람 판정 대기
**Document ID:** MEM-EVAL-VNEXT-OFFLINE-SUBSET-1

## Context — 검토된 N 이후의 좁은 승인 요청

사용자가 요청한 것은 N-F1 반영과 offline subset **승인 패키지 작성**이다.
이 요청은 구현 승인이 아니다. 현재 decision=pending, approvedBy/approvedAt=null이며
코드·테스트·fixture·key·운영 signature를 생성하지 않는다. 이번 산출물은 이 문서와
[동반 근거 JSON](evidence/memory-eval-vnext-offline-subset-package-2026-09-08.json) 두 파일뿐이다.

N의 최초 독립 검토는 PASS_WITH_WARNINGS, 새 P1/P2 0건, P3 두 건이다. N-F1은 C04의
등록 원문 parser 형식을 구현자가 발명할 위험을 지적했다. N-F2는 작성 당시 기록을 고치라는
요청이 아니라 후속 착수 시점의 develop 반영·CI를 확인하라는 조건이다. **검토자는 N만
검토했다. 이 새 패키지는 아직 Claude가 검토하거나 사람이 승인한 문서가 아니다.**

### 1. Identity, 승인 계보, 후속 사실

| 이름 | 고정 Git commit / 의미 |
|---|---|
| B | 48df8e428061003115aad8d66c27fd1dddd56f7a — R의 parent |
| R | 2a13acea05805f18528a205d5caeba37f0d800c9 — 넓은 bootstrap·P 준비 범위 |
| N | 2b652cb9f8a729b40fe325be06503f92a62c524d — 최초 검토된 NEXT-1 상세안; parent=R |
| M / repositoryBasis | 0c6b3fec7cfb68f5a2fc4e4a492de7905b413bff — PR #1274의 SHA 보존 merge; parents=[B,N] |

이번 branch는 codex/memory-eval-vnext-offline-subset-approval이다. 원격 develop=M 및
tracked/index clean을 확인하고 M에서 만들었다. M tree=N tree이며 R/N은 모두 M의 조상이다.
N 본문·JSON과 R 원문은 그대로 보존한다. N의 “R은 develop 미포함”·검토 대기 문언은
작성 당시 사실이며 소급 수정하지 않는다. 새 제한은 이 패키지의 **첫 subset에만** 적용한다.

N의 원문은 memory-eval-vnext-bootstrap-p-next1-detailed-plan-2026-09-07.md이며
raw SHA-256은 ea0fc284e9c2aa2eca3a1cefc517552ae537c28aa3ec07c77990c4fd1ea153a8이다.
N의 evidence/memory-eval-vnext-bootstrap-p-next1-plan-2026-09-07.json raw SHA-256은
8b7ae1357a66f569cb7b9f0caa588b1093ce4e00e5a39d777567bf44620ea8a8이다.
두 경로는 이 문서와 같은 audits 디렉터리를 기준으로 한다.

검토 보고서 원본은 C:/Users/Vyper/.codex/attachments/f03f32b2-4035-4af2-affd-d5753bb7ffec/pasted-text.txt,
raw SHA-256은 569f9ef21a0918855e1baba91b915e4802906b2a340ca6e090fafe9064da9ce3이다.
이 hash는 **사용자 제공 검토 보고서만** 식별하며 승인 대상 문서 hash가 아니다.
보고서 원본은 Git에 추가하지 않는다. 지적 수용·수정 설명은 작성자 disposition이며
CONFIRMED 판정을 만들어 쓰지 않는다.

M의 develop push CI 두 건을 attempt 1, headSha=M으로 재확인했다.

- [Admin Console E2E 34172915045](https://github.com/mposition/Tomverse/actions/runs/34172915045): 실제 Production build 및 E2E step success.
- [Credit Finance DB Integration 34172915046](https://github.com/mposition/Tomverse/actions/runs/34172915046): email/memory/finance/assistant/import/accounts/routing 7개 실제 test와 Require every lane to have passed success.

이는 M의 CI 사실이다. N의 PR Fast Gate는 workflow success지만 docs-only 변경으로 일부
build/smoke/UI step이 skipped였다. 보고서의 “steps 전부 success”를 전부 실행됐다는 증거로
전사하지 않는다. M의 CI는 새 패키지의 CI·offline 구현 시험·운영 적합성 증거가 아니다.

A=3f14afb29eddc243640fdb0a5a4f604646ade9f0,
CA=80842e62925c05af9450e6acc6ceb70b56f67655,
D=159267a80acee97da3a297c637343ea15de725f9,
K=6b2465e921c6e8b99ff032a36be8ada61c0ad599,
H=a19ae39d0da61295eb17e1545c74bc5b7e702c1a는 모두 M의 조상이다.
JSON.sourceFiles는 S1–S4/기존 승인/D/K/H 18개와 R/N 각 2개, 총 22개의
원 commit/path/blob OID/raw SHA/길이를 결속한다. 원문 decision 400줄·§13 공란도 보존한다.

### 2. N-F1 disposition — 전체 trust verifier가 아닌 component subset

| 구분 | 이번 패키지가 요청하는 것 | 요청하지 않는 것 |
|---|---|---|
| C04의 TrustAnchor | S3의 listed field·공개 key 길이·role set·명시된 시각/nullable 구조 검사 | caller anchor를 신뢰 root로 등록·채택 |
| epoch | payload/anchor/명시 expected 값의 exact equality, 불일치·미제공 거부 | epoch 번호/순서/발급 규칙 발명, 폐기 이력 chain의 완전성 인증 |
| purpose→role | D B-S2-01의 세 쌍에 대한 순수 비교 | 실제 사람 신원/등록/purpose 허용 사실을 비교값만으로 인증 |
| D/K GitFileRef | 명시적으로 전달된 commit/path/raw SHA와 bytes의 일치 검사 | Git 실행·DAG/보호/원 등록의 진위 검증 또는 K만으로 activation 허가 |
| 등록 원문 | registrationReceipt를 **opaque BlobRef**로 취급; bytes가 주어지면 길이/raw SHA만 비교 | Markdown/YAML/JSON 등록 원문 parser, 임의 schema 또는 policy extraction |
| trustPolicyDigest / previousEpochDigest | 이미 주어진 digest의 문법·expected equality만 | domain/입력 형식 추정, digest 생성·epoch chain의 신뢰성 판정 |

등록 원문 parsing, 실제 signer/key/epoch/purpose 허용, 폐기 운영 및 trustPolicyDigest 생성은
**HD-1 이후 별도 exact schema·scope 결정**이 필요하다. 이 문서의 local comparison 입력을
새 등록 wire로 저장하거나 opaque 원문에서 그 입력을 자동 생성해서는 안 된다.
같은 signer가 여러 role을 가질 수 있다는 사실과 그 권한을 받았다는 사실은 별개다.

원문이 닫지 않은 trustEpoch의 발급·순서·이전 epoch digest 산식, validity 경계의 운영 정책은
정하지 않는다. epoch는 NFC ASCII opaque 문자열의 동일성까지만 비교한다. 시각의 내부
비교는 명백한 범위 밖/폐기 후 거절만 검사하고 validFrom/validUntil/revokedAt에 정확히 걸린
운영 허용 판정은 후속 정책에 남긴다. 이 미정 부분을 숨겨 전체 TrustAnchor 유효성을 선언하지 않는다.

## Functional Requirements — 요청할 한정 권한

- FR-1: 작성자는 M/N/R/상위 승인 및 보고서 identity를 MUST 보존하고 이 초안을 승인 receipt로 사용해서는 MUST NOT 된다.
- FR-2: 미래 변경은 아래 6개 exact 경로와 각 경로의 한정 책임에만 MUST 머문다.
- FR-3: C01은 S1 §7의 mem-cjson-1 및 raw/domain hash 분리를 MUST 지킨다.
- FR-4: C02는 아래 공통 구조만 MUST 해석하고 미정 등록 원문·전체 business record를 파싱해서는 MUST NOT 된다.
- FR-5: C03은 PureEd25519 bytes 검증과 정확한 S3 message 구성만 MUST 수행하며 signer/custodian 기능을 export해서는 MUST NOT 된다.
- FR-6: C04는 §2의 구조·동일성·명백한 부적합 비교까지만 MUST 수행하고 trusted context나 운영 허가를 발급해서는 MUST NOT 된다.
- FR-7: T01/T11은 아래 AC 및 양성/음성 case 전부를 MUST 검사하고 에이전트가 시료·정답을 준비한다.
- FR-8: 별도 검토·사람 승인·고정 hash·후속 착수 조건 이전에는 구현을 MUST NOT 시작한다.

### 3. 정확한 미래 변경 allowlist — 현재는 전부 미생성

| ID | 경로 | 이 subset의 책임 | 허용 local import | 시험 |
|---|---|---|---|---|
| C01 | lib/memoryEvalVnext/protocol/canonicalJson.ts | CJSON encode/strict canonical decode, raw SHA, domain SHA | 없음 | T01/T11 |
| C02 | lib/memoryEvalVnext/protocol/wire.ts | BlobRef/GitFileRef/SignaturePayload/SignatureReceipt/TrustAnchor 공통 구조 | C01 | T01/T11 |
| C03 | lib/memoryEvalVnext/protocol/signatures.ts | message 구성·receipt digest·PureEd25519 검증; authorization 없음 | C01, C02 | T01/T11 |
| C04 | lib/memoryEvalVnext/protocol/trust.ts | §2 비교; D 세 purpose→role 쌍, ref/bytes·epoch equality | C01, C02 | T01/T11 |
| T01 | tests/memoryEvalVnextWire.test.mjs | 한정 component AC 전수; test-only 합성 envelope 시료 | C01–C04, T11 | 테스트 자체 |
| T11 | tests/fixtures/memory-eval-vnext/wire-vectors.json | 공개 known vector·한정 fixture 및 정답 | 없음 | T01 |

이 allowlist는 4개 runtime **후보 component**와 2개 test-only 파일이다. N의 C02 전체
S3/S4/D record decoder·C04 전체 등록 이력 책임·T02를 포함한 47개 후보 전체가 아니다.
C04가 C03을 import하거나 C03이 C04를 import할 필요 없이 테스트가 두 결과를 각각 검사한다.
새 helper/폴더 아래 임의 파일/adapter/API/schema/config/package 변경을 자동 허용하지 않는다.
임의 callback/plugin으로 미정 trust 검증을 주입하는 우회도 금지한다.

허용 builtin 사용 제안은 C01의 node:crypto hash, C02의 bytes/strict decoding,
C03의 node:crypto 공개 key 해석·verify뿐이다. 곡선 연산을 직접 구현하지 않는다.
새 외부 dependency, package.json/package-lock.json/tsconfig.json/runner/workflow 변경은 0개다.
기존 앱 module/scorer/resolver/DB/provider import도 금지다. T01의 node:test/node:assert,
T11 읽기 및 별도 승인 후 node:crypto의 volatile 합성 key/signature 생성만 시험 지원으로
쓰며 실제 운영 파일/환경변수/자격증명을 읽지 않는다. runtime component는 파일을 읽지 않는다.
후속 구현 시 설치된 Node/tsx/dependency와 lock의 일치를 확인하고 추가 설치·선정이 필요하면
그 부분을 중단해 별도 exact 권한을 요청한다. 현재 로컬 runtime 관측은 P 동결이 아니다.

T01은 tests/ 루트 .test.mjs이므로 기존 npm run test:unit에서 발견된다. 이 script는
추가 CLI 인자를 한 파일 filter로 전달하지 않으므로 `npm run test:unit -- <path>`를
대상 한정 실행이라고 안내하지 않는다. 이번 문서 작업에서는 unit 시험을 생성·실행하지 않는다.

### 4. Pure wire와 digest의 세부 경계

CJSON 입력은 null/boolean/string/safe integer/array/plain object만이다. 문자열은 이미 NFC여야
하며 NFD를 몰래 normalize하지 않는다. key는 고유 ASCII이고 byte 순 정렬, array 순서·중복은
보존한다. roles처럼 set인 field만 schema 순서를 검증하고 중복을 거절한다. serializer가 모든
array를 정렬하거나 deduplicate하지 않는다. raw source는 bytes로 hash하여 NFC view와 분리한다.

strict canonical decode는 raw bytes를 받으며 BOM·잘못된 UTF-8·duplicate key·추가 token을
거절해야 한다. JSON.parse 후 duplicate가 사라진 object만 검사해서는 안 된다. 숫자 -0,
지수 표기·소수 표기·비canonical escape/공백 등 canonical bytes가 아닌 입력은 거절한다.
encoder의 JS -0 입력은 정수 0으로 직렬화한다. undefined/NaN/Infinity/BigInt/function,
unpaired surrogate, sparse array, accessor/custom prototype/cycle은 유효 CJSON 입력이 아니다.
이 항목들은 객체 API의 input safety이지 새 protocol field/운영 정책이 아니다.

decode는 CJSON bytes와 **CJSON+단일 LF 파일** 모드를 구분한다. 기본 CJSON에는 LF가 없고,
명시적 파일 모드에서만 마지막 LF 한 개를 제거해 검사한다. trim()으로 둘을 섞지 않는다.
rawSha256은 LF를 포함한 원 bytes 그대로이고 H(domain,x)는 UTF8(domain+LF)||CJSON(x)다.
signature message는 H의 hex 문자열이 아니라 UTF8("mem-signature-1\n")||CJSON(payload)다.

| 공통 구조 | 정확한 field / 제한 |
|---|---|
| BlobRef | path,byteLength,rawSha256; byteLength safe non-negative integer, SHA 64 lowercase hex |
| GitFileRef | commit,path,rawSha256; commit 40 lowercase hex, repository-relative POSIX path |
| SignaturePayload | schemaVersion:1,purpose,signerId,keyId,trustEpoch,contentDigest,issuedAt |
| SignatureReceipt | payload,signatureBase64; decoded signature 64 bytes, 표준 padded Base64 |
| TrustAnchor | trustEpoch,signerId,keyId,publicKeyBase64,roles,validFrom,validUntil,revokedAt,registrationReceipt,previousEpochDigest |

listed field 누락/추가/null은 거절한다. TrustAnchor.validUntil/revokedAt 및 첫 epoch의
previousEpochDigest만 명시적 null을 구조상 운반한다. validFrom은 실제 달력에 존재하는
UTC YYYY-MM-DDTHH:mm:ssZ이며 만료·폐기 운반값도 같고 public key는 32 bytes다.
keyId는 S3 random 128-bit ID의 lowercase 32 hex 운반형이다. random 생성의 진실을
문자열 검사로 증명하지 않는다. signerId는 exact NFC ASCII 값이며 신규 D activation
approver의 경우에만 D ApproverId 문법을 추가 적용한다. 다른 role에 @ 금지를 소급하지 않는다.

상대 path는 절대/drive/backslash/빈 segment/dot/dotdot를 거절한다. symlink와 Git mode의
진위는 이 순수 구조 검사로 증명할 수 없고 실제 Git resolver가 담당할 후속 의무다.
Base64는 decode 후 표준 padded 재인코딩 equality와 decoded 길이를 검사한다. Node의
관대한 decoding 성공만으로 whitespace/URL-safe/누락 padding/비canonical pad bit를 받지 않는다.

C03 receipt purpose 처리와 C04 역할 비교의 **첫 subset 지원 목록은 D의 세 purpose뿐**이다:
s2_activation_approval→approver, s2_source_evidence→importer,
s2_activation_inclusion→importer. 나머지 S3/S4 purpose는 원 계약에서 유효할 수 있지만
이 component subset에서 미지원이라고 반환한다. 이를 원 계약에서 금지됐다고 재정의하지 않는다.
전체 purpose 목록·body domain별 business validation은 후속 범위다. contentDigest는 caller가
명시한 expected digest와 비교하되 그것을 실제 승인 body에서 유도했다는 인증은 하지 않는다.

## Non-Functional Requirements — 측정할 제한

- NFR-1: 이 문서/JSON은 strict UTF-8, BOM/CRLF/후행 공백 0, 끝 LF 한 개이며 기존 22 source bytes는 MUST 보존한다.
- NFR-2: 미래 C01–C04는 network/DB/fs read·write/child process/clock read/random/key generation/signing을 MUST 0회 수행한다.
- NFR-3: T01의 합성 key/서명은 별도 승인 후 volatile test 내부에서만 생성할 수 있다. 운영 key와 개인 seed는 MUST 0개 읽고 private key 출력·Git 보존은 MUST 0건이다.
- NFR-4: 미래 검증은 모든 AC/case에 대해 actual pass/fail/미실행을 MUST 기록한다. skip/누락을 성공으로 간주해서는 MUST NOT 된다.
- NFR-5: production 성능/SLA/격리·보안 인증은 N/A다. 이 패키지는 운영 배포물을 정의하지 않으며 그런 수치·통제의 달성을 MUST NOT 주장한다.

## API Contracts — 내부 component 제안, 운영 API 없음

HTTP endpoint/DB API는 N/A다. 아래는 승인 요청의 **비운영 내부 interface 제안**이다.
새 S2 Refusal enum·D wire·S3Verifier·ProvenanceVerifier를 정의하거나 대체하지 않는다.

```typescript
type ComponentError = "invalid_input" | "unsupported_subset" | "bytes_mismatch"
  | "signature_mismatch" | "binding_mismatch" | "authority_unavailable";
type ComponentResult<T> = { ok: true; value: T } | { ok: false; error: ComponentError };
interface ComponentCheck {
  scope: "offline_component_only";
  authorityEstablished: false;
  fieldsMatch: boolean;
}
```

C01의 결과는 canonical bytes 또는 raw/domain SHA, C02는 **구조만 검사된 값**,
C03은 bytes signature 일치 여부, C04는 ComponentCheck다. success의 의미는 각 component
검사에만 한정된다. 함수 이름에 issue/approve/activate를 쓰거나 VerifiedHistory,
HistoryContext, ApprovedTrustRoot, activation_complete/decision admission을 반환하지 않는다.

오류 우선순위 제안은 invalid_input → unsupported_subset → bytes_mismatch →
signature_mismatch → binding_mismatch다. 호출한 component에 해당하지 않는 단계는 실행하지
않는다. 운영 권한을 요청하는 사용은 authority_unavailable이며 필드 일치나 유효 서명으로
이 오류를 성공으로 바꾸지 않는다. 내부 error를 S2/S3/S4의 공개 refusal로 변환하는 facade는
이번 범위에 없다. malformed native crypto 입력의 원 exception/입력 bytes를 출력하지 않는다.

## Data Models — 감사용 패키지, 서명할 운영 object 아님

| JSON field | 의미 / 한계 |
|---|---|
| authorization | preparationAuthorized=true만 현재 권한; decision=pending, 승인자/일자/receipt commit=null |
| sourceFiles / supportFiles | 원 commit bytes 및 작업 bytes의 식별; 전체 P/dependency closure 아님 |
| review | N 보고서 target/hash/result와 작성자 N-F1/N-F2 disposition; 새 검토 결과 없음 |
| requestedImplementationFiles | 6개 미래 경로·책임·dependency/test 연결; 현재 생성되지 않음 |
| acceptanceCriteria / futureCases | 이번 subset의 전수 AC와 정상/음성 기대 결과; 구현 시험은 전부 not_run |
| upstreamAcDisposition | S3 12 + S4 17 + D 25 = 54개 AC의 부분 component/후속 의무 분리 |
| referenceGoldens | literal bytes/hash 계산 및 공개 RFC vector의 primitive 대조; P 구현 test 아님 |
| remainingDecisions / remainingOperations | HD 전체 및 OP 7개; pending을 수용/해결로 변경하지 않음 |
| validation | M tracked-clean 기준선과 작성 후 package script 결과·동일 실패 이름 |

local comparison의 expected D/K/anchor 값은 시험 입력이지 trust registration schema가 아니다.
그 값의 출처·진위·보호된 Git inclusion·사람 수용은 여전히 외부 authority 검증을 요구한다.
구조형 fixture를 운영 receipt 파일 경로에 저장하지 않는다. 미래 T11은 test-only JSON이며
기존 eval dataset/manifest/register 또는 holdout case와 무관한 공개 시료만 담는다.

## Acceptance Criteria — 첫 subset의 전수 수용 기준

각 AC는 동반 JSON의 futureCases와 1:다 대응한다. 아래는 **미래 구현 승인 후**의 기대 결과다.
이 문서 작성에서 6개 파일이나 그 구현 시험을 만들었다는 뜻이 아니다.

### AC-1: canonical bytes (FR-3)

Given G01–G04의 값 및 역순 object key가 있다.
When C01로 직렬화한다.
Then referenceGoldens의 UTF-8 hex·길이와 exact 같고 array 순서/중복은 유지한다.

### AC-2: canonical refusal (FR-3, FR-4)

Given NFD/비ASCII·중복 key/비정수·비유한 수/unsafe integer/깨진 UTF-8·surrogate/비canonical bytes가 있다.
When encoder 또는 strict decoder의 해당 경계를 검사한다.
Then invalid_input이며 normalize/trim/duplicate 삭제로 성공시키지 않는다.

### AC-3: raw, file, domain 분리 (FR-3, FR-5)

Given G01의 canonical bytes, 끝 LF를 붙인 파일, domain prefix를 붙인 message가 있다.
When 세 hash와 signature message를 구성한다.
Then 고정 정답과 일치하며 raw SHA·domain SHA·message bytes를 교환하지 않는다.

### AC-4: closed shape와 leaf 제약 (FR-4)

Given 5개 공통 구조의 정상 시료와 매 field의 누락/추가/불허 null/type 변형이 있다.
When C02를 검사한다.
Then 정상 구조만 수용하고 SHA/commit/ID/UTC/path/Base64 및 roles 정렬·중복 변형은 invalid_input이다.

### AC-5: PureEd25519 검증 (FR-5)

Given RFC G05 공개 vector 및 별도 승인 후 T01 내부에서만 만든 합성 S3 payload 서명이 있다.
When 원 message와 한 bit 변조·다른 message/key·잘못된 길이·ph/ctx 대용을 검증한다.
Then 원 primitive/합성 message만 일치하고 나머지는 구조 오류 또는 signature_mismatch다.
primitive 일치를 운영 signer 신뢰로 반환하지 않는다.

### AC-6: purpose·role·identity 분리 (FR-5, FR-6)

Given D의 세 purpose와 approver/importer 비교 시료 및 importer의 approval 대리 시료가 있다.
When purpose별 component와 exact signer/key/epoch/contentDigest를 대조한다.
Then 세 정해진 role만 fieldsMatch이고 역할/identity 교환은 binding_mismatch다.
S4 provenance_checkpoint 재사용은 unsupported_subset이며 사람/기계 권한을 추론하지 않는다.

### AC-7: epoch·등록 미정 경계 (FR-4, FR-6)

Given anchor의 공개 구조와 opaque registrationReceipt 및 명시 expected epoch/ref가 있다.
When C04에 값 불일치·누락·명백한 만료/폐기를 제출하거나 등록 원문 parsing/신뢰 판정을 요청한다.
Then 불일치는 거절하고 parser/신뢰 요청은 미지원 또는 authority_unavailable다.
같은 값이어도 authorityEstablished=false이며 epoch chain/domain/운영 시각 경계를 발명하지 않는다.

### AC-8: GitFileRef와 raw bytes (FR-4, FR-6)

Given expected D/K GitFileRef와 별도 제공 bytes, 그리고 commit/path/hash 각각을 바꾼 입력이 있다.
When 순수 결속 비교를 수행한다.
Then 불일치·bytes 부재는 거절한다. 동일 bytes라도 Git object 종류/ancestry/사람 승인 검증 완료는 아니다.

### AC-9: 합성 시험과 권한 비승격 (FR-6, FR-7, NFR-2, NFR-3)

Given T01/T11과 모든 정상 component 결과가 있다.
When 실행 의존성·입출력·반환형을 검사하고 운영 authorization을 요구한다.
Then network/실제 credential/운영 서명/DB write는 0이고 trusted context는 발급되지 않는다.

### AC-10: exact 파일·범위 (FR-2, FR-7, NFR-4)

Given 6개 파일의 구현 diff와 실제 import 목록 및 테스트 결과가 있다.
When 요청 allowlist·AC/case ID·상위 AC disposition을 전수 대조한다.
Then 추가 경로/숨은 import/빠진 case/skip이면 완료가 아니다. T02 등 후속 시험을 T01 통과로 면제하지 않는다.

### AC-11: 승인 전 실행 금지 (FR-1, FR-8)

Given 이번 초안과 N의 PASS_WITH_WARNINGS만 있고 새 사람 구현 승인은 없다.
When 다음 착수 여부를 판정한다.
Then 구현은 차단되며 과거 mposition 승인이나 merge/CI success를 새 승인으로 복사하지 않는다.

### AC-12: 문서와 감사 보존 (FR-1, NFR-1)

Given M과 기존 15 untracked 항목(일반 파일 13개)의 보존 기준선이 있다.
When 이번 두 파일과 raw hash·source·문서 참조·Git 상태를 검사한다.
Then 기존 원문/상태는 그대로이고 추가는 두 파일뿐이며 baseline과 신규 실패를 구분한다.

### 5. 상위 AC에 대한 전수 disposition

JSON.upstreamAcDisposition은 S3 AC-1–AC-12, S4 AC-1–AC-17, D AC-1–AC-25를 빠짐없이
열거한다. **어느 상위 AC도 이 subset만으로 fully satisfied가 아니다.** 관련 bytes/서명/참조
component가 있는 항목은 partial_components로, 이 범위 밖의 동작은 deferred로 구분한다.
상위 full contract 검증·환경·폐기 이력·DAG·실제 proof·사람 의미 판단은 후속 구현에 남는다.

예를 들어 S3 AC-4의 raw/Base64 일부는 여기서 검사하지만 fresh key/AEAD/crash 복구는 아니다.
S4 AC-15의 controller/importer journal/checkpoint 권한은 이번 세 purpose 목록 밖이므로 deferred다.
D AC-1의 ref 비교는 있어도 K/등록 원문/보호된 Git/사람 수용의 검증 완료가 아니다.
S1 AC-10은 CJSON·hash 부분만 연결하고 scoring inventory/statement resource_limit 부분은 제외한다.

### 6. 시료와 정답의 준비 상태

JSON.referenceGoldens의 G01–G04는 명시한 canonical literal bytes의 UTF-8 hex·길이·raw/file-LF/
domain SHA를 계산했다. domain 예제의 임의 작은 object는 receipt schema가 아니므로 실제
SignatureReceipt로 채택하지 않는다. G05는 [RFC 8032 §7.1 TEST 1](https://www.rfc-editor.org/rfc/rfc8032.txt#section-7.1)의
**공개 key/message/signature만** 옮겨 primitive 대조했다. secret seed는 포함하지 않는다.

예: G01 canonical은 {"a":"한","b":1}, 17 bytes이며 raw SHA는
67f2fd255e411935d63adb1352ddb23efd6054c61d3131965ab2809e0c10d61f다.
끝 LF를 붙인 raw file SHA는 56c2983b681f1fa15614e6d1426ddfb1600c469c6b10c804607b2f6533a51e57이다.
두 값을 혼동하지 않는다. 모든 정상/음성 변형과 기대 결과는 JSON.futureCases에 명시한다.

합성 S3 envelope의 양성 서명과 mutation은 별도 승인 뒤 T01에서만 생성할 **미래 시험**이다.
이번에는 key generation/signing을 0회 수행했다. 공개 G05 primitive 확인은 새 protocol 구현의
통과 증거가 아니다. [Node 22 crypto 공식 문서](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptoverifyalgorithm-data-key-signature-callback)는
Context7으로 읽어 null algorithm·key type에 따른 검증과 boolean 반환을 확인했다.
primitive 채택 제안은 Node 내장 검증이며 runtime image/P/dependency 최종 동결을 뜻하지 않는다.

## Edge Cases — 준비 중에도 남겨 둘 차단

- EC-1: 미정 등록 schema가 필요하면 C04 parser를 만들어 채우지 않고 별도 HD-1 결정으로 넘긴다.
- EC-2: caller public key로 signature가 맞아도 실제 등록/role·정책 권한은 성립하지 않는다.
- EC-3: previousEpochDigest/trustPolicyDigest 입력 산식이 필요하면 새 domain을 정하지 않는다.
- EC-4: 시각이 validity/revocation 경계와 같거나 epoch 이력이 불명하면 운영 허용 여부를 단정하지 않는다.
- EC-5: D의 새 approver handle에만 @ 없는 exact 규칙을 적용한다. 과거 @mposition과 타 role을 고치지 않는다.
- EC-6: canonical file + LF를 domain 입력에 넣거나 JSON.parse가 중복 key를 지우면 시험 실패다.
- EC-7: 새 파일/외부 dependency/runner 수정이 필요하면 6개 allowlist를 넓히기 전에 별도 승인한다.
- EC-8: upstream AC 일부 component 통과로 전체 AC·P·genesis·activation 완료를 선언하지 않는다.
- EC-9: 이 패키지 변경 후 이전 raw hash에 대한 검토·승인을 새 bytes에 재사용하지 않는다.

## 7. 사람에게 요청할 결정과 후속 순서

현재 아래 전부 **pending**이다. 승인 기록을 지금 만들지 않는다.

| 결정 항목 | 요청 내용 | 현재 |
|---|---|---|
| limitedOfflineImplementation | §2–§4의 제한을 포함한 6개 exact 파일 구현·합성 시험만 | pending |
| testOnlySyntheticSignatures | T01 내부 volatile 합성 key/signature와 공개 fixture만; 운영 signer export 없음 | pending |
| noAuthorityPromotion | component success는 trust/activation/운영 적합성을 뜻하지 않음 | pending |
| deferredRegistrationParser | HD-1 및 별도 exact 결정 전 parser/trust digest 생성·이력 authority 검증 제외 | pending |

이번 단계에서 정책/운영 담당자를 지정하지 않는다. HD-1–HD-8은 N의 pending/null을 유지한다.
향후 한정 구현 승인이 나더라도 HD-7 **전체 P 범위·최종 closure 승인**이 완료되는 것은 아니다.
한정 권한은 별도 receipt에 담고 전체 HD의 selectedValue를 조용히 채우지 않는다.

권장 인계는 이 두 문서 bytes/hash 고정 → 별도 지시로 문서 commit → 고정 commit 독립 검토
→ 지적 반영 및 필요한 한정 확인 → 사람의 한정 구현 승인 → 별도 authoritative receipt다.
검토 횟수·대상은 이 패키지에 따로 귀속하고 D 확인 검토 1/1 소진을 재시작하지 않는다.
이번 작성에는 commit/push/PR 요청이나 Claude 호출 권한이 포함되지 않는다.

사람 승인 receipt는 승인받은 **이 문서와 JSON 각각의 전체 raw SHA-256 및 문서 commit**을
함께 명시해야 한다. N의 hash나 검토 보고서 hash를 대신 쓰지 않는다. 이 초안의 pending
칸을 채워 승인 대상 bytes를 바꾸지 않고 별도 기록으로 남긴다. receiptCommit도 문서 commit과
다르며 둘 다 실제 생성 뒤 확인한다. 새 승인은 A/CA/K/activationApprovalCommit을 치환하지 않는다.

실제 구현은 승인 문서와 receipt의 원 SHA를 보존해 develop에 merge commit 방식으로 반영하고,
해당 tip CI·원문 hash·ancestry를 재확인한 뒤 그 tip의 **별도 새 codex/ 브랜치와 착수 지시**로
시작한다. 지금 만든 branch는 승인 패키지 문서용이다. 이 작성 지시나 이후 단순 PR 병합을
코드 착수 지시로 해석하지 않는다. 승인 의미가 불명확하면 정확한 6파일·한정 권한을 확인한다.

## Out of Scope — 기존 승인·잔여·운영 경계 보존

- OS-1: 이번 코드·테스트 skeleton/fixture 생성 및 scorer/F, ledger/P, resolver, controller/custodian/importer 구현.
- OS-2: 실제 key/서명/TrustAnchor 등록, registration parser, trustPolicyDigest 생성, epoch 폐기 운영, EnvironmentApproval/ClockPolicy 및 하위 verifier 구축.
- OS-3: genesis/root/journal/checkpoint/proof/attestation/retention·백업 복구 운영. 부분 구현으로 전체 P 동결 금지.
- OS-4: dataset/manifest/register/목적 전환·activationApprovalCommit/C, H의 resolver 9경로 제안 변경.
- OS-5: holdout 작성·검수·seal/open, S5/v9 prompt, pair/예산/dispatch/re-run/provider 호출.
- OS-6: production/Railway/DB/보호 설정·release gate·memoryExtractionEnabled·memoryInjectionEnabled 변경.
- OS-7: 기존 승인/검토 원문 변경, stage/commit/push/PR/merge/추가 자동 독립 검토 요청.

A/CA의 D1–D5·§12, P2-N1·C-COORD-1 및 기존 R-* 잔여, S3/S4 승인 N-1(controller key
분리)/N-2(no-contact closure)와 열두 잔여를 보존한다. D의 별도 namespace
s2_clarification_confirmation_2026_09_07 N-1–N-3는 요청-header 증명 공백/8개 rule 전부 OK/
ReplayEnvironment는 network 차단 증명이 아니라는 경계다. importer-attest와 새 D
EnvironmentAttestation을 채택하지 않으며 D 확인 검토 1/1은 소진 상태 그대로다.

OP-TRUST, OP-P-ROOT, OP-CUSTODY, OP-SOURCES, OP-ACTIVATION-APPROVAL,
OP-RESOLVER, OP-C-INCLUSION 7개는 계속 남는다. D<K<activationApprovalCommit<C,
원래 A/CA SHA, historical 122/forward 109 구분과 legacy admissible=true·quality FAIL·
workflow failure·pair revoked·ordinal 2 금지도 그대로다. 15 role/4 proof kind/8 rule을 바꾸지 않는다.
하위 verifier 동결→실제 정책 등록→trustPolicyDigest→전체 P 채택→genesis/root,
S2 전환 검증→F 동결→holdout seal→S5→E/pair/예산/dispatch 순서를 면제하지 않는다.

## 8. 문서 검증 및 한계

M tracked/index clean 상태에서 package scripts 7개를 기준선으로 실행했다.
check:encoding:strict, check:policy-section-references, check:release-records,
check:memory-eval-succ9, check:memory-extraction-eval, check:memory-eval-freeze는 exit 0이다.
check:doc-references는 기존 Windows 경로 참조 8건으로 exit 1이며 JSON에 이름을 보존한다.
작성 후 같은 7개 scripts로 재실행한 exit code·출력이 기준선과 전부 같았다. 새 실패는 0건이다.
이번 작업과 무관한 8건은 수정하지 않는다.

audits는 doc-reference/policy 의미 검사 범위 밖이므로 상대 링크·source hash·위치·AC 전수성·
MD/JSON allowlist/권한 일치·strict raw UTF-8는 별도 대조한다. git diff --check와 신규 파일의
no-index diff/whitespace도 검사한다. 기존 13개 untracked 일반 파일 hash·15개 항목을 보존하고
현재 실제 추가 두 문서와 미래 6개 구현 경로를 구분한다. 구현 시험·전체 closure·운영 proof는 미실행이다.

spec-driven-workflow를 사용해 FR/AC/음성 case/상위 AC의 범위 추적을 작성했다.
strict spec validator는 98/100, 오류 0·HTTP endpoint 경고 1로 exit 1이다. 이 경고는 내부
component-only 문서에서 N/A로 기록하며 가짜 endpoint를 추가하지 않는다. 이 점수는
구현·운영·독립 검토·사람 승인을 대신하지 않는다.
