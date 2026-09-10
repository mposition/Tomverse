# memory-eval vNext — OI-F2 실제 착수 tip 사전 재검증

## 1. 판정과 효력

**PASS_WITH_RETAINED_RESIDUALS — 고정 tip의 한정 착수 사전 재검증 완료. 구현 착수 아님.**

작성자 Codex, 작성일 2026-09-10, Australia/Brisbane.
사용자 지시: “1번 실제 착수 기준 재검증 작업 해주세요”.
관측 구간은 동반 JSON의 각 timestamp로 식별한다. 사람 승인 instant를 새로 만들지 않는다.

- 실제 고정 tip: 89288a8671ef25c30084b71f8a9266a3ae9f5475
- 원격 develop 고정 관측: 2026-09-10T00:14:00.695Z
- 실제 checkout: 2026-09-10T00:15:18.845Z, detached HEAD.
- 기존 승인 branch codex/memory-eval-vnext-oi-f2-id-path-approval와 그 tip b8d96f0f19f51f0bb6296b06dbc986bc6df7e47b는 그대로 보존했다.
- 새 검증/구현 branch·commit/push/PR·CI dispatch는 만들지 않았다.
- 새로 작성한 것은 이 문서와 [관측 evidence JSON](evidence/memory-eval-vnext-oi-f2-start-tip-revalidation-2026-09-10.json) 두 파일뿐이다.

~~~yaml
recordKind: oi_f2_actual_start_tip_revalidation
recordStatus: PASS_WITH_RETAINED_RESIDUALS
repository: mposition/Tomverse
actualStartTip: 89288a8671ef25c30084b71f8a9266a3ae9f5475
approvalTargetCommit: 13a6b088cd88d53d971e66f358e297b8c71c6ad7
reviewedDocumentCommit: 896a8ad756ce2f1a5bf3dff85d238240a8e2f2b8
approvalReceiptCommit: b8d96f0f19f51f0bb6296b06dbc986bc6df7e47b
approvalMergeCommit: 0e41b2d481bfb830eef0189b46b6ae56f40bf625
preStartRevalidationComplete: true
newHumanApproval: false
isAuthoritativeApprovalReceipt: false
implementationStartInstructionReceived: false
implementationStarted: false
newImplementationBranchCreated: false
dependencyInstallationPerformed: false
gitPublicationAuthorized: false
recordCommit: null
independentReviewPerformed: false
oiF2ExternalClosureDeclared: false
fullF07OrFullPDeclared: false
activationAuthorized: false
operationalSigningAuthorized: false
paidExecutionAuthorized: false
~~~

이 판정은 승인 기록 §6의 **로컬 환경·원문·실행 범위·CI 관측 단계**에 한정한다.
새 사람 승인, 독립 검토, IP19 외부 감사 완료 또는 IP01–IP20 구현 충족을 발급하지 않는다.
기존 문서의 pending/null/과거 판정은 바꾸지 않고, 현재 권한은 별도
[OI-F2 승인 receipt](memory-eval-vnext-oi-f2-id-path-approval-2026-09-09.md)에서 읽는다.

JSON.document.rawSha256은 이 Markdown의 최종 raw bytes를 결속한다.
JSON 자체/기존 승인 문서의 hash와 혼동하지 않는다. 이 문서에는 JSON hash나 자기 hash를 넣지 않는다.
최종 두 파일의 raw SHA와 이후 실제 record commit은 별도 전달에서 고정한다.

## 2. 고정 기준과 checkout의 구분

승인 문서 basis는 17b074c600e98e8fe52175ea0cbc6c5860b0c742이며 이번 actualStartTip과 다르다.
PR #1307의 merge는 0e41b2d481bfb830eef0189b46b6ae56f40bf625이고, 그 parent는
0e3144112ec0f4c3e3143edf6422ebb8c13eb717 및 082bb2fdc13867e484e6d3888caac41cc2ad17f1이다.
현재 고정 tip의 parent는 0e41b2d481bfb830eef0189b46b6ae56f40bf625 및 1ceb029316f2a329fe660607d8ccf9b1cf2c4d9e이다.
승인 R/R1/R2/receipt 원 SHA가 merge와 actualStartTip의 조상인 것을 확인했다.

