# memory-eval vNext — OI-F2 M3 실제 구현 착수 관측

작성자: Codex. 작성일: 2026-09-10.
이 기록은 기존 승인에 따른 착수 조건의 관측이며 새 정책 승인·독립 검토·외부 closure가 아니다.
[동반 evidence](evidence/memory-eval-vnext-oi-f2-m3-start-observation-2026-09-10.json)는 이 문서 raw SHA에 결속한다.

## 1. 고정 기준과 지시

사용자의 이번 지시는 “네 모니터 종료하고 다음 작업으로 넘어가주세요”다.
이를 기존 승인된 M3 3파일 구현 진행으로 해석했으며, 구현 전 대화에서 범위와
commit/push/PR/activation 미포함을 명시했다. 새 IP 정책 승인이나 과거 receipt의 시점 필드를
수정하는 지시로 해석하지 않는다.

- 실제 착수 basis F: f016c1e20b78e9405080ae73de37c345466b6af1
- 새 branch: codex/memory-eval-vnext-oi-f2-id-path-implementation
- 승인 대상 R2: 13a6b088cd88d53d971e66f358e297b8c71c6ad7
- authoritative IP receipt AIP: b8d96f0f19f51f0bb6296b06dbc986bc6df7e47b
- V: 1d21c9392b19d403d83dfb71a0c391cd329ee553
- ISV-F1 보완 C: 1c0ddb728d16f49352867231233094f1ad7c7c3f
- PR #1310 merge M: 1fcd9654fd5682ce8632a4f5de103f7c7d4a41a3
- 이전 실제 tip T: 89288a8671ef25c30084b71f8a9266a3ae9f5475

R2/AIP/T/V/C/M 및 상위 승인 계보는 F의 조상이다. F는 성공한 develop descendant를
명시 고정한 것이며 이후 계속 이동하는 origin/develop 최신값을 의미하지 않는다.
모니터 oi-f2-pr-1310-develop-ci는 PAUSED로 종료했다.

## 2. 승인 원문과 변경 범위

승인 receipt의 decision=yes, approvedBy=mposition, approvedAt=2026-09-09,
IP-D1–IP-D5 수용을 대조했다. 원 패키지의 pending 및 receipt의
implementationStartAuthorizedNow=false는 작성 당시 이력으로 불변이다.

| 승인 대상 | raw SHA-256 |
|---|---|
| memory-eval-vnext-oi-f2-id-path-approval-package-draft-2026-09-09.md | 14e0b11f71991c30e4bde14a0b502b1b1cce678a095fbd957e4b62e3ffbce2d0 |
| evidence/memory-eval-vnext-oi-f2-id-path-approval-package-2026-09-09.json | 12a2b3fb145b2807529450dda8c091d78d4a47bfb80814f368185aecb1cf6ab0 |
| memory-eval-vnext-oi-f2-id-path-approval-2026-09-09.md | 9f505ed184a487db2f03f9799fa4ab3f8466c8fdba4fde7ce5888b82d7c40f9a |

구현 변경 allowlist는 다음 셋뿐이다.

- lib/memoryEvalVnext/protocol/wire.ts: isAsciiId/private isRelativePath 및 직접 주석.
- tests/memoryEvalVnextWire.test.mjs: IP01–IP15 별도 등록/완료 집합·독립 기대표 및 승인된 B19 projection 조정.
- tests/fixtures/memory-eval-vnext/wire-vectors.json: 기존 15 key/값/순서 유지, idPathPolicy만 마지막에 추가.

C01/C03/C04, Proxy/bytes intrinsic helper, export/import/builtin/dependency/runner/static gate는
변경하지 않는다. 이 별도 사전 관측 두 파일은 구현 소스 allowlist를 늘리지 않으며
이번 구현 commit은 아직 만들지 않았다.

## 3. 환경과 지원 파일 재결속

F에서 source45 원문 Git hash, support9의 Git/working hash, 승인 4파일과 계보를 다시 계산했다.
support9 상세값은 JSON.binding.supportFiles다. 승인 basis 대비 package.json에는 관련 없는
script 9개 추가, policy-section checker 변경이 있고 기존 script 및 non-script manifest 값은 같다.
T→F의 support 차이는 package.json에 script 5개 추가뿐이다.
lock·runner·기존 dependency 선언 불변, 설치/재설치·환경변수·Git config 변경 없음.
CRLF 차이는 메모리 안에서만 비교했고 파일을 정규화하지 않았다.

