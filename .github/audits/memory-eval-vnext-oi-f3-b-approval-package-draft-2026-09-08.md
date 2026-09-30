# memory-eval vNext — OI-F3 B exact 설계·구현 승인 패키지 초안

**Author:** Codex
**Date:** 2026-09-08
**Status:** Draft — pending independent review and exact human approval
**Reviewers:** 독립 검토자 미지정; 사람 승인자 미지정
**Revision:** PB-R1 — PB-F1–PB-F4 response; pending confirmation and exact human approval

아래 Identity/CI/Document preparation verification과 JSON의 기존 identity/validation은
원 PB 작성 당시의 AOD/M 관측을 보존한다. 이번 수정의 authoring HEAD는 R이며,
최초 검토 결과·수정 범위·R 기준 검사는 끝의 PB-R1 구획과 JSON revision에 별도로 기록한다.
원 R에 대한 PASS_WITH_WARNINGS를 이 수정본의 확인 검토 결과로 승계하지 않는다.

## Context

이 문서는 사람의 **B 방향 선택**을 별도 승인 가능한 설계·파일 범위·시험 계약으로 구체화한
PB 패키지다. B는 선택됐지만 이 exact 패키지의 승인은 아직 없다. 원 Q의 F07 보장을
축소하는 A안이 아니며, 기존 구현 I의 F07 전체 충족을 소급 선언하지 않는다.
현재 작업은 문서 2파일 작성·검증뿐이다. 코드·helper·test·fixture 작성이나 실행은 하지 않는다.

[AOD 승인 기록](memory-eval-vnext-offline-subset-disposition-approval-2026-09-08.md)은
mposition의 2026-09-08 사후 처리방침 승인과 별도 B 선택을 결속한다. B 선택 회신은 별도의
날짜를 주지 않았으므로 selectedAt=null을 유지한다. 필수 조건은 root·nested·revoked Proxy,
bytes 경계, 거절 전 trap 실행 0회, 기존 정상 입력 결과 보존, 일반 JavaScript sandbox와의
구별이다. 이 조건의 채택 방향과 아직 미실행인 시험 결과를 분리한다.

현재 C01의 descriptor 검사는 ordinary getter 호출은 피하지만 Proxy 판별 전에
getPrototypeOf/getOwnPropertyDescriptors에 도달한다. C03의 message instanceof 검사는
try 밖이고 C04는 caller bytes.byteLength를 다시 읽는다. 따라서 C01 수정만으로 모든 bytes
진입점의 무호출 보장을 주장할 수 없다. 아래는 소스에서 도출한 설계이며 새 재현 실험의 결과가 아니다.

## Identity and approval boundary

```yaml
recordKind: oi_f3_b_exact_approval_package_draft
recordStatus: pending_independent_review_and_human_approval
packageLabel: PB
directionSelected: B
selectedBy: mposition
selectedAt: null
directionReceiptCommit: "42a99c4c5721a25b13894b99533b9800f4fb437b"
repositoryBasis: "65b82d5670e086ca77f39050ad48e68f56433f0e"
authoringHead: "42a99c4c5721a25b13894b99533b9800f4fb437b"
implementationReferenceCommit: "54ad04e29aa3390f4d342d152127e99928b4268e"
implementationReferenceParent: "718aaf974e254e32bcb010ff2c1170a06011eed5"
reviewCommit: null
decision: pending
approvedBy: null
approvedAt: null
exactImplementationPackageApproved: false
newBuiltinAuthorizedNow: false
implementationChangeAuthorizedNow: false
activationAuthorized: false
fullF07SatisfiedNow: false
externalReviewVerdict: null
```

