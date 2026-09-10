# memory-eval vNext — OI-F4 Windows unit runner 별도 승인 패키지 초안

**Status: DRAFT — WR-F1 설명 보완·사람 승인 대기. 수정본의 추가 독립 검토는 없으며 구현 또는 착수 승인이 아니다.**
작성자: Codex. 작성일: 2026-09-10.
Document ID: MEM-EVAL-VNEXT-OI-F4-RUNNER-1. Revision: WR-1.

## 1. 목적·현재 권한·결속 방식

OI-F4는 Windows의 전체 unit runner가 긴 argv 때문에 시험을 시작하지 못하는 잔여다.
[기존 disposition 승인](memory-eval-vnext-offline-subset-disposition-approval-2026-09-08.md)의
OI-F4 처리방침은 별도 runner 범위로 보류했으며, runner·package·lock·config 변경 권한을 주지 않았다.
이번 사용자 지시는 그 **별도 승인 패키지를 문서로 작성**하라는 것이며 구현 승인이 아니다.

현재 산출물은 이 Markdown과
[동반 evidence JSON](evidence/memory-eval-vnext-oi-f4-runner-approval-package-2026-09-10.json)
두 파일이다. Markdown은 규범 제안, JSON은 이 Markdown의 exact raw SHA-256에
일방향 결속한 출처·현재 관측·향후 시험 명세다. 미래 receipt가 두 파일의 path/raw SHA와
실제 reviewCommit을 함께 승인해야 한다. JSON 자기 hash 또는 미래 commit을 기입하지 않는다.
상위 문서 hash·과거 검토 보고서 hash는 출처 식별자이며 이 패키지의 승인 대상 hash가 아니다.

~~~yaml
recordKind: oi_f4_windows_unit_runner_approval_package_draft
recordStatus: revised_pending_human_approval
packageLabel: WR
proposalVersion: oi-f4-runner-1
repository: mposition/Tomverse
repositoryBasis: 7bce6df0e2ff55d50d24e23c172aa831b09e7c15
branch: codex/memory-eval-vnext-oi-f4-runner-approval
documentCommit: null
reviewCommit: null
decision: pending
approvedBy: null
approvedAt: null
approvalReceiptCommit: null
requiredDecisionIds: [WR-D1, WR-D2, WR-D3, WR-D4, WR-D5]
acceptedDecisionIds: []
preparationAuthorized: true
implementationChangeAuthorizedNow: false
implementationStartAuthorizedNow: false
publicationAuthorizedNow: false
externalReviewVerdict: null
oiF4ClosureDeclared: false
fullUnitSuitePassed: false
activationAuthorized: false
paidExecutionAuthorized: false
~~~

proposalVersion은 감사 문서용 식별자이며 운영 schema·wire field·새 runtime 옵션이 아니다.
기존 mposition 승인일·서명을 새 결정을 승인한 것처럼 복사하지 않는다.
이 초안 작성에는 commit/push/PR/병합/issue 생성/모니터 재개가 포함되지 않는다.

## 2. 고정 기준·승인 계보·현재 CI

작성 기준 B는 **7bce6df0e2ff55d50d24e23c172aa831b09e7c15**다.
기존 branch와 HEAD 18dceb8fd12ac6d76b09594f2803fa1221af99d2를 보존하고,
tracked/index clean 및 보호 대상 관측 후 B에서 위 문서 branch를 만들었다.
이것은 미래 구현의 실제 착수 tip을 고정한 것이 아니다. 원격 develop이 이동해도 B를 자동 바꾸지 않는다.

