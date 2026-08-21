# 이미지 생성 — 활성화 이후 남은 작업

`feature.imageGenerationEnabled`는 2026-08-20T00:59Z에 production에서 켜졌습니다
(`.github/audits/image-generation-activation-2026-08-20.md`). 이 문서는 **그
활성화가 덮지 않은 것**을 다음 세션이 그대로 집어 들 수 있게 적어 둔 목록입니다.

활성화까지의 회차는 **되돌릴 수 없는 것 — 돈**에 집중했습니다. 가격, 예약,
이중 과금, provider별 예산 귀속은 staging과 production 양쪽에서 실측으로
닫혔습니다. 아래는 전부 그 바깥이며, 대부분 **한 번도 실행된 적이 없는 경로**
입니다.

우선순위는 "틀렸을 때 사용자가 돈을 잃는가"로 매겼습니다.

---

## 1. 부분 실패 — 실행된 적 없음 (최우선)

**상태:** 코드 근거로만 종결. staging에서 provider 실패를 만들 수단이 없었고,
그 판단은 2026-08-19에 `@mposition`이 내렸습니다.

**왜 남았나:** 계약은 "한쪽이 실패해도 성공한 결과가 유지되고, 실패한 attempt의
예약만 환급된다"입니다. 코드는 `lib/imageGenerationService.ts:1033`·`:1051`에서
`settledCredits: 0`(전액 환급, 부분 환급 없음)으로 되어 있습니다. **읽은 것이지
실행한 것이 아닙니다.**

**다음에 할 일:** 실사용에서 첫 provider 실패가 발생하면 admin에서 확인합니다.

```
generations.failuresByPhase           어느 단계에서 실패했는지
해당 ImageCreditReservation           settledCredits 0, refundedAt 채워짐
같은 그룹의 성공한 target             영향 없음, 카드 유지
provider 예산 버킷                    실패한 예약분이 남아 있음(의도적)
```

마지막 줄이 반직관적이므로 미리 적어 둡니다 — `finalizeFailure`는
`releaseProviderBudget: false`입니다. **provider가 이미 청구했을 수 있으므로
보수적으로 예산 부담을 유지**합니다. 크레딧은 환급하고 예산은 유지하는 것이
설계이며, 결함이 아닙니다.

실패를 기다리는 대신 만들고 싶다면, staging에서 provider 키를 일시적으로 잘못된
값으로 두는 방법이 있습니다. **production에서는 하지 않습니다.**

## 2. 재시도와 취소 — 실행된 적 없음

체크리스트 §E입니다. 확인된 것은 **"성공한 target에 재실행 버튼이 없다"** 하나
뿐이고(카드에 `원본 보기`·`다운로드`만 있음), 나머지는 실패 카드가 없어서 실행
자체가 불가능했습니다.

- 실패 카드에 사유와 환급이 함께 표시되는가
- 재시도하면 **같은 카드가 교체**되고 항목 수가 늘지 않는가
- 취소가 lease를 결정적으로 해제하는가

1번과 같은 조건(실패 한 건)에서 함께 봅니다.

## 3. `PROVIDER_BUDGET_EXHAUSTED` — 실행된 적 없음

production 한도는 openai·xai 일 50,000,000 / 월 500,000,000, fal 일
12,000,000 / 월 50,000,000입니다. 오늘 사용량이 openai 53,045로 일 한도의
0.1%이므로 **정상 사용으로는 도달하지 않습니다.**

staging에서는 일·월이 같은 값(10,800,000)이라 창이 사실상 하나입니다. 그 상태를
이용해 한도를 낮춰 소진 경로를 밟는 것이 가장 싼 방법입니다.

볼 것: 거절이 행도 비용도 남기지 않는지, 오류 코드가
`PROVIDER_BUDGET_EXHAUSTED`인지(entitlement 오류와 섞이지 않아야 함),
`resetAt`이 생성 시점보다 미래인지.

## 4. 동시성 한도 — 실행된 적 없음

정책 §12의 두 층입니다 — workflow(활성 그룹 수)와 execution(provider별 job 수).
어느 쪽도 실행하지 않았습니다. 그룹을 여러 개 동시에 제출해야 관측됩니다.

## 5. `orphanedReservations` production 확인 — **닫힘 (2026-08-20)**

