# memory-eval vNext — OI-F3 B 설치 환경 수정·고정 N 재검증

## 1. 결과

**PASS_WITH_RETAINED_RESIDUALS — START-ENV-1 설치 불일치 해소, 고정 N의 한정 착수 사전 재검증 완료.**

- 고정 tip N: 75b8d9a7a5464c5d36843331a39161c3fba71fda
- 준비 branch: codex/memory-eval-vnext-oi-f3-b-implementation
- 작성자 Codex, 작성일 2026-09-09, Australia/Brisbane.
- Node v22.22.2 / npm 10.9.7에서 npm ci --no-audit --no-fund 성공, 927 packages.
- js-yaml: N lock·설치본·hidden lock 모두 4.3.2.
- version 불일치 1→0, hidden-lock version 불일치 1→0, 필수 누락 0.
- N의 기존 package/lock/config/schema bytes는 설치 전후 불변.
- 관련 package script 7개·한정 공개 reference runtime probe·N CI 9개 통과.
- 구현·기존40 unit·새 B case·commit/push/PR·운영 작업은 시작하지 않았다.

사용자 “설치환경이 계속 불일치하다고 보고 하시는데 고쳐주세요.”는 앞서 설명한
고정 N checkout·lock 보존 재설치·재검증 범위의 실행 지시로 적용했다.
새 설계·builtin·구현·운영 승인으로 확대하지 않았다.
기존 [PB 승인 receipt](memory-eval-vnext-oi-f3-b-approval-2026-09-08.md)의
실제 착수 Gate와 별도 구현 지시 조건은 계속 적용된다.

[중단 기록](memory-eval-vnext-oi-f3-b-start-tip-revalidation-2026-09-09.md)과
[중단 증거](evidence/memory-eval-vnext-oi-f3-b-start-tip-revalidation-2026-09-09.json)는
원 bytes 그대로 보존했다. 과거 BLOCKED를 PASS로 고치지 않는다.
이번 증거는 [설치 수정·재검증 JSON](evidence/memory-eval-vnext-oi-f3-b-environment-repair-2026-09-09.json)이다.
JSON raw SHA-256: 393ebb5c7744a7a3bdba48f3b1d1aa7619e6d58d730efc7ce82023478e42dde7.
이는 환경 수정 관측 증거 식별자이며 새 사람 승인 대상 hash가 아니다.

## 2. 원인과 수행한 수정

이전 checkout W=aac943b839392764224906057040282a6e78faeb의 설치본은 js-yaml 4.3.1이었다.
후보 N의 upstream lock은 4.3.2로 바뀌었지만 실제 checkout·설치를 옮기지 않은 상태였으므로
N과 로컬 설치 비교가 계속 불일치했다. package/lock 자체를 바꿔야 하는 결함이 아니었다.

W의 tracked/index clean, 일반 untracked27개·ignored3개 및 관련 원문을 보존 기준으로 잡았다.
.claude/, .codex/, human-review-ai-output/ 내부는 재귀 조사·변경하지 않았다.
N tracked 경로와 기존 untracked 충돌이 없음을 확인한 뒤 N을 detached checkout했다.
기존 branch는 이동하지 않았다. checkout의 upstream 변경과 이번 수정은 구별한다.

