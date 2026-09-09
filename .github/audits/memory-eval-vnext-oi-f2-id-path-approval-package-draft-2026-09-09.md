# memory-eval vNext — OI-F2 ID/path exact 승인 패키지 초안

**Status: DRAFT — 독립 검토·사람 승인 대기. 구현 승인/착수 아님.**
작성자: Codex. 작성일: 2026-09-09.
Document ID: MEM-EVAL-VNEXT-OI-F2-ID-PATH-1. Revision: IP-1.

## 1. 목적과 현재 권한

사용자는 PR #1306의 병합을 확인한 뒤 OI-F2 ID/path 허용 규칙을 확정할 별도 승인 패키지
작성을 요청했다. 이 문서는 그 **새 결정의 제안**이다. 기존 “보류 유지” 수용, OI-F3 B 승인,
이번 작성 지시를 아래 IP-D1–IP-D5의 사람 승인으로 옮기지 않는다.

현재 산출물은 이 Markdown과
[동반 evidence JSON](evidence/memory-eval-vnext-oi-f2-id-path-approval-package-2026-09-09.json)
두 파일뿐이다. Markdown은 규범 제안, JSON은 그 exact raw SHA에 일방향 결속한 출처·관측·시험
명세다. 두 파일의 최종 path/raw SHA-256과 실제 reviewCommit을 나중의 별도 receipt에 함께
결속한다. JSON hash를 Markdown에 다시 넣어 순환시키거나 자기 hash/미래 commit을 발명하지 않는다.

~~~yaml
recordKind: oi_f2_id_path_exact_approval_package_draft
recordStatus: pending_independent_review_and_human_approval
packageLabel: IP
proposalVersion: oi-f2-id-path-1
repository: mposition/Tomverse
repositoryBasis: 17b074c600e98e8fe52175ea0cbc6c5860b0c742
predecessorMergeCommit: c8b5f28ca331b9594865d949f17d1aee0a250ee1
predecessorApprovalReceiptCommit: b98509dcd9ac9c19e389dece4da429301e2510aa
implementationReferenceCommit: e0a8c743695fce278592c29e85d32279fa1f2b85
documentCommit: null
reviewCommit: null
decision: pending
approvedBy: null
approvedAt: null
approvalReceiptCommit: null
requiredDecisionIds: [IP-D1, IP-D2, IP-D3, IP-D4, IP-D5]
acceptedDecisionIds: []
preparationAuthorized: true
policyChangeApprovedNow: false
implementationChangeAuthorizedNow: false
implementationStartAuthorizedNow: false
externalReviewVerdict: null
oiF2ExternalClosureDeclared: false
fullF07OrFullPDeclared: false
activationAuthorized: false
operationalSigningAuthorized: false
paidExecutionAuthorized: false
~~~

proposalVersion은 감사 문서의 식별자다. 운영 wire field·runtime 옵션·새 schemaVersion이나
등록 형식이 아니다. approvedBy/approvedAt=null은 실제 미판정이며 기존 mposition 날짜를 복사하지 않는다.

## 2. 병합·작성 기준과 원문 결속

