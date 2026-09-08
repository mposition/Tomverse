# memory-eval vNext — offline subset 한정 구현 승인 요청 초안

**상태: DRAFT / UNSIGNED — 사람 판정 대기, 승인 효력 없음.**
작성자: Codex. 작성일: 2026-09-08. 작성일은 승인일이 아니다.

사용자의 이번 “네 작성해주세요”는 검토된 Q를 보존하면서 OS-F1–OS-F4 처리방침을 담은
**승인 요청 초안 작성**에 대한 지시다. 한정 구현·합성 서명 시험·잔여 수용의 승인으로
전사하지 않는다. 과거 mposition / 2026-09-07 승인도 새 승인자·승인일로 복사하지 않는다.

이번 산출물은 이 Markdown 한 파일뿐이다. Q의 두 문서·기존 승인·검토 보고서·전달
프롬프트를 수정하지 않는다. 이 문서는 별도 authoritative receipt가 아니며 실제
key·서명·등록·코드·test skeleton·fixture·activation을 생성하지 않는다.

## 1. 승인 요청의 정확한 대상과 현재 상태

검토 대상 Q: **7e5491f5fa24295912d5da7a6cc5e86ddb637f43**
Q의 유일 parent / 작성 basis M: **0c6b3fec7cfb68f5a2fc4e4a492de7905b413bff**
Q subject: Prepare memory eval vNext offline subset approval package

| 대상 | 경로 | Raw SHA-256 | Git blob OID | Bytes / LF lines |
|---|---|---|---|---|
| Q 문서 | .github/audits/memory-eval-vnext-offline-subset-approval-draft-2026-09-08.md | 0b8668d8bf65f139895af13c126d43b1a277d6152582ec3ce857fc763b1310df | 853ea85ce07f69dc2c3f3b3ca08f803bcb5016f0 | 31978 / 418 |
| Q 근거 JSON | .github/audits/evidence/memory-eval-vnext-offline-subset-package-2026-09-08.json | 7ad37a223dc20eea71a20f539d7778000d1b0ada4e61e6d3d64cffe25dcf6ed2 | 94edbf8c43bf5f652a67831ff3413856678dcd00 | 94616 / 2617 |

두 원문은 [Q 승인 패키지 문서](memory-eval-vnext-offline-subset-approval-draft-2026-09-08.md)와
[Q 근거 JSON](evidence/memory-eval-vnext-offline-subset-package-2026-09-08.json)이다.
Q는 M 대비 두 파일 추가만이며, 아직 최종 P나 activation 승인 commit이 아니다.

아래 YAML은 **사람이 답할 요청 상태표**다. 운영 wire schema·등록 object·서명 payload가 아니다.

```yaml
recordStatus: draft_unsigned
recordKind: offline_subset_limited_implementation_approval_request
repository: mposition/Tomverse
documentCommit: 7e5491f5fa24295912d5da7a6cc5e86ddb637f43
repositoryBasis: 0c6b3fec7cfb68f5a2fc4e4a492de7905b413bff
decision: pending
approvedBy: null
approvedAt: null
approvalReceiptCommit: null
requestedDecisionStatus:
  limitedOfflineImplementation: pending
  testOnlySyntheticSignatures: pending
  noAuthorityPromotion: pending
  deferredRegistrationParser: pending
dispositionNamespace: offline_subset_initial_review_2026_09_08
requiredDispositionIds: [OS-F1, OS-F2, OS-F3, OS-F4]
acceptedDispositionIds: []
reviewLimitationsAcknowledged: null
upstreamConditionsPreserved: null
implementationAuthorized: false
activationAuthorized: false
operationalSigningAuthorized: false
paidExecutionAuthorized: false
```

pending/null/빈 목록은 미판정이다. Q의 documentCommit=null·commit/push 제외 문언은 작성
당시 상태로 남고, 이후 Q 제출·이번 요청 문서 작성은 별도 사람 지시의 사실이다.
그 제출 권한을 구현 승인으로 확대하지 않는다.

## 2. 독립 검토의 귀속과 한계

