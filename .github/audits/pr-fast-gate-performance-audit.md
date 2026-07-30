# PR Fast Gate 성능 감사 보고서

- 감사일: 2026-07-27
- 대상: `mposition/Tomverse` — `.github/workflows/pr-fast-gate.yml`
- 측정 범위: PR Fast Gate run #80 ~ #109 (2026-07-27, 완료된 run 28건) + Secret History Scan run #131 ~ #142
- 데이터 출처: GitHub Actions REST API (`/actions/runs`, `/actions/runs/{id}/jobs`, `/actions/jobs/{id}/logs`) — GitHub MCP 도구로 조회. `gh` CLI는 이 환경에 설치되어 있지 않음.
- 이 문서는 **감사·계획 문서**이며 워크플로 파일은 아직 수정하지 않았음.

> **측정치 표기 규칙**
> - `[측정]` = Actions API / 실제 로그에서 확인된 값
> - `[로컬]` = 이 감사 세션의 컨테이너에서 직접 실행해 측정한 값 (GitHub Runner와 하드웨어가 다르므로 CI 절대값이 아닌 **비율·구성비 근거**로만 사용)
> - `[추정]` = 위 두 가지에서 유도한 계산값. 실측이 아님.

---

## 1. 최종 판정

### **과도하게 느림 (Excessively slow)**

근거 요약:

| 항목 | 값 | 판정 |
|---|---|---|
| 현재 테스트 세트 기준 성공 run 소요 | **17.4 ~ 21.8분** `[측정]` | 목표(8분) 대비 2.2~2.7배 |
| E2E 단계가 전체에서 차지하는 비중 | **85.5 ~ 89.4%** `[측정]` | 단일 병목 |
| E2E 외 전체 오버헤드 | **147 ~ 165초 (2.5분)** `[측정]` | 정상 범위 |
| "PR 스모크 테스트"라는 이름의 실제 테스트 수 | **332건** (265 pass / 16 flaky / 51 skip) `[측정]` | 스모크가 아님 |
| 성공 run에서 재시도로 가려진 flaky 테스트 | **16건, 전부 동일 파일** `[측정]` | 최소 8분 낭비 |

핵심 결론은 하나입니다. **PR Fast Gate가 느린 이유는 CI 인프라·캐시·설치 비용이 아니라, "PR smoke tests"라는 이름의 단계가 사실은 전체 E2E 회귀 스위트(332건)를 worker 1개로 직렬 실행하고 있고, 그중 16건이 매 run마다 30초 타임아웃 후 재시도로 통과하고 있기 때문입니다.**

인프라 측면(캐시, npm ci, 브라우저 설치, 큐 대기)은 **모두 건강하며 최적화 여지가 거의 없습니다.** 이 부분을 건드리는 것은 시간 낭비입니다.

---

## 2. 최근 실행시간 통계 `[측정]`

### 2.1 전체 집계 (완료된 run 28건, 2026-07-27)

| 지표 | 값 |
|---|---|
| 전체 run 수 | 28건 (총 109 run 중 최근 구간) |
| 성공 | 12건 (42.9%) |
| 실패 | 13건 (46.4%) |
| **취소** | **3건 (10.7%)** |
| 성공 run 중앙값 | 469초 (7.8분) |
| 성공 run 평균 | 619초 (10.3분) |
| 성공 run p95 | 1,212초 (20.2분) |
| 성공 run 최대 | 1,310초 (21.8분) |
| 실패 run 중앙값 | **99초 (1.7분)** |
| 실패 run p95 | 1,170초 (19.5분) |
| 취소 run 중앙값 | 371초 |

### 2.2 중요: 위 중앙값은 현재 상태를 과소평가합니다

측정 구간 도중(`#107`, `tests/e2e/chat-state-visual-regression.spec.ts`, 45 테스트 추가)에 E2E 스위트 크기가 급증했습니다. 측정 구간 전반부의 run들은 구버전 브랜치라 E2E가 108~326초에 불과합니다.

**현행 테스트 세트를 실제로 실행한 최근 5개 run:**

