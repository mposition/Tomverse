# GitHub Actions 캐시 오염 경로 감사 (2026-10-03)

> **인용은 번호가 아니라 anchor로 적습니다**(2026-10-07 전수 재검증).
> 조사 시점의 `path:line`은 그 뒤 여러 세션이 workflow를 편집하면서 밀렸습니다.
> 63건을 트리에서 되읽어 본 결과 약 40건이 빈 줄이나 무관한 키를 가리켰고, 그중
> 둘은 **의도와 반대되는 곳**을 가리켰습니다 — §6의 sha512 핀 인용이
> `FEEDBACK_AUTOFIX_SYNC_SECRET`를 든 heartbeat 단계를 가리키고 있었습니다.
>
> 주장 자체는 대체로 맞았습니다. 예를 들어 3.4의 "열여섯 곳"은 지금도 정확합니다
> (`actions/cache*` 단계 17개 중 16개). 틀린 것은 번호뿐이었으므로, 번호를 다시
> 맞추는 대신 **밀리지 않는 것**으로 바꿨습니다 — step 이름, 상수 이름, 명령
> 문자열, 그리고 개수 주장은 개수와 다시 세는 방법.
>
> **범위를 정직하게 적습니다.** 그 재검증이 덮은 것은 `` `파일:줄` `` 형태로
> backtick 안에 있던 **63건**이고, 그중 약 40건을 고쳤습니다. 문서 전체에는
> `(:809-810)`처럼 괄호 안에 번호만 있는 형태까지 합쳐 **186건**의 줄 참조가
> 있으며, 그 나머지는 **확인하지 않았습니다** — 독립 검토가 2026-10-07에 그
> 누락을 지적했고, 그때 고친 것은 그 지적이 이름 댄 것뿐입니다. 이 문서의 줄
> 번호는 조사 시점의 snapshot이고 **유지되지 않습니다.** 인용이 step·상수·명령
> 이름을 함께 들고 있으면 **이름이 권위 있는 쪽**이고, 번호와 어긋나면 번호가
> 낡은 것입니다.
>
> 다른 감사 문서(`pr-fast-gate-performance-audit.md`)로의 인용은 번호를
> 유지합니다 — 그쪽은 날짜가 박힌 기록이고 움직이지 않습니다.
>
> **2026-10-08 추가 회차.** 위에서 "확인하지 않았다"고 적은 나머지 중, **2장의
> trigger·key 표(줄 참조 76건)를 뺀 전부**를 트리에서 되읽었습니다. 표 밖에서
> 번호로 남은 것은 `cron-auto-fix.yml`·`feedback-autofix.yml`의 설치·핀 인용과
> `pr-fast-gate-performance-audit.md` 세 건이며, 이번에 다시 읽어 **그대로
> 맞습니다.** 괄호 안 번호 형태는 읽어 본 것이 전부 밀려 있었고(한 건은
> `e2e.yml`의 trigger와 그 주석이 **서로 바뀌어** 있었습니다) 모두 이름으로
> 바꿨습니다. **2장의 표는 아직 확인하지 않았습니다.**
>
> 이 회차가 찾은 것은 번호만이 아닙니다. **3.2와 3.3의 주장 자체가 낡았습니다** —
> 캐시 key가 workflow마다 구획된 뒤로 그 두 절이 전제한 공유 항목과 broad
> fallback이 존재하지 않습니다. 3.2 앞의 갱신 주석에 전수 수집 결과를 표로
> 넣았습니다. 4.2의 분석기 셈도 그 뒤 판정이 세분화됐고, 선언을 거둔 뒤의
> 자격증명 캐시 복원 수는 **4.3의 0건**입니다(P1a는 `cache-mode` 쪽 측정입니다). **번호가 밀린 것과 주장이 바뀐 것은 다른 사건이고, 번호만 고치면
> 뒤쪽을 놓칩니다.**
>
> 그래서 2장, 3.1의 Rust 단락, 2.1 뒤의 `e2e.yml` 단락, 그리고 **F1·F2·F3·F4**에
> 각각 날짜 있는 갱신 주석을 달았습니다 — `cache-mode: read`가 24개 workflow에
> 선언되고 쓸 수 있는 둘이 `pull_request` 전용이라 **`main`·`develop` scope의
> writer가 0**이기 때문입니다. F4는 그 사이 검사가 생겨(`check:credential-cache-separation`
> 등) 해소됐습니다.
>
> 다시 세어 **그대로 맞은 것도 적습니다** — 3.4와 F6의 "열여섯 곳"은 지금도
> 정확하고(캐시 단계 17개 중 16개, 예외는 `orchestrator-rust.yml`의
> `Restore the downloaded crates`), 2장의 install script 10개도 그대로입니다.
> 낡은 것만 고르고 맞은 것을 말하지 않으면 **문서가 어디까지 확인됐는지 알 수
> 없습니다.**
>
> **상태: 조사 완료, 독립 검토 반영(rev 4 — 2026-10-08 인용 회차와 2장·3.1·3.2·3.3·F1~F4 갱신), 조치 없음.** 이 감사는
> workflow를 하나도 바꾸지 않았습니다. 7장의 권고는 소유자 승인 전 제안이며,
> 각 항목에 승인·검토 요건을 적었습니다.
>
> **rev 3**은 검토 서버 round 2(codex)의 reject를 반영한 것입니다. major 둘 중
> 하나는 이 감사가 **§16을 위반해 미해소 자격증명 도달 목록을 공개 저장소에
> push한 것**이고, 그것이 이 세션에서 유일하게 **되돌릴 수 없는** 사건입니다 —
> 경위·범위·완화의 실제 크기·소유자 결정 사항은 **10장**에 있습니다. rev 3
> 자체는 아직 검토를 받지 않았습니다(9장).
>
> **rev 2에서 바뀐 것**(9장의 검토 결과 반영, 초안의 판정을 뒤집은 것 포함):
> F5는 **틀렸고** 2순위에서 3순위로 내렸습니다 — 분석기의 cache 규칙은
> 에이전트가 심은 캐시만 묻고 그 질문에 그 기록이 정확히 답합니다. F1의 "pool
> 하나"는 "exact 항목 하나 + exact miss 시 교차 fallback"으로, "PR job의 runtime
> token이 `main` scope를 다시 쓴다"는 주장은 삭제했습니다. "자격증명 없음"은
> "장기 외부 secret·repository write 자격증명 없음"으로 한정했습니다. 1장의
> "모든 run이 복원"은 "복원 후보"로, 항목 수명은 삭제·퇴출·cache version으로
> 고쳤습니다. 4.2에 `setup-node@v6`의 `package-manager-cache` 기본값과
> `packageManager` 필드가 만드는 잠복 경로를 추가했습니다. P1에 `push: develop`·
> dispatch·기존 항목 삭제·Rust 범위·조건부 save를, P3에 `POSTURE_DIGEST`가 캐시
> 종류를 담지 않는다는 맹점을 추가했습니다.
>
> **rev 2에서 찾은 F5의 세 번째 방향:** 공식 규칙이 닫는 것은 **다른 ref**이고
> **같은 PR의 re-run**은 복원할 수 있으므로, `cacheIsolationRecorded` 기록의
> 근거는 "다른 ref는 닫혀 있다"만으로 충분하지 않습니다. 다만 rev 2가 든
> **사례는 틀렸고**(그 job의 `if:`가 에이전트 브랜치를 배제합니다) round 2가
> 그것을 잡았습니다 — rev 3은 "구조는 열려 있고 오늘 사례는 없다"로 적습니다.

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

여기서 따라오는 것이 이 감사의 핵심입니다. **scope는 복원의 자격 조건이지
복원 자체가 아닙니다** — 항목이 실제로 쓰이려면 scope 안에 있고, cache
version이 맞고, primary key가 정확히 일치하거나 restore-key prefix에 맞아야
합니다.

- **`main` scope 항목은 이 저장소의 모든 run에서 복원 **후보**가 됩니다** — PR
  Fast Gate를 포함해서.
