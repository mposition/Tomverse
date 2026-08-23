# Knowledge tombstone sweep은 일간 job에 걸려 있다 — 2026-08-23

정책 §14.2가 확정한 것은 15분 sweep이고, 배선은 하루 한 번짜리 job입니다.
**정책과 구현 중 어느 쪽이 옳은지 정하는 문제가 아니라, 정책이 말한 것이
절반만 구현된 문제입니다.**

발견 경로: `docs/ops/assistant-knowledge-staging-verification-records/`
2026-08-22 회차 두 건. 삭제한 파일의 R2 object가 몇 시간 뒤에도 남아 있어
결함을 의심했고, 주기를 확인하다 드러났습니다.

## 사실

`docs/policy/external-conversation-import-and-memory.md` §14.2
[확정 · 2026-08-13 @mposition]:

> 생성 이미지는 DB-first tombstone(`ImageAssetCleanup`) + 15분 maintenance
> sweep(`lib/imageAssetLifecycle.ts`). Knowledge는 **후자**를 따릅니다.

같은 절의 보존 표:

> 사용자 삭제 · profile 삭제 · 계정 삭제 | tombstone은 같은 transaction,
> object는 **다음 sweep(≈15분)**

배선은 이렇습니다.

```
railway.credit-reconciliation.json   */15 * * * *
  → npm run maintenance:credit-reservations
  → POST /api/internal/maintenance/credit-reservations
  → runImageAssetMaintenanceQuietly()
       drainImageAssetCleanupQueue()      이미지 tombstone — 15분  ✅ 정책대로

railway.maintenance.json             0 3 * * *
  → npm run maintenance:cleanup
  → POST /api/internal/maintenance/cleanup
  → cleanupExpiredData()
       drainKnowledgeCleanupQueue()       knowledge tombstone — 일간  ❌
       sweepAbandonedKnowledgeObjects()   고아 object — 일간
```

Knowledge는 tombstone **모양**은 이미지를 따랐고(같은 transaction, DB-first,
재시도 상한) **주기**만 다른 job에 연결됐습니다. `lib/maintenance.ts`가
`assistantKnowledgeLifecycle`을 import하는 유일한 곳이고, 15분 route는
`imageAssetLifecycle`만 부릅니다.

## 관측된 결과

2026-08-22 회차에서 삭제한 파일 두 건의 R2 object가 삭제 후 각각 약 3시간·
22시간 동안 남아 있었고, 2026-08-23 03:00Z sweep에서 함께 사라졌습니다.
`docs/ops/assistant-knowledge-staging-verification-records/2026-08-22__4380bc1*.md`
의 C-3에 양쪽 관측이 있습니다.

**동작 자체는 옳습니다.** DB-first가 지켜졌고 bytes가 tombstone 뒤에
사라졌습니다. 틀린 것은 **얼마나 걸리는가**뿐입니다.

## 왜 지금 고치는 것이 나은가

**아직 아무도 이 약속에 노출되지 않았습니다.** `assistantKnowledgeEnabled`는
production에서 켜진 적이 없으므로 삭제를 기다린 사용자가 없습니다. flag를
켠 뒤에 고치면 그 사이 삭제한 사용자들이 최대 24시간 창을 겪습니다.

7개 locale의 `privacyPolicy`가 knowledge 파일에 대해 *"the stored files are
erased shortly afterwards"*라고 말합니다. 24시간을 "shortly"라고 부를 수
있는지는 판단이지만, 그 문장이 근거로 삼는 것은 §14.2의 표이고 그 표는
≈15분이라고 적혀 있습니다.

## 고치는 방법 — 두 가지, 크기가 다릅니다

**(가) 15분 route에 knowledge drain을 추가한다.**
`app/api/internal/maintenance/credit-reservations/route.ts`가
`runImageAssetMaintenanceQuietly()` 옆에서 `drainKnowledgeCleanupQueue()`를
부르게 합니다. 이미지가 이미 그 자리에 있으므로 대칭이고, 정책이 "후자를
따른다"고 한 것이 실제로 그렇게 됩니다.

주의할 것 둘. 그 route는 크레딧 정산 job이므로 **이름과 실제 하는 일이 이미
어긋나 있습니다**(이미지 정리도 거기 있습니다) — 세 번째를 얹으면 더
어긋납니다. 그리고 `cleanupExpiredData()`의 knowledge step을 남길지 뺄지
정해야 합니다. 남기면 두 job이 같은 큐를 비우게 되는데, `skipDuplicates`와
조건부 UPDATE 덕분에 안전하긴 합니다.

**(나) object 정리 전용 15분 job을 만든다.**
이미지·knowledge·향후 것들을 한 이름 아래 모으고, 크레딧 정산 route에서
이미지를 떼어냅니다. 이름이 하는 일과 맞고 다음 저장 기능이 붙을 자리가
생기지만, Railway 서비스가 하나 늘고 배포·환경변수가 따라옵니다.

## 함께 볼 것

- **온디맨드 실행이 막혀 있습니다.** `retention.cleanup.execute`는 2인 승인을
  요구하고 `lib/adminApprovalCore.ts`가 `requestedById !== reviewerId`로
  자기 승인을 금지합니다. 관리자가 한 명인 조직에서는 실행할 수 없으므로,
  주기를 앞당길 운영 수단이 없습니다. 주기가 일간인 동안 이 제약이 더
  무겁습니다.
- **cleanup dry-run이 knowledge를 보고하지 않습니다.** 응답에
  `assistantKnowledge*` 항목이 없어 execute가 R2에서 무엇을 지울지 미리
  보여주지 못합니다.

## 정하지 않은 것

(가)와 (나) 중 무엇을 할지, 그리고 §14.2의 ≈15분을 그대로 둘지입니다.
구현을 정책에 맞추면 문서는 그대로 두면 됩니다.

**이 보고서는 결정이 아니라 관측입니다.** 정책 문서는 건드리지 않았습니다.
