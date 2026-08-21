# 이메일 알림 시스템 아키텍처 의사결정 문서

- 기준일: 2026-08-21
- 상태: **초안, 승인 대기**. 이 문서는 코드 변경을 포함하지 않습니다.
- 작성 범위: 규제 요구사항 조사 + 저장소 현황 조사 + 아키텍처 권고
- 법적 성격: **법률 자문이 아닙니다.** 21절의 질문 목록을 법률 담당자가 확인하기
  전에는 marketing 계열 기능을 production에서 활성화하지 않는 것을 전제로 씁니다.

---

## 1. Executive summary

**결론 한 줄:** 지금 필요한 것은 새 이메일 제공자가 아니라, 이미 있는 Resend 파이프
앞에 **동의(consent) / 억제(suppression) / 관할권(jurisdiction) 판정 계층**을 세우고,
큐 밖에서 직접 발송되는 경로들을 outbox로 모으는 일입니다.

여섯 가지 판단:

1. **제공자는 바꾸지 않습니다.** Resend를 유지하고, `lib/email.ts` 자리에 얇은
   provider port를 둡니다. 차선책은 Postmark(transactional/broadcast 스트림이 제품
   구조로 분리됨), 데이터 위치가 결정적 제약이 되면 AWS SES(`ap-northeast-2` 서울 /
   `eu-central-1`)입니다. Customer engagement platform(Braze, Customer.io)은 현
   규모에서 **과잉**입니다.
2. **transactional과 marketing은 도메인부터 분리합니다.** 같은 도메인·같은 스트림에서
   보내면 프로모션 한 건의 complaint가 로그인 코드 도달률을 깎습니다. 이것은 규제
   요구이자 deliverability 요구입니다.
3. **관할권은 IP로 정하지 않습니다.** 현재 저장소는 analytics 동의와 결제 통화를 모두
   `cf-ipcountry` 단독으로 판정합니다. 이메일에는 그 방식을 복제하지 않고,
   **청구 국가 > 사용자 신고 국가 > 계정 설정 > IP(약한 신호)** 우선순위와 불일치
   처리를 별도로 정의합니다(6절).
4. **국가별 규칙은 코드가 아니라 버전이 있는 데이터로 운영합니다.**
   `JurisdictionProfile` + `EmailPolicyVersion`을 두고, 규제 변경의 대부분을 배포
   없이 반영할 수 있게 합니다. 다만 "배포 없이 바꿀 수 있는 범위"에는 한계가 있고,
   그 경계를 8절과 15절에서 명시합니다.
5. **MVP는 marketing을 포함하지 않습니다.** 1단계는 transactional/service 경로의
   신뢰성(outbox, suppression, 감사 스냅샷)과 preference center의 뼈대까지입니다.
   marketing 발송은 인프라를 만들되 flag로 잠근 채 법률 검토를 기다립니다.
6. **가장 큰 현재 리스크는 마케팅이 아니라 유실입니다.** 로그인 코드, 환영 메일,
   Stripe 결제 확인 메일이 지금 큐 밖에서 fire-and-forget으로 나갑니다. 실패하면
   사용자는 로그인하지 못하고 아무도 그것을 모릅니다.

**즉시 결정이 필요한 항목(22절 상세):** 서비스 유형(B2C/B2B), 우선 국가 확정,
일본·중국 시장 포함 여부, 예상 발송량, EU 데이터 리전 요구 여부.

---

## 2. 현재 저장소와 기존 기능 조사 결과

### 2.1 기술 스택

| 항목 | 값 | 근거 |
|---|---|---|
| Framework | Next.js **16.3.0**, React 19.2.8 | `package.json` |
| Runtime | Node 22.x | `package.json` engines |
| ORM/DB | Prisma 7.9.1 + `@prisma/adapter-pg`, PostgreSQL | `package.json`, `prisma/schema.prisma` |
| 인증 | next-auth 4.24 (**JWT 전략**, 서버 세션 행 없음), `@auth/prisma-adapter` | `prisma/schema.prisma` User 주석 |
| 결제 | Stripe 22.5 | `lib/stripeWebhookProcessing.ts` |
| 배포 | Railway (`railway.*.json` cron 정의 4종) | 저장소 루트 |
| Edge/CDN | Cloudflare (`cf-ipcountry` 헤더 사용) | `app/(site)/(application)/layout.tsx:56` |
| 관측 | Sentry (server/edge/client config) | 루트 config 3종 |
| 스토리지 | Cloudflare R2 | `check:cloudflare-r2-analytics` |
| **이메일** | **Resend 단일 제공자** | `lib/email.ts` |

> **확인 필요:** 조사 시점에 `node_modules/`가 설치되어 있지 않아
> `node_modules/next/dist/docs/`를 읽지 못했습니다. AGENTS.md가 요구하는 대로,
> 구현 착수 전에 반드시 설치된 Next 16.3.0 문서를 읽고 Route Handler / `after()` /
> cache 관련 API의 현재 시그니처를 확인해야 합니다. 이 문서의 Next 관련 서술은
> 아키텍처 수준(어디에 무엇을 두는가)에 한정하며, 구체 API 사용법을 확정하지
> 않았습니다.

### 2.2 현재 이메일 발송 경로

`lib/email.ts`의 `sendTransactionalEmail()` 하나가 모든 발송의 입구입니다.

- Resend REST(`POST https://api.resend.com/emails`) 직접 호출. SDK 미사용.
- **Idempotency-Key 지원 이미 있음** (256자 절단). 주석이 계약을 명시합니다:
  같은 key + **동일 payload**여야 중복이 억제되므로, 재시도 주체가 안정적인 key를
  쓰고 매 시도 동일 렌더 결과를 만들어야 합니다.
- From 주소는 `TRANSACTIONAL_EMAIL_FROM` -> `EMAIL_FROM` -> 하드코딩 기본값
  `Tomverse Insight <hello@tomverse.app>` 순. **스트림/도메인 분리 개념 없음.**
- `RESEND_API_KEY`가 없으면 `{ sent: false, skipped: true }`로 조용히 넘어감.
- 실패는 `throw`. 호출자가 처리하지 않으면 그대로 유실.

### 2.3 이미 있는 것: NotificationDelivery 재시도 큐

`prisma/schema.prisma:1399` + `lib/notificationDeliveries.ts` + `lib/notificationRetryCore.ts`.
**설계 품질이 높고, 이번 작업의 확장 기반이 됩니다.**

- `@@unique([kind, referenceId])` -> 소스 레코드 1건당 큐 행 1건. 중복 enqueue 불가.
- 소스 레코드와 **같은 트랜잭션에서** 큐 행을 씁니다(= 이미 outbox 패턴).
- 재시도 6회, 고정 백오프 `[1m, 5m, 15m, 1h, 4h]` (약 5.5시간). jitter 없음(단건이라
  thundering herd 없음, 운영자가 행 하나로 추론 가능하게).
- 소진 시 `abandoned` + `NOTIFICATION_DELIVERY_ABANDONED` 운영 incident.
- 큐 깊이 임계 초과 또는 시간 예산 미소진 시에도 incident.
- **본문을 저장하지 않습니다.** 발송 시점에 소스 행에서 재렌더링하고, 실패는 짧은
  분류(`http_502`)만 남깁니다.
- drain은 전용 maintenance endpoint + 15분 크레딧 정산 cron 양쪽에서 호출.

**한계: 사용하는 kind가 7개뿐입니다.**
`support_feedback`, `refund_request_{received,approved,rejected}`,
`feedback_user_{received,reviewing,completed}`.

### 2.4 큐 밖에서 직접 나가는 발송 (현재 최대 리스크)

| 발송 | 호출 위치 | 실패 시 |
|---|---|---|
| 로그인 코드/매직링크 | `lib/emailLoginEmails.ts:98,196` | **사용자가 로그인 불가.** 재시도 없음 |
| 계정 환영 메일 | `app/api/user/settings/route.ts:121` | 유실 |
| 계정 삭제 예약 / 복구 안내 | `lib/accountEmails.ts:20,32` | 유실. **법적 통지 성격** |
| Stripe 결제 확인 | `lib/stripeWebhookProcessing.ts:522` | 유실. 영수증 성격 |
| 플랜 변경 / 크레딧 관련 | `lib/billingEmails.ts:901,983,1031` | 유실 |
| provider 카탈로그 리포트 | `lib/providerModelCatalogReport.ts:212` | 운영자 대상 |
| 운영 incident 알림 | `lib/operationalMonitoring.ts:113` | 운영자 대상 |
| 보안 감사 리포트 | `scripts/send-security-audit-report.mjs` | 운영자 대상 |
| 관리자 테스트 메일 | `app/api/admin/test-email/route.ts` | 무해 |

즉 **가장 중요한 두 종류(인증, 영수증)가 가장 약한 경로**에 있습니다.

### 2.5 다국어 현황

- `locales/`: **7개 언어** — `en`, `ko`, `zh`, `fr`, `de`, `es`, `pt`. **`ja` 없음.**
- 이메일 카피는 locale 파일이 아니라 **각 이메일 모듈이 자기 사본을 들고 있습니다.**
  `lib/accountEmails.ts`, `lib/billingEmails.ts`, `lib/emailLoginEmails.ts`가 각각
  동일한 `type EmailLanguage` union과 `normalizeLanguage()`를 재정의합니다.
  -> **drift 위험.** 한 곳에 언어를 추가해도 다른 곳은 조용히 `en`으로 떨어집니다.
- `lib/feedbackLifecycleEmails.ts`만 공용 `lib/language.ts`의 `Language`를 씁니다.
  이쪽이 옳은 방향이고, 나머지를 여기로 모아야 합니다.
- `lib/emailTypography.ts`: 웹세이프 스택 단일 정책. 한/중 시스템 폰트 인라인 포함.
  타이포그래피 계약(`docs/ui-contracts/typography.md`)이 "이메일은 웹폰트를 절대
  로드하지 않는다"를 이미 못박고 있습니다. **이 계약은 그대로 유지합니다.**

### 2.6 관할권 판정의 기존 선례

`lib/analyticsConsentPolicy.ts` — 이미 관할권 인지 동의 정책이 존재합니다.

- `STRICT_OPT_IN_COUNTRIES`: EU/EEA 30개국 + `GB` + `CH` (33개).
- 기본 `notice_opt_out` 허용 국가: `AU` 하나(환경변수로 확장 가능).
- 미확인/판정 불가는 `ZZ` -> `opt_in` (**fail-closed**). 좋은 기본값입니다.
- 그러나 **입력이 `cf-ipcountry` / `x-vercel-ip-country` 단독**입니다
  (`layout.tsx:56`, `app/api/analytics/consent-policy/route.ts:11`,
  `lib/productAnalyticsServer.ts:206`).
- `lib/billingCurrency.ts:48`도 동일하게 IP 헤더로 통화를 정합니다.

**이메일에는 이 방식을 복제하지 않습니다.** 사용자의 요구사항 5번이 명시적으로
금지하며, 실무적으로도 틀립니다: 한국 사용자가 출장 중 미국 IP로 접속했다고 해서
정보통신망법이 적용되지 않는 것이 아닙니다.

### 2.7 시장 신호 (실제 대상 국가 추정)

`lib/billingMarkets.ts`의 `BILLING_CURRENCIES = ["USD", "AUD", "CNY", "EUR", "KRW"]`.
표시 로케일은 `en-US`, `en-AU`, `zh-CN`, `de-DE`, `ko-KR`.

-> 실제로 결제를 받도록 만들어 둔 시장은 **한국, 미국, 호주, EU(유로존 20개국),
중국**입니다. 영국·캐나다·싱가포르는 USD로 유입 가능하지만 전용 통화가 없습니다.
**일본은 통화도 로케일도 없습니다.**

### 2.8 재사용 가능한 기존 인프라

| 필요한 것 | 이미 있는 것 |
|---|---|
| outbox + 재시도 | `NotificationDelivery` (2.3) |
| 관리자 이중 승인 | `AdminActionApproval` (`payloadHash`, `expiresAt`, `consumedAt`) |
| 감사 로그 | `AdminAuditLog`, `writeAdminAuditLog()` |
| feature flag | `AppSetting` (key/value) + `lib/appSettings.ts` |
| 스케줄 잡 기록 | `ScheduledJobRun`, `startScheduledJob()`/`completeScheduledJob()` |
| 개인정보 요청 처리 | `PrivacyRequest` (`dueAt`, `legalHold`, `legalHoldReason`) |
| 데이터 내보내기 | `AccountDataExportRequest` |
| 보관/삭제 배치 | `AdminRetentionRun` |
| 운영 incident | `reportOperationalIncident()` |
| Rate limit | `consumeApiRateLimit()` (`lib/apiSecurity.ts`) |
| 웹훅 중복 방지 선례 | `StripeWebhookEventLog` |

**새로 만들어야 하는 것은 생각보다 적습니다.** 없는 것은 동의, 억제, 관할권,
선호 설정, 템플릿 버전, 그리고 이 다섯을 묶는 렌더러입니다.

### 2.9 지켜야 하는 기존 계약

이 작업이 건드릴 표면에 이미 계약이 걸려 있습니다.

- **Admin Console IA** (`docs/ui-contracts/admin-console-ia.md`): 새 admin 화면은
  `lib/adminNavigation.ts` + `adminNavigationIcons.ts` + 실제 route segment
  **세 곳을 동시에** 등록. catch-all 금지, 퇴역 URL redirect 필수.
- **Settings navigation** (`docs/ui-contracts/settings-navigation.md`): preference
  center는 settings 패널 안의 항목이며, 상세 페이지는 `settingsSectionHref()`로
  올라갑니다. `router.back()` 금지.
- **Accent colour roles** (AGENTS.md): 새 역할은 `app/globals.css`에 token을 먼저
  추가하고 `KNOWN_ROLES`에 등록한 뒤 사용. AI Review gradient는 예약됨.
- **Typography** (`docs/ui-contracts/typography.md`): 이메일은
  `lib/emailTypography.ts` 단일 스택, 웹폰트 금지.
- **브랜치 정책**: develop 자동 PR은 이름에 `to-develop` 경로 조각이 있는 브랜치만.
- **릴리스 게이트**: `docs/release-gates/tomverse-chat-v1.yaml`에 게이트를 추가할 수
  있으나, 승인·증거는 사람이 registry에 기록합니다. 보고 도구가 registry를 쓰지
  않습니다.

---

## 3. 이메일 유형별 분류표

분류 정의:

- **transactional**: 사용자가 시작한 특정 거래/요청에 대한 응답. 동의 불필요.
- **service/legal**: 사용자가 시작하지 않았지만 계약 이행 또는 법적 의무로 반드시
  전달해야 하는 것. 동의 불필요하나 **마케팅을 섞으면 즉시 marketing이 됩니다.**
- **marketing**: 영리 목적 판촉. 대부분의 관할권에서 사전 동의 또는 좁은 예외 필요.

> **핵심 원칙:** 분류는 발신자의 의도가 아니라 **메시지의 주된 목적(primary purpose)**이
> 정합니다. CAN-SPAM의 `16 CFR 316.3`이 이 판정 기준을 두고 있고, 실무에서 오분류가
> 발생하는 지점은 거의 항상 "service 메일에 프로모션 한 줄을 끼워 넣는" 순간입니다.

### 3.1 요약표

| # | 이메일 유형 | 분류 | 동의 없이 발송 | marketing 거부자에게도 | unsubscribe 링크 | 우선순위 | 재시도 | 스트림 |
|---|---|---|---|---|---|---|---|---|
| 1 | 이메일 확인, 로그인 코드, 보안 알림 | transactional | 가능 | 가능 | **금지** | P0 | 공격적(즉시 3회, 짧은 백오프) | transactional |
| 2 | 비밀번호/인증수단 변경 | transactional | 가능 | 가능 | **금지** | P0 | 공격적 | transactional |
| 3 | 영수증, 결제 실패, 환불, 구독 변경 | transactional | 가능 | 가능 | **금지** | P0 | 공격적 | transactional |
| 4 | 서비스 장애, 예정 점검 | service | 가능 | 가능 | 선택(별도 preference) | P1 | 표준 | transactional |
| 5 | 약관/개인정보처리방침/가격 변경 | service/legal | 가능 | **가능(필수)** | **금지** | P1 | 표준 + 미도달 추적 | transactional |
| 6 | 사용자가 명시적으로 구독한 기능 업데이트 | service(동의 기반) | 불가 | 불가 | **필수** | P2 | 표준 | marketing |
| 7 | 신규 기능 소개, 뉴스레터 | marketing | 불가 | 불가 | **필수** | P3 | 관대(1회 재시도) | marketing |
| 8 | 프로모션, 할인, 재참여 | marketing | 불가 | 불가 | **필수** | P3 | 관대 | marketing |
| 9 | 관리자 긴급 공지 | 내용에 따라 갈림 | 조건부 | 조건부 | 조건부 | P0 | 공격적 | transactional |
| 10 | 법정 통지 | legal | 가능 | **가능(필수)** | **금지** | P0 | 공격적 + 대체 채널 | transactional |

### 3.2 유형별 상세

#### 1. 이메일 주소 확인 / 로그인 / 보안 알림
- **반드시 포함:** 무엇이 요청되었는지, 만료 시각, 1회용임, 요청하지 않았다면
  무엇을 할지, 발신자 신원. 현행 `lib/emailLoginEmails.ts`가 이미 충족합니다.
