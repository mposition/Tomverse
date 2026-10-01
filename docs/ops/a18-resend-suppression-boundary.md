# A18 실행 지시서 — marketing 전 Resend suppression 경계 결정

> 이 문서는 **결정 한 건을 내리기 위한 지시서**입니다. 결정 자체는 사람이
> 내리고, 그 전에 필요한 사실 수집·계산·초안은 이 문서가 이미 끝내 두었습니다
> (AGENTS.md "사람에게 남기는 것은 사람만 할 수 있는 것뿐입니다").
>
> - **근거 문서**: `docs/policy/email-notifications.md` §5.3.1 · §22 A18 · §20 R23
> - **연결 문서**: `docs/ops/email-sending-domains.md` §4 · §8.3
> - **감사 근거**: `.github/audits/model-lifecycle-email-2026-08-22.md` EM-16
> - **사실 수집일**: 2026-09-14

---

## 1. 무엇을 정하는가

**transactional 메일과 marketing 메일을 같은 Resend team에 둘 것인가.**

Resend의 suppression 목록은 **team 전체**에 적용되며 **모든 도메인과
서브도메인**에 걸칩니다. 서브도메인을 나누는 것으로는 분리되지 않습니다.

따라서 두 스트림을 한 team에 두면 이런 일이 성립합니다.

```
사용자가 프로모션 메일 하나를 스팸 신고
  → 그 주소가 team suppression 목록에 등재
  → 같은 team에서 나가는 로그인 코드가 드롭됨
  → 증상은 "로그인 메일이 안 온다"는 신고로만 나타남
```

우리 gating 계층은 "marketing complaint 후에도 transactional은 보낸다"고 말할
수 있지만, 그 아래 provider가 드롭합니다. **우리가 보내기로 결정해도 도달하지
않습니다.**

### 1.1 경계는 region이 아니라 team입니다 (2026-09-14 정정)

ADR §5.3.1과 `docs/ops/email-sending-domains.md`는 이 범위를 "**동일 region의
계정 전체**"로 적고 있습니다. **그 표현은 정확하지 않으며, 결정을 틀리게
만들 수 있습니다.**

- 오늘 Resend 문서의 문구는 "Suppressions apply to your entire **team** …
  skipped across all your domains and subdomains"입니다.
- **region 단위 억제는 SES의 성질**이지 Resend 문서가 말하는 경계가 아닙니다.
- 따라서 **"`news.`를 다른 region에 만든다"는 분리 수단이 아닐 수 있습니다.**
  같은 team에 있으면 억제가 그대로 걸리고, 분리했다고 믿으면서 아무것도
  분리하지 않은 상태가 됩니다. **분리하는 축은 team입니다.**

확인 경로: 웹 검색이 요약한 Resend 자체 문서
(`resend.com/docs/dashboard/emails/email-suppressions`,
`resend.com/blog/multiple-teams`). 이 컨테이너는 `resend.com` 직접 접근이
egress 정책에서 차단되어(`EGRESS_BLOCKED`) 원문을 읽지 못했으므로,
**결정 전에 대시보드에서 한 번 눈으로 확인**합니다.

결정을 기록할 때(§6) ADR §5.3.1과 ops 문서의 "region" 표현도 **함께**
"team"으로 정정합니다 — 고치지 않으면 다음 사람이 region 분리를 유효한
선택지로 읽습니다.

### 1.2 새 계정은 필요하지 않습니다

**기존 로그인으로 team을 추가로 만들 수 있습니다.** 한 이메일 주소가 여러
team을 소유하고 Team switcher로 전환하며, **각 team은 자기 API 키·청구·사용량을
갖습니다**(출처: 위 `blog/multiple-teams`). 즉 선택지 A는 "새 Resend 계정 개설"이
아니라 "기존 계정에 team 추가"입니다.


## 2. 왜 marketing을 켜기 전이어야 하는가

AGENTS.md의 차단 기준 — **틀렸을 때 되돌릴 수 없는가** — 에 해당하기 때문입니다.

- marketing을 켠 뒤 첫 complaint가 들어오는 순간, 그 사용자의 로그인 도달이
  끊깁니다. 이미 발생한 등재는 되돌리기가 provider 쪽 조작이고, 그동안 그
  사용자는 계정에 들어올 수 없습니다.
- 결정을 미루고 켜는 것은 "나중에 고치면 되는" 항목이 아닙니다. 반대로
  **결정을 내리는 데 드는 비용은 이 문서를 읽고 한 칸을 고르는 것**입니다.

