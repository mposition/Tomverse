# dev · Test · production 배포 lane

- 작성: 2026-10-07 (Claude). 결정: 운영자, 2026-10-07 (dev 환경 도입 3단계).
- release 경로의 규범은 `.github/RELEASE_CHECKLIST.md` 7.9이고, 이 문서는 그 절차와 한 번만 하는 전환을 적습니다.

## 1. 세 환경

| 환경 | 주소 | 배포하는 브랜치 | 브랜치를 움직이는 것 |
|---|---|---|---|
| dev | `dev.tomverse.app` | `develop` | 모든 병합. merge train은 dev 배포가 끝나기를 기다립니다 |
| staging(사람에게는 Test) | `staging.tomverse.app` | `test` | `npm run promote:test`만(관례이며 ruleset은 없습니다) |
| production | `tomverse.app` | `main` | release PR |

Railway 환경 이름과 앱의 환경 판정(`lib/deploymentEnvironment.ts`)은 `staging` 그대로입니다. Test 전용 게이트
(마케팅 webhook shadow, prompt refiner stage 등)는 계속 staging에서만 동작하고 dev에서는 동작하지 않습니다.

## 2. release candidate를 Test에 올리기 (매번)

**실행 위치:** 로컬 PC의 PowerShell, Tomverse clone 폴더 안. Node 22와 `npm ci`, `mposition/Tomverse` push 권한,
`gh` 로그인이 필요합니다. production 자격증명은 필요 없습니다. **쓰기**입니다: `test` 브랜치를 옮기고, Test가
그 commit으로 재배포됩니다.

```
npm run promote:test -- --sha=<develop 병합 commit> --dry-run
npm run promote:test -- --sha=<develop 병합 commit>
```

- 받는 것: `develop`이 실제로 가리켰던 commit(first-parent 이력 — 병합 commit). PR head나 병합된 브랜치 안의 commit은
  dev가 돌린 적 없는 tree라서 거절합니다. 선택 release는 `--source=release/<date>-<subject>`.
- 거절하는 것: GitHub Actions suite가 하나라도 성공하지 않은 commit(취소 포함 — Railway Wait for CI가 그 배포를
  SKIPPED로 만듭니다), 지금 후보를 버리는 이동(`--allow-rewind`가 없으면).
- push는 읽은 `test`에 lease를 걸므로, 그 사이 누가 옮겼으면 덮어쓰지 않고 거절합니다.
- push 뒤 Test의 `/api/build-info`가 그 SHA를 말할 때까지 기다립니다(기본 45분, `--no-wait`로 생략).
- **되돌리기:** 이전 SHA로 같은 명령에 `--allow-rewind`.

## 3. 한 번만: staging을 `test`로 전환

**선행 조건**

- 이 변경(merge train·IaC 표·drift·`promote:test`)이 `develop`에 병합돼 있고, 로컬 clone이 그 `develop`입니다.
- QA Release Merge Lane이 돌고 있지 않습니다. 2026-10-07 현재 그 서비스는 Railway에 없습니다. 있다면 develop lane
  스위치를 끄는 revision을 먼저 기록합니다 — 그 lane은 staging에서 develop 배포를 기다리므로 전환 뒤 15분이면
  latch합니다(docs/policy/qa-release-agent.md §8, 대상 환경 개정 전까지).

**순서** (2~4는 이어서 합니다. 사이에 staging이 develop의 새 병합을 배포하면 전환이 그만큼 되돌아갑니다)

1. **[Cloudflare Zero Trust 대시보드 → Access → Applications]** dev의 bypass 앱이 staging과 같은 다섯 경로를
   덮는지 확인합니다: `/robots.txt`, `/api/internal`, `/api/billing/webhook`, `/api/webhooks`, `/api/build-info`
   (`docs/ops/staging-access-boundary.md`). staging은 앱이 둘입니다 — 호스트 전체(Allow, 운영자 이메일)와 이 다섯
   destination을 묶은 앱(Bypass, Everyone). **staging의 bypass 앱은 UI 한도인 destination 다섯 개가 이미 차 있어서**
   dev 경로를 거기에 더할 수 없으므로, dev는 자기 bypass 앱(같은 다섯 경로, 호스트 `dev.tomverse.app`)을 갖습니다.
   `/api/build-info`가 없으면 매시 drift 보고가 dev를 unknown으로 보고, `/robots.txt`가 없으면
   `check:edge-robots`가 실패합니다. 확인: 로컬 PowerShell에서
   `npm run report:deployed-commit-drift -- --environment=dev --fetch`가 dev의 commit을 읽는지.