- **오분류 위험:** unsubscribe 링크를 붙이면 사용자가 눌러 자기 계정 인증 경로를
  차단합니다. **transactional에는 unsubscribe를 절대 넣지 않습니다.**
  단, `List-Unsubscribe` 헤더도 넣지 않습니다(일부 클라이언트가 자동 처리).
- **suppression 상호작용:** hard bounce는 존중해야 하지만, **complaint(스팸 신고)로
  인증 메일을 막으면 계정 복구가 불가능해집니다.** 이 경계는 13절에서 다룹니다.
- **국가별 차이:** 없음. 모든 조사 대상 관할권에서 광고성 정보가 아닙니다.

#### 2. 비밀번호/인증 수단 변경
- 1번과 동일 취급. `emailLoginEnabled`, `sessionsRevokedAt` 변경 시에도 통지가
  필요합니다(현재 통지 없음 — 갭).
- **반드시 포함:** 변경된 항목, 변경 시각(사용자 시간대), "본인이 아니라면" 경로.
- **오분류 위험:** 보안 알림을 preference로 끌 수 있게 만들면 계정 탈취자가 먼저
  꺼버립니다. **끌 수 없어야 합니다.**

#### 3. 결제 영수증, 실패, 환불, 구독 변경
- **반드시 포함:** 금액과 통화(`lib/billingMarkets.ts`의 시장별 표기 규칙 준수),
  기간, 플랜, 다음 청구일, 세금/사업자 정보(관할권별), 결제 수단 마지막 4자리,
  분쟁/문의 경로.
- **국가별 차이 있음:** EU/한국 등은 세금계산서/영수증 표시 요건이 별도 법령
  (부가가치세법, EU VAT Directive)에 있습니다. **이 문서는 그것을 다루지 않으며,
  세무 요건은 별도 검토가 필요합니다(21절 Q7).**
- **오분류 위험:** "업그레이드하세요" CTA를 영수증에 넣는 순간 marketing 논쟁이
  생깁니다. 실패 통지에 대한 "결제 수단 업데이트" 링크는 거래 이행이므로 안전합니다.

#### 4. 서비스 장애 / 예정 점검
- **분류가 미묘합니다.** 계약 이행 정보이므로 대체로 동의 불요이나, 빈도가 높아지면
  사용자는 뉴스레터로 인식합니다.
- **권고:** `service_status` 라는 **별도 preference**를 두고 기본 ON, 끌 수 있게
  합니다. marketing opt-out과는 독립입니다. 단, **보안 사고 통지는 이 preference로
  끌 수 없습니다**(10번으로 분류).
- **반드시 포함:** 영향 범위, 시각(사용자 시간대), 현재 상태, 다음 갱신 시점.
- **국가별 차이:** GDPR 제33/34조의 개인정보 유출 통지는 4번이 아니라 10번입니다.

#### 5. 약관/개인정보처리방침/가격의 중요 변경
- **service/legal. marketing 거부자에게도 반드시 보냅니다.**
- **반드시 포함:** 무엇이 바뀌는지 요약, 시행일, 전문 링크, 동의하지 않을 경우의
  선택지(해지/환불), 정책 버전 식별자.
- **unsubscribe 금지.** 대신 "이 안내는 계약상 필수 통지이며 수신 거부할 수
  없습니다"를 명시합니다.
- **국가별 차이 큼:** 사전 통지 기간이 다릅니다. 한국은 약관 불리 변경 시 30일 전
  공지가 일반적 실무이고(약관규제법/전자상거래법 맥락), EU는 소비자보호 지침 및
  Digital Content Directive 맥락이 별도로 있습니다. **21절 Q3에서 확인.**
- **오분류 위험:** 가격 인상 안내에 프로모션을 붙이면 marketing이 되고, 그러면
  marketing 거부자에게 못 보내게 되어 **법적 통지 의무를 스스로 깨뜨립니다.**
  이것이 이 문서에서 가장 강조하고 싶은 실패 모드입니다.

#### 6. 사용자가 명시적으로 구독한 기능 업데이트
- 동의 기반이므로 동의 없이는 불가. **unsubscribe 필수.**
- 7번(뉴스레터)과 **별개 preference**여야 합니다. "기능 업데이트만 받고 프로모션은
  안 받겠다"가 가능해야 합니다. 이것이 목적별 opt-in의 핵심 사례입니다.
- **국가별 차이:** EU/UK/캐나다/일본/싱가포르에서 이 유형이 CEM/특정전자메일에
  해당하는지는 내용에 따라 갈립니다. 판촉 요소가 없는 순수 릴리스 노트라도
  **자사 서비스 홍보로 읽히면 광고성**입니다. 보수적으로 marketing 스트림으로
  보냅니다.

#### 7. 신규 기능 소개 / 뉴스레터, #8. 프로모션 / 할인 / 재참여
- **완전한 marketing.** 사전 동의 필요(관할권별 예외는 5절).
- **반드시 포함:** 발신자 법인명, 유효한 물리적 우편 주소, 명확한 수신거부 방법,
  왜 이 메일을 받는지, 관할권별 광고 표시(한국 `(광고)`, 싱가포르 `<ADV>`).
- **재참여(re-engagement) 특유의 위험:** 오래 접속하지 않은 사용자에게 보내는
  것이므로 **동의가 이미 만료된 사람**을 대상으로 하기 쉽습니다. 한국의 2년 재확인,
  캐나다의 묵시적 동의 만료(2년/6개월)가 정확히 여기서 문제가 됩니다.

#### 9. 관리자가 보내는 긴급 공지
- **분류가 내용으로 결정됩니다.** 시스템이 이것을 판단해서는 안 됩니다.
- **권고:** 관리자 발송 UI에서 분류를 **명시적으로 선택**하게 하고, 선택에 따라
  수신자 집합·footer·unsubscribe 유무가 자동으로 달라지게 합니다. 선택은
  `AdminActionApproval`에 payload로 기록되어 감사 대상이 됩니다.
- **오분류 위험이 가장 큰 유형.** "긴급"이라는 라벨로 marketing을 legal로
  올려보내는 것이 가장 흔한 위반 경로입니다. 12절에서 방어책을 다룹니다.

#### 10. 법적으로 반드시 전달해야 하는 통지
- 예: 개인정보 유출 통지(GDPR 제33/34조, 개인정보보호법 제34조), 계정 정지/삭제
  통지, 규제기관 명령에 따른 통지, 서비스 종료 통지.
- **모든 preference와 marketing suppression을 무시합니다.** 단
  **hard bounce suppression은 무시할 수 없습니다**(주소가 존재하지 않으므로).
  이 경우 **대체 채널이 필요**합니다: 앱 내 강제 배너, 로그인 시 확인 모달.
- **반드시 포함:** 법적 근거, 발생 사실, 영향, 사용자가 할 일, 연락처, 규제기관
  안내(관할권별).
- **재시도:** 다른 어떤 유형보다 길게. 도달 실패 시 운영 incident + 수동 후속.

---

## 4. 국가별 규제 요구사항 비교표

> **모든 항목은 아래 명시된 출처를 2026-08-21에 확인한 결과입니다.**
> 법령 원문의 개정일은 출처마다 다르며, 확인 가능한 경우 표기했습니다.
> **이 표는 법률 자문이 아닙니다.** 굵게 표시한 항목은 21절의 법률 검토 대상입니다.

### 4.1 marketing 이메일 핵심 요건

| 관할권 | 법적 근거 | 사전 동의 | 기존 고객 예외 | 동의 만료 | 수신거부 처리 기한 | 제목 광고 표시 | 필수 발신자 정보 |
|---|---|---|---|---|---|---|---|
| **EU/EEA** | ePrivacy Dir. 2002/58/EC 제13조 + GDPR | **원칙 opt-in** | soft opt-in: 자사 유사 상품, 판매 맥락에서 취득, 취득 시점 및 매회 거부 기회 제공 | 명시 규정 없음(GDPR 동의 신선도 논점) | "지체 없이"(구체 일수 없음) | 없음 | 신원, 유효 연락처 |
| **영국** | UK GDPR + PECR reg. 22 | **원칙 opt-in** | soft opt-in(동일 구조). 2026-02-05부터 자선 목적 soft opt-in 신설(reg. 22(3A)) | 명시 규정 없음 | "지체 없이" | 없음 | 신원, 유효 연락처 |
| **미국** | CAN-SPAM 15 U.S.C. 7701 이하, 16 CFR 316 | **불요(opt-out 체제)** | 해당 없음 | 해당 없음 | **10 영업일** | 없음(성적 내용 예외) | **유효한 물리적 우편 주소 필수** |
| **캐나다** | CASL | **원칙 opt-in** | 묵시적 동의: 거래 후 **2년**, 문의 후 **6개월** | 명시적 동의는 만료 없음. **묵시적 동의는 위 기간 후 만료** | **10 영업일** | 없음 | 신원, 연락처, 수신거부 수단 |
| **호주** | Spam Act 2003 | **원칙 opt-in** | 추론된 동의(inferred consent) 가능하나 좁음 | 명시 규정 없음 | **5 영업일** | 없음 | **법인명 또는 이름 + ABN**, 발송 후 30일간 정확 유지 |
| **한국** | 정보통신망법 제50조 | **원칙 opt-in** | 제50조제1항 단서(거래관계 예외)가 있으나 좁음 | **동의일로부터 2년마다 재확인 의무** | 즉시 처리 + 처리 결과 통지 | **제목 앞 `(광고)` 표시** | 명칭·연락처·수신거부 방법(시행령 별표 6) |
| **일본** | 특정전자메일법 | **원칙 opt-in** | 명함 교환 등 좁은 예외 | 명시 규정 없음 | 지체 없이 | 없음 | 송신자 성명/명칭, 거부 통지용 주소 표시 |
| **싱가포르** | Spam Control Act 2007 + PDPA | Spam Control Act는 **opt-out 체제**, PDPA는 개인정보 처리에 동의 필요 | 해당 없음 | 해당 없음 | **10 영업일**(SCA 부칙) | **제목 앞 `<ADV>` 표시** | 신원, 유효 주소 |

### 4.2 개인정보/데이터 측면

| 관할권 | 법적 근거 | 동의 증거 보관 | 국외 이전 | 미성년자 | 삭제/보관 |
|---|---|---|---|---|---|
| EU/EEA | GDPR | 제7조제1항 입증책임(기간 미규정) | 적정성 결정 / SCC / 파생 보호조치 | 정보사회서비스 동의 연령 16세, 회원국별 13~16세 조정 가능 | 제5조(1)(e) 목적 달성 시 삭제 |
| 영국 | UK GDPR + DUAA 2025 | 동일 | 영국 적정성 / UK IDTA / UK Addendum | 13세 | 동일 |
| 미국 | CAN-SPAM + 주별 포괄 개인정보법 | CAN-SPAM은 동의 개념 없음 | 제한 없음(연방 차원) | COPPA 13세 미만 | 주별 상이 |
| 캐나다 | CASL + PIPEDA | **동의 입증책임은 발신자**(CRTC 명시) | PIPEDA 책임 유지 | 주별/사안별 | PIPEDA |
| 호주 | Spam Act + Privacy Act 1988 (APP) | **동의 입증책임은 발신자**(ACMA 명시) | APP 8 국외 공개 | 사안별 판단 | APP 11.2 |
| 한국 | 개인정보보호법 + 정보통신망법 | 동의 기록 보관 필요(구체 기간은 검토 대상) | 개인정보보호법 제28조의8 국외 이전 요건 | **만 14세 미만 법정대리인 동의** | 법 제21조 파기 |
| 일본 | APPI + 특정전자메일법 | **동의 증명 기록 보존 의무(시행규칙)** — 송신 중단 시점 기준으로 산정 | APPI 제28조 외국 제3자 제공 | 16세 미만 관련 가이드라인 | APPI |
| 싱가포르 | PDPA | 동의 기록 | PDPA 이전 제한 규정 | 사안별 | PDPA 보관 제한 |

### 4.3 각 항목의 출처와 확인 결과

