# 이미지 생성 production 활성화 — 2026-08-20 / `cc2614d`

`feature.imageGenerationEnabled`를 production에서 켜고 첫 생성을 실행한 기록입니다.
`.github/audits/image-generation-exposure-readiness-2026-08-16.md`가 남긴 체크리스트를
이 문서가 이어받습니다 — 그 문서는 시점 기록이므로 고치지 않습니다.

```
production   cc2614d80d1631f60057c2feaaed50ead1457024
             deployment f10363dc-9393-4d44-8cfe-134dfb3419e0
             deployedAt 2026-08-20T00:39:08Z
활성화 전     flagEnabled false  (기준선: docs/ops/image-generation-staging-verification-records/2026-08-20__cc2614d80d1631f60057c2feaaed50ead1457024.md)
활성화 후     flagEnabled true   관측 2026-08-20T01:05Z
readiness    /api/ready 200 ok:true — database·securityEnvironment·providerBudgets·imageProviderBudget 전부 true
```

## 활성화 전 세 가지 확인

| # | 확인 | 결과 |
|---|---|---|
| 1 | Guest에게 진입점이 **보이면서** 잠긴다 | 사이드바 split button 드롭다운의 `새 이미지`가 자물쇠 + `로그인` 배지와 함께 렌더됨. 숨김 아님, 마지막 단계 차단 아님 |
| 2 | production의 `IMAGE_GROUP_MAX_MODELS` | 컴포저가 `모델 2/2개`를 표시 → **2**(환경변수 미설정, 기본값) |
| 3 | 상한 초과 선택이 선택을 바꾸지 않고 거절된다 | 세 번째 모델이 점선 비활성, 선택은 2개 그대로, `한 번에 최대 2개 모델을 비교할 수 있습니다` 안내. 2026-08-16 상한 불일치 수정이 production에서 처음 확인됨 |

## 첫 생성 — 2모델 1그룹

GPT Image 2 + Grok Imagine, Standard / 1024×1024, 합계 **145크레딧**. 제출 전에
`70` · `75` · `145`가 표시됐고 생성 버튼에도 `145`.

두 카드 모두 `AI로 생성된 이미지` 라벨, `1024x1024`, `원본 보기`·`다운로드`만
(성공한 target에 재실행 없음). 새로고침 후 서버에서 그대로 복원됨.

### provider별 예산 귀속 — production 첫 실측

| provider | 예약 | 정산 | true-up | 오늘 버킷 |
|---|---|---|---|---|
| openai | 58,000 | 53,045 | 4,955 | 0 → **53,045** |
| xai | 55,000 | 50,000 | 5,000 | 0 → **50,000** |
| fal | — | — | — | 0 → **0** |

**fal이 움직이지 않았습니다.** 한 그룹 안의 두 provider가 각각 자기 버킷으로
정산되고, 세 번째는 건드려지지 않습니다. 2026-08-16 결함이었다면 두 true-up
9,955가 다른 곳에서 빠졌을 것입니다.

```
reservations.total    4 → 6        target당 1건, 한 트랜잭션
reservedCredits     335 → 480      +145
settledCredits      335 → 480      +145 — 고정가
reservedCostMicroUsd  258,000 → 371,000   +113,000 = 58,000 + 55,000
settledCostMicroUsd   236,105 → 339,150   +103,045
generations.succeeded  4 → 6       failuresByPhase {}
storage               4/4 → 6/6    원본·썸네일 짝 맞음
invariants            6종 전부 0
dimensionCoverage     openai 3/3 · xai 2/2 · fal 1/1 — 누락 없음
```

크레딧당 원가는 openai 757 · xai 667 µUSD로 상한 900 아래입니다.

### drift가 늘지 않았다 (핵심)

활성화 전 기준선의 배분 오류가 그대로입니다.

```
              정산 합계    월 버킷    차이        기준선 대비
openai        159,150     147,150    −12,000     변화 없음
xai           100,000     105,000     +5,000     변화 없음
fal            80,000      87,000     +7,000     변화 없음
합계          339,150     339,150          0
```

이번 생성이 drift에 **하나도 기여하지 않았습니다.** 수정 이후의 생성은 자기
버킷으로만 간다는 것이 production 데이터로 확인됐습니다. 12,000 µUSD는
`accepted`이며 월 경계(2026-09-01 UTC)가 효과를 끝냅니다.

## readiness 체크리스트에서 아직 안 닫힌 것

