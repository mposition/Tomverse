# OI-F4 실제 착수 재검증 V — 독립 검토 보고서

## 0. 검토 대상과 검토자

| 항목 | 값 |
|---|---|
| reviewCommit V | `1f34a6fb0d61b8704d656fee7638a93c9ef42c75` |
| V parent = 고정 tip T | `aafdceca3e4270ff146077c02f480ba3fd68c9f4` |
| branch | codex/memory-eval-vnext-oi-f4-start-tip-revalidation |
| V의 변경 | 두 파일 **A(추가)뿐**, tracked/staged 비어 있음, commitCount 1 |
| Markdown | `.github/audits/memory-eval-vnext-oi-f4-start-tip-revalidation-2026-09-10.md` — raw SHA-256 `452d7b80399d2eff66f5ed32998ba6d1a1a7544af9e5533ec07eb810cc4fc16c`, 19,606 bytes, 281 LF, strict UTF-8, Git=working |
| Evidence JSON | `.github/audits/evidence/memory-eval-vnext-oi-f4-start-tip-revalidation-2026-09-10.json` — raw SHA-256 `20d7e09d66cd1f7f3bd2a3c2c0938e643bd785d7f2194cd6a68d57e70208df87`, 197,254 bytes, 3,296 LF, strict UTF-8, Git=working |
| 관측 시각 | 2026-09-10T08:47:10Z ~ 08:49:28Z (UTC) |

검토자: 독립 reviewer로 실행된 Claude(Anthropic) 에이전트. 정확한 모델 빌드 식별자는 제공된 도구로 확인할 수 없어 **not independently verified**로 표기합니다. 작성자(Codex)의 자기 판정은 근거로 쓰지 않았습니다.

## 1. 수행한 도구/검사

- `identity`, `list_paths`, `git_diff`(B→T 전체·package.json, sync→T), `hash_paths`(14 경로 @T), `read_blob`(V MD 전문, AGENTS.md 61,198자 전량 4구간, AWR 전문), `read_json_section`(document, hashBinding, identity, authority, facts/ancestry, facts/discovery 4 스칼라, originalDecision, discoveryAddedFromB, extraneousPhysicalBindings, comparisonWithApprovedPackageBasis, knownResiduals, ci 대체 확인, deployment, documentationValidation, nextStep, exclusions, method)
- `run_baseline_checks`(V tree, 자격증명 없는 child), `preservation`, `github_status`(pr1323 / admin_run / admin_jobs / finance_run / finance_jobs / develop), `gateway_source`(environment, checks)
- **실패**: `installation_and_discovery` 전 section — `Cannot find module 'js-yaml'`(temp 경로에서 require 해석 실패). 재시도 2회 동일.

수정·stage/commit/push/branch/checkout·PR·병합·install/dedupe/generate·승인/closure/flag 변경·provider 호출·추가 subagent 실행은 **하지 않았습니다.** 파일도 쓰지 않았고, 본 보고서가 유일한 산출물입니다.

## 2. 독립 재계산으로 확인된 사실