2. **[브라우저 — 읽기]** `https://staging.tomverse.app/api/build-info`의 `commitSha`를 읽습니다.
3. **[로컬 PowerShell — 쓰기]** 그 SHA로 `test`를 만듭니다. 첫 실행은 `create`이고, lease는 `test`가 아직 없어야
   통과합니다.
   ```
   npm run promote:test -- --sha=<2의 commitSha> --no-wait
   ```
4. **[Railway 대시보드 — 쓰기]** 각 서비스의 Settings → Source → Branch를 `test`로 바꿉니다.
   - 프로젝트 `Tomverse`, 환경 `staging`: `Tomverse`, `Credit Reconciliation`, `Maintenance Cron`,
     `Provider Model Catalog`, `Provider Probe`, `Provider Usage Sync`.
     `Tomverse AMUX Validation 2026-09-21`은 자기 release 브랜치에 둡니다(4단계 정리 대상).
   - 프로젝트 `Tomverse Agents`, 환경 `staging`: `Product Research Observation`, `Product Research Probe`.
5. **IaC apply로 전환하지 않습니다.** 표는 이미 `test`라서 나중의 plan에는 브랜치 차이가 없어야 합니다. 2026-10-07의
   staging plan은 그 환경에 없는 서비스를 **새로 만듭니다** — `railway:iac`는 Marketing Publisher, `railway:agents`는
   QA Release Digest·QA Release Monitor·Billing Finance Ops Deadline. 그 생성은 별개 결정입니다.
6. **확인:** `npm run report:deployed-commit-drift -- --fetch`에서 staging은 `test`, dev는 `develop`과 맞습니다.
   Railway에서 staging `Tomverse`의 새 배포가 `test`의 SHA로 `SUCCESS`인지 봅니다.
   **첫 관측을 아래에 적습니다** — 이미 끝난 suite만 가진 commit을 Railway Wait for CI가 바로 배포하는지는 이 전환 전에
   확인된 적이 없습니다.

   ```
   전환 일시(UTC):          ____________________
   test 첫 SHA:             ____________________
   Wait for CI 동작:        ____________________  (WAITING이 몇 분, 또는 즉시)
   확인한 사람:             ____________________
   ```

**되돌리기:** 4의 서비스들 Branch를 `develop`으로 되돌립니다. `test`는 남겨 둬도 아무것도 읽지 않습니다. merge
train은 이 변경 이전의 script로 돌리면 staging을 기다립니다.

## 4. 전환 뒤 알려진 것

- **매시 drift workflow는 `main`의 script를 돌립니다.** 이 변경이 `main`에 닿기 전까지 staging을 `develop`과
  비교해 빨간불이 날 수 있고 dev는 보지 않습니다. 다음 release로 해소됩니다.
- **IaC apply의 checkout.** staging cron은 `test`의 코드를 돌리므로 staging apply는 `origin/test` checkout에서 합니다
  — 단 `test`가 이 변경을 담은 뒤부터입니다(그 전의 표는 staging을 `develop`이라고 말합니다). 어느 환경이든 plan이
  서비스 생성이나 삭제를 보이면 apply하지 않습니다.
- **정책 개정을 기다리는 둘:** QA Release Merge Lane의 대상(docs/policy/qa-release-agent.md §8)과 feedback
  auto-fix의 승격 관측(docs/policy/trace-feedback-automation.md §9.3)은 아직 staging을 봅니다. 둘 다 2026-10-07
  현재 운영되지 않습니다.
