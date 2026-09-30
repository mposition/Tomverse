# memory-eval vNext — OI-F3 B 실제 착수 후보 tip 사전 재검증

## 1. 판정과 권한 경계

**판정: PASS_WITH_RETAINED_RESIDUALS — 아래 T의 한정 사전 재검증 완료.**

- 검증 대상 T: `15dd94f7f9e96aa815cca1034f1c1abf24d993a8`
- 작성 날짜: 2026-09-08. 작성자: Codex.
- 작업 지시: 실제 착수 tip의 CI·지원 9파일·실행 환경·승인 계보를 재검증하고 별도 기록 작성.
- 현재 checkout: T의 codex/memory-eval-vnext-oi-f3-b-start-tip-revalidation 브랜치.
  사전 검증과 CI 확인 후 생성했으며 기존 승인 기록 브랜치는 보존했다.
- 구현·설치·설정 변경·commit/push/PR·CI 재실행은 하지 않았다.
- 이 기록은 새 사람 승인 receipt나 독립 검토 결과가 아니다.
- actualImplementationStartAuthorized=false, fullF07Satisfied=false, fullPFreeze=false.

[승인 receipt §5–§6](memory-eval-vnext-oi-f3-b-approval-2026-09-08.md)와
[승인된 R1 패키지](memory-eval-vnext-oi-f3-b-approval-package-draft-2026-09-08.md)의
FR-16/AC-12/B24, 상위 RC §7의 사전 조건을 확인한다.
새로운 명세·허용 API·호환성 예외를 결정하거나 승인 범위를 확대하지 않는다.

`spec-driven-workflow`의 bounded-autonomy 범위 통제 원칙을 적용했다.
이것은 새 spec 작성이나 배포 직전 ship-gate가 아니므로 코드·테스트 stub·운영 감사를
추가하지 않았다. 설치나 scope 변경이 필요했다면 별도 권한 없이는 진행하지 않는다.

증거: [사전 재검증 JSON](evidence/memory-eval-vnext-oi-f3-b-start-tip-revalidation-2026-09-08.json)

- JSON raw SHA-256: `af88c5532e4e84a783d3fa89c20cdc489c74689edfb98aa9c6eeadd483fb4577`
- 이 SHA는 관측 증거 식별자이며 승인된 PB/receipt의 SHA와 다른 것이다.
- Git bytes hash와 Windows working bytes hash를 구별한다.
- T의 CI·계보·원문·support9·한정 실행 환경을 확인했다. 기존 Windows 전체 runner
  한계와 별도 실제 착수 지시는 남아 있으며 AC-12/B24 전체 완료를 주장하지 않는다.

## 2. 고정 identity와 후보 이동

| 구분 | 40자 commit SHA |
|---|---|
| PB의 repositoryBasis M | 65b82d5670e086ca77f39050ad48e68f56433f0e |
| 최초 검토 R | 60486e971c94a189ab418c4743f48428a402ea52 |
| 승인된 수정본 R1 | f84036a4c86f7d3f91dcd9592f8137bb5cb16f6b |
| 승인 receipt commit A | 11eac3f29b432ab721fe40ef6acb68918a1758d2 |
| PR #1289 merge F | 38568f0cf8f88a6803bfedb76184232bef7312a6 |
| 최초 후보 T0 | f925263dc6ed76dc89b8a9b048c93702f7a998c7 |
| 이번 재결속 후보 T | 15dd94f7f9e96aa815cca1034f1c1abf24d993a8 |

시작 HEAD=A, branch=codex/memory-eval-vnext-oi-f3-b-approval-package이며 tracked/index는
깨끗했다. 기존 일반 untracked 23개와 별도 ignored 3개 raw hash를 보존했다.
설치 version 불일치 0·필수 누락 0 및 checkout 충돌 부재 확인 후 T를 detached checkout으로
열었다. 기존 브랜치를 이동하거나 reset/stash/강제 checkout하지 않았다.

