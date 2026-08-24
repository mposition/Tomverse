# 모델 lifecycle 발견·결정·전달 감사 (2026-08-22)

- 대상 저장소: `mposition/Tomverse` (로컬 `/home/user/Tomverse`)
- 기준 브랜치: `claude/email-lifecycle-model-discovery-audit-it1l4n` (`25479aa` 시점)
- 범위: 관리자 Daily 모델 리포트, provider model discovery, 발견 후보의 관리자
  workflow, 모델 출시·업그레이드·폐기 사용자 이메일, 폐기 시 자동 전환,
  2026-08-21~22에 도입된 공통 이메일 시스템과의 통합
- 권한: read-only. 코드·DB·migration·환경변수·DNS·Resend 설정을 변경하지 않았고
  이메일을 발송하지 않았으며 campaign·task·issue·PR을 만들지 않았습니다.
- 증거 표기: `[코드]` `[테스트]` `[측정]` `[공식 자료]` `[추정]` `[확인 불가]`

---

## 1. Executive summary

**모델 lifecycle에는 탐지가 있고 작업 큐가 없습니다. 이메일에는 배관이 있고
청중이 없습니다. 두 결함은 같은 모양입니다 — 한 번 만들어진 사실이 다음 날까지
살아남지 못합니다.**

1. **신규 모델 후보는 발견된 날 하루만 존재하고, 이미 손실이 발생했습니다.**
   `newCandidates`는 `ProviderModelCatalogEntry` 행이 이미 있으면 비게 되고,
   행은 첫 스캔에서 만들어집니다. production 실측(2026-07-21~08-22, 전 기간):
   20일에 걸쳐 후보 37건이 생성됐고, 그중 **해당 provider 자신의 모델인데 오늘
   저장소 어디에도 없는 것이 7건**입니다 — `qwen3.7-flash`(28일 방치),
   `qwen3.8-max`(18일), `grok-4.6`(9일), `gemini-3.7-flash`(8일),
   `qwen3.8-2.4t-a95b`(8일), `glm-5.3`(6일), `qwen3.8-27b`(2일).
   카탈로그에 도달한 후보는 전부 **발견 당일에 사람이 처리한 것**입니다.
   `[코드]` `lib/providerModelCatalogMonitor.ts:213` `[측정]` 5절 ML-01
2. **그 후보를 다시 볼 수 있는 화면이 저장소에 하나도 없습니다.**
   `ProviderModelCatalogEntry`를 읽는 코드는 monitor 자기 자신뿐입니다 — admin
   page 없음, API 없음, 리포트 없음. 발견은 아무도 열 수 없는 서랍에 들어갑니다.
   `[코드]`
3. **관리자 결정이 저장될 곳이 없습니다.** 후보 행에는 검토자·판단·소유자·기한·
   구현 상태 필드가 없습니다. `status`는 관측 상태(`candidate` /
   `available` / `missing` / `likely_deprecated` / `lifecycle_warning`)이지
   workflow 상태가 아닙니다. `[코드]` `prisma/schema.prisma:1725`
4. **Daily 이메일은 새 이메일 시스템 밖에 있습니다.** `sendTransactionalEmail()`
   직접 호출 + `white-space:pre-wrap` 평문 + `AdminNotificationLog` 기록.
   `EmailDelivery`도 `EmailTemplate`도 거치지 않으므로 발송 이력·재시도·
   suppression·bounce 처리가 전부 적용되지 않습니다.
   `[코드]` `lib/providerModelCatalogReport.ts:212-216`
   — **2026-08-23 해결(P0-3, §10.10)**: 이메일은 standard lane으로 옮겼고
   Slack은 direct로 남겼습니다. 이 문단은 감사 시점의 기록입니다.
5. **사용자용 모델 lifecycle 이메일은 template이 0개입니다.** 등록된 template은
   5개(`auth_login_code`, `account_welcome`, `account_deletion_scheduled`,
   `account_restored`, `billing_welcome`)이고 그중 marketing도 service도
   없습니다. `[코드]` `lib/emailTemplateDefinitions.ts:83-131`
   — 2026-08-23에 `ops_model_lifecycle_daily`가 추가돼 6개가 됐지만 그것은
   운영자 메일입니다. **사용자용 모델 lifecycle template은 여전히 0개입니다.**
6. **대량 발송 경로가 존재하지 않습니다.** `EmailEvent.audienceKind`의
   `user_segment` / `all_users`는 CHECK에만 있고 코드가 쓰지 않습니다. 두 lane
   모두 `single_user`를 하드코딩하며 fan-out worker가 없습니다.
   `[코드]` `lib/standardEmailLane.ts:140`, `lib/credentialEmailLane.ts:101`,
   `prisma/migrations/20260821090000_email_notification_mvp/migration.sql:491`
7. **오늘 자동 전환을 사실대로 약속할 수 없습니다.** 이전 script는
   `gpt-5-4-mini → gpt-5-6-luna`로 하드코딩돼 있고,
   `UserSettings.newConversationModelIds`를 건드리지 않으며, 무엇이 바뀌었는지를
   사용자 단위로 남기지 않습니다. 그러므로 "완료 안내"의 수신자를 정할 수
   없습니다. `[코드]` `scripts/run-default-model-reconciliation.mjs:51-52,127-137`

**착수 우선순위 다섯 가지**(20절에서 상세):
P0-1 persistent work item, P0-2 후보 backlog 조회 경로, P0-3 Daily 리포트 v2,
P0-4 preference fail-closed 수정, P0-5 retirement audience/cohort 계산기.

**최종 판정: end-to-end closed loop는 Mature가 아닙니다.** 공통 이메일 플랫폼은
transactional 사용자 메일에 대해 production-ready이지만, 모델 lifecycle vertical은
탐지 단계에서 끊겨 있습니다.

---

## 2. 오늘 구현된 이메일 시스템의 실제 범위

`prisma/migrations/20260821090000_email_notification_mvp/`가 11개 테이블과 32개
CHECK를 한 migration에 넣었습니다. 실제로 동작하는 것:

| 영역 | 실제 상태 | 증거 |
|---|---|---|
| credential lane | 동작. `EmailLoginAttempt`+`EmailEvent`+`EmailDelivery` 한 트랜잭션, 요청 내 재시도, snapshot 미저장(CHECK 강제) | `[코드]` `lib/credentialEmailLane.ts:86-133` `[테스트]` `tests/integration/credential-email-lane.db.test.ts` |
| standard lane | 동작. 조건부 UPDATE claim + `FOR UPDATE SKIP LOCKED`, stale claim 회수, 분류별 retry curve, 봉투 암호화 snapshot에서 렌더 | `[코드]` `lib/standardEmailLane.ts:222-249,585-697` `[테스트]` 15개 케이스 |
| drain 스케줄 | 15분 크레딧 정산 cron에 얹혀 있음. 전용 cron 없음 | `[코드]` `lib/notificationDeliveryJob.ts:78-100` |
| suppression | 동작. hard bounce/complaint 영구, soft bounce만 만료(CHECK) | `[코드]` `lib/emailSuppression.ts` `[테스트]` `tests/integration/email-webhook-suppression.db.test.ts` |
| webhook | 동작. Svix `svix-id` replay 방지, 90일 purge | `[코드]` `lib/emailWebhookProcessing.ts` |
| preference | 6개 purpose, security/billing 잠금(CHECK) | `[코드]` `lib/emailPreferenceCore.ts:14-51` |
| consent | append-only, 원시 IP 미저장(HMAC) | `[코드]` `lib/emailPreferences.ts:44-51` |
| jurisdiction | 8 profile seed + 국가 매핑 + footer renderer 존재 | `[코드]` `lib/emailJurisdictionSeed.ts`, `lib/emailFooterRenderer.ts` |
| unsubscribe | token + `/unsubscribe` + RFC 8058 One-Click. 키 없으면 발송 거부 | `[코드]` `lib/emailUnsubscribeHeaders.ts:31-38` `[테스트]` `tests/integration/email-preferences-consent.db.test.ts:470` |
| sending identity | marketing은 `MARKETING_EMAIL_FROM` 없으면 `MARKETING_FROM_MISSING`으로 거부, 같은 도메인이면 `STREAMS_SHARE_A_DOMAIN` | `[코드]` `lib/emailSendingIdentityCore.ts:190-217` |
| readiness | sending identity + snapshot keyring이 `/api/ready`의 hard dependency | `[코드]` `app/api/ready/route.ts:91-108` |
| 관리자 화면 | `/admin/email-delivery`, `/admin/email-policy` | `[코드]` `lib/adminNavigation.ts:341,389` |

실제로 큐를 쓰는 호출자는 **4곳뿐**입니다: Stripe webhook, admin security route,
account deletion route, user settings(welcome). `[코드]`

---

## 3. 이전 가정 중 더 이상 유효하지 않은 것

| 이전 가정 | 현재 사실 |
|---|---|
| "이메일은 fire-and-forget이라 유실된다" | 사용자 대상 발송은 전부 outbox를 거칩니다(EM-07, 2026-08-23). 남은 직접 발송은 credential lane·운영자 test 발송·notification 재시도 큐 자신뿐이고, `tests/billingLifecycleEmails.test.mjs`가 그 셋을 allowlist로 고정합니다 |
| "marketing은 flag 하나로 켤 수 있다" | ADR §15.2가 이름 댄 `feature.emailMarketingEnabled` / `feature.emailCampaignsEnabled`는 **코드에 없습니다**. 실제 차단은 (a) marketing template 0개, (b) `MARKETING_EMAIL_FROM` 미설정이라는 구조적 차단입니다 `[코드]` |
| "template registry가 사람 승인을 담는다" | content hash 기반 자동 publish이고 `publishedById`/`publishedByEmail`은 아무도 쓰지 않습니다 `[코드]` `lib/emailTemplateRegistry.ts:118-133` |
| "jurisdiction footer/제목 접두어가 발송에 적용된다" | `renderJurisdictionFooter()`와 `subjectPrefix`는 **어느 발송 경로에서도 호출되지 않습니다**. 테스트와 seed만 참조합니다 `[코드]` |
| "모델 리포트는 운영자 알림이니 큐 밖이 정상" | ADR §17.2가 이전 순서 **2단계**로 "운영자 알림(provider 리포트, incident)"을 명시했습니다. 3~8단계는 이전됐고 2단계는 남았습니다 `[코드]` `docs/policy/email-notifications.md:2296-2312` |
| "폐기 reconciliation이 사용자 선택 상태를 전부 옮긴다" | `newConversationModelIds`는 대상이 아닙니다 `[코드]` |

---

## 4. 현재 model lifecycle 흐름 (end-to-end)

Railway cron `0 0 * * *` (= 10:00 Australia/Brisbane) `[코드]` `railway.provider-model-catalog.json`

| # | 단계 | 입력 | 출력 | source of truth | 자동/수동 | 내일도 지속? | 승인 주체 | 실패/재시도 | 감사 기록 | 다음 단계와 연결 | 코드/테스트 | gap |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | cron 기동 | — | run 시작 | Railway | 자동 | n/a | 없음 | restart NEVER | `ScheduledJobRun` | ✓ | 없음 |
| 2 | provider catalog API | API key | JSON | provider | 자동 | n/a | 없음 | 없음(1회) | `ProviderModelCatalogRun` | ✓ `lib/providerModelCatalogMonitor.ts:69-97` | 재시도 없음 |
| 3 | parse/filter/pagination | JSON | observation[] | 코드 | 자동 | n/a | 없음 | 없음 | run 카운터 | ✓ `[테스트]` `tests/provider-model-catalog-core.test.ts` (15케이스) | MAX_PAGES=5 초과 시 조용히 절단 |
| 4 | `ProviderModelCatalogRun` | 결과 | 행 1개 | DB | 자동 | 365일 | 없음 | 있음 | 읽는 코드는 retention뿐 | `lib/retentionPolicyCore.ts:275` | **읽는 화면 없음** |
| 5 | `ProviderModelCatalogEntry` upsert | observation | 행 | DB | 자동 | 영구 | 없음 | `lastCheckedAt` | **끊김** | `monitor.ts:223,267` | **읽는 코드 0개** |
| 6 | registry 매핑 | `ModelRegistryEntry.apiModel` | mapped/candidate | DB | 자동 | 영구 | 없음 | — | 6→7 | `monitor.ts:196-201` | 없음 |
| 7 | candidate / missing / lifecycle 판정 | 5,6 | 배열 | 메모리 | 자동 | **아니오** | 없음 | — | 7→8 | `monitor.ts:203-289` | **ML-01** |
| 8 | registry reconciliation | 7 | `enabled=false` / 복원 / hold | DB | 자동 | 영구 | 없음(자동) | 없음 | `operationalReason` 문자열 | `lib/providerModelCatalogReconciliation.ts:88-107` `[테스트]` core 6케이스 | 사용자 통지 hook 없음 |
| 9 | Slack + Email | 7,8 | 메시지 | — | 자동 | 아니오 | 없음 | `AdminNotificationLog` | 9→10은 사람의 기억 | `lib/providerModelCatalogReport.ts:154-232` | **ML-02, EM-14** |
| 10 | 관리자 decision | 이메일 | — | **없음** | 수동 | **아니오** | 사람 | — | **없음** | — | **ML-03** |
| 11 | model/pricing/registry 변경 | 결정 | `lib/models.ts` PR + `PUT /api/admin/models` | 코드+DB | 수동 | 영구 | 사람 | — | `AdminAuditLog` | 10과 연결 안 됨 | 결정과 구현이 서로를 모름 |
| 12 | staging/production 검증 | 11 | 체크리스트 | 문서 | 수동 | 문서로 | 사람 | — | `docs/ops/` | — | 모델용 체크리스트 없음 |
| 13 | 사용자 communication campaign | — | — | **없음** | — | — | — | — | — | — | **존재하지 않음** |
| 14 | audience expansion | — | — | **없음** | — | — | — | — | — | — | **EM-01** |
| 15 | `EmailDelivery` | 14 | — | — | — | — | — | — | — | — | 14 없이는 도달 불가 |
| 16 | 실제 발송 | 15 | — | — | — | — | — | — | — | — | — |
| 17 | bounce/complaint/suppression | webhook | `SuppressionEntry` | DB | 자동 | 영구 | 없음 | replay 안전 | `ProviderWebhookEvent` | ✓ | 16이 없어 모델 메일에는 미적용 |
| 18 | retirement reconciliation | 승인 | `UserSettings.defaultModel`, `Conversation.selectedModels` | DB | 수동 | 영구 | 사람(4개 인자) | 없음 | stdout만 | 13,19와 연결 없음 | **ML-09, ML-10, ML-11** |
| 19 | 완료 안내 + 감사 기록 | — | — | **없음** | — | — | — | — | — | — | **존재하지 않음** |

**7단계에서 10단계로 가는 다리는 사람의 기억 하나입니다.** 그리고 그 다리는
하루짜리입니다.

---

## 5. 확인된 findings

각 finding은 ID · Severity · Evidence · 현재 동작 · 기대 동작 · 영향 · Root
cause · 권고 · Acceptance criteria · 검증 방법 · 파일:line 순입니다.

### ML-01 — 신규 후보는 발견 당일에만 보고된다 (P0, High) — **production에서 확인됨**

- **Evidence**: `[코드]` `[측정]`
- **현재 동작**: `newCandidates`는 `existingByApiModel`에 해당 `apiModel`이 없을
  때만 채워집니다. 그 map은 같은 함수 앞부분에서 `ProviderModelCatalogEntry`
  전체를 읽어 만들고, 행은 첫 관측에서 upsert로 생성됩니다. 따라서 어떤 모델도
  두 번 `newCandidates`에 들어가지 않습니다.
- **기대 동작**: 미검토 후보는 검토·기각·연기 중 하나가 되기 전까지 매일 보고에
  남는다.
