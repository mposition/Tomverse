# Perplexity Sonar credit price — hold

- Status: **hold, awaiting finance/product approval.** 승인 전에는 production
  DB의 `ModelRegistryEntry.creditWeight`도 `lib/models.ts`의 값도 변경하지
  않습니다. 한쪽만 고치는 것도 포함해서.
- Discovered: 2026-08-15, provider 정산 검증 중 (`.github/audits/release-deviation-2026-08-15__5528317.md`)
- Reads on top of: `docs/policy/credit-and-cost-limits.md`

## 1. 사실

`perplexity/sonar` 한 턴의 크레딧 가격에 대해 **두 개의 값이 존재하며, 서로
다릅니다.**

| 출처 | 값 | 이것이 무엇인가 |
|---|---|---|
| `lib/models.ts:294` `creditWeight: 16` | **16** | 소스를 읽는 사람이 보는 값 |
| `ModelRegistryEntry.creditWeight` (production) | **20** | **실제로 청구되는 값** |

런타임은 DB 행을 씁니다(`lib/modelRegistry.ts:68`). 2026-08-15T14:20+10:00에
정산된 실제 턴이 `Credits: 20 reserved / 20 settled`로 기록됐고, Admin Console의
Models 화면에서도 20으로 확인됐습니다.

**20은 `usageClass: "research"`의 기본값입니다**
(`MODEL_USAGE_CREDIT_WEIGHTS.search`, `lib/models.ts:52`). 즉 DB의 20은 누군가
20을 골라서 넣은 값일 수도 있고, `creditWeight: 16`이 소스에 들어오기 전 seed가
넣은 기본값일 수도 있습니다. **행만 봐서는 구분되지 않습니다** —
`ModelRegistryEntry.creditWeight`는 `Int` non-nullable이라 값의 출처를 말하지
못합니다.

## 2. 왜 16이 반영되지 않았는가

편집이 실패한 것이 아니라 **반영 경로가 없습니다.**

- `ensureModelRegistrySeeded()`는 `createMany({ skipDuplicates: true })`로
  넣습니다(`lib/modelRegistry.ts:253`). 이미 있는 행은 다시 보지 않습니다.
- 기존 행을 갱신하는 유일한 경로는
  `staticModelRegistryReconciliationRows()`이고, 이는
  `STATIC_CATALOG_RECONCILIATION_MODEL_IDS`에 등록된 모델만 대상으로
  필터합니다(`lib/modelRegistryShared.ts:351`). **`perplexity/sonar`는 그
  목록에 없습니다.**

그래서 소스를 고쳐도 production 행은 영원히 움직이지 않습니다. 배포는 됐고
아무것도 바뀌지 않았으며, **소스를 읽는 것이 그 편집이 적용됐다고 결론짓는
방법**이었습니다.

## 3. 언제부터

```
0d2e849   2026-08-04T23:15:30+10:00   PR #356
          "claude/tomverse-nightly-visual-regression-z4ia53 -> develop"
```

**야간 시각 회귀 PR에 가격 한 줄이 섞여 들어왔습니다.** main에도 포함돼
있습니다(`git merge-base --is-ancestor 0d2e849 origin/main` → 0).

이것은 "16이 승인된 가격인가"에 답하지 않습니다. 다만 승인 기록을 찾을 때
후보 시점이 2026-08-04이고, **그 PR의 제목과 설명이 가격을 언급하지 않는다**는
것은 사실로 기록해 둡니다. 승인 기록이 발견되지 않는다면 가장 단순한 설명은
"16은 승인된 적 없는 값"이며, 그 경우 정렬 방향은 20입니다. **그 판단은 이
문서가 하지 않습니다.**

## 4. 결정해야 하는 것

### 4.1 승인된 판매가는 얼마인가

finance/product가 확정합니다. 이 문서는 두 값이 존재한다는 사실만 기록하며
어느 쪽도 권하지 않습니다.

### 4.2 20이 승인된 가격이라면

