# staging 접근 경계 — 열린 항목

**상태: 미결정. 아직 아무것도 구현하지 않았습니다.**
이 문서는 결정을 위한 사전 조사이지 결정이 아닙니다.

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

## 4. 결정 전에 답이 필요한 것

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
