# Tomverse Insight Remediation 실행 결과 (2026-07-29T21:41:24Z)

## 1. Executive summary와 현재 Go-Live 상태

**현재 판정: `Needs operational verification / Conditional No-Go` 유지.**

합의된 8개 finding 중 5개(R-02, R-04, R-06, R-07, R-08)를 증거와 함께 종결했고,
R-03은 작업 중 upstream에 merge된 PR #145가 이미 해결한 것을 확인해 그 구현을
채택했다.

R-05는 `/`를 0.2667 → 0.1095로 59% 개선했으나 완료 조건(median CLS ≤0.1)에 미달
하고, 사용자가 제시한 **조건부 수용의 배제 기준에도 걸린다** —— 320px·한국어·200%
에서 최대 0.2385까지 커지고, 한국어에서는 consent slot 외에 hero 본문이라는 추가
shift source가 나타난다(§4 R-05).

`QA-GATE-001`은 canonical CI에서 **실행했고 실패했다**(1509 passed / 10 failed /
908 skipped). 다만 `develop` 대조 실행이 **동일한 10건과 동일한 카운트를 재현**했으므로
이 실패는 전부 trunk의 기존 상태이고, **이번 remediation이 canonical 환경에 추가한
regression은 0건**이다. gate 종결은 합의 범위 밖의 신규 항목이 됐다(§6.4). R-01은 계정·승인·로그인·baseline까지 확보했으나 실행 단계에서
막혔고, 사람이 UI에서 수행하는 방식으로 진행하기로 결정됐다. **실제 Provider 호출
0회, credit 소비 0.**

production `Go`를 선언하지 않는다. R-01, R-05, `QA-GATE-001` 셋이 모두 열려 있다.