## 3. 이미 확보된 사실 (재조사 불필요)

### 3.1 운영 Resend 계정 — 2026-09-14 실측

| 사실 | 값 | 확인 방법 |
|---|---|---|
| 등록 도메인 | `tomverse.app`(2026-07-12), `mail.tomverse.app`(2026-08-21) | `mcp__Resend__list-domains` |
| 상태 | 둘 다 `verified` · sending enabled · receiving disabled | 동일 |
| region | **둘 다 `ap-northeast-1`** | 동일 |
| open/click tracking | 둘 다 false | 동일 |
| **현재 suppression 등재 수** | **0건** (bounce·complaint·manual 전부) | `mcp__Resend__list-suppressions` |
| `news.tomverse.app` | **없음** — 의도된 상태 | 동일 |

**suppression 0건이 결정에 주는 의미**: 지금 분리를 고르더라도 **옮길 억제
이력이 없습니다.** 이전 비용이 0인 시점이며, marketing을 켠 뒤에는 이 성질이
사라집니다.

### 3.2 저장소는 어느 쪽이든 받을 준비가 돼 있음

| 준비된 것 | 위치 | 의미 |
|---|---|---|
| 스트림별 API 키 분리 | `lib/emailProviderPortCore.ts:207-210` | transactional은 `TRANSACTIONAL_RESEND_API_KEY` → `RESEND_API_KEY` 순, marketing은 **`MARKETING_RESEND_API_KEY` 하나뿐이고 fallback 없음** |
| 분리 강제 | 동일 파일 | marketing 키가 없으면 빌려 쓰지 않고 거부 |
| 발신 신원 분리 | `lib/emailSendingIdentityCore.ts:189-215` | `MARKETING_EMAIL_FROM` 없으면 `MARKETING_FROM_MISSING`, 두 스트림이 같은 도메인이면 `/api/ready`가 `STREAMS_SHARE_A_DOMAIN`으로 실패 |
| 계정 범위 억제 **탐지** | `lib/emailSuppression.ts:268-286` | provider가 우리 목록이 허용한 주소를 거부하면 `EMAIL_PROVIDER_SUPPRESSED` incident |
| 마지막 로그인 수단 보호 | `lib/loginMethodsCore.ts:20-47` | 남은 수단이 1개면 제거 차단(per-user advisory lock) |
| 로그인 수단 조회 | `app/api/user/login-methods/route.ts:33-58` | `canRemove` + 수단 목록 |
| OAuth 공급자 | `lib/auth.ts` | Google은 상시, Azure AD는 환경변수 3개가 모두 있을 때만 |

**즉 선택지 A·B는 "구현"이 아니라 "환경변수와 도메인 설정"입니다.** 선택지 C만
새 제품 정책과 새 코드를 요구합니다(§5.3).

### 3.3 이 컨테이너가 확인하지 못한 것

- `resend.com`은 이 세션의 egress 정책에서 차단됩니다(`EGRESS_BLOCKED`). 공식
  문서 원문, 요금, team 생성 화면은 **사람이 대시보드에서** 봐야 합니다.
- **suppression 범위는 재확인이 선택이 아닙니다.** §1.1대로 ADR의 "region"
  표현과 오늘 문서의 "team" 문구가 어긋나며, 둘 중 무엇이 맞는지가 선택지
  A의 실행 방법을 바꿉니다(다른 region으로 나눌 것인가, 다른 team으로 나눌
  것인가). 대시보드에서 확인하고 결정문에 어느 쪽인지 적습니다.

## 4. 사람이 구해야 하는 사실 — 두 개뿐

### F1. 이메일 로그인만 가진 계정 수 (운영 DB, read-only)

선택지 C의 **강제 불가 인원**이 몇 명인지가 여기서 나옵니다.

```sql
SELECT
  count(*)                                                              AS total_users,
  count(*) FILTER (WHERE oauth.cnt > 0)                                 AS has_oauth,
  count(*) FILTER (WHERE oauth.cnt = 0 AND u."emailLoginEnabled")       AS email_only,
  count(*) FILTER (WHERE oauth.cnt = 0 AND NOT u."emailLoginEnabled")   AS neither
FROM "User" u
LEFT JOIN LATERAL (
  SELECT count(*) AS cnt FROM "Account" a WHERE a."userId" = u.id
) oauth ON true;
```

