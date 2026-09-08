# Daily Security Audit 실패 분석 — secret scan과 production 의존성 감사 (2026-09-08)

대상 run: [#62 · 34169714126](https://github.com/mposition/Tomverse/actions/runs/34169714126)
(schedule, `main` @ `ba1adcf`, 2026-09-07 23:20:37Z ~ 2026-09-08 00:10:33Z)

## 1. 무엇이 실패했나

`Enforce security audit result`가 exit 1로 끝났고, 빨간 항목은 둘입니다.

```
##[error]Secret history scan finished with status failure.
##[error]Production dependency audit finished with status failure.
```

나머지 10개 — node setup, install, security regression, unit·API policy tests,
strict encoding, typecheck, ESLint·production build, Playwright browser setup,
6개 shard 전부의 E2E, report delivery — 는 `success`입니다. 2026-09-01의
E2E 예산 초과(`daily-security-audit-e2e-timeout-2026-09-01.md`)는 sharding
이후 재발하지 않았습니다.

두 step 모두 `continue-on-error`라 job 자체는 초록이고, 결과는 `outputs`로만
report job에 전달됩니다. 각 step의 로그 본문은 runner의 blob storage에 있어
이 컨테이너에서 읽을 수 없었으므로, **둘 다 로컬에서 같은 명령으로 재현해
원인을 확정했습니다.**

## 2. Secret history scan — develop 전용 commit이 main run을 붉게 만들었습니다

gitleaks 8.30.0으로 전체 이력(2,221 commits)을 스캔한 결과 2건입니다.

```
generic-api-key 866e0693 scripts/ops/Test-InvokeMobileAuthDeploymentVerify.ps1:205
generic-api-key 866e0693 scripts/ops/Test-InvokeMobileAuthDeploymentVerify.ps1:206
```

해당 줄은 PowerShell 자체 테스트가 wrapper의 pre-injection 경로를 검증하려고
넣은 가짜 ring 값입니다.

```powershell
$injected = Invoke-Wrapper -Preinjected -Inject @{
    MOBILE_AUTH_SIGNING_KEYS = <"INJECTED-SIGNING-" 뒤에 hex 6자리>
    MOBILE_AUTH_REFRESH_PEPPERS = <"INJECTED-PEPPER-" 뒤에 hex 6자리>
}
```

(값은 일부러 그대로 옮기지 않았습니다. 이 보고서가 같은 모양을 한 줄로 쓰면
보고서 자신이 다음 finding이 됩니다 — 첫 초안이 실제로 그랬습니다.)

어느 값도 무언가를 서명하거나 pepper한 적이 없고, 실제 ring은 `op run`을
통해서만 프로세스에 도달합니다. 그러나 `<KEY 이름> = "<고엔트로피 문자열>"`은
scanner가 자격증명으로 읽어야 하는 모양이며, 그 판단은 옳습니다.

**왜 main run이 실패했나.** 이 파일은 `main`에 없습니다. commit `866e069`는
2026-09-03에 `develop`에만 올라갔습니다. 그런데 이 workflow는
`fetch-depth: 0`으로 checkout하고, 그 설정은 **모든 ref**를 받아 옵니다.
gitleaks는 `--all`로 이력을 걷기 때문에 develop의 commit도 main run에서
스캔되며, 그래서 `main`의 SHA가 바뀌지 않았는데도 2026-09-04부터 매일
같은 이유로 붉었습니다. 이 사실은 이번 분석에서 처음 확인된 것이고, 앞으로
develop에 들어간 어떤 finding도 main의 nightly에 즉시 나타난다는 뜻입니다.

**수정.** `.gitleaksignore`에 그 commit의 두 fingerprint를 **정확히 그 범위로**
고정했습니다. 저장소 관례대로 allowlist regex를 넓히지 않았습니다 — 이
config의 allowlist는 `regexTarget = "line"`이라 패턴 하나가 소스 한 줄 전체를
무시할 권한이고, 이미 한 번 그 방식으로 실제 자격증명 모양을 덮은 전력이
있습니다(SEC-009).

**develop 쪽 후속.** fingerprint는 commit에 묶이므로, 그 두 줄을 다시 편집하는
다음 commit은 같은 finding을 새 fingerprint로 다시 만듭니다. 그래서 develop
PR은 같은 줄을 `("INJECTED-SIGNING", "e31f80") -join "-"`처럼 조각으로
조립하도록 바꿔 모양 자체를 쓰지 않습니다 — `tests/assistantPackageReview.test.mjs`
의 `forge()`와 같은 방식이고, 값은 그대로입니다. main에는 그 파일이 없어
main PR은 fingerprint만 싣습니다.

## 3. Production dependency audit — pin 하나가 advisory 안으로 들어갔습니다

`npm audit --omit=dev`가 high 4·moderate 2, 총 6건을 보고했습니다.

| 패키지 | 설치됨 | advisory | 경로 | 조치 |
|---|---|---|---|---|
| `fast-uri` | 3.1.5 | GHSA-5jgf-p345-68v8, GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf, GHSA-jqff-g426-hqxp (high, `<3.1.6`) | `ajv@8` ← `@prisma/streams-local`·`ajv-formats`·`schema-utils` | override `"3.1.5"` → `"^3.1.6"`, 해석 3.1.7 |
| `mysql2` | 3.15.3 | GHSA-3f6p-5ww8-9rcr (high, `<3.22.0`), GHSA-rgwj-5xj2-c3m3 (moderate, `<=3.23.0`) | `prisma@7.9.1`이 **정확히 3.15.3으로 고정** | override `prisma.mysql2: "^3.23.1"`, 해석 3.24.3 |
| `prisma` | 7.9.1 | 위 mysql2를 통해 moderate | direct | mysql2가 풀리면서 함께 해소 |
| `browserslist` | 4.28.5 | GHSA-c83g-rgw3-j3cx, GHSA-73wf-gq98-2v4g (high, `<=4.28.6`) | `@babel/helper-compilation-targets`·`webpack`·`update-browserslist-db` | `npm update`, 4.28.9 |
| `@xmldom/xmldom` | 0.9.10 | GHSA-6gmq-8vp8-gcm6 (moderate, `<=0.9.11`) | `officeparser ^0.9.10` | `npm update`, 0.9.12 |

두 가지가 눈에 띕니다.

**`fast-uri`는 같은 실수의 두 번째입니다.** 2026-08-06의 `e07efe57`이 override를
`"3.1.4"`에서 `"3.1.5"`로 올리면서 "pin은 버전을 붙잡아 둘 뿐 안전하게
붙잡아 두지는 않는다"고 적었는데, 그 commit 자신도 정확한 pin을 남겼고 그
pin이 이번에 advisory 안으로 들어갔습니다. 이번에는 **바닥(`^3.1.6`)**으로
바꿔서, lockfile을 다시 만들 때 3.x 안의 후속 patch가 자동으로 따라오게
했습니다. `ajv@8`이 요구하는 범위는 `^3.0.1`이라 4.x로는 올릴 수 없습니다.

**`mysql2`는 npm이 제안한 수정이 다운그레이드입니다.** `fixAvailable`이
`prisma@6.19.3 (semver major)`인데, 7.x 전부(7.10.0 포함)가 mysql2를 3.15.3에
정확히 고정하고 있어서입니다. 이 앱은 PostgreSQL(`@prisma/adapter-pg`)만 쓰고
mysql2는 prisma CLI의 로컬 개발 도구 경로에만 실리므로, prisma 범위 안에서
mysql2만 override했습니다(`@prisma/config`의 `deepmerge-ts` override와 같은
꼴). 3.24.3은 내부 의존을 `denque`·`seq-queue`·`sqlstring`에서 `sql-escaper`로
바꾸는데, 이 앱의 어느 코드 경로도 그것을 지나지 않습니다. `prisma --version`과
`prisma validate`는 그대로 통과합니다.

## 4. 검증

| 검사 | 결과 |
|---|---|
| `npm audit --omit=dev` | 0건 (dev 포함 `npm audit`도 0건) |
| gitleaks 8.30.0, 전체 이력 2,221 commits | no leaks found |
| `npm run security:regression` | 188 checks passed |
| `node --test tests/gitleaksAllowlist.test.mjs` | 3 pass |
| `npm run test:unit` | pass |
| `npm run typecheck` | pass |
| `npm run check` (ESLint + production build) | pass |
| `npm run check:encoding:strict` | pass |
| `npx prisma validate` | valid |

## 5. 병합

이 변경은 `main`과 `develop` 양쪽에 필요합니다. nightly는 `main`에서 돌고,
develop의 lockfile도 같은 네 버전(mysql2 3.15.3, fast-uri 3.1.5, browserslist
4.28.5, xmldom 0.9.10)을 안고 있습니다.

- `package.json`: develop이 main보다 앞서 있지만(`apps/*` workspace, script
  추가) `overrides` 블록은 두 branch가 동일하므로 그대로 적용됩니다.
- `.gitleaksignore`·이 보고서: 두 branch 모두 충돌 없습니다.
- `package-lock.json`: develop은 prisma 7.10.0이고 main은 7.9.1이라 **develop
  쪽 병합에서는 충돌합니다.** 손으로 맞추지 않습니다 — develop의 lockfile을
  택한 뒤 `npm install --no-audit --no-fund && npm update browserslist
  @xmldom/xmldom`을 다시 돌리면 `package.json`의 override가 같은 네 버전으로
  다시 해석합니다. 확인은 `npm audit --omit=dev`가 0건인지 봅니다.