- **`[측정]` production 실측 — 관측 전 기간 (2026-07-21 ~ 08-22, 33일)**

  DB에 닿지 않고 복원했습니다. `newCandidates` 수는 Railway `Provider Model
  Catalog` cron 로그가, 후보 **이름**은 `#all-tomverse`의
  `Tomverse model catalog report` Slack 메시지가 갖고 있습니다. 리포트는
  ML-01의 메커니즘상 **행이 생기는 날 정확히 한 번** 후보를 호명하므로,
  전 기간 리포트의 합집합이 곧 `ProviderModelCatalogEntry`의 누적 후보 전체입니다.

  첫 리포트는 2026-07-21. **20일에 걸쳐 후보 37건이 생성**됐고 중복 모델을
  묶으면 고유 모델 약 24종입니다. 하루 최대는 4건(8/13)이라 20행 상한(ML-04)에
  닿은 적이 없습니다.

  그중 **해당 provider 자신의 카탈로그에서 나온 그 provider 자신의 모델인데
  오늘 저장소 어디에도 없는 것이 7건**입니다. 이것이 U1의 답입니다.

  | 최초 발견 | provider | 모델 | 방치 일수 | 재호명 |
  |---|---|---|---|---|
  | 07-25 | Qwen | `qwen3.7-flash` (+`-2026-07-15`) | **28일** | 없음 |
  | 08-04 | Qwen | `qwen3.8-max` | **18일** | 없음 |
  | 08-13 | xAI | `grok-4.6` | **9일** | 없음(당일 Perplexity 경유 1건 별도) |
  | 08-14 | Google | `gemini-3.7-flash` | **8일** | 없음(익일 Perplexity 경유 1건 별도) |
  | 08-14 | Qwen | `qwen3.8-2.4t-a95b` | **8일** | 없음 |
  | 08-16 | Zhipu | `glm-5.3` | **6일** | 없음(8/19·8/21에 타 provider 경유) |
  | 08-20 | Qwen | `qwen3.8-27b` | **2일** | 없음 |

  대조군으로, 카탈로그에 **도달한** 후보들은 전부 발견 직후 사람이 손으로
  넣은 것입니다 — `gemini-3.6-flash`·`gemini-3.5-flash-lite`(7/22 발견),
  `kimi-k3`(7/28 발견 → `20260803040000_launch_kimi_k3` migration),
  `claude-opus-5`·`claude-fable-5`·`glm-5.2`. 즉 **이 파이프라인이 실제로
  작동한 경우는 전부 "그날 이메일을 본 사람이 그날 처리했다"입니다.**
  하루를 놓치면 위 표가 됩니다.

  나머지 후보는 두 종류의 노이즈입니다. (a) 집계 provider 경유 중복 —
  Perplexity·Qwen·Mistral의 카탈로그가 남의 모델을 서빙해서 생기는 것으로,
  `perplexity/kimi-k3`·`google/gemini-3.7-flash`·`zai-glm-5-2` 등(ML-12).
  (b) chat이 아닌 모델 — `gemini-robotics-er-2-preview`,
  `qwen-audio-3.0-asr-flash`, `qwen-image-3.0`,
  `gemini-3.7-flash-video-understanding-eap`가 `isLikelyChatModelId`를
  통과했습니다(6절 #10·#11).

  **부수 확인**: 7/22~8/15 전 기간 리포트가
  `Anthropic: failed (PROVIDER_MODEL_CATALOG_HTTP_404)`를 달고 있습니다 —
  `providerModelCatalogCore.ts:10-20`의 주석이 말하는 그 한 달이며, 8/16부터
  `checked 12/12`로 복구됐습니다. 7/29에는
  `registry auto-updates 4`가 찍혀 auto-disable이 실제로 동작한 기록이
  남아 있습니다.
- **이 7건의 triage는 `.github/audits/model-lifecycle-triage-2026-08-22.md`에
  있습니다.** 5개 결정으로 묶이고, 2026-08-22 provider 자료 조사 결과
  **`gemini-3.7-flash` 1건만 착수 가능**하며 `glm-5.3`은 종량제 단가 공표 여부가
  확인되지 않아 blocked입니다.
- **영향**: cron 실패, 이메일 유실, 휴가, 다른 급한 일 — 어느 하나만 겹쳐도 그
  모델은 영구히 사라집니다. 위 표가 그 손실이 가설이 아니라 **한 달 동안 7건**
  누적된 사실임을 보여 줍니다. 그중 `grok-4.6`·`gemini-3.7-flash`·`glm-5.3`은
  각 provider의 현행 플래그십 후속 모델입니다.
- **Root cause**: "오늘의 변화"와 "미처리 목록"이 같은 배열로 표현됨.
- **권고**: 5절의 `ModelLifecycleWorkItem` 도입. Daily 리포트는 `NEW TODAY`와
  `PENDING N DAYS`를 별도 섹션으로 렌더.
- **AC**: 같은 후보로 monitor를 2회 실행하면 1회차 리포트에 `NEW`, 2회차에
  `PENDING 1 day`가 나오고 두 회차 모두 항목이 보인다.
- **검증**: DB integration test (backlog 재조회), 유료 turn 0.
- **파일**: `lib/providerModelCatalogMonitor.ts:213`,
  `lib/providerModelCatalogReport.ts:73-74,105`

### ML-02 — 발견 결과를 읽는 UI/API가 하나도 없다 (P0, High)

- **Evidence**: `[코드]`
- **현재 동작**: `prisma.providerModelCatalogEntry`를 참조하는 파일은
  `lib/providerModelCatalogMonitor.ts` 하나입니다(191, 223, 267행).
  `providerModelCatalogRun`은 retention 카운터 두 곳에서만 읽힙니다.
- **기대 동작**: 관리자가 "지금 미검토 후보가 몇 건인지"를 언제든 볼 수 있다.
- **영향**: ML-01과 곱해집니다. 하루짜리 이메일을 놓치면 복구 수단이 없습니다.
- **Root cause**: 저장은 감사 목적으로만 설계됐고 조회는 범위 밖이었음.
- **권고**: `/admin/models?tab=discovery` + `lib/adminWorkQueue.ts`에
  `Model lifecycle` collector 추가(기존 7개 카테고리와 같은 방식).
- **AC**: `/admin/models?tab=discovery`가 provider별 후보·missing·lifecycle
  경고를 first-seen 오름차순으로 렌더하고, 알 수 없는 admin URL은 여전히 404.
- **검증**: `tests/e2e-admin/**` 1건, `tests/adminNavigation.test.mjs` 갱신.
- **파일**: `lib/providerModelCatalogMonitor.ts:191`,
  `app/api/admin/retention/route.ts:146`, `lib/adminWorkQueue.ts:153-222`

### ML-03 — 후보 행에 결정 상태가 없다 (P0, High)

- **Evidence**: `[코드]` `prisma/schema.prisma:1725-1749`
- **현재 동작**: 컬럼은 `status`, `firstSeenAt`, `lastSeenAt`, `lastCheckedAt`,
  `missingSinceAt`, `consecutiveSeen`, `consecutiveMissing`, `lifecycle`,
  `metadata`뿐입니다. 검토자·판단·사유·소유자·기한·연기일·연결 이슈·구현 증거·
  검증 증거·communication 요구·완료 시각이 전부 없습니다.
- **기대 동작**: 승인된 항목이 구현·검증·통지 완료까지 상태를 유지한다.
- **영향**: `ModelRegistryEntry` 행이 생겼다는 사실만으로 "완료"로 보이고,
  가격 검증·접근 검증·staging 검증·사용자 통지가 남았는지 아무도 모릅니다.
- **Root cause**: 관측 테이블에 workflow를 얹으려 한 적이 없음.
- **권고**: 9절 `ModelLifecycleWorkItem` 신설(관측 테이블은 그대로 둠).
- **AC**: 승인된 항목은 `communication_pending`을 지나기 전에 `completed`가 될
  수 없고, 상태 전이는 허용 그래프 밖에서 거부된다.
- **검증**: pure unit test(전이 그래프) + DB integration.
- **파일**: `prisma/schema.prisma:1725`

### ML-04 — 리포트가 행을 조용히 절단한다 (P1, Medium) — **해결 (2026-08-23)**

- **Evidence**: `[코드]` `lib/providerModelCatalogReport.ts:27-33`
- **현재 동작**: Slack 20행, 이메일 100행에서 `…and N more`. 잘린 항목이 무엇인지
  다른 곳에서 볼 수 없습니다(ML-02 때문에).
- **기대 동작**: 절단은 남되, 잘린 항목을 볼 수 있는 링크가 함께 있어야 합니다.
- **영향**: 현재는 **잠복 상태**입니다 — `[측정]` 8/17~8/22 실측에서 하루 최대
  2행이라 상한에 닿은 적이 없습니다. backlog가 쌓이는 순간(ML-01 수정 직후)
  정확히 이 절단이 문제가 됩니다.
- **권고**: 절단 시 Admin Console deep link + 총계를 함께 출력.
- **AC**: 101건일 때 이메일에 "100 shown of 101 · 전체 보기" 링크가 있다.
- **검증**: unit test.
- **파일**: `lib/providerModelCatalogReport.ts:27-33,101-104`

### ML-05 — `minimax`가 provider 표시명 표에서 빠져 있다 (P2, Low)

- **Evidence**: `[코드]`
- **현재 동작**: `AI_PROVIDERS`는 12개인데 `providerName()`의 map은 11개입니다.
  `minimax`는 raw key로 출력됩니다.
- **영향**: 운영자 리포트의 일관성 저하. 기능 영향 없음.
- **권고**: map에 `minimax: "MiniMax"` 추가하고, `AI_PROVIDERS` 전수를 덮는지
  검사하는 test 추가(다음 provider 추가 때 같은 일이 반복되지 않도록).
- **AC**: `AI_PROVIDERS`의 모든 키가 표시명을 갖는다는 test가 있다.
- **파일**: `lib/providerModelCatalogReport.ts:10-22`,
  `lib/modelRegistryShared.ts:9-22`

### ML-06 — 이미지 생성 모델은 discovery 밖에 있다 (P1, Medium)

- **Evidence**: `[코드]` `lib/imageModelRegistry.ts:638-656`
- **현재 동작**: 이미지 모델은 `IMAGE_MODEL_REGISTRY` 정적 배열입니다. DB registry
  없음, catalog 스캔 없음, lifecycle 경고 없음, auto-disable 없음.
- **기대 동작**: 최소한 "이 lifecycle 감시는 chat 모델만 덮는다"가 리포트에
  명시돼야 합니다.
- **영향**: 이미지 모델이 provider에서 사라져도 아무 신호가 없습니다.
  `docs/policy/image-generation.md`의 고정 성공 가격 계약은 모델이 살아 있다는
  전제 위에 있습니다.
- **권고**: 이번 범위에서는 **리포트 footer에 범위 한계를 명시**만 하고, 이미지
  discovery는 별도 작업으로 분리(P2 backlog).
- **AC**: Daily 리포트 footer가 "chat models only; image models are a static
  catalogue"를 말한다.
- **파일**: `lib/imageModelRegistry.ts:638`, `lib/providerModelCatalogMonitor.ts:16`

### ML-07 — perplexity 예외가 리포트 본문에서 이름 불리지 않는다 (P2, Low)

- **Evidence**: `[코드]` `lib/providerModelCatalogMonitor.ts:250-252`
- **현재 동작**: perplexity는 missing 판정에서 `continue`로 건너뜁니다(주석에
  근거가 있음: 공식 list endpoint가 Agent API 모델을 기술함). 리포트 footer는
  일반 문장만 말하고 perplexity를 지목하지 않습니다.
- **영향**: 운영자가 "perplexity는 missing 0건이니 안전하다"고 읽습니다.
- **권고**: Provider coverage 섹션에 `known limitations` 열을 두고 perplexity에
  "retirement cannot be proven from this endpoint"를 명시.
- **파일**: `lib/providerModelCatalogMonitor.ts:250-252`

### ML-08 — auto-disable이 사용자 영향을 남기지 않는다 (P1, Medium) — **해결 (2026-08-23)**

- **Evidence**: `[코드]` `lib/providerModelCatalogReconciliation.ts:88-100`
- **현재 동작**: `enabled=false` + `status="disabled"` +
  `operationalReason` 문자열만 씁니다. `replacementModelId`도
  `userVisibleNote`도 설정하지 않고, 영향 사용자 수도 계산하지 않습니다.
- **기대 동작**: 자동 비활성화는 "운영 중단"(정책 4.7)이고, 그 사실이 lifecycle
  work item과 사용자 안내 요구로 이어져야 합니다.
- **영향**: 사용자는 자기 기본 모델이 조용히 replacement chain으로 흐르는 것을
  통지 없이 겪습니다. `lib/newConversationModels.ts`가 이를 우아하게 처리하므로
  **장애는 아니지만**, 안내는 없습니다.
- **권고**: auto-disable이 `ModelLifecycleWorkItem`을 `communication_pending`
  또는 `awaiting_decision`으로 생성. 이메일은 생성하지 않음(§10 금지 항목).
- **AC**: auto-disable 1건이 work item 1건을 만들고, 그 item은 사람이 닫기
  전까지 열려 있다.
- **파일**: `lib/providerModelCatalogReconciliation.ts:88-100`

### ML-09 — reconciliation이 `newConversationModelIds`를 옮기지 않는다 (P0, High) — **해결 (2026-08-22)**

- **Evidence**: `[코드]`
- **현재 동작**: script는 `AppSetting["guestDefaultModelId"]`,
  `UserSettings.defaultModel`, `Conversation.selectedModels` 셋만 씁니다.
  `UserSettings.newConversationModelIds`는 이름조차 나오지 않습니다.
- **기대 동작**: AGENTS.md와 `lib/newConversationModels.ts:15-19`가 "영구 변경은
  사용자의 명시적 재저장 또는 **승인된 retirement reconciliation**뿐"이라고
  말하므로, reconciliation은 이 컬럼을 다뤄야 합니다.
- **영향**: 두 가지. (a) `defaultModel`만 옮기면 저장된 조합의 첫 항목과
  `defaultModel`이 어긋나 `default_model_out_of_sync` reason이 영구히 켜집니다.
  (b) **"자동 변경했습니다" 메일이 거짓이 됩니다** — 사용자의 새 대화 시작 조합에는
  옛 모델 id가 그대로 남습니다.
- **Root cause**: `newConversationModelIds`가 script보다 나중에 도입됨.
- **권고**: script를 확장. JSON 배열 파싱 → 항목 단위 치환 → 중복 collapse →
  `defaultModel`과 같은 transaction에서 동기화. malformed는 파괴하지 않고 보고.
- **AC**: `['gpt-5-4-mini','claude-x']` → `['gpt-5-6-luna','claude-x']`이고
  같은 행의 `defaultModel`이 `gpt-5-6-luna`가 된다. 재실행해도 변화 없음.
- **검증**: pure unit + DB integration. 유료 turn 0.
- **파일**: `scripts/run-default-model-reconciliation.mjs:26-33`,
  `lib/newConversationModels.ts:15-19`

### ML-10 — reconciliation script는 범용 도구가 아니다 (P1, Medium) — **해결 (2026-08-23)** — §33

- **Evidence**: `[코드]` `scripts/run-default-model-reconciliation.mjs:51-52`
- **현재 동작**: `FROM_MODEL_ID`/`TO_MODEL_ID`가 파일 상수이고, `--from`/`--to`는
  그 상수와 **일치하는지 검사할 뿐** 값을 바꾸지 않습니다
  (`findReconciliationApprovalProblems`의 `target_mismatch`).
- **기대 동작**: 다음 폐기에 그대로 쓸 수 있어야 합니다.
- **영향**: 다음 폐기마다 script를 복사·수정하게 되고, 그때 승인 gate가 함께
  복사될 보장이 없습니다.
- **권고**: `--from`/`--to`를 실제 파라미터로 승격하되, 승인 인자
  (`--approved-retirement` + ticket + actor + CI/lifecycle 거부)는 그대로 두고,
  추가로 **대상 모델이 실제로 disabled + delisted 상태인지 DB에서 확인**하는
  precondition을 넣습니다(정책 문서 §7의 "retirement deploy와 함께" 조건을
  paperwork가 아니라 검사로 만듦).
- **AC**: enabled 상태의 모델을 `--from`으로 주면 `--apply`가 거부된다.
- **파일**: `scripts/run-default-model-reconciliation.mjs:51-86`,
  `lib/reconciliationApprovalCore.ts:23-80`

### ML-11 — 무엇이 바뀌었는지 사용자 단위로 남지 않는다 (P0, High) — **해결 (2026-08-22)**

- **Evidence**: `[코드]` `scripts/run-default-model-reconciliation.mjs:187-200`
- **현재 동작**: 출력은 stdout의 집계 카운트뿐입니다
  (`userDefaultMatches` 개수, conversation `scanned/rewritten/unchanged/malformed`).
  어떤 userId가 바뀌었는지 DB에 남지 않습니다.
- **기대 동작**: "자동 전환 완료" 안내는 **실제로 바뀐 사용자에게만** 가야 하므로
  (§7-F), 바뀐 사용자 목록이 필요합니다.
- **영향**: 완료 안내를 지금 만들면 (a) 안 바뀐 사람에게 보내거나 (b) 전부에게
  보내게 됩니다. 둘 다 회수 불가한 오발송입니다.
- **Root cause**: script가 이메일보다 먼저 존재했고, 통지를 전제하지 않았음.
- **권고**: `ModelMigrationRecord`(userId, workItemId, field, fromModelId,
  toModelId, changedAt) append-only 테이블. reconciliation이 같은 transaction에서
  기록. completion campaign의 audience는 이 테이블입니다.
- **AC**: `--apply` 후 변경된 사용자 수 = record 행 수 = completion audience 크기.
- **검증**: DB integration.
- **파일**: `scripts/run-default-model-reconciliation.mjs:127-200`

### ML-12 — 같은 모델이 provider마다 별개의 후보가 된다 (P1, Medium) — **해결 (2026-08-23)**

- **Evidence**: `[코드]` `[측정]`
- **현재 동작**: 후보의 identity는 `@@unique([provider, apiModel])`입니다
  (`prisma/schema.prisma:1745`). 여러 provider가 같은 모델을 서빙하면 각각
  별개의 행이 되고, 각각 따로 `newCandidates`에 들어갑니다.
- **`[측정]` 실측 두 사례**
  - **GLM-5.3이 세 번, 사흘에 걸쳐, 서로 무관한 세 줄로 보고됐습니다** —
    8/16에 `Zhipu GLM glm-5.3`(Zhipu 자신의 카탈로그), 8/19에
    `Qwen ZHIPU/GLM-5.3`, 8/21에 `Perplexity perplexity/glm-5.3`.
    세 리포트 중 어느 쪽도 "이건 며칠 전에 본 그 모델"이라고 말하지 않습니다.
    세 번 호명됐는데도 registry는 여전히 `glm-5.2`입니다(`lib/models.ts:293`).
    **같은 모델을 세 번 말하면서 한 번도 같은 것으로 묶지 못하면, 세 번은
    한 번보다 나을 것이 없습니다.**
  - **`kimi-k3`는 세 번 NEW로 보고됐습니다** — 7/28
    `Perplexity moonshotai/kimi-k3`, 7/29 `Perplexity perplexity/kimi-k3`
    (같은 provider가 id 철자를 바꾸자 새 후보가 됨), 8/22 `Qwen kimi-k3`.
    그런데 이 모델은 2026-08-03에 이미 출시됐습니다
    (`prisma/migrations/20260803040000_launch_kimi_k3/`). 출시 3주 뒤에도
    "새 모델 발견" 줄이 붙습니다.
- **기대 동작**: 이미 카탈로그에 있는 모델은 어느 provider 경로로 나타나든
  후보가 아니어야 하고, 같은 모델의 서로 다른 provider 관측은 하나의 검토
  대상으로 묶여야 합니다.
- **영향**: 두 방향 모두 나쁩니다. 노이즈(`kimi-k3`)는 "새 후보" 섹션을 무시하게
  만들고, 분산(GLM-5.3)은 같은 결정을 두 번 요구하면서 그것이 같은 결정임을
  숨깁니다.
- **Root cause**: candidate 판정이 `registryByApiModel`을 **해당 provider 안에서만**
  조회합니다(`monitor.ts:186-196`).
- **권고**: work item 생성 시 (a) provider 무관 `apiModel` 정규화 키로 기존
  registry 전체를 조회해 이미 있으면 후보로 만들지 않고, (b) 정규화 키가 같은
  관측을 하나의 work item에 `observedVia: [{provider, rawId}]`로 모읍니다.
  관측 테이블(`ProviderModelCatalogEntry`)의 provider별 행은 그대로 둡니다 —
  그것은 사실이고, 묶는 것은 결정 계층의 일입니다.
- **AC**: 이미 registry에 있는 `apiModel`이 다른 provider 카탈로그에 나타나도
  work item이 생기지 않는다. 같은 정규화 키의 두 provider 관측은 work item
  하나에 모인다.
- **검증**: pure unit + DB integration. 유료 turn 0.
- **파일**: `lib/providerModelCatalogMonitor.ts:186-196,203-216`,
  `prisma/schema.prisma:1745`

### ML-13 — provider 라벨이 모델 소유자가 아니라 스캔한 provider다 (P1, Medium) — **해결 (2026-08-23)** — §31

- **Evidence**: `[코드]` `[측정]`
- **현재 동작**: `providerName(result.provider)`는 **카탈로그를 스캔한 쪽**을
  출력합니다(`report.ts:73-77`). 실측에서 그 결과는
  `Qwen ZHIPU/GLM-5.3`, `Qwen kimi-k3`, `Perplexity perplexity/deepseek-v4-pro-0813`
  입니다 — 읽으면 Qwen이 GLM을 냈고 Kimi를 냈다고 말하는 문장입니다.
- **기대 동작**: "누구의 모델인가"와 "어느 카탈로그에서 봤는가"를 구분해
  표기합니다.
- **영향**: triage가 첫 줄부터 틀린 전제 위에서 시작합니다. ML-12와 겹쳐서,
  같은 모델이 다른 이름표를 달고 다른 날 나타납니다.
- **권고**: `owner/observed` 두 열로 렌더 — 예:
  `GLM-5.3 · Zhipu 모델 · Qwen·Perplexity 카탈로그에서 관측`.
  소유자를 확정할 수 없으면 `unknown`으로 두고 추측하지 않습니다.
- **AC**: 리포트의 각 후보 줄이 관측 경로를 소유자와 구분해 말한다.
- **파일**: `lib/providerModelCatalogReport.ts:10-22,73-77`

### EM-01 — segment/all-users fan-out 경로가 없다 (P0, High) — **1~8차 해결 (2026-08-24)** — §36 · §37 · §38 · §41 · §42 · §43 · §44 · §45

- **Evidence**: `[코드]`
- **현재 동작**: `audienceKind`는 CHECK에서 3값을 허용하지만
  (`migration.sql:491`) 코드가 쓰는 값은 `single_user` 하나입니다
  (`standardEmailLane.ts:140`, `credentialEmailLane.ts:101`). `audienceSpec`,
  `expansionCursor`, `status`의 `pending`/`expanding`/`failed`는
  **어느 코드도 쓰지 않습니다**. `scripts/check-enum-constraints.mjs:332`가 이
  사실을 이미 문서화하고 있습니다.
- **기대 동작**: 하나의 이벤트에서 다수 `EmailDelivery`를 재개 가능하게 생성.
- **영향**: 모델 lifecycle 사용자 안내를 오늘 만들 수 없습니다.
- **권고**: 12절 아키텍처(B안).
- **AC**: 같은 event를 두 번 확장해도 `EmailDelivery` 수가 변하지 않는다
  (`@@unique([eventId, recipientKey])`가 이미 강제).
- **파일**: `prisma/schema.prisma:3622-3631`, `lib/standardEmailLane.ts:140`

### EM-02 — preference row 부재가 동의로 해석된다 (P0, High) — **해결 (2026-08-22)**

> **수정**: 판정이 `lib/emailPreferenceCore.ts`의 `consentGateVerdict()` 순수
> 함수로 옮겨졌고, 행 부재의 의미가 purpose마다 갈립니다 — consent 대상은
> **거절**, `service_status`는 **기본값(ON)**. marketing이면서 계정이 없는
> delivery도 거절합니다(동의 주체가 없고, `userId` 없이는 unsubscribe token도
> 발급되지 않아 분류가 요구하는 링크를 실을 수 없습니다).
> 전 계정 backfill은 `20260822140000_email_preference_backfill`이며 §17.1의
> 값 그대로이고 **`ConsentRecord`를 만들지 않습니다**.
> `tests/emailConsentGate.test.mjs` 9건이 고정하고, 그중 하나는 migration의
> 하드코딩 값을 `defaultPreferenceEnabled()`와 대조합니다.
>
> **오늘 production 동작은 바뀌지 않습니다** — gated template(marketing·service)이
> 아직 0개이므로, 이것은 기능보다 먼저 설치한 guard입니다.

- **Evidence**: `[코드]` `lib/standardEmailLane.ts:464-480`
- **현재 동작**:
  ```ts
  if (preference && !preference.enabled) { /* skip: no_consent */ }
  ```
  행이 없으면 `preference`가 `null`이라 조건이 거짓이 되고 **발송됩니다**.
- **기대 동작**: consent 기반 purpose(`product_updates`/`newsletter`/
  `promotions`)는 행이 없으면 발송하지 않는다(fail-closed).
- **영향**: `ensureDefaultPreferences()`는 **설정 화면을 읽을 때 lazy로**
  만들어지고 migration backfill이 없습니다
  (`prisma/migrations/`에 `INSERT INTO "EmailPreference"` 없음).
  그러므로 `/settings/notifications`를 한 번도 열지 않은 기존 계정에는 행이
  없고, marketing template이 생기는 순간 **동의 없이 발송**됩니다.
  회수 불가한 결과입니다.
- **Root cause**: 방어가 "행은 항상 있다"는 전제 위에 놓임. 그 전제는 lazy 생성
  때문에 거짓.
- **권고**: 두 가지를 함께 합니다.
  1. `CONSENT_REQUIRED_PURPOSES`에 대해 **행 부재 = `no_consent`**로 판정.
     `service` 계열은 반대로 행 부재 = 기본값(ON)으로 유지 — 두 규칙을
     `lib/emailPreferenceCore.ts`의 순수 함수 하나로 표현합니다.
  2. 기존 전 계정 backfill migration(§17.1의 값 그대로:
     security/billing/service_status ON, 나머지 OFF, **ConsentRecord 생성 안 함**).
- **AC**: preference 행이 없는 사용자에게 marketing template을 enqueue하면 drain이
  `skipped:no_consent`로 끝난다. 같은 상황에서 transactional은 발송된다.
- **검증**: DB integration. **release-blocking**.
- **파일**: `lib/standardEmailLane.ts:466`, `lib/emailPreferences.ts:78-91`

### EM-03 — marketing 경로가 end-to-end로 증명되지 않는다 (P0, High) — **해결 (2026-08-23)**

- **Evidence**: `[테스트]`
- **현재 동작**: marketing classification의 template이 0개이므로
  `sendClaimedDelivery()`의 marketing 분기 3개
  (jurisdiction 재검사 `:481-505`, unsubscribe header `:514-532`,
  `streamForClassification` `:535`)는 **한 번도 실행되지 않습니다**.
  `tests/integration/`에서 `classification: "marketing"`이 나오는 곳은 schema
  CHECK 테스트와 `suppressionCheck` 단위 호출뿐입니다.
- **기대 동작**: marketing 활성화 이전에 이 세 분기가 실제 drain으로 증명돼야
  합니다.
- **영향**: 첫 marketing 발송이 곧 첫 실행입니다.
- **권고**: 테스트 전용 marketing template fixture를 등록하는 대신,
  **§7-A의 `model_launch` template을 먼저 만들고**(marketing, `product_updates`,
  unsubscribe 필수) 그것으로 통합 테스트를 씁니다. 발송은 `MARKETING_EMAIL_FROM`
  부재로 자동 거부되므로 production 위험이 없습니다.
- **AC**: `MARKETING_EMAIL_FROM` 미설정 + marketing template → drain이
  `failed:identity_marketing_from_missing`으로 끝나고
  `EMAIL_SENDING_IDENTITY_REFUSED` incident가 1회 발생.
- **파일**: `lib/standardEmailLane.ts:481-535`

### EM-04 — jurisdiction footer와 제목 접두어가 발송에 적용되지 않는다 (P0, High) — **해결 (2026-08-23)**

- **Evidence**: `[코드]`
- **현재 동작**: `renderJurisdictionFooter()`는 `tests/emailFooterRenderer.test.mjs`
  에서만 호출됩니다. `subjectPrefix`는 seed와 policy 조회에서만 읽힙니다.
  `sendClaimedDelivery()`는 `definition.render(payload, language)`의 결과를
  그대로 provider에 넘깁니다.
- **기대 동작**: `EmailDelivery.jurisdictionProfileKey`가 pin돼 있는 이유가 바로
  이것입니다 — 그 profile의 footer block과 제목 접두어가 적용돼야 합니다.
- **영향**: KR 사용자에게 가는 marketing 메일에 `(광고)`가 붙지 않고, SG에
  `<ADV> `가 붙지 않습니다. `[공식 자료]` 정보통신망법 제50조 제4항,
  Spam Control Act Second Schedule — 둘 다 제목 표시를 요구합니다.
  회수 불가한 규제 위반입니다.
- **Root cause**: M7이 renderer를 만들었고 M2가 template을 만들었는데, 둘을 잇는
  합성 단계가 어느 쪽 범위에도 없었음.
- **권고**: `sendClaimedDelivery()`에서 렌더 직후 합성 단계를 하나 추가.
  `policyVersionId` + `jurisdictionProfileKey`로 profile을 읽어
  `subject = prefix + subject`, `html/text += footer`. **transactional/legal은
  ZZ profile이므로 사업자 정보 footer만 붙고 광고 표시는 붙지 않습니다.**
  determinism 유지를 위해 profile은 pin된 policyVersion에서만 읽습니다.
- **AC**: KR/ko marketing 발송의 subject가 `(광고)`로 시작하고, 같은 template의
  US/en 발송은 그렇지 않다. transactional은 어느 관할권에서도 접두어가 없다.
- **검증**: rendering snapshot test 8 profile × 7 언어. **release-blocking**.
- **파일**: `lib/standardEmailLane.ts:508-511`, `lib/emailFooterRenderer.ts:282`,
  `lib/emailJurisdictionSeed.ts:88,183`

### EM-05 — ADR이 이름 댄 flag가 코드에 없다 (P1, Medium)

- **Evidence**: `[코드]` — `emailMarketingEnabled` / `emailCampaignsEnabled` /
  `emailConsentReconfirmEnabled` 전수 검색 결과 0건.
- **현재 동작**: marketing은 구조적으로 차단됩니다(template 0개 +
  `MARKETING_FROM_MISSING`). 이는 flag보다 **강한** 차단이지만 ADR §15.2를 읽은
  사람은 없는 flag를 찾게 됩니다.
- **권고**: flag를 만들되 **구조적 차단을 대체하지 않고 추가**합니다. 순서는
  flag → template → identity. flag가 꺼져 있으면 enqueue 자체를 거부.
- **AC**: `feature.emailMarketingEnabled`가 false면 marketing template의
  `enqueueStandardEmail`이 행을 만들지 않고 이유를 반환한다.
- **파일**: `docs/policy/email-notifications.md:2206-2223`

### EM-06 — template 게시에 사람의 내용 승인이 없다 (P1, Medium) — **해결 (2026-08-24)** — §37

- **Evidence**: `[코드]` `lib/emailTemplateRegistry.ts:118-133`
- **현재 동작**: 코드의 카피가 바뀌면 다음 발송이 새 `TemplateVersion`을
  `status:"published"`로 자동 생성합니다. `publishedById`/`publishedByEmail`은
  스키마에만 있고 아무도 쓰지 않습니다.
- **기대 동작(marketing 한정)**: ADR §12.3은 marketing 전량 발송에 이중 승인을
  요구합니다. 자동 publish는 그 승인 대상인 "내용"을 승인 없이 확정합니다.
- **영향**: transactional에서는 문제가 아닙니다(카피 변경은 PR 리뷰를 거침).
  marketing campaign에서는 승인 후 카피가 바뀌면 승인이 무효화돼야 합니다.
- **권고**: campaign이 `templateVersionId`를 **pin**하고, 승인 시점의
  `contentHash`를 `AdminActionApproval.payloadHash`에 넣습니다. 자동 publish는
  그대로 두되 campaign은 자동으로 새 버전을 따라가지 않습니다.
- **AC**: 승인 후 template 카피를 바꾸면 그 campaign의 발송이 거부된다.
- **파일**: `lib/emailTemplateRegistry.ts:118-133`, `prisma/schema.prisma:3465-3467`

### EM-07 — M1 이전이 끝나지 않았다 (P1, Medium) — **해결 (2026-08-23)** — §30

- **Evidence**: `[코드]`
- **현재 동작**: ADR §2.4가 나열한 직접 발송 경로 중 아직 남은 사용자 대상 발송:
  - `sendFoundingTesterPassStartedEmail` — `app/api/billing/checkout/route.ts:587`
  - `sendFoundingTesterPassReminderEmail` — `lib/maintenance.ts:148`
  - `sendFoundingTesterPassEndedEmail` — `lib/maintenance.ts:241`
  - `sendAdminPlanChangedEmail` — `app/api/admin/users/[userId]/plan-adjust/route.ts:124`
  네 경로 모두 `sendTransactionalEmail()` 직접 호출이고 실패 시 유실됩니다.
- **기대 동작**: M1 완료 조건은 "2.4의 직접 발송 경로가 큐를 경유"입니다.
- **영향**: Founding Tester 종료 안내가 유실되면 사용자는 플랜이 왜 내려갔는지
  모릅니다.
- **권고**: 4개 template을 `emailTemplateDefinitions.ts`에 등록하고
  `enqueueStandardEmail`로 전환. classification은 `transactional`
  (플랜 상태 변화 = 계약 이행).
- **AC**: `sendTransactionalEmail`을 직접 부르는 사용자 대상 경로가 0이 된다
  (운영자 알림·테스트 메일 제외).
- **파일**: `lib/billingEmails.ts:928,1010,1058`

### EM-08 — 이메일 데이터가 무한 증가한다 (P1, Medium) — **해결 (2026-08-23)**

- **Evidence**: `[테스트]` `npm run report:unswept-tables` 실행 결과
  ```
  5 table(s) nothing removes rows from, and nothing bounds:
    - MessageArtifactCleanup
    - EmailPolicyVersion
    - EmailTemplate
    - ConsentRecord
    - EmailEvent
  ```
  `EmailDelivery`는 "부모가 지워질 때만" 목록에 있습니다.
- **현재 동작**: `renderDataSnapshot` purge job이 없습니다.
  `snapshotPurgedAt`를 쓰는 코드가 0개입니다(schema/migration 제외).
  `lib/retentionPolicyCore.ts`에 이메일 정책이 하나도 없습니다.
- **기대 동작**: ADR §10.3-7과 §13.2가 snapshot 보관 기한 후 삭제를 요구합니다.
- **영향**: 봉투 암호화된 개인화 입력이 무기한 남습니다. 대량 campaign이
  시작되면 증가율이 계단식으로 올라갑니다.
- **권고**: `emailDeliverySnapshots`(예: 90일 후 `renderDataSnapshot=NULL` +
  `snapshotPurgedAt` 설정) 정책을 `retentionPolicyCore.ts`에 추가하고
  maintenance step에 연결. `EmailEvent`/`ConsentRecord`는 각각
  "보존"(감사·법적 증거) 등록으로 명시.
- **AC**: `report:unswept-tables`가 5개 목록에서 이메일 테이블을 더 이상 세지
  않는다.
- **파일**: `lib/retentionPolicyCore.ts:53-285`,
  `prisma/schema.prisma:3735-3737`

### EM-09 — marketing bounce/complaint kill switch가 없다 (P1, Medium) — **해결 (2026-08-23)** — §34

- **Evidence**: `[코드]` — `killSwitch`는 auto-router에만 존재
  (`lib/autoCohort.ts:114`). 이메일에는 없습니다.
- **기대 동작**: ADR §14.5가 complaint rate 임계 초과 시 marketing 중단을
  요구합니다.
- **영향**: 대량 발송 중 complaint가 튀어도 자동으로 멈추지 않습니다. Resend
  suppression은 계정·region 전체 범위이므로(§5.3.1) 최악의 경우 로그인 코드까지
  영향받습니다.
- **권고**: campaign wave 단위 rolling complaint/bounce rate를 계산하고 임계
  초과 시 wave를 `halted`로. Phase 6 blocking 조건.
- **파일**: `lib/emailWebhookProcessing.ts`

### EM-10 — `EMAIL_UNSUBSCRIBE_KEYS`가 readiness에 없다 (P1, Medium) — **해결 (2026-08-23)** — §32

- **Evidence**: `[코드]` `app/api/ready/route.ts:104-108`
- **현재 동작**: `/api/ready`의 hard dependency는 sending identity와 snapshot
  keyring 둘입니다. unsubscribe 키는 `lib/adminEnvironmentChecks.ts:128`의
  참고 목록에만 있습니다.
- **영향**: 오늘은 무해합니다(marketing template 0개). marketing 활성화 시점에는
  배포가 ready라고 답하면서 모든 marketing이 거부되는 상태가 됩니다.
- **부수 문제**: `unsubscribeHeaders()`는 키가 없을 때 **throw** 합니다
  (`lib/emailUnsubscribeHeaders.ts:31-40`). 그 throw는 drain의 바깥 `try/catch`가
  받아 `status='failed'` + `EMAIL_RENDER_FAILED` incident로 끝납니다
  (`lib/standardEmailLane.ts:621-660`). 즉 **"수신 거부 키가 없다"가
  "렌더에 실패했다"로 보고됩니다** — `EMAIL_SENDING_IDENTITY_REFUSED`처럼
  이름 붙은 거부가 아닙니다. 운영자가 원인을 찾는 데 걸리는 시간의 차이입니다.
- **권고**: (a) `feature.emailMarketingEnabled`가 켜졌을 때만 hard dependency로
  승격(조건부 readiness), (b) unsubscribe 키 부재를 `identityRefusal`과 같은
  이름 붙은 permanent 거부로 분류.
- **파일**: `app/api/ready/route.ts:91-108`,
  `lib/emailUnsubscribeHeaders.ts:31-40`, `lib/standardEmailLane.ts:621-660`

### EM-11 — standard drain에 자기 job 기록이 없다 (P2, Low) — **해결 (2026-08-23)** — §35

- **Evidence**: `[코드]` `lib/notificationDeliveryJob.ts:78-100`
- **현재 동작**: `drainStandardEmailDeliveries()`는 `try/catch`로 감싸여
  `console.error` 한 줄만 남깁니다. `ScheduledJobRun` 기록이 없고
  `SCHEDULED_JOB_DEFINITIONS`에도 없으며, `result.pending` backlog에 대한
  incident가 없습니다(operator 큐에는 있습니다).
- **영향**: 사용자 메일 큐가 밀려도 `/admin/jobs`에서 보이지 않습니다.
  abandonment는 잡히지만 그건 이미 늦은 신호입니다.
- **권고**: `standard_email_drain` job key 추가 + backlog incident.
- **파일**: `lib/notificationDeliveryJob.ts:78-100`,
  `lib/scheduledJobsCore.ts:159-220`

### EM-12 — legal/transactional template의 다국어 누락 (P1, Medium) — **해결 (2026-08-23)**

- **Evidence**: `[코드]` `lib/accountEmails.ts:17-33`
- **현재 동작**: `buildAccountDeletionScheduledEmail`(classification `legal`)과
  `buildAccountRestoredEmail`은 `language` 인자를 받지 않고 영어 고정입니다.
  같은 파일의 welcome 메일은 7개 언어를 갖습니다.
- **영향**: 계정 삭제 예정이라는 **가장 되돌릴 수 없는 통지**가 한국어 사용자에게
  영어로 갑니다.
- **권고**: 모델 template을 만들기 전에 이 두 건을 7개 언어로 채웁니다 — 새
  기능을 얹기 전에 기존 계약을 맞추는 쪽이 순서입니다.
- **파일**: `lib/accountEmails.ts:17-33`

### EM-13 — EmailPreference backfill migration이 없다 (P0, High) — **해결 (2026-08-22)**

- **Evidence**: `[코드]` `grep "INSERT INTO \"EmailPreference\"" prisma/migrations/` → 0건
- **현재 동작**: `ensureDefaultPreferences()`가 `readPreferences()`에서만
  호출되고, 그것은 `/settings/notifications`를 열어야 실행됩니다.
- **영향**: EM-02 참조. 단독으로는 무해하고 EM-02와 함께 회수 불가한 오발송이
  됩니다.
- **권고**: EM-02와 한 변경으로 처리.
- **파일**: `lib/emailPreferences.ts:78-91`

### EM-14 — Daily 모델 리포트가 이메일 시스템 밖에 있다 (P1, Medium) — **해결 (2026-08-23)**

- **Evidence**: `[코드]` `lib/providerModelCatalogReport.ts:137,212`
- **현재 동작**: `sendTransactionalEmail()` 직접 호출, `AdminNotificationLog`
  기록. `EmailDelivery` 없음 → 재시도 없음, bounce 처리 없음, suppression
  체크 없음, `/admin/email-delivery`에 나타나지 않음.
- **영향**: 운영자 주소가 hard bounce 상태가 되면 리포트가 조용히 사라집니다.
- **권고**: 10절의 판정 참조 — **Slack은 직접 유지, 이메일은 standard lane으로**.
- **파일**: `lib/providerModelCatalogReport.ts:196-232`

### EM-15 — 오늘의 유일한 폐기 안내가 영어 한 줄이다 (P1, Medium) — **해결 (2026-08-24)** — §39

- **Evidence**: `[코드]` `lib/models.ts:201,243,249,250,267,269,270,271,279,283`
- **현재 동작**: 폐기 안내는 `ModelRegistryEntry.userVisibleNote` 문자열
  하나이며 전부 영어입니다("This model was retired and replaced by …").
  `lib/modelAvailability.ts:28,32`가 이것을 그대로 사용자에게 돌려줍니다.
- **영향**: 한국어·중국어 사용자가 영어 안내를 받습니다. 이메일 이전에 이미
  존재하는 gap입니다.
- **권고**: 이번 범위 밖으로 분리하되 P1 backlog에 명시. 이메일 template이
  다국어를 갖는데 in-app 안내가 영어면 두 안내가 불일치합니다.
- **파일**: `lib/models.ts:201`, `lib/modelAvailability.ts:28`

### EM-16 — marketing 활성화 선행 조건이 미완 (P0 for Phase 6, 운영)

- **Evidence**: `[문서]` `docs/ops/email-sending-domains.md:38,160-170,434-450`
- **현재 상태**:
  - DMARC `p=none` 관측 시작 2026-08-21, 최소 2주 → **2026-09-04 이전 완료 불가**
  - `dmarc@tomverse.app` 실제 수신 여부 **미확인**
  - `news.tomverse.app` 미구성, warm-up(4~6주) 미시작
  - Resend 계정/region suppression 분리 결정 미완(ADR §5.3.1, A18)
  - 법률 검토 Q1/Q2/Q8 미회신
- **영향**: **신규·업그레이드 홍보 메일은 오늘 발송할 수 없고, 빨라도
  2026-10월 이전에는 어렵습니다** (`[추정]`: DMARC 2주 + warm-up 4~6주).
- **권고**: Phase 6 진입 조건으로 고정. 이 감사가 이 상태를 바꾸지 않습니다.

---

## 6. one-shot candidate 분석

4절에서 요구한 원인 후보를 전부 검토했습니다.

| # | 후보 원인 | 분류 | 근거 |
|---|---|---|---|
| 1 | 최초 발견 시에만 `newCandidates` | **코드로 확정 + production 실측** | `monitor.ts:213`. 주원인이며 8/17~8/22 실측에서 후보 6건이 각각 한 번씩만 보고됨 |
| 1b | 같은 모델이 provider마다 별개 후보 | **코드로 확정 + production 실측** | ML-12. GLM-5.3이 8/19·8/21에 무관한 두 줄로, `kimi-k3`는 이미 있는데 NEW로 |
| 2 | DB에 candidate는 남지만 이메일은 delta만 | **코드로 확정 + production 실측** | `report.ts:73-74`가 `result.newCandidates`만 읽음. 8/17·8/18 리포트는 `New model candidates found today: None`을 출력 |
| 3 | 미검토 후보 재조회 query 부재 | **코드로 확정** | `providerModelCatalogEntry`를 읽는 코드 0개(monitor 자신 제외) |
| 4 | API key/계정별 model visibility | **운영 데이터 필요** | `npm run check:openai-model-access`가 이를 위해 존재. 실행에는 실제 키 필요 |
| 5 | 공식 발표와 `/models` 반영 시점 차이 | **공식 자료 필요** | provider마다 다름. `[확인 불가]` |
| 6 | endpoint/version 오류 | **코드로 확정 — 과거에 발생** | `providerModelCatalogCore.ts:10-20` 주석: Anthropic이 `/models`(404)를 한 달간 호출했고 404가 "provider가 endpoint를 없앴다"로 읽혔음. 현재는 `v1/models`로 수정됨 |
| 7 | pagination/cursor/MAX_PAGES | **설계상 의도 + 잠재 결함** | `MAX_PAGES=5`. google `pageSize=1000`, anthropic/minimax `limit=1000` → 최대 5,000개. 현실적으로 충분하지만 **초과 시 조용히 절단**되고 로그가 없음 `[추정]` |
| 8 | response schema 변경 | **코드로 확정 — 부분 방어** | `parseProviderCatalogResponse`는 `data`/`models`/배열 루트만 인식. 그 밖의 형태는 빈 배열 → `PROVIDER_MODEL_CATALOG_EMPTY`로 **failed** 처리됨(조용하지 않음). 좋음 |
| 9 | alias/base model ID/dedup | **설계상 의도** | alias는 별도 observation으로 확장되고 `aliasOf` metadata를 가짐. `Map`으로 dedup `core.ts:170-195` |
| 10 | chat model heuristic 오판 | **코드로 확정 — 실제 위험 있음** | `isLikelyChatModelId`가 OpenAI에 대해 `/^(gpt-|chatgpt-|o\d)/`만 통과시킵니다. **OpenAI가 이 prefix 밖의 chat 모델을 내면 발견되지 않습니다** `core.ts:78-89` |
| 11 | image/embedding/speech/rerank 제외 | **설계상 의도** | 정규식으로 제외. 다만 이미지 **생성** 모델은 ML-06대로 별도 정적 registry라 discovery 자체가 없음 |
| 12 | Gemini/Mistral capability filter | **설계상 의도** | google은 `generateContent` 미지원 시 제외, mistral은 `completion_chat === false` 제외 `core.ts:107-129` |
| 13 | Perplexity 범위 차이 | **설계상 의도 — 문서화됨** | missing 판정에서 제외 `monitor.ts:250-252`. ML-07 |
| 14 | provider failed/skipped/key missing | **코드로 확정 — 올바름** | `status !== "checked"`면 reconciliation이 아무것도 하지 않음 `core.ts:230-232`. `[테스트]` "acts on nothing when the provider check did not complete" |
| 15 | 이미 registry에 매핑된 모델 | **설계상 의도** | mapped는 candidate가 아님 |
| 16 | email row cap | **실제 결함(경미)** | ML-04 |
| 17 | cron/delivery 실패 | **운영 데이터 필요** | `AdminNotificationLog`에 `status`가 남으므로 `[측정]`으로 확인 가능. 23절 |
| 18 | 공식 lifecycle/replacement metadata 부재 | **공식 자료 필요** | `lifecycleFromRecord`가 인식하는 필드는 `archived`/`deprecated`/`stage`/`lifecycle`/`status`뿐. 대부분의 provider가 이를 제공하지 않음 `[추정]` |

**결론**: 신규 모델이 "누락"되는 지배적 원인은 provider 쪽이 아니라 **1+2+3의
조합**이며, 이는 더 이상 추정이 아니라 **측정된 사실**입니다 — 발견은 되고,
저장도 되고, 하루만 보이고, 다시 볼 방법이 없습니다. 1b(ML-12)가 그 위에
노이즈와 분산을 얹습니다. 10번(OpenAI prefix heuristic)이 세 번째로 실질적인
위험입니다.

---

## 7. 공통 이메일 시스템과 모델 기능 사이의 gap

| 필요한 것 | 공통 시스템에 있음 | 모델 기능에 없음 |
|---|---|---|
| durable outbox | ✓ `EmailEvent`+`EmailDelivery` | 모델 template 0개 |
| 분류별 retry | ✓ | 해당 없음 |
| suppression 재검사 | ✓ 발송 시점 | 해당 없음 |
| preference gate | △ fail-open (EM-02) | `model_lifecycle` purpose 없음 |
| jurisdiction gate | ✓ marketing만 | footer/접두어 미적용 (EM-04) |
| unsubscribe | ✓ | marketing template 없어 미사용 |
| 다국어 | △ template마다 제각각 | 모델 카피 0개 |
| 대량 fan-out | ✗ | ✗ |
| campaign 승인/예약/취소 | ✗ | ✗ |
| audience 계산 | ✗ | ✗ (ML-11) |
| 발송 내용과 실제 변경의 정합성 | ✗ | ✗ (ML-09) |

**요약: 배관은 있고 청중·내용·일정이 없습니다.**

---

## 8. Maturity scorecard

0=없음 1=prototype 2=부분 3=production-capable이나 중요한 gap 4=mature

| 영역 | 점수 | 근거 | confidence | gap | 다음 단계 완료 조건 |
|---|---|---|---|---|---|
| 공통 이메일 데이터 모델 | **4** | 11 테이블 + 32 CHECK, 불변조건이 DB에 있음 | 높음 | 없음 | — |
| credential lane | **4** | 한 트랜잭션 3행, snapshot 금지 CHECK, 테스트 존재 | 높음 | 없음 | — |
| standard lane | **3** | claim/retry/abandon 견고 | 높음 | 자기 job 기록 없음(EM-11) | job key + backlog incident |
| consent/preferences | **2** | 6 purpose, 잠금 CHECK | 높음 | fail-open(EM-02), backfill 없음(EM-13) | 두 건 수정 + DB test |
| jurisdiction | **2** | 8 profile seed + renderer 존재 | 높음 | **발송에 미적용(EM-04)** | 합성 단계 + 8×7 snapshot test |
| suppression/webhook | **4** | replay 안전, 분류별 동작 | 높음 | 없음 | — |
| unsubscribe | **3** | One-Click, 키 없으면 거부 | 높음 | readiness 미포함(EM-10) | 조건부 readiness |
| provider abstraction | **4** | 얇은 port, `check:email-provider-port` gate | 높음 | 없음 | — |
| sending identity/readiness | **3** | fail-closed, `/api/ready` hard dep | 높음 | DMARC 관측 미완(EM-16) | 2주 리포트 확인 |
| delivery history | **3** | `/admin/email-delivery` + 필터 | 중간 | 원시 주소 노출 | 마스킹 정책 결정 |
| campaign authoring | **0** | 없음 | 높음 | 전부 | 12절 |
| segment fan-out | **0** | 스키마만, 코드 0 | 높음 | 전부 | 12절 |
| content approval | **1** | 자동 publish, 승인 필드 미사용 | 높음 | EM-06 | campaign이 version pin |
| marketing production readiness | **1** | 구조적 차단만 | 높음 | EM-03,04,05,09,16 | Phase 6 |
| model discovery | **3** | 12 provider, pagination, alias, 15 테스트 | 높음 | heuristic 위험, 이미지 제외 | ML-06/ML-07 명시 |
| persistent lifecycle workflow | **0** | 없음 | 높음 | ML-01,02,03 | 9절 |
| 관리자 Daily email UX | **1** | 평문 pre-wrap, delta만 | 높음 | ML-01,02,04, EM-14 | 10절 |
| model launch communication | **0** | 없음 | 높음 | 전부 | 11절 |
| retirement communication | **1** | `userVisibleNote` 영어 한 줄 | 높음 | EM-15 | 11절 |
| affected-user targeting | **0** | 쿼리 없음 | 높음 | ML-11 | 13절 |
| automatic migration truthfulness | **1** | script는 있으나 컬럼 누락·기록 없음 | 높음 | ML-09,10,11 | 14절 |
| localization | **2** | welcome 7개 언어, legal 영어 | 높음 | EM-12, EM-15 | 7개 언어 채우기 |
| rendering compatibility | **2** | table 없는 단순 HTML | 중간 | Outlook 미검증 | 15절 |
| observability | **2** | incident 있음, 큐 깊이 미노출 | 중간 | EM-11 | job key |
| tests | **3** | DB integration 다수, pure core 충실 | 높음 | marketing/fan-out 0 | 17절 |
| rollout/runbook | **2** | 도메인 문서 상세 | 중간 | 모델 폐기 runbook 없음 | 19절 |

### 별도 판정

| 질문 | 판정 |
|---|---|
| 새 공통 이메일 시스템은 MVP로 Mature한가? | **아니오, 그러나 근접.** EM-02와 EM-04 두 건이 남아 있고 둘 다 회수 불가 등급 |
| transactional 사용자 이메일에 production-ready한가? | **예.** EM-07의 4개 경로와 EM-12의 legal 다국어는 2026-08-23에 해결 |
| marketing 이메일에 production-ready한가? | **아니오.** EM-03/04/05/09/10/16 |
| 대량 campaign에 production-ready한가? | **아니오.** 코드가 0줄입니다 |
| 모델 lifecycle 관리자 workflow에 ready한가? | **아니오.** 탐지만 있습니다 |
| 모델 출시/업그레이드 이메일에 ready한가? | **아니오.** template 0개 + marketing 비활성 |
| 모델 폐기·자동 전환 안내에 ready한가? | **아니오.** audience 계산도 변경 기록도 없습니다 |
| end-to-end closed-loop로 Mature한가? | **아니오** |

---

## 9. 목표 `ModelLifecycleWorkItem`

### 9.1 기존 `ProviderModelCatalogEntry.status` 재사용 vs 신설

| 기준 | 재사용 | 신설 |
|---|---|---|
| 의미 충돌 | `status`는 **관측** 상태(`candidate`/`available`/`missing`/`likely_deprecated`/`lifecycle_warning`). 매 스캔이 덮어씀 | 관측과 결정이 분리 |
| upsert 안전성 | monitor가 매일 `status`를 덮으므로 결정이 지워짐 | 영향 없음 |
| 한 모델에 여러 결정 | 불가(행 하나) | 가능(모델 하나에 add 후 나중에 retire) |
| migration 비용 | 낮음 | 테이블 1개 + CHECK |
| 감사 | 이력 없음 | append-only 이벤트 |

**권고: 신설.** 결정적 이유는 upsert입니다 — monitor는 매일
`status`를 무조건 덮어쓰고(`monitor.ts:223-243`), 관리자 결정을 같은 컬럼에
두면 다음 스캔이 지웁니다. 관측 테이블은 사실을 말하고, work item은 우리가 그
사실로 무엇을 하기로 했는지를 말합니다.

### 9.2 상태 그래프

제시된 15개 상태를 검토해 **11개로 줄입니다.** 근거: 상태 하나가 늘 때마다
전이 규칙이 제곱으로 늘고, 1인 조직에서 구분되지 않는 상태는 곧 잘못 쓰입니다.

```
discovered ──► triage_pending ──► awaiting_decision ──┬─► rejected      (종단)
                     │                                ├─► deferred ─────► awaiting_decision
                     │                                └─► approved
                     └────────────────────────────────────► closed_no_action (종단)

approved ──► implementation_pending ──► validation_pending ──► rollout_pending
                                                                    │
                                                          ┌─────────┴─────────┐
                                              communication_required?         │
                                                     yes │                    │ no
                                                         ▼                    ▼
                                              communication_pending ──►  completed (종단)
```

**병합한 것과 이유**
- `evaluation_required`를 뺐습니다 — `awaiting_decision`의 `blockers` 필드가
  "무엇을 더 알아야 하는가"를 이미 표현합니다. 별도 상태는 두 곳에서 같은
  질문을 관리하게 만듭니다.
- `pricing_verification_pending` / `access_verification_pending` /
  `staging_validation_pending`을 `validation_pending` 하나로 합치고, 무엇이
  남았는지는 `pendingValidations: string[]`로 둡니다. 세 상태는 순서가 없고
  병렬이므로 상태로 표현하면 하나만 표현할 수 있습니다.
- `production_rollout_pending` → `rollout_pending`.

### 9.3 필드

```
ModelLifecycleWorkItem
  id                     String  @id
  provider               String
  apiModel               String        -- provider의 문자열
  modelId                String?       -- 매핑된 ModelRegistryEntry.id
  catalogEntryId         String?       -- ProviderModelCatalogEntry 참조(관측 근거)

  action                 String        -- add | upgrade | replace | retire | monitor | no_action
  status                 String        -- 9.2의 11개
  severity               String        -- critical | high | normal

  predecessorModelId     String?
  replacementModelId     String?

  recommendation         String?       -- 자동 생성 제안(사람이 덮어쓸 수 있음)
  confidence             String?       -- high | medium | low  (자동 제안의 신뢰도)
  evidence               Json          -- 관측 근거: lifecycle 문자열, consecutiveMissing, run id
  unknowns               Json          -- 답이 필요한 사실
  blockers               Json          -- 이름 붙은 대기 항목 (BILLING-04 선례와 같은 방식)
  pendingValidations     Json          -- ["pricing","access","staging"] 중 남은 것

  reviewerId             String?
  reviewerEmail          String?
  decision               String?       -- approve | reject | defer
  decisionReason         String?
  decidedAt              DateTime?

  ownerEmail             String?
  dueAt                  DateTime?
  deferredUntil          DateTime?

  linkedIssueUrl         String?
  linkedPrUrl            String?
  linkedDeploymentId     String?
  implementationEvidence Json?         -- commit SHA, registry 행 id
  validationEvidence     Json?         -- CI run URL, staging 기록 경로

  communicationRequired  Boolean @default(false)
  campaignId             String?       -- EmailCampaign 참조 (12절)

  firstSeenAt            DateTime
  completedAt            DateTime?
  closedAt               DateTime?

  @@unique([provider, apiModel, action])
  @@index([status, severity, firstSeenAt])
  @@index([ownerEmail, dueAt])

ModelLifecycleWorkItemEvent   -- append-only
  id, workItemId, at, actorEmail|null, fromStatus, toStatus, note, evidence Json
```

`@@unique([provider, apiModel, action])`가 핵심입니다: 같은 모델에 대해
"추가"와 "폐기"는 다른 시기의 다른 작업이지만, "추가" 두 건이 동시에 열려서는
안 됩니다.

### 9.4 불변조건과 그 강제 방법

| 불변조건 | 강제 |
|---|---|
| "NEW TODAY"와 "PENDING 12 DAYS" 분리 | `firstSeenAt` + 리포트가 오늘 생성분과 그 이전을 별도 섹션으로 |
| 미검토 후보는 다음 날 사라지지 않음 | 리포트가 `status IN (discovered, triage_pending, awaiting_decision)` 전체를 매일 조회 |
| 승인 항목은 구현·검증 완료까지 유지 | 상태 그래프. `approved`에서 `completed`로 가는 직행 전이 없음 |
| registry row 생성만으로 완료 아님 | `implementation_pending → validation_pending`이 `pendingValidations`가 빌 때만 다음으로 |
| auto-disabled도 통지가 남으면 유지 | `communicationRequired=true`면 `communication_pending` 경유 필수 |
| failed scan을 폐기 증거로 쓰지 않음 | 이미 `planCatalogReconciliation`이 `status !== "checked"`에서 return `[테스트]`. work item 생성도 같은 조건 |
| raw discovery가 사용자 메일을 만들지 않음 | campaign은 `status === "approved"` 이후의 work item에서만 생성 가능(FK + CHECK) |

### 9.5 구현 기록 (2026-08-22 · 완료)

| 파일 | 역할 |
|---|---|
| `lib/modelLifecycleWorkItemCore.ts` | 11개 상태의 전이 규칙·불변조건·후보 identity. 순수 |
| `prisma/schema.prisma` + `migrations/20260822120000_model_lifecycle_work_item/` | 두 테이블 + CHECK 11개 |
| `lib/modelLifecycleWorkItems.ts` | DB 경계. 생성·전이·조회 |
| `lib/providerModelCatalogMonitor.ts` | 스캔 후 큐 적재 |
| `lib/providerModelCatalogReport.ts` + 내부 route | summary에 `awaiting review N` |
| `scripts/backfill-model-lifecycle-work-items.mjs` | 과거 후보 seed (dry run 기본) |
| `tests/model-lifecycle-work-item-core.test.ts` | 21건 |

**ML-01의 실제 수정은 한 줄입니다: 큐를 `newCandidates`가 아니라 `candidates`로
채웁니다.** 전자는 첫 실행 이후 항상 비어 있고(행이 없을 때만 채워지는데 같은
스캔이 그 행을 씁니다) 그래서 모델이 한 번 불리고 사라졌습니다. 후자는 스캔이
본 미매핑 모델 전체이고, 무엇이 새로운지는 큐가 판단합니다.

**ML-12도 함께 닫혔습니다.** `candidateIdentity()`가 vendor 접두어를 떼고
소문자화해, `glm-5.3`·`ZHIPU/GLM-5.3`·`perplexity/glm-5.3`이 한 결정이 됩니다.
관측 테이블의 provider별 행은 그대로 둡니다 — 그것은 사실이고, 묶는 것은 결정
계층의 일입니다.

**강제되는 불변조건** (state machine과 DB CHECK 양쪽):
- 이유 없는 결정 불가 (`decision_reason_check`)
- 결정 없이 `approved` 불가 (`approved_needs_decision_check`)
- `pendingValidations`가 남아 있으면 `rollout_pending` 불가
- `communicationRequired`면 `communication_pending`을 거치지 않고 종료 불가
- 종단 상태는 재개봉 불가 — `completed` 포함. 재개는 새 item입니다
- 자동화는 생성만, 결정은 사람만 (`actor_required`)
- 종단 timestamp는 정확히 하나 (`completed_at_check` / `closed_at_check`)

**검증**: unit 4,161→4,182 · `check:enum-constraints` 통과(61 closed list) ·
`report:unswept-tables`에 두 테이블 retained 등록 · typecheck · eslint.
**실행하지 못한 것**: DB integration과 `db:compare-schema`는 DATABASE_URL이
필요해 이 세션에서 돌리지 못했습니다. migration 적용은 배포 시점입니다.

### 9.6 조회·triage 경로 (2026-08-22 · P0-2 완료)

| 파일 | 역할 |
|---|---|
| `lib/adminNavigation.ts` | `models` entry에 `registry`/`discovery` 탭 + `modelLifecycle` badge |
| `components/admin/adminNavigationIcons.ts` | 기존 `models: Bot` 재사용 (신규 route 세그먼트 없음) |
| `app/(site)/(application)/admin/models/page.tsx` | `?tab=` 서버 판정, 열린 섹션만 mount |
| `components/admin/AdminModelDiscoveryPanel.tsx` | 백로그 표 + triage 3동작 |
| `app/api/admin/model-lifecycle/route.ts` | GET 목록 · PATCH 전이 |
| `lib/adminNavigationBadges.ts` / `Counts.ts` | `openModelLifecycle` 배지 |
| `lib/adminWorkQueue.ts` | `Model lifecycle` collector (8번째 카테고리) |

**IA 계약 준수**: `?tab=`은 `<Link>`이고 서버 컴포넌트가 `searchParams`를 읽으며
열린 섹션만 fetch합니다. catch-all route를 만들지 않았고 새 route 세그먼트가
없으므로 icon 등록도 기존 것을 씁니다. 배지는 알 수 없으면 0이 아니라 아무것도
렌더하지 않습니다(`settled()` → `null`).

**승인 gate를 두지 않은 이유**: 이중 승인은 되돌리기 어려운 행위
(suppression 해제, 관할권 정책 활성화)의 것이고 triage는 그렇지 않습니다.
위험한 형태는 전이 규칙이 이미 거절하고, 모든 이동이 사람 이름과 함께
append-only 이력에 남습니다. 이 화면이 바꾸는 것은 **모델에 대한 결정**이지
모델 자체가 아니며, 뒤따르는 registry 쓰기는 자기 gate를 그대로 유지합니다.

**읽기 실패와 빈 목록을 구분합니다.** 조회가 실패하면 "아무것도 기다리지
않는다"고 말하지 않고 실패했다고 말합니다 — 빈 표와 실패한 읽기는 화면에서
같아 보이지만 둘 중 하나만 "할 일 없음"입니다.

**검증**: unit 4,182→4,183(nav 15건) · typecheck · eslint · enum gate.
**실행하지 못한 것**: `tests/e2e-admin/**`은 `npm run build`와 DB가 필요합니다.

---

---

## 10. 관리자 Daily Lifecycle 이메일 v2

### 10.1 어느 lane인가 — 판정

| 안 | 장점 | 단점 |
|---|---|---|
| A. 현재 direct 유지 | 이메일 outbox 장애와 독립 | 이력·suppression·재시도 밖. 운영자 주소 bounce 시 조용히 사라짐(EM-14) |
| B. standard lane | durable, `/admin/email-delivery`에서 보임, retry, template version | **이메일 시스템 장애를 이메일 시스템이 보고하는 순환** |
| C. Slack 직접 + 이메일 standard | 채널별 복구 특성 분리 | 두 경로 유지 |

**권고: C.**

근거는 이 리포트가 무엇을 보고하는가입니다. Daily 모델 리포트는 **이메일
subsystem에 대해 아무것도 말하지 않습니다** — provider catalog 상태를
말합니다. 그러므로 §9.1의 순환 의존은 이 리포트에 성립하지 않습니다.
순환이 실재하는 것은 `operationalMonitoring.ts`의 incident 알림 쪽이고,
그것은 direct로 남겨야 합니다. 두 경로를 같은 규칙으로 묶는 것이 실수입니다.

Slack을 직접 유지하는 이유는 다릅니다: 이메일 큐가 15분 cron에 얹혀 있으므로
`standard` lane으로 옮기면 리포트가 **최대 15분 지연**됩니다. 즉시성이 필요한
쪽은 Slack이고, 감사 가능성이 필요한 쪽은 이메일입니다. 각자 자기 성질에 맞는
경로를 씁니다.

수반 변경: `ops_model_lifecycle_daily` template을 `transactional`
classification으로 등록(운영자 대상, purpose 없음, unsubscribe 없음),
`recipientKey`는 `addr:` 형태.

### 10.2 정보 구조

정상일에는 짧고, action이 있을 때만 길어집니다. 규칙:
**Action required가 0이고 새 발견이 0이면 섹션 3~7을 렌더하지 않습니다.**

### 10.3 Subject 규칙

```
정상:      [Tomverse] Model lifecycle · 22 Aug · healthy
검토 대기: [Tomverse] Model lifecycle · 22 Aug · 4 awaiting review
조치 필요: [Tomverse] Model lifecycle · 22 Aug · ACTION 2 · 6 awaiting review
provider 장애: [Tomverse] Model lifecycle · 22 Aug · ACTION 1 · 3 providers failed
```

- 접두어 `[Tomverse] Model lifecycle`는 고정(필터 대상).
- 날짜는 `Australia/Brisbane` 기준 — 본문의 `generatedAt`과 같은 timezone.
- `ACTION n`은 n>0일 때만. 정상일 subject에 숫자를 넣지 않는 것이
  "숫자가 있으면 볼 일이 있다"는 신호를 지킵니다.
- `[TEST] ` 접두어는 현재 동작 유지.

### 10.4 ASCII wireframe (desktop, 640px)

```
┌────────────────────────────────────────────────────────────────┐
│ TOMVERSE · MODEL LIFECYCLE                     22 Aug 2026 AEST│
│                                                                │
│  ▌ ACTION REQUIRED — 2 items                                   │
│    (정상일에는 이 배너가 "All clear — nothing waiting"으로 바뀜)│
│                                          [ Open work queue → ] │
├────────────────────────────────────────────────────────────────┤
│  Providers checked      11 / 12      Failed / skipped      1   │
│  New today               3           Awaiting review       9   │
│  Approved, not shipped   2           Lifecycle warnings    1   │
│  Auto-disabled           1           Restored              0   │
│  Held (provider-wide)    0                                     │
├────────────────────────────────────────────────────────────────┤
│  ACTION REQUIRED                                               │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ CRITICAL · retire · Groq                                 │  │
│  │ llama-4-scout-17b-16e-instruct                           │  │
│  │ first seen 12 Aug (10d) · owner unassigned · due —        │  │
│  │ Auto-disabled after 3 missing scans.                     │  │
│  │ Blocker: replacement not chosen                          │  │
│  │ Next: choose replacement, then decide user notice        │  │
│  │                                    [ Review item → ]     │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ HIGH · add · OpenAI                                      │  │
│  │ gpt-5-7-preview                                          │  │
│  │ first seen 22 Aug (NEW) · owner unassigned               │  │
│  │ Blocker: no verified price                               │  │
│  └──────────────────────────────────────────────────────────┘  │
├────────────────────────────────────────────────────────────────┤
│  AWAITING DECISION — 9                                         │
│                                                                │
│  NEW TODAY (3)                                                 │
│   · OpenAI    gpt-5-7-preview                                  │
│   · Anthropic claude-opus-5-1-20260820                         │
│   · Mistral   mistral-large-3                                  │
│                                                                │
│  PENDING (6)                                                   │
│   · 12d  Groq      llama-4-maverick-17b                        │
│   · 12d  xAI       grok-4-6                                    │
│   ·  8d  Zhipu     glm-5-air                                   │
│   ·  8d  Qwen      qwen3-max                                   │
│   ·  4d  DeepSeek  deepseek-v4-pro                             │
│   ·  4d  Moonshot  kimi-k3                                     │
├────────────────────────────────────────────────────────────────┤
│  APPROVED — AWAITING IMPLEMENTATION — 2                        │
│   · add     Google  gemini-3-7-pro                             │
│     PR #812 merged · pending: pricing, staging                 │
│   · retire  Groq    llama-3-3-70b-versatile                    │
│     no PR yet · pending: user notice, reconciliation           │
├────────────────────────────────────────────────────────────────┤
│  LIFECYCLE RISKS — 1                                           │
│   · Mistral  codestral-latest  provider marks it "deprecated"  │
├────────────────────────────────────────────────────────────────┤
│  CHANGES SINCE YESTERDAY                                       │
│   discovered  3    decided   1 (approve)                       │
│   transitions 2    completed 0                                 │
├────────────────────────────────────────────────────────────────┤
│  PROVIDER COVERAGE                                             │
│   provider    result   last success   models   note            │
│   OpenAI      ok       22 Aug 10:00      48                    │
│   Anthropic   ok       22 Aug 10:00      14                    │
│   ...                                                          │
│   Perplexity  ok       22 Aug 10:00       9    retirement       │
│                                                cannot be       │
│                                                proven here     │
│   MiniMax     failed   19 Aug 10:00       —    HTTP_401         │
├────────────────────────────────────────────────────────────────┤
│  A model absent from one successful scan is not deprecated.    │
│  Consecutive misses are reported separately because access     │
│  permissions and catalogue behaviour also cause absence.       │
│  Scope: chat models only. Image generation models are a        │
│  static catalogue and are not scanned.                         │
│  Generated 22 Aug 2026, 10:00 AEST · run 8f3c…                 │
└────────────────────────────────────────────────────────────────┘
```

### 10.5 Outlook-safe 레이아웃 규칙

- 최상위 `<table role="presentation" width="100%">` 안에
  `<table width="640" align="center">` 중첩. `max-width`만으로는 Outlook
  (Word 렌더러)이 무시합니다.
- flexbox/grid 금지. KPI 4열은 `<td width="25%">` 4개.
- `border-radius`는 붙이되 사라져도 무방한 장식으로만(§15의 비차단 예시).
- 카드 좌측 severity 막대는 `<td width="4" bgcolor="…">`. `border-left`는
  Outlook에서 사라집니다.
- 모든 CSS inline. `<style>` 블록은 mobile media query 용도로만 두고, 그것이
  적용되지 않아도 읽히도록 단일 컬럼이 기본.
- 폰트는 `lib/emailTypography.ts`의 `EMAIL_FONT_STACK` 하나. webfont 금지.
- 긴 model ID: `<td style="word-break:break-all;">` + `<span style="font-family:monospace">`.
  `overflow-wrap`은 Outlook에서 동작하지 않습니다.

### 10.6 색 없이 이해되는 label

severity는 색이 아니라 **단어**로 옵니다: `CRITICAL` / `HIGH` / `NORMAL`.
색은 보조입니다. `▌` 문자와 대문자 label이 grayscale·고대비 모드·다크 모드에서
모두 유지됩니다.

### 10.7 mobile 우선순위

세로 순서: Action required → KPI → Awaiting decision(NEW 먼저) → 나머지.
KPI는 2열로 접힘. Provider coverage 표는 `overflow-x:auto` 컨테이너 안에.

### 10.8 plain-text 구조

```
TOMVERSE MODEL LIFECYCLE - 22 Aug 2026 (AEST)
ACTION REQUIRED: 2

SUMMARY
  providers checked 11/12 | failed 1 | new today 3
  awaiting review 9 | approved not shipped 2
  lifecycle warnings 1 | auto-disabled 1 | held 0

ACTION REQUIRED
  [CRITICAL] retire | groq | llama-4-scout-17b-16e-instruct
    first seen 12 Aug (10 days) | owner: unassigned
    auto-disabled after 3 missing scans
    blocker: replacement not chosen
    next: choose replacement, then decide user notice
    https://tomverse.app/admin/models?tab=discovery&item=...
...
```

HTML과 plain-text는 **같은 데이터 구조에서 렌더**합니다. 두 렌더러가 갈라지면
plain-text가 조용히 뒤처집니다.

### 10.9 overflow / digest

- 각 섹션 25행 상한. 초과 시 `… 41 more · open work queue →`와 **총계**를
  함께 출력(ML-04).
- `AWAITING DECISION`이 50건을 넘으면 이메일은 provider별 집계만 내고 목록은
  전부 링크로 넘깁니다. 200줄짜리 이메일은 읽히지 않습니다.

---

### 10.10 구현 기록 (2026-08-23 · P0-3 완료)

| 파일 | 역할 |
|---|---|
| `lib/modelLifecycleDailyReportCore.ts` | 리포트를 텍스트가 아니라 **구조**로 만드는 순수 module. subject 규칙·섹션 상한·digest 임계값 |
| `lib/modelLifecycleDailyEmail.ts` | 그 구조에서 HTML과 plain-text를 함께 렌더 |
| `lib/emailTemplateDefinitions.ts` | `ops_model_lifecycle_daily` 등록 (transactional · purpose 없음 · unsubscribe 없음) |
| `lib/providerModelCatalogReport.ts` | payload 조립 + standard lane enqueue. Slack은 direct 유지 |
| `lib/modelLifecycleWorkItems.ts` | `listLifecycleReportWorkItems()` · `summariseLifecycleChanges()` |
| `app/api/internal/provider-model-catalog/check/route.ts` | 큐 행과 24시간 변화량 전달 |
| `tests/modelLifecycleDailyReport.test.mjs` | 17건 |
| `tests/integration/model-lifecycle-daily-report.db.test.ts` | 5건 (lane·template·버전·미설정·거부) |

**10.1의 C안을 그대로 구현했습니다.** Slack은 요청 안에서 direct로 나가고,
이메일은 `enqueueStandardEmail()`로 들어갑니다. 순환 의존은 성립하지 않습니다 —
이 리포트는 provider catalog를 보고하지 이메일 subsystem을 보고하지 않습니다.
`operationalMonitoring.ts`의 incident 알림은 direct로 남겨 두었습니다.

**EM-14가 닫혔습니다.** 이제 리포트마다 `EmailDelivery` 행이 있고, 재시도되고,
`/admin/email-delivery`에 보이며, 운영자 주소가 hard bounce면 조용히 사라지는
대신 그 상태로 남습니다. 계정이 없는 주소이므로 `recipientKey`는 `addr:` 형태
입니다.

**ML-04도 닫혔습니다.** 절단은 남되 `…N more · 총 M건 · open work queue →`로
바뀌었습니다. Slack·HTML·plain-text 세 곳 모두입니다. 이전 형태(`…and N more`)
는 잘린 항목을 볼 곳이 없을 때 쓰던 것이고, P0-1 이후로는 볼 곳이 있습니다.

**되돌아가지 않게 고정한 것**
- HTML과 plain-text는 같은 구조에서 렌더합니다. test가 아홉 개 섹션 제목이
  양쪽에 다 있는지 검사하므로 한쪽만 늘릴 수 없습니다.
- render는 시계를 읽지 않습니다. lane이 snapshot에서 매 재시도마다 다시
  렌더하므로, 시계를 읽으면 두 번째 시도가 다른 bytes가 되고 provider의
  idempotency key가 중복을 막지 못합니다. 날짜·URL은 caller가 넣습니다.
- Outlook 규칙(고정폭 중첩 table, `<td width="4" bgcolor>` severity 막대,
  `border-left` 금지, flex/grid 금지, webfont 금지)을 test가 검사합니다.
- severity는 색이 아니라 단어로 옵니다(`CRITICAL`/`HIGH`/`NORMAL`).
- 조용한 날은 섹션 3~7을 렌더하지 않습니다. 매일 같은 길이인 리포트는 읽히지
  않게 됩니다.
- 큐 조회·변화량 조회는 실패해도 리포트를 잃지 않습니다. lane이 enqueue를
  거부해도(`EMAIL_SNAPSHOT_KEYS` 미설정 등) 스캔 결과가 우선입니다.

**cron 응답의 `emailDelivered`가 `emailQueued`·`emailFailed`로 바뀌었습니다.**
이 요청은 더 이상 발송 여부를 알 수 없으므로 delivered를 보고하면 거짓입니다.

**검증**: unit 4,511→4,528 · server-contract 436 · DB integration(로컬
PostgreSQL 16) email 3개 suite 36건 + 신규 5건 · PR Fast Gate static 35개 ·
typecheck · eslint.

---

## 11. 사용자 이메일 taxonomy와 classification 결정

### 11.1 여섯 개 template — 합치지 않습니다

| # | template key | 상황 | classification | purpose | unsubscribe | stream | 오늘 발송 가능? |
|---|---|---|---|---|---|---|---|
| A | `model_launch` | 신규 모델 출시 | `marketing` | `product_updates` | 필수 | marketing | **아니오** (EM-16) |
| B | `model_upgrade` | 후속 모델 출시 | `marketing` | `product_updates` | 필수 | marketing | **아니오** |
| C | (없음) | 전체 대상 일반 폐기 공지 | — | — | — | — | **만들지 않음** |
| D | `model_retirement_notice` | 영향 사용자 사전 안내 | `service` | `model_lifecycle` (신규) | 없음 | transactional | 인프라 후 |
| E | `model_retirement_reminder` | 폐기 임박 재안내 | `service` | `model_lifecycle` | 없음 | transactional | 인프라 후 |
| F | `model_migration_completed` | 자동 전환 완료 | `transactional` | 없음 | 없음 | transactional | 인프라 후 |
| G | `model_unavailable_incident` | 긴급 사용 불가 | `service` | `service_status` | 없음 | transactional | 인프라 후 |

### 11.2 C를 만들지 않는 이유

"전 사용자에게 보내는 일반 폐기 공지"는 영향받지 않는 사람에게 보내는 제품
소식입니다. 그러면 그것은 `marketing`이고, `product_updates` opt-in 사용자에게
가는 A/B와 같은 채널입니다. 별도 template을 두면 **`service`로 분류해서 opt-out을
우회하고 싶어지는 순간**이 옵니다. ADR §3.2 #9가 정확히 그 실패를 말합니다.
필요하면 A/B의 본문에 "이번 달 카탈로그 변경" 섹션으로 넣습니다.

### 11.3 여덟 개 핵심 질문에 대한 답

**1. 신규/업그레이드는 `marketing + product_updates`로 충분한가?**
예. 이것은 제품 홍보이고, 사용자가 그것 없이도 서비스를 쓸 수 있습니다.
`newsletter`(정기 소식)나 `promotions`(할인)와는 다른 목적이므로
`product_updates`가 맞습니다.

**2. 영향 사용자 대상 폐기 안내는 무엇인가?**
**`service` + 신규 `model_lifecycle` purpose.**

- `transactional`이 아닙니다 — 대응하는 사용자 행위(구매, 로그인 요청)가 없습니다.
- `legal`이 아닙니다 — 법적 통지 의무가 없습니다. 중요하다는 이유로
  `legal`로 올리는 것이 ADR §3.2가 경고하는 오분류입니다.
  `account_deletion_scheduled`가 `legal`인 이유는 **계정과 모든 데이터가
  파괴된다**는 것이고, 모델 폐기는 그 등급이 아닙니다.
- `service` + `service_status`도 아닙니다 — 다음 질문 참조.

**3. `service_status` opt-out 사용자가 자기 기본 모델 자동 변경 안내를
받지 못하는 것이 허용 가능한가?**
**아니오, 그래서 purpose를 나눕니다.** `service_status`는
"장애·점검 알림"이라는 약속입니다. 그것을 끈 사람은 "서버가 잠깐 느렸다는
이야기는 안 듣겠다"고 말한 것이지 "내 계정 설정이 바뀐다는 것도 안 듣겠다"고
말한 적이 없습니다. 한 스위치가 두 약속을 담으면 어느 쪽 의사도 정확히
표현하지 못합니다.

**4. 중요하다는 이유로 `legal`로 올리는 것은 오분류인가?**
예. 2번 참조.

**5. 자동 변경 완료 안내는 transactional인가 service인가?**
**`transactional`.** 이것은 우리가 **사용자가 요청하지 않은 변경을 그의 계정에
가한 기록**입니다. `account_restored`가 `transactional`인 것과 같은 모양입니다.
opt-out 가능한 것으로 두면 "우리가 당신 설정을 바꿨습니다"를 안 보낼 수 있게
되는데, 그것은 보내지 않아도 되는 종류의 사실이 아닙니다.

**6. 새 `model_lifecycle` purpose의 정의**

| 항목 | 값 | 근거 |
|---|---|---|
| default | **ON** | consent 대상이 아님. 계약 이행에 가까움 |
| locked | **아니오** | `security`/`billing`의 잠금 근거(공격자 차단 / 계약 이행)에 해당하지 않음. 세 번째 잠금 purpose를 만들면 잠금 기준이 "중요함"으로 흐려짐 |
| consent 필요 | **아니오** | `CONSENT_REQUIRED_PURPOSES`에 넣지 않음 |
| unsubscribe 링크 | **없음** | `service`는 CHECK에서 자유. 링크 대신 preference center 경로를 footer에 문장으로 |
| DB CHECK | `EmailPreference_purpose_check`에 `'model_lifecycle'` 추가 — **migration 필요** |
| preference center | `/settings/notifications`에 행 추가 |
| locale | ko/en/zh/fr/de/es/pt **7개 전부**. 하나라도 비면 그 언어 사용자에게 영어 label |
| backfill | EM-13의 backfill migration과 **한 변경으로** 처리. 기존 전 계정에 `enabled=true, source:"system_default"` |
| 기존 사용자 | ON으로 시작. `ConsentRecord` 생성하지 않음(§17.1: 동의한 적 없는 것을 동의로 기록하지 않음. 이 purpose는 동의 대상이 아니므로 애초에 기록 대상이 아님) |

**7. classification을 call site가 고르지 않는다**
현재 구조가 이미 그렇습니다 — `emailTemplateDefinitions.ts`의 표가 유일한
출처이고 DB CHECK가 같은 규칙을 겁니다. 모델 template도 같은 표에 들어갑니다.
`enqueueStandardEmail`에 classification 인자를 추가하지 않습니다.

**8. 현재 분류 체계가 요구를 표현하지 못하는 부분**
`model_lifecycle` purpose 신설은 **ADR 개정 사항**입니다. §11.2의
"6개 purpose"와 §10.2의 CHECK 목록이 바뀝니다. 편의상 `service_status`에
욱여넣지 않고 v5 개정으로 올립니다. 결정권자: product + legal(21절).

---

## 12. campaign / fan-out 아키텍처

### 12.1 세 안 비교

| | A: EmailEvent를 campaign으로 | B: EmailCampaign 신설 + EmailEvent는 wave outbox | C: 모델 전용 campaign 테이블 |
|---|---|---|---|
| draft/preview/approval/cancel | `EmailEvent.status`에 6개 상태 추가 필요 | campaign이 담당 | 담당 |
| 한 campaign의 여러 wave | 불가(event 1개 = template version 1개) | 가능 | 가능 |
| credential lane 영향 | `status` CHECK를 바꾸면 credential/standard 양쪽 의미가 흔들림 | 없음 | 없음 |
| 재사용성 | — | 다른 product communication에 그대로 | **모델 전용이라 두 번째 communication에서 중복** |
| 죽은 스키마 활용 | ✓ | ✓ (wave가 `user_segment` event를 만듦) | ✓ |

**권고: B.**

결정적 이유는 `EmailEvent.status`입니다. 그 CHECK는
`pending|expanding|expanded|failed` 4값이고 credential lane과 standard lane이
모두 `expanded`를 씁니다. 여기에 `draft`/`pending_approval`/`scheduled`/
`cancelled`를 더하면, 로그인 코드 행이 있는 테이블의 상태 어휘에 승인 개념이
섞입니다. 승인은 campaign의 성질이지 outbox의 성질이 아닙니다.

동시에 **fan-out 자체는 이미 있는 죽은 필드를 씁니다** —
`audienceKind='user_segment'`, `audienceSpec`, `expansionCursor`,
`status: pending→expanding→expanded`. 새 fan-out 모델을 만들지 않습니다.

### 12.2 스키마 (개념)

```
EmailCampaign
  id
  workItemId            String?   -- ModelLifecycleWorkItem. 없으면 일반 campaign
  category              String    -- model_launch | model_upgrade | model_retirement
                                  --  | model_migration | model_incident | other
  templateKey           String    -- classification/purpose는 여기서 파생. 저장하지 않음
  targetModelId         String?
  replacementModelId    String?
  effectiveAt           DateTime? -- 자동 전환 시각(UTC) + timezone 라벨
  timezoneLabel         String?
  status                String    -- draft | pending_approval | approved | scheduled
                                  --  | running | completed | cancelled | halted
  triggerMode           String    -- manual | auto_draft | approved_schedule
  templateVersionIds    Json      -- 언어별 pin (EM-06)
  locales               Json
  audienceVersion       Int       -- audience 정의의 버전
  audienceSpec          Json
  estimatedRecipients   Int?
  approvalId            String?   -- AdminActionApproval (payloadHash)
  scheduledAt           DateTime?
  cancelledAt           DateTime?
  cancelReason          String?
  createdByEmail        String
  createdAt / updatedAt

EmailCampaignWave
  id, campaignId
  kind                  String    -- launch | notice | reminder | final_reminder | completion
  sequence              Int
  scheduledAt           DateTime?
  eventId               String?   -- 확장 시 생성되는 EmailEvent (audienceKind='user_segment')
  status                String    -- pending | expanding | expanded | sending | done
                                  --  | cancelled | halted
  recipientCap          Int?
  dryRun                Boolean   @default(false)
  expandedCount         Int       @default(0)
  @@unique([campaignId, kind, sequence])

EmailCampaignRecipient      -- 확장 결과의 감사 기록. EmailDelivery와 1:1
  id, campaignId, waveId, userId
  emailAddress, language, jurisdictionCountry
  eligibilityReason     String    -- default_model | new_conversation_lead
                                  --  | conversation_selection | recent_usage
  excludedReason        String?   -- no_email | suppressed | no_consent
                                  --  | plan_incompatible | already_changed | malformed
  deliveryId            String?   -- 실제 발송된 경우
  @@unique([waveId, userId])
```

`EmailCampaignRecipient`가 있어야 하는 이유: `EmailDelivery`는 **보낸 것만**
기록합니다. campaign에서는 **왜 안 보냈는지**가 감사 대상입니다
(§11의 cohort별 count가 여기서 나옵니다).

### 12.3 fan-out 요구와 구현 방식

| 요구 | 구현 |
|---|---|
| cursor 기반 재시작 | `EmailEvent.expansionCursor`에 마지막 userId. 이미 있는 필드 |
| 중복 확장 불가 | `EmailDelivery @@unique([eventId, recipientKey])` — **이미 존재** |
| small transaction batch | 200행/트랜잭션, cursor 갱신 포함 |
| recipient cap | `EmailCampaignWave.recipientCap`. 초과 시 확장 중단 + 사유 로그 |
| dry run | `EmailDelivery.status='skipped', skipReason='dry_run'` — **CHECK에 이미 있음** |
| eligibility 재검사 | 확장 시점 1회 + `sendClaimedDelivery` 시점 1회(기존 gate 재사용) |
| cancellation/kill switch | campaign `cancelled`/`halted` → 확장 중단 + 미발송 delivery를 `skipped` |
| partial failure 복구 | cursor가 있으므로 재개. 실패한 batch는 `EmailEvent.status='failed'` |
| campaign status ≠ delivery status | 별도 필드. campaign이 `completed`여도 개별 delivery는 `abandoned`일 수 있음 |
| 재실행해도 delivery 수 불변 | unique index. `[테스트]`로 고정 |
| queued 뒤 동의 철회 시 차단 | 기존 `sendClaimedDelivery`의 preference 재검사(EM-02 수정 후) |
| queued 뒤 사용자가 직접 변경 시 reminder 차단 | reminder wave는 **발송 직전에 cohort 재계산**. 이미 바꾼 사용자는 `excludedReason='already_changed'` |

### 12.4 재사용하는 것

`EmailDelivery`의 봉투 암호화 snapshot, policy/template pinning, retry curve,
webhook 상태 반영, suppression 재검사를 **그대로** 씁니다. campaign은
`EmailEvent`를 만들 뿐이고 그 아래는 손대지 않습니다.

---

## 13. audience 및 자동 전환 truthfulness

### 13.1 cohort 정의

| cohort | 쿼리 | 오늘 계산 가능? |
|---|---|---|
| `UserSettings.defaultModel = X` | 동등 비교 | ✓ `[코드]` |
| `newConversationModelIds`에 X 포함 | JSON 배열 파싱 필요 | △ 쿼리 없음, 파서는 있음 |
| `Conversation.selectedModels`에 X 포함 | `contains` 후 JSON 파싱 | ✓ script가 함 (사용자 단위 집계는 없음) |
| assistant profile의 모델 선택 | `AssistantProfileVersion` 조사 필요 | `[확인 불가]` — 이번 조사 범위 밖 |
| favorites/recents/pins | 해당 필드 없음 | n/a |
| 최근 N일 실제 사용 | `Message.modelId` + `ChatAttemptUsage` | ✓ 가능하나 비용 큼 |
| malformed JSON | 파서가 분류 | ✓ `lib/newConversationModels.ts` |
| replacement plan 불일치 | `canUseModelWithPlan` | ✓ `lib/newConversationModels.ts:31` |
| replacement capability 불일치 | 수동 판단 | ✗ |
| 이메일 없음 | `User.email IS NULL` | ✓ |
| suppression | `suppressionCheck` | ✓ |
| inactive/deleted/suspended | 계정 상태 | ✓ |
| locale/jurisdiction | `UserSettings.language`, `country` | ✓ |

### 13.2 보고 항목

audience dry run은 다음을 **한 번의 실행에서** 냅니다.

```
Audience for retire(gpt-5-4-mini) → gpt-5-6-luna
  audienceVersion 3 · as of 2026-09-01T00:00:00Z

  cohort                          rows    distinct users
  default_model                   1,204          1,204
  new_conversation_lead             318            287
  conversation_selection          9,441          2,106
  recent_usage_30d                    —              —   (not included)
  ────────────────────────────────────────────────────
  distinct users (union)                         3,012
    with an email address                        2,988
    - excluded: suppressed                          41
    - excluded: no model_lifecycle consent            0   (default ON)
    - excluded: account inactive                    12
    - excluded: plan incompatible                    7
  ────────────────────────────────────────────────────
  initial notice audience                        2,928
  auto-migratable                                2,921
  malformed / left untouched                         7
  already changed (recomputed at reminder)           —
```

**`audienceVersion`과 기준 시각을 기록합니다.** 이메일 발송 시점의 대상과
migration 시점의 대상이 같다고 가정하지 않습니다 — 그 사이에 사람들이 설정을
바꾸기 때문입니다.

### 13.3 자동 전환 truthfulness contract

다음 문장은 **아래 12개 조건이 전부 참일 때만** 씁니다.

> "폐기 예정일까지 이 모델을 기본 모델로 유지하면 Tomverse가
> \<effectiveAt\>에 \<replacement\>로 자동 변경합니다."

1. `ModelLifecycleWorkItem.action='retire'` 이고 `status='approved'`
2. `effectiveAt` + `timezoneLabel`이 확정
3. replacement가 `enabled && publiclyListed && !catalogDeleted`
4. 대상 사용자의 plan에서 replacement 사용 가능 (`canUseModelWithPlan`)
5. capability/credit 차이가 본문에 적혀 있음
6. approved retirement ticket URL이 work item에 있음
7. dry run count가 기록돼 있음
8. staging 검증 기록이 있음
9. reconciliation script와 rollback 절차가 준비됨
10. communication approval(`AdminActionApproval`)이 소비됨
11. 실행 owner가 지정됨
12. post-run validation과 completion campaign이 예약됨

**하나라도 거짓이면 문장을 바꿉니다**: "이 모델은 \<날짜\>에 사용할 수 없게
됩니다. \<replacement\>를 직접 선택해 주세요." — 약속을 하지 않는 쪽으로.

### 13.4 반드시 구분해야 하는 것

| 대상 | 자동 전환 | 이메일에서 뭐라고 말하는가 |
|---|---|---|
| guest 기본 모델 (`AppSetting`) | 예(운영자 결정) | 언급하지 않음 — 수신자가 없음 |
| `UserSettings.defaultModel` | 예 | "기본 모델" |
| `newConversationModelIds` | **ML-09 수정 후에만** | "새 대화 시작 조합" |
| `Conversation.selectedModels` | 예 | "기존 대화의 모델 선택" |
| assistant profile | `[확인 불가]` | 조사 전까지 **언급하지 않음** |
| 과거 `Message.modelId` | 아니오 | "이미 받은 답변은 그대로 남습니다" |
| usage/pricing/billing ledger | 아니오 | 언급하지 않음 |
| 공유 링크 / export | 아니오 | "공유한 링크의 내용은 바뀌지 않습니다" |

**과거 기록은 변경하지 않습니다.** 이메일 campaign이
`--approved-retirement`·ticket·actor·CI 거부 계약을 완화하거나 대신 승인하지
않습니다.

### 13.5 구현 기록 (2026-08-22 · P0-5 완료)

| 파일 | 역할 |
|---|---|
| `lib/defaultModelReconciliationCore.ts` | `rewriteNewConversationModelIds()` · `leadOutOfSync()` |
| `prisma/.../20260822160000_model_migration_record/` | `ModelMigrationRecord` + CHECK 4개 + User cascade |
| `scripts/run-default-model-reconciliation.mjs` | 조합 처리 + 변경 기록을 같은 transaction에 |
| `lib/modelRetirementAudienceCore.ts` | cohort 합집합 · 제외 우선순위 · 요약 |
| 테스트 17건 | `newConversationModelsReconciliation` 9 + `modelRetirementAudienceCore` 8 |

**세 가지 판단**

1. **lead 불일치는 보고만 하고 고치지 않습니다.** 조합의 첫 모델이 무엇이냐는
   사용자의 선택이고, `defaultModel`에 맞춰 재정렬하는 것은 그 선택을 대신
   하는 일입니다 — 폐기 pass가 할 일의 반대입니다.
2. **malformed는 안내는 받되 자동 전환을 약속받지 않습니다.** parser가 읽지
   못한 값은 보존되므로, 그 계정에 "자동으로 바꿔 드립니다"는 참이 아닙니다.
   `autoMigratable`이 `noticeAudience`보다 항상 작거나 같은 이유입니다.
3. **`ModelMigrationRecord`는 계정과 함께 삭제됩니다.** 이 행의 두 목적 —
   완료 안내의 수신자, "내 설정이 전에 뭐였나" — 이 모두 계정과 함께 사라지므로,
   남겨 두면 목적 없는 user id를 보관하는 것이 됩니다. 폐기 후에 필요한 집계
   ("N개 계정이 옮겨졌다")는 campaign의 것이지 사람마다의 행이 아닙니다.

**§13.3 truthfulness contract 상태**: 12개 조건 중 코드로 강제할 수 있는 것이
채워졌습니다. `newConversationModelIds`가 실제로 옮겨지고(조건 4의 전제),
무엇이 바뀌었는지 사용자 단위로 남습니다(조건 12의 전제). 나머지는 사람이
확인할 운영 조건입니다.

**검증**: unit 4,193→4,210 · typecheck · eslint · enum gate(62) ·
data domain registry · unswept tables.
**실행하지 못한 것**: DB integration과 migration 적용.

---

---

## 14. 전문 이메일 템플릿과 ko/en sample

### 14.1 재사용 판정

| 기존 요소 | 재사용 |
|---|---|
| `EMAIL_FONT_STACK` (`lib/emailTypography.ts`) | ✓ 그대로 |
| account welcome shell (`lib/accountEmails.ts:264`) | ✓ 구조 차용, **모듈은 공용으로 승격** — 세 번째 복사를 만들지 않음 |
| footer renderer | ✓ **그리고 EM-04에 따라 발송 경로에 연결** |
| jurisdiction subject prefix | ✓ 동일 |
| unsubscribe headers | ✓ marketing만 |
| TemplateVersion registry | ✓ |
| deterministic renderer 규칙 | ✓ `new Date()`·random·live DB lookup 금지 |

### 14.2 지원 언어 정책

`SUPPORTED_LANGUAGES = ["ko","en","zh","fr","de","es","pt"]` `[코드]`
`lib/language.ts:11`.

**모든 모델 template은 7개 언어를 전부 갖습니다.** 조용한 fallback을 두지
않습니다 — `Record<Language, Copy>`를 쓰면 언어 추가 시 TypeScript가 빠진
항목을 잡습니다(`lib/accountEmails.ts:79`가 이미 이 패턴).

**관할권과 언어는 별개 축입니다.** KR 거주 + 영어 사용자는 `(광고)` 접두어
(관할권)와 영어 본문(언어)을 함께 받습니다.

### 14.3 카피 규칙

**홍보(A/B)**
- 검증되지 않은 "최고", "가장 빠름", "가장 똑똑한" 금지.
  `tests/autoRoutingUi.test.mjs`가 auto-routing 문구에 대해 이미 같은 검사를
  합니다 — 같은 방식의 test를 모델 카피에 적용합니다.
- provider 공식 문서로 확인된 capability만.
- plan/credit 명시.
- production에서 실제 `enabled && publiclyListed`인 모델만 홍보 — 렌더 시점이
  아니라 **enqueue 시점에 검사**하고, 실패하면 campaign을 만들지 않습니다.
- CTA 하나.

**폐기(D/E/F/G)**
- 사실과 사용자 영향 우선, 사과 서술 금지.
- 날짜는 항상 timezone 라벨과 함께.
- 무엇이 바뀌지 않는지를 명시.
- promotional upsell 금지 — `service` 메일에 상위 플랜 CTA를 넣지 않습니다.
- 불안 조성 금지("지금 조치하지 않으면…").

### 14.4 wireframe — D: 폐기 사전 안내

```
┌──────────────────────────────────────────────────┐
│  (preheader) Grok 4.5 is being retired on 15 Sep.│
│              Your default model will change.     │
├──────────────────────────────────────────────────┤
│  TOMVERSE                                        │
│                                                  │
│  A model you use is being retired                │
│                                                  │
│  Grok 4.5 will stop being available on           │
│  15 September 2026, 09:00 (Australia/Brisbane).  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │  Retiring    Grok 4.5      Advanced · 3cr  │  │
│  │  Replacing   Gemini 3.6 Flash              │  │
│  │              Advanced · 2 credits          │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  What changes for you                            │
│   • Your default model is Grok 4.5.              │
│   • On 15 Sep we will set it to Gemini 3.6       │
│     Flash unless you choose another model first. │
│   • 3 of your conversations have Grok 4.5        │
│     selected. Those selections change too.       │
│                                                  │
│  What does not change                            │
│   • Answers you already received stay as they    │
│     are, and still show Grok 4.5.                │
│   • Links you have shared keep their content.    │
│   • Your credits and billing are unaffected.     │
│                                                  │
│  Differences worth knowing                       │
│   • Gemini 3.6 Flash costs 2 credits, not 3.     │
│   • It accepts images and PDFs; Grok 4.5         │
│     accepted images only.                        │
│                                                  │
│         [ Choose your model ]                    │
│  https://tomverse.app/settings                   │
│                                                  │
│  Questions: support@tomverse.app                 │
├──────────────────────────────────────────────────┤
│  You receive this because it affects a model on  │
│  your account. Manage what we send:              │
│  tomverse.app/settings/notifications             │
│  [ jurisdiction footer blocks ]                  │
└──────────────────────────────────────────────────┘
```

### 14.5 sample copy

**A. 신규 모델 출시 — `marketing` / `product_updates`**

en
> **Subject:** Claude Opus 5.1 is now on Tomverse
>
> Claude Opus 5.1 is available from today on the Pro and Max plans.
>
> · 200K context window
> · Image and PDF input
> · Premium tier — 12 credits per message
>
> It sits alongside the models you already use; nothing about your current
> selection changes.
>
> [ Try Opus 5.1 ]
>
> You are receiving this because you asked for product updates.
> Unsubscribe · Manage preferences

ko
> **제목:** Claude Opus 5.1을 Tomverse에서 쓸 수 있습니다
>
> 오늘부터 Pro·Max 플랜에서 Claude Opus 5.1을 사용할 수 있습니다.
>
> · 컨텍스트 200K 토큰
> · 이미지·PDF 입력 지원
> · Premium 등급 — 메시지당 12크레딧
>
> 기존 모델과 함께 제공되며, 지금 쓰고 계신 선택은 바뀌지 않습니다.
>
> [ Opus 5.1 사용해 보기 ]
>
> 제품 소식 수신에 동의하셔서 보내 드립니다.
> 수신 거부 · 수신 설정

**B. 업그레이드 — `marketing` / `product_updates`**

en
> **Subject:** Gemini 3.7 Pro replaces 3.6 Pro on Tomverse
>
> Gemini 3.7 Pro is available today. It is the successor to Gemini 3.6 Pro,
> which stays available for now.
>
> What Google changed: a 2M token context window (3.6 Pro had 1M), and
> native PDF input.
>
> Price is unchanged — Advanced tier, 4 credits per message.
>
> **Your settings are not changed by this.** If you want 3.7 Pro as your
> default, choose it in settings.
>
> [ Compare the two ]

ko
> **제목:** Gemini 3.7 Pro가 Tomverse에 추가됐습니다
>
> 오늘부터 Gemini 3.7 Pro를 사용할 수 있습니다. Gemini 3.6 Pro의 후속 모델이며
> 3.6 Pro는 당분간 그대로 유지됩니다.
>
> Google이 바꾼 것: 컨텍스트 200만 토큰(3.6 Pro는 100만), PDF 원본 입력 지원.
>
> 가격은 그대로입니다 — Advanced 등급, 메시지당 4크레딧.
>
> **이 메일로 설정이 바뀌지는 않습니다.** 3.7 Pro를 기본으로 쓰시려면 설정에서
> 직접 선택해 주세요.
>
> [ 두 모델 비교하기 ]

**D. 폐기 사전 안내 — `service` / `model_lifecycle`**

en
> **Subject:** Grok 4.5 is being retired on 15 September
>
> Grok 4.5 stops being available on **15 September 2026, 09:00
> (Australia/Brisbane)**.
>
> **What changes for you**
> · Grok 4.5 is your default model. On 15 September we will set it to
>   **Gemini 3.6 Flash**, unless you choose a different model before then.
> · 3 of your conversations have Grok 4.5 selected. Those selections move to
>   Gemini 3.6 Flash at the same time.
>
> **What does not change**
> · Answers you already received stay as they are and still show Grok 4.5.
> · Links you have shared keep their content.
> · Your credits and billing are not affected.
>
> **Differences worth knowing**
> · Gemini 3.6 Flash costs 2 credits per message; Grok 4.5 cost 3.
> · It accepts images and PDFs. Grok 4.5 accepted images only.
>
> [ Choose your model ]  https://tomverse.app/settings
>
> Questions: support@tomverse.app

ko
> **제목:** Grok 4.5가 9월 15일에 종료됩니다
>
> Grok 4.5는 **2026년 9월 15일 오전 9시(호주 브리즈번 기준)**에 사용할 수
> 없게 됩니다.
>
> **바뀌는 것**
> · 지금 기본 모델이 Grok 4.5입니다. 9월 15일에 **Gemini 3.6 Flash**로
>   변경됩니다. 그 전에 다른 모델을 고르시면 그 선택이 유지됩니다.
> · 대화 3개에 Grok 4.5가 선택돼 있습니다. 같은 시점에 함께 변경됩니다.
>
> **바뀌지 않는 것**
> · 이미 받으신 답변은 그대로이며 Grok 4.5로 표시됩니다.
> · 공유하신 링크의 내용은 그대로입니다.
> · 크레딧과 결제에는 영향이 없습니다.
>
> **알아 두실 차이**
> · Gemini 3.6 Flash는 메시지당 2크레딧입니다. Grok 4.5는 3크레딧이었습니다.
> · 이미지와 PDF를 함께 받습니다. Grok 4.5는 이미지만 지원했습니다.
>
> [ 모델 선택하기 ]  https://tomverse.app/settings
>
> 문의: support@tomverse.app

**E. reminder — `service` / `model_lifecycle`**

en
> **Subject:** 3 days left — Grok 4.5 retires on 15 September
>
> This is the last reminder. Grok 4.5 stops being available on 15 September
> 2026, 09:00 (Australia/Brisbane), and your default model will change to
> Gemini 3.6 Flash at that time.
>
> If you already chose a different model, you can ignore this — we recheck
> before sending and you would not have received it. [본문 조건부]
>
> [ Choose your model ]

ko
> **제목:** 3일 남았습니다 — Grok 4.5가 9월 15일에 종료됩니다
>
> 마지막 안내입니다. Grok 4.5는 2026년 9월 15일 오전 9시(브리즈번)에 사용할 수
> 없게 되며, 그 시점에 기본 모델이 Gemini 3.6 Flash로 변경됩니다.
>
> [ 모델 선택하기 ]

**F. 자동 전환 완료 — `transactional`**

en
> **Subject:** Your default model changed to Gemini 3.6 Flash
>
> Grok 4.5 was retired on 15 September 2026, 09:00 (Australia/Brisbane).
> We changed the settings that pointed at it:
>
> · Default model: Grok 4.5 → Gemini 3.6 Flash
> · New conversation combination: Grok 4.5 → Gemini 3.6 Flash
> · 3 conversations: Grok 4.5 → Gemini 3.6 Flash
>
> Changed at 15 September 2026, 09:04 (Australia/Brisbane).
>
> You can pick a different model at any time in settings. Answers you
> already received are unchanged and still show Grok 4.5.
>
> [ Open settings ]

ko
> **제목:** 기본 모델이 Gemini 3.6 Flash로 변경됐습니다
>
> Grok 4.5가 2026년 9월 15일 오전 9시(브리즈번)에 종료되어, 이 모델을 가리키던
> 설정을 변경했습니다.
>
> · 기본 모델: Grok 4.5 → Gemini 3.6 Flash
> · 새 대화 시작 조합: Grok 4.5 → Gemini 3.6 Flash
> · 대화 3개: Grok 4.5 → Gemini 3.6 Flash
>
> 변경 시각: 2026년 9월 15일 오전 9시 4분(브리즈번)
>
> 설정에서 언제든 다른 모델로 바꾸실 수 있습니다. 이미 받으신 답변은 변경되지
> 않았고 Grok 4.5로 표시됩니다.
>
> [ 설정 열기 ]

**G. 긴급 사용 불가 — `service` / `service_status`**

en
> **Subject:** Grok 4.5 is temporarily unavailable
>
> Grok 4.5 is not responding and we have disabled it while xAI investigates.
> We do not have a restoration time yet.
>
> Until it returns, requests to Grok 4.5 will use **Gemini 3.6 Flash** as a
> temporary fallback. This is not a permanent replacement and your saved
> settings are unchanged.
>
> We will email again when it is back, or if this becomes permanent.
>
> Status: https://tomverse.app/status

ko
> **제목:** Grok 4.5를 일시적으로 사용할 수 없습니다
>
> Grok 4.5가 응답하지 않아 xAI 확인 중 사용을 중지했습니다. 복구 시점은 아직
> 알 수 없습니다.
>
> 복구 전까지 Grok 4.5 요청은 **Gemini 3.6 Flash**로 임시 처리됩니다. 영구
> 대체가 아니며, 저장하신 설정은 변경되지 않았습니다.
>
> 복구되거나 영구 종료로 결정되면 다시 안내드립니다.
>
> 서비스 상태: https://tomverse.app/status

**G에서 미래 날짜를 지어내지 않습니다.** 정식 폐기(D)와 분리된 이유입니다.

### 14.6 렌더링 품질 요구

600~640px table, inline CSS, preheader, brand header, 모바일 단일 컬럼,
320px·200% zoom, 색 없이 이해 가능, 고대비, 긴 model ID `word-break:break-all`,
이미지 alt, plain-text fallback, dark mode 최소 가독성(배경색 명시),
외부 font·background image 의존 금지, CTA 아래 원문 URL,
jurisdiction footer, marketing만 unsubscribe/preference center,
`service` 메일에 upsell 금지, 렌더러에 `new Date()`/random/live DB lookup 금지,
동일 version+payload+language+policy는 바이트 동일.

---

## 15. Admin UX

ADR §12.1이 `/admin/messaging`을 제안했지만, `admin-console-ia.md` 계약에 따라
**최소 변경 원칙**으로 다음을 권고합니다.

| 배치 | 내용 |
|---|---|
| `/admin/models?tab=discovery` | 후보 backlog. provider/first-seen/age/추천/blocker. 결정 버튼 |
| `/admin/models?tab=lifecycle` | work item 목록. 상태별 필터, 소유자·기한 |
| `/admin/work-queue` | `lib/adminWorkQueue.ts`에 `Model lifecycle` collector 1개 추가 |
| `/admin/email-delivery?tab=campaigns` | campaign 목록·미리보기·승인·dry run (Phase 4) |

**계약 준수 체크**
- `lib/adminNavigation.ts` + `adminNavigationIcons.ts` + 실제 route 세그먼트
  **세 곳 동시 등록**. catch-all `[section]` 금지, 알 수 없는 URL은 404.
- 섹션은 `?tab=`, 탭은 `<Link>`, 서버 컴포넌트가 `searchParams`를 읽고
  **열린 섹션의 데이터만** 로드.
- 배지는 작업이 있을 때만: `awaiting_decision` 수, `pending_approval` campaign 수.
  0이면 배지 없음, 알 수 없으면 아무것도 렌더하지 않음.
- 은퇴한 `/admin/*` URL은 redirect 유지(이번 변경은 신설만이므로 해당 없음).

**accent token**: 새 역할이 필요하면 `app/globals.css`에 namespace를 만들고
`scripts/check-accent-tokens.mjs`의 `KNOWN_ROLES`에 등록한 뒤 씁니다.
`accent-model-catalogue-*`(purple)가 이미 있으므로 discovery/lifecycle은
그것을 씁니다. AI Review gradient는 예약.

---

## 16. schema / API 변경안

### 16.1 migration (additive only)

| # | 내용 | Phase |
|---|---|---|
| S1 | `ModelLifecycleWorkItem` + `ModelLifecycleWorkItemEvent` 신설 + status/action CHECK | 1 |
| S2 | 기존 `ProviderModelCatalogEntry` → work item backfill (미매핑 candidate + likely_deprecated) | 1 |
| S3 | `EmailPreference` 전 계정 backfill (EM-13) | 3 |
| S4 | `EmailPreference_purpose_check`에 `'model_lifecycle'` 추가 + 전 계정 row 생성 | 3 |
| S5 | `ModelMigrationRecord` 신설 (append-only, ML-11) | 3 |
| S6 | `EmailCampaign` + `EmailCampaignWave` + `EmailCampaignRecipient` + CHECK | 4 |
| S7 | `EmailDelivery` snapshot retention 정책 (코드 변경, migration 없음) | 2 |

**컬럼 삭제 없음.** `ProviderModelCatalogEntry`는 그대로 둡니다 — 관측
기록이며 work item과 역할이 다릅니다.

### 16.2 API

| method | path | 용도 | 승인 |
|---|---|---|---|
| GET | `/api/admin/model-lifecycle` | work item 목록(status/provider/owner 필터) | 불요 |
| PATCH | `/api/admin/model-lifecycle/[id]` | 결정·소유자·기한·연기 | 단일 |
| POST | `/api/admin/model-lifecycle/[id]/transition` | 상태 전이 | 단일 |
| GET | `/api/admin/model-lifecycle/audience` | audience dry run(발송 없음) | 불요 |
| GET/POST | `/api/admin/email-campaigns` | 목록 / draft 생성 | 생성 불요 |
| POST | `/api/admin/email-campaigns/[id]/preview` | 관할권×언어 렌더 | 불요 |
| POST | `/api/admin/email-campaigns/[id]/dry-run` | `skipped:dry_run` 생성 | 단일 |
| POST | `/api/admin/email-campaigns/[id]/approve` | `AdminActionApproval` | **이중(1인 예외 적용)** |
| POST | `/api/admin/email-campaigns/[id]/cancel` | 취소 | 단일 |
| POST | `/api/internal/maintenance/email-campaign-expand` | fan-out 1 pass | 내부 |

모든 write는 `consumeApiRateLimit()`, `readLimitedJson()`, `writeAdminAuditLog()`
를 기존대로 씁니다.

---

## 17. 테스트 전략

### A. 모델 lifecycle (unit + DB integration)

| 테스트 | 막는 실패 |
|---|---|
| 첫날 NEW, 다음 날 PENDING 1d | **ML-01**. 후보가 하루 만에 사라짐 |
| approved → implementation_pending 유지 | registry 행 생성만으로 완료 처리 |
| rejected/deferred/snoozed가 다시 NEW로 돌아오지 않음 | 같은 결정을 매일 다시 요구 |
| registry 행 생성 ≠ completed | 가격·검증·통지 미완인 채 닫힘 |
| provider `failed`가 work item 상태를 바꾸지 않음 | 장애를 폐기 증거로 사용 |
| alias/version dedup | 같은 모델이 두 work item |
| auto-disable → work item 1건, 재발견 → restore + 같은 item 유지 | 자동 조치가 결정 이력을 지움 |
| replacement chain 유효성(순환·자기참조·비활성 대상) | 존재하지 않는 대체 모델을 사용자에게 약속 |

### B. campaign / fan-out (DB integration)

| 테스트 | 막는 실패 |
|---|---|
| 같은 event 2회 확장 → delivery 수 불변 | 중복 발송 |
| cursor resume: 200건 중 120건에서 중단 후 재개 | 재시작이 처음부터 |
| worker 2개 동시 claim | 이중 발송 |
| recipientCap 초과 시 중단 + 사유 기록 | 조용한 절단 |
| dry run이 `skipped:dry_run`만 만들고 provider를 호출하지 않음 | 테스트가 실제 발송 |
| cancel 후 미발송 | 취소가 늦음 |
| source work item 상태가 바뀌면 stale campaign 차단 | 철회된 결정으로 발송 |
| `@@unique([waveId,userId])` | 한 사람에게 두 통 |
| batch 중간 실패 후 재개 | 부분 확장이 고아로 남음 |

### C. consent / classification

| 테스트 | 막는 실패 |
|---|---|
| launch/upgrade는 `product_updates` opt-in 없으면 `skipped:no_consent` | 동의 없는 광고 — **회수 불가** |
| **preference row 부재 = fail-closed (consent 대상 purpose)** | **EM-02 — 회수 불가** |
| opt-out 후 queued mail 차단 | 철회가 무시됨 |
| jurisdiction unknown/conflict에서 marketing 차단 | 잘못된 라벨로 광고 |
| service/legal/transactional 분류 행렬(6 template × 4 classification) | 오분류 |
| marketing unsubscribe 헤더 존재, transactional/legal 부재 | 로그인 코드에 수신거부 버튼 |
| `MARKETING_EMAIL_FROM` 부재 → permanent refusal + incident | 광고가 로그인 도메인에서 발송 |
| transactional stream으로 marketing 우회 불가 | 위와 동일 |
| **KR profile에서 marketing subject가 `(광고)`로 시작** | **EM-04 — 회수 불가** |

### D. retirement audience

`defaultModel` / `newConversationModelIds` / `Conversation.selectedModels`
각각, union 중복 제거, 직접 변경한 사용자의 reminder 제외, plan 불일치 제외,
malformed 보존, 이메일 없음·suppression 제외, **migration 대상 수 =
`ModelMigrationRecord` 행 수 = completion audience 크기**.

### E. reconciliation

exact model ID만 변경, JSON 배열 항목 단위, duplicate collapse, malformed 보존,
과거 `Message`/ledger 불변, 승인 없는 `--apply` 거부, CI/lifecycle 거부,
idempotent rerun, `newConversationModelIds`와 `defaultModel` 동기화(ML-09),
rollback 가능성(`ModelMigrationRecord`에서 역방향 생성 가능).

### F. template / rendering

deterministic bytes(같은 payload 2회 렌더 → 동일), HTML escaping,
snapshot 암호화, HMAC 키 버전, **7개 언어 전부**, **8 jurisdiction × 7 언어
snapshot**, Outlook/Gmail/mobile, plain-text 동등성, 긴 model ID,
접근성(대비·alt·논리 순서), preheader, subject prefix, footer, unsubscribe.

### G. delivery

retry curve(분류별), provider idempotency, bounce/complaint webhook replay,
suppression 우선, 계정 삭제/주소 변경, abandoned classification incident,
marketing kill switch, outbox backlog incident.

### 계층 배분

| 계층 | 대상 |
|---|---|
| pure unit | 상태 전이 그래프, audience 규칙, 카피 금지어, cohort 산식 |
| DB integration | fan-out, consent, audience 쿼리, reconciliation |
| server-contract | admin API 응답 형태·권한 |
| rendering snapshot | 6 template × 7 언어 × 8 profile (=336 snapshot; 자동 생성) |
| E2E | admin discovery 화면, campaign 승인 플로우 |
| staging | 실제 발송 3~5통 (18절) |

---

## 18. blocking / optional verification

### 18.1 총량

- **release-blocking 검증: 9건**
- **선택 검증: 14건**
- **외부 provider를 실제 호출하는 유료/실발송 turn: 5건**

### 18.2 release-blocking (되돌릴 수 없는 것만)

| # | 항목 | 무엇이 복구 불가인가 | 유료 turn |
|---|---|---|---|
| B1 | preference row 부재 fail-closed (EM-02) | 동의 없이 발송한 광고는 회수 불가 | 0 |
| B2 | KR/SG marketing subject 접두어 (EM-04) | 규제 위반 발송은 회수 불가 | 0 |
| B3 | fan-out 재실행 시 delivery 수 불변 | 중복 발송은 회수 불가 | 0 |
| B4 | dry run이 provider를 호출하지 않음 | 테스트가 실제 발송이 되면 회수 불가 | 0 |
| B5 | audience cohort union 정확성 | 잘못된 수신자에게 간 메일은 회수 불가 | 0 |
| B6 | `newConversationModelIds` 동기화 (ML-09) | 잘못 덮어쓴 선택 상태는 이력이 없어 복구 불가 | 0 |
| B7 | malformed 값 보존 | 파괴된 사용자 설정은 복구 불가 | 0 |
| B8 | `ModelMigrationRecord` 행 수 = 실제 변경 수 (ML-11) | 잘못된 대상에게 "바꿨습니다"를 보내면 회수 불가 | 0 |
| B9 | snapshot/로그에 credential·개인정보 미포함 | 유출은 회수 불가 | 0 |

**전부 자동 테스트로 증명 가능하며 유료 turn 0입니다.**

### 18.3 유료/실발송 turn 5건 — 각각 무엇을 판별하는가

| # | 발송 | 판별 대상 | 차단? |
|---|---|---|---|
| P1 | 관리자 Daily v2 → 운영자 주소 1통 | Outlook/Gmail에서 table 레이아웃이 무너지지 않는지. HTML 검사기로는 알 수 없음 | 비차단 |
| P2 | D template ko → 테스트 주소 1통 | 한국어 줄바꿈, 긴 model ID, preheader가 실제 클라이언트에서 어떻게 보이는지 | 비차단 |
| P3 | marketing template + `MARKETING_EMAIL_FROM` 미설정 | **거부가 실제로 일어나는지**. mock으로는 provider 응답을 모름 | **차단** |
| P4 | dry-run campaign 100건 | provider 호출이 0회인지 (Resend 로그로 확인) | **차단** |
| P5 | staging에서 폐기 1건 end-to-end (D→E→reconciliation→F) | 이메일 내용과 실제 변경의 정합성 | **차단** |

### 18.4 건너뛴 것과 이유

- **다크 모드 픽셀 검증**: 되돌릴 수 있음(고치면 끝). 비차단.
- **7개 언어 실발송**: ko/en 2개만 실발송하고 나머지는 snapshot test로 대체.
  번역 오류는 고쳐서 재배포할 수 있음.
- **8 jurisdiction 실발송**: KR(접두어 있음) + US(없음) 2개만. 나머지는 snapshot.
- **DMARC 리포트 실수신 확인**: 이 감사의 read-only 권한 밖. 23절.

---

## 19. rollout / rollback

| Phase | 내용 | flag | backfill | blocking evidence | optional | success metric | abort | rollback | owner |
|---|---|---|---|---|---|---|---|---|---|
| 0 | 현 상태 감사(본 문서) | — | — | — | — | 문서 제출 | — | — | — |
| 1 | persistent work queue + 조회 화면 | `feature.modelLifecycleQueue` | S2 (candidate→work item) | 상태 전이 unit, backlog 재조회 DB test | E2E admin | 미검토 후보가 2일 연속 보임 | backfill이 중복 생성 | flag off, 테이블 유지 | — |
| 2 | Daily email v2 (standard lane) | `feature.modelLifecycleReportV2` | — | 렌더 determinism, 절단 표기 | Outlook 육안(P1) | 운영자가 v1 대신 v2를 읽음 | 렌더 실패 | flag off → v1 | — |
| 3 | 사용자 template 6종 + `model_lifecycle` purpose | `feature.emailModelLifecycle` | S3, S4 (preference) | B1, B2, B9 · 7언어 snapshot | 8 profile snapshot | 전 계정에 preference 행 존재 | backfill이 기존 선택을 덮음 | flag off. **컬럼 삭제 금지** | — |
| 4 | campaign draft/preview/approval (발송 disabled) | `feature.emailCampaignsEnabled` | S6 | B4 · approval payloadHash | preview UX | dry run 100건이 provider 0회 호출(P4) | provider 호출 발생 | flag off | — |
| 5 | segment fan-out shadow (`dry_run`) | 동일 | — | B3, B5 · cursor resume | 대량 성능 | 재실행 시 delivery 수 불변 | 중복 생성 | wave `cancelled` | — |
| 6 | 신규/업그레이드 limited marketing | `feature.emailMarketingEnabled` | — | B1, B2 · P3 · EM-09 kill switch | warm-up 곡선 | complaint rate < 0.1% | complaint > 0.3% | kill switch → wave `halted` | legal 승인 필요 |
| 7 | 폐기 end-to-end 1건 | 동일 | S5 | B6, B7, B8 · P5 | 사용자 문의 수 | 완료 안내 수 = migration record 수 | 불일치 발견 | reconciliation은 record로 역산 | — |
| 8 | 제한된 자동화(auto draft + approved schedule) | `feature.modelLifecycleAutoDraft` | — | raw discovery→발송 차단 test | — | draft 정확도 | 오탐 draft | flag off | — |

**Phase 6 선행 조건**(전부 이 저장소 밖):
법률 검토 Q1/Q2/Q8 회신 · marketing provider 계정/region 결정 ·
`news.tomverse.app` 구성 · SPF/DKIM/DMARC · warm-up 4~6주 · consent cohort 확보.

**Phase 7 순서**: 승인된 retirement 1건 → 사전 안내(D) → reminder(E) →
reconciliation dry run → retirement deploy → `--approved-retirement` apply →
post-run validation → completion(F). **이 순서를 바꾸지 않습니다.**

---

## 20. P0/P1/P2 backlog

### P0 — 가장 먼저 구현할 다섯 가지

| # | 항목 | findings | 왜 지금인가 |
|---|---|---|---|
| P0-0 | 미처리 7건 triage 실행 (`model-lifecycle-triage-2026-08-22.md`) | ML-01 | 최대 28일째 방치. P0-1과 **병렬**로 — 순차로 하면 처리하는 동안 새 후보가 같은 방식으로 사라집니다 |
| P0-1 | ~~`ModelLifecycleWorkItem` + backfill~~ **완료 (2026-08-22)** | ML-01, ML-03, ML-12 | 하루만 사는 후보가 계속 사라지고 있었습니다. §9.5 참조 |
| P0-2 | ~~`/admin/models?tab=discovery` + work-queue collector~~ **완료 (2026-08-22)** | ML-02 | 저장된 것을 볼 수 없으면 P0-1이 의미가 없었습니다 |
| P0-3 | ~~Daily email v2 (NEW/PENDING 분리 + standard lane)~~ **완료 (2026-08-23)** | ML-01, ML-04, EM-14 | 운영자가 매일 보는 유일한 신호였습니다. §10.10 참조 |
| P0-4 | ~~preference fail-closed + 전 계정 backfill~~ **완료 (2026-08-22)** | EM-02, EM-13 | marketing template이 생기는 순간 동의 없는 발송이 될 상태였습니다 |
| P0-5 | ~~audience 계산기 + `ModelMigrationRecord` + `newConversationModelIds` 동기화~~ **완료 (2026-08-22)** | ML-09, ML-11 | 이 셋이 없으면 폐기 안내를 사실대로 쓸 수 없었습니다 |

### P1

- ~~EM-04 jurisdiction footer/접두어 발송 경로 연결~~ **완료 (2026-08-23)** — §24
- ~~EM-03 marketing 경로 end-to-end 테스트~~ **완료 (2026-08-23)** — §26
- ~~EM-07 Founding Tester ×3 + admin plan-adjust를 큐로~~ **완료 (2026-08-23)** — §30
- ~~EM-12 legal/transactional template 7개 언어~~ **완료 (2026-08-23)** — §27
- ~~EM-08 snapshot retention + 무한 증가 테이블 등록~~ **완료 (2026-08-23)** — §29
- ~~ML-08 auto-disable → work item 생성~~ **완료 (2026-08-23)** — §25
- ~~ML-12 provider 무관 후보 dedup~~ **완료 (2026-08-23)** — §28
- ~~ML-13 리포트에서 모델 소유자와 관측 경로 분리~~ **완료 (2026-08-23)** — §31
- ~~ML-10 reconciliation script 범용화 + precondition 검사~~ **완료 (2026-08-23)** — §33
- ~~EM-06 campaign이 templateVersion pin~~ **완료 (2026-08-24)** — §37
- ~~EM-11 standard drain job key + backlog incident~~ **완료 (2026-08-23)** — §35
- ~~EM-10 조건부 readiness~~ **완료 (2026-08-23)** — §32
- ~~EM-09 marketing bounce/complaint kill switch~~ **완료 (2026-08-23)** — §34
- ~~EM-15 `userVisibleNote` 다국어~~ **완료 (2026-08-24)** — §39

### P2

- ~~ML-05 minimax 표시명 + 전수 test~~ **완료 (2026-08-24)** — §40
- ML-06 이미지 모델 discovery (별도 설계) — 리포트 범위 한계 명시는 §10.10에서 완료
- ~~ML-07 perplexity 한계 명시~~ **완료** — §10.10
- ~~OpenAI `isLikelyChatModelId` prefix 위험 완화(6절 #10)~~ **완료 (2026-08-24)** — §40
- ~~`MAX_PAGES` 초과 시 경고 로그~~ **완료 (2026-08-24)** — §40
- `/admin/email-delivery` 주소 마스킹 정책 — **결정 대기**(§21에 D10으로 추가)

---

## 21. 관리자 / product / legal 결정 필요 항목

| # | 결정 | 결정권자 | 막고 있는 것 | 기본 권고 |
|---|---|---|---|---|
| D1 | `model_lifecycle` purpose 신설 여부 (ADR v5 개정) | product + legal | Phase 3 전체 | **신설**. `service_status` 재사용은 두 약속을 한 스위치에 담습니다 |
| D2 | 자동 전환 완료 안내를 `transactional`로 둘지 | product + legal | F template | **transactional**. 요청 없이 가한 변경의 기록이므로 끌 수 없어야 합니다 |
| D3 | 전체 대상 일반 폐기 공지를 만들지 | product | C template | **만들지 않음**. marketing A/B에 흡수 |
| D4 | marketing Resend 계정/region 분리 | ops + legal | Phase 6 | ADR §5.3.1 미결 |
| D5 | 1인 조직 이중 승인 예외를 campaign에 적용 | 조직 | Phase 4 승인 | `soleApproverAllowed` 선례 적용 |
| D6 | reminder를 몇 번 보낼지 (1회 / 2회) | product | E wave 수 | **최초 + 3일 전 2회**. 그 이상은 스팸 신고를 부릅니다 |
| D7 | 사전 안내 리드타임 | product | D 일정 | **14일**. 폐기 결정 → 안내 → reminder → 실행 |
| D8 | assistant profile이 모델 선택을 갖는지 | eng | audience 정의 | 조사 필요(23절) |
| D9 | 최근 사용 기반 cohort를 포함할지 | product | audience 크기 | **미포함**. 저장된 선택만. 최근 사용은 영향이 아니라 관심입니다 |
| D10 | `/admin/email-delivery`의 사용자 주소를 마스킹할지 | product + ops | 없음(오늘 동작함) | **기본 마스킹 + 명시적 공개 행위를 감사 로그에 기록**. 지원 능력을 잃지 않으면서 노출을 *상태*가 아니라 *사건*으로 만듭니다. 다만 공개 행위의 감사 설계는 구현 전 승인이 필요합니다 |

---

## 22. 확인 불가 운영 사실과 read-only 확인 방법

| # | 확인 불가 사실 | read-only 확인 방법 |
|---|---|---|
| U1 | 지금 DB에 미검토 candidate가 **누적 총** 몇 건인지 | **해결됨 (2026-08-22).** DB 없이 Slack 리포트 전 기간(2026-07-21~08-22) 합집합으로 복원: **후보 37건 / 고유 모델 약 24종 / 그중 first-party 미처리 7건.** 5절 ML-01의 표. production 변수 읽기는 권한 classifier가 차단했고, 우회하지 않았습니다. DB 직접 확인이 필요하면 `SELECT provider, count(*) FROM "ProviderModelCatalogEntry" WHERE status='candidate' AND "modelRegistryId" IS NULL GROUP BY provider;` |
| U2 | ML-01 때문에 놓친 모델이 실제로 있는지 | **해결됨 (2026-08-22).** U1과 같은 자료로 확인. **7건이 first-party 모델이면서 오늘 저장소에 없고, 어느 하나도 두 번 호명되지 않았습니다.** 5절 ML-01의 표 |
| U3 | Daily 이메일이 실제로 도착하는지 | **부분 해결.** cron 로그의 `emailDelivered: 1`·`slackDelivered: true`가 8/17~8/21 전일 확인됩니다. 다만 이는 **발송 시도의 성공**이지 수신이 아닙니다(EM-14: bounce 처리 없음). 수신 확인은 여전히 사서함 필요 |
| U4 | provider별 최근 성공 시각 | **부분 해결.** 8/17~8/22 매일 `checked: 12/12 · failed: 0`. provider별 세부는 `SELECT provider, max("startedAt") FROM "ProviderModelCatalogRun" WHERE status='checked' GROUP BY provider;` |
| U12 | Zhipu 카탈로그가 `glm-5.3`을 반환하지 않는 이유 (ML-12) | `SELECT * FROM "ProviderModelCatalogEntry" WHERE provider='zhipu';` — API key별 모델 가시성(6절 #4) 또는 endpoint 범위 차이 |
| U5 | preference 행이 없는 계정 수 (EM-02 노출 규모) | `SELECT count(*) FROM "User" u WHERE NOT EXISTS (SELECT 1 FROM "EmailPreference" p WHERE p."userId"=u.id);` |
| U6 | `MARKETING_EMAIL_FROM` production 설정 여부 | `GET /api/ready`의 `email-sending-identity` 항목, 또는 `npm run report:email-domains` |
| U7 | DMARC 리포트 실수신 여부 | `dmarc@tomverse.app` 사서함 확인. 저장소 밖 |
| U8 | `gpt-5-4-mini` 잔여 사용자 수 | `node --import tsx scripts/run-default-model-reconciliation.mjs` (dry run, 쓰기 없음) |
| U9 | assistant profile의 모델 선택 저장 위치 (D8) | `AssistantProfileVersion` 스키마 조사 — 이번 감사 범위 밖 |
| U10 | EmailDelivery 현재 행 수·snapshot 크기 (EM-08 규모) | `SELECT status, count(*), count("renderDataSnapshot") FROM "EmailDelivery" GROUP BY status;` |
| U11 | Resend 계정 suppression 목록에 오른 자사 사용자 수 | Resend 콘솔 또는 `mcp__Resend__list-suppressions`. 이번 권한 밖 |

---

## 23. 최종 판정

### 한 문장씩

- **새 이메일 시스템에서 이미 해결된 것은 무엇인가?**
  transactional·legal 사용자 메일의 유실입니다 — outbox, 분류별 재시도,
  suppression, 웹훅, 동의 이력, 로그인 없는 수신 거부, 발신 도메인 분리가
  실제로 동작합니다.

- **아직 model lifecycle 전용으로 연결되지 않은 것은 무엇인가?**
  전부입니다 — 모델용 template 0개, campaign 0줄, fan-out 0줄, audience 쿼리
  0줄이고, Daily 리포트는 이메일 시스템 밖에서 직접 발송됩니다.

- **신규 후보가 다음 날에도 추적되는가?**
  아니오 — `newCandidates`는 첫 관측에서만 채워지고
  (`lib/providerModelCatalogMonitor.ts:213`), 그 행을 다시 읽는 코드가 저장소에
  없으며, 2026-07-21~08-22 전 기간 실측에서 후보 37건 중 first-party 모델 7건이
  한 번 호명된 뒤 최대 28일째 저장소 어디에도 없습니다.

- **현재 Daily 이메일이 새 standard lane과 template registry를 활용하는가?**
  아니오 — `sendTransactionalEmail()` 직접 호출에 `white-space:pre-wrap` 평문이며
  `AdminNotificationLog`에만 남습니다
  (`lib/providerModelCatalogReport.ts:212-216`).

- **신규/업그레이드 홍보 이메일을 지금 production에서 발송할 수 있는가?**
  아니오 — marketing template이 0개이고 `MARKETING_EMAIL_FROM`이 없어
  `MARKETING_FROM_MISSING`으로 거부되며, DMARC 관측과 warm-up과 법률 검토가
  모두 미완입니다.

- **model retirement 안내의 올바른 classification은 무엇인가?**
  영향 사용자 사전 안내와 reminder는 `service` + 신규 `model_lifecycle` purpose,
  자동 전환 완료 안내는 `transactional`, 긴급 사용 불가는 `service` +
  `service_status`입니다 — `legal`로 올리는 것은 중요함을 분류로 착각하는
  오분류입니다.

- **영향 사용자를 현재 정확히 계산할 수 있는가?**
  아니오 — `defaultModel`과 `Conversation.selectedModels`는 셀 수 있지만
  `newConversationModelIds` 쿼리가 없고, 사용자 단위 union·이메일·suppression
  결합이 어디에도 없습니다.

- **자동 전환을 사용자에게 지금 사실대로 약속할 수 있는가?**
  아니오 — script가 `newConversationModelIds`를 옮기지 않고(ML-09) 무엇을
  바꿨는지 사용자 단위로 남기지 않아서(ML-11), 약속도 완료 보고도 검증할 수
  없습니다.

- **campaign fan-out이 현재 구현되어 있는가?**
  아니오 — `user_segment`/`all_users`와 `audienceSpec`/`expansionCursor`는
  스키마와 CHECK에만 있고 코드가 한 번도 쓰지 않습니다.

- **가장 먼저 구현해야 할 다섯 가지는 무엇인가?**
  `ModelLifecycleWorkItem`과 backfill, 그것을 볼 수 있는 admin 화면,
  NEW/PENDING을 나눈 Daily email v2, preference fail-closed와 전 계정 backfill,
  audience 계산기와 `ModelMigrationRecord`입니다.

- **end-to-end 시스템을 현재 Mature하다고 부를 수 있는가?**
  아니오 — 이메일 플랫폼은 3~4 수준이지만 모델 lifecycle vertical은 탐지 이후가
  전부 0이므로, 닫힌 loop가 존재하지 않습니다.

---

## 24. EM-04 구현 기록 (2026-08-23 · 완료)

| 파일 | 역할 |
|---|---|
| `lib/emailJurisdictionComposition.ts` | 렌더와 발송 사이의 합성 단계. 순수 |
| `lib/emailBusinessIdentity.ts` | footer가 찍을 사업자 정보를 환경변수에서 읽습니다 |
| `lib/emailUnsubscribeHeaders.ts` | `unsubscribeUrl()` 분리 — footer 링크와 헤더가 같은 URL |
| `lib/standardEmailLane.ts` | 고정된 policy version에서 profile을 읽어 합성. 거부 또는 저하 |
| `lib/adminEnvironmentChecks.ts` | 신원 변수 6개 노출 |
| `prisma/migrations/20260823060000_email_jurisdiction_labelling_skip_reasons/` | skipReason 2개 추가 |
| `docs/ops/email-business-identity.md` | 무엇을 설정하고, 설정하지 않으면 무엇이 일어나는지 |
| `tests/emailJurisdictionComposition.test.mjs` | 15건 (profile 8 × 언어 7 포함) |
| `tests/integration/email-jurisdiction-composition.db.test.ts` | 7건 |

**Root cause는 감사가 적은 그대로였습니다.** M7이 renderer를 만들고 M2가
template을 만들었는데 둘을 잇는 단계가 어느 쪽 범위에도 없었습니다.
`renderJurisdictionFooter()`는 자기 test에서만 불렸고 `subjectPrefix`는 seed와
policy reader만 읽었습니다.

**AC 충족**: KR/marketing subject는 `(광고)`로 시작하고 같은 template의 US 발송은
그렇지 않으며, transactional은 어느 관할권에서도 접두어가 없습니다. SG는
`<ADV> `이고 seed의 뒤따르는 공백이 보존됩니다.

**세 가지 결정**

1. **광고 표시는 marketing 전용입니다.** 정보통신망법 제50조와 Second Schedule은
   영리목적 광고성 정보에 붙습니다. 영수증에 `(광고)`를 붙이는 것은 과잉 준수가
   아니라 그 메일이 무엇인지에 대한 **거짓 진술**이고, 표시가 꼭 필요한 메일에서
   수신자가 표시를 무시하도록 훈련시킵니다.
2. **비대칭 실패**: marketing은 표시할 수 없으면 **보내지 않습니다**(도착한 뒤
   되돌릴 수 없음). transactional은 footer 없이 **보내되 매번 경고**합니다 —
   계정 삭제 예정 안내를 환경변수 하나 때문에 붙잡는 것이 더 나쁩니다.
3. **수신거부 block은 `requiresUnsubscribe`가 정합니다**, 분류가 아니라. 같은
   값이 `List-Unsubscribe` 헤더도 정하므로 footer 링크와 헤더가 어긋날 수
   없고, DB가 그 flag를 분류에 대한 CHECK로 들고 있습니다. ZZ profile은 의도적
   으로 완전한 marketing profile이므로(transactional도 그 신원 footer가 필요),
   수신거부 block만 걸러 냅니다.

**고정(pin)이 이 단계를 위해 존재합니다.** profile은 delivery에 고정된
`policyVersionId`에서 읽고 활성 버전에서 읽지 않습니다. 그렇지 않으면 한 표시
규칙 아래 큐에 들어간 메시지가 다른 규칙으로 나가고, delivery 행은 전자를
기록하는데 수신자는 후자를 받습니다. DB test가 이것을 직접 확인합니다 — 나중에
활성화된 후속 정책이 대기 중 메시지의 footer를 바꾸지 못합니다.

**아직 남은 것**

- **신원 값 6개가 설정되지 않았습니다.** 이 저장소가 답할 수 없는 사실이며
  (§Q8), 그래서 기본값을 넣지 않았습니다. 오늘 production의 transactional
  메일은 footer 없이 나가고 매번 `email_jurisdiction_footer_degraded`를 남깁니다.
  이전과 같은 결과이되 **조용하지 않다**는 점이 다릅니다.
- **관할권 정책이 활성화되지 않았습니다.** bootstrap 버전에는 profile이 없으므로
  활성화 전까지 `profile_missing`입니다. 활성화는 사람이 승인해 registry에
  기록하는 행위입니다(§12.5).
- **marketing 거부 경로는 end-to-end로 실행되지 않았습니다.** 등록된 marketing
  template이 하나도 없기 때문이며, 그것을 만드는 것은 제품 결정입니다. 순수
  test가 seed의 실제 profile 8개로 거부 두 갈래를 모두 덮고, DB test는 CHECK가
  그 두 skipReason을 받는지 확인합니다.

**검증**: unit(신규 15) · DB integration 이메일 6개 suite 63건(신규 7 포함) ·
`check:enum-constraints` 65 closed list · typecheck · eslint · doc/policy 참조 검사.

---

## 25. ML-08 구현 기록 (2026-08-23 · 완료)

| 파일 | 역할 |
|---|---|
| `lib/modelUsageFootprint.ts` | 모델이 저장된 세 곳의 계정 수와 **distinct 계정 수** |
| `lib/modelLifecycleWorkItems.ts` | `recordAutoDisableWorkItem()` |
| `lib/providerModelCatalogReconciliation.ts` | registry 비활성화와 queue 행을 **한 transaction**에서 |
| `tests/integration/model-lifecycle-auto-disable.db.test.ts` | 7건 |

**`discovered`로 만듭니다, `communication_pending`이 아니라.** 자동화는 만들 뿐
결정하지 않는다는 것이 §9.2의 규칙이고, 세 단계 앞에서 시작하는 것은 이 스캔이
"사용자에게 알려야 한다"를 결정하는 일입니다. 스캔이 말할 수 있는 것은 **몇 개
계정이 이 모델을 들고 있는가**이고, `communicationRequired`를 거기서 정합니다 —
아무도 안 들고 있으면 안내 없이 닫을 수 있고, 들고 있으면 상태 기계가 막습니다.

**계정 수는 JSON 배열 원소로 셉니다.** `gpt-5-4`가 `gpt-5-4-mini`를 잡으면 은퇴
대상이 아닌 후속 모델 사용자에게 안내가 갑니다. distinct는 SQL `UNION` 한 번으로
구하며, 세 곳에 다 들어 있는 한 사람이 세 번 세어지지 않습니다.

**두 write가 한 transaction입니다.** 사이에서 죽으면 모델은 꺼졌는데 왜 껐는지도
누가 영향받는지도 없는 상태가 남고, 그것이 ML-08이 말하는 상태입니다. 계정 수
읽기는 transaction **밖**입니다 — 이 transaction이 건드리지 않는 테이블 세 개를
읽는 동안 write transaction을 열어 두면 야간 스캔이 실사용과 경합합니다.

**이메일은 만들지 않습니다**(§10 금지 항목). 만들어지는 것은 사람이 답해야 하는
큐 행 하나입니다.

**범위 밖**: `replacementModelId`와 `userVisibleNote`는 설정하지 않습니다. 대체
모델 선택은 결정이고, 이 항목은 그 결정을 **요구**하는 것이지 대신하는 것이
아닙니다. `recommendation`이 그것을 문장으로 적습니다.

---

## 26. EM-03 구현 기록 (2026-08-23 · 완료)

| 파일 | 역할 |
|---|---|
| `lib/modelLaunchEmail.ts` | template A. 7개 언어 `Record<Language, Copy>` |
| `lib/emailTemplateDefinitions.ts` | `model_launch` 등록 (marketing · `product_updates` · unsubscribe 필수) |
| `tests/modelLaunchEmail.test.mjs` | 8건 (카피 규칙·언어·escaping·결정성) |
| `tests/integration/marketing-lane.db.test.ts` | 9건 |

**권고대로 test 전용 fixture를 만들지 않았습니다.** §7-A의 `model_launch`를 실제로
만들고 그것으로 증명했습니다. fixture로 증명하면 **아무도 보내지 않는 메시지에
대해** lane을 증명하는 것이고, 첫 실제 발송이 여전히 그 분기들의 첫 실행이 됩니다.

**증명된 분기 세 개** — 전부 marketing만 도달할 수 있어 그때까지 죽은 코드였습니다.
관할권 재검사(미확인 → `jurisdiction_unconfirmed`), one-click header(RFC 8058,
Resend는 요청 **본문**의 `headers`로 싣습니다), marketing stream(자기 도메인·자기 키,
transactional로 fallback하지 않음).

**감사 AC와 실제 동작이 갈리는 지점을 하나 찾았습니다.** AC는
"`MARKETING_EMAIL_FROM` 미설정 → `failed:identity_marketing_from_missing`"인데,
키(`MARKETING_RESEND_API_KEY`)까지 없으면 provider가 키에서 먼저 멈춰
`not_configured` **transient**가 되어 메시지가 큐에 남습니다. 오늘 production이
바로 그 상태입니다. 둘은 다른 결과이고 — 하나는 영구 실패, 하나는 재시도 —
합치면 메시지를 잃거나 거절을 영원히 재시도합니다. test를 둘로 나눴습니다.

**EM-04의 marketing 거절 분기도 여기서 처음 실행됩니다.** KR 구독자 제목이
`(광고)`로 시작하고 US는 아니며, 사업자 정보가 불완전하면
`jurisdiction_footer_incomplete`로 보류됩니다. EM-04 때는 등록된 marketing
template이 없어 순수 test로만 덮여 있던 경로입니다.

**카피 규칙을 test가 강제합니다.** 최상급 표현("최고"·"가장 빠른"·`best`·
`fastest` …)을 7개 언어에서 검사합니다. 이 저장소는 어느 모델이 최고인지 측정한
적이 없으므로 그것은 근거 없는 주장입니다. `tests/autoRoutingUi.test.mjs`가 auto
routing 문구에 대해 하는 검사와 같은 방식입니다.

**여전히 발송되지 않습니다.** `MARKETING_EMAIL_FROM`이 없고, 이 template을
enqueue하는 코드가 없으며, marketing은 production에서 비활성입니다. **template
등록은 발송이 아닙니다.** EM-16(발송 계정·region 분리, 도메인, warm-up)은 그대로
남아 있습니다.

---

## 27. EM-12 구현 기록 (2026-08-23 · 완료)

| 파일 | 역할 |
|---|---|
| `lib/accountEmails.ts` | 두 통지의 7개 언어 `Record<EmailLanguage, Copy>` |
| `lib/emailTemplateDefinitions.ts` | render에 language 전달 |
| `lib/accountDeletion.ts` | 예약 결과가 계정의 language를 함께 반환 |
| `app/api/user/account/route.ts` · `app/api/admin/users/[userId]/security/route.ts` | enqueue에 language 전달 |
| `tests/accountLifecycleEmails.test.mjs` | 7건 |
| `tests/integration/account-deletion.db.test.ts` | 2건 추가 |

**절반만 고치면 죽은 코드가 됩니다.** template에 7개 언어를 넣어도 **호출자가
language를 넘기지 않으면** lane이 `resolveLanguage(undefined)` → `"en"`으로
떨어져 번역이 도달하지 못합니다. 그래서 두 호출 경로가 계정의
`UserSettings.language`를 싣도록 함께 고쳤습니다.

**`Record<EmailLanguage, Copy>`를 쓴 이유**는 언어를 추가할 때 모든 메시지를 쓰기
전까지 컴파일이 실패하기 때문입니다. 번역 집합을 완전하게 유지한 유일한 기제가
그것입니다.

**계정 설정 행이 없으면 `null`을 반환합니다, `"en"`이 아니라.** language 부재의
해석은 lane 한 곳이 하는 결정이고, 호출자마다 기본값을 정하면 그 결정이 흩어집니다.

**test가 강제하는 것**: 7개 언어 전부 렌더되고 제목이 서로 다를 것(조용한
fallback이면 집합이 무너짐), 날짜와 support 주소가 모든 언어에 남을 것(취소가
self-service가 아니므로 이 둘이 유일한 행동 경로), 문단 4개가 전부 존재할 것,
어느 언어도 사과하거나 재촉하지 않을 것(§14.3).

**범위**: `auth_login_code`·`account_welcome`·`billing_welcome`은 이미 다국어
이고, `ops_model_lifecycle_daily`는 운영자 메일이라 영어 하나가 의도된 상태입니다.

---

## 28. ML-12 구현 기록 (2026-08-23 · 완료)

| 파일 | 역할 |
|---|---|
| `lib/providerModelCatalogMonitor.ts` | 후보 판정을 provider slice가 아니라 **카탈로그 전체**의 정규화 키로 |
| `lib/modelLifecycleWorkItemCore.ts` | `observedVia` 그룹핑, `mergeObservedVia()`, `observationsForExistingItems()` |
| `lib/modelLifecycleWorkItems.ts` | 신규 item에 `observedVia` 기록, 기존 item에 새 provider 관측 추가 |
| `tests/model-lifecycle-work-item-core.test.ts` | 5건 추가 (총 26) |
| `tests/integration/model-lifecycle-auto-disable.db.test.ts` | 3건 추가 (총 10) |

**Root cause를 근원에서 고쳤습니다.** 후보 판정이 `where: { provider }`로 좁힌
registry를 봤기 때문에, 다른 provider가 서빙하기 시작하면 이미 있는 모델이 새
후보가 됐습니다. `kimi-k3`가 출시 3주 뒤까지 세 번 NEW로 보고된 이유입니다.
이제 `candidateIdentity()`로 카탈로그 전체를 조회합니다.

**두 질문을 분리했습니다.** "이 provider가 우리가 가진 모델을 서빙하는가"는
provider 범위 질문이고 missing 탐지·reconciliation이 그것으로 동작하므로 그대로
뒀습니다. "이 모델이 우리에게 새로운가"는 provider 범위가 아닙니다.

**관측 행은 손대지 않았습니다** — 감사 권고대로. `ProviderModelCatalogEntry`의
provider별 행은 사실이고, 묶는 것은 결정 계층의 일입니다.

**묶되 버리지 않습니다.** `glm-5.3`을 하나로 collapse하는 것은 맞지만 collapse된
둘을 버리는 것은 틀립니다 — 어느 provider가 서빙하는지가 추가 여부를 결정하는
사람이 필요로 하는 바로 그 정보입니다. `observedVia`에 provider와 **원본
apiModel 문자열**을 함께 남깁니다(`ZHIPU/GLM-5.3`은 Qwen이 실제로 반환한 것이고,
확인하려는 사람은 정규화 키가 아니라 그 문자열이 필요합니다).

**날짜를 건너뛴 관측도 붙습니다.** 월요일에 만든 item이 목요일에 provider 하나를
얻습니다. 병합은 멱등이라 같은 provider만 다시 보이는 scan은 행을 건드리지
않습니다(DB test가 `updatedAt` 불변으로 고정).

---

## 29. EM-08 구현 기록 (2026-08-23 · 완료)

| 파일 | 역할 |
|---|---|
| `lib/emailSnapshotRetentionCore.ts` | 분류별 보관 기간과 cutoff. 순수 |
| `lib/emailSnapshotRetention.ts` | `purgeExpiredRenderSnapshots()` |
| `lib/retentionPolicyCore.ts` | `emailDeliverySnapshots` 정책 (`clear`) |
| `lib/maintenance.ts` | `email_render_snapshots` step |
| `app/api/admin/retention/route.ts` | 관리자 화면의 계측 |
| `scripts/report-unswept-tables-core.mjs` | 이메일 테이블 4개 등록 |
| `tests/emailSnapshotRetention.test.mjs` | 7건 |
| `tests/integration/email-snapshot-retention.db.test.ts` | 5건 |

**AC 충족**: `report:unswept-tables`의 미결 목록에서 이메일 테이블이 사라졌습니다
(6건 → 2건, 남은 둘은 `MessageArtifactCleanup`·`MessageAttachmentCleanup`으로
이메일과 무관).

**`delete`가 아니라 `clear`입니다.** 행은 남고 `renderDataSnapshot`만 비우며
`snapshotPurgedAt`을 찍습니다. 발송 사실과 `renderedHash`가 남는 것이 §10.3
규칙 4가 요구하는 것입니다 — 삭제 요청은 snapshot을 지우되 통지했다는 증명은
남깁니다. 재현 가능 창에서 검증 전용 창으로 옮기는 것이지 기록을 없애는 것이
아닙니다.

**분류가 기간을 정합니다.** transactional·service·marketing 90일, **legal 7년**
(잠정, §21 Q6). legal이 긴 이유는 그 메일이 통지 그 자체이기 때문입니다 — 계정
삭제 통지가 무엇을 말했는지 나중에 물을 수 있어야 합니다. DB test에서 같은 날짜의
welcome과 deletion 두 건이 같은 sweep에서 갈라지는 것으로 고정했습니다.

**모르는 분류는 가장 짧은 창을 받습니다.** 실수로 개인정보를 7년 들고 있는 쪽이
더 나쁜 실패입니다. DB CHECK가 분류 집합을 닫고 있으므로 이것은 바닥이지
실제 경로가 아닙니다.

**나이는 발송 시각 기준, 없으면 생성 시각입니다.** 발송되지 않은 delivery도 같은
개인정보를 들고 있고, 실패했다는 이유로 영원히 두는 것은 방향이 반대입니다.

**등록한 4개 테이블**: `EmailTemplate`은 bounded(키가 코드에 있음),
`EmailEvent`·`ConsentRecord`·`EmailPolicyVersion`은 retained입니다. 셋 다
지우면 답할 수 없게 되는 질문이 있습니다 — 왜 이 메일이 발송됐는가, 무엇에
동의했는가, 어떤 표시 규칙 아래 렌더됐는가.

**범위 밖**: `EmailDelivery` 행 자체의 보관 기간(§13.2의 분류별 삭제)은 이
항목이 아닙니다. snapshot을 비우는 것과 행을 지우는 것은 다른 결정이고,
후자는 legal 7년 확정(Q6) 이후의 일입니다.

**cutoff은 TypeScript가 계산하고 SQL에는 timestamp로 바인딩합니다.** 처음에는
`make_interval(days => $1)`로 SQL 안에서 만들었고, 그 인자는 text로 바인딩됩니다.
purge의 평범한 형태에서는 planner가 타입을 추론해 통과했지만, admin 조회의
`CASE` 안에서는 추론할 근거가 없어
`function make_interval(days => text) does not exist`로 던졌습니다. **증상은
그 오류가 아니라 retention 화면 전체가 비는 것**이었습니다 — 한 Promise.all이
전부 실패했기 때문입니다(admin E2E `admin-read-surfaces.spec.ts`가 잡았습니다).
이제 sweep과 admin 조회가 `snapshotPurgeCutoffs()` 하나에서 같은 `Date`를 받아
씁니다.

**`Prisma.JsonNull`이 아니라 `Prisma.DbNull`입니다.** `renderDataSnapshot`은
`Json?`이고, 비운 상태는 컬럼 NULL이지 JSON `null` 값이 아닙니다.

---

## 30. EM-07 구현 기록 (2026-08-23 · 완료)

| 파일 | 역할 |
|---|---|
| `lib/billingEmails.ts` | `passEmail`·`sendAdminPlanChangedEmail`을 순수 builder로 |
| `lib/emailTemplateDefinitions.ts` | template 4개 등록 (전부 `transactional`) |
| `app/api/billing/checkout/route.ts` | pass 시작 안내 enqueue |
| `lib/maintenance.ts` | reminder·ended 두 sweep을 **claim과 한 transaction**으로 |
| `app/api/admin/users/[userId]/plan-adjust/route.ts` | 플랜 변경 안내 enqueue |
| `tests/billingLifecycleEmails.test.mjs` | 8건 |
| `tests/integration/founding-tester-pass-emails.db.test.ts` | 7건 |

**AC를 상태가 아니라 검사로 만들었습니다.** "직접 발송 경로가 0이 된다"는 한 번
관측하고 끝나면 다음 사람이 다시 늘립니다. `tests/billingLifecycleEmails.test.mjs`
마지막 test가 `git ls-files`로 `sendTransactionalEmail` 호출자를 세고 allowlist
3개와 대조합니다. **양방향입니다** — 새 직접 호출도 실패시키고, allowlist에
있는데 더 이상 직접 호출하지 않는 항목도 실패시킵니다(지키는 것이 없는 예외가
남지 않도록).

**allowlist 3개는 ADR이 이름 댄 것입니다.** admin test-email(운영자 자기
발송), `lib/emailLoginEmails.ts`(credential synchronous lane — 10분짜리 코드를
15분 주기 큐에 넣지 않습니다, §9.4a), `lib/notificationDeliveries.ts`(그 자체가
재시도 큐).

**죽은 직접 발송 경로 3개를 지웠습니다.** `sendRefundRequestReceived/Approved/
RejectedEmail`은 호출자가 없었고(환불 메일은 `buildRefundRequestEmail`을 통해
notification 큐가 보냅니다), 남겨 두면 AC가 세는 대상이 다시 늘어납니다.

**큐 전환이 maintenance 두 경로의 실제 결함을 고쳤습니다.** 전환 전 reminder는
`reminderSentAt`을 먼저 찍고 보낸 뒤 실패하면 되돌렸고, ended는 보내고 나서
찍었습니다. 앞쪽은 되돌리기 직전에 죽으면 **보내지 않은 안내를 보냈다고
기록**하고, 뒤쪽은 찍기 직전에 죽으면 **다음 sweep이 다시 보냅니다**. 이제 claim과
outbox 행이 한 transaction에서 commit됩니다 — 이것이 큐가 여기서 사는 이유이고,
DB test가 그 쌍을 고정합니다(단일 process test로는 관측되지 않습니다).

**transaction timeout을 넓혔습니다**(`maxWait: 5s`, `timeout: 15s`).
`enqueueStandardEmail`은 template version과 관할권을 자기 connection에서 먼저
해석하고, 새로 등록한 template의 첫 발송은 행을 insert합니다.

**template 3개이지 phase field 하나가 아닙니다.** `TemplateVersion`은 한 메시지
카피의 해시입니다. 셋을 phase 변수 뒤로 접으면 해시가 하나가 되고, 감사 재현이
어느 안내였는지 말하지 못하게 됩니다.

**`periodEnd`는 `Date`가 아니라 ISO 문자열입니다.** snapshot이 JSON이라 `Date`가
왕복을 견디지 못하고, renderer 안의 시계 읽기는 재시도가 다른 바이트를 만들어
멱등성 키를 깨뜨립니다(§9.3).

**`admin_plan_changed`에는 language를 넘기지 않습니다.** 이 카피는 영어
하나뿐이므로, 계정 language를 실으면 **렌더되지 않는 언어를 delivery 행에 찍고**
그 거짓을 감사 기록에 남깁니다. 번역은 별개 결정이며 EM-07의 범위가 아닙니다 —
남은 다국어 공백으로 여기 적어 둡니다.

**범위 밖**: `lib/notificationDeliveries.ts`의 자체 재시도 큐를 standard lane으로
합치는 것. 두 큐가 공존하는 것은 별개 결정이고 이 항목의 AC가 묻는 것이
아닙니다.

---

## 31. ML-13 구현 기록 (2026-08-23 · 완료)

| 파일 | 역할 |
|---|---|
| `lib/modelOwner.ts` | 식별자 → 제작사. 순수, 새 파일 |
| `lib/modelLifecycleWorkItems.ts` | report row가 `observedVia`를 함께 반환 |
| `lib/modelLifecycleDailyReportCore.ts` | `publisher` · `observedVia` 필드 |
| `lib/providerModelCatalogReport.ts` | 후보 줄을 모델 단위로 묶고 제작사·관측 경로를 분리 |
| `lib/modelLifecycleDailyEmail.ts` | `provenance()` — HTML·plain text 양쪽 |
| `tests/modelOwner.test.mjs` | 12건 |
| `tests/modelLifecycleDailyReport.test.mjs` | 4건 추가 (총 21) |
| `tests/integration/model-lifecycle-auto-disable.db.test.ts` | 2건 추가 (총 12) |

**감사가 실측한 세 줄을 test가 고정합니다** — `Qwen ZHIPU/GLM-5.3`,
`Qwen kimi-k3`, `Perplexity perplexity/deepseek-v4-pro-0813`. 지금은 각각 Zhipu ·
Moonshot · DeepSeek입니다.

**이름의 family token이 경로 prefix를 이깁니다.** aggregator의 경로는 namespace이지
저작 주장이 아닙니다 — `perplexity/deepseek-v4-pro`는 Perplexity 경로 위의 DeepSeek
모델이고, prefix를 소유권으로 읽으면 업계 모델 절반이 Perplexity 것이 됩니다.
prefix는 **이름이 아무것도 말하지 않을 때만** 봅니다. 그리고 `groq/`·`perplexity/`·
`openrouter/`는 prefix 표에 **없습니다**(남의 모델을 서빙하는 host).

**`unknown`은 진짜 답입니다.** 이름이 아무 token에도 안 맞으면 스캔한 provider로
떨어지지 않고 `unknown owner`로 남습니다. 라벨의 존재 이유가 triage 첫 줄을 믿을
수 있게 하는 것인데, 사실처럼 꾸민 추측은 아무도 나중에 고치지 않습니다.

**필드 이름은 `owner`가 아니라 `publisher`입니다.** 같은 타입에 이미
`ownerEmail`(담당자)이 있고, 한 행에 owner가 둘이면 renderer가 틀린 쪽을 고릅니다.

**Slack 후보 줄은 모델 단위로 묶습니다.** `candidateIdentity`로 같은 모델을
한 줄에 모으고, 카탈로그가 다르게 부른 경우에만 그 문자열을 함께 적습니다
(`Qwen as \`ZHIPU/GLM-5.3\``) — 확인하려는 사람은 정규화 키가 아니라 실제 반환된
문자열이 필요합니다.

**한 곳에서만 본 항목은 관측 경로를 적지 않습니다.** 자기가 접수된 provider 하나만
보인 것이 보통이고, 매 줄에 반복하면 정작 의미 있는 줄이 묻힙니다.

**ML-12 이전 행은 접수 scan으로 대체합니다.** `evidence.observedVia`가 없으면 빈
목록이 아니라 `[{provider, apiModel}]`을 돌려줍니다 — 빈 목록은 "아무도 본 적 없는
모델"이라는 다른, 더 틀린 주장입니다.

**범위 밖**: `missing`·`lifecycleWarnings` 줄의 provider 라벨. 그 둘은 **우리
registry에 있는 모델**에 대한 것이고 거기서 provider는 우리가 실제로 요청을 보내는
경로이므로 의미가 맞습니다.

---

## 32. EM-10 구현 기록 (2026-08-23 · 완료)

| 파일 | 역할 |
|---|---|
| `lib/emailUnsubscribeReadiness.ts` | 조건부 readiness 판정. 순수, 새 파일 |
| `app/api/ready/route.ts` | `emailUnsubscribeKeyring` hard dependency 추가 |
| `lib/emailUnsubscribeHeaders.ts` | throw → 이름 붙은 refusal |
| `lib/standardEmailLane.ts` | refusal을 `EMAIL_UNSUBSCRIBE_KEY_MISSING`으로 보고 |
| `lib/adminEnvironmentChecks.ts` | 설명에 `/api/ready` 결합 명시 |
| `tests/emailUnsubscribeReadiness.test.mjs` | 7건 |
| `tests/integration/marketing-lane.db.test.ts` | 1건 추가 (총 10) |
| `tests/integration/email-preferences-consent.db.test.ts` | 호출 형태 갱신 |

**조건은 `MARKETING_EMAIL_FROM`입니다.** 감사 §15.2가 이름 댄
`feature.emailMarketingEnabled`는 **코드에 없으므로** 그것을 조건으로 쓸 수
없습니다. 대신 marketing이 실제로 나갈 수 있으려면 반드시 참이어야 하는 구조적
사실 하나 — 자기 발송 identity — 를 씁니다. 그 주소를 설정하고 키를 설정하지 않은
상태가 정확히 EM-10이 말한 "ready라고 답하면서 모든 marketing이 거부되는" 상태입니다.

**"marketing template이 있는가"를 조건으로 쓰지 않았습니다.** template은 코드가
등록하므로 모든 환경에 존재합니다 — `model_launch`가 생긴 날(EM-03) 그 조건은
모든 환경에서 참이 됐고, 그것을 기준으로 삼았다면 오늘 배포가 not-ready가 됩니다.

**키가 있는데 깨진 것은 marketing 여부와 무관하게 error입니다.** 설정한 사람은
동작하기를 의도한 것이고, "아직 필요 없음"으로 보고하면 오타가 marketing을 켜는
날까지 숨습니다 — 찾기에 가장 나쁜 날입니다.

**pin 안 된 rotation은 warning입니다.** 발송은 되고 기존 token도 전부 검증됩니다.
잘못된 것은 **어느 키가 새 token에 서명하는지를 목록 순서가 정한다**는 것이고,
이는 snapshot keyring이 이미 경고하는 것과 같은 drift입니다.

**부수 문제를 함께 고쳤습니다 — 이쪽이 운영자 시간을 더 아낍니다.**
`unsubscribeUrl()`이 throw했고 drain 바깥 `try/catch`가 그것을 받아
`EMAIL_RENDER_FAILED`로 보고했습니다. **"수신 거부 키가 없다"가 "렌더에
실패했다"로 보고되면** 운영자는 환경변수 하나를 찾는 대신 template을 읽습니다.
이제 `{ok:false, refusal:"unsubscribe_keys_missing"}`를 돌려주고 drain이
`EMAIL_UNSUBSCRIBE_KEY_MISSING` incident와 함께 permanent로 기록합니다 —
identity refusal과 같은 취급이며, 이유도 같습니다: 기다린다고 환경변수가
설정되지 않습니다.

**`{ok:true, url:null}`과 `{ok:false}`는 다른 답입니다.** 앞은 unsubscribe가
없는 것이 옳은 transactional 메시지이고, 뒤는 보내면 안 되는 marketing
메시지입니다. 호출자가 둘을 섞으면 광고가 링크 없이 나갑니다.

**오늘 production 동작은 바뀌지 않습니다.** `MARKETING_EMAIL_FROM`이 미설정이므로
`/api/ready`는 계속 ready이고, 키 부재는 warning으로만 보고됩니다. 기능보다 먼저
설치한 guard입니다.

**범위 밖**: EM-16(발송 계정·region 분리, 도메인, warm-up). marketing을 실제로
켜는 것은 이 항목이 아니며, 이 변경은 **켤 때 조용히 실패하지 않게** 합니다.

---

## 33. ML-10 구현 기록 (2026-08-23 · 완료)

| 파일 | 역할 |
|---|---|
| `lib/reconciliationApprovalCore.ts` | `target_mismatch` 제거, `same_target` 추가, `findReconciliationTargetProblems()` 신설 |
| `scripts/run-default-model-reconciliation.mjs` | 파일 상수 제거, registry precondition |
| `docs/policy/default-model-luna-migration.md` | §7 서술을 실제 동작에 맞춤 |
| `tests/reconciliationApprovalCore.test.ts` | 11건 추가 (총 19) |
| `tests/integration/default-model-reconciliation.db.test.ts` | 7건, 새 파일 |

**상수 두 개를 지우는 것이 절반이고, 그것이 지키던 것을 대체하는 것이
나머지입니다.** `FROM_MODEL_ID`/`TO_MODEL_ID`가 파일에 박혀 있었고
`--from`/`--to`는 그것과 일치하는지만 검사했습니다. 그래서 다음 은퇴는
**스크립트를 복사해 고치는 일**이 되고, 그 복사본이 승인 gate를 함께
가져온다는 보장이 없습니다. 이제 두 값은 진짜 파라미터입니다.

**그런데 그 상수가 우연히 지키던 것이 있었습니다** — "이 스크립트는 gpt-5-4-mini
은퇴에만 쓴다". 그것을 지우면 타이밍 규칙(정책 §7 "은퇴 배포와 함께")을
아무것도 강제하지 않게 됩니다. 그래서 **prose를 검사로 바꿨습니다**:
`--apply`는 쓰기 전에 `ModelRegistryEntry`를 읽고 `--from`이 아직
`enabled`이거나 `publiclyListed`이면 거부합니다. 이것이 AC이고, 상수보다
**강한** 보장입니다 — 상수는 그 한 번의 migration에 대해서만 참이었습니다.

**행이 없으면 거부합니다**(`from_unknown`). 없는 행은 은퇴의 증거가 아니고,
이 검사의 존재 이유가 증명이므로 fail-closed입니다.

**파라미터를 풀면 새 footgun이 생깁니다.** 상수가 막고 있던 것들이라 함께
막았습니다 — `--to`가 비활성·삭제면 거부(옮겨진 계정이 답 못 받는 모델에
착지), `--from === --to`면 거부(바뀌는 것 없이 행마다 migration record가 남아
"옮겼다"고 말함). `--to`가 공개 목록에 없으면 **경고만** 합니다: 모델은
동작하고 의도된 선택일 수 있으며, 잃는 것은 picker에서 찾는 능력입니다.

**정확히 무엇이 참인지 메시지가 말합니다.** `enabled and publicly listed`처럼
남은 조건을 나열하므로, 반쯤 은퇴시킨 상태에서 어느 쪽을 더 해야 하는지
운영자가 압니다.

**DB test는 규칙이 아니라 규칙에 도달하는지를 봅니다.** 순수 함수 test 19건이
판정을 고정하고, 통합 test 7건은 **실제 명령을 실행해** `--apply`가 스캔 전에
registry를 읽고 거부하며 **어떤 행도 건드리지 않는지** 확인합니다. 아무도 부르지
않는 규칙은 성립하지 않는 규칙입니다.

**dry run은 여전히 아무 승인도 필요 없습니다.** precondition도 dry run에는
적용되지 않습니다 — 무엇이 바뀔지 보는 것은 안전한 절반이고, 살아 있는 모델에
대해서도 범위를 볼 수 있어야 은퇴를 결정할 수 있습니다. 다만 `--from`/`--to`는
dry run에도 필요합니다(없으면 보고할 대상이 없습니다).

**범위 밖**: reconciliation을 자동으로 실행하는 것. CI·lifecycle 거부는 그대로이고,
`tests/reconciliationApprovalCore.test.ts`가 저장소 안 어떤 경로도 이 명령을
스스로 부르지 않는지 계속 확인합니다.

---

## 34. EM-09 구현 기록 (2026-08-23 · 완료)

| 파일 | 역할 |
|---|---|
| `lib/marketingSendHealthCore.ts` | 임계·최소 사건 수·판정. 순수, 새 파일 |
| `lib/marketingSendHealth.ts` | window 집계, sticky halt 기록, incident |
| `lib/standardEmailLane.ts` | marketing 분기에서 halt 확인 → `marketing_halted` |
| `lib/emailWebhookProcessing.ts` | marketing 이벤트마다 재평가 |
| `prisma/migrations/20260823230000_email_marketing_halt_skip_reason` | skipReason 값 추가 |
| `tests/marketingSendHealth.test.mjs` | 15건 |
| `tests/integration/marketing-lane.db.test.ts` | 4건 추가 (총 13) |

**감사의 권고는 "campaign wave 단위"였지만 campaign이 없습니다**(EM-01 미구현).
그런데 §14.5의 표는 **wave가 아니라 stream 단위**입니다 — bounce > 5%,
complaint > 0.3%면 "marketing 발송 자동 중단". 그래서 stream 층에 구현했습니다.
campaign이 생기면 wave 단위가 그 위에 얹히고, 이것은 바닥으로 남습니다.

**rate만으로는 멈출 수 없습니다.** 100건 중 complaint 1건은 1%로 임계의 세
배지만, 버튼을 누른 사람 하나입니다. 작은 분모 위의 비율은 비율이 아닙니다.
그래서 halt에는 비율 **그리고** 패턴이라 부를 만한 사건 수가 필요합니다 —
complaint 3건, bounce 10건.

**분모 하한은 의도적으로 없습니다.** 0.3%가 산술적으로 도달 가능하려면 약
1,000명이 필요한데, 그것을 요구하면 **작은 campaign에서는 스위치가 영원히
작동하지 않습니다** — 그리고 이 시스템이 처음 보낼 것이 전부 작은 campaign입니다.
200건에 complaint 3건이면 이미 문제를 찾은 것입니다.

**warning에는 최소 사건 수가 없습니다.** warning은 로그 한 줄이고, 피해보다
먼저 도착하는 유일한 신호입니다. 그것을 막으면 조기 경보를 늦추는 것뿐입니다.

**halt는 sticky이고 사람이 해제합니다.** window는 굴러갑니다. 나쁜 발송이
window 밖으로 나가면서 halt가 저절로 풀린다면, **보호하려던 바로 그 평판으로
재개**합니다. incident에 무엇을 지워야 하는지(`AppSetting["email.marketingHalt"]`)
적어 두었습니다 — 사람의 결정이지만 방법을 모르게 두지는 않습니다.

**읽을 수 없는 halt 값은 halt로 셉니다.** "중단됐는지 알 수 없다"의 대안은
발송이고, 발송이 되돌릴 수 없는 쪽입니다.

**transactional은 절대 건드리지 않습니다.** 이것이 가장 중요한 경계입니다 —
provider suppression이 이미 계정 전체 범위이므로(§5.3.1), transactional을 멈출
수 있는 kill switch는 **로그인 코드가 안 오는 상태로 가는 두 번째 경로**가 됩니다.
DB test가 halt된 상태에서 welcome 메일이 정상 발송됨을 고정합니다.

**분모에 bounce·complaint를 포함합니다.** bounce된 메시지도 발송된 것이고,
분모에서 빼면 측정 대상 자체만큼 모든 비율이 부풀려집니다.

**평가 지점은 둘입니다** — 발송 직전(모든 marketing 전송)과 marketing webhook
이벤트(임계를 넘긴 그 사건에서 즉시 트립, 다음 drain을 기다리지 않음). 멱등이고
어느 쪽도 halt를 해제하지 않습니다.

**범위 밖**: campaign wave 단위 집계(EM-01 대기), 그리고 halt 해제 UI. 오늘은
`AppSetting` 행 삭제이고, admin 화면은 campaign 화면과 함께 오는 것이 맞습니다.
## 35. EM-11 구현 기록 (2026-08-23 · 완료)

| 파일 | 역할 |
|---|---|
| `lib/scheduledJobsCore.ts` | `standard_email_drain` job key 등록 |
| `lib/notificationDeliveryJob.ts` | drain을 `startScheduledJob`/`complete`/`fail`로 감쌈 |
| `lib/standardEmailLane.ts` | `oldestPendingMs` + backlog incident |
| `tests/integration/standard-email-lane.db.test.ts` | 6건 추가 (총 21) |

**운영자 큐가 성공했다는 것이 사용자 메일이 나갔다는 뜻은 아니었습니다.**
standard drain은 `try/catch`로 감싸여 `console.error` 한 줄만 남겼고,
`ScheduledJobRun` 기록이 없어 **`/admin/jobs`에는 두 큐가 하나의 초록 행**으로
보였습니다. 이제 자기 job key를 갖습니다 — 같은 cron(같은 tick에 돌므로)이지만
자기 run입니다. 실패도 그 run에 기록한 뒤 삼킵니다(두 큐는 독립적으로 실패하고
그렇게 보고돼야 합니다).

**backlog 신호를 두 모양으로 잡습니다.** 깊이만으로는 더 나쁜 쪽을 놓칩니다 —
1분 전에 쌓인 200건은 바쁜 아침이고, **6시간째 기다리는 5건은 영수증을 못 받은
사람 다섯**인데 그동안 큐는 계속 얕습니다. 그래서 `pending >= 200` **또는**
가장 오래 기다린 메시지가 1시간을 넘으면 incident를 올립니다. incident의
`trigger`가 어느 쪽인지 말하므로 숫자를 역산할 필요가 없습니다.

**abandonment incident와 의도적으로 분리했습니다.** 그것은 메시지가 이미
사라진 뒤에 울리고, 감사가 지적한 것이 바로 "그건 이미 늦은 신호"입니다.
이쪽은 아직 손쓸 수 있을 때 울립니다.

**임계 200의 근거**: 한 pass가 50건을 집고 15분 cron을 탑니다. 200건이면
약 한 시간치 밀림이고, "바쁨"과 "못 따라감"이 갈라지는 지점입니다.

**빈 큐는 `null`이지 `0`이 아닙니다.** 대시보드에 "0분"으로 뜨면 완벽하게 도는
큐처럼 보입니다.

**측정 시각을 loop 밖에서 잡습니다.** loop 안의 `now`는 claim 하나에 묶여
있고 **loop가 한 번도 안 돌면 존재하지 않습니다** — 그것이 정체된 큐가 드러나는
바로 그 경우입니다.
## 36. EM-01 구현 기록 — 1차: event 단위 fan-out (2026-08-24 · 완료)

| 파일 | 역할 |
|---|---|
| `lib/emailAudienceExpansionCore.ts` | 착수 가능 여부·batch 계획·spec 파싱. 순수, 새 파일 |
| `lib/emailAudienceExpansion.ts` | `expandEmailEvent()` |
| `tests/emailAudienceExpansionCore.test.mjs` | 13건 |
| `tests/integration/email-audience-expansion.db.test.ts` | 12건, 새 파일 |

**범위를 event 층으로 잘랐습니다.** EM-01의 기대 동작("하나의 이벤트에서 다수
`EmailDelivery`를 재개 가능하게 생성"), AC, 파일 목록(`EmailEvent`,
`standardEmailLane`)이 **전부 event 단위**입니다. §12.2의 `EmailCampaign` ·
`Wave` · `Recipient`는 그 위의 **campaign workflow** 층이고, EM-06이 기다리는
것이 그쪽입니다. 2차에서 만듭니다.

**새 죽은 컬럼을 만들지 않았습니다.** EM-01의 evidence 자체가
"`audienceSpec`·`expansionCursor`·`status`의 세 값을 **아무 코드도 쓰지
않는다**"입니다. 승인 flow가 없는 상태에서 `approvalId`·`scheduledAt`을 미리
만들면 같은 결함을 한 번 더 저지르는 것입니다. 이번 변경은 **이미 있는 죽은
필드를 살립니다** — 새 테이블도 새 컬럼도 없습니다.

**AC는 unique index가 강제합니다.** `@@unique([eventId, recipientKey])`가
중복을 막고, 그래서 재개한 pass는 **앞 pass가 무엇을 했는지 알 필요 없이**
겹쳐 읽어도 됩니다. `createMany({ skipDuplicates: true })`의 결과로
`expanded`와 `alreadyPresent`를 구분해 보고합니다 — "아무것도 안 썼다"와
"아무도 없었다"는 다른 사실이고 하나만 문제입니다.

**모든 수신자에게 행을 씁니다, 보내지 않을 사람 것도.** lane의 gate(동의·
suppression·관할권)가 이미 행을 `skipped`로 만들고 **이유를 그 행에 적습니다**.
여기서 걸러내면 발송은 싸지지만 "누구에게 도달했고 나머지는 왜 아닌가"가
그 질문에 답해야 할 테이블에서 사라집니다. 예외는 주소 없는 계정뿐입니다 —
쓸 행이 없습니다. 세지만 지어내지 않습니다.

**dry run은 같은 행을 쓰고 표시만 합니다.** 행을 안 만드는 dry run은 dry run에게
묻는 질문에 답하지 못합니다. `dry_run`은 처음부터 skipReason CHECK에 있었고
아무도 쓴 적이 없습니다.

**time budget 검사를 batch **뒤**로 옮겼습니다.** 앞에서 검사하면 한 batch보다
작은 예산 — 느린 DB, 큰 batch size, 이미 늦은 tick — 이 **fan-out을 영원히 0행씩
전진**시키면서 매번 성공을 보고합니다. test가 그것을 드러냈고, 고친 것은 test가
아니라 동작입니다.

**cap은 page size가 아닙니다.** "audience query가 틀렸으면 어떻게 되는가"에
대한 답이고, 틀렸을 때의 대가는 **이미 도착했다**는 것입니다. 재개한 pass는
테이블에서 센 값으로 cap을 이어 쓰므로 세 번 재개해도 cap이 세 배가 되지
않습니다.

**`failed`는 사람을 기다립니다.** 얼마나 진행됐는지 모르는 채 멈췄고, 실패
원인은 대개 저절로 낫는 종류가 아닙니다. incident에 cursor를 싣습니다 —
고치려는 사람이 필요한 값이 그것입니다.

**2차 범위**: `EmailCampaign`/`Wave`/`Recipient`, 승인(§12.3), 예약, reminder
wave의 cohort 재계산, admin 화면. EM-06은 그 위에 얹힙니다.

---

## 37. EM-01 2차 + EM-06 구현 기록 — campaign workflow (2026-08-24 · 완료)

| 파일 | 역할 |
|---|---|
| `prisma/schema.prisma` · `migrations/20260824000000_email_campaign` | `EmailCampaign` · `EmailCampaignWave` |
| `lib/emailCampaignCore.ts` | 발송 가능 여부 판정 + **EM-06 content 대조**. 순수 |
| `lib/emailCampaignService.ts` | draft · approve · run wave · cancel |
| `scripts/check-enum-constraints.mjs` | 새 CHECK 5건 등록 |
| `tests/emailCampaignCore.test.mjs` | 12건 |
| `tests/integration/email-campaign.db.test.ts` | 12건, 새 파일 |

**승인은 campaign의 성질이지 outbox의 성질이 아닙니다.** §12.1이 B안을 고른
결정적 이유가 이것이고, 그래서 `draft`/`pending_approval`을 `EmailEvent.status`에
넣지 않았습니다 — 그 CHECK는 **로그인 코드가 들어 있는 테이블**의 어휘이고 두
lane이 모두 의존합니다.

**EM-06은 여기서 자연히 나옵니다.** 승인이 언어별로 `TemplateVersion.id`와
**그 시점의 `contentHash`**를 함께 pin하고, 발송 직전에 template이 **지금**
렌더하는 해시와 대조합니다. 다르면 거부입니다 — 재승인이 아니라 거부인 이유는,
승인의 의미가 **사람이 그 문장을 봤다**는 것이기 때문입니다.

**세 가지 거부를 구분합니다.** `content_changed`(승인된 문장이 바뀜),
`locale_not_pinned`(승인 후 언어 추가 — 고치는 방법이 다릅니다: 새 언어를 덮는
승인이 필요하지 옛 승인을 다시 읽는 게 아닙니다), 그리고 상태별
`not_approved`/`cancelled`/`halted`/`already_completed`. 하나의 "보낼 수 없음"으로
뭉치면 운영자가 무엇을 해야 하는지 알 수 없습니다.

**언어가 사라진 것도 바뀐 것으로 셉니다.** 승인된 문장이 다른 것이 아니라
**없어진** 것이고, 그쪽이 더 중요한 방향입니다.

**읽을 수 없는 pin은 pin이 아닙니다.** `locale_not_pinned`으로 드러납니다 —
이 코드가 절대 만들면 안 되는 결과가 **pin 없는 언어를 조용히 발송**하는 것입니다.

**DB CHECK가 반쪽 승인을 막습니다.** `EmailCampaign_approval_completeness_check`:
approved 이상이면 approvalId·approvedAt·templateVersionIds가 **전부** 있어야
합니다. 승인 id는 있고 pin이 없는 행은 오늘의 코드가 말하는 것을 그대로
보내며, 그것이 EM-06이 서술한 실패 전부입니다.

**wave의 unique index가 재실행을 무해하게 만듭니다.** `(campaignId, kind,
sequence)`이므로 두 번째 `reminder 1`은 불가능하고, 그래서 서비스는 요청을
거절하는 대신 **이어서 합니다** — 재시도한 운영자 조작이 바로 그 모양입니다.

**취소는 앞으로를 정하고 뒤를 고치지 않습니다.** 이미 쓰인 delivery 행은 lane이
자기 gate로 처리하도록 둡니다. 되돌려 쓰면 이미 일어난 일이 기록에서 사라집니다.

**아직 컬럼을 만들지 않은 것**: `scheduledAt`·`workItemId`·`targetModelId`·
`effectiveAt`·`triggerMode`·`audienceVersion`·`estimatedRecipients`, 그리고
`EmailCampaignRecipient`. 마지막 것은 cohort 귀속(§11)이 목적인데 audience
계산기 연결이 3차이고, 지금 만들면 절반이 죽은 채로 남습니다 — EM-01이 지적한
그 결함입니다.

**3차 범위**: 예약, audience 계산기 연결과 `EmailCampaignRecipient`, reminder
wave의 cohort 재계산, admin 화면, `runWithAdminApproval` 연결.

---

## 38. EM-01 3차 구현 기록 — audience 해석과 recipient 원장 (2026-08-24 · 완료)

| 파일 | 역할 |
|---|---|
| `lib/modelRetirementAudience.ts` | cohort 세 개를 DB에서 해석. 새 파일 |
| `lib/emailCampaignRecipientCore.ts` | 원장 판정(우선순위·제외 사유·재계산). 순수, 새 파일 |
| `prisma/schema.prisma` · `migrations/20260824030000_email_campaign_recipient` | `EmailCampaignRecipient` |
| `lib/emailAudienceExpansionCore.ts` | cohort selector, `no_audience` 거부 |
| `lib/emailAudienceExpansion.ts` | cohort 해석 연결 + 원장 기록 |
| `lib/accountDataExport.ts` · `lib/accountDataExportDomains.ts` · `docs/policy/tomverse-chat-data-domain-registry.yaml` | 새 domain 등록과 export |
| `tests/emailCampaignRecipientCore.test.mjs` | 11건 |
| `tests/emailAudienceExpansionCore.test.mjs` | 7건 추가 (총 20) |
| `tests/integration/campaign-audience.db.test.ts` | 17건, 새 파일 |

**§12.2의 표와 계산기가 서로 다른 말을 하고 있었습니다.** §12.2의
`excludedReason` 목록에는 `malformed`가 있고 `account_inactive`가 없는데,
P0-5가 만든 `summariseAudience()`는 malformed 계정을 **notice audience 안**과
`autoMigratable` 밖에 셉니다 — 알려는 주고 자동 이전은 하지 않는다는 뜻입니다.
`malformed`를 "아무것도 못 받은 이유"로 두면 그 계산기와 정면으로 어긋나므로,
**독립 컬럼으로 두고 제외 사유 목록에서 뺐습니다.** §12.2는 "스키마 (개념)"
이고 계산기는 나중에 내려진 검증된 결정이므로 후자를 따랐습니다. CHECK 주석과
`CAMPAIGN_EXCLUDED_REASONS`의 주석에 근거를 적었습니다.

**`selectedModels`는 substring으로만 조회할 수 있고, 그것은 답이 아니라
prefilter입니다.** `String` 컬럼에 든 JSON 배열이라 DB가 줄 수 있는 조건이
`contains`뿐인데, `gpt-5-4-mini`로 찾으면 `gpt-5-4-mini-preview`를 고른 행도
같이 옵니다. 배열을 파싱해 원소 단위로 비교합니다. 이것을 안 하면 **폐기되지
않는 모델을 쓰는 사람에게 폐기 안내가 갑니다.**

**그래서 판정 결과가 셋입니다.** `include` · `exclude` · `not_in_audience`.
prefilter에 걸렸다가 cohort 규칙에서 탈락한 사람을 `already_changed`로 적으면
**사실이 아닌 기록**이 남습니다 — 그들은 아무것도 바꾸지 않았고, 나중에
`already_changed`를 세는 사람은 첫 안내가 닿은 적도 없는 사람에게 효과가
있었다고 결론짓게 됩니다. 이 경우는 아무것도 적지 않는 것이 정직한 기록입니다.

**탈락자도 page에 실려 나옵니다.** cursor가 그들을 지나가야 하기 때문입니다.
여기서 걸러 내면 near-miss만 든 page 하나가 audience의 끝처럼 보이고, **그
뒤의 사람 전원이 영원히 안 읽힙니다.** 소속 판정은 `cohorts.length > 0`이고,
`summariseRetirementAudience()`가 세기 전에 거릅니다.

**reminder는 새 audience 질의가 아니라 원장을 읽습니다.** 질의를 다시 돌리면
첫 안내를 듣고 설정을 바꾼 사람은 **결과에 안 나올 뿐**이고, "안 나옴"과
"더 이상 해당 없음"이 같은 침묵이 됩니다. campaign이 이미 쓴 사람들을 다시
읽어 cohort를 재계산하고, 비어 있으면 `already_changed`입니다.

**segment가 아무도 지목하지 않으면 거부합니다(`no_audience`).**
`readExpansionSpec`은 읽을 수 없는 spec을 빈 spec으로 되돌리고, 빈 spec은
필터 없는 질의로 떨어졌습니다 — **필드 하나 오타가 수백 명 대상 폐기 안내를
전 제품 발송으로 바꿉니다.** 1차의 주석은 "누구인지 모르는 확장은 아무에게도
닿으면 안 된다"고 적어 놓고 반대로 동작하고 있었습니다. `all_users`는 그대로
전원을 뜻합니다 — 그렇게 말하는 것은 별개의 의도적 행위입니다.

**classification은 template이 정합니다.** suppression 판정이 classification마다
다르므로(complaint는 marketing을 막고 transactional을 막지 않습니다) 확장기가
`"service"`로 고정하면 아무도 하지 않는 발송에 대해 옳은 제외 목록이 나옵니다.

**userIds로 지목한 wave는 원장을 쓰지 않습니다.** 기록할 cohort 귀속이 없고,
`eligibilityReason`을 지어내면 **그러지 않으려고 만든 표에 지어낸 이유가**
들어갑니다.

**계정 삭제 시 cascade입니다** — `EmailDelivery`의 `SetNull`과 다릅니다.
delivery는 법적 통지가 실제로 전달됐다는 증거라 계정보다 오래 남을 근거가
있지만, 이 행은 **보내지 않았다는 기록**이고 그것을 보관할 의무는 없습니다.
게다가 주소를 들고 있으므로 링크만 끊어 남기는 쪽이 더 나쁩니다. campaign의
도달 수는 아무도 지목하지 않는 `EmailCampaignWave.expandedCount`에 남습니다.

**4차 범위**: 예약(`scheduledAt`·`triggerMode`·`effectiveAt`·`workItemId`·
`targetModelId`), `runWithAdminApproval` 연결, admin API와 화면.
예약을 3차에서 빼는 이유는 예약이 **운영자의 결정**이고 그것을 설정하는 화면과
같은 변경으로 와야 하기 때문입니다.
## 39. EM-15 구현 기록 — 폐기 안내의 다국어 (2026-08-24 · 완료)

| 파일 | 역할 |
|---|---|
| `lib/modelRetirementNotice.ts` | 안내 판정. 순수, 새 파일 |
| `lib/modelAvailability.ts` | 저장된 영어 문장 대신 copy key + 파라미터 반환 |
| `lib/models.ts` | 유도 가능한 note 9개 제거 + field 용도 문서화 |
| `app/api/chat/route.ts` | `MODEL_TEMPORARILY_UNAVAILABLE`이 안내를 데이터로 전달 |
| `components/chat/ChatApp.tsx` | 그 안내를 사용자 언어로 렌더 |
| `locales/*.ts` | `chat.modelTemporarilyUnavailable` 7개 언어 |
| `tests/modelRetirementNotice.test.mjs` | 9건 |

**규약은 이미 있었고 한 경로만 쓰고 있었습니다.** `MODEL_RETIRED`(410) 분기는
이미 `replacementModelName`을 **데이터로** 보내고 client가
`chat.modelRetiredWithReplacement`를 렌더합니다. EM-15의 실제 gap은
`MODEL_TEMPORARILY_UNAVAILABLE`(503)이 `userVisibleNote`를 **영어 문장 그대로**
message에 실어 보내는 것이었습니다. 그래서 새 문구 체계를 만들지 않고 그 규약에
맞췄고, **새 key는 하나**입니다.

**10개 중 9개는 `replacementModelId`가 이미 말하는 것을 다시 쓴 것이었습니다.**
"This model was retired and replaced by Grok 4.5." — replacement의 이름이
그대로 들어 있습니다. 저장하지 않고 registry에서 유도해 client가 렌더합니다.
저장을 지운 것이 핵심입니다: 남겨 두면 유도된 다국어 문장보다 저장된 영어가
이깁니다.

**열 번째는 남깁니다.** codestral의 note는 "Tomverse **Review**에서 더 이상
제공되지 않는다"이고, 모델 자체는 존재합니다. 어떤 field도 담지 않는 사실이므로
운영자의 문장이 맞습니다. 대신 그것이 **번역될 수 없다는 사실을 타입이
말합니다** — `source: "operator"`와 `source: "localised"`는 서로 다른 것이고,
후자인 척하는 것이 영어 한 문장이 번역 작업을 통과해 살아남은 방식입니다.

**replacement가 없는 사용 불가는 "폐기"라고 하지 않습니다.** 장애·공급자
사고·관리자 스위치로도 사용 불가가 되며, 돌아올 모델을 두고 사라졌다고 말하는
쪽이 두 실수 중 비싼 쪽입니다. 그래서 `chat.modelTemporarilyUnavailable`이
별도 문구입니다 — 기존 "더 이상 제공되지 않습니다. 다른 모델을 선택하세요"를
재사용하지 않았습니다.

**운영자 note는 동작하는 모델에서도 남습니다.** throttling을 설명하는 note가
바로 그 경우입니다. 유도된 문장은 반대로 사용 불가일 때만 만듭니다 — 답하고
있는 모델에 "폐기되어 X로 대체됨"을 유도하면 사실이 아닌 말을 하게 됩니다.

**공개 catalogue는 문장을 잃고 `replacementModelId`를 유지합니다.**
`/api/models`의 `userVisibleNote`를 읽는 client component는 없었고,
`tests/publicModelCatalog.test.mjs`가 고정하던 것은 결함 자체였습니다 —
그 단언을 의도로 바꿨습니다.

**회귀 방지**: `tests/modelRetirementNotice.test.mjs`가 (1) 7개 locale 전부에
key가 있는지, (2) `{model}` placeholder가 번역에서 사라지지 않았는지,
(3) 정적 카탈로그에 "This model was retired..." 문장이 다시 들어오지 않았는지를
검사합니다. 세 번째가 이 결함의 재발 경로입니다.
## 40. P2 catalogue coverage 구현 기록 (2026-08-24 · 완료)

ML-05, 6절 후보 10(OpenAI prefix), `MAX_PAGES` 경고 — 셋 다 **스캔이 본 것보다
적게 보고 그 사실을 말하지 않는다**는 같은 모양이라 한 변경으로 묶었습니다.

| 파일 | 역할 |
|---|---|
| `lib/providerModelCatalogReport.ts` | provider 표시명을 `Record<AiProvider, string>`으로 |
| `lib/providerModelCatalogCore.ts` | `chatModelExclusion()`, `parseProviderCatalogModels()` |
| `lib/providerModelCatalogMonitor.ts` | truncation 감지 + incident, 두 사실을 결과에 실음 |
| `tests/providerCatalogCoverage.test.mjs` | 10건, 새 파일 |

**ML-05는 map 하나만 타입이 없었습니다.** 네 개의 provider 표시명 map 중
`providerMonitoring` · admin panel · marketing은 `Record<AiProvider, string>`이고
전부 12개를 갖습니다. 리포트의 것만 타입 없는 literal에 `|| provider` fallback
이었고, 그것만 `minimax`를 잃었습니다. **값을 채우는 것이 아니라 타입을 주는
것이 고침입니다** — 빠짐이 이제 컴파일 오류입니다.

**표시명을 하나로 합치지 않았습니다.** 값이 표면마다 의도적으로 다릅니다 —
운영 리포트는 스캔 대상 제품군(`Google Gemini`·`Moonshot Kimi`·`Zhipu GLM`)을,
marketing은 회사(`Google`·`Moonshot AI`)를 부릅니다. 하나로 만들면 어느 쪽이든
한쪽 화면에서 틀립니다. 공유하는 것은 값이 아니라 **전수성**입니다.

**추측인 제외와 사실인 제외를 나눴습니다.** embedding 모델은 이름에
`embedding`이 있고, 그것은 이름이 줄 수 있는 만큼 확실합니다. "OpenAI chat
모델은 `gpt-`·`chatgpt-`·`o<n>`으로 시작한다"는 **내기**이고, 그것이 깨지는 날
새 모델은 발견되지 않고 보고되지 않고 아무도 그 사실을 모릅니다. 그래서
`openai_prefix_heuristic`으로 떨어진 id를 parser 밖으로 들고 나와 리포트의
provider 행이 이름을 댑니다.

**incident가 아니라 리포트입니다.** OpenAI는 항상 `davinci-002` 같은 것을 몇 개
내보내므로 알림으로 만들면 매일 노이즈입니다. 리포트가 막아야 하는 것은 조용한
경우 — 선배들과 다른 모양의 진짜 신형 chat 모델이 흔적 없이 사라지는 것입니다.

**truncation은 반대로 incident입니다.** 5페이지 × 1000은 오늘 어느 provider보다
훨씬 많아서, 도달했다면 비정상입니다. 그리고 이것이 **다음 섹션을 오염시킵니다** —
잘린 뒤의 모델은 성공했다고 보고된 실행에서 부재하고, **부재가 곧 폐기 판정
신호**입니다. incident 문장이 "must not be read as missing"이라고 적는 이유이고,
테스트가 그 문장을 고정합니다.

**ML-06·ML-07은 이미 되어 있었습니다.** daily email v2(§10.10)가 footer에
"chat models only; image generation models are a static catalogue and are not
scanned"를, perplexity 행에 "retirement cannot be proven here"를 이미 넣었습니다.
착수 전에 코드로 확인했고, 없는 일을 한 것으로 적지 않았습니다.

**남은 하나는 정책 결정입니다.** `/admin/email-delivery`의 주소 마스킹은 감사
자신이 "마스킹 정책 결정"이라고 적었고, 저장소가 답할 수 없는 사실(관리자
접근 범위, 지원 업무 실태)에 달려 있습니다. §21에 D10으로 올렸습니다.

---

## 41. EM-01 4차 구현 기록 — 예약과 자동 전환 진실성 게이트 (2026-08-24 · 완료)

| 파일 | 역할 |
|---|---|
| `lib/automaticTransitionClaim.ts` | §13.3의 12개 조건. 순수, 새 파일 |
| `lib/emailCampaignScheduleCore.ts` | due 판정 + 일정 정합성. 순수, 새 파일 |
| `prisma/schema.prisma` · `migrations/20260824060000_email_campaign_scheduling` | 예약·모델·전환 컬럼 |
| `lib/emailCampaignService.ts` | `scheduleCampaignWave` · `campaignScheduleProblems` · `runDueCampaignWaves` |
| `lib/scheduledJobsCore.ts` · `lib/notificationDeliveryJob.ts` | `campaign_wave_scheduler` job key + cron 연결 |
| `tests/automaticTransitionClaim.test.mjs` | 14건 |
| `tests/emailCampaignScheduleCore.test.mjs` | 17건 |
| `tests/integration/campaign-scheduling.db.test.ts` | 15건, 새 파일 |

**예약과 §13.3을 같이 넣은 이유.** `effectiveAt` 컬럼은 campaign이 날짜를
말할 수 있게 하는 것이고, **날짜를 말할 수 있다는 것은 그 날짜에 무언가를
약속할 수 있다는 뜻**입니다. 12개 조건은 아무도 다시 읽지 않는 감사 문서의
산문이었습니다. 컬럼만 추가하면 사실이 아닌 약속을 쓸 수 있는 컬럼이 생깁니다.

**게이트의 세 조건은 코드가 알아낼 수 없습니다.** 본문이 capability·크레딧
차이를 실제로 적었는지, rollback을 예행했는지, staging 검증이 됐는지 —
`validationEvidence` blob이 비어 있지 않다는 것과 **누군가 그것을 확인했다**는
것은 다른 사실입니다. 셋은 이름이 붙은 명시적 attestation으로 들어오고,
**없으면 미충족**입니다. `undefined`·`0`·`"yes"`가 통과하지 않는 것을 테스트가
고정합니다 — 침묵은 동의가 아닙니다.

**`dryRunRecipientCount`에서 `0`과 `null`은 다릅니다.** 0은 누군가 세어 보고
아무도 없었다는 것이고, `null`은 아무도 안 봤다는 것입니다. 후자만 미충족입니다.

**게이트 두 개를 합치지 않습니다.** `scheduleRefusal`은 "이 자동화를 요청했고
시간이 됐는가"(운영자 의도), `campaignSendRefusal`은 "이 문장을 보내도 되는가"
(승인, EM-06). 앞을 통과하고 뒤에서 막히는 경우가 중요합니다 — 일정은 잡혀
있는데 그 아래에서 문구가 바뀐 것이고, 그때 아무것도 나가면 안 됩니다.
DB test가 이 경우를 고정합니다.

**`manual`인 campaign은 대신 시작하지 않습니다.** manual로 둔 사람은 발송을
지켜보려는 것이고, 시간이 설정돼 있다는 이유로 대신 시작하면 그 결정을 말없이
빼앗는 것입니다. 그래서 scheduler는 `approved_schedule`만 봅니다.

**due인데 거절된 wave는 조용한 skip이 아닙니다.** 일정은 보내라고 했고 무언가가
아니라고 했으며, 그 간격은 아무도 스스로 알아내지 못합니다.
`CAMPAIGN_WAVE_REFUSED_AT_SCHEDULE` incident를 올립니다. 반대로 아무것도 due가
아닌 tick은 로그를 남기지 않습니다 — 15분마다 "없음"을 적는 것이 진짜 신호를
묻는 방법입니다.

**자기 테스트가 제 버그를 잡았습니다.** `campaignScheduleProblems`가 DB에서
`scheduledAt` 순으로 읽어 넘기는데 `scheduleProblems`는 **목록 순서**로 앞뒤를
비교했습니다. 이미 오름차순인 목록을 연속 비교하면 순서 위반이 **영원히 발견되지
않습니다**. 순수 함수가 스스로 `WAVE_ORDER`로 정렬하도록 고쳤습니다 — 물어야 할
것은 배열이 정렬됐는지가 아니라 notice가 reminder보다 앞인지입니다. 회귀
테스트가 시간 순으로 넘긴 경우를 고정합니다.

**`effectiveAt`과 `timezoneLabel`은 함께 있거나 함께 없습니다**(DB CHECK).
label 없는 UTC 순간은 받는 사람에게 설정한 사람과 다른 날로 읽히고, 이 한 쌍이
존재하는 이유인 그 문장은 **날짜를 지목**합니다.

**scheduler는 drain보다 앞에서 돕니다.** 여기서 확장된 wave가 delivery 행이
되고 같은 pass가 그것을 내보내므로, 메일이 due였던 tick에 나갑니다 — 다음
tick이 아니라.

**D5는 건드리지 않았습니다.** 1인 조직 이중 승인 예외를 campaign에 적용할지는
§21의 조직 결정이고, `SOLE_APPROVER_ACTIONS`에 campaign을 넣는 것은 그 결정을
코드로 내리는 일입니다. 5차의 승인 연결은 일반 2인 경로(`runWithAdminApproval`)
를 씁니다.

**5차 범위**: admin API와 화면, `runWithAdminApproval` 연결, attestation을
사람이 입력하는 경로.

---

## 42. EM-01 5차 구현 기록 — attestation 저장과 admin API (2026-08-24 · 완료)

| 파일 | 역할 |
|---|---|
| `lib/emailCampaignAttestationCore.ts` | attestation 판정. 순수, 새 파일 |
| `prisma/schema.prisma` · `migrations/20260824080000_email_campaign_attestation` | `EmailCampaignAttestation` |
| `lib/emailCampaignCore.ts` | `transition_unproven` 거부 |
| `lib/emailCampaignService.ts` | 기록·철회·상태·12조건 종합 |
| `app/api/admin/email-campaigns/**` | 목록·생성·상세·수정·승인·attestation·wave |
| `tests/emailCampaignAttestationCore.test.mjs` | 12건 |
| `tests/integration/campaign-attestations.db.test.ts` | 15건, 새 파일 |

**4차가 이름만 붙이고 저장하지 않은 것을 저장합니다.** 살 곳이 없는
attestation은 **호출자가 `true`를 넘길 수 있는 매개변수**입니다. 값어치를
만드는 것은 누가 언제 말했는가이므로 boolean이 아니라 컬럼입니다.

**셋 중 하나만 상합니다.** `differences_stated`는 **본문**에 대한 주장입니다 —
누군가 문구를 읽고 capability·크레딧 차이가 적혀 있음을 확인한 것. 문구를 바꾸면
그 읽기는 발송될 것을 더 이상 설명하지 않으며, 이것이 EM-06이 존재하는 실패와
정확히 같은 모양입니다. 그래서 만들어진 시점의 content digest를 들고 다니고
digest가 움직이면 세지 않습니다.

`staging_verified`와 `reconciliation_ready`는 **migration**에 대한 것 — 예행과
rollback입니다. 문구 수정이 둘 중 어느 것도 되돌리지 않으며, 그것으로 만료시키면
**운영자가 다시 확인하지 않고 다시 서명하도록 훈련**됩니다. 묻지 않는 것보다
나쁩니다.

**digest는 요청이 아니라 campaign에서 가져옵니다.** 작성자가 제출한 digest에
묶인 attestation은 **그가 문구라고 믿은 것**에 묶인 것이고, 검사 대상이 바로 그
믿음입니다.

**상했다는 것과 없다는 것을 구분합니다.** 상한 것도 서명자를 그대로 들고
있으므로 화면이 "이것은 상했습니다"라고 말할 수 있습니다 — "아무도 이것을
말하지 않았습니다"와 다른 문장이고, 일을 한 사람에 대해 뒤쪽은 틀렸습니다.

**게이트가 발송을 실제로 막습니다**(`transition_unproven`). 이것이 없으면 12개
조건은 권고입니다. 그리고 **약한 문장으로 조용히 낮추지 않습니다** — 그것은
안전한 문구를 아무도 쓰기로 결정하지 않은 채 보내는 것이고, 운영자는 자기가 쓴
약속이 나가지 않았다는 사실을 영원히 모릅니다.

**승인만 2인 경로입니다.** draft는 아무것도 보내지 않고, 예약도 보내지
않습니다(승인되지 않은 campaign의 예약은 due 시점에 거부됩니다). 이미 승인된
campaign의 wave 실행은 **여기서 승인된 결정의 수행**이고, 그것에 두 번째 승인을
요구하면 검토 대상이 문구가 아니라 발송 행위가 됩니다. 사람이 문구를 읽는 곳이
승인이고, EM-06이 그 문구를 거기에 pin합니다.

**승인 payload에 언어 목록을 넣습니다.** 그래야 요청과 승인 사이에 locale이
움직이면 payload hash가 달라져 **옛 승인을 물려받지 못합니다.** 그리고 언어
불일치는 승인을 claim하기 **전에** 거부합니다 — 잘못된 언어 목록에 대해 소비된
승인은 이미 써 버린 것이고, 운영자의 다음 시도는 처음부터 시작합니다.

**CHECK를 `owner: "list"`로 등록했습니다.** `ATTESTATION_KINDS`와 DB CHECK가
서로 비교되므로 어긋날 수 없습니다 — 여기 있고 저기 없는 kind는 게이트가 결코
묻지 않는 attestation입니다.

**6차 범위**: admin 화면. `lib/adminNavigation.ts` 항목·icon·route segment를
한 번에 추가해야 하고(admin IA 계약), E2E가 따로 필요합니다. API에 nav 항목만
먼저 넣으면 그 계약을 깹니다.

## 43. EM-01 6차 구현 기록 — campaign admin 화면 (2026-08-24 · 완료)

| 파일 | 역할 |
|---|---|
| `lib/adminNavigation.ts` | `email-campaigns` 항목(Operations) · `Campaign detail` detail route · badge key |
| `components/admin/adminNavigationIcons.ts` | icon |
| `lib/adminNavigationBadges.ts` · `lib/adminNavigationCounts.ts` | `overdueCampaignWaves` |
| `lib/adminEmailCampaigns.ts` | 화면용 read layer. 새 파일 |
| `app/(site)/(application)/admin/email-campaigns/**` | 목록·일정 route, 상세 route |
| `components/admin/AdminEmailCampaignsPanel.tsx` | 목록. server component |
| `components/admin/AdminCampaignSchedulePanel.tsx` | wave 일정. server component |
| `components/admin/AdminCampaignDetailPanel.tsx` | 상세·승인·attestation·취소. client |
| `lib/emailTemplateRegistry.ts` | **두 건의 동시성 결함 수정** (아래) |
| `tests/e2e-admin/admin-email-campaigns.spec.ts` | 10건, 새 파일 |
| `tests/integration/email-template-registry-race.db.test.ts` | 5건, 새 파일 |

**admin IA 계약대로 세 곳을 한 번에 넣었습니다** — route table · icon ·
실제 route segment. `docs/ui-contracts/admin-console-ia.md` 규칙 3이고,
`tests/adminNavigation.test.mjs`가 셋 중 하나라도 빠지면 실패합니다. section은
`?tab=`에 있고 tab은 `<Link>`이며 열린 section의 데이터만 읽습니다(규칙 2).

**badge는 "승인된 발송이 due였는데 나가지 않은 wave" 하나뿐입니다.** 규칙 4가
badge를 장식이 아니라 일에만 허용하고, 이 수는 운영자가 실제로 할 일이 있을
때만 0이 아닙니다. `approved_schedule`로 한정합니다 — `manual` wave의 과거
시각은 누군가 보내려던 때를 적은 메모이지 실패한 job이 아니고, 그것까지 세면
어떤 행동으로도 사라지지 않는 숫자가 sidebar에 붙습니다.

**일정 section이 존재하는 이유는 목록이 보여 줄 수 없는 행 하나입니다.**
scheduler가 due wave에 도달해 거부하면 wave 행은 시도도 이유도 기록하지
않습니다 — 거부는 `CAMPAIGN_WAVE_REFUSED_AT_SCHEDULE` operational incident로
나가고, 그것은 Sentry와 운영 알림 채널로 갈 뿐 이 console이 읽는 어떤 표에도
남지 않습니다. 그래서 console 안의 유일한 흔적이 "due인데 여전히 pending"이고,
**화면은 이유가 wave에 있는 척하지 않습니다.**

**초안 작성은 API에 남겼고 화면이 그렇게 적습니다.** audience spec은 expansion
층이 소유하는 문서이고, 자유 입력 상자는 이미 검증하는 요청보다 나쁜 편집기
입니다. 없는 버튼을 찾게 만들지 않으려면 없다고 말해야 합니다.

**상세 화면은 gate를 스스로 판단하지 않습니다.** 버튼은 계속 살아 있고 거부는
전부 서버의 것을 그대로 옮깁니다 — 문장 없이 비활성화된 버튼은 고장 난 버튼과
구분되지 않습니다. 모든 동작 뒤에 서버에서 다시 읽습니다: gate는 이 화면이
들고 있지 않은 행에서 계산되므로, 국소 갱신은 다시 묻지 않은 판정을 보여
주게 됩니다.

**상한 뒤 `notFound()`는 soft 404입니다.** shell이 이미 streaming된 뒤라 상태
코드를 바꿀 수 없고(`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/not-found.md`),
`noindex`가 그것을 정직하게 만듭니다. E2E는 200/404가 아니라 **not-found UI가
뜨고 상세 panel이 뜨지 않는다**와 `noindex`를 검사합니다.

### 43.1 화면이 드러낸 발송 경로의 동시성 결함 둘

**이 slice가 만든 결함이 아니라 이 slice가 처음 부딪힌 결함입니다.** 상세
route가 send gate와 content digest를 병렬로 묻는데 둘 다 같은 template을
ensure하므로, `lib/emailTemplateRegistry.ts`의 경합이 매번 재현됐습니다.

1. **`emailTemplate.upsert` / `emailPolicyVersion.upsert`가 P2002로 터집니다.**
   존재하지 않는 행에 대한 `upsert`는 읽고 나서 insert이므로 동시 호출 둘이
   모두 "없음"을 읽고 모두 insert합니다. 바로 아래 `templateVersion.create`는
   이미 같은 경합을 처리하고 있었고 위 두 줄은 처리하지 않았습니다.
   `upsertSurvivingRace()`로 잡아 읽어 옵니다. **credential lane에서는 이것이
   copy 변경 직후 동시에 로그인한 두 사람 중 하나가 코드를 영영 못 받는
   결함입니다.**

2. **같은 문구가 published version 두 개를 갖습니다.** unique index는
   `(templateId, language, version)`이라, `latest`를 서로 다른 시점에 읽은 두
   caller가 N과 N+1을 쓰고 **둘 다 성공**합니다. send gate는 hash를 비교하므로
   발송 판정은 무해하지만, 바뀐 적 없는 문구에 대해 "어느 version을
   보냈는가"의 답이 둘이 됩니다 — 이 registry가 답하려고 존재하는 바로 그
   질문입니다. `pg_advisory_xact_lock`으로 (template, language)마다
   직렬화하며, **행이 이미 있는 정상 경로는 잠금을 잡지 않으므로** 비용은 copy
   변경 후 첫 발송에만 듭니다. P2002 처리는 그대로 둡니다 — 잠금을 잡지 않는
   다른 process(migration, console, 배포 중인 구버전)가 여전히 먼저 쓸 수
   있습니다.

`tests/integration/email-template-registry-race.db.test.ts`가 둘을 고정합니다.
2번은 비결정적이라 한 번의 통과가 증거가 아니며, 3회 연속 실행으로 확인했습니다.

### 43.2 남은 것

**D5와 D10은 그대로입니다.** `email_campaign.approve`는 여전히
`SOLE_APPROVER_ACTIONS`에 없고(§21 D5), `/admin/email-delivery` 주소 마스킹
(§21 D10)도 결정 대기입니다. 둘 다 조직의 결정이지 코드의 결정이 아닙니다.

**초안 작성 UI는 만들지 않았습니다.** 위에 적은 이유이며, audience spec의
모양이 하나(`model_retirement` cohort)를 넘어 늘어나면 다시 볼 일입니다.

## 44. EM-01 7차 구현 기록 — 확장 원장 읽기 (2026-08-24 · 완료)

| 파일 | 역할 |
|---|---|
| `lib/adminEmailCampaigns.ts` | `waveAudienceBreakdown()` |
| `app/api/admin/email-campaigns/[campaignId]/route.ts` | 상세 응답에 `audience` |
| `components/admin/AdminCampaignDetailPanel.tsx` | wave별 원장 구획 |
| `tests/integration/campaign-audience-readback.db.test.ts` | 11건, 새 파일 |
| `tests/e2e-admin/admin-email-campaigns.spec.ts` | 2건 추가(총 12건) |

**3차가 쓴 것을 아무도 읽지 못했습니다.** `EmailCampaignRecipient`를 읽는 곳은
expander(재개용), transition gate의 count 하나, 계정 데이터 내보내기 셋뿐이고
**운영자가 열 수 있는 화면은 없었습니다.** 3차가 제외 사유를 기록한 이유 자체가
그것을 검토하기 위해서였는데 볼 곳이 없었고, **dry run은 "누구에게 갔을
것인가"에 답하는 것이 유일한 일인데 그 답을 아무도 읽을 수 없었습니다.**

이는 6차가 고친 것과 같은 모양입니다 — 쓰이고 읽히지 않는 데이터.
12조건의 `dry_run_counted`가 "아무도 보지 않은 숫자에게 약속하게 된다"고
말하면서 볼 방법을 주지 않았던 것도 같은 구멍입니다.

**`excludedReason IS NULL`을 "발송됨"이라고 쓰지 않습니다.** dry run은
`EmailDelivery`를 `status: "skipped"` · `skipReason: "dry_run"`으로 쓰므로,
원장에서 그 열은 **"delivery 행이 쓰였음"**입니다. "sent"라고 이름 붙인 열은
예행을 발송으로 보고하는 것이고, 예행이 절대 오해받아서는 안 되는 단 하나가
그것입니다. 화면은 wave의 `dryRun`을 보고 문장을 바꿉니다.

**0인 사유도 전부 보여 줍니다.** 발동하지 않은 사유를 생략한 내역은 그 사유를
묻지 않은 것처럼 읽히고, "아무도 suppress되지 않았다"는 부재에서 추론할 것이
아니라 적혀 있어야 하는 답입니다.

**cohort는 제외와 따로 셉니다.** 제외된 사람도 audience에 있던 사람입니다 —
cohort는 expander가 왜 그를 봤는지, 제외는 왜 그에게 쓰지 않았는지입니다.
쓰인 사람만 세면 audience가 실제로 일치한 것보다 작아 보입니다.

**`malformed`를 결과 대신이 아니라 결과와 함께 보고합니다.** 읽기에 대한
사실이지 제외 사유가 아니며, malformed인 사람도 발송 대상일 수 있습니다.
3차가 "보고하되 다시 쓰지 않는다"고 정한 값이 이제 로그가 아니라 화면에
있습니다.

**주소는 한 개도 싣지 않습니다 — 숫자만입니다.** 모든 행이 주소를 들고 있고,
campaign 화면에서 운영자가 주소를 볼 수 있는지는 `/admin/email-delivery`의
**D10(§21)과 같은 미결 질문**입니다. 개인 목록을 만드는 것이 곧 그 결정을
내리는 일이므로 만들지 않았습니다. E2E가 이 구획에 `@`가 없음을 검사합니다.

**도달 불가능한 상태를 단언하지 않았습니다.** breakdown에는 목록에 없는 사유를
만나도 합계가 맞도록 하는 분기가 있지만, 그 분기는 DB CHECK 때문에 오늘 DB를
통해서는 도달할 수 없습니다. 테스트는 분기가 아니라 **CHECK가 그 행을
거부한다**는 실제 보증을 고정합니다.

### 44.1 남은 것

**초안 작성 UI는 여전히 없습니다**(§43.2). **D5·D10도 그대로 결정 대기**입니다.
개인 단위 원장 열람은 D10이 정해진 뒤에 다시 봅니다.

## 45. EM-01 8차 구현 기록 — 추정치를 재기 (2026-08-24 · 완료)

| 파일 | 역할 |
|---|---|
| `lib/modelRetirementAudienceCore.ts` | `AUDIENCE_DEFINITION_VERSION`, `AudienceSummary.truncated` |
| `lib/modelRetirementAudience.ts` | `summariseRetirementAudience`에 `maxCandidates` |
| `prisma/schema.prisma` · `migrations/20260824120000_email_campaign_audience_estimate` | `estimatedAt` · `estimatedByEmail` · `audienceEstimate` + 완결성 CHECK |
| `lib/emailCampaignService.ts` | `estimateCampaignAudience()` |
| `app/api/admin/email-campaigns/[campaignId]/estimate/route.ts` | 계수 실행 |
| `components/admin/AdminCampaignDetailPanel.tsx` | 추정 구획 |
| `tests/audienceEstimateTruncation.test.mjs` | 5건, 새 파일 |
| `tests/integration/campaign-audience-estimate.db.test.ts` | 12건, 새 파일 |
| `tests/e2e-admin/admin-email-campaigns.spec.ts` | 2건 추가(총 14건) |

**`estimatedRecipients`의 유일한 출처가 사람이 타이핑한 숫자였습니다.**
4차부터 컬럼은 있었지만 audience에서 그것을 쓰는 코드가 없었고,
`audienceVersion`은 **아무도 쓰지 않아 영원히 1**이었습니다 — "어떤 규칙이 이
추정을 만들었는가"를 말하겠다는 컬럼이 어떤 규칙도 만들지 않은 추정에 대해
"버전 1"이라고 답하고 있었습니다. 그리고 3차가 만든
`summariseRetirementAudience()`는 **자기 테스트 말고 아무도 부르지
않았습니다** — 이 기능에서 같은 패턴의 세 번째입니다(§43.1의 overdue wave,
§44의 원장).

**저장하는 머릿수는 `noticeAudience`이지 `distinctUsers`가 아닙니다.** cohort
전체로 크기를 잡으면, 곧 쓰지 않기로 결정할 사람들까지 포함해 발송 규모를
가늠하게 됩니다.

**추정은 숫자·시각·요약이 함께이거나 전부 없습니다**(CHECK). 시각 없는 숫자는
매일 움직이는 audience에 대한 나이 모를 수이고, 그것이 바로 이 slice가
"측정"으로 오인되지 않게 하려는 **타이핑된 추측**입니다. `NOT VALID`으로
배포하며, 그런 기존 행은 삭제가 아니라 **다시 재도록** 남겨 둡니다.

**요약 전체를 행에 저장합니다.** 제외 내역은 audience query가 틀렸다고 말해
주는 부분인데, 계산한 요청의 응답에만 두면 **campaign을 검토하는 두 번째
관리자가 그것을 영영 보지 못합니다.**

**한계를 둔 계수는 한계를 두었다고 말합니다.** scan은 은퇴 모델을 지목한 모든
계정을 도는데, 그것이 바로 묻고 있는 수이므로 **가장 알고 싶은 audience에서
가장 비쌉니다.** 사람이 기다리므로 상한을 두고, 넘으면 `truncated`이며 모든
수치가 총계가 아니라 **하한**입니다. 화면이 "at least N"이라고 씁니다 —
보정·외삽·반올림을 하지 않으므로 그 문장이 참입니다.

**13번째 조건을 만들지 않았습니다.** §13.3의 12조건은 그대로이고 이것은
아무것도 gate하지 않습니다. 크기를 **누구도 약속하기 전에 알 수 있게** 할
뿐입니다.

**승인 후에는 거부합니다.** 다시 재면 승인자가 읽은 숫자가 같은 승인 아래에서
다른 숫자로 바뀌고, 어차피 각 wave가 실행 시점에 자기 audience를 다시
계산합니다.

**cohort 없는 campaign은 0으로 재지 않고 거부합니다.** 세 사람을 명시적으로
지목한 campaign에 "수신자 0명"이라고 답하는 것은 틀린 질문에 대한 측정입니다.

### 45.1 테스트에서 고친 제 실수 셋

세 번 다 코드가 아니라 테스트가 틀렸고, 그대로 두면 통과하는 거짓 검사가
됐을 것들입니다.

1. **`AudienceMember` fixture의 필드명이 틀렸습니다.** 모두 `no_email`로
   제외돼 0을 세고 있었고, "truncation이 수치를 바꾸지 않는다" 검사는 양쪽 다
   0이라 **통과하고 있었습니다.** fixture를 고치고, 비교 전에
   `noticeAudience === 2`를 먼저 단언하도록 바꿨습니다.
2. **cap을 기본 page size(200)보다 작은 audience로 시험했습니다.** 짧은 page
   에서 loop가 먼저 끝나므로 cap에 닿지 않습니다 — 코드가 맞습니다. 그 분기는
   `pageSize`가 노출된 summariser 층에서 시험하고, 서비스에는 **테스트 전용
   손잡이를 달지 않았습니다.**
3. **`status: "approved"`를 손으로 세팅했습니다.** `approval_completeness_check`
   가 정당하게 거부했고, `approveCampaign()`으로 실제 경로를 지나게 고쳤습니다.

### 45.2 남은 것

초안 작성 UI(§43.2), **D5**·**D10**(§21) 그대로입니다. `audienceEstimate`가
있는 지금도 개인 단위 열람은 D10 뒤입니다.