참고로 marketing 수신에 동의할 수 있는 모집단도 같이 봅니다.

```sql
SELECT p.purpose, count(*) FILTER (WHERE p.enabled) AS opted_in, count(*) AS rows
FROM "EmailPreference" p
WHERE p.purpose IN ('product_updates','newsletter','promotions')
GROUP BY p.purpose ORDER BY p.purpose;
```

**판정 기준**: `email_only`가 0이면 선택지 C의 정책 부채가 없습니다. 1명이라도
있으면 C는 "강제할 수 없는 사용자에 대한 정책"을 반드시 함께 만들어야 합니다.

### F2. 두 번째 Resend team의 비용

**team을 만들 수 있는지는 이미 답이 나왔습니다**(§1.2 — 같은 로그인으로 추가
생성, 새 계정 불필요). 남은 것은 값입니다. Resend 대시보드의 team 생성 화면에서
확인합니다.

- **두 번째 team이 Free로 설 수 있는가, 유료 플랜이 강제되는가.**
  `blog/multiple-teams`는 team 생성 시 "유료 transactional 또는 marketing 플랜
  선택"을 서술하는 반면, Free 플랜(월 3,000통·도메인 1개)은 공개 가격표에
  존재합니다. 두 서술이 이 화면에서 갈립니다.
- 유료라면 최소 얼마인가 (공개 가격표 기준 Pro는 $20/mo부터)
- 새 team의 `news.` 도메인 region을 무엇으로 둘 것인가 — **region은 분리 수단이
  아니라 지연·데이터 소재의 문제**입니다(§1.1). 특별한 이유가 없으면 기존과
  같은 `ap-northeast-1`이 단순합니다.

**F2가 "비용 과다"로 나와도 C로 내려가는 근거는 되지 않습니다** — C의 비용은
돈이 아니라 로그인 도달이기 때문입니다. 그때 비교 대상은 선택지 B(별도
provider)입니다.

## 5. 선택지와 각각의 귀결

### 5.1 선택지 A — 기존 계정에 marketing 전용 team 추가 (권고)

| | |
|---|---|
| 하는 일 | **기존 로그인으로** marketing 전용 team 생성(새 계정 아님, §1.2) → `news.tomverse.app` 등록 → 그 team의 API 키 발급 |
| 환경변수 | `MARKETING_RESEND_API_KEY`(새 team 키), `MARKETING_EMAIL_FROM=Tomverse <news@news.tomverse.app>`. transactional은 기존 `RESEND_API_KEY` 유지 또는 `TRANSACTIONAL_RESEND_API_KEY`로 개명 |
| 코드 변경 | **없음** (§3.2) |
| suppression | 완전 분리. complaint가 로그인 코드에 닿지 않음 |
| 비용 | 두 번째 team 요금(F2), DNS 레코드 4종 추가, warm-up 4~6주 |
| 되돌릴 수 있는가 | 예 — 잘못되면 marketing만 끄면 되고 transactional은 영향 없음 |
| 남는 숙제 | 없음. §5.3.1 결정 3이 따라오지 않음 |

### 5.2 선택지 B — 별도 provider (marketing만 다른 업체)

| | |
|---|---|
| 하는 일 | marketing 전용 provider 계약 → `EmailProviderPort` 구현체 1개 추가 |
| 코드 변경 | **있음** — `lib/emailProviderPort.ts`에 두 번째 구현. port가 이미 얇으므로 큰 작업은 아니지만 A보다 큼 |
| suppression | 완전 분리. 단 **양쪽에 밀어 넣어야 함** — 우리 `SuppressionCause`가 유일한 판정 근거이고 동기화는 단방향(ADR §8.8) |
| 언제 이걸 고르는가 | F2에서 team 분리가 불가하거나, 세그먼트·여정 같은 marketing 기능이 실제로 필요해졌을 때(그건 Phase 3 조건이며 지금은 아님) |
| 되돌릴 수 있는가 | 예, 다만 계약이 걸림 |

### 5.3 선택지 C — 한 계정 유지 + 비이메일 복구 수단 의무화