T0의 CI는 이 작업 중 후속 develop push로 cancelled가 됐다. T0→T는 다른 작업의
mobile-auth 문서 2개와 script/test 2개, 총 4파일이며 support9·lock·승인 원문은 동일했다.
T에서 다시 inventory·계보·hash를 계산하고 실제 working tree로 검사했다.
T0의 결과를 T의 실행 결과로 전사하지 않았다. 후보가 다시 바뀌면 재결속해야 한다.

F는 두 parent를 가진 merge commit이고 R/R1/A의 원 SHA가 T의 조상으로 남아 있다.
F의 첫 parent는 6d9cd3a8f392d24f2818b76d0c6a857954da88f4,
둘째는 a5954e67b26b8bbcd13e9257faf4c34f4b0e5cf1이다.
F 직전 develop의 별도 문서 3개 변화 때문에 F tree와 당시 PR head tree가 다른 사실도
보존한다. F의 실제 첫 parent 대비는 PB 문서/receipt 5파일 추가뿐이다.

## 3. 승인 원문·계보·사람 판정 결속

R1 JSON의 M 기준 sourceFiles 36개와 PB/승인 전사 5개를 합친 **41개 Git blob raw hash가
모두 일치**했다. 이 중 기존 protocol/test/fixture는 6개, 문서는 35개다.
Q가 참조한 상위 source 22개는 원 commit bytes 및 T bytes를 각각 계산하고
각 원 commit이 T의 조상임도 확인했다. 핵심 계보 15개와 전체 행은 JSON에 있다.

| 승인·전사 대상 | T Git raw SHA-256 |
|---|---|
| R1 package Markdown | a2241c6f48dc79d43ebf159494bdeadbf06c0e86de6db05fdcff4f00a77be9a9 |
| R1 package JSON | 3e400844dbdda306b5697f40328e673f7d037a5e84cf2124b1193f301a703399 |
| 승인 요청 초안 | 5d030bc3e9defb2e9a4c565ed4952395f25b95e2c16e39e333b4fed587e1b8a5 |
| 승인 전 record 초안 | b044d0b5fcb9ef29026f10594e0281450a37490320aaa19325dbeb0f2d82f49f |
| authoritative approval receipt | 03286ef63c1cba204254592535d1ab7fa7e2e47665fd0eee215e6e910ba0ad32 |

receipt YAML을 실제 parsing해 decision=yes, approvedBy=mposition, approvedAt=2026-09-08,
PB-D1–PB-D5 전체 승인과 PB-D2/D3 불가분 수용을 대조했다.
원 결정문의 400줄/§13 공란과 원 SHA
355f8387808b8a7ea86e02ecffc4303562b5ab5c43c27fef0c2bdb2bf57e89da를 보존한다.

R/R1 독립 검토 보고서 두 로컬 첨부의 raw hash도 receipt 값과 일치한다.
R1 CONFIRMED는 문서 대응의 확인 검토이며 회차 1/1은 이미 소진됐다.
이 사전 검증을 새로운 Claude 검토·사람 승인·B01–B23 구현 검증으로 표시하지 않는다.
보고서는 로컬 첨부이며 이 두 산출물에 원문을 복사하지 않았다.

receipt의 approvalReceiptCommit=null 등은 작성 당시 사실로 남긴다.
실제 외부 Git identity A는 이 관측에 별도로 결속하며 승인 bytes 안을 채워 쓰지 않는다.
S2 approvalCommit A=3f14afb2…와 이번 receipt commit의 별칭 A를 동일 권한으로 혼동하지 않는다.

## 4. 지원 파일 9개 — 실제 T에 결속

모든 target commit은 T이며 raw SHA는 Buffer로 읽은 실제 bytes에서 계산했다.
working 열은 **T checkout에서 관측한 값**이다. core.autocrlf=true를 바꾸지 않았고,
LF/CRLF 정규화 일치는 보조 대조일 뿐 승인 raw hash를 대체하지 않는다.

