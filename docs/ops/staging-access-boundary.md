# staging 접근 경계 — 열린 항목

**상태: Access 켜짐 (2026-08-26). 실제 호출 확인만 남았습니다.**
§0에 결정과 남은 순서가 있습니다. §1~§3은 결정에 이르기까지의 조사이고,
§3의 저울질은 §0이 뒤집은 부분이 있으므로 §0을 먼저 읽으십시오.

## 0. 결정 (2026-08-26)

§4의 네 질문에 답이 모였습니다.

| 질문 | 답 |
|---|---|
| staging에 실제 사용자 데이터가 있는가 | **없음.** DB가 production과 완전히 분리 |
| Cloudflare Access가 이 플랜에서 되는가 | **됨** |
| 어떤 인바운드 호출자가 살아야 하는가 | 아래 세 접두어 전부 |
| `check:edge-robots`를 유지하는가 | **유지.** 게이트를 인식하도록 고침 |

**Cloudflare Access 단독으로 갑니다.** 앱 레벨(§3.B)은 채택하지 않습니다.

### §3의 저울질에서 두 가지가 틀렸습니다

**bypass를 "가장 민감한 지점에 뚫는 구멍"이라고 쓴 것은 과장입니다.** 실제 경로를
확인하니 셋뿐이고, 전부 **이미 호출자를 암호학적으로 검증합니다**:

| bypass | 자체 인증 |
|---|---|
| `/api/internal/*` | 크론 3종이 전부 이 접두어 하나 아래 있습니다 (`MAINTENANCE_SECRET` 등) |
| `/api/billing/webhook` | Stripe 서명 |
| `/api/webhooks/*` | Resend 자체 검증 |

Access를 빼는 것은 자물쇠를 없애는 게 아니라 **이미 잠긴 문에 두 번째 자물쇠를 안
다는 것**입니다. 그리고 대시보드에 흩어지는 목록도 아닙니다 — 규칙 세 줄입니다.

**§3.B가 "조각이 이미 있다"고 한 것도 정확하지 않습니다.** `proxy.ts`와
`lib/originProtection.ts`에 있는 것은 *거절* 판정이지 *인증* 이 아닙니다. 앱 레벨로
가면 staging용 로그인을 새로 만들어야 하고, 빌려 쓸 수 있는 SSO를 두고 인증 코드를
직접 짜는 것은 나쁜 거래입니다.

### 순서 — 검사 수정이 먼저입니다

Access를 켜면 `/`가 게이트 뒤로 들어가고, 그때 `check:edge-robots`가 `X-Robots-Tag`를
읽을 응답을 못 받습니다. 그래서:

1. **검사 수정을 먼저 배포합니다.** 게이트(401·403, 또는 로그인 호스트로 나가는
   리다이렉트)를 `noindex`와 **동등 이상**으로 인정하도록 했습니다 — `noindex`는
   요청이고 403은 아니므로, 게이트가 더 강한 신호입니다. `/robots.txt`는 게이트 뒤로
   보내지 않습니다: 인증 없이 읽히는 것이 존재 이유인 파일이고, 크롤러에게는 403보다
   올바른 `Disallow: /`가 낫습니다. 검사는 `/robots.txt`가 200이 아니면 실패합니다.
2. Cloudflare Access를 켭니다. 정책은 운영자 이메일. bypass는 위 세 접두어.
3. `npm run check:edge-robots -- https://staging.tomverse.app` 과
   `-- https://tomverse.app` 을 둘 다 통과시킵니다. staging 쪽은 `/`가 게이트 뒤임을
   `Note:` 로 알립니다.
4. Stripe test mode 결제와 크론 한 바퀴가 staging에서 여전히 도는지 확인합니다.

검사는 401, 403, 그리고 다른 호스트로 나가는 3xx를 인식하고 **그 밖의 것은
실패시킵니다** — 모르는 응답에 통과를 주지 않는 방향으로 틀리게 해 뒀습니다.