**EU/EEA**
- ePrivacy Directive 2002/58/EC 제13조: 직접 마케팅 목적 미요청 통신은 **사전 동의**
  필요. 동의는 GDPR 제4조(11) 기준을 충족해야 함(EDPB Opinion 5/2019).
  soft opt-in 조건: (a) 상품/서비스 **판매 맥락에서** 연락처 취득,
  (b) **자사의 유사한** 상품/서비스, (c) 취득 시점과 **매 메시지마다** 무료·간편한
  거부 기회 제공. 출처: [EUR-Lex 32002L0058](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32002L0058),
  [EDPB Opinion 5/2019](https://www.edpb.europa.eu/sites/default/files/files/file1/201905_edpb_opinion_eprivacydir_gdpr_interplay_en_0.pdf). 확인일 2026-08-21.
- **주의:** ePrivacy는 **지침(Directive)**이므로 회원국별 국내법이 다릅니다. 독일은
  UWG상 더 엄격한 실무, 프랑스 CNIL은 B2B/B2C를 달리 취급합니다.
  **회원국별 차이는 이 문서가 해결하지 못합니다(21절 Q1).**

**영국**
- PECR reg. 22 soft opt-in은 EU와 동일 구조.
- **Data (Use and Access) Act 2025**가 PECR reg. 22(3A)에 **자선 목적 soft opt-in**을
  신설했고 **2026-02-05 시행**. 우리 서비스는 자선단체가 아니므로 직접 적용은
  없으나, PECR이 최근 개정되었다는 사실 자체가 "이 영역은 움직인다"는 신호입니다.
  출처: [ICO — DUAA 2025: privacy and electronic communications](https://ico.org.uk/about-the-ico/what-we-do/legislation-we-cover/data-use-and-access-act-2025/the-data-use-and-access-act-2025-duaa-summary-of-the-changes/privacy-and-electronic-communications/),
  [ICO 보도 2026-04](https://ico.org.uk/about-the-ico/media-centre/news-and-blogs/2026/04/charities-given-new-flexibility-to-contact-supporters-under-data-law-change/). 확인일 2026-08-21.

**미국**
- FTC CAN-SPAM 준수 가이드: **유효한 물리적 우편 주소 필수**(현재 주소, USPS 등록
  사서함, 또는 등록된 상업용 사서함). 수신거부는 **10 영업일 내** 처리, 수신거부
  수단은 발송 후 **최소 30일간** 동작해야 함. 수수료 부과 금지, 이메일 주소 외
  개인정보 요구 금지, "회신 또는 웹페이지 1개 방문" 이상의 단계 요구 금지.
  출처: [FTC CAN-SPAM Act: A Compliance Guide for Business](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business). 확인일 2026-08-21.
- **선점(preemption):** 15 U.S.C. 7707은 상업용 이메일을 명시적으로 규율하는 주법을
  선점하되, **허위·기만을 금지하는 부분은 선점하지 않습니다.** 법원은 이 예외를
  좁게 해석해 왔습니다(제4순회). 실무적 함의: **발신자 정보와 제목의 정확성이
  주법 집단소송의 표적**이며, 특히 캘리포니아 Bus. & Prof. Code 17529.5가
  활발합니다. 출처: [15 U.S.C. 7707](https://uscode.house.gov/view.xhtml?req=granuleid%3AUSC-prelim-title15-section7707),
  [Cornell LII — CAN-SPAM preemption](https://law.cornell.edu/wex/inbox/can-spam_act_preemption). 확인일 2026-08-21.
- **주별 포괄 개인정보법(CCPA/CPRA 등)은 이메일 발송 자체를 규율하지 않지만**,
  개인정보 판매/공유 opt-out, 민감정보 제한, 보편적 opt-out 신호(GPC) 존중을
  요구합니다. **2026년 시점의 시행 주 목록은 확정하지 못했습니다(22절 A6).**

**캐나다**
- 명시적 동의는 만료되지 않음. **묵시적 동의**: 거래(구매/임대 등) 후 **2년**,
  문의/신청 후 **6개월**. 수신거부는 **10 영업일** 내 처리.
  **동의 입증책임은 발신자에게 있음**(CRTC 명시).
  출처: [CRTC — Guidance on Implied Consent](https://crtc.gc.ca/eng/com500/guide.htm),
  [CRTC FAQ](https://crtc.gc.ca/eng/com500/faq500.htm),
  [ISED — Getting consent to send email](https://ised-isde.canada.ca/site/canada-anti-spam-legislation/en/getting-consent-send-email). 확인일 2026-08-21.
- **설계 함의:** 묵시적 동의 만료는 **자동 계산이 가능하고 반드시 자동이어야
  합니다.** 사람이 캠페인마다 판단하면 반드시 틀립니다.

**호주**
- 동의 필요, **입증책임은 발신자**. 발신자 식별: **정확한 법인명 또는 이름 + ABN**,
  이 정보는 **발송 후 30일간 정확해야 함**. 수신거부는 **5 영업일** 내 처리 —
  조사 대상 관할권 중 **가장 짧습니다.** 수신거부에 추가 개인정보 요구 금지,
  **계정 로그인/생성 요구 금지**.
  출처: [ACMA — Avoid sending spam](https://www.acma.gov.au/avoid-sending-spam),
  [ACMA — Email and SMS unsubscribe rules (2024-05)](https://www.acma.gov.au/sites/default/files/2024-05/Fact%20sheet%20-%20email%20and%20SMS%20unsubscribe%20rules.pdf),
  [Spam Act 2003](https://www.legislation.gov.au/C2004A01214/latest). 확인일 2026-08-21.
- **설계 함의:** "로그인 요구 금지"가 **로그인 없는 unsubscribe token을 사실상
  의무화**합니다. 5 영업일이 전역 SLA의 기준선이 됩니다.

**한국**
- 정보통신망법 제50조: 영리목적 광고성 정보 전송은 **명시적 사전 동의** 필요.
- **제50조제8항: 동의를 받은 날부터 2년마다 수신동의 여부를 확인**해야 하며,
  위반 시 **3천만원 이하 과태료**.
- 제50조제4항 + 시행령 제61조제3항 [별표 6]: 광고성 정보에 명시할 사항과 방법.
  **전자우편은 제목이 시작되는 부분에 `(광고)` 표시**가 요구됩니다.
- 제50조제3항: **오후 9시~다음날 오전 8시** 전송에는 별도 사전 동의. 다만
  **대통령령이 정하는 매체는 예외**이며, **전자우편이 이 예외에 해당하는지 조문
  확인이 필요합니다(21절 Q4).** 확인 전까지는 야간 억제를 기본값으로 둡니다.
  출처: [국가법령정보센터 — 정보통신망법](https://www.law.go.kr/%EB%B2%95%EB%A0%B9/%EC%A0%95%EB%B3%B4%ED%86%B5%EC%8B%A0%EB%A7%9D%EC%9D%B4%EC%9A%A9%EC%B4%89%EC%A7%84%EB%B0%8F%EC%A0%95%EB%B3%B4%EB%B3%B4%ED%98%B8%EB%93%B1%EC%97%90%EA%B4%80%ED%95%9C%EB%B2%95%EB%A5%A0),
  [시행령 [별표 6] 영리목적의 광고성 정보의 명시사항 및 명시방법](https://www.law.go.kr/flDownload.do?flSeq=41072496),
  [방송통신위원회 법령정보](https://kcc.go.kr/user.do?boardId=1098&dc=K02030400&mode=view&page=A02030400).
  KISA/방통위 「스팸 방지를 위한 정보통신망법 안내서」 참조. 확인일 2026-08-21.
- 개인정보보호법: 만 **14세 미만**은 법정대리인 동의 필요. 국외 이전은 제28조의8.

**일본**
- 특정전자메일법(특정전자메일의 송신 적정화 등에 관한 법률, 2002년 제정,
  2008년 개정으로 **opt-in 규제** 도입): 사전 동의자 외 송신 금지, **표시 의무**
  (송신자 성명/명칭, 거부 통지 수신용 이메일 주소 등이 수신 단말 화면에 올바르게
  표시되어야 함), 송신자 정보 위조 금지, 거부자 송신 금지.
- **동의를 증명하는 기록의 보존 의무**가 시행규칙에 있으며, 보존 기간은 송신을
  중단한 시점 기준으로 산정됩니다(최종 송신일 기준 1개월 또는 1년 — **정확한
  적용은 21절 Q5**).
  출처: [소비자청 — 특정전자메일법](https://www.caa.go.jp/policies/policy/consumer_transaction/specifed_email/),
  [총무성 — 특정전자메일 송신 등에 관한 가이드라인](https://www.soumu.go.jp/main_content/000060967.pdf),
  [총무성 팸플릿(opt-in 방식, 동의 기록 보존)](https://www.soumu.go.jp/main_sosiki/joho_tsusin/d_syohi/pdf/m_mail_pamphlet.pdf),
  [e-Gov — 시행규칙](https://laws.e-gov.go.jp/law/414M60000008066/). 확인일 2026-08-21.
- **범위 결정 필요:** 저장소에 `ja` locale도 JPY 통화도 없습니다(2.5, 2.7). 22절 A3.

**싱가포르**
- Spam Control Act 2007: 미요청 상업용 전자 메시지는 **제목 앞에 `<ADV>` + 공백**
  표시. 수신거부 수단 제공 및 존중. **opt-out 체제**입니다.
- PDPA: 개인정보 수집/이용/공개에는 동의가 필요하므로, **마케팅 목적 이용에 대한
  PDPA 동의와 SCA의 opt-out 체제가 겹칩니다.** 실무적으로는 opt-in으로 운영하는
  것이 안전합니다.
  출처: [Spam Control Act 2007 (SSO)](https://sso.agc.gov.sg/Act/SCA2007),
  [PDPC — Advisory Guidelines on Requiring Consent for Marketing Purposes (2015-05-08)](https://www.pdpc.gov.sg/-/media/Files/PDPC/PDF-Files/Advisory-Guidelines/advisoryguidelinesonrequiringconsentformarketing8may2015.pdf),
  [IMDA — Best Practices for Organisations](https://www.imda.gov.sg/infocomm-regulation-and-guides/unsolicited-communications/best-practices-for-organisations). 확인일 2026-08-21.

### 4.4 범위 조정: 추가/제외 판단

| 관할권 | 판단 | 이유 |
|---|---|---|
| 한국 | **포함(1순위)** | KRW 결제, ko locale, 팀 소재 추정. 가장 요건이 많음 |
| 미국 | **포함(1순위)** | USD 기본 통화, en locale |
| EU/EEA | **포함(1순위)** | EUR 결제, de/fr/es/pt locale |
| 호주 | **포함(1순위)** | AUD 결제, analytics 정책의 유일한 notice_opt_out 국가 |
| 영국 | **포함** | USD 결제로 유입, EU와 요건 거의 동일하여 한계비용 낮음 |
| 캐나다 | **포함** | USD 결제로 유입. CASL 위반 리스크가 큼 |
| 싱가포르 | **포함(저비용)** | `<ADV>` 표시 규칙 하나만 추가하면 됨 |
| 일본 | **결정 필요 — 잠정 제외** | ja locale 없음, JPY 없음. 시장 진입 결정 전에 규제 대응만 만드는 것은 낭비. 22절 A3 |
| **중국** | **결정 필요 — 잠정 제외하되 경고** | **CNY 결제 통화와 zh locale이 이미 있습니다.** 중국은 PIPL(국외 이전에 CAC 보안평가/표준계약/인증 요구), 광고법, 그리고 이메일 관련 별도 규정이 적용됩니다. **본 문서는 중국을 조사하지 않았습니다.** CNY 결제를 받으면서 중국 거주자에게 마케팅을 보내는 것은 별도 검토 없이는 해서는 안 됩니다. 22절 A4 |
| 스위스 | 포함(EU와 동일 취급) | `analyticsConsentPolicy`가 이미 `CH`를 strict opt-in에 넣고 있음. revFADP는 별도이나 이메일 요건은 UWG 제3조(1)(o)로 opt-in |

---

## 5. 공통 규칙과 국가별 예외

### 5.1 모든 곳에 적용하는 공통 규칙 (최대공약수가 아니라 최대공배수)

국가별 분기를 최소화하는 방법은 **가장 엄격한 요건을 전역 기본값으로 삼는 것**입니다.
분기가 필요한 곳은 그렇게 해도 남는 곳뿐이고, 그 수는 놀랄 만큼 적습니다.

| # | 공통 규칙 | 어느 관할권에서 왔는가 |
|---|---|---|
| C1 | marketing은 **전역 opt-in**. opt-out 체제 국가(미국, 싱가포르)에도 opt-in 적용 | EU/UK/KR/CA/AU/JP |
| C2 | 수신거부는 **로그인 없이, 1클릭 이내**, 추가 정보 요구 없음 | 호주(로그인 요구 금지), 미국(1페이지 원칙) |
| C3 | 수신거부 반영은 **즉시(동기)**. SLA는 24시간, 상한은 **5 영업일** | 호주 5영업일이 최단 |
| C4 | 모든 marketing 메일에 **법인명 + 물리적 우편 주소 + 수신거부 링크 + 수신 이유** | 미국(주소), 호주(법인명/ABN), CASL |
| C5 | `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058) 헤더를 **marketing에만** 부착 | Gmail/Yahoo 대량 발신자 요건 + C2 |
| C6 | 동의는 **시각, 출처, 정책 버전, 관할권, 증거**를 함께 기록 | CASL/호주 입증책임, GDPR 제7조(1) |
| C7 | 동의 **재확인 주기 2년** 전역 적용 | 한국 제50조제8항이 최단 |
| C8 | 묵시적 동의는 **쓰지 않습니다** (soft opt-in 미사용) | 아래 5.3 |
| C9 | 발송 수단은 **transactional / marketing 도메인·스트림 완전 분리** | 전 관할권 + deliverability |
| C10 | transactional에는 unsubscribe 링크도 `List-Unsubscribe` 헤더도 **넣지 않음** | 오분류 방지 |
| C11 | 모든 메일에 **plain-text 대체본** 제공 | 접근성 + deliverability |
| C12 | 미성년자 기준 **만 14세** 전역 적용(가장 높은 기준) | 한국 개인정보보호법 |
| C13 | 발신자 정보는 발송 후 **최소 30일간** 유효 | 호주 |
| C14 | 수신거부 수단은 발송 후 **최소 30일간** 동작 | 미국 |

### 5.2 국가별로 남는 진짜 예외 (딱 여섯 개)

C1~C14를 적용하고 나면 국가별 분기는 여섯 개만 남습니다. **이것이 "정말 필요한
국가별 분기"의 전부입니다.**

| # | 예외 | 적용 국가 | 구현 위치 |
|---|---|---|---|
| E1 | **제목 접두어** `(광고)` | KR | `JurisdictionProfile.subjectPrefix` |
| E2 | **제목 접두어** `<ADV> ` | SG | 동일 필드 |
| E3 | **footer에 표시할 사업자 정보 집합** (한국: 사업자등록번호·통신판매업 신고번호 / 호주: ABN / 기타: 법인명+주소) | KR, AU, 기타 | `JurisdictionProfile.footerBlocks[]` |
| E4 | **수신거부 처리 SLA 표기** (5/10 영업일) | AU=5, US/CA/SG=10 | `JurisdictionProfile.unsubscribeSlaBusinessDays` — 표기용. 실제 처리는 항상 즉시 |
| E5 | **야간 발송 억제 창** (21:00~08:00 현지) | KR (매체 예외 확인 전까지) | `JurisdictionProfile.quietHours` |
| E6 | **묵시적 동의 만료 계산** | CA(2년/6개월) | C8로 인해 **미사용**. profile에 필드만 남기고 비활성 |

**나머지는 전부 공통입니다.** 템플릿 본문, 레이아웃, 버튼, 언어, 브랜딩은 국가로
분기하지 않습니다.

### 5.3 soft opt-in을 쓰지 않기로 하는 이유

EU/UK의 soft opt-in은 합법적이고 매력적입니다. 그런데 **조건을 정확히 만족시키는
비용이 얻는 것보다 큽니다.**

- "판매 맥락에서 취득"이어야 합니다. 우리는 **무료 가입과 게스트 체험**이 있고,
  이들은 판매가 아닙니다. 즉 사용자마다 취득 맥락을 구분해 저장해야 합니다.
- "자사의 유사한 상품/서비스"의 범위 판정이 매 캠페인마다 필요합니다.
- 회원국별로 해석이 다릅니다(4.3 EU 주의).
- **미국·싱가포르를 제외한 나머지 관할권에는 이 예외가 없습니다.** 따라서 soft
  opt-in을 쓰면 사용자 집합이 관할권별로 갈라지고, 관할권 판정이 틀리면 곧바로
  위반입니다.

**결론: C8. soft opt-in 미사용.** 전원 명시적 opt-in. 이 결정 하나가 관할권 판정
오류의 법적 결과를 크게 줄입니다 — 관할권을 틀려도 opt-in한 사람에게만 보내기
때문입니다. (**단, 이것은 사업적 결정이기도 합니다. 22절 A5.**)

---

## 6. 관할권 결정 로직과 불확실한 경우의 처리

### 6.1 신호 우선순위

IP는 **가장 약한 신호**이며 단독으로 관할권을 확정하지 않습니다.

| 순위 | 신호 | 출처 | 신뢰도 | 비고 |
|---|---|---|---|---|
| 1 | **계약 주체 관할권** | 사업자 간 계약(B2B) | 최상 | 현재 B2B 개념 없음. 22절 A1 |
| 2 | **청구 국가** | Stripe Customer `address.country` / 세금 ID | 높음 | 결제 수단 검증을 거침 |
| 3 | **사용자가 직접 신고한 국가** | 프로필 설정(신설 필요) | 높음 | 현재 `UserSettings`에 없음 |
| 4 | **동의 기록 시점의 관할권** | `ConsentRecord.jurisdiction` | 높음(과거 시점) | 동의의 유효성 판단에 사용 |
| 5 | 계정 언어 + 시간대 조합 | `UserSettings.language`, `timeZone` | 중간 | `Asia/Seoul` + `ko`는 강한 정황 |
| 6 | IP 국가 | `cf-ipcountry` | **낮음** | 단독 확정 금지 |

### 6.2 판정 알고리즘

```
resolveEmailJurisdiction(user) -> { code, confidence, source, conflicts[] }

1. 1~3순위 신호를 모은다.
2. 존재하는 최고 순위 신호를 채택한다.
3. 2순위와 3순위가 서로 다르면 -> conflict 기록.
   - marketing: 두 관할권 중 **더 엄격한 쪽**을 적용한다.
   - transactional/legal: 판정과 무관하게 발송한다.
4. 1~3순위가 하나도 없으면 5순위(언어+시간대)로 후보를 만들되
   confidence = "low"로 표시한다.
5. 그래도 없으면 code = "ZZ", confidence = "unknown".
6. IP(6순위)는 **판정에 쓰지 않고 conflict 관찰용으로만 기록**한다.
```

### 6.3 불확실할 때의 동작 (fail-closed)

`analyticsConsentPolicy`의 `ZZ -> opt_in` 원칙을 그대로 계승합니다.

| confidence | marketing | service/legal | transactional |
|---|---|---|---|
| high (1~3순위) | 해당 profile 적용 | 발송 | 발송 |
| low (5순위) | **가장 엄격한 profile 적용** (= `(광고)` 접두어 포함 KR 수준) | 발송 | 발송 |
| unknown (ZZ) | **가장 엄격한 profile 적용** | 발송 | 발송 |

**핵심:** 관할권 불명이 **transactional/legal 발송을 막아서는 안 됩니다.** 불명은
marketing을 더 보수적으로 만들 뿐입니다. 여기를 뒤집으면 계정 복구 불가가 됩니다.

### 6.4 관할권이 바뀌었을 때

- 청구 국가가 바뀌면 -> **재동의를 요구하지 않고**, 새 관할권 profile을 다음
  발송부터 적용합니다. 기존 `ConsentRecord`는 그대로 유효하되 `jurisdiction`
  필드는 **동의 당시 값을 보존**합니다(감사 기록이므로 소급 변경 금지).
- 다만 **새 관할권이 기존 동의로는 부족한 경우**(예: opt-out 체제에서 동의를 받아
  놓고 opt-in 체제로 이동)는 재동의가 필요합니다. C1(전역 opt-in)을 채택하면 이
  경우가 발생하지 않습니다 — **C8과 C1이 함께 관할권 이동 문제를 없앱니다.**

### 6.5 기존 analytics 판정과의 관계

**통합하지 않습니다.** 이유:

- analytics 동의는 **브라우저 세션**의 문제이고 IP가 실제로 관련 신호입니다.
- 이메일 동의는 **계정과 사람**의 문제이고 IP는 노이즈입니다.
- 두 판정을 하나로 합치면 한쪽 규제 변경이 다른 쪽을 조용히 바꿉니다.

AGENTS.md의 accent token 규칙 2번("역할이 다르면 값이 같아도 분리한다")과 같은
논리입니다. `STRICT_OPT_IN_COUNTRIES` 목록이 오늘 두 곳에서 같아 보여도, 별개
결정입니다.

---

## 7. 제공자 비교표

> 가격은 2026-08-21 기준 공개 정보에서 확인한 **개략치**이며, 실제 견적은 다를 수
> 있습니다. 계약 전 재확인이 필요합니다(22절 A7).

### 7.1 동일 기준 비교

| 기준 | **Resend** (현행) | **Postmark** | **AWS SES** | SendGrid | Mailgun | Customer.io | Braze |
|---|---|---|---|---|---|---|---|
| transactional 지원 | 강함 | **최강**(전문화) | 강함(원시적) | 강함 | 강함 | 보통 | 약함 |
| marketing 지원 | Broadcasts/Topics/Segments/Automations 보유 | Broadcast stream(기본적) | **없음**(직접 구현) | Marketing Campaigns | 보통 | **최강** | **최강** |
| 두 스트림 분리 | 도메인/API 키로 수동 분리 | **제품이 강제**(별도 IP·From 자동) | Configuration set으로 수동 | 수동 | 수동 | 해당 없음 | 해당 없음 |
| 템플릿 | 있음(사용 안 할 예정) | 있음 | 기본적 | 있음 | 있음 | 강함 | 강함 |
| 다국어 | 제공자 기능 아님(우리가 렌더) | 동일 | 동일 | 동일 | 동일 | locale 지원 | locale 지원 |
| suppression | Suppressions API + 대량 처리 | Stream별 suppression + Subscription Change webhook | account/configuration-set/tenant 3계층 | 있음 | 있음 | 있음 | 있음 |
| bounce/complaint | webhook | webhook | SNS/EventBridge | webhook | webhook | 있음 | 있음 |
| webhook 서명 | **Svix 서명** + `svix-id` 중복 제거 | 기본 인증/서명 | SNS 서명 검증 | 서명 | 서명 | 있음 | 있음 |
| idempotency | **Idempotency-Key 24h(이미 사용 중)** | 없음(직접 구현) | 없음(직접 구현) | 없음 | 없음 | 해당 없음 | 해당 없음 |
| **데이터 리전** | **미국 저장. EU 리전 없음.** DPF 인증 + SCC | 미국 | **리전 선택 가능**(`ap-northeast-2` 서울, `eu-central-1` 등) | 미국/EU | 미국/EU | 미국/EU | 다중 |
| 개인정보 조건 | SOC 2 Type II, GDPR, EU-US DPF + UK Extension, 공개 subprocessor 목록 | SOC 2 | AWS DPA, 다수 인증 | 인증 다수 | 인증 다수 | 인증 다수 | 인증 다수 |
| deliverability 기능 | 도메인 인증, 전용 IP 옵션 | **평판 관리가 강점**, 엄격한 가입 심사 | 직접 관리 | 있음 | 있음 | 발송은 위탁 | 발송은 위탁 |
| 전용 IP 필요 시점 | 월 수십만 통 이상 | 동일 | 동일 | 동일 | 동일 | - | - |
| 개발 복잡도 | **낮음(이미 통합됨)** | 낮음 | **높음** | 보통 | 보통 | 보통 | 높음 |
| 운영 복잡도 | 낮음 | 낮음 | **높음**(warm-up, 평판, 샌드박스 해제) | 보통 | 보통 | 보통 | 높음 |
| 예상 비용(월 5만 통) | 약 $20 | 약 $15~55 | **약 $5** | 약 $20~ | 약 $15~ | **$100+** | **연 단위 계약** |
| 비용 증가 구간 | 통수 구간제 | 통수 구간제 | 통당 종량 | 구간제 | 구간제 | **MAU/프로필 수 기준** | MAU 기준 |
| vendor lock-in | 낮음(우리가 렌더하면) | 낮음 | 낮음 | 보통 | 보통 | **높음**(여정·세그먼트가 제품 안에) | **매우 높음** |
| 저장소 통합 난이도 | **없음(완료됨)** | 중간(마이그레이션) | 높음 | 중간 | 중간 | 높음(데이터 동기화) | 매우 높음 |
| 장애 대응 | port 뒤에서 교체 | 동일 | 동일 | 동일 | 동일 | 어려움 | 어려움 |
| 규제 요건 충족 | 필요 기능 모두 보유 | 모두 보유 | 모두 보유(수작업) | 보유 | 보유 | 보유 | 보유 |

출처: [Postmark — Message Streams](https://postmarkapp.com/message-streams),
[Postmark — 브로드캐스트 모범사례](https://postmarkapp.com/guides/best-practices-for-broadcast-sending),
[Resend — Managing Webhooks](https://resend.com/docs/webhooks/introduction),
[Resend — GDPR](https://resend.com/security/gdpr), [Resend — DPA](https://resend.com/legal/dpa),
[Resend — SOC 2](https://resend.com/security/soc-2),
[AWS — SES account-level suppression list](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html),
[AWS — Regions and Amazon SES](https://docs.aws.amazon.com/ses/latest/dg/regions.html).
확인일 2026-08-21.

### 7.2 조사 중 발견한 대안

| 제품 | 성격 | 판단 |
|---|---|---|
| **Loops** | SaaS 특화 transactional+marketing 통합 | 소규모에 적합하나 Resend 대비 이점이 크지 않음. 관할권 footer 조립을 우리가 하면 차별점 소멸 |
| **MailerSend** | transactional 중심, EU(리투아니아) 기반 | **EU 데이터 위치가 요구사항이 되면 후보.** 22절 A2 |
| **Knock / Novu** | 알림 **오케스트레이션** 레이어(제공자 위에) | preference center와 다채널 팬아웃을 제품으로 제공. **현재 규모에서는 과잉이며, 우리가 필요한 것은 관할권 로직이지 다채널이 아님.** 2단계 재검토 대상 |
| **Twilio SendGrid** | 범용 | 이점 없음. 계정 정지 리스크 사례가 많음 |
| **Brevo** | EU(프랑스) 기반 통합 | EU 리전이 결정적이면 후보 |

### 7.3 왜 "기능이 많은 제품"이 정답이 아닌가

Braze/Customer.io는 요구사항의 상당 부분(preference center, suppression, 여정,
다국어 템플릿)을 **제품으로** 제공합니다. 그런데:

1. **관할권 규칙은 여전히 우리가 넣어야 합니다.** 어떤 제품도 "이 사용자는 한국
   관할이니 제목에 `(광고)`를 붙여라"를 우리 데이터 없이 알지 못합니다. 결국
   `JurisdictionProfile`을 만들어 제품에 밀어 넣게 되고, **그러면 정책이 두 곳에
   살게 됩니다** — 우리 DB와 벤더 콘솔에. 이것이 이 문서가 가장 피하려는 상태입니다.
2. **immutable audit snapshot 요구와 충돌합니다.** 벤더 콘솔에서 편집된 템플릿은
   우리 감사 기록이 아닙니다. "무엇이 실제로 발송되었는가"를 우리가 증명하지
   못하게 됩니다 — CASL과 호주의 **입증책임이 발신자에게 있다는 규칙**을 생각하면
   이것은 사소한 문제가 아닙니다.
3. **비용 구조가 프로필 수 기준**이라 무료 사용자가 많은 B2C SaaS에서 급격히
   비쌉니다.
4. 현재 팀 규모에서 **운영 인력이 없습니다.**

---

## 8. 최종 추천안과 추천하지 않은 대안의 이유

### 8.1 추천: **단일 transactional provider 중심 + 얇은 자체 abstraction**

정확히는 네 선택지 중 **1번(단일 transactional provider 중심)**이되, 다음을
덧붙입니다.

- **제공자: Resend 유지.** 이미 통합되어 있고, Idempotency-Key라는 우리 큐 설계의
  전제가 이미 동작하며, suppression/webhook/broadcast가 모두 있습니다.
- **차선책: Postmark.** transactional/broadcast 스트림 분리가 **제품 구조로
  강제**된다는 점이 우리 정책과 정확히 일치합니다. Resend에서 문제가 생기면 여기로.
- **데이터 위치가 결정적 제약이 되면: AWS SES** (`ap-northeast-2` 서울 /
  `eu-central-1`). 단 운영 부담을 감수해야 합니다.
- **marketing은 별도 제품이 아니라 별도 도메인/스트림으로 시작합니다.**
  `mail.tomverse.app`(transactional) vs `news.tomverse.app`(marketing) 형태.
  발송량이 월 수십만 통을 넘거나 세그먼트 기반 여정이 실제로 필요해질 때
  전용 marketing platform을 재검토합니다.

### 8.2 provider abstraction을 지금 도입할 것인가: **예, 단 얇게**

`lib/email.ts`가 이미 그 seam입니다. 지금 할 일은 **인터페이스를 만드는 것이 아니라
경계를 지키는 것**입니다.

**지금 도입할 것:**
```
EmailProviderPort {
  send(message: RenderedMessage, opts: { stream, idempotencyKey }): Promise<ProviderResult>
  verifyWebhook(rawBody, headers): Promise<VerifiedEvent | null>
}
```
- 구현체는 `ResendProvider` **하나만** 만듭니다.
- **템플릿, 연락처, 세그먼트, 자동화는 port에 넣지 않습니다.** 그것들은 우리
  DB에만 삽니다. 이것이 lock-in을 실질적으로 없애는 지점입니다.

**지금 도입하지 않을 것:** 다중 provider 라우팅, 자동 failover, provider별 기능
플래그. 구현체가 하나일 때 만드는 추상화는 그 하나의 모양을 그대로 굳힙니다.

### 8.3 첫 번째로 구현할 최소 기능

우선순위 순서 — **이 순서 자체가 권고입니다.**

1. **outbox 통합.** 2.4의 fire-and-forget 경로를 전부 `EmailEvent` -> `EmailDelivery`
   큐로 옮깁니다. **규제와 무관하게 지금 가장 큰 사용자 피해가 여기 있습니다.**
2. **`SuppressionEntry` + Resend webhook 수신** (bounce/complaint). 서명 검증과
   `svix-id` 기반 replay 방지 포함.
3. **`EmailPreference` + `ConsentRecord`** 스키마와 목적별 opt-in/opt-out.
4. **로그인 없는 unsubscribe token** + 최소 preference center.
5. **`JurisdictionProfile` + footer renderer.** transactional footer부터 적용하고
   marketing footer는 flag 뒤에.
6. **transactional/marketing 도메인 분리 및 DNS(SPF/DKIM/DMARC) 구성.**

### 8.4 지금 구현하지 말아야 할 과도한 기능

| 기능 | 왜 지금 아닌가 |
|---|---|
| open/click 추적 | EU/UK에서 **추적 픽셀은 그 자체가 동의 대상**(ePrivacy 제5조(3))입니다. 규제 표면을 넓히면서 현 단계에 주는 정보는 거의 없습니다 |
| 세그먼테이션, 여정(journey), A/B 테스트 | 보낼 marketing 메일이 아직 없습니다 |
| 다중 provider 자동 failover | 구현체가 하나입니다. 16절 |
| 전용 IP | 월 수십만 통 미만에서는 **오히려 도달률이 나빠집니다**(warm-up 트래픽 부족) |
| RTL 언어 지원 | ar/he locale이 없습니다. 다만 렌더러가 `dir` 속성을 **받을 수 있게만** 설계 |
| 국가별 템플릿 본문 분기 | 5.2에서 확인했듯 진짜 분기는 6개뿐이며 전부 footer/제목입니다 |
| SMS/푸시 다채널 | 알림 오케스트레이션은 별도 문제. `EmailPreference`를 `NotificationPreference`로 일반화만 해두고 채널은 이메일만 |
| 자체 unsubscribe 랜딩의 재구독 유도 UI | 호주 "추가 단계 요구 금지"와 충돌할 수 있습니다 |

### 8.5 transactional과 marketing의 명확한 경계

**단일 판정 규칙 — 이 세 질문에 하나라도 "예"면 marketing입니다.**

1. 사용자가 요청하지 않았는데, 사용자에게 **무언가를 사거나 쓰게 하려는** 내용이
   포함되어 있는가?
2. 이 메일을 **안 보내도 계약 이행과 법적 의무에 아무 영향이 없는가**?
3. 수신자 집합이 **개인의 요청이 아니라 우리의 선택**으로 정해지는가?

**기술적 경계 (코드가 강제):**

| | transactional/legal | marketing |
|---|---|---|
| 발송 도메인 | `mail.tomverse.app` | `news.tomverse.app` |
| Resend API 키 | 별도 | 별도 |
| suppression 조회 | hard bounce만 | hard bounce + complaint + **모든 목적별 opt-out** |
| unsubscribe 링크 | **없음** | **필수** |
| `List-Unsubscribe` 헤더 | **없음** | **필수** |
| 관할권 footer | 사업자 정보만 | 사업자 정보 + 광고 표시 + 수신 이유 |
| 제목 접두어 | 없음 | E1/E2 적용 |
| 관리자 승인 | 불요 | **대량 발송은 이중 승인** |
| 발송 속도 제한 | 없음 | 있음 |

**타입 수준에서 갈라야 합니다.** `sendMarketingEmail()`이 `TransactionalTemplate`을
받을 수 없어야 하고, 그 반대도 마찬가지입니다. 런타임 조건문으로 나누면 언젠가
누군가 조건을 뒤집습니다.

### 8.6 국가별 템플릿 분기: 정말 필요한 곳과 공통화할 곳

| 요소 | 판단 |
|---|---|
| 본문 카피, 레이아웃, 버튼, 브랜딩 | **완전 공통.** 언어로만 분기 |
| 제목 접두어 | **국가별** (E1, E2) |
| footer 사업자 정보 블록 | **국가별** (E3) |
| 수신거부 문구와 SLA 표기 | **국가별** (E4) — 문구만, 동작은 공통 |
| 발송 시간대 억제 | **국가별** (E5) |
| 언어 | **사용자별**(`UserSettings.language`), 국가와 독립. 한국 거주 영어 사용자는 `(광고)` + 영어 본문 |
| 시각 표기 | **사용자별**(`UserSettings.timeZone`) |
| 통화 표기 | **시장별**(`lib/billingMarkets.ts` 재사용) |

**언어와 관할권은 다른 축입니다.** 이것을 섞으면 `ko` = 한국이라는 가정이 코드에
들어가고, 미국의 한국어 사용자에게 틀린 footer가 갑니다.

### 8.7 규제 변경 시 배포 없이 갱신 가능한 범위

| 배포 없이 가능 | 배포 필요 |
|---|---|
| 국가를 profile에 추가/제거 | 새로운 **종류**의 요건 등장(예: 새 헤더 의무) |
| 제목 접두어 문자열 변경 | 새 이메일 **유형** 추가 |
| footer 블록 구성/문구 변경 | 동의 **모델**의 구조 변경 |
| 수신거부 SLA 표기 변경 | 새 **채널** 추가 |
| 야간 억제 창 변경 | 관할권 **판정 알고리즘** 변경 |
| 동의 재확인 주기 변경 | 새 preference **카테고리** 추가 |
| 국가별 opt-in/opt-out 체제 전환 | 렌더러 구조 변경 |
| 특정 국가 marketing 전면 중단 | |

**경계선:** profile은 **값**을 바꿉니다. **형태**를 바꾸려면 배포가 필요합니다.
이 경계를 명확히 해 두지 않으면 profile이 점점 튜링 완전해지고, 결국 배포보다
위험한 무엇이 됩니다. `JurisdictionProfile`에 표현식이나 조건 언어를 넣지 않습니다.

### 8.8 추천하지 않은 대안과 그 이유

| 대안 | 기각 사유 |
|---|---|
| **transactional provider + 별도 marketing platform** | 지금 보낼 marketing이 없습니다. 두 시스템의 suppression 동기화는 실패하기 쉽고, 동기화가 깨지면 **거부한 사람에게 메일이 갑니다.** 발송량이 임계를 넘으면 재검토 |
| **customer engagement platform 중심** | 7.3의 네 가지 이유. 특히 감사 스냅샷과 정책 이중화 문제 |
| **자체 abstraction을 둔 multi-provider** | 구현체가 하나인 추상화는 추상화가 아닙니다. 그리고 **중복 발송 없는 provider 전환은 abstraction이 아니라 outbox의 idempotency key가 보장**합니다 — 우리는 그것을 먼저 만듭니다 |
| **AWS SES로 즉시 이전** | 비용 절감액(월 $15 수준)이 운영 부담을 정당화하지 못합니다. 데이터 위치가 요구사항이 되면 그때 |
| 기존 `NotificationDelivery`를 그대로 사용자 메일에 확장 | `kind + referenceId` unique가 "이벤트당 1통"에는 맞지만 **"1000명에게 1통씩"에는 맞지 않습니다.** 수신자 축이 없습니다. 9절에서 해결 |

---

## 9. 제안 아키텍처와 이벤트 흐름

### 9.1 계층

```
  도메인 이벤트 (결제 성공, 약관 변경, 캠페인 발송)
        |
        v
  [1] EmailEvent  (outbox. 소스 트랜잭션과 같은 트랜잭션에서 기록)
        |
        v
  [2] Fan-out + Gating          <- 여기서 규제가 강제됨
        |  - 수신자 확정
        |  - 관할권 판정 (6절)
        |  - preference 확인 (분류별)
        |  - suppression 확인 (전역 + 목적별)
        |  - 동의 유효성 확인 (2년 재확인, 만료)
        |  - quiet hours 확인
        v
  [3] EmailDelivery (수신자 1명 x 이벤트 1건 = 행 1개, idempotencyKey 보유)
        |
        v
  [4] Renderer  (언어 x 템플릿버전 x 관할권profile -> RenderedMessage)
        |  결정적(deterministic). 같은 입력 -> 바이트 단위 같은 출력
        v
  [5] EmailProviderPort.send()  -> Resend (stream별 API 키)
        |
        v
  [6] ProviderWebhookEvent  <- bounce / complaint / delivered / unsubscribe
        |
        +--> SuppressionEntry 갱신
        +--> EmailDelivery 상태 갱신
```

### 9.2 왜 EmailEvent와 EmailDelivery를 나누는가

기존 `NotificationDelivery`는 이 둘이 합쳐져 있고(`kind + referenceId`), **그래서
수신자가 여럿인 발송을 표현하지 못합니다.**

- `EmailEvent` = **무슨 일이 일어났는가** (약관 v3.2가 게시되었다). 1건.
- `EmailDelivery` = **누구에게 무엇을 보내는가**. 수신자 수만큼.

이렇게 나누면:
- 이벤트는 소스 트랜잭션에서 즉시 커밋되고(유실 없음), fan-out은 비동기로
  천천히 진행할 수 있습니다(약관 변경 = 전체 사용자).
- **fan-out 자체가 재시작 가능**해야 합니다: `EmailEvent`에 커서를 두고
  `(eventId, userId)` unique로 중복 생성을 막습니다.
- gating 결과를 `EmailDelivery`에 **이유와 함께 기록**할 수 있습니다
  (`suppressed_complaint`, `no_consent`, `consent_expired`). 안 보낸 것도 증거입니다.

### 9.3 idempotency key 설계

```
idempotencyKey = hash(eventId, userId, templateVersionId, jurisdictionProfileVersion)
```

- Resend가 24시간 창에서 **같은 key + 같은 payload**만 억제하므로, 렌더러가
  결정적이어야 합니다. `lib/feedbackLifecycleEmails.ts`의 주석이 이미 이 계약을
  정확히 서술하고 있습니다 — **그 규율을 전체로 확대합니다.**
- 템플릿 버전이 key에 들어가므로, 템플릿을 고쳐 재발송하면 **의도적으로 다른
  key**가 되어 실제로 재발송됩니다. 이것이 맞는 동작입니다.
- 24시간을 넘는 재시도는 provider가 막아주지 않으므로 **우리 쪽 `EmailDelivery`
  상태가 최종 방어선**입니다.

### 9.4 재시도 정책 (분류별)

`lib/notificationRetryCore.ts`의 구조를 재사용하되 분류별 곡선을 둡니다.

| 분류 | 최대 시도 | 백오프 | 소진 시 |
|---|---|---|---|
| transactional (P0) | 8 | 10s, 30s, 1m, 5m, 15m, 1h, 4h | incident + 사용자에게 앱 내 대체 경로 |
| legal (P0) | 10 | 위 + 12h, 24h | **incident(critical) + 수동 후속 + 대체 채널** |
| service (P1) | 6 | 현행과 동일 | incident |
| marketing (P3) | 2 | 5m, 1h | **조용히 포기.** 프로모션 재시도는 가치보다 위험이 큼 |

**marketing의 관대한 재시도가 중요합니다.** 실패한 프로모션을 끈질기게 재시도하면
일시적 차단이 영구적 평판 손상이 됩니다.

### 9.5 dead-letter

`EmailDelivery.status = "abandoned"` 자체가 dead-letter입니다. 별도 테이블을 두지
않습니다 — 행을 옮기면 원래 맥락(시도 횟수, 오류 분류)이 흩어집니다. Admin에서
`abandoned` 필터로 조회하고, **legal 분류의 abandoned는 배지로 노출**합니다
(admin-console-ia 계약: "배지는 장식이 아니라 작업").

### 9.6 웹훅 처리

```
POST /api/webhooks/email/resend
 1. raw body 보존 (서명은 포맷에 민감)
 2. Svix 서명 검증 -> 실패 시 400, 본문 로그 금지
 3. svix-id 로 ProviderWebhookEvent upsert -> 이미 있으면 200 즉시 반환 (replay 방지)
 4. 트랜잭션: 이벤트 저장 + EmailDelivery 갱신 + SuppressionEntry 갱신
 5. 200
```

`StripeWebhookEventLog`가 이미 같은 패턴을 씁니다. **그 선례를 따릅니다.**
출처: [Resend — Managing Webhooks](https://resend.com/docs/webhooks/introduction)
(`svix-id` 저장 후 중복 스킵을 공식 권고). 확인일 2026-08-21.

### 9.7 Next.js 관련 배치

- 웹훅과 unsubscribe는 **Route Handler**로 두고 `runtime = "nodejs"`.
  서명 검증에 raw body가 필요하므로 Edge/미들웨어에서 처리하지 않습니다.
- fan-out과 drain은 **HTTP 요청 수명에 태우지 않습니다.** Railway cron ->
  `/api/internal/maintenance/*` 방식(현행 `run-notification-deliveries.mjs` 선례)을
  그대로 씁니다.
- **구현 전 확인:** Next 16.3.0의 Route Handler 시그니처, `after()` 지원 여부,
  캐시 기본값을 `node_modules/next/dist/docs/`에서 읽어야 합니다(2.1 참고).

---

## 10. 데이터 모델 초안 (개념 수준)

> Prisma 스키마 초안이 아니라 **개념 모델**입니다. 실제 필드/인덱스는 구현 시
> 확정합니다. 기존 스키마 관례(cuid id, `createdAt`/`updatedAt`, 상태는 String,
> 의미 있는 `@@unique`)를 따릅니다.

### 10.1 필요한 엔터티 판정

| 엔터티 | 필요? | 판단 |
|---|---|---|
| `EmailPreference` | **필요** | 목적별 on/off. 사용자당 목적당 1행 |
| `ConsentRecord` | **필요** | 불변 이력. preference와 **분리**해야 함(아래) |
| `JurisdictionProfile` | **필요** | 국가별 규칙 데이터 |
| `EmailTemplate` | **필요** | 템플릿 식별자와 분류 |
| `TemplateVersion` | **필요** | 불변 버전 |
| `EmailEvent` | **필요** | outbox |
| `EmailDelivery` | **필요** | 수신자별 발송 |
| `SuppressionEntry` | **필요** | 전역 + 목적별 억제 |
| `ProviderWebhookEvent` | **필요** | replay 방지 + 원본 보존 |
| `EmailPolicyVersion` | **필요** | profile 묶음의 버전. 아래 10.4 |

**10개 모두 필요합니다.** 다만 MVP에서 전부 만들지는 않습니다(15절).

### 10.2 핵심 엔터티

**`EmailPreference`** — 현재 상태(가변)
```
id, userId -> User (cascade)
purpose            "security" | "billing" | "service_status" | "product_updates"
                   | "newsletter" | "promotions"
enabled            Boolean
source             "signup" | "preference_center" | "unsubscribe_link"
                   | "admin" | "system_default"
updatedAt, createdAt
@@unique([userId, purpose])
```
- `security`와 `billing`은 **행이 존재하되 `enabled` 변경이 거부**됩니다.
  UI에서도 잠긴 상태로 보이되 숨기지 않습니다(사용자가 왜 받는지 알아야 함).

**`ConsentRecord`** — 이력(불변, append-only)
```
id, userId -> User (SetNull: 계정 삭제 후에도 증거 필요할 수 있음. 21절 Q6)
emailAddress       String   // 당시 주소. 변경돼도 보존
purpose            String
action             "granted" | "withdrawn" | "reconfirmed" | "expired"
occurredAt         DateTime
jurisdiction       String   // 당시 판정값. 소급 변경 금지
jurisdictionSource String   // "billing_country" | "self_declared" | ...
policyVersionId -> EmailPolicyVersion
capturedVia        "signup_form" | "preference_center" | "unsubscribe_page" | "import"
evidence           Json     // 동의 문구 원문 해시, UI 스크린 식별자, 요청 메타
ipHash             String?  // 원시 IP 저장 금지. 해시 + salt
userAgentHash      String?
expiresAt          DateTime? // C7의 2년 재확인 기한
@@index([userId, purpose, occurredAt])
@@index([expiresAt])
```
- **`EmailPreference`와 분리하는 이유:** preference는 "지금 어떤가", consent는
  "언제 무엇에 동의했는가"입니다. 캐나다·호주의 **입증책임**은 후자를 요구하고,
  전자는 덮어쓰기 때문에 증거가 되지 못합니다.
- **원시 IP를 저장하지 않습니다.** 동의 증거로는 해시로 충분하고, GDPR 최소수집
  원칙에 맞습니다. (`lib/operationalMonitoringCore.ts`가 이미 `cf-ipcountry`를
  민감 헤더로 다루는 선례가 있습니다.)

**`JurisdictionProfile`**
```
id
countryCode        String   // "KR", "AU", "ZZ"(fallback)
policyVersionId -> EmailPolicyVersion
marketingBasis     "opt_in" | "opt_out"     // 우리는 전역 opt_in(C1)이나 기록은 사실대로
subjectPrefix      String?  // "(광고)" | "<ADV> "
footerBlocks       Json     // ["legal_name","postal_address","business_registration",...]
unsubscribeSlaBusinessDays Int
consentReconfirmMonths     Int?   // KR=24
quietHours         Json?    // { start:"21:00", end:"08:00", tz:"local" }
impliedConsentDays Json?    // CASL. C8로 비활성
minimumAgeYears    Int      // 14 전역
notes              String   // 근거 출처와 확인일
@@unique([countryCode, policyVersionId])
```
- **표현식/조건 언어를 넣지 않습니다**(8.7).

**`EmailPolicyVersion`**
```
id, version        String   // "2026-08-21.1"
status             "draft" | "active" | "superseded"
activatedAt, supersededAt
approvedById, approvedByEmail, approvedAt
changeSummary      String
@@unique([version])
```
- 전체 `JurisdictionProfile` 집합의 스냅샷 버전. **profile을 개별 수정하지 않고
  새 policy version을 만들어 전환**합니다. 그래야 "그날 무슨 규칙이었나"에 답할 수
  있습니다. 릴리스 게이트 registry와 같은 사고방식입니다.

**`EmailTemplate` / `TemplateVersion`**
```
EmailTemplate:
  id, key            String  // "billing_receipt"
  classification     "transactional" | "service" | "legal" | "marketing"
  purpose            String? // marketing/service만. EmailPreference.purpose와 대응
  requiresUnsubscribe Boolean  // classification에서 파생되나 명시 저장(검사 가능)
  @@unique([key])

TemplateVersion:
  id, templateId -> EmailTemplate
  version            Int
  language           String   // 언어별 행
  subject, bodyHtml, bodyText
  contentHash        String   // 불변성 검증
  status             "draft" | "published" | "retired"
  publishedAt, publishedById
  @@unique([templateId, version, language])
```
- **published 이후 수정 불가.** 고치려면 새 버전. `contentHash`가 이를 검증합니다.

**`EmailEvent`** (outbox)
```
id
kind               String   // "billing.receipt", "legal.terms_changed"
templateId -> EmailTemplate
referenceType, referenceId  // 소스 행
payload            Json     // 렌더링에 필요한 최소 데이터만
audienceKind       "single_user" | "user_segment" | "all_users"
audienceSpec       Json?
status             "pending" | "expanding" | "expanded" | "failed"
expansionCursor    String?
createdAt
@@index([status, createdAt])
```

**`EmailDelivery`**
```
id
eventId -> EmailEvent
userId -> User?          // null 가능(게스트 support 회신 등)
emailAddress       String // 발송 시점 주소 (스냅샷)
language           String
jurisdiction       String
policyVersionId -> EmailPolicyVersion
templateVersionId -> TemplateVersion
idempotencyKey     String
status             "pending" | "sent" | "delivered" | "bounced" | "complained"
                   | "suppressed" | "skipped" | "abandoned"
skipReason         String?  // "no_consent" | "consent_expired" | "suppressed_complaint"
                   //  | "quiet_hours" | "hard_bounce"
attempts, nextAttemptAt, lastAttemptAt, lastErrorKind
providerMessageId  String?
renderedSubject    String   // 감사 스냅샷
renderedHash       String   // 본문 해시. 본문 자체는 저장하지 않음(10.3)
sentAt, deliveredAt
@@unique([eventId, userId])       // fan-out 중복 방지
@@unique([idempotencyKey])
@@index([status, nextAttemptAt])
```

**`SuppressionEntry`**
```
id
emailAddress       String   // 정규화(소문자)
scope              "global" | "purpose"
purpose            String?  // scope="purpose"일 때만
reason             "hard_bounce" | "complaint" | "unsubscribe" | "manual"
                   | "privacy_request"
source             "provider_webhook" | "unsubscribe_link" | "preference_center"
                   | "admin"
occurredAt
expiresAt          DateTime?  // soft bounce 임시 억제용. hard는 null(영구)
evidence           Json?
@@unique([emailAddress, scope, purpose])
@@index([emailAddress])
```
- **userId가 아니라 emailAddress 기준**입니다. 사용자가 계정을 지웠다 다시 만들어도
  스팸 신고는 그 주소에 남아야 합니다.

**`ProviderWebhookEvent`**
```
id
provider           String   // "resend"
providerEventId    String   // svix-id
eventType          String
receivedAt, processedAt
payload            Json     // 원본 보존
processingError    String?
@@unique([provider, providerEventId])
```

### 10.3 발송 내용의 immutable audit snapshot

**본문 전체를 저장하지 않습니다.** 대신:
- `TemplateVersion`(불변, `contentHash`) + `EmailDelivery.payload 참조` +
  `policyVersionId` + `renderedHash`
- 이 넷이 있으면 **결정적 렌더러로 원본을 재구성**하고 해시로 검증할 수 있습니다.

이유: 사용자 이름·금액 등이 들어간 완성 본문을 수백만 건 보관하면 그 자체가
개인정보 저장소가 되고, 삭제 요청이 오면 복잡해집니다. 기존
`NotificationDeliveries`가 이미 "본문을 저장하지 않고 재렌더링" 원칙을 씁니다.

**단, legal 분류는 예외로 완성 본문을 보관합니다.** "그날 정확히 무엇을
통지했는가"를 증명해야 하고, 건수가 적습니다.

### 10.4 User/UserSettings 변경

```
UserSettings:
  + country            String?   // 사용자가 직접 신고. 6.1의 3순위
  + countrySource      String?   // "self_declared" | "billing" | "inferred"
  + countryUpdatedAt   DateTime?
```
- `timeZone`이 이미 `timeZoneInitializedAt`/`timeZoneChangedAt`를 갖고 있으므로
  **같은 관례를 따릅니다.**
- `User.email` 변경 경로는 현재 없어 보입니다(next-auth OAuth + email login).
  이메일 변경 기능이 생기면 13.4를 반드시 구현해야 합니다.

---

## 11. Preference center 및 사용자 UX

### 11.1 배치

`docs/ui-contracts/settings-navigation.md` 계약을 따릅니다.

- Settings의 **`settingsNav.dataAndPersonalization` 그룹에 행 하나** 추가:
  "이메일 알림" -> `/settings/notifications` 상세 페이지.
- 상세 페이지 상단은 `settingsSectionHref()`로 settings에 복귀. `router.back()` 금지.
- 행 하나 = 링크 하나, 명시적 접근 가능 이름(제목 + 동작), 설명/상태는
  `aria-describedby`, 복귀 시 스크롤/포커스 복원.
- **기존 "가져오기"·"메모리" 행과 병합하지 않습니다.** 별개 기능입니다.

### 11.2 화면 구성

```
이메일 알림                                   받는 주소: u***@example.com [변경]

  보안 및 계정                                          [항상 켜짐]
    로그인 코드, 비밀번호 변경, 보안 경고
    > 이 알림은 계정 보호를 위해 꺼둘 수 없습니다.

  결제                                                  [항상 켜짐]
    영수증, 결제 실패, 구독 변경
    > 계약 이행을 위해 꺼둘 수 없습니다.

  서비스 상태                                           [ ON  ]
    장애, 예정된 점검
    > 보안 사고 통지는 이 설정과 무관하게 발송됩니다.

  제품 업데이트                                         [ OFF ]
    새 기능과 개선 사항

  뉴스레터                                              [ OFF ]
    Tomverse 소식과 활용법

  프로모션                                              [ OFF ]
    할인과 이벤트 안내
    > 동의일: 2026-08-21 | 재확인 예정: 2028-08-21     (동의한 경우에만)

  [ 모든 마케팅 수신 거부 ]

  발송 이력 보기 >
```

**설계 판단:**
- 잠긴 항목을 **숨기지 않고 잠긴 상태로 보여줍니다.** 사용자는 자기가 왜 메일을
  받는지 알 권리가 있고, "설정에 없는데 메일이 온다"가 스팸 신고의 주된 이유입니다.
- **재확인 예정일을 노출**합니다(C7). 한국 규정을 UI가 그대로 설명합니다.
- "모든 마케팅 수신 거부"를 별도 버튼으로 둡니다 — 항목별로 5번 누르게 하는 것은
  호주의 "추가 단계 요구 금지" 정신과 어긋납니다.
- **발송 이력**: 사용자가 자기에게 간 메일 목록(제목, 시각, 상태)을 볼 수 있게
  합니다. GDPR 접근권 대응이자 신뢰 장치입니다.

### 11.3 로그인 없는 수신 거부

**호주 규정상 필수입니다**(계정 로그인/생성 요구 금지).

```
GET  /unsubscribe?t=<token>     -> 확인 화면 (즉시 처리 + 되돌리기 제공)
POST /api/unsubscribe            -> One-Click (RFC 8058)
```

- **`GET`만으로 상태를 바꾸지 않습니다** — 메일 클라이언트의 링크 프리페치가
  의도치 않은 수신 거부를 일으킵니다. 대신:
  - `List-Unsubscribe-Post` One-Click 요청(`POST`)은 **즉시 처리**.
  - 사람이 링크를 클릭한 `GET`은 확인 화면을 보여주고 **한 번의 클릭으로 완료**.
    "1페이지 방문 + 1클릭"은 CAN-SPAM과 호주 요건을 모두 만족합니다.
- 확인 화면에서 **목적별 세분 선택**도 제공하되, 기본 동작은 "이 메일이 온 목적을
  끈다"입니다.
- 처리 후 "되돌리기" 링크를 30분간 제공(오클릭 구제). **재구독을 유도하는 마케팅
  문구는 넣지 않습니다.**

### 11.4 unsubscribe token 보안

| 요구 | 설계 |
|---|---|
| 위조 불가 | HMAC-SHA256, 서버 전용 secret. JWT 미사용(라이브러리 취약점 표면 축소) |
| 열거 불가 | payload에 `userId` 대신 **불투명 식별자**. 이메일 주소 평문 금지 |
| 범위 제한 | `{ subjectId, purpose, deliveryId, version }`만 서명. **다른 사용자 설정 변경 불가** |
| 만료 | **만료하지 않음.** CAN-SPAM은 최소 30일 동작을 요구하고, 오래된 메일에서 눌러도 동작해야 합니다. 대신 secret 회전 시 이전 버전 검증을 1년간 유지 |
| 재사용 | 멱등. 이미 거부 상태면 같은 결과 |
| 로그 유출 | **token은 URL 쿼리에 남습니다.** 접근 로그·Sentry·Referer에서 마스킹 필수 |
| 권한 상승 불가 | token으로는 **끄기만** 가능. 켜기는 로그인 필요 |

**"끄기만 가능"이 핵심입니다.** token이 유출돼도 최악의 결과가 "메일이 덜 온다"에
머물러야 합니다.

### 11.5 접근성과 plain-text

- 모든 메일에 **plain-text 대체본**. 현재 코드가 이미 `text`를 항상 보냅니다.
- 이미지에 대체 텍스트, 색상만으로 정보 전달 금지, 링크 텍스트는 목적을 서술
  ("여기를 클릭" 금지).
- 본문 최소 14px, 모바일 입력은 16px — 타이포그래피 계약과 정합.
- **RTL**: 지금 구현하지 않되, 렌더러가 `dir`과 논리 속성(`margin-inline-start`)을
  받을 수 있게 설계만 해 둡니다. 이메일 클라이언트의 CSS 지원 한계상 테이블
  레이아웃 방향 전환이 필요하므로, 실제 지원은 별도 작업입니다.

---

## 12. 관리자 발송 및 승인 UX

### 12.1 배치

`docs/ui-contracts/admin-console-ia.md` 계약 준수:
- `lib/adminNavigation.ts` + `components/admin/adminNavigationIcons.ts` + 실제 route
  세그먼트 **세 곳 동시 등록**. catch-all 금지.
- 섹션은 `?tab=`으로. 탭은 `<Link>`, 서버 컴포넌트가 `searchParams`를 읽습니다.
- 배지는 **작업이 있을 때만**: `abandoned` legal 발송 수, 승인 대기 캠페인 수.

제안 위치: `/admin/messaging` (탭: `발송함` / `캠페인` / `템플릿` / `억제 목록` / `관할권 정책`)

### 12.2 발송 플로우 (오분류를 구조로 막기)

```
1. 분류 선택 (가장 먼저, 되돌릴 수 없음)
   ( ) transactional   ( ) service   ( ) legal   ( ) marketing

   -> 선택 즉시 화면 전체가 바뀝니다:
      marketing:  수신자 = opt-in 사용자만. unsubscribe 강제. 승인 필수.
      legal:      수신자 = 전원(hard bounce 제외). unsubscribe 없음. 승인 필수.
      service:    수신자 = service_status ON. 승인 필요(단일 승인).

2. 템플릿 버전 선택 (published만)

3. 수신자 미리보기
   전체 12,431명
     - opt-in           1,204
     - suppressed          88   (bounce 12 / complaint 9 / unsubscribe 67)
     - 동의 만료           31   <- C7
     - quiet hours 대기    140  <- E5
   => 실제 발송 대상 1,173명

4. 관할권별 미리보기 (필수 단계)
   [KR/ko] [KR/en] [US/en] [AU/en] [DE/de] [ZZ/en] ...
   -> 각 조합의 실제 렌더 결과. 제목 접두어와 footer가 눈에 보여야 함.

5. 테스트 발송 (자신 + 지정 수신자 최대 5명)

6. dry-run (실제 발송 없이 EmailDelivery를 "skipped:dry_run"으로 생성)

7. 승인 요청 -> AdminActionApproval (payloadHash)

8. 승인자가 4번 미리보기를 다시 보고 승인

9. 발송 (속도 제한 적용, 진행 상황 실시간)
```

**분류를 맨 처음 고르게 하고 되돌릴 수 없게 하는 것**이 이 화면의 핵심입니다.
마지막에 고르게 하면 "이미 다 썼는데 marketing이면 수신자가 1,173명뿐이네"라는
상황에서 legal로 바꾸고 싶어집니다. 3.2의 #9가 말한 바로 그 실패입니다.

### 12.3 승인 규칙

기존 `AdminActionApproval`을 재사용합니다(`payloadHash`, `expiresAt`, `consumedAt`).

| 조건 | 승인 |
|---|---|
| 테스트 발송 (5명 이하, 지정 주소) | 불요 |
| transactional (시스템 트리거) | 불요 |
| service, 1,000명 미만 | 단일 승인 |
| service, 1,000명 이상 | **이중 승인** |
| marketing (전량) | **이중 승인** |
| legal (전량) | **이중 승인** |
| 관할권 정책(`EmailPolicyVersion`) 활성화 | **이중 승인** |
| 억제 목록에서 주소 제거 | **이중 승인 + 사유 필수** |

- `payloadHash`가 승인 후 **내용 변경을 막습니다** — 이미 있는 메커니즘입니다.
- **1인 조직 예외:** `shared-packages.md`의 `soleApproverAllowed` 선례를 따릅니다.
  담당자가 한 명이면 이중 승인이 충족 불가능하고, 그러면 모든 발송이 영구 차단
  됩니다. registry에 명시적으로 기록된 허용으로 다루고, 두 번째 담당자가 생기면
  플래그 한 줄로 되돌립니다.

### 12.4 억제 목록 관리

- 조회, 사유, 출처, 시각 표시.
- **제거는 이중 승인 + 사유 필수.** complaint 제거는 "사용자가 직접 재구독을
  요청함"이라는 증거 없이는 금지 — 스팸 신고자에게 다시 보내는 것이 계정 차단으로
  가는 가장 빠른 길입니다.
- CSV 내보내기는 있고, **CSV 가져오기는 없습니다**(대량 오염 방지).

### 12.5 관할권 정책 편집

- `EmailPolicyVersion`을 **draft로 만들고** profile들을 편집한 뒤, 미리보기로
  각 국가 footer를 확인하고, **이중 승인 후 활성화**합니다.
- 활성화는 원자적: 새 버전이 활성화되면 이전 버전은 `superseded`. 진행 중인
  `EmailDelivery`는 **자기가 붙잡은 `policyVersionId`를 계속 사용**합니다
  (렌더 결정성 유지 -> idempotency key 유효).
- 편집 화면에 **각 필드의 근거 출처와 확인일**(`notes`)을 함께 표시합니다.
  이 문서 4.3의 내용이 그대로 들어갑니다.

### 12.6 rate limit

- 관리자 발송 API: `consumeApiRateLimit()` 재사용.
- 캠페인 발송 자체: 초당 통수 상한(제공자 한도 이하), 그리고 **quiet hours 준수**로
  자동 지연.
- 테스트 발송: 관리자당 분당 5회 / 일 30회 (현행 `admin-test-email` 선례와 동일).

---

## 13. 보안, 개인정보, 감사 설계

### 13.1 개인정보 최소 수집

| 데이터 | 처리 |
|---|---|
| 이메일 주소 | 저장 필요. `EmailDelivery`에 발송 시점 스냅샷 |
| IP (동의 증거) | **원시 저장 금지.** salt+hash. `ConsentRecord.ipHash` |
| User-Agent | 해시 |
| 렌더된 본문 | **저장 안 함**(legal 제외). `renderedHash`만 |
| open/click | **수집 안 함**(8.4) |
| 제공자 웹훅 원본 | `ProviderWebhookEvent.payload`에 보존하되 **보관 기간 제한** |

### 13.2 보관과 삭제

| 데이터 | 보관 | 근거 |
|---|---|---|
| `ConsentRecord` | **동의 철회 후 최소 3년** (잠정) | 입증책임(CASL/호주). **정확한 기간은 21절 Q6** |
| `SuppressionEntry` (complaint/unsubscribe) | **영구** | 삭제하면 다시 보내게 됨. GDPR 제17조(3)(b) 법적 의무 이행 근거 |
| `EmailDelivery` | 13개월 | 분쟁 대응 + deliverability 분석 |
| `EmailDelivery` (legal 분류, 본문 포함) | **7년** (잠정) | 법정 통지 증명. 21절 Q6 |
| `ProviderWebhookEvent` | 90일 | replay 방지에 필요한 기간 + 여유 |
| `EmailEvent` | 13개월 | |

- 기존 `AdminRetentionRun` 배치에 규칙을 추가합니다.
- **계정 삭제와의 상호작용:** 사용자 계정을 지워도 `SuppressionEntry`는
  **주소 기준으로 남습니다.** 이것은 GDPR 삭제권의 예외(법적 의무 준수)에
  해당한다고 보지만, **21절 Q6에서 확인이 필요합니다.** 개인정보처리방침에
  명시해야 합니다.

### 13.3 suppression과 transactional의 충돌

**가장 어려운 설계 지점입니다.**

| 억제 사유 | transactional | legal | service | marketing |
|---|---|---|---|---|
| hard bounce | **차단**(주소가 없음) | **차단** + 대체 채널 | 차단 | 차단 |
| complaint (스팸 신고) | **발송**(아래) | 발송 | 차단 | 차단 |
| unsubscribe | 발송 | 발송 | 목적별로 판단 | 차단 |
| soft bounce (일시) | 재시도 | 재시도 | 재시도 | 차단 |

**complaint에도 transactional을 보내는 이유:** 사용자가 프로모션을 스팸 신고했다고
로그인 코드를 막으면 계정에서 잠깁니다. 법적으로도 transactional은 동의 대상이
아닙니다.

**그러나 이것은 도달률 리스크입니다.** 완화책:
1. transactional과 marketing 도메인이 분리되어 있으므로, marketing 도메인의
   complaint가 transactional 도메인 평판에 직접 전이되지 않습니다. **C9가 이
   문제의 실질적 해법입니다.**
2. 같은 주소에서 transactional complaint가 반복되면 **critical incident**로 올리고
   사람이 판단합니다.

### 13.4 이메일 주소 변경 시 처리

현재 저장소에 이메일 변경 경로가 보이지 않습니다. **생기면 반드시 다음을
구현해야 합니다.**

1. 새 주소 **검증 완료 전까지** 어떤 것도 옮기지 않습니다.
2. **동의는 자동으로 이전되지 않습니다.** 관할권에 따라 동의는 특정 주소에
   결부되며, 특히 주소가 다른 사람에게 넘어간 경우(회사 이메일 등) 새 사람에게
   동의 없이 마케팅을 보내게 됩니다.
   -> **권고: marketing 동의는 주소 변경 시 초기화하고 재동의를 요청합니다.**
   transactional/legal은 새 주소로 계속됩니다.
3. **suppression은 이전하지 않습니다**(주소 기준이므로). 옛 주소의 억제는 옛
   주소에 남습니다.
4. 이전 주소로 **변경 사실을 통지**합니다(계정 탈취 탐지).
5. `ConsentRecord`에 `emailAddress` 스냅샷이 있으므로 이력은 보존됩니다.

### 13.5 웹훅 보안

- Svix 서명 검증 필수, raw body 사용.
- `svix-id` 기반 replay 방지(`ProviderWebhookEvent` unique).
- 타임스탬프 허용 창(예: 5분) 확인.
- 검증 실패 시 **본문을 로그에 남기지 않습니다.**
- 엔드포인트에 rate limit.
- **`StripeWebhookEventLog` 선례를 그대로 따릅니다.**

### 13.6 SSRF / 주입 방지

- 템플릿에 들어가는 모든 사용자 데이터는 HTML 이스케이프. 기존 코드가 이미
  `escapeHtml`을 쓰고 있으나 **모듈마다 재정의**되어 있습니다 -> 하나로 통합.
- 템플릿에 임의 URL을 넣을 수 있게 하지 않습니다(관리자 입력 포함). 링크는
  허용 목록 기반.
- unsubscribe token은 URL 로그에서 마스킹.
- 관리자 발송 미리보기가 **실제 사용자 데이터를 렌더**하므로, 미리보기 접근에도
  권한 검사와 감사 로그가 필요합니다.

### 13.7 감사

모든 다음 행위를 `AdminAuditLog`에:
- 캠페인 생성/승인/발송/취소
- 템플릿 버전 게시/폐기
- 억제 항목 추가/제거(제거는 사유 포함)
- `EmailPolicyVersion` 생성/활성화
- 테스트 발송
- 사용자 preference의 **관리자에 의한** 변경

---

## 14. Deliverability 운영 계획

### 14.1 도메인과 DNS

| 용도 | 도메인 | 비고 |
|---|---|---|
| transactional | `mail.tomverse.app` | 현행 `hello@tomverse.app`에서 이전 |
| marketing | `news.tomverse.app` | 신규 |
| 운영자 내부 알림 | transactional 재사용 | 외부 발송 아님 |

각 도메인에:
- **SPF**: 제공자 include만. **10 DNS lookup 한도**에 유의.
- **DKIM**: 제공자 발급 키. 2048비트 권장.
- **DMARC**: `p=none`으로 시작 -> 리포트 수집 -> `p=quarantine` -> `p=reject`.
  **루트 도메인(`tomverse.app`)에도 DMARC를 두고 서브도메인 정책(`sp=`)을 명시.**
- **Return-Path(bounce 도메인)**: 제공자 관리 도메인이 아니라 **우리 서브도메인으로
  커스텀 설정**해 정렬(alignment)을 맞춥니다.
- **BIMI**: 지금 하지 않습니다(VMC 비용 대비 이점 낮음).

### 14.2 대량 발신자 요건

Gmail/Yahoo/Microsoft의 대량 발신자 요건(일 5,000통 이상 기준)은 이미 업계 표준
기준선입니다. 우리가 그 규모가 아니어도 **처음부터 충족하도록** 만듭니다:
- SPF + DKIM + DMARC 정렬
- marketing에 **One-Click unsubscribe**(RFC 8058)
- **스팸 신고율 0.3% 미만 유지**(0.1% 목표)
- 유효한 정방향/역방향 DNS, TLS 전송

### 14.3 전용 IP

- **지금 도입하지 않습니다.** 월 발송량이 적을 때 전용 IP는 warm-up 트래픽이
  부족해 공유 IP보다 나쁩니다.
- 검토 시점: **marketing 단독으로 월 10만 통을 안정적으로 넘길 때.**

### 14.4 목록 위생

- hard bounce -> 즉시 영구 억제.
- soft bounce -> 연속 N회(예: 5회) 후 억제, 카운터는 성공 시 리셋.
- complaint -> 즉시 영구 억제 + 해당 목적 opt-out.
- **비활동 정리:** 12개월간 열지도(추적 안 하므로 대신 로그인 안 함) 않은
  marketing 수신자는 발송 대상에서 제외. C7의 2년 재확인이 이것을 자연스럽게
  수행합니다.

### 14.5 모니터링

| 지표 | 임계 | 조치 |
|---|---|---|
| bounce rate | > 2% | 경고 |
| bounce rate | > 5% | marketing 발송 자동 중단 |
| complaint rate | > 0.1% | 경고 |
| complaint rate | > 0.3% | **marketing 발송 자동 중단** |
| transactional 발송 실패율 | > 1% | incident |
| `abandoned` legal 발송 | >= 1 | **critical incident** |
| 큐 깊이 | 기존 `NOTIFICATION_QUEUE_DEPTH_ALERT` 준용 | incident |

`reportOperationalIncident()`를 그대로 씁니다. **자동 중단(kill switch)은
marketing에만 적용**하고 transactional은 절대 자동 중단하지 않습니다.

### 14.6 warm-up

marketing 도메인 신설 시 4~6주 warm-up:
- 1주차 일 50통(가장 최근 동의자부터), 이후 매주 배증.
- **가장 참여도 높은 수신자부터** 보내는 것이 핵심입니다.
- warm-up 중 complaint rate가 0.1%를 넘으면 즉시 중단하고 재검토.

---

## 15. MVP 범위

### 15.1 MVP에 포함 (Phase 1)

**목표: 지금 보내고 있는 메일을 안전하고 신뢰할 수 있게 만든다. 마케팅은 아직 없다.**

| # | 항목 | 완료 조건 |
|---|---|---|
| M1 | `EmailEvent` + `EmailDelivery` outbox 도입 | 2.4의 **모든** 직접 발송 경로가 큐를 경유. 프로세스가 죽어도 메일이 유실되지 않음을 통합 테스트로 증명 |
| M2 | `EmailTemplate` + `TemplateVersion`, 이메일 카피 통합 | 3개 모듈의 중복 `EmailLanguage`/`normalizeLanguage`/`escapeHtml` 제거. 언어 추가가 한 곳에서 끝남 |
| M3 | Resend 웹훅 수신 + `ProviderWebhookEvent` | Svix 서명 검증, `svix-id` replay 방지, 중복 전달이 상태를 두 번 바꾸지 않음 |
| M4 | `SuppressionEntry` + hard bounce/complaint 자동 억제 | 13.3 표대로 분류별 동작. bounce된 주소로 재발송하지 않음 |
| M5 | `EmailPreference` (6개 목적) + 잠금 규칙 | security/billing은 API로도 끌 수 없음 |
| M6 | `ConsentRecord` append-only | 모든 preference 변경이 이력을 남김. 원시 IP 미저장 |
| M7 | `JurisdictionProfile` + `EmailPolicyVersion` + footer renderer | 8개 관할권 + `ZZ` fallback. 6.3의 fail-closed 동작 |
| M8 | 관할권 판정 (`resolveEmailJurisdiction`) | IP 단독 판정 없음. conflict 기록. `UserSettings.country` 추가 |
| M9 | unsubscribe token + `/unsubscribe` + One-Click | 로그인 불필요. `GET`이 상태를 바꾸지 않음. 끄기만 가능 |
| M10 | preference center (`/settings/notifications`) | settings-navigation 계약 준수. desktop/mobile 동일 |
| M11 | transactional 도메인 분리 + SPF/DKIM/DMARC | `mail.tomverse.app`에서 발송, DMARC `p=none` 리포트 수집 시작 |
| M12 | `EmailProviderPort` (Resend 구현 1개) | 템플릿/연락처/세그먼트가 port에 없음 |
| M13 | 분류별 재시도 정책 | 9.4 표대로. legal abandoned가 critical incident |
| M14 | 감사 로그 + 발송 이력 조회 | 13.7의 모든 항목 |

### 15.2 MVP에 만들되 **비활성**으로 두는 것 (법률 검토 대기)

`AppSetting`의 flag 뒤에 fail-closed로 둡니다. **활성화는 법률 검토 완료 후.**

| 항목 | flag | 활성화 조건 |
|---|---|---|
| marketing 분류 발송 | `feature.emailMarketingEnabled` | 21절 Q1, Q2, Q8 회신 |
| marketing 도메인(`news.`) | 동일 | 위 + warm-up 계획 승인 |
| `(광고)` / `<ADV>` 접두어 적용 | 정책 활성화로 제어 | Q4(한국), 싱가포르 확인 |
| 관리자 대량 발송 UI | `feature.emailCampaignsEnabled` | 승인 프로세스 확정 |
| 동의 2년 재확인 배치 | `feature.emailConsentReconfirmEnabled` | marketing 활성화 이후 의미 있음 |
| quiet hours 억제 | 정책으로 제어 | Q4 |

**"만들되 끈다"는 이유:** 규제 확인은 몇 주가 걸리는데 그동안 구조를 못 만들면
나중에 급하게 만들게 되고, 급하게 만든 동의 시스템이 정확히 이 문서가 막으려는
것입니다. 반대로 flag만 켜면 되는 상태로 대기시키면 법률 검토 결과를 그대로
데이터에 반영할 수 있습니다.

### 15.3 MVP에서 제외

- 8.4의 전체 목록(open/click, 세그먼트, 여정, A/B, 전용 IP, RTL, 다채널,
  다중 provider failover)
- 실제 marketing 캠페인 발송
- 이메일 주소 변경 기능(현재 없음. 생길 때 13.4 적용)
- 일본/중국 관할권 profile(22절 A3, A4 결정 후)

---

## 16. 2단계 및 장기 로드맵

### Phase 2 (법률 검토 완료 후, 약 1~2개월)

| 항목 | 내용 |
|---|---|
| marketing 발송 활성화 | flag 해제, `news.` 도메인 warm-up 시작(14.6) |
| 관리자 캠페인 UI | 12.2의 전체 플로우 + 이중 승인 |
| 동의 2년 재확인 배치 | 만료 30일 전 알림 -> 만료 시 자동 opt-out + `ConsentRecord("expired")` |
| DMARC 강화 | `p=none` -> `p=quarantine` -> `p=reject` |
| 가입 플로우 동의 수집 | 회원가입 시 목적별 opt-in 체크박스(사전 선택 금지). `analyticsConsentPolicy`의 UI 선례 참고 |
| 사용자 발송 이력 화면 | 11.2의 "발송 이력 보기" |
| 릴리스 게이트 등록 | `docs/release-gates/`에 EMAIL-01 이하 게이트 추가 |

### Phase 3 (6~12개월, 규모가 요구하면)

| 항목 | 착수 조건 |
|---|---|
| 전용 IP | marketing 월 10만 통 안정적 초과 |
| 세그먼테이션/여정 | 실제 marketing 프로그램이 존재하고, 수동 운영이 병목일 때 |
| open/click 추적 | **추적 자체에 대한 별도 동의**를 preference center에 추가한 뒤에만 |
| 별도 marketing platform | 위 두 개가 모두 필요해졌을 때. 그때도 suppression은 우리 DB가 source of truth |
| 다채널(SMS/푸시/인앱) | `EmailPreference` -> `NotificationPreference` 일반화. Knock/Novu 재검토 |
| 두 번째 provider | 아래 16.1 |
| RTL / ar·he locale | 해당 시장 진입 결정 시 |
| 일본/중국 관할권 | 시장 진입 결정 시. **중국은 별도 규제 조사 필수** |

### 16.1 장애 시 중복 발송 없이 provider를 전환할 수 있는가

**예. 단, abstraction 때문이 아니라 outbox 때문입니다.**

- `EmailDelivery.status`가 우리 쪽 진실이고, `providerMessageId`가 붙기 전까지는
  "보냈는지 모름" 상태입니다.
- provider A가 죽어서 B로 넘길 때 **A가 이미 수락한 메일을 B가 다시 보낼 수
  있습니다.** provider의 idempotency key는 provider 간에 공유되지 않습니다.
- 완화:
  1. transactional만 전환(marketing은 그냥 기다립니다 — 프로모션이 두 번 가는 것이
     더 나쁩니다).
  2. `sentAt`이 기록된 건은 전환 대상에서 제외하고, 미확정 건만 넘깁니다.
  3. **중복 가능성을 명시적으로 수용**합니다. 로그인 코드가 두 통 오는 것이
     한 통도 안 오는 것보다 낫습니다.
- **자동 failover는 만들지 않습니다.** 운영자가 flag를 뒤집는 수동 전환입니다.
  자동 전환은 provider의 일시적 5xx에 반응해 절반의 메일을 두 번 보냅니다.

---

## 17. Migration 및 rollout 계획

### 17.1 기존 데이터

- **기존 사용자에게 marketing 동의가 없습니다.** 이것은 문제가 아니라 정상입니다.
  마케팅을 보낸 적이 없으므로 마이그레이션할 동의도 없습니다.
- 모든 기존 사용자에 대해:
  - `EmailPreference`: `security`/`billing`/`service_status` = ON(system_default),
    `product_updates`/`newsletter`/`promotions` = **OFF**.
  - `ConsentRecord`: 생성하지 않습니다. **동의한 적이 없으므로 동의 기록을 만들면
    거짓입니다.** 이것을 지키는 것이 중요합니다.
- `UserSettings.country`: NULL로 시작. Stripe 청구 국가가 있는 계정은 배치로
  `countrySource = "billing"`으로 채웁니다. **IP로 채우지 않습니다.**
- 기존 `NotificationDelivery`: **그대로 둡니다.** 신규 발송만 새 큐를 씁니다.
  두 큐가 한동안 공존하고, 기존 큐가 비면 제거합니다.

### 17.2 발송 경로 이전 순서

위험이 낮은 것부터. 각 단계마다 실제 발송을 관찰하고 다음으로 갑니다.

1. 관리자 테스트 메일 (영향 없음)
2. 운영자 알림 (provider 리포트, incident) — 내부 수신자
3. 지원/피드백 lifecycle (이미 큐에 있음 — 새 큐로 이전)
4. 환불 관련 (이미 큐에 있음)
5. 계정 환영 메일
6. 결제 관련 (Stripe webhook)
7. 계정 삭제/복구 통지
8. **로그인 코드 — 마지막.** 실패가 가장 치명적이므로 다른 모든 경로가 안정된 뒤

### 17.3 도메인 전환

1. `mail.tomverse.app` DNS 구성, Resend에서 검증.
2. DMARC `p=none`으로 리포트만 수집(2주).
3. transactional 발송을 신규 도메인으로 전환. **From 주소가 바뀌므로 사용자가
   기존 필터를 잃습니다** -> 전환 전 안내 메일 1회(기존 도메인에서).
4. 리포트 정상 확인 후 `p=quarantine` (Phase 2).
5. `news.tomverse.app`은 marketing 활성화 시점에 별도 구성 + warm-up.

### 17.4 rollout 안전장치

- 모든 신규 경로는 `AppSetting` flag 뒤에서 시작.
- **shadow 모드:** outbox에 `EmailDelivery`를 생성하되 실제 발송은 기존 경로가
  담당. 두 결과를 비교해 gating 로직이 예상대로 동작하는지 확인한 뒤 전환.
  (`trace-feedback-automation.md`의 Phase 2 shadow mode 선례와 같은 방식)
- 롤백: flag 하나로 이전 경로 복귀. 스키마 변경은 additive만(컬럼 삭제 없음).

---

## 18. 테스트 전략과 acceptance criteria

### 18.1 계층별

| 계층 | 대상 | 도구 |
|---|---|---|
| 순수 함수 단위 | 관할권 판정, gating, 재시도, 렌더러 결정성, token | `npm run test:unit` (node:test) |
| DB 통합 | outbox 원자성, fan-out 재시작, unique 제약, suppression | `npm run test:db:integration` |
| 서버 계약 | 웹훅 서명/replay, unsubscribe 엔드포인트 | `npm run test:server-contract` |
| E2E | preference center(desktop+mobile), unsubscribe 플로우, 관리자 발송 | Playwright |
| 정적 검사 | 분류/템플릿 정합성 (신규 `check:email-classification`) | PR Fast Gate |

### 18.2 반드시 있어야 하는 테스트

**분류 불변식 (정적 검사로 강제)**
- `classification = "marketing"` 인 모든 템플릿은 `requiresUnsubscribe = true`.
- `classification = "transactional" | "legal"` 인 템플릿은 렌더 결과에
  unsubscribe 링크와 `List-Unsubscribe` 헤더가 **없어야** 함.
- 모든 marketing 템플릿은 `purpose`를 가지며 그 값이 `EmailPreference.purpose`에
  존재.
- **모든 지원 언어에 대해 published `TemplateVersion`이 존재.** 없으면 빌드 실패
  (현재 `normalizeLanguage`가 조용히 `en`으로 떨어지는 문제의 근본 해결).

**gating (단위)**
- marketing + opt-in 없음 -> `skipped:no_consent`
- marketing + 동의 만료 -> `skipped:consent_expired`
- marketing + complaint suppression -> `skipped:suppressed_complaint`
- **transactional + complaint suppression -> 발송됨** (13.3)
- **legal + marketing opt-out -> 발송됨**
- legal + hard bounce -> `skipped:hard_bounce` + critical incident
- 관할권 unknown + marketing -> **가장 엄격한 profile 적용**
- 관할권 unknown + transactional -> **발송됨** (6.3)

**렌더러 결정성**
- 같은 (템플릿버전, payload, 관할권, 언어) -> **바이트 단위 동일** 출력.
  clock/random 의존 금지. `lib/feedbackLifecycleEmails.ts`의 기존 규율과 동일.
- KR profile -> 제목이 `(광고)`로 시작
- SG profile -> 제목이 `<ADV> `로 시작
- AU profile -> footer에 ABN 블록
- **KR 관할권 + `en` 언어 -> `(광고)` + 영어 본문** (8.6의 축 분리 검증)

**멱등성**
- 같은 `EmailEvent`를 두 번 fan-out -> `EmailDelivery` 행 수 불변
- 같은 `EmailDelivery` 재시도 -> 같은 `idempotencyKey`, 같은 payload
- 같은 `svix-id` 웹훅 두 번 -> 상태가 한 번만 변함

**unsubscribe**
- `GET /unsubscribe?t=...` -> **상태 변경 없음**, 확인 화면
- `POST` One-Click -> 즉시 반영
- 유효하지 않은/변조된 token -> 거부, 정보 노출 없음
- 다른 사용자의 token으로 내 설정 변경 불가
- token으로 preference **켜기** 불가
- 처리 후 5초 내 다음 발송이 차단됨

**E2E (Playwright, desktop + mobile 프로젝트)**
- settings에서 preference center 진입, 토글, settings로 복귀(스크롤/포커스 복원)
- 직접 URL 진입 후에도 "설정으로 돌아가기" 동작
- security/billing 토글이 잠긴 상태로 **보임**
- 관리자: 분류 선택 -> 수신자 미리보기 -> 관할권 미리보기 -> 테스트 -> 승인 -> 발송

### 18.3 Acceptance criteria (MVP)

- [ ] 2.4의 직접 발송 경로가 **0개** 남음 (정적 검사로 확인)
- [ ] 프로세스를 발송 직전에 죽여도 메일이 결국 도착 (통합 테스트)
- [ ] 프로세스를 발송 직후 죽여도 **두 번 도착하지 않음**
- [ ] hard bounce 처리 후 같은 주소로 재발송 시도가 발생하지 않음
- [ ] marketing flag가 꺼진 상태에서 marketing 발송 시도가 **실패**함(조용한 통과 아님)
- [ ] 8개 관할권 x 7개 언어 조합에서 footer가 정상 렌더 (56 스냅샷)
- [ ] unsubscribe가 로그인 없이 1클릭으로 동작하고 5초 내 반영
- [ ] 모든 관리자 발송 행위가 `AdminAuditLog`에 기록됨
- [ ] `EmailPolicyVersion`을 새로 활성화해도 진행 중인 발송의 렌더가 바뀌지 않음
- [ ] 320px 폭, 200% 텍스트 확대, 한국어 IME에서 preference center 정상 (모바일 계약)
- [ ] `npm run check:accent-tokens` 통과 (신규 UI가 역할 token 사용)
- [ ] `npm run check:encoding` 통과

---

## 19. 예상 비용과 운영 부담

### 19.1 직접 비용 (가정: 월 5만 통, 22절 A6)

| 항목 | 월 비용 |
|---|---|
| Resend (transactional + marketing) | 약 $20 |
| 도메인/DNS | 기존 |
| 전용 IP | $0 (도입 안 함) |
| 추가 인프라 | $0 (기존 Postgres/Railway cron 재사용) |
| **합계** | **약 $20/월** |

발송량이 10배(월 50만 통)가 되면 약 $90~180/월 수준. **비용은 이 결정의
제약 요인이 아닙니다.**

비교: Customer.io는 프로필 수 기준으로 월 $100부터 시작하고 무료 사용자가 많으면
빠르게 증가합니다. Braze는 연 단위 계약입니다.

### 19.2 구현 공수 (개략)

| Phase | 항목 | 규모 |
|---|---|---|
| 1 | M1~M4 (outbox, 웹훅, suppression) | 중 |
| 1 | M5~M8 (preference, consent, 관할권) | 중 |
| 1 | M9~M10 (unsubscribe, preference center) | 중 |
| 1 | M11~M14 (도메인, port, 재시도, 감사) | 소~중 |
| 2 | 캠페인 UI + 승인 | 중 |
| 2 | 재확인 배치, DMARC 강화, 가입 동의 | 소 |

**정확한 인일 추정은 하지 않습니다.** 저장소의 기존 인프라 재사용도(2.8)가 높아
불확실성이 크고, 근거 없는 숫자는 계획을 왜곡합니다.

### 19.3 지속 운영 부담

| 작업 | 주기 |
|---|---|
| DMARC 리포트 확인 | 주 1회 (Phase 1) -> 월 1회 |
| bounce/complaint rate 확인 | 자동 알림 + 월 1회 검토 |
| `abandoned` 발송 처리 | 알림 발생 시 |
| 관할권 정책 검토 | **분기 1회** + 규제 변경 인지 시 |
| 억제 목록 검토 | 분기 1회 |
| warm-up 관리 | marketing 도메인 신설 시 4~6주 집중 |

**가장 지속적인 부담은 규제 추적입니다.** 4.3에서 보듯 영국 PECR이 2026년 2월에
개정되었습니다. 이 영역은 정지해 있지 않습니다.

---

## 20. 위험 목록과 완화책

| # | 위험 | 영향 | 완화 |
|---|---|---|---|
| R1 | **legal/service 메일에 프로모션을 섞어 marketing이 됨** | 법적 통지가 opt-out 사용자에게 도달하지 못함. 이중 위반 | 8.5 타입 분리, 12.2 분류 선점, 18.2 정적 검사 |
| R2 | **관할권 오판으로 잘못된 규칙 적용** | 과태료. 한국 3천만원 이하 등 | 6.3 fail-closed, C1 전역 opt-in, C8 soft opt-in 미사용 |
| R3 | complaint suppression이 로그인 코드를 막음 | 사용자가 계정에서 잠김 | 13.3 분류별 억제, C9 도메인 분리 |
| R4 | marketing complaint가 transactional 도달률을 깎음 | 로그인 코드 미도달 | C9 도메인/IP 분리, 14.5 자동 중단 |
| R5 | **한국 2년 재확인 누락** | 3천만원 이하 과태료 | C7 전역 적용, 배치 자동화, `ConsentRecord.expiresAt` 인덱스 |
| R6 | 캐나다 묵시적 동의 만료 후 발송 | CASL 위반 | C8로 묵시적 동의 미사용 |
| R7 | 호주 5영업일 초과 | Spam Act 위반 | C3 즉시 처리(SLA 24시간) |
| R8 | unsubscribe token 유출 | 타인 설정 변경 | 11.4 끄기 전용, 범위 제한, URL 로그 마스킹 |
| R9 | **provider 데이터 리전(미국)이 EU 요구와 충돌** | GDPR 이전 문제 | DPF + SCC 의존. **22절 A2에서 결정.** 필요 시 SES/MailerSend |
| R10 | 중복 발송 (재시도 or provider 전환) | 사용자 불신, 스팸 신고 | 9.3 idempotency key, 16.1 수동 전환 |
| R11 | **메일 유실 (현재 상태)** | 로그인 불가, 영수증 미도달 | **M1이 최우선인 이유** |
| R12 | 관리자가 실수로 전체 발송 | 평판 즉시 손상, 되돌릴 수 없음 | 12.3 이중 승인, 12.2 dry-run, 속도 제한 |
| R13 | 템플릿 언어 누락으로 조용히 영어 발송 | 사용자 경험 저하, 한국 광고 표시 누락 가능 | 18.2 정적 검사(빌드 실패) |
| R14 | 억제 목록에서 잘못된 제거 | 스팸 신고자에게 재발송 -> 계정 차단 | 12.4 이중 승인 + 사유 |
| R15 | **CNY 결제를 받으면서 중국 규제 미대응** | PIPL 위반 가능 | 22절 A4. 조사 전 중국 marketing 금지 |
| R16 | 규제 변경을 놓침 | 조용한 위반 | 19.3 분기 검토, `JurisdictionProfile.notes`에 확인일 기록 |
| R17 | policy version 전환 중 렌더 불일치 | idempotency key 무효화, 중복 발송 | 12.5 발송이 잡은 버전 유지 |
| R18 | Next 16.3.0 API 가정 오류 | 구현 재작업 | 2.1 — 착수 전 `node_modules/next/dist/docs/` 확인 필수 |

---

## 21. 법률 담당자에게 반드시 확인할 질문

| # | 질문 | 왜 중요한가 | 막히는 것 |
|---|---|---|---|
| Q1 | EU 회원국 중 우리 사용자가 있는 국가에서 ePrivacy 국내법이 추가 요건을 두는가? (특히 독일 UWG, 프랑스 CNIL의 B2B/B2C 구분) | 4.3 EU 주의 참조. 지침이라 국내법이 다름 | EU marketing 활성화 |
| Q2 | 전역 opt-in(C1)과 soft opt-in 미사용(C8) 결정을 승인하는가? 사업적으로 감당 가능한가? | 보수적 선택이 마케팅 도달 가능 대상을 크게 줄임 | marketing 전략 |
| Q3 | 약관/개인정보처리방침/가격 변경 시 **사전 통지 기간**이 관할권별로 얼마인가? | 5번 유형의 발송 시점을 정함 | 정책 변경 프로세스 |
| Q4 | **정보통신망법 제50조제3항의 야간 전송 제한에서 전자우편이 시행령상 예외 매체에 해당하는가?** | E5의 적용 여부. 확인 전까지 억제 기본값 | 한국 marketing 발송 시간 |
| Q5 | 일본 특정전자메일법의 **동의 증명 기록 보존 기간**이 우리 사례에 정확히 어떻게 적용되는가? | 13.2 보관 정책 | 일본 진출 시 |
| Q6 | `ConsentRecord`와 `SuppressionEntry`를 **계정 삭제 후에도 보관**하는 것이 GDPR 제17조(3)와 개인정보보호법 제21조상 정당한가? 보관 기간은? | 13.2. 삭제하면 재발송 위험, 보관하면 삭제권 논점 | 계정 삭제 프로세스, 개인정보처리방침 |
| Q7 | 영수증에 관할권별 **세무 정보 표시 의무**가 있는가? (한국 부가세, EU VAT) | 3.2의 #3. 이 문서 범위 밖 | 영수증 템플릿 |
| Q8 | 발신자 정보로 표시할 **법인명, 사업자등록번호, 통신판매업 신고번호, 물리적 주소, ABN**의 실제 값은? | C4, E3. 값이 없으면 marketing 자체가 불가 | 모든 marketing 발송 |
| Q9 | **만 14세 미만 사용자**가 실제로 존재할 수 있는가? 연령 확인을 하는가? | C12. 하지 않으면 법정대리인 동의 절차가 필요 | 가입 플로우 |
| Q10 | 미국 **주별 개인정보법**(CCPA 등) 중 이메일 마케팅에 실제로 영향을 주는 요건이 있는가? GPC 신호를 존중해야 하는가? | 4.3 미국. 2026년 현황 미확인 | 미국 marketing |
| Q11 | Resend의 **DPA를 체결했는가?** subprocessor 목록을 개인정보처리방침에 반영했는가? | GDPR 제28조 처리자 계약 | 모든 발송(현재도!) |
| Q12 | 개인정보처리방침에 **이메일 마케팅과 이메일 관련 처리**가 기재되어 있는가? (현재 `PrivacyPolicy` 컴포넌트에 marketing 관련 문구 없음 — 2.5 조사 결과) | 고지 없이 처리 불가 | marketing 활성화 |

---

## 22. 아직 확인되지 않은 가정

> **굵게 표시한 항목은 "결정 필요"입니다** — 법적 결과, 동의 범위, 또는 비용을
> 크게 바꿉니다.

| # | 가정 | 근거 | 틀리면 |
|---|---|---|---|
| **A1** | **서비스 유형은 B2C SaaS이다** | 스키마에 조직/팀/seat 개념이 전혀 없음. `User.plan`이 개인 단위. Stripe Checkout이 개인 구독 | **B2B라면 EU 일부 국가에서 B2B 이메일 규칙이 다르고, 계약 주체 관할권(6.1의 1순위)이 실제로 최상위 신호가 됨. 데이터 모델에 조직 축이 필요** |
| **A2** | **EU 데이터 리전이 요구사항이 아니다** | 현재 Resend(미국 저장, DPF+SCC)를 이미 쓰고 있음 | **요구사항이라면 제공자 추천이 SES(`eu-central-1`) 또는 MailerSend로 바뀜. 8절 전체 재작성** |
| **A3** | **일본은 현재 서비스 대상이 아니다** | `ja` locale 없음, JPY 통화 없음 (2.5, 2.7) | 대상이면 locale 추가 + 특정전자메일법 profile + 동의 기록 보존 규칙(Q5) |
| **A4** | **중국은 현재 marketing 대상이 아니다** | 조사하지 않음. 그러나 **CNY 통화와 zh locale이 이미 존재** | **CNY 결제 사용자가 중국 거주자라면 PIPL/광고법 대응 없이 마케팅을 보내게 됨. 별도 규제 조사 필수** |
| **A5** | **전역 opt-in의 사업적 비용을 감수한다** | 5.3의 법적 논거 | 마케팅 도달 가능 사용자가 크게 줄어듦. Q2 |
| A6 | 월 발송량 5만 통 미만, 사용자 수 수만 명 규모 | 미제공. 저장소 규모와 단일 Postgres 구성에서 추정 | 10배 이상이면 전용 IP와 발송 인프라 재검토 |
| A7 | 제공자 가격이 2026-08-21 공개 정보와 일치 | 7.1 주석 | 계약 시 재확인 |
| A8 | 지원 언어는 현행 7개(en/ko/zh/fr/de/es/pt) | `locales/` 조사 | 언어 추가 시 M2가 그것을 쉽게 만듦 |
| A9 | 우선 국가는 KR, US, EU, AU (+GB, CA, SG) | `BILLING_CURRENCIES`에서 유도 (2.7) | 명시적 확인 필요 |
| A10 | 이메일 주소 변경 기능이 현재 없다 | 코드에서 경로를 찾지 못함 | 있다면 13.4를 즉시 적용해야 함 |
| A11 | Railway cron으로 fan-out/drain을 충분히 처리할 수 있다 | 기존 4개 cron이 이 방식으로 동작 | 대량 fan-out(전체 사용자)이 시간 예산을 넘으면 커서 기반 재개가 필수(9.2에 반영됨) |
| A12 | 기존 `NotificationDelivery` 큐를 그대로 두고 병행 운영 가능 | 별개 테이블 | 중복 발송 없음 — kind가 다름 |
| A13 | Next 16.3.0의 Route Handler / cron 호출 패턴이 현행 코드와 동일하게 동작 | 기존 `/api/internal/maintenance/*`가 동작 중 | **`node_modules/next/dist/docs/` 미확인 (2.1). 착수 전 필수** |

---

## 23. 출처 목록

### 규제 (관할권 / 확인일 2026-08-21)

**EU/EEA**
- [Directive 2002/58/EC (ePrivacy Directive), 제13조 — EUR-Lex](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32002L0058)
- [EDPB Opinion 5/2019 — ePrivacy Directive와 GDPR의 상호작용](https://www.edpb.europa.eu/sites/default/files/files/file1/201905_edpb_opinion_eprivacydir_gdpr_interplay_en_0.pdf)
- [EDPB Guidelines 1/2024 — legitimate interest](https://www.edpb.europa.eu/system/files/2024-10/edpb_guidelines_202401_legitimateinterest_en.pdf)

**영국**
- [ICO — Guidance on direct marketing using electronic mail](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-direct-marketing-using-electronic-mail/)
- [ICO — Electronic mail marketing (Guide to PECR)](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guide-to-pecr/electronic-and-telephone-marketing/electronic-mail-marketing/)
- [ICO — Data (Use and Access) Act 2025: privacy and electronic communications](https://ico.org.uk/about-the-ico/what-we-do/legislation-we-cover/data-use-and-access-act-2025/the-data-use-and-access-act-2025-duaa-summary-of-the-changes/privacy-and-electronic-communications/) (reg. 22(3A) 신설, 2026-02-05 시행)
- [ICO 보도 (2026-04) — 자선단체 soft opt-in](https://ico.org.uk/about-the-ico/media-centre/news-and-blogs/2026/04/charities-given-new-flexibility-to-contact-supporters-under-data-law-change/)

**미국**
- [FTC — CAN-SPAM Act: A Compliance Guide for Business](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business)
- [FTC — Candid answers to CAN-SPAM questions](https://www.ftc.gov/business-guidance/blog/2015/08/candid-answers-can-spam-questions)
- [FTC — CAN-SPAM Act (법령 페이지)](https://www.ftc.gov/legal-library/browse/statutes/controlling-assault-non-solicited-pornography-marketing-act-2003-can-spam-act)
- [15 U.S.C. 7707 — Effect on other laws (선점)](https://uscode.house.gov/view.xhtml?req=granuleid%3AUSC-prelim-title15-section7707)
- [Cornell LII — CAN-SPAM Act preemption](https://law.cornell.edu/wex/inbox/can-spam_act_preemption)

**캐나다**
- [CRTC — Guidance on Implied Consent (CASL)](https://crtc.gc.ca/eng/com500/guide.htm)
- [CRTC — Frequently Asked Questions about CASL](https://crtc.gc.ca/eng/com500/faq500.htm)
- [CRTC — Express consent versus implied consent (인포그래픽)](https://crtc.gc.ca/pubs/casl_infograph3_eng.pdf)
- [ISED — Getting consent to send email](https://ised-isde.canada.ca/site/canada-anti-spam-legislation/en/getting-consent-send-email)

**호주**
- [ACMA — Avoid sending spam](https://www.acma.gov.au/avoid-sending-spam)
- [ACMA — Email and SMS unsubscribe rules (Fact sheet, 2024-05)](https://www.acma.gov.au/sites/default/files/2024-05/Fact%20sheet%20-%20email%20and%20SMS%20unsubscribe%20rules.pdf)
- [ACMA — Telemarketing and e-marketing: common issues and mistakes](https://www.acma.gov.au/telemarketing-and-e-marketing-common-issues-and-mistakes)
- [Spam Act 2003 — Federal Register of Legislation](https://www.legislation.gov.au/C2004A01214/latest)

**한국**
- [국가법령정보센터 — 정보통신망 이용촉진 및 정보보호 등에 관한 법률](https://www.law.go.kr/%EB%B2%95%EB%A0%B9/%EC%A0%95%EB%B3%B4%ED%86%B5%EC%8B%A0%EB%A7%9D%EC%9D%B4%EC%9A%A9%EC%B4%89%EC%A7%84%EB%B0%8F%EC%A0%95%EB%B3%B4%EB%B3%B4%ED%98%B8%EB%93%B1%EC%97%90%EA%B4%80%ED%95%9C%EB%B2%95%EB%A5%A0)
- [국가법령정보센터 — 정보통신망법 제50조](https://www.law.go.kr/LSW/lsLawLinkInfo.do?chrClsCd=010202&lsJoLnkSeq=1000688185&lsId=000030)
- [정보통신망법 시행령 [별표 6] 영리목적의 광고성 정보의 명시사항 및 명시방법](https://www.law.go.kr/flDownload.do?flSeq=41072496)
- [국가법령정보센터 — 정보통신망법 시행령](https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq=260797)
- [방송통신위원회 — 법령정보](https://kcc.go.kr/user.do?boardId=1098&dc=K02030400&mode=view&page=A02030400)
- 방송통신위원회/KISA 「스팸 방지를 위한 정보통신망법 안내서」(2020)

**일본**
- [소비자청 — 특정전자메일의 송신의 적정화 등에 관한 법률](https://www.caa.go.jp/policies/policy/consumer_transaction/specifed_email/)
- [총무성 — 특정전자메일의 송신 등에 관한 가이드라인](https://www.soumu.go.jp/main_content/000060967.pdf)
- [총무성 — 팸플릿 (opt-in 방식, 동의를 증명하는 기록의 보존)](https://www.soumu.go.jp/main_sosiki/joho_tsusin/d_syohi/pdf/m_mail_pamphlet.pdf)
- [e-Gov — 특정전자메일법 시행규칙](https://laws.e-gov.go.jp/law/414M60000008066/)
- [e-Gov — 특정전자메일법](https://laws.e-gov.go.jp/law/414AC0100000026)
- [총무성 — 국민을 위한 사이버시큐리티 사이트: 특정전자메일법](https://www.soumu.go.jp/main_sosiki/cybersecurity/kokumin/basic/legal/08/)

**싱가포르**
- [Spam Control Act 2007 — Singapore Statutes Online](https://sso.agc.gov.sg/Act/SCA2007)
- [PDPC — Advisory Guidelines on Requiring Consent for Marketing Purposes (2015-05-08)](https://www.pdpc.gov.sg/-/media/Files/PDPC/PDF-Files/Advisory-Guidelines/advisoryguidelinesonrequiringconsentformarketing8may2015.pdf)
- [IMDA — Best Practices for Organisations (Unsolicited Communications)](https://www.imda.gov.sg/infocomm-regulation-and-guides/unsolicited-communications/best-practices-for-organisations)

### 제공자 공식 문서 (확인일 2026-08-21)

- [Resend — Managing Webhooks](https://resend.com/docs/webhooks/introduction)
- [Resend — Managing Webhooks via API (changelog)](https://resend.com/changelog/managing-webhooks-via-api)
- [Resend — Security](https://resend.com/docs/security)
- [Resend — GDPR](https://resend.com/security/gdpr)
- [Resend — Data Processing Addendum](https://resend.com/legal/dpa)
- [Resend — Subprocessors](https://resend.com/legal/subprocessors)
- [Resend — SOC 2](https://resend.com/security/soc-2)
- [Resend — Data Privacy Framework Certification (changelog)](https://resend.com/changelog/data-privacy-framework-certification)
- [Postmark — Message Streams](https://postmarkapp.com/message-streams)
- [Postmark — How to create and send through Message Streams](https://postmarkapp.com/support/article/how-to-create-and-send-through-message-streams)
- [Postmark — Best practices for bulk broadcast sending](https://postmarkapp.com/guides/best-practices-for-broadcast-sending)
- [AWS — Using the Amazon SES account-level suppression list](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html)
- [AWS — Configuration set-level suppression](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list-config-level.html)
- [AWS — Creating configuration sets in SES](https://docs.aws.amazon.com/ses/latest/dg/creating-configuration-sets.html)
- [AWS — Regions and Amazon SES](https://docs.aws.amazon.com/ses/latest/dg/regions.html)
- [AWS — Managing lists and subscriptions in Amazon SES](https://docs.aws.amazon.com/ses/latest/dg/lists-and-subscriptions.html)

### 저장소 내부 근거

- `lib/email.ts`, `lib/notificationDeliveries.ts`, `lib/notificationRetryCore.ts`,
  `lib/notificationDeliveryJob.ts`
- `lib/accountEmails.ts`, `lib/billingEmails.ts`, `lib/emailLoginEmails.ts`,
  `lib/feedbackLifecycleEmails.ts`, `lib/supportNotificationEmail.ts`,
  `lib/emailTypography.ts`, `lib/emailValidation.ts`
- `lib/analyticsConsentPolicy.ts`, `lib/billingMarkets.ts`, `lib/billingCurrency.ts`
- `prisma/schema.prisma` (`User`, `UserSettings`, `NotificationDelivery`,
  `AdminActionApproval`, `AdminAuditLog`, `AppSetting`, `PrivacyRequest`,
  `StripeWebhookEventLog`, `ScheduledJobRun`, `AdminRetentionRun`)
- `app/(site)/(application)/layout.tsx`, `app/api/analytics/consent-policy/route.ts`
- `.github/audits/notification-delivery-queue-2026-08-01.md`
- `AGENTS.md`, `docs/ui-contracts/settings-navigation.md`,
  `docs/ui-contracts/admin-console-ia.md`, `docs/ui-contracts/typography.md`,
  `docs/policy/shared-packages.md`, `docs/policy/trace-feedback-automation.md`

---

## 승인 요청

이 문서는 **분석과 권고까지**입니다. 코드는 변경하지 않았습니다.

**승인이 필요한 것:**
1. 8절의 제공자 결정 (Resend 유지 + 얇은 port)
2. 5.1의 공통 규칙 C1~C14, 특히 **C1(전역 opt-in)과 C8(soft opt-in 미사용)**
3. 6절의 관할권 판정 우선순위 (IP를 판정에 쓰지 않음)
4. 15절의 MVP 범위와 "만들되 끄는" 항목 목록
5. 22절의 **결정 필요 5건**: A1(B2C/B2B), A2(EU 리전), A3(일본), A4(중국), A5(opt-in 비용)

**병렬로 시작할 수 있는 것:** 21절의 법률 질문 12건 전달. 특히 **Q8(사업자 정보
실제 값)과 Q11(Resend DPA 체결 여부)**은 답이 없으면 아무것도 진행할 수 없습니다.
Q11은 marketing과 무관하게 **지금 이미 발송 중이므로** 가장 급합니다.
