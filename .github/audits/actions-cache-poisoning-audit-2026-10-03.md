# GitHub Actions 캐시 오염 경로 감사 (2026-10-03)

> **상태: 조사 완료, 조치 없음.** 이 감사는 workflow를 하나도 바꾸지 않았습니다.
> 7장의 권고는 소유자 승인 전 제안이며, 각 항목에 승인·검토 요건을 적었습니다.

기준 commit: `2f7550a5873606fecbfeec993c398a898a69ffcb`
(`origin/main` 끝, 2026-10-03T00:54:48+10:00, PR #1944 병합).
기본 branch는 `main`입니다(`refs/remotes/origin/HEAD`).
대상: `.github/workflows/` 아래 **27개 workflow 전부**.
도구: `lib/agentCredentialReachability.ts`(저장소 자신의 분석기, 실제 workflow에
대해 실행), 그리고 `.github/workflows/` 전수 독해.

## 0. 세 축과, 이 문서가 말하지 않는 것

조사한 축은 셋입니다.

1. **누가 `main`(기본 branch) scope 캐시에 쓸 수 있는가** — 2장.
2. **누가 캐시를 복원하고 그 내용을 실행하거나 신뢰하는가** — 3장.
3. **그 consumer job이 어떤 secret·권한을 들고 있는가** — 4장.

먼저 이 문서가 **아닌** 것 넷을 못박습니다.

1. **침해 사실이 아닙니다.** 오염된 캐시 항목을 관측한 것이 아니고, 경로가
   열려 있다는 구조 판정입니다. 캐시 항목의 실제 내용은 조회하지 않았습니다.
2. **가장 심한 결과가 자격증명 유출이라는 주장이 아닙니다.** 4장의 결론은
   그 반대입니다 — 무결성 검증이 없는 캐시를 복원하는 job 중 외부 API
   자격증명을 든 것은 **현재 하나도 없습니다.** 그 분리는 지금 사실이지만
   어떤 검사도 그것을 유지하지 않습니다. 발견은 유출이 아니라 **유지 장치의
   부재**입니다.
3. **모든 캐시를 같은 위험으로 보지 않습니다.** `npm` cacache는 내용
   주소화돼 있고 `npm ci`가 `package-lock.json`의 integrity와 대조하므로
   치환은 `EINTEGRITY`로 실패합니다. `.next/cache`·`~/.cache/ms-playwright`·
   Rust `target`에는 그에 해당하는 검증이 **없습니다.** 3장이 이 둘을 분리해
   셉니다.
4. **자격증명 판정 전수를 재검증한 것이 아닙니다.** 분석기가 자격증명 보유로
   본 22개 job 중, 이 감사가 한 줄씩 대조한 것은 **캐시를 복원한다고 판정된
   14건**입니다(4.2에 과대추정 3건을 적습니다). 캐시를 복원하지 않는 job의
   자격증명 판정 근거는 이 세 축에 영향을 주지 않으므로 추적하지 않았습니다.

## 1. 전제 — 캐시의 ref scope

GitHub의 공식 규칙입니다(Actions dependency caching reference). 이 감사 전체가
이 넷 위에 서 있으므로 원문을 인용합니다.

| 방향 | 규칙 |
|---|---|
| 기본 branch → 모든 run | "Workflow runs can restore caches created in either the current branch or the default branch (usually `main`)." |
| base branch → 그 PR의 run | "If a workflow run is triggered for a pull request, it can also restore caches created in the base branch." |
| PR run → 다른 ref | "the cache is created for the merge ref (`refs/pull/.../merge`) ... can only be restored by re-runs of the pull request." |
| child·sibling branch → 부모 | "Workflow runs cannot restore caches created for child branches or sibling branches." |

여기서 따라오는 것이 이 감사의 핵심입니다.

- **`main` scope에 쓰인 캐시 항목은 이 저장소의 모든 run이 복원합니다** — PR
  Fast Gate를 포함해서.
- **`develop` scope에 쓰인 항목은 base가 `develop`인 모든 PR이 복원합니다** —
  이 저장소에서 기능 PR은 전부 `develop`을 향하므로(AGENTS.md "main으로 가는
  PR은 release와 hotfix뿐입니다"), 실질적으로 거의 모든 PR입니다.
- **반대 방향(PR → 다른 ref)은 닫혀 있습니다.** 이 구분이 5장 F5의 근거입니다.
- `schedule`은 기본 branch에서 돕니다 → **`main` scope**. `workflow_dispatch`는
  고른 ref의 scope입니다.

그리고 `actions/cache`는 **이미 있는 key를 덮어쓰지 않습니다.** 그래서 어떤
lockfile 해시에 대해 `main` scope에 먼저 도착한 writer가 그 항목을 소유하고,
PR run의 저장은 자기 merge-ref scope로 가므로 그것을 밀어내지 못합니다. 즉
`main` scope 항목은 **모든 PR이 복원하는 정본**으로 남습니다.

## 2. 축 1 — `main`·`develop` scope 캐시에 쓸 수 있는 job

`npm ci`는 `--ignore-scripts` 없이는 의존성의 install script를 실행합니다.
이 저장소에서 `--ignore-scripts`를 쓰는 곳은 `pr-fast-gate.yml:684`
(`vendor/amux`) **한 곳뿐**입니다. 아래 표의 모든 `npm ci`는 제3자 코드를
실행하며, 그 코드는 그 job의 Actions runtime token에 닿습니다 — GitHub-hosted
Linux runner는 passwordless sudo이므로 격리는 없습니다.

### 2.1 무결성 검증이 없는 캐시를 `main`·`develop` scope에 쓰는 job

| workflow | trigger | scope | 쓰는 항목 | 제3자 코드 |
|---|---|---|---|---|
| `daily-security-audit.yml` | `schedule` :4-6 | **main** | `.next/cache` → `Linux-next-daily-*` :73-79, `~/.cache/ms-playwright` → `Linux-playwright-<lock>-chromium-webkit` :148-153; `e2e` job이 같은 두 키 :275-281, :294-299 | `npm ci` :85, :284, :361 |
| `nightly-visual-regression.yml` | `schedule` :29-32 | **main** | `.next/cache` → `Linux-next-visual-*` :69-75, ms-playwright → `Linux-playwright-<lock>-chromium` :85-90 | `npm ci` :78 |
| `admin-console-e2e.yml` | `push` :53-56 | **main + develop** | `.next/cache` → `Linux-next-admin-e2e-*` :157-163, ms-playwright → `Linux-playwright-<lock>-chromium` :175-180 | `npm ci` :167 |
| `orchestrator-rust.yml` | `push` :17-18 | **main + develop** | `~/.cargo/registry`, `~/.cargo/git`, `target`, `vendor/amux/target` → `Linux-rust-workspaces-*` :47-54 | `cargo` build script |
| `e2e.yml` | `workflow_dispatch` :51 | 고른 ref | `.next/cache` → `Linux-next-main-*` :193-199, ms-playwright → `Linux-playwright-<lock>-chromium` :212-217 | `npm ci` :202 |

`e2e.yml`은 2026-10-02부터 `push: main`이 아니라 `pull_request: branches:[main]`
입니다(:47-50, 그 위 :56-88의 주석이 변경 이유를 적습니다). 따라서 그 PR run은
PR scope에만 씁니다. `main` scope에 쓰는 경로는 `workflow_dispatch`를 `main`에서
돌릴 때만 남습니다 — 이 감사의 과제 설명에 있던 "`e2e.yml` push main"은 더 이상
맞지 않습니다.

### 2.2 `npm` cacache만 `main` scope에 쓰는 job

전부 `actions/setup-node`의 `cache: npm`입니다. key는
`node-cache-{platform}-{arch}-npm-{hash(package-lock.json)}`이고 restore-keys가
없습니다(setup-node는 npm에 대해 primary key 정확 일치만 씁니다).

| workflow | trigger | scope | 위치 | 제3자 코드 |
|---|---|---|---|---|
| `cron-auto-fix.yml` | `schedule` :45-54 | **main** | :210 | `npm ci` :213, `npm install -g` :226 |
| `fal-price-drift.yml` | `schedule` :29-33 | **main** | :65 | `npm ci` :69 |
| `voice-price-reverification-notice.yml` | `schedule` :27-31 | **main** | :59 | `npm ci` :62 |
| `credit-finance-db-integration.yml` | `push` :79-82 | **main + develop** | :176 | `npm ci` :179 |
| `daily-security-audit.yml` (`report` job) | `schedule` | **main** | :356 | `npm ci` :361 |
| `visual-baseline-record.yml` | `dispatch` :31 | 고른 ref | :65 | `npm ci` :68 |
| `memory-eval-decision-grade.yml` | `dispatch` :31 | 고른 ref | :142 | `npm ci` :144 |
| `memory-eval-development-probe.yml` | `dispatch` :38 | 고른 ref | :81 | `npm ci` :83 |
| `memory-eval-inspect-artifact.yml` | `dispatch` :22 | 고른 ref | :53 | `npm ci` :55 |
| `router-eval-pilot.yml` | `dispatch` :41 | 고른 ref | :134 | `npm ci` :136 |
| `router-judge-cap-probe.yml` | `dispatch` :28 | 고른 ref | :128 | `npm ci` :130 |
| `router-human-review-sheets.yml` | `dispatch` :30 | 고른 ref | :94 | `npm ci` :120 |
| `router-human-review-recovery-probe.yml` | `dispatch` :23 | 고른 ref | :45 | `npm ci` :47 |
| `feedback-autofix.yml` | `dispatch` :29 | 고른 ref | :119 | `npm ci` :123 |
| `feedback-autofix-promotion-pr.yml` | `pull_request: closed` :25-27, `dispatch` | PR scope / 고른 ref | :125 | `npm ci` :129 |

### 2.3 캐시를 전혀 쓰지 않는 workflow — 유지해야 할 모양

| workflow | 근거 |
|---|---|
| `secret-history-scan.yml` | `setup-node` 자체가 없습니다(:51 checkout, :54 gitleaks뿐). `push: main` + `schedule`인데도 캐시 표면이 0입니다. |
| `back-merge-main-to-develop.yml` | `push: main`. `setup-node` :281에 `cache:` 입력이 없습니다. `back-merge` job(`GH_AUTOMATION_PAT` :110, :119)은 `setup-node`조차 없습니다. |
| `deployed-commit-drift.yml` | `schedule`. `setup-node` :110에 `cache:` 없음. :114-116 주석이 `npm ci`를 **일부러** 하지 않는다고 적습니다. |
| `engineering-agent-image.yml` | `push: main` + `packages: write`. :4 주석이 "no repository secret, no cache"를 명시하고 :46-48이 `docker build --pull --no-cache`입니다. |
| `codeql.yml` | `push: main` + `schedule` + `security-events: write`. `setup-node`가 없습니다(:65 주석이 그 생략을 설명). CodeQL action 자신의 bundle 캐시는 GitHub가 관리하며 이 감사 범위 밖입니다. |
| `auto-pr-to-develop.yml` | `GH_AUTOMATION_PAT` :46를 들지만 `actions/checkout` :50 하나뿐입니다. |

## 3. 축 2 — 복원하고, 실행하거나 신뢰하는 job

### 3.1 무결성 검증이 없는 세 캐시

**`.next/cache`.** webpack/Turbopack의 컴파일 산출물입니다. `npm run build`가
그것을 읽어 `.next/server/**`를 만들고, e2e는 `next start`로 그것을 실행합니다.
항목에 서명도 해시 핀도 없고, 저장소가 대조할 수 있는 기대값도 없습니다 —
내용이 빌드마다 달라지므로 핀 자체가 성립하지 않습니다.

**`~/.cache/ms-playwright`.** 실행 가능한 브라우저 바이너리입니다.
`scripts/ci/install-playwright.sh`의 두 번째 half(`npx playwright install`)는
**캐시 적중 시 아무것도 내려받지 않고 아무 해시도 검증하지 않습니다** — 그
파일의 주석이 "on a cache hit this is a no-op that costs a second"라고 적고,
이전 성능 감사가 그것을 측정했습니다
(`.github/audits/pr-fast-gate-performance-audit.md:355` "브라우저, 캐시 적중 시
즉시 종료", :349 "캐시 적중 시에도 실행되는 12초는 대부분 apt").

같은 감사의 :348이 수명을 측정했습니다 — "Playwright 캐시는 **매번 primary key
적중** (키가 lockfile 해시만 포함 → lockfile이 안 바뀌면 항상 warm)". 즉 한
항목이 lockfile이 바뀔 때까지 모든 run에 제공됩니다.

**Rust `target` 과 `~/.cargo`.** `orchestrator-rust.yml:47-54`가
`~/.cargo/registry`, `~/.cargo/git`, `target`, `vendor/amux/target`을 한 항목에
담습니다. restore-keys가 없는 것(:54, primary key 하나뿐)은 올바른 선택이지만,
`target/` 안의 build script 바이너리에는 검증이 없습니다. `push: main`과
`push: develop` 양쪽에서 씁니다.

### 3.2 키 공유 — 하나의 Playwright 항목이 5개 workflow를 지납니다

`Linux-playwright-<lock>-chromium`은 **fallback이 아니라 primary key로** 아래
여섯 job이 공유합니다.

```
admin-console-e2e.yml:178          pr-fast-gate.yml:841   (build-and-e2e)
e2e.yml:215                        pr-fast-gate.yml:1033  (ui-risk)
nightly-visual-regression.yml:88   review-parity-shadow.yml:128
```

그리고 **모두** restore-keys `${{ runner.os }}-playwright-${{ hashFiles('package-lock.json') }}-`
를 갖습니다(:180, :217, :90, :843, :1035, :130). 이 prefix는
`daily-security-audit.yml:151`·`:297`의 `-chromium-webkit` 항목에도 맞습니다.
따라서 **모든 Playwright 캐시가 lockfile 해시 하나당 pool 하나**이고, 그 pool의
`main` scope writer는 `nightly-visual-regression`(schedule),
`daily-security-audit`(schedule), `admin-console-e2e`(push main)입니다.

`.next/cache` 쪽은 workflow마다 namespace가 다릅니다(`-daily-`, `-visual-`,
`-admin-e2e-`, `-main-`, `-parity-`, `-pr-`). 그런데 다섯 곳이 그 경계를 지우는
broad fallback을 갖습니다.

```
admin-console-e2e.yml:163          daily-security-audit.yml:79, :281
e2e.yml:199                        nightly-visual-regression.yml:75
review-parity-shadow.yml:103
```

`${{ runner.os }}-next-` 는 다른 모든 `Linux-next-*` 항목에 맞습니다.
`pr-fast-gate.yml`은 이 fallback을 이미 **뺐고**(:809-810, :1014-1015), 그 이유가
주석에 있습니다(:806-808).

> Stop at next-pr-&lt;lockfile&gt;. A bare Linux-next- prefix also matches
> Linux-next-admin-e2e- from another workflow. That cache was built
> with Next 16.3.4 and breaks a 16.3.5 Turbopack font build.

**이 채널이 실제로 작동한다는 것은 이미 관측됐습니다.** 당시 판정은 정합성
문제였고 보안 경계로 다루지 않았으므로, 같은 수정이 다른 다섯 곳에는 적용되지
않았습니다.

### 3.3 복원 → 실행 경로 전수

| workflow # job | `.next/cache` | ms-playwright | rust | npm | 복원한 것이 실행되는 지점 |
|---|---|---|---|---|---|
| `pr-fast-gate` # `build-and-e2e` | :802 | :838 | — | :797 | `npm run build` :833 → `install-playwright.sh` :848 → smoke :850- |
| `pr-fast-gate` # `ui-risk` | :1007 | :1030 | — | :1002 | `npm run build` :1025 → :1040 → UI 회귀 :1042 |
| `pr-fast-gate` # `static-and-unit` | — | — | — | :135 | `npm ci` :165, static 검사 전부 |
| `pr-fast-gate` # `unit-tests` | — | — | — | :711 | `npm ci` :715 |
| `review-parity-shadow` # `review-parity` | :97 | :125 | — | :92 | `npm run build` :120 → :135 |
| `admin-console-e2e` # `admin-console-e2e` | :157 | :175 | — | :153 | `npm run build` :171 → :184 |
| `daily-security-audit` # `audit` | :73 | :148 | — | :68 | `npm run check` :143(build 포함) → :176 |
| `daily-security-audit` # `e2e` (6 shard) | :275 | :294 | — | :269 | `npm run build` :290 → :311 → 전체 e2e |
| `daily-security-audit` # `report` | — | — | — | :356 | `node --import tsx scripts/send-security-audit-report.mjs` :394 |
| `e2e` # `playwright` (5 shard) | :193 | :212 | — | :189 | `npm run build` :208 → :220 → :223 |
| `nightly-visual-regression` # `visual-regression` | :69 | :85 | — | :65 | `npm run build` :81 → :93 |
| `orchestrator-rust` # `workspace` | — | — | :47 | — | `cargo build` :60- |
| `credit-finance-db-integration` # `credit-finance-db` | — | — | — | :176 | `npm ci` :179 + DB 시나리오 |
| `cron-auto-fix` # `attempt-fix` | — | — | — | :210 | `npm ci` :213, `npm run check` :316, `test:e2e:pr` :325 |
| `feedback-autofix` # `attempt-fix` | — | — | — | :119 | `npm ci` :123 |
| `feedback-autofix-promotion-pr` # `promotion-pr` | — | — | — | :125 | `npm ci` :129 |
| `fal-price-drift` # `price-drift` | — | — | — | :65 | `npm ci` :69 |
| `voice-price-reverification-notice` # `notice` | — | — | — | :59 | `npm ci` :62 |
| `visual-baseline-record` # `record` | — | — | — | :65 | `npm run build` :71 |
| `memory-eval-*`, `router-*` (7 job) | — | — | — | 2.2 참조 | `npm ci` |

**`cron-auto-fix.yml:320`과 `visual-baseline-record.yml:74`는
`install-playwright.sh`를 캐시 복원 없이 호출합니다** — 매 run CDN에서
새로 내려받습니다. 이 둘은 쓰기 권한·자격증명을 가진 job이고, 그래서 이 모양이
맞습니다. 6장에 유지 항목으로 적습니다.

### 3.4 복원 단계는 모두 `continue-on-error: true`

`admin-console-e2e.yml:156`·`:174`, `daily-security-audit.yml:72`·`:147`·
`:274`·`:293`, `e2e.yml:192`·`:211`, `nightly-visual-regression.yml:68`·`:84`,
`pr-fast-gate.yml:801`·`:837`·`:1006`·`:1029`,
`review-parity-shadow.yml:96`·`:124`.

복원 실패가 조용하다는 것은 성능상 의도된 선택입니다. 완화책 설계에 주는 제약은
하나입니다 — **오염 항목을 거부하는 검사를 복원 단계 안에 넣으면 조용히
통과합니다.** 검사는 `continue-on-error`가 없는 별도 단계여야 합니다.

## 4. 축 3 — consumer job의 secret·권한

### 4.1 저장소 자신의 분석기가 이미 이 규칙을 갖고 있습니다

`lib/agentCredentialReachability.ts`는 `credential_job_restores_cache`라는
판정을 갖습니다(:61). 계약은 `docs/policy/engineering-agent.md:198-201`입니다.

> **cache 경로**: 자격증명을 가진 job이 Actions cache를 복원하면, 그 job은
> trigger·path filter와 무관하게 도달한 것으로 보고 **모든 변경이 push
> 금지**다. 이 가정을 푸는 방법은 job별 제외가 아니라, cache의 ref 간 공유
> 범위에 대한 날짜 있는 확인 기록 하나를 분석기 설정에 고정하는 것뿐이다.

이 감사는 그 분석기를 기준 commit의 실제 workflow에 대해 실행했습니다. 결과:
`forbidsAll: true`, 자격증명 보유 job 22건, 이유 17건, 그중
`credential_job_restores_cache` **14건**.

```
back-merge-main-to-develop.yml # verify          credit-finance-db-integration.yml # report-red-lane
cron-auto-fix.yml # attempt-fix                  daily-security-audit.yml # report
deployed-commit-drift.yml # drift                fal-price-drift.yml # price-drift
feedback-autofix-promotion-pr.yml # promotion-pr feedback-autofix.yml # attempt-fix
memory-eval-decision-grade.yml # run             memory-eval-development-probe.yml # run
router-eval-pilot.yml # run                      router-judge-cap-probe.yml # probe
visual-baseline-record.yml # record              voice-price-reverification-notice.yml # notice
```

재현(이 저장소 clone 안, Node 22와 `npm ci`가 끝나 있어야 하고 자격증명은
필요하지 않습니다 — 읽기 전용입니다):

```bash
npm run report:engineering-agent-tiers
```

### 4.2 분석기의 "restores" 3건은 보수적 과대추정입니다

`restoresCache`(:267-289)는 `actions/setup-*`를 "`cache`가 명시적으로 꺼져
있지 않으면 복원한다"로 봅니다(:283-286). 실제 `actions/setup-node`는 `cache`
입력이 없으면 캐시를 쓰지 않습니다. 아래 셋은 `cache:` 입력이 없으므로 실제
복원자가 아닙니다 — fail-closed 설계의 의도된 과대추정입니다.

| job | 근거 |
|---|---|
| `back-merge-main-to-develop.yml # verify` | `setup-node` :281에 `cache:` 없음 |
| `credit-finance-db-integration.yml # report-red-lane` | `setup-node` :243에 `cache:` 없음 |
| `deployed-commit-drift.yml # drift` | `setup-node` :110에 `cache:` 없음 |

### 4.3 실제로 자격증명을 들고 캐시를 복원하는 11건 — 전부 `npm` cacache 하나뿐

| job | scope | 든 secret / 쓰기 권한 | 복원하는 캐시 |
|---|---|---|---|
| `cron-auto-fix # attempt-fix` | **main**(schedule) | `GH_AUTOMATION_PAT` :182, `ANTHROPIC_API_KEY` :238, `AUTO_FIX_SYNC_SECRET` :277·:288·:333·:354; `contents: write` + `pull-requests: write` :57-59 | `cache: npm` :210 |
| `daily-security-audit # report` | **main**(schedule) | `RESEND_API_KEY` :373, Slack webhook :367, 수신자 주소 :368 | `cache: npm` :356 |
| `fal-price-drift # price-drift` | **main**(schedule) | `FAL_KEY` :78·:93 | `cache: npm` :65 |
| `voice-price-reverification-notice # notice` | **main**(schedule) | `issues: write` :34-38, `GITHUB_TOKEN` :66 | `cache: npm` :59 |
| `feedback-autofix # attempt-fix` | dispatch | `FEEDBACK_AUTOFIX_ANTHROPIC_API_KEY` :161, `GH_AUTOMATION_PAT` :303, sync secret | `cache: npm` :119 |
| `feedback-autofix-promotion-pr # promotion-pr` | PR scope / dispatch | `GH_AUTOMATION_PAT` :149·:191, sync secret :89 | `cache: npm` :125 |
| `memory-eval-decision-grade # run` | dispatch | `OPENAI_API_KEY` :199 | `cache: npm` :142 |
| `memory-eval-development-probe # run` | dispatch | `OPENAI_API_KEY` :125 | `cache: npm` :81 |
| `router-eval-pilot # run` | dispatch | `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY` :199-201, :234, :276-277, :342-344 | `cache: npm` :134 |
| `router-judge-cap-probe # probe` | dispatch | `ANTHROPIC_API_KEY` :167·:177 | `cache: npm` :128 |
| `visual-baseline-record # record` | dispatch | `contents: write` :38-39 | `cache: npm` :65 |

**이 열한 건 중 `.next/cache`나 `~/.cache/ms-playwright`를 복원하는 job은
하나도 없습니다.** 반대로 3.3에서 무검증 캐시를 복원하는 **job 정의 아홉**은
전부 `contents: read`이고 외부 API 자격증명을 들지 않습니다(matrix 전개가
아니라 정의 수입니다 — `daily-security-audit # e2e`는 6 shard,
`e2e # playwright`는 5 shard로 돕니다).

그 분리가 지금의 안전을 만들고 있습니다. 그리고 그것을 유지하는 장치는
없습니다 — 위 열한 job 중 하나에 `actions/cache`로 `.next/cache`를 더하는 한
줄이면, 검증되지 않은 캐시와 `GH_AUTOMATION_PAT`·`ANTHROPIC_API_KEY`가 같은
job에 들어옵니다. `credential_job_restores_cache` 판정은 **에이전트의 쓰기를
막는 게이트**이고, workflow 변경 자체를 막는 검사가 아닙니다.

### 4.4 `npm` cacache의 실제 영향 범위

`npm ci`는 `package-lock.json`의 integrity와 대조하므로 내용 치환은
`EINTEGRITY`로 **실패**합니다. 따라서 이 경로의 결과는 코드 실행이 아니라
가용성입니다.

lockfile 밖의 설치만이 치환 위험이고, 저장소에 둘 있습니다 — 그리고 둘 다
이미 명시적 sha512 핀을 갖고 있습니다.

- `cron-auto-fix.yml:218-225` — `CLAUDE_CODE_INTEGRITY` 대조 후 `npm install -g`
- `feedback-autofix.yml:146-154` — 같은 패턴

`package.json`의 `postinstall`은 `prisma generate` 하나입니다.

## 5. 발견과 되돌릴 수 있음/없음 분류

분류 기준은 AGENTS.md "검증 범위는 되돌릴 수 없는 것에 비례합니다"입니다 —
**무엇이 복구 불가인지 한 줄로 적을 수 없으면 차단이 아닙니다.**

### F1 — Playwright 브라우저 캐시 pool 하나가 `main` scope에서 쓰이고 8개 job에서 실행됩니다

근거: 3.2의 키 표, `scripts/ci/install-playwright.sh`(캐시 적중 시 무검증
no-op), `.github/audits/pr-fast-gate-performance-audit.md:348`·`:355`.

결과: CI 안의 임의 바이너리 실행, 그리고 필수 check(`pr-fast-gate # fast-gate`)의
판정. 그 job들의 runtime token은 `main` scope에 다시 쓸 수 있으므로 오염이
자기를 유지할 수 있습니다.

**되돌릴 수 있음.** 캐시 항목은 삭제할 수 있고 빌드는 다시 돌릴 수 있습니다.
복구 불가인 것을 한 줄로 적을 수 없습니다 — 자격증명이 그 job에 없기
때문입니다(4.3). 차단 사유가 아니며, **권고 1순위**입니다.

단 분명히 해 둘 것: gate가 잘못 green이 되어 병합·배포된 변경의 가역성은 그
변경 자신의 것이고 이 항목의 것이 아닙니다. 마이그레이션이나 가격 변경이 그
경로로 통과하면 그쪽 기준으로 복구 불가일 수 있습니다.

### F2 — `.next/cache`의 broad restore-key가 workflow 경계를 지웁니다

근거: `admin-console-e2e.yml:163`, `daily-security-audit.yml:79`·`:281`,
`e2e.yml:199`, `nightly-visual-regression.yml:75`,
`review-parity-shadow.yml:103`. 반례이자 증거: `pr-fast-gate.yml:806-810`.

결과: PR workflow(`review-parity-shadow`)가 `main` scope의 schedule job이 쓴
`.next/cache`를 복원해 빌드하고 실행합니다. **F1과 달리 이 채널이 실제로
작동한 기록이 저장소에 있습니다**(16.3.4 캐시가 16.3.5 빌드를 깨뜨린 사건).

**되돌릴 수 있음.** F1과 같은 이유입니다. **권고 1순위**.

### F3 — `main`·`develop` scope writer가 제3자 install script를 실행합니다

근거: 2장의 모든 `npm ci`, `--ignore-scripts`는 `pr-fast-gate.yml:684` 한 곳뿐.

이것은 발견이라기보다 **F1·F2의 전제**입니다 — 침해된 의존성 하나가 `main`
scope 캐시 쓰기를 얻는 경로. 따로 분류하지 않고 7장 P6의 조사 항목으로
넘깁니다.

### F4 — 자격증명과 무검증 캐시의 분리를 유지하는 검사가 없습니다

근거: 4.3의 열한 건과 3.3의 아홉 건이 교집합 없음. 그 사실을 고정하는
테스트·검사 없음. `credential_job_restores_cache`(lib:61, :494)는 에이전트의
push를 막을 뿐 workflow 변경을 막지 않습니다.

결과: 열한 job 중 하나에 무검증 캐시가 더해지면 `GH_AUTOMATION_PAT`(공개
저장소에 `contents: write`), `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`DEEPSEEK_API_KEY`, `FAL_KEY`, `RESEND_API_KEY`가 오염된 코드와 같은 job에
놓입니다.

**지금은 되돌릴 수 있음**(가용성). **그 한 줄이 들어온 뒤에는 되돌릴 수
없음** — AGENTS.md가 "유출처럼 회수가 성립하지 않는" 것을 복구 불가로 명시하고,
키 회전은 미래 사용만 제한하며 유출 자체를 되돌리지 못합니다. 현재 상태가
깨져 있다는 뜻은 아니므로 **차단 사유는 아니고**, 가장 오래 가는 조치이므로
**권고 2순위**입니다.

### F5 — `cacheIsolationRecorded`가 기록하려는 방향은 이미 닫힌 방향입니다

근거: `lib/agentCredentialReachability.ts:369-370`이 그 설정을 "a dated record
that **pull_request-run caches never reach other refs' runs**"로 정의합니다.
`docs/policy/engineering-agent.md:198-201`이 계약입니다. 호출자는 둘이고 **둘
다 `false`로 고정**돼 있습니다(`tests/agentCredentialReachability.test.mjs:13`·
`:561`, `scripts/report-engineering-agent-tiers.mjs:144`) — 즉 기록은 아직
존재하지 않습니다.

1장의 공식 규칙은 **그 방향이 이미 닫혀 있음을 확인합니다** — PR 캐시는
`refs/pull/.../merge` scope이고 그 PR의 re-run만 복원합니다. 그러므로 그 기록은
쓸 수 있습니다.

**열려 있는 방향은 반대쪽입니다.** 에이전트가 일으키는 이벤트는 PR이지만, 그
PR의 job이 복원하는 것은 `main`·`develop` scope의 항목 — 에이전트가 아닌
누군가가, 또는 침해된 의존성이 거기에 쓴 것입니다. 기록을 "캐시는 ref 간에
격리된다"로 뭉뚱그려 쓰면, **맞는 사실로 틀린 결론을 세워** 에이전트의 blanket
push 금지를 풀게 됩니다.

**되돌릴 수 없음에 가장 가까운 항목입니다.** 복구 불가인 것을 한 줄로 적을 수
있습니다 — 잘못된 근거로 풀린 금지는 에이전트가 자격증명 옆에서 실행되는
파일을 쓰게 하고, 그 결과는 자격증명 유출입니다. 다만 **지금 깨져 있는 것이
아니라 선행 조건**입니다(기록이 없으므로). 그 기록을 쓰는 PR은 차단 대상이며
contract 역할과 소유자 승인이 필요합니다.

### F6 — 복원 단계가 모두 `continue-on-error: true`입니다

근거: 3.4. **되돌릴 수 있음.** 발견이 아니라 완화책 설계 제약으로 기록합니다.

### 인접 경로 (세 축 밖, 참고)

`main` scope job의 action이 태그로 고정돼 있습니다 — `actions/cache@v5`,
`actions/setup-node@v6`, `actions/checkout@v6`, `gitleaks/gitleaks-action@v3`.
태그는 움직일 수 있으므로 "제3자 코드가 `main` scope job에서 실행된다"는 F3의
전제를 캐시 없이도 성립시킵니다. 가장 위험한 두 job은 **이미 SHA로 핀했습니다**
(`cron-auto-fix.yml:179`·`:207`, `feedback-autofix.yml:108`·`:116`). 이 감사의
세 축이 아니므로 권고하지 않고, 별도 판단 대상으로만 적습니다.

## 6. 이미 맞게 되어 있는 것 — 완화 PR이 되돌리면 안 되는 결정

| 결정 | 위치 |
|---|---|
| 자격증명 job이 Playwright 캐시를 복원하지 않고 매번 새로 내려받음 | `cron-auto-fix.yml:320`, `visual-baseline-record.yml:74` |
| lockfile 밖 설치에 명시적 sha512 핀 | `cron-auto-fix.yml:218-225`, `feedback-autofix.yml:146-154` |
| 가장 위험한 두 job의 action SHA 핀 | `cron-auto-fix.yml:179`·`:207`, `feedback-autofix.yml:108`·`:116` |
| `--ignore-scripts` | `pr-fast-gate.yml:684` |
| `Linux-next-` fallback 제거 | `pr-fast-gate.yml:809-810`, `:1014-1015` |
| 이미지 빌드에 secret·캐시 없음 | `engineering-agent-image.yml:4`, `:46-48` |
| `npm ci`를 일부러 하지 않음 | `deployed-commit-drift.yml:114-116` |
| 캐시 표면 0 | `secret-history-scan.yml`, `back-merge-main-to-develop.yml`, `codeql.yml` |
| secret을 한 step으로 좁힘 | `feedback-autofix.yml:157` ("LLM key only in this step") |
| Rust 캐시에 restore-keys 없음 | `orchestrator-rust.yml:54` |

## 7. 권고 — 우선순위 순

**어느 것도 이 감사에서 실행하지 않았습니다.** 각 항목에 승인·검토 요건을
적습니다.

### P1. `main`·`develop` scope에서 무검증 캐시 **저장**을 멈춥니다 — 1순위

대상: 2.1의 다섯 workflow의 `.next/cache`·ms-playwright 단계. 방법은
`actions/cache`를 `actions/cache/restore`로 바꾸는 것(복원은 유지, 저장만 중단)
입니다.

효과가 가장 큰 이유: 1장의 규칙상 PR scope 항목은 **그 PR의 re-run만** 복원할
수 있습니다. 기본·base scope에 무검증 항목을 만드는 주체가 없어지면 오염은 PR
하나에 갇히고, F1·F2가 함께 닫힙니다. 무결성 검사보다 **싸고**, `.next/cache`는
핀할 기대값이 아예 없으므로 사실상 유일한 실질 조치입니다.

비용:

- `.next/cache` — 이전 감사가 miss 비용을 측정했습니다: **~6초 이하**
  (`.github/audits/pr-fast-gate-performance-audit.md:115`). 사실상 무료입니다.
- ms-playwright — 새 PR의 **첫** run이 브라우저 다운로드를 추가로 냅니다(2회차
  부터는 자기 PR scope에서 warm). 그 비용은 그 감사의 측정 범위 밖이므로
  **산정 보류**입니다. `install-playwright.sh`가 기록한 13분 사례는 apt이고
  브라우저 다운로드가 아니므로 그 숫자를 빌려오면 안 됩니다. 결정 전에
  `Linux-playwright-*` 항목을 지우고 한 run을 측정하는 것이 맞습니다.

판단이 필요한 지점: ms-playwright 저장을 어디서 남길지. 모든 scope에서 끄면
첫 run 비용이 모든 PR에 걸립니다. 한 가지 중간 안은 PR workflow에서는 저장을
유지하고(PR scope로만 감) schedule·push-main job에서만 끄는 것입니다 — 그러면
기본 scope 항목이 사라지고 PR 비용은 그대로입니다. **이 안을 권고합니다.**

역할: `impl`. 계약 파일이 아니지만 필수 check의 입력을 바꾸므로 독립 검토
대상입니다.

### P2. restore-keys와 키 namespace를 끊습니다 — 1순위, P1과 독립

- `${{ runner.os }}-next-` fallback 다섯 곳 제거(F2의 목록). `pr-fast-gate`가
  이미 한 것과 같은 변경이고, 정합성 이득이 함께 옵니다. 비용 거의 없음.
- Playwright 키에 workflow 식별자를 넣어 pool을 쪼갭니다.

**P2만으로는 F1이 닫히지 않습니다.** 3.2의 여섯 job은 restore-keys를 지워도
`Linux-playwright-<lock>-chromium`이라는 **같은 primary key**를 공유합니다.
키에 식별자를 넣는 쪽이 본체이고 restore-keys 정리는 부수입니다. 이 점을
혼동하면 "좁혔다"고 적고 아무것도 좁히지 않게 됩니다.

역할: `impl`.

### P3. 분리를 규칙으로 고정합니다 — 2순위, F4의 답

**자격증명을 가진 job은 `cache: npm` 외의 Actions 캐시를 복원하지 않는다.**

구현은 새 스크립트가 **아니라** `lib/agentCredentialReachability.ts`의
`restoresCache`(:267-289)를 캐시 종류별로 나누고, 그 판정을 PR Fast Gate static
단계의 검사로 올리는 것입니다. 두 번째 판정기를 만들면 숫자가 어긋납니다 —
AGENTS.md가 PACKAGE-01 지표에 대해 같은 것을 요구합니다("ESLint 자체 API로
셉니다. 별도 scanner를 만들어 두 숫자가 어긋나게 하지 않습니다").

`tests/agentCredentialReachability.test.mjs:555`의 `POSTURE_DIGEST`가 함께
움직입니다. 그 digest는 소유자와 함께 읽고 나서 갱신하라고 :546-548이 적습니다.

역할: `contract`(`lib/agentCredentialReachability.ts`는 에이전트 권한 경계).
소유자 승인 + 독립 검토.

### P4. `cacheIsolationRecorded` 기록의 선행 조건을 정책에 박습니다 — 2순위, F5의 답

기록은 **두 방향을 따로** 서술해야 합니다.

- PR → 다른 ref: 닫혀 있음. 근거는 1장의 공식 규칙.
- 기본·base → PR: **열려 있음.** 이 방향의 근거는 격리가 아니라 P3의 검사
  — "무검증 캐시를 복원하는 job에 자격증명이 없다"입니다.

`docs/policy/engineering-agent.md:198-201` 변경이므로 역할은 `contract`이고
**소유자 승인이 필요합니다.** P3보다 먼저 쓰면 근거가 없는 기록이 됩니다 —
순서가 계약입니다.

### P5. 복원 후 무결성 검사 — 권고하지 않음, 대안으로만 기록

Playwright 바이너리 해시 핀은 브라우저 버전마다 바뀌어 유지보수가 비싸고,
`.next/cache`는 내용이 빌드마다 달라 핀할 기대값이 없습니다. P1이 더 싸고 더
확실합니다. 검사를 넣는다면 F6 때문에 `continue-on-error`가 없는 **별도
단계**여야 합니다.

### P6. 조사 항목 — 권고가 아닙니다

`main` scope writer의 `npm ci --ignore-scripts`. drop-in이 아닙니다:
`package.json`의 `postinstall`이 `prisma generate`이므로 명시적
`npx prisma generate` 단계가 필요합니다. `sharp@0.35`가 install script를
요구하는지는 **확인하지 않았습니다.** 확인 전에 권고하지 않습니다.

## 8. 이 감사가 증명하지 못한 것

1. **실제 캐시 항목의 내용.** GitHub의 캐시 목록·내용을 조회하지 않았습니다.
   오염 항목이 지금 있는지는 모릅니다.
2. **P1의 ms-playwright 비용.** 7장 P1에 산정 보류로 적었습니다.
3. **`.next/cache` 오염으로 번들에 코드를 넣을 수 있다는 것.** webpack/Turbopack
   의 파일시스템 캐시에 모듈 단위 무결성이 없다는 구조 판정이고, 이 저장소의
   Next 버전에서 실증한 것은 아닙니다. 실증된 것은 **버전이 다른 캐시가 빌드를
   깨뜨렸다**는 것뿐입니다(`pr-fast-gate.yml:806-808`).
4. **자격증명 판정 22건의 전수 근거.** 0장 4번에 적었습니다. `pr-fast-gate #
   fast-gate`가 왜 자격증명 보유로 판정되는지는 추적하지 않았습니다 — 그 job은
   캐시를 복원하지 않으므로 세 축에 영향이 없습니다.
5. **공격자 모델의 현실성.** 침해된 npm 의존성 하나를 전제로 합니다. 그 전제의
   확률은 평가하지 않았습니다.

## 9. 독립 검토

요청: Codex.
프롬프트: `.github/audits/actions-cache-poisoning-audit-independent-review-prompt-2026-10-03.md`
(이 PC에서 Codex는 명령을 실행할 수 없으므로 증거를 프롬프트에 그대로
싣습니다).
결과: 미기록.