### 켜고 나서 확인된 것 (2026-08-26)

**켰습니다.** 애플리케이션 둘 — 호스트 전체(Allow, Include Emails)와 bypass
destination 4개를 묶은 앱(Bypass, Everyone) — 으로 구성했습니다. Cloudflare UI가
앱당 destination을 다섯 개까지 허용하므로 경로마다 앱을 만들 필요는 없었습니다.

켜기 전까지 모른다고 적어 뒀던 두 가지에 답이 나왔습니다.

**Access는 302로 거절합니다.** 로그인 호스트로 나가는 리다이렉트이고, 검사가
인식하는 세 형태 중 하나입니다. `check:edge-robots` 가 통과하며
`Note: / is behind an access gate on https://staging.tomverse.app (status 302).` 를
출력합니다.

**Path는 접두어로 매칭됩니다.** 이것이 실제로 중요했습니다 — 크론이 치는 주소는
`/api/internal` 이 아니라 `/api/internal/maintenance/cleanup` 이고, Resend는
`/api/webhooks/email/resend` 입니다. 정확히 일치해야 하는 방식이었다면 둘 다
막혔을 것입니다. 서명 없는 요청으로 확인한 결과:

| 경로 | 응답 | 낸 주체 |
|---|---|---|
| `/` | 302 | Access |
| `/robots.txt` | 405 (POST라서) | 앱 |
| `/api/internal/maintenance/cleanup` | 401 | 앱의 시크릿 검사 |
| `/api/webhooks/email/resend` | 503 `Email webhook is not configured` | 앱 |
| `/api/billing/webhook` | 503 `Stripe webhook is not configured` | 앱 |

401·503은 전부 앱 자신의 거절이므로 **요청이 원본까지 갔다**는 증거입니다.
Access가 막았다면 `/` 처럼 302가 왔을 것입니다.

### Railway 생성 도메인은 이미 막혀 있습니다 — 그런데 코드가 아니라 변수로

`tomverse-staging.up.railway.app` 은 Cloudflare를 거치지 않으므로 살아 있으면
Access를 통째로 우회합니다. 확인 결과 **421 `Misdirected Request`** 를 반환합니다 —
`proxy.ts`의 `blockedOriginResponse()` 가 내는 바로 그 응답이고,
`isAllowedRequestHost()` 가 실패했다는 뜻입니다. 그 호스트가 staging의
`ALLOWED_REQUEST_HOSTS` 에 없습니다.

`REQUIRE_CLOUDFLARE_ORIGIN_SECRET` 과는 무관합니다. 두 검사가 OR로 묶여 있어 호스트
검사만으로 거절이 성립하고, 값을 확인할 수 없는 변수에 의존하지 않는다는 점에서
오히려 낫습니다.

**여기에 이 경계의 유일한 무른 지점이 있습니다.** 방어가 걸려 있는 것은
`ALLOWED_REQUEST_HOSTS` 에 Railway 도메인이 **없다**는 사실 하나이고, 그것은
환경변수라 **어떤 테스트도 고정할 수 없습니다.**
`scripts/security-regression-check.mjs` 는 `proxy.ts` 가 `isAllowedRequestHost`·
`hasRequiredOriginSecret`·`"Misdirected Request"` 를 담고 있는지까지만 봅니다 —
장치가 있는지는 지키지만 변수 내용은 못 지킵니다.

그러므로: **디버깅한다고 Railway 도메인을 `ALLOWED_REQUEST_HOSTS` 에 넣지 마십시오.**
넣는 순간 Access가 조용히 무의미해지고, 알려줄 검사가 없습니다. 더 확실히 하려면
Railway 서비스에서 생성 도메인 자체를 제거하는 방법이 있고, `README.md` 도 Cloudflare
프록시를 쓸 때 그렇게 권합니다.

### 다섯 번째 destination — `/api/build-info` (2026-09-01)