| 항목 | 사용자 제공 보고서의 식별 / 판정 |
|---|---|
| reviewCommit | Q 7e5491f5fa24295912d5da7a6cc5e86ddb637f43 |
| 회차 | offline_subset_initial_review_2026_09_08 — 최초 독립 검토 |
| 보고서 원문 | C:/Users/Vyper/.codex/attachments/48340331-6727-4995-a9f3-6fc0b2d62327/pasted-text.txt |
| 보고서 raw SHA-256 | a66758772910834953d66afd491d21aae86a470bd9c4244fe9367599eb311104 |
| 보고서 길이 | 11327 bytes |
| 판정 | PASS_WITH_WARNINGS — P1 0 / P2 0 / P3 4 |
| N-F1 | C04의 구조·exact equality·opaque BlobRef 비교 한정, 등록 parser·trust digest 생성 제외가 적합하다는 판정 |
| 새 경고 | OS-F1–OS-F4; Q bytes를 반드시 바꿔야 승인 가능한 성격은 아니라는 검토자 판단 |

보고서 hash는 **보고서만** 식별한다. Q 문서 두 hash나 사람 승인 receipt를 대신하지 않는다.
이 문서는 그 보고서의 전사·작성자 처리 제안이며 Claude의 새 확인 검토 결과가 아니다.
이 요청 초안 자체는 아직 Claude 검토 대상이 아니며 CONFIRMED를 기록하지 않는다.

검토의 미수행/한계도 보존한다. Q head의 workflow run은 보고 당시 0건, PR 없음이었다.
M snapshot에서 git 의존 검사 두 개는 직접 기준선 실행을 완료하지 못해 입력 무변경으로
동등성을 추론했다. M의 실제 CI 성공과 N PR의 docs-only skip은 Q/현재 develop의 CI·배포·
운영 readiness가 아니다. 실제 구현·key generation/signing·full P closure·운영 proof 검증은
수행하지 않았다. 공개 vector 대조를 그런 증거로 승격하지 않는다.

## 3. 사람이 함께 판단할 네 결정

아래는 **요청할 범위**이며 현재 네 항목 모두 pending이다. 이 한정 구현 패키지 전체에
착수하려면 네 항목을 모두 명시적으로 수용해야 한다. 일반적인 문서 검토 동의나 PR 병합을
이 네 결정으로 대신하지 않는다.

| 결정 | 수용 시 허용/유지할 내용 | 현재 |
|---|---|---|
| limitedOfflineImplementation | Q §2–§4의 한정 책임 및 아래 6개 exact 파일 구현·합성 시험만; §4의 경고 처리조건 포함 | pending |
| testOnlySyntheticSignatures | 미래 T01 내부 volatile 합성 key/signature 생성·검증만; 운영 key·seed 사용, private key 출력/보존, 운영 signer export 금지 | pending |
| noAuthorityPromotion | component match/유효 서명은 실제 신뢰·사람 승인·activation을 증명하지 않으며 authorityEstablished=false 유지 | pending |
| deferredRegistrationParser | HD-1 이후 별도 exact 결정 전 등록 원문 parser·trust digest 생성·폐기 이력 authority 검증 제외 | pending |

**limitedOfflineImplementation과 testOnlySyntheticSignatures는 이 요청에서 결합 판정한다.**
둘 중 하나를 거절/보류하거나 서로 다른 범위로 답하면, Q의 전체 6파일 패키지는 착수하지
않는다. 일부 AC를 조용히 삭제하거나 공개 vector만으로 전체 AC-5/6 통과를 선언하지 않는다.
더 좁은 대안을 원하면 별도 exact 범위·AC·시료·승인 판단을 준비하며 현재 Q 승인을 추정하지 않는다.
나머지 두 제한을 거부하는 답도 Q 그대로의 한정 권한을 성립시키지 않는다.

### 정확한 미래 파일 allowlist