`image-generation-exposure-readiness-2026-08-16.md` §"What remains" 기준입니다.

- [x] flag ON
- [x] **`AdminAuditLog` 항목 확인** — route를 탔습니다. 같은 시각에 두 항목이
      남았습니다: `app_settings.update_started`(변경 전)와
      `app_settings.guest_default_model.updated`(결과). 전자의 metadata에
      `"imageGenerationEnabled": true`가 들어 있습니다. **DB 행 직접 편집이었다면
      이 두 항목이 없습니다**
- [x] **fal 1건** — 활성화 이후 실행 완료. 아래 §"fal 실행" 참조
- [x] ~~마지막 `@ai-sdk/*` patch bump 판단~~ — 그 시점 이후 빌드가 여러 번 바뀌었고
      현재 production 빌드는 위 실행으로 직접 검증됐으므로 대체됨

```
켠 사람:        @mposition (계정 소유자)
켠 시각 (UTC):  2026-08-20T00:59Z
켠 방법:        PUT /api/admin/app-settings   (AdminAuditLog 항목으로 확인)
AdminAuditLog:  app_settings.update_started + app_settings.guest_default_model.updated
                target AppSettings / public, 2026-08-20 00:59 UTC
fal 1건 실행:   Nano Banana 2, Standard / 1024x1024, 120크레딧
```

## fal 실행 — 세 provider가 모두 자기 버킷으로

| 버킷 | 이전 | 이후 |
|---|---|---|
| fal `usedTodayMicroUsd` | 0 | **80,000** (+80,000 = 자기 정산액) |
| openai | 53,045 | 53,045 (0) |
| xai | 50,000 | 50,000 (0) |

`reserved` 371,000 → 458,000 (+87,000 = fal 최악 원가), `settled` 339,150 →
419,150 (+80,000), true-up 7,000이 fal에서 빠짐. `reservations.total` 6 → 7,
`settledCredits` 480 → 600 (+120, 고정가), succeeded 6 → 7, 저장 7/7,
`dimensionCoverage` fal 2/2, invariant 6종 0, `failuresByPhase` 비어 있음.

크레딧당 80,000/120 = 667 µUSD로 상한 900 아래입니다.

**이로써 세 provider가 production에서 각각 확인됐습니다.** fal은 셋 중 true-up이
가장 크고(7,000) 일 한도가 가장 낮으므로(12,000,000), 옛 결함이 남아 있었다면
가장 크게 드러났을 지점입니다.

### drift는 세 번째 실행에서도 그대로다

```
              정산 합계    월 버킷     차이       기준선 대비
openai        159,150     147,150    −12,000    변화 없음
xai           100,000     105,000     +5,000    변화 없음
fal           160,000     167,000     +7,000    변화 없음
합계          419,150     419,150          0
```

활성화 이후 생성 3건(openai·xai·fal 각 1건)이 drift에 **하나도 기여하지
않았습니다.** 12,000 / 5,000 / 7,000은 활성화 전 기준선의 값 그대로입니다.

## 여전히 실행된 적 없는 것

- **부분 실패 경로.** staging에서 provider 실패를 만들 수 없어 코드 근거로
  종결했습니다(`lib/imageGenerationService.ts:1033`·`:1051` 전액 환급). 처음
  실행되는 곳은 실사용자의 요청이 됩니다
- 재시도, 취소, 동시성 한도, `PROVIDER_BUDGET_EXHAUSTED` 경로
- 모바일 320px, ko/en 두 locale
- 3모델 그룹 — production 상한이 2

## 되돌리기

`feature.imageGenerationEnabled = false`. flag가 꺼지면 네 진입점이 렌더되지
않고 `POST /api/images/generations`가 거절하며 행도 비용도 남기지 않습니다.
배포도 마이그레이션도 필요 없습니다.

## Related

- `.github/audits/image-generation-followup-2026-08-20.md` — **이 활성화가 덮지
  않은 것들.** 다음 세션이 집어 들 목록
- `.github/audits/image-generation-exposure-readiness-2026-08-16.md` — 이 문서가
  이어받은 시점 기록
- `docs/ops/image-generation-staging-verification-records/2026-08-20__cc2614d80d1631f60057c2feaaed50ead1457024.md` — 활성화 전 기준선
- `docs/ops/image-generation-staging-verification-records/2026-08-19__6fb0a9e7148fc93a15340f1348285bec37639513.md` — staging 검증 실행
- `docs/policy/image-generation.md`
- `docs/ui-contracts/image-generation-workspace.md`
