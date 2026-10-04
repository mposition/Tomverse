# OI-F4 V — 남은 방법론 경고와 판정 범위에 대한 독립 확인 보고서

## 0. 고정 대상·직접 관측 사실

| 항목 | 직접 관측값 (이번 세션) |
|---|---|
| V | `1f34a6fb0d61b8704d656fee7638a93c9ef42c75`, parents = T 단일 |
| T | `aafdceca3e4270ff146077c02f480ba3fd68c9f4`, parents `04e18713…`/`2ce7b596…` |
| branch / 범위 | `codex/memory-eval-vnext-oi-f4-start-tip-revalidation`, diff = 두 파일 **A(추가)뿐**, tracked/staged 공란, commitCount 1 |
| V Markdown | `452d7b80…4fc16c`, 19,606 bytes, 281 LF, strict UTF-8, Git=working ✔ |
| V JSON | `20d7e09d…08df87`, 197,254 bytes, 3,296 LF, strict UTF-8, Git=working ✔ |
| 새 scope note | `3d42f22372b0daff741e777519569850671ca7e75f3b9b85afbca3526b0b1485` (4,269 bytes) — V tree 밖 작성자 기록 |
| 최초 prompt / 최초 보고서 / 후속 note / 1차 확인 prompt·report | `57314590…`, `e654ea05…`, `6a6eb399…`, `dc1fb55f…`, `2c4fa625…` — 모두 지시서의 hash와 일치, 원문 불변 |

INCOMPLETE 중단 사유 없음. 관측 시각(UTC): identity 09:29:15.435Z · scope_evidence(probe/pr1328/v_checks/runner_probe/jobs) 09:29:42.558Z 전후 · installation_and_discovery 09:29:58.061Z · preservation 09:30:04.238Z · reviewer_query raw rows 09:30:25.988Z(1회 캐시) · run_baseline_checks 09:30:41.876Z · config_projection 09:30:51.828Z.

읽은 원문: **AGENTS.md 전문 61,198자 전량(3구간)**, **V Markdown 전문 14,510자**, V JSON `/document`·`/hashBinding`·`/authority`·`/exclusions`, 최초 prompt·최초 보고서·후속 note·1차 확인 prompt·1차 확인 보고서·새 scope note 전문, `scripts/run-unit-tests.mjs`(V blob 전문), scope-evidence 도구 소스·probe preload 소스, prior_execution 기록(구 gateway 소스 포함).

---

## 1. 판정 범위 네 질문 — 원문 근거로 답함

**Q1. 최초 기준은 해당 잔여의 "정확한 기록"을 요구했나, "해결"을 요구했나 → 기록·구분만 요구했다.**
최초 prompt(`57314590…`) 도입부: “이 검토는 **문서 두 파일의 정확성·재현성·승인 경계 감사**이며 runner 구현 검토가 아닙니다.” §4.7은 “전체 Windows test:unit exit1과 직접 spawn ENAMETOOLONG, cache wiring 12중 11 pass/1 fail의 **정확한 이름과 경로를 구분**”하고 “알려지지 않은 미래 assertion을 기존 실패로 분류할 권한을 주지 않는지”를 볼 것을 지시한다 — 실패의 존재가 **전제**이고 대상은 그 서술의 정확성이다. §4.12는 V가 “전체 suite PASS/OI-F4 closure가 아님”을 점검하라고 하여 미해결 상태를 정상으로 못박는다. §5는 “차단0이면 불필요한 설계 변경·재승인 루프를 요구하지 않음”이라고 적었다. 어디에도 실패의 해결·운영 인수를 요구한 문장은 없다.