`#683`(일곱 번째 invariant)이 `#687` 승격으로 production에 배포됐습니다
(`c823fc853b8d7b918e5a5d690d67b4623ea6667f`, deployedAt 2026-08-20T04:31:49Z).

```
/admin/providers?tab=usage-cost  →  Image generation  →  Invariants
clean
0 empty conversations · 0 stale (0 stranded mid-settlement) · 0 cleanup backlog
· 0 thumbnails queued (0 exhausted) · 0 orphaned reservations holding $0.00
```

**0입니다.** 활성화 전 기준선에서 예약 총액이 provider별 최악 원가로 정확히
분해된다는 산술(`openai 2×58,000 + xai 55,000 + fal 87,000 = 258,000`)이 이제
관측으로 바뀌었습니다. production에는 staging의 blind spot이 없습니다.

**계속 볼 값입니다.** 0이 아니게 되는 순간이 곧 "생성이 중간에 죽고 그 대화가
지워졌다"는 신호이며, 그때는 행을 열어 봅니다 —
`docs/ops/image-generation-staging-verification-records/2026-08-19__6fb0a9e7148fc93a15340f1348285bec37639513.md`
§발견-4에 staging에서 같은 일을 한 SQL과 절차가 있습니다.

## 6. staging에 남은 116,000 µUSD와 예약 2건

**staging 이야기입니다.** 2026-08-03에 만들어진 예약 2건이 generation 없이
`reserved` 상태로 남아 openai 버킷에 116,000 µUSD를 붙들고 있습니다.
`accepted`로 처리했고 보정하지 않았습니다.

남은 결정: **환급 경로를 만들 것인가.** 만든다면 1번의 보수적 판단
(`releaseProviderBudget: false`, provider가 청구했을 수 있음)이 여기에도
적용되는지 먼저 정해야 합니다. 16일 지난 예약에 대해서는 그 논거가 약하지만,
"얼마나 지나면 청구되지 않았다고 볼 수 있는가"는 저장소가 답할 수 없는 사실
입니다.

## 7. 남은 drift 두 건 (조치 없음, 관찰만)

```
production   openai −12,000 · xai +5,000 · fal +7,000    총액은 정확
staging      116,000 (위 6번)
```

둘 다 `accepted`입니다. **월 경계(2026-09-01 UTC)가 효과를 끝내며 수치를 고치지
않습니다.** 9월 1일 이후 새 월 버킷이 정산 합계와 일치하는지 한 번 확인하면
이 항목은 닫힙니다.

## 8. 체크리스트에서 실행하지 않은 구획

`docs/ops/image-generation-staging-checklist.md` 기준입니다.

| 구획 | 상태 |
|---|---|
| A. Fail-closed (flag off) | **미실행.** flag가 꺼진 상태에서 `POST /api/images/generations`에 직접 요청해 거절되고 행이 안 생기는지. 지금은 flag가 켜져 있어 끄지 않으면 못 합니다 |
| B. 멀티 모델 fan-out | 실행 완료 (staging·production 양쪽) |
| B2. 부분 실패 | **미실행** — 위 1번 |
| C. 진입점 네 곳 | **1/4.** 사이드바 split button만 확인. 모바일 드로어 행, 컴포저 도구 메뉴(작성 중 텍스트 이월 + "채팅으로 돌아가기"가 draft 복원), 카탈로그 이미지 탭이 남았습니다 |
| D. 잠금 노출 | Guest·Free staging 확인. **production에서는 Guest만** 확인 |
| E. 재시도 | **1/3** — 위 2번 |
| F. 자산과 라벨 | AI 생성 라벨만 확인. **R2 key 미노출, signed URL이 DB에 저장되지 않음, 만료된 카드의 단일 복구 endpoint**는 미확인 |
| G. 이미지 대화의 금지 사항 | **미실행.** AI Review가 이미지 대화에서 안 나오는지, 비교 action rail이 마운트되지 않는지 |
| H. 관측 | 실행 완료 |

C·F·G는 **돈과 무관하고 브라우저에서 몇 분이면 끝납니다.** 다음 세션의 가장
싼 항목입니다.

## 9. 모바일 320px와 ko/en

이미지 workspace는 모바일에서 한 번도 열어보지 않았습니다. UI 계약이 요구하는
것 — textarea가 전용 full-width 행을 갖고, 어떤 컨트롤도 그 행을 나눠 쓰거나
겹치거나 위에 뜨지 않음 — 은 `tests/e2e/image-generation-workspace.spec.ts`가
desktop·mobile 양쪽에서 지키게 되어 있습니다. **E2E는 있고 사람 눈은 없습니다.**

