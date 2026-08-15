# UI 테스트 실행 tier (UI-008)

이 문서는 **어떤 spec이 어느 CI tier에서 실행되는지**의 단일 기준입니다.
`scripts/security-regression-check.mjs`의 "PR, main, and nightly workflows split
browser coverage without rebuilding E2E" 항목이 이 문서의 존재와 workflow의
실제 step을 함께 검사합니다.

## Tier 요약

| Tier | Workflow | 명령 | 실행 시점 | merge 차단 |
|---|---|---|---|---|
| PR static | `pr-fast-gate.yml` | `npm run check:accent-tokens` (UI-012 역할 token 강제) | 모든 PR | 예 |
| PR contract | `pr-fast-gate.yml` | `npm run test:e2e:smoke` (`--grep=@smoke`, `desktop-chromium`) | 모든 PR | 예 |
| PR high-risk UI | `pr-fast-gate.yml` | `npm run test:e2e:ui-risk` (`--grep=@ui-risk`, `desktop-chromium` + `mobile-chromium`) | 모든 PR | 예 |
| Main regression | `e2e.yml` | `npm run test:e2e:chromium` (필터 없음) | `main` push | 아니오 |
| Nightly visual | `nightly-visual-regression.yml` | `npm run test:e2e:visual -- --retries=0` | 매일 | 아니오 |
| Nightly full | `daily-security-audit.yml` | `npm run test:e2e:run` (chromium + webkit, 필터 없음) | 매일 | 아니오 |

두 PR tier는 같은 `build-and-e2e` job 안에서 같은 build·browser cache를
공유합니다. documentation-only PR은 `scope` step이 두 tier를 함께 건너뜁니다.
`tests/`, `.github/workflows/`, lockfile을 건드리는 변경은 documentation으로
분류되지 않으므로 두 tier가 모두 실행됩니다.

## `@ui-risk` tier 구성

| Spec | 태그된 test | 관련 이슈 | Project |
|---|---|---|---|
| `model-picker-responsive.spec.ts` | `model selection can be finished at 390x844 / 320x568 with the keyboard open`, `the picker footer clears the safe area with no keyboard` | UI-001 | mobile-chromium (desktop은 skip) |
| `analytics-settings-target.spec.ts` | 44px target ×3 route, content intersection ×3 route, keyboard 도달, light/dark AA | UI-002 | 양쪽 |
| `ui-state-contrast.spec.ts` | full/partial error, mobile header·composer, sidebar, desktop model panel의 light/dark AA, 11px floor ×2 | UI-003, UI-007 | desktop-chromium (다른 project는 skip) |
| `korean-typography.spec.ts` | display heading 어절 보존 ×4 viewport, 150% zoom | UI-006 | 양쪽 |
| `pricing-promotion-reflow.spec.ts` | 16개 viewport×zoom×언어 조합의 절대 overflow ≤1px + promotion 귀속 | UI-005 | desktop-chromium |

위 다섯 항목은 UI-001~UI-007 감사에서 tier가 만들어질 때 기록된 것입니다.
그 뒤로 tier는 **표가 아니라 태그로** 정해지므로, spec은 `@ui-risk`를 붙이는
것만으로 합류했고 이 문서는 따라오지 않았습니다. 2026-08-05 대조 시점에
태그된 파일은 25개, 표에 적힌 것은 5개였습니다.

나머지 태그된 spec은 다음과 같습니다. 상세 case 목록 없이 파일만 기록하는
것은 태그가 진실이고 표가 뒤늦기 때문이며, 각 spec의 실제 case는 파일에
있습니다. `npm run check:ui-tier-coverage`가 이 목록과 태그를 양방향으로
맞춥니다.

실측: 2026-08-14 기준 `--grep=@ui-risk --list`가 desktop-chromium과
mobile-chromium 두 project에서 **27개 파일, 638 test**를 선택합니다.