시작 checkout은 승인 receipt commit이었으며 tracked/index clean, 기존 untracked 30항목,
stash 17개였다. 대상 tree의 tracked 경로와 untracked 파일/디렉터리 충돌이 없음을 확인한 뒤
git switch --detach로 고정 tip을 checkout했다. 기존 branch ref는 이동하지 않았다.
그 checkout에 포함된 upstream 변경과 이번 작성자의 변경을 구별한다.

보존 대상 60개 중 checkout으로 달라진 파일은 package.json,
scripts/check-policy-section-references.mjs, prisma/schema.prisma 세 개다.
이는 이미 develop에 있던 변경이며 작성자가 수정한 것이 아니다.
나머지 보존 파일과 untracked 일반 파일은 원 raw hash 그대로다.
전체 basis/receipt/merge→actualStartTip 경로 diff는 JSON에 별도로 보존했다.
관련 source45와 OI-F2 승인 4파일은 고정 tip에서 승인 결속값과 동일하다.

원격 ref가 이후 움직여도 이 문서의 tip은 자동 변경되지 않는다.
다른 tip이나 바뀐 설치 환경에 이 관측을 그대로 적용하지 않는다.

2026-09-10T00:30:12.986Z 관측에서 원격 develop은 543e74898c1618f9366a0e28b482e8efff7d0c14로 전진했다.
고정 tip의 후손(6 commits ahead)이며 관련 없는 AI Review/router/mobile-auth 10파일 변경이다.
지원9·source45·OI-F2 승인 4파일은 그 diff에 없다. 전체 경로 목록은 JSON.remoteAdvance에 있다.
새 tip을 checkout하거나 그 로컬 실행·CI까지 검증하지 않았다. 이번 actualStartTip은 계속
89288a8671ef25c30084b71f8a9266a3ae9f5475이며 후속 지시에서 다른 tip을 선택하면 별도 재결속이 필요하다.

## 3. 승인 원문·계보·기존 fixture

승인 대상과 검토 대상을 분리한다.

| 역할 | 실제 commit |
|---|---|
| 최초 패키지 R | 1979839dc200687336db3d72526e9a76c860be71 |
| 확인 검토 대상 R1 | 896a8ad756ce2f1a5bf3dff85d238240a8e2f2b8 |
| 한 줄 정정·승인 대상 R2 | 13a6b088cd88d53d971e66f358e297b8c71c6ad7 |
| authoritative 승인 receipt | b8d96f0f19f51f0bb6296b06dbc986bc6df7e47b |

| 문서 | raw SHA-256 |
|---|---|
| [R2 Markdown](memory-eval-vnext-oi-f2-id-path-approval-package-draft-2026-09-09.md) | 14e0b11f71991c30e4bde14a0b502b1b1cce678a095fbd957e4b62e3ffbce2d0 |
| [R2 JSON](evidence/memory-eval-vnext-oi-f2-id-path-approval-package-2026-09-09.json) | 12a2b3fb145b2807529450dda8c091d78d4a47bfb80814f368185aecb1cf6ab0 |
| [승인 전 요청 초안](memory-eval-vnext-oi-f2-id-path-approval-request-draft-2026-09-09.md) | 03f6b934078157473c153ec28fc48c5dc17548427220e092db93de5ab391a612 |
| [최종 receipt](memory-eval-vnext-oi-f2-id-path-approval-2026-09-09.md) | 9f505ed184a487db2f03f9799fa4ab3f8466c8fdba4fde7ce5888b82d7c40f9a |