| path | T blob OID | T Git raw SHA-256 | T working raw SHA-256 | M 대비 |
|---|---|---|---|---|
| AGENTS.md | 68196927b7cdf5b9722c34899823b7e4dd40947f | dd0d1b6da2bc8d1677b1fec691d6b6341a81c0e0a2170406fd023367e9203fad | f4e48afffa926681e07e93634509d75eb4abbc2fda19b6ab7a83ff57d4387dd1 | 동일 |
| package.json | c8fb5d7fd0bcdcc9aecc16ef15220b8bff64d6ff | c6bf5319a293933f2679fa250760ad9529c30e946e07bed6c18b366f138265d4 | 220d57967f91519186c733a44e9edddc379017daff14536f213613eb07c8a458 | 변경 |
| package-lock.json | eb105b3cca2877a93f3f095430b118339e390b79 | d5b9271e5e5a7d0ab068a6c3bd821c99a4014b3915c09f367826bd348d94691c | fbb286ab621b1333421d4728474867b58956538f80299bfb4a0f4a0585e86266 | 동일 |
| tsconfig.json | a21d63d1f62995aeee3d8885e720f1eb3f23ebc2 | cde6f63f9bcfc446ab223e6fff385b2d586893da2d8469d454c811acb54b3959 | a90dbaf3d7885d0e4d1db827497488e0d905cffc528d65836634b549e4c1a098 | 동일 |
| scripts/run-unit-tests.mjs | 0a51e254e2df67fbdc8595b9a3b5d7deac1e3291 | 9a9b3cee85bc012ea90d1adfc79b03e912cea0a6838c12e048ded5222ad40ac9 | e6af763f362e6a31a838d7e5fc9a7c7d5dbbe42d8bceede1da6c9fba24986e76 | 동일 |
| scripts/check-text-encoding.mjs | 76289e5a0405c8e5f49e12073c68e7daede1f386 | 0decbd8e3298abd77e305b6464b3ce6298b73b97a7ece345cd34d2b6e57d6f4e | 6f43f15a2c30afcfe9050897ca9db53b3f5e443d5d7ebf37fa7d4aa94cc8c473 | 동일 |
| scripts/check-doc-references.mjs | da5398a40e0059bd4082ea7bd2caac0a62b93c5f | acfb8b4a4bff6bc9d5e6b849d7e0b3de6800ad06c1e6b3e2342b9b91ea889d5f | bcae9e4e989506004d57764de2a7f725cc765bd83a64f7e9d95aa25bb1b0a35c | 동일 |
| scripts/check-policy-section-references.mjs | 2d66f9c194bb79d03626db091a9c34d4ffee5a7b | 57a2282e5609c4017f2a6ef1ac53b0394f9d006b8f185f1706b2cb9eaa3d1b50 | 15a73f7cd7f2ed624a129c41be42406243f83e6fa6e19d5a8ca8d6a6cc946d49 | 동일 |
| scripts/check-release-records.mjs | 3ffb806df1d8a6057ea1db80ef692deea8765087 | ab99efc972ab85c02c2897f3e378a2ee19580a196647c1c5e2c61f3bdef16080 | 12466afec65a4f8728ef5972f33459757e365682c065d077fb76b014020d6999 | 동일 |

9개 중 8개는 M과 동일하고 package.json만 다르다. 차이는 이미 develop에 반영된
다른 작업 script 3개 추가다: experiment:ai-review-scoring-policies,
check:mobile-auth-store-entries, score:ai-review-judgements.
기존 script/flags, root dependencies/devDependencies/overrides, package-lock은 동일하다.
이 세 신규 script는 이번 작업에서 실행하지 않았다.

M→T 전체 diff는 34파일이다. 그중 PB 5파일은 승인 기록이고 나머지 29파일은 이미 병합된
AI Review/mobile auth/voice 관련 source·test·운영 문서 변화다.
기존 memory protocol6·승인 원문30개, dataset/register/manifest 및 memory flags에 대한
변경은 없다. 이번 작업이 upstream의 source·기록을 새로 변경한 것이 아니다.

## 5. 설치 상태와 실행 환경

- Node v22.22.2 / V8 12.4.254.21-node.39 / OpenSSL 3.5.5 / win32 x64.
- Node engine 22.x 충족. npm 10.9.7.
- tsx 4.23.13, TypeScript 6.0.3, esbuild/win32-x64 0.28.1, Prisma/Client 7.10.0.
- 실제 physical non-link package 924개: version 불일치 0, 필수 누락 0.
- workspace link 3개: 저장소 내부의 원래 workspace 경로와 version 일치.
  과거 927개 집계와의 차이는 이번에는 이 link 3개를 별도로 센 것이다.