코드와 테스트를 20으로 정렬합니다. **결제액은 변하지 않습니다** — 이미 20을
청구하고 있습니다.

검증해야 하는 것은 표시·정산·보고 경로입니다.

| 층 | 읽는 곳 |
|---|---|
| 표시 | `lib/publicModelCatalog.ts:100`, `lib/modelRecommendations.ts:263`, `lib/webSearchCredits.ts:74` |
| 정산 | `lib/chatSecurity.ts:543`, `lib/memoryExtractionService.ts:208` |
| 등급 분류 | `lib/appDefaults.ts:50`, `lib/modelFinder.ts:187`, `lib/comparisonReviewService.ts:164` |

`usageClass`는 `research` 그대로이므로 **등급 분류는 움직이지 않습니다.**
실제로 바뀌는 것은 소스가 말하는 숫자뿐입니다.

**먼저 확인해야 할 것**: 사용자에게 **표시되는** 값이 16인지 20인지. 카탈로그가
DB 값을 내보낸다면 표시도 20이고 사용자에게는 아무 불일치가 없으며, 거짓말하는
것은 소스뿐입니다. 화면에 16이 보인다면 **표시와 청구가 11일간 어긋난
상태**이고, 그것은 이 문서의 §4.3이 아니라 별개의 시급성입니다.

### 4.3 16이 승인된 가격이라면

이는 **가격 인하**입니다.

- 적용 시각과 대상을 먼저 결정합니다.
- **forward-only로 배포합니다.** 기존 구매 기록, 정산된 reservation, pricing
  snapshot은 변경하지 않습니다 — `docs/policy/credit-and-cost-limits.md`의
  "가격 변경은 소급 적용하지 않습니다"가 그대로 적용됩니다.
- **불일치 기간에 20으로 결제된 거래의 보상 여부를 별도로 판단합니다.** 이는
  가격 결정과 다른 결정이며, 같은 승인으로 묶지 않습니다.

보상 판단에 필요한 숫자는 아직 측정되지 않았습니다.

```sql
SELECT count(*)              AS turns,
       sum("settledCredits") AS credits_charged,
       min("createdAt")      AS first_turn,
       max("createdAt")      AS last_turn
FROM "ChatCreditReservation"
WHERE "modelId" = 'perplexity/sonar'
  AND "createdAt" >= '2026-08-04T13:15:30Z'
  AND "status" = 'settled';
```

0이면 §4.3의 보상 항목은 판단할 대상이 없습니다.

```
측정 시각:   ____________________
turns:       ____________________
credits:     ____________________
```

## 5. 이 hold가 덮지 않는 것

**다른 모델도 같은 상태일 수 있습니다.** `perplexity/sonar`는 정산 검증 중
우연히 발견됐고, 같은 조건(soure가 `creditWeight`를 명시 + 행이 seed 이후
생성 + reconciliation 대상 아님)을 만족하는 모델이 더 있는지는 측정되지
않았습니다.

```
npm run report:model-credit-weights
```

production DB를 향해 실행하면 `stranded edit` 목록이 나옵니다. **그 결과가 이
문서의 범위를 정합니다** — 다른 모델이 나오면 각각 자기 승인이 필요하며, 이
문서를 그쪽으로 넓히지 않습니다.

## 6. 해제 조건

아래가 모두 채워지기 전에는 `lib/models.ts`의 `creditWeight`와 production의
`ModelRegistryEntry.creditWeight` 어느 쪽도 변경하지 않습니다.

- [ ] 승인된 판매가 확정 (16 또는 20), 승인자와 일시 기록
- [ ] `report:model-credit-weights`를 production DB에 대해 실행, 범위 확정
- [ ] 사용자에게 표시되는 값이 실제로 무엇인지 확인
- [ ] 16으로 확정된 경우: 적용 시각·대상 결정, 보상 판단 별도 기록

```
승인자:      ____________________
승인 일시:   ____________________
확정 가격:   ____________________
```