위 목록 넷은 §0이 심사한 것들입니다. **`/api/build-info`는 그 심사를 받은 적이
없습니다** — 그것을 읽는 호출자가 §2의 표가 만들어진 **다음 날** 태어났기
때문입니다. `Deployed Commit Drift`(2026-08-27 착지)는 첫 실행부터 staging을
비교하지 못한 채 매시 실패했고, 다섯째 날에야 읽혔습니다.

막힌 것은 그 워크플로 하나가 아닙니다. **staging 검증 체크리스트 전부가 같은
endpoint를 요구합니다** — `generated-artifacts-staging-checklist.md`와
`chat-attachment-staging-checklist.md`의 **A-1**,
`assistant-profile-staging-checklist.md`,
`assistant-package-import-staging-checklist.md`, 그리고 세 개의
`*-staging-verification-records/README.md`. 기록의 첫 칸(이 회차가 어느 커밋을
검증했는가)을 채울 수단이 사라져 있었습니다.

**bypass에 추가했습니다.** 근거는 위 넷과 종류가 다릅니다 — 저 넷은 *자체 인증을
하므로* 뚫었고, 이것은 **인증할 것이 애초에 없어서** 뚫습니다.
`app/api/build-info/route.ts`는 `getPublicBuildInfo()`의 allowlist 필드만
돌려주고 상태를 바꾸지 않으며, 공개·비인증이 그 계약입니다(STG-F010, AUD-R002;
`final-stg-reaudit-2026-07-28` 두 회차에서 민감정보 없음 확인). §0이 막으려던
위험은 *미출시 화면이 사람에게 읽히는 것*이고 커밋 SHA는 그 화면이 아닙니다 —
`/robots.txt`를 공개로 남긴 것과 같은 판단입니다.

service token으로 워크플로만 통과시키는 방법은 채택하지 않았습니다. 체크리스트가
요구하는 사람 손의 `curl`은 여전히 막히므로 문제의 절반만 풀면서, 토큰 수명·회전이
새 운영 항목으로 생깁니다.

2026-09-01T01:47Z 실측:

| 경로 | 응답 | 낸 주체 |
|---|---|---|
| `/api/build-info` | 200 JSON (`4b618702`) | 앱 |
| `/api/build-info/` | 308 → `/api/build-info` | 앱의 trailing-slash routing |
| `/api/health` | 302 | Access |

`/api/health`가 게이트 뒤인 것은 무해합니다. §2가 적어 둔 대로 Railway
healthcheck는 컨테이너로 직접 가므로 Cloudflare 앞단을 지나지 않습니다.

**`/api/build-info/`의 308은 게이트가 아니라 앱 자신의 routing입니다.** drift
스크립트가 같은 origin에 머무는 3xx는 따라가고 origin을 떠나는 3xx만 게이트로
읽는 것이 이 구분 때문입니다 — 전부 게이트로 판정했다면 평범한 끝 슬래시가
장애로 보고됐을 것입니다.

이후 `npm run report:deployed-commit-drift -- --gate`가 exit 0입니다 —
production `a37f11a9`, staging `4b618702`, 둘 다 in sync. **staging은 drift 중이
아니었습니다.** 게이트가 가린 것은 결함이 아니라 답이었고, 그래서 "확인 못 했다"를
"괜찮다"로 세지 않은 판정이 옳았습니다.

경위 전체는
`.github/audits/deployed-commit-drift-staging-access-2026-09-01.md`.

### 아직 안 한 것

Stripe test mode 결제 한 번과 크론 한 바퀴를 실제로 돌려본 확인은 남아 있습니다.
위 표가 "Access가 그 경로를 통과시킨다"까지는 보였지만, 올바른 시크릿·서명을 든
진짜 호출이 끝까지 도는 것을 본 것은 아닙니다.

### 우선순위는 낮아졌습니다

