# 독립 검토 요청 — GitHub Actions 캐시 오염 경로 감사 (2026-10-03)

> **round 0의 기록입니다. 이 문서는 갱신하지 않습니다.** 아래 주장 C1~C8은
> 감사 **rev 1**에 대한 것이고, Codex는 reject했습니다(C1·C2·C4·C6·C7 틀림).
> 지적은 rev 2에 반영됐으므로, 현재 판정은 대상 문서의 머리말과 9장을
> 보십시오. rev 2에 대한 재검토는 아직 하지 않았습니다.

검토자: Codex. 작성자: Claude (Opus 5).
대상 문서: `.github/audits/actions-cache-poisoning-audit-2026-10-03.md`
기준 commit: `2f7550a5873606fecbfeec993c398a898a69ffcb` (`origin/main` 끝).

**이 PC에서 Codex는 명령을 실행할 수 없습니다.** 그래서 판정에 필요한 증거를
아래에 그대로 싣습니다. 1~6장은 제가 수집한 **원자료**이고, 7장이 **검토해
주실 주장**입니다. 저장소 파일을 직접 읽을 수 있다면 그것이 우선이고, 아래
인용과 다르면 그 차이를 지적해 주십시오.

검토 결과는 **신호이지 승인이 아닙니다.** 이 감사는 workflow를 하나도 바꾸지
않았고, 권고 실행에는 별도 소유자 승인이 필요합니다.

---

## 1. 과제와 범위

`.github/workflows/` 27개 workflow 전부에 대해 세 축을 조사했습니다.

1. 누가 `main`(기본 branch) scope 캐시에 쓸 수 있는가
2. 누가 캐시를 복원하고 그 내용을 실행하거나 신뢰하는가
3. 그 consumer job이 어떤 secret·권한을 들고 있는가

공격자 모델: **침해된 npm 의존성 하나**. GitHub-hosted Linux runner는
passwordless sudo이므로, `npm ci`가 실행하는 install script는 그 job의 Actions
runtime token에 닿고 그 token은 run의 ref scope에 캐시를 쓸 수 있습니다.

## 2. 전제 — GitHub 공식 캐시 scope 규칙

`https://docs.github.com/en/actions/reference/dependency-caching-reference` 에서
가져온 원문입니다.

- "Workflow runs can restore caches created in either the current branch or the
  default branch (usually `main`)."
- "If a workflow run is triggered for a pull request, it can also restore
  caches created in the base branch, including base branches of forked
  repositories."
- "When a cache is created by a workflow run triggered on a pull request, the
  cache is created for the merge ref (`refs/pull/.../merge`). Because of this,
  the cache will have a limited scope and can only be restored by re-runs of the
  pull request."
- "Workflow runs cannot restore caches created for child branches or sibling
  branches."

추가 전제 두 개(제가 적용한 것이며, 틀렸다면 지적해 주십시오):

- `actions/cache`는 이미 존재하는 key를 덮어쓰지 않는다.
- `actions/setup-node`는 `cache` 입력이 없으면 캐시를 쓰지 않으며, npm에 대해
  restore-keys를 쓰지 않고 primary key 정확 일치만 쓴다. key는
  `node-cache-{platform}-{arch}-npm-{hash(package-lock.json)}`.

## 3. 원자료 A — 캐시 키와 restore-keys 전수

`grep -nE "actions/cache|cache:|restore-keys|key:|path:" .github/workflows/*.yml`
의 결과를 정리한 것입니다.

### 3.1 `~/.cache/ms-playwright`

primary key `${{ runner.os }}-playwright-${{ hashFiles('package-lock.json') }}-chromium`:

```
admin-console-e2e.yml:177-180        path/key/restore-keys
e2e.yml:214-217
nightly-visual-regression.yml:87-90
pr-fast-gate.yml:840-843             (build-and-e2e)
pr-fast-gate.yml:1032-1035           (ui-risk)
review-parity-shadow.yml:127-130
```