[PR #1306](https://github.com/mposition/Tomverse/pull/1306)은 2026-09-09T10:09:42Z에
merge commit c8b5f28ca331b9594865d949f17d1aee0a250ee1로 병합됐다.
parents는 57dd6c96646f4aecb8f0bbb31499ed882044a289와
b98509dcd9ac9c19e389dece4da429301e2510aa다. IB → BF → BF-R1 → 최종 receipt의
원 SHA가 merge 및 아래 작성 기준의 조상임을 Git DAG로 확인했다. squash/rebase가 아니다.

- IB: e0a8c743695fce278592c29e85d32279fa1f2b85
- BF: fe7c4704be1bfb2165c2436ccea460bc6f7aa18f
- BF-R1: e0208c34a3d12b67c9d1e0ec0d92b720637d02a6
- BF-R1 수용 receipt: b98509dcd9ac9c19e389dece4da429301e2510aa

PR 검사 11개는 성공이었다. 그러나 merge 자체의 develop push CI
34338724051/34338723999는 cancelled였고, 다음 tip 8d36839ff854378c4cfef10331b9d7bc57a4e13c의
34339179916/34339179917도 cancelled였다. 취소를 통과로 기록하지 않는다.
동일 ref의 새 실행이 이전 실행을 취소하는 workflow concurrency 설정과 부합하는 관측이다.
개별 취소 행위자의 감사 로그까지 확인한 것은 아니다.

문서 작성 basis와 branch 생성 시 원격 develop은 **17b074c600e98e8fe52175ea0cbc6c5860b0c742**였다.
2026-09-09T10:28:22.967Z 관측에서 이 tip의 다음 두 push/develop 실행이 completed/success임을 확인했다.

- [Admin Console E2E 34339410878](https://github.com/mposition/Tomverse/actions/runs/34339410878): Production build와 실제 Admin E2E step success.
- [Credit Finance DB Integration 34339411069](https://github.com/mposition/Tomverse/actions/runs/34339411069): 7개 lane의 실제 financial DB test 및 Require every lane to have passed success.

두 run은 모두 attempt 1이다. 실패 증거 업로드/실패 lane 보고 등의 skipped step을 실제 시험 실행으로 세지 않는다.
merge→basis 차이는 memory-eval vNext와 무관한 감사 문서 3파일뿐이며 JSON에 exact path를 열거했다.
관련 원문·구현 45개는 merge와 basis의 raw Git hash가 같았다.
tracked/index clean 및 기존 untracked 28항목 보존을 확인한 뒤 이 tip에서
codex/memory-eval-vnext-oi-f2-id-path-approval 브랜치를 만들었다.

CI 통과는 **이 작성 기준의 저장소 검사**다. 미래 IP 구현 시험·운영 readiness·배포 확인이
아니며 취소된 과거 SHA의 CI를 소급 성공시키지 않는다. 작성 기준을 고정한 뒤 원격 ref가
더 이동해도 이 문서의 basis는 자동 변경되지 않는다. 새 실제 구현 착수 tip은 다시 확인한다.

주요 근거의 아래 hash는 작성 기준의 Git blob raw bytes를 식별한다.
이 초안의 승인 대상 hash나 검토 보고서 hash로 대용하지 않는다.

| 근거 | 경로 | Git raw SHA-256 |
|---|---|---|
| S1 | [memory-eval-vnext-s1-scoring-contract-2026-09-06.md](memory-eval-vnext-s1-scoring-contract-2026-09-06.md) | 393497a5acbe7ee47af6947a84204eac7723fdd973bf30afad79c812da4db0e7 |
| S3 | [memory-eval-vnext-s3-holdout-contract-2026-09-07.md](memory-eval-vnext-s3-holdout-contract-2026-09-07.md) | 66a29c01dd5e2d099817ee799afc960f090e93f900be53b546b8b73f4d3b3d05 |
| D | [memory-eval-vnext-s2-activation-clarification-revised-draft-2026-09-07.md](memory-eval-vnext-s2-activation-clarification-revised-draft-2026-09-07.md) | 7ce66bb7386c5b55509b054170c1fdedc65cb505b40512823ddb282c83c3ca98 |
| Q Markdown | [memory-eval-vnext-offline-subset-approval-draft-2026-09-08.md](memory-eval-vnext-offline-subset-approval-draft-2026-09-08.md) | 0b8668d8bf65f139895af13c126d43b1a277d6152582ec3ce857fc763b1310df |
| Q JSON | [evidence/memory-eval-vnext-offline-subset-package-2026-09-08.json](evidence/memory-eval-vnext-offline-subset-package-2026-09-08.json) | 7ad37a223dc20eea71a20f539d7778000d1b0ada4e61e6d3d64cffe25dcf6ed2 |
| RC | [memory-eval-vnext-offline-subset-approval-2026-09-08.md](memory-eval-vnext-offline-subset-approval-2026-09-08.md) | 44f8400b6b2338caa7443b97f7f47b72c8bb64951a9dd77078bf2b5140c8b498 |
| AOD | [memory-eval-vnext-offline-subset-disposition-approval-2026-09-08.md](memory-eval-vnext-offline-subset-disposition-approval-2026-09-08.md) | 144ca91255bf45e5d924285ccb2516be63cc749bc001262245840c3e2f25cae3 |
| PB receipt | [memory-eval-vnext-oi-f3-b-approval-2026-09-08.md](memory-eval-vnext-oi-f3-b-approval-2026-09-08.md) | 03286ef63c1cba204254592535d1ab7fa7e2e47665fd0eee215e6e910ba0ad32 |
| BF-R1 수용 receipt | [memory-eval-vnext-oi-f3-b-implementation-review-acceptance-approval-2026-09-09.md](memory-eval-vnext-oi-f3-b-implementation-review-acceptance-approval-2026-09-09.md) | 5538b59f950b09831c1d41b5a37e262d504b28f09a97bf485111f4eb75d4e468 |

JSON.sourceBindings는 기존 36개 결속과 IB 5파일·BF/BF-R1 수용 기록 4개를 합한
중복 없는 45개 경로를 담는다. 각 파일의 merge/basis Git raw hash와 현재 working raw hash를
구별하며 Git/working 개행 차이를 원문 변경으로 단정하지 않는다.
원 decision은 400 LF, SHA 355f8387808b8a7ea86e02ecffc4303562b5ab5c43c27fef0c2bdb2bf57e89da
및 §13 공란 그대로다. JSON.ancestry의 기존 A/CA/D/K/H/Q/RC/AOD/PB/IB 계보를 보존한다.

## 3. OI-F2 사실과 변경의 성격

I 최초 독립 검토 보고서의 OI-F2(P3)는 ASCII의 문자 그대로의 허용 범위가 C0·space·DEL을
포함하고 path도 newline을 수용한다고 지적했다. 원본은
C:/Users/Vyper/.codex/attachments/c34fdd17-56a9-4933-8ad5-2dcd61f3f73b/pasted-text.txt,
raw SHA-256 74bbc335f5a5c05552d1ad7fa0e3660da8725cbf51996a35d3fa546af26e51c6이다.
보고서는 PASS_WITH_WARNINGS였으며 그 보고서를 이 IP 초안의 독립 검토로 재사용하지 않는다.

AOD [OI-F2 처리방침](memory-eval-vnext-offline-subset-disposition-approval-2026-09-08.md)은
현재 Q/S3 규범·I bytes를 보존하고 ID와 path를 별도 exact 결정으로 남겼다.
OD-R1과 BF-R1 수용 receipt도 그 보류를 닫지 않았다. 이 패키지는 그 뒤의 **허용집합 축소 제안**이며
단순 오탈자 수정이나 기존 규범이 처음부터 같은 뜻이었다는 해석이 아니다.

현재 C02 isAsciiId는 비어 있지 않은 U+0000..U+007F 전체를 수용한다.
isRelativePath는 NUL/backslash, 시작의 ASCII drive prefix, 빈/dot/dotdot segment 등을 거절하지만
C0 나머지/DEL은 거절하지 않는다. C01은 NFC·Unicode scalar 선행 조건을 이미 검사한다.
C04 expectation도 C02의 isAsciiId를 공유한다.

2026-09-09T10:28:44.663Z, HEAD=17b074c600e98e8fe52175ea0cbc6c5860b0c742에서
production 자격증명 없는 격리 child로 기존 C01/C02/C03/C04를 읽기 전용 호출했다.
ID 대표 16행, path 대표 31행, ASCII 128개 전수 insertion 관측은 JSON.currentBehavior에 있다.
진단의 source/명령·정확한 script 문자열 hash를 보존하며 실제 C02/T01/T11 수정은 없다.
새 key 생성/서명·provider/DB 호출은 0회다. 공개 T11 vector의 public key만 구조 시료에 사용했다.

| 현재 코드에 넣은 값 | 현재 결과 | 새 제안의 해당 field 판정 |
|---|---|---|
| signerId의 LF/CR/TAB/NUL/space/DEL; 세 비교값 동일 | shape ok, fieldsMatch | IP-D1 invalid_input |
| trustEpoch가 단일 space; 세 비교값 동일 | fieldsMatch | IP-D1 invalid_input |
| BlobRef/GitFileRef/nested registrationReceipt의 C0(non-NUL)/DEL path | shape ok | IP-D2 invalid_input |
| NFC 한글·é 및 space path | shape ok | shape 유지 |
| NFD path, dotdot/backslash/absolute path | invalid_input | 동일 거절 유지 |
| 서로 다른 정상 signer 대소문자 | binding_mismatch | 동일 유지 |

ASCII sweep의 path 시료는 "a" + 문자 + "b"다. 기존 거절 문자는 NUL, colon(시료가 drive prefix),
backslash 3개였고 나머지 125개는 수용됐다. ID는 128개 모두 수용됐다.
이는 이 유한 시료의 관측이며 모든 possible string/운영 corpus를 검사했다는 뜻이 아니다.

같은 금지 후보를 세 곳에 모두 넣어 fieldsMatch가 된 관측은 caller가 전달한 로컬 비교값의
일치일 뿐이다. 보안 혼동 공격·실제 등록·서명자 권한의 성립을 증명한 것이 아니다.
새 규칙도 이 권한 경계를 바꾸지 않는다.

## 4. 요청할 다섯 결정 — 전부 pending

| 결정 | 요청 내용 | 명시적으로 수용할 변화 |
|---|---|---|
| IP-D1 | 지정 opaque ID를 비공백 ASCII U+0021..U+007E로 제한 | C0/DEL뿐 아니라 U+0020 space도 거절 |
| IP-D2 | 지정 상대 path는 NFC Unicode/space 보존 + C0/DEL 거절 | NUL 외 C0 31개와 DEL의 추가 거절; ASCII-only path 아님 |
| IP-D3 | 후속 구현의 prospective 판정·과거 bytes 무변경 | 과거 허용 입력도 새 함수 호출에서는 invalid_input일 수 있음; 자동 migration/fallback 없음 |
| IP-D4 | C02/T01/T11 3파일만의 미래 구현·fixture 확장 범위 | 새 IP inventory 및 B19의 정확한 projection 변경 포함 |
| IP-D5 | 시험·검토·실제 착수 gate와 한정 잔여 | Unicode 표시/OS 경로 안전성·운영 권한은 여전히 증명하지 않음 |

ID와 path의 의미는 독립적으로 검토할 수 있지만 이 패키지가 요청하는 구현 묶음은 다섯 결정
전체와 아래 조건이다. 일부만 승인되면 미승인 부분을 조용히 구현하지 않고 부분 승인 범위에
맞는 새 exact 패키지를 제시한다. 현재 selected/accepted 값은 없다.

### 4.1 IP-D1 — 지정 ID field의 정확한 허용집합

입력은 primitive string, 길이는 1 이상이고 **모든 문자**의 code point가
U+0021..U+007E(양 끝 포함)여야 한다. ASCII 94개 기호만이다.
공백 없는 printable ASCII라는 설명에서 “공백 없음”을 생략하지 않는다.

- U+0000..U+001F(C0 32개), U+0020(space), U+007F(DEL), 모든 non-ASCII,
  빈 문자열·non-string/boxed string을 거절한다.
- 선행/후행/중간 어디에서나 동일하다. 줄 끝 문자를 허용하는 예외, prefix 일치만의 검사는 없다.
- trim/NFC 변환/case-fold/@ 제거/alias 치환/숫자 변환을 하지 않는다.
- 대소문자·punctuation을 원 값 그대로 유지한다. @importer, slash, backslash, colon,
  quote 등 이 범위의 기호는 opaque ID에서는 허용한다. 이를 URL/shell/path로 실행·해석할 권한은 없다.
- 새 최대 길이·epoch 발급/순서/랜덤성 규칙은 만들지 않는다. keyId 등 fixed-format ID는 별개다.

적용 field를 이름으로 닫는다.

| 위치 | field | 현재 검사/전파 |
|---|---|---|
| SignaturePayload | purpose, signerId, trustEpoch | C02 checkWire |
| SignatureReceipt.payload | purpose, signerId, trustEpoch | C02 nested SignaturePayload |
| TrustAnchor | signerId, trustEpoch | C02 checkWire |
| BindingExpectation(운영 wire 아님) | purpose, signerId, trustEpoch | C04 private expectation, C02 predicate 공유 |

총 11개 field 위치와 공개 primitive predicate isAsciiId가 대상이다.
C03 signatureMessage/signatureReceiptDigest/verifySignatureReceipt(receipt·expectedPayload),
C04 compareTrustBinding(payload·anchor·expected)은 기존 C02 공유 경로를 통해 같은 제한을 받는다.
같은 금지 signer/epoch가 세 곳에 모두 있어도 equality 이전에 invalid_input이어야 한다.

역할·purpose 제약은 별도로 유지한다. C02의 lexical shape 성공이 purpose 지원/사람 역할을
의미하지 않는다. D의 세 지원 purpose→role 쌍은 그대로며 정상 문자열인 미지원 purpose는
C03/C04에서 unsupported_subset이다. D 신규 activation approver에만
^[A-Za-z0-9][A-Za-z0-9-]{0,38}$ 및 등록값 case-sensitive exact equality를 추가 적용한다.
C02가 그 역할 판정을 새로 맡지 않는다. @importer의 허용과 신규 approver @user의 C04 거절은
동시에 성립한다. 과거 @mposition 표기를 수정하지 않는다.

이 목록 밖의 S1 case/gold ID, S3 random 128-bit hex ID, keyId, commit, digest, roles enum,
UTC timestamp, GitHub 숫자 ID, repositoryId, source path/URL/HTTP resource locator,
CJSON object key, C01 domain 문자열의 문법은 변경하지 않는다.

### 4.2 IP-D2 — ID 규칙과 다른 상대 path 허용집합

다음 조건을 **모두** 만족하는 primitive string이다.

1. 비어 있지 않고 Unicode scalar string이며 이미 NFC다. C01 선행 검사를 보존한다.
2. 어느 위치에도 U+0000..U+001F 또는 U+007F가 없다.
3. U+005C(backslash)가 없고 시작 두 문자가 ASCII letter + colon인 drive prefix가 아니다.
4. U+002F(slash)로 분할한 모든 segment가 비어 있지 않고 정확한 "." 또는 ".."가 아니다.
   따라서 leading/trailing slash, 중복 slash, absolute/UNC slash 형식도 거절한다.

적용은 BlobRef.path, GitFileRef.path, TrustAnchor.registrationReceipt.path다.
C04 compareBlobRef/compareGitFileRef의 **actual과 expected 각각** 및 compareTrustBinding의
anchor.registrationReceipt도 기존 checkWire를 통해 동일하게 거절한다.
byteLength는 path 문자열 길이가 아니라 참조 대상 raw bytes 길이이며 변경하지 않는다.

NFC non-ASCII와 U+0020 space는 유지한다. 한글/증거 파일.json, é/한.txt,
선행·후행 space와 space-only segment까지 기존처럼 구조상 수용한다.
이 표기는 시각적 구분을 보장하지 않는다. ID에만 적용할 space 제거를 path에 숨겨 적용하지 않는다.

**이 안이 거절하는 control 집합은 C0와 DEL로 닫혀 있다.** C1 U+0080..U+009F,
U+2028/U+2029, zero-width/bidi/format scalar, 기타 NFC Unicode를 일괄 거절하지 않는다.
이는 무제한 안전성의 선언이 아니라 최소 축소안의 명시적 잔여다. 이들을 더 금지하거나
OS-portable filename 규칙을 도입하려면 별도 변경 범위/호환성 검토가 필요하다.

percent/URL decoding, slash 치환·collapse, path.resolve/realpath, dot 제거,
NFC/trim/case-fold, device-name/extension/OS alias 처리를 하지 않는다.
a/%2e%2e/b, a/..x, dir/C:a, CON, trailing dot가 lexical shape를 통과할 수 있다.
이를 열어도 안전하다고 주장하지 않는다. 파일 존재·Git object 종류/mode·symlink·승인 root
포함·OS별 동등성/충돌·중복·collection 정렬은 원 상위 계약의 resolver/보관 계층 의무다.
이번 범위는 이를 구현/면제하지 않는다. PrivateFile·materialisation absolutePath 등
미구현 상위 record 전체에 이 profile을 자동 적용하지도 않는다.

### 4.3 IP-D3 — 호환성과 효력

승인돼도 S1/S3/Q/D/PB 및 모든 기존 receipt·report·dataset·fixture 과거 commit을 고치지 않는다.
새 정책은 향후 승인된 implementation commit과 그것을 선택한 실행의 lexical 검사에 적용한다.
schemaVersion=1, wire field, 서명 domain, digest 산식은 그대로이며 새 version switch/legacy
fallback/등록 schema를 추가하지 않는다. IP proposalVersion은 wire negotiation 수단이 아니다.

- 새 허용집합 안의 기존 정상 입력: 반환값·CJSON bytes·message·raw/domain digest·오류 순서 보존.
- 새로 제외되는 값: 이후 validator에서는 invalid_input. 과거 verdict/서명/raw bytes를
  소급 무효로 재기록하거나 “과거에도 거절됐다”라고 하지 않는다.
- 새 허용집합 밖 historical object를 새 validator로 검증해야 하는 사용처가 발견되면,
  trim/migration/legacy fallback으로 통과시키지 않고 별도 보존·전환 정책 결정을 요청한다.
  과거 구현의 exact commit으로 재현하는 것은 감사 참조이지 새 실행의 우회 승인 경로가 아니다.
- 이미 등록된 모든 운영 ID/path에 새 규칙이 호환된다는 조사는 하지 않았다.
  운영 저장소·DB·private package를 열지 않았으므로 “영향 0”이라고 주장하지 않는다.

일반 mem-cjson-1 문자열의 C0 escape·DEL·NFC 규칙은 유지한다. C01은 범용 canonical bytes를
만들 뿐 모든 string을 ID/path로 해석하지 않는다. 이 구별을 위해 C01은 미래 변경 allowlist에서도 제외한다.

## 5. IP-D4 — 미래 구현 3파일과 B19 보존

**아래는 아직 미승인인 미래 M3 제안이며 이번 실제 변경은 감사 문서 A2뿐이다.**

| ID | 미래 변경 path | 허용 변경 |
|---|---|---|
| C02 | lib/memoryEvalVnext/protocol/wire.ts | isAsciiId와 private isRelativePath의 lexical predicate 및 직접 설명 주석만 |
| T01 | tests/memoryEvalVnextWire.test.mjs | 독립 IP unit inventory/음성·보존 시험; 아래 B19 projection 한정 조정 |
| T11 | tests/fixtures/memory-eval-vnext/wire-vectors.json | 기존 15 top-level key 값/순서 보존 후 idPathPolicy 한 key만 끝에 추가 |

C02의 이름·export signature·closed shape field·기존 local import C01을 보존한다.
새 helper export/builtin/dependency/import/API/schema/config/runner/static checker는 허용하지 않는다.
C03/C04는 C02를 공유하므로 구현 파일을 수정하지 않는다. C01/C03/C04 및 승인된 Proxy/bytes
intrinsic helper를 exact bytes로 유지한다. 다른 file 수정이 필요하면 구현을 멈추고 재승인한다.

기존 F inventory는 44 선언(40 unit/4 external), B inventory는 24 선언(19 unit/5 external)이다.
새 IP는 별도 inventory이며 F/B를 재번호·삭제·합치거나 외부 감사를 unit 성공으로 세지 않는다.
F41/F/B 등록·완료 집합 검사를 완화하지 않는다. IP01–IP15는 별도 등록/완료 집합을 사용한다.

현재 T11은 15 top-level key다. B19는 proxySafety만 제외한 original14 projection을 고정한다.
idPathPolicy 추가 후 그대로 두면 새 key까지 hash해 실패하므로 **다음 한정 변경을 명시 요청**한다.

- B19의 original14 projection에서 제외하는 key는 정확히 proxySafety와 idPathPolicy 둘뿐.
  나머지 값/순서와 기대 hash
  1d286a257c44d3444de99b945a8276cd680b8b30adc41bf0fc5df32a5f4123ca는 변경하지 않는다.
- 새 IP15는 idPathPolicy만 제외한 기존 original15의 JSON.stringify projection raw SHA를
  e59c8ef30d4dae1430e113392d63924e9d2a77cd764edd8297e59ed2d987e652로 검사한다.
  이는 proxySafety 값/순서도 보존한다. 전체 top-level key 집합/순서는 기존 15 + idPathPolicy
  정확히 16개여야 하며 임의 metadata를 추가/제외할 수 없다.
- projection hash는 파일 raw SHA나 mem-cjson-1/domain hash가 아니다.
  JSON.parse된 object의 insertion order를 유지해 지정 key만 제외한 뒤
  JSON.stringify(no replacer/no space)의 UTF-8 bytes, 끝 LF 없이 SHA-256한다.
- T11 전체 raw SHA는 새 key 때문에 바뀐다. 과거 raw SHA
  136469c95aeeeacdeb0069e457476a273036e5d73964f336f2fbc6f6d4dcc70f를 새 파일 hash로 주장하지 않는다.

미래 idPathPolicy는 비운영 시료·기대값·IP01–IP20 추적성만 담는다.
IP15는 idPathPolicy를 IP01–IP20 순서의 정확히 20개 row 배열로 검사한다.
각 row의 key 집합은 id/acId/verification/expected 네 개뿐이고 모두 비어 있지 않은 primitive string이다.
T01에 독립 고정한 기대표는 이 패키지 JSON.futureCases의 해당 네 필드 값을 그대로 전사하며,
IP15는 각 row의 네 값을 exact equality로 대조한다. 정답을 검사 대상 fixture에서 유도하지 않는다.
따라서 verification은 IP01–IP15에서 unit, IP16–IP20에서 external_repository_audit여야 한다.
각 row의 acId에서 역으로 모은 case ID 목록도 이 패키지 JSON.acceptanceCriteria의 각 caseIds와
집합·순서가 같아야 한다. IP→AC와 AC→IP 양쪽에서 누락·중복·알 수 없는 ID·잘못된 대응을 거절한다.
IP15 자신의 expected도 실행식이 아닌 고정 문자열 데이터로 비교하며 재귀 생성·자기 hash를 만들지 않는다.
기존 top-level kind/authorityEstablished/provenance/golden/vector/closedTypes/purposeRoles/
acTrace/caseTrace/upstreamDisposition/upstreamCounts/proxySafety 값을 덮어쓰지 않는다.
새 운영 wire/profile 객체나 key/signature/승인·활성 상태를 발급하지 않는다.
이번 evidence JSON은 계획 문서이며 실제 T11에 idPathPolicy를 만들지 않았다.

## 6. IP-D5 — 수용 기준과 시험 계약

모든 미래 시험은 **not_run_future_implementation**이다. §3 진단은 현재 코드의 관측이며
아래 새 규칙을 구현·검증했다는 증거가 아니다. IP-AC1–IP-AC5는 이 변경의 한정 AC이고
Q/S3/S4/D의 번호와 혼동하지 않는다.

| AC | Given / When / Then |
|---|---|
| IP-AC1 | 지정 ID field의 전체 alphabet/위치 변형을 primitive·closed shape·expected 경로에 전달하면 새 범위만 수용하며 동일 금지값도 invalid_input |
| IP-AC2 | 세 path leaf·actual/expected/nested 경로에서 C0/DEL은 거절하고 NFC Unicode/space 및 기존 상대 문법의 결과는 명시한 변화 외 보존 |
| IP-AC3 | lexical invalid와 unsupported/mismatch가 겹치면 기존 우선순위를 지키고 lexical success를 role/identity/운영 권한으로 승격하지 않음 |
| IP-AC4 | 기존 canonical·Proxy/bytes·F/B fixture·시험을 보존하고 새 IP inventory/정답/외부 감사와 분리 |
| IP-AC5 | exact M3·승인 원문/계보·실제 착수 환경/CI·비운영 제한을 모두 감사할 수 있어야 하며 소급 변경/범위 초과는 불허 |

아래 20개 group의 완전한 expected 문장은 JSON.futureCases에 결속한다.
IP01–IP15는 각각 별도 named unit group, IP16–IP20은 external repository audit다.
group 내부 반복 alphabet/field assertion 수를 별도 top-level test 수로 부풀리지 않는다.

| Group | AC | 분류 | 시험 초점 |
|---|---|---|---|
| IP01 | IP-AC1 | unit | ID alphabet is exhaustive |
| IP02 | IP-AC1 | unit | Payload ID field coverage |
| IP03 | IP-AC1 | unit | Receipt nested payload coverage |
| IP04 | IP-AC1 | unit | Anchor ID field coverage |
| IP05 | IP-AC1 | unit | Expectation has no legacy bypass |
| IP06 | IP-AC3 | unit | Signature entry-point propagation |
| IP07 | IP-AC3 | unit | Role-specific and unsupported boundaries |
| IP08 | IP-AC3 | unit | Exact equality and no repair |
| IP09 | IP-AC2 | unit | Path controls at all leaf locations |
| IP10 | IP-AC2 | unit | NFC Unicode and spaces remain allowed |
| IP11 | IP-AC2 | unit | Path canonical precondition and type |
| IP12 | IP-AC2 | unit | Relative syntax is unchanged |
| IP13 | IP-AC3 | unit | Ref and expectation propagation |
| IP14 | IP-AC4 | unit | Canonical and Proxy guarantees are not narrowed |
| IP15 | IP-AC4 | unit | Separate inventory and exact fixture projection |
| IP16 | IP-AC5 | external | Three-path implementation allowlist |
| IP17 | IP-AC5 | external | Approval and non-retroactivity |
| IP18 | IP-AC4 | external | Coverage and regression evidence |
| IP19 | IP-AC5 | external | Actual start tip and environment |
| IP20 | IP-AC5 | external | No authority or upstream completion promotion |

새로운 P/F07 전체 충족이나 OI-F2 외부 closure는 이 표에서 발급하지 않는다.
기존 F40/F42/F43/F44, B20–B24의 외부 감사 의무와 BI-F1/BI-F2의
영구 정적 강제 부재·m3/m6 생존 잔여도 유지한다. 새 영구 CI gate를 몰래 추가하지 않는다.

후속 구현 검증은 package.json에 있는 npm script를 우선 실행한다.
test:unit은 현재 단일 파일 filter를 지원하지 않으며 Windows ENAMETOOLONG의 OI-F4를
이 범위에서 수정하지 않는다. package 실행 실패 시 정확한 실패/명령을 남기고,
한정 T01 실행은 해당 tip의 runner server flags를 그대로 복사한 별도 근거로 구분한다.
전체 suite·CI·T01을 서로 대체하지 않고 baseline 실패는 같은 이름/원인으로 대조한다.
기존 test-only volatile 합성 서명 허용을 새 운영 서명/새 signer API로 확대하지 않는다.

## 7. 독립 검토·사람 승인·실제 착수 순서

이것은 단순 승인 전사가 아니라 **새 허용집합/호환성/B19 범위 결정**이므로 별도 최초 독립
검토가 필요하다. 현 IP에는 외부 판정이 없다. 권장 순서는 다음과 같다.

1. 사용자 별도 지시로 두 파일 exact bytes를 commit/push하여 실제 40자 reviewCommit 고정.
2. 그 commit과 두 Git blob raw SHA로 Claude 최초 독립 검토.
3. finding 수정 후 필요할 때 해당 변경분의 확인 검토 최대 한 번.
   이전 PB/BF/OD/D namespace의 사용 회차를 초기화하지 않는다.
4. 사람이 IP-D1–IP-D5, path 잔여, future M3/시험/효력 조건을 명시 승인.
5. 승인 대상 두 파일은 불변으로 두고 별도 authoritative receipt에 각각의 path/hash/reviewCommit,
   실제 승인자/날짜/회신 범위를 결속. 문서 commit/receipt commit을 구별.
6. 별도 지시로 제출·CI 확인·원 SHA 보존 merge commit develop 반영·그 실제 tip CI 확인.
7. **별도 실제 착수 기록**에서 support9 Git/working bytes, runtime·설치/lock·scope·계보·CI를
   새 tip에 재결속. 승인된 범위가 성립하지 않으면 재결정.
8. 확인된 tip의 새 codex/ 브랜치와 별도 구현 착수 지시 뒤에만 M3 구현.

이번 작성 지시에는 commit/push/PR/merge/추가 Claude 호출이나 수동 CI dispatch가 포함되지 않는다.
현재 문서 작성용 브랜치는 구현 브랜치가 아니며 이 패키지 검증을 OS-F4/미래 착수 기록으로 대용하지 않는다.

## 8. 보존하는 잔여와 범위 밖

- A/CA/D/K/H/Q/RC/AOD/PB 및 IB/BF/BF-R1/수용 receipt 원 bytes·판정·SHA 계보 보존.
  S2 approvalCommit=3f14afb29eddc243640fdb0a5a4f604646ade9f0와
  contractApprovalCommit=80842e62925c05af9450e6acc6ceb70b56f67655를 IP로 치환하지 않는다.
- OI-F1 시점 공백 accepted residual/closure=false, ODR-F1 외부 closure 부재,
  OI-F4 runner 별도 작업, BI-F1–F5 및 BFR-R1-1/BFR-R1-2 수용 한계 유지.
  이 초안은 OI-F2를 resolved/approved로 기록하지 않는다.
- 상위54 AC partial9/deferred45/full0, HD-1–HD-8/OP 7개, D<K<activationApprovalCommit<C,
  historical122/forward109·기존 legacy 판정 및 원 결정 D1–D5/§12 잔여 유지.
- scorer/ledger/full P/resolver/controller/custodian/importer·등록 parser/trust digest 생성·
  genesis/root/journal/checkpoint/backup/attestation 운영을 하지 않는다.
- dataset/manifest/register·S2 purpose/activation·holdout 작성/seal/open·S5/v9 prompt·pair·
  예산/dispatch/provider·DB/Railway/production·release gate·두 memory flag를 변경하지 않는다.
- 현재 lexical 시료 관측을 일반 JavaScript sandbox, Unicode 시각적 유일성,
  파일 존재/OS-portability/경로 접근 권한/전체 실행 격리의 보장으로 확대하지 않는다.

## 9. 작성 검증과 한계

로컬 PC PowerShell, H:/Project/ai-chat-hub의 기존 Node v22.22.2/npm 10.9.7/
tsx 4.23.13/TypeScript 6.0.3에서 package.json의 npm run script 7개를 실행했다.
production 자격증명은 사용하지 않았다. OS/PATH/TEMP/user-cache allowlist만 child에 전달하고,
부재 확인한 .os-f4-absent-env-file을 DOTENV_CONFIG_PATH로, DOTENV_CONFIG_QUIET=true 및
NEXT_TELEMETRY_DISABLED=1을 child에만 지정했다. 원 PowerShell 창의 환경은 바꾸지 않았다.

작성 전 기준선은 HEAD=17b074c600e98e8fe52175ea0cbc6c5860b0c742, tracked/index clean이었다.
실행 구간 2026-09-09T10:28:44.404Z–2026-09-09T10:28:49.546Z.
출력 hash는 stdout raw bytes 뒤에 stderr raw bytes를 연결한 SHA-256이다.

| npm run script | 기준선 exit | 출력 raw SHA-256 |
|---|---|---|
| check:encoding:strict | 0 | 7d5195263cb38b5aa0de4bf8e0ead06774933b4e124616518883574554bcd380 |
| check:policy-section-references | 0 | bc9a33ead4deb5a419249fddec5a8f681136d645dbfc2cab1967995cae12059a |
| check:release-records | 0 | 5d216eabba9f6eb6762717a31e2bc3c26172d530ed554ab099a9c21a537f3565 |
| check:memory-eval-succ9 | 0 | f792af65d17e277fecceedf03b5eaba6484180748d3013de077a027a005e194c |
| check:memory-extraction-eval | 0 | 575a56bac68f5e261286b5e00894451bd0fb1b7b5cead22e49d8d8f28315629b |
| check:memory-eval-freeze | 0 | 8318af98d6c2a2ce9ca9f2d7c0d9b4acc70cc97ee7555b8dc026a4fb5b10cca1 |
| check:doc-references | 0 | fdf56bff206d251401863a06e045c07b7663ae53ea0514976ea99d15686c8375 |

이전 receipt/다른 tip의 문서 참조 출력과 달라도 새 basis의 같은 이름별 결과로 대조한다.
이번 기준선 실패는 0개다.

support9의 Git blob/raw bytes와 working raw hash, Node/tsx/TypeScript 버전은 이번 문서
검사 입력 식별을 위한 관측이다. 전체 설치 inventory/lock 적합성·dependency closure나
미래 실제 착수 OS-F4 완료를 선언하지 않는다. 설치·환경변수·Git config는 수정하지 않았다.

문서/audit 참조 검사의 범위 밖인 새 audits 두 파일에는 별도로 strict UTF-8 fatal decode,
BOM/CR/후행 공백 부재·끝 LF, 상대 링크, Markdown↔JSON의 pending/정책/field/allowlist/시험,
source raw hash·근거와 제안의 구분을 검사한다. 새 두 파일은 untracked이므로 일반
git diff --check만으로 검사했다고 하지 않고 각각 no-index --check도 확인한다.
no-index exit 1/빈 진단은 빈 입력과 새 비어 있지 않은 파일의 차이로만 해석한다.

### 9.1 작성 후 검증 관측

2026-09-09T10:39:00.682Z–2026-09-09T10:39:05.277Z에 같은 7개 script를 다시 실행했다.
전부 exit 0이고 이름별 stdout+stderr raw SHA도 위 basis 기준선과 7/7 일치했다.
이번 기준선 실패/신규 실패는 각각 0개다. 기존 audit 전체가 자동 검사된다는 뜻은 아니다.

2026-09-09T10:38:34.256Z의 새 파일 전용 검증에서 다음을 확인했다.

- 두 파일 strict UTF-8, BOM/CR/후행 공백 부재, 마지막 LF 1개 및 no-index whitespace 진단 0.
- Markdown raw SHA↔JSON.document 결속, pending/미승인 값, IP-D1–IP-D5,
  field 11개·M3 allowlist·IP 20 group/AC 대응 및 상대 링크 11개 정합.
- source45와 support9의 Git/working raw hash, 계보 17 commit, fixture original14/original15
  projection 및 진단 script/외부 보고서 원문 hash 재계산 일치.
- tracked/staged 변경 0, 새 untracked 2파일 외 기존 28항목 보존.
  기존 파일 25개는 raw hash로 확인했고 디렉터리 3개는 존재만 확인했다.
  디렉터리 내부 전체 보존을 재귀 hash로 증명한 것은 아니다.
- stash 17개, core.autocrlf 관측값과 .git/config mtime 보존.
  일반/staged diff --check 및 새 두 파일 각각 no-index --check 진단 0.
  구현·dataset·register·prompt·flag·source code 변경 0.

JSON.verification에는 위 실행 출력·기준선 대조와 수동 검증 관측을 보존한다.
이는 검증 결과 구획을 덧붙이기 전의 content-check snapshot이며 최종 bytes의 자기 hash가 아니다.
결과를 덧붙인 파일도 전달 전에 동일 검사와 결속을 다시 확인한다.
최종 두 raw SHA는 후속 commit/review 고정 시 별도로 결속하며 reviewCommit은 아직 null이다.

전체 unit/T01/lint/typecheck/build/E2E·신규 구현 시험·운영 corpus/원격 서비스 검사는 이번 로컬 작성에서 미실행이다.

quality-documentation-manager의 변경 영향·원문 보존·초안/승인/효력 분리 원칙을 적용했다.
QMS 인증이나 사람 서명/독립 검토를 대신하는 점수·자동 판정을 만들지 않는다.

## 10. IP-1 — IP-F1 한정 보완 이력

최초 검토 대상 IP-0은 commit 1979839dc200687336db3d72526e9a76c860be71에 그대로 보존한다.
그 최초 독립 검토 보고서는 PASS_WITH_WARNINGS, P1 0/P2 0/P3 1이며 IP-F1은 비차단이었다.
보고서 path:
C:/Users/Vyper/.codex/attachments/cdc77e91-891a-4778-af66-570e4652d916/pasted-text.txt
보고서 raw SHA-256: 5d7acbe9fb1bbb4f7cf707f20fccadf69ef4df5e2232c37f20a7469bd045ab7c
길이 21,054 bytes, LF 163. 이 식별은 보고서 bytes 결속이지 작성자 인증을 추가 입증한 것이 아니다.

2026-09-09 사용자 지시에 따라 §5의 idPathPolicy 내용 계약과 JSON.futureCases의 IP15 기대 문장을
보완했다. 20 row의 정확한 ID 순서·네 필드 값·IP/AC 양방향 대응을 T01의 독립 기대표로 검사하도록
명시한 변경이며, 기존 ID/path 허용집합·미래 M3·IP20 분류·다른 case의 expected는 바꾸지 않았다.
현재 disposition은 addressed_pending_confirmation이다. 최초 보고서를 이 수정본의 확인 판정이나
사람 승인·OI-F2 외부 closure·구현 허가로 승격하지 않는다.

기존 T11 bytes 및 original14/original15 projection 기대 hash는 불변이다. 수정된 두 패키지의
raw SHA와 후속 commit SHA까지 불변이라는 뜻은 아니다. JSON.document는 수정된 Markdown raw SHA에
다시 결속하고, 자기/future commit hash는 넣지 않는다. 검토 SHA는 커밋 뒤 별도 인계에 고정한다.

§9와 JSON.verification의 T 시점 관측은 IP-0 작성 이력으로 그대로 보존한다.
IP-1의 전후 검사와 실제 커밋 identity는 변경분 확인 검토 인계에서 별도로 기록한다.
남은 절차는 IP-F1 변경분 확인 검토(필요 시 최대 한 번)와 사람의 별도 승인이다.