- Node v22.22.2, npm 10.9.7, tsx 4.23.13, TypeScript 6.0.3; win32/x64.
- 설치 node_modules metadata 924행, workspace directory 3개, link 3개.
- version mismatch/required missing/hidden-lock mismatch 모두 0.
- optional 미설치 175개 중 OS/CPU 제외 164개. 나머지 11개도 optional로 구분.
- npm ls --all --json --offline: exit 0, root error 없음.
- 기존 optional extraneous 2개는 lock의 exact path/version/optional=true와 대조.
- 설치 inventory SHA: da51cfba9083e21086a94af80ee00e3278c228e1b3775b1f4972f15b43ea181a.
- G01–G04 public bytes/hash, G05 public Ed25519 valid/두 mutation 기대값 통과.
- 설치 전체 bytes/tarball integrity·모든 generated Prisma readiness·production readiness 보장은 아니다.

child에는 OS/PATH/TEMP/user-cache allowlist와 부재 .os-f4-absent-env-file 지정만 전달했다.
production 자격증명·DB/provider 호출 없음. runtime probe에는 protocol import/keygen/signing이 없으며
기존 T01의 승인된 volatile synthetic test만 별도로 실행했다.

## 4. CI와 변경 전 시험 기준선

F의 아래 push/develop 실행 attempt 1, headSha=F, completed/success를
2026-09-10T02:41:29.623Z GitHub API 관측과 결속했다.