primary key `...-chromium-webkit`:

```
daily-security-audit.yml:150-153     (audit job)
daily-security-audit.yml:296-299     (e2e job)
```

**여덟 곳 모두** restore-keys가
`${{ runner.os }}-playwright-${{ hashFiles('package-lock.json') }}-` 한 줄입니다.

예시 원문 (`pr-fast-gate.yml:835-843`):

```yaml
      - name: Restore Playwright Chromium cache
        if: steps.scope.outputs.code == 'true'
        continue-on-error: true
        uses: actions/cache@v5
        with:
          path: ~/.cache/ms-playwright
          key: ${{ runner.os }}-playwright-${{ hashFiles('package-lock.json') }}-chromium
          restore-keys: |
            ${{ runner.os }}-playwright-${{ hashFiles('package-lock.json') }}-
```

### 3.2 `.next/cache`

primary key는 workflow마다 다릅니다 — `Linux-next-{daily,visual,admin-e2e,main,parity,pr}-<lock>-<src>`.
restore-keys의 두 번째 줄에 broad fallback이 있는 곳:

```
admin-console-e2e.yml:161-163        -> "${{ runner.os }}-next-"
daily-security-audit.yml:77-79       -> "${{ runner.os }}-next-"
daily-security-audit.yml:279-281     -> "${{ runner.os }}-next-"
e2e.yml:197-199                      -> "${{ runner.os }}-next-"
nightly-visual-regression.yml:73-75  -> "${{ runner.os }}-next-"
review-parity-shadow.yml:101-103     -> "${{ runner.os }}-next-"
```

broad fallback이 **없는** 곳 — `pr-fast-gate.yml:799-810`, 주석 포함 원문:

```yaml
      - name: Restore Next.js build cache
        if: steps.scope.outputs.code == 'true'
        continue-on-error: true
        uses: actions/cache@v5
        with:
          path: .next/cache
          key: ${{ runner.os }}-next-pr-${{ hashFiles('package-lock.json') }}-${{ hashFiles('app/**/*.ts', ...) }}
          # Stop at next-pr-<lockfile>. A bare Linux-next- prefix also matches
          # Linux-next-admin-e2e- from another workflow. That cache was built
          # with Next 16.3.4 and breaks a 16.3.5 Turbopack font build.
          restore-keys: |
            ${{ runner.os }}-next-pr-${{ hashFiles('package-lock.json') }}-
```

`pr-fast-gate.yml:1004-1015`(ui-risk)에 같은 주석과 같은 좁힌 restore-keys가
있습니다.

### 3.3 Rust (`orchestrator-rust.yml:46-54`)

```yaml
      - name: Restore Rust build cache
        uses: actions/cache@v5
        with:
          path: |
            ~/.cargo/registry
            ~/.cargo/git
            target
            vendor/amux/target
          key: ${{ runner.os }}-rust-workspaces-${{ hashFiles('Cargo.lock', 'vendor/amux/Cargo.lock') }}
```

restore-keys 없음. trigger는 `pull_request` + `push: branches: [main, develop]`
(:15-19).

### 3.4 `cache: npm` (setup-node) 위치 전수

```
admin-console-e2e.yml:153            memory-eval-decision-grade.yml:142
credit-finance-db-integration.yml:176  memory-eval-development-probe.yml:81
cron-auto-fix.yml:210                memory-eval-inspect-artifact.yml:53
daily-security-audit.yml:68          nightly-visual-regression.yml:65
daily-security-audit.yml:269         pr-fast-gate.yml:135, :711, :797, :1002
daily-security-audit.yml:356         review-parity-shadow.yml:92
e2e.yml:189                          router-eval-pilot.yml:134
fal-price-drift.yml:65               router-human-review-recovery-probe.yml:45
feedback-autofix.yml:119             router-human-review-sheets.yml:94
feedback-autofix-promotion-pr.yml:125  router-judge-cap-probe.yml:128
                                     visual-baseline-record.yml:65
                                     voice-price-reverification-notice.yml:59
```

