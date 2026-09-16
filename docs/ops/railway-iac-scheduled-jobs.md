# Railway cron 서비스: Config as Code → Infrastructure as Code 전환

- 작성: 2026-09-17 (Claude). 상태: **저장소 준비 완료, Railway 적용 전**
- 기한: **2026-12-01** — Railway가 `railway.json`·`railway.toml`(Config as Code)을 읽지 않기 시작하는 날
  ([docs.railway.com/config-as-code](https://docs.railway.com/config-as-code))
- 대상: cron 서비스 5개 × 환경 2개(staging, production). 웹 서비스 `Tomverse`는 **대상이 아닙니다.**

## 1. 왜 해야 하는가

2026-09-17에 두 환경의 최근 배포 메타데이터를 읽어 확인한 사실입니다.

| 서비스 | 설정 파일(Config File Path) | 대시보드에 저장된 값 |
|---|---|---|
| Maintenance Cron | `/railway.maintenance.json` | start·cron·restart 모두 **비어 있음** |
| Credit Reconciliation | `/railway.credit-reconciliation.json` | 비어 있음 |
| Provider Probe | `/railway.provider-probe.json` | 비어 있음 |
| Provider Model Catalog | `/railway.provider-model-catalog.json` | 비어 있음 |
| Provider Usage Sync | `/railway.provider-usage-sync.json` | 비어 있음 |

다섯 서비스의 시작 명령과 cron 일정은 **저장소의 JSON 파일에서만** 옵니다. 2026-12-01 이후 첫 배포부터
이 값이 사라지면 서비스는 cron 없이 기본 시작 명령으로 뜹니다. 그러면 크레딧 예약 환급, 보존기간
정리, provider probe, 일일 보고가 멈춥니다. 크레딧 환급이 멈추는 것은 고객 잔액에 바로 보입니다.

## 2. 무엇이 바뀌었나 (이 PR)

| 파일 | 역할 |
|---|---|
| `.railway/scheduled-jobs.ts` | cron 서비스 표(서비스 이름, 시작 명령, cron, **환경별 변수 이름 목록**)와 그 표로 리소스 목록을 만드는 `buildScheduledJobResources()`. SDK 의존성 없음 — 테스트가 SDK 없이 이 함수를 직접 실행합니다 |
| `.railway/railway.ts` | SDK 함수를 `buildScheduledJobResources()`에 넘기기만 하는 진입점. `export const partial = "scheduled-jobs"`. 목록을 거르거나 덧붙이는 코드는 테스트가 거절합니다 |
| `.railway/run.mjs` | 설치된 Railway CLI를 찾아 버전(≥ 5.42.1)을 확인하고 실행합니다 |
| `.railway/package.json` | Railway TypeScript SDK(`railway` 3.11.0)만 고정. 앱 빌드·workspace와 무관 |
| `lib/scheduledJobsCore.ts`, `tests/scheduledJobsCore.test.mjs` | 관리 화면 일정표를 JSON 파일 대신 IaC 표와 대조. **JSON 파일이 남아 있는 동안은 IaC 표와 같아야** 통과 |
| `scripts/security-regression-check.mjs` | cron 확인 3건을 IaC 표 기준으로 |

`railway.*.json` 5개는 **아직 지우지 않습니다.** Railway가 지금 그 파일로 cron을 돌리고 있기 때문입니다.
4절을 두 환경에서 끝낸 뒤 별도 PR로 지웁니다(5절).

### 왜 partial인가

IaC apply는 **파일이 소유한 것 중 선언하지 않은 것을 삭제합니다**("omit means delete",
[docs.railway.com/infrastructure-as-code](https://docs.railway.com/infrastructure-as-code)).
프로젝트 전체 파일로 만들면 웹 서비스의 변수 160여 개와 도메인까지 이 파일이 소유하게 되고,
대시보드에서 변수를 하나 추가한 뒤 apply를 한 번 하면 그 변수가 지워집니다. partial은 파일이 선언한
cron 서비스 5개만 소유합니다. 2026-09-17 plan에서 웹 서비스 변경은 0건이었습니다.

partial 이름(`scheduled-jobs`)은 첫 apply 뒤에 **바꾸지 않습니다.** 소유 기록이 이름에 묶입니다.

## 3. 사람이 지켜야 할 규칙

- **cron 서비스에 대시보드로 변수를 추가하면, 같은 이름을 `.railway/scheduled-jobs.ts`에도 추가합니다.**
  빠뜨리면 다음 apply가 그 변수를 지웁니다. plan에 `- Delete variable`이 보이면 **apply하지 말고** 이름을 추가합니다.
- **cron 서비스를 표에서 빼면 apply가 그 서비스를 삭제합니다.** 서비스를 없애는 것이 목적일 때만 뺍니다.
- apply는 사람이 실행합니다. CI에 apply를 두지 않습니다.
- 모르는 환경(PR 환경 등)은 `railway.ts`가 오류로 거절합니다. 빈 변수 목록으로 plan하면 모든 변수를 지우는 계획이 나오기 때문입니다.

## 4. 적용 절차 (환경마다 한 번, staging 먼저)

**실행 위치:** 로컬 PC의 PowerShell, Tomverse clone 폴더 안(이 PR이 병합된 `develop`, production은 `main`).
**필요한 것:**
- Node 22
- Railway CLI **5.42.1 이상**(`railway --version`으로 확인, 낮으면 `railway upgrade`)
- `railway login`으로 로그인된 상태

production 자격증명을 대화나 파일에 붙일 일은 없습니다.

### 4.1 준비 (읽기 전용)

```powershell
npm run railway:iac:install
npm run railway:iac:use-staging
npm run railway:iac:plan
```

`use-staging`은 이 PC의 Railway CLI 연결 대상만 바꿉니다(`.railway` 폴더 기준). 서버에는 아무것도 쓰지 않습니다.

**plan 결과가 정확히 이래야 다음으로 갑니다.**

```text
Environment staging
Plan: 0 to add, 5 to change, 0 to destroy
```

각 서비스에 `deploy.cronSchedule`, `deploy.restartPolicyType`, `deploy.startCommand`가 `null →` 값으로
바뀌는 줄만 있어야 합니다. `destroy`가 0이 아니거나 `Delete variable`이 있으면 멈추고 3절을 봅니다.

### 4.2 apply (쓰기)

```powershell
npm run railway:iac:apply
```

- **바뀌는 것:** 다섯 cron 서비스의 대시보드 설정에 시작 명령·cron·restart 정책이 저장됩니다. 값은 지금 JSON 파일과 **같으므로** 동작은 바뀌지 않습니다(설정 파일이 여전히 우선).
- **되돌리기:** 대시보드에서 세 칸을 다시 비우면 됩니다. JSON 파일이 계속 우선이므로 되돌리지 않아도 해가 없습니다.

**apply 뒤 4.3으로 가기 전에 반드시 plan을 한 번 더 실행합니다.**

```powershell
npm run railway:iac:plan
```

`Your Railway configuration is already up to date.`(또는 `0 to change`)가 나와야 4.3으로 갑니다.
이것이 "대시보드에 값이 들어갔다"는 증거입니다. 이 증거 없이 설정 파일 연결을 끊으면, 다음 배포는
JSON도 읽지 않고 대시보드 값도 비어 있어 **cron 없이** 뜹니다.

#### apply가 거절되면: 4.3으로 가지 않습니다

apply가 "Config as Code로 관리 중인 서비스" 같은 이유로 거절되면 **설정 파일 연결을 먼저 끊지 않습니다.**
대신 설정 파일이 아직 연결된 상태에서 대시보드에 같은 값을 손으로 넣습니다. 설정 파일이 우선이므로
이 단계에서는 동작이 바뀌지 않습니다.

1. 각 cron 서비스 → **Settings**에서 다음 세 칸을 `.railway/scheduled-jobs.ts`의 값으로 채웁니다.
   - 시작 명령(Custom Start Command) = `startCommand`
   - Cron Schedule = `cronSchedule`
   - Restart Policy = Never
2. staged changes를 **Deploy**합니다.
3. `npm run railway:iac:plan`이 `0 to change`를 보일 때 4.3으로 갑니다. plan도 거절되면 멈추고
   이 문서를 고친 뒤 진행합니다.

`railway config migrate --apply`는 쓸 수 없습니다. 이름이 정확히 `railway.json`·`railway.toml`인 파일만
찾기 때문에 이 저장소의 `railway.*.json`을 발견하지 못합니다(2026-09-17 실행 확인).

### 4.3 설정 파일 연결 끊기 (대시보드, 서비스마다)

Railway 대시보드 → 프로젝트 `Tomverse` → 환경 선택 → 각 cron 서비스 → **Settings**에서 설정 파일 경로 칸(Config File Path, 현재 `/railway.*.json`이 들어 있는 칸)을 비웁니다. 화면의 정확한 이름은 Railway UI 변경에 따라 다를 수 있으니 값으로 찾습니다. 서비스 5개 모두 합니다.
화면에 staged changes가 뜨면 **Deploy**로 반영합니다.

### 4.4 확인 (읽기 전용)

```powershell
npm run railway:iac:plan
```

`Your Railway configuration is already up to date.`(또는 `0 to change`)가 나와야 합니다.
그다음 각 서비스의 새 배포에서 **Details**의 start command·cron schedule 옆에 파일 아이콘이 없고, 값이 `.railway/scheduled-jobs.ts`의 `startCommand`·`cronSchedule`과 같은지 봅니다(1절 표의 "비어 있음"은 전환 **전** 상태입니다).
다음 cron 시각 이후 Admin Console → Scheduled Jobs에서 해당 job이 `delayed`가 아닌지 확인합니다.

### 4.5 production

`main`에 이 변경이 들어간 뒤 `npm run railway:iac:use-production`으로 바꾸고 4.1–4.4를 반복합니다.
끝나면 `npm run railway:iac:use-staging`으로 되돌려 두는 편이 안전합니다.

## 5. 두 환경을 마친 뒤 (별도 PR)

- `railway.*.json` 5개를 **한 커밋에서 함께** 삭제. `tests/scheduledJobsCore.test.mjs`의 legacy 대조 테스트는 다섯 파일이 모두 있거나 모두 없어야 통과합니다. 하나만 먼저 지우면 실패합니다.
- `README.md` "Scheduled Maintenance"와 코드 주석에서 JSON 파일 경로를 가리키는 문장 정리.
  `.github/audits/`·검증 기록의 과거 인용은 **기록이므로 고치지 않습니다.**

## 6. 기록

| 환경 | plan 확인 | apply | 설정 파일 해제 | 확인 | 실행자 |
|---|---|---|---|---|---|
| staging | 2026-09-17 plan: 0 add / 5 change / 0 destroy (Claude, 읽기 전용) | 미기록 | 미기록 | 미기록 | |
| production | 2026-09-17 plan: 0 add / 5 change / 0 destroy (Claude, 읽기 전용) | 미기록 | 미기록 | 미기록 | |