위 4파일은 actualStartTip의 Git blob과 실제 working raw bytes가 모두 표와 같다.
기존 source45도 승인 JSON.sourceBindings의 raw Git SHA와 45/45 일치하고,
working raw bytes도 승인 패키지 작성 당시 관측값과 45/45 동일하다.
핵심 계보 23개 commit은 actualStartTip의 조상이다. 목록과 parents는 JSON에 있다.

receipt를 읽어 decision=yes, approvedBy=mposition, approvedAt=2026-09-09,
IP-D1–IP-D5 전체 수용과 별도 착수 조건을 확인했다.
이는 2026-09-09 사람 승인을 관측한 것이지 2026-09-10 새 승인을 만든 것이 아니다.
R1 원 판정 CHANGES_REQUIRED, R2 추가 독립 확인 없음, 확인 회차 1/1 사용을 보존한다.
승인 target R2를 reviewedDocumentCommit으로 바꾸지 않는다.

원 decision SHA는 355f8387808b8a7ea86e02ecffc4303562b5ab5c43c27fef0c2bdb2bf57e89da,
400 LF/§13 공란을 보존한다. S2 approvalCommit=3f14afb29eddc243640fdb0a5a4f604646ade9f0,
contractApprovalCommit=80842e62925c05af9450e6acc6ceb70b56f67655를 이 기록으로 치환하지 않는다.

| fixture 관측 | 값 |
|---|---|
| T11 raw SHA-256 | 136469c95aeeeacdeb0069e457476a273036e5d73964f336f2fbc6f6d4dcc70f |
| original14 projection | 1d286a257c44d3444de99b945a8276cd680b8b30adc41bf0fc5df32a5f4123ca |
| original15 projection | e59c8ef30d4dae1430e113392d63924e9d2a77cd764edd8297e59ed2d987e652 |
| top-level key | 15개, idPathPolicy 없음 |

projection은 JSON.parse insertion order를 유지해 지정 key만 제외한 뒤
JSON.stringify(no replacer/no space)의 UTF-8/끝 LF 없음 bytes를 hash한다.
현재 original14는 proxySafety만 제외하고 original15는 idPathPolicy만 제외한다.
미래 B19/IP15 구현이나 fixture key 추가를 이번에 실행하지 않았다.

## 4. 지원 파일 9개 — Git와 working bytes의 별도 결속

각 raw SHA는 실제 bytes를 그대로 hash했다. 개행 정규화는 **비교 진단에만** 사용했다.
원문/working file을 바꾸거나 정규화한 것은 아니다.

| path | actualStartTip Git raw SHA-256 | working raw SHA-256 | 승인 basis 대비 |
|---|---|---|---|
| AGENTS.md | dd0d1b6da2bc8d1677b1fec691d6b6341a81c0e0a2170406fd023367e9203fad | f4e48afffa926681e07e93634509d75eb4abbc2fda19b6ab7a83ff57d4387dd1 | Git 불변 |
| package.json | 32ae2fb24678fe1a5d9a687e24e44d251e0df6d471b59ee30de246a9fb703615 | 32ae2fb24678fe1a5d9a687e24e44d251e0df6d471b59ee30de246a9fb703615 | upstream 변경 |
| package-lock.json | 61d643fcfa748f9e8edd276b6cfb3c4f52e08ec5390ab57cc85f9ce0a256ca18 | e6fa61514e418ee7c1064c84a2514dd695b078f4a41f33ca66e798943a4c3843 | Git 불변 |
| tsconfig.json | cde6f63f9bcfc446ab223e6fff385b2d586893da2d8469d454c811acb54b3959 | a90dbaf3d7885d0e4d1db827497488e0d905cffc528d65836634b549e4c1a098 | Git 불변 |
| scripts/run-unit-tests.mjs | 9a9b3cee85bc012ea90d1adfc79b03e912cea0a6838c12e048ded5222ad40ac9 | e6af763f362e6a31a838d7e5fc9a7c7d5dbbe42d8bceede1da6c9fba24986e76 | Git 불변 |
| scripts/check-text-encoding.mjs | 0decbd8e3298abd77e305b6464b3ce6298b73b97a7ece345cd34d2b6e57d6f4e | 6f43f15a2c30afcfe9050897ca9db53b3f5e443d5d7ebf37fa7d4aa94cc8c473 | Git 불변 |
| scripts/check-doc-references.mjs | acfb8b4a4bff6bc9d5e6b849d7e0b3de6800ad06c1e6b3e2342b9b91ea889d5f | bcae9e4e989506004d57764de2a7f725cc765bd83a64f7e9d95aa25bb1b0a35c | Git 불변 |
| scripts/check-policy-section-references.mjs | 6e75e68266963721eceaf1b41ee997fff6286aa588efb35860af8fb8025a6358 | 6e75e68266963721eceaf1b41ee997fff6286aa588efb35860af8fb8025a6358 | upstream 변경 |
| scripts/check-release-records.mjs | ab99efc972ab85c02c2897f3e378a2ee19580a196647c1c5e2c61f3bdef16080 | 12466afec65a4f8728ef5972f33459757e365682c065d077fb76b014020d6999 | Git 불변 |

