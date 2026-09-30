# memory-eval vNext — OI-F1 사후 재검증 기록·OI-F2–F4 처리방침 초안

## 1. 상태와 읽는 경계

**DRAFT — 현재 재검증 관측은 기록했지만, 처리방침의 사람 수용·Git 고정은 아직 없다.**
이 문서는 구현 I의 최초 독립 검토 뒤 작성한 **사후 감사 기록**이다.
“구현 착수 전에 기록이 존재했다”거나 OI-F1의 시점 증명 공백을 해소했다는 주장이 아니다.
원래 승인 receipt·Q·구현 6파일 bytes를 바꾸거나 과거 관측을 소급 교정하지 않는다.

사용자는 “OI-F1 보완 기록과 OI-F2–F4 처리방침 초안” 작성 제안에
“네 그렇게 해주세요”라고 답했다. 이는 이번 두 파일의 작성·필요한 재검증 허가다.
아래 잔여 수용·계약 변경·구현 수정·commit/push/PR/병합·activation 승인으로 전사하지 않는다.

```yaml
recordStatus: draft_pending_human_disposition
recordKind: offline_subset_posthoc_revalidation_and_disposition
preparedBy: Codex
preparedDate: "2026-09-08"
draftRevision: OD-R1
evidenceType: posthoc_current_observation
currentRevalidationCompleted: true
currentRevalidationScopeRef: "§1 및 evidence.scope.currentRevalidationScope"
reviewCommit: "54ad04e29aa3390f4d342d152127e99928b4268e"
implementationBasis: "718aaf974e254e32bcb010ff2c1170a06011eed5"
historicalPackageBasis: "0c6b3fec7cfb68f5a2fc4e4a492de7905b413bff"
humanDispositionDecision: pending
approvedBy: null
approvedAt: null
acceptedDispositionIds: []
historicalPreStartTimingProven: false
oiF1ClosureDeclared: false
recordCommitAtPreparation: null
independentConfirmationReview: null
implementationBytesChanged: false
approvedDocumentBytesChanged: false
gitPublicationAuthorizedByThisInstruction: false
activationAuthorized: false
```

OD-R1은 이 초안의 최초 독립 검토 OD-F1–F4를 반영한 수정본이다. 원 초안의 hash·보존 사본과
검토 보고서는 §12에 결속한다. **수정본 확인 검토·사람 수용은 아직 없다.** 과거 I 구현 검토,
원 초안 최초 검토와 이번 수정본 확인 검토를 구별한다.

currentRevalidationCompleted=true는 **최초 작성 시 기록한 한정 관측·검사 작업을 마쳤다**는
뜻이다. “현재”는 아래 기록 시점의 I checkout이지 미래에도 유효한 상태가 아니다.
JSON.scope.currentRevalidationScope와 동일한 경계는 다음과 같다.

- 포함: 승인 원문 26개·지원 9개·구현 6개 Git/working bytes, 12 commit의 object/parents/계보,
  M→T 30파일·aa→T 12파일 diff 및 package/discovery 대조, 설치 package.json/version·
  optional/hidden-lock inventory, T CI 두 run의 GET/job/step 관측, T01 40 pass,
  최초 ID/path·두-trap Proxy 재현, 관련 package check 7개.
- 제외: 과거 착수 전 수행 시점 증명, receipt §7.4 소급 이행/면제, 사람 수용·OI-F1 closure·
  승인·Git 고정, full P/상위 54 AC 충족, T/I 전체 suite·lint/typecheck·88-case harness 재실행,
  I/최신 develop CI·배포·운영 readiness, 모든 설치 파일·tarball integrity.
- 완료는 모든 검사가 통과했다는 뜻도 아니다. 기록한 doc-reference 기준선 실패는 남아 있다.
  OD-R1의 새 세-trap 관측과 수정 전후 검사는 §12·JSON.draftRevision 및
  reproductions.getPrototypeOfSupplement에 별도 시점으로 기록하며 과거 결과를 덮어쓰지 않는다.

현재 기록의 최소 구분은 다음과 같다.

| 층 | 상태 / 출처 |
|---|---|
| 기존 승인 | Q·별도 scope receipt가 승인한 6파일 한정 범위와 OS-F1–OS-F4 처리조건. 원문 유지 |
| 구현 | I=54ad04e2…에 고정된 6파일. 이번에는 수정 없음 |
| 최초 독립 검토 | Claude의 PASS_WITH_WARNINGS, P1 0/P2 1/P3 3. 이 기록의 판정이 아님 |
| 이번 관측 | 현재 I checkout에서 T/I Git bytes·설치 환경·T CI·재현·검사를 다시 확인 |
| 남은 판단 | 사후 기록과 시점 공백의 처리방침 수용, OI-F2/F3 계약 해석·변경 선택. 아직 pending |
| 후속 제출 | 별도 audit commit·push/PR 지시 없음. I를 amend/rebase하지 않음 |

근거 JSON: [사후 재검증·처리방침 근거](evidence/memory-eval-vnext-offline-subset-review-disposition-2026-09-08.json)

- 현재 evidence raw SHA-256: `90e55c1f13471b5040103972d8476b8a10b51f67eaadd815a65fe42686693b11`
- 이 hash는 이 초안의 관측 JSON을 식별할 뿐 사람 승인 hash나 SignatureReceipt가 아니다.
- JSON은 원 commit별 26문서·9지원 파일·6구현 파일, M→T 30파일 diff, CI job/step,
  runtime 검사 방식·출력 hash, 실행 결과와 보존 기준선을 담는다.
- 이 값은 현재 초안 bytes를 식별한다. 이후 초안을 바꾸면 다시 계산해야 하며 아직 승인된 bytes가 아니다.

## 2. 최초 독립 검토의 귀속

| 항목 | 값 |
|---|---|
| 보고서 locator | C:/Users/Vyper/.codex/attachments/c34fdd17-56a9-4933-8ad5-2dcd61f3f73b/pasted-text.txt |
| raw SHA-256 | 74bbc335f5a5c05552d1ad7fa0e3660da8725cbf51996a35d3fa546af26e51c6 |
| bytes | 14007 |
| 대상 | I=54ad04e29aa3390f4d342d152127e99928b4268e |
| 보고된 판정 | PASS_WITH_WARNINGS — P1 0 / P2 1 / P3 3 |
| 보고된 코드 결론 | 코드 수정 요구 없음. OI-F1은 기록·시점 증거 공백 |
| 보고된 독립 실행 | T01 40/40, 별도 harness 88 case, 전체 7823 tests / 7804 pass / 18 fail / 1 skip |

