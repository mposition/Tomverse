# memory-eval vNext — OI-F4 실제 착수 tip 재검증

## 1. 결과와 효력

**PASS_WITH_RETAINED_RESIDUALS — 고정 tip의 사전 재검증 완료. 구현·전체 unit PASS·OI-F4 closure 아님.**

작성자 Codex, 작성일 2026-09-10, Australia/Brisbane.
사용자 지시: “배포 및 CI 완료 되었습니다. 확인후 OI-F4 실제 착수 기준 재검증으로 넘어가주세요. 권장 순서로대로 자동으로 작업해주세요.”
관측 시각은 동반 JSON의 각 구획에 UTC로 기록한다. 사람 승인 시각을 발명하지 않는다.

이번에는 병합/CI/배포 확인 → 고정 tip checkout/새 branch → 지원 파일·설치·계보·기준선
재검증 → 이 문서와 [관측 JSON](evidence/memory-eval-vnext-oi-f4-start-tip-revalidation-2026-09-10.json)
작성까지 진행했다. runner 구현이나 새 승인 receipt 작성은 하지 않았다.

~~~yaml
recordKind: oi_f4_actual_start_tip_revalidation
recordStatus: PASS_WITH_RETAINED_RESIDUALS
repository: mposition/Tomverse
actualStartTip: aafdceca3e4270ff146077c02f480ba3fd68c9f4
approvalPackageBasis: 7bce6df0e2ff55d50d24e23c172aa831b09e7c15
approvalTargetCommit: 52beb7de9c1cb949677c5db306ffd6425a89ea46
initialReviewCommit: 3fb5ac9554ecbe8c3c52a7da0f9bf1739030e7a9
revisionIndependentReviewCommit: null
approvalReceiptCommit: 2a8609feeb4ea19c3793e6b968601b060432fa67
approvalMergeCommit: aafdceca3e4270ff146077c02f480ba3fd68c9f4
branch: codex/memory-eval-vnext-oi-f4-start-tip-revalidation
preStartRevalidationComplete: true
isAuthoritativeApprovalReceipt: false
newHumanApproval: false
independentReviewPerformed: false
implementationStarted: false
separateImplementationStartInstructionRequired: true
dependencyInstallationPerformed: false
fullUnitSuitePassed: false
oiF4ClosureDeclared: false
activationAuthorized: false
paidExecutionAuthorized: false
recordCommit: null
~~~

JSON.document.rawSha256은 **이 Markdown**에만 일방향 결속한다.
JSON 자기 hash나 미래 commit을 넣지 않는다. 승인 문서 hash와 이 관측 문서 hash를 혼용하지 않는다.
이번 판정은 작성자의 한정 사전 점검 결과이지 외부 검토 verdict 또는 구현 결과 인수가 아니다.

## 2. 원 SHA를 보존한 병합과 실제 기준 T

