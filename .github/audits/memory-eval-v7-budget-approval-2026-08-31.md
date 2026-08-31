# `gpt-5-6-luna::mem-extract-v7` decision-grade eval 예산 승인

**상태: 승인됨 (2026-08-31).** 승인자 `@mposition`.

이 문서는 `lib/memoryExtractionEvalRegister.ts`의 `evalBudget`가 가리키는
ticket입니다. register의 숫자와 digest는 여기 적힌 것과 같아야 하며,
`tests/memoryEvalBudgetBinding.test.mjs`가 tree와 대조합니다.

## 1. 승인된 실행 대상

| 항목 | 값 |
| --- | --- |
| model | `gpt-5-6-luna` |
| prompt | `mem-extract-v7` |
| prompt digest | `7ec5e591628ad719be7f13faf850a537c6f77cfcb22cc50471a245bee7beb912` |
| dataset | `mem-eval-succ-6` |
| dataset digest | `2ffc8c09d6a20c2ad150d222fd71b891bf160b6c26b4d27684708ccbcf20fb63` |
| dataset manifest digest | `b1904682a2920a6554f533001a2b59cbd2d4cdc06b517aa2b53588c094ce603d` |
| scoring contract | `mem-score-v3.4` |
| scoring contract digest | `a62f4bdd8d2073345e19e478541c20d81275a0d11fb78aa6e4df86ec0489b4cd` |
| approved implementation SHA | `51bebe56fb9833f9a8209fd9ca32aa499865d3d4` |

approved SHA는 PR #1220(harness를 succ-6으로 전환)의 병합 commit이며, 위 tuple의
일곱 값을 그 commit에서 직접 읽어 확인했습니다.

**실행 SHA는 이 SHA의 후손이어야 합니다.** 등식은 요구하지 않지만, git이 조상
관계를 확인하지 못하면 fail-closed로 거절합니다 — 2026-08-29에 `fetch-depth: 1`
때문에 승인 commit이 clone에 없어 `run_sha_not_descendant`가 났던 것이 이
조건입니다.

## 2. 예산

| 항목 | 값 |
| --- | --- |
| 실행별 상한 | US$6.39 |
| 승인된 provider-dispatched 실행 | 최대 2회 |
| 프로그램 총상한 | US$12.78 / 12,780,000 microUSD |
| `runOrdinal=1` | 최초 decision-grade 실행 |
| `runOrdinal=2` | §12.4 독립 재현 실행 |

**실행별과 프로그램은 다른 숫자입니다.** `accruedCostUsd`는 호출마다 0에서
시작하므로 `maxUsd`는 한 invocation의 상한이고, 프로그램 총액을 거기 적으면 두 번
쓸 수 있게 됩니다. 12.78은 `npm run report:memory-eval-cost-estimate`의 최악값
(1,150 case × 4,096 토큰 출력 상한 × 2회)이고, 6.39는 그 절반입니다. 반올림하지
않았습니다 — 올림한 상한은 아무도 계산하지 않은 상한입니다.

## 3. 실행 개시는 별도 지시입니다

**두 회차의 예산을 승인하지만 실행을 자동으로 개시하지 않습니다.** 각 회차는
별도의 명시적 실행 지시가 있어야 하고, 2회차는 1회차 artifact와 blind review를
확인한 뒤에만 지시합니다.

같은 ordinal 재개는 **provider dispatch 이전에 실패했고 provider 미접촉·비용
US$0가 증명된 경우에만** 허용합니다. Provider에 도달한 실행은 결과와 무관하게
승인 회차를 소비하며, 추가 실행·상한 증액·자동 재시도는 별도 승인이 필요합니다.

## 4. 결속 및 이전 금지

위 dataset·manifest·contract·prompt의 version 또는 digest 중 **하나라도 달라지면
이 승인은 즉시 효력을 잃습니다.** 판정은 `evalBudgetTupleFailures()`가 하고,
비교 대상은 `harnessRunTuple()`이 만드는 production tuple입니다.

미사용 예산은 다음으로 **이전하지 않습니다** — 다른 model, 다른 promptVersion,
다른 datasetVersion, 다른 scoring contract, `gpt-5-4-mini`, v6 또는 이후 prompt.

## 5. 승인 범위 밖

- 유료 실행 자동 개시
- pair의 `approved` 전환 (`status`는 `candidate` 유지)
- `gpt-5-4-mini::mem-extract-v7` 등록 또는 예산
- release gate 전환
- staging·production 활성화
- `memoryExtractionEnabled` · `memoryInjectionEnabled` 변경