Git/working raw hash가 다른 7파일은 CRLF→LF 비교 결과가 Git bytes와 정확히 같다.
기존 core.autocrlf=false 환경에서 보존된 working CRLF를 Git raw SHA로 대신하지 않는다.
현재 clean-filter hash-object 결과가 같다는 주장도 하지 않는다. raw와 비교용 hash를 JSON에 모두 분리했다.
tracked/index clean 결과만으로 bytes 일치를 추정하지 않았다.

승인 basis→현재 package.json은 관련 없는 script 네 개 추가뿐이며 기존 script/flags와
모든 non-script field(dependency/workspace 등)는 동일하다. package-lock.json Git bytes도 동일하다.

- experiment:ai-review-judged-gate-transition
- experiment:ai-review-judged-metric-definitions
- experiment:ai-review-003-revision
- judge:mobile-auth-binding-round

정책 참조 검사기는 docs/ops/cross-review/packages/의 과거 교차검토 이력을 제외하도록
기존 develop에서 바뀌었다. 원래도 .github/audits/는 이 검사 대상 밖이다.
따라서 이 신규 감사 기록은 일반 검사 통과와 별도로 인코딩·hash·JSON·상대 링크·범위 검증을 한다.
지원 파일의 이번 차이는 M3 범위/실행 flags/dependency 변경을 요구하지 않는다.

## 5. 설치 환경 — 재설치 없이 일치

실행 위치: 로컬 PC PowerShell, H:/Project/ai-chat-hub, 실제 고정 tip checkout.
기존 Node/npm과 설치본을 사용했다. production 자격증명은 전달하지 않았다.
OS/PATH/TEMP/user-cache 계열 변수만 child에 allowlist로 전달하고 부재 확인한
.os-f4-absent-env-file을 DOTENV_CONFIG_PATH로 지정했다.
DOTENV_CONFIG_QUIET=true/NEXT_TELEMETRY_DISABLED=1도 child에만 적용했다.
원 셸 환경·.env 내용·npm/Git 설정을 바꾸지 않았다.

| 항목 | 결과 |
|---|---|
| Node / npm | v22.22.2 / 10.9.7 |
| V8 / OpenSSL | 12.4.254.21-node.39 / 3.5.5 |
| OS / CPU | win32 / x64 |
| tsx / TypeScript | 4.23.13 / 6.0.3 |
| js-yaml lock / installed / hidden lock | 4.3.2 / 4.3.2 / 4.3.2 |
| 설치 version 불일치 / hidden-lock 불일치 / 필수 누락 | 0 / 0 / 0 |
| npm ls --all --json --offline | exit 0, root error=null |
| manifest↔lock root dependency/workspace 선언 | 일치 |
| node_modules metadata / workspace directory / link | 924 / 3 / 3 |
| optional 미설치 | 175개: OS/CPU 제외 164, 그 외 11 |