**Q2. 기록이 정확하고 미검증 범위가 명시돼 있어도 그 잔여들이 문서 감사 PASS의 필수조건인가 → 아니다.**
V 문서는 §6 표에서 `test:unit exit1 = 전체 suite 실행 완료/성공 아님`, ENAMETOOLONG, `12/11 pass/1 fail` + 실패 이름(`promptCachePath is not passed from a file the map does not know`)·파일·대상 route를 그대로 적고, §1 YAML `fullUnitSuitePassed:false`·`oiF4ClosureDeclared:false`, §5 “metadata 검사 ≠ 설치 bytes/Prisma/운영 readiness”, §7 “Railway staging 한정, production 미증명”, §8.1 “config 전체 bytes 보존을 PASS라고 하지 않는다, 변경 주체 미확인”을 명시한다. AGENTS.md의 상위 원칙(“검증 범위는 되돌릴 수 없는 것에 비례합니다 — 무엇이 복구 불가인지 한 줄로 적을 수 없으면 차단이 아닙니다”)도 같은 방향이다. 따라서 **기존 Windows launch 실패와 cache-wiring 1건 실패는 운영/구현 잔여이지 문서 결함이 아니며, 문서 감사 PASS의 필수조건이 아니다.** 작성자의 이의는 이 한도에서 타당하다.
단, 1차 확인 §7이 든 다른 사유(“모든 관측이 작성자 제공·단일 호스트 도구 안에서 이루어졌고 Railway 현재 상태·config 내용·주체가 미검증”)는 **문서 감사 범위 안의 증거력 문제**로 여전히 유효하다. 즉 §7의 결론(PASS_WITH_WARNINGS)은 유지되지만, 그 사유 목록 중 “실패가 남아 있기 때문” 부분은 범위 혼동 소지가 있다(아래 X-1). 나는 그 역사적 판정을 소급 변경하지 않는다.

**Q3. V-F3는 결함인가, 정보성 한계인가 → 정보성 한계(RETAINED_INFORMATIONAL). 구분 표기는 충분하다.**
이번에 나는 (a) `scripts/run-unit-tests.mjs`의 **V blob 원문**을 읽어 discovery 규칙(직계 `readdir(tests)` → `.test.mjs|.test.ts` → `.sort()` → `join(cwd,'tests',name)` 절대경로, client는 `tests/client` + `.test.tsx|.test.ts`)과 server argv(`execPath` + 정확히 그 7 flags + 파일들, `spawnSync`)를 직접 확인했고, (b) 작성자 산식을 쓰지 않고 내가 작성한 reviewer_query로 교차계산했다:

| 내가 쓴 query(요지) | 결과 | 문서 주장 |
|---|---|---|
| `records`: `starts(path,"node_modules/") ∧ ¬lock.link ∧ exists` → `{path,expectedVersion,actualVersion,packageJsonSha256,optional}` | count **924**, `sha256Json` **`da51cfba…ea181a`** | inventory 924 / 동일 SHA ✔ |
| `serverNames`: `ends .test.mjs ∨ .test.ts` → sort → `"tests/"+n` | **654**, `sha256LfJoined` **`24f48671…60ef7`** | server 654 / 목록 hash ✔ |
| 위 → `absolute()` → `prepend[execPath+7 flags]` → `len+2` 합 | count **662**, sum **40352** → 40352+661+1 = **41014** | `naiveQuotedUtf16IncludingNull` 41014 ✔ |
| 동일 파이프라인 → `2·len+3` 합 | sum **80042** → 1+80042 = **80043** | `conservativeCost` 80043 ✔ |