| Spec |
|---|
| `account-flow.spec.ts` |
| `chat-analytics-settings-placement.spec.ts` |
| `chat-memory-context.spec.ts` |
| `comparison-panel-controls.spec.ts` |
| `csp-eval-free.spec.ts` |
| `external-import-settings.spec.ts` |
| `feedback-modal.spec.ts` |
| `keyboard-and-heading-structure.spec.ts` |
| `marketing-language-analytics.spec.ts` |
| `marketing-language-focus.spec.ts` |
| `marketing-toast-host.spec.ts` |
| `menu-and-tab-semantics.spec.ts` |
| `mobile-composer-banner-reflow.spec.ts` |
| `mobile-short-viewport-drawer.spec.ts` |
| `modal-focus-contract.spec.ts` |
| `model-panel-tablet-reachability.spec.ts` |
| `provider-status.spec.ts` |
| `settings-information-architecture.spec.ts` |
| `sidebar-context-menu-theme.spec.ts` |
| `signin-analytics-placement.spec.ts` |
| `skip-link-and-armed-delete.spec.ts` |
| `ssr-root-language.spec.ts` |

검토 시점 실측(2026-08-14, `--list`): **27개 파일 638 test** (두 project 합계).
직전 값은 2026-08-05의 25개 파일 630 test였고, 그 뒤 `csp-eval-free.spec.ts`
(+4)와 `external-import-settings.spec.ts`(+2)가 합류했습니다. 그 이전 기록
"76 test / 14 skip / 67초"는 표에 적힌 5개 파일만 세던 시점의 값입니다. 이
tier는 merge를 차단하므로, PR tier 비용을 근거로 무언가를 빼거나 넣는 판단은
위 숫자를 다시 재고 나서 합니다.

`external-import-settings.spec.ts`는 2026-08-14에 합류했습니다(27개 파일,
+2 test — desktop·mobile 각 1). 태그된 것은 그 파일의 한 case뿐입니다:
`an HTML export is told how to fix it, not that it is unreadable`. Google
Takeout은 My Activity를 JSON 또는 HTML로 내보내고 JSON만 지원하는데, HTML을
고른 사용자는 **파일 선택기에서 자기 파일을 고를 수조차 없었고** 일반 "읽을 수
없음"만 봤습니다. 고칠 방법을 아는 유일한 실패가 고칠 수 없는 실패로 보인
것입니다. 계약은 두 가지 — `accept`에 `.html`이 있을 것, 그리고 화면이 "JSON
형식으로 다시 내보내라"고 말할 것 — 이며 둘 다 브라우저에서만 확인됩니다.
무태그로 두면 `main` push의 무필터 실행에서만 잡히는데, 이 회귀는 PR로
들어옵니다.

`csp-eval-free.spec.ts`는 2026-08-13에 합류했습니다(26개 파일, +4 test).
이 tier의 다른 spec과 달리 UI 감사가 아니라 CSP 계약에서 왔습니다 — 클라이언트
번들이 `eval`을 부르지 않는다는 것은 브라우저에서만 확인되는 사실이고, 이를
깨뜨리는 변경(`lib/csp.ts`의 지시문 완화, `instrumentation-client.ts` 삭제,
eval probe를 다시 들여오는 의존성)은 PR로 들어옵니다. 무태그로 두면 `main`
push의 무필터 실행에서만 잡히는데, 승격 후에 말하는 보안 계약은 늦습니다.

## PR tier에 두지 않는 것과 그 이유

- `chat-state-visual-regression.spec.ts` (63 golden). PR에서 제거한 성능 근거가
  유효하고, security regression 검사가 이 파일 이름이 `pr-fast-gate.yml`에
  다시 등장하는 것을 금지합니다. golden은 main push와 nightly에서
  `--retries=0`으로 first-run 검증됩니다.
- `--update-snapshots`는 어떤 tier에서도 사용하지 않습니다. 같은 검사에서
  `pr-fast-gate.yml`과 `nightly-visual-regression.yml` 양쪽에 대해 부재를
  검사합니다.
- webkit은 nightly 전용입니다. PR tier는 Chromium만 설치합니다.

## Tier에 test를 추가할 때

1. `@smoke`는 manifest 기반입니다. `scripts/verify-smoke-coverage.mjs`의
   `MANIFEST`에 등록하지 않은 test에 태그를 붙이면 gate가 실패합니다.
2. `@ui-risk`는 manifest가 없는 대신 이 문서의 표를 갱신합니다. 태그를 붙이기
   전에 `npx playwright test --project=desktop-chromium --project=mobile-chromium --grep=@ui-risk --list`로
   실제 실행 대상과 시간을 확인하고, 위 실측값을 갱신합니다.
3. mobile/coarse-pointer 측정에는 `hasTouch: true`가 필요합니다. viewport 폭만
   줄인 desktop project 결과는 44px 근거로 인정하지 않습니다
   (`useIsMobileShell`은 `(max-width: 767px) AND (pointer: coarse)`).