924행 설치 inventory SHA-256:
da51cfba9083e21086a94af80ee00e3278c228e1b3775b1f4972f15b43ea181a

target lock insertion order에서 node_modules/ non-link·존재 package.json을 선택하고
path/expectedVersion/actualVersion/packageJsonSha256/optional 순서 객체를 hash한다.
optional은 Boolean(lock.optional)이며 devOptional을 OR하지 않는다.
JSON.stringify(rows)의 UTF-8/BOM 없음/끝 LF 없음 산식이다.
workspace directory 3개를 더한 non-root/non-link 존재 항목은 927개다.
workspace link 3개는 존재와 실제 연결 경로를 별도로 확인하고 중복 package로 세지 않는다.

hidden lock raw SHA-256:
9cd03955eef3d97bfd1457069b27f46ec7493828591cc5487602f21f09955dd6

npm ls의 extraneous label 두 개는 기존 @emnapi/runtime 1.11.3과
@img/sharp-wasm32 0.35.4다. 각각 target lock의 정확한 physical path/version/optional=true에
다시 결속했고 새 missing/invalid로 보지 않았다. 전체 npm ls 출력 hash는 실행 관측이지
결정적인 설치 fingerprint가 아니다. 924행 metadata inventory를 별도로 사용한다.

현재 설치가 lock에 맞으므로 npm ci/install/dedupe·수동 node_modules 수정은 하지 않았다.
이것은 package metadata/version/dependency graph의 한정 검사이며 모든 설치 파일/tarball
integrity 감사, generated Prisma Client/schema 정합·앱 전체 readiness/DB 검증은 아니다.
Prisma 관련 표기는 package version 관측뿐이며 generate/migration/seed/DB 연결은 하지 않았다.

## 6. 공개 reference probe와 runner 범위

실제 Node에서 --conditions=react-server --import tsx 조건으로 기존 G01–G04의
UTF-8 길이/hex/raw SHA/LF SHA를 다시 계산해 모두 일치했다.
G05 공개 Ed25519 vector는 정상 검증 true, signature bit 변경 false, message 변경 false였다.

probe는 [기존 환경 수정 증거](evidence/memory-eval-vnext-oi-f3-b-environment-repair-2026-09-09.json)의
검토 가능한 reference script를 사용했다. script와 명령·출력 SHA를 이번 JSON에 다시 보존했다.
protocol module import, private key, keygen/signing, 새 Proxy/bytes case 또는 새 IP 시험이 아니다.
공개 reference arithmetic/verify 통과를 C02 구현 정확성으로 확장하지 않는다.

현재 runner의 Git/working test discovery는 server 641개 / client 4개로 일치했다.
서버 목록 SHA는 897f18950e82e55bc5ef7e237b9da695e744f9e4892d7fdadb0289a9394582ce,
클라이언트 목록 SHA는 88e7df406f7efb10b2784770fbfda4252555818e796137d3ec9a99bc76d8dd40이다.
정렬된 repository-relative / 경로를 LF로 잇고 끝 LF를 붙여 hash한다.
T01은 server discovery에 포함되고 T11은 fixture이므로 직접 test 목록에는 없다.

package script test:unit은 node scripts/run-unit-tests.mjs다. 서버 flags는 다음과 같다.

- --conditions=react-server
- --import tsx
- --test
- --test-concurrency=1
- --test-reporter=spec
- --test-reporter-destination=stdout

client process에는 react-server condition이 없고 server 실패는 client 실행을 막는다.
단일 파일 filter를 지원하지 않는다. tsconfig는 JSONC로 해석했고 내용은 JSON에 결속했다.
quoted absolute server 경로 문자열은 39947자다.
OI-F4의 Windows full-suite runner 한계는 남으며 runner를 수정하거나 새로운 gate를 추가하지 않았다.
이번에 full unit/T01/B19·신규 IP01–IP20·lint/typecheck/build/E2E를 로컬에서 실행하지 않았다.
실제 구현 지시 뒤의 변경 전 기준선/구현 후 시험/외부 감사와 이번 환경 재검증은 별개다.