또한 1차 확인 §3(b)가 남긴 **execPath 공백**이 이번에 메워졌다: `runner_probe`(09:29:42.558Z)는 저장소 runner를 고치지 않고(전후 raw SHA `e6af763f…` 동일, 도구 소스가 before/after 바이트 비교 후 불일치 시 `runner_changed` 예외) spawn을 가로채지 않은 채 child-only `NODE_OPTIONS` preload로 **실제 runner 프로세스**의 `execPath=C:\nvm4w\nodejs\node.exe`, `entry=H:\Project\ai-chat-hub\scripts\run-unit-tests.mjs`, `cwd=H:\Project\ai-chat-hub`만 보고했고, 이는 `installation_and_discovery(environment).runtime.execPath`와 **일치**한다(내가 41014 계산에 쓴 문자열과 동일). 이 계측 출력(exit 1, 배너+probe 1줄)은 **원 시험 출력도 suite PASS도 아니다.**
그러므로 V-F3은 “특정 문서 주장을 뒷받침할 증거가 없다”가 아니라, **“두 번째 수집·계산 경로까지 확보했으나 모든 transport가 여전히 같은 호스트·작성자 준비물”**이라는 정보성 한계다. “작성자 script 재실행(installation_and_discovery / run_baseline_checks는 `exec(process.execPath,[envScript|checksScript])`)”과 “reviewer 지정 query”를 계속 분리해 표기하는 방식은 충분하며, 나는 어느 것도 독립 구현 oracle이라고 부르지 않는다.

**Q4. 같은 호스트·작성자 transport 외에 남는 구체적 근거 공백.** 없는 외부 oracle을 있다고 선언하지 않는다.

| 공백 | 성격 | 최소 증거 | 효과 |
|---|---|---|---|
| `.git/config` 전체 bytes·세 section 외 목록·**변경 actor** | 실제 공백. 도구가 hash와 세 section만 반환(`actorUnknown:true`) | 호스트에서 사람이 직접 config·셸/도구 이력 확인 | V 서술(“보존 PASS 아님·주체 미확인”)은 이미 정확 → 문서 결함 아님. 원인 규명은 **이 gateway로 불가** |
| Railway 현재/production 상태 | 실제 공백(접근 권한 없음). V §7은 **과거 staging snapshot**으로만 주장 | Railway 계정 읽기 권한 | 문서 결함 아님. 다만 V 본문 주장 1건이 이 검토로 **재관측되지 않음** |
| 설치 파일 bytes/tarball integrity, Prisma 생성물 | 범위 밖. metadata/version/graph만 검증 | `npm ci`/integrity 재계산 = 설치 행위(금지) | V가 이미 “metadata 검사이지 integrity 아님”을 명시 |
| Windows 전체 suite 결과 | 미해결 잔여. probe에서도 launch 단계에서 exit 1 | R01–R03 구현 후 실행 | 별도 명시적 착수 지시 없이는 해결 불가 |
| 단일 호스트·작성자 도구(외부 하드웨어 oracle/임의 JS sandbox 부재) | 신뢰 가정. 다만 두 계산 경로 일치 + 원격 GitHub REST에서 head=V 확인으로 위험은 “도구 전체의 조직적 위조” 시나리오로 축소 | 제3 환경에서의 독립 재계산 또는 사람의 별도 hash 검산 | 현 범위에서 추가 보완 불가 → 정보성 유지 |

---

## 2. 새 증거 직접 관측 결과