[PR #1323](https://github.com/mposition/Tomverse/pull/1323)은 2026-09-10T07:58:27Z에 develop으로 병합됐다.
고정 T는 aafdceca3e4270ff146077c02f480ba3fd68c9f4이며 두 parent는 다음과 같다.

- 04e18713494d154163f84fdf42f4564c58232268
- 2ce7b59606c582169fa3de07528d93598a259923 — PR head, 승인 계보를 포함한 sync commit

WR-1과 승인 receipt AWR의 원 SHA는 T의 조상이다. squash/rebase로 대체되지 않았다.
AWR → sync commit의 Git 이력은 유지하며 이 재검증에서 병합·rebase·amend·push하지 않았다.
승인 패키지의 과거 basis B를 T로 소급 변경하지 않는다.

시작 checkout은 sync commit 2ce7b59606c582169fa3de07528d93598a259923의 기존 승인 branch였다.
tracked/index clean, 기존 untracked 36항목, 보호 파일 65개를 관측했다.
T tree와 기존 untracked의 충돌 0건 및 branch 이름 부재를 확인한 뒤
2026-09-10T08:22:08Z 이후 T에서 위 새 codex/ branch를 만들었다.
기존 승인 branch ref는 이동하지 않았다. 이 branch는 재검증용이며 구현 시작을 뜻하지 않는다.

sync checkout → T의 upstream 차이는 model lifecycle/catalog 관련 8파일이다.
지원9·직접 binding24·보호65·WR 승인4에는 그 8파일이 없다.
B → T의 전체 경로 차이와 이 checkout 차이는 JSON.identity에 보존한다.
upstream 변경을 이 작업의 코드 변경으로 보고하지 않는다.

처음 확인한 T를 고정한 뒤 origin/develop은
b880bc4ee815500797b796001aa4ebb4e7488d03으로 전진했다.
2026-09-10T08:22:08.160Z의 T 대비 차이는 무관한
.github/audits/ai-review-003-necessity-recommendation-2026-09-10.md 한 파일뿐이다.
이 후속 tip을 checkout하거나 그 CI/배포를 T의 증거로 대용하지 않았다.
원격의 이후 이동은 T를 자동 변경하지 않는다. 다른 tip에서 구현한다면 변경분을 다시 확인해야 한다.

## 3. 승인 원문·계보·역할 구분

[authoritative WR-1 승인 receipt](memory-eval-vnext-oi-f4-runner-approval-2026-09-10.md)를 읽고
decision=yes, approvedBy=mposition, approvedAt=2026-09-10,
WR-D1–WR-D5 전체 수용과 별도 착수 조건을 확인했다.

| 파일 | T의 Git blob OID | Git/working 동일 raw SHA-256 |
|---|---|---|
| .github/audits/memory-eval-vnext-oi-f4-runner-approval-package-draft-2026-09-10.md | ca875ee93ea668c26eed997eb0fc1bb5ca27ef97 | 420f8876d9e6e472345ff5a953ea446db16a862b48b28242fa460de14ac80381 |
| .github/audits/evidence/memory-eval-vnext-oi-f4-runner-approval-package-2026-09-10.json | fb5f6ccd8b10c842a2626790ae5ed95a0aeeda2b | ccc42634c68571878572eb24c4b6b6890fd334712f3c88050eb318ba2fc5ece5 |
| .github/audits/memory-eval-vnext-oi-f4-runner-approval-request-draft-2026-09-10.md | a7f4a1f836f15a1cb0f9355cc2718461b8b224de | 37b17d9f0a3dea1450a3f16cc38ed7ab5bb05cd06770b854fbf830cd7b3a7220 |
| .github/audits/memory-eval-vnext-oi-f4-runner-approval-2026-09-10.md | 313c3cbd9b2dfce4e445e5b2eff08dddee35f7c9 | c1c919a8cc1b08ebd75ca581283f4af2dd0b66e9d7a16e6759bee683339adc3f |

최초 검토는 R=3fb5ac9554ecbe8c3c52a7da0f9bf1739030e7a9에 대한
PASS_WITH_WARNINGS, 차단 0건, P3 WR-F1 한 건이다.
승인 대상 WR-1=52beb7de9c1cb949677c5db306ffd6425a89ea46은 추가 독립 검토 **미실시**이며,
사람이 WR-F1 작성자 보완과 그 한계를 함께 수용했다. 최초 1회/확인 0회를 유지한다.
이번 관측을 WR-1의 CONFIRMED 또는 외부 finding closure로 쓰지 않는다.

상위9 및 B/R/WR-1/AWR/sync 총 14개 SHA를 git merge-base --is-ancestor로 T에 대해 재검증했고
모두 exit0이다. 목록·parents는 JSON.facts.ancestry에 있다.
S2의 decision approvalCommit A=3f14afb29eddc243640fdb0a5a4f604646ade9f0,
S1–S4 contractApprovalCommit CA=80842e62925c05af9450e6acc6ceb70b56f67655를
AWR 또는 이번 기록으로 치환하지 않는다.

원 decision은 T의 Git blob raw SHA
355f8387808b8a7ea86e02ecffc4303562b5ab5c43c27fef0c2bdb2bf57e89da,
400 LF, §13 공란 그대로다. 기존 working copy는 CRLF이며 raw SHA
f10c6effd8556b7c51781216e9ad450b2b3badc5421c522e82e581f965646b60이다.
CRLF→LF의 **메모리 내 비교**만 Git bytes와 같다. working hash를 승인 SHA라 부르거나 파일을 정규화하지 않았다.

## 4. 지원9와 변경 영향

| path | T Git raw SHA-256 | working raw SHA-256 |
|---|---|---|
| AGENTS.md | dd0d1b6da2bc8d1677b1fec691d6b6341a81c0e0a2170406fd023367e9203fad | f4e48afffa926681e07e93634509d75eb4abbc2fda19b6ab7a83ff57d4387dd1 |
| package.json | 8987ee5e84717813b146099d26957c906b7ab161b8a07fa0a26ebe887fc838c4 | 8987ee5e84717813b146099d26957c906b7ab161b8a07fa0a26ebe887fc838c4 |
| package-lock.json | 61d643fcfa748f9e8edd276b6cfb3c4f52e08ec5390ab57cc85f9ce0a256ca18 | e6fa61514e418ee7c1064c84a2514dd695b078f4a41f33ca66e798943a4c3843 |
| tsconfig.json | cde6f63f9bcfc446ab223e6fff385b2d586893da2d8469d454c811acb54b3959 | a90dbaf3d7885d0e4d1db827497488e0d905cffc528d65836634b549e4c1a098 |
| scripts/run-unit-tests.mjs | 9a9b3cee85bc012ea90d1adfc79b03e912cea0a6838c12e048ded5222ad40ac9 | e6af763f362e6a31a838d7e5fc9a7c7d5dbbe42d8bceede1da6c9fba24986e76 |
| scripts/check-text-encoding.mjs | 0decbd8e3298abd77e305b6464b3ce6298b73b97a7ece345cd34d2b6e57d6f4e | 6f43f15a2c30afcfe9050897ca9db53b3f5e443d5d7ebf37fa7d4aa94cc8c473 |
| scripts/check-doc-references.mjs | acfb8b4a4bff6bc9d5e6b849d7e0b3de6800ad06c1e6b3e2342b9b91ea889d5f | bcae9e4e989506004d57764de2a7f725cc765bd83a64f7e9d95aa25bb1b0a35c |
| scripts/check-policy-section-references.mjs | 6e75e68266963721eceaf1b41ee997fff6286aa588efb35860af8fb8025a6358 | 6e75e68266963721eceaf1b41ee997fff6286aa588efb35860af8fb8025a6358 |
| scripts/check-release-records.mjs | ab99efc972ab85c02c2897f3e378a2ee19580a196647c1c5e2c61f3bdef16080 | 12466afec65a4f8728ef5972f33459757e365682c065d077fb76b014020d6999 |

서로 다른 7파일은 기존 CRLF/LF 차이만이며 실제 bytes를 수정하지 않았다.
B 대비 지원9의 유일한 Git 변경은 package.json의 다음 script 추가 두 건이다.

- benchmark:router:collect
- test:router-development-collector

기존 모든 script 본문과 non-script field, dependency/workspace 선언은 그대로다.
package-lock·tsx/Node 실행 조건·test:unit·runner·tsconfig는 불변이다.
직접 binding24 중 나머지23, 보호65 중 나머지64도 B의 관측과 일치한다.
이번 시작 snapshot 대비 보호65는 **65/65 동일**하다.
따라서 새 script는 승인된 Windows 분할 상한·실행 의미를 바꾸지 않으며 runner 범위를 넓힐 이유가 없다.
이 판정은 새 script 기능 전체의 감사가 아니다.

## 5. 실행 환경 — 설치 변경 없이 일치

로컬 PC의 PowerShell, H:/Project/ai-chat-hub, T의 기존 설치에서 점검했다.
로컬 검사는 production 자격증명 없이 수행했다. OS/PATH/TEMP/user-cache allowlist와
부재 확인한 .os-f4-absent-env-file의 DOTENV_CONFIG_PATH,
DOTENV_CONFIG_QUIET=true/NEXT_TELEMETRY_DISABLED=1은 시험 child에만 전달했다.
부모 환경·.env·설치·lock은 수정하지 않았다. npm ls는 같은 OS/cache allowlist에서
--all --json --offline으로 실행했고 .env를 읽지 않았다.

| 항목 | 실제 관측 |
|---|---|
| Node / npm / OS / CPU | v22.22.2 / 10.9.7 / win32 / x64 |
| libuv / V8 / OpenSSL | 1.51.0 / 12.4.254.21-node.39 / 3.5.5 |
| tsx / TypeScript | 4.23.13 / 6.0.3 |
| js-yaml lock / installed / hidden lock | 4.3.2 / 4.3.2 / 4.3.2 |
| 필수 누락 / 설치 version 불일치 / hidden-lock 불일치 | 0 / 0 / 0 |
| manifest↔lock root dependency/workspace | 모두 일치 |
| node_modules metadata / workspace directory / link | 924 / 3 / 3 |
| optional 미설치 | 175: OS/CPU 제외 164, 그 외 11 |
| npm ls --all --json --offline | exit0, root error 없음 |

설치 inventory SHA-256은
da51cfba9083e21086a94af80ee00e3278c228e1b3775b1f4972f15b43ea181a이며 이전 검증과 같다.
산식과 재계산 script는 JSON에 있다. hidden lock raw SHA는
9cd03955eef3d97bfd1457069b27f46ec7493828591cc5487602f21f09955dd6다.
npm ls의 기존 extraneous label @emnapi/runtime 1.11.3과 @img/sharp-wasm32 0.35.4는
정확한 physical path/version/optional=true가 target lock에 존재한다. label을 삭제하거나 새 오류로 오인하지 않았다.

이는 metadata/version/graph 검사이지 모든 설치 파일의 integrity 감사, generated Prisma/schema 검증,
앱 readiness·운영 DB 검증이 아니다. npm ci/install/dedupe/generate/migration/seed는 하지 않았다.

## 6. 발견 목록과 실제 실패 기준선

현재 runner의 원래 직계/확장자/.sort() 규칙으로 발견한 목록은 **server 654 / client 4**이며
Git tree와 working 목록이 순서까지 같다. 목록 전부와 LF-joined hash는 JSON에 있다.
B의 649/4를 현재 상수로 복사하지 않았다. 직계 server 신규5는 lifecycle 시험1과 collector 시험4다.
추가된 tests/server-contract/... 시험은 하위 폴더여서 이 runner 목록에 넣지 않았다.

server executable+flags+절대 경로를 단순 quote한 추정 길이는 NUL 포함 41,014 UTF-16 단위,
WR의 보수적 cost는 80,043이다. 실제 OS 직렬화 측정값이나 구현된 batch 계획이 아니다.
R02/R03은 여전히 없으며 R01 원 bytes도 불변이다.

| 검사 | T의 실제 결과 | 의미 |
|---|---|---|
| npm run test:unit | exit1, npm banner만 | 전체 suite 실행 완료/성공 아님 |
| 동일 server argv 직접 spawn | ENAMETOOLONG, status/signal null, stdout/stderr 0 bytes | wrapper 밖의 한정 launch 진단; package script도 별도 실행 |
| 기존 T01 한정 실행 | 74 tests / 74 pass / 0 fail / 0 skipped | 구현 전 기존 protocol 기준선, WR19 전체 충족 아님 |
| anthropicPromptCachingWiring 한정 실행 | 12 tests / 11 pass / 1 fail | 아래 이름의 기존 Windows assertion, OI-F4와 분리 |

기존 assertion 이름은 **promptCachePath is not passed from a file the map does not know**다.
tests/anthropicPromptCachingWiring.test.mjs의 relative()가 만든 Windows backslash 경로와
PATH_CALL_SITES의 slash 경로를 비교해 app\api\chat\compare-summary\route.ts에서 실패했다.
T의 tracked-clean 실행에서 관측했으며 해당 test와 route Git bytes는 이전 sync tip과 동일하다.
이 사실과 실제 실패 이름을 기준선으로 남긴다. 다른 미래 assertion까지 기존 실패로 추정하지 않는다.
PR #1323의 원래 cacheWriteTokens harvest 실패와도 다른 시험이다. 그 harvest 시험은 이번 한정 묶음에서 통과했다.

T01과 cache wiring 전용 npm script가 없어, 기존 runner server flags를 그대로 사용했다.
--conditions=react-server, --import tsx, --test, --test-concurrency=1,
--test-reporter=spec, --test-reporter-destination=stdout과 해당 파일만 전달했다.
별도 script·filter·skip·정상화 patch를 추가하지 않았다. 전체 server/client를 실행했다는 뜻이 아니다.
WR01–WR20 구현 검증, 새 fixture, keygen/signing/provider/DB 호출은 하지 않았다.

## 7. T의 CI 및 staging 배포

- [Admin Console E2E 34452681335](https://github.com/mposition/Tomverse/actions/runs/34452681335): headSha=T, push/develop, attempt1, completed/success.
- [Credit Finance DB Integration 34452681336](https://github.com/mposition/Tomverse/actions/runs/34452681336): headSha=T, push/develop, attempt1, completed/success.

Admin의 실제 Production build와 Run the Admin Console E2E suite step이 success다.
DB의 email/assistant/finance/accounts/import/memory/routing 7개 실제 실행 lane 및 집계가 success다.
job/step 결과는 JSON.ci에 있다. 문서-only skip의 headline 성공을 실제 시험으로 세지 않았다.
Linux CI 성공은 Windows 전체 runner 성공 또는 미래 개선 시험의 대체 증거가 아니다.

Railway metadata를 읽기 전용으로 확인했다. Tomverse project/service,
**staging** 환경의 source repo는 mposition/Tomverse다.
deployment 8a4e67aa-cab9-4b51-a1b1-312f2fec8e02는
2026-09-10 07:58:29.353 UTC 생성, commit=T, 관측 status=SUCCESS였다.
production 환경 배포나 애플리케이션 전체 기능 점검을 증명하는 것은 아니다.
후속 b880bc4e... 배포는 관측 시 WAITING이었고 이번 대상에서 제외했다.
변수 값·사용자 로그·운영 DB를 읽지 않았고 재배포·설정 변경·서비스 쓰기는 하지 않았다.

## 8. 검사 결과와 보존 범위

동일 T의 tracked-clean 기준에서 2026-09-10T08:25:47.624Z까지 검사했다.
이전 B 기준의 8개 npm script와 이름별로 비교하면 exit는 모두 같다.
정책/참조 script의 출력 hash 두 개는 upstream 문서/파일 수 변화로 다르고 통과 상태는 동일하다.
다른 6개 출력 hash는 동일하다. stdout raw bytes 뒤 stderr raw bytes를 결합한 SHA-256이다.

| npm run script | exit | T 기준 출력 SHA-256 |
|---|---|---|
| check:encoding:strict | 0 | 7d5195263cb38b5aa0de4bf8e0ead06774933b4e124616518883574554bcd380 |
| check:policy-section-references | 0 | 186e01d8fe6404117146063d01f13379d3de76a45d49a6a7970dcfc5cfb255ac |
| check:release-records | 0 | 5d216eabba9f6eb6762717a31e2bc3c26172d530ed554ab099a9c21a537f3565 |
| check:memory-eval-succ9 | 0 | f792af65d17e277fecceedf03b5eaba6484180748d3013de077a027a005e194c |
| check:memory-extraction-eval | 0 | 575a56bac68f5e261286b5e00894451bd0fb1b7b5cead22e49d8d8f28315629b |
| check:memory-eval-freeze | 0 | 8318af98d6c2a2ce9ca9f2d7c0d9b4acc70cc97ee7555b8dc026a4fb5b10cca1 |
| check:doc-references | 0 | 5a51c6dd0e6fa0c87b9270a5771589f97f3f9aa8a5b2d2dcd4358576d084fc39 |
| test:unit | 1 | 30da9d3e251bc45dce4be788c62aaa860e4b1dd33ff5ce02a6de6df08f323e15 |

감사 문서 의미는 일반 checker만으로 검증되지 않는다. 작성 후 위 script 재실행과 별도로
신규 두 파일 strict UTF-8/no BOM/LF/JSON/YAML/상대 링크/Markdown hash binding/후행 공백,
diff --check와 변경 allowlist를 확인한다. 결과는 JSON.documentationValidation에 별도로 결속한다.
원 승인4·지원9·보호65·기존 untracked 정규 파일 hash/디렉터리 존재·stash17·hidden lock·
.env metadata도 전후 대조한다. 디렉터리 내부 전체 재귀 hash를 보장하지 않는다.

### 8.1 Git config 변화는 별도 관측

이 작업 시작 config SHA는
e3cab8eb198a28363829059b3e86a476964d1c6610bb738913c88abefd1d5bf5였다.
이후 2026-09-10T08:22:42.355Z mtime의 SHA는
0978548a8b1ee007337690681fd3cdff6fece55f77ae64ef868282f984eb1b5e였다.
따라서 이번 작업의 config 전체 bytes 보존을 PASS라고 하지 않는다.

읽기 전용으로 현재 bytes에서 branch "codex/to-develop/fix-admin-session-loop"의
remote=origin, merge=refs/heads/develop인 **완전한 section 한 개만 메모리에서 제외**하면
시작 SHA e3cab8eb...가 정확히 재현됐다. 나머지 bytes가 같다는 hash 근거다.
또 branch "codex/router-collector-cache-observation-fix"의 추적 section까지 제외하면
이전 승인 당시 74daa3336def61337c3b7bd4f06d9c35051660ef8111ae5f292e04383bd8bbb4가 재현된다.
새 revalidation branch의 section은 추가되지 않았다.

이는 관측된 차이가 다른 branch 추적 metadata뿐임을 결속하며 변경 주체는 확인하지 못했다.
이 작업은 config를 쓰거나 복구하지 않았다. runner/실행 설정과 작업 파일은 바뀌지 않아
문서 점검을 계속했으나, 작성자 모르게 이루어진 변경을 사람의 신규 승인으로 간주하지 않는다.
과거 4b07f53f...→74daa333...의 provenance 한계도 이 비교로 소급 해소하지 않는다.

## 9. 다음 단계와 계속 닫힌 권한

승인 receipt §5에 따라 다음 단계는 **별도 명시적 착수 지시 후** 승인된 세 파일 구현이다.

1. scripts/run-unit-tests.mjs 수정
2. scripts/run-unit-tests-core.mjs 신규
3. tests/unitTestRunner.test.mjs 신규

같은 T·같은 설치·같은 protected bytes라면 이 관측을 재사용하며 불필요한 재설치/전체 승인 재검토를 반복하지 않는다.
다른 tip·환경에서 시작하면 달라진 부분부터 재검증한다.
구현 후 WR01–WR20 실제 검증, 구현 SHA 고정, 독립 검토, 사람의 결과 수용 순서다.
이 문서 자체가 새 정책/범위를 제안하지 않으므로 새 사람 승인이나 독립 검토 의무를 자동 추가하지 않는다.

이번 재검증 지시는 commit/push/PR/병합/CI dispatch 또는 runner 구현으로 확장하지 않았다.
신규 두 기록은 아직 untracked이며 reviewCommit/recordCommit이 없다.
이후 발행 시 실제 Git SHA를 별도로 고정한다.

package/lock/설치/workflow/tsconfig/release gate, 기존 승인 bytes,
scorer/ledger/protocol/M3/M6·기존 시험/fixture, dataset/manifest/register/purpose activation,
holdout/S5/v9/pair/key·운영 서명·full P 동결·예산/dispatch/provider·운영 DB/서비스 쓰기,
memoryExtractionEnabled/memoryInjectionEnabled 및 다른 flag는 변경하지 않았다.
OI-F1–F3/ODR-F1 등 기존 잔여를 이 사전 검증으로 닫지 않는다.

문서 통제 원칙은 승인 원문 보존·출처와 관측의 분리·변경 이력 결속에만 적용했다.
의료 QMS 인증, 새 서명 체계, 새 검토자/승인자 요구를 도입하지 않는다.