`setup-node`를 쓰지만 `cache:` 입력이 **없는** 곳:
`back-merge-main-to-develop.yml:281`, `credit-finance-db-integration.yml:243`,
`deployed-commit-drift.yml:110`.

`setup-node`가 아예 없는 workflow: `secret-history-scan.yml`, `codeql.yml`,
`engineering-agent-image.yml`, `auto-pr-to-develop.yml`.

### 3.5 모든 `actions/cache` 복원 단계에 `continue-on-error: true`

```
admin-console-e2e.yml:156, :174      nightly-visual-regression.yml:68, :84
daily-security-audit.yml:72, :147, :274, :293    pr-fast-gate.yml:801, :837, :1006, :1029
e2e.yml:192, :211                    review-parity-shadow.yml:96, :124
```

(`orchestrator-rust.yml:47`에는 없습니다.)

## 4. 원자료 B — trigger와 scope

```
admin-console-e2e.yml:50-57      pull_request / push:[develop, main] / dispatch
auto-pr-to-develop.yml:3-31      push:["to-develop/**","**/to-develop/**"]
back-merge-main-to-develop.yml:88-92  push:[main] / dispatch
codeql.yml:14-21                 push:[main] / pull_request:[main] / schedule
credit-finance-db-integration.yml:3-83  pull_request(paths) / push:[main,develop] / dispatch
cron-auto-fix.yml:44-55          schedule "15 0,1 * * *" / dispatch
daily-security-audit.yml:3-7     schedule "0 21 * * *" / dispatch
deployed-commit-drift.yml:70-81  schedule "20 * * * *" / dispatch
e2e.yml:46-51                    pull_request:[main] / dispatch        <-- push:main 아님
engineering-agent-image.yml:12-25  push:[main](paths)
fal-price-drift.yml:28-34        schedule "0 22 * * *" / dispatch
feedback-autofix.yml:28-29       dispatch
feedback-autofix-promotion-pr.yml:24-35  pull_request:closed:[develop] / dispatch
memory-eval-*.yml                dispatch
nightly-visual-regression.yml:28-33  schedule "30 19 * * *" / dispatch
orchestrator-rust.yml:14-19      pull_request / push:[main,develop] / dispatch
pr-fast-gate.yml:60-63           pull_request
review-parity-shadow.yml:23-26   pull_request
router-*.yml                     dispatch
secret-history-scan.yml:18-25    pull_request / push:[main] / schedule / dispatch
visual-baseline-record.yml:30-37 dispatch
voice-price-reverification-notice.yml:26-32  schedule "10 7 * * *" / dispatch
```

`npm ci` 위치(모두 `--ignore-scripts` 없음, `pr-fast-gate.yml:684` 하나만 예외):

```
admin-console-e2e.yml:167    daily-security-audit.yml:85, :284, :361
credit-finance-db-integration.yml:179    e2e.yml:202
cron-auto-fix.yml:213        fal-price-drift.yml:69
nightly-visual-regression.yml:78    pr-fast-gate.yml:165, :715, :815, :1020
review-parity-shadow.yml:108    visual-baseline-record.yml:68
(그 외 dispatch workflow 전부)
```

`package.json`의 lifecycle script는 `postinstall: prisma generate` 하나입니다.
`preinstall`/`install`/`prepare` 없음. 네이티브·빌드스크립트 후보 의존성:
`sharp ^0.35.4`, `prisma ^7.10.0`, `@prisma/client ^7.10.0`,
`@playwright/test ^1.63.0`.

`scripts/ci/install-playwright.sh`는 두 half로 나뉩니다 —
`npx playwright install-deps`(apt)와 `npx playwright install`(브라우저). 후자에
대한 그 파일의 주석:

