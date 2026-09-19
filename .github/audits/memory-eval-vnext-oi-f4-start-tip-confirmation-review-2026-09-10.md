# OI-F4 V — V-F1/V-F2/V-F3 후속 확인 검토 보고서

## 0. 고정 대상과 관측 시각

| 항목 | 값 (직접 관측) |
|---|---|
| V | `1f34a6fb0d61b8704d656fee7638a93c9ef42c75` (parents = T 단일) |
| parent T | `aafdceca3e4270ff146077c02f480ba3fd68c9f4` (parents `04e18713…`, `2ce7b596…`) |
| branch / 범위 | `codex/memory-eval-vnext-oi-f4-start-tip-revalidation`, diff = 두 파일 **A(추가)뿐**, tracked/staged 공란, commitCount 1 |
| V Markdown | raw SHA `452d7b80…4fc16c`, 19,606 bytes, 281 LF, strict UTF-8, Git=working ✔ |
| V JSON | raw SHA `20d7e09d…08df87`, 197,254 bytes, 3,296 LF, strict UTF-8, Git=working ✔ |
| 후속 note | `6a6eb399…20aea9` (7,649 bytes) — V tree 밖 보완 기록 |
| 최초 외부 보고서 | `e654ea05…fb62ac` (12,915 bytes) |
| 최초 실행/작성자 관측 JSON | `b9de4505…7e712d5a` (29,725 bytes) |

관측 시각(UTC): identity 09:15:13.547Z · config_projection 09:15:28.6~09:15:31.7Z · installation_and_discovery 09:15:52.580Z · reviewer_query raw rows 09:17:18.614Z(캐시 1회) · preservation 09:18:26.947Z · run_baseline_checks 09:18:35.948Z · github_status(develop) 09:15Z대.

identity·raw hash·parent·추가 범위가 모두 지시서와 일치하여 INCOMPLETE 중단 사유는 없었습니다. 읽은 원문: AGENTS.md 전문(61,198자, 2구간), V Markdown 전문(14,510자), 후속 note, 최초 보고서, AWR 전문, V JSON `/method`(collectionScript·checksScript 전문)·`/document`·`/hashBinding`, gateway·environment 소스, reviewer-query.cjs 소스, prior_execution 기록.

---

## 1. V-F1 — 시점별 config 사실과 추적 section 범위 → **CLOSED (원인 규명, 기존 잔여는 유지)**

제가 직접 호출한 `config_projection` 5회의 결과(모두 동일한 현재 bytes 기준, 디스크 쓰기 없음):

| 내가 지정한 메모리 내 투영 | 결과 SHA-256 | 대조 대상 |
|---|---|---|
| (없음) 현재 raw | `25bb2a4a…d008496`, mtime **2026-09-10T08:59:27.661Z** | 새 관측 시점 사실 |
| `historicalTracking=true` (두 merge ref만 develop/main으로) | `011874ca…c644f833` | **최초 검토(08:49Z) 현재값과 정확히 일치** |
| 위 + `to-main/fix-admin-session-loop` section 제외 | `0978548a…84eb1b5e` | **V §8.1의 이후 값** |
| 위 + `to-develop/fix-admin-session-loop` 제외 | `e3cab8eb…d1d5bf5` | **V §8.1의 시작 값** |
| 위 + `router-collector-cache-observation-fix` 제외 | `74daa333…83bd8bbb4` | **AWR §3의 승인 시점 값** |

반환된 세 section 본문은 `remote = origin` / `merge = refs/heads/…` 두 줄뿐이며(도구 소스에서 그 형태만 허용하고 그 외는 `unexpected_section_content`로 거절), 다른 config 내용·자격증명은 반환되지 않았습니다.