- [Admin Console E2E 34429318445](https://github.com/mposition/Tomverse/actions/runs/34429318445): 실제 Production build/Admin E2E step 성공.
- [Credit Finance DB Integration 34429318426](https://github.com/mposition/Tomverse/actions/runs/34429318426): 7개 실제 DB lane 및 aggregate 성공.

이는 F의 CI이고, cancelled인 M의 CI를 성공으로 바꾸거나 앞으로의 구현 CI를 대신하지 않는다.
사용자 배포 완료 발언을 별도 production API 관측으로 바꾸지 않는다.

변경 전 tracked/index clean인 F에서 package script를 실행했다.

| 검사 | 변경 전 결과 |
|---|---|
| check:encoding:strict | exit 0 |
| check:policy-section-references | exit 1: 기존 §3.6 참조 6건 |
| check:release-records | exit 0 |
| check:memory-eval-succ9 | exit 0 |
| check:memory-extraction-eval | exit 0 |
| check:memory-eval-freeze | exit 0 |
| check:doc-references | exit 0 |
| test:unit | exit 1; 실제 시험 출력 없음 |
| 별도 한정 T01 | 59/59 pass, fail/cancel/skip/todo 0 |

기존 참조 실패는 docs/ops/ai-review-eval-scoring-contract.md:621,
scripts/report-ai-review-judged-denominators.mjs:10/14/113/288,
tests/aiReviewJudgedDenominators.test.mjs:3의 §3.6이다. 이 범위에서 고치지 않으며
변경 후 같은 이름·진단과 대조한다.

runner discovery는 server 648/client 4, Git/working 목록 일치다.
전체 runner는 648개 absolute path를 한 Windows spawn에 전달한다.
같은 executable/server flags/path 인수의 별도 native spawn 관측은
status=null/error=ENAMETOOLONG, stdout/stderr 0 bytes였다.
OI-F4는 별도 작업이며 runner 실패를 unit 통과나 설치 불일치라고 부르지 않는다.

단일 파일 filter script가 없으므로 실제 runner server flags를 그대로 옮긴 별도 한정 실행:
node --conditions=react-server --import tsx --test --test-concurrency=1 --test-reporter=spec --test-reporter-destination=stdout tests/memoryEvalVnextWire.test.mjs

원 original14/B19 SHA 1d286a257c44d3444de99b945a8276cd680b8b30adc41bf0fc5df32a5f4123ca와
original15 SHA e59c8ef30d4dae1430e113392d63924e9d2a77cd764edd8297e59ed2d987e652를
구현 전 확보했다. 새 IP 시험은 이 사전 관측 시점에 아직 작성/실행하지 않았다.

## 5. 보존과 남은 검증

기존 untracked는 이번 git ls-files --others --exclude-standard --directory 열거 기준 34항목이며
파일은 raw hash, 디렉터리는 존재만 확인한다. 과거 git status의 축약 31항목과 같은 수라고
주장하지 않는다. 내부 재귀 검사는 하지 않았다. config는 이전 기록 이후 다른 branch 설정이
늘어 현재 hash를 별도 기준으로 수집했고 이 작업은 쓰지 않았다. stash 17개,
.env/.env.local metadata 및 hidden lock도 보존했다.
C→F checkout에서 보호 목록의 raw bytes 변화는 upstream package.json뿐이었다.

이 기록 시점에 IP 구현/외부 검토는 아직 미실행이다. 향후 IP01–IP15 실제 실행과 3파일 diff를
확인해야 하며 IP16–IP20은 external_repository_audit로 남긴다.
OI-F2 외부 closure, full F07/full P, 상위54 AC full 승격은 선언하지 않는다.
OI-F1/ODR-F1 closure=false, OI-F4 runner, BI/BFR 잔여 및 partial9/deferred45/full0를 유지한다.
S2 activation/purpose, dataset/manifest/register, holdout, S5/v9 prompt, pair,
예산/dispatch/provider, 운영 key/서명, release gate 및 두 memory flag 변경은 없다.

문서 관리 skill은 원 승인 bytes와 관측·판정을 분리하는 데만 적용했다. 규제 인증이나 새 승인
절차를 만들지 않았다. tdd-guide는 승인된 IP AC를 실패 시험→최소 구현→회귀 검사로 연결한다.

## 6. 후속 구현·검증 관측 — 사전 기록 이후

이 절과 JSON.postImplementation은 §§1–5의 사전 관측 이후인 2026-09-10T03:05:25.207Z까지의
로컬 결과다. 앞의 “아직 미실행”은 사전 시점의 사실로 보존하며 최종 상태는 이 절에서 구분한다.
새 구현 commit/원격 CI/독립 검토/사람의 완료 판정은 아직 없다.

tdd-guide의 RED→GREEN 순서로 승인된 15개 IP named group을 먼저 작성했다.
기존 C02에서는 74개 중 64 pass/10 fail이었다. 실패는 IP01–IP06/IP08/IP09/IP13 및
이들 미완료를 잡은 IP15였다. 기존 F 40/B 19는 RED에서도 전부 통과했다.
그 뒤 C02의 두 predicate 및 직접 주석만 수정했다.

- 최종 T01: 74/74 pass = F 40 + B 19 + IP 15. fail/cancel/skip/todo 0.
- test:unit: 전후 모두 exit 1, 출력 raw SHA 동일. 기존 ENAMETOOLONG runner 문제 유지.
- 7개 package 검사: 전후 exit·진단·출력 raw SHA 7/7 동일. 문서 참조 오류 6건은 기존 그대로,
  다른 6개 script는 exit 0. 새 검사 실패 0.
- IP16–IP20 및 F/B external row는 실제 unit으로 등록하지 않았다. 외부 감사 완료 판정 없음.
- 승인 R2.futureCases와 T11/T01 독립 기대표의 네 field exact 일치.
- original14/original15 projection hash와 기존 fixture 15개 key/값/순서 보존.
- 기존 T01 F/B 본문은 승인된 B19 exclusion 한 줄 외 보존.
- C01/C03/C04, 지원 파일·승인 원문·기존 untracked/환경 metadata 보존.
- diff --check 통과, staged 0, tracked diff는 위 M3 셋뿐.

| 구현 working file | raw SHA-256 |
|---|---|
| lib/memoryEvalVnext/protocol/wire.ts | 2a14e73c43964d218b4b4085a077dda52b0c4fcbcd1dfba3217f355671ebbba0 |
| tests/memoryEvalVnextWire.test.mjs | 313a1be852c5ba78a6a9f87522a297716a3816180a09185db5b0f788da14fdde |
| tests/fixtures/memory-eval-vnext/wire-vectors.json | 89389622880f4e55093867e7baa502c28597d4fcdc8309dcdaa8461a83d95eed |

최종 hashes는 구현 working bytes 식별이다. 미래 Git commit SHA나 이번 감사 문서의 hash가 아니다.
full repository typecheck/lint/build, 구현 원격 CI, 운영 corpus 검사는 이번에 실행하지 않았다.
사전/후속 관측 두 감사 파일은 현재 untracked, 구현 3파일은 unstaged로 남긴다.
commit/push/PR/merge·activation·dataset/register/flags 변경은 수행하지 않았다.