1. **결속·범위** — JSON `/document`는 `{path, rawSha256 452d7b80…, bytes 19606, lfCount 281}`로 Markdown만 지목하고 `/hashBinding`은 `selfHashStored:false`, `approvalHashesAreSeparate:true`. 내가 다시 계산한 두 blob 해시/바이트/LF가 전부 일치하며, JSON 자기 hash나 승인 문서 hash와의 혼용은 없습니다.
2. **원 SHA 보존 병합** — GitHub REST: PR #1323 merged, `merged_at 2026-09-10T07:58:27Z`, `merge_commit_sha = T`, headSha `2ce7b596…`, base develop. T parents = `04e18713…`, `2ce7b596…`. A/CA/B/R/WR-1/AWR/sync 14개 SHA 모두 T·V의 조상(`identity.ancestry` exit 0 상당). squash/rebase 대체 없음.
3. **승인4 / 지원9 / 원 decision** — T에서 재계산한 승인4 raw SHA(`420f8876…`, `ccc42634…`, `37b17d9f…`, `c1c919a8…`)와 지원9 Git/working 해시가 문서 표와 **문자 단위로 일치**. 원 decision은 Git `355f8387…`/400 LF, working `f10c6eff…`(CRLF)로 문서 서술과 일치하며 승인 bytes 변경·일치 혼동 없음. §13 공란 보존 확인(JSON `/originalDecision.section13`).
4. **B→T 의미 불변** — `git diff B..T -- package.json`은 `benchmark:router:collect`, `test:router-development-collector` **두 script 추가뿐**. B→T 전체 name-status에서 지원9 중 변경된 것은 package.json 하나뿐임을 확인.
5. **checkout delta** — `git diff 2ce7b596..T` = 정확히 8파일(model lifecycle/catalog 계열)이며 지원9·승인4·보호 목록과 교집합 없음. 문서 §2 주장 확인.
6. **discovery 654** — 검사 스크립트의 `nativeSpawn.serverCount = 654`로 서버 직계 목록 수를 재관측. B→T 추가 시험 파일은 직계 5건(lifecycle 1 + collector 4) + 하위폴더 `tests/server-contract/...` 1건이므로 649→654 설명이 성립.
7. **기준선 검사(V tree 재실행)** — 7개 npm 검사 exit 0이며 출력 SHA-256 8개가 문서 §8 표와 **모두 동일**(`7d519526…`, `186e01d8…`, `5d216eab…`, `f792af65…`, `575a56ba…`, `8318af98…`, `5a51c6dd…`, test:unit `30da9d3e…`). `npm run test:unit` exit 1(배너만), 동일 argv 직접 spawn = `ENAMETOOLONG`/status·signal null/0 bytes. T01 74 tests/74 pass/0 fail. cache wiring 12 tests/11 pass/1 fail, 실패 이름 **“promptCachePath is not passed from a file the map does not know”**, 위치 `tests/anthropicPromptCachingWiring.test.mjs:332`, 대상 `app\api\chat\compare-summary\route.ts`. 문서 서술과 완전 일치하며, focused 실행의 출력 hash만 duration 때문에 달라진다는 문서 설명(`documentationValidation.comparisonBeforeAfter`)도 재현되었습니다.
8. **CI 실체** — Admin Console E2E 34452681335: headSha=T, push/develop, attempt 1, success이며 step 수준에서 `Production build`·`Run the Admin Console E2E suite` success. Credit Finance DB Integration 34452681336: 동일 헤드/이벤트/attempt, **실제 7 lane**(email/assistant/finance/accounts/import/memory/routing) 모두 success + 집계 job `Require every lane to have passed` success. headline만 인용한 흔적 없음.
9. **보존** — `preservation`: 보호 목록 전 항목 expected == actual, 승인4 working=Git, hidden lock `9cd03955…` 일치, stash 출력 hash·.env metadata(크기/mtime만) 관측, 환경/설정 내용은 읽지 않음. 기존 untracked 항목은 그대로이고 **target 2개만 nowTracked=true**(V 발행의 후속 결과).
10. **권한 경계** — AWR 원문(§4·§5)은 3파일 allowlist, `implementationStartAuthorizedNow:false`, closure/activation/paid 전부 false, 별도 명시적 착수 지시 요구를 규정합니다. V의 YAML/`/authority`/`/exclusions`/`/nextStep`은 이를 그대로 보존하며 S2 activation·full P·scorer/ledger·dataset/register·holdout/S5/v9/pair/key/budget/flags를 모두 닫힌 상태로 유지합니다. V가 새 사람 승인·구현·전체 suite PASS·OI-F4 closure를 주장하는 문장은 없습니다.

## 3. 미검증(gateway 제약) — 명시적 목록

- **설치 metadata 전부**: node_modules metadata 924 / workspace 3+3, 필수누락·version·hidden mismatch 0, optional 미설치 175(플랫폼 164 + 그 외 11), `npm ls --all --json --offline` exit0·extraneous 2, inventory SHA `da51cfba…`, runtime/js-yaml 버전 표. → `installation_and_discovery` 도구 오류로 **재계산 불가**. 다만 문서 §5·JSON `/method.collectionScript`의 산식(lock 순회, optional/devOptional 분기, `supported()` 플랫폼 판정, inventory 직렬화 규칙)은 원문으로 검토했고 `metadata 검사 ≠ 설치 bytes/tarball/Prisma/운영 readiness`라는 구분이 문서에 명시돼 있음을 확인했습니다.
- **client 4**, server/client 목록 LF-joined hash, `naiveQuotedUtf16IncludingNull = 41014`, `conservativeCost = 80043`의 수치. → 산식(`argv.map(x=>'"'+x+'"').join(' ').length+1`, `1+Σ(2·len+3)`)과 “실측 아님” 표기는 확인했으나 값 자체는 재계산 불가.
- **Railway**: 이 gateway에는 Railway 접근 권한이 없습니다. deployment `8a4e67aa-cab9-4b51-a1b1-312f2fec8e02`/T SUCCESS는 JSON `/deployment.rawMetadata`에 결속된 **작성자의 과거 읽기 전용 관측**이며, 저는 재조회하지 않았습니다. 문서는 staging 한정·production 미증명·후속 `b880bc4e…`는 WAITING으로 제외를 명시하고 있어 과장은 없으나, **현재 active 배포 상태는 이 검토로 확인되지 않습니다.**
- **Git config 내용**: 도구가 hash만 반환하므로 §8.1의 “다른 두 branch 추적 section만 제외 시 이전 SHA 재현”이라는 논리 자체는 검증 불가이며, 변경 주체도 미확인 상태 그대로입니다.
- 임의 reviewer script 실행이 지원되지 않습니다. 아래 V-F3 참조.

## 4. Finding