판단 근거:
- 네 개의 과거 해시가 **순서대로 정확히 재현**되었으므로, V 기록 시점 → 최초 검토 시점 → 현재 사이의 bytes 차이는 **위 세 branch 추적 section의 존재 여부와 두 merge ref 값 변화로 완전히 설명**됩니다. 다른 위치가 1바이트라도 달랐다면 SHA-256이 맞을 수 없습니다.
- 따라서 최초 보고서 V-F1의 추측(“V branch 발행에 따른 추적 section 추가가 유력”)은 **지지되지 않습니다.** 실제로 추가된 것은 `codex/to-main/fix-admin-session-loop` section이고, 재검증 branch 이름의 section은 존재하지 않습니다(존재했다면 나머지 해시가 어긋납니다). 최초 보고서 원문은 역사적 기록으로 그대로 두며, 이 정정은 제 새 관측입니다.
- 현재값이 최초 검토 시점과도 다시 달라졌고(두 merge ref가 각자 branch 이름으로 변경, mtime 08:59:27Z = 최초 검토 종료 이후), 이 delta 역시 위 투영으로 증명됩니다. **추정하지 않았습니다.**

유지되는 잔여(해소 아님):
- **변경 actor는 여전히 미확인**입니다(도구도 `actorUnknown:true`만 반환하며 귀속하지 않음).
- **config 전체 bytes 보존은 PASS가 아닙니다.** V 문서의 그 서술은 정확합니다.
- 더 오래된 `4b07f53f…` → `74daa333…` provenance 예외는 그대로 유지되며 이 비교로 소급 해소되지 않습니다(AWR §3 원문과 일치).
- 방법 한계: `historicalTracking`은 reviewer가 지시한 **메모리 내 재구성 가설**(merge ref 문자열 치환)이며 보관된 과거 bytes가 아닙니다. 다만 사전 기록된 3개 해시와 동시에 일치하므로 우연 일치는 실질적으로 배제됩니다. 세 section 외 config 본문·다른 section 목록은 여전히 비공개/미검증입니다.

---

## 2. V-F2 — 실패했던 도구의 실제 회복과 수치 → **CLOSED**

`installation_and_discovery`가 이번에는 오류 없이 실행(09:15:52.580Z)되었고, V §5·§6 수치를 그대로 재관측했습니다: metadata **924**, workspace directory/link **3/3**, 필수누락/version 불일치/hidden 불일치 **0/0/0**, optional 미설치 **175**(OS/CPU 제외 **164**), inventory SHA `da51cfba…ea181a`, hidden lock `9cd03955…955dd6`, lock Git SHA `61d643fc…56ca18`, js-yaml lock/installed/hidden 4.3.2, `npm ls --all --json --offline` **exit 0**·rootError null·기존 extraneous 2건(@emnapi/runtime 1.11.3, @img/sharp-wasm32 0.35.4), runtime v22.22.2 / npm 10.9.7 / win32 x64 / uv 1.51.0 / V8 12.4.254.21-node.39 / OpenSSL 3.5.5 / tsx 4.23.13 / TS 6.0.3, server **654** / client **4**, 목록 hash `24f48671…`/`88e7df40…`, `naiveQuotedUtf16IncludingNull` **41014**, `conservativeCost` **80043**.

**helper 변경 범위 확인:** 현재 environment 스크립트 sha256 = `b2475779…1c6085`(최초 검토 시 `7ef3fff3…`). V JSON `/method.collectionScript`(V에 불변 결속된 당시 텍스트)와 현재 소스를 문장 단위로 대조한 결과 차이는 두 곳뿐이었습니다 — (a) HEAD assert 값 `aafdceca…`→`1f34a6fb…`(최초 검토도 이미 기록), (b) `require('js-yaml')` → 주석 1줄 + `require(path.join(process.cwd(),'node_modules/js-yaml'))`. 산식·필터·집계·직렬화·assert는 동일 텍스트입니다. 한계: 이전 temp helper의 원문 bytes는 저에게 공개되지 않으므로 “그 외 변경 없음”은 **V-결속 텍스트와의 텍스트 대조**로 성립하며 기계 diff가 아닙니다.

범위 한계(그대로 유지): 이는 metadata/version/graph 재검증이며 **모든 설치 파일 bytes/tarball integrity, 생성된 Prisma client, 앱·운영 readiness를 보장하지 않습니다.** 설치·generate·migration은 수행하지 않았습니다.

---

## 3. V-F3 — 원 스크립트 재실행과 독립 query의 증거력 → **RETAINED (정보성 방법론 한계, 부분 완화)**