> Second, and separately: on a cache hit this is a no-op that costs a second,
> which is the whole reason the two are not one command.

`.github/audits/pr-fast-gate-performance-audit.md`의 측정:

- :348 "Playwright 캐시는 **매번 primary key 적중** (키가 lockfile 해시만 포함
  → lockfile이 안 바뀌면 항상 warm)"
- :355 "`npx playwright install chromium` (브라우저, 캐시 적중 시 즉시 종료)"
- :115 `.next/cache` miss 시 추가 비용 "**~6초 이하** `[로컬 측정]`"

## 5. 원자료 C — 저장소 자신의 분석기 출력

`lib/agentCredentialReachability.ts`를 기준 commit의 실제 27개 workflow에 대해
실행했습니다(`exclusions: []`, `cacheIsolationRecorded: false` — 운영 호출자
둘 다 이 값입니다).

```
forbidsAll: true

--- credentialed jobs (22) ---
auto-pr-to-develop.yml # auto-pr                 back-merge-main-to-develop.yml # back-merge
back-merge-main-to-develop.yml # verify          codeql.yml # analyze
credit-finance-db-integration.yml # report-red-lane
credit-finance-db-integration.yml # credit-finance-db-result
cron-auto-fix.yml # discover                     cron-auto-fix.yml # attempt-fix
daily-security-audit.yml # report                deployed-commit-drift.yml # drift
engineering-agent-image.yml # image              fal-price-drift.yml # price-drift
feedback-autofix-promotion-pr.yml # promotion-pr feedback-autofix.yml # discover
feedback-autofix.yml # attempt-fix               memory-eval-decision-grade.yml # run
memory-eval-development-probe.yml # run          pr-fast-gate.yml # fast-gate
router-eval-pilot.yml # run                      router-judge-cap-probe.yml # probe
visual-baseline-record.yml # record              voice-price-reverification-notice.yml # notice

--- reasons (17) ---
credential_job_restores_cache  <-  back-merge-main-to-develop.yml # verify
credential_job_restores_cache  <-  credit-finance-db-integration.yml # report-red-lane
credential_job_restores_cache  <-  cron-auto-fix.yml # attempt-fix
credential_job_restores_cache  <-  daily-security-audit.yml # report
credential_job_restores_cache  <-  deployed-commit-drift.yml # drift
credential_job_restores_cache  <-  fal-price-drift.yml # price-drift
credential_job_restores_cache  <-  feedback-autofix-promotion-pr.yml # promotion-pr
credential_job_restores_cache  <-  feedback-autofix.yml # attempt-fix
credential_job_restores_cache  <-  memory-eval-decision-grade.yml # run
credential_job_restores_cache  <-  memory-eval-development-probe.yml # run
credential_job_restores_cache  <-  router-eval-pilot.yml # run
credential_job_restores_cache  <-  router-judge-cap-probe.yml # probe
credential_job_restores_cache  <-  visual-baseline-record.yml # record
credential_job_restores_cache  <-  voice-price-reverification-notice.yml # notice
credential_job_reached_without_path_filter  <-  auto-pr-to-develop.yml # -
credential_job_reached_without_path_filter  <-  feedback-autofix-promotion-pr.yml # -
credential_job_reached_without_path_filter  <-  pr-fast-gate.yml # -
```

관련 소스:

- `lib/agentCredentialReachability.ts:61` — `credential_job_restores_cache` 정의
- `:267-289` — `restoresCache`. `:283-286`이 `actions/setup-*`를 "`cache`가
  명시적으로 false가 아니면 복원"으로 봅니다.
- `:369-370` — `cacheIsolationRecorded`의 정의 주석: "A dated record that
  pull_request-run caches never reach other refs' runs."
- `:493-497` — 그 설정만이 cache 규칙을 풀며, job별 exclusion은 못 푼다.
- 호출자 둘, 둘 다 `false`: `tests/agentCredentialReachability.test.mjs:13`·`:561`,
  `scripts/report-engineering-agent-tiers.mjs:144`