| ID | 경로 | 이 subset의 한정 책임 | 허용 local import |
|---|---|---|---|
| C01 | lib/memoryEvalVnext/protocol/canonicalJson.ts | CJSON encode/strict canonical decode, raw/domain SHA | 없음 |
| C02 | lib/memoryEvalVnext/protocol/wire.ts | BlobRef/GitFileRef/SignaturePayload/SignatureReceipt/TrustAnchor 공통 구조 | C01 |
| C03 | lib/memoryEvalVnext/protocol/signatures.ts | S3 message·receipt digest·PureEd25519 verify; D 세 purpose만 | C01,C02 |
| C04 | lib/memoryEvalVnext/protocol/trust.ts | Q의 구조·명시 값 equality·명백한 부적합 비교만 | C01,C02 |
| T01 | tests/memoryEvalVnextWire.test.mjs | Q 전수 case 및 아래 공개 vector 보강; 승인 후 합성 envelope 시험 | C01,C02,C03,C04,T11 |
| T11 | tests/fixtures/memory-eval-vnext/wire-vectors.json | 공개 known vector·합성 시료와 정답; 운영 자료 없음 | 없음 |

Q의 지원 purpose는 s2_activation_approval→approver, s2_source_evidence→importer,
s2_activation_inclusion→importer 셋뿐이다. 타 S3/S4 purpose는 원 계약에서 유효해도
첫 subset에서 미지원이며, 새 금지 정책으로 재정의하지 않는다.

runtime C01–C04는 network/DB/fs read·write/child process/clock read/random/keygen/sign을
수행하지 않는다. T01의 별도 승인 대상 test key/sign 예외는 runtime으로 넘어가지 않는다.
추가 helper·dependency·package.json·package-lock.json·tsconfig.json·runner/workflow·API·
adapter 변경은 허용하지 않는다. 필요하면 구현을 멈추고 별도 exact 권한을 요청한다.
이 6파일은 전체 P 47개 후보나 H의 resolver 9경로를 승인하는 목록이 아니다.

## 4. OS-F1–OS-F4 처리방침 수용 요청

아래는 작성자 제안이다. 경고의 수용/계획은 수정 완료·독립 확인·기존 조건 면제가 아니다.
네 처리방침의 사람 수용은 각각 pending이며 §1의 acceptedDispositionIds는 비어 있다.

### OS-F1 — NFR 추적성 보완, Q JSON 원문은 보존

Q JSON.acceptanceCriteria[].frIds에는 FR만 들어 있고 Markdown의 NFR 참조가 빠져 있다.
이 점을 인정하고, 아래 대응을 **별도 추적성 보완표**로 Q와 함께 읽을 것을 요청한다.

| Q AC / Markdown 위치 | JSON의 기존 FR 대응 | 함께 적용할 NFR 대응 |
|---|---|---|
| AC-9 / Q md:282 | FR-6, FR-7 | NFR-2, NFR-3 |
| AC-10 / Q md:288 | FR-2, FR-7 | NFR-4 |
| AC-12 / Q md:300 | FR-1 | NFR-1 |

이는 Q Markdown에 이미 적힌 참조의 전사다. 새 NFR/AC/field/운영 schema를 정하지 않는다.
Q JSON의 mdJsonAcAndAllowlistMatched=true를 NFR까지 전수 일치했다는 증거로 인용하지 않는다.
기존 대조는 AC ID·제목·파일 allowlist/연결을 확인했지만 이 NFR 불일치를 놓쳤다.

미래 구현 검증에서는 FR와 NFR 연결을 함께 대조하고 시험/증거 대응을 기록한다.
위 표에 없는 NFR-5를 삭제하거나 NFR이 이 세 AC에서만 적용된다고 축소하지 않는다.
Q의 모든 NFR은 그대로이며, 원 JSON에 nfrIds를 소급 삽입하거나 hash를 변경하지 않는다.

### OS-F2 — 공개 비어 있지 않은 message vector 보강