보고서 hash·길이는 이번에 직접 읽어 계산했다. 전체 보고서·harness 로그가 Git에 들어 있다는
주장이 아니다. Claude의 88 case 및 전체 suite 결과는 **검토자 보고에 귀속**하며 이번 기록의
직접 실행으로 복사하지 않는다. 최초 작성 당시 이 기록의 독립 검토는 없었으며,
이후 받은 **원 초안 최초 검토**는 §12에 별도 귀속한다. OD-R1의 CONFIRMED·사람 승인은 아니다.
과거 Q 검토 또는 D 확인 검토 1/1과 회차를 섞지 않는다.

## 3. 고정 대상·계보·시점

| 별칭 | 정확한 commit |
|---|---|
| I — 구현 검토 대상 | 54ad04e29aa3390f4d342d152127e99928b4268e |
| T — 구현 basis | 718aaf974e254e32bcb010ff2c1170a06011eed5 |
| M — Q 작성 당시 basis | 0c6b3fec7cfb68f5a2fc4e4a492de7905b413bff |
| Q — 승인 패키지 | 7e5491f5fa24295912d5da7a6cc5e86ddb637f43 |
| RC — 승인 요청·scope receipt | bd69a817006fb45ee88aa399940acec3d4e36470 |
| RC SHA 보존 merge (#1279) | 182dad1aaa5c70c4e32696d0c60676ed4a53fc7b |
| 앞선 환경 기록의 tip | aa99828d3030badd7553fa4da2fa7ae12be944d6 |

I는 T를 유일 parent로 가지며 T..I는 6파일 A(mode 100644), 1938 insertions뿐이다.
Q parent=M, RC parent=Q, #1279 merge의 parents는
68421cc32fb3dbfdfa0a6609b7f1ec761ef0ba57 및 RC다.
모두 T/I의 조상으로 보존된다. T parents는
9d4d2d6361b634c49c28cfce44c66b68cc9d2357 및 aa99828d3030badd7553fa4da2fa7ae12be944d6이다.

원 decision A=3f14afb29eddc243640fdb0a5a4f604646ade9f0,
통합 계약 승인 CA=80842e62925c05af9450e6acc6ceb70b56f67655,
D=159267a80acee97da3a297c637343ea15de725f9,
K=6b2465e921c6e8b99ff032a36be8ada61c0ad599,
H=a19ae39d0da61295eb17e1545c74bc5b7e702c1a도 조상이다.
이번 기록/I/RC를 S2 approvalCommit A나 별도 activationApprovalCommit으로 바꾸지 않는다.

### 이번 관측 시점과 과거 사건은 다르다

| 이벤트 | UTC / 설명 |
|---|---|
| I Git committer time | 2026-09-08T05:42:31Z (Git metadata이며 실제 구현 착수 시각의 증명은 아님) |
| 현재 runtime inventory | 2026-09-08T07:04:24.188Z |
| 현재 Git·blob·보존 계산 | 2026-09-08T07:04:30.623Z |
| 현재 GitHub GET 재조회 | 2026-09-08T07:05:02.900Z–2026-09-08T07:05:06.528Z |
| 현재 T01 재실행 | 2026-09-08T07:06:38.562Z–2026-09-08T07:06:38.909Z |
| 현재 경계 재현 | 2026-09-08T07:06:40.233Z |

실제 착수 지시 “6파일 한정 구현 착수해주세요”는 앞선 대화 provenance다.
승인 receipt의 implementationStartAuthorized=false는 작성 당시 상태로 유지한다.
도구 로그에서 착수 전 검증했다고 보고한 내용과 **현재 Git/환경 재계산으로 증명한 내용**은
별개다. 현재 설치 상태로 과거 설치 상태의 모든 bytes 또는 실행 시점을 증명하지 않는다.

현재 HEAD와 local/remote 구현 branch는 I다. GitHub GET에서 관측한 develop ref는
2a74f920745ec6ae8126896e7f2e2cb4bae29c05이며 T와 다르다. 이는 ref snapshot만 읽은 것이고 그 tip의
support/CI/ancestry를 전수 재검증한 것이 아니다. fetch·checkout·branch 이동은 하지 않았다.
이 기록을 미래 착수 tip의 재결속 대용으로 쓰지 않는다.

## 4. 승인 원문·구현 6파일 보존

Q JSON.sourceFiles 22개와 Q Markdown/JSON·승인 요청·scope receipt 4개를 원 commit/T/I에서
raw Buffer로 읽었다. source commit의 ancestry와 blob OID/raw SHA/길이/line count를 계산했고
원 기록 SHA 26/26과 T/I equality가 일치한다. 26개 전수 표와 현재 workingRawSha256은
evidence.git.files에 있다.

“이전 관측과도 같다”는 비교는 **최초 작성자의 도구 로그에 귀속한 주장**이다. 그 과거 비교
hash/log가 이 기록에 없어 독립 검증할 수 없으며, 현재 재검증 증거나 과거 시점 증명으로
쓰지 않는다. JSON의 authorReportedPreviousWorkingMatch는 그 귀속만 보존한다.
공통 정의는 git.previousWorkingComparison이며, 현재 raw hash·Git blob equality와 다르다.

| 핵심 원문 | 원 commit | Git raw SHA-256 |
|---|---|---|
| .github/audits/memory-eval-vnext-contract-decision-2026-09-05.md | 3f14afb29eddc243640fdb0a5a4f604646ade9f0 | 355f8387808b8a7ea86e02ecffc4303562b5ab5c43c27fef0c2bdb2bf57e89da |
| .github/audits/memory-eval-vnext-offline-subset-approval-draft-2026-09-08.md | 7e5491f5fa24295912d5da7a6cc5e86ddb637f43 | 0b8668d8bf65f139895af13c126d43b1a277d6152582ec3ce857fc763b1310df |
| .github/audits/evidence/memory-eval-vnext-offline-subset-package-2026-09-08.json | 7e5491f5fa24295912d5da7a6cc5e86ddb637f43 | 7ad37a223dc20eea71a20f539d7778000d1b0ada4e61e6d3d64cffe25dcf6ed2 |
| .github/audits/memory-eval-vnext-offline-subset-approval-request-draft-2026-09-08.md | bd69a817006fb45ee88aa399940acec3d4e36470 | e9ff1e0f2d2335035588dfeeed888c5cd3729add66b79572a1a63dcd68f90351 |
| .github/audits/memory-eval-vnext-offline-subset-approval-2026-09-08.md | bd69a817006fb45ee88aa399940acec3d4e36470 | 44f8400b6b2338caa7443b97f7f47b72c8bb64951a9dd77078bf2b5140c8b498 |

원 decision은 400줄·§13 공란의 승인 bytes 그대로다.
기존 Q pending/null, 승인자·날짜·scope receipt, D/K와 잔여 수용 문언은 수정하지 않았다.

| I 구현 파일 | I Git raw SHA-256 = 현재 working raw SHA-256 |
|---|---|
| lib/memoryEvalVnext/protocol/canonicalJson.ts | 5af07e3d71ac9b0e3504f973264576aaf0934a7ffc0c15fc258adde95fbdd2a0 |
| lib/memoryEvalVnext/protocol/wire.ts | f2cd8e85f3215a8b67ed23b515e83ea790c67486aac76eb02977cbd05079bb31 |
| lib/memoryEvalVnext/protocol/signatures.ts | c9b9848004b868180b25d2615acfd7518e59bda3b440a89e49b18448648f82a9 |
| lib/memoryEvalVnext/protocol/trust.ts | b0d3a2212370b69d1860c7b52b246f3e396cebedd8a8feeb82b553b5213ce757 |
| tests/memoryEvalVnextWire.test.mjs | 16b933bc7e23736ae400449cc037af2eec0c1372f414bc3e281618558196257e |
| tests/fixtures/memory-eval-vnext/wire-vectors.json | d2528196b50e64aceeaed912b5e8077a7f42069b53639148b18e9a5034321af8 |

추가 helper·test·fixture·source/config/runner 변경은 없다. 아래 감사 두 파일은 별도 문서
산출물이지 일곱 번째 runtime 구현 파일이 아니며 아직 Git에 고정하지 않았다.

## 5. T 지원 파일 9개 재결속 — 사후 관측

모든 Git 행은 **T=718aaf974e254e32bcb010ff2c1170a06011eed5**에 결속된다.
현재 I에서도 같은 blob이다. 마지막 column은 **이번 I checkout에서 읽은 working bytes**이며,
과거 T checkout 시점에 직접 측정한 값으로 소급 표시하지 않는다.

| path | T/I Git blob OID | T/I Git raw SHA-256 | 현재 I working raw SHA-256 |
|---|---|---|---|
| AGENTS.md | 68196927b7cdf5b9722c34899823b7e4dd40947f | dd0d1b6da2bc8d1677b1fec691d6b6341a81c0e0a2170406fd023367e9203fad | f4e48afffa926681e07e93634509d75eb4abbc2fda19b6ab7a83ff57d4387dd1 |
| package.json | 9b8776a871580d077e1497fcae34283304d55daa | bf1fa24ae46281e9cbf94a6955c62f4d77a2c3c49902f54d2144ae9f9d61dbdf | 9a37cc648e8ae5eb5ceec6d8e3727477ac13ce5977b088328e26d3bc11f705b3 |
| package-lock.json | eb105b3cca2877a93f3f095430b118339e390b79 | d5b9271e5e5a7d0ab068a6c3bd821c99a4014b3915c09f367826bd348d94691c | fbb286ab621b1333421d4728474867b58956538f80299bfb4a0f4a0585e86266 |
| tsconfig.json | a21d63d1f62995aeee3d8885e720f1eb3f23ebc2 | cde6f63f9bcfc446ab223e6fff385b2d586893da2d8469d454c811acb54b3959 | a90dbaf3d7885d0e4d1db827497488e0d905cffc528d65836634b549e4c1a098 |
| scripts/run-unit-tests.mjs | 0a51e254e2df67fbdc8595b9a3b5d7deac1e3291 | 9a9b3cee85bc012ea90d1adfc79b03e912cea0a6838c12e048ded5222ad40ac9 | e6af763f362e6a31a838d7e5fc9a7c7d5dbbe42d8bceede1da6c9fba24986e76 |
| scripts/check-text-encoding.mjs | 76289e5a0405c8e5f49e12073c68e7daede1f386 | 0decbd8e3298abd77e305b6464b3ce6298b73b97a7ece345cd34d2b6e57d6f4e | 6f43f15a2c30afcfe9050897ca9db53b3f5e443d5d7ebf37fa7d4aa94cc8c473 |
| scripts/check-doc-references.mjs | 9d0da98af25d9f01bb0da84daa46232a91bfc65b | 943eee2e34ca059e911e4f7dcf58992345acdd288d79f56eaf2f269fb40c7f45 | 32ac89f0f955054b5ac8710b72cc0c0a9e2fb2c7d585de2e83c44abb0d7c3843 |
| scripts/check-policy-section-references.mjs | 2d66f9c194bb79d03626db091a9c34d4ffee5a7b | 57a2282e5609c4017f2a6ef1ac53b0394f9d006b8f185f1706b2cb9eaa3d1b50 | 15a73f7cd7f2ed624a129c41be42406243f83e6fa6e19d5a8ca8d6a6cc946d49 |
| scripts/check-release-records.mjs | 3ffb806df1d8a6057ea1db80ef692deea8765087 | ab99efc972ab85c02c2897f3e378a2ee19580a196647c1c5e2c61f3bdef16080 | 12466afec65a4f8728ef5972f33459757e365682c065d077fb76b014020d6999 |

Git raw와 working CRLF hash가 다를 수 있다. core.autocrlf 설정을 바꾸지 않았고,
Git raw 승인 hash를 working hash로 치환하지 않았다. 앞선 aa99828d tip의 지원 9개도 T와
byte 동일하지만, 그 사실은 과거 aa 대상 보고서를 T의 사전 기록으로 바꾸지 않는다.

### M→T 변경과 호환성 관측

M→T 전체 diff는 30파일이며, 아래는 T가 만들어지기까지 다른 작업을 포함해 이미 존재하던
변경이다. **이번 기록 작성의 변경 목록이 아니다.** 특히 spend JSONL·ledger 경로가
나온다는 이유로 이번 작업이 dataset/ledger에 썼다고 읽지 않는다.

```text
M	.github/RELEASE_CHECKLIST.md
M	.github/audits/2026-09-02-native-mobile-auth-n2-implementation-report.md
A	.github/audits/daily-security-audit-gitleaks-npm-audit-2026-09-08.md
A	.github/audits/evidence/memory-eval-vnext-offline-subset-package-2026-09-08.json
A	.github/audits/memory-eval-vnext-offline-subset-approval-2026-09-08.md
A	.github/audits/memory-eval-vnext-offline-subset-approval-draft-2026-09-08.md
A	.github/audits/memory-eval-vnext-offline-subset-approval-request-draft-2026-09-08.md
M	.gitleaksignore
M	docs/ops/ai-review-eval-runbook.md
M	docs/ops/ai-review-evaluation-set/decision-v1.spend.jsonl
M	docs/ops/mobile-auth-key-rotation.md
M	docs/policy/voice-input.md
M	lib/aiReviewDraftLedger.ts
M	lib/mobileAuthContract.ts
M	lib/mobileAuthKeyring.ts
M	lib/voiceInputPricing.ts
M	package-lock.json
M	package.json
M	scripts/check-mobile-auth-keyring.mjs
M	scripts/check-voice-price-register.mjs
M	scripts/draft-ai-review-eval-candidates.mjs
M	scripts/ops/Invoke-MobileAuthDeploymentVerify.ps1
M	scripts/ops/Test-InvokeMobileAuthDeploymentVerify.ps1
M	scripts/verify-mobile-auth-deployment.mjs
M	tests/aiReviewDraftLedger.test.mjs
M	tests/aiReviewDraftLedgerCli.test.mjs
M	tests/mobileAuthDeploymentVerify.test.mjs
M	tests/mobileAuthKeyring.test.mjs
M	tests/mobileAuthKeyringCheck.test.mjs
M	tests/voiceProviderBudget.test.mjs
```

지원 9개 중 7개는 M/T에서 같고 package.json·package-lock.json만 다르다.
package scripts와 root dependencies/devDependencies는 동일하고 overrides의
fast-uri가 3.1.5→^3.1.6, prisma.mysql2=^3.23.1가 추가됐다.
lock의 실제 diff 통계는 evidence.git.mToTNumstat에 그대로 기록한다.
새 dependency/override를 선택하거나 lock을 수정하지 않았다.

aa99828d→T의 변경은 mobile-auth 관련 12파일이며 지원 9개는 동일하다.
경로 전수는 evidence.git.aaToT에 있다. 같은 support bytes에 대한 앞선 설치 검증은 참고하되,
T의 Git/CI/시점 기록을 대신하지 않는다. source·runtime 호환성의 관측 범위는 아래와 같다.

## 6. 현재 설치 환경·discovery·CI

### 현재 설치 환경

로컬 PC Windows x64의 I checkout에서 읽기 전용으로 재계산했다. Node v22.22.2,
npm 10.9.7, OpenSSL 3.5.5다. npm install/ci/dedupe·Prisma generate·migration·seed,
서비스 접속/설정은 수행하지 않았다.

| package | 현재 physical / T=I lock version |
|---|---|
| tsx | 4.23.13 / 4.23.13 |
| typescript | 6.0.3 / 6.0.3 |
| esbuild | 0.28.1 / 0.28.1 |
| @esbuild/win32-x64 | 0.28.1 / 0.28.1 |
| prisma | 7.10.0 / 7.10.0 |
| @prisma/client | 7.10.0 / 7.10.0 |
| @xmldom/xmldom | 0.9.12 / 0.9.12 |
| mysql2 | 3.24.3 / 3.24.3 |
| sql-escaper | 1.5.1 / 1.5.1 |
| browserslist | 4.28.9 / 4.28.9 |

- physical package.json 927개 version 일치, mismatch 0, mandatory missing 0.
- optional missing 175개: entry 자체 OS/CPU 비호환 164개, 그 외 optional/WASM 경로 11개.
  필수 누락 또는 다른 OS의 호환성 통과로 세지 않는다.
- hidden lock의 version 불일치 0.
- inventory SHA-256: 61b16f3c4f6a97e146dc612b8ce0d77bbe5418a9100cddfd3d2d7e0257be62b1.
- 산식: lock.packages의 존재하는 non-link package.json마다 path/version/raw SHA를 만들고,
  path의 JavaScript 기본 문자열 sort, 즉 **UTF-16 코드 단위 순** 배열을
  JSON.stringify(UTF-8, 끝 LF 없음)해 SHA-256. localeCompare 순서가 아니다.
  이는 package.json/version inventory이지 모든 설치 파일·tarball integrity 재감사가 아니다.
- npm ls --all --json exit 0이나 extraneous label 2개는 남는다:
  @emnapi/runtime@1.11.3, @img/sharp-wasm32@0.35.4.
  두 경로는 lock의 optional exact version이기도 하며 label을 숨기거나 삭제하지 않았다.
- OD-F4에 따라 최초 npm ls stdout의 usable hash/bytes 필드는 철회했다. 당시 capture의
  stream/encoding/개행 규칙이 기록되지 않았고 독립 재현도 불일치했으므로 이를 추측해
  소급 기입하지 않는다. JSON.runtime.npmLs.withdrawnClaim은 **사용 불가한 옛 주장**의
  변경 이력일 뿐 bytes 식별자가 아니다. exit/problems/error/stderr·optional lock binding의
  관측과 구별하며 OD-R1에서 npm ls를 다시 실행했다고 주장하지 않는다.

### Discovery·실행 경계

T의 tracked server test는 624개/client 4개, I는 625개/client 4개다.
차이는 승인된 T01 한 파일이며 T11 JSON은 test로 발견되지 않는다.
server/client를 발견하는 기존 scripts/run-unit-tests.mjs는 변경하지 않았다.

검사는 Windows 실행에 필요한 OS/PATH/TEMP 등만 allowlist한 child 환경에서 실행했다.
DOTENV_CONFIG_PATH=H:/Project/ai-chat-hub/.os-f4-absent-env-file(실제 부재),
DOTENV_CONFIG_QUIET=true, NEXT_TELEMETRY_DISABLED=1은 그 child에만 전달했다.
.env/비밀값을 읽어 출력하지 않았고 부모 환경·저장소 설정은 바꾸지 않았다.

T01은 기존 package runner의 단일-file filter 부재 때문에 다음 flags를 그대로 옮겨 실행했다:
--conditions=react-server --import tsx --test --test-concurrency=1 --test-reporter=spec
--test-reporter-destination=stdout. 대상은 tests/memoryEvalVnextWire.test.mjs뿐이다.
40 tests/40 pass/0 fail/0 skip을 이번에 직접 관측했다.
T01 안의 이미 승인된 volatile 합성 key/sign 시험은 수행됐지만 private key의
export/직렬화/보존/로그는 없으며 운영 key/signing·provider/DB 호출과 다르다.

### T의 CI — 실제 job·step 귀속

두 run 모두 attempt 1, headSha=T, event=push, branch=develop, completed/success다.
GitHub GET 응답의 재조회 시점과 원 응답 hash·job/step 결과를 evidence.ci에 기록했다.

| Run | 직접 재조회한 실제 성공 step |
|---|---|
| [Admin Console E2E 34188356181](https://github.com/mposition/Tomverse/actions/runs/34188356181) | Production build; Run the Admin Console E2E suite |
| [Credit Finance DB Integration 34188356415](https://github.com/mposition/Tomverse/actions/runs/34188356415) | assistant/email/finance/accounts/routing/import/memory 7 lane의 Run financial DB integration tests; Require every lane to have passed |

실패 증거 upload 또는 red-lane 알림 step의 skipped는 그대로 남기며 모든 step 실제 실행으로
표시하지 않는다. T CI 종료 metadata는 04:58:19Z/04:58:09Z이고 현재 조회가 그 과거 사실을
확인한 것이다. **착수 전 담당자가 그 run을 읽었다는 시점 증명은 아니다.**

I의 workflow run은 조회 당시 0건이다. T CI를 I CI, 최신 develop CI, Railway 배포,
운영 readiness로 승격하지 않는다. PR 생성·CI rerun/dispatch·병합은 수행하지 않았다.

## 7. OI-F1 — 사후 증거 보완과 남은 시점 공백

근거는 [기존 scope receipt](memory-eval-vnext-offline-subset-approval-2026-09-08.md)
§7.3–§7.5(원문 223–229줄)다. T support·환경·CI 자체는 현재 재계산으로 확인했으나,
“착수 전에 별도 T 기록을 남겼다”는 사실은 이 문서로 생성할 수 없다.

| 항목 | 현재 상태 |
|---|---|
| T 대상 지원 9개·M→T diff·CI·환경의 확인 가능한 별도 파일 | 이번 두 파일로 사후 작성. 아직 untracked |
| 원 I·Q·receipt의 SHA·Git 계보 | 보존 |
| 과거 사전 수행 시점의 검토 가능 증거 | 공백 유지; historicalPreStartTimingProven=false |
| 시점 공백의 사람 수용 | pending |
| OI-F1 전체 closure / 원 승인 조건 충족 소급 선언 | 하지 않음 |
| 독립 검토 회차 | 원 초안 최초 검토는 §12; OD-R1 수정본 확인 검토는 아직 없음 |

권장 처리방침 초안:

1. 현재 관측과 사후 작성 사실을 I 밖 **별도 audit commit**으로 고정한다.
   이 작업에서는 아직 commit하지 않으며 별도 지시가 필요하다.
2. 원 I를 amend/rebase/squash해 기록이 구현과 동시에 있었던 것처럼 만들지 않는다.
   원 receipt·Q의 bytes도 바꾸지 않는다.
3. 현재 재검증의 실체와 남은 시점 공백을 구분해 사람이 처리조건을 수용할지 판단한다.
   이 초안은 수용한 척 서명하거나 reviewer의 비차단 판단을 사람 승인으로 대용하지 않는다.
4. 후속 구현의 실제 새 tip에서는 **착수 전에** 동일 재결속 기록과 정확한 CI를 검증한다.
   미래 merge/develop 이동 또는 새 작업 시작을 이번 T 기록으로 면제하지 않는다.

Claude는 OI-F1을 비차단 P2 증거 공백으로 분류했다. 이는 검토자 판정으로 보존한다.
“비차단”은 미기록 사실을 지우는 말이 아니며, 이 문서가 원 승인 조건을 독자 면제하지 않는다.

## 8. OI-F2–F4 처리방침 초안

### OI-F2 — ID/path 허용값 축소는 별도 결정

현재 코드 재현에서 isAsciiId는 newline·space·DEL을 수용했고,
BlobRef path의 newline도 구조 검사에서 수용됐다. evidence.reproductions에 입력·결과가 있다.
현재 Q의 ID는 “NFC ASCII; exact equality”, path는 별도 상대 POSIX 제약이며,
현재 코드는 그 두 범위를 같은 정책으로 합치지 않는다.

**제안 상태: deferred_pending_exact_contract_decision. 이번 구현 변경 없음.**

- ID에서 비공백 ASCII 0x21–0x7e만 허용할지 별도 결정한다. 이는 C0/DEL 거절에 더해
  space도 제거하는 허용집합 축소이므로 “printable”이라는 한 단어로 범위를 숨기지 않는다.
- path는 별도 결정이다. 같은 ASCII 범위를 그대로 적용하면 현재 허용되는 NFC 비ASCII와
  space도 함께 배제할 수 있다. 제어문자 금지·공백·Unicode 처리를 각각 명시해야 한다.
- normalization/trim/case-fold로 입력을 고쳐 성공시키는 변경은 제안하지 않는다.
- exact 정책·적용 field·과거 값 취급·음성 case를 먼저 정한 후 별도 승인으로 구현한다.
  기존 S3/Q/receipt를 수정하거나 이 초안만으로 validator를 좁히지 않는다.

### OI-F3 — Proxy와 accessor/toJSON 보장을 분리

최초 작성 재현(2026-09-08T07:06:40.233Z)은 ownKeys/getOwnPropertyDescriptor만 세었고
encoder 1/3, checkWire(object) 1/3, 일반 bytes decode 0/0이었다.
그 시점 getPrototypeOf는 **미측정이지 0이 아니다**. 원 source/result는 JSON.reproductions에 유지한다.

OD-F3 보완 재현(2026-09-08T07:43:31.885Z, 같은 I의 3-field BlobRef Proxy):

| 경로 | 결과 | ownKeys | getOwnPropertyDescriptor | getPrototypeOf |
|---|---|---|---|---|
| encodeCanonical(proxy) | ok | 1 | 3 | 1 |
| checkWire("BlobRef", proxy) | ok | 1 | 3 | 1 |
| 위 결과의 일반 Uint8Array를 decodeCanonical | ok | 0 | 0 | 0 |
| decode된 plain object를 다시 checkWire("BlobRef", ...) | ok | 0 | 0 | 0 |

새 source/result·시점·실행 경계는 JSON.reproductions.getPrototypeOfSupplement에 별도로 담았다.
0은 이 재현의 **원 Proxy counter**에 대한 값이며, 모든 hostile byte 객체/변형된 전역 환경에
사용자 코드 실행이 없다는 보편 보장을 뜻하지 않는다.

따라서 보고서의 “wire 입력은 영향 없음”을 그대로 일반화하지 않는다.
영향을 받지 않은 재현은 **일반 bytes decode**이고, checkWire(object)는 encodeCanonical을
거치므로 Proxy trap이 실행된다. Proxy trap은 이 process의 caller 코드이며 이번 재현은
counter 증가뿐이었다. 네트워크·자격증명·운영 데이터에 접근하지 않았다.

**제안 상태: pending_explicit_input_guarantee_disposition. 이번 구현 변경 없음.**

현재 주석의 “not a sandbox for hostile JavaScript/Proxy code”는 Q의 규범을 면제하지 않는다.
Q JSON의 F07 then은 “invalid_input; accessor 호출 등 사용자 코드를 실행하지 않음.”이다.
원 초안 검토자는 이 문언상 Proxy 실행을 보장 밖으로 빼는 것은 **단순 명확화가 아니라
실질 보장 축소**라고 판단했다. 그 판단을 여기 귀속하며, 이 수정본도 그 후보를 승인된 해석으로
표시하지 않는다. 현재 I가 문자 그대로의 광범위한 F07 보장을 충족했다고 선언하지 않는다.

사람에게 제시하는 두 선택은 다음과 같고 **선택값은 null, 어느 쪽도 미승인**이다.

| 선택 | 결정할 정확한 방향 | 영향과 별도 승인 범위 |
|---|---|---|
| A — 보장 축소 수용 후보 | 일반 object data를 검사할 때 property getter/setter·toJSON·custom iterator hook을 호출하지 않는 한정 보장으로 좁히되, caller Proxy trap 실행 방지는 보장하지 않음 | Q F07에 대한 실질 보장 축소. 영향받는 Q/S1 요구·C01/C02 진입점·입력 전제·잔여 위험·효력 대상 I/후속 SHA를 exact 변경 승인/receipt에 결속해야 함. 원 승인 bytes를 덮어쓰거나 과거 F07 충족으로 소급하지 않음 |
| B — 기존 보장 유지·강화 후보 | 관련 root/nested object·진입점에서 관측 가능한 연산 전에 Proxy를 거절할 강화 범위를 별도로 설계·승인 | 새 import/helper/builtin과 시험 범위에 별도 exact 승인 필요. Q Markdown §3의 C01 허용 builtin은 node:crypto hash뿐이며, 같은 6개 path 안의 수정이어도 권한이 자동 생기지 않음. revoked Proxy·중첩 입력·bytes 경계 전제와 음성 시험으로 가능성과 보장을 검증하기 전 완료 선언 금지 |

위 A의 문언도 검토·결정을 위한 후보이지 확정 계약이나 구현 수정 허가가 아니다.
B 역시 새 API를 채택했거나 Proxy 거절만으로 모든 사용자 코드 경계를 해결했다는 주장이 아니다.
어느 쪽도 선택하지 않으면 pending을 유지하고 그 선택에 의존하는 후속 단계로 진행하지 않는다.
원 Q·receipt·구현 6파일은 그대로 두며, 이번 수정은 선택지와 수용 조건을 드러내는 데 한정한다.

### OI-F4 — Windows runner는 범위 밖 후속 작업

이번 npm run test:unit은 exit 1로 unit test를 실행하지 못했다.
동일 runner의 native spawn 재현: 625 server 파일, 실행 파일+args를 공백으로 합친 길이
37779자, error.code=ENAMETOOLONG, status=null, child stdout/stderr 0 bytes.
합친 문자열 길이는 Windows가 실제 전달한 command-line bytes 길이라는 주장이 아니다.
리포트와 숫자가 다른 것을 그대로 두고 executable 경로·집계 방식 차이를 구별한다.
npm wrapper의 script 안내 출력과 테스트 child 출력 0 bytes도 서로 다른 층이다.

**제안 상태: deferred_outside_six_file_scope. runner 수정·issue 생성 없음.**

별도 작업에서 Windows 분할 실행 또는 동등한 발견/실행 방식을 다룰 수 있다.
그때 package script 진입점, server/client 분리, react-server 조건, tsx loader,
concurrency=1·spec/stdout reporter, 모든 파일 누락/중복 방지, 실패 집계와 exit를
회귀 검사해야 한다. 이번 문서는 fix 완료·Linux 전체 CI 통과·성능 보장을 선언하지 않는다.

## 9. 검사 결과 — 현재 실행과 과거 귀속

초안 작성 전 I tracked/index clean에서 아래 package script를 그대로 실행했다.
“과거 I commit 직전 출력과도 hash가 일치했다”는 것은 **최초 작성자의 도구 로그 귀속 주장**이다.
그 과거 log/비교 hash가 JSON에 없어 이번 기록만으로 독립 검증할 수 없으며, 현재 검사의
기준선으로 쓰지 않는다(JSON.verification.priorComparisonAttribution).
직접 비교할 수 있는 것은 아래 최초 작성 전후 출력과 §12의 수정 전후 출력이다.
기존 doc 오류는 그대로이며 새로운 코드 수정이나 기준선 오류 수정을 하지 않았다.

| npm script | 이번 작성 전 exit | 전체 출력 SHA-256 |
|---|---|---|
| check:encoding:strict | 0 | 7d5195263cb38b5aa0de4bf8e0ead06774933b4e124616518883574554bcd380 |
| check:policy-section-references | 0 | a023c1b4064b51f38930616299cf1b1cd344d1d96ff41f3b32025f9f9398682e |
| check:release-records | 0 | 5d216eabba9f6eb6762717a31e2bc3c26172d530ed554ab099a9c21a537f3565 |
| check:memory-eval-succ9 | 0 | f792af65d17e277fecceedf03b5eaba6484180748d3013de077a027a005e194c |
| check:memory-extraction-eval | 0 | 575a56bac68f5e261286b5e00894451bd0fb1b7b5cead22e49d8d8f28315629b |
| check:memory-eval-freeze | 0 | 8318af98d6c2a2ce9ca9f2d7c0d9b4acc70cc97ee7555b8dc026a4fb5b10cca1 |
| check:doc-references | 1 | a71fe18e693b1d3bd8a77f83701bf950e0d8cef5635c3330ba9e85d466d2ac6a |

doc-references 기존 8건은 app/layout.tsx를 지목한
lib\\documentLanguage.ts, app\\[locale]\\layout.tsx,
scripts\\security-regression-check.mjs, tests\\e2e\\ssr-root-language.spec.ts의
missing 4건 및 같은 POSIX historical entry의 unused 4건이다.
이름·내용·출력 hash로 비교했으며, 같은 개수만으로 동일 실패라고 판정하지 않았다.

이번 T01은 40/40으로 직접 재실행했지만, **T checkout 전체 suite·I 전체 분할 suite·
lint/typecheck·Claude 독립 harness 88 case는 이번 문서 작성에서 다시 실행하지 않았다.**
이유는 구현 bytes가 I 그대로인 문서 보완이며, 이 작업의 직접 목적이 T source/지원·환경·CI
및 증거 기록 재결속이기 때문이다. 앞선 I 구현 검사와 Claude 보고는 출처를 구별해 보존한다.
단일 T01 통과를 full P conformance나 모든 상위 AC 충족으로 부르지 않는다.

관련 검사 범위도 구별했다. encoding script는 .github를 포함해 source control-character를
검사하지만 모든 문서의 정책 의미를 검증하지 않는다. doc/policy reference script는 audits를
제외하며 release-records는 release-* 기록을 검사한다. 이 두 파일의 strict UTF-8/JSON parse,
상대 링크·전수 SHA/identity·후행 공백·diff 및 보존은 별도 검사한다.

### 작성 후 검증 — 완료, 기존 실패 보존

두 파일 작성 후 같은 7개 package script를 다시 실행했다. 6개 exit 0 및 doc-references
exit 1/기존 8건이 작성 전과 같고, 전체 출력 SHA도 7/7 동일하다. 신규 실패는 0건이다.
이 결과는 이번 I checkout에서의 문서 작성 전후 대조이며 T 전체 suite의 직접 재실행이 아니다.

두 파일의 fatal UTF-8 decode·UTF-8 roundtrip, JSON parse, BOM/CR/후행 공백 부재와 끝 LF,
상대 링크 2개 존재, Git identity·승인 원문·지원·구현·기존 파일 hash 보존을 별도로 확인했다.
일반 diff --check는 exit 0, 새 파일별 --no-index --check는 exit 1/진단 0건이다.
후자는 추가 diff가 있다는 exit이며 whitespace 실패가 아니다. index/tracked 변경은 없다.

최초 검증 helper 명령은 Windows command-line 길이 한도로 process 생성 전에 실패했다.
비교용 메모리 metadata만 줄여 같은 읽기 전용 감사를 완료했고, 별도 helper 파일이나
repository code를 고치지 않았다. 마지막 metadata·evidence hash 전사 후에도 두 파일의
bytes/JSON/reference/hash 결속을 다시 확인한다. 자기 파일 hash를 JSON 안에 넣지 않아
자기참조 digest를 만들지 않는다.

## 10. 보존과 미승인 범위

작성 시작 HEAD=I, branch=codex/memory-eval-vnext-offline-subset-implementation,
tracked/index clean이었다. 기존 untracked 일반 파일 19개와 ignored 문서 3개, 총 22개
raw hash를 보존 기준으로 수집했다. .claude/·.codex/ 두 directory는 건드리지 않았고
전체를 재귀 조사·복사하거나 directory hash를 계산했다고 하지 않는다.
원 26문서·9지원 파일·6구현 파일과 기존 untracked의 목록·hash는 evidence.git에 있다.

이전 OS-F4 두 Markdown/two JSON 및 I 전달 프롬프트를 포함해 기존 원문은 유지한다.
과거 aa/e881 기록을 T 결과로 덮어쓰지 않는다. 현재 두 파일의 path는 다음뿐이다.

- .github/audits/memory-eval-vnext-offline-subset-review-disposition-draft-2026-09-08.md
- .github/audits/evidence/memory-eval-vnext-offline-subset-review-disposition-2026-09-08.json

이번에는 scorer/ledger/resolver/registration parser·operational adapter, dataset/manifest/register,
holdout/S5/v9 prompt, pair·예산·dispatch/provider 호출, release gate,
memoryExtractionEnabled/memoryInjectionEnabled를 바꾸지 않는다.
GitHub는 GET만 사용하고 production/Railway/DB API·배포·CI dispatch는 수행하지 않는다.

HD-1–HD-8 pending/null, OP 7개, 상위 54 AC partial 9/deferred 45/fullySatisfied 0,
D1–D5/§12, S1/S2 P2-N1·C-COORD-1/R-*, S3/S4 N-1/N-2 및 별도 D namespace 잔여는 유지한다.
D<K<activationApprovalCommit<C와 S2 전환 검증→F 동결→holdout seal→S5→E/pair/예산/dispatch
순서를 바꾸지 않는다. 이 초안은 S2 activation 승인 패키지의 공백을 채우는 운영 proof가 아니다.

## 11. 사람이 결정할 항목 — 아직 미수용

1. OI-F1의 현재 사후 재검증 기록과 **남는 과거 시점 증명 공백**을 구별한 처리방침을 수용할지.
2. OI-F2는 현재 입력 규범을 유지하고 별도 exact ID/path 결정을 기다릴지.
3. OI-F3의 §8 A(실질 보장 축소) 또는 B(기존 보장 유지·강화)의 어느 방향을 선택할지,
   그 exact 계약·입력 전제·잔여·후속 구현 승인 범위를 어떻게 정할지. 선택은 아직 null이다.
4. OI-F4 runner 수정을 6파일 밖 별도 작업으로 남길지.

이는 판정 질문 목록이지 accepted 표가 아니다. 사용자에게 원문 hash·표·검사 결과를
다시 계산하도록 떠넘기지 않으며 계산은 위에 제공했다. 사람에게 남는 것은 실제 수용 판단이다.
원 초안 최초 검토는 §12처럼 완료됐지만, 수정본 확인 검토·사람 승인·Git 고정은 각각 별도이며
어느 것도 실행했다고 선언하지 않는다.

## 12. OD-R1 — 원 초안 독립 검토 반영과 확인 검토 인계

### 원본과 회차 고정

| 구분 | path / raw SHA-256 |
|---|---|
| 원 OD_MD, 30777 bytes / 460 LF lines | C:/Users/Vyper/AppData/Local/Temp/memory-eval-od-revision-61fd971b2fd346e5b5241bae48c227bf/original.md / 7041f7f5898ca333ae1d54f3656644d26c736011b32d8e4ad121009406fa233b |
| 원 OD_JSON, 131358 bytes / 2581 LF lines | C:/Users/Vyper/AppData/Local/Temp/memory-eval-od-revision-61fd971b2fd346e5b5241bae48c227bf/original.json / 0400f4455f620038c990e82872d724ec6a6233ca8c7be6976b772c10d56eee72 |
| 원 초안 최초 검토 보고서, 10830 bytes | C:/Users/Vyper/.codex/attachments/8c91b016-4cd6-401a-8e32-0790a509163e/pasted-text.txt / 63373d6b845a439908661bec3eb356ce6b885c650f59e28fb68da625fc9edb84 |

원본은 이번 수정 전에 저장소 밖 새 임시 디렉터리에 exact-byte 복사해 보존했다.
위 경로는 로컬 전달용이며 Git/장기 보관소가 아니다. 사본이 없으면 이전 검토 보고서의
수치만으로 원본 diff를 증명하지 않는다. 기존 최초 검토 프롬프트의 원 SHA도 바꾸지 않는다.

보고된 원 초안 판정은 PASS_WITH_WARNINGS, P1 0/P2 0/P3 4다. 이는 원 OD 두 파일에 대한
판정이지 OD-R1의 확인 검토·사람 승인·I 구현 재승인이 아니다. 검토자의 재실행 주장도
그 보고서에 귀속하며 이번 작성자의 새 실행으로 복사하지 않는다.

### 지적 대응 — 작성자 보완, closure 미선언

| 항목 | 수정 내용 | 상태 |
|---|---|---|
| OD-F1 | 완료 boolean을 MD에도 표시하고 포함/제외·기준선 실패·시점 범위를 JSON과 일치시킴 | addressed_pending_independent_confirmation |
| OD-F2 | 과거 working/check 출력 비교를 검증 불가한 작성자 귀속 주장으로 명시; 현재 raw 증거와 분리 | addressed_pending_independent_confirmation |
| OD-F3 | 과거 두-trap 결과 유지, 별도 시점 getPrototypeOf 포함 재현 추가; 미선택 A/B 보장 결정 제시 | addressed_pending_independent_confirmation |
| OD-F4 | 재현 불가능한 npm ls stdout hash/bytes의 식별자 지위 철회, 사용 불가한 옛 주장만 변경 이력으로 유지 | addressed_pending_independent_confirmation |

finding이 아닌 inventory 정렬 관측도 JavaScript 기본 sort의 UTF-16 코드 단위 순으로 명시했다.
OI-F1의 과거 시점 공백, OI-F2 ID/path 보류, OI-F3 미선택, OI-F4 별도 작업은 유지된다.
원 초안/과거 I/Q/D 검토 회차나 D 확인 검토 1/1을 초기화하지 않는다.
OD-R1 확인 검토는 이 수정 범위와 그 회귀에 한정해 별도 1회 요청할 대상이며 아직 수행하지 않았다.

### 이번 수정의 검증 범위

수정 시작 HEAD=I, tracked/index clean, 일반 untracked 22개와 별도 directory 2개였다.
기존 일반 파일 중 이번 두 초안만 수정하고 확인 검토 전달 프롬프트 한 파일만 새로 추가한다.
그 밖의 일반 파일 20개·기존 ignored 문서 3개와 승인 원문 26개·지원 9개·구현 6개를 보존한다.
기존 .claude/·.codex/ 전체 재귀 수집·정리는 하지 않는다.

수정 전 7개 package check는 최초 문서 작성 전후 결과와 exit·전체 출력 hash 7/7이 일치했다.
수정 후에도 6개 exit 0, doc-references exit 1/기존 8건이며 exit·전체 출력 hash 7/7이
수정 전과 같다. 신규 실패 0건이다. 실패 이름 8개와 전후 출력은
JSON.draftRevision.checks.docReferenceComparison에 나란히 기록했다.
이는 I checkout의 수정 전후 대조이지 T clean-tree 전체 suite 실행이 아니다.
검사 출력 hash는 allowlisted child의 UTF-8 stdout 다음 stderr를 그대로 연결한 bytes에
대해 계산했다. trim·개행 추가는 없으며, 철회한 npm ls capture와는 별도 규칙이다.

이번에 새로 실행한 것은 관련 7개 check와 세-trap local counter 재현이다.
T01·T/I 전체 suite·lint/typecheck·88-case harness·설치 inventory·npm ls·CI는 재실행/재조회하지 않았다.
이유는 승인 원문·구현 bytes가 그대로인 문서 보완이며 과거 관측 전체를 새 시각으로 갱신하는
작업이 아니기 때문이다. 각 기존 timestamp와 미실행 범위를 유지한다.
파일 hash·JSON·문서 결속·인코딩·공백·범위·보존은 마지막 metadata 전사 후 다시 확인한다.
두 수정본의 raw SHA는 별도 전달 프롬프트에서 고정한다. JSON은 자신의 최종 hash를 담지 않는다.