**(a) 재실행은 여전히 재실행입니다.** gateway 소스에서 `installation_and_discovery`/`run_baseline_checks`가 `exec(process.execPath,[cfg.envScript|cfg.checksScript])`로 **작성자 제공 스크립트를 그대로 실행**함을 확인했습니다. 이를 독립 구현 oracle이라고 부르지 않으며, 최초 검토가 완전했다고 소급하지도 않습니다.

**(b) 제가 직접 작성한 reviewer_query 교차계산.** reviewer-query.cjs(`2e1d6d5e…6362f7`) 소스를 읽어, `sources()`가 package-lock·hidden lock·`readdir(tests)`·`readdir(tests/client)`·`git ls-tree`만 읽고 `packageJsonSha256`을 **자체적으로 바이트에서 계산**하며, `evaluate()`가 한정된 op만 해석하고 eval/new Function/명령/임의 경로가 없음을 확인한 뒤 다음 식을 직접 구성했습니다.

| 내가 쓴 query(요지) | 결과 | 작성자 주장과 대조 |
|---|---|---|
| `records`: `starts(path,"node_modules/") ∧ ¬link ∧ exists` → `{path,expectedVersion=lock.version,actualVersion=installedVersion,packageJsonSha256,optional=bool(lock.optional)}` | count **924**, `sha256Json` = **`da51cfba…ea181a`** | inventory SHA **완전 일치**(별도 read+hash 경로) |
| `¬link ∧ ¬exists ∧ ¬(optional∨devOptional)` | **0** (values=[]) | 필수 누락 0 |
| `¬link ∧ ¬exists ∧ (optional∨devOptional)` | **175** | optional 미설치 175 |
| 위 + 내가 재구성한 supported() 부정식: `os/cpu`에 `!win32`/`!x64` 포함, 또는 (전부 `!` 접두 아님 ∧ `win32`/`x64` 미포함) | **164** | OS/CPU 제외 164 |
| `¬link ∧ exists ∧ ne(lock.version, installedVersion)` | **0** | version 불일치 0 |
| `node_modules/ ∧ ¬link ∧ exists ∧ ne(hiddenVersion, installedVersion)` | **0** | hidden 불일치 0 |
| `¬link ∧ exists ∧ ¬node_modules/ ∧ path≠""` / `bool(lock.link)` | **3 / 3** (apps/mobile, packages/chat-core, packages/ui-tokens; 3 link realpath) | workspace 3+3 |
| `serverNames`: `ends .test.mjs ∨ .test.ts` → sort → `"tests/"+n` | count **654**, `sha256LfJoined` **`24f48671…60ef7`** | server 목록 hash 일치 |
| `clientNames`: `ends .test.tsx ∨ .test.ts` → sort → `"tests/client/"+n` | count **4**, **`88e7df40…d8dd0`** | client 목록 hash 일치 |
| `gitPaths`(V ls-tree): `starts "tests/" ∧ (…mjs∨…ts) ∧ length(split(p,"/"))=2` → sort | **654**, **`24f48671…`** | Git↔working 목록 **동일**(작성자 assert와 무관한 경로로 확인) |
| `gitPaths`: `starts "tests/client/" ∧ (…tsx∨…ts) ∧ split 길이 3` | **4**, **`88e7df40…`** | 동일 |
| `serverNames` → sort → `absolute("tests/"+n)` → `prepend[execPath+7 flags]` → `len+2` 합 | count **662**, **sum 40352** | 40352 + (662−1) + 1 = **41014** ✔ |
| 동일 파이프라인 → `2·len+3` 합 | **sum 80042** | 1 + 80042 = **80043** ✔ |

즉 §5·§6의 분모·산식은 **작성자 계산식을 그대로 쓰지 않은 두 번째 조회·산술 경로**에서 재현되었습니다.