| | |
|---|---|
| 하는 일 | 계정을 나누지 않는 대신 §5.3.1 **결정 3**을 실행 |
| 따라오는 **필수** 조건 | ① "이메일 외 로그인 수단 1개 이상"을 권장 → **요구**로 승격 ② marketing opt-in UI를 OAuth 미연결 계정에 제공하지 않거나 연결을 선행 요구 ③ suppression 등재 사용자 탐지 → 지원 경로 안내 ④ **강제할 수 없는 기존 사용자**(F1의 `email_only`)에 대한 정책 |
| 코드 변경 | **있음** — ①②는 새 제품 정책과 새 UI. ③은 탐지 incident가 이미 있으나(§3.2) 사용자 안내 경로는 없음 |
| suppression | 분리되지 않음. R23이 상시 위험으로 남음 |
| 되돌릴 수 있는가 | **아니오** — 켠 뒤 등재된 사용자의 로그인 단절은 사후 복구 대상이지 예방이 아님 |
| 언제 이걸 고르는가 | F1의 `email_only`가 0이고, F2에서 분리가 실제로 불가능하다고 확인됐을 때만 |

### 5.4 권고: **A**

이유 셋.

1. **오늘 이전 비용이 0입니다.** suppression 0건이고 `news.` 도메인이 아직
   없으므로, 지금 나누는 것과 나중에 나누는 것의 차이는 나중에는 옮길 이력이
   생긴다는 것뿐입니다.
2. **코드가 이미 두 키를 받게 돼 있습니다.** A는 환경변수 두 개와 DNS이고, B·C만
   새 코드를 요구합니다.
3. **C는 영구적인 정책 부채를 만듭니다.** "이메일 외 수단 1개 이상"은 신규
   사용자에게는 강제할 수 있어도 기존 사용자에게는 강제할 수 없고, 그 사용자
   목록은 시간이 지나도 저절로 비지 않습니다.

## 6. 결정한 뒤 — 무엇을 어디에 쓰는가

**결정은 문서에 기록될 때 끝납니다.** 아래 네 곳을 한 commit에서 고칩니다.

| # | 파일 | 위치 | 무엇을 |
|---|---|---|---|
| 1 | `docs/policy/email-notifications.md` | §22 A18 행 (현재 2667행) | "…분리한다(**잠정**)" → 확정 문구 + 결정일 + 근거 |
| 2 | `docs/policy/email-notifications.md` | §5.3.1 결정표 2행 (현재 638행) | "결정한다" → 결정된 값 |
| 3 | `docs/policy/email-notifications.md` | §0 개정 이력 | v5 항목 추가 (ADR이므로 개정과 재승인이 필요) |
| 4 | `docs/ops/email-sending-domains.md` | §8.3 (현재 758행) | "막혀 있는 것: 사람의 결정" → 결정 기록. §4의 선행 조건 1 해제 |
| 5 | `docs/policy/email-notifications.md` · `docs/ops/email-sending-domains.md` | "region 내 계정 전체"가 나오는 모든 곳 (§5.3.1 본문, §1.1의 표, §4, §8.3) | **"team 전체"로 정정**(§1.1). 대시보드 확인 결과와 확인일을 함께 적습니다 — 고치지 않으면 다음 사람이 region 분리를 유효한 선택지로 읽습니다 |

C를 고른 경우에만 추가로:

| 6 | `docs/policy/email-notifications.md` | §5.3.1 결정 3 | 요구로 승격됨을 명시하고, ①~④의 담당과 기한을 적음 |

### 6.1 복붙용 결정 기록 (A를 고른 경우)

`docs/policy/email-notifications.md` §22 A18 행을 다음으로 교체합니다.

```
| **A18** | **결정됨 (2026-__-__).** marketing은 **별도 Resend team**을 쓰고
transactional 계정과 suppression 목록을 공유하지 않습니다 | 5.3.1. 결정 시점의
suppression 등재 0건이라 이전 비용이 없었고, port가 이미 `MARKETING_RESEND_API_KEY`를
별도로 요구합니다(`lib/emailProviderPortCore.ts:207-210`) | 가정이 아니라
결정입니다. §5.3.1 결정 3(비이메일 복구 수단 의무화)은 **따라오지 않습니다** |
```

`docs/ops/email-sending-domains.md` §8.3 표를 다음으로 교체합니다.

```
| | |
|---|---|
| 상태 | **결정됨 (2026-__-__)** — 기존 계정에 marketing 전용 team 추가 |
| 근거 | ADR §22 A18. 결정 시점 suppression 0건, 도메인 2개 모두 ap-northeast-1 |
| 다음 | §4의 선행 조건 1 해제. Q8(사업자 정보)만 남으면 `news.tomverse.app` 구성 착수 |
```

### 6.2 A를 고른 뒤의 실행 순서