- `docs/policy/engineering-agent.md:198-201` — 계약 원문:

> **cache 경로**: 자격증명을 가진 job이 Actions cache를 복원하면, 그 job은
> trigger·path filter와 무관하게 도달한 것으로 보고 **모든 변경이 push
> 금지**다. 이 가정을 푸는 방법은 job별 제외가 아니라, cache의 ref 간 공유
> 범위에 대한 날짜 있는 확인 기록 하나를 분석기 설정에 고정하는 것뿐이다.

## 6. 원자료 D — secret과 권한

workflow-level `permissions`:

```
contents: read 만            : admin-console-e2e, back-merge-main-to-develop,
                               credit-finance-db-integration, deployed-commit-drift,
                               e2e, fal-price-drift, feedback-autofix,
                               feedback-autofix-promotion-pr, memory-eval-*,
                               nightly-visual-regression, orchestrator-rust,
                               review-parity-shadow, router-*
actions: read + contents: read : daily-security-audit (:9-11)
actions,contents,pull-requests: read : pr-fast-gate (:64-67)
contents: read + pull-requests: write : auto-pr-to-develop (:33-35)
contents: write + pull-requests: write : cron-auto-fix (:57-59)
contents: read + packages: write : engineering-agent-image (:27-29)
contents: write             : visual-baseline-record (:38-39)
contents: read + issues: write : voice-price-reverification-notice (:34-38)
security-events: write 등 (job-level) : codeql (:33-42)
```

secret 참조 — 캐시를 **복원하는** job만 추려서:

```
cron-auto-fix # attempt-fix        GH_AUTOMATION_PAT :182, ANTHROPIC_API_KEY :238,
                                   AUTO_FIX_SYNC_SECRET :277,:288,:333,:354
daily-security-audit # report      RESEND_API_KEY :373, SECURITY_AUDIT_SLACK_WEBHOOK_URL :367,
                                   SECURITY_AUDIT_EMAILS :368
fal-price-drift # price-drift      FAL_KEY :78, :93
voice-price-... # notice           GITHUB_TOKEN :66 (+ issues: write)
feedback-autofix # attempt-fix     FEEDBACK_AUTOFIX_ANTHROPIC_API_KEY :161,
                                   GH_AUTOMATION_PAT :303, FEEDBACK_AUTOFIX_SYNC_SECRET
feedback-autofix-promotion-pr      GH_AUTOMATION_PAT :149, :191, sync secret :89
memory-eval-decision-grade # run   OPENAI_API_KEY :199
memory-eval-development-probe # run OPENAI_API_KEY :125
router-eval-pilot # run            OPENAI_API_KEY/DEEPSEEK_API_KEY/ANTHROPIC_API_KEY
                                   :199-201, :234, :276-277, :342-344
router-judge-cap-probe # probe     ANTHROPIC_API_KEY :167, :177
visual-baseline-record # record    (secret 없음, contents: write)
```

이 열한 job이 복원하는 캐시는 **전부 `cache: npm` 하나뿐**입니다(3.4 참조).
`.next/cache`나 ms-playwright를 복원하는 job 정의(아래 아홉)는 전부
`contents: read`이고 외부 API 자격증명이 없습니다.

```
admin-console-e2e # admin-console-e2e    daily-security-audit # audit
daily-security-audit # e2e (6 shard)     e2e # playwright (5 shard)
nightly-visual-regression # visual-regression
pr-fast-gate # build-and-e2e             pr-fast-gate # ui-risk
review-parity-shadow # review-parity     orchestrator-rust # workspace
```

(`daily-security-audit # audit`은 `gitleaks` step에서 `secrets.GITHUB_TOKEN`
:59를 쓰지만, 그 step은 `setup-node` :65와 캐시 복원 :73 **앞**이고
workflow 권한은 `actions: read, contents: read`입니다.)