- **PR #1328 / V CI(W-2 보완)**: `pr1328` = head **`1f34a6fb…`(정확히 V)**, state open, **draft true**, base develop, **autoMerge null**. `v_checks` = commit `1f34a6fb…`에 대한 check-runs **총 11건 전부 completed/success**. job step으로 실행/skip을 구분: **실제 실행** — “Security, lint, encoding, and unit tests”(Unit and API policy tests, Server contract tests, 강한 encoding, 각종 register/gate, ESLint 등 success), “Admin Console E2E (PostgreSQL)”(Production build·Run the Admin Console E2E suite success), Secret scan 2건. **docs-only skip** — Production build/Chromium smoke, High-risk UI 4 shard의 Setup/Install/Build/Run 단계 전부 `skipped`(“Determine whether this PR touches anything but documentation” 뒤). headline 성공을 실행으로 세지 않았다. 도구 소스(`scope-evidence.cjs`, sha256 `7a1b2378…`)에서 이 값들이 고정 endpoint의 실 REST GET임을 확인했다.
- **회귀(preservation 09:30:04.238Z)**: 보호65 전 항목 `expected == actual`(불일치 0), 승인4 Git=working(`420f8876…`/`ccc42634…`/`37b17d9f…`/`c1c919a8…`), hidden lock `9cd03955…` 일치, stash 출력 hash 관측, `.env`/`.env.local`은 **크기·mtime만**(3,169/1,344 bytes, 내용 미열람), 기존 untracked 유지·target 2개만 `nowTracked=true`. **config만 불일치**(`expected 0978548a…` vs `actual 25bb2a4a…`).
- **config(09:30:51.828Z)**: 현재 raw `25bb2a4a…`, mtime 2026-09-10T08:59:27.661Z. 내가 지정한 메모리 내 투영(`historicalTracking=true` + `to-main/fix-admin-session-loop` section 제외)으로 **`0978548a…`(V §8.1의 “이후 값”)가 정확히 재현**됐다. 반환된 세 section 본문은 `remote=origin`/`merge=refs/heads/…` 두 줄뿐. 디스크 쓰기 없음, **actor는 여전히 미확인**, 구 `4b07f53f…→74daa333…` provenance 예외 유지.
- **설치/discovery(09:29:58.061Z)**: 도구 오류 재발 없음. metadata **924**, workspace 3/3, 필수누락·version·hidden 불일치 **0/0/0**, optional 미설치 **175**(OS/CPU 제외 **164**), inventory `da51cfba…`, hidden lock `9cd03955…`, lock Git `61d643fc…`, `npm ls --all --json --offline` **exit 0**·rootError null·기존 extraneous 2건, runtime v22.22.2/npm 10.9.7/win32 x64/tsx 4.23.13/TS 6.0.3, js-yaml 4.3.2/4.3.2/4.3.2, server **654**/client **4**, 목록 hash `24f48671…`/`88e7df40…`, `gitWorkingEqual:true`, 41014/80043.
- **기준선 재실행(09:30:41.876Z, 작성자 script 재실행임을 명시)**: 7개 npm 검사 exit 0 및 출력 SHA 8개가 V §8 표와 **전부 동일**(`7d519526…`, `186e01d8…`, `5d216eab…`, `f792af65…`, `575a56ba…`, `8318af98…`, `5a51c6dd…`, test:unit `30da9d3e…`). `npm run test:unit` **exit 1(배너만)**, 동일 argv 직접 spawn **ENAMETOOLONG**/status·signal null/0 bytes/serverCount 654. T01 **74/74 pass**. cache wiring **12 / 11 pass / 1 fail**, 실패 이름·위치(`tests\anthropicPromptCachingWiring.test.mjs:332`)·대상(`app\api\chat\compare-summary\route.ts`) 동일. **기존 실패를 삭제하지 않았다.**
- **승인 경계 원문**: V JSON `/document`(Markdown만 지목, 19606/281), `/hashBinding`(`selfHashStored:false`, `approvalHashesAreSeparate:true` → 단방향), `/authority`(`implementationStarted:false`, `separateImplementationStartInstructionRequired:true`, `fullUnitSuitePassed:false`, `oiF4ClosureDeclared:false`, `activationAuthorized:false`, `paidExecutionAuthorized:false`, `publicationPerformed:false`), `/exclusions`(runner 구현·package/lock/install·workflow·dataset/register/purpose activation·holdout/S5/v9/pair/keys·full P/scorer·provider/dispatch/budget/운영 DB·flags·commit/push/PR/merge) **모두 그대로**. AWR §5의 “별도 명시적 착수 지시 후 R01–R03 3파일” 조건도 변경 없음.

---

## 3. Disposition