`news.` 도메인 작업은 **Q8(사업자 정보 실제 값)이 확정된 뒤**입니다. 순서를
바꾸면 도메인은 섰는데 footer가 없어 발송이 거부되는 상태로 warm-up을 시작하게
됩니다.

1. **기존 Resend 로그인**으로 marketing 전용 team 생성(§1.2). 도메인 region은
   특별한 이유가 없으면 기존과 같은 `ap-northeast-1`(§1.1 — region은 분리 수단이
   아닙니다)
2. `news.tomverse.app` 등록 → SPF/DKIM 레코드 → DMARC `p=none`
   (`docs/ops/email-sending-domains.md` §3.1~3.3을 `news.` 이름으로 반복)
3. 환경변수를 **코드보다 먼저** 배포
   - `MARKETING_RESEND_API_KEY`
   - `MARKETING_EMAIL_FROM=Tomverse <news@news.tomverse.app>`
   - `EMAIL_UNSUBSCRIBE_KEYS` · `EMAIL_UNSUBSCRIBE_KEY_VERSION`
     (`MARKETING_EMAIL_FROM`이 설정되는 순간 `/api/ready`의 필수 항목이 됩니다 —
     `lib/emailUnsubscribeReadiness.ts`)
   - `EMAIL_BUSINESS_*` 6개 (Q8)
4. 검증
   ```
   npm run check:sending-identity
   npm run check:email-provider-port
   npm run report:email-domains
   curl -s https://<host>/api/ready | jq '.checks[] | select(.name|test("email"))'
   ```
   `/api/ready`가 `STREAMS_SHARE_A_DOMAIN`이나 미설정 항목으로 실패하지 않아야
   합니다.
5. warm-up 4~6주 시작 (§14.6 — 주당 배증, 가장 최근 동의자부터)
6. 그 뒤에야 `feature.emailMarketingEnabled` 해제 검토

## 7. 하지 말 것

- **flag만 켜기.** `feature.emailMarketingEnabled`를 켜도 `MARKETING_EMAIL_FROM`이
  없으면 거부되고, 사업자 정보가 없으면 footer 렌더가 실패합니다. 구조적 차단이
  flag보다 앞에 있으며, 그 순서를 뒤집지 않습니다.
- **`MARKETING_EMAIL_FROM`을 `mail.tomverse.app`이나 `tomverse.app`으로 두기.**
  `/api/ready`가 `STREAMS_SHARE_A_DOMAIN`으로 실패하며, 실패하지 않더라도 그것이
  바로 이 결정이 막으려는 상태입니다.
- **`RESEND_API_KEY`를 marketing에 재사용하기.** port가 fallback을 의도적으로
  갖지 않습니다. 재사용하려면 코드를 고쳐야 하고, 그 수정이 곧 A18을 C로
  바꾸는 결정입니다 — 문서 없이 코드로 내리지 않습니다.
- **suppression을 Resend 대시보드에서 손으로 지워 로그인을 복구하기.** 증상은
  사라지고 원인은 남습니다. 우리 `SuppressionCause`가 판정 근거이므로, 지우는
  행위는 감사 기록 없이 provider 상태만 바꿉니다.
- **같은 team 안에서 region만 다르게 두고 분리했다고 믿기.** 오늘 문서가 말하는
  경계는 team이며(§1.1), region은 지연과 데이터 소재의 문제입니다. 이 착각은
  아무것도 분리하지 않은 상태를 "분리 완료"로 기록하게 만듭니다.
- **결정을 코드나 환경변수로만 내리기.** A18은 ADR의 가정 행이며, 문서가 갱신되지
  않으면 다음 사람이 같은 조사를 다시 합니다.

## 8. 이 결정이 풀어 주는 것과 풀어 주지 않는 것

**풀어 주는 것**: `docs/ops/email-sending-domains.md` §4의 선행 조건 1,
EM-16의 A18 항목, `news.` 도메인 착수.

**풀어 주지 않는 것** — marketing 활성화에는 이것들이 여전히 남습니다.

- Q8 사업자 정보 실제 값 (없으면 footer 렌더 실패 = 발송 거부)
- Q1·Q2 법률 회신
- Q12 개인정보처리방침의 이메일 마케팅 처리 기재 (현재 미기재)
- DMARC 집계 리포트 2주분 + SPF·DKIM 정렬 확인
- warm-up 4~6주
- M7 관할권 정책 version을 사람이 `/admin/email-policy`에서 활성화