실제 사용자 데이터가 없다는 답이 이 항목의 크기를 정합니다. 남은 위험은
**미출시 화면이 읽히는 것** 하나이고, 유출될 사용자 데이터는 없습니다. 급한 일이
아니라 정리해 둘 일입니다.


## 1. 왜 열려 있나

`docs/ops/search-indexing-boundary.md` §3과 §4a가 같은 문장을 두 번 적었습니다:
`robots.txt`도 `X-Robots-Tag: noindex`도 **요청이지 통제가 아닙니다.** 무시하는
크롤러에게는 둘 다 효력이 없고, 사람에게는 애초에 효력이 없습니다.

2026-08-26 현재 `https://staging.tomverse.app/` 는 **인증 없이 200** 을 반환합니다.
URL을 아는 누구나 읽습니다.

staging은 **결정되기 전** 변경이 올라가는 곳입니다 — flag 뒤 표면, 미출시 제품,
아직 문구가 확정되지 않은 화면. 색인은 막았지만 **읽히는 것 자체는 막지 않았고**,
그것이 이 항목의 내용입니다.

**지금 당장의 사고는 아닙니다.** staging에 실제 사용자 데이터가 있는지, 미출시
표면이 지금 어느 정도 민감한지는 이 문서가 답하지 않습니다. 그 판단이 이 항목의
우선순위를 정합니다.

## 2. 인증을 앞에 세우면 깨지는 것 — 실측

staging **호스트 전체**에 인증을 걸면 사람만 막히는 게 아닙니다. 저장소에서 확인한
인바운드 호출자들입니다.

| 호출자 | 경로 | 현재 인증 방식 |
|---|---|---|
| Stripe webhook | `app/api/billing/webhook/route.ts` | `stripe-signature` 서명 검증 (`STRIPE_WEBHOOK_SECRET`) |
| Resend webhook | `app/api/webhooks/email/resend` | 자체 검증 |
| Maintenance cron | `MAINTENANCE_URL` | `MAINTENANCE_SECRET` |
| Provider probe cron | `PROVIDER_PROBE_URL` | `PROVIDER_PROBE_SECRET`/`MAINTENANCE_SECRET` |
| Provider usage sync cron | — | `PROVIDER_USAGE_SYNC_SECRET` |
| `npm run check:edge-robots` | `/robots.txt`, `/` | 없음 (공개 응답을 읽는 것이 목적) |
| 로그인 코드·매직링크 클릭 | `/auth/*` | 링크 자체 |
| `Deployed Commit Drift` (매시) | `/api/build-info` | 없음 (공개·비인증이 계약, STG-F010) |
| staging 검증 체크리스트 A-1 (사람 손) | `/api/build-info` | 같음 |

**끝의 두 행은 2026-09-01에 추가됐습니다.** 이 표는 2026-08-26에 만들어졌고
`/api/build-info`를 읽는 호출자는 그 다음 날 생겼습니다 — 표가 다시 읽히지 않아
그 경로가 bypass 심사를 통째로 건너뛰었습니다(§0a). **staging에 새 인바운드
호출자를 만들 때 이 표를 함께 고칩니다.**

staging 환경에 위 변수들이 **전부 설정돼 있습니다.** 즉 이 호출자들은 가정이 아니라
실제로 staging을 부릅니다 — 2026-08-24 회차에서 Stripe test mode Checkout을 staging에
대고 돌렸습니다.

**영향받지 않는 것 하나:** Railway healthcheck(`/api/health`)는 컨테이너로 직접
가므로 Cloudflare 앞단 인증과 무관합니다.

## 3. 두 갈래, 그리고 각각의 진짜 비용

### A. Cloudflare Access (호스트 앞단)

Zero Trust 무료 티어로 가능합니다. **경계가 애플리케이션 밖에 있다는 것이 장점**
입니다 — 앱 코드에 버그가 있어도 요청이 앱에 닿지 않습니다.