**그럼에도 경고를 닫지 않는 이유:** ① reviewer_query 역시 **Codex가 작성한 도구**이고 같은 호스트·같은 프로세스군에서 같은 파일시스템을 읽습니다 — 외부 하드웨어 oracle이나 임의 JS sandbox가 아닙니다. ② argv 길이의 `execPath` 문자열은 runtime row에서 가져온 값이며, 실제 runner가 사용할 execPath와 같다는 것은 별도로 증명되지 않았습니다. ③ `npm ls` exit/extraneous, 7개 npm 검사, ENAMETOOLONG, CI/Railway는 여전히 단일(작성자 script/REST) 경로 관측입니다. 따라서 V-F3은 **정보성 방법론 한계로 유지**하되, 실질 증거력은 최초 검토 시점보다 상승했다고 기록합니다.

---

## 4. 회귀 확인

- **보존(09:18:26.947Z)**: 보호 목록 전 항목 `expected == actual`(불일치 0), 승인4 Git=working 및 `420f8876…`/`ccc42634…`/`37b17d9f…`/`c1c919a8…` 일치, hidden lock `9cd03955…` 일치, stash 출력 hash 관측, `.env`/`.env.local`은 **크기·mtime만**(3,169 / 1,344 bytes) — 내용 미열람. 기존 untracked 항목 유지, target 2개만 `nowTracked=true`. **config만 불일치**(§1에서 설명, PASS 아님).
- **기준선(09:18:35.948Z)**: 7개 npm 검사 exit 0 및 출력 SHA 8개가 V §8 표와 **모두 동일**(`7d519526…`, `186e01d8…`, `5d216eab…`, `f792af65…`, `575a56ba…`, `8318af98…`, `5a51c6dd…`, test:unit `30da9d3e…`). `npm run test:unit` **exit 1**(배너만), 동일 argv 직접 spawn = **ENAMETOOLONG**/status·signal null/0 bytes/serverCount 654. T01 **74 tests / 74 pass / 0 fail**. cache wiring **12 / 11 pass / 1 fail**, 실패 이름 **“promptCachePath is not passed from a file the map does not know”**, 위치 `tests\anthropicPromptCachingWiring.test.mjs:332`, 대상 `app\api\chat\compare-summary\route.ts`. 기존 실패는 지워지지 않았습니다.
- **권한 경계 원문 확인**: AWR YAML — `implementationStartAuthorizedNow:false`, `implementationChangeAuthorizedNow:false`, `mergeAuthorizedNow:false`, `activationAuthorized:false`, `paidExecutionAuthorized:false`, `oiF4ClosureDeclared:false`, `fullUnitSuitePassed:false`; §5-4는 **“확인한 tip의 새 codex/ branch와 별도 명시적 착수 지시 후에만”** 세 파일(R01–R03) 구현을 허용. V JSON `/document`는 Markdown만 지목(`452d7b80…`, 19606, 281), `/hashBinding`은 `selfHashStored:false`·`approvalHashesAreSeparate:true` — **단방향 결속** 확인. `publicationPerformed=false`/`recordCommit:null`은 작성 시점 필드로 정상입니다.
- **T와 moving develop 구분**: 현재 `refs/heads/develop` = `16127165e2202e86c6f56b24a6c439b0942bcf25`(V 기록 `b880bc4e…`, 최초 검토 `5ad71623…`와 또 다름). 고정 T는 변하지 않으며, 다른 tip에서 착수하면 달라진 부분부터 재검증해야 합니다.
- **Railway**: 이 gateway에 접근 권한이 없습니다. V의 staging deployment(`8a4e67aa…`, SUCCESS)는 **V가 기록한 과거 snapshot**이며, 이번에 현재 Railway/production을 재조회하지 않았습니다.

---

## 5. 이번 검토의 새 finding