- hidden lock version 불일치 0. 설치 inventory/hidden lock/node 실행파일 digest는 JSON에 기록.
- optional 미설치 175개 중 164개는 OS/CPU 조건 제외, 나머지 11개는 optional WASM 관련 경로.
- 이는 version/package.json inventory이며 설치된 모든 파일의 tarball integrity 재감사는 아니다.

npm ls --all --json --offline는 exit 0, error=null, 필수 missing/invalid 진단 없음이다.
다음 기존 logical-tree label 두 건은 숨기지 않고 보존한다.

| label | 실제/T lock version | 근거 |
|---|---|---|
| extraneous @emnapi/runtime | 1.11.3 | 해당 physical path가 lock에 있으며 optional=true |
| extraneous @img/sharp-wasm32 | 0.35.4 | 해당 physical path가 lock에 있으며 optional=true |

dependency 설치·제거·dedupe·설정 수정은 하지 않았다. npm 진단은 사용자 npm cache에
로그를 남길 수 있으나 dependency를 변경하지 않는다. child process에는 Windows 실행/
사용자/cache/temp 관련 변수만 allowlist로 전달했다. production DB/provider 자격증명을
전달하지 않았고 .env도 읽지 않았다. DOTENV_CONFIG_PATH는 존재하지 않는
H:/Project/ai-chat-hub/.os-f4-absent-env-file이며 생성하지 않았다.
이 환경변수는 해당 child에만 적용했고 저장소·사용자 설정을 바꾸지 않았다.

실제 --conditions=react-server --import tsx 조건에서 기존 공개 G01–G04의 UTF-8 bytes/
길이/raw SHA/LF SHA를 재계산했다. G05 공개 key/signature는 정상 true, signature bit
변경 false, message 변경 false였다. protocol module·C01 helper를 구현/import하거나
새 Proxy/bytes case·keygen/signing·비밀키를 실행한 것이 아니다.
memory 검사 3종은 설치된 tsx로 기존 TypeScript module을 로딩해 통과했다.

## 6. test discovery·flags와 남아 있는 runner 한계

실제 working 목록과 T tracked 목록이 일치한다: server 632개, client 4개.
M의 server 629개보다 다른 작업 test 3개가 늘었다. 목록과 digest는 JSON에 있다.
T01은 server 선택 조건에 포함되고 T11 JSON은 test로 선택되지 않는다.

test:unit은 기존 scripts/run-unit-tests.mjs를 그대로 실행한다. server는
--conditions=react-server --import tsx --test --test-concurrency=1,
spec reporter/stdout을 사용한다. client는 react-server 조건 없이 별도 process이며
server 실패 시 실행되지 않는다. 추가 argv를 단일 파일 filter로 쓰는 runner가 아니다.

tsconfig strict/noEmit/bundler·TS extension/JSON resolution·alias·include/exclude를
원문 bytes에 결속했다. typecheck는 next typegen을 포함하므로 실행하지 않았다.
전체 local unit/build/E2E 및 T01/B01–B23 구현 시험은 수행하지 않았다.

**OI-F4의 기존 Windows full-suite runner 한계는 해결하지 않았다.**
현재 server 파일 경로를 quoted 문자열로 펼친 길이만 39,347자다(M은 39,156자).
이는 정적 길이 관측이며 이번에 ENAMETOOLONG을 재현했다는 주장도, runner가
호환성 검증을 통과했다는 주장도 아니다. discovery/한정 실행 성공으로 full-suite 성공을
대체하지 않는다. runner 수정은 별도 승인 범위이고 B 패키지 5파일에 몰래 포함하지 않는다.

## 7. CI와 로컬 검사

T의 push CI를 정확한 headSha/event/branch에 결속한다.