## 7. 고정 tip의 실제 원격 CI

2026-09-10T00:21:34.146Z에 headSha=89288a8671ef25c30084b71f8a9266a3ae9f5475, event=push, branch=develop,
attempt=1인 두 workflow를 재조회했다.

- [Admin Console E2E 34355875482](https://github.com/mposition/Tomverse/actions/runs/34355875482):
  completed/success. 실제 Production build와 Run the Admin Console E2E suite step success.
- [Credit Finance DB Integration 34355875448](https://github.com/mposition/Tomverse/actions/runs/34355875448):
  completed/success. finance/assistant/import/memory/routing/email/accounts 7개 실제 DB lane과 집계 success.

check 9개 모두 success다. 실패 전용 upload/report 등 skipped step을 시험 실행으로 세지 않는다.
다른 SHA/과거 CI를 이 tip의 증거로 대체하지 않았다. CI rerun/dispatch는 수행하지 않았다.
원격 CI 성공은 로컬 full-suite 통과나 운영 배포·activation 검증을 뜻하지 않는다.

## 8. 기록 작성 전 검사

실제 고정 tip에서 package.json에 있는 npm script 7개를 그대로 실행했다.
출력 hash는 stdout raw bytes 뒤 stderr raw bytes를 연결한 SHA-256이다.

| npm run script | 작성 전 exit | 출력 SHA-256 |
|---|---|---|
| check:encoding:strict | 0 | 7d5195263cb38b5aa0de4bf8e0ead06774933b4e124616518883574554bcd380 |
| check:policy-section-references | 0 | bc9a33ead4deb5a419249fddec5a8f681136d645dbfc2cab1967995cae12059a |
| check:release-records | 0 | 5d216eabba9f6eb6762717a31e2bc3c26172d530ed554ab099a9c21a537f3565 |
| check:memory-eval-succ9 | 0 | f792af65d17e277fecceedf03b5eaba6484180748d3013de077a027a005e194c |
| check:memory-extraction-eval | 0 | 575a56bac68f5e261286b5e00894451bd0fb1b7b5cead22e49d8d8f28315629b |
| check:memory-eval-freeze | 0 | 8318af98d6c2a2ce9ca9f2d7c0d9b4acc70cc97ee7555b8dc026a4fb5b10cca1 |
| check:doc-references | 0 | 759ff0df13085b5dacc5cbc02d5cae951c29a1526c04eb711fe9571f1e967322 |

작성 전 tracked/index clean이며 기준선 실패 이름은 0개다.
기존 policy reference notice와 v4/v6 예산 승인 대기를 실패로 바꾸거나 면제하지 않는다.
과거 승인 basis와 doc-references 출력이 다른 것은 새 tip의 파일 집합 차이다.
새 실패 여부는 이번 같은 tip의 작성 전/후 이름별 결과로 대조한다.

일반 reference 검사가 신규 audits 전체를 덮는다고 주장하지 않는다.
신규 두 파일은 strict UTF-8/BOM/CR/EOF/후행 공백, JSON parse·Markdown hash,
상대 링크, 승인/검토/착수 구분, exact source/support/projection/계보 결속을 직접 검사한다.
기존 보호60개 working bytes·untracked30개·hidden lock·Git config·stash 보존도 대조한다.
새 untracked 파일은 일반/staged diff만으로 검증하지 않고 각각 no-index --check로 검사한다.

작성 보조 진단에서는 출력 수집 한도, Windows path separator 분류, 기존 CRLF와 Git raw의
비교 방식, 주석 있는 tsconfig의 JSONC 처리를 보완한 뒤 다시 계산했다.
이는 package script 실패나 source/설치 변경이 아니며 잘못된 중간 진단을 환경 실패로 기록하지 않는다.
저장소 파일·runner를 고쳐 검사에 맞춘 것이 아니다.

### 8.1 작성 후 실제 관측

2026-09-10T00:28:09.500Z–2026-09-10T00:28:13.862Z에 같은 고정 tip에서
동일한 npm script 7개를 재실행했다. 전부 exit 0이며 이름별 stdout+stderr SHA도 작성 전과
7/7 일치했다. 기준선/작성 후/신규 package script 실패 이름은 모두 0개다.
문서와 JSON의 최종 결속·인코딩·링크·보존 검사는 결과 전사 뒤에도 별도로 다시 수행한다.
새 파일 두 개 외의 tracked/index 변경, 설치·fixture·운영 변경은 허용하지 않는다.

2026-09-10T00:32:25.578Z 직접 검사에서 두 신규 파일의 strict UTF-8/no BOM/CR0/EOF LF 한 개/
후행 공백 없음, JSON parse와 Markdown raw SHA 결속, 상대 링크 7회/고유 6개를 확인했다.
source45/approval4/계보23 및 보호60개 working bytes가 유지됐고 설치 metadata 924개·workspace
directory 3개·link 3개와 hidden lock, Git config/core.autocrlf, stash 17개도 보존됐다.
.env 두 파일은 내용 없이 size/mtime만 대조했다. untracked는 기존30 + 새 기록2 = 32개다.
tracked/index clean이며 원래 승인 branch ref도 그대로다.
일반/staged diff --check는 exit 0, 새 파일 각각 no-index --check는 exit 1/빈 stdout·stderr였다.
이는 NUL과 비어 있지 않은 새 파일의 차이이며 whitespace 실패를 면제한 것이 아니다.
이 관측은 결과 문단을 덧붙이기 전 snapshot이며 자기 hash가 아니다.
결과 전사 뒤에도 두 파일의 최종 결속과 같은 보존 검사를 다시 수행한다.

## 9. 잔여·보존·다음 단계

quality-documentation-manager의 원문 보존·변경 이력·승인과 효력 구분을 적용했다.
의료 QMS 인증, 암호학적 승인 서명 또는 독립 검토 판정을 만든 것은 아니다.

- OI-F1 timing gap accepted residual/closure=false, ODR-F1 외부 closure 없음.
- OI-F2 정책은 기존 receipt로 승인됐지만 구현 충족·외부 closure는 아직 별개다.
- R1 CHANGES_REQUIRED와 R2 추가 독립 확인 없음, 확인 검토 1/1 사용을 보존한다.
- OI-F4 runner 별도 범위, BI/BFR 수용 한계·m3/m6 생존·영구 정적 강제 부재를 유지한다.
- 상위54 AC partial9/deferred45/full0, HD-1–HD-8/OP 7개, D<K<activationApprovalCommit<C는 그대로다.
- path의 C1/format scalar·NFC Unicode/space 허용 잔여와 OS path 안전성/운영 corpus 미조사를 유지한다.
- 일반 JavaScript sandbox·full F07/full P·S2 activation·운영 readiness 완료를 선언하지 않는다.

후속 구현은 **확인된 tip에서 새 codex/ 구현 branch와 별도 명시적 착수 지시 뒤에만** 가능하다.
미래 M3는 C02 lib/memoryEvalVnext/protocol/wire.ts,
T01 tests/memoryEvalVnextWire.test.mjs,
T11 tests/fixtures/memory-eval-vnext/wire-vectors.json의 승인된 범위뿐이다.
실제 구현 시 변경 전 기준선과 IP01–IP15 unit/IP16–IP20 external을 구분해야 한다.
이번 기록을 그 시험/외부 감사의 실행 통과로 재사용하지 않는다.

이번에는 scorer/ledger/full P/resolver/controller/custodian/importer·등록 parser/trust digest,
운영 key/signature/genesis/root/journal/checkpoint/backup/attestation,
dataset/manifest/register·S2 purpose/activation·holdout 작성/seal/open·S5/v9 prompt·pair,
예산/dispatch/provider·DB/Railway/production/배포·release gate·두 memory flag에 쓰지 않았다.