| run | 결론 | 전체 | E2E 단계 | E2E 비중 |
|---|---|---|---|---|
| 30256146044 (#103) | success | 17분 24초 | 893초 | 85.5% |
| 30243347696 (#101) | failure | 19분 08초 | 989초 | 86.2% |
| 30244476297 (#102) | success | 20분 09초 | 1,044초 | 86.4% |
| 30261847561 (#104) | success | 21분 47초 | 1,159초 | 88.7% |
| 30262881954 (#106) | failure | 23분 07초 | 1,240초 | 89.4% |

→ **현행 기준 실질 중앙값 ≈ 20.2분, p95 ≈ 23.1분** `[측정]`

### 2.3 Queue 대기시간 — 문제 없음 `[측정]`

- 28건 중 25건: **queue 0초** (`created_at` == `run_started_at`)
- 나머지 3건(640s / 1,145s / 1,239s): 전부 `run_attempt = 2`인 **수동 re-run**. `created_at`은 원본 run 생성 시각이므로 이 차이는 큐 대기가 아니라 "사람이 재실행 버튼을 누르기까지의 시간"입니다.
- **결론: Runner 큐 병목 없음. 최적화 대상 아님.**

### 2.4 실패를 처음 확인할 때까지 걸린 시간 `[측정]`

두 종류로 확연히 갈립니다.

| 실패 유형 | 피드백 시간 | 예시 |
|---|---|---|
| 정적/lint/build 실패 | **56 ~ 103초** | run 30238668498: ESLint에서 92초 만에 실패 |
| E2E 실패 | **1,148 ~ 1,387초 (19~23분)** | run 30243347696, 30262881954 |

run 30238668498 스텝 타임라인 (총 95초 만에 실패 확정):
```
Set up job        3s   → 누적    3s
Checkout          2s   → 누적    5s
Gitleaks          3s   → 누적    8s
Setup Node        6s   → 누적   14s
Next cache        1s   → 누적   15s
npm ci           35s   → 누적   50s
security:regr     0s   → 누적   50s
test:unit        11s   → 누적   61s
encoding          1s   → 누적   62s
ESLint+build     29s   → 누적   91s  ← ESLint 실패
```

**"명백한 정적·Unit 실패 피드백 3분 이하" 목표는 이미 달성되어 있습니다.** 이 목표에는 손댈 것이 없습니다.

### 2.5 Cold Cache / Warm Cache 차이 `[측정]`

조사한 모든 run에서 3개 캐시 전부 적중했습니다. 로그 원문:

```
Cache hit occurred on the primary key Linux-playwright-<lock-hash>-chromium, not saving cache.
Cache hit occurred on the primary key Linux-next-pr-<lock-hash>-<src-hash>, not saving cache.
Cache hit occurred on the primary key node-cache-Linux-x64-npm-<lock-hash>, not saving cache.
```

| 캐시 | 키 | 적중 여부 | miss 시 추가 비용 |
|---|---|---|---|
| setup-node npm | lockfile 해시 | 항상 hit (lockfile 변경 시에만 miss) | ~25초 `[추정]` |
| Playwright 브라우저 | lockfile 해시 | 항상 hit | ~40~60초 `[추정]` |
| `.next/cache` | lockfile + 소스 해시 | run에 따라 hit/miss 혼재 | **~6초 이하** `[로컬 측정]` |

`.next/cache` miss 사례 (run 30261847561 post-job 로그):
```
Sent 204426 of 204426 (100.0%), 2.4 MBs/sec
Cache saved with key: Linux-next-pr-<lock-hash>-c77a91c4...
```
→ 업로드 payload가 **204 KB**. miss 비용이 사실상 0입니다.

**Cold/Warm 차이는 전체적으로 1분 미만이며, 20분짜리 run에서 유의미하지 않습니다.**

---

## 3. Step별 병목 순위 `[측정]`

현행 세트를 실행한 5개 run의 스텝별 소요(초):

| # | Step | 30240981816* | 30242980905* | 30256146044 | 30244476297 | 30261847561 | 30243347696 | 30262881954 | 중앙값(현행) |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Set up job | 1 | 2 | 1 | 1 | 1 | 2 | 2 | 1 |
| 2 | Checkout (`fetch-depth: 0`) | 1 | 1 | 2 | 2 | 2 | 2 | 1 | 2 |
| 3 | **Gitleaks** | 2 | 1 | 1 | 2 | 1 | 1 | 2 | 1 |
| 4 | Setup Node.js | 3 | 3 | 3 | 6 | 3 | 3 | 3 | 3 |
| 5 | Next.js cache restore | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| 6 | **npm ci** | 38 | 33 | 30 | 36 | 33 | 33 | 30 | **33** |
| 7 | security:regression | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **0** |
| 8 | test:unit | 6 | 11 | 10 | 11 | 11 | 11 | 10 | 11 |
| 9 | check:encoding:strict | 1 | 1 | 1 | 2 | 1 | 1 | 2 | 1 |
| 10 | **ESLint + next build** | 70 | 76 | 84 | 84 | 78 | 80 | 75 | **80** |
| 11 | Playwright cache restore | 0 | 3 | 2 | 3 | 3 | 2 | 4 | 3 |
| 12 | Install Chromium | 27 | 11 | 13 | 12 | 11 | 19 | 11 | 12 |
| 13 | **Desktop Chromium E2E** | 108 | 326 | 893 | 1044 | 1159 | 989 | 1240 | **1044** |
| | **전체 job** | 266 | 471 | 1044 | 1209 | 1307 | 1148 | 1387 | **1209** |

\* 구버전 브랜치(테스트 수가 적음) — 현행 중앙값 계산에서 제외

### 가장 느린 Step 5개 (현행 기준)

| 순위 | Step | 중앙값 | 전체 대비 |
|---|---|---|---|
| **1** | **Run desktop Chromium PR smoke tests** | **1,044초** | **86.4%** |
| 2 | ESLint and production build | 80초 | 6.6% |
| 3 | Install dependencies (`npm ci`) | 33초 | 2.7% |
| 4 | Install Chromium | 12초 | 1.0% |
| 5 | Unit and API policy tests | 11초 | 0.9% |
| — | 나머지 8개 스텝 합계 | 12초 | 1.0% |

**1위와 2위의 격차가 13배입니다. 2위 이하를 전부 0초로 만들어도 전체는 13.6%밖에 줄지 않습니다.**

---

## 4. 의심 지점 검증 결과

### A. Gitleaks 중복 — **중복 확정. 단, 시간 절감 효과는 ~2초** ✅

`Secret History Scan` 워크플로의 실제 로그 (run 30262882037):

```
[command]/tmp/gitleaks-8.24.3/gitleaks detect --redact -v --exit-code=2 \
  --report-format=sarif --report-path=results.sarif --log-level=debug \
  --log-opts=--no-merges --first-parent 2007ca4b...^..faec18bd...
INF 5 commits scanned.
INF scanned ~112539 bytes (112.54 KB) in 208ms
INF no leaks found
```

**핵심 발견: `Secret History Scan`은 이름과 달리 `pull_request` 이벤트에서 히스토리 전체를 스캔하지 않습니다.** gitleaks-action은 PR 이벤트에서 base..head 커밋 범위만 스캔합니다. PR Fast Gate 내부의 Gitleaks 스텝도 **동일한 action, 동일한 이벤트, 동일한 커밋 범위**를 스캔합니다.

→ **두 스캔은 문자 그대로 동일한 작업입니다.** 보안 수준 저하 없이 하나만 남길 수 있습니다.

| 항목 | PR Fast Gate 내부 | Secret History Scan |
|---|---|---|
| 트리거 | `pull_request` | `pull_request`, `push:main`, weekly cron, dispatch |
| PR에서 스캔 범위 | base..head | base..head (**동일**) |
| 실제 히스토리 전체 스캔 | 안 함 | `push:main` / cron 에서만 함 |
| 소요 | 1~2초 | 9~16초 (독립 job, **critical path 아님**) |
| artifact 업로드 | 비활성 | 활성 (SARIF) |

**권장: PR Fast Gate에서 인라인 Gitleaks 스텝을 제거하고 `Secret History Scan`을 유일한 Required Check로 유지.**
- 보안 커버리지: 동일 (PR 범위 스캔 + main push/주간 전체 히스토리 스캔 모두 유지)
- 부수 효과: `fetch-depth: 0`도 함께 제거 가능 (PR Fast Gate에서 전체 히스토리가 필요한 유일한 이유였음)
- **단, 시간 절감은 2~4초입니다. 이건 "중복 제거"이지 "성능 개선"이 아닙니다. 성능 근거로 팔지 마십시오.**

⚠️ **주의: `Secret History Scan`에는 `concurrency` 블록이 없습니다.** 새 커밋 push 시 이전 run이 취소되지 않아 계속 쌓입니다. 별도 수정 항목(P1)으로 분류.

### B. E2E가 진짜 Smoke Test인지 — **전혀 아님** ❌

| 항목 | 값 |
|---|---|
| `tests/e2e/` spec 파일 수 | **40개** `[측정]` |
| `npm run test:e2e:pr` 실행 명령 | `playwright test --project=desktop-chromium` (필터 없음) |
| desktop-chromium 프로젝트 실제 실행 건수 | **332건** (265 passed + 16 flaky + 51 skipped) `[측정 — run 30256146044 로그]` |
| 소요 | 14.9분 ~ 19.3분 `[측정]` |

로그 원문:
```
run 30256146044:  16 flaky / 51 skipped / 265 passed (14.9m)
run 30261847561:  (동일 패턴) / 51 skipped / 266 passed (19.3m)
```

파일별 테스트 수 상위:

| 파일 | 테스트 수 |
|---|---|
| `chat-state-visual-regression.spec.ts` | **45** (2026-07-27 #107에서 신규 추가) |
| `analytics-consent.spec.ts` | 26 |
| `upgrade-discovery.spec.ts` | 20 |
| `touch-targets.spec.ts` | 20 |
| `chat-keyboard-policy.spec.ts` | 20 |
| `korean-typography.spec.ts` | 19 |
| `build-info.spec.ts` | 17 |
| `model-comparison-layout.spec.ts` | 16 |

`@smoke` 태그는 **현재 코드베이스에 하나도 존재하지 않습니다** `[측정]`.

#### 제안: PR용 `@smoke` 세트 (18~20건)

PR에서 **반드시 남겨야 하는** 핵심 시나리오를 실제 테스트 제목 기준으로 선정했습니다.

| 영역 | 파일 | 테스트 | 건수 |
|---|---|---|---|
| 앱 부팅 / 마케팅 | `smoke.spec.ts` | `home renders the marketing site` | 1 |
| Guest Chat | `smoke.spec.ts` | `guest preview opens a 3-model comparison chat by default` | 1 |
| Guest Chat | `guest-flow.spec.ts` | `guest message appears immediately with mocked response` | 1 |
| **결제/권한** | `guest-flow.spec.ts` | `guest cannot activate a paid model` | 1 |
| 로그인 | `smoke.spec.ts` | `signed-in homepage keeps the page visible and offers one continue action` | 1 |
| 로그인 | `account-flow.spec.ts` | `authenticated user opens settings` | 1 |
| **결제** | `account-flow.spec.ts` | `billing success modal respects the explicit return language` | 1 |
| **결제/Credit** | `upgrade-discovery.spec.ts` | `locked paid model opens an actionable plan dialog` | 1 |
| **Credit 원장** | `upgrade-discovery.spec.ts` | `comparison preflight rejection prevents every provider request` | 1 |
| **Credit 원장** | `upgrade-discovery.spec.ts` | `comparison preflight retries one transient network failure` | 1 |
| **Credit 원장** | `upgrade-discovery.spec.ts` | `unexpected aggregate preflight failure falls back to authoritative chat checks` | 1 |
| 모델 비교 | `comparison-review.spec.ts` | `AI comparison review with two reviewers shows a tab switcher and agreement summary` | 1 |
| 모델 비교 | `desktop-flow.spec.ts` | `guest model selector opens a swap dialog once the 3-model cap is reached` | 1 |
| 모델 비교 | `desktop-flow.spec.ts` | `model picker prioritizes exact credits and shows the final input estimate` | 1 |
| 첨부파일 | `attachment-flow.spec.ts` | `selected image previews before and after send` | 1 |
| 첨부파일 | `attachment-flow.spec.ts` | `PDF remains a friendly file card and sends successfully` | 1 |
| 첨부파일 | `attachment-flow.spec.ts` | `image attachments disable text-only Llama models and keep Scout available` | 1 |
| UI 계약 | `ui-contracts.spec.ts` | `desktop exposes stable QA contracts` | 1 |
| UI 계약 | `ui-contracts.spec.ts` | `mobile exposes stable QA contracts` | 1 |
| 배포 무결성 | `build-info.spec.ts` | (대표 1건) | 1 |
| | | **합계** | **20** |

선정 원칙:
- 결제·Credit 원장·인증 경로는 **한 건도 빼지 않음** (오히려 `upgrade-discovery`의 preflight 3건을 명시적으로 포함해 Credit 차감 안전성을 PR 게이트에 고정)
- 시각 회귀(스크린샷 비교), 타이포그래피, 터치 타깃, 키보드 정책, 반응형 레이아웃, i18n 전수 검사는 **PR에서 제외 → main/nightly로 이동**
- 나머지 312건은 **삭제하지 않고** main push(`e2e.yml`) 및 nightly(`daily-security-audit.yml`)에서 계속 실행

예상 소요: 서버 부팅 20~40초 + 20건 × 2~3초 → **약 1.5~2.5분** `[추정]`

### C. Playwright 병렬성 — **지금 workers를 올리면 안 됨** ⚠️

현재 설정 (`playwright.config.ts`):
```ts
fullyParallel: false,
retries: process.env.CI ? 2 : 0,
workers: process.env.CI ? 1 : 4,
```

#### 상태 공유 여부 검증 `[측정]`

| 자원 | 공유 여부 | 병렬화 위험 |
|---|---|---|
| DB | **없음** — `E2E_DISABLE_DATABASE: "true"`, `DATABASE_URL`이 죽은 포트(`127.0.0.1:1`)를 가리킴 | 없음 |
| 포트 | 단일 `webServer` (127.0.0.1:3100)를 전 worker가 공유 | 낮음 (읽기 전용 Next 서버) |
| 사용자 상태 | Playwright 기본 격리 — worker/테스트별 독립 BrowserContext | 없음 |
| 파일 상태 | 업로드는 `page.route("**/__qa_upload__")`로 **클라이언트 측 인터셉트**. 서버에 도달하지 않음 | 없음 |
| 서버 측 in-memory 상태 | `lib/` 내 in-memory rate limiter 없음 | 없음 |
| 모킹 | `app-fixtures.ts`에서 `page.route` 19곳 — 전부 페이지 단위 격리 | 없음 |

→ **구조적으로는 병렬 안전합니다.** 문제는 다른 데 있습니다.

#### Retry가 실제 장애를 가리고 있음 — **확정** 🔴

성공으로 표시된 run 30256146044의 로그:
```
16 flaky
  [desktop-chromium] › chat-state-visual-regression.spec.ts:201:11 › Loading state › chat-loading-mobile-light-ko
  [desktop-chromium] › chat-state-visual-regression.spec.ts:201:11 › Loading state › chat-loading-mobile-dark-ko
  [desktop-chromium] › chat-state-visual-regression.spec.ts:233:11 › Streaming state › chat-streaming-mobile-light-ko
  [desktop-chromium] › chat-state-visual-regression.spec.ts:310:11 › Partial failure state › chat-partial-failure-mobile-dark-ko
  ... (총 16건, 14건이 동일 파일의 mobile-* 변형)
51 skipped
265 passed (14.9m)
```

실패 원인이 **16건 전부 동일**합니다:
```
Test timeout of 30000ms exceeded.
Error: expect(locator).toHaveCount(expected) failed
  Locator:  getByTestId('mobile-header-model-summary-skeleton')
  Expected: 0
  Received: 1
  Timeout:  30000ms
    64 × locator resolved to 1 element
  at enterConversation (tests/e2e/chat-state-visual-regression.spec.ts:181:76)
```

그리고 소스에는 이미 이런 주석이 있습니다:
```ts
// bootstrap) rather than steady-state render time -- under a loaded
// runner 15s was observed to be insufficient even across retries.
await expect(page.getByTestId("mobile-header-model-summary-skeleton")).toHaveCount(0, {
  timeout: 30_000,
});
```

즉 **이미 한 번 타임아웃을 15초 → 30초로 늘려 문제를 덮은 이력**이 있습니다. `MobileChatShell.tsx:490`의 스켈레톤이 30초 넘게 사라지지 않는다는 것은 타이밍 이슈가 아니라 **모바일 헤더 모델 요약의 hydration 성능/조건 문제일 가능성이 높습니다.** 이것은 실제 사용자에게 영향을 주는 결함일 수 있으며, 재시도로 가려져 있습니다.

#### 비용 계산 `[추정]`

- 16건 × 30초 첫 시도 타임아웃 = **480초 (8분)**
- 재시도 재실행분: 16건 × 5~15초 ≈ 80~240초
- **성공 run 1건당 약 9~12분이 flaky 재시도에 소모** (E2E 14.9~19.3분 중)

#### workers=2 평가

| 항목 | 평가 |
|---|---|
| 예상 이득 | 스모크 세트(20건) 기준 **약 30~40초** `[추정]` — 스코프 축소로 얻는 12~16분에 비해 미미 |
| 위험 | GitHub hosted `ubuntu-latest` = 4 vCPU / 16 GB. Next 프로덕션 서버 + Chromium 2개 동시 실행 → CPU 경합 증가 |
| 치명적 위험 | 현재 알려진 실패 모드가 **정확히 "로드가 걸리면 hydration이 느려져 타임아웃"**. workers를 올리면 이 실패가 **더 자주** 발생 |
| 판정 | **지금은 금지.** flaky 해결 전 병렬성만 올리는 것은 요청하신 안전 조건에 정면으로 위배 |

**권장 순서:**
1. `chat-state-visual-regression.spec.ts`를 PR 티어에서 제외 (즉시)
2. `mobile-header-model-summary-skeleton` 대기 실패의 **근본 원인 수정** (타임아웃 재증가 금지)
3. 그 후에만 스모크 티어에서 `workers: 2` + **`retries: 1`** 을 실험 (retries를 낮춰야 flaky가 다시 숨지 않음)

### D. Chromium 설치 — **문제 없음. 최적화 대상 아님** ✅

`[측정]` `npx playwright install --with-deps chromium` 소요: **11, 11, 12, 13, 19, 27초** (중앙값 12초)

- Playwright 캐시는 **매번 primary key 적중** (키가 lockfile 해시만 포함 → lockfile이 안 바뀌면 항상 warm)
- 캐시 적중 시에도 실행되는 12초는 대부분 **Ubuntu OS 의존 패키지(`--with-deps`)의 apt 처리**이며, 브라우저 다운로드는 캐시로 건너뜁니다
- 27초가 나온 run(30240981816)은 `Restore Playwright Chromium cache` 스텝이 0초로 끝난 케이스 — 즉 캐시 복원이 실패했거나 없었던 경우

**개선 여지 (총 절감 ~8초, 우선순위 낮음):**
- `--with-deps`를 브라우저 설치와 OS 의존성 설치로 분리:
  - `npx playwright install-deps chromium` (OS 의존성, 캐시 불가)
  - `npx playwright install chromium` (브라우저, 캐시 적중 시 즉시 종료)
- 또는 캐시 적중 시 `install-deps`만 실행하도록 조건 분기
- **전체 20분 중 12초입니다. 손대지 마십시오.**

### E. Next.js Cache — **키 설계는 공식 권장안 그대로. 다만 Turbopack 때문에 효과가 거의 없음** ⚠️

#### 키 설계 검증

현재 키:
```yaml
key: ${{ runner.os }}-next-pr-${{ hashFiles('package-lock.json') }}-${{ hashFiles('app/**/*.ts', ... ) }}
restore-keys: |
  ${{ runner.os }}-next-pr-${{ hashFiles('package-lock.json') }}-
  ${{ runner.os }}-next-
```

이것은 `node_modules/next/dist/docs/01-app/02-guides/ci-build-caching.md`의 GitHub Actions 예시와 **동일한 설계**입니다:
```yaml
key: ${{ runner.os }}-nextjs-${{ hashFiles('**/package-lock.json') }}-${{ hashFiles('**/*.js', '**/*.jsx', '**/*.ts', '**/*.tsx') }}
restore-keys: |
  ${{ runner.os }}-nextjs-${{ hashFiles('**/package-lock.json') }}-
```

→ **"소스 해시 때문에 대부분의 PR에서 새 키가 생성된다"는 지적은 사실이지만, 그것이 설계 의도입니다.** restore-key 폴백이 정상 작동하며(run 30261847561에서 확인), 소스가 바뀌었을 때 이전 캐시를 재사용하되 새 캐시를 저장합니다.

#### 실측: 효과가 거의 없음

| 항목 | 값 |
|---|---|
| `.next/cache` 크기 | **828 KB** (압축 전) `[로컬]` |
| 업로드 payload | **204 KB** `[측정 — run 30261847561 로그]` |
| 캐시 복원 소요 | 1초 `[측정]` |
| 캐시 저장 소요 | 1초 미만 `[측정]` |
| Cold build | **64초** `[로컬]` |
| Warm build (`.next/cache` 존재) | **58초** `[로컬]` |
| **순 이득** | **약 6초 (9%)** |

원인: 이 프로젝트는 **Next.js 16.2.10 + Turbopack** 빌드입니다 (`✓ Compiled successfully in 26.2s` 위에 `▲ Next.js 16.2.10 (Turbopack)`). Turbopack 빌드는 과거 webpack의 대용량 persistent cache를 `.next/cache`에 남기지 않습니다. 실제 내용물은:
```
.next/cache/fetch-cache   (192K)
.next/cache/.tsbuildinfo
.next/cache/.previewinfo
.next/cache/.rscinfo
```

빌드 단계 분해 `[로컬]`:
```
Cold:  Compiled 28.7s  |  TypeScript 28.6s  |  static pages 1.3s   → 64s
Warm:  Compiled 26.2s  |  TypeScript 26.4s  |  static pages 1.0s   → 58s
```

**판정: 캐시 다운로드·압축 해제·업로드 시간(합계 ~2초)이 빌드 절감(~6초)보다 짧습니다. 즉 순이득이지만 절대값이 무의미합니다.** 두 캐시 스텝 모두 이미 `continue-on-error: true`가 붙어 있어 캐시 실패가 워크플로 실패로 이어지지 않습니다 — 이 부분은 이미 올바릅니다. **유지하되, 여기서 시간을 찾으려 하지 마십시오.**

### F. npm ci — **건강함. node_modules 직접 캐시는 명확히 반대** ✅

| 항목 | 값 |
|---|---|
| CI `npm ci` (setup-node npm 캐시 warm) | **30 ~ 38초, 중앙값 33초** `[측정]` |
| 로컬 `npm ci` (npm 캐시 cold, 다운로드 포함) | **58초** `[로컬]` |
| `postinstall`의 `prisma generate` 단독 | **3초** `[로컬]` |
| `node_modules` 크기 | **1.6 GB** `[로컬]` |

분석:
- `prisma generate`는 33초 중 **약 3초**. 별도 최적화 대상 아님.
- setup-node의 npm 캐시는 tarball만 캐시하고 `node_modules`를 매번 재생성하는 것이 맞습니다. 그 재생성이 **30초**입니다. 이는 1.6 GB 규모 의존성으로는 양호한 수치입니다.

#### `node_modules` 직접 캐시 — **반대**

| 위험 | 내용 |
|---|---|
| 무결성 | `npm ci`는 lockfile로부터 결정적 재현을 보장. `node_modules` 캐시는 이 보장을 우회하며, 캐시 오염 시 **PR CI와 프로덕션 빌드가 다른 트리를 사용**하게 됨 |
| 플랫폼 바이너리 | `sharp`, `@prisma/client`, `pdfjs-dist`가 네이티브/생성 아티팩트를 포함. 캐시 키에 Node 마이너 버전·glibc·아키텍처가 모두 들어가야 안전 |
| 크기 | 1.6 GB 압축·업로드·다운로드가 30초보다 빠르다는 보장 없음 (actions/cache 10 GB 한도도 압박) |
| 이득 | 최대 30초. 전체 20분의 2.5% |

**판정: 무결성 위험이 이득을 압도합니다. 채택하지 않습니다.**

#### pnpm 전환 — **장기 옵션으로만 분류**

즉시 변경안에 포함하지 않습니다. 근거:
- 최대 이득 15~20초 (전체의 1.6%)
- Prisma 7 + Next 16 + Sentry의 hoisting 동작 검증 비용이 이득을 초과
- Dependabot 설정, 모든 워크플로, 배포 파이프라인 동시 변경 필요
- 별도 스파이크로 분리 (이번 성능 작업과 무관)

### G. Build 중복과 검사 범위 `[측정]`

#### `npm run check` 구성
```json
"check": "eslint . --max-warnings=0 && next build"
```

`[로컬]` ESLint 단독: **34초** / `[로컬]` `next build` 단독: **58~64초** → 합계 92~98초
`[측정]` CI에서 이 스텝: **70~84초** (Runner가 더 빠름)

#### `next build`의 TypeScript 검사 vs `npm run typecheck`

| | 명령 | 소요 | PR Fast Gate에서 실행? |
|---|---|---|---|
| `next build` 내부 | (자동) `Running TypeScript ... Finished TypeScript in 26.4s` | **26~29초** `[로컬]` | ✅ (`npm run check`에 포함) |
| `npm run typecheck` | `next typegen && tsc --noEmit --incremental false` | 유사 | ❌ (PR에서 실행 안 함) |

**차이:** `next build`의 TS 검사는 Next가 생성한 라우트 타입까지 포함해 빌드 그래프에 도달한 파일을 검사합니다. `npm run typecheck`는 `tsconfig.json` `include` 전체를 검사하므로, **빌드 그래프에 없는 파일(예: `scripts/`, 일부 테스트 헬퍼)까지 커버**합니다.

→ **완전 중복은 아니지만 상당 부분 겹칩니다.** 현재 PR Fast Gate가 `typecheck`를 실행하지 않는 것은 **올바른 선택**입니다(`daily-security-audit.yml`에서 별도 실행 중). 추가하지 마십시오.

#### PR에서 동일 build를 중복 수행하는 워크플로 확인

PR(`pull_request`)에서 트리거되는 워크플로 전수 조사 `[측정]`:

| 워크플로 | 트리거 | `npm ci` | `next build` | E2E | 소요 |
|---|---|---|---|---|---|
| **PR Fast Gate** | `pull_request` (전체) | ✅ | ✅ | ✅ 332건 | **17~23분** |
| Secret History Scan | `pull_request` (전체) | ❌ | ❌ | ❌ | 9~16초 |
| Credit Finance DB Integration | `pull_request` + **paths 필터** | ✅ | ❌ | ❌ (DB 통합) | (조건부) |
| CodeQL Advanced | `pull_request` + **`branches: [main]`** | ❌ (`build-mode: none`) | ❌ | ❌ | (develop PR에서 미실행) |
| Main Chromium Regression (`e2e.yml`) | `push: main` 만 | — | — | — | PR 미실행 |
| Daily Security Audit | cron 만 | — | — | — | PR 미실행 |

**결론: `next build`는 PR에서 단 한 번만 실행됩니다. 빌드 중복은 없습니다.** `npm ci`는 Credit Finance DB Integration이 조건부로 트리거될 때만 2회 실행되며, 이는 별도 job이므로 병렬입니다.

#### 전체 PR Required Checks의 실제 Critical Path

```
                     ┌─ Secret History Scan ────────────  16초
 PR open/push ───────┼─ PR Fast Gate ──────────────────── 1,209초  ← Critical Path
                     └─ Credit Finance DB (조건부) ─────  (paths 매칭 시)

 Critical path = 1,209초 = 20.2분   (= PR Fast Gate 단독)
```

**PR Fast Gate 하나가 전체 critical path의 100%입니다.** 다른 어떤 워크플로도 이를 늘리지 않습니다.

⚠️ **별도 발견 (성능과 무관한 커버리지 갭):** CodeQL은 `pull_request: branches: [main]`으로 제한되어 있습니다. 이 팀의 개발 흐름은 `develop`으로 머지하므로, **일상적인 PR에서 CodeQL이 전혀 실행되지 않습니다.** 이번 작업 범위 밖이지만 반드시 별도로 검토해야 합니다.

---

## 5. 중복 실행 및 불필요한 직렬화

### 5.1 중복 실행

| # | 항목 | 상태 | 낭비 | 조치 |
|---|---|---|---|---|
| 1 | Gitleaks가 PR Fast Gate와 Secret History Scan에서 **동일 커밋 범위** 스캔 | 확정 `[측정]` | ~2초 (critical path) | 인라인 스텝 제거 |
| 2 | `fetch-depth: 0` — Gitleaks 전용인데 전체 job이 부담 | 확정 | ~1초 | Gitleaks 제거 시 함께 제거 |
| 3 | `next build`의 TS 검사 vs `npm run typecheck` | 부분 중복 | 0 (PR에서 typecheck 미실행) | **현상 유지** |
| 4 | `next build` 자체 | 중복 없음 | 0 | — |
| 5 | `npm ci` (PR Fast Gate 단일 job 내) | 중복 없음 | 0 | — |

**중복 제거로 얻는 총 시간: 약 3초.** 이것이 성능 문제의 원인이 아니라는 점을 분명히 합니다.

### 5.2 불필요한 직렬화 — 여기가 진짜 문제

현재 13개 스텝이 **단일 job에서 완전 직렬** 실행됩니다. 각 검사의 성격 분류:

| Step | PR 머지 전 필수 | 병렬 가능 | main push 이후 가능 | Nightly 이동 가능 | 변경파일 조건부 | 중복 |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Checkout | ✅ | — | — | — | — | — |
| **Gitleaks** | ✅ | ✅ (독립 job) | — | — | — | ✅ **중복** |
| Setup Node | ✅ | — | — | — | — | — |
| Next.js cache restore | ⬜ | ✅ | — | — | — | — |
| npm ci | ✅ | — | — | — | — | — |
| Security regression | ✅ | ✅ (static job) | — | — | — | — |
| Unit/API tests | ✅ | ✅ (static job) | — | — | — | — |
| Encoding validation | ✅ | ✅ (static job) | — | — | ✅ (텍스트 파일) | — |
| ESLint | ✅ | ✅ (static job) | — | — | — | — |
| Next.js production build | ✅ | ✅ (build job) | — | — | — | — |
| Playwright cache restore | ⬜ | ✅ (build job) | — | — | — | — |
| Chromium 설치 | ⬜ | ✅ (build job) | — | — | — | — |
| **Desktop Chromium E2E (332건)** | **20건만** | ✅ | **✅ 나머지 312건** | ✅ 시각회귀·i18n·a11y 전수 | ✅ | — |

**직렬화 자체보다, 마지막 한 줄이 전체의 86%라는 것이 문제입니다.** job을 4개로 쪼개도 E2E가 17분이면 전체는 17분입니다.

### 5.3 개별 검사 재배치 계획 (삭제 없음)

| 검사 | 현재 | 이동 후 | 근거 |
|---|---|---|---|
| Gitleaks (PR 범위) | PR Fast Gate + Secret History Scan | **Secret History Scan만** | 동일 스캔 확인 |
| Gitleaks (전체 히스토리) | Secret History Scan (push:main + weekly) | **변경 없음** | 유지 |
| Security regression | PR | **PR 유지** | 0초, 보안 게이트 |
| Unit/API tests (464건) | PR | **PR 유지** | 11초, 결제·Credit 로직 커버 |
| Encoding validation | PR | **PR 유지** | 1초 |
| ESLint | PR | **PR 유지** | 30초 |
| Production build | PR | **PR 유지** | 55초, TS 검사 포함 |
| E2E 핵심 20건 (`@smoke`) | PR | **PR 유지** | 결제·Credit·인증·Guest·비교·첨부 |
| E2E 나머지 312건 | PR | **`e2e.yml` (main push)** | 회귀 탐지 유지 |
| `chat-state-visual-regression.spec.ts` (45건) | PR | **`e2e.yml` (main push) + nightly** | 시각 회귀는 PR 게이트 부적합 |
| `korean-typography` / `touch-targets` / `chat-keyboard-policy` / `model-picker-responsive` (66건) | PR | **`e2e.yml` (main push)** | 레이아웃·a11y 회귀 |
| `analytics-consent*` (34건) | PR | **`e2e.yml` (main push)** | 동의 정책은 unit test에서도 커버 (`analyticsConsentPolicy.test.mjs`) |
| desktop-compact / mobile-chromium 뷰포트 | `e2e.yml` (이미 main) | **변경 없음** | 유지 |
| mobile-safari (WebKit) | `daily-security-audit.yml` | **변경 없음** | 유지 |
| 전체 E2E (`test:e2e:run`) | nightly | **변경 없음** | 유지 |
| CodeQL | PR→main only | **변경 없음** (별도 검토 항목) | 범위 밖 |
| DB Integration | PR (paths 조건부) | **변경 없음** | 이미 조건부 |
| `npm audit` | nightly | **변경 없음** | 유지 |
| `npm run typecheck` | nightly | **변경 없음** | build의 TS 검사와 부분 중복 |

---

## 6. Coverage를 유지하는 권장 Workflow 구조 — 3개 안 비교

### 안 A: 최소 변경 (단일 job 유지)

```
PR Fast Gate (단일 job, 이름 변경 없음)
├── Checkout                        (fetch-depth: 1 로 축소)
├── [삭제] Gitleaks                  ← Secret History Scan에 위임
├── Setup Node + npm cache
├── Next.js cache restore
├── npm ci                          33초
├── security:regression              0초
├── test:unit                       11초
├── check:encoding:strict            1초
├── ESLint                          30초   ← check 분리
├── next build                      55초   ← check 분리
├── Playwright cache restore + Chromium 15초
└── test:e2e:smoke (--grep @smoke)  150초  ← 332건 → 20건
                                    ─────
                                    ~300초 = 5.0분
```

변경 파일: `pr-fast-gate.yml`, `secret-history-scan.yml`, `e2e.yml`, `package.json`, 20개 spec 파일에 `@smoke` 태그
**Required Check 이름 변경: 없음** (job 이름 그대로)

### 안 B: 병렬 Fast Gate (4 job)

```
                    ┌─ secret-scan ──────────────────────  25초
                    │    checkout(fd:0) + gitleaks
                    │
 PR ────────────────┼─ static-and-unit ─────────────────  ~86초
                    │    checkout + node + npm ci(33)
                    │    + regression(0) + unit(11)
                    │    + encoding(2) + eslint(30)
                    │
                    ├─ build-and-smoke ────────────────── ~264초  ← 임계
                    │    checkout + node + npm ci(33)
                    │    + build(55) + pw-cache(3)
                    │    + chromium(12) + smoke(150)
                    │
                    └─ [needs: 위 3개] aggregate ────────  ~12초

 Wall clock = 264 + 12 = 276초 = 4.6분
```

**npm ci 중복 비용:**

| 항목 | 값 |
|---|---|
| `npm ci` 추가 실행 횟수 | +1회 (static-and-unit, build-and-smoke 각 1회) |
| 추가 runner 시간 | +33초 |
| 추가 job 기동(`Set up job` + checkout + setup-node) | 3개 job × ~8초 = +24초 |
| **총 추가 과금 시간** | **약 +57초 (+1.0 runner-분)** |
| 단축된 wall clock | −24초 (안 A 대비) |

→ **npm ci 중복 비용이 얻는 wall clock 이득보다 큽니다.** 안 B의 실질 가치는 시간이 아니라 **장애 격리**(lint 실패가 build를 기다리지 않음)입니다.

**Required Status Check 이름 안정화 (필수):**

브랜치 보호는 워크플로 이름이 아니라 **check run 이름 = job의 `name:` 값**을 참조합니다. 현재 required check는 십중팔구
```
Security, unit, build, and Chromium smoke tests
```
입니다. 안 B로 전환할 때 집계 job의 `name:`을 **이 문자열 그대로** 지정해야 브랜치 보호 설정을 건드리지 않습니다.

```yaml
  fast-gate:
    name: Security, unit, build, and Chromium smoke tests   # ← 절대 변경 금지
    needs: [secret-scan, static-and-unit, build-and-smoke]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - name: Enforce upstream job results
        run: |
          # needs.*.result 를 검사해 하나라도 success가 아니면 exit 1
          # (skipped/cancelled 를 success 로 취급하지 않도록 명시적으로 검사)
```

⚠️ 하위 3개 job은 **required로 등록하지 말 것.** 등록하면 이름이 늘어나 브랜치 보호 재설정이 필요해집니다.

### 안 C: Two-tier CI

PR 티어는 안 B와 동일 구조(4 job, ~4.6분). 여기에 tier-2 재배치를 **명시적으로** 추가:

| 티어 | 워크플로 | 내용 | 상태 |
|---|---|---|---|
| **PR** | PR Fast Gate | secret-scan / static+unit / build+smoke(20건) / aggregate | 수정 |
| **main push** | `e2e.yml` (Main Chromium Regression) | desktop-chromium **전체 332건** + desktop-compact + mobile-chromium | 확장 |
| **main push** | Secret History Scan | 전체 히스토리 Gitleaks | 현행 유지 |
| **main push** | Credit Finance DB Integration | PostgreSQL 통합 시나리오 | 현행 유지 |
| **main PR** | CodeQL Advanced | actions + javascript-typescript | 현행 유지 (별도 검토) |
| **Nightly** | `daily-security-audit.yml` | 전체 E2E(4 프로젝트, WebKit 포함) + `npm audit` + `typecheck` + 전체 회귀 | 현행 유지 |
| **Nightly (신규 권장)** | 시각 회귀 전용 | `chat-state-visual-regression.spec.ts` 45건 + 스냅샷 갱신 리포트 | 신규 |

### 3개 안 비교표

| 기준 | 현재 | 안 A (최소 변경) | 안 B (병렬 4-job) | 안 C (Two-tier) |
|---|---|---|---|---|
| **예상 PR 중앙 실행시간** | **20.2분** `[측정]` | **~5.0분** `[추정]` | **~4.6분** `[추정]` | **~4.6분** `[추정]` |
| **예상 p95** | **23.1분** `[측정]` | ~7.0분 `[추정]` | ~6.5분 `[추정]` | ~6.5분 `[추정]` |
| 정적 실패 피드백 | 1.5분 `[측정]` | 1.5분 | ~1.6분 (독립 job) | ~1.6분 (독립 job) |
| E2E 실패 피드백 | 19~23분 `[측정]` | ~5분 | ~4.6분 | ~4.6분 |
| **보안 Coverage** | 기준 | **동일** (Gitleaks PR 스캔 유지, 히스토리 스캔 유지, security:regression 유지) | **동일** | **동일** |
| **회귀 탐지 Coverage (PR 시점)** | 332 E2E | 20 E2E (−94%) | 20 E2E | 20 E2E |
| **회귀 탐지 Coverage (머지 후 24h 내)** | 332 + nightly 전체 | **332 + nightly 전체 (동일)** | 동일 | **동일 + 시각회귀 전용 job 추가로 소폭 향상** |
| **Flaky 위험** | 높음 (성공 run당 16건 flaky) | **낮음** (원인 파일이 PR 티어에서 제외됨) | 낮음 | 낮음 |
| **GitHub Actions 비용** | ~21 runner-분/run | **~5.5 runner-분/run (−74%)** | ~7 runner-분/run (−67%) | ~7 runner-분/run + tier-2 증가 |
| **구현 난이도** | — | **낮음** (파일 5개 + 태그 20개) | 중간 (워크플로 재작성 + 집계 job) | 중간~높음 (신규 nightly job 포함) |
| **Required Check 변경 영향** | — | **없음** ✅ | **없음 (집계 job 이름 고정 시)** ⚠️ | **없음 (동일 조건)** ⚠️ |
| 롤백 용이성 | — | **매우 쉬움** (grep 한 줄) | 중간 | 중간 |

### 권장: **안 A를 먼저 적용하고, 안정화 후 안 C로 확장**

근거를 분명히 합니다.

- 안 A만으로 **20.2분 → 5.0분 (−75%)** 를 달성합니다. 안 B/C가 추가로 주는 것은 0.4분(8%)뿐입니다.
- 이득의 **97%가 "E2E 스코프 축소" 단 하나**에서 나옵니다. job 병렬화는 성능 기여가 거의 없습니다.
- 안 A는 **브랜치 보호를 전혀 건드리지 않으며**, 문제 시 `--grep @smoke` 제거만으로 즉시 롤백됩니다.
- 안 B/C의 집계 job 이름 고정은 실수 시 **모든 PR이 머지 불가**가 되는 위험을 동반합니다. 성능 이득 8%를 위해 감수할 위험이 아닙니다.
- 안 C의 tier-2 재배치(= `e2e.yml` 확장, 시각회귀 nightly)는 **안 A와 함께 즉시 수행해야 합니다.** 이것은 job 구조 변경 없이 가능합니다.

---

## 7. 예상 Before / After 실행시간

### 스텝별 Before / After (안 A 기준)

| Step | Before `[측정]` | After `[추정]` | 차이 |
|---|---|---|---|
| Set up job | 1초 | 1초 | — |
| Checkout | 2초 (`fetch-depth: 0`) | 1초 (`fetch-depth: 1`) | −1초 |
| Gitleaks | 1초 | **0초 (제거)** | −1초 |
| Setup Node.js | 3초 | 3초 | — |
| Next.js cache restore | 1초 | 1초 | — |
| npm ci | 33초 | 33초 | — |
| security:regression | 0초 | 0초 | — |
| test:unit | 11초 | 11초 | — |
| check:encoding:strict | 1초 | 1초 | — |
| ESLint | (합산) | 30초 | — |
| next build | (합산 80초) | 55초 | −(±0) |
| Playwright cache restore | 3초 | 3초 | — |
| Install Chromium | 12초 | 12초 | — |
| **E2E** | **1,044초 (332건)** | **~150초 (20건)** | **−894초** |
| **합계** | **1,209초 (20.2분)** | **~301초 (5.0분)** | **−75.1%** |

### 시나리오별 Before / After

| 시나리오 | Before `[측정]` | After (안 A) `[추정]` | After (안 C) `[추정]` |
|---|---|---|---|
| PR 성공 (중앙값) | 20.2분 | **5.0분** | **4.6분** |
| PR 성공 (p95) | 23.1분 | **7.0분** | **6.5분** |
| ESLint/TS 실패 | 1.5분 | 1.5분 | 1.6분 |
| Unit 실패 | 1.1분 | 1.1분 | 1.3분 |
| E2E 실패 | 19.1~23.1분 | **~5.0분** | **~4.6분** |
| Cold cache (lockfile 변경) | ~21분 | **~6.5분** | **~6.0분** |
| main push 회귀 (`e2e.yml`) | ~20분 (3 프로젝트) | ~35분 (3 프로젝트 + 332건 전체) | 동일 |
| Nightly 전체 | 현행 | 현행 유지 | 현행 + 시각회귀 job |

### 비용 영향 `[추정]`

| | Before | After (안 A) |
|---|---|---|
| PR 1건당 runner-분 | ~21분 | ~5.5분 |
| 일일 PR run 약 30건 기준 | ~630 runner-분 | ~165 runner-분 |
| main push 추가분 | ~20분/회 | ~35분/회 |
| **순 절감** | — | **일 약 400 runner-분 (−63%)** |

---

## 8. P0 / P1 / P2 개선 목록

### P0 — 즉시 (효과의 97%)

| # | 항목 | 예상 절감 | 위험 |
|---|---|---|---|
| **P0-1** | **PR E2E를 `@smoke` 20건으로 축소.** `package.json`에 `"test:e2e:smoke": "playwright test --project=desktop-chromium --grep @smoke"` 추가, `pr-fast-gate.yml`이 이를 호출. 20개 테스트 제목에 `@smoke` 태그 부착 | **−12 ~ −16분** | 낮음 (롤백 = grep 제거) |
| **P0-2** | **제외된 312건을 `e2e.yml`(main push)로 명시 재배치.** `test:e2e:chromium`은 이미 desktop-chromium 전체를 포함하므로 **추가 작업 없이 커버됨** — 이 사실을 워크플로 주석으로 문서화하고, 축소가 커버리지 손실이 아님을 검증 | 0 (커버리지 보전) | 없음 |
| **P0-3** | **`chat-state-visual-regression.spec.ts`(45건)를 PR 티어에서 제외** — `@smoke` 태그를 붙이지 않는 것으로 자동 달성. 이 파일이 성공 run당 flaky 16건 전부의 출처 | **−8분** (P0-1에 포함) | 없음 |
| **P0-4** | **PR Fast Gate의 인라인 Gitleaks 스텝 제거**, `Secret History Scan`을 유일한 PR Required Check로 유지. `fetch-depth: 0` → 기본값 | −3초 | **없음** (동일 스캔 확인됨) |

### P1 — 다음 (안정성·가시성)

| # | 항목 | 근거 |
|---|---|---|
| **P1-1** | **`mobile-header-model-summary-skeleton` 30초 타임아웃의 근본 원인 수정.** `components/chat/MobileChatShell.tsx:490` 스켈레톤이 로드된 러너에서 30초 넘게 남는 원인 규명. **타임아웃 재증가 금지** | 재시도가 실제 결함을 가리고 있음. 사용자 영향 가능성 |
| **P1-2** | **`secret-history-scan.yml`에 `concurrency` 블록 추가** (`cancel-in-progress: true`) | 현재 없음 → 새 커밋 push 시 이전 run이 취소되지 않고 누적 |
| **P1-3** | **`npm run check`를 ESLint 스텝과 build 스텝으로 분리** | 스텝별 소요가 로그에 분리 기록되어 병목 추적 가능. lint 실패가 build를 시작하지 않음 |
| **P1-4** | **시각 회귀 전용 nightly job 신설** (`chat-state-visual-regression.spec.ts` 45건 + 스냅샷 diff 리포트) | PR에서 뺀 만큼 명시적으로 재배치 (요청하신 안전 조건) |
| **P1-5** | **`@smoke` 세트에 대한 커버리지 회귀 방지 테스트** — 결제/Credit/인증 경로 spec에 `@smoke`가 최소 N건 유지되는지 검증하는 lint 규칙 또는 unit test | 시간이 지나며 smoke 세트가 조용히 축소되는 것을 방지 |

### P2 — 나중 (조건부·저효과)

| # | 항목 | 조건 |
|---|---|---|
| **P2-1** | 안 B/C의 job 병렬화 (secret-scan / static-and-unit / build-and-smoke / aggregate) | 안 A 안정화 후. **집계 job 이름을 현재 job 이름과 동일하게 고정** |
| **P2-2** | `workers: 2` + `retries: 1` 실험 | **P1-1(flaky 근본 수정) 완료 후에만.** retries를 낮춰 flaky가 다시 숨지 않게 함 |
| **P2-3** | `--with-deps`를 `install-deps` / `install`로 분리 | −8초. 우선순위 매우 낮음 |
| **P2-4** | `.next/cache` 스텝 유지 여부 재검토 | Turbopack 하에서 순이득 ~6초. **유지 권장** (비용도 ~2초로 무해) |
| **P2-5** | 문서 전용 PR에 대한 조건부 실행 | ⚠️ `paths-ignore`를 워크플로 레벨에 쓰면 required check가 **영구 pending**이 되어 머지가 막힘. 반드시 job 레벨 `if` + 항상 실행되는 집계 job 패턴으로 구현 |
| **P2-6** | pnpm 전환 | **이번 작업 범위 밖.** 별도 스파이크로 분리 |
| **P2-7** | CodeQL을 develop PR에도 적용할지 검토 | 성능이 아닌 **커버리지 갭** 이슈. 별도 티켓 |

---

## 9. 변경 예정 파일

이번 감사 단계에서는 **아무 파일도 수정하지 않았습니다.** 실제 구현 시 변경 대상:

### 안 A (P0) 적용 시

| 파일 | 변경 내용 | 위험 |
|---|---|---|
| `.github/workflows/pr-fast-gate.yml` | Gitleaks 스텝 제거, `fetch-depth: 0` 제거, `npm run check` → ESLint/build 분리, `test:e2e:pr` → `test:e2e:smoke`. **`jobs.fast-gate.name`은 절대 변경 금지** | 중간 |
| `.github/workflows/secret-history-scan.yml` | `concurrency` 블록 추가 (P1-2) | 낮음 |
| `.github/workflows/e2e.yml` | 주석으로 "PR에서 제외된 312건이 여기서 커버됨" 명시. 필요 시 `timeout-minutes` 상향(45 → 60) | 낮음 |
| `package.json` | `"test:e2e:smoke"` 스크립트 추가. `test:e2e:pr`은 하위 호환 위해 유지 | 낮음 |
| `tests/e2e/smoke.spec.ts` | 4건에 `@smoke` 태그 | 낮음 |
| `tests/e2e/guest-flow.spec.ts` | 2건에 `@smoke` 태그 | 낮음 |
| `tests/e2e/account-flow.spec.ts` | 2건에 `@smoke` 태그 | 낮음 |
| `tests/e2e/upgrade-discovery.spec.ts` | 4건에 `@smoke` 태그 (Credit preflight 3건 포함) | 낮음 |
| `tests/e2e/comparison-review.spec.ts` | 1건에 `@smoke` 태그 | 낮음 |
| `tests/e2e/desktop-flow.spec.ts` | 2건에 `@smoke` 태그 | 낮음 |
| `tests/e2e/attachment-flow.spec.ts` | 3건에 `@smoke` 태그 | 낮음 |
| `tests/e2e/ui-contracts.spec.ts` | 2건에 `@smoke` 태그 | 낮음 |
| `tests/e2e/build-info.spec.ts` | 1건에 `@smoke` 태그 | 낮음 |

### P1 추가 시

| 파일 | 변경 내용 |
|---|---|
| `components/chat/MobileChatShell.tsx` | 모바일 헤더 모델 요약 스켈레톤 해제 조건 수정 (P1-1) |
| `tests/e2e/chat-state-visual-regression.spec.ts` | `enterConversation`의 30초 대기 제거/축소 (근본 수정 후) |
| `.github/workflows/` (신규) | 시각 회귀 전용 nightly 워크플로 (P1-4) |

### 변경하지 **않을** 파일

| 파일 | 이유 |
|---|---|
| `playwright.config.ts` | `workers`/`retries` 변경은 P2, flaky 근본 수정 후에만 |
| `.github/workflows/codeql.yml` | 별도 커버리지 이슈 |
| `.github/workflows/credit-finance-db-integration.yml` | 이미 paths 조건부, 최적 |
| `.github/workflows/daily-security-audit.yml` | nightly 전체 커버리지 유지 |
| `scripts/run-unit-tests.mjs` | 11초, 최적화 불필요 |
| `scripts/security-regression-check.mjs` | 0초, 최적화 불필요 |
| `package-lock.json` | pnpm 전환은 범위 밖 |

---

## 10. Branch Protection 변경 여부

### 결론: **안 A 적용 시 변경 불필요** ✅

| 안 | check run 이름 | 브랜치 보호 조치 |
|---|---|---|
| **안 A** | `Security, unit, build, and Chromium smoke tests` (변경 없음) | **불필요** |
| 안 B/C | 집계 job을 동일 이름으로 지정하면 변경 없음 | **집계 job `name:` 고정 필수** |
| 안 B/C (부주의 시) | 4개 job 이름이 모두 새 check로 등록됨 | ⚠️ **모든 PR 머지 차단 위험** |

### ⚠️ 확인 불가 사항 (반드시 사람이 확인)

`develop`과 `main`은 **둘 다 protected** 입니다 `[측정 — list_branches]`. 그러나 **현재 세션의 도구로는 required status check 이름 목록을 읽을 수 없습니다.** (GitHub MCP에 branch protection 조회 도구 없음, `gh` CLI 미설치.)

구현 전 반드시 확인:
```
Settings → Branches → develop / main → Require status checks to pass
```

확인할 것:
1. 등록된 required check 이름이 정확히 `Security, unit, build, and Chromium smoke tests` 인지
2. `Scan repository history for secrets` (Secret History Scan의 job 이름)가 required인지 — **P0-4에서 PR Fast Gate의 인라인 Gitleaks를 제거하므로, 이것이 required가 아니라면 반드시 추가해야 보안 게이트가 유지됩니다**
3. `Credit and finance PostgreSQL scenarios`가 required인지 (paths 조건부 워크플로를 required로 두면 조건 미충족 PR이 영구 pending이 될 수 있음)

---

## 11. 목표 성능 평가

| 목표 | 현재 `[측정]` | 달성 가능성 | 평가 |
|---|---|---|---|
| PR 성공 중앙값 **≤ 8분** | 20.2분 | **✅ 달성 가능 (~5.0분)** | 안 A만으로 목표를 크게 상회 |
| PR p95 **≤ 12분** | 23.1분 | **✅ 달성 가능 (~7.0분)** | 여유 있음 |
| 정적·Unit 실패 피드백 **≤ 3분** | **1.5분** | **✅ 이미 달성** | **수정 불필요.** 이 목표를 근거로 job 분리를 정당화하지 마십시오 |
| 새 commit push 시 이전 run 자동 취소 | **✅ 이미 구현** (`pr-fast-gate.yml` L11-13) | — | **단, `secret-history-scan.yml`에는 없음 → P1-2에서 추가** |
| Main/Nightly 전체 Coverage 유지 | 현행 | **✅ 유지** | `e2e.yml`의 `test:e2e:chromium`이 desktop-chromium 전체를 이미 포함. 삭제 없음 |
| 보안·결제·Credit 원장 검사 미약화 | 현행 | **✅ 유지** | Gitleaks(동일 스캔 유지), `security:regression`, unit 464건, Credit preflight E2E 3건 전부 PR Required 유지 |

### 목표 수정 제안

**목표 자체는 모두 현실적이며, 오히려 보수적입니다.** 다만 두 가지를 명확히 합니다.

1. **"정적·Unit 실패 3분 이하"는 이미 1.5분으로 달성되어 있습니다.** 이 목표를 근거로 job 분리(안 B)를 추진할 필요가 없습니다.
2. **"자동 취소"도 PR Fast Gate에는 이미 구현되어 있습니다.** 취소율 10.7%는 이 설정이 정상 동작 중이라는 증거입니다 — 문제가 아니라 의도된 동작입니다.

**추가 권장 목표 (현재 측정되지 않고 있음):**

| 신규 목표 | 근거 |
|---|---|
| **성공 run당 flaky 테스트 = 0건** | 현재 16건. 이것이 재시도로 8분을 태우는 원인이자 실제 결함을 가리는 경로 |
| PR E2E 테스트 수 ≤ 25건 | 스코프가 조용히 다시 부풀지 않도록 상한 고정 |
| main push 회귀 실패 → 알림 ≤ 40분 | PR에서 뺀 312건이 실제로 회귀를 잡는지 보장 |

---

## 12. 안전 조건 준수 확인

| 조건 | 준수 여부 | 근거 |
|---|---|---|
| 단순히 테스트를 삭제해 시간 단축 금지 | ✅ | **312건 중 단 한 건도 삭제하지 않음.** `@smoke` 태그로 PR 티어만 필터링하며, 전체는 `e2e.yml`(main push) + nightly에서 계속 실행 |
| PR에서 빠진 검사를 Main/Nightly에 명시적 재배치 | ✅ | §5.3 재배치 표 참조. `e2e.yml`의 `test:e2e:chromium`이 desktop-chromium 전체를 이미 포함하므로 커버리지 손실 0. 시각 회귀는 P1-4에서 전용 nightly job 신설 |
| 결제·Credit·인증·보안 경로를 Required Gate로 유지 | ✅ | Gitleaks(스캔 범위 동일), `security:regression`, unit 464건(결제·Credit 로직 포함), E2E smoke에 결제 2건 + Credit preflight 3건 + 인증 2건 명시 포함 |
| Cache 실패가 Workflow 실패로 이어지지 않게 | ✅ | 두 cache 스텝에 이미 `continue-on-error: true` 적용됨. **변경하지 않음** |
| Fork PR에서 Secret 노출 방지 | ✅ | 트리거는 `pull_request`(fork에서 secret 미주입, 읽기 전용 토큰). **`pull_request_target`으로 변경하지 않음.** `GITLEAKS_ENABLE_COMMENTS: "false"`로 토큰 쓰기 요구 없음 |
| Workflow 권한 확대 금지 | ✅ | 현재 `actions: read, contents: read, pull-requests: read`. **확대하지 않음.** (Gitleaks 제거 시 `actions: read`도 불필요해지므로 오히려 축소 가능 — 선택) |
| Applied Branch Protection의 Check 이름 변경 위험 표시 | ✅ | §10에 명시. 안 A는 위험 없음, 안 B/C는 집계 job 이름 고정 필수 |
| 로그에서 확인되지 않은 수치는 추정치로 명시 | ✅ | 전 문서에 `[측정]` / `[로컬]` / `[추정]` 표기 |

---

## 13. 실제 구현 전에 확인이 필요한 사항

| # | 확인 항목 | 확인 방법 | 차단성 |
|---|---|---|---|
| **1** | **`develop` / `main`의 required status check 이름 목록** | Settings → Branches. 특히 `Scan repository history for secrets`가 required인지 | 🔴 **차단** — P0-4 전제 조건 |
| **2** | **PR에서 반드시 blocking이어야 하는 E2E 시나리오 확정** | 제품 오너 승인. §4-B의 20건 목록 검토 | 🔴 **차단** — 범위 확정 필요 |
| 3 | `chat-state-visual-regression.spec.ts`의 스냅샷 기준선이 main에서도 안정적인지 | main push run에서 시각 회귀만 별도 실행해 flaky 재현 여부 확인 | 🟡 P1-4 전제 |
| 4 | `mobile-header-model-summary-skeleton`이 실사용자에게도 30초 이상 남는지 | Sentry / 프로덕션 성능 지표 확인. 실사용자 영향이면 P0로 승격 | 🟡 P1-1 우선순위 결정 |
| 5 | `e2e.yml`의 `timeout-minutes: 45`가 확장 후에도 충분한지 | 현재 3 프로젝트로 이미 상당한 시간 소요. 332건 전체 포함 시 상향 필요 여부 | 🟡 P0-2 부수 |
| 6 | CodeQL이 `develop` PR에서 실행되지 않는 것이 의도된 설계인지 | 보안 담당자 확인 | 🟢 별도 티켓 |
| 7 | `Credit Finance DB Integration`의 paths 필터가 모든 Credit 원장 코드를 덮는지 | `lib/credit*.ts` 외 원장 관련 파일 존재 여부 감사 | 🟢 별도 티켓 |
| 8 | Fork PR이 실제로 발생하는 저장소인지 | 발생한다면 Gitleaks가 fork PR에서 정상 통과하는지 로그 확인 | 🟢 확인만 |
| 9 | GitHub Actions 로그 ZIP 다운로드 경로 | 이 감사에서는 프록시가 `results-receiver.actions.githubusercontent.com`을 403으로 차단해 전체 로그 ZIP을 받지 못함. 스텝 타임라인은 Jobs API로, 요약은 Job Logs API로 확보 | 🟢 참고 |

---

## 부록 A. 재현용 명령

`gh` CLI가 설치된 환경에서 이 감사를 재현하려면:

```bash
# 최근 20건 실행시간
gh run list --workflow=pr-fast-gate.yml --limit 20 \
  --json databaseId,conclusion,createdAt,runStartedAt,updatedAt,runAttempt,headBranch

# 특정 run의 스텝별 소요
gh api repos/mposition/Tomverse/actions/runs/<RUN_ID>/jobs \
  --jq '.jobs[] | {name, conclusion,
        steps: [.steps[] | {name, conclusion,
        seconds: ((.completed_at|fromdateiso8601) - (.started_at|fromdateiso8601))}]}'

# 캐시 hit/miss
gh run view <RUN_ID> --log | grep -E "Cache (hit|restored|saved|not found)"

# Playwright flaky / 소요 요약
gh run view <RUN_ID> --log | grep -E "^\s+[0-9]+ (flaky|skipped|passed|failed)"

# Gitleaks 실제 스캔 범위
gh run view <RUN_ID> --log | grep -E "gitleaks detect|commits scanned|leaks found"

# 총 소요 (billable)
gh api repos/mposition/Tomverse/actions/runs/<RUN_ID>/timing
```

이 감사에서 사용한 실제 run ID:

| 목적 | run ID |
|---|---|
| 성공 + flaky 16건 전체 로그 | `30256146044` |
| 성공 + 최장 E2E (19.3분) | `30261847561` |
| 실패 + E2E 20분 | `30262881954` |
| 실패 + ESLint 92초 조기 실패 | `30238668498` |
| Secret History Scan 스캔 범위 증거 | `30262882037` |

## 부록 B. 로컬 측정 환경

`[로컬]` 표기 수치는 다음 환경에서 측정되었습니다. GitHub hosted `ubuntu-latest`(4 vCPU / 16 GB)와 하드웨어가 다르므로 **절대값이 아닌 구성비 근거**로만 사용하십시오.

| 측정 | 값 |
|---|---|
| `npm ci` (npm 캐시 cold, 다운로드 포함) | 58초 |
| `prisma generate` 단독 | 3초 |
| `node_modules` 크기 | 1.6 GB |
| `npm run security:regression` | 0초 |
| `npm run check:encoding:strict` | 2초 |
| `npm run test:unit` | 12초 (464 pass / 0 fail) |
| `eslint . --max-warnings=0` | 34초 |
| `next build` (cold) | 64초 — compile 28.7s / TypeScript 28.6s / static 1.3s |
| `next build` (warm, `.next/cache` 존재) | 58초 — compile 26.2s / TypeScript 26.4s / static 1.0s |
| `.next/cache` 크기 | 828 KB |
| `.next` 전체 크기 | 137 MB |
| 빌드 번들러 | Next.js 16.2.10 (**Turbopack**) |