## 10. 3모델 그룹

production `IMAGE_GROUP_MAX_MODELS`는 **2**입니다(환경변수 미설정, 기본값).
3모델 비교를 원하면 `docs/ops/image-group-max-models-activation.md`의 절차를
따릅니다. 예산 영향이 있으므로 별도 결정입니다.

## 11. Google 3모델 hold

`gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`가
`worst_case_cost_unbounded`로 비활성입니다. **가격은 검증됐고 막힌 것은 상한**
입니다 — 공식 문서에 "출력 + thinking 토큰 합계에 대한 유한한 요청당 상한"이
없다는 것이 2026-08-05에 *확인된 부재*로 종결됐습니다.

푸는 방법은 문서를 더 읽는 것이 아니라 **측정**입니다. `max_output_tokens`를
낮게 잡고 `total_output_tokens + total_thought_tokens`가 그 아래에 머무는지
staging에서 보는 실행이며, 과금되므로 정책 §15의 예산 승인이 필요합니다.
`gemini-3.1-flash-lite-image`(상한 4,096)가 가장 먼저 측정할 값입니다 — 낮은
상한이 실제로 물릴 가능성이 크기 때문입니다.

## 12. 코드 정리 두 건

- **`releaseProviderBudget: true`가 도달 불가입니다.** 네 호출부가 모두 `false`
  이며 `true`를 주는 경로가 없습니다. 죽은 분기로 남길지, 지울지, 아니면 6번의
  환급 경로가 쓸 자리로 둘지 결정이 필요합니다
- **DB 테스트 헬퍼 분리** — `@mposition`이 2026-08-18에 처방한 리팩터입니다.
  `openAiDraftRequestInput()` / `comparisonRequestInput()`로 역할을 나누고 실제
  `Partial<>` 타입을 붙입니다. 기본값을 `medium`으로 바꾸는 방식은 **거부됐습니다**

## 13. `dimensionCoverage` staging openai 7/6

staging에 치수가 기록되지 않은 과거 성공 1건이 있습니다. 격차는 이 회차 내내
1로 고정이었고 새로 생기지 않았습니다. production에는 없습니다(3/3, 2/2, 2/2).

데이터 손실도 과금 영향도 아닙니다. 원인은 규명하지 않았습니다 — 치수 기록이
실패한 것인지 그 세대가 치수를 낼 수 없는 경로였는지 구분하려면 해당 행을
봐야 합니다.

## 14. staging 정리 의무 (미기재)

`docs/ops/image-generation-staging-verification-records/2026-08-19__6fb0a9e7148fc93a15340f1348285bec37639513.md`의
정리 의무 칸이 비어 있습니다. staging 계정에 이 회차의 이미지가 남아 있습니다.

```
staging 데이터 삭제 (UTC):   ____________________
로컬 파일 정리 (UTC) / 확인자: ____________________
```

합성 프롬프트만 썼으므로 개인 데이터는 없습니다. 삭제 후 시각을 적으면 됩니다.

---

## 다음 세션에 권하는 순서

1. **C·F·G 구획** — 브라우저에서 몇 분, 돈과 무관, 가장 싼 미확인 계약
2. **모바일 320px** — 이미지 workspace를 실제로 열어보기
3. **부분 실패 한 건** — staging에서 provider 키를 일시 무효화. 1번과 2번을
   한 번에 닫습니다
4. 나머지는 결정이 선행됩니다 (6·10·11·12)

§5는 2026-08-20에 닫혔습니다.

## Related

- `.github/audits/image-generation-activation-2026-08-20.md` — 활성화 실행
- `.github/audits/image-generation-exposure-readiness-2026-08-16.md` — 활성화 전 시점 기록
- `docs/ops/image-generation-staging-verification-records/2026-08-19__6fb0a9e7148fc93a15340f1348285bec37639513.md` — staging 검증
- `docs/ops/image-generation-staging-verification-records/2026-08-20__cc2614d80d1631f60057c2feaaed50ead1457024.md` — production 기준선
- `docs/ops/image-generation-staging-checklist.md`
- `docs/ops/image-group-max-models-activation.md`
- `docs/policy/image-generation.md`
- `docs/ui-contracts/image-generation-workspace.md`