비용은 §2의 표 전체입니다. Access를 통과시키려면 service token 또는 경로별 bypass
정책이 필요하고, 그 경로는 하필 **`/api/billing/webhook`, `/api/webhooks/*` 처럼 가장
민감한 것들**입니다. 결과적으로 "경계"에 구멍이 여럿 나고, 그 구멍 목록은 저장소가
아니라 Cloudflare 대시보드에 삽니다 — 코드 리뷰에도, 테스트에도 안 잡힙니다.

`search-indexing-boundary.md` §4a가 기록한 플랜 제한이 Access에도 적용되는지는
**확인되지 않았습니다.** 관리 robots.txt 설정과 Access는 다른 제품이지만, 같은
계정의 플랜 제약을 다시 만날 수 있으므로 착수 전에 확인해야 합니다.

### B. 애플리케이션 레벨 (`proxy.ts`)

**이 저장소에는 이미 자리가 있습니다.** `proxy.ts`(Next 16에서 middleware가 이 이름을
씁니다)가 모든 요청 앞에서 돌고, 이미 같은 성격의 거절을 하고 있습니다:

```ts
if (
  !isAllowedRequestHost(request.headers.get("host")) ||
  !hasRequiredOriginSecret(request.headers)
) {
  return blockedOriginResponse();
}
```

`lib/originProtection.ts`가 그 판정을 갖고 있고, non-canonical 배포 판정은
`lib/robotsPolicyCore.ts`의 `robotsDecision`이 이미 합니다. 즉 **"staging이면
거절한다"는 판정에 필요한 조각이 둘 다 이미 있습니다.**

장점은 예외가 코드 안에 있다는 것입니다 — 서명 검증을 자기가 하는 webhook 경로는
코드에서 정확히 지정하고 테스트로 고정할 수 있습니다. Cloudflare 대시보드의 경로
규칙과 달리 리뷰 대상이 됩니다.

단점은 **경계가 우리 코드라는 것**입니다. `proxy.ts`의 버그는 곧 경계의 버그입니다.
그리고 앱보다 앞에서 일어나는 일(예: 잘못 설정된 CDN 캐시)은 막지 못합니다.

## 4. 결정 전에 답이 필요했던 것 — 전부 답이 나왔습니다 (§0)

1. **staging에 실제 사용자 데이터가 있습니까?** 있으면 A안 쪽으로 기울고 우선순위가
   올라갑니다. 없으면 이 항목 전체가 "미출시 화면이 읽힌다" 하나로 줄어듭니다.
2. **Cloudflare Access가 현재 플랜에서 가능합니까?** A안의 선결 조건입니다.
3. **§2의 인바운드 호출자 중 staging에서 계속 살아 있어야 하는 것은 무엇입니까?**
   Stripe test mode 검증을 staging에서 계속 할 생각이면 그 경로는 반드시 뚫려야
   합니다. 회차마다 손으로 하는 것으로 바꾼다면 얘기가 달라집니다.
4. **`check:edge-robots`를 계속 돌릴 것입니까?** 돌린다면 `/robots.txt`와 `/`는
   공개로 남아야 하고, 그러면 "전체 차단"이 아니라 "선별 차단"이 됩니다.

## 5. 하지 않기로 한 것

**부분적으로 시작하지 않습니다.** 인증을 절반만 걸면 §2의 호출자 일부가 조용히
실패하고, 그 실패는 staging에서만 나므로 다음 회차 검증에서야 발견됩니다. 착수한다면
§4의 네 답을 먼저 받고 한 번에 갑니다.

**robots 쪽 우회는 이 항목이 아닙니다.** `search-indexing-boundary.md` §4a가 Worker
우회를 검토하고 채택하지 않은 이유를 적어 뒀습니다. 인증이 서면 크롤 문제도 같이
해결되지만, 그것은 결과이지 이 항목의 근거가 아닙니다 — 크롤 억제만 원한다면 더 싼
방법이 있고, 여기서 값을 치르는 이유는 **사람이 읽는 것**입니다.