| ID | Severity | 위치 | 근거 | 영향 | 최소 수정 |
|---|---|---|---|---|---|
| **W-1** | P3 (정보) | 최초 보고서 §4 V-F1 행 | 해시 체인상 추가된 section은 `codex/to-main/fix-admin-session-loop`이며 V branch section은 부재 | 판정·승인 경계에 영향 없음. 역사적 보고서의 추측 문구가 오독될 수 있음 | 원문 수정 불필요. 인용 시 “추측”과 이번 해시 근거를 구분해 표기(후속 note에 이미 정정 서술 있음) |
| **W-2** | P3 (검증 한계) | 후속 note §5, prior_execution `publication.ciStatus` | PR #1328 11 checks 성공 주장은 이 gateway 권한(pr1323/두 run/develop) 밖 | V 본문 주장이 아니므로 V 결함 아님 | 해당 문장을 인용할 때 “이번 외부 검토 미검증”으로 표기 |
| **W-3** | P3 (정보) | gateway environment helper | sha256이 `7ef3fff3…`(최초) → `b2475779…`(현재) | 재현 근거 인용 시 helper 버전이 달라 혼동 가능 | helper sha256을 기록에 병기(prior_execution `helperHashes`에 이미 `b2475779…` 기재됨 → 충족) |

**차단(P0/P1/P2) 0건.** V 두 파일에서 새 문서 결함, 과장, 미승인 권한 개방, 미래 assertion의 기존 실패 선점 분류는 발견되지 않았습니다.

---

## 6. 미검증·방법 한계(명시)

- config 전체 bytes 내용, 세 section 외 다른 section 목록, **변경 actor** — 미확인.
- 설치 파일 bytes/tarball integrity, 생성 Prisma client, 앱·운영 readiness, 운영 DB — 미검증(범위 밖).
- `npm ls` 결과, 7개 npm 검사, ENAMETOOLONG, CI run/job, PR #1328 — 단일 경로(작성자 script 또는 제한 REST) 관측.
- Railway 현재/production 상태 — 접근 불가.
- 모든 도구가 Codex 작성이며 단일 호스트에서 실행됨 — 외부 oracle 아님.
- 표현 불가로 생략한 교차검증: reviewer_query에는 프로세스 실행·출력 해시 계산·REST 조회가 없으므로 §7~§8의 CI/검사 항목은 별도 식으로 재계산할 수 없었습니다.

---

## 7. 판정

**PASS_WITH_WARNINGS**

- V-F1 **CLOSED**(원인 규명 완료, 단 actor 미확인·config 전체 보존 미PASS·구 provenance 예외는 유지) · V-F2 **CLOSED** · V-F3 **RETAINED**(정보성 방법론 한계).
- 회귀 없음: 보호65·승인4·hidden lock·stash·env metadata·8개 검사 출력 SHA·T01·cache-wiring 실패 이름·ENAMETOOLONG 모두 V 기록과 동일.
- PASS로 올리지 않는 이유: 모든 관측이 작성자 제공·단일 호스트 도구 안에서 이루어졌고(V-F3), Railway 현재 상태·config 전체 bytes·변경 주체·설치 bytes/Prisma가 여전히 미검증이며, 기존 Windows launch 실패와 cache-wiring 1건 실패가 그대로 남아 있기 때문입니다.
- **최초 보고서의 역사적 verdict(PASS_WITH_WARNINGS, 2026-09-10 08:47~08:49Z)는 그대로이며, 이 새 판정을 그 시점으로 소급하지 않습니다.**

**이번 확인이 아닌 것:** 현재 deployment 인증, runner 구현 완성·인수, 전체 unit suite PASS, OI-F4 closure, S2 activation, 새 사람 승인, 병합·유료 실행 허가 — 어느 것도 아닙니다. AWR §5와 V §9의 순서가 그대로 유효합니다.

**최소 다음 조치:** ① 구현은 **별도 명시적 착수 지시** 후 T(또는 재검증한 tip)의 새 codex/ branch에서 `scripts/run-unit-tests.mjs` 수정 + `scripts/run-unit-tests-core.mjs`·`tests/unitTestRunner.test.mjs` 신규 3파일로 한정. ② `.git/config` 변경 주체가 문제라면 도구 밖에서 사람이 확인(현 gateway로는 불가). ③ 향후 기록에서 §5·§6 수치를 재사용할 때 tip·설치·helper sha256과 “작성자 script 재실행 / reviewer 교차계산” 구분을 함께 표기.

본 검토에서 파일 쓰기, Git 쓰기, 설치, provider/운영 호출, 추가 세션·subagent 실행, 승인·closure 발급은 **일절 수행하지 않았습니다.** 산출물은 이 응답뿐입니다.