| ID | 최종 심각도 | 판정 | 근거 |
|---|---|---|---|
| `R-01` | P1 release blocker | **부분 검증 — 1/3 run 완료** | 사람이 staging UI에서 comparison 1회 + Review 1회 실행. expected/charged가 정책과 정확히 일치(3, 8), 3개 provider 실제 응답, 중복 차감·debt 없음. 남은 것: comparison run 2·3, 환불 경로 actual 검증, provider-start 내부 counter |
| `R-02` | P1 release gate | **성공** (staging 미배포) | source 수정 + 38개 unit test, stale failure → `unknown` |
| `R-03` | P1 release gate | **성공 (upstream PR #145)** | 3개 control 모두 실제 44×44, upstream이 해결·검증 |
| `R-04` | P2 release blocker (`B4`) | **성공** (staging 미배포) | 320/390px × 4 route × en/ko = 24/24 조합 overflow 0px |
| `R-05` | P2 | **부분 성공 — 완료 조건 미달, 조건부 수용도 불가** | `/` 0.2667 → 0.1095, `/pricing`·`/chat` 0. 그러나 320px·한국어·200%에서 최대 0.2385까지 커지고 한국어에서는 hero 본문이라는 추가 shift source가 나타나 배제 기준에 걸림 |
| `R-06` | P2 | **성공** | 3개 lifecycle 전이 coverage 추가, 11/11 통과 |
| `R-07` | P2 verification | **성공** | live `/api/build-info` ↔ UI field 일치 검증 추가 |
| `R-08` | P3 | **성공** (staging 미배포) | stall 25초 내 안내, security semantics 무변경 |
| `QA-GATE-001` | release gate | **실행됨 — 실패, 단 원인은 trunk** | canonical CI 실행 완료: 1509 passed / 10 failed. `develop` 대조 실행이 **동일한 10건·동일한 카운트**를 재현 → 전부 기존 실패이며 이번 변경의 regression은 **0건**. gate 종결은 trunk의 신규 항목 |

---

## 2. Baseline branch / HEAD / origin / remote / staging / deployment

### 2.1 작업 시작 시점 (프롬프트가 지정한 기준선)

| 항목 | 값 | 지정값과 일치 |
|---|---|---|
| branch | `claude/tomverse-insight-remediation-yvubkq` | — |
| local HEAD | `a1e13fec3f4f6706affc8f1d70f54e6df1f29d22` | ✅ |
| local `origin/develop` | `a1e13fec…` | ✅ |
| remote `develop` | `a1e13fec…` | ✅ |
| staging `/api/build-info` commitSha | `a1e13fec…` | ✅ |
| staging deploymentId | `642acaea-95e6-429d-8fe9-ac389b2ce79a` | ✅ |
| staging deployedAt | `2026-07-29T11:41:22.821Z` | ✅ |
| worktree | clean (modified/untracked 0건) | — |

기준선 5개 축이 모두 일치했으므로 지정된 SHA에서 작업을 시작했다.

### 2.2 작업 중 발생한 SHA 이동 — `[USER DECISION REQUIRED]` 처리 완료

작업 도중 remote `develop`과 staging이 이동했다.

| 항목 | 값 |
|---|---|
| 새 remote `develop` | `ea56a6bae5ff4631db3b48b58e9c8441395cfc98` |
| 새 staging commitSha | `ea56a6ba…` |
| 새 staging deploymentId | `fc2d3d66-23a3-4292-a05d-c4a95b6e0157` |
| 새 staging deployedAt | `2026-07-29T15:12:12.925Z` |
| 새 커밋 | `ea56a6b` — PR #145 "Fix confirmed UI blockers: touch targets, loading shell, attachment stages, contrast, pricing reflow" |

PR #145는 이번 작업이 건드리는 파일과 정확히 겹쳤다:
`components/chat/ProviderStatusBanner.tsx`, `components/marketing/MarketingChrome.tsx`,
`components/marketing/MarketingLanguageSwitcher.tsx`,
`components/marketing/PricingPageContent.tsx`, `tests/e2e/touch-targets.spec.ts`,
`tests/e2e/pricing-promotion-reflow.spec.ts`, `tests/e2e/provider-status.spec.ts`.

측정으로 확인한 겹침의 성격:

- **R-03은 #145가 이미 해결**했다. 3개 control 모두 pseudo-element가 아닌 실제
  44px box를 갖고, `tests/e2e/provider-status.spec.ts`와
  `tests/e2e/touch-targets.spec.ts`에 44×44 + hit-test + desktop 무회귀 test까지
  추가돼 있다. swap chip을 pseudo-element로 키우면 6px 간격 때문에 이웃 chip의
  tap을 훔친다는 근거까지 이번 작업의 판단과 동일했다.
- **R-04는 #145가 해결하지 않았고, 오히려 악화**시켰다. #145는 menu button과
  language switcher, header CTA를 rem 기반 `h-11`로 올렸는데, 200% root font에서
  `2.75rem`은 88px이 된다.

| 200% root font, `/pricing` document overflow | 320px | 390px |
|---|---:|---:|
| 감사 기준선 (`h-10` = 80×80) | 94px | 24px |
| upstream #145 geometry (`h-11` = 88×88) | **102px** | **32px** |
| 이 branch | **0px** | **0px** |

사용자 결정을 요청해 **"`ea56a6ba`로 rebase, R-03은 upstream 채택"**을 확인받고
그대로 실행했다.

### 2.3 최종 상태

| 항목 | 값 |
|---|---|
| branch | `claude/tomverse-insight-remediation-yvubkq` |
| base / HEAD | `ea56a6bae5ff4631db3b48b58e9c8441395cfc98` |
| commit | **없음** — 프롬프트 §7·§8이 commit·push·PR을 승인 범위에서 제외 |
| 변경 파일 | 18개 수정 + 1개 신규 (모두 uncommitted) |

---

## 3. 보존한 기존 modified/untracked 파일

작업 시작 시 worktree는 **완전히 clean**했다(`git status --short` 출력 없음).
따라서 보존해야 할 사용자 변경은 존재하지 않았고, 덮어쓴 것도 없다.

rebase는 `git stash push -u` → `git checkout -B <branch> origin/develop` →
`git stash pop`으로 수행했다. stash entry는 안전을 위해 남겨 두었고, 작업 전
전체 diff를 patch로 백업했다(§13).

---

## 4. Finding별 before/after, 근본 원인, 변경 파일

### R-01 — Actual Provider·AI Review·credit operational proof

- **판정**: `Not verified`
- **근본 원인**: 제품 결함이 아니라 검증 수단의 부재. Guest 계정은 AI Review가
  잠겨 있고, 실제 3-model comparison에는 인증 계정이 필요하다.
- **변경한 제품 코드**: 없음.
- **실제 Provider 호출 0회, credit 소비 0.**

**후속 실행 시도 (2026-07-29T22:00–23:15Z)**

사용자가 QA 계정 `qaverify@tomverse.app`을 제시하고, 실행 범위를
**3-model×3 + AI Review×1, 상한 40 credit, web search off**로 승인한 뒤
로그인 코드까지 전달했다. 인증과 baseline 확보까지 성공했고, 실제 호출
직전에 정지했다.

*예상 credit 산출 (`lib/models.ts`)*

공식 `ceil(usage class 가중치 × 입력 토큰 배수)`. 가중치 standard 1 /
advanced 4 / premium 8 / reasoning 12 / premium-reasoning 16 / research 20.
입력 배수 ≤16k 1× / >16k 1.5× / >50k 2× / >100k 3×. web search `always`는
모델당 +8(미실행 시 환불).

| 항목 | 구성 | credit |
|---|---|---:|
| 3-model comparison ×3 | `gpt-5-4-mini` + `claude-haiku-4-5` + `gemini-2-5-flash` (전부 standard, provider 3사) | 3/회 × 3 = 9 |
| AI Review ×1 | 기본 reviewer `mistral-medium-3-1` + `claude-sonnet-5` + `llama-3-3` (전부 advanced) | 12 |
| **예상 합계** | | **9–21** |
| 최악 (프롬프트 >16k 토큰) | | 36 |
| 승인된 hard cap | | **40** |

*확보한 것*

- **로그인 성공**: `POST /api/auth/callback/email-code` → 세션 확립.
  계정 plan **Pro**, 세션 만료 2026-08-05.
- **credit baseline** (`GET /api/user/usage`, 2026-07-29T23:10:21Z):
  `creditsMonth=23`, `planRemainingCredits=2977`(월 한도 3000),
  `purchasedRemainingCredits=0`, `creditDebt=0`, `maxModels=3`.
- **실행 경로 확정**: `POST /api/conversations` → `POST /api/chat/preflight`
  (expected credit) → `POST /api/chat` ×3 병렬(panel별 HTTP status·latency·
  trace·완료 여부) → `GET /api/user/usage`(charged) →
  `POST /api/conversations/{id}/comparison-reviews`. run별 before/after 기록.

*차단 요인 2 — 이 환경의 브라우저가 staging에 도달하지 못한다*

R-01은 본래 UI flow다. 그러나 Chromium이 `https://staging.tomverse.app`에
도달하지 못한다. 5개 구성 전부 `net::ERR_CONNECTION_RESET`: Playwright `proxy`
옵션, raw `--proxy-server`, 프록시 미사용, `--disable-http2`,
`--ignore-certificate-errors`.

- 같은 호스트에 **curl은 정상 도달**한다(`/api/build-info` 200).
- agent proxy `__agentproxy/status`는 이 호스트에 대한 **정책 거부를 기록하지
  않았다**(기록된 `connect_rejected`는 Chromium 자체 telemetry인
  `www.google.com`·`android.clients.google.com`뿐). egress 정책 문제가 아니다.
- `/root/.ccr/README.md`가 "report, do not work around"라고 명시하므로 로컬
  reverse-proxy 등으로 브라우저 트래픽을 우회시키는 workaround는 **시도하지
  않았다**. 그런 경로로 얻은 증거는 신뢰할 수 없다.

이 때문에 UI 관찰(사용자가 보는 3개 panel 완료)은 이 환경에서 불가능하고,
browserless API 경로만 남았다.

*확인한 사실 — Turnstile은 guest 전용이다*

- 로그인 코드 요청은 Turnstile 없이 성공한다
  (`POST /api/auth/email-login/request` → `{"ok":true}` 200). 코드 TTL 최대 10분
  (`EMAIL_LOGIN_CODE_TTL_MINUTES`).
- Turnstile은 guest flow에만 걸린다(`guest_turnstile_grant` cookie,
  `expectedAction = "guest_chat"`). **인증된 chat은 Turnstile을 요구하지 않는다.**
  감사 기준선의 `403 TURNSTILE_REQUIRED` 3건이 모두 guest 시도였던 이유가 이것이며,
  이는 Provider 장애의 증거가 아니었다는 기존 판단을 뒷받침한다.

*차단 요인 3 — 실행 단계가 권한 classifier에 거부됨*

실제 호출(`POST /api/conversations`, `/api/chat/preflight`, `/api/chat` ×3)이
Claude Code auto-mode 권한 classifier에 의해 차단되었다. credit을 소비하고 외부
Provider를 호출하는 되돌릴 수 없는 동작이므로 **정당한 게이트**이며, 지침에 따라
우회하지 않고 정지했다.

결과적으로 이 세션은 이 계정의 credit을 **한 번도 쓰지 않았다**
(`creditsMonth`는 baseline과 동일한 23).

- **다음 승인**: 아래 중 하나.
  1. staging에 대한 authenticated POST를 허용하는 Bash 권한 규칙 추가 —— 세션이
     2026-08-05까지 유효하므로 새 로그인 코드 없이 즉시 재개 가능하다.
  2. 사람이 staging UI에서 직접 수행하고 metadata를 공유 —— 브라우저 도달 문제까지
     함께 해소되므로 UI 충실도가 가장 높다.
- **별도 보고 대상**: 브라우저의 staging 도달 불가는 세션 환경/프록시 제약이므로
  관리자 또는 Anthropic 지원에 보고할 사안이다(README 지침).
- **위생**: 세션 cookie는 저장소가 아니라 세션 scratchpad에만 있고 컨테이너와 함께
  사라진다. 로그인 코드·cookie·token은 보고서와 artifact에 기록하지 않았다.

**실제 실행 결과 (사람이 staging UI에서 수행, 2026-07-30)**

(b) 경로로 사람이 staging UI에서 직접 실행하고 metadata를 공유했다. **이번
remediation 전체에서 유일한 actual Provider 트래픽이다.**

| 단계 | creditsMonth | planRemaining | purchased | debt | charged |
|---|---:|---:|---:|---:|---:|
| baseline | 23 | 2977 | 0 | 0 | — |
| 3-model comparison run 1 | 26 | 2974 | 0 | 0 | **3** |
| AI Review ×1 | 34 | 2966 | 0 | 0 | **8** |
| 누적 | | | | | **11** (상한 40) |

*comparison run 1 — 4축 대조*

| 축 | 관측값 | 정책값 | 판정 |
|---|---|---|---|
| expected | UI 추정 칩 **3**, `preflight` 응답 `requiredCredits: 3` (`modelCount: 3`, `comparisonId: 1785373195068`) | 3 (standard×3 = 1+1+1, 입력 배수 1×) | ✅ 두 독립 출처가 일치 |
| charged | `creditsMonth` +3, `planRemaining` −3 | 3 | ✅ 두 counter가 서로 일치 |
| refunded | 차감액 == 예약액, 환불 없음 | 실패·미소비분이 없으므로 환불이 발생할 이유가 없음 | ⚠️ 아래 참고 |
| provider-start | Gemini 200 OK 1.32s / Claude 200 OK 1.42s / GPT 200 OK 2.56s, **3개 panel 모두 답변 완료** | 3 | ✅ 관측 가능한 대체 지표 충족 |

*AI Review — 예측 정정*

charged **8**이다. 이 보고서의 앞선 예측은 12였고 **그것이 틀렸다**.
`reviewerIds()`가 반환하는 3개가 모두 실행된다고 읽었으나, 실제 코드는
`candidates[0]`과 그와 다른 **두 번째 후보 하나**만 실행하고 나머지는 fallback
후보다(`app/api/conversations/[conversationId]/comparison-reviews/route.ts:199–207`,
주석도 "roughly doubled"라고 명시). 두 reviewer 모두 `advanced`(가중치 4)이므로
정책값은 4+4 = **8**이고, **관측값과 정확히 일치한다.**

따라서 §4 R-01의 예상 credit 표에서 Review 항목 12는 8로, 합계 9–21은
**9–17**로 읽어야 한다.

*아직 닫히지 않은 것*

1. **comparison은 3회 중 1회만 실행됐다.** 완료 조건은 "3회 모두 3개 panel 완료"
   이므로 run 2·3이 남았다.
2. **환불 경로는 actual 트래픽으로 검증되지 않았다.** run 1은 3개 panel이 모두
   성공하고 차감액이 예약액과 같아 환불이 발생할 상황 자체가 아니었다. partial
   failure 시 미소비분 환불은 여전히 unit/server-contract 수준에서만 검증돼 있다.
3. **provider-start의 내부 counter는 사용자에게 노출되지 않는다.** 위 ✅는
   "3개 provider가 서로 다른 latency로 200을 반환하고 답변을 완료했다"는 대체
   관찰이다. 진짜 counter는 서버 로그/admin 경로에서 별도로 확인해야 한다.

*확인된 긍정 신호*

- `purchased`와 `debt`가 전 구간 0을 유지했다 —— 구매 credit 소진이나 debt
  누적 없이 plan credit만 정상적으로 사용됐다.
- 두 개의 독립 counter(`creditsMonth` 증가분, `planRemaining` 감소분)가 두 단계
  모두에서 일치했다 —— 중복 차감 징후 없음.
- 세 provider(OpenAI·Anthropic·Google)가 모두 실제로 응답했다. 감사 기준선의
  "성공한 실제 3-model comparison 0회"는 이로써 **1회**가 됐다.

### R-02 — Stale probe failure freshness ✅

- **판정**: 성공 (`Fixed locally, not verified on staging`)
- **사용자 결정**: `[R-02-FRESHNESS-WINDOW]` → **기존 `freshnessMinutes`와 동일
  window 사용** (권장안). 구현과 test에 반영했다.
- **근본 원인**: `lib/providerPublicStatusCore.ts`가 `lastProbeFailureAt`을 입력
  으로만 받고 판정에 쓰지 않았다. 기존 주석은 두 field가 원자적으로 기록되므로
  한쪽만 stale할 수 없다고 논증했는데, 이는 **상대적** staleness만 다룬다. probe
  가 멈추면 두 field가 **함께** 얼어붙어 오래된 count가 영구히 현재 Incident 근거로
  남는 **절대적** staleness는 처리되지 않았다. 결과적으로 success에는 30분 만료가
  있는데 failure에는 만료가 없는 비대칭이 생겼다.
- **before**: 202회 누적 실패 + 마지막 failure 약 38시간 경과 → `incident`
- **after**: 같은 입력 → `unknown` / `PROBE_FAILURE_STALE`, reason text가 202라는
  숫자를 현재 근거로 제시하지 않음
- **변경 파일**:
  - `lib/providerPublicStatusCore.ts` — `lastProbeFailureAt`을 destructure해
    `isProbeFailureFresh` gate 추가. probe escalation을 `!isFresh &&
    isProbeFailureFresh`로 제한. stale/invalid/future/null failure는 새 reason
    code `PROBE_FAILURE_STALE`로 정직하게 `unknown` 귀결. fresh success(real 또는
    probe)는 그대로 우선.
  - `lib/statusPageEvidence.ts` — `PROBE_FAILURE_STALE`을 probe 계열로 분류해
    "real request traffic"으로 잘못 표기되지 않게 했다.
  - `tests/providerPublicStatusCore.test.ts` — +11 test
  - `tests/statusPageEvidence.test.mjs` — 새 code를 synthetic 계열에 포함
- **의도적 test fixture 수정 3건**: 기존 test 3개가
  `consecutiveProbeFailures`만 주고 `lastProbeFailureAt`을 주지 않았다. 이는
  `recordProviderProbeFailure`가 두 field를 한 문장에서 원자적으로 쓰기 때문에
  **production에서 발생할 수 없는 조합**이다. fixture에 실제로 기록되는
  timestamp를 추가했다. assertion은 약화하지 않았고(전부 원래 기대값 유지),
  fixture가 현실을 반영하도록 강화한 것이다.
- **UI 영향**: `/status`는 reasonText를 그대로 렌더링하므로 분기 추가 불필요.
  public status와 admin diagnostics는 동일 core 결과를 계속 공유한다.

### R-03 — 핵심 recovery control 44×44 ✅ (upstream PR #145)

- **판정**: 성공 — upstream 구현 채택
- upstream이 `useIsMobileShell` 기반으로 refresh를 `h-11 w-11`, swap chip을
  `h-11 min-w-11 px-3`로 실제 박스화했고, marketing menu button과 language
  switcher를 44px로 올렸다. `data-testid`는 `provider-status-refresh` /
  `provider-status-swap` / `provider-status-fallback`.
- 이번 작업의 R-03 구현(`useHasCoarsePointer` + refresh는 pseudo-element,
  swap chip은 `min-h-11`)과 test는 **전량 폐기**했다. `tests/e2e/touch-targets.spec.ts`
  는 upstream 버전으로 되돌렸다.
- 단, upstream의 rem 기반 크기가 200% root font에서 88px로 커지는 문제는 R-04에서
  **44px 목표를 유지한 채** px 기반으로 전환해 해결했다(아래).

### R-04 — `/pricing` 200% overflow와 strict closure ✅

- **판정**: 성공 (`Fixed locally, not verified on staging`)
- **근본 원인**: header의 고정 정사각형·gutter·gap·logo가 모두 rem 기반이어서
  root font 32px에서 전부 2배가 되는데 viewport는 그대로다. `h-10 w-10` menu
  button은 80×80(upstream `h-11`은 88×88)이 되어 header를 화면 밖으로 밀었다.
- **기존 test가 놓친 이유**: `pricing-promotion-reflow.spec.ts`와
  `accessibility-core-tasks.spec.ts`의 reflow 검증은 **viewport를 축소**하는
  WCAG 1.4.10 축이다. 이번 결함은 viewport를 320/390px로 유지한 채 **root
  font-size를 32px로 키우는** WCAG 1.4.4 축이다. 기존 test는 교체하지 않고
  **별도 축을 신규 추가**했다.
- **before/after (동일 build에서 CSS로 pre-fix geometry를 재현해 대조)**:

| mode | viewport | route | document overflow | menu button |
|---|---:|---|---:|---|
| before | 320 | `/pricing` | **94px** | 80×80 @ right 414 |
| before | 390 | `/pricing` | **24px** | 80×80 @ right 414 |
| after | 320 | `/pricing` | **0px** | 44×44 @ right 288 |
| after | 390 | `/pricing` | **0px** | 44×44 @ right 358 |

  before 수치 94px/24px과 offender 위치(right 414, 80×80)는 감사 기준선 표와
  **정확히 일치**한다.

- **최종 검증**: 320/360/390px × `/`·`/pricing`·`/privacy`·`/chat?entry=guest-preview`
  × en/ko = **24/24 조합에서 document overflow 0px**.
- **변경 파일**: `components/marketing/MarketingChrome.tsx`
  - menu button `h-11 w-11` → `h-[44px] w-[44px]`, `data-testid` 추가
  - header CTA `h-11` → `h-[44px]`
  - header row gutter/gap `px-4 gap-3` → `px-[16px] gap-[12px]`
  - brand link gap `gap-2` → `gap-[8px]`, logo `h-9 w-9` → `h-[36px] w-[36px]`
  - 우측 control group gap `gap-2` → `gap-[8px]`
  - **44px 목표는 하나도 줄이지 않았다.** px로 고정한 것은 text가 아닌 chrome
    (gutter·gap·logo 타일)과 이미 44px인 hit target뿐이며, 내부 label·icon은
    사용자 font 크기에 따라 계속 확대된다.
- **채택하지 않은 대안과 이유**: `flex-wrap` + `min-h-16`도 200%를 0px로 만들지만
  일반 크기에서 회귀한다. 우측 group의 max-content(220px)가 320·360px에서 brand
  이후 남는 폭을 초과해 브라우저가 language switcher를 축소하는 대신 **줄바꿈**을
  택하고, header가 64px → **92px 2줄**이 된다. switcher가 축소를 흡수하는 것은
  FINAL-F004가 의도적으로 선택한 동작이므로 보존했다.
- **회귀 확인**: header row 높이가 320/360/390/430px 전부 **64px**로, rebase 이전
  baseline(`nowrap` 상태의 320→166, 360→206, 390→220, 430→220 우측 group 폭)과
  픽셀 단위로 동일하다.
- **contract 준수**: brand는 `Tomverse`/`Tomverse Insight` 완전 단어 유지(`T.`
  축약 없음), menu target 44×44 유지, consent/H1/CTA 교차 0.
- **신규 test**: `tests/e2e/root-font-resize-text.spec.ts` (14 test) — 4 route ×
  2 viewport overflow, brand 완전 단어·accessible name, 200% header 조작
  (click/keyboard), promotion·H1, consent 비교차, ko copy.

### R-05 — Mobile CLS ⚠️ 부분 성공

- **판정**: **완료 조건 미달**. `/`가 median 0.1095로 임계 0.1을 0.0095 초과.
- **측정 조건**: 360×640, cold context(매 run 새 context), DPR 2, `isMobile`,
  고정 network profile(latency 40ms / down 10Mbps / up 3Mbps), route별 5회,
  표준 `PerformanceObserver`의 `layout-shift` + `largest-contentful-paint`.
- **재현 결과 (감사 보고값과 형태가 다름)**:

| route | 감사 보고 median | 수정 전 median (본 실행) | 수정 후 median | max | median LCP |
|---|---:|---:|---:|---:|---:|
| `/` | 0.1454 | **0.2667** | **0.1095** | 0.1095 | 392ms |
| `/pricing` | 0.2352 | **0** | **0** | 0.1095 | 392ms |
| `/chat?entry=guest-preview` | 0.1403 | **0** | **0** | 0 | 896ms |

  `/pricing`과 `/chat`은 임계치 초과가 **재현되지 않았다**. `/pricing`은 이미
  credit pack skeleton이 geometry를 예약하고 있고, `/chat`은 layout이 서버에서
  consent mode를 받는다. CLS는 network 조건에 강하게 의존한다 —— throttling 없이
  측정하면 `/`조차 0이 나온다. 이 축은 그 자체로 `Environment dependent`다.

- **특정한 원인 1 (수정 완료)**: `/` hero의 `landing-hero-signup-note`와
  `landing-guest-note`가 `status === "unauthenticated"`로 gated돼 있었다.
  `useSession()`의 `status`는 `"loading"`으로 시작해 세션 probe가 끝나는 ~920ms에
  해결되고, 그 순간 두 문단이 삽입되며 hero 아래 전체가 78px 밀렸다.
  raw entry: `t=921ms value=0.2537`, source `section.relative.border-b…`
  `y,h: 93,547 → 171,469`.
  - **수정**: `status !== "authenticated"`로 변경 — `loading` 동안에도 렌더.
    marketing landing page의 기본 방문자는 로그아웃 상태이므로 정확한 추정이자
    안정적인 선택이다. **copy는 변경하지 않았다.**
  - **효과**: `/` 0.2667 → 0.1095 (**59% 감소**), 5회 모두 동일값으로 안정화.
  - 변경 파일: `components/marketing/LandingPageContent.tsx`

- **특정한 원인 2 (미수정 — 설계 결정 필요)**: 잔여 0.1095는 전량
  `MarketingConsentSlot`이다. raw entry: `t=877ms value=0.1095`, hero
  `y 65 → 143` (+78px). slot은 `empty:hidden`인 빈 div이고, consent notice는
  `resolvedPolicy`가 `fetch("/api/analytics/consent-policy")`로 도착한 뒤에야
  portal로 들어온다. header 자체는 이 수정 후 65px로 고정돼 있어 원인이 아니다
  (확인 완료).
  - `/chat`이 CLS 0인 이유가 바로 이것이다: `app/(site)/(application)/layout.tsx`는
    `initialConsentMode={analyticsConsentPolicy.mode}`를 SSR로 내려주므로 fetch
    자체가 발생하지 않는다.
  - marketing layout은 `export const dynamic = "force-static"`이라 같은 방법을
    쓰려면 `cf-ipcountry` header를 읽어야 하고, 그러면 **정적 marketing page가
    동적으로 바뀐다** —— TTFB·캐싱을 CLS와 맞바꾸는 구조 변경이며 이번 범위에서
    제외된 "대규모 구조 변경"에 해당한다.
  - 다른 선택지인 "slot 높이 예약"은 breakpoint별 magic number(측정값 74–94px,
    폭·locale 의존)를 요구하고, 첫 방문자에게 hero 위 빈 띠가 보이며,
    `empty:hidden`이 display:none이므로 pending 상태를 slot에 전달하는 추가 배선이
    필요하다. 그리고 notice를 static flow에 두는 것은 FINAL-F001이 H1/CTA overlay를
    없애기 위해 **의도적으로** 선택한 배치다.
  - → **`[USER DECISION REQUIRED]`**: (a) 0.1095 수용, (b) marketing page를
    동적으로 전환해 consent mode를 SSR로 해결, (c) slot 높이 예약.

- **가격·consent·composer 회귀**: 0. LCP는 악화되지 않았다(392–896ms).

**조건부 수용 심사 (2026-07-30T00:00–00:30Z)**

사용자가 R-05에 대해 **조건부 수용**을 제시했다: 원인이 consent slot 삽입으로
한정되고, median이 0.1095 수준에서 안정적이며, 심각한 최대값이나 추가 shift
source가 없으면 —— Pass가 아니라 **문서화된 잔여 위험 수용**으로 기록하고
Go-Live 예외를 승인한다. 단 다음 중 하나라도 해당하면 수용해서는 안 된다:
`CLS ≤0.1`이 예외 없는 계약인 경우 / 반복 측정에서 0.1095보다 높은 값이
반복되는 경우 / **320px·한국어·200%에서 더 큰 shift가 발생하는 경우** /
실제 RUM p75도 0.1을 초과하는 경우.

측정 조건은 §4 R-05와 동일(cold context, 40ms/10Mbps, `PerformanceObserver`),
cell당 5–10회. 모든 shift source를 기록해 "추가 source"가 top-N 절단에 숨지
않게 했다.

| cell (route `/`, 첫 방문) | median | max | 판정 |
|---|---:|---:|---|
| 360×640 en 100% (10회) | 0.1095 | 0.1095 | 안정 |
| 360×640 en 200% | 0.1095 | 0.1095 | 동일 |
| **320×568 en 100%** | **0.1466** | 0.1466 | **더 큼** |
| **320×568 en 200%** | **0.1466** | 0.1466 | **더 큼** |
| **320×568 ko 100%** | **0.1498** | **0.2385** | **더 큼** |
| **320×568 ko 200%** | **0.2282** | 0.2282 | **더 큼** |
| **360×640 ko 100%** | **0.116** | **0.2141** | **더 큼** |
| **360×640 ko 200%** | **0.116** | 0.2089 | **더 큼** |

| consent 상태 (360×640 en 100%) | median | 비고 |
|---|---:|---|
| 최초 방문 (unset) | 0.1095 | consent slot 삽입 |
| 동의 완료 직후 (just-accepted) | 0.1095 | 클릭 이후 추가 shift 없음(사용자 조작분은 `hadRecentInput`으로 제외) |
| **기존 동의 (accepted)** | **0** | 5/5 회 |
| **거부 (declined)** | **0** | 5/5 회 |

**판정: 조건부 수용 조건을 충족하지 못한다. (a)를 적용하지 않는다.**

배제 기준 두 개가 걸린다.

1. **320px·한국어·200%에서 더 큰 shift가 발생한다.** 최대 0.2385(320 ko)로,
   360 en의 0.1095의 두 배가 넘는다.
2. **0.1095보다 높은 값이 반복된다** —— 320/ko 계열 6개 cell 전부.

또한 전제 자체가 깨진다: **"원인이 consent slot 삽입으로 한정"이 한국어에서
성립하지 않는다.** 한국어 cell에서는 consent slot(`section.relative.border-b…`)
외에 다음 source들이 추가로 나타난다.

- `p[landing-hero-signup-note]`, `h1[landing-hero-title]`,
  `p[landing-brand-note]`, `p.mt-6.max-w-2xl`(hero 본문),
  `div.mt-8.flex.flex-col`(CTA 블록)
- header의 `div.flex.min-w-0.items-center`, `svg`,
  `a.font-bold.text-blue-700.underline`

즉 hero 본문 자체가 재배치된다. `Noto Sans KR`이 `preload: false`인 typography
contract와 맞물린 늦은 font swap이 유력한 설명이지만 **아직 확증하지 않았다**
(cold/warm 대조 미실시). 확증 전까지 추정으로만 기록한다.

*부수적으로 확인된 것*

- **`CLS ≤0.1`은 예외 없는 계약이 아니다.** `docs/ui-contracts/`의 3개 문서
  (mobile-chat-composer, comparison-action-rail, typography) 중 CLS를 release
  gate로 규정한 것은 없고, 감사 문서들은 "Core Web Vitals good 기준"으로 다룬다.
- **RUM p75는 이 환경에서 접근할 수 없어 미확인**이다.
- **기존 동의·거부 사용자는 이미 shift가 0이다.** 따라서 (c) 고정 높이 예약은
  반드시 pending 상태에만 적용해야 하며, 무조건 예약하면 현재 0인 사용자에게
  새 shift를 만든다.
- **(c)만으로는 부족하다.** 한국어·320px의 지배적 원인은 consent slot이 아니라
  hero 본문 재배치이므로, slot 높이 예약은 그 부분을 해결하지 못한다.

*사용자 결정으로 제외된 선택지*

- **(b) marketing route 동적 전환은 적용하지 않는다** —— 성능·캐시 영향에 비해
  변경 범위가 과도하다는 사용자 판단.
- **(c) 고정 높이 예약**은 최초 방문·동의 완료·기존 동의·거부 네 상태 모두에서
  삽입·제거 CLS가 발생하지 않음이 증명된 경우에만 후속 개선으로 적용한다.

- **남은 작업**: 한국어 hero shift의 근본 원인 확증, (c) 설계·4상태 검증,
  그리고 한국어·320px 축은 별도 작업으로 분리할지에 대한 결정.

### R-06 — Authenticated web-search state transitions ✅

- **판정**: 성공 — **production source 결함은 재현되지 않았고, coverage만 보강**했다.
- **source 재검토**: 원래의 stale closure는 이미 수정돼 있다
  (`ChatPageClient.tsx`의 dependency array가 `webSearchMode`를 포함). 기존 test도
  mode 토글 3종(on / back-off / rapid toggle)을 덮고 있었다.
- **비어 있던 축**: 사용자의 mode 선택과 submit **사이에 lifecycle event가 끼는**
  경우. 각각 submit handler를 재생성하므로 stale mode가 재유입될 수 있는 지점이다.
- **추가한 test 4건** (`tests/e2e/native-web-search.spec.ts`, authenticated Pro fixture):
  1. 모델 변경(panel `<select>` 교체) 직후 submit → `always` 유지
  2. 같은 전이에서 stale `always` 없음(`off` 유지)
  3. composer rerender(viewport 820↔1440 shell swap) 직후 submit → `always` 유지
  4. 대화 전환(New Chat) 직후 submit → 이전 대화의 `always`를 상속하지 않음
- 모든 test가 **UI가 보여주는 mode ↔ `/api/chat/preflight` body ↔ 모든
  `/api/chat` body**의 일치를 검증한다. request body는 mode 값만 읽고 민감정보는
  기록하지 않는다.
- **결과**: 11/11 통과. 경계 조건 flake 1건을 발견해 수정한 뒤(첫 대화의 body 2건이
  모두 도착하기 전 스냅샷을 떠 slice 경계가 흔들렸다) **3회 연속 full-spec 통과**로
  안정성을 확인했다.

### R-07 — Source grounding·Build information runtime evidence ✅

- **판정**: 성공 — 제품 코드 변경 없음.
- **Source grounding**: 재조사 결과 이미 충분히 덮여 있었다 ——
  `tests/e2e/source-grounding.spec.ts`가 hover 열기, keyboard focus 열기 + Escape
  닫기 + focus 유지 + Enter 재열기 + focus 이동 시 닫기, `aria-describedby`로
  screen reader 도달, **touch tap 열기/닫기**, 44×44 `::after` hit area, 320×640
  viewport 내 유지, "사실 정확도·출처 신뢰성·모델 확신을 뜻하지 않음" 문구를
  모두 검증한다. 재현 가능한 결함이 없어 제품 코드를 변경하지 않았다.
- **English UI 축은 구조적으로 불가**: 공유 fixture `mockAuthenticatedApi`의
  `/api/user/settings` 응답이 계정 언어를 `ko`로 고정하며, 이것이 `?lang=en`을
  덮어쓴다. spec 주석도 이 분업을 명시한다. 영어 copy는 대신
  `tests/sourceGroundingCopy.test.mjs`(6 test)가 두 locale 전체 어휘, 세 오해
  배제, "confidence" 미노출, 전 언어 fallback 해석을 검증한다. 시도했던 영어 UI
  test는 **되돌렸다** —— 통과시키려면 공유 fixture를 바꿔야 하고 이는 R-07 범위를
  넘는 blast radius다.
- **Build information**: 기존 UI test는 전부 endpoint를 mock한다(그래야
  deployedAt 결측·production/staging 분기를 결정적으로 재현할 수 있다). 검증되지
  않은 축은 **mock 없는 실제 배선** —— 이 배포의 `/api/build-info`가 말하는 값이
  실제로 panel에 렌더되는지였다.
- **추가한 test 1건** (`tests/e2e/build-info.spec.ts`): live endpoint를 호출해
  status 200 + `no-store`를 확인하고, `shortCommitSha`·`deploymentId`·`builtAt`·
  `deploymentStartedAt`·`deployedAt` 중 **endpoint가 실제로 반환한 non-null field
  전부**가 panel 텍스트에 존재하는지 검사한다. full SHA가 `title`로 도달 가능한지,
  그리고 `DATABASE_URL`/`NEXTAUTH_SECRET`/`sk-`/`postgres://`가 노출되지 않는지도
  함께 본다.
- **결과**: 72/72 통과 (source-grounding + build-info + 관련 spec).

### R-08 — Turnstile 장기 대기 피드백 ✅

- **판정**: 성공 (`Fixed locally, not verified on staging`)
- **근본 원인**: `before-interactive-callback`이 발생하면 앱의 20초 silent timer가
  **의도적으로** 해제된다(사람이 풀고 있는 challenge를 임의 취소하지 않기 위해).
  그 시점부터 Cloudflare의 terminal callback만이 결말을 정하는데, 도달 불가
  네트워크에서는 약 126초가 걸리고 그동안 UI가 아무 말도 하지 않았다.
- **수정**: `LONG_WAIT_NOTICE_MS = 25_000` 타이머 추가. **challenge를 취소하지도,
  token을 건드리지도, Cloudflare timeout을 단축하지도 않는다.** 대기를 읽을 수
  있게 만들고 원래 있던 취소 control을 가리키기만 한다.
- **변경 파일**:
  - `components/chat/GuestVerificationProvider.tsx` — `longWaitRequestId` state.
    boolean이 아니라 request id를 저장해, 교체된 challenge(shell swap, 두 번째
    action)가 이전 request의 안내를 상속할 수 없게 했다. phase가 `interactive`가
    아니면 파생값이 false가 되고, effect cleanup이 타이머를 걷는다.
  - `components/chat/GuestVerificationSheet.tsx` — `role="status"`(polite)로 안내.
    실패가 아니므로 `role="alert"`를 쓰지 않는다. failure가 있으면 표시하지 않는다.
  - `locales/{en,ko,zh,de,es,fr,pt}.ts` — `guestVerificationLongWait` 7개 locale
- **유지한 계약**: Turnstile token 검증·single-use·action binding·server-side
  verification 무변경, CSP 무완화, mobile composer/bottom-sheet contract 무변경,
  close·focus management 무변경.
- **추가한 test 4건** (`tests/e2e/guest-turnstile-verification.spec.ts`):
  1. stall 시 40초 예산 내 안내 표시 + `role="status"` + failure 미표시 +
     widget 생존 + **token 소비 0** + close 동작 + 재시도 성공
  2. 예산 전에 해결되면 안내가 **나타나지 않음**
  3. terminal failure가 안내를 failure copy로 교체
  4. 320px × ko × 200% text scale에서 안내 가독·overflow 0·close 44×44
- **결과**: 32/32 통과 (기존 28 + 신규 4).

---

## 5. Evidence 분리표

| Finding | Source | Automated test | Local browser | Read-only staging | Operational |
|---|---|---|---|---|---|
| R-01 | 해당 없음 | 해당 없음 | 해당 없음 | 공개 `/api/build-info`만 | **Not verified** (계정 없음) |
| R-02 | ✅ core gate 추가 | ✅ unit 38/38, provider-status E2E | ✅ fixture 판정 확인 | 현재 배포는 **수정 전** 동작 | probe/traffic timestamp 대조는 후속 |
| R-03 | ✅ upstream #145 | ✅ upstream test | ✅ 44×44 확인 | `ea56a6ba`에 포함·배포됨 | 해당 없음 |
| R-04 | ✅ px 기반 전환 | ✅ 신규 spec 14/14 | ✅ 24/24 조합 0px, before/after 대조 | 현재 배포는 **수정 전** 동작 | 해당 없음 |
| R-05 | ✅ hero 부분 수정 | 측정 harness (미커밋) | ✅ 5회×3 route raw entry | 현재 배포 baseline만 | RUM은 후속 |
| R-06 | 변경 없음 (결함 미재현) | ✅ 신규 4건, 11/11 ×3회 | ✅ request body 대조 | 해당 없음 | actual credit은 R-01 |
| R-07 | 변경 없음 (결함 미재현) | ✅ 신규 1건, 72/72 | ✅ live API↔UI 일치 | 해당 없음 | 해당 없음 |
| R-08 | ✅ 안내 타이머 추가 | ✅ 신규 4건, 32/32 | ✅ 320px·ko·200% | 현재 배포는 **수정 전** 동작 | 차단 network 실측은 후속 |
| QA-GATE-001 | 해당 없음 | 비-canonical 실행만 | 해당 없음 | 해당 없음 | **Not verified** |

**browser evidence 공통 metadata**: Chromium `/opt/pw-browsers/chromium-1194`
(비-canonical), viewport 320×568 / 360×640 / 390×844 / 430×932, DPR 2,
`isMobile: true`, `hasTouch: true`, locale `en-US`·`ko-KR`, timezone `UTC`,
color scheme 기본, cold cache(측정마다 새 context), 대상 SHA `ea56a6ba` + 미커밋
변경, 측정 시각 2026-07-29 18:00–21:40Z.

---

## 6. 테스트 command별 결과

`ea56a6ba` + 이번 변경 기준. 전부 최초 실행 결과다(명시된 경우 외 재실행 없음).

| command | 결과 | 비고 |
|---|---|---|
| `npm run typecheck` | ✅ pass | |
| `npm run lint` | ✅ pass | 최초 1건 실패 → 수정 후 pass (아래) |
| `npm run test:unit` | ✅ **552/552** | R-02 신규 11건 포함 |
| `npm run check:accent-tokens` | ✅ pass | 10 guarded files, 10 roles |
| `npm run check:encoding` | ✅ pass | mojibake 0 |
| `npm run security:regression` | ✅ pass | **113 checks** |
| `npm run build` | ✅ exit 0 | production build |
| E2E: R-02/03/04 관련 6 spec × desktop+mobile | ✅ **223 passed**, 0 failed | |
| E2E: R-06/07/08 관련 5 spec × desktop | ✅ **72 passed**, 0 failed | |
| E2E: 전체 suite × desktop+mobile (비-canonical) | ⚠️ 256/1618까지 실행 후 중단, 18 failed | §6.3 |
| **QA-GATE-001 canonical (CI, `ubuntu-24.04`, 고정 Chromium)** | ⚠️ **1509 passed / 10 failed / 908 skipped** (36.1분) | §6.4 |

### 6.1 최초 실패와 분류

| # | 대상 | 최초 결과 | 분류 | 처리 |
|---|---|---|---|---|
| 1 | `tests/providerPublicStatusCore.test.ts` 3건 | fail (`unknown` vs `degraded`/`incident`) | **Test regression** | fixture에 production이 실제로 함께 기록하는 `lastProbeFailureAt` 추가. assertion 불변 |
| 2 | `npm run test:unit` 78/78 fail (`ERR_MODULE_NOT_FOUND`) | fail | **Environment problem** | `node_modules` 미설치 → `npm ci` |
| 3 | `guest-turnstile-verification.spec.ts` 32/32 fail | fail | **Environment problem** | 재빌드 후 이전 build의 서버가 3100에 남아 재사용됨. 서버 재시작 후 32/32 pass |
| 4 | `npm run lint` 1건 (`react-hooks/set-state-in-effect`) | fail | **Product regression (본 작업)** | effect 본문의 `setState` 제거, request id 파생으로 재작성 |
| 5 | `native-web-search.spec.ts` 대화 전환 test | fail (`toHaveLength 0` vs 1) | **New flake (본 작업)** | slice 경계를 `toBe(2)`로 결정화. **3회 연속 full-spec pass**로 확인 |
| 6 | `mobile-composer-contract.spec.ts` 2건 `toHaveScreenshot` | fail | **Environment problem** | 아래 §6.2 |
| 7 | 전체 suite 18건 (16 visual `-ko` + 2 비-visual) | fail | **Environment problem** | 아래 §6.3. clean upstream에서도 재현 |

`git checkout`으로 되돌린 것은 R-03 중복 test(`touch-targets.spec.ts` → upstream)와
구조적으로 불가한 영어 source-grounding test 2건뿐이며, 둘 다 판단 근거를 위에
남겼다. 통과를 위해 약화·삭제한 assertion은 없다.

### 6.2 visual snapshot 2건 — snapshot 갱신하지 않음

`mobile-composer-contract.spec.ts`의 `toHaveScreenshot` 2건이 실패한다.

- diff: **906 pixels (ratio 0.02–0.03)**
- `docs/qa/canonical-visual-baseline.md`가 이미 기록한 값과 **정확히 동일**하다:
  "a run on Chromium 141 against goldens recorded on Chromium 151 reported 906
  differing pixels (2-3% of the image) spread across the glyph edges of every
  text run, with no element moved and no layout changed."
- 이 실행의 Chromium은 `1194`이고 저장소가 고정한 것은 `1234`
  (Chrome for Testing 151.0.7922.34)다. 같은 문서가 명시한다: "A run using the
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE` escape hatch is **not** canonical. Its
  screenshots must be reported as `Not verified`, never as a pass and never as a
  reason to re-record."
- 이번 변경은 composer를 건드리지 않았다.
- → **snapshot을 갱신하지 않았다.** `Not verified`로 보고한다.

### 6.4 QA-GATE-001 — canonical 실행 결과 (2026-07-29T23:19–23:57Z)

사용자 요청으로 canonical 환경에서 gate를 실행했다. 이 컨테이너에서는 고정
Chromium 설치가 프록시 403으로 막히지만, CI에서는 정상 완료된다.

| 항목 | 값 |
|---|---|
| workflow | `.github/workflows/e2e.yml` "Main Chromium Regression" (`workflow_dispatch`) |
| run | `30499132860`, run #44 |
| ref / head SHA | `claude/tomverse-insight-remediation-yvubkq` / `199baa65` |
| runner | `ubuntu-24.04` (canonical) |
| browser | `npx playwright install chromium` = 저장소 고정 build **설치 성공** |
| 명령 | `npm run test:e2e:chromium` (desktop-chromium + desktop-compact + mobile-chromium) |
| 결과 | **1509 passed / 10 failed / 908 skipped**, 36.1분 |
| artifact | `main-chromium-test-results-30499132860` (306 files, 75.7MB, 14일 보존) |

**범위의 한계**: 이 workflow는 `test:e2e:chromium`을 실행하므로 WebKit·Windows
project는 포함되지 않는다. 다만 `docs/qa/canonical-visual-baseline.md`가
"golden을 판정할 수 있는 유일한 조합"으로 지정한 `desktop-chromium`이 포함되므로,
**visual baseline 판정에는 이것이 정확한 gate**다.

**실패 10건**

| # | 종류 | 대상 |
|---|---|---|
| 1–4 | visual | `chat-state-visual-regression.spec.ts:141` — `chat-loading-{desktop,mobile}-{light,dark}-ko` |
| 5–7 | visual | 같은 spec — `chat-attachment-{uploading,processing,error}-desktop-light-ko` |
| 8 | visual | 같은 spec — `chat-attachment-error-mobile-dark-ko` |
| 9–10 | 기능 | `upgrade-discovery.spec.ts:428 › panel-only send waits for a changed model selection to persist` (desktop-chromium, desktop-compact). `messageSavedAfterPatch`가 retry2까지 false |

visual 8건은 **전부 `-ko`**이고 `-en`은 하나도 실패하지 않았다.

**§6.2·§6.3의 분류를 정정한다.** 로컬에서 `-ko` visual 실패를 "비-canonical
Chromium `1194` vs 고정 `1234`의 glyph rasterization 차이"로 분류했는데,
**canonical 환경에서도 동일하게 실패**했으므로 그 설명은 이 8건에 대해 성립하지
않는다. §6.2의 `mobile-composer-contract` 2건(906px, 문서화된 수치와 정확히 일치)은
여전히 rasterization 차이로 보지만, `chat-state-visual-regression`의 `-ko` 8건은
**별개의 미해결 사안**이다.

가능한 원인 셋 중 하나다 — golden이 base 대비 stale / 이번 변경이 한국어 렌더링에
영향 / 이 golden이 이 workflow로 검증된 적이 없음. 세 번째가 유력한 정황이 있다:
#145는 `develop`에 merge됐고 이 workflow는 `main` push와 수동 실행만 트리거하며,
`pr-fast-gate.yml`은 `@smoke` ~20개만 돌린다. 즉 #145가 추가한 이 golden 세트가
canonical gate를 한 번도 통과한 적이 없을 수 있다.

같은 workflow의 **run #43(`8386443a`, #145 이전)은 success**였다는 점도 이 방향을
뒷받침한다.

**대조 실행으로 귀속이 확정됐다.**

`develop`(`cb57c8d7`, 이번 변경이 전혀 포함되지 않은 trunk)에서 **동일한
workflow·동일한 명령**으로 실행한 결과(run `30501422995`, run #45):

| | 이 branch (`199baa65`) | 대조 `develop` (`cb57c8d7`) |
|---|---|---|
| passed | **1509** | **1509** |
| failed | **10** | **10** |
| skipped | **908** | **908** |
| 소요 | 36.1분 | 30.9분 |

그리고 실패한 10건의 목록이 **완전히 일치한다** —— `chat-loading-*-ko` 4건,
`chat-attachment-{uploading,processing,error}-desktop-light-ko` 3건,
`chat-attachment-error-mobile-dark-ko` 1건,
`upgrade-discovery.spec.ts:428`(desktop-chromium + desktop-compact) 2건.
`upgrade-discovery` 실패는 양쪽 모두 retry2까지 동일하게
`messageSavedAfterPatch`가 false다.

**결론: 10건 전부 trunk의 기존 실패이며 이번 변경과 무관하다.** 이번 branch가
canonical 환경에 추가한 regression은 **0건**이고, passed 수도 trunk와 정확히
동일하다.

**따라서 `QA-GATE-001`은 여전히 닫히지 않았지만, 그 원인은 이번 remediation이
아니다.** gate를 닫으려면 다음 10건을 trunk에서 해결해야 하며, 이는 합의된
R-01–R-08 범위 밖의 **신규 항목**이다.

1. `chat-state-visual-regression.spec.ts`의 `-ko` golden 8건 —— #145가 추가한
   golden 세트가 canonical gate를 통과한 적이 없는 것으로 보인다(§위 정황).
   `-en`은 전부 통과하므로 한국어 렌더링 경로에 국한된 문제다.
2. `upgrade-discovery.spec.ts:428` 2건 —— `messageSavedAfterPatch`가 끝까지
   false. retry 3회 모두 실패하므로 flake가 아니라 재현되는 실패다.

**snapshot은 갱신하지 않았다** —— canonical 재현과 승인 없이 golden을 건드리지
않는다는 정책이고, 애초에 이 golden들은 이번 변경 소관이 아니다.

---

### 6.3 비-canonical 전체 suite 실행 — 18 failed의 내역과 판별

전체 suite(1618 test)를 `desktop-chromium` + `mobile-chromium`으로 실행해
**256/1618 지점까지 진행한 뒤 중단**했다(canonical 실행이 아니라 판정 가치가
제한적이고, 남은 시간을 아래 판별에 쓰는 편이 유용했다). 그 시점 실패 18건:

**(a) 16건 — `chat-state-visual-regression.spec.ts`의 `chat-*-ko` snapshot**

`chat-loading` / `chat-streaming` / `chat-success` / `chat-partial-failure` ×
desktop·mobile × light·dark, **전부 `-ko` variant만**. `-en` variant는 하나도
실패하지 않았다. 이 spec은 upstream #145가 새로 추가한 것이다(+302행 + PNG).

`-ko`만 실패하는 것은 canonical baseline 문서가 설명하는 구조와 정확히 맞는다:
locale이 `:lang()`으로 font stack을 고르므로(`Noto Sans KR`) 한국어 subtree는
다른 glyph를 rasterize하고, Chromium `1194`와 golden을 기록한 `1234` 사이의
glyph-edge 차이가 여기서 드러난다. §6.2의 906px 사례와 같은 계열이다.
→ **Environment problem**. snapshot 갱신하지 않음. `Not verified`.

**(b) 2건 — 비-visual: `account-flow` "authenticated user opens settings @smoke",
`model-picker` "guest model selector opens a swap dialog once the 3-model cap is
reached @smoke"**

두 건 모두 `chat-input`을 찾지 못하는 형태였다. 판별 실험:

| # | tree | 실행 | 결과 |
|---|---|---|---|
| 1 | 이 branch | 해당 3 spec 단독 (desktop) | ✅ **29/29 passed** — 두 test 모두 통과 |
| 2 | 이 branch | 8 spec × desktop+mobile × `--repeat-each=2` | ⚠️ 249 passed, **1 failed** — 단, 실패한 것은 `attachment-flow`의 다른 test |
| 3 | clean upstream `ea56a6ba` | 실험 2와 **완전히 동일한 command** | ✅ 250 passed, 0 failed |
| 4 | clean upstream `ea56a6ba` | 실험 2와 **완전히 동일한 command** (재실행) | ⚠️ 249 passed, **1 failed** — `account-flow`의 또 다른 test |

**결론: Environment problem.** 이 컨테이너는 4-worker 병렬 부하에서 약 250건당
1건이 실패하며, **실패하는 test의 정체가 매 실행마다 바뀐다.** 결정적으로 실험 4가
보여주듯 **내 변경이 전혀 없는 clean upstream에서도 같은 비율로 발생**한다.
따라서 이 2건은 이번 변경이 만든 것이 아니다.

**남겨두는 한계 (중요):** 프롬프트는 "단독 재실행 1회 통과만으로 flake를 종결하지
말고, 원 full-spec 순서에서 최소 20회 반복하거나 원인을 제거하라"고 요구한다.
그 20회 반복은 **수행하지 않았다** —— 1회가 7.5분이므로 20회는 2.5시간이고,
전체 suite 순서로는 훨씬 더 길다. 따라서 이 2건은 "clean upstream에서도 재현되는
환경성 불안정"으로 판별했을 뿐, **개별 test의 flake로 종결(closed)하지 않았다.**
근본 원인 제거(worker 수 축소, 또는 CI canonical runner에서의 확인)는 후속이다.

---

## 7. 320 / 390 / 200% / keyboard / Korean IME / coarse-pointer 결과

| 축 | 결과 |
|---|---|
| 320px | ✅ 4 route document overflow 0 (일반·200% 모두), Turnstile sheet·close 44×44 |
| 360px | ✅ overflow 0, header row 64px, CLS 측정 기준 폭 |
| 390px | ✅ overflow 0, header row 64px |
| 430px | ✅ header row 64px |
| 200% root font (WCAG 1.4.4) | ✅ **신규 축**. 24/24 조합 overflow 0. header 조작 가능(click·Enter), brand 완전 단어, consent 비교차 |
| 실제 browser zoom 200% | ⛔ **Not verified** — Playwright/CDP로 진짜 브라우저 zoom을 설정할 수 없다. root font-size 32px 축으로 대체했고 이 한계를 명시한다 |
| keyboard-only | ✅ menu button focus+Enter로 열림, Turnstile close focus·Escape·focus 복귀, banner refresh Enter / swap Space (upstream test) |
| Korean IME | ✅ 기존 `guest-turnstile-verification.spec.ts` synthetic IME test 통과. ko copy 320px·200% 검증 추가 |
| coarse pointer | ✅ upstream `mobile-*` project test가 44×44 bounding box + center hit-test + overlap 0 검증 |

---

## 8. Performance 5회 raw summary와 측정 한계

§4의 R-05 표가 route별 5회 값·median·max·LCP·top shifter를 담고 있다.

**raw `layout-shift` entry (수정 후 `/`, 대표 1회)**

```
t=877ms value=0.1095
    source: section.relative.border-b.border-zinc-200
    y,h: 65,575 -> 143,497
```

**측정 한계 — 결과 해석 시 반드시 함께 읽어야 한다**

1. **network 의존성이 지배적이다.** throttling 없이 측정하면 `/`조차 CLS 0이
   나온다. 표의 모든 값은 latency 40ms / 10Mbps 프로필에서만 유효하다.
2. **감사 보고값과 형태가 다르다.** `/pricing` 0.2352와 `/chat` 0.1403은 재현되지
   않았다(둘 다 median 0). 이 축은 `Environment dependent`로 취급해야 한다.
3. **비-canonical Chromium 1194**에서 측정했다.
4. **synthetic 단일 머신 측정**이며 실제 사용자 분포(RUM)가 아니다. 실기기·실
   네트워크 확인은 별도 후속이다.
5. 측정 harness는 scratchpad에만 존재하며 **저장소에 커밋하지 않았다**(§13).

---

## 9. Actual Provider 호출 승인 여부·실행 횟수·credit 대조

| 항목 | 값 |
|---|---|
| 사용자 승인 | **받음** — 3-model×3 + Review×1, 상한 40 credit, web search off. 계정과 로그인 코드까지 제공됨 |
| 인증 | **성공** — `qaverify@tomverse.app`, plan Pro, 세션 만료 2026-08-05 |
| credit baseline | `creditsMonth=23`, `planRemaining=2977`/3000, purchased 0, debt 0 |
| 실제 실행한 comparison | **0회** |
| 실제 실행한 AI Review | **0회** |
| 소비한 credit | **0** |
| Provider 호출 | **0** |
| 차단 사유 | (1) 이 환경의 Chromium이 staging에 도달 불가 → UI 관찰 불가 (2) browserless 실행 POST가 권한 classifier에 거부 |
| baseline 대비 변화 | **없음** — `creditsMonth`가 23으로 동일 |

승인은 존재하지만 실행 수단이 없었다. Turnstile CDN 도달은 확인했으므로(302),
남은 유일한 차단 요인은 계정이다. mock/unit/server-contract 결과를 actual
evidence로 표기하지 않았다. secret·token·cookie·prompt/answer는 보고서와
artifact에 기록하지 않았다.

---

## 10. 변경하지 않은 scope와 이유

| 대상 | 이유 |
|---|---|
| `STG-F008` 추천 5개 / 전체 28개 | 프롬프트 §7이 제외. 현재 수 승인 여부가 선행 사용자 결정 |
| `STG-F009` 가시 대표 모델명 | §7 제외. accessible name만으로 승인할지 디자인 결정 필요 |
| console `NaN` | raw evidence 없음. 추측성 수정 금지 |
| CSP 완화 | 금지. axe 통과를 위해 security header를 건드리지 않았다 |
| `FINAL-F005/F006`, `STG-F001/F003/F006` | 해결 상태 보존. 재설계하지 않았고 regression만 확인 |
| Railway 설정·환경변수·cron·alert | 승인 범위 밖. read-only 확인만 |
| 배포·재배포·service restart | 승인 범위 밖 |
| DB migration·데이터 삭제·account·payment | 승인 범위 밖 |
| commit·push·PR | §7·§8이 제외. 변경은 uncommitted로 남겼다 |
| snapshot/golden 갱신 | §6.2의 근거로 금지. 승인 요청 대상 |
| `MarketingLanguageSwitcher` 의 rem `h-11` | R-04를 위해 px화가 바람직하나, 200% overflow가 이미 0이므로 불필요한 변경을 피했다. 필요해지면 같은 근거로 전환 가능 |
| `ChatInput.tsx` (upstream이 304행 변경) | 이번 finding과 무관. 건드리지 않았다 |
| 실기기 iOS/Android IME·VoiceOver/TalkBack | 별도 후속 |
| Perplexity probe 운영 원인 조사 | 별도 후속. R-02는 source 판정만 고쳤고 probe가 왜 멈췄는지는 운영 조사 대상 |

---

## 11. `Not verified` 항목과 필요한 다음 승인

| 항목 | 상태 | 필요한 다음 조치 |
|---|---|---|
| **R-01 actual proof** | Not verified | 인증·baseline은 확보(Pro, 2977 credit). 남은 차단 요인 둘: 이 환경의 Chromium이 staging에 도달 못함(`ERR_CONNECTION_RESET`, curl은 정상), 실행 POST가 권한 classifier에 거부됨. Bash 권한 규칙 추가 또는 사람의 UI 실행이 필요. credit 소비 0 |
| **QA-GATE-001 canonical 전체 E2E** | Not verified | canonical runner. 이 환경에서는 `cdn.playwright.dev`가 proxy에서 403(`host not permitted`)이라 고정 Chromium `1234`를 설치할 수 없고, 제공된 build는 `1194`다. OS는 canonical `ubuntu-24.04`로 일치한다. CI의 `ubuntu-24.04` job에서 실행해야 51개 visual diff와 axe/CSP 환경 차이를 종결할 수 있다 |
| **visual snapshot 2건** | Not verified | canonical 환경 재현. diff는 906px 문서화된 rasterization 차이. 갱신 승인 요청 대상이며 임의 갱신하지 않았다 |
| **R-02/R-04/R-05/R-08 staging 검증** | Fixed locally, not verified on staging | 배포 승인. 현재 staging(`ea56a6ba`)에는 이 수정들이 없다 |
| **R-05 잔여 CLS 0.1095** | 완료 조건 미달 | 설계 결정: (a) 수용, (b) marketing page 동적 전환, (c) consent slot 높이 예약 |
| **실제 browser zoom 200%** | Not verified | 진짜 zoom을 제어할 수 있는 실기기/도구 |
| **R-07 staging 인증 UI** | 해당 없음으로 처리 | local authenticated fixture로 충족. staging 계정 접근은 요청하지 않았다 |
| **`STG-F008` / `STG-F009`** | 미착수 | 사용자 결정 |

---

## 12. 잔여 위험과 Go-Live 재판정 조건

### 잔여 위험

1. **R-01이 비어 있다 (P1).** 성공한 실제 3-model comparison이 여전히 0회다.
   Provider 정상성·AI Review·ledger의 expected/charged/refunded/provider-start
   4축 일치가 **한 번도 관측되지 않았다.** 이것이 가장 큰 미지의 위험이다.
2. **canonical gate가 닫히지 않았다.** 51개 visual failure와 axe/CSP 환경 차이가
   미해결로 남아 있다. 이 실행의 906px 근거와 `-ko` 전용 실패 패턴은 그중 일부를
   설명하지만 종결하지는 못한다. 더구나 upstream #145가 `chat-state-visual-regression`
   golden 세트를 새로 추가했으므로 canonical 환경에서 판정해야 할 snapshot이
   늘었다.
7. **E2E 실행 환경 자체가 불안정하다.** 4-worker 병렬에서 250건당 약 1건이
   실패하며 실패 대상이 매번 바뀐다. clean upstream에서도 동일하게 재현되므로
   제품 결함은 아니지만, 이 상태로는 전체 suite의 green/red를 신뢰하기 어렵다.
   CI canonical runner에서의 확인이 필요하다.
3. **R-05 잔여 CLS**가 임계를 근소하게 초과하며, 정적 marketing page 구조와
   FINAL-F001 배치 결정이 얽혀 있다.
4. **R-04는 여유 폭이 크지 않다.** 200%에서 overflow 0을 달성했지만 header는
   빈틈이 넉넉하지 않다. locale 추가나 promotion 문구 변경이 다시 넘칠 수 있다.
   신규 spec이 320/390px × 4 route × en/ko를 지키므로 조용히 재발하지는 않는다.
5. **`ea56a6ba`와 이 branch의 변경이 아직 합쳐지지 않았다.** commit이 승인 범위
   밖이므로 uncommitted 상태다. rebase는 완료했고 build·lint·typecheck·unit·
   security는 새 base에서 전부 통과한다.
6. **R-02는 source 판정만 고쳤다.** Perplexity probe가 38시간 멈춰 있었던 운영
   원인은 그대로다. 이제 stale count가 거짓 Incident를 만들지는 않지만, probe가
   멈추면 `unknown`이 되므로 **scheduler 자체의 감시**가 여전히 필요하다.

### Go-Live 재판정 조건

다음이 모두 충족되면 `Go` 판정을 재검토할 수 있다.

1. R-01: 3-model comparison 3회 + AI Review 1회가 모두 완료되고, 각 run의
   expected/charged/refunded/provider-start가 정책과 정확히 일치
2. QA-GATE-001: canonical에서 unexpected failure 0. 현재 10건은 **trunk의 기존
   실패**로 확정됐으므로(이번 변경 regression 0건) trunk 쪽 신규 작업으로 처리해야
   한다 —— `-ko` golden 8건과 `upgrade-discovery.spec.ts:428` 2건
3. R-02·R-04·R-08이 staging에 배포되고 배포본에서 재확인
4. R-05: `/` median CLS ≤0.1 달성 —— 단 360px/en뿐 아니라 **320px과 한국어에서도**.
   조건부 수용은 배제 기준에 걸려 현재 선택지가 아니다(§4 R-05)
5. `STG-F008`·`STG-F009` 사용자 결정 종결
6. visual snapshot 2건이 canonical 환경에서 pass 또는 정당한 근거로 갱신 승인

이 중 1·2가 닫히기 전에는 production `Go`를 선언하지 않는다.

---

## 13. Artifact 목록과 runner metadata

### 13.1 저장소에 남는 변경 (uncommitted, 19개)

**제품 코드 (6)**

| 파일 | Finding | 증감 |
|---|---|---|
| `lib/providerPublicStatusCore.ts` | R-02 | +58 −? |
| `lib/statusPageEvidence.ts` | R-02 | +3 −1 |
| `components/marketing/MarketingChrome.tsx` | R-04 | +45 −? |
| `components/marketing/LandingPageContent.tsx` | R-05 | +17 −? |
| `components/chat/GuestVerificationProvider.tsx` | R-08 | +51 −? |
| `components/chat/GuestVerificationSheet.tsx` | R-08 | +16 |

**locale (7)** — `locales/{en,ko,zh,de,es,fr,pt}.ts`, 각 +1 (`guestVerificationLongWait`)

**test (6)**

| 파일 | Finding | 증감 |
|---|---|---|
| `tests/providerPublicStatusCore.test.ts` | R-02 | +156 |
| `tests/statusPageEvidence.test.mjs` | R-02 | +6 −2 |
| `tests/e2e/root-font-resize-text.spec.ts` | R-04 | **신규** 14 test |
| `tests/e2e/native-web-search.spec.ts` | R-06 | +141 |
| `tests/e2e/build-info.spec.ts` | R-07 | +60 |
| `tests/e2e/guest-turnstile-verification.spec.ts` | R-08 | +144 |

합계: `18 files changed, 681 insertions(+), 23 deletions(-)` + 신규 spec 1개.

### 13.2 휘발성 artifact — 보존되지 않음

다음은 세션 scratchpad에만 존재하며 **팀이 접근할 수 없고 컨테이너 종료 시
사라진다.** 증거가 보존된 것처럼 취급하지 말 것. SHA-256 manifest를 만들지 않은
이유도 이것이다 —— 해시가 가리킬 대상이 남지 않는다. 재현이 필요하면 §4·§8의
수치와 아래 방법으로 다시 측정해야 한다.

| 용도 | 재현 방법 |
|---|---|
| 200% overflow 측정 | viewport 고정 + `html{font-size:32px}` 주입 후 `documentElement.scrollWidth - clientWidth` |
| before/after 대조 | 동일 build에 pre-fix geometry를 CSS로 재현(`h-10 w-10` / rem chrome 복원) |
| CLS 측정 | 360×640 cold context, CDP `Network.emulateNetworkConditions`(40ms/10Mbps/3Mbps), `PerformanceObserver` `layout-shift` buffered, route별 5회 |
| header 높이 회귀 | 320/360/390/430px에서 `header > div` bounding box |
| 작업 patch 백업 | rebase 전 전체 diff (stash entry도 유지 중) |

R-04·R-05 측정 harness는 저장소에 커밋하지 않았다. 영구화가 필요하면 별도 결정
사항이다(R-04의 회귀 축은 `tests/e2e/root-font-resize-text.spec.ts`로 이미 영구화됐다).

### 13.3 Runner metadata

| 항목 | 값 |
|---|---|
| OS | Ubuntu 24.04.4 LTS (canonical image와 일치) |
| Node | v22.22.2 |
| npm | 10.9.7 |
| Next.js | 16.2.12 |
| Prisma Client | 7.9.0 |
| `@playwright/test` | 1.62.0 (lockfile 고정) |
| Chromium (사용) | `/opt/pw-browsers/chromium-1194` — **비-canonical** |
| Chromium (저장소 고정) | `1234` / Chrome for Testing 151.0.7922.34 — **설치 불가** (`cdn.playwright.dev` 403 `host not permitted`) |
| Playwright projects | `desktop-chromium`, `mobile-chromium` |
| locale / timezone | `en-US`·`ko-KR` / `UTC` |
| 대상 SHA | `ea56a6bae5ff4631db3b48b58e9c8441395cfc98` + 미커밋 변경 |
| 실행 시각 (UTC) | 2026-07-29 15:30 – 21:41 |

민감정보(secret·token·cookie·session identifier·credential·사용자 prompt/answer)는
보고서와 artifact에 기록하지 않았다.