- **`develop` scope 항목은 `develop` 자신의 run과 base가 `develop`인 PR에서만
  후보입니다.** 이 저장소의 기능 PR은 `develop`을 향하므로(AGENTS.md "main으로
  가는 PR은 release와 hotfix뿐입니다") 그 PR 대부분이 해당되지만, **main을
  향하는 release·hotfix PR은 해당되지 않습니다.**
- **반대 방향(PR → 다른 ref)은 닫혀 있습니다.** 5장 F5가 이 사실을 다룹니다.
- `schedule`은 기본 branch에서 돕니다 → **`main` scope**. `workflow_dispatch`는
  고른 ref의 scope입니다.

그리고 `actions/cache`는 **이미 있는 key를 덮어쓰지 않습니다.** 그래서 어떤
exact key에 대해 `main` scope에 먼저 도착한 writer가 그 항목을 소유하고, PR
run의 저장은 자기 merge-ref scope로 가므로 그것을 밀어내지 못합니다. 소유가
끝나는 조건은 lockfile 변경이 아니라 **항목 삭제·미사용 퇴출·cache version
변경**입니다 — lockfile이 바뀌면 key가 바뀌어 새 항목이 생기지만, 옛 항목은
퇴출될 때까지 자기 key로 남습니다. restore-key prefix에 후보가 여럿이면 **가장
최근 항목**이 선택됩니다.

## 2. 축 1 — `main`·`develop` scope 캐시에 쓸 수 있는 job

> **2026-10-08: 이 장이 세는 writer는 더 이상 그만큼이 아닙니다.** 아래 2.1·2.2의
> 표는 2026-10-03의 트리이고 기록으로 남깁니다. 그 뒤 두 가지가 일어났습니다 —
> 널리 읽히는 24개 workflow가 최상위 `cache-mode: read`를 선언해 **토큰 자체가**
> 쓸 수 없게 됐고(7장 P1a, 측정 포함), 자격증명을 가진 열 job에서 npm 캐시 선언을
> 거뒀습니다(4.3, 지금 0건).
>
> **이 장이 묻는 것에 대한 답은 2026-10-08 현재 0입니다.** 캐시에 쓸 수 있는
> workflow는 `pr-fast-gate`와 `review-parity-shadow` 둘뿐이지만(`cache-mode`
> 선언 없음 + `actions/cache@`), **둘 다 `pull_request` 전용**이므로 그 save는
> `refs/pull/<n>/merge` scope에 남습니다 — `main`·`develop` scope에는 쓰지
> 않습니다. 2.1의 나머지와 `orchestrator-rust`는 `cache-mode: read`이고 캐시
> 단계가 `actions/cache/restore@`이므로 어느 scope에도 쓸 수 없습니다.
>
> **쓸 수 없다는 것이 복원하지 않는다는 뜻은 아닙니다.** `admin-console-e2e`·
> `daily-security-audit`·`e2e`·`nightly-visual-regression`은 `actions/setup-node@v6`에
> `cache: npm`을 그대로 두고 있어 npm 캐시를 계속 **복원**합니다. `cache-mode: read`가
> 거절하는 것은 save입니다.
>
> 공격자 모델 자체와 2.1이 세는 install script 10개는 이 변경과 무관하게 그대로
> 입니다(2026-10-08 lockfile에서 다시 세어 10개) — 바뀐 것은 **그 코드가 쥐는
> 토큰이 캐시에 쓸 수 있는지**입니다.

공격자 모델은 **침해된 제3자 의존성 하나**입니다. `npm ci`는
`--ignore-scripts` 없이는 의존성의 install script를 실행합니다. 이 저장소에서
`--ignore-scripts`를 쓰는 곳은 `pr-fast-gate.yml`의 `npm ci --prefix vendor/amux --ignore-scripts` **한
곳뿐**이고, 현재 lockfile에서 `hasInstallScript`인 패키지는 **10개**입니다
(`@prisma/engines`, `prisma`, `esbuild`, `@sentry/cli`, `tesseract.js`,
`unrs-resolver`, `fsevents` 3경로). 그 코드는 그 job의 Actions runtime token에
닿습니다 — GitHub-hosted Linux runner는 passwordless sudo이므로 격리는 없습니다.

**Rust 경로는 같은 모델로 설명되지 않습니다.** `orchestrator-rust.yml`의 캐시를
쓰는 것은 `npm ci`가 아니라 `cargo`이고, 그 foothold는 침해된 **crate**의 build
script입니다(`Cargo.lock`·`vendor/amux/Cargo.lock`이 정하는 의존성). 아래 2.1에
함께 적지만, 그것은 npm 모델의 사례가 아니라 **별개 모델의 같은 구조**입니다 —
7장 P1이 Rust를 범위에 넣을지 따로 판단합니다.

### 2.1 무결성 검증이 없는 캐시를 `main`·`develop` scope에 쓰는 job

| workflow | trigger | scope | 쓰는 항목 | 제3자 코드 |
|---|---|---|---|---|
| `daily-security-audit.yml` | `schedule` :4-6 | **main** | `.next/cache` → `Linux-next-daily-*` :73-79, `~/.cache/ms-playwright` → `Linux-playwright-<lock>-chromium-webkit` :148-153; `e2e` job이 같은 두 키 :275-281, :294-299 | `npm ci` :85, :284, :361 |
| `nightly-visual-regression.yml` | `schedule` :29-32 | **main** | `.next/cache` → `Linux-next-visual-*` :69-75, ms-playwright → `Linux-playwright-<lock>-chromium` :85-90 | `npm ci` :78 |
| `admin-console-e2e.yml` | `push` :53-56 | **main + develop** | `.next/cache` → `Linux-next-admin-e2e-*` :157-163, ms-playwright → `Linux-playwright-<lock>-chromium` :175-180 | `npm ci` :167 |
| `orchestrator-rust.yml` | `push` :17-18 | **main + develop** | `~/.cargo/registry`, `~/.cargo/git`, `target`, `vendor/amux/target` → `Linux-rust-workspaces-*` :47-54 | `cargo` build script |
| `e2e.yml` | `workflow_dispatch` :51 | 고른 ref | `.next/cache` → `Linux-next-main-*` :193-199, ms-playwright → `Linux-playwright-<lock>-chromium` :212-217 | `npm ci` :202 |

`e2e.yml`은 2026-10-02부터 `push: main`이 아니라 `pull_request: branches:[main]`
입니다(`on:`의 `pull_request:` 아래 `branches:`가 `main` 하나이고, 그 바로 위
주석이 draft PR과 release PR의 check suite 때문임을 적습니다). 따라서 그 PR run은
PR scope에만 씁니다. `main` scope에 쓰는 경로는 `workflow_dispatch`를 `main`에서
돌릴 때만 남습니다 — 이 감사의 과제 설명에 있던 "`e2e.yml` push main"은 더 이상
맞지 않습니다.

> **2026-10-08: 이제 어느 이벤트에서도 그 두 항목을 저장하지 않습니다.**
> `e2e.yml`은 최상위 `cache-mode: read`를 선언하고 Next·Playwright 단계가
> `actions/cache/restore@`뿐이므로, `pull_request`도 `main`에서 돌린
> `workflow_dispatch`도 save에 도달하지 못합니다(7장 P1a). 위 문단의 "PR scope에만
> 쓴다"·"`workflow_dispatch`가 `main` scope에 쓴다"는 2026-10-03의 기록입니다.

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
| `secret-history-scan.yml` | `setup-node` 자체가 없습니다 — job의 step은 `actions/checkout`과 `gitleaks/gitleaks-action` 둘뿐입니다. `push: main` + `schedule`인데도 캐시 표면이 0입니다. |
| `back-merge-main-to-develop.yml` | `push: main`. `setup-node` :281에 `cache:` 입력이 없습니다. `back-merge` job(`GH_AUTOMATION_PAT` :110, :119)은 `setup-node`조차 없습니다. |
| `deployed-commit-drift.yml` | `schedule`. `setup-node` :110에 `cache:` 없음. :114-116 주석이 `npm ci`를 **일부러** 하지 않는다고 적습니다. |
| `engineering-agent-image.yml` | `push: main` + `packages: write`. :4 주석이 "no repository secret, no cache"를 명시하고 :46-48이 `docker build --pull --no-cache`입니다. |
| `codeql.yml` | `push: main` + `schedule` + `security-events: write`. `setup-node`가 없습니다(`actions/setup-node`를 이름 대며 그 생략을 설명하는 주석이 있습니다). CodeQL action 자신의 bundle 캐시는 GitHub가 관리하며 이 감사 범위 밖입니다. |
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

같은 감사의 :348은 **관측**을 적었습니다 — "Playwright 캐시는 **매번 primary
key 적중** (키가 lockfile 해시만 포함 → lockfile이 안 바뀌면 항상 warm)". 이것은
규칙이 아니라 그 기간의 측정입니다. 실제 수명 상한은 1장의 조건 — 삭제·미사용
퇴출·cache version 변경 — 이고, lockfile이 그대로인 동안 적중이 이어졌다는
사실은 **그 항목이 길게 산다**는 것까지만 말합니다.

**Rust `target` 과 `~/.cargo`.** `orchestrator-rust.yml`의 step
`Restore the downloaded crates`가 담던 것은 `~/.cargo/registry`, `~/.cargo/git`,
`target`, `vendor/amux/target` 넷이었고, `push: main`과 `push: develop` 양쪽에서
썼습니다. restore-keys가 없는 것(그 step은 `key:` 하나만 갖습니다)은 올바른
선택이지만, `target/` 안의 build script 바이너리에는 검증이 없었습니다.

> **2026-10-08: 이 단락의 세 가지가 모두 달라졌습니다.** 그 step은 이제
> `~/.cargo/registry`와 `~/.cargo/git` **둘만** 담고 `target`·`vendor/amux/target`은
> 들어 있지 않습니다. `actions/cache/restore@`이고 workflow가 `cache-mode: read`
> 이므로 **어느 push에서도 쓰지 않습니다.** 키는
> `OS-rust-v2-cargo-home-${{ hashFiles('Cargo.lock', 'vendor/amux/Cargo.lock') }}`
> 이고 `restore-keys`는 여전히 없습니다. 위 문단은 2026-10-03의 기록입니다.

### 3.2 키 공유 — 한 exact 항목을 6개 job이, 그리고 그 둘이 서로의 fallback

> **2026-10-08 갱신 — 이 절이 서술하는 지형은 더 이상 트리의 상태가 아닙니다.**
> 이 절은 2026-10-03의 트리를 적었고 기록으로 남깁니다. 그 뒤 `pr-fast-gate`만
> 갖고 있던 `v2-<namespace>-` 구획이 **캐시를 쓰는 모든 workflow로** 확장됐고,
> 그래서 아래 사실 A와 사실 B가 전제한 **공유 항목이 존재하지 않습니다.**
>
> 2026-10-08에 `.github/workflows/*.yml`의 `key`·`restore-keys`를 전수 수집한
> 결과입니다(`${{ runner.os }}`를 `OS`, lockfile 해시를 `LOCK`으로 줄여 적습니다).
>
> | workflow | playwright primary key | `.next/cache` restore-keys가 멈추는 곳 |
> |---|---|---|
> | `admin-console-e2e` | `OS-playwright-v2-admin-e2e-LOCK-chromium` | `OS-next-v2-admin-e2e-LOCK-` |
> | `daily-security-audit` | `OS-playwright-v2-daily-LOCK-chromium-webkit` | `OS-next-v2-daily-LOCK-` |
> | `e2e` | `OS-playwright-v2-main-LOCK-chromium` | `OS-next-v2-main-LOCK-` |
> | `nightly-visual-regression` | `OS-playwright-v2-visual-LOCK-chromium` | `OS-next-v2-visual-LOCK-` |
> | `pr-fast-gate` | `OS-playwright-v2-pr-LOCK-chromium` | `OS-next-v2-pr-LOCK-` |
> | `review-parity-shadow` | `OS-playwright-v2-parity-LOCK-chromium` | `OS-next-v2-parity-LOCK-` |
>
> 표가 덮는 것은 `.next/cache`와 `~/.cache/ms-playwright` 두 종류입니다. 세
> 번째 캐시는 `orchestrator-rust.yml`의
> `OS-rust-v2-cargo-home-${{ hashFiles('Cargo.lock', 'vendor/amux/Cargo.lock') }}`
> 하나이고 `restore-keys`가 없습니다(3.1).
>
> 읽는 법은 셋입니다. **workflow 사이의 exact 공유가 없습니다** — 여섯 개의
> primary key가 모두 다른 문자열이므로 한 항목을 두 workflow가 집어 쓸 수
> 없습니다. 단 **같은 workflow 안에서 같은 키를 선언하는 쌍은 남아 있습니다**:
> `pr-fast-gate`의 `build-and-e2e`와 `ui-risk`, 그리고 `daily-security-audit`의
> `audit`과 `e2e`입니다. **그 둘은 성질이 다릅니다** — 키를 선언하는 것과 저장된
> 항목을 주고받는 것은 다르기 때문입니다. `pr-fast-gate`는 `actions/cache@`를
> 쓰고 `cache-mode` 선언이 없어 **쓸 수 있으므로** 두 job이 실제로 한 항목을
> 주고받습니다. `daily-security-audit`은 최상위 `cache-mode: read`에
> `actions/cache/restore@`뿐이라 **쓸 수 없고**, 이 저장소의 어느 workflow도
> `-v2-daily-` 키를 쓰지 않으므로 그 쌍은 아무것도 담기지 않는 키를 함께
> 선언하는 것입니다(P1a가 적은 영구 miss). **교차 fallback은
> 없습니다** — 모든 `restore-keys`가 자기 namespace 안에서 멈추므로
> `-chromium`과 `-chromium-webkit`이 서로의 후보가 되지 않습니다. 그리고
> **broad `OS-next-` fallback은 한 곳도 남지 않았습니다**(이 절이 아래에서 다섯
> 곳을 셌던 그 항목입니다).
>
> 이 갱신은 범위를 줄이지 않습니다. 1장의 신뢰 경계(항목에 서명도 해시 핀도 없고
> 내용을 대조할 기대값도 없다)와 `~/.cache/ms-playwright`가 실행 가능한 바이너리를
> 담는다는 사실은 그대로이며, 구획은 **누가 누구의 항목에 닿는가**만 좁힙니다.
> 쓰기 권한 자체는 `cache-mode`가 정합니다(7장의 P1a).

여기에는 서로 다른 두 사실이 있고, 섞으면 틀립니다.

- **사실 A (exact 공유).** `Linux-playwright-<lock>-chromium`이라는 **하나의
  항목**을 아래 여섯 job이 primary key로 씁니다. exact 적중이면 여섯 job이
  같은 바이트를 받습니다.
- **사실 B (교차 fallback).** `-chromium`과 `-chromium-webkit`은 **별개의 두
  항목**입니다. 공통 restore-key prefix 때문에 둘은 서로의 **fallback 후보**가
  되지만, 그 채널은 **exact key가 miss일 때만** 열립니다. 정상적인 exact 적중
  상태에서 두 항목이 하나로 합쳐지는 것이 아닙니다.

`Linux-playwright-<lock>-chromium`을 primary key로 쓰는 여섯 job:

여섯 곳 모두 step `Restore Playwright Chromium cache`이고, `pr-fast-gate.yml`은
job `build-and-e2e`와 `ui-risk`가 각각 하나씩 갖습니다. 줄 번호를 적지 않는 것은
이 감사 이후 여섯 파일 전부가 움직여 그 숫자가 빈 줄과 주석을 가리키게 됐기
때문이고(2026-10-08 확인), step 이름은 그 사이 바뀌지 않았습니다.

```
admin-console-e2e.yml   pr-fast-gate.yml (build-and-e2e)
e2e.yml                 pr-fast-gate.yml (ui-risk)
nightly-visual-regression.yml   review-parity-shadow.yml
```

그리고 **모두** restore-keys `${{ runner.os }}-playwright-${{ hashFiles('package-lock.json') }}-`
를 갖고 **있었습니다**(같은 step의 `restore-keys` 블록). 그 prefix는
`daily-security-audit.yml`의 `-chromium-webkit`로 끝나는 키 두 개에도 맞으므로
사실 B가 성립했습니다. **2026-10-08 현재는 성립하지 않습니다** — 여섯 곳의
`restore-keys`가 모두 자기 `-playwright-v2-<namespace>-<lock>-`에서 멈추므로
`-chromium`과 `-chromium-webkit`이 서로의 후보가 되지 않습니다(이 절 앞의 갱신
주석).

`main` scope writer는 이렇게 갈립니다.

- `-chromium` 항목: `nightly-visual-regression`(schedule),
  `admin-console-e2e`(push main). **여섯 job이 공유하는 바로 그 항목**입니다.
- `-chromium-webkit` 항목: `daily-security-audit`(schedule). 여섯 job에는
  exact miss일 때만 닿습니다.

즉 `admin-console-e2e`와 `nightly-visual-regression`은 PR Fast Gate가 exact로
집어 쓰는 항목을 직접 씁니다. `daily-security-audit`의 항목은 한 단계 더 멀어,
lockfile이 바뀌어 `-chromium` 항목이 아직 없는 창에서만 닿습니다.

> **2026-10-08: 이 세 workflow는 더 이상 writer가 아닙니다.** 셋 다 최상위
> `cache-mode: read`를 선언하고 캐시 단계가 전부 `actions/cache/restore@`이므로
> **쓸 수 없습니다**(P1a의 측정). 키까지 `-v2-visual-`·`-v2-admin-e2e-`로 갈라져
> PR Fast Gate의 `-v2-pr-`과 맞지도 않습니다. 남은 writer는 `pr-fast-gate`와
> `review-parity-shadow` 둘뿐이고(`cache-mode` 선언 없음, `actions/cache@`),
> 각자 자기 namespace에만 씁니다. 위 세 항목은 2026-10-03의 기록입니다.

`.next/cache` 쪽은 workflow마다 namespace가 다릅니다(`-daily-`, `-visual-`,
`-admin-e2e-`, `-main-`, `-parity-`, `-pr-`). 그런데 다섯 곳이 그 경계를 지우는
broad fallback을 갖습니다.

broad fallback이 **있던** 다섯 곳이며, 전부 step `Restore Next.js build cache`
입니다(`daily-security-audit.yml`은 두 job이 각각 하나씩 갖습니다). 줄 번호는 위와
같은 이유로 적지 않고, 2026-10-08 현재 이 다섯 곳의 `restore-keys`는 모두 자기
namespace에서 멈추므로 **아래 목록은 당시의 기록입니다**(3.2의 갱신 주석).

```
admin-console-e2e.yml   daily-security-audit.yml (두 job)
e2e.yml                 nightly-visual-regression.yml
review-parity-shadow.yml
```

`${{ runner.os }}-next-` 는 다른 모든 `Linux-next-*` 항목에 맞습니다.
`pr-fast-gate.yml`은 이 fallback을 이미 **뺐습니다** — 네 `restore-keys` 블록이
모두 `${{ runner.os }}-next-v2-pr-` 또는 `-playwright-v2-pr-`에서 멈추고, 16.3.4
캐시가 16.3.5 Turbopack font 빌드를 깨뜨린 기록은
`admin-console-e2e.yml`·`daily-security-audit.yml`의 restore-key 주석에 있습니다.

> Stop at next-pr-&lt;lockfile&gt;. A bare Linux-next- prefix also matches
> Linux-next-admin-e2e- from another workflow. That cache was built
> with Next 16.3.4 and breaks a 16.3.5 Turbopack font build.

**이 채널이 실제로 작동한다는 것은 이미 관측됐습니다.** 당시 판정은 정합성
문제였고 보안 경계로 다루지 않았으므로, 같은 수정이 다른 다섯 곳에는 적용되지
않았습니다.

> **2026-10-08: 그 뒤 다섯 곳에도 적용됐습니다.** 어느 `restore-keys`에도 bare
> `${{ runner.os }}-next-`가 남아 있지 않고, 전부 자기
> `-next-v2-<namespace>-<lock>-`에서 멈춥니다(3.2 앞의 갱신 주석). 위 문단은
> 2026-10-03의 기록입니다.

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
| `e2e` # `playwright` (5 shard) | :193 | :212 | — | :189 | `npm run build` :208 → :220 → :223 |
| `nightly-visual-regression` # `visual-regression` | :69 | :85 | — | :65 | `npm run build` :81 → :93 |
| `orchestrator-rust` # `workspace` | — | — | :47 | — | `cargo build` :60- |
| `credit-finance-db-integration` # `credit-finance-db` | — | — | — | :176 | `npm ci` :179 + DB 시나리오 |
| 자격증명을 가진 job **11건** | — | — | — | 각자 `cache: npm` | `npm ci` 및 그 job의 일 |

마지막 행은 §16에 따라 이름을 적지 않습니다(4.1·4.3). 중요한 것은 그 11건의
`.next/cache`·ms-playwright·rust 칸이 **전부 비어 있다**는 것입니다.

**자격증명·쓰기 권한을 가진 job 둘은 `install-playwright.sh`를 캐시 복원 없이
호출합니다** — 매 run CDN에서 새로 내려받습니다. 그래서 그 모양이 맞고, 6장에
유지 항목으로 적습니다(해소된 상태이므로 6장은 이름을 적습니다).

### 3.4 Next·Playwright 복원 단계는 `continue-on-error: true`, Rust는 아닙니다

`actions/cache*` 단계 **17개 중 16개**가 그렇습니다 —
`admin-console-e2e`·`e2e`·`nightly-visual-regression`·`review-parity-shadow`가
각 2개, `daily-security-audit`·`pr-fast-gate`가 각 4개입니다. 세는 명령은
`npm run -s check:ci-cache-keys`가 읽는 것과 같은 트리이고, 손으로 다시 셀 때는
`grep -c 'continue-on-error: true'`가 아니라 `actions/cache*` 단계만 보아야
합니다(그 문자열은 캐시와 무관한 단계에도 쓰입니다).

**`orchestrator-rust.yml`의 step `Restore the downloaded crates`에는 없습니다** — 그 단계는 실패하면 job을
실패시킵니다. 그래서 "복원 단계가 모두 조용하다"는 틀리고, 범위는 위
Next·Playwright 열여섯 곳입니다.

그 열여섯 곳에서 복원 실패가 조용하다는 것은 성능상 의도된 선택입니다. 완화책
설계에 주는 제약은 하나입니다 — **오염 항목을 거부하는 검사를 그 단계 안에
넣으면 조용히 통과합니다.** 검사는 `continue-on-error`가 없는 별도 단계여야
하며, Rust 단계에는 이 제약이 없습니다.

## 4. 축 3 — consumer job의 secret·권한

### 4.1 저장소 자신의 분석기가 이미 이 규칙을 갖고 있습니다

`lib/agentCredentialReachability.ts`는 `credential_job_restores_cache`라는
판정을 갖습니다(`reason: "credential_job_restores_cache"`). 계약은 `docs/policy/engineering-agent.md` §5의 캐시 경로 항목입니다.

> **cache 경로**: 자격증명을 가진 job이 Actions cache를 복원하면, 그 job은
> trigger·path filter와 무관하게 도달한 것으로 보고 **모든 변경이 push
> 금지**다. 이 가정을 푸는 방법은 job별 제외가 아니라, cache의 ref 간 공유
> 범위에 대한 날짜 있는 확인 기록 하나를 분석기 설정에 고정하는 것뿐이다.

이 감사는 그 분석기를 기준 commit의 실제 workflow에 대해 실행했습니다. 결과:
`forbidsAll: true`, 자격증명 보유 job 22건, 이유 17건, 그중
`credential_job_restores_cache` **14건**.

> **대상 목록은 여기에 싣지 않습니다**(`docs/policy/engineering-agent.md` §16).
> 이 저장소는 공개이므로 "고쳐지지 않은 경로를 이름과 줄 번호로 적는 것은 그
> 자체가 공개"이고, 해소된 것만 저장소 기록에 남습니다. 남기는 것은 판정
> 규칙과 수치이며, §16이 "규칙은 공개해도 안전하다"고 적은 그 구분입니다.
> `tests/agentCredentialReachability.test.mjs`가 같은 이유로 posture를 12자
> digest(`POSTURE_DIGEST`)로만 고정합니다.
>
> **이 문서의 rev 1~rev 2는 그 목록을 실었고 공개 저장소에 push됐습니다.**
> 경위와 조치는 10장에 적습니다.

재현(이 저장소 clone 안, Node 22와 `npm ci`가 끝나 있어야 하고 자격증명은
필요하지 않습니다 — 읽기 전용입니다). 출력은 대상 이름을 담으므로 **공개
문서에 붙이지 않습니다**:

```bash
npm run report:engineering-agent-tiers
```

### 4.2 분석기의 "restores" 3건은 보수적 과대추정입니다

`restoresCache`는 `actions/setup-*`를 "`cache`가 명시적으로 꺼져 있지 않으면
복원한다"로 봤습니다. **그 뒤 그 판정이 세분화됐습니다** — 지금은
`VERIFIED_SETUP_CACHES`가 어느 action의 어느 캐시를 검증된 것으로 볼지 정하고,
`AUTOMATIC_PACKAGE_MANAGER_CACHE`가 `cache:` 입력 없이도 복원하는 것은
`actions/setup-node` v6뿐임을 적습니다. 아래 셈은 그 세분화 이전의 것이고, 열 개
job에서 선언을 뺀 뒤의 측정은 4.3의 0건입니다. 14건 중 **3건**은 `setup-node`에
`cache:` 입력이 없어 **현재 트리에서는** 실제 복원자가 아닙니다 — fail-closed
설계의 의도된 과대추정입니다. 어느 셋인지는 §16에 따라 적지 않습니다(4.1).

> **조치 완료.** 이 잠복 경로는 닫혔습니다. 그 세 단계에
> `package-manager-cache: false`를 명시했고, 분석기는 이제 그것만을 off
> 스위치로 인정합니다(`cache: false`는 아닙니다 — v6에서 그것은 자동 캐싱을
> 끄지 않습니다). 결과로 자격증명 cache 복원 job이 **14건에서 11건으로**
> 줄었고, 4.3이 손으로 읽은 수치와 분석기의 보수적 과대추정이 일치했습니다 —
> 워크플로가 이제 자기가 무엇을 하는지 말하기 때문입니다.

**"`cache:`가 없으면 캐시가 없다"로 일반화하면 틀립니다.** `actions/setup-node`
v6는 `package-manager-cache` 입력의 기본값이 `true`이고, 그 설명은 이렇습니다.

> Set to false to disable automatic caching. By default, caching is enabled when
> either `devEngines.packageManager` or the top-level `packageManager` field in
> package.json specifies npm as the package manager.

현재 `package.json`에는 `packageManager`도 `devEngines`도 **없습니다**(확인함).
그래서 위 셋은 지금 캐시하지 않습니다. 그러나 `packageManager: "npm@..."`를
추가하는 평범한 변경 하나로 **`cache:` 줄을 건드리지 않고도** 그 셋이 npm
캐시를 복원하게 됩니다. 그 셋은 전부 자격증명을 가진 job이므로, 그 변경은 4.3의
분리를 조용히 넓힙니다. 분석기의 과대추정은 **이 경우에 대해서는 과대가
아닙니다** — 7장 P3의 검사는 `cache:` 문자열이 아니라 이 기본값을 반영해야
합니다.

### 4.3 실제로 자격증명을 들고 캐시를 복원하는 11건 — 전부 `npm` cacache 하나뿐

> **지금은 0건입니다**(2026-10-04). 아래 11건은 **감사 시점의 관측**이고, 10장의
> 소유자 결정에 따라 그 job들이 선언하던 npm 캐시를 거뒀습니다(P7이 먼저 1건,
> 이 변경이 나머지 10건). `npm run check:credential-cache-separation`이 0건을,
> `npm run check:agent-pr-cache-isolation`이 에이전트 이벤트가 닿는 8개 workflow의
> 자격증명 job 5건 중 0건을 보고합니다. 비용은 0으로 측정됐습니다 — 그 scope에는
> 아무도 쓸 수 없어 복원이 이미 확정적 miss였습니다(run `37162314395`).

§16에 따라 **job 이름과 secret 매핑은 싣지 않습니다**(4.1). 남기는 것은 분리의
모양과 수치입니다.

- 4.1의 14건에서 4.2의 3건(실제 복원자 아님)을 빼면 **11건**이 남습니다.
- 그 **11건이 복원하는 캐시는 `npm` cacache 하나뿐입니다.** `.next/cache`나
  `~/.cache/ms-playwright`를 복원하는 것은 **하나도 없습니다.**
- 들고 있는 것의 종류: repository write 토큰, LLM provider key 셋, 이미지·음성
  provider key, 이메일 발송 key, Slack webhook, `issues: write`,
  `contents: write`. 어느 job이 무엇을 드는지는 적지 않습니다.
- 반대로 3.3에서 무검증 캐시를 복원하는 **job 정의 아홉**은 전부
  `contents: read`이고 **장기 외부 secret도 repository write 자격증명도 들지
  않습니다**(matrix 전개가 아니라 정의 수입니다 — 그 중 둘은 6 shard와 5
  shard로 돕니다).

"자격증명이 없다"고 쓰면 틀립니다. 그 아홉에도 두 가지는 있습니다.

- **읽기 전용 `GITHUB_TOKEN`.** `actions/checkout`이 Git 인증으로 남겨 두며,
  권한은 그 workflow가 선언한 read scope뿐입니다.
- **단기 Actions runtime token.** 모든 job에 있고, **자기 run의 ref scope**
  캐시를 쓸 수 있습니다. PR job의 것은 그 PR의 merge-ref scope에만 쓰므로
  `main` scope를 다시 오염시키지 못합니다(1장). `main` scope를 다시 쓸 수 있는
  것은 애초에 `main`에서 도는 writer뿐이고, 그것은 2.1이 이미 적습니다 — 그
  셋은 자격증명 job이 아니므로 §16의 목록이 아닙니다.

그 분리가 지금의 안전을 만들고 있습니다. 그리고 그것을 유지하는 장치는
없습니다 — 위 열한 job 중 하나에 `actions/cache`로 `.next/cache`를 더하는 한
줄이면, 검증되지 않은 캐시와 repository write 토큰·LLM key가 같은 job에
들어옵니다. `credential_job_restores_cache` 판정은 **에이전트의 쓰기를 막는
게이트**이고, workflow 변경 자체를 막는 검사가 아닙니다.

### 4.4 `npm` cacache의 실제 영향 범위

`npm ci`는 `package-lock.json`의 integrity와 대조하므로 lockfile이 고정한
것과 **다른 코드가 설치되는 일은 일어나지 않습니다.** 결과는 코드 실행이 아니라
**가용성 영향 또는 자동 복구**입니다 — 손상이 항상 `EINTEGRITY`로 끝나는 것은
아니고, pacote가 손상을 발견하면 registry에서 다시 내려받아 복구하는 경로도
있습니다. 어느 쪽이든 공격자가 고른 코드가 실행되지는 않습니다.

lockfile 밖의 설치만이 치환 위험이고, 저장소에 둘 있습니다 — 그리고 둘 다
이미 명시적 sha512 핀을 갖고 있습니다.

- `cron-auto-fix.yml:235-247`(step `Install Claude Code CLI`) — `CLAUDE_CODE_INTEGRITY`
  대조 후 `npm install -g`
- `feedback-autofix.yml:160-172`(step `Install Claude Code CLI (pinned)`) — 같은 패턴

`package.json`의 `postinstall`은 `prisma generate` 하나입니다.

## 5. 발견과 되돌릴 수 있음/없음 분류

분류 기준은 AGENTS.md "검증 범위는 되돌릴 수 없는 것에 비례합니다"입니다 —
**무엇이 복구 불가인지 한 줄로 적을 수 없으면 차단이 아닙니다.**

### F1 — `main` scope에서 쓰인 Playwright 항목 하나를 6개 job이 exact key로 공유합니다

> **2026-10-08: 이 발견의 전제가 더 이상 성립하지 않습니다.** 여섯 job의
> primary key가 workflow마다 자기 `v2-<namespace>-`를 갖게 되어 **여섯이 한
> 항목을 공유하지 않습니다**(3.2 앞의 갱신 주석에 전수 표). 남은 공유는 같은
> workflow 안에서 같은 키를 선언하는 쌍입니다 — `pr-fast-gate`의 두 job과
> `daily-security-audit`의 두 job. 어느 쪽도 이 발견이 말한 **교차 경로가
> 아닙니다**: 앞은 그 workflow 자신이 쓴 항목을 그 workflow가 읽는 것이고
> (`pr-fast-gate`는 `actions/cache@`로 쓸 수 있습니다), 뒤는 **아무것도 담기지
> 않는 키**입니다 — `daily-security-audit`은 `cache-mode: read`에
> `actions/cache/restore@`뿐이고 그 `-v2-daily-` 키를 쓰는 workflow가 없습니다. 아래 분석은 2026-10-03의 트리에 대한
> 기록이며, **권고 1순위라는 표시는 그 시점의 것입니다.** 캐시 항목 자체에 여전히
> 서명도 해시 핀도 없다는 1장의 사실은 바뀌지 않았습니다.

근거: 3.2의 사실 A·B, `scripts/ci/install-playwright.sh`(캐시 적중 시 무검증
no-op), `.github/audits/pr-fast-gate-performance-audit.md:348`·`:355`.

결과: CI 안의 임의 바이너리 실행, 그리고 필수 check(`pr-fast-gate # fast-gate`)의
판정. 오염이 **스스로 유지되는 것은 `main`에서 도는 writer 쪽에서만**입니다 —
그 job의 runtime token은 `main` scope를 다시 쓸 수 있습니다. PR job에서는
그렇지 않습니다: 그 token은 자기 merge-ref scope에만 쓰므로, 오염된 바이너리를
실행해도 `main` 항목을 다시 쓰지는 못합니다(4.3).

**되돌릴 수 있음.** 캐시 항목은 삭제할 수 있고 빌드는 다시 돌릴 수 있습니다.
복구 불가인 것을 한 줄로 적을 수 없습니다 — 그 job들에 장기 외부 secret도
repository write 자격증명도 없기 때문입니다(4.3). 차단 사유가 아니며,
**권고 1순위**입니다.

단 분명히 해 둘 것: gate가 잘못 green이 되어 병합·배포된 변경의 가역성은 그
변경 자신의 것이고 이 항목의 것이 아닙니다. 마이그레이션이나 가격 변경이 그
경로로 통과하면 그쪽 기준으로 복구 불가일 수 있습니다.

### F2 — `.next/cache`의 broad restore-key가 workflow 경계를 지웁니다

> **2026-10-08: 이 발견이 이름 댄 broad restore-key는 한 곳도 남지 않았습니다.**
> 다섯 곳 모두 `restore-keys`가 자기 `OS-next-v2-<namespace>-LOCK-`에서 멈춥니다
> (3.2 앞의 갱신 주석). 아래는 2026-10-03의 기록입니다.

근거: 3.4의 열여섯 단계가 `continue-on-error: true`이므로 복원 실패가 job을
멈추지 않습니다. 반례이자 증거: `pr-fast-gate.yml`의 두 `restore-keys` — 그
주석이 16.3.4 캐시가 16.3.5 Turbopack font 빌드를 깨뜨린 기록을 담고 있고,
같은 기록이 `admin-console-e2e.yml`·`daily-security-audit.yml`의 restore-key
주석에도 있습니다.

결과: PR workflow(`review-parity-shadow`)가 `main` scope의 schedule job이 쓴
`.next/cache`를 복원해 빌드하고 실행합니다. **F1과 달리 이 채널이 실제로
작동한 기록이 저장소에 있습니다**(16.3.4 캐시가 16.3.5 빌드를 깨뜨린 사건).

**되돌릴 수 있음.** F1과 같은 이유입니다. **권고 1순위**.

### F3 — `main`·`develop` scope writer가 제3자 install script를 실행합니다

근거: 2장의 모든 `npm ci`, `--ignore-scripts`는 `pr-fast-gate.yml`의 `npm ci --prefix vendor/amux --ignore-scripts` 한 곳뿐.

이것은 발견이라기보다 **F1·F2의 전제**입니다 — 침해된 의존성 하나가 `main`
scope 캐시 쓰기를 얻는 경로. 따로 분류하지 않고 7장 P6의 조사 항목으로
넘깁니다.

> **2026-10-08: 그 전제의 뒷부분이 사라졌습니다.** `npm ci`가 install script를
> 실행한다는 것과 그 패키지가 10개라는 것은 그대로지만, **그 코드가 쥔 토큰이
> `main`·`develop` scope 캐시에 쓸 수 있는 경로가 없습니다** — 2장 앞의 갱신
> 주석대로 그 scope의 writer는 0입니다. 남는 것은 그 토큰이 할 수 있는 다른
> 일들이고, 이 발견이 말한 캐시 쓰기는 아닙니다.

### F4 — 자격증명과 무검증 캐시의 분리를 유지하는 검사가 없습니다

근거: 4.3의 열한 건과 3.3의 아홉 건이 교집합 없음. 그 사실을 고정하는
테스트·검사 없음. `credential_job_restores_cache`(`lib/agentCredentialReachability.ts`의
`reason` 값)는 에이전트의 push를 막을 뿐 workflow 변경을 막지 않습니다.

> **2026-10-08: 이 발견은 해소됐습니다.** 그 분리를 고정하는 검사가 생겼고 PR Fast
> Gate에서 돕니다 — `npm run check:credential-cache-separation`,
> `npm run check:agent-pr-cache-isolation`, `npm run check:ci-cache-keys`
> (4.3이 앞의 둘의 보고 수치를 적습니다). 아래 결과·분류는 2026-10-03의
> 기록입니다.

결과: 열한 job 중 하나에 무검증 캐시가 더해지면, 4.3이 종류로 적은 것 —
공개 저장소에 `contents: write`인 자동화 토큰, LLM provider key 셋, 이미지·음성
provider key, 이메일 발송 key — 이 오염된 코드와 같은 job에 놓입니다.

**지금은 되돌릴 수 있음**(가용성). 그 한 줄이 들어오면 **되돌릴 수 없는 결과로
가는 노출 경로가 생깁니다** — 노출 자체가 복구 불가는 아니고, 실제 유출이
일어났을 때 복구 불가가 됩니다. AGENTS.md가 "유출처럼 회수가 성립하지 않는"
것을 복구 불가로 명시하고, 키 회전은 미래 사용만 제한하며 유출 자체를 되돌리지
못합니다. 현재 상태가 깨져 있지 않으므로 **차단 사유는 아니고**, 가장 오래 가는
조치이므로 **권고 2순위**입니다.

4.2가 이 항목을 넓힙니다: `cache:` 줄을 더하는 것만이 경로가 아니고,
`package.json`에 `packageManager`를 추가하는 변경도 같은 일을 합니다.

### F5 — `cacheIsolationRecorded` 기록은 쓸 수 있고, 문구만 한정하면 됩니다 (초안 판정 철회)

근거: `lib/agentCredentialReachability.ts`의 `cacheIsolationRecorded` 주석이 그 설정을 "a dated record
that **pull_request-run caches never reach other refs' runs**"로 정의합니다.
`docs/policy/engineering-agent.md` §5의 캐시 경로 항목이 계약입니다.

> **이 문단은 조사 시점(2026-10-03)에 "호출자는 둘이고 둘 다 `false`로 고정돼
> 있다 — 즉 기록은 아직 존재하지 않는다"고 적었고, 그것은 더 이상 사실이
> 아닙니다**(독립 검토가 지적, 2026-10-07). 기록은 2026-10-04에 소유자가
> 서명했고(P7의 장치, #2052), `scripts/report-engineering-agent-tiers.mjs`는
> 이제 **조건부로** 적용합니다 — `cacheIsolationRecordSignature().signed`와
> `judgeAgentPrCacheIsolation()`의 `held`가 둘 다 참일 때만
> `cacheIsolationRecorded: true`로 다시 분석하고, 그 둘은 먼저 기록을 무시한
> 분석(`blind`)으로 판정합니다 — 기록을 적용한 분석은 캐시 이유를 하나도
> 보고하지 않으므로, 그것으로 조건을 판정하면 증거를 가린 채 충족된 것처럼
> 보이게 됩니다. `npm run check:credential-cache-separation`과
> `tests/agentCredentialReachability.test.mjs`의 posture digest는 계속 기록을
> 무시한 채 판정합니다.

1장의 공식 규칙은 **그 방향이 이미 닫혀 있음을 확인합니다** — PR 캐시는
`refs/pull/.../merge` scope이고 그 PR의 re-run만 복원합니다. 그러므로 그 기록은
사실에 부합하게 쓸 수 있습니다.

**이 항목의 초안은 여기서 틀렸고, 독립 검토(9장)가 그것을 잡았습니다.** 초안은
"열려 있는 방향은 반대쪽이므로 그 기록은 맞는 사실로 틀린 결론을 세운다"고
적었습니다. 그 추론이 틀린 이유는 이렇습니다.

분석기의 cache 규칙이 막는 것은 **에이전트 자신이 심은 캐시가 자격증명 job에
도달하는 것**입니다. 에이전트가 일으키는 이벤트는 PR이고, PR run이 쓴 캐시는
다른 ref의 run에 도달하지 않습니다. 그러므로 그 기록은 **자기가 대답해야 할
질문에 정확히 대답**하며, 그 근거로 cache 규칙을 푸는 것은 타당합니다.

반대 방향(기본·base → PR)이 열려 있는 것은 **다른 위협**입니다 — 주체가
에이전트가 아니라 침해된 의존성이고, 에이전트의 push 권한과 무관합니다. 그 쪽은
cache 규칙이 아니라 F4·P3이 다룹니다. 그리고 PR에서 실제로 도는 자격증명 job은
분석기의 trigger·path 도달 판정이 계속 따로 다룹니다.

**세 번째 방향이 있습니다. 다만 rev 2가 든 사례는 틀렸고, round 2가 그것을
잡았습니다.**

구조는 이렇습니다. 공식 규칙의 그 문장을 끝까지 읽으면 PR 캐시는 "can only be
restored by **re-runs of the pull request**"입니다. 즉 닫힌 것은 **다른 ref**
이고, **같은 PR의 이후 run에는 열려 있습니다.** 에이전트가 캐시를 심을 수 있는
곳이 거기입니다: 자기 PR.

그러므로 물어야 할 것은 "에이전트의 PR에서 **실제로 도는** 자격증명 캐시 복원
job이 있는가"입니다.

**rev 2는 하나 있다고 적었고, 그것이 틀렸습니다.** 지목한 job은 `pull_request:
types:[closed], branches:[develop]`로 돌지만, 그 job의 `if:`가 head ref가
`feedback-autofix/`로 시작할 것을 요구합니다
(`feedback-autofix-promotion-pr.yml`의 job 조건 `startsWith(github.event.pull_request.head.ref, 'feedback-autofix/')`). 에이전트 브랜치는
`agent/engineering/` namespace이므로(`lib/agentCredentialReachability.ts`의 `AGENT_BRANCH_PREFIX`)
**절대 걸리지 않습니다.** rev 2는 workflow의 trigger만 보고 job의 조건을 읽지
않았습니다.

나머지 `pull_request` workflow도 둘 중 하나입니다 — 자격증명이 없거나,
자격증명 job이 캐시를 복원하지 않습니다. **그래서 오늘 이 방향의 사례는
없습니다.**

남는 것은 **감시 항목**입니다. 사례가 생기는 조건은 둘 — 자격증명 job의
`if:`가 넓어지거나, 에이전트 PR에서 도는 자격증명 job에 캐시가 더해지는 것.
둘 다 P3의 검사가 보는 변경이므로, P4의 기록은 같은 PR 방향에 대해 "오늘 사례가
없다"를 근거로 쓰고 P3이 그것을 유지합니다.

**이 항목에서 제 판정은 두 번 틀렸습니다** — rev 1은 방향을 잘못 짚었고, rev 2는
방향은 맞았지만 사례를 잘못 짚었습니다. 두 번 다 독립 검토가 잡았습니다.

**되돌릴 수 있음** — 정책 문구 명확화 항목입니다. 그 기록을 쓰는 PR은
`docs/policy/engineering-agent.md` 변경이므로 여전히 contract 역할과 소유자
승인이 필요합니다.

### F6 — Next·Playwright 복원 단계 열여섯 곳이 `continue-on-error: true`입니다

근거: 3.4. Rust 단계는 해당하지 않습니다. **되돌릴 수 있음.** 발견이 아니라
완화책 설계 제약으로 기록하며, 제약이 걸리는 범위는 그 열여섯 곳입니다.

### 인접 경로 (세 축 밖, 참고)

`main` scope job의 action이 태그로 고정돼 있습니다 — `actions/cache@v5`,
`actions/setup-node@v6`, `actions/checkout@v6`, `gitleaks/gitleaks-action@v3`.
태그는 움직일 수 있으므로 "제3자 코드가 `main` scope job에서 실행된다"는 F3의
전제를 캐시 없이도 성립시킵니다. 가장 위험한 두 job은 **이미 SHA로 핀했습니다**
(`cron-auto-fix.yml:189`·`:217`, `feedback-autofix.yml:115`·`:123` — 각 파일의
`actions/checkout`·`actions/setup-node`). 이 감사의
세 축이 아니므로 권고하지 않고, 별도 판단 대상으로만 적습니다.

## 6. 이미 맞게 되어 있는 것 — 완화 PR이 되돌리면 안 되는 결정

| 결정 | 위치 |
|---|---|
| 자격증명 job이 Playwright 캐시를 복원하지 않고 매번 새로 내려받음 | `cron-auto-fix.yml`·`visual-baseline-record.yml`의 `scripts/ci/install-playwright.sh chromium`(캐시 단계가 없습니다) |
| lockfile 밖 설치에 명시적 sha512 핀 | `cron-auto-fix.yml:235-247`, `feedback-autofix.yml:160-172` (step `Install Claude Code CLI`) |
| 가장 위험한 두 job의 action SHA 핀 | `cron-auto-fix.yml:189`·`:217`, `feedback-autofix.yml:115`·`:123` (`checkout`·`setup-node`) |
| `--ignore-scripts` | `pr-fast-gate.yml`의 `npm ci --prefix vendor/amux --ignore-scripts` |
| `Linux-next-` fallback 제거 | `pr-fast-gate.yml`의 두 `restore-keys` — 이제 그 접두사를 담지 않고, 주석만 왜 지웠는지 적습니다 |
| 이미지 빌드에 secret·캐시 없음 | `engineering-agent-image.yml`의 `docker build --pull --no-cache` |
| `npm ci`를 일부러 하지 않음 | `deployed-commit-drift.yml`의 "No `npm ci`" 주석 |
| 캐시 표면 0 | `secret-history-scan.yml`, `back-merge-main-to-develop.yml`, `codeql.yml` |
| secret을 한 step으로 좁힘 | `feedback-autofix.yml:174` (step `Attempt the fix (LLM key only in this step)`) |
| Rust 캐시에 restore-keys 없음 | `orchestrator-rust.yml`의 step `Restore the downloaded crates` |

## 7. 권고 — 우선순위 순

**어느 것도 이 감사에서 실행하지 않았습니다.** 각 항목에 승인·검토 요건을
적습니다.

### P1. `main`·`develop` scope에서 무검증 캐시 **저장**을 멈춥니다 — 1순위

> **구현 완료.** schedule 전용 둘은 `actions/cache/restore`로 바꿔 아예 쓰지
> 않고, 혼합 trigger 셋은 restore + `if: github.event_name == 'pull_request'`
> 조건부 `actions/cache/save`로 나눴습니다. Rust 캐시도 포함했습니다(아래 2번의
> 판단). PR 전용 둘(`pr-fast-gate`, `review-parity-shadow`)은 그대로 둡니다 —
> 그 run은 자기 merge ref에만 씁니다.
>
> 불변식은 `reachesWidelyReadableScope()`가 판정하고 같은 검사가 강제합니다:
> **기본 branch나 `develop`에 닿을 수 있는 run은 캐시를 쓰지 못하며**, 조건부
> save는 `github.event_name`이나 `github.ref`를 이름 대야 합니다. 읽을 수 없는
> trigger는 "닿는다"로 봅니다(fail-closed). 쓰기가 허용된 workflow 목록도
> 테스트가 고정하므로 새 writer는 조용히 생기지 않습니다.
>
> **보강(round 12).** 위 문단은 **선언된 단계**에 대해서만 참이었습니다. 아래
> P1a가 그 차이와, 토큰 자체에서 쓰기를 거두는 조치를 적습니다.

#### P1a. 선언을 좁히는 것은 **토큰**을 좁히는 것이 아닙니다 — `cache-mode`

> **구현 완료.** `main`·`develop`에 닿을 수 있는 workflow **24개 전부**가
> 최상위에 `cache-mode: read`를 선언합니다. 같은 검사가
> `cache_mode_write_capable_in_widely_readable_scope`와
> `cache_mode_widened_by_job`으로 이를 유지하며, 선언 누락·`write`·
> `write-only`·GitHub이 정의하지 않은 값(식 포함)을 모두 거절합니다.

**독립 검토 round 12가 reject한 지점이고, 지적이 맞습니다.**

`actions/cache/restore`를 고르고 save에 `if:`를 붙이는 것은 **그 단계가 무엇을
하는지**에 대한 진술입니다. job의 캐시 **토큰**은 그대로 쓰기가 가능하고,
GitHub의 기본값은 trusted trigger(`push`·`schedule`·`workflow_dispatch` 등)에
대해 `write`입니다. 그러므로 그 job 안에서 실행되는 어떤 것이든 — 의존성의
install script, crate build script, `uses:`로 불러온 action — 캐시 API를 직접
호출해 **아무 키로든** 항목을 쓸 수 있습니다. 이 감사가 F3에서 적은 "제3자
install script를 실행하는 `main`·`develop` writer"가 바로 그 실행 지점입니다.

**이 문서가 만든 키 namespace는 권한 경계가 아닙니다.** namespace가 말하는 것은
*선언된* 단계가 어느 항목에 닿는지뿐이고, API를 직접 부르는 코드에는 아무
제약도 걸지 않습니다. 따라서 **부분 적용은 완화가 아닙니다** — 쓰기 가능한
토큰이 `main` scope에 하나라도 남아 있으면, 그 하나를 통해 다른 모든
workflow의 키를 쓸 수 있습니다.

토큰 수준의 유일한 통제는 `cache-mode`입니다(workflow 또는 job 수준,
`read`·`write`·`write-only`·`none`, scoped cache token으로 강제되고 runner가
`ACTIONS_CACHE_MODE`로 노출). 근거:
<https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching>

적용 규칙과 그 근거:

1. **`main`·`develop`에 닿을 수 있는 workflow는 `read` 또는 `none`을 선언합니다.**
   판정은 P1이 이미 쓰던 `reachesWidelyReadableScope()`를 그대로 씁니다. 두
   번째 판정기를 만들지 않습니다.
2. **캐시를 전혀 쓰지 않는 workflow도 포함합니다.** 2.3이 "유지해야 할 모양"
   으로 적은 그 workflow들도 토큰은 쓰기 가능합니다. 캐시 단계가 없다는 것은
   오늘의 사실이고, 단계 하나가 추가되거나 `uses:`가 스스로 캐시하는 순간
   아무도 결정하지 않은 쓰기가 생깁니다.
   - **그 workflow에도 `none`이 아니라 `read`를 썼습니다.** `none`이 더 좁지만,
     "이 workflow는 캐시를 안 쓴다"를 증명하려면 **불러온 action이 스스로 캐시하지
     않는다**까지 증명해야 하고(4.2의 `setup-node` 기본값이 바로 그 사례입니다),
     틀렸을 때 `none`은 그 action의 복원을 끊습니다. 반면 `read`로 얻지 못하는
     보안은 없습니다 — 이 감사가 닫는 것은 **쓰기** 경로이고, `read`는 그것을
     전부 거둡니다. 검사가 `none`도 받으므로, 어느 workflow를 `none`으로 좁히는
     것은 나중에 공짜로 할 수 있습니다.
3. **선언 위치는 job이 아니라 workflow 최상위입니다.** job 수준 값이 workflow
   값을 덮으므로, 최상위에 두면 나중에 추가된 job이 **상속**합니다. job 수준
   선언은 좁히는 것만 허용하고(`read` 아래의 `none`), 넓히는 것은 거절합니다 —
   `write-only`는 복원을 못 하지만 쓰기를 되돌려 주므로 넓히는 것입니다.
4. **PR 전용 workflow에는 요구하지 않습니다.** 그 run의 쓰기는
   `refs/pull/<n>/merge`에 들어가고 다른 ref가 복원하지 못합니다(1장). 거기에
   `read`를 요구하면 이 감사가 **일부러 남긴** warming — 같은 PR의 다음 run이
   복원하는 항목 — 이 사라집니다.
5. **값은 네 literal만 받습니다.** 식(`${{ … }}`)은 공식 문서가 정의하지 않고
   GitHub이 받아 줄지도 확인되지 않았으므로, 이 검사는 거절합니다. 틀릴 수 있는
   방향이 한쪽뿐이기 때문입니다.

**비용과 아직 측정되지 않은 것.** `cache-mode: read`는 fail-safe입니다 — 공식
문서는 "mode 때문에 건너뛴 캐시 동작은 informational message를 남기고 step과
run은 실패 없이 계속된다"고 적습니다. 따라서 최악의 결과는 느려지는 것이고
깨지는 것이 아닙니다. 다만 **명시 선언이 `pull_request` run에도 걸리는지는
문서가 답하지 않습니다.** 문서가 "`pull_request` 이벤트는 영향을 받지 않는다"고
적은 곳은 *low-trust 기본값* 절이고, 기본값과 명시 선언은 다른 것입니다. 이것이
중요한 이유는 혼합 trigger 셋(`admin-console-e2e`·`e2e`·`orchestrator-rust`)
입니다. 그 셋은 `read`를 선언하면서 PR 조건부 save도 그대로 갖고 있습니다.

- 명시 선언이 PR run에 걸리지 **않으면**: 선언은 trusted run의 쓰기만 거두고 PR
  warming은 그대로입니다. 비용 0.
- 걸리**면**: 그 셋의 save는 informational message를 남기고 건너뛰어지며, 캐시
  warming이 사라집니다. 그 경우 남은 save·restore 단계는 죽은 코드이므로
  제거하는 것이 정직하고, 비용은 저장소에서 가장 무거운 gate 둘이 매 run 차가운
  캐시로 도는 것입니다.

**이 PR 자신이 그 측정입니다.** `admin-console-e2e`와 `orchestrator-rust`는 이
PR에서 `pull_request`로 돌고, 그 run의 save 단계 로그가 mode 때문에
건너뛰어졌는지를 말해 줍니다. 결과는 아래 "측정" 칸에 적습니다.

> **측정 결과 — 걸립니다.** PR #2009의 `Orchestrator Rust` run
> (`37106375986`, `pull_request` 이벤트, `cache-mode: read`)에서 save 단계가
> 남긴 줄입니다.
>
> ```
> ##[warning]Failed to save: Unable to reserve cache with key
> Linux-rust-v2-cargo-home-85e0d614…
> More details: cache write denied: token has no writable scopes
> ```
>
> 세 가지가 함께 확정됐습니다.
>
> 1. **명시 `cache-mode`는 `pull_request` run에도 적용됩니다.** 문서가
>    "영향받지 않는다"고 적은 것은 low-trust *기본값*이고, 명시 선언은 별개
>    입니다.
> 2. **"token has no writable scopes" — round 12의 전제가 맞습니다.** 거부 주체가
>    action이 아니라 **토큰**이라고 GitHub 자신이 말합니다. restore-only가 하지
>    못한 일이 바로 이것입니다.
> 3. **fail-safe는 맞지만 문서보다 약합니다.** 단계 결론은 `success`이고 run은
>    실패하지 않습니다. 다만 문서가 말한 "informational message"가 아니라
>    `##[warning]`이며, `cache/save@v5`는 **tar/zstd 압축을 모두 끝낸 뒤** 거부
>    당합니다. 건너뛰는 것이 아니라 값을 치르고 거절당하는 것입니다.
>
> **관측은 하나가 아닙니다.** 같은 PR의 `Admin Console E2E` run
> (`37106376116`)에서 `.next/cache`와 Playwright 캐시 양쪽이 같은 거부를
> 받았습니다. 즉 경로·workflow·캐시 종류에 따른 특수 사례가 아니라 토큰의
> 성질입니다. 같은 run의 restore는 `Cache not found for input keys`였습니다 —
> v2 키로 쓰인 항목이 아직 없었다는 뜻이고, 이 변경 이전에도 miss였습니다.

**그래서 죽은 save 단계 다섯 개를 제거했습니다**(`admin-console-e2e` 2,
`e2e` 2, `orchestrator-rust` 1). 그 단계들이 할 수 있는 일은 매 run 압축 비용을
쓰고 경고를 남기는 것뿐이고, 남겨 두면 **필수 gate에 상설 경고**가 생겨 사람이
경고를 무시하도록 훈련시킵니다. 더 나쁜 것은 warming이 동작하는 것처럼 보인다는
점입니다. restore 쪽 절반은 **남겼습니다** — 아래 세 선택지 전부가 그것을
필요로 하고, 주석이 "지금은 아무도 쓰지 못한다"를 명시합니다.

**이로써 이 저장소의 캐시 writer는 PR 전용 둘(`pr-fast-gate`,
`review-parity-shadow`)뿐입니다.** 그리고 키 namespace 규칙상 두 writer의 항목은
다른 workflow의 복원 키와 맞지 않으므로, **24개 workflow의 복원은 지금 영구히
miss입니다.** 비용은 측정 가능한 것으로만 적습니다 — Next build 캐시와 Playwright
브라우저가 `admin-console-e2e`·`e2e`의 매 run에서, cargo registry가
`orchestrator-rust`의 매 run에서, npm 캐시가 schedule workflow 약 20개에서 다시
만들어집니다. (이 run의 restore 로그가 이미 `Cache not found for input keys`
입니다 — v2 키를 쓴 적이 아직 없으므로 이 변경 전에도 miss였습니다.)

**warming을 되살리는 길은 셋이고, 전부 운영자 행위가 필요하거나 별도 설계입니다.**
"검증 범위는 되돌릴 수 없는 것에 비례합니다"에 따라 경로를 닫는 것이 기본이므로
닫은 상태로 두고, 선택은 넘깁니다.

> **소유자 결정 (2026-10-04): 지금은 셋 중 아무것도 하지 않습니다.** 측정이 그
> 설계 비용을 정당화하지 않습니다.
>
> p50(성공 run), 변경 전 2026-09-28~10-02 대 변경 후 2026-10-03 07:04Z 이후:
>
> | workflow | 전 | 후 |
> |---|---|---|
> | Admin Console E2E | 11분 (7–21, n=100) | **12분** (8–31, n=100) |
> | Orchestrator Rust | 11분 (1–21, n=100) | 1분 (0–18, n=100) |
> | E2E (Chromium) | 36분 (27–66, n=49) | 28분 (26–46, n=5) |
>
> 뒤의 둘은 **빨라졌습니다** — vendor scope 판정과 6-shard 분할·가중치 때문이고
> 캐시와 무관합니다. 이 창에서는 다른 CI 작업이 효과를 지배하므로, 캐시에
> 귀속할 수 있는 신호는 Admin Console E2E의 **+1분(~9%)** 하나입니다. 그마저
> 작은 이유는 v2 키 회전 뒤 main scope 항목이 애초에 없었고 아무도 다시 데우지
> 않았기 때문입니다.
>
> 되찾을 수 있는 **상한**도 단계별로 쟀습니다(main push run, 전부 cold):
> `npm ci` 39초 + Next build 135초 + Chromium 설치 23초 = **약 3분 17초**. warm
> 캐시가 `npm ci`나 build를 공짜로 만들지는 않으므로 현실적 회수는 run당 1.5~2.5
> 분이고, 이 job 시간의 대부분인 suite 504초는 그대로입니다.
>
> **다시 볼 조건**(하나라도 성립하면 1번을 꺼냅니다):
> Admin Console E2E p50가 **15분 초과**(오늘 12분, job 상한 25분에 대한 여유가
> 줄어드는 지점) · E2E 샤드 중 하나의 p50가 **30분 초과** · Playwright나 Next
> 캐시를 쓰는 workflow가 새로 추가되어 cold 비용이 곱해짐.

> **아직 열려 있는 것 — 기존 항목.** 위 3번("기존 항목은 전환만으로 사라지지
> 않습니다")은 **실행되지 않았습니다.** 2026-10-04에 캐시 API를 읽은 결과, 활성
> 항목 20개 10,167 MB 중 널리 읽히는 scope에 있는 것은 **정확히 1개**입니다 —
> `gitleaks-cache-8.24.3-linux-x64`, 5 MB, 생성 2026-10-03T05:16(쓰기가 열려
> 있던 창), 최근 접근 2026-10-04T07:46. 매일 접근되므로 퇴출되지 않습니다.
>
> 그 항목은 이 문서의 규칙이 보지 못하는 모양입니다. `gitleaks/gitleaks-action@v3`
> 가 **자기 키로** Actions 캐시를 내부에서 쓰고 복원한 **바이너리를 실행**하며,
> `npm run check:ci-cache-keys`는 workflow YAML에 선언된 `actions/cache*` 단계만
> 읽습니다(이 모듈의 머리 주석이 그 한계를 적고 있습니다). 즉 F3이 말한 모양이
> 서드파티 action 안에 한 건 남아 있습니다.
>
> **삭제했습니다**(2026-10-07, 소유자 지시). 삭제 뒤 다시 읽은 결과 널리 읽히는
> scope의 항목은 **0개**이고, 저장소 전체는 20개 10,167 MB에서 19개 9,776 MB가
> 됐습니다. 그 scope에는 아무도 쓸 수 없으므로 항목은 다시 생기지 않고, 비용은
> daily audit run마다 gitleaks 5 MB 재다운로드(로그상 약 1초)입니다. 이로써
> P1의 3번("기존 항목은 전환만으로 사라지지 않습니다")이 지적한 잔존이 닫혔고,
> 그것은 이 감사가 적어 두고 실행하지 않았던 유일한 항목이었습니다.

1. **writer 하나, reader 여럿** — 캐시 scope는 **ref 단위이고 workflow 단위가
   아니므로**, PR 전용 writer가 쓴 항목은 같은 PR ref에서 도는 다른 workflow가
   복원할 수 있습니다. 키를 공유하게 만드는 것이 조건이고, 그러려면
   `key_shared_across_workflows`를 "선언된 writer 하나 + reader 여럿"으로
   다시 설계해야 합니다. 그것이 안전해진 근거는 이 변경 자체입니다 — 널리 읽히는
   scope에 쓸 수 있는 run이 더는 없으므로, 남는 위험은 정책이 이미 열려 있다고
   기록한 **같은 PR 방향**뿐이고 그것은 PR 작성자가 자기 코드로 이미 할 수 있는
   일입니다. 다만 writer의 캐시 **내용**이 reader에게 쓸모 있는지(예:
   `pr-fast-gate`가 Playwright 브라우저를 받는지)는 확인이 필요합니다.
   운영자 행위 없음, 설계 필요.
2. **reusable workflow로 이벤트별 job 분리** — 호출자 job의 `cache-mode`가 피호출
   workflow의 요청을 제한하므로, `pull_request` job은 선언 없이(write) 두고
   trusted job만 `read`로 둘 수 있습니다. **필수 check 이름이 바뀌므로** 운영자가
   branch protection을 갱신해야 합니다.
3. **trusted trigger 제거** — `admin-console-e2e`·`orchestrator-rust`의
   `push: [develop, main]`을 없애면 두 workflow가 PR 전용이 되어 규칙 대상에서
   빠지고 warming이 그대로 돌아옵니다. AGENTS.md의 "main으로 가는 PR은 release와
   hotfix뿐" 절이 같은 중복(PR과 push에서 CI 두 번)을 비용으로 적고 있으므로
   방향은 어긋나지 않습니다. 다만 **병합 후 검증 run을 없애는 것**이고, 그것은
   운영자 결정입니다.

대상과 조건 다섯 가지입니다. 독립 검토(9장)가 넷을 추가했습니다.

1. **막을 이벤트는 `schedule`·`push: main`만이 아닙니다.** `push: develop`
   (`admin-console-e2e`, `orchestrator-rust`, `credit-finance-db-integration`)
   과 `main`·`develop`에서 도는 `workflow_dispatch`(`e2e.yml` 등)도 같은
   scope에 씁니다. 판정은 trigger 이름이 아니라 **run의 ref가 기본 branch이거나
   `develop`인가**여야 합니다.
2. **Rust 캐시를 범위에 넣을지 명시합니다.** 2장이 적은 대로 그 foothold는 npm이
   아니라 crate build script입니다. **포함했습니다** — 구조가 같기 때문입니다:
   `target/`의 build script 바이너리에 무결성 검증이 없고, 그 workflow는 `push`
   로 `main`·`develop`에 모두 닿으며, 복원한 것을 `cargo`가 실행합니다. 모델이
   다른 것은 **누가 심는가**이고, 바뀌지 않는 것은 **쓰인 곳이 모든 run에서
   읽힌다**는 점입니다. 키 namespace 규칙은 Rust에 적용하지 않는다는 것이
   초안의 판단이었습니다 — 한 workflow만 쓰고 restore-keys가 없어서 공유 규칙이
   잡을 것이 없다고 봤습니다. **최종 구현은 적용했습니다.** 캐시는 **키만으로**
   식별되므로 경로를 근거로 한 면제는 면제된 단계가 다른 workflow의 키를 쓰는
   길이 되고(독립 검토 round 9), 그래서 검사는 `actions/cache`의 **모든** 경로에
   적용됩니다. Rust 키도 `${{ runner.os }}-rust-v2-cargo-home-`을 갖고,
   `target/`은 운영자의 병합 결정으로 캐시에서 빠졌습니다(9장 round 11 뒤의
   병합 기록). 쓰기 규칙은 모든 경로에 적용됩니다.
3. **기존 항목은 전환만으로 사라지지 않습니다.** restore-only로 바꾼 뒤에도
   이미 `main`·`develop` scope에 있는 항목은 퇴출될 때까지 복원 후보로 남습니다
   (1장). 그러므로 **일회성 삭제**(캐시 관리 API/UI) 또는 **key namespace
   회전**이 전환과 **한 변경에** 들어가야 합니다. 이것이 빠지면 전환은 아무것도
   닫지 않습니다.
4. **"PR은 저장 유지"는 action 교체 하나로 되지 않습니다.** 같은 단계가 ref에
   따라 저장을 하고 안 하게 하려면 `actions/cache/restore`와
   `actions/cache/save`를 나누고 save에 `if:` 조건을 달아야 합니다.
   `actions/cache` 한 줄을 바꾸는 것보다 손이 더 갑니다.
5. 대상 단계는 2.1의 다섯 workflow의 `.next/cache`·ms-playwright 단계이고,
   Rust는 2번의 판단에 달립니다.

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
첫 run 비용이 모든 PR에 걸립니다. 중간 안은 PR run에서는 저장을 유지하고(PR
scope로만 감) **run의 ref가 기본 branch이거나 `develop`일 때만** 끄는 것입니다
— 그러면 기본·base scope 항목이 더 생기지 않고 PR 비용은 그대로입니다.
**이 안을 권고하며, 위 3번(기존 항목 삭제 또는 namespace 회전)과 한 변경으로
묶어야 합니다.**

역할: `impl`. 계약 파일이 아니지만 필수 check의 입력을 바꾸므로 독립 검토
대상입니다.

### P2. restore-keys와 키 namespace를 끊습니다 — 1순위, P1과 독립

> **구현 완료.** `.next/cache`의 broad fallback 여섯 줄을 지우고, 두 캐시
> 계열의 키를 `<family>-v2-<workflow namespace>-`로 바꿨습니다. 불변식은
> `scripts/ci-cache-key-policy.mjs`가 판정하고
> `npm run check:ci-cache-keys`가 PR Fast Gate static 단계에서 강제하며
> `tests/ciCacheKeyPolicy.test.mjs`가 고정합니다. `v2`가 P1의 "기존 항목이
> 남는다" 요구를 함께 해결합니다 — 옛 세대의 항목은 어떤 키에도 맞지 않으므로
> 운영자가 캐시를 손으로 지울 필요가 없습니다.

- `${{ runner.os }}-next-` fallback 다섯 곳 제거(F2의 목록). `pr-fast-gate`가
  이미 한 것과 같은 변경이고, 정합성 이득이 함께 옵니다. 비용 거의 없음.
- Playwright 키에 workflow 식별자를 넣어 pool을 쪼갭니다.

**P2만으로는 F1이 닫히지 않습니다.** 3.2의 여섯 job은 restore-keys를 지워도
`Linux-playwright-<lock>-chromium`이라는 **같은 primary key**를 공유합니다.
키에 식별자를 넣는 쪽이 본체이고 restore-keys 정리는 부수입니다. 이 점을
혼동하면 "좁혔다"고 적고 아무것도 좁히지 않게 됩니다.

역할: `impl`.

### P3. 분리를 규칙으로 고정합니다 — 2순위, F4의 답

> **구현 완료.** `lib/agentCredentialReachability.ts`가 복원하는 캐시의
> **종류**(`verified_package_manager` · `unverified` · `unreadable`)를 판정해
> `credential_job_restores_cache` 이유에 실어 보냅니다. **기존 규칙은 바뀌지
> 않았습니다** — 어떤 캐시든 복원하면 여전히 모든 변경이 push 금지입니다.
> `npm run check:credential-cache-separation`이 PR Fast Gate static 단계에서
> 자격증명 job의 `unverified`·`unreadable` 복원을 막고, 같은 모듈을 쓰므로
> 판정기가 둘로 갈라지지 않습니다.
>
> `POSTURE_DIGEST`가 이제 종류를 담습니다(`62ba14563ed8` → `2ccf7af5eb0f` →
> `977c24f3e564`). **첫** 전환에서 workflow의 posture는 바뀌지 않았습니다 —
> 캐시 이유 14건이 전부 `verified_package_manager`, 이유 17건, 자격증명 job
> 22건이었습니다. **두 번째**는 같은 작업의 결과입니다: 4.2가 가리킨 bare
> `setup-node` 세 곳에 `package-manager-cache: false`를 넣었으므로 캐시 이유가
> 14 → 11건, 이유 합계가 17 → 14건으로 줄고, 자격증명 job 22건과 경로 규칙
> 1건은 그대로입니다. 즉 4.3이 손으로 읽어 낸 **11건**이 이제 기계가 확인한
> 사실이고, 그것이 끝나는 순간 digest와 검사가 함께 실패합니다.
>
> (초안은 이 칸에 `2ccf7af5eb0f`와 14건을 적어 둔 채였습니다. 독립 검토
> round 12가 최종 상태와 다르다고 지적했고, 위 숫자가 최종입니다.)

**자격증명을 가진 job은 `cache: npm` 외의 Actions 캐시를 복원하지 않는다.**

구현은 새 스크립트가 **아니라** `lib/agentCredentialReachability.ts`의
`restoresCache`를 캐시 종류별로 나누고, 그 판정을 PR Fast Gate static
단계의 검사로 올리는 것입니다. 두 번째 판정기를 만들면 숫자가 어긋납니다 —
AGENTS.md가 PACKAGE-01 지표에 대해 같은 것을 요구합니다("ESLint 자체 API로
셉니다. 별도 scanner를 만들어 두 숫자가 어긋나게 하지 않습니다").

조건 셋을 함께 지켜야 합니다. 독립 검토(9장)가 둘을 추가했습니다.

1. **판정은 `cache:` 문자열이 아니라 실제 캐싱 조건을 읽어야 합니다.** 4.2가
   보인 대로 `setup-node@v6`는 `packageManager`·`devEngines.packageManager`가
   npm을 지정하면 `cache:` 없이도 캐시합니다. `cache:` 유무만 보는 검사는 그
   변경을 통과시킵니다.
2. **`POSTURE_DIGEST`에 캐시 **종류**가 들어가야 합니다.**
   `tests/agentCredentialReachability.test.mjs`의 `POSTURE_DIGEST`는 reason 이름
   (`credential_job_restores_cache`)만 담습니다. 그래서 **이미 npm 캐시를
   복원하는 자격증명 job에 `.next/cache`를 더하면 reason이 그대로고 digest가
   움직이지 않습니다** — 4.3의 열한 job 전부가 그 상태이므로, 이 감사가 가장
   걱정하는 변경이 바로 digest에 안 잡히는 변경입니다. 분석 결과와 digest
   입력에 종류를 명시해야 검사가 성립합니다.
3. digest를 갱신할 때는 소유자와 함께 읽으라고 :546-548이 적습니다.

역할: `contract`(`lib/agentCredentialReachability.ts`는 에이전트 권한 경계).
소유자 승인 + 독립 검토.

### P4. `cacheIsolationRecorded` 기록의 문구를 한정합니다 — 3순위, F5의 답

> **구현 완료.** `docs/policy/engineering-agent.md` §5에 "그 기록이 담아야 하는
> 것" 세 항목을 넣었습니다 — PR → 다른 ref는 닫혀 있다(근거: 공식 규칙), 기본·
> base → PR은 열려 있고 **격리를 근거로 쓸 수 없다**, 같은 PR 안은 열려 있으므로
> 에이전트 PR에서 도는 자격증명 cache 복원 job이 없음을 **job의 조건식까지 읽어**
> 따로 확인해야 한다. "Actions cache는 ref 간에 격리된다"는 거짓이라고 명시했습니다.
>
> 새 §5.1이 cache 종류와 `check:credential-cache-separation`을 적고, **그 검사가
> 3번 항목을 유지하지 않는다**는 것을 명시합니다 — 그것은 `unverified`·
> `unreadable`만 거절하고, 3번은 자격증명 job이 **어떤** cache도 복원하지
> 않는다는 더 강한 조건입니다. 그래서 정책은 그 장치가 생길 때까지 기록 작성을
> 막고, 필요한 장치는 **P7**에 적었습니다. **기록 자체를 쓰는
> 것(`cacheIsolationRecorded: true`)은 여전히 소유자의 행위이고 이 변경에
> 포함되지 않습니다** — 호출자 둘 다 `false`로 남아 있습니다.

**초안은 이 항목을 2순위이자 P3의 선행 조건으로 두었습니다. 독립 검토(9장)가
그 판단을 뒤집었으므로 3순위로 내리고 내용을 줄입니다.**

그 기록은 자기가 대답할 질문에 정확히 대답하므로(F5), P3을 기다릴 필요가
없습니다. 남는 요구는 셋입니다.

- 쓸 수 있는 문장: "pull_request run이 만든 캐시는 **다른 ref의** run에 도달하지
  않는다." 근거는 1장의 공식 규칙.
- 쓰면 안 되는 문장: "Actions 캐시는 ref 간에 격리된다." 기본·base → PR 방향이
  열려 있으므로 거짓이고, 그 방향은 F4·P3이 다루는 **다른 위협**입니다.
- **같은 PR 방향을 따로 적어야 합니다.** 공식 문장은 "re-runs of the pull
  request"는 복원할 수 있다고 말하므로, 그 방향에 대해서는 격리가 근거가 되지
  않습니다. 근거는 **"에이전트 PR에서 실제로 도는 자격증명 캐시 복원 job이
  오늘 없다"**이고, 그 판정은 workflow trigger만이 아니라 **job의 `if:`까지**
  읽어야 성립합니다(F5가 rev 2에서 틀린 지점이 바로 그것입니다). 대상 이름은
  §16에 따라 비공개 기록에 둡니다.

`docs/policy/engineering-agent.md` §5의 캐시 경로 항목 변경이므로 역할은 `contract`이고
**소유자 승인이 필요합니다.** P3과의 순서 의존은 없지만, 세 번째 항목의 근거가
"오늘 없다"이므로 **P3이 그 상태를 유지해 주어야 기록이 계속 참입니다.**

### P5. 복원 후 무결성 검사 — 권고하지 않음, 대안으로만 기록

Playwright 바이너리 해시 핀은 브라우저 버전마다 바뀌어 유지보수가 비싸고,
`.next/cache`는 내용이 빌드마다 달라 핀할 기대값이 없습니다. P1이 더 싸고 더
확실합니다. 검사를 넣는다면 F6 때문에 `continue-on-error`가 없는 **별도
단계**여야 합니다.

### P6. 조사 항목 — 권고가 아닙니다

`main` scope writer의 `npm ci --ignore-scripts`. **drop-in이 아닙니다.** 둘이
걸립니다.

- `package.json`의 `postinstall`이 `prisma generate`이므로 명시적
  `npx prisma generate` 단계가 필요합니다.
- 현재 lockfile에서 `hasInstallScript`인 패키지가 **10개**입니다 —
  `@prisma/engines`, `prisma`, `esbuild`, `@sentry/cli`, `tesseract.js`,
  `unrs-resolver`, 그리고 `fsevents` 3경로(macOS 전용이라 Linux runner에서는
  설치되지 않습니다). 각각이 script 없이도 동작하는지는 패키지별로 달라
  **확인하지 않았습니다.**

확인 전에 권고하지 않습니다. 이 수치는 "표면이 좁다"가 아니라 "넓다"는 쪽을
가리킵니다.

### P7. 후속 — P4가 쓰려는 기록의 세 번째 조건에는 유지 장치가 없습니다

> **구현 완료.** `npm run check:agent-pr-cache-isolation`이 그 장치입니다 —
> **에이전트가 일으키는 이벤트에 걸리는 workflow의 자격증명 job은 어떤 cache도
> 복원하지 않는다**를 묻고, `verified_package_manager`까지 거절합니다. 판정은
> `lib/agentCredentialReachability.ts`가 새로 보고하는 `reachedWorkflows`와 cache
> 이유의 교차이며(P3대로 판정기를 둘로 만들지 않았습니다), 판정 코드는
> `scripts/agent-pr-cache-isolation-policy.mjs`, 고정은
> `tests/agentPrCacheIsolation.test.mjs`입니다. PR Fast Gate static 단계에서 돕니다.
>
> **아래가 설계를 요구한 지점 — 조건식 — 은 분석기가 읽지 않습니다.**
> `docs/policy/engineering-agent.md` §5의 제약을 그대로 두고, 대신 조건을 면제가
> 아니라 사실로 만들었습니다(소유자 결정, 2026-10-03). 실측에서 cache 이유 11건
> 중 도달 workflow 안에 있던 것은 **1건**이고, 그 job의 `if:`가 에이전트 branch를
> 배제하지만 그것을 근거로 쓰지 않고 그 job에서 npm cache를 뗐습니다. 그래서
> 검사는 도달 workflow 8개의 자격증명 job 5개에 대해 복원 0으로 통과합니다.
> cache 이유는 11 → 10이 되었고 전부 도달하지 않는 workflow에 있으며, §5는
> 그것들에 대해 여전히 모든 변경을 금지합니다.
>
> `docs/policy/engineering-agent.md`에 §5.2가 생기고, §5 기록 3번과 §5.1의
> "장치가 아직 없다"가 그것을 가리키도록 바뀌었습니다. **기록 자체를 쓰는
> 것(`cacheIsolationRecorded: true`)은 여전히 소유자의 행위이고 이 변경에
> 포함되지 않습니다** — 호출자 둘 다 `false`로 남아 있습니다.
>
> 독립 검토: 검토 서버 job `r-20261003-015621-25b789`, contract 경로이므로
> reviewer 2명(Codex `openai`, Cursor `xai`), 양쪽 **accept**, finding 0.
> 검토 뒤에 주석 두 곳의 문구만 줄였습니다 — §16이 금지하는 "현재 실패하고 있는
> 대상의 이름"에 걸리지 않도록, 특정 job이 자격증명을 갖고 도달한다고 단정하던
> 문장을 규칙 서술로 바꾼 것이고 판정 코드는 바뀌지 않았습니다.

**이 항목은 감사의 원래 권고가 아니라 P4를 구현하는 동안 독립 검토가 찾아낸
선행 조건입니다.** 분모에 넣지 않고 여기에 기록해 잃지 않게 합니다.

P4의 §5 기록 3번은 "에이전트 PR에서 도는 자격증명 cache 복원 job이 없다"를
근거로 요구합니다. P3의 `check:credential-cache-separation`은 그것을 **유지하지
않습니다** — `unverified`·`unreadable`만 거절하고 `verified_package_manager`
복원은 통과시킵니다. 그 차이가 중요한 이유는 에이전트가 자기 PR에서
`package-lock.json`을 바꿀 수 있고, 그러면 lockfile integrity 대조는 에이전트가
넣은 값과 맞아떨어진다는 것입니다.

필요한 장치는 더 좁은 질문입니다 — **에이전트가 일으키는 이벤트에 걸리는
workflow의 자격증명 job은 어떤 cache도 복원하지 않는다.** 그것은 P3의 검사와
다른 검사이고, 분석기가 job의 조건식을 해석하지 않는다는 제약
(`docs/policy/engineering-agent.md` §5의 "사람이 검토한 제외" 항목)과 어떻게
맞물릴지 설계가 필요합니다 — F5가 틀린 이유가 바로 조건식을 읽지 않은 것이기
때문입니다.

**그 장치가 없는 동안 정책은 기록 작성을 막습니다.** 그것이 지금의 안전한
상태이고, 이 항목은 기록을 쓰고 싶어질 때 먼저 해야 할 일입니다.

장치가 생긴 뒤에도 **정책은 기록을 자동으로 열어 주지 않습니다.** 검사가 통과하는
것은 3번 조건이 오늘 참이라는 사실일 뿐이고, 1번·2번의 근거와 함께 날짜 있는
기록을 쓰는 것은 소유자의 행위로 남습니다.

## 8. 이 감사가 증명하지 못한 것

1. **실제 캐시 항목의 내용.** GitHub의 캐시 목록·내용을 조회하지 않았습니다.
   오염 항목이 지금 있는지는 모릅니다.
2. **P1의 ms-playwright 비용.** 7장 P1에 산정 보류로 적었습니다.
3. **`.next/cache` 오염으로 번들에 코드를 넣을 수 있다는 것.** webpack/Turbopack
   의 파일시스템 캐시에 모듈 단위 무결성이 없다는 구조 판정이고, 이 저장소의
   Next 버전에서 실증한 것은 아닙니다. 실증된 것은 **버전이 다른 캐시가 빌드를
   깨뜨렸다**는 것뿐입니다(`admin-console-e2e.yml`·`daily-security-audit.yml`의
   restore-key 주석이 그 기록입니다).
4. **자격증명 판정 22건의 전수 근거.** 0장 4번에 적었습니다. `pr-fast-gate #
   fast-gate`가 왜 자격증명 보유로 판정되는지는 추적하지 않았습니다 — 그 job은
   캐시를 복원하지 않으므로 세 축에 영향이 없습니다.
5. **공격자 모델의 현실성.** 침해된 제3자 의존성 하나를 전제로 합니다. 그
   전제의 확률은 평가하지 않았습니다. Rust 경로는 그 모델의 crate 판본이며,
   2장이 그 구분을 적습니다.
6. **install script 10개 각각이 생략 가능한지.** 7장 P6에 적었습니다.
7. **`packageManager` 필드가 추가될 가능성.** 4.2의 잠복 경로는 구조 판정이고,
   그 변경이 제안된 적이 있는지는 확인하지 않았습니다.

## 9. 독립 검토

**문서에 대한 round와, 구현 전체에 대한 round를 함께 적습니다.** 구현 slice
각각에 대한 round 3–11은 이 문서가 아니라 그 slice의 코드와 테스트에 반영돼
있고(각 테스트가 "independent review caught it"으로 그 사례를 고정합니다),
여기 적는 것은 **판정이 이 문서의 내용을 바꾼 round**입니다.

| round | 대상 | 경로 | reviewer | 결과 |
|---|---|---|---|---|
| 0 | rev 1 (`3882fdb6f`) | Codex 직접 (서버 큐 `queue_full`) | Codex `gpt-5.6-sol` / xhigh | **reject** — 지적 전부 반영 |
| 1 | rev 2 (`5abcb4ef7`) | 검토 서버 `r-20261002-223406-84907a` | **devin** (vendor `cognition`) | **unknown** — `reviewer_exit_1`, findings 0건 |
| 2 | rev 2 (`7598ff881`) | 검토 서버 `r-20261002-223916-d7532b` | **codex** (vendor `openai`) | **reject** — major 2, minor 1. 전부 반영 → rev 3 |
| 12 | 구현 전체 diff (`2e831bbd7`, PR #1964) | 검토 서버 `r-20261003-055900-4e006a` | 2명 (contract 경로) | **reject** — major 1, minor 1. 전부 반영 → P1a |
| 13 | rev 3 (`ee802e6c3`, PR #2230) | 검토 서버 `r-20261008-091013-08b7de` | **cursor** (vendor `xai`) | **reject** — major 1, minor 3. 전부 반영 |
| 14 | 같은 PR (`580dbac5b`) | 검토 서버 `r-20261008-092418-121d66` | **cursor** (vendor `xai`) | **reject** — major 2, nit 1. 전부 반영 |
| 15 | 같은 PR | 검토 서버 `r-20261008-093548-f38842` | **cursor** (vendor `xai`) | **reject** — major 3, minor 1, nit 1. 전부 반영 → rev 4 |

### round 13~15 — 같은 실패를 세 번: 선언을 읽고 권한을 읽지 않았습니다

**round 12가 고친 것과 같은 종류입니다.** 그때는 restore-only 선언을 토큰 통제로
읽었고, 이번에는 **같은 캐시 키를 선언하는 것을 항목을 주고받는 것으로** 읽었습니다.
세 round이 잡은 것을 합치면 하나입니다 — 어떤 workflow가 캐시에 **쓸 수 있는가**는
`cache-mode`와 그 단계가 `actions/cache@`인지 `actions/cache/restore@`인지가 정하며,
키 문자열은 그것을 말하지 않습니다.

그 결과로 바뀐 사실들입니다.

- 쓸 수 있는 workflow는 `pr-fast-gate`·`review-parity-shadow` 둘뿐이고 **둘 다
  `pull_request` 전용**이므로, 2장이 묻는 `main`·`develop` scope writer는 **0**입니다.
- `daily-security-audit`의 두 job이 선언하는 키는 **아무도 쓰지 않는 키**입니다.
- `e2e.yml`은 어느 이벤트에서도 Next·Playwright 항목을 저장하지 않습니다.
- `orchestrator-rust.yml`의 항목은 `~/.cargo/registry`·`~/.cargo/git` 둘만 담고
  `target`은 들어 있지 않으며, 어느 push에서도 쓰지 않습니다.
- 쓸 수 없는 것이 복원하지 않는다는 뜻은 아닙니다 — 네 workflow가 `cache: npm`으로
  npm 캐시를 계속 복원합니다.

**세 round 모두 제 수정이 만든 오류였고, 원래 조사의 오류가 아닙니다.** rev 4
자체는 아직 검토를 받지 않았습니다.

### round 12 — reject, 완화의 전제가 틀렸습니다

**처음으로 끝난 전체를 본 round이고, 그 전까지의 accept 하나(round 11)는 마지막
slice 하나에 대한 것이었습니다.**

- **major — 선언을 좁히는 것은 토큰을 좁히는 것이 아닙니다.**
  `actions/cache/restore`로 바꾸고 save에 PR 조건을 붙여도 job의 캐시 쓰기
  권한은 남고, trusted trigger의 기본값은 `write`입니다. 그래서 `main`·`develop`
  에서 도는 악성 install script가 캐시 API를 직접 불러 필수 gate가 복원하는
  공개된 `v2` 키에 오염 항목을 쓸 수 있습니다. 토큰 수준 통제는 `cache-mode`이고
  별도로 적용해야 합니다. **반영: P1a** — 해당 workflow 24개 전부에
  `cache-mode: read`, 검사 규칙 둘, 테스트 6건.
  - 이 지적이 이 감사가 반복한 실패의 세 번째 사례입니다. F5를 두 번 틀린 이유도
    같았습니다 — **선언을 읽고 권한을 읽지 않은 것**(round 0: 분석기가 묻는 질문을
    읽지 않음, round 2: job `if:`를 읽지 않음, round 12: 토큰을 읽지 않음).
- **minor — 구현 완료 칸이 최종 상태와 달랐습니다.** `POSTURE_DIGEST`와 캐시
  이유 건수, Rust 키 namespace 적용 여부가 초안 시점 관측으로 남아 있었습니다.
  **반영**: 두 칸 모두 최종값으로 갱신하고, 초안 관측과 구분해 적었습니다.

### round 2 — reject, 전부 반영

소유자가 재전송을 지시했고(round 1이 unknown이었으므로 에이전트가 스스로 다시
보내지 않았습니다), 서버가 이번에는 codex를 배정했습니다.

| 심각도 | 지적 | 조치 |
|---|---|---|
| major | 같은 PR 방향의 사례로 지목한 job은 head ref가 `feedback-autofix/`일 때만 도는 조건이 있어 에이전트 PR에 걸리지 않는다 | 확인함(`feedback-autofix-promotion-pr.yml`의 job 조건 `startsWith(github.event.pull_request.head.ref, 'feedback-autofix/')`). F5·P4를 고쳐 **오늘 사례가 없다**로 바꿨습니다 |
| major | 미해소 자격증명 도달 대상을 이름과 줄 번호로 공개 저장소에 나열했다 — §16 위반 | 확인함. 목록을 두 문서에서 제거했고, 경위를 **10장**에 적습니다 |
| minor | "복원 단계가 모두 `continue-on-error`"가 Rust 단계와 모순된다 | 확인함. 3.4·F6의 범위를 Next·Playwright 열여섯 곳으로 한정했습니다 |

두 major 모두 **제 쪽 오류**입니다. 첫 번째는 workflow의 trigger만 읽고 job의
조건식을 읽지 않은 것이고, 두 번째는 과제가 요구한 "path:line 증거"와 §16이
충돌하는 지점을 **공개 전에** 짚지 못한 것입니다.

### round 1 — unknown, 재전송하지 않음

```
{
  "jobId": "r-20261002-223406-84907a",
  "status": "unknown",
  "base": "2f7550a5873606fecbfeec993c398a898a69ffcb",
  "head": "5abcb4ef7656ab152d6b9c0e8e535fe12547d730",
  "author": "claude", "authorVendor": "anthropic",
  "touchesContract": false,
  "reviews": [{ "slot": 0, "status": "done", "provider": "devin",
                "vendor": "cognition", "verdict": "unknown",
                "reason": "reviewer_exit_1", "findings": [] }]
}
```

`report`는 본문을 돌려주지 않습니다(0 바이트) — reviewer가 종료 코드 1로
끝났으므로 검토 내용이 없습니다. **그러므로 rev 2는 독립 검토를 받지 않은
상태입니다.** AGENTS.md는 unknown을 다른 reviewer로 다시 보내지 말라고 하므로
(부하가 한쪽으로 쏠림) 재전송하지 않았고, 이 결정은 사람에게 보고했습니다.

### round 0 — reject, 전부 반영

- reviewer: Codex CLI 0.146.0, `gpt-5.6-sol` / `model_reasoning_effort=xhigh`
  (`.codex/agents/contract.toml`이 되돌릴 수 없는 작업에 쓰는 조합),
  `--sandbox read-only`. Codex는 저장소를 직접 읽었고 기준 commit 일치를
  확인했습니다.
- 프롬프트: `.github/audits/actions-cache-poisoning-audit-independent-review-prompt-2026-10-03.md`
  (명령 실행이 막힐 경우를 대비해 증거를 그대로 실었습니다).
- 판정: **reject.** C1·C2·C4·C6·C7 틀림, C3·C5·C8 맞음.
- 반영: rev 2(문서 머리말에 목록). 지적 전부를 받아들였고, 그중 **F5는 제
  판정이 틀렸음**을 확인해 순위를 내리고 내용을 다시 썼습니다. 사실 확인이
  가능한 두 건은 저장소에서 직접 대조했습니다 — `package.json`에
  `packageManager`·`devEngines` 부재, lockfile의 `hasInstallScript` 10건,
  그리고 `actions/setup-node` `action.yml`의 `package-manager-cache` 기본값.
- 다음 round: **rev 3은 아직 검토를 받지 않았습니다.** round 2의 세 지적을
  반영한 결과이고, 재검토가 특히 봐야 할 것 둘:
  1. **F5가 세 번째로도 틀렸는지.** 이 항목에서 제 판정은 이미 두 번
     뒤집혔습니다 — rev 1은 방향을, rev 2는 사례를 잘못 짚었습니다. rev 3은
     "구조는 열려 있고 오늘 사례는 없다"로 적었는데, 그 "없다"는 모든
     `pull_request` workflow의 job 조건식을 제가 읽어서 낸 결론이고 분석기가
     보증한 것이 아닙니다(정책 :206-207이 분석기는 조건식을 해석하지 않는다고
     적습니다). **세 번 틀린 항목을 세 번째로 믿을 근거가 약합니다.**
  2. **§16 재발 여부.** rev 3이 목록을 지운 범위가 맞는지 — 10장이 어디에
     선을 그었는지 적었고, 2·3장의 캐시 키·scope 표는 자격증명 도달 목록이
     아니라고 판단해 남겼습니다. 그 판단 자체를 봐 주십시오.

## 10. 이 감사 자신이 만든 공개 — §16 위반

**rev 1과 rev 2는 미해소 자격증명 도달 대상을 이름과 줄 번호로 담았고, 공개
저장소에 push됐습니다.** round 2의 독립 검토가 그것을 잡았습니다.

### 무엇이 공개됐는가

- 자격증명 도달 분석기가 `credential_job_restores_cache`로 지목한 **14건의
  workflow·job 이름**(4.1이 담았던 블록).
- 그중 실제 복원자 **11건의 job 이름 · 든 secret 이름 · 각 줄 번호**(4.3이
  담았던 표).
- 분석기가 자격증명 보유로 본 **22건 전수**와 같은 secret 매핑(검토 프롬프트
  문서 5·6절).

secret **값**은 공개되지 않았습니다. 공개된 것은 어느 job이 어느 secret을 들고
캐시를 복원하는지의 **목록**입니다.

### 어느 계약을 어겼는가

`docs/policy/engineering-agent.md` §16:

> **아직 해소되지 않은 자격증명 도달 경로의 구체 목록.** 이 저장소는 공개이므로,
> 고쳐지지 않은 경로를 이름과 줄 번호로 적는 것은 그 자체가 공개다. 목록은 비공개
> 설계서에 있고, 해소된 것만 이 문서와 저장소 기록에 남는다. §5는 **판정 규칙**을
> 담으며, 규칙은 공개해도 안전하다 — 안전하지 않은 것은 현재 실패하고 있는 대상의
> 이름이다.

"이 문서와 저장소 기록"이므로 `docs/policy/engineering-agent.md`만이 아니라
`.github/audits/` 같은 저장소 기록 전체가 대상입니다.
`tests/agentCredentialReachability.test.mjs`의 `POSTURE_DIGEST` 비교가 같은 이유로 posture를
12자 digest로만 고정하며, 그 주석이 §16을 인용합니다.

### 되돌릴 수 없습니다

AGENTS.md "검증 범위는 되돌릴 수 없는 것에 비례합니다"의 기준으로 **복구
불가**이고, 한 줄로 적을 수 있습니다 — **공개된 목록은 회수가 성립하지
않습니다.** 공개 저장소에 push된 commit 넷(`3882fdb6f`, `0588519fc`,
`5abcb4ef7`, `7598ff881`)이 PR #1964의 이력에 있고, 트리에서 지우는 것은
공개를 되돌리지 않습니다. clone·fork·GitHub의 unreachable object 보존이 남습니다.

이 감사의 다른 모든 항목은 "되돌릴 수 있음"으로 분류됐고, **실제로 복구 불가인
것은 이 감사 자신이 만든 이 하나뿐입니다.**

### 완화의 실제 크기

과소도 과대도 하지 않기 위해 양쪽을 적습니다.

- **줄여 주는 것:** 공개된 사실은 전부 `.github/workflows/`에서 유도됩니다.
  그 파일들은 이미 공개이고 `secrets.X` 참조와 `cache:` 줄을 그대로 담으며,
  `lib/agentCredentialReachability.ts`도 공개입니다. 같은 목록을 누구나
  `npm run report:engineering-agent-tiers`로 몇 분에 다시 만들 수 있습니다.
  한계 정보량은 작습니다.
- **줄여 주지 않는 것:** §16이 막는 것은 데이터의 기밀성이 아니라 **현재
  실패하고 있는 대상의 목록을 정리해 공개하는 일**입니다. 정책 저자가 그
  구분을 명시적으로 내렸습니다 — "규칙은 공개해도 안전하다 — 안전하지 않은
  것은 현재 실패하고 있는 대상의 이름이다." 유도 가능성은 그 판단을 무효로
  만들지 않습니다.

### 이 문서가 한 조치, 그리고 하지 않은 것

- 두 문서에서 목록을 **제거**했습니다(4.1·4.2·4.3, 검토 프롬프트 5~6절). 남긴
  것은 판정 규칙과 수치이며, §16이 안전하다고 적은 범위입니다.
- **선을 어디에 그었는가:** 2·3장의 캐시 키·restore-key·scope 표는 남겼습니다.
  그것은 자격증명 도달 목록이 아니라 캐시 메커니즘이고, §16은 전자를 다룹니다.
  6장의 "이미 맞게 되어 있는 것"도 남겼습니다 — §16이 "해소된 것만 남는다"고
  적은 그 범주입니다. **이 선이 맞는지는 다음 검토가 봐야 합니다**(9장).
- **제거는 삭제가 아닙니다.** 이력에서 지우는 것(history rewrite, PR 삭제,
  commit을 unreachable로 만들기)은 **하지 않았습니다.** 공개 저장소의 이력을
  고치는 것은 되돌릴 수 없고 다른 사람의 clone을 깨뜨리므로 소유자의
  결정입니다. 선택지와 비용은 운영자에게 보고했습니다.
- 비공개 설계서로 목록을 **옮기지 않았습니다.** 다른 저장소에 쓰는 것은 이
  과제의 범위 밖이고, 그 repo의 경로·구조를 공개 문서가 인용해서도 안 됩니다
  (AGENTS.md 9번). 옮길지는 소유자의 결정입니다.

### 소유자 결정 (2026-10-04)

**이력은 고치지 않고, 목록을 틀리게 만듭니다.**

확인된 사실부터. 게시한 commit 4건은 **develop 이력에만** 있습니다. main은 한
번도 담은 적이 없습니다 — main으로 간 경로가 7.9.1 선택 릴리스의 cherry-pick이
라 새 commit이 만들어졌기 때문입니다. 두 branch의 현재 트리는 모두 수정판이고,
남아 있는 `workflow # job` 행은 전부 3.3절(복원 → 실행 경로)이며 §16이 보호하는
목록이 아닙니다.

**하지 않는 것 — 이력 재작성.** develop은 열려 있는 모든 PR의 base이고,
force push는 merge train과 다른 세션의 브랜치 전부를 rebase로 끌고 갑니다. 그리고
force push만으로는 지워지지 않습니다 — 도달 불가가 된 객체도 GitHub가
garbage-collect할 때까지 옛 SHA로 제공되며, 그것을 강제하려면 별도 지원 요청이
필요합니다. 비용은 크고 효과는 부분적입니다.

**하는 것 — 공개된 매핑이 설명하는 상태를 없앱니다.** 그 목록의 값은 "이 job들이
이 secret을 들고 캐시를 복원한다"입니다. P1a가 이미 그 절반을 없앴고(그 scope에서
캐시 **쓰기**가 사라졌습니다), 나머지 절반을 이 변경이 없앱니다 — 자격증명을 가진
job 10건이 선언하던 npm 캐시를 거뒀습니다. 이제
`npm run check:credential-cache-separation`이 **0건**을 보고합니다.

**비용은 0으로 측정됐습니다.** 그 10건은 널리 읽히는 scope의 workflow에 있고,
그 scope에는 아무도 쓸 수 없으므로 복원은 이미 확정적 miss였습니다 —
`daily-security-audit` run `37162314395`(변경 후 schedule 실행)이
`npm cache is not found`와 `cache write denied: token has no writable scopes`를
함께 남겼습니다. 선언을 거두는 것은 동작을 바꾸지 않고 사실만 바꿉니다.

이것으로 공개가 회수되는 것은 **아닙니다.** 공개는 되돌릴 수 없고, 이 조치가
하는 일은 그 내용을 **낡은 것으로 만드는 것**입니다. 숨기기에 의존하지 않는
유일한 완화라는 점이 이 선택의 근거입니다.

### 왜 일어났는가

과제는 "`.github/audits/` 아래에 **path:line 증거**로 findings를 쓰라"고
지시했고, §16은 미해소 자격증명 도달 대상에 대해 그것을 금지합니다. 두 지시가
이 내용에 대해 충돌했고, **저는 그 충돌을 공개 전에 짚지 않았습니다.**
AGENTS.md는 그런 경우 "정확한 blocker를 한 줄로 적고" 승인된 범위를 계속하라고
적습니다 — 그렇게 했어야 했습니다. 축 1·2(캐시 키와 scope)는 §16과 무관하므로
그 부분은 path:line으로 쓰고, 축 3의 대상 이름만 비공개로 돌리는 것이 맞는
처리였습니다.