| ID | 판정 | 근거 |
|---|---|---|
| **V-F1** (시점별 config) | **CLOSED**(원인 규명, 잔여는 유지) | 내가 직접 지정한 투영으로 `0978548a…` 재현, 차이는 지정 세 branch 추적 section·두 merge ref로 설명. actor 미확인·전체 bytes 보존 미PASS·구 provenance 예외는 그대로 |
| **V-F2** (도구 오류·수치) | **CLOSED** | 도구 정상 실행, §5·§6 수치 전부 재관측 + reviewer query로 교차계산 일치 |
| **V-F3** (재실행 vs 독립 query) | **RETAINED_INFORMATIONAL** | 두 번째 계산 경로 + runner 원문 대조 + execPath probe로 실질 증거력 상승. 그러나 모든 transport가 작성자 준비·단일 호스트 → 외부 oracle 아님 |
| **W-1** (최초 보고서 V-F1 추측 문구) | **RETAINED_INFORMATIONAL** | 최초 보고서 `e654ea05…` **원문 불변**(덮어쓰기 없음), 정정은 후속 note §2와 1차 확인 §1에 **별도 기록**으로 존재. 원문 수정 불필요 |
| **W-2** (PR #1328 11 checks 미검증) | **CLOSED** | 이번 세션에서 고정 REST GET으로 head=V·11/11 success·실행/skip 단계까지 직접 확인 |
| **W-3** (helper sha256 병기) | **CLOSED** | `prior_execution.helperHashes`에 `environment.cjs = b2475779…`, `checks.cjs = 222d8a3a…` 등 기재 확인 |

### 새 finding

| ID | Severity | 위치 | 근거 | 실제 영향 | 필요 조치 |
|---|---|---|---|---|---|
| **X-1** | P3 (정보, 검토 기록 대상 — V 두 파일의 결함 아님) | 1차 확인 보고서 §7 “PASS로 올리지 않는 이유” 중 “기존 Windows launch 실패와 cache-wiring 1건 실패가 그대로 남아 있기 때문” | 최초 prompt 도입부·§4.7·§4.12·§5는 그 실패의 **정확한 구분·기록**만 요구하고 해결을 요구하지 않음 | 역사적 verdict(PASS_WITH_WARNINGS, 차단0)와 V의 승인 경계에는 영향 없음. 다만 운영 잔여를 문서 감사 판정 사유로 인용하면 기준이 과잉 확대돼 보일 수 있음 | 원문 수정·재승인 루프 불필요. 향후 인용 시 “운영/구현 잔여이며 V 문서 결함이 아님”으로 분리 표기(이 보고서 §1이 그 구분을 기록) |

**차단(P0/P1/P2) 0건.** V 두 파일에서 새 문서 결함, 사실 과장·치환, 미승인 권한 개방, 미래 assertion의 기존 실패 선점 분류는 이번에도 발견되지 않았다. `recordCommit:null`·`publicationPerformed:false`·“아직 untracked”는 작성 시점 사실의 보존이며 정상이다.

---

## 4. 미검증·방법 한계(명시)

- Railway 현재/production 상태 — **접근 불가**(V의 `8a4e67aa…`/T SUCCESS는 V가 기록한 과거 snapshot이며 이번에 재조회하지 않음).
- `.git/config` 전체 내용·세 section 외 목록·**변경 actor** — 미확인.
- 설치 파일 bytes/tarball integrity, 생성 Prisma client, 앱·운영 readiness, 운영 DB — 범위 밖·미검증(install/generate/migration 미수행).
- `npm ls` 결과·7개 npm 검사·ENAMETOOLONG·T01/cache-wiring·runner_probe·CI/PR REST — **단일 경로(작성자 script 또는 고정 REST) 관측**.
- **T의 두 CI run(34452681335 / 34452681336)** 은 이번 세션에서 재조회하지 않았다(최초 검토가 REST로 확인한 사실을 그대로 인용).
- 이번 세션에서 `reviewer-query.cjs` 원문과 현재 gateway 전체 소스는 읽지 않았다(1차 확인이 읽음). 대신 나는 `scope-evidence.cjs`·`probe-preload.cjs` 원문과 `run-unit-tests.mjs` V blob을 직접 읽어 새 증거 경로의 방법을 확인했다. → reviewer_query 결과의 증거력은 “내가 작성한 식 + 결과가 runner 원문·작성자 script와 독립적으로 일치”까지이며, evaluator 구현 자체의 이번 세션 독립 확인은 **미수행**.
- 모든 도구가 Codex 작성이며 단일 호스트에서 실행됨 — 외부 oracle 아님. AGENTS.md 전문·V 전문은 고정 blob에서 직접 읽었다.

---

## 5. 최종 판정

**PASS_WITH_WARNINGS** (차단 0건)

- **이유(무엇이 검증됐나)**: identity·두 blob raw SHA/bytes/LF·단방향 결속·추가 범위, 승인4·보호65·hidden lock·stash·env metadata 회귀 없음, `/authority`·`/exclusions`·AWR 착수 조건 보존, §5·§6 수치(924/inventory SHA/654·4/목록 hash/41014/80043)의 **reviewer 자작 query 교차계산 및 runner 원문 대조 일치**, §8 8개 출력 SHA·T01·cache-wiring 실패 이름·ENAMETOOLONG 일치, §8.1 config 논리의 해시 재현, V head의 11 checks 실제 실행/skip 구분.
- **PASS로 올리지 않는 이유(정확히 무엇 때문인지)**: ① V §7의 **Railway staging 주장이 이 검토 경로로 재관측 불가**하여 V 본문 사실 주장 중 1건이 미검증으로 남는다(문서 자체는 “staging 한정·production 미증명”으로 정확히 한정하므로 결함은 아님). ② 모든 측정 transport가 작성자 준비·단일 호스트여서 **외부 독립 oracle이 존재하지 않는다**(V-F3). ③ `.git/config` 변경 actor·전체 bytes 보존은 여전히 미확인.
- **PASS로 올리지 않는 이유가 *아닌* 것**: 기존 Windows launch 실패, cache-wiring 1건 실패, 설치 bytes/Prisma, 운영 readiness. 이것들은 최초 기준이 **정확한 기록**만 요구한 항목이며 V는 정확히 기록했다(X-1 참조). 이 항목들을 근거로 문서 감사 PASS를 막지 않는다.
- **최소 보완 가능성 구분**: 현재 승인된 문서검토 범위 안에서 할 수 있는 보완은 이번 세션에서 사실상 소진되었다(두 번째 계산 경로, execPath probe, V head CI REST까지 수행). 남은 세 경고는 **별도 환경·권한 또는 사람 판정 없이는 닫을 수 없다** — Railway 읽기 권한, 호스트에서의 config actor 확인, 그리고 제3 환경/제3자에 의한 독립 재계산이 각각 필요하다. Windows 전체 suite PASS는 **별도 명시적 착수 지시 후 R01–R03 구현**을 통해서만 가능하다.
- **역사적 판정 보존**: 최초 보고서(PASS_WITH_WARNINGS, 08:47~08:49Z)와 1차 확인(PASS_WITH_WARNINGS, V-F1/V-F2 CLOSED·V-F3 RETAINED)의 verdict는 그대로이며, 이번 판정을 그 시점으로 소급하지 않는다. 기존 운영 잔여, 승인 원문, 승인 경계는 그대로 유지된다.

**이번 확인이 아닌 것**: 현재 배포 인증, runner 구현 완성·인수, 전체 unit suite PASS, OI-F4 closure, S2 activation, 새 사람 승인, 병합·유료 실행 허가 — 어느 것도 아니다. **reviewer는 human approval을 발급하지 않는다.** AWR §5와 V §9의 순서가 그대로 유효하다.

*본 검토에서 파일 쓰기, Git 쓰기, 설치/dedupe/generate, provider·운영 DB·flags 호출, 임의 명령/endpoint 접근, 추가 세션·subagent 실행, 승인·closure 발급은 **일절 수행하지 않았다.** 산출물은 이 응답뿐이다.*