- [Admin Console E2E 34228297888](https://github.com/mposition/Tomverse/actions/runs/34228297888): success.
  Production build와 실제 Admin Console E2E suite step 모두 성공.
- [Credit Finance DB Integration 34228298090](https://github.com/mposition/Tomverse/actions/runs/34228298090): success.
  accounts/finance/memory/assistant/import/routing/email 7개 실제 scenario step 및
  Require every lane to have passed 최종 집계 성공.

두 run은 completed/success이고 해당 SHA의 check 9개도 전부 completed/success다.
실패 evidence upload처럼 조건상 skipped인 보조 step을 실제 시험 실행 성공과 혼동하지 않는다.
PR CI·과거 merge CI·다른 tip의 성공·사용자가 보고한 배포 완료를 T CI의 대체물로 쓰지 않는다.
F의 두 cancelled CI/credit aggregate failure와 T0의 두 cancelled CI는 JSON에 별도 보존했다.
재실행·dispatch·운영 배포 확인을 하지 않았다.

T tracked-clean 기준선에서 새 기록 작성 전에 package script 그대로 실행했다.

| npm script | exit | 관측 |
|---|---|---|
| check:encoding:strict | 0 | marker 검사 통과 |
| check:policy-section-references | 0 | 4,121 citations / 30 policy documents |
| check:release-records | 0 | 기존 release registry 통과 |
| check:memory-eval-succ9 | 0 | 기존 succ-9 구조 통과 |
| check:memory-extraction-eval | 0 | 14 pairs / 0 approved |
| check:memory-eval-freeze | 0 | 기존 freeze 조건 통과 |
| check:doc-references | 0 | 743 instruction paths / 862 comment paths, 모두 존재 |

이 T 기준선의 실패 이름은 0개다. 과거 OS-F4의 Windows doc-reference 8건 실패는
그 시점 기록으로 보존하며 이번에 고친 것처럼 쓰지 않는다.
audits는 doc-reference/policy 검사의 일반 대상에서 제외되고 release-records는 release-*만
검사하므로, 위 통과가 이 문서 전체의 수동 hash/reference 검증을 뜻하지 않는다.

## 8. 작성 후 검증 및 남은 단계

작성 후 같은 7개 script를 실행해 전부 exit 0이며 작성 전과 출력 SHA도 7/7 동일함을
확인했다. 기준선/사후 실패 이름은 모두 0개이고 새로운 실패는 없다.
fatal UTF-8/JSON parse/끝 LF/BOM·CR·후행 공백 부재, git diff --check 및 신규 파일별
no-index --check도 통과했다. 일반 git diff만으로 untracked를 검사했다고 주장하지 않는다.
원문 41개·지원 9파일의 working bytes·기존 untracked23/ignored3 raw hash는 보존됐다.
CI 결과 전사 후 2026-09-08T13:05:10Z 최종 보존 검사도 통과했다. 같은 7개 script를
다시 실행해 exit 0/출력 SHA 불변을 확인했으며, 설치 inventory와 hidden lock hash도
변하지 않았다. evidence hash·상대 링크 3개·최종 HEAD/branch를 재확인했다.

새 산출물은 이 Markdown과 JSON 두 파일뿐이다. 기존 승인 원문·이전 OS-F4 기록·
검토 프롬프트·.claude/·.codex는 수정하지 않았다. stage/commit/push하지 않는다.

사전 확인과 T CI 완료 후 그 T에서 codex/memory-eval-vnext-oi-f3-b-start-tip-revalidation
검증 브랜치를 만들었다. 새 commit은 없고 HEAD는 T 그대로다.
**그 뒤에도 별도 5파일 구현 착수 지시가 필요하다.**
T나 환경이 바뀌면 바뀐 내용을 다시 결속한다. B24에는 실제 착수 지시 조건이 남으므로
이 기록만으로 AC-12/B24 전체 충족이나 F07 충족을 선언하지 않는다.

OI-F1 timing gap/closure=false, OI-F2 별도 ID/path, OI-F4 별도 runner, ODR-F1 외부 closure
없음 및 상위54 AC partial9/deferred45/fullySatisfied0을 유지한다.
C02 변경, scorer/ledger/full P, dataset/register/flags, holdout/S5, key/trust 운영,
S2 activation, pair/예산/dispatch/provider·DB 호출은 모두 범위 밖이다.