Context7의 npm/Prisma 공식 문서를 확인했다. 새로운 dependency upgrade나 코드 수정 대신
[lock을 변경하지 않는 npm ci](https://github.com/npm/cli/blob/latest/docs/lib/content/commands/npm-ci.md)를 사용했다.
설치용 package script는 없으며 npm이 기존 postinstall인 prisma generate를 그대로 호출했다.
세 workspace에는 install lifecycle script가 없다. Prisma 설정은 optional URL이며
[URL 없는 generate 지원](https://github.com/prisma/web/blob/main/apps/blog/content/blog/announcing-prisma-orm-7-2-0/index.mdx)에 해당한다.
별도 migration·seed·DB 연결은 하지 않았다.

npm ci 교체 대상의 absolute/realpath를 설치 전에 확인했다.
root H:/Project/ai-chat-hub/node_modules는 저장소 안의 일반 디렉터리이며 symlink/junction이 아니었다.
packages/chat-core/node_modules, packages/ui-tokens/node_modules, apps/mobile/node_modules는 없었다.
수동 재귀 삭제 명령·process 종료·전역 설치·npm 설정 변경은 사용하지 않았다.

실행 위치는 로컬 PC PowerShell, H:/Project/ai-chat-hub, 기존 Node 22/npm 환경이다.
production 자격증명은 필요 없고 전달하지 않았다. Windows/PATH/user/cache/temp 변수만 child에
allowlist로 전달하고 존재하지 않는 .os-f4-absent-env-file을 DOTENV_CONFIG_PATH로 지정했다.
DOTENV_CONFIG_QUIET=true/NEXT_TELEMETRY_DISABLED=1도 child에만 적용했다.
.env·원 창 환경·사용자 설정을 바꾸지 않았으며 npm cache/log만 정상적으로 사용했다.

설치 시작 2026-09-09T02:12:46.156Z, 종료 02:13:46.338Z, exit 0.
Prisma Client 7.10.0은 node_modules 아래 생성됐고 생성 schema가 N schema와 LF 정규화 후 같았다.
이는 generated output 대조이며 승인 raw hash에 LF 정규화를 적용했다는 뜻이 아니다.

기존 node_modules는 npm ci가 교체했다. 임의 수동 설치 수정의 자동 백업은 없고,
선언된 dependency는 해당 lock으로 재구성할 수 있다. 원문/source는 삭제하지 않았다.

## 3. 설치·실행 환경 재검증

| 관측 | 결과 |
|---|---|
| Node / V8 / OpenSSL | v22.22.2 / 12.4.254.21-node.39 / 3.5.5 |
| OS / architecture | win32 / x64 |
| tsx / TypeScript | 4.23.13 / 6.0.3 |
| esbuild / win32-x64 | 0.28.1 / 0.28.1 |
| Prisma / Client | 7.10.0 / 7.10.0 |
| js-yaml N lock / installed / hidden lock | 4.3.2 / 4.3.2 / 4.3.2 |
| version / hidden-lock mismatch | 0 / 0 |
| required missing | 0 |
| npm ls --all --json --offline | exit 0, error=null |

PSV-F1 정정대로 non-root/non-link 존재 항목 927개는 node_modules 924개와 workspace directory
3개다. link 3개는 별도이며 workspace와 중복 package로 세지 않는다.
optional 미설치 175개는 이전과 같고 OS/CPU 제외 164개와 그 밖의 11개로 구별한다.

924행 inventory SHA는 da51cfba9083e21086a94af80ee00e3278c228e1b3775b1f4972f15b43ea181a다.
N lock의 insertion order에서 node_modules/·non-link·존재 package.json만 선택하고,
path/expectedVersion/actualVersion/packageJsonSha256/optional 순서 객체를 사용한다.
optional은 Boolean(lock.optional)이며 devOptional을 OR하지 않는다.
JSON.stringify(rows)의 UTF-8/BOM 없음/끝 LF 없음 bytes를 hash한다.
이는 package.json/version metadata 대조이며 모든 설치 파일/tarball integrity 감사는 아니다.

npm ls에는 기존 optional 경로의 extraneous label 두 개가 남는다:
@emnapi/runtime 1.11.3과 @img/sharp-wasm32 0.35.4.
두 physical path는 N lock의 optional=true·같은 version에 결속된다. 새 missing/invalid가 아니며
이를 없애려고 dedupe/lock 수정을 하지 않는다. 전체 npm ls 출력 SHA는 그 실행 관측으로만
기록하고 동일 설치 상태의 결정적 fingerprint로 사용하지 않는다(PSV-F2).

실제 --conditions=react-server --import tsx 조건에서 기존 G01–G04의 UTF-8 bytes/길이/
raw SHA/LF SHA를 재계산했다. G05 공개 key/signature 검증은 정상 true,
signature bit 변경 false, message 변경 false다.
이 probe는 공개 reference arithmetic/verify만 수행했다. protocol module import, private key,
keygen/signing, 새 Proxy/bytes case 또는 기존40 unit/구현 시험이 아니다.

## 4. 지원9·승인·CI와 움직인 원격 ref

N의 지원9 Git blob·working raw bytes, PB basis M→N diff·기존 T→N diff를 다시 결속했다.
N의 package.json에는 T 대비 이미 병합된 script 2개 추가가 있고 lock에는 js-yaml 변경이 있다.
이는 이전 중단 기록에 식별한 upstream 변화이며 이번 설치가 수정한 것이 아니다.
기존 script/flags와 dependency 선언·overrides 등은 그대로다.

승인/전사 원문·protocol/test/fixture 41개 N raw hash가 모두 일치했고,
상위 원문22개는 원 commit·N bytes와 ancestry를 재확인했다. 핵심 계보19개도 보존됐다.
PB receipt의 decision=yes, mposition, 2026-09-08, PB-D1–D5/D2·D3 불가분 수용을
동일 원문에서 확인했다. 원 decision §13 공란과 원 SHA, 기존 receipt의 과거 null/false를 보존했다.
PB 승인 대상과 이번 환경 증거 hash를 혼동하지 않는다.

N tracked/working discovery는 server632/client4로 일치한다. runner·package flags·tsconfig를
실제 N에 결속했다. discovery digest는 정렬된 상대 / 경로 목록을 LF로 잇고 끝 LF를 붙인다.
OI-F4의 quoted server 경로 39,347자와 full-suite runner 한계는 남는다.
test:unit은 단일 파일 filter가 아니며 runner를 변경하지 않았다.
목록 대조는 전체 unit 실행이나 B19 기존40 unit 기준선 증거가 아니다.

N CI는 정확한 headSha/event=push/branch=develop/attempt=1에서 재조회했다.
[Admin 34298297550](https://github.com/mposition/Tomverse/actions/runs/34298297550)의 실제 build/E2E,
[Credit 34298297644](https://github.com/mposition/Tomverse/actions/runs/34298297644)의
7개 실제 lane 및 집계가 모두 성공했고 9 check도 전부 success다.
실패 전용 upload/report만 skipped다. M1295=8b5168e1…의 cancelled 두 run과
Credit aggregate failure를 N 성공으로 덮어쓰지 않았다. CI rerun/dispatch는 하지 않았다.

작업 중 2026-09-09T02:16:23.655Z의 원격 develop은
366deb06fa3ed6bf89826f4f2e31702fad93895f로 전진했다.
N의 후손이며 별도 router-judge 작업 5파일(package.json 포함) 변화다.
**이번 대상은 계속 N이다.** 후속 tip을 checkout하거나 그 CI·실행 환경까지 검증했다고 주장하지 않는다.
자동으로 최신 tip을 쫓아가며 설치 대상을 바꾸지 않았다.

## 5. 검사·보존 및 다음 단계

실제 N checkout에서 기록 작성 전 package script 7개를 그대로 실행했다.

| script | 작성 전 exit |
|---|---|
| check:encoding:strict | 0 |
| check:policy-section-references | 0 |
| check:release-records | 0 |
| check:memory-eval-succ9 | 0 |
| check:memory-extraction-eval | 0 |
| check:memory-eval-freeze | 0 |
| check:doc-references | 0 |

7개 모두 exit 0으로 기준선 실패 이름은 0개다. 이전 W와 다른 document/reference 출력은
checkout 대상 차이이며 새 실패로 세지 않는다. audits가 일반 reference 검사에서 제외되는
한계 때문에 신규 기록은 fatal UTF-8/JSON·상대 링크·hash·whitespace를 별도로 대조한다.
작성 후 같은 7개 script를 다시 실행해 모두 exit 0, 전후 출력 SHA 7/7 동일을 확인했다.
기준선/사후 실패 이름과 신규 script 실패는 0개다.
2026-09-09T02:21:43.462Z에 fatal UTF-8/JSON, 상대 링크4개, inventory 산식과 보호87개
raw hash 불변, HEAD=N/준비 branch/tracked clean, 새 파일2개만 존재함을 대조했다.
일반/staged diff --check는 exit 0이며 새 파일 no-index --check는 차이 exit 1이다.
whitespace 진단은 없고 기존 core.autocrlf의 LF→CRLF 안내만 있었다.
보존용 보조 명령의 최초 긴 인라인 입력은 Windows os error 206으로 실행 전 거절됐고,
필요한 path/hash/status만 전달하도록 입력을 줄여 같은 보존 검사를 통과했다.
이는 저장소 test:unit 실패나 runner 수정이 아니다. 결과 전사 후 최종 보존도 다시 확인한다.

설치 뒤 2026-09-09T02:17:33.149Z 검사에서 post-checkout 보호87개 raw hash,
package/lock/prisma config/schema가 전부 보존됐다. 최초 W→N checkout 때 바뀐 지원파일은
package/lock 두 개이며 설치 때문에 바뀐 것은 아니다. tracked/index clean이다.
그 뒤 위 검증을 통과한 N에 새 codex/memory-eval-vnext-oi-f3-b-implementation branch를 만들었다.
새 commit이나 구현은 없다. 기존 검증 branch와 untracked/ignored는 보존했다.

다음 작업은 이 **고정 N branch/설치 상태**에서 별도 지시를 받은 5파일 구현이다.
그때 코드 변경 전에 B19 기존40 unit 기준선 증거를 확보해야 한다.
현재 preStartRevalidationComplete=true는 한정 환경 Gate 완료이며 실제 착수 지시·B19·
AC-12/B24 전체 완료나 F07 구현 충족을 뜻하지 않는다.

OI-F1 timing gap/closure=false, OI-F2 별도 ID/path, OI-F4 별도 runner,
ODR-F1 외부 closure 없음, 상위54 AC partial9/deferred45/fullySatisfied0,
PB R1 확인 검토 1/1 소진 상태를 유지한다.
C02 변경, scorer/ledger/full P, S2 activation/dataset/register/manifest, holdout/S5/v9 prompt,
key/trust 운영, pair/예산/dispatch/provider/DB/Railway/release gate/memory flags는 범위 밖이다.