캐시를 복원하지 않고 Playwright를 매 run 새로 내려받는 자격증명 job 둘:
`cron-auto-fix.yml:320`, `visual-baseline-record.yml:74`.

lockfile 밖 설치에 명시적 sha512 핀이 걸린 곳 둘:
`cron-auto-fix.yml:218-225`, `feedback-autofix.yml:146-154`.

---

## 7. 검토해 주실 주장

각 항목에 **맞음 / 틀림 / 근거 부족**과 이유를 주십시오. 특히 "제가 과장했다"
와 "제가 축소했다" 양쪽을 봐 주십시오 — 이 감사는 결론을 두 번 **낮췄고**
(F1·F2를 차단 사유로 올리지 않았습니다), 그 판단이 틀렸을 수 있습니다.

### C1. 열려 있는 방향은 `main`·`develop` → 모든 PR이다

2장의 규칙에서, PR → 다른 ref는 닫혀 있고 기본·base → 모든 run은 열려 있다.
따라서 `schedule`·`push: main` job이 쓴 항목은 PR Fast Gate를 포함한 모든 run이
복원한다. **맞습니까?**

### C2. Playwright 캐시는 lockfile 해시당 pool 하나다

3.1의 여덟 곳이 primary key 둘(`-chromium`, `-chromium-webkit`)과 공통
restore-keys prefix 하나를 공유하므로, 사실상 하나의 pool이다. 그리고
`actions/cache`가 덮어쓰지 않으므로 `main` scope의 첫 writer가 lockfile이
바뀔 때까지 그 항목을 소유한다. **맞습니까? 특히 `-chromium-webkit` 항목이
`-chromium`을 primary로 쓰는 job의 restore-keys에 맞는다는 판정이 맞습니까?**

### C3. `npm` cacache와 나머지 셋은 다른 위험이다

`npm ci`는 lockfile integrity와 대조하므로 치환은 `EINTEGRITY`로 실패하고,
결과는 코드 실행이 아니라 가용성이다. `.next/cache`·ms-playwright·Rust
`target`에는 그 검증이 없다. **맞습니까?** 특히:

- npm cacache 오염으로 `npm ci`가 다른 코드를 **설치하게** 만들 현실적 경로가
  있습니까? (packument 캐시, cacache index 위조, `npm ci`가 lockfile 밖을
  보는 경우 등)
- `npm pack @anthropic-ai/claude-code`(`cron-auto-fix.yml:220`)는 lockfile
  밖이지만 :221-225의 sha512 대조로 막힙니까?

### C4. 자격증명 job과 무검증 캐시의 교집합은 현재 없다

6장의 열한 건 대 아홉 건 분리(matrix 전개가 아니라 job 정의 수). **맞습니까?** 제가 놓친 job이 있습니까?
특히 `daily-security-audit # audit`을 "자격증명 없음"으로 분류한 것 —
`gitleaks` step의 `secrets.GITHUB_TOKEN`이 캐시 복원 앞이고 권한이 전부 read
라는 이유 — 가 타당합니까? job env에 상시 존재하는 `ACTIONS_RUNTIME_TOKEN`을
자격증명으로 세야 합니까?

### C5. 분석기의 "restores" 3건은 과대추정이다

`back-merge # verify`, `credit-finance # report-red-lane`,
`deployed-commit-drift # drift`는 `setup-node`에 `cache:` 입력이 없으므로 실제
복원자가 아니다. **맞습니까?** `actions/setup-node`의 `cache` 기본값이 정말
"없음"입니까?

### C6. 되돌릴 수 있음/없음 분류

AGENTS.md 기준은 "무엇이 복구 불가인지 한 줄로 적을 수 없으면 차단이
아니다"입니다. 제 분류:

| 항목 | 제 분류 | 근거 |
|---|---|---|
| F1 Playwright pool | 되돌릴 수 있음, 1순위 | 캐시 삭제 가능, 그 job에 자격증명 없음 |
| F2 `.next/cache` broad key | 되돌릴 수 있음, 1순위 | 같음. 단 실제 작동 기록 있음 |
| F4 분리 유지 장치 부재 | 지금 되돌릴 수 있음 / 한 줄 추가되면 되돌릴 수 없음 | 자격증명 유출은 회수 불가 |
| F5 `cacheIsolationRecorded` | 되돌릴 수 없음에 가장 가까움, 선행 조건 | 잘못된 근거로 풀린 blanket ban → 자격증명 유출 |

**이 분류가 맞습니까?** 두 가지를 특히 봐 주십시오.

- F1·F2를 차단 사유로 **올리지 않은** 것이 맞습니까? 필수 check가 잘못 green이
  되는 것은 "고쳐서 배포하면 끝나는 것"입니까, 아니면 그 경로로 통과한
  migration·가격 변경 때문에 차단이어야 합니까? 저는 "gate 오판은
  복구 불가의 **메커니즘**이지 복구 불가 자체가 아니다"로 보고 내렸습니다.
- F5를 가장 높게 둔 것이 맞습니까? 기록이 아직 **없으므로** 현재 결함이
  아니라 선행 조건으로 적었는데, 그 구분이 타당합니까?

### C7. 권고의 우선순위와 비용

- **P1** (`main`·`develop` scope에서 무검증 캐시 **저장** 중단, `actions/cache`
  → `actions/cache/restore`)을 1순위로, 무결성 검사(P5)보다 **싸다**고 판정.
  권고안은 "PR workflow는 저장 유지(PR scope로만 감), schedule·push-main job만
  끈다". **맞습니까?** PR scope 저장을 남겨도 열린 방향이 닫힙니까?
- **P2** (restore-keys 좁히기)만으로는 F1이 닫히지 않는다 — 여섯 job이 같은
  primary key를 공유하므로 키에 workflow 식별자를 넣는 쪽이 본체다.
  **맞습니까?**
- **P3** (자격증명 job은 `cache: npm` 외 캐시를 복원하지 않는다를 PR Fast Gate
  검사로) 구현을 **기존 `lib/agentCredentialReachability.ts` 재사용**으로 한
  것 — 두 번째 판정기를 만들면 숫자가 어긋난다는 이유 — 이 맞습니까?
  `tests/agentCredentialReachability.test.mjs:555`의 `POSTURE_DIGEST`가 함께
  움직인다는 지적이 맞습니까?
- **P6** (`npm ci --ignore-scripts`)을 권고가 아니라 **조사 항목**으로 남긴
  것 — `postinstall: prisma generate` 때문에 drop-in이 아니고 `sharp@0.35`를
  확인하지 않았다 — 이 맞습니까?

### C8. 빠진 것

세 축에서 제가 **놓친 경로**가 있습니까? 후보로 생각했지만 범위 밖으로 둔 것:

- `codeql.yml`의 CodeQL action 내부 캐시(GitHub 관리)
- `actions/download-artifact`로 다른 run의 artifact를 읽는 세 곳
  (`memory-eval-inspect-artifact.yml:83`, `router-human-review-sheets.yml:140`,
  `router-judge-cap-probe.yml:149`) — 캐시가 아니라 artifact이므로 제외
- action 버전 태그 핀(`@v5`/`@v6`) — 캐시가 아니므로 "인접 경로"로만 기록
- `vendor/amux` 하위 트리

이 제외들이 타당합니까?

---

## 8. 요청 형식

항목 번호(C1~C8)별로:

```
C_: 맞음 | 틀림 | 근거 부족
근거:
(틀림이면) 올바른 판정:
```

그리고 마지막에 전체 판정 — **accept / reject** 와, reject면 문서에서 고쳐야
할 지점을 path:line으로.