미래 T01/T11에서 Q의 G05를 유지하고 [RFC 8032 §7.1](https://www.rfc-editor.org/rfc/rfc8032.txt)의
**TEST 2와 TEST 3** 공개 publicKey/message/signature를 추가하는 처리방침을 요청한다.
공식 원문에서 TEST 2의 message는 hex 72(1 byte), TEST 3은 af82(2 bytes)임을 확인했다.
이 초안에는 secret seed를 전사하지 않으며 key나 signature를 새로 생성하지 않는다.

승인 뒤 시료·정답 준비는 에이전트가 한다. 두 vector의 public bytes를 원문과 exact 대조하고,
각 원본 verify 성공 및 signature 한 bit/message 변형 거절을 T01에서 검사한다.
개인/운영 key를 읽거나 공개 RFC의 secret seed를 복사·Git 보존할 필요가 없다.
이는 기존 T11 공개 vector 책임 안의 보강이며 Q의 F01–F44를 삭제·재번호 매기지 않는다.
Q의 44개는 case 묶음 수이고 미래 변형 전개 후 leaf test 총수와 같다고 주장하지 않는다.

비어 있지 않은 RFC message도 **S3 domain+LF+CJSON payload 자체가 아니다.**
따라서 이 보강만으로 S3-framed signature 양성 검증을 완료했다고 할 수 없다.
F12의 exact message bytes 구성과 F21–F23/F25의 합성 envelope 결속 검사는 별도로 유지한다.
이 추가 vector는 Q 당시 이미 검사된 G01–G05나 Claude가 직접 확인한 새 결과가 아니다.

### OS-F3 — 합성 서명 시험과 한정 구현의 결합

§3의 결합 판정을 수용할 것을 요청한다. 승인 뒤 T01에서만 volatile 합성 key로
S3-framed 양성 서명 및 변조 검증을 수행하며 운영 key/등록/실제 사람 서명은 만들지 않는다.
합성 입력이 모두 일치하더라도 authorityEstablished=false이며 실제 권한은 성립하지 않는다.

F12의 message **구성 bytes** 자체는 signing 없이 대조할 수 있다. 그러나 그 대조나 G05
primitive 성공은 S3-framed 양성 signature 시험을 대신하지 않는다. 합성 서명이 거절되면
이에 종속된 양성 통합 시험은 미실행으로 남으며, 전체 Q AC-5/6 충족 주장은 차단한다.
실패·skip·미실행을 공개 vector 성공으로 덮거나 자동으로 더 좁은 구현을 시작하지 않는다.

### OS-F4 — 실제 착수 tip에서 support 9개 재결속

보고서의 후속 환경 관측은 develop=68421cc32fb3dbfdfa0a6609b7f1ec761ef0ba57,
M 이후 전진 및 lockfile 변경이다. Q의 M 기준 hash는 작성 당시 사실로 보존한다.
이 초안 작성은 현재 tip CI/lock 호환성/배포를 새로 검증한 작업이 아니다.

승인 문서와 receipt를 원 SHA 보존 merge commit으로 develop에 반영한 뒤, **실제로 구현을
시작할 tip의 40자 SHA**를 고정하고 해당 CI·Q/receipt ancestry·승인 원문 hash를 재확인한다.
그 tip에서 아래 9개에 대해 commit/path/Git blob OID/raw SHA 및 필요 시 working raw SHA를
다시 계산해 별도 착수 검증 기록으로 남긴다. 과거 Q JSON.supportFiles를 덮어쓰지 않는다.

- AGENTS.md
- package.json
- package-lock.json
- tsconfig.json
- scripts/run-unit-tests.mjs
- scripts/check-text-encoding.mjs
- scripts/check-doc-references.mjs
- scripts/check-policy-section-references.mjs
- scripts/check-release-records.mjs

hash 교체만으로 호환성 검증을 대신하지 않는다. M→착수 tip의 해당 diff, 실제 Node/tsx/
설치 dependency와 lock 일치, test discovery·script flags·검사 적용 범위를 함께 대조한다.
Windows checkout CRLF의 working hash와 Git blob raw hash를 구별한다.
변경 때문에 기존 6파일 범위·AC·pure 의존성이 성립하지 않거나 새로운 dependency/설치·
설정 선택이 필요하면 착수를 보류하고 별도 지시를 요청한다. 이 요청은 그 선택을 미리
승인하거나 package/lock 수정 권한을 추가하지 않는다. 재결속은 최종 P 동결도 아니다.

## 5. 기존 승인·잔여 및 미승인 범위

S2 approvalCommit A=3f14afb29eddc243640fdb0a5a4f604646ade9f0,
contractApprovalCommit CA=80842e62925c05af9450e6acc6ceb70b56f67655,
D=159267a80acee97da3a297c637343ea15de725f9,
K=6b2465e921c6e8b99ff032a36be8ada61c0ad599,
H=a19ae39d0da61295eb17e1545c74bc5b7e702c1a 및 Q의 sourceFiles 22개는 그대로다.
새 한정 승인 receipt가 생겨도 A/CA/K/activationApprovalCommit을 치환하지 않는다.

원결정 D1–D5·§12 및 §13 공란 bytes, S1/S2 P2-N1·C-COORD-1/R-*,
S3/S4 승인 N-1(controller key 분리)/N-2(no-contact)와 잔여,
별도 D namespace s2_clarification_confirmation_2026_09_07 N-1–N-3를 보존한다.
요청 header 증명 공백, exact V 8개 rule 전부 OK, ReplayEnvironment≠독립 network 차단
증명은 여전히 남는다. importer-attest/새 D EnvironmentAttestation을 채택하지 않는다.
D 확인 검토 1/1 소진 상태를 재시작하지 않는다.

HD-1–HD-8 pending/null 및 OP-TRUST, OP-P-ROOT, OP-CUSTODY, OP-SOURCES,
OP-ACTIVATION-APPROVAL, OP-RESOLVER, OP-C-INCLUSION 7개도 유지한다.
한정 권한을 받더라도 HD-7 전체 P 범위·dependency closure 승인이 완료된 것은 아니다.
상위 AC 54개는 partial 9/deferred 45/fullySatisfied 0이며 첫 subset만으로 full conformance가
아니다. historical 122/forward 109, legacy admissible=true·quality FAIL·workflow failure·
pair revoked·ordinal 2 금지, 15 source roles/4 proof kind/8 rule을 바꾸지 않는다.

이 한정 승인으로 허용하지 않는 것은 다음과 같다.

- scorer/F·ledger/P 전체·resolver·controller·custodian·importer·하위 verifier 또는 운영 adapter 구현
- 실제 key/signature/TrustAnchor 등록, registration parser·trust digest 생성·폐기 이력 운영
- EnvironmentApproval/ClockPolicy·genesis/root/journal/checkpoint/proof·백업 복구 운영
- S2 purpose 전환·activationApprovalCommit/C, dataset/manifest/register 변경
- holdout 작성·검수·seal/open, S5/v9 prompt 작성·활성화
- pair/예산/dispatch/re-run/provider 호출 또는 유료 turn
- production/Railway/DB/보호 설정·release gate·memoryExtractionEnabled·memoryInjectionEnabled 변경
- 6파일 밖 source/config/package/dependency 변경 및 자동 PR/merge/배포

하위 verifier 동결→실제 정책 등록→trustPolicyDigest→전체 P 채택→genesis/root,
D<K<activationApprovalCommit<C, S2 전환 검증→F 동결→holdout seal→S5→E/pair/예산/dispatch
순서는 면제하지 않는다.

## 6. 사람 회신과 별도 authoritative receipt

아래는 **미회신 양식**이다. 실제 승인 예시나 제출된 서명이 아니다.
파일을 직접 편집할 필요 없이 대화로 답하면 에이전트가 관측·판정을 구분해 옮겨 적는다.

```text
대상 Q: 7e5491f5fa24295912d5da7a6cc5e86ddb637f43
대상 문서 raw SHA-256: 0b8668d8bf65f139895af13c126d43b1a277d6152582ec3ce857fc763b1310df
대상 JSON raw SHA-256: 7ad37a223dc20eea71a20f539d7778000d1b0ada4e61e6d3d64cffe25dcf6ed2
Q 두 문서 및 이 승인 요청 초안 전체 수용 여부: 미회신
limitedOfflineImplementation + testOnlySyntheticSignatures 결합 승인 여부: 미회신
noAuthorityPromotion 수용 여부: 미회신
deferredRegistrationParser 수용 여부: 미회신
OS-F1 / OS-F2 / OS-F3 / OS-F4 처리방침 수용 여부: 각각 미회신
기존 승인·잔여·착수 조건 유지 및 검토 한계 인지 여부: 미회신
승인자: 미회신
승인일: 미회신
```

명시적으로 전체 범위를 수용한 사람 회신을 받은 뒤 별도 authoritative receipt를 준비한다.
회신이 모호하면 승인자/날짜·결합 판단·수용 범위를 확인하며, 빠진 선택을 채워 넣지 않는다.
이 요청의 pending 칸이나 Q 원문을 수정하여 승인받은 bytes를 바꾸지 않는다.

향후 receipt에는 최소한 다음을 결속한다.

- Q 40자 commit, 두 정확한 path와 각각의 전체 raw SHA-256.
- 실제 사람 decision/approvedBy/approvedAt 및 네 한정 결정·결합 조건의 수용.
- 이 요청 초안의 승인 당시 path/raw SHA-256과 존재하는 경우 그 문서 commit.
- Q 독립 검토의 대상·보고서 hash·판정 및 OS-F1–OS-F4 처리방침/한계 수용.
- 기존 승인/조건·미승인 범위·착수 tip 재결속 의무의 보존.

이 파일은 자기 raw hash나 미래 receipt commit을 자기 본문에 미리 넣지 않는다.
승인 후의 외부 기록이 실제 bytes를 계산해 결속한다. Git blob OID·raw SHA·문서 commit·
receipt commit은 각각 다르다. receipt에 signer wire/임의 암호 schema를 도입하지 않는다.

후속 순서는 사람 승인 → 별도 receipt → 별도 지시로 문서/receipt commit·push·PR →
Q/요청 문서/receipt 원 SHA 보존 merge commit → develop tip CI·OS-F4 재결속 →
그 tip의 새 codex/ 브랜치에서 별도 착수 지시다. 지금의 승인 요청 작성이나 이후 단순 PR
병합만으로 코드를 시작하지 않는다. squash/rebase로 승인 계보를 끊지 않는다.

이 문서는 기존 Q 문언과 검토자의 권고를 승인자가 명시적으로 수용할 수 있게 전사한 것이다.
독립 검토를 자동 반복하지 않는다. 다만 실제 요청이 Q의 protocol 의미·6파일 범위·운영 권한을
변경하거나 미정 정책을 새로 정해야 하면 단순 disposition으로 처리하지 않고 별도 검토·
승인 범위를 정한다. 검토된 Q의 판정을 변경된 bytes에 재사용하지 않는다.

## 7. 이번 초안의 검증 범위

Q HEAD·tracked/index clean 및 기존 untracked 16항목(일반 파일 14개)을 기준선으로 삼았다.
Q 두 blob의 raw hash와 working bytes, 기존 source 22개 및 무관 untracked 일반 파일 hash,
상대 문서 링크, 위 NFR 대응표와 Q Markdown/JSON의 차이를 직접 대조했다.
추가 파일은 이 요청 초안 한 개이며 코드·시험·fixture·승인 receipt는 만들지 않는다.

package.json scripts check:encoding:strict, check:policy-section-references,
check:release-records, check:memory-eval-succ9, check:memory-extraction-eval,
check:memory-eval-freeze, check:doc-references를 Q clean 기준선과 작성 후 각각 실행해 비교했다.
앞 6개는 exit 0, 마지막은 exit 1이며 출력과 기존 8건의 내용·이름이 기준선과 같다. 신규 실패는 0건이다.
기존 8건은 app/layout.tsx를 향한 lib/documentLanguage.ts, app/[locale]/layout.tsx,
scripts/security-regression-check.mjs, tests/e2e/ssr-root-language.spec.ts의 missing 4건과
동일 POSIX historical entry의 unused 4건이다. 이 범위에서 그 오류를 수정하지 않는다.

audit 문서는 일반 reference 검사 대상 밖일 수 있어 strict raw UTF-8/BOM/CRLF/후행 공백/
끝 LF·문서 링크·수치·승인 상태는 별도 확인했다. git diff --check는 exit 0이며 신규 파일의
no-index 검사는 추가 diff에 따른 exit 1/whitespace 진단 0건이다. 이번에는 keygen/signing/provider/운영 API 호출·tip CI 검증·
합성 구현 시험을 수행하지 않는다. 공식 RFC TEST 2/3의 공개 message 길이만 확인했으며
미래 T01/T11의 구현·시험 통과를 주장하지 않는다.
