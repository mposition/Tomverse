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
| `R-01` | P1 release blocker | **부분 검증 — 3/3 run 완료, 2축 미검증** | 사람이 staging UI에서 comparison 3회 + Review 3회 실행. expected/charged가 6/6 단계에서 정책과 정확히 일치(3, 8), 9개 provider 호출 전부 200 OK·panel 완료, 중복 차감·debt 없음, 누적 33 credit(상한 40 이내). **미검증**: 환불·partial failure(실패가 발생하지 않아 경로가 실행되지 않음), provider-start 내부 counter(사용자 노출 없음) |
| `R-02` | P1 release gate | **성공** (staging 미배포) | source 수정 + 38개 unit test, stale failure → `unknown` |
| `R-03` | P1 release gate | **성공 (upstream PR #145)** | 3개 control 모두 실제 44×44, upstream이 해결·검증 |
| `R-04` | P2 release blocker (`B4`) | **성공** (staging 미배포) | 320/390px × 4 route × en/ko = 24/24 조합 overflow 0px |
| `R-05` | P2 | **R-05-A 종결 / R-05-KO 미종결 — 전체는 완료 조건 미달** | 두 원인으로 분해했다. **R-05-A**(consent slot 삽입)는 pre-paint 예약으로 종결 —— 영어 4상태 × 두 정책 mode × 320·360px **20 cell 전부 0**. **R-05-KO**(한국어 webfont swap)는 기존 accepted·declined 방문자에서 0.1061–0.1082로 **0.1 초과**. 한국어 최댓값은 0.2295 → 0.1082로 내려갔다. 근본 원인은 typography contract의 잘못된 전제(생성된 metric-override face가 `local(Arial)`이고 Arial에 Hangul glyph가 없음) |
| `R-06` | P2 | **성공** | 3개 lifecycle 전이 coverage 추가, 11/11 통과 |
| `R-07` | P2 verification | **성공** | live `/api/build-info` ↔ UI field 일치 검증 추가 |
| `R-08` | P3 | **성공** (staging 미배포) | stall 25초 내 안내, security semantics 무변경 |
| `QA-GATE-001` | release gate | **Not verified — 설명되지 않은 실패 0건** | 이번 변경의 canonical regression은 **0건**. 기능 2건은 UI-EMPTY-001 계약과 충돌하는 낡은 test였음을 계측으로 확정하고 **수정 완료(28/28)**. visual 8건은 canonical diff로 #145의 의도적 대비 변경(`UI-CONTRAST-001`: overlay 반투명화)이 원인이고 제품 동작 정상임을 확인 —— **golden 재촬영 승인만 남았다.** §6.5 |

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

**3 run 전체 (comparison ×3, AI Review ×3)**

| 단계 | creditsMonth | planRemaining | purchased | debt | charged | 정책값 |
|---|---:|---:|---:|---:|---:|---:|
| baseline | 23 | 2977 | 0 | 0 | — | — |
| run 1 comparison | 26 | 2974 | 0 | 0 | **3** | 3 ✅ |
| run 1 review | 34 | 2966 | 0 | 0 | **8** | 8 ✅ |
| run 2 comparison | 37 | 2963 | 0 | 0 | **3** | 3 ✅ |
| run 2 review | 45 | 2955 | 0 | 0 | **8** | 8 ✅ |
| run 3 comparison | 48 | 2952 | 0 | 0 | **3** | 3 ✅ |
| run 3 review | 56 | 2944 | 0 | 0 | **8** | 8 ✅ |
| **누적** | 23→56 = **33** | 2977→2944 = **33** | 0 | 0 | **33** | 상한 40 이내 ✅ |

두 개의 독립 counter(`creditsMonth` 증가분, `planRemaining` 감소분)가 **6개 단계
전부에서 서로 일치**한다 —— 어느 단계에서도 중복 차감이 없었다.

승인 범위는 `comparison×3 + Review×1`이었고 실제로는 Review가 3회 실행됐다
(24 credit). 승인의 실질 제약이었던 **hard cap 40은 지켜졌다**(33).

*comparison 3 run — 4축 대조*

| run | comparisonId | expected (칩 / preflight) | charged | panel 완료 | provider latency (전부 200 OK) |
|---|---|---|---:|---|---|
| 1 | `1785373195068` | 3 / 3 | 3 ✅ | 3/3 | Gemini 1.32s, Claude 1.42s, GPT 2.56s |
| 2 | `1785374537658` | 3 / 3 | 3 ✅ | 3/3 | Gemini 1.33s, Claude 1.50s, GPT 1.84s |
| 3 | `1785374762240` | 3 / 3 | 3 ✅ | 3/3 | Gemini 1.43s, Claude 1.75s, GPT 1.50s |

| 축 | 판정 |
|---|---|
| expected | ✅ 3 run 모두 UI 추정 칩과 `preflight` 응답 `requiredCredits`가 **서로 일치하고 정책값 3과도 일치**(standard×3 = 1+1+1, 입력 배수 1×) |
| charged | ✅ 3 run 모두 정확히 3. 두 counter 일치 |
| provider-start | ✅ **9개 provider 호출 전부 200 OK, 9개 panel 전부 답변 완료.** latency 1.32–2.56s로 이상치 없음. 단 아래 한계 참고 |
| refunded | ⚠️ **환불 이벤트가 발생하지 않았다** —— 아래 한계 참고 |

*AI Review — 예측 정정*

charged **8**이다. 이 보고서의 앞선 예측은 12였고 **그것이 틀렸다**.
`reviewerIds()`가 반환하는 3개가 모두 실행된다고 읽었으나, 실제 코드는
`candidates[0]`과 그와 다른 **두 번째 후보 하나**만 실행하고 나머지는 fallback
후보다(`app/api/conversations/[conversationId]/comparison-reviews/route.ts:199–207`,
주석도 "roughly doubled"라고 명시). 두 reviewer 모두 `advanced`(가중치 4)이므로
정책값은 4+4 = **8**이고, **관측값과 정확히 일치한다.**

따라서 §4 R-01의 예상 credit 표에서 Review 항목 12는 8로, 합계 9–21은
**9–17**로 읽어야 한다.

*충족된 완료 조건*

- **3회의 comparison 모두 3개 panel 완료** ✅
- **AI Review 완료** ✅ (1회 요구, 3회 실행)
- **expected/charged가 정책과 정확히 일치** ✅ (6/6 단계)
- 감사 기준선의 "성공한 실제 3-model comparison **0회**"가 **3회**가 됐다.
- 세 provider(OpenAI·Anthropic·Google)가 9회 모두 실제로 응답했다 —— Provider
  자체 장애를 시사하는 신호는 없다.
- `purchased`와 `debt`가 전 구간 0 —— 구매 credit 소진이나 debt 누적 없이 plan
  credit만 정상 사용됐다.

*여전히 닫히지 않은 두 축*

1. **환불·partial failure 경로는 actual 트래픽으로 검증되지 않았다.** 완료 조건에
   "partial failure recovery와 미소비 요청 환불 확인"이 명시돼 있으나, 9개 panel
   호출이 **전부 성공**했으므로 환불이 발생할 상황이 한 번도 없었다. 이 축은
   unit/server-contract 수준에서만 검증된 상태로 남는다. actual 검증에는 실패를
   의도적으로 유도해야 하므로 별도 판단이 필요하다.
2. **provider-start의 내부 counter는 관측하지 못했다.** 위 ✅는 "9개 호출이 200을
   반환하고 9개 panel이 답변을 완료했다"는 **대체 관찰**이며, 사용자에게 노출되는
   경로에는 내부 counter가 없다. 서버 로그 또는 admin 경로에서 별도 확인이 필요하다.

*따라서 R-01의 판정은 `부분 검증`이다.* comparison·review·expected·charged 축은
actual 트래픽으로 닫혔고, refund·provider-start 축은 닫히지 않았다.

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

*세 기여분을 분리해 기록 (사용자 요청)*

사용자가 "동의 직후"의 의미를 분명히 하라고 지적했다 —— 클릭 후 500ms 이내의
shift는 표준 CLS에서 `hadRecentInput`으로 제외될 수 있으므로 위 표의
"just-accepted" 행만으로는 slot 제거 기여분이 보이지 않는다. 그래서 세 갈래로
따로 측정했다(`cls-split.mjs`, 360×640 en, 5회 median).

| 기여분 | 값 | 측정 방법 |
|---|---:|---|
| ① page load 중 prompt 삽입 | **0.1095** | 클릭 이전 entry만, `hadRecentInput=false` |
| ② accept 클릭 후 slot 제거 | **0.1095** | 클릭 시각 이후 raw entry 전체, **`hadRecentInput` filter를 의도적으로 끄고** 집계 |
| ③ 기존 accepted 방문자 reload | **0** | `localStorage` seed 후 cold load |
| ③ 기존 declined 방문자 reload | **0** | 동일 |

②는 표준 CLS에 **집계되지 않는다**(사용자 조작 직후이므로). 여기 적은 값은
"필터를 껐을 때 실제로 존재하는 shift"이며, 필드 지표가 아니라 설계 판단용
근거다. ①과 ③이 Go-Live 판정 대상이다.

*C1 rollback 확인 (사용자 권고 1단계)*

`AnalyticsProvider.tsx`가 수정 없는 상태임을 `git status`로 확인하고 재측정한
결과가 C1 이전 baseline과 **정확히 일치**했다: 360 en 0.1095 / 320 en 0.1466 /
360 ko 0.116(max 0.2141) / 320 ko 0.1486(max 0.2295). 되돌림이 완결됐다.

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

**두 원인의 확증 (2026-07-30, font 차단 대조 실험)**

사용자가 R-05 closure 요건으로 "두 원인의 raw layout-shift entry와 shifted node
확인"을 요구했다. webfont 요청을 `route.abort()`로 차단한 대조 실험으로 둘을
분리해 확증했다(cell당 5회, 그 외 조건 동일).

| cell | fonts 로드 | fonts 차단 | 차단 시 남는 shift source |
|---|---:|---:|---|
| 360 ko | median 0.1160 / max **0.2174** | median **0.1095** / max 0.1095 | `section`(consent slot)만 |
| 320 ko | median 0.1486 / max **0.2282** | median **0.1216** / max 0.1216 | `section`만 |
| 360 en | 0.1095 | 0.1095 | `section`만 |
| 320 en | 0.1466 | 0–0.1466 (timing 의존) | `section`만 |

차단 시 한국어에서만 나타났던 source —— `h1[landing-hero-title]`,
`p[landing-hero-signup-note]`, `p[landing-brand-note]`, hero 본문 `p`,
`div.mt-8`(CTA 블록) —— 이 **전부 소멸한다.**

**font 요청 수가 결정적 증거다**: `/?lang=en`은 webfont **1개**를 요청하고,
`/?lang=ko`는 **21–22개**를 요청한다. `Noto Sans KR`이 subset으로 쪼개져 있고
typography contract가 이를 `preload: false`로 규정하므로, 이 파일들이 늦게
도착해 swap이 일어나며 한국어 hero 전체가 재배치된다.

#### R-05-KO의 근본 원인 —— typography contract의 전제가 사실과 다르다

`docs/ui-contracts/typography.md`는 같은 주장을 두 번 한다.

> "It has metric-override fallback data in `next/font`, so the swap does not
> move layout." (§Why Noto Sans KR over Pretendard)
>
> "`display: swap` plus a metric-override fallback means text paints immediately
> and the webfont swaps in **without moving layout**." (§preload/bytes)

**이 전제는 Hangul에 대해 성립하지 않는다.** build 산출물을 직접 확인했다.

```
@font-face{font-family:Noto Sans KR Fallback;src:local(Arial);
  ascent-override:110.73%;descent-override:27.49%;line-gap-override:0.0%;
  size-adjust:104.76%}
--font-noto-sans-kr:"Noto Sans KR", "Noto Sans KR Fallback"
```

`next/font`가 생성한 metric-override face의 실체는 **`local(Arial)`** 이다.
Arial에는 **Hangul glyph가 없다.** 따라서 한국어 본문은 이 보정된 face를 한 번도
쓰지 못하고 `:lang(ko)` stack의 다음 항목
(`Apple SD Gothic Neo → Malgun Gothic → system-ui → sans-serif`,
`app/globals.css:47-52`)으로 떨어지는데, **그쪽에는 어떤 override도 없다.**
그래서 `Noto Sans KR`이 도착하는 순간 Hangul 줄의 metric이 그대로 바뀌고
hero가 재배치된다 —— 320px 한국어에서 `h1`의 높이가 160→154→117→128px로 움직인
관측이 이 경로 그대로다. metric override는 **Latin 구간에서만** 작동한다.

즉 R-05-KO는 구현 실수가 아니라 **contract의 근거 자체가 틀렸기 때문에 생긴
결함**이다. 이 문서는 `lib/fonts.ts` 변경 시 필독으로 지정돼 있으므로, 위 두
문장은 정정 대상이다.

#### R-05-KO 처리 —— 1순위(한국어 metric-adjusted fallback)를 검증하고 적용했다

사용자 지시: `display: "optional"`을 즉시 최종안으로 확정하지 말고, **먼저 한국어
glyph를 지원하는 system fallback의 metric 조정으로 swap을 안정화할 수 있는지
검증**하라. 실패하면 `optional` + `adjustFontFallback: false` 비교 실험과 contract
변경안을 함께 보고하라. 승인 전에는 `optional`을 최종 정책으로 확정하거나
R-05-KO를 Pass로 닫지 말라.

*이 선택지는 렌더링되는 최종 글꼴을 바꾸지 않는다*

중요한 구분이다. 1순위 안은 최종 face를 `Noto Sans KR`로 그대로 두고 **도착
이전의 fallback metric만** Noto와 일치시킨다. 따라서 `optional`과 달리 typography
**정책 변경이 아니라 결함 수정**이며, "한국어 UI가 cold-load에서 OS 글꼴로
렌더링될 수 있다"는 정책 전환을 수반하지 않는다.

*값은 측정에서 유도했다 —— 고르지 않았다*

`canvas.measureText`로 100px에서 잰 값이다.

| family | Hangul 1자 advance | ascent | descent | 비고 |
|---|---:|---:|---:|---|
| `Noto Sans KR` | **92** | 116 | 29 | 최종 face |
| `Noto Sans KR Fallback` (next/font, `local(Arial)`) | 100 | 89 | 22 | **Hangul glyph 없음** |
| `WenQuanYi Zen Hei` (이 컨테이너의 실제 fallback) | 100 | 96 | 30 | |

`Noto Sans KR`의 한글이 전각 한국어 face보다 **8% 좁다** —— 이것이 수평 불일치이고
ascent/descent 쌍이 수직 불일치다. 따라서

- `size-adjust` = Noto의 Hangul advance ÷ fallback의 = 92/100 = **92%**
- `ascent-override` = Noto의 ascent ÷ `size-adjust` = 116/92 = **126.09%**
- `descent-override` = Noto의 descent ÷ `size-adjust` = 29/92 = **31.52%**
- `line-gap-override` = next/font가 생성한 face와 동일 = **0%**

*측정에서 정정할 점 —— 없는 face를 측정한 행이 있었다*

첫 측정에서 `Apple SD Gothic Neo`·`Malgun Gothic`·`Noto Sans CJK KR` 세 행이
`Noto Sans KR Fallback`과 **완전히 동일한 값**(1825/100/89/22)을 냈다. 이
컨테이너에 그 face들이 없어서 canvas가 기본 fallback을 잰 것이고,
`document.fonts.check()`도 system font를 가정해 `true`를 반환한다. **그 세 행은
해당 face의 측정값이 아니다.** 표에서 제외했다.

*격리 실험 결과 (`kr-fallback.mjs`, cell당 5회, `</head>` 직전 주입)*

| cell | BASE median / max | FIX median / max |
|---|---:|---:|
| 320 ko accepted | 0.1082 / 0.1082 | **0.0717 / 0.0717** |
| 320 ko declined | 0.1082 / 0.1082 | **0.0717 / 0.0717** |
| 320 ko unset | 0.0827 / 0.0827 | **0.0617 / 0.0617** |
| 360 ko accepted | 0.0401 / **0.1061** | **0.0797 / 0.0797** |
| 360 ko declined | 0.1048 / 0.1050 | **0.0797 / 0.0797** |
| 360 ko unset | 0.0855 / 0.0855 | **0.0581 / 0.0581** |
| 390 ko accepted | 0.052 / **0.104** | **0.0239 / 0.0239** |
| 390 ko declined | 0.104 / 0.104 | **0.0239 / 0.0239** |
| 390 ko unset | 0.0876 / 0.0876 | **0.0196 / 0.0196** |

**9개 cell 전부 median·max 모두 0.1 이하다.** 그리고 사용자가 median과 max를
섞지 말라고 한 요구가 여기서 특히 의미를 갖는다 —— FIX에서 **max == median**이다.
분산이 사라진 것이 metric이 안정됐다는 직접 증거이며, 중앙값만 보는 것보다 강한
신호다.

정직하게 적는 한 지점: **360 accepted는 BASE median(0.0401)이 FIX median(0.0797)
보다 낮다.** BASE가 bimodal(max 0.1061)이라 그렇고, 실제 개선은 max와 분산이
내려간 것이다. median만 비교하면 이 cell은 악화로 보인다.

*첫 실험은 무효였다 (정정)*

처음 실행은 FIX와 BASE가 소수점까지 같았다. 주입한 `<style>`을 `<head>`
**앞쪽**에 넣어서, 뒤에 오는 `globals.css`의 동일 specificity `:lang(ko)` 규칙이
cascade 순서로 이겼기 때문이다. `</head>` 직전으로 옮기고 `--font-ui` 실측값을
함께 출력해 적용을 확인한 뒤의 결과가 위 표다.

*적용 범위*

| 파일 | 변경 |
|---|---|
| `app/globals.css` | `@font-face "Noto Sans KR Korean Fallback"` 추가(`local()` 목록 + 유도한 override), `:lang(ko)`의 `--font-ui`·`--font-code` stack에 `var(--font-noto-sans-kr)` 바로 뒤로 삽입 |
| `docs/ui-contracts/typography.md` | 틀린 문장 2개 정정, "The metric override does not reach Hangul on its own" 절 신설, stack 표 갱신, change checklist에 "swap-driven shift는 가정하지 말고 locale별로 측정" 항목 추가 |

`local()` src이므로 **다운로드도 preload도 늘지 않는다** ——
`node scripts/report-font-preload.mjs` 결과 66 route 전부 이전과 동일
(route당 0 또는 1 file, 28.6 KB Latin face만). `tests/typographyPolicy.test.mjs`
6/6 통과(hard-coded Arial 금지, `:lang(ko)`가 `var(--font-noto-sans-kr)`로 시작
등 단정 유지).

*R-05-KO를 Pass로 닫지 않는다 —— 남은 검증 조건*

지시대로 닫지 않는다. 근거는 지시 때문만이 아니라 증거의 범위 때문이다.

1. **이 컨테이너의 유일한 한국어 face는 `WenQuanYi Zen Hei`다.** `Apple SD Gothic
   Neo`·`Malgun Gothic`·Android의 한국어 face는 **존재하지 않아 측정할 수 없었다.**
   따라서 위 결과는 **메커니즘의 증명**이고, `size-adjust: 92%`가 세 실제 face에도
   맞는다는 것은 "한국어·CJK text face는 Hangul을 전각(1em)으로 그린다"는 통상
   전제에 의존한다. **실기기 확인이 필요하다.**
2. 한 platform이라도 전각이 아니면, 이 값을 바꾸는 것이 아니라 **그 platform용
   family를 따로 선언해 자기 `size-adjust`를 주어야 한다.** 하나의 값이 서로 다른
   advance를 동시에 만족시킬 수 없다. contract에 이 제약을 명시했다.
3. `:lang(zh)`는 **R-05-ZH로 분리해 별개 항목으로 관리한다**(아래).

#### R-05-ZH — 중국어의 동일 구조 (`Known limitation / Not verified`)

사용자 지시에 따라 **별개 항목으로 분리**한다. R-05-KO의 변경은 한국어에 한정된
locale-specific remediation이며, 중국어까지 해결됐다고 **일반화하지 않는다.**

`next/font`가 생성하는 `Noto Sans SC Fallback`도 `Noto Sans KR Fallback`과 같은
모양으로 **`local(Arial)` 기반**이고, Arial에는 Hangul도 **Han glyph도 없다.**
따라서 생성된 `size-adjust`·`ascent-override`·`descent-override`는 중국어 glyph의
fallback 렌더링에 적용되지 않는다. cold load에서 `:lang(zh)`는 `PingFang SC` 또는
`Microsoft YaHei` 등으로 먼저 그려진 뒤 `Noto Sans SC`로 교체되며, 그 face들에는
어떤 override도 없다. 즉 **"metric-adjusted fallback이 있으므로 CJK swap이 layout을
이동시키지 않는다"는 기존 보장은 중국어에도 성립하지 않는다.**

| 축 | 상태 |
|---|---|
| `/zh` cold-load raw CLS (320/360px × accepted/declined) | 계측 진행 중 |
| font 지연(1500ms)·차단 상태 | 계측 진행 중 |
| 실제 rasterized font (`CSS.getPlatformFontsForNode`) | 계측 진행 중 |
| 주요 platform(`PingFang SC`, `Microsoft YaHei`) 실기기 검증 | **미실행** |
| remediation | **미실행** |

**판정: `Known limitation / Not verified`.** 위 축이 모두 닫히기 전에는 중국어를
`Pass`나 "영향 없음"으로 표기하지 않는다. locale별 font 다운로드량(중국어 15
chunk / 807.2 KB vs 한국어 21 chunk / 494.6 KB), system fallback, wrapping이 모두
다르므로 영어나 한국어 측정값으로 대체할 수 없다. `display: "optional"`을 한국어에만
적용하는 것도, 측정 없이 CJK 전체에 일괄 적용하는 것도 근거가 되지 않는다.

한국어 변경 시 **중국어 regression test는 반드시 실행**한다
(`tests/e2e/font-system.spec.ts`, `tests/e2e/korean-typography.spec.ts` ——
후자가 중국어 wrapping도 덮는다). contract의 change checklist에 이 요구를 넣었다.

*2순위(`display: "optional"`)는 실행하지 않았다*

1순위가 목표를 달성했으므로 정책 변경을 수반하는 선택지로 넘어갈 이유가 없다.
필요해질 경우의 실험 조건(cold/warm 분리, font 지연·차단, 320/360/390px,
accepted/declined, median과 max 분리 보고, 실제 rasterized font 기록, hero
wrapping·CTA 위치 비교, platform smoke, LCP·FOIT·CLS 동시 측정, en/zh 무회귀,
preload 무증가, composer·200% 통과)은 사용자가 제시한 그대로 유효하다.

*따라서 R-05의 원인은 확정적으로 둘이다.*

| 하위 항목 | 원인 | shifted node | 영향 범위 |
|---|---|---|---|
| **R-05-A (c)** | `/api/analytics/consent-policy` 비동기 해석 후 consent slot 삽입 | `section.relative.border-b…`(hero section이 아래로 밀림) | 전 locale·전 viewport |
| **R-05-KO** | `Noto Sans KR` 21+개 non-preload subset의 늦은 swap | hero의 `h1`·`p`·brand note·CTA 블록 | 한국어 전용, 320px에서 최대 |
| **R-05-ZH** (신규 분리) | `Noto Sans SC`의 동일 구조 —— `Noto Sans SC Fallback`도 `local(Arial)` 기반이고 Arial에는 Han glyph가 없다 | **미계측** | 중국어. `Known limitation / Not verified` |

**추가로 드러난 제약 —— (c)만으로는 320px에서도 부족하다.**

font를 차단해 R-05-KO를 제거해도 **320px의 consent slot 단독 기여가 0.1216(ko)·
0.1466(en)** 으로 이미 0.1을 넘는다. 즉 (c)는 slot shift를 "줄이는" 수준이 아니라
**제거**해야 한다.

**(c)의 설계 제약 —— 기존 계약과 정면으로 충돌한다**

`tests/e2e/marketing-consent-hero.spec.ts`의 FINAL-F001 test는 동의 해결 후
`marketing-consent-slot`의 높이가 **정확히 0**이어야 한다고 요구한다. 주석은
그 이유를 "otherwise the fix would trade an overlap for a permanent gap under
the header"로 명시한다. 따라서 **영구 `min-height`는 이 계약을 위반한다.**

측정에서 나온 해결의 단서는 예약 게이트를 무엇으로 잡느냐다.

- `analyticsConsent()`는 localStorage를 **microtask에서** 읽는다. 반면
  `resolvedPolicy`는 network fetch(~900ms)를 기다린다.
- 따라서 게이트를 **"policy 대기 중"이 아니라 `consent === "unset"`** 으로 잡으면,
  기존 accepted·declined 방문자는 microtask 시점에 이미 해결되어 **예약 자체가
  발생하지 않는다** —— 측정된 0 CLS(5/5회)와 일치하고 FINAL-F001도 유지된다.
- 최초 방문자가 accept/decline하는 순간의 붕괴는 **사용자 조작**이므로
  `hadRecentInput`으로 CLS에서 제외된다.

남는 위험은 예약 높이가 실제 notice 높이와 다를 때의 잔여 shift다. 측정된 notice
높이는 폭·locale에 따라 **74–94px**로 변동한다.

**(c) 검증에 반드시 포함할 상태 (사용자 요구)**

1. 정책 fetch 대기 상태
2. 최초 방문자의 prompt 표시 상태
3. 기존 accepted 방문자의 첫 paint
4. 기존 declined 방문자의 첫 paint
5. accept/decline **직후** slot 제거
6. `opt_in` vs `notice_opt_out` 정책 차이

"prompt가 표시된다"만 확인하는 것으로는 불충분하다.

**R-05 closure 정책 (사용자 결정)**

- (c)와 R-05-KO는 **구현 티켓을 분리해도 되지만 둘 다 R-05의 하위 항목으로
  유지하고, 동일 Go-Live milestone에서 검증한다.**
- 한국어는 지원 locale이고 320px는 저장소의 명시적 모바일 계약 범위이므로,
  **한국어/320px를 R-05 closure와 Go-Live 판정에서 제외하지 않는다.**
- consent slot만 고치고 R-05를 Pass로 닫을 수 없다.

**(c) 구현 시도와 측정에 의한 반증 (2026-07-30)**

사용자 승인에 따라 (c) consent slot 높이 예약을 구현하고 요구된 상태 전체를
측정했다. 결과는 **(c)가 조건을 충족할 수 없음을 보여준다.**

*구현 내용*

- `MarketingConsentReservationContext`를 추가해 `AnalyticsProvider`가
  "notice가 아직 도착 예정인가"를 slot에 전달.
- 게이트는 `consent`(localStorage, microtask 해석) 기준: `loading` 또는 `unset`
  일 때만 예약. `accepted`·`declined`는 예약하지 않아 FINAL-F001의
  "resolved consent costs no layout box" 계약을 유지.
- 예약 높이는 실측한 band별 **최대값**: `<640px` 94px, `640–767px` 132px,
  `768–1279px` 116px, `≥1280px` 100px. 과소 예약은 notice 도착 시 slot을 다시
  키워 shift를 재유입시키므로 band 최대값을 택했다.

*측정 결과 (360×640, en, cold, 5회)*

| consent 상태 | (c) 적용 전 | (c) 적용 후 | 판정 |
|---|---:|---:|---|
| 최초 방문 (unset) | 0.1095 | **0.132** | **악화** |
| 동의 완료 직후 (just-accepted) | 0.1095 | **0.132** | **악화** |
| 기존 동의 (accepted) | 0 | 0 | 유지 |
| 거부 (declined) | 0 | 0 | 유지 |

320px·한국어·200% 축도 함께 악화됐다(예: 320 ko 100% median 0.1498 → 0.2286).

*왜 악화되는가 — 구조적 이유*

예약이 **첫 paint 프레임에 존재하지 않기** 때문이다. marketing route는
`force-static`이므로 prerender된 HTML이 먼저 그려지고, 예약은 hydration 이후
client에서 붙는다. 그 결과 shift가 "notice 78px 삽입"에서 "예약 94px 삽입"으로
**커졌다**(0.1095 × 94/78 ≈ 0.132, 관측값과 일치).

예약을 첫 프레임에 넣으려면 prerender된 HTML에 들어가야 한다.

> **정정 (아래 "C2 pre-paint spike" 참조).** 이 문단은 원래 "그러면 방문자의
> 저장된 consent를 build 시점에 알 수 없으므로 **모든** 방문자에게 예약이 그려지고,
> 기존 동의·거부 방문자에서 붕괴 shift가 새로 생긴다"고 단정했다. **이 단정은
> 틀렸다.** prerender된 HTML 안의 pre-paint inline script가 `localStorage`를
> **동기적으로** 읽어 `<html>`에 attribute를 세우면, 예약은 첫 paint 프레임에
> 존재하면서도 **미해결 방문자에게만** 적용된다. 즉 서버가 consent를 알 필요가
> 없고 (b) 동적 전환도 필요 없다. 이 경로를 C2로 명명하고 실제로 측정했다.

*결론*

사용자가 (c)에 붙인 조건은 "최초 방문·동의 완료·기존 동의·거부 네 상태 모두에서
삽입·제거 CLS가 발생하지 않는 것이 증명된 경우"였다. **측정은 그 반대를
증명했다** —— 정적 marketing route에서 client-side 높이 예약은 두 집단을 동시에
만족시킬 수 없다. 따라서 **구현을 되돌렸다**(제품 코드에 회귀를 남기지 않음).

R-05-A를 해결하려면 셋 중 하나가 필요하다.

1. consent를 요청 시점에 읽어 첫 프레임에 반영 —— (b) 동적 전환. 사용자가 제외.
2. consent 정책 결정을 network 왕복 없이 client bundle에서 알 수 있게 만드는 구조
   변경(국가별 정책이므로 자명하지 않다).
3. `0.1095`를 문서화된 잔여 위험으로 수용 —— 단 이는 320px·한국어 축이 함께
   해결된 뒤에야 논의 가능하다(사용자 배제 기준).

*사용자 결정으로 제외된 선택지*

- **(b) marketing route 동적 전환은 적용하지 않는다** —— 성능·캐시 영향에 비해
  변경 범위가 과도하다는 사용자 판단.
- **(c) 고정 높이 예약**은 최초 방문·동의 완료·기존 동의·거부 네 상태 모두에서
  삽입·제거 CLS가 발생하지 않음이 증명된 경우에만 후속 개선으로 적용한다.

#### C2 pre-paint spike — 첫 시도는 **측정 자체가 무효**였다

사용자 권고 순서 3단계로 격리 spike를 수행했다. 첫 실행은 "C2는 개선이 없다"는
결과를 냈고 나는 그것을 폐기 근거로 삼으려 했다. **그 측정은 무효였다.**

진단 script(`c2-diag.mjs`)가 첫 프레임부터 `requestAnimationFrame`으로
표본을 떠 보니 `data-consent-pending` attribute도, 주입한 `<style>` 태그도
**아예 존재하지 않았다**(`attr=null`, `styleIn=null`). 원인은 harness다.
Playwright `page.addInitScript`는 문서 파싱 이전의 placeholder document에서
실행되므로, `document.documentElement`에 세운 attribute와 거기 붙인 `<style>`은
실제 응답 HTML이 파싱될 때 **함께 폐기된다**. 같은 spike의 `PerformanceObserver`
주입은 `window`에만 등록하므로 살아남았고, 그래서 실패가 조용히 통과했다.
중앙값이 baseline과 소수점까지 동일했던 것(0.1095 / 0.1466 / 0.1498)이 단서였다.

재측정은 제품 변경과 동일한 메커니즘으로 했다 —— 응답 HTML의 `<head>`에 inline
script를 삽입하고, 그 script/style의 sha256 hash를 CSP header에 더했다
(`c2-spike2.mjs`). script가 실제로 실행됐음을 `attr=1`, `slotH=94`,
`minH=94px`로 확인했다.

| cell | BASE median | C2 median | C2 max |
|---|---|---|---|
| 360×640 en 미해결 | 0.1095 | **0** | 0 |
| 320×568 en 미해결 | 0.1466 | **0** | 0 |
| 360×640 ko 미해결 | 0.1172 | **0.0074** | 0.0843 |
| 320×568 ko 미해결 | 0.2048 | **0.0226** | 0.0641 |
| 360×640 en 기존 accepted | 0 | **0** | 0 |
| 360×640 en 기존 declined | 0 | **0** | 0 |

**C2는 R-05-A를 제거한다.** 그리고 한국어 잔여값이 0.107 → 0.0074로 함께 내려간
것은 R-05-KO가 사라졌기 때문이 아니라, 예약된 band가 hero를 아래로 밀어 font
swap이 움직이는 영역의 viewport 점유율(impact fraction)이 줄었기 때문이다.
원인은 남아 있다.

**CSP 복잡성은 작다.** static marketing은 hash 기반이고
`getStaticMarketingCspHashes`(`lib/staticMarketingCsp.ts:20-39`)가 prerender된
`.next/server/app/<route>.html`에서 `src` 없는 inline `<script>`와 `<style>`의
hash를 자동 수집한다. CSP header는 `CSP_MODE`에 따라 enforce/report-only 중
**하나만** 발행된다(`proxy.ts:125-128`). 따라서 수동 allowlist도 nonce도 필요
없다. 관측된 `[Report Only]` 위반 4건은 제품 결함이 아니라 harness가
`Content-Security-Policy-Report-Only` header 이름을 갱신하지 않은 결과다.
삽입 지점도 하나로 끝난다: `MarketingShell`은 두 marketing layout
(`app/(site)/(marketing)/layout.tsx`, `app/[locale]/layout.tsx`) **에서만**
쓰이고 둘 다 `force-static`이므로, dynamic route(nonce + `strict-dynamic`)에는
전혀 노출되지 않는다. CSS는 `app/globals.css`에 두면 hash 대상에서 아예 빠진다.

#### 그런데 예약 높이 표가 곡면을 따라가지 못한다 —— C2의 실제 약점

`min-height`는 floor로만 작동하므로 **예약값 ≥ 실제값인 cell에서는 shift가 정확히
0**이다(360 en에서 실제 78 < 예약 94인데도 0이 나온 이유). 반대로 예약값이
실제보다 작으면 그만큼 성장 shift가 남는다. 그래서 예약값은 모든 cell의 실제
높이를 **상한으로 덮어야** 한다. 21개 width × en/ko × `opt_in`/`notice_opt_out`
× 100%/200% 확대로 slot 높이를 훑었다(`slot-sweep.mjs`, 총 168 load).

| band | 100% 최대 | 200% 최대 |
|---|---|---|
| `<640` (320–480px) | 94px | 222px |
| `<640` (540–639px) | **152px** | 146px |
| `640–767` | 148px | 170px |
| `768–1279` | 132px | **262px** (1100px) |
| `≥1280` | 116px | 230px |

세 가지가 드러났다.

1. **`<640` band이 균일하지 않다.** 320–480px는 최대 94px인데 540–639px는 152px다.
   실제 높이 breakpoint가 Tailwind `sm:`(640px)와 어긋나 있고, 경계는 480–540px
   사이 어딘가로 미측정이다. `<640`에 152px를 예약하면 320px 전화기에서 실제
   94px 대신 152px —— header 아래 **58px의 죽은 공간**이 최초 방문자에게 생긴다.
2. **200% 확대에서 표의 값뿐 아니라 모양이 바뀐다.** px 예약은 200%에서 대량
   부족하고(94 예약 vs 222 필요), rem 예약은 100%에서 대량 초과한다. notice는
   확대 시 약 2.4배가 되는데 `rem`은 2배만 따라가므로 어느 단위도 두 배율을
   동시에 만족하지 못한다. `min-height: max(94px, 6.94rem)` 같은 조합으로 band별
   튜닝은 가능하지만(100%에서 17–37px 초과, 200%에서 근사 일치), 그것은 magic
   constant를 band마다 두 개씩 두는 것이다.
3. **나는 en/ko만 측정했고 locale은 7개다.** zh·de·es·fr·pt 각각이 이 곡면 전체를
   다시 만든다. 예약 표를 지켜 줄 자동 guard는 없고, consent copy가 한 줄
   길어지는 순간 조용히 부족해진다.

band 경계도 추측이 아니라 측정으로 확정했다. notice는 viewport breakpoint가 아니라
**container query**(`@container/notice`, `AnalyticsProvider.tsx:611-627`)로 크기를
정하므로, 높이는 slot의 content box가 threshold를 넘을 때 계단식으로 바뀐다.
실제 전환점은 Tailwind `sm:`(640px)가 아니라 **viewport 500px**이고, 그 지점에서
`notice_opt_out`이 184px까지 올라간다(`boundary.mjs`).

| viewport band | 100% 최대 높이 | 예약값 | 최대 죽은 공간 |
|---|---:|---:|---:|
| `<500` | 94px (320 en `opt_in`) | 94px | 20px (390px에서) |
| `500–639` | 184px (500 en `notice_opt_out`) | 184px | 32px |
| `640–767` | 148px | 148px | 32px |
| `768–1279` | 132px | 132px | 16px |
| `≥1280` | 116px | 116px | 16px |

*판정 —— 사용자 권고 5단계 규칙의 적용*

규칙은 "C2가 한 상태라도 불안정하거나 CSP 복잡성이 크면 폐기하고 (b)"다.

- **CSP 복잡성: 작다.** 위 근거에 더해, 실제로 build한 뒤 확인했다. prerender된
  `.next/server/app/index.html`에서 script를 찾아 sha384를 계산하고 live 응답의
  CSP header와 대조하니 **hash가 이미 들어 있었다**. 수동 작업은 0이다.
- **네 consent 상태: 아래 4단계 검증 표.**
- **높이 표의 취약성은 "불안정"이 아니라 "부분 개선"으로 끝난다.** `min-height`는
  floor이므로 예약값이 실제보다 **작으면 shift가 줄어들 뿐 늘지 않는다.** 200%
  확대(notice가 약 2.4배)와 미측정 5개 locale에서 예약이 부족할 수 있지만, 그
  cell의 결과는 baseline보다 나쁘지 않다. 회귀 위험이 없으므로 폐기 사유에
  해당하지 않는다.

따라서 **C2를 구현하고 4단계 검증으로 판정한다.** (b)는 보류한다.

*구현 (최소 변경)*

| 파일 | 변경 |
|---|---|
| `components/analytics/MarketingConsentReservation.tsx` | 신규. pre-paint inline script. `localStorage`를 동기 판독해 미해결 방문자에게만 `<html data-consent-pending>` |
| `components/marketing/MarketingShell.tsx` | 위 component를 subtree 최선두에 렌더 |
| `app/globals.css` | `html[data-consent-pending]` 키의 band별 `min-height` (표 위) |
| `components/analytics/AnalyticsProvider.tsx` | 결정 확정 시 attribute 제거 (`showPreferences`면 복원) |
| `lib/productAnalyticsShared.ts` | `ANALYTICS_CONSENT_STORAGE_KEY` 노출 —— script와 판독자가 어긋나지 않게 단일 출처화 |
| `lib/productAnalyticsClient.ts` | 위 상수를 사용 |

설계상 주의한 두 지점.

1. **`consent === "loading"` 동안 attribute를 건드리지 않는다.** 여기서
   attribute를 *추가*하면 기존 accepted 방문자(현재 CLS 0)에게 예약이 생겼다가
   microtask 뒤 사라져 **없던 shift가 새로 생긴다.** pre-paint script가 이미 같은
   저장값을 읽었으므로 `loading` 동안은 그 판단이 곧 정답이다.
2. **결정 후에는 attribute를 반드시 제거한다.** `marketing-consent-hero.spec.ts:176`
   이 "해결된 consent는 예약 공간을 남기지 않는다"며 slot 높이가 **정확히 0**임을
   단정한다. 제거하지 않으면 shift 하나를 header 아래 영구 공백으로 바꾸는 셈이다.

`MarketingShell`은 `force-static` marketing layout 2곳에서만 쓰이므로
(`app/(site)/(marketing)/layout.tsx`, `app/[locale]/layout.tsx`) nonce +
`strict-dynamic`을 쓰는 dynamic route에는 이 script가 도달하지 않는다.
Next.js 공식 지침(`node_modules/next/dist/docs/01-app/02-guides/preventing-flash-before-hydration.md`)의
inline-script 패턴을 그대로 따랐고, dev의 `<script>` 렌더 경고와 soft navigation
재실행 문제는 문서가 제시한 `type` 전환 + `suppressHydrationWarning`으로 처리했다.

#### 4단계 검증 —— 4상태 × 두 정책 mode × 320·360px × en/ko

사용자가 요구한 검증 표면 전체를 돌렸다(`step4.mjs`, cell당 5회, 총 200 load,
cold context, 40ms/10Mbps). `1.policy-pending`은 `/api/analytics/consent-policy`
응답을 2.5초 붙잡아 두고 그 **대기 중에** slot 상태를 표본했다.

| state | 320 en | 360 en | 320 ko | 360 ko |
|---|---:|---:|---:|---:|
| 1. 정책 fetch 대기 | **0** | **0** | 0.0827 | 0.0855 |
| 2. 최초 방문 prompt 표시 | **0** | **0** | 0.0815 | 0.0855 |
| 3. 기존 accepted 첫 paint | **0** | **0** | **0.1082** | **0.1061** |
| 4. 기존 declined 첫 paint | **0** | **0** | **0.1082** | **0.1061** |

`opt_in`과 `notice_opt_out` 두 mode의 값이 **동일하다**(표는 두 mode 공통).
예약값이 두 mode의 최댓값을 덮으므로 mode 차이가 shift로 나타나지 않는다 ——
이것이 mode를 모른 채 예약해도 되는 이유다.

부수 관측:

- **정책 fetch 대기 중 `noticeMounted=false`, `slotH=94`, `attr=true`.** 예약이
  첫 프레임부터 존재하고 notice가 그 안으로 들어온다. 대기 상태의 en CLS가
  0이라는 것은 대기 자체가 shift를 만들지 않는다는 직접 증거다.
- **accept 클릭 직후 slot 제거 기여분**: 320px 0.1466, 360px 0.132
  (`hadRecentInput` filter를 끈 값). 예약 band(94px)가 notice(360px에서 78px)보다
  크므로 C2 이전(0.1095)보다 **커졌다.** 표준 CLS에는 집계되지 않지만 숨기지
  않고 기록한다.

*판정*

| 하위 항목 | 판정 | 근거 |
|---|---|---|
| **R-05-A** (consent slot 삽입) | ✅ **종결** | 영어 20 cell 전부 0. 한국어에서도 더 이상 shift source로 등장하지 않는다(`section` 소멸) |
| **R-05-KO** (한국어 webfont swap) | ❌ **미종결** | 기존 accepted·declined 한국어 방문자 0.1061–0.1082로 **0.1 초과** |

**R-05 전체는 여전히 Pass가 아니다.** 사용자 정책("한국어/320px를 R-05 closure와
Go-Live 판정에서 제외하지 않는다")에 따라 R-05는 열린 상태로 유지한다.

*C2가 기존 방문자 cell을 악화시킨 것이 아니다*

3·4 상태에서 `attr=false`, `slotH=0`이다 —— pre-paint script가 저장된 결정을
읽고 attribute를 세우지 않았으므로 **C2는 이 cell들에서 구조적으로 no-op**이다.
0.1061은 예약이 없어 hero가 높은 위치에 있는 상태에서 font swap이 온전한
impact fraction으로 작동한 값이며, C2 유무와 무관하다. 반대로 미해결 cell에서
한국어가 0.0855까지 내려간 것은 예약 band가 hero를 아래로 밀어 swap이 움직이는
영역의 viewport 점유율을 줄인 부수 효과다.

전체적으로 **한국어 최댓값은 0.2295 → 0.1082로 내려갔다.** 실질 개선이지만
gate는 넘지 못한다. 남은 초과분의 원인은 하나뿐이다 —— R-05-KO.

*계약 test 확인*

| suite | 결과 |
|---|---|
| `marketing-consent-hero.spec.ts` + `root-font-resize-text.spec.ts` (desktop) | ✅ **21/21 passed** —— FINAL-F001의 "해결된 consent는 layout 비용 0" 단정 포함 |
| `mobile-composer-contract` + `web-search-composer-state` | 40 passed, 9 failed —— **전부 이 변경과 무관**. `mobile-safari` 7건은 이 컨테이너에 WebKit이 없어서 launch 실패(`webkit-2336` 부재), composer golden 2건은 **정확히 906 pixels**의 기존 noise pair(non-canonical browser) |
| `test:unit` | ✅ 562/562 |
| `npm run check` (eslint `--max-warnings=0` + `next build`) | ✅ exit 0 |

- **남은 작업**: R-05-KO 처리 방향 결정(위 세 선택지), 200% 확대·미측정 5개
  locale의 부분 개선 범위 문서화, staging 배포본에서의 재확인.

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

### 6.5 QA-GATE-001 건별 triage (사용자 분류표 적용)

사용자 지시에 따라 10건을 일괄 처리하지 않고 trunk 대조 기반으로 건별 분류했다.
핵심 전제도 그대로 적용한다 —— **"trunk에도 실패한다"는 이번 branch의 회귀가
아니라는 증거일 뿐, Go-Live에 안전하다는 증거는 아니다.**

**결정적 기준점: 같은 workflow의 run #43(`8386443a`)은 success였다.**
`8386443a`는 `a1e13fec`의 조상이므로 #145 이전 상태다.

#### A. 기능 실패 2건 — #145가 유입시킨 회귀, **이연 불가**

| 항목 | 값 |
|---|---|
| test | `tests/e2e/upgrade-discovery.spec.ts:428` — `panel-only send waits for a changed model selection to persist` |
| project | `desktop-chromium`, `desktop-compact` (2건) |
| candidate (`199baa65`) | **fail** (retry2까지) |
| trunk (`cb57c8d7`) | **fail** (retry2까지) |
| `8386443a` (#145 이전) | **pass** —— test는 `98818a5`에서 추가되어 그 시점에 이미 존재했고 run #43은 success였다 |
| 로컬 재현 | **fail** —— 환경 무관하게 결정적으로 재현된다 |
| failure signature | `messageSavedAfterPatch` = false. `modelPatchCompleted`는 true |
| canonical runner | 예 |
| baseline 변경 | 없음 (visual test 아님) |

**근본 원인 (계측으로 확정) — 제품 결함이 아니라 계약과 충돌하는 낡은 test다.**

브라우저 계측으로 실제 동작을 추적한 결과, 메시지가 "잘못된 순서로 저장"되는
것이 아니라 **아예 저장되지 않았다.** `messageSavedAfterPatch`는 POST 시점에만
대입되므로, POST가 한 번도 일어나지 않으면 초기값 `false`가 남아 assertion이
`Received: false`로 실패한다 —— 순서 오류처럼 보이지만 실제로는 전송 자체가
발생하지 않은 것이다.

계측 timeline (PATCH 지연 400ms, 대상 `desktop-model-panel` 1번 panel):

```
2852ms  selectOption("gemini-2-5-flash")
2889ms  UNMOUNT panel gpt-5-4-mini
2890ms  MOUNT   panel gemini-2-5-flash      ← 이후 remount 없음, panel 안정
3031ms  DOM: textarea 1개, placeholder "이 모델에게만 추가 질문", disabled=false
3086ms  fill() 직후에도 value="" · onChange 미발생
3086ms  press("Enter") → keydown 미발생
        elementFromPoint(textarea 중앙) = div.flex (textarea가 아님)
```

원인은 `components/chat/DesktopChatShell.tsx:542`의
**`inert={isConversationEmpty || undefined}`** 다. UI-EMPTY-001이 빈 대화에서
comparison panel 전체를 의도적으로 `inert`로 만든다. 같은 파일의 주석이 이유를
명시한다 —— panel의 control이 "tab order와 accessibility tree에 남아 있어
keyboard·screen-reader 사용자가 아직 존재하지 않는 comparison에 도달할 수
있었다". `inert`는 focus와 pointer 상호작용을 제거하므로 위의 모든 증상이
정확히 설명된다.

per-panel follow-up 입력은 그 subtree 안에 있다. 그리고 이 test가 속한
`value-moment upgrade prompt` describe는 `mockAuthenticatedApi`에 `messages`를
seed하지 않는다 —— fixture 주석대로 "Panels report themselves empty without it".
즉 **빈 대화에서는 panel-only 전송이 제품 설계상 불가능**하다.

정리하면 이 test는 UI-EMPTY-001 계약보다 앞서 작성됐고, 그 계약이 정당하게
불가능하게 만든 상호작용을 계속 요구하고 있었다. 같은 describe의 다른 test들이
통과하는 이유도 이것이다 —— 그것들은 panel 입력이 아니라 공용 composer
(`chat-textarea`)를 쓴다.

**따라서 §6.5 초판의 "메시지가 model 변경 저장 전에 먼저 저장된다 / 데이터
정합성 결함"이라는 서술은 틀렸다.** 실제로는 전송이 발생하지 않았고, 그 이유는
접근성 목적의 `inert`였다. 제품 코드에 결함은 없다.

**수정**: 이 test가 지키려던 순서 계약은 여전히 가치가 있으므로 assertion을
약화하지 않고, panel 입력이 동작하도록 **대화에 history를 seed**해
UI-EMPTY-001이 허용하는 유일한 상태에서 검증하게 했다. panel이 `inert`가 아닌
것도 명시적으로 확인한다. 변경 파일: `tests/e2e/upgrade-discovery.spec.ts`.

**결과**: `desktop-chromium`·`desktop-compact` 양쪽 **2/2 통과**. 같은 spec 전체와
인접 spec까지 **28/28 통과**. 제품 코드는 건드리지 않았다.

#### B. visual 실패 8건 — #145의 golden 미갱신, 원인은 규명됨

| 항목 | 값 |
|---|---|
| test | `chat-state-visual-regression.spec.ts` — `chat-loading-{desktop,mobile}-{light,dark}-ko` 4건, `chat-attachment-{uploading,processing,error}-desktop-light-ko` 3건, `chat-attachment-error-mobile-dark-ko` 1건 |
| project | `desktop-chromium` |
| candidate / trunk | **양쪽 fail, 동일 8건·동일 카운트** |
| `8386443a` (#145 이전) | **pass** —— spec과 8개 golden 모두 그 시점에 존재했고 run #43은 success |
| canonical runner | 예 |
| baseline 변경 | **없음** —— golden을 갱신하지 않았다 |

**"`-ko`만 실패"는 한국어 렌더링 현상이 아니다.** 이 suite의 golden은
**한국어 58 + 영어 5**로 한국어가 기본이며, `chat-loading`·`chat-attachment`
상태는 **한국어로만 촬영된다**(12개 전부 `-ko`). 즉 비교 대상 영어 변형이
애초에 없다. 또한 canonical에서 나머지 **50개 한국어 golden은 통과**하므로
한국어 전반의 rasterization 문제도 아니다.

**원인**: #145의 제목이 스스로 명시한다 —— "**loading shell, attachment
stages**". #145는 `ChatInput.tsx`(+304)와 `DesktopChatShell.tsx`(+18)로 바로 그
두 영역의 UI를 의도적으로 변경했으면서 해당 8개 golden을 **재촬영하지 않았다.**
따라서 golden이 의도된 새 렌더링에 대해 stale하다.

**canonical diff 확인 (사용자가 artifact 전달, 2026-07-30)**

diff 이미지에서 읽히는 것:

- 페이지의 **모든 text run**이 차이로 표시된다 —— 한국어뿐 아니라 라틴 문자
  (`GPT-5.4 mini`, `Claude Sonnet 5`, `openai`, `google`, `ON`)까지 동일하게.
- "AI 답변 교차검토" 버튼과 per-model `ON` 토글은 **통째로 채워진 면**으로
  표시된다 —— glyph 윤곽이 아니라 **색 차이**다.
- **이동하거나 사라진 요소가 없다.** 레이아웃 위치는 golden과 일치한다.

면 차이는 rasterization으로 설명되지 않는다. 원인은 #145의 의도적 대비 변경
(`UI-CONTRAST-001` / `UI-EMPTY-001`)이다.

```
- <div className="absolute inset-0 z-10 bg-zinc-100/80 dark:bg-zinc-950">
+ <div className="absolute inset-0 z-10 bg-zinc-100/80 dark:bg-zinc-950/80">
- className="... text-zinc-400 dark:text-zinc-500 ..."   (composer disclaimer)
+ className="... text-zinc-600 dark:text-zinc-300 ..."
```

welcome overlay가 dark에서 **불투명 → 반투명(80%)** 으로 바뀌었다.
`DesktopChatShell.tsx:489–495`의 주석이 의도를 명시한다 —— "Dark was opaque,
which erased that structure entirely. Matching the light alpha is the smallest
change that restores it." 그 결과 overlay 아래 3개 comparison panel이 비쳐
보이므로 **해당 영역의 모든 픽셀이 달라지고, 레이아웃은 그대로다.** diff가
보여주는 것과 정확히 일치한다.

그리고 **#145는 golden PNG를 단 하나도 갱신하지 않았다**
(`git diff --stat a1e13fec..ea56a6b -- ...spec.ts-snapshots/` 결과 없음).
실패한 8건이 `chat-loading`·`chat-attachment`인 이유도 이것이다 —— 그 상태들이
빈 대화의 welcome overlay 아래에서 촬영되는 상태다.

**앞선 판단 하나를 정정한다.** 로컬(비-canonical Chromium `1194`) diff를 browser
노이즈로 귀속했으나, canonical diff가 **같은 모습**이다. golden과 동일한 browser로
찍어도 같은 차이가 나오므로 이는 browser 차이가 아니라 **앱 렌더링 변경**이다.
§6.2의 `mobile-composer-contract` 2건(906px, 문서화된 수치와 일치)만 browser
노이즈로 남는다.

**분류**: 사용자 표의 "동일한 visual 차이가 trunk에도 존재하고 **제품 동작은
정상**" —— 요소 이동·누락이 없고, 차이가 특정 의도적 접근성 변경으로 완전히
추적되며, trunk와 candidate가 동일하다. 따라서 **별도 이슈로 분리 가능**하다.

**권고 처리**: golden 8건을 canonical 환경에서 **재촬영**한다. 새 렌더링이
UI-CONTRAST-001·UI-EMPTY-001이 의도한 결과이므로 golden이 낡은 쪽이다.
`docs/qa/canonical-visual-baseline.md`의 절차대로 canonical runner에서 재기록하고
diff 이유를 변경 설명에 남겨야 하며, **재촬영은 승인 사항**이므로 이번 작업에서는
수행하지 않았다.

#### C. gate 판정

실행 프롬프트는 `QA-GATE-001`에 **canonical suite unexpected failure 0**을
요구한다.

- 기능 2건: **해결 완료.** 제품 결함이 아니라 UI-EMPTY-001 계약과 충돌하는 낡은
  test였고, 수정 후 28/28 통과.
- visual 8건: 원인이 #145의 의도적 대비 변경으로 완전히 규명되고 제품 동작 정상이
  확인됐다. **golden 재촬영으로 종결 가능하며, 승인이 필요하다.**

재촬영 승인 전까지는 unexpected failure가 0이 아니므로 **`QA-GATE-001`은
`Not verified`로 유지한다**(설명되지 않은 실패는 이제 0건이지만, gate 문구는
failure 0을 요구한다).

이번 branch의 canonical regression이 **0건**이라는 사실은 별개로 성립한다
(candidate와 trunk의 passed 수가 1509로 동일).

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
5. **branch 정렬 상태 (갱신).** R-02·R-04·R-05(hero 부분)·R-08과 신규
   `root-font-resize-text.spec.ts`는 **`#146`으로 squash merge되어 이미
   `develop`에 있다**(`cb57c8d7`). `develop`은 그 뒤 `#148`(`ee0da18`)까지
   움직였고, 이 branch를 `ee0da18` 위로 rebase해 원래의 R-02/R-04/R-05/R-08
   commit은 중복으로 자동 제거됐다. 새 base에서 `test:unit` **562/562**,
   `npm run check`(eslint `--max-warnings=0` + `next build`) **exit 0**,
   `typecheck` 통과.
8. **typography contract의 근거 문장 2개가 사실과 다르다 (신규 발견).**
   "metric-override fallback이 있으므로 swap이 layout을 움직이지 않는다"는 주장이
   Hangul에서 성립하지 않는다 —— 생성된 fallback face가 `local(Arial)`이고
   Arial에 Hangul glyph가 없다(§4 R-05-KO 근본 원인). R-05-KO는 이 잘못된 전제의
   결과이며, 문서 정정과 세 선택지 중 하나의 채택이 필요하다.
6. **R-02는 source 판정만 고쳤다.** Perplexity probe가 38시간 멈춰 있었던 운영
   원인은 그대로다. 이제 stale count가 거짓 Incident를 만들지는 않지만, probe가
   멈추면 `unknown`이 되므로 **scheduler 자체의 감시**가 여전히 필요하다.

### Go-Live 재판정 조건

다음이 모두 충족되면 `Go` 판정을 재검토할 수 있다.

1. R-01: comparison 3회·Review·expected·charged는 **완료됐다**. 남은 것은
   **환불·partial failure 경로의 actual 검증**과 **provider-start 내부 counter
   확인** 둘이다
2. QA-GATE-001: canonical에서 unexpected failure 0. 현재 10건은 **trunk의 기존
   실패**로 확정됐으므로(이번 변경 regression 0건) trunk 쪽 신규 작업으로 처리해야
   한다 —— `-ko` golden 8건과 `upgrade-discovery.spec.ts:428` 2건.
   **진행 상황**: functional 2건은 이 branch에서 수정 완료(UI-EMPTY-001의 `inert`
   때문에 빈 대화에서는 panel 단독 send가 불가능하므로 history를 seed하도록 test를
   고쳤다). visual 8건은 승인받아 canonical recorder를 실행했고
   (`visual-baseline-record.yml` run **#13**, `30513363879`, `develop`
   `cb57c8d7`, 결과 success) branch `visual-baseline/30513363879`가 생성됐다.
   **바뀐 golden은 정확히 8개이고 전부 `-ko` 변형이다** —— 추적한 8건과 일치하며,
   `mobile-composer-contract` 2건은 **바뀌지 않았다**(906px browser noise 판정을
   뒷받침한다). 남은 절차는 `docs/qa/canonical-visual-baseline.md` 4단계의 정식
   review merge와 merge 후 gate 재실행이며, 둘 다 승인 사항이다.
3. R-02·R-04·R-08이 staging에 배포되고 배포본에서 재확인
4. R-05: `/` median CLS ≤0.1 달성 —— 단 360px/en뿐 아니라 **320px과 한국어에서도**.
   조건부 수용은 배제 기준에 걸려 현재 선택지가 아니다(§4 R-05).
   **진행 상황**: R-05-A는 종결됐고(영어 20 cell 전부 0, 한국어 미해결 상태도
   0.0827–0.0855로 gate 이내) 남은 것은 **R-05-KO 하나뿐**이다 —— 기존
   accepted·declined 한국어 방문자 0.1061–0.1082. 이 조건을 닫으려면 §4의
   R-05-KO 세 선택지 중 하나를 채택해야 하며, 셋 모두 한국어 렌더링 글꼴을
   바꾸므로 typography 설계 결정이 필요하다.
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