M=repositoryBasis는 [PR #1284](https://github.com/mposition/Tomverse/pull/1284)의 SHA 보존
merge commit이다. parents는 d79d3c8673db4a9f5f4cd109bc99c50c21e182e3와
6294d7f54f0a85480b45dfb2f54f05b8d7dfc8ef다. AOD는 M의 조상이며 로컬 HEAD는 AOD다.
M은 이 패키지의 문서·코드 참조 기준이지 미래 실제 착수 tip이나 PB reviewCommit이 아니다.
이번에는 checkout/branch/index를 바꾸지 않았다.

2026-09-08 재조회에서 원격 develop locator는 fbfc4a84eb2637e9845103289c4ca76580a86765였다.
움직이는 locator를 승인 SHA로 쓰지 않는다. M의 develop CI
[34208999148](https://github.com/mposition/Tomverse/actions/runs/34208999148)과
[34208999175](https://github.com/mposition/Tomverse/actions/runs/34208999175)는 completed/cancelled다.
M CI 통과를 주장하거나 PR CI·다른 tip 성공으로 대용하지 않는다. 재실행은 요청하지 않았다.
문서 준비와 실제 구현 착수 조건은 별개이며 후자는 뒤의 Gate 절에 남긴다.

### Immutable source binding

| 대상 | 경로 | M Git blob raw SHA-256 |
|---|---|---|
| S1 | [원문](memory-eval-vnext-s1-scoring-contract-2026-09-06.md) | 393497a5acbe7ee47af6947a84204eac7723fdd973bf30afad79c812da4db0e7 |
| Q 문서 | [원문](memory-eval-vnext-offline-subset-approval-draft-2026-09-08.md) | 0b8668d8bf65f139895af13c126d43b1a277d6152582ec3ce857fc763b1310df |
| Q JSON | [원문](evidence/memory-eval-vnext-offline-subset-package-2026-09-08.json) | 7ad37a223dc20eea71a20f539d7778000d1b0ada4e61e6d3d64cffe25dcf6ed2 |
| RC 원 scope 승인 | [원문](memory-eval-vnext-offline-subset-approval-2026-09-08.md) | 44f8400b6b2338caa7443b97f7f47b72c8bb64951a9dd77078bf2b5140c8b498 |
| OD-R1 문서 | [원문](memory-eval-vnext-offline-subset-review-disposition-draft-2026-09-08.md) | aaf16425e8ff5ead15d3e25e71bce809ff15e481717a20f1ad6f08a64eab082a |
| OD-R1 JSON | [원문](evidence/memory-eval-vnext-offline-subset-review-disposition-2026-09-08.json) | 90e55c1f13471b5040103972d8476b8a10b51f67eaadd815a65fe42686693b11 |
| AOD B 방향 승인 | [원문](memory-eval-vnext-offline-subset-disposition-approval-2026-09-08.md) | 144ca91255bf45e5d924285ccb2516be63cc749bc001262245840c3e2f25cae3 |

[동반 JSON](evidence/memory-eval-vnext-oi-f3-b-approval-package-2026-09-08.json)은
상위/승인/구현 36파일의 M blob OID·raw SHA와 authoring HEAD/working raw SHA,
support 9파일, 보존 기준, 시험 추적성을 담는다. 36파일의 M/HEAD Git bytes는 같다.
working CRLF hash를 Git LF hash로 대용하지 않는다. support 중 package.json과
scripts/check-doc-references.mjs는 M/HEAD bytes가 달라 로컬 검사를 M 검사라고 부르지 않는다.

PB Markdown이 규범 초안이고 JSON은 그 raw SHA에 일방향 결속한 보조 근거다.
JSON 자체/미래 receipt/commit SHA를 자기 hash 계산에 넣지 않는다.
향후 사람 승인은 **두 파일 각각의 path+최종 raw SHA-256 및 reviewCommit**을 별도 receipt로
결속해야 한다. 이 표는 상위 원문 identity이지 그 원문을 새로 승인하는 서명란이 아니다.

### 기존 계약과의 관계

- Q §4의 기존 builtin 한정은 그대로 보존한다. PB-D2만 그 정확한 추가 예외를 요청한다.
- Q JSON futureCases/F07의 Then은 “invalid_input; accessor 호출 등 사용자 코드를 실행하지 않음.”
  이다. Q 원문·과거 not_run·I 검토 결과는 수정하지 않는다. PB는 Proxy를 사전 거절하는
  구체적인 보강 의무를 더하며, 거절 후 trap 실행을 허용하는 식으로 보장을 줄이지 않는다.
- S1 §7 mem-cjson-1의 값 허용집합·NFC·키 순서·정수·escape·UTF-8·LF 규칙은 바꾸지 않는다.
  PB의 bytes adapter 규칙은 object CJSON 허용집합과 별개다.
- OI-F1 시점 공백 accepted residual/closure=false, OI-F2 ID/path 별도 결정,
  OI-F4 runner 별도 범위, ODR-F1 외부 closure 부재를 유지한다.
  OD-R1의 CONFIRMED는 PB에 귀속되지 않는다.

## Requested exact decisions

아래 5건은 **한 묶음의 승인 요청 제안**이며 전부 pending이다.
방향 B의 기존 승인이나 문서의 commit/CI 성공만으로 자동 채택되지 않는다.

| ID | 요청하는 exact 결정 | 범위와 대가 |
|---|---|---|
| PB-D1 | 기존 6파일 중 C01/C03/C04/T01/T11 5파일만 변경 | bytes 경계를 위해 C03/C04 포함; C02 및 6파일 밖 불변 |
| PB-D2 | C01에 node:util types.isProxy/isUint8Array, 한정 intrinsic snapshot; T01에 node:vm runInNewContext | PB-D3와 불가분 승인 묶음; 새 builtin 승인 요청; vm은 상수 cross-realm 시료 생성 전용이며 sandbox 아님 |
| PB-D3 | genuine Uint8Array raw-storage 경계, private copy 및 명시된 호환성 예외 | PB-D2와 불가분 승인 묶음; Buffer/기존 정상 view 결과 유지와 genuine cross-realm 추가 수용을 함께 명시 승인 |
| PB-D4 | B01–B24·AC-1–AC-12·전 trap 0회와 회귀/정적 감사 기준 | 모든 미래 시험 not_run; 기존 40 unit/4 external 분류 보존 |
| PB-D5 | 미해결 잔여·비운영 경계·실제 착수 Gate 및 비소급 효력 | 새 구현 이후에만 판정; 운영 권한·활성화·full P 동결 없음 |

PB-D2와 PB-D3는 **불가분 승인 묶음**이다. native brand 설계에는 realm을 구별하는 단계가
없으므로 D2만 수용하고 D3를 거절하는 조합은 이 설계를 승인한 것이 아니다. 둘 중 하나만
수용하거나 어느 하나를 거절·보류하면 PB exact 승인 전체가 미완료이며, 구현·새 builtin 사용
권한은 생기지 않는다. D1·D4·D5도 포함한 다섯 결정 전부의 명시적 승인이 필요하다.
cross-realm 수용을 거절하려면 대체 설계·허용 범위·시험을 별도 exact 패키지로 정의하여
검토·승인받아야 한다. 임의 realm/prototype 동일성 검사를 추가하여 정상 subclass 또는
Proxy-prototype genuine view의 B12/B13·AC-5 결과를 바꾸는 권한은 주지 않는다.

### Exact file allowlist

| ID | path | 미래 변경 권한 제안 | 허용 책임 |
|---|---|---|---|
| C01 | lib/memoryEvalVnext/protocol/canonicalJson.ts | 수정 제안 | 재귀 Proxy guard, copyByteInput, decode/raw-hash bytes adapter |
| C02 | lib/memoryEvalVnext/protocol/wire.ts | 읽기 전용 | checkWire의 C01 경유 보호를 시험; schema·scalar grammar 불변 |
| C03 | lib/memoryEvalVnext/protocol/signatures.ts | 수정 제안 | verifyPureEd25519의 message 경계만 private copy 사용 |
| C04 | lib/memoryEvalVnext/protocol/trust.ts | 수정 제안 | compareBlobRef/compareGitFileRef의 bytes snapshot·길이 결속 |
| T01 | tests/memoryEvalVnextWire.test.mjs | 수정 제안 | B 음성·회귀 시험, 별도 B inventory |
| T11 | tests/fixtures/memory-eval-vnext/wire-vectors.json | 수정 제안 | 기존 값 불변 + 선언형 proxySafety 구획 추가 |

신규 구현 파일 0개, dependency/package/lock/config/runner 변경 0개다.
공통 helper를 다른 폴더로 빼거나 barrel/API를 만들지 않는다.
C01–C04의 기준 raw SHA는 다음과 같고 T01/T11도 JSON에 결속한다.

- C01: 5af07e3d71ac9b0e3504f973264576aaf0934a7ffc0c15fc258adde95fbdd2a0
- C02: f2cd8e85f3215a8b67ed23b515e83ea790c67486aac76eb02977cbd05079bb31
- C03: c9b9848004b868180b25d2615acfd7518e59bda3b440a89e49b18448648f82a9
- C04: b0d3a2212370b69d1860c7b52b246f3e396cebedd8a8feeb82b553b5213ce757

### Imports and trusted operations

C01의 기존 node:crypto createHash는 그대로이며 신규 node:util 사용은 types.isProxy와
types.isUint8Array 두 함수 참조로 한정한다. 임의 util API나 V8 internalBinding을 호출하지 않는다.
프로토콜 내부 export copyByteInput 하나를 추가하고 C03/C04에서 그 helper만 추가 import한다.
C02 import/export 및 closed wire type/지원 purpose/ID-path grammar는 그대로다.

신규 intrinsic 사용은 trusted Uint8Array constructor, trusted %TypedArray%.prototype의
length getter/set method, 이를 가져오는 Object.getPrototypeOf/Object.getOwnPropertyDescriptor,
호출하는 Reflect.apply로 한정한다. 참조는 module 초기화 때 trusted builtins에서 확보한다.
기존 자체 생성 Buffer/array/object 연산은 유지할 수 있다. caller 객체에서 메서드를 얻지 않는다.

T01의 신규 node:vm runInNewContext는 외부 문자열/코드가 아닌 상수 식의 Uint8Array 생성에만
허용하는 제안이다. test-only structuredClone의 transfer는 자체 생성 ArrayBuffer detach 시료에만
쓴다. 기존 OS-F3의 volatile 합성 서명 시험 권한을 확대하지 않으며 새 operational key를 만들지 않는다.

공식 Node v22.22.2의 [native type predicate](https://github.com/nodejs/node/blob/v22.22.2/src/node_types.cc)는
Proxy 판별을 V8 type 검사로 연결한다. [Uint8Array predicate 구현](https://raw.githubusercontent.com/nodejs/node/v22.22.2/lib/internal/util/types.js)은
캡처된 TypedArray intrinsic을 사용한다. Context7의 Node 22 문서도 함께 대조했다.
[ECMAScript 2024 typed-array set 규칙](https://tc39.es/ecma262/2024/multipage/indexed-collections.html#sec-settypedarrayfromtypedarray)은
genuine typed-array source를 array-like property 접근과 다른 경로로 복사한다.
[V8 12.4.254.21 typed-array-set.tq](https://raw.githubusercontent.com/v8/v8/12.4.254.21/src/builtins/typed-array-set.tq)도
버전을 고정해 대조했다. source를 JSTypedArray로 분류한 경로에서 target/source 양쪽의
EnsureAttachedAndReadLength가 srcLength 0 조기 반환보다 먼저 있고, array-like 경로의
ToObject/GetLengthProperty와 구분된다. 이는 설계 근거이지 특정 Node binary의 빌드 증명은 아니다.
이로부터 아래 무호출 설계를 도출했다. 공식 문서/소스 읽기는 미래 구현의 trap 0회 실증이나
Node/V8 버전 변경의 자동 승인으로 대체되지 않는다.

## Functional Requirements

- FR-1: PB는 MUST 방향 B 승인과 exact 패키지 승인·구현 착수를 분리하고 상위 bytes/잔여를 보존한다.
- FR-2: C01 serializer는 MUST 각 object/function 값에 대한 관측 가능한 연산보다 먼저 native isProxy로 거절한다.
- FR-3: C01은 MUST ordinary object data value와 dense array element를 재귀 검사하여 nested/revoked Proxy도 거절한다.
- FR-4: CJSON 경계는 MUST 기존 accessor/toJSON/custom iterator를 호출하지 않으며 기존 mem-cjson-1 결과를 보존한다.
- FR-5: C02 checkWire 및 이를 사용하는 C03/C04 object 경계는 MUST C01의 검증된 자체 snapshot만 후속 검사에 쓴다.
- FR-6: 모든 bytes 경계는 MUST isProxy → isUint8Array brand → intrinsic private copy 순서를 지킨다.
- FR-7: bytes 소비자는 MUST hash/decode/native verify/길이 비교를 private copy에서만 수행하고 caller 속성을 다시 읽지 않는다.
- FR-8: detached/out-of-bounds bytes는 MUST invalid_input으로 반환하며 attached empty view와 구별한다.
- FR-9: Proxy 거절은 MUST invalid_input이며 모든 측정 trap/hook 0회, native 예외 유출 0건이어야 한다.
- FR-10: PB-D2·PB-D3가 불가분 묶음으로 함께 승인된 경우 genuine cross-realm Uint8Array는 MUST raw-storage 경계로 수용하되 CJSON object 범위를 넓히지 않는다.
- FR-11: 기존 정상 입력은 MUST byte-for-byte canonical/hash/framing 결과와 기존 성공/실패 코드·metadata를 보존한다.
- FR-12: 미래 diff는 MUST 위 5파일 및 한정 import/helper/fixture 변경 안에 있고 C02 bytes는 불변이어야 한다.
- FR-13: T01/T11은 MUST B inventory를 별도로 추가하고 기존 F01–F44와 상위 54 AC 분류를 보존한다.
- FR-14: 시험은 MUST 전 trap 계측·누락/중복/skip 점검·우회 민감도 및 정적 호출 감사를 결합한다.
- FR-15: 모든 결과는 MUST offline_component_only/authorityEstablished=false 경계를 유지하며 운영 권한을 발급하지 않는다.
- FR-16: 구현은 MUST exact 승인 receipt·SHA 보존 계보·실제 tip CI/support/환경 재검증 및 별도 착수 지시 뒤에 시작한다.

### 거절 순서와 관측 경계

typeof/null/identity 비교는 허용된다. Proxy에 Array.isArray, instanceof, prototype/descriptor/
ownKeys/property 접근을 먼저 시도한 뒤 catch하는 구현은 불합격이다.
함수는 호출/생성하지 않고 invalid_input으로 거절한다.
ordinary object의 prototype이 Proxy이면 그 포인터가 허용 prototype과 다름만 비교해 거절하며
prototype 자신을 탐색하지 않는다. 재귀 active-set의 순환 거절과 반복 참조 허용을 유지한다.

도달 가능한 CJSON own data value가 재귀 대상이다. accessor/symbol/non-enumerable extra 등은
기존 구조 규칙에서 값을 실행하지 않고 거절한다. bytes API의 의미 있는 입력은 view raw storage다.
bytes 객체의 사용하지 않는 own metadata에 Proxy가 들어 있어도 그것을 찾아 순회하지 않는다.
무관한 metadata까지 전수 거절하려다가 사용자 hook을 실행하는 설계는 채택하지 않는다.

### Bytes boundary algorithm

1. helper는 caller input에 native isProxy를 먼저 적용하고 true면 invalid_input을 반환한다.
2. native isUint8Array로 genuine view임을 확인한다. duck typing/instanceof로 대신하지 않는다.
3. trusted intrinsic length getter를 Reflect.apply로 호출하여 storage 길이를 얻는다.
4. trusted Uint8Array constructor에 숫자 길이만 전달해 별도 view를 만든다.
5. trusted typed-array set을 새 view에 적용하고 genuine source와 숫자 offset 0만 전달한다.
   길이 0이어도 이 검증/복사를 생략하지 않아 detached/out-of-bounds를 거절한다.
6. 이후 처리에는 새 view만 전달한다. native 오류는 기존 invalid_input으로 정리한다.
   비교 함수에서는 같은 private snapshot으로 hash와 길이를 결속한다.

금지: caller에 Buffer.from, new Uint8Array(caller), spread/for-of/Array.from, caller.slice/set,
caller의 length/byteLength/buffer/byteOffset/constructor 읽기, Symbol.iterator/species/toPrimitive/
toStringTag 호출, Object.prototype.toString 기반 판별. 자체 생성한 안전한 copy에 대한 기존
Buffer 변환은 금지가 아니다. intrinsic set의 genuine-source 경로를 우회하는 복사는 금지다.

### 정상 입력·호환성의 정확한 뜻

기존 계약상 정상 CJSON 값·canonical/file-with-single-lf bytes·공개 서명 검증·비권위 비교 결과는
모두 보존한다. 새로운 numeric/depth/size cap이나 ID/path 제한을 추가하지 않는다.
Buffer, attached empty/offset Uint8Array, 정상 subclass의 같은 storage는 같은 bytes로 처리한다.
genuine view가 가진 shadow getter/iterator/constructor도 호출하지 않는다.

**명시적 차이:** Proxy wrapper는 과거 우연히 통과했어도 거절한다. fake view 및 detached/OOB는
거절한다. genuine cross-realm Uint8Array는 기존 instanceof 거절과 달리 허용하는 PB-D2·PB-D3
불가분 묶음 제안이다. 이 호환성 예외만 거절하고 나머지 설계로 구현을 시작할 수 없다.
genuine view의 custom prototype/shadow byteLength로 유도된 과거 결과를 보존 대상으로 삼지 않고
실제 storage를 따른다. 이 예외 목록을 숨긴 채 모든 JavaScript 입력의 결과가 같다고 말하지 않는다.
cross-realm object/array를 CJSON 정상 값으로 추가하는 결정은 아니다.

SAB/RAB/GSAB-backed genuine view는 호출 중 bytes와 길이가 안정적일 때 같은 storage 결과를
보존한다. 다른 thread/native 코드의 동시 변경에 대한 원자 snapshot·일관성은 보장하지 않는다.
이 전제는 Proxy trap 실행을 허용하는 예외가 아니라 byte 내용의 결정성 한계다.

## Non-Functional Requirements

- NFR-1: 보안 — 각 시험에서 13종 Proxy trap 및 별도 hook counter 합계는 MUST 0이다. 임의 JS sandbox 보장은 0건이어야 한다.
- NFR-2: 신뢰성 — 요구된 음성 입력의 uncaught exception은 MUST 0건이고 기존 정상 vector 결과 차이는 MUST 0건이다.
- NFR-3: 범위 — 신규 운영 I/O·provider/DB 호출·환경 읽기·운영 key/signature 생성은 MUST 0건이다.
- NFR-4: 비용 — bytes snapshot 추가 작업은 MUST 입력 길이 n에 대해 O(n) 시간/공간이며 전역 cache·새 quota는 0개다.
- NFR-5: 감사성 — B24개 case group·기존40 unit scenario의 누락/중복/skip은 MUST 0개다. 외부4 case는 별도 증거를 가져야 한다.
- NFR-6: 재현성 — MUST 실행 commit/Node/V8/OS/tsx/lock·실제 package flags를 기록하고 신규 실패와 기준선 실패를 이름별 구분한다.

성능 절대 시간 SLA·OOM/native crash 격리·UI 접근성·HTTP 가용성은 N/A다.
입력 의존 연산만 다루는 in-process component이며 native 자원 고갈을 catch 가능하다고 보장하지 않는다.
trusted Node runtime/intrinsics가 전제다. module import 전후의 전역 monkeypatch, debugger,
caller 자체의 사전 실행·동시 악성 코드 전체를 통제하지 않는다.

## API Contracts

HTTP endpoints: N/A — 로컬 TypeScript component 계약이며 HTTP route를 만들지 않는다.
기존 공개 함수 signature/오류 union/wire version은 변경하지 않는다.
추가하는 protocol-internal helper 계약만 다음과 같다.

```typescript
interface OfflineResultMetadata {
  scope: "offline_component_only";
  authorityEstablished: false;
}
type ComponentError = "invalid_input" | "unsupported_subset" | "bytes_mismatch"
  | "signature_mismatch" | "binding_mismatch" | "authority_unavailable";
type ComponentResult<T> =
  | ({ ok: true; value: T } & OfflineResultMetadata)
  | { ok: false; error: ComponentError };
declare function copyByteInput(input: unknown): ComponentResult<Uint8Array>;
```

copyByteInput은 새 private copy를 반환하며 authority를 만들지 않는다.
componentValue/componentError는 기존 단순 포장 helper로 데이터 validator가 아니고 input을 실행하지 않는다.
이 둘에 임의 값 전수 탐색을 추가하지 않는다.

| 경계 | 전체 대상 함수/인자 | 보호 경로 |
|---|---|---|
| C01 object | encodeCanonical(input), domainSha256(domain,input)의 input | 재귀 guard; domain은 primitive-only |
| C01 bytes | copyByteInput(input), decodeCanonical(input,mode), rawSha256(input) | 직접 안전 복사; mode primitive-only |
| C02 object | checkWire(kind,input), 5종 closed type 모두 | encode/decode 자체 snapshot; kind coercion 없음 |
| C03 object | signatureMessage(input), signatureReceiptDigest(input), verifySignatureReceipt(input,key,expectedPayload) | 모든 object 인자 checkWire; key primitive-only |
| C03 bytes | verifyPureEd25519(message,key,signature) | message 안전 복사; key/signature primitive-only |
| C04 object | compareTrustBinding(payload,anchor,expected,time), compareBlobRef(ref,bytes,expected), compareGitFileRef(ref,bytes,expected) | 모든 object 인자 기존 C01/C02 snapshot |
| C04 bytes | compareBlobRef/compareGitFileRef의 bytes | private snapshot의 hash/길이 |
| scalar/negative capability | C02 scalar predicates·decodeBase64·requiredRole, C04 digest 비교·availability 함수 | 기존 primitive/상수 처리; coercion·권한 발급 없음 |

bytes 진입점은 새 helper 포함 6개다. 각각 direct/revoked/typed-array Proxy를 시험한다.
검증 실패 우선순위는 invalid_input → unsupported_subset → bytes_mismatch →
signature_mismatch → binding_mismatch → authority_unavailable라는 기존 Q 계약을 유지한다.
여러 인자가 잘못돼도 Proxy를 읽어 우선순위를 계산하지 않는다.

## Acceptance Criteria

모든 AC와 B case의 implementationExecution은 **not_run**이다. 아래는 미래 완료 조건이다.

### AC-1: Root/revoked 거절 (FR-2, FR-9, NFR-1, NFR-2)

Given object/array/function의 active·throwing·revoked·다중 Proxy.
When encodeCanonical에 각각 전달한다(B01–B03).
Then invalid_input, uncaught exception 0, 각 trap counter 0이다.

### AC-2: 재귀와 기존 hook 보호 (FR-3, FR-4, FR-9, NFR-1)

Given data value/array element/mixed graph의 Proxy 및 ordinary accessor·custom prototype 시료.
When encodeCanonical/domainSha256을 각각 호출한다(B04–B06).
Then invalid_input이며 trap/getter/setter/toJSON/iterator를 한 번도 실행하지 않는다.

### AC-3: Object 진입점 전수 (FR-5, FR-9, NFR-1)

Given API 표의 모든 object 인자 위치를 번갈아 바꾼 root/nested/revoked Proxy와 나머지 정상 인자.
When C02 5종/C03/C04를 각각 호출한다(B07–B08).
Then invalid_input·trap 0을 유지하며 C02 bytes 변경 없이 전이 보호가 성립한다.

### AC-4: Bytes의 선행 판별 (FR-6, FR-9, NFR-1, NFR-2)

Given Uint8Array/Buffer Proxy와 fake view/DataView/ArrayBuffer/다른 typed-array 시료.
When 6 bytes entry를 각각 호출한다(B09–B10).
Then invalid_input이며 instanceof·getter·iterator·native 예외 유출이 없다.

### AC-5: 정상 view와 명시된 adapter 변경 (FR-7, FR-10, FR-11, NFR-1, NFR-4)

Given offset/empty/Buffer/subclass/cross-realm 및 안정적인 SAB/RAB/GSAB view와 shadow hook.
When PB-D2·PB-D3의 불가분 공동 승인에 따른 bytes 처리를 수행한다(B11–B14).
Then raw-storage expected bytes/hash/length와 일치하고 unused metadata/모든 hook은 실행하지 않는다.
새 cross-realm 허용은 명시된 호환성 변경으로 보고하며 기존 정상 결과 차이는 0이다.

### AC-6: Detached/OOB와 copy 독립성 (FR-7, FR-8, NFR-2, NFR-4)

Given 자체 소유한 detached/OOB view 및 정상 view.
When bytes 검증 또는 copy 반환 뒤 원 storage 변경을 수행한다(B15–B16).
Then detached/OOB는 invalid_input, attached empty는 타입 경계 통과이며 copy는 원본 변경과 독립이다.
empty의 실제 decode/signature 결과는 각 API의 기존 의미 규칙대로다.

### AC-7: 오류 우선순위와 scalar 경계 (FR-9, FR-11, NFR-2)

Given Proxy invalid와 unsupported/mismatch 조합 및 scalar 자리에 Proxy/boxed primitive.
When 해당 API를 호출한다(B17–B18).
Then 기존 계약의 오류/false를 반환하고 coercion/trap/예외 유출은 0이다.

### AC-8: 기존 정상 결과 회귀 (FR-4, FR-11, FR-13, NFR-2)

Given I의 기존 golden/caseTrace/acTrace/upstreamDisposition과 공개 signature vector.
When 기존 40 unit scenario와 B19를 실행한다.
Then canonical bytes/hash/domain framing/성공·실패·metadata 차이 0, 44 case 분류 불변이다.
OS-F3의 기존 volatile 합성 서명 범위만 사용하며 private 자료를 fixture에 저장하지 않는다.

### AC-9: Exact diff 감사 (FR-12, NFR-3)

Given 실제 구현 commit의 parent/diff/import/export/fixture subtree.
When B20으로 static audit한다.
Then 위 5파일 밖 변경 0, C02 hash 동일, 신규 import/helper가 한정 목록과 정확히 일치한다.

### AC-10: 시험 증거의 민감도와 완전성 (FR-13, FR-14, NFR-5, NFR-6)

Given B01–B24 inventory와 13 trap counter 및 기존 F40/F42/F43/F44 외부 감사 구분.
When B21–B22로 실행 등록/완료/skip 및 격리 임시 검증에서 guard/copy 우회를 대조한다.
Then 누락·중복·skip 0이고 우회 시 관련 음성 시험이 실패한다. 수정 소스를 제출 트리에 남기지 않는다.
외부 감사 미실행을 unit pass로 치환하지 않는다.

### AC-11: 비운영·비소급 유지 (FR-1, FR-15, NFR-3)

Given 원 승인 문서·I·새 구현/시험 결과.
When B23으로 호출 경로와 결과/잔여를 감사한다.
Then 운영 I/O/권한 발급 0, 상위 54 AC partial 9/deferred 45/fullySatisfied 0 및 기존 잔여 불변이다.
새 시험 성공을 I 당시 F07 충족이나 OI-F1 시점 공백 해소로 쓰지 않는다.

### AC-12: 실제 착수 Gate (FR-16, NFR-6)

Given 고정된 PB 두 bytes, 독립 검토, 사람 exact receipt와 미래 develop tip.
When B24로 아래 Gate를 확인한다.
Then 모든 결속/CI/환경/지원 파일·명시적 지시가 확인될 때만 새 branch 구현을 시작한다.
누락 시 문서 준비 상태로 남고 임의 설치·CI 재실행·권한 확대를 하지 않는다.

## Test plan

### 계측 규칙과 fixture 작성 범위

13 trap은 getPrototypeOf, setPrototypeOf, isExtensible, preventExtensions,
getOwnPropertyDescriptor, defineProperty, has, get, set, deleteProperty, ownKeys, apply, construct다.
각 counter를 분리해 전부 0인지 확인한다. getter/setter/toJSON/Symbol.iterator/
Symbol.toPrimitive/Symbol.toStringTag/constructor/species hook도 별도 counter를 둔다.
fixture 생성·revoke가 끝난 뒤 counter를 초기화하고, API 호출 전후 구간만 측정한다.
assertion/error formatting이 Proxy를 JSON.stringify/inspect하여 시험 자체가 trap을 부르지 않게 한다.

forwarding handler와 호출 즉시 throw하는 handler 양쪽을 포함한다. 모든 trap 0인 결과가
계측 누락 때문에 얻어진 것이 아닌지 B22에서 확인한다. 임시 mutant 실행도 미래 구현/검증
단계의 승인 범위에서만 수행하며 현재는 시료·코드·테스트 stub을 만들지 않는다.

T11은 Proxy를 JSON에 직렬화하지 않는다. 새로운 proxySafety 배열에 id/acId/fixtureKind/
placement/expectedError/trapNames/hookNames/expectedInvocationCount를 선언하고 T01이 합성
fixture를 생성한다. trapNames는 위 13개 전부, hookNames는 getter, setter, toJSON,
Symbol.iterator, Symbol.toPrimitive, Symbol.toStringTag, constructor, Symbol.species의
8개 전부를 중복 없이 포함한다. expectedInvocationCount는 literal 0이며 각 이름의 counter에
개별 적용한다. trap/hook 총합만 보고하지 않는다. 필수 이름·counter·기대값이 빠지면
검증 불완전이며 통과로 처리할 수 없다. 이는 선언형 규격이고 현재 T01/T11은 수정하지 않는다.
기존 모든 top-level subtree 값과 기존 caseTrace/acTrace 순서·값을 그대로 보존한다.
새 B 그룹의 등록/완료 set은 기존 F41 set과 분리한다. B01–B19는 unit 시험 구획이고
B20–B24는 정적·외부 감사/사전 Gate 구획이다. T01이 외부5건을 실행했다고 표시하지 않는다.
이 분류는 기존 F40/F42/F43/F44 외부4건과 별개이며 양쪽을 누락 없이 대조한다.

| Case group | AC | 필수 coverage |
|---|---|---|
| B01 | AC-1 | root object/array Proxy; forwarding 및 throwing handler |
| B02 | AC-1 | root callable/constructable Proxy 및 Proxy를 다시 감싼 Proxy |
| B03 | AC-1 | revoked object/array/function Proxy; 예외 유출 없음 |
| B04 | AC-2 | object data value, array element, mixed deep graph의 active/revoked Proxy |
| B05 | AC-2 | ordinary object의 Proxy prototype; 포인터 비교 후 거절 |
| B06 | AC-2 | 기존 getter/setter, toJSON, iterator, symbol, custom prototype, cycle 거절 |
| B07 | AC-3 | checkWire 5종의 root 및 구조상 가능한 각 nested data 위치 |
| B08 | AC-3 | C03 object 입력 전부; C04 ref/expected/anchor/payload/expectation 입력 전부 |
| B09 | AC-4 | 6 bytes entry의 Uint8Array/Buffer Proxy: active, throwing, revoked |
| B10 | AC-4 | fake typed array, DataView, ArrayBuffer, Uint8ClampedArray, other typed array 거절 |
| B11 | AC-5 | attached empty, nonzero offset, Buffer slice, stable RAB/SAB/GSAB view의 정확한 bytes |
| B12 | AC-5 | genuine Uint8Array subclass의 shadow getter/constructor/species/iterator/toJSON 무호출 |
| B13 | AC-5 | genuine cross-realm Uint8Array 및 Proxy prototype view; raw-storage 처리 |
| B14 | AC-5 | bytes의 사용하지 않는 own property에 Proxy가 있어도 탐색/호출하지 않음 |
| B15 | AC-6 | detached 및 out-of-bounds view; 0 길이처럼 보이는 경우 포함 |
| B16 | AC-6 | copyByteInput 반환 후 원 buffer mutation으로 반환 copy가 바뀌지 않음 |
| B17 | AC-7 | invalid object/bytes와 unsupported purpose·mismatch의 조합 우선순위 |
| B18 | AC-7 | scalar-only 인자에 Proxy/boxed primitive; coercion·trap 없이 기존 오류/false |
| B19 | AC-8 | F01–F44 inventory 및 기존 40 unit scenario; golden bytes/digests/결과 보존 |
| B20 | AC-9 | 5파일 diff/import/export/fixture 허용 범위 및 C02 hash 불변 정적 감사 |
| B21 | AC-10 | F40/F42/F43/F44 외부 감사와 B 계측의 누락·중복·skip 판별 |
| B22 | AC-10 | guard/copy 우회 시 시험이 실제 실패하는 민감도 확인; 격리된 임시 검증 |
| B23 | AC-11 | 운영 호출·권한 발급·새 secret 0; 기존 residual/54 AC 상태 보존 |
| B24 | AC-12 | 승인 bytes/계보, 실제 tip CI·support9·환경·명시적 착수 지시 확인 |

## Data Models

| Entity.field | Type | Constraints |
|---|---|---|
| PB.approval | pending metadata | reviewCommit/approvedBy/approvedAt null; 자기 승인 아님 |
| SourceBinding | path + commit + blob OID + raw SHA-256 | M/HEAD/working bytes 구분; 후속 tip 자동 대체 금지 |
| ByteSnapshot | Uint8Array | genuine source view 범위만 새 storage로 복사; 운영 payload 저장 없음 |
| ComponentResult | TypeScript union | 기존 metadata/error union; 새 wire 필드 없음 |
| BCase | id/acId/coverage/implementationExecution | B01–B24 unique, AC-1–AC-12 참조, 현재 not_run |
| TrapCounters | 13개 이름별 nonnegative integer | API 측정 구간에서 각각 0; hook counter 별도 |
| ProxySafetyCounters | trapNames + hookNames + expectedInvocationCount | trap 13개/hook 8개 완전·고유 목록; literal 0을 이름별 적용; 누락은 검증 불완전 |
| FutureEvidence | commit + runtime + command + exit + case results | baseline/new failure·skip 구분; 실제 실행 뒤 작성 |
| FutureApprovalReceipt | 두 path/hash + reviewCommit + 사람 판단/날짜 | PB 원문 불변; 별도 기록, 아직 생성하지 않음 |

DB schema/persistent model: N/A — 운영 저장소·ledger/등록 schema를 만들지 않는다.

## Edge Cases

- EC-1: revoked/function/중첩 Proxy — B01–B04/B09; native 사전 거절, trap 0, invalid_input.
- EC-2: Proxy prototype·accessor·symbol·cycle — B05–B06; 구조 거절 자체가 hook을 부르지 않는다.
- EC-3: 위장 view/own shadow getter/cross-realm — B10–B14; brand+intrinsic 경계와 명시적 호환성 규칙.
- EC-4: detached/OOB/attached empty/nonzero offset — B11/B15; 0 길이 조기 성공 금지, view 밖 bytes 미포함.
- EC-5: 공유/가변 storage의 동시 변경 — 원자 snapshot 보장 없음; B11은 안정적 storage 시료만 사용.
- EC-6: native predicate/getter/set 실패·자원 부족 — 검증 가능한 예외는 invalid_input, OOM/process 격리 보장은 없음.
- EC-7: runtime/intrinsics 변조 또는 지원 버전 차이 — 신뢰 전제 불성립; B24에서 재승인 필요 여부 판단 후 중단.
- EC-8: 잘못된 mode/kind/key/time 및 다중 invalid — B17–B18; primitive 검증, 오류 우선순위 보존.
- EC-9: unit runner ENAMETOOLONG/CI cancelled — 결과를 통과로 대체하지 않고 OI-F4/실제 tip Gate에 남긴다.

## Out of Scope

- OS-1: 현재 code/helper/test/fixture 변경·실행, commit/push/PR/merge/CI dispatch — 문서 작성만 지시됐다.
- OS-2: C02 변경 및 기존 6파일 밖 구현·dependency/package/lock/runner 수정 — 별도 exact 범위다.
- OS-3: 임의 JavaScript sandbox, process/worker 격리, monkeypatch 방어, 동시 메모리 원자성 — input boundary 보장과 다르다.
- OS-4: OI-F2 ID/path grammar 변경, OI-F4 runner 수정, 과거 OI-F1/ODR-F1 closure 재작성 — 기존 보류/잔여다.
- OS-5: scorer/ledger/full P/resolver/controller/운영 adapter, trust registration/폐기·root/journal/checkpoint — 이 subset 밖이다.
- OS-6: 실제 key/signature/TrustAnchor, EnvironmentApproval/ClockPolicy/genesis, 백업/복구 운영 — 별도 운영 승인이다.
- OS-7: S2 purpose/activationApprovalCommit/C, dataset/manifest/register 변경 — 본 문서는 activation 승인 아님.
- OS-8: holdout 작성/검수/seal/open, S5/v9 prompt 작성·활성화 — 순서와 별도 승인을 유지한다.
- OS-9: pair/예산/dispatch/provider 호출/유료 turn, production/Railway/DB 접속·설정·배포 — 허용하지 않는다.
- OS-10: release gate, memoryExtractionEnabled/memoryInjectionEnabled 변경 — 어떠한 flag도 변경하지 않는다.

## Gate, effective scope and completion

1. 별도 제출 지시가 오면 PB 두 파일의 exact bytes만 commit하고 40자 reviewCommit을 고정한다.
   untracked 문서나 basis M을 검토 commit으로 대용하지 않는다.
2. 고정 commit을 대상으로 독립 검토한다. 새 builtin·bytes 설계·호환성 예외·13-trap 계측과
   파일 allowlist를 함께 본다. 차단점 수정 뒤 한정 확인 검토는 최대 한 번을 제안한다.
   이는 PB의 회차이며 기존 OD-R1/D의 완료된 회차를 초기화하는 뜻이 아니다.
3. 사람이 PB-D1–PB-D5 전부와 두 파일 각각의 hash/reviewCommit에 exact 승인한다.
   PB-D2·PB-D3는 불가분 묶음이며 일부 수용·거절·보류는 구현/새 builtin 권한을 만들지 않는다.
   별도 receipt를 작성하며 PB 원문 pending/null은 작성 시점의 사실로 보존한다.
4. 별도 publication/merge 지시 아래 PB/receipt의 원 SHA를 보존한 merge commit으로 develop에
   반영한다. 실제 착수 tip/해당 CI·원문 hash/승인 ancestry를 확인한다.
5. RC §7의 support 9개, M→실제 tip diff, Node/V8/tsx·설치 dependency/lock, package flags/
   test discovery를 **별도 사전 기록으로 재결속**한다. 이 초안의 로컬 검사를 대용하지 않는다.
6. 위 조건이 충족된 tip에서 새 codex/ branch를 만들고 별도 구현 착수 지시에 따라 5파일만 고친다.
7. 실제 구현 commit과 검증 evidence를 결속한 뒤 AC 전건을 판정한다. 보강된 F07의 효력은
   검증된 해당 구현 SHA 및 이후 별도 재검증된 후속 SHA에만 귀속한다. I를 소급 통과 처리하지 않는다.

현재 미승인 초안에서는 newBuiltinAuthorizedNow/implementationChangeAuthorizedNow=false다.
AC 전건의 구현·시험 완료가 없는 지금 fullF07SatisfiedNow=false를 유지한다.
문서 승인 완료와 구현 완료, component 완료와 전체 P/활성화 완료는 각각 별개다.
A=3f14afb29eddc243640fdb0a5a4f604646ade9f0 등 기존 approvalCommit을 PB/receipt로 치환하지 않는다.
D<K<activationApprovalCommit<C, 하위 verifier 동결→실제 정책 등록→trustPolicyDigest→전체 P
채택→genesis/root, S2 전환 검증→F 동결→holdout seal→S5→E/pair/예산/dispatch 순서는 그대로다.

## Document preparation verification

로컬 PC PowerShell, H:/Project/ai-chat-hub clone, 기존 Node v22.22.2/V8
12.4.254.21-node.39/win32 x64에서 수행한다. production 자격증명 없이 package script를
실행하고 필요한 OS/PATH/TEMP만 child에 전달한다. DOTENV_CONFIG_PATH는 부재 확인한
.os-f4-absent-env-file, DOTENV_CONFIG_QUIET=true, NEXT_TELEMETRY_DISABLED=1로 child에만
설정한다. 원 창 환경·.env·dependency/운영 설정은 바꾸지 않는다.

작성 전 tracked/index clean인 AOD HEAD에서 7개 package script를 실행했다.
encoding:strict/policy-section-references/release-records/memory-eval-succ9/
memory-extraction-eval/memory-eval-freeze는 exit 0, doc-references는 exit 1/기존 8건이다.
8건은 app/layout.tsx 참조에 대한 lib/documentLanguage.ts, app/[locale]/layout.tsx,
scripts/security-regression-check.mjs, tests/e2e/ssr-root-language.spec.ts의 Windows missing
4건과 대응 POSIX historical unused 4건이다. 전체 출력 SHA는
a71fe18e693b1d3bd8a77f83701bf950e0d8cef5635c3330ba9e85d466d2ac6a다.
작성 후 같은 7개 script를 다시 실행했고 exit·전체 출력 bytes·SHA가 작성 전과 7/7 같았다.
신규 실패 0건이며 실행 시각·exit·출력 hash·이름 대조는 JSON validation에 기록한다.

package checker가 untracked 초안의 모든 내용/링크를 보장하지 않으므로 추가로 두 파일의
strict UTF-8(fatal decode), BOM/CR/후행 공백/끝 LF, JSON parse, hash·FR/AC/B 추적성,
상대 링크, diff --check/no-index --check, 기존 36+9파일·untracked 21개·ignored 3개 보존을 검사한다.
.claude/·.codex/ directory는 건드리지 않으며 내부 전수 hash를 했다고 주장하지 않는다.
spec-driven-workflow validator는 98/100, 오류 0·경고 1, exit 1이었다. 남은 경고는
HTTP method/path가 없다는 일반 항목이며 이 component 문서에는 N/A로 명시했다.
경고를 없애기 위해 가짜 HTTP endpoint나 범위 밖 API를 만들지 않는다. 수동 계약 대조도 적용한다.
검증기 결과는 문서 완결성 검사이지
독립 검토나 사람 승인, API 구현 시험의 대체물이 아니다.

이번 작성에서는 T01/전체 unit suite/lint/typecheck/새 Proxy probe·fixture·keygen/signing을
실행하지 않는다. PB B01–B24는 모두 not_run이다. 기존 실행 보고서를 이번 시험 결과로
복사하지 않는다. GitHub 조회는 PR/CI 상태 read-only 확인뿐이며 재실행·환경 변경은 없다.

## PB-R1 review response and R verification

이번 수정의 authoring HEAD와 원 검토 commit R은
60486e971c94a189ab418c4743f48428a402ea52이며 parent는 M이다.
R의 원문 Git object는 수정하지 않는다. 아래 원 hash는 최초 검토 대상의 identity이지
수정본 승인 hash가 아니다. 수정본 MD의 최종 raw hash는 JSON document가 결속한다.

| 원 R 대상 | raw SHA-256 |
|---|---|
| PB Markdown | 5465da2fcd13dd920cbfdd7e1cfbc5f05575ce36f4524f726acbcf227007dc53 |
| PB JSON | eb15aec4a53c605bc97e82bd9a38b189e0af499e9c2e42b54c5ab089f89c807e |

사용자가 전달한 Claude 최초 독립 검토 보고서의 raw SHA-256은
76989963726c2a1a0b0334269af46588fadd23cbb7a9debfaf1e384149b0b1a7이다.
로컬 수신 경로는 JSON revision.initialReview에 기록한다. R에 대한 판정은
PASS_WITH_WARNINGS(P1 0/P2 1/P3 3), 차단 finding 0건이었다.
이 판정은 사람 승인·수정본 CONFIRMED·F07 구현 통과가 아니다.

| Finding | 이번 문서 대응 | 상태 |
|---|---|---|
| PB-F1 (P2) | D2/D3 불가분 승인과 부분 수용 시 권한 없음; cross-realm 거절은 별도 대체 패키지 필요 | 초안 반영, 확인 검토 대기 |
| PB-F2 (P3) | T11 선언에 hookNames·expectedInvocationCount 추가; trap/hook 전부 이름별 0과 누락 시 불완전 | 초안 반영, 확인 검토 대기 |
| PB-F3 (P3) | 버전 고정 V8 source를 보조 설계 근거로 추가; 기존 표준 링크 보존 | 초안 반영, 확인 검토 대기 |
| PB-F4 (P3) | 기존 AOD validation 불변; 이번 R clean 기준 7개 결과를 별도 결속 | 별도 관측 기록, 확인 검토 대기 |

2026-09-08T10:46:41.713Z의 R HEAD에서 tracked/index clean과 보호 대상 36+9파일을
고정한 뒤, 수정 **전** 7개 package script를 실행했다. 명령은 각각 npm run <script>이며
위와 같은 무자격증명 child 환경을 사용했다. 실행 시각·exit·전체 출력·출력 SHA-256은
JSON revision.verification.cleanRBaseline에 있다. 다른 문서의 과거 실행을 복사한 것이 아니다.

| R clean 기준 script | exit / 결과 |
|---|---|
| check:encoding:strict | 0 / 통과 |
| check:policy-section-references | 0 / 통과 |
| check:release-records | 0 / 통과 |
| check:memory-eval-succ9 | 0 / 통과 |
| check:memory-extraction-eval | 0 / 통과 |
| check:memory-eval-freeze | 0 / 통과 |
| check:doc-references | 0 / 통과 |

R의 policy 검사는 citation 4101/named 2451/unscoped historical 1421을 보고했고,
doc-reference 검사는 733 referenced paths/92 instruction documents/860 comment paths/
2570 source files가 모두 존재한다고 보고했다. AOD의 policy 4059/2424/1406 및
doc-reference 기존 8건 실패와 다른 **R의 관측**이다. AOD 결과를 R의 실패로 전이하거나
R 결과로 AOD 기록을 덮어쓰지 않는다. 수정 후 검사는 R+작업 파일 변경 위에서 수행하며
JSON revision.verification.afterWriting에 별도로 기록한다. 로컬 검사는 develop CI 증명이 아니다.

이번 수정의 확인 검토 commit은 아직 없다. 별도 commit 지시 뒤 R을 parent로 하는 두 파일
수정 commit의 40자 SHA를 고정하고, 그 SHA와 두 raw hash에 결속한 한정 확인 검토를
최대 한 번 진행한다. 원 R이나 untracked prompt를 수정본 reviewCommit으로 대용하지 않는다.
PB-D1–PB-D5는 계속 pending이고 승인 receipt·구현·fixture·새 시험 결과는 생성하지 않는다.