[PR #1317](https://github.com/mposition/Tomverse/pull/1317)의 merge M은
e0ec7c6429c35d2c3dff1f5999adc87fe23e1ce5다. parent는
6aeee21ded2ab0dbc147056fcc01c9c1731be46f와 18dceb8fd12ac6d76b09594f2803fa1221af99d2다.
다음 원 SHA가 B의 조상임을 확인했다. JSON에 검사 대상 전체 9개를 기록한다.

- decision approvalCommit A: 3f14afb29eddc243640fdb0a5a4f604646ade9f0
- S1–S4 contractApprovalCommit CA: 80842e62925c05af9450e6acc6ceb70b56f67655
- OI-F2 IP R2: 13a6b088cd88d53d971e66f358e297b8c71c6ad7
- OI-F2 승인 receipt AIP: b8d96f0f19f51f0bb6296b06dbc986bc6df7e47b
- M3 착수 관측 OM3: a7be3b88b7b476e24b4a258ceab8ef5f5dd3628f
- M3 구현 IM3: 786c06d7f5ef89d829d3ca8474192015294b18ad
- M3 착수 의도 확인 receipt: 18dceb8fd12ac6d76b09594f2803fa1221af99d2
- 위 merge M 및 성공 successor S: 5a91fe8f06f2c382f6d3ecae125dfac0e1a8c1d0

착수 의도 확인은 과거 발언의 의미 확인이다. IM3 독립 검토의 모든 경고 closure,
새 runner 승인 또는 구현 인수 승인으로 확대하지 않는다. 그 IM3 보고서는 OI-F4 패키지의
독립 검토가 아니며 JSON의 출처 구획에서만 식별한다.

2026-09-10T04:56:00.115Z에 B의 다음 push/develop run을 확인했다. 모두 attempt 1이다.

- [Admin Console E2E 34438295749](https://github.com/mposition/Tomverse/actions/runs/34438295749): completed/success, Production build 및 실제 Admin E2E step success.
- [Credit Finance DB Integration 34438295752](https://github.com/mposition/Tomverse/actions/runs/34438295752): completed/success, 실제 7개 lane와 집계 job success.

M의 이전 run 34436660760/34436660792가 cancelled였다는 사실은 그대로다.
B의 성공을 M의 성공으로 소급하지 않는다. 위 두 run은 Windows runner 개선 시험도,
B의 Railway 배포 증명도 아니다. 이 패키지에서는 운영 서비스에 접속하지 않았다.

## 3. 현재 runner와 재현 기준선

B의 package script는 test:unit = node scripts/run-unit-tests.mjs다.
[현재 runner](../../scripts/run-unit-tests.mjs)의 Git blob은
0a51e254e2df67fbdc8595b9a3b5d7deac1e3291,
Git raw SHA-256은 9a9b3cee85bc012ea90d1adfc79b03e912cea0a6838c12e048ded5222ad40ac9다.
working raw SHA는 e6af763f362e6a31a838d7e5fc9a7c7d5dbbe42d8bceede1da6c9fba24986e76다.
Git/working hash를 혼용하지 않는다. runner와 지원 파일 9개의 Git bytes는 IM3 이후 B까지 같다.

로컬 Windows x64의 Node v22.22.2, npm 10.9.7, tsx 4.23.13, TypeScript 6.0.3,
libuv 1.51.0을 관측했다. 설치 변경은 하지 않았고, 전체 dependency inventory의 새 인증도 아니다.
지원 파일 9개·관련 원문/구현·workflow를 합친 직접 binding 24개와 보호 파일 65개의
기준선은 JSON에 있다. untracked 35항목은 정규 파일 29개의 raw hash와 디렉터리 6개의
존재만 관측했다. 디렉터리 내부 전체 bytes를 검증했다는 뜻이 아니다.
stash 17개, Git config hash, hidden lock hash, .env 계열의 크기·mtime도 보존 대상으로 삼았다.
.env 내용·자격증명 값은 읽거나 기록하지 않았다.

2026-09-10T04:54:47.654Z–04:54:52.763Z, B의 tracked-clean tree에서 다음을 실행했다.
npm script 이름·실제 script 본문·시각·exit·stdout/stderr와 그 결합 raw hash는 JSON에 기록한다.

| 검사 | B 기준 결과 | 해석 |
|---|---|---|
| check:encoding:strict | exit 0 | 저장소 script 범위 통과 |
| check:policy-section-references | exit 0 | 현재 기준 통과; IM3 때의 과거 오류 6건을 현재 실패로 복사하지 않음 |
| check:release-records | exit 0 | 기존 release record 검사 통과 |
| check:memory-eval-succ9 | exit 0 | 기존 구조 검사만; purpose activation 승인이 아님 |
| check:memory-extraction-eval | exit 0 | 기존 register 검사만; pair 승인 아님 |
| check:memory-eval-freeze | exit 0 | 기존 freeze 검사만; vNext full freeze 아님 |
| check:doc-references | exit 0 | 해당 checker가 소유한 참조 범위 통과 |
| test:unit | exit 1 | npm banner만 출력, 전체 시험 통과/실행 완료 아님 |
| 동일 server argv의 직접 spawn 재현 | status null, error ENAMETOOLONG | stdout/stderr 0 bytes; 기존 wrapper가 숨긴 launch 실패 확인 |

B의 발견 목록은 server 649파일, client 4파일이다. JSON에 정렬된 상대 경로 전부를 보존한다.
단순히 각 argv에 따옴표를 붙여 합친 길이 추정은 NUL 포함 UTF-16 40,662단위다.
이 값은 OS가 실제 직렬화한 command line의 측정값이 아니며 아래 보수적 cost 식과도 다르다.
직접 spawn은 오류의 종류를 확인하기 위한 진단으로만 사용했다. package script 검사를 대체하지 않았다.

검사는 child process에 OS/PATH/TEMP 및 사용자 cache 경로 관련 최소 환경만 전달하고
존재하지 않는 DOTENV_CONFIG_PATH를 사용했다. production 자격증명·provider 예산·DB 연결 없이
실행했으며 부모 환경·설치·lock은 수정하지 않았다. 이것은 **이번 검증 환경**의 제한이다.
미래 runner가 caller 환경을 임의로 제거하도록 승인하는 것은 아니다.

## 4. WR-D1 — Windows 전용 결정적 길이 분할 제안

Microsoft CreateProcessW의 command line 한도는 종료 NUL을 포함한 32,767 문자다.
[공식 CreateProcessW 문서](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw)

제안은 win32에서만 고정 **16,000 UTF-16 단위**의 보수적 budget을 사용하는 것이다.
16,000은 OS 공식 한도가 아니라 이 패키지가 승인 요청하는 여유 있는 내부 제한이다.
Node v22.22.2에 포함된 libuv의 UTF-16 변환·인용 처리로부터 다음 상한식을 도출한다.
이는 소스에서 도출한 설계 추론이며 실제 직렬화 결과를 측정했다는 주장이 아니다.
[고정 버전 libuv Windows process 소스](https://github.com/nodejs/node/blob/v22.22.2/deps/uv/src/win/process.c)

~~~text
argsIncludingExecutable = [process.execPath, ...laneFlags, ...absoluteFilePaths]
cost = 1 + sum(2 * arg.length + 3)
budget = 16000
~~~

arg.length는 JavaScript UTF-16 code unit 수다. 각 인자의 인용/escape에 최대 2배,
따옴표·구분자에 3단위, 전체 종료 NUL에 1단위를 잡는다.
실행 파일 경로와 모든 고정 flag도 매 batch 비용에 포함한다.
수동 quoting 결과를 실행하지 않고 원래 string argv 배열을 Node에 그대로 넘긴다.
문자열에 NUL이 있거나 string이 아니거나 비용 계산이 안전한 정수 범위를 벗어나면 계획 실패다.
Windows에서 허용되지 않는 실제 파일명을 정규화하여 허용하는 계약이 아니다.

- 원래 정렬 목록의 **최대 prefix**가 cost <= budget을 만족하도록 greedy 분할한다.
- 다음 파일을 넣으면 넘는 경우에만 새 batch를 시작한다. 파일 경로 자체를 나누지 않는다.
- 빈 lane은 batch 0개다. server lane이 비는 기존 오류는 별도로 유지한다.
- 양쪽 lane의 모든 계획을 **첫 spawn 전에** 검증한다. 실행 파일+flags+파일 하나도
  budget에 안 들어가면 전체 계획 실패, spawn 0회, exit 1이다. 해당 파일만 skip하지 않는다.
- flatten(batch files)은 해당 원 발견 목록과 순서까지 같아야 한다. 누락·중복·재정렬 금지.
- runtime budget 변경용 env/CLI 옵션, retry, 자동 fallback, 크기에 따른 시험 제외는 없다.
  순수 helper 시험에서만 작은 budget을 인자로 주입해 경계를 재현할 수 있다.
- win32 이외에서는 각 비어 있지 않은 lane을 기존과 같이 **단일 spawn**한다.
  다른 OS의 argv 한도까지 해결하거나 모든 길이의 checkout을 지원한다고 주장하지 않는다.

## 5. WR-D2 — discovery·server/client·Node 옵션 보존 제안

현재 발견 규칙을 유지한다. process.cwd()를 기준으로 tests의 직계 이름을 읽고,
server는 .test.mjs 또는 .test.ts로 끝나는 이름만, client는 tests/client의 직계
.test.tsx 또는 .test.ts 이름만 선택한다. 각각 기존 .sort()를 거친 뒤 절대 경로로 만든다.
확장자 비교의 대소문자 의미도 그대로다. 재귀 탐색·glob·Git tracked 필터·새 stat 필터를 넣지 않는다.
서버 디렉터리 부재/읽기 실패 또는 server 0개는 nonzero다. client 부재/0개는 허용한다.

server의 모든 batch가 먼저이고 client는 그 다음이다. batch들은 순차 spawnSync로 실행한다.
server에 일반 시험 실패가 있으면 나머지 server batch는 실행하되 client 전체는 실행하지 않는다.
이는 기존 server 전체 결과가 nonzero일 때 client를 건너뛰던 경계를 보존하는 제안이다.

| lane | 파일 목록 앞에 전달할 정확한 argv |
|---|---|
| server | --conditions=react-server, --import, tsx, --test, --test-concurrency=1, --test-reporter=spec, --test-reporter-destination=stdout |
| client | --import, tsx, --test, --test-concurrency=1, --test-reporter=spec, --test-reporter-destination=stdout |

process.execPath, stdio: inherit, env: process.env, caller cwd 상속을 유지한다.
shell은 false, windowsVerbatimArguments는 false/생략이다. argv0·timeout·killSignal·filter·retry·
추가 Node option 또는 별도 NODE_OPTIONS를 새로 설정하지 않는다.
기존 client에 react-server 조건을 넣지 않는다. 프로그램형 test API나 실험적 isolation으로 옮기지 않는다.
기본 파일별 process isolation과 concurrency=1을 유지한다.
[Node 22 test runner 문서](https://nodejs.org/docs/latest-v22.x/api/test.json)

Windows에서는 Node test runner의 batch별 집계가 여러 번 출력되고 프로세스 시작 비용이 늘어난다.
batch마다 번호·집계가 다시 시작될 수 있어 하나의 전역 TAP/spec 총합을 보장하지 않는다.
비-Windows의 기존 통상 실행 경로는 유지하되 아래 비정상 결과의 fail-closed 처리는 공통 적용한다.
이것은 임의 JavaScript 격리 sandbox 또는 악성 시험 코드의 I/O 방지 보장이 아니다.

## 6. WR-D3 — 실패 누적·중단·진단 제안

정상 종료와 spawn 오류/signal은 다른 결과다.
[Node v22.22.2 spawnSync API 문서](https://github.com/nodejs/node/blob/v22.22.2/doc/api/child_process.md)

| 관측 결과 | 같은 lane의 나머지 batch | 다음 lane | 최종 exit 의미 |
|---|---|---|---|
| error 없음, signal null, status 0 | 계속 | lane 전부 성공이면 진행 | 다른 실패가 없을 때만 0 |
| error 없음, signal null, 정수 status 1–255 | 계속 | server 실패면 client 미실행 | 실행 순서상 최초 nonzero를 보존 |
| error 존재, signal 존재, status null/누락/비정수/범위 밖 또는 spawn throw | 즉시 중단 | 미실행 | 기존 최초 nonzero 또는 없으면 1 |
| 계획/discovery 실패 | 실행 안 함 | 실행 안 함 | 1 |

비정상 값은 성공으로 간주하지 않으며 error와 status 0이 함께 있어도 비정상이 우선한다.
통상 1–255 실패 코드는 보존하고 그 밖의 비정상 status는 1로 정규화한다.
이는 기존 runner의 모든 exit 동작을 그대로 보존하는 것은 아니다. 현행 server의
result.status ?? 1 및 clientResult.status ?? 1은 null/undefined가 아닌 status를 범위 검사 없이
process.exit에 전달한다. 제안은 정상 성공 status 0을 제외한 범위 밖 값을 인프라 실패로 분류해 남은 batch/lane을
중단하고, 최종 exit는 앞서 기록한 최초 nonzero가 있으면 그 값을 유지하고 없으면 1로 정한다.
정상 실패 코드 보존과 달리 이 비정상 경로는 의도된 동작 변경이며 WR-D3 승인 대상이다.
POSIX wait/waitpid는 정상 종료 status의 하위 8비트를 반환하므로 256이 부모에서 0으로 보일 수 있다.
따라서 범위 밖 값을 다시 전달하지 않고 휴대 가능한 nonzero로 제한하는 방어적 처리다.
[POSIX.1-2017 wait의 종료 status 정의](https://pubs.opengroup.org/onlinepubs/9699919799/functions/wait.html)
다만 이미 OS 경계에서 잘려 spawnSync가 status 0을 반환한 원래 값을 복원한다는 보장은 아니다.
이번 보완은 기존 표의 값·분류·최초 nonzero 우선순위를 바꾸지 않고 현행과의 차이·이유를 밝힌다.
여러 실패를 합산하여 0으로 wrap시키거나 마지막 성공으로 덮어쓰지 않는다.
ENAMETOOLONG/ENOENT/EACCES, signal, throw 뒤에 자동 재시도하지 않는다.
중단으로 남은 batch와 server 실패로 건너뛴 client는 **미실행**이며 통과 수에 더하지 않는다.

새 wrapper 진단은 lane/batch 번호, 계획 파일 수, spawn에 제출한 파일 수, 미제출 파일 수,
정상 종료/시험 실패/인프라 중단 구분과 제한된 오류 분류만 남긴다.
제출 파일 수는 실제 assertion 실행·완료 수가 아니다. child stdout/stderr는 기존처럼 그대로 전달하고,
wrapper는 spec/TAP 문자열을 파싱해 pass/fail을 판정하거나 가짜 전역 “전체 시험 통과” 총계를 만들지 않는다.
새 진단에 전체 argv·절대 경로·env·error.message/stack을 dump하지 않는다.
알 수 없는 오류는 고정 unknown 분류로 남긴다. 기존 child 출력의 비밀 제거 기능을 새로 보장하지 않는다.

## 7. WR-D4 — 향후 구현의 정확한 3파일 범위 제안

아래는 **미래 승인 시의 구현 allowlist**다. 이번 문서 작성에서 바꾸는 파일이 아니다.
새 파일 두 개는 B와 현재 작업 트리에서 모두 없음을 확인했다.

| ID | 경로 | 허용 변경 |
|---|---|---|
| R01 | scripts/run-unit-tests.mjs | 기존 discovery 유지, local helper 연결, 사전 계획·순차 실행·제한된 진단·최종 exit 적용 |
| R02 | scripts/run-unit-tests-core.mjs (신규 예정) | 부수효과 없는 내부 계획 helper 및 주입된 spawn을 호출하는 동기 orchestration |
| R03 | tests/unitTestRunner.test.mjs (신규 예정) | 아래 독립 회귀 시험 및 소유한 임시 디렉터리 안의 합성 CLI fixture |

R02의 내부 export 이름은 planUnitTestBatches와 runUnitTestBatches다.
전자는 순수 계획 함수, 후자는 spawn/환경/event sink를 인자로 받는 실행 helper다.
import 시 discovery/spawn/파일 쓰기를 하지 않고 builtin·외부 package import도 하지 않는다.
R01의 기존 builtin은 node:fs, node:path, node:child_process이고 신규 local helper import만 추가한다.
R03은 node:test, node:assert/strict, node:fs, node:os, node:path, node:url,
node:child_process 및 R02의 local import만 허용한다. 새 dependency는 없다.
구체적인 내부 인자/결과 type 배치는 위 의미를 바꾸지 않는 범위의 구현 세부다.

R03은 기존 자동 server discovery에 시험 파일 **한 개만** 추가한다.
B에 다른 변화가 없다면 649→650 server, client 4 유지가 기대값이다.
착수 tip에서 실제 목록을 다시 계산하며 649를 영구 상수나 skip 기준으로 쓰지 않는다.
기존 test 제목/내용/fixture를 고쳐 “새 runner 통과”를 만들지 않는다.

R03의 실제 CLI 시험은 저장소 밖 소유한 임시 디렉터리에 R01/R02의 exact bytes와 작은
합성 시험만 복사한다. 승인된 설치의 node_modules를 읽기 위한 junction/symlink는 허용하되
그 대상은 쓰지 않는다. .env·실제 데이터·비밀은 복사하지 않고 유료/provider/DB 호출은 하지 않는다.
fixture discovery에 R03 자신 또는 실제 전체 tests를 넣지 않아 재귀 실행을 막는다.
실제 파일명 시험은 OS가 허용하는 공백·한글·괄호 등을 사용하고, 따옴표 같은 금지 파일명은
순수 argv cost 시험에서만 다룬다. root에 합성 test 파일을 잠깐 추가하는 방식은 금지한다.

정리는 먼저 junction/symlink 자체만 제거하고, 생성·검증한 소유 임시 경로만 제거한다.
node_modules 대상이나 저장소/기존 temp를 재귀 삭제하지 않는다.
임시 fixture 생성은 R03의 시험 동작이며 네 번째 tracked 파일을 허용하는 뜻이 아니다.

## 8. WR-D5 — 독립 검증 및 완료 판정 제안

아래 **20개 검증 그룹**은 미래 명세다. 현재 결과가 아니며 모두 not_run이다.
유료 turn 0회, production 자격증명 불필요다. WR01–WR17은 focused 회귀,
WR18–WR20은 실제 환경·기존 회귀·범위 확인이다. false pass/누락 방지와 직접 관련된 이 그룹은
완료 필수다. 출력 문구 미관·batch 크기 성능 튜닝·별도 Windows CI 신설은 필수가 아니며 범위 밖이다.

| ID | 확인할 독립 oracle / 기대 결과 |
|---|---|
| WR01 | cost에 실행 파일·고정 flag·구분자/NUL 포함; UTF-16 수를 손으로 고정한 별도 기대값과 대조 |
| WR02 | cost가 budget보다 작음/같음/1 큼의 경계, 최대 prefix 분할 및 빈 lane |
| WR03 | 여러 batch·수천 합성 경로의 flatten이 원본 순서와 일치, 중복/누락 0, 입력 배열 불변 |
| WR04 | 공백·한글·astral 문자·quote/backslash 조합의 상한 계산; 실제 OS 금지 경로와 구별 |
| WR05 | 한 파일 또는 실행 파일+flags 초과, NUL/잘못된 인자/계산 오류 시 양쪽 lane의 spawn 0회 |
| WR06 | non-win32에서는 budget 분할 없이 lane당 한 batch; 원래 argv와 순서 보존 |
| WR07 | server/client의 정확한 확장자·대소문자·정렬·직계 탐색, 하위 폴더 시험 제외가 기존 규칙과 일치 |
| WR08 | server 부재/읽기 실패/0개 nonzero; client 부재/0개 허용; 발견 파일을 Git 상태로 거르지 않음 |
| WR09 | spawn recorder가 executable·각 argv·stdio/env·cwd 상속·shell 경계를 확인; lane별 조건 차이 유지 |
| WR10 | server 전부 성공 뒤에만 client, client 0개면 추가 spawn 없음; 겹쳐 실행하지 않음 |
| WR11 | 첫/중간/마지막 server batch의 일반 실패마다 뒤 server는 모두 실행, client는 미실행 |
| WR12 | 서로 다른 nonzero 뒤 성공 및 client 내부 실패: 최초 nonzero 유지, exit 0으로 덮이지 않음 |
| WR13 | error+status0, ENAMETOOLONG/ENOENT/EACCES, signal/null/누락/비정수/범위 밖/throw: fail-closed·남은 실행 0·retry 0; 범위 밖 status의 현행 pass-through와 제안의 중단·최초 nonzero 보존/없으면 1 차이를 고정 |
| WR14 | 제출/미제출 수·인프라 중단과 시험 실패를 구분; child 출력에 “pass”가 있어도 실패를 성공으로 바꾸지 않음 |
| WR15 | 소유한 합성 CLI fixture에서 실제 discovery·tsx loader·server/client 조건 및 성공 exit 관측 |
| WR16 | 실제 CLI의 의도된 실패·이후 server marker·미실행 client marker, 비밀 없는 fixture·안전 정리·재귀 실행 없음 |
| WR17 | focused 시험의 기대 목록/결과는 helper 출력을 다시 정답으로 쓰지 않음; 경계·실패 누적 오류를 주입한 in-memory stub도 검출 |
| WR18 | 실제 Windows 전체 npm run test:unit: 같은 tip의 전체 발견 목록 제출, ENAMETOOLONG 없음, 결과·미실행·실패명 구분; 아래 조건 충족 전 PASS 아님 |
| WR19 | 기존 T01을 원문 그대로 독립 실행해 현재 74개 회귀 보존; 새 test 파일 자동 발견; Linux PR Fast Gate의 실제 unit step 결과와 파일 차이 확인 |
| WR20 | exact 3파일 diff·상위 raw bytes·지원 파일/환경·보호 파일·금지 영역·문서/정책 검사 및 diff/encoding 검증 |

이 표는 20개 assertion만 만들라는 뜻이 아니다. 각 그룹의 분기와 음성 입력을 시험하되
같은 기능을 여러 형식의 대형 증거로 중복 검토하지 않는다.
WR15/WR16은 실제 CLI, 나머지 focused 그룹의 계획·실패 경계는 주입된 platform/budget/spawn으로
작게 재현한다. 실제 Windows full run은 WR18에서 별도로 수행해 합성 성공을 실기기 증명으로 대용하지 않는다.
소유 임시 fixture는 에이전트가 준비한다. 사람이 수백 시험을 손으로 실행하거나 숫자를 세지 않는다.

실제 착수 시 package.json에 대응 script가 있으면 반드시 그 script를 실행한다.
focused R03/T01 전용 script가 없는 경우에만 test:unit의 해당 server flag 배열을 **그대로**
사용해 대상 파일을 실행하고, 전체 runner가 아닌 한정 회귀라는 사실을 기록한다.
package script를 추가하는 권한은 없다. T01은 tests/memoryEvalVnextWire.test.mjs이며,
74는 현재 IM3 회귀 기준이다. 이 초안 작성에서 다시 실행한 값은 아니다.

완료는 세 판단을 분리한다.

1. **runner 실행 결함 해소**: WR01–WR17 통과, 실제 Windows에서 발견 파일의 누락/중복 없는
   제출·실행 결과가 확인되고 ENAMETOOLONG이 없어야 한다. 서버 일반 실패로 client가 미실행이면
   client 실제 실행 검증을 별도 한정 lane 실행으로 보완하고, 전체 run 성공이라고 쓰지 않는다.
2. **전체 unit suite 통과**: 실제 전체 package script exit 0, server/client 완료, 인프라 중단 없음,
   기존 및 새 시험 결과 확인이 있어야만 선언한다. 몇 batch 성공이나 Linux 성공만으로 대용하지 않는다.
3. **OI-F4 closure**: 위 runner 검증과 WR18–WR20의 결과·잔여를 고정 SHA에 결속해 독립 검토 후
   사람이 수용해야 한다. 무관한 기존 시험 실패가 남으면 runner 결함 해소만 수용할 수 있으며,
   전체 unit PASS와 미실행 구획을 혼동하지 않는다. 미검증이 있으면 그 이름과 이유를 남긴다.

Windows의 과거 전체 runner는 실행 자체가 실패했으므로 수정 후 처음 보인 assertion 실패를
자동으로 “기존 실패”라 부르지 않는다. 같은 실제 tip·환경·동일 test 이름으로
기존 runner의 flag/순서에 맞춘 한정 진단 또는 동일 SHA의 Linux unit 근거와 대조한다.
원인 미확정은 unresolved다. assertion을 고치거나 skip하는 일은 3파일 범위 밖이며 별도 지시가 필요하다.
문서 검사는 B의 이번 7개 script 결과와 **이름 단위** 대조하며 새 실패와 기존 실패를 구분한다.
지원 환경이 달라지면 관측만으로 같은 기준선이라 선언하지 않고 해당 차이를 설명한다.

## 9. 권한 밖·불변 원문·잔여

이 제안이 승인되어도 runner 개선 이외 권한을 열지 않는다.

- package.json, package-lock.json, tsconfig, npm 설치, hidden lock, workflow/CI·release gate 변경 금지.
- 승인된 S1–S4, Q, D/K, 기존 receipt·evidence 및 원 decision bytes/빈 서명란 변경 금지.
- scorer/ledger/C01/C02/M3/M6 등 memory-eval 구현 또는 기존 시험·wire vector 변경 금지.
- dataset·manifest·register·succ-9 purpose 변경/activation, holdout 작성·봉인·개봉 금지.
- S5/v9 prompt 작성·활성화, full P/scorer 동결, pair 승인, key/서명·seal 운영 금지.
- provider 호출·dispatch·예산 집행·production DB/서비스 쓰기 금지.
- memoryExtractionEnabled·memoryInjectionEnabled 및 그 밖의 flag 변경 금지.
- Git config·기존 stash·관련 없는 untracked·.env 내용/메타데이터 변경 금지.

A/CA가 갖는 승인 의미, D<K<activationApprovalCommit<C 순서 및 기존 수용/보류는 그대로다.
OI-F1·ODR-F1의 소급 closure를 선언하지 않고, OI-F2·OI-F3 및 full P의 잔여/미구현 구획을
runner 시험 통과로 닫지 않는다. 새 계약/시험 결과를 과거 F07 완전 충족으로 소급하지 않는다.
원문 bytes를 고쳐 새 승인처럼 보이게 하는 대신 별도 receipt를 추가하는 방식을 유지한다.

## 10. 권장 진행 순서·승인 요청

다음은 순서 제안이며 현재 실행 권한이 아니다.

1. 사용자가 요청하면 두 파일만 검증·commit/push하고 그 40자 SHA를 reviewCommit으로 고정한다.
2. Claude에 WR 패키지 자체의 최초 독립 검토를 요청한다. B와 상위 원문·현재 기준선,
   WR-D1–WR-D5 및 WR01–WR20을 재계산한다. IM3 검토를 WR 검토로 대용하지 않는다.
3. 차단점이 있으면 이 패키지 범위에서 수정·SHA 재결속하고 변경분 확인 검토는 최대 한 번을 권장한다.
   미해소 차단점은 사람에게 보고하며 검토 횟수 소진을 승인으로 간주하지 않는다.
4. 사람이 최종 두 파일의 exact hash·reviewCommit·검토 결과/잔여와 WR-D1–WR-D5를 승인한다.
   별도 authoritative receipt를 만들며, 이 초안의 null을 과거 날짜로 채워 바꾸지 않는다.
5. 승인 계보를 원 SHA를 보존하는 merge commit으로 develop에 반영하고 해당 CI를 확인한다.
   실제 구현 착수 tip에서 지원 파일 9개·runner·발견 목록·실행 환경·승인 ancestry를 재검증한다.
6. 명시적 착수 지시 후 새 codex/ branch에서 R01–R03 세 파일만 구현한다.
   구현 SHA를 고정하고 실제 시험·독립 검토·사람의 결과 수용을 거쳐 closure 여부를 정한다.

실제 착수 재검증에서 일치하는 환경을 반복 재설치하지 않는다. 관측된 변경만 대조하고,
runtime/지원 파일 변화가 분할 상한·시험 의미에 영향을 주면 구현 전에 범위를 재확인한다.
이 문서는 사람의 서명·검토 판정·미래 CI·실행 결과를 대신 만들지 않는다.

## 11. 이번 문서 작성의 검증 범위

이번에는 알고리즘·runner·R03을 구현하지 않았고 WR01–WR20을 실행하지 않았다.
T01·mutant·lint/typecheck/build/E2E를 새로 실행한 것도 아니다.
B의 기존 7개 문서/정책 script 통과와 Windows launch 실패 재현은 관측 구획에만 결속한다.

문서 완성 후 같은 7개 script, strict UTF-8 raw decode·JSON parse·MD hash binding,
내부 상대 링크·결정/검증 ID 결속·diff --check 및 두 신규 파일의 whitespace를 확인한다.
tracked/index clean, 신규 파일 두 개 외 기존 untracked 정규 파일 hash/디렉터리 존재,
보호 파일 65개·config·stash·hidden lock·env 메타데이터를 기준선과 대조한다.
저장소 checker 통과가 이 문서의 모든 의미·승인 권한을 자동 증명한다고 주장하지 않는다.
그 직접 검증 결과와 보존 관측은 동반 JSON에 기록한다.

보존 예외: 문서 작성 중 .git/config raw SHA가 시작 시
4b07f53f881d29563ec651733a2910738686bd45e77319aaf5f89f7f62b48252에서
74daa3336def61337c3b7bd4f06d9c35051660ef8111ae5f292e04383bd8bbb4로 달라졌다.
관측한 최종 mtime은 2026-09-10T04:56:32Z다. 이 작업에서는 config 쓰기를 하지 않았으나
변경 주체·정확한 내용 차이를 입증할 이전 config 원문 snapshot이 없어 원인을 단정하지 않는다.
덮어쓰기/복구하지 않았고 config 보존 PASS라고 기록하지 않는다.
HEAD·branch·tracked/index·보호 파일 65개·기존 untracked·stash·hidden lock·env 메타데이터가
그대로임을 별도로 확인해 문서만 계속 작성했다. commit/push 전 config를 다시 관측해야 한다.

## 12. WR-1 처리 이력과 검토 한계 — 2026-09-10

원본 R=3fb5ac9554ecbe8c3c52a7da0f9bf1739030e7a9의 두 blob은 Git 이력에 그대로 보존한다.
R의 최초 독립 검토는 PASS_WITH_WARNINGS, 승인 차단 0건, P3 WR-F1 한 건이었다.
보고서 raw SHA-256은 d0ea75c475e42e9ca41434547731b9a4a9e1a0e0fa31ab8b7160e16d9f7418a8이다.
그 판정은 R에만 귀속한다. WR-1은 §6의 현행/제안 차이·이유 설명과 WR13의 대응 문구를
보완하고 JSON의 Markdown hash를 재결속한 수정본이며, 값·16,000 budget·3파일 범위는 불변이다.

처리 상태는 작성자의 author_addressed_pending_human_acceptance다. 수정본의 추가 독립 검토나
CONFIRMED·외부 finding closure를 발급하지 않았다. 최초 검토 1회, 변경분 확인 검토 0회다.
비차단 설명 보완이므로 전체 재검토를 반복하지 않고, 사람이 수정 차이와 추가 독립 검토 부재를
함께 수용하도록 요청한다. 별도 요청이 있으면 WR-F1 변경분 확인 검토만 할 수 있다.
이 권고는 승인 자체가 아니며 사람 판정은 여전히 pending이다. 새 정책·값·범위 변경이 필요하면
이 한정 보완에 섞지 않고 별도 지시·검토 대상으로 분리한다.

JSON의 baseline·provenance·documentationValidation은 R 작성 당시 관측으로 보존하며,
WR-1의 처리와 직접 검증은 revisionReviewDisposition에서 구분한다. 미래 WR01–WR20은 여전히
not_run이고 구현·커밋·푸시·PR·운영 활성화를 이번 수정 지시에서 시작하지 않는다.
