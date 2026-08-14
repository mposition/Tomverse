# fal-ai/nano-banana-2 활성화 증거 (2026-08-14)

`fal-ai/nano-banana-2`를 `operational_hold`에서 해제하며 근거로 삼은 실행 1건의
기록입니다. **서술은 이 문서이고, `2026-08-14-smoke.json`은 그 서술을 다시
계산할 수 있는 증거입니다.**

- 검증: `npm run check:fal-smoke-evidence` (PR Fast Gate에서 실행)
- 생성: `npm run smoke:fal-image -- --out=<path> --i-accept-the-cost`
- 실행: 사용자 환경(`FAL_KEY` 보유), 2026-08-14T11:41:34Z, $0.08 1회

## 왜 필요했나

활성화 직전까지 `generateWithFal`은 **성공한 요청을 한 번도 보낸 적이
없었습니다.** 요청 본문, 플랫폼 헤더, CDN host, 배달되는 MIME, 이미지의 실제
치수 — 전부 저장소가 *믿고* 있을 뿐 아는 것이 아니었습니다. 그대로 활성화하면
첫 실제 호출이 요금을 내는 사용자의 것이 되고, "문서 예시의 asset host가 실제와
다르다"는 사실을 발견할 자리로는 최악입니다.

smoke script는 adapter가 쓰는 `buildFalImageRequest`·`falPlatformHeaders`·
`parseFalImageResponse`를 **그대로** 통과합니다. adapter가 만들지 않는 요청을
검사해 봐야 adapter에 대해 아무것도 증명하지 못하며, 이 교훈은 이미 값을
치렀습니다 — 2026-08-06 Google 측정 script는 자체 요청식을 만들어, adapter가 이미
고친 HTTP 400을 계속 재현했습니다.

## 결과

7개 gate 전부 통과, `outcome: "passed"`.

| gate | 결과 |
|---|---|
| 응답이 정확히 이미지 1장 | ok |
| asset host가 fal CDN | ok — `v3b.fal.media` |
| 배달 MIME이 저장 허용 목록 | ok — `image/png` |
| 허용 host를 벗어나는 리다이렉트 없음 | ok — HTTP 200 |
| 선언 길이가 상한 이내 | ok — 1,618,675 / 16,777,216 |
| 실제 크기가 상한 이내 | ok — 1,618,675 bytes |
| **배달된 이미지가 가격 책정한 크기** | **ok — 1024×1024** |

마지막 항목이 핵심입니다. fal 스키마의 `aspect_ratio` 기본값은 `"auto"`("프롬프트를
보고 모델이 정한다")이므로, 고정하지 않았다면 1024×1024로 팔고 다른 모양을 받는
일이 조용히 일어났을 것입니다.

`asset.reportedWidth`·`reportedHeight`는 `null`입니다. fal이 이 응답에 치수를
싣지 않았다는 뜻이고, 무해합니다 — adapter는 응답의 필드가 아니라
`readImageDimensions()`로 **바이트 헤더에서** 읽어 비교하므로 검사가 무력화되지
않습니다.

## 실제 청구액

`x-fal-billable-units: 1.025`.

```
1.025 units × 80,000 µUSD/unit = 82,000 µUSD
                               = 80,000 (1K 이미지) + 2,000 (high thinking)
```

정책 §16.4의 fal 측 항목 두 개와 **정확히** 일치합니다. 0.025 단위가 곧 공표된
$0.002 high-thinking 할증입니다. `check:fal-image-pricing`은 fal의 pricing API가
단가 하나만 답하기 때문에 이 할증을 "비교하지 않았다"고 명시하는데, 이 실측이 그
공백을 메웠습니다.

승인 최악값 87,000 µUSD 중 나머지 5,000은 `IMAGE_PROMPT_BUDGET_MICRO_USD`로,
fal의 과금 항목이 아니라 모든 모델의 바닥값에 동일하게 얹는 여유분입니다.
판매 120크레딧의 상한(108,000 µUSD)과도 여유가 있습니다.

웹 검색 할증($0.015)도, 재시도로 인한 2회 과금도 발생하지 않았습니다. 요청이
`enable_web_search: false`를 보내고 `X-Fal-No-Retry: 1`을 붙인 결과가 청구액에서
확인됩니다.

## 이 기록이 담지 않은 것

- **1회 실행입니다.** 신뢰성·성공률·지연 분포에 대해 말하지 않습니다. 소요
  18,783 ms는 관측 1건이지 성능 특성이 아닙니다.
- **1K·PNG·1:1·high thinking 조건만** 증명합니다. 2K·4K는 fal이 1.5배·2배로
  과금하며 별도 가격 검증과 승인 대상입니다(§16.5).
- **가격 drift는 다루지 않습니다.** 그것은 `check:fal-image-pricing`이 하고,
  `FAL_KEY`가 필요해 수동 실행입니다.
- 프롬프트는 digest로만 남습니다(§10). asset URL은 만료 전까지 공개 접근 가능한
  실제 링크이므로 host와 path 깊이로만 기록합니다.