| ID | Severity | 위치 | 근거 | 실제 영향 | 최소 수정 |
|---|---|---|---|---|---|
| **V-F1** | P3 (정보) | MD §8.1 / JSON `/knownResiduals/2` | `preservation`(2026-09-10T08:49:28Z) 현재 config hash `011874ca2449ef7a060ce8a71bf9d094b084bc8c7c22c39bc3992ca2c644f833` — 문서가 기록한 시작 `e3cab8eb…`, 이후 `0978548a…` 어느 쪽과도 다름. V branch 발행에 따른 추적 section 추가가 유력하나 **원인 미확인** | 승인 경계·판정에는 영향 없음. 문서가 이미 “전체 bytes 보존 PASS 아님·주체 미확인”을 명시하므로 과장은 아님. 다만 독자가 `0978548a…`를 현재 값으로 오독할 여지 | 수정 불필요. 후속 기록을 쓸 때 발행 이후 config hash를 별도 시점으로 추가 기록하고 provenance 예외를 그대로 유지 |
| **V-F2** | P3 (검토 커버리지) | MD §5 전체, §6의 client 4·41,014·80,043 | `installation_and_discovery` 도구 3회 모두 `MODULE_NOT_FOUND: js-yaml` | 해당 수치는 이번 검토에서 **unsupported(미검증)**. 문서 결함 증거는 발견되지 않음 | 문서 수정 불필요. 착수 시점에 같은 tip·같은 설치라면 §5 재사용 전에 동일 스크립트를 저장소 루트 해석 경로에서 1회 재실행해 수치를 갱신 관측 |
| **V-F3** | P3 (방법론) | JSON `/method.collectionScript`, `/method.checksScript` | 두 스크립트가 이 검토 gateway의 `environment`(sha256 `7ef3fff3…`)·`checks`(sha256 `222d8a3a…`) 구현과 동일(HEAD assert 값만 상이) | 내 재관측은 “동일 코드의 재실행”이지 독립 구현에 의한 교차검증이 아님. 결과 일치의 증거력이 그만큼 제한됨 | 수정 불필요. 향후 기록에서 재현 근거를 인용할 때 “작성자 제공 스크립트 재실행”임을 계속 구분해 표기 |

**차단(P0/P1/P2) 0건.** 문서가 기존 사실을 과장·치환하거나, 승인되지 않은 권한을 여는 문장, 미래 assertion을 “기존 실패”로 선점 분류하는 문장, WR01–WR20 검증/batching 구현을 수행한 듯한 서술은 발견되지 않았습니다. 시점 귀속도 문제없습니다 — `recordCommit:null`·`publicationPerformed:false`·“아직 untracked”는 작성 시점의 사실 보존이며, 이후 사용자 지시로 이루어진 V commit/push와 이번 외부 검토는 그 기록을 무효화하지 않습니다(오히려 §9가 “이후 발행 시 실제 Git SHA를 별도로 고정한다”로 그 경로를 열어 둡니다).

## 5. 판정

**PASS_WITH_WARNINGS**

- 근거: V의 identity·두 blob·단방향 결속·추가 범위, 승인4/지원9/원 decision bytes, 14 SHA ancestry와 원 SHA 보존 merge, B→T script 2건 한정 변경, 서버 discovery 654와 649→654 설명, 8개 npm 검사 exit/출력 hash, T01 74/74, cache wiring 11/1 + 정확한 실패 이름·경로, test:unit exit1 및 ENAMETOOLONG, 두 CI run의 실제 build/E2E·7 lane step, 보존 대조가 모두 독립 재계산과 일치했습니다.
- 경고: §5 설치 수치·client 4·argv 길이 추정치·Railway 현재 상태·config 내용은 이 gateway로 **검증할 수 없었습니다**(V-F1~V-F3). 해당 항목에 한해 이 검토는 부분적으로 미완입니다. 다만 기록의 승인 경계·계보·기준선이라는 핵심은 전부 검증되었으므로 전체 INCOMPLETE로 내리지 않습니다.

## 6. 남은 조건과 다음 지시

1. 이 검토는 **새 사람 승인, runner 구현 인수, 전체 unit suite PASS, OI-F4 closure, activation, 유료 실행 승인 중 어느 것도 아닙니다.** AWR §5와 V §9의 순서가 그대로 유효합니다.
2. 구현은 **사용자의 별도 명시적 착수 지시**가 있어야 하며, 범위는 `scripts/run-unit-tests.mjs` 수정, `scripts/run-unit-tests-core.mjs` 신규, `tests/unitTestRunner.test.mjs` 신규(R01–R03) 세 파일뿐입니다. 그 외 package/lock/설치/workflow/tsconfig/release gate·기존 승인 bytes·dataset/register/purpose·holdout/S5/v9/pair/key·예산/dispatch/provider·운영 DB·flags는 계속 닫혀 있습니다.
3. 착수 tip이 T가 아니면(현재 origin/develop은 `5ad7162354eb3480267eb25edd7d1fa8993bf8cb`까지 전진해 있음) 달라진 부분부터 재검증해야 하며, 이 기록의 §5·§6 수치는 동일 tip·동일 설치에서만 재사용 가능합니다. 재사용 전 V-F2의 1회 재관측을 권합니다.
4. 차단 0건이므로 설계 변경, 대규모 형식 정리, 재승인 루프는 **요구하지 않습니다.**

*본 검토에서 수정·Git 쓰기·설치·운영/provider 호출·추가 검토(subagent 포함)는 일절 수행하지 않았습니다.*
