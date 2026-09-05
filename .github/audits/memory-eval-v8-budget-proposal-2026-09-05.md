# `gpt-5-6-luna::mem-extract-v8` 유료 평가 예산 승인안 (2026-09-05)

**이 문서는 제안이지 승인이 아닙니다.** 승인은 `@mposition`이
`lib/memoryExtractionEvalRegister.ts`의 해당 항목에 §5의 블록을 써 넣고 별도
변경으로 병합하는 행위이며, 그 commit이 감사 기록입니다. 이 문서는 그때 **옮겨
적을 값**을 전부 담아, 승인이 계산이 아니라 전사(轉寫)가 되게 하는 것이
목적입니다.

pair는 2026-09-05에 **candidate로 등록**됐고 예산은 비어 있습니다. 그래서 지금
`--live`는 거절되며, 거절 사유가 `unknown_pair`에서 예산 부재로 **옮겨 갔을
뿐**입니다.

## 1. 무엇을 처음 재는가

**v8과 succ-9에서 실제 모델이 §12.3 기준을 충족하는지는 아직 아무도 모릅니다.**
바뀐 것은 계측기이지 판정이 아닙니다.

v7은 미완의 측정이 아니라 **기록된 실패**입니다 — precision Wilson lower
0.7123(기준 0.95), recall 0.7268(기준 0.85), critical bulk-safe adoption
20건(기준 0). 40건 블라인드 검토(@mposition)는 그 판정을 뒤집을 실행·채점 결함을
찾지 못했습니다(`.github/audits/memory-eval-v7-run1-blind-review-2026-09-01.md`).

그 사이에 움직인 것은 셋입니다.

| | v7 시점 | 지금 |
| --- | --- | --- |
| prompt | `mem-extract-v7` | `mem-extract-v8` (EN/KO 완결형 negated 예시 2개) |
| dataset | `mem-eval-succ-6` | `mem-eval-succ-9` (B+ 5건 퇴역, repair 1건) |
| contract | `mem-score-v3.4` | `mem-score-v3.5` (한국어 숫자 정규화 개정) |

**이 표는 개선을 예측하지 않습니다.** 세 변경 모두 각자의 결함을 고친 것이고,
그것이 모델의 점수를 기준 위로 올린다는 근거는 어디에도 없습니다. run 1이 그
첫 측정입니다.

## 2. 예산 근거

`npm run report:memory-eval-cost-estimate`를 succ-9에서 실행한 값입니다.

```
가격 출처                     registry
input                        US$0.2 / 1M tokens
output                       US$1.2 / 1M tokens
측정된 mean input tokens      3,935 (succ-9의 1,150 case)
  그중 JSON schema             281   — 모든 요청에 실림
per-call output ceiling      4,096
runs                         2  (§12.4 독립 재실행)

input only, 2회 합계          US$1.81        측정값
output 1,024 토큰 가정, 2회    US$4.64        가정값 — 아무도 측정한 적 없음
모든 답변이 상한에 닿으면, 2회  raw 13.1149804
```

**상한은 가정이 아니라 최악값에서 잡습니다.** 가정은 답변 길이에 관한 것이고,
상한은 그 가정대로 동작하지 않는 실행을 위해 존재합니다. 그러므로 승인할
숫자는 최악값 쪽이지 US$4.51이 아닙니다.

**다만 "정상 실행은 이 상한을 넘을 수 없다"는 참이 아닙니다.** 두 가지 이유로
그렇고, 둘 다 아래에서 다룹니다 — 토큰 수가 공급자 tokenizer가 아닌 추정값이라는
것(§2.3), 그리고 harness가 상한을 **다음 호출 직전에만** 비교한다는 것(§2.4).

### 2.1 첫 판의 US$12.99는 두 가지가 틀렸습니다

**(가) 표시용 반올림이었습니다.** 12.99는 estimator가 `toFixed(2)`로 찍은
표시값이고, `toFixed`는 가장 가까운 값으로 반올림하므로 **내려갈 수
있습니다.**

```
raw 회차당      6.4928602      →  toFixed(2) 표시  US$6.49   ← 최악값보다 낮음
raw 2회 합계    12.9857204     →  toFixed(2) 표시  US$12.99  ← 이번엔 올라감
```

회차당 표시값이 자기가 덮어야 할 최악값보다 낮았습니다. 사고가 나지 않은 것은
제안값이 2회 합계였고 그 값이 **우연히** 올림 방향이었기 때문입니다.

첫 수정에서 쓴 올림 함수 `Math.ceil(v * 100 - 1e-9) / 100`도 틀렸습니다 —
부동소수 잡음을 흡수할 만큼 큰 epsilon은 **센트 경계 바로 위의 값을 그 경계로
끌어내릴** 만큼도 큽니다. 일부 입력을 내리는 올림 함수는 올림 함수가 아니므로
epsilon을 없앴습니다. 센트 하나 높게 잡히는 쪽이 안전한 방향입니다.

**(나) 요청의 JSON schema 비용이 빠져 있었습니다.** `memoryExtractionProvider`가
`Output.object({ schema, name })`를 `strictJsonSchema`로 보내므로 schema는 요청의
일부이고 **매 호출 input으로 청구됩니다.** estimator는 `prompt.system`과
`prompt.user`만 셌습니다.

```
schema JSON        1,061자 → 로컬 estimator 추정 281 tokens (name·strict 포함)
                   공급자 계측값이 아닙니다
case당 input       3,654 → 3,935   (+7.7%)
회차당 최악값       6.4928602 → 6.5574902   (+US$0.065)
```

schema는 상수로 박지 않고 같은 estimator로 셉니다 — 출력 계약이 바뀌면 schema도
바뀌고, 여기 적어 둔 숫자는 그때부터 아무도 보내지 않는 요청을 설명하게 됩니다.

### 2.2 그래서 승인할 숫자

여유 0으로 잡으면 이 값입니다. **권고값은 아닙니다** — §2.3을 보십시오.

```
회차당 US$6.56   = ceil(6.5574902)     여유 0
2회   US$13.12   = 6.56 × 2
```

**프로그램 총액은 raw 총액을 한 번 반올림한 값이 아니라 회차 상한 × 회차 수**
입니다. `findEvalRegisterProblems()`가 `maxUsd × maxProviderDispatchedRuns >
programmeMaxMicroUsd`를 거절하므로, 양 끝을 따로 반올림하면 US$6.56 × 2 =
US$13.12 > ceil(13.1149804) = US$13.12 … 이번에는 같지만, 일반적으로는
**아무도 의도하지 않은 산술 때문에** 거절당할 수 있습니다. 그래서 리포트가 총액을
회차 상한에서 유도해 찍고, 테스트가 그 관계를 고정합니다.

`accruedCostUsd`는 매 호출 0에서 시작하므로 `maxUsd`에 프로그램 총액을 적으면
그 금액이 두 번 쓰입니다.

### 2.3 이 상한이 덮지 않는 것 — 그리고 여유가 얼마나 좁은지

```
회차당 상한 US$6.56  −  raw 최악값 6.5574902  =  US$0.0025098
                                            ≈  case당 input 10 토큰
```

**이것은 반올림 여유이지 오차 여유가 아닙니다.** 그리고 위 토큰 수는
**추정값**입니다 — 이 script는 공급자의 tokenizer로 세지 않고, 파일 스스로 그렇게
적습니다. 그러므로 "정상 실행은 이 상한을 초과할 수 없다"는 **현재 성립하지
않습니다.** 정직한 주장은 더 좁습니다: 이 값은 **이 script가 계산하는 최악값
모형**을 덮습니다.

estimator 오차를 위해 그 위에 여유를 더 둘지는 **판단이고, 예산을 승인하는
사람의 것**입니다.

**그런데 첫 판은 그 판단을 이미 대신 내려 두었습니다.** §2.3이 "여유는 승인자의
판단"이라고 적어 놓고 §5의 블록에는 `maxUsd: 6.56`이 박혀 있어서, 빈칸은
날짜뿐이었습니다. 선택지가 하나뿐인 곳에 선택이라고 적는 것은 선택을 준 것이
아니라 **여유 0을 기본값으로 정해 놓고 그렇게 부른 것**입니다.

그래서 세 값을 나란히 적고, §5는 권고값을 담습니다.

| | 회차당 | 2회 | 모형 최악값 대비 |
| --- | --- | --- | --- |
| 모형 최악값 (raw) | 6.5574902 | 13.1149804 | — |
| 여유 0 (센트 올림) | US$6.56 | US$13.12 | +0.04% |
| **권고** | **US$7.00** | **US$14.00** | **+6.75%** |

권고값 US$7.00은 검토자(@mposition)의 값이고 근거는 estimator 오차입니다. 모형
최악값보다 6.75% 높고, **추정 input 비용 기준으로는 약 49%의 여유**입니다 —
input이 회차당 US$0.905이므로, 이 estimator가 공급자 tokenizer보다 input을 그만큼
적게 세고 있어도 상한 안에 들어옵니다.

**그래도 공급자 청구의 절대 상한은 아닙니다.** output 쪽이 상한에 닿는 최악
경우를 이미 가정한 값이므로 output 오차에는 여유가 이만큼 없고, §2.4의 이유로
harness가 마지막 호출을 상한과 비교하지 못합니다.

리포트도 같은 문장으로 고쳤고, `tests/memoryEvalCostCeilingRounding.test.mjs`가
"cannot exceed it"이 **인용부호 안에서만** 나타나는지 검사합니다 — 철회한 주장이
철회 문장과 함께 지워지지 않도록.

함께 포함되지 않는 것: 블라인드 검토 세트 생성, 실패 후 재실행, 공급자 측
반올림, 그리고 이 estimator와 공급자 tokenizer의 차이. 채택된 dataset의 평균
프롬프트 길이로 계산하므로 더 긴 대화는 더 비쌉니다.

### 2.4 `maxUsd`는 hard ceiling이 아닙니다

**harness는 상한을 다음 호출 직전에만 비교하고, 비용은 응답이 온 뒤에 더합니다.**
그래서 **한 실행의 마지막 호출은 상한과 비교되지 않습니다.** 마지막 응답이
상한을 넘겨도 `costStopped`는 false로 끝나고, 그 실행이 decision-grade로
보고될 수 있었습니다.

최소한의 방어를 넣었습니다 — 루프가 끝난 뒤 `accruedCostUsd > ceiling`이면
`exceededCostCeiling`으로 기록하고 **decision-grade를 거절**합니다. 요약에도
`OVER CEILING`으로 찍습니다.

**이것은 지출을 막지 않습니다.** 관측되는 시점에 돈은 이미 나갔습니다. 막으려면
**다음 호출의 비용을 dispatch 전에 예약**해야 하고, 그 예약값은 정확도가 지금
문제가 되고 있는 바로 그 estimator에서 나옵니다. 그것은 이 문서가 조용히 넣을
변경이 아니라 별도로 결정할 설계입니다.

그러므로 승인하는 숫자의 성격은 이렇습니다.

- **`maxUsd`는 실행을 조기에 중단시키는 임계값**입니다 — 호출과 호출 사이에서만.
- **초과 자체는 사후에 감지되어 인용을 막습니다** — 지출을 막지는 않습니다.
- **공급자 청구의 절대 상한은 아무 값도 아닙니다.**

## 3. 실행 순서 — 두 회차를 함께 돌리지 않습니다

```
1. run ordinal 1 만 실행
2. 자동 점수 + 블라인드 검토 확인
3. 명백한 실패면 여기서 중단 — ordinal 2는 실행하지 않음
4. 승인 가능성이 있을 때만 독립적인 ordinal 2 실행
5. 두 결과가 재현되면 pair를 approved로 전환
6. staging과 release gate를 통과한 뒤 extraction flag부터 제한적으로 ON
7. injection flag는 별도 검증 후 마지막에 ON
```

**ordinal 2는 재시도가 아니라 재현입니다.** 1회차가 구조적 실패나 명백한 미달을
보이면 만들지 않습니다 — 그것이 v7에서 실제로 내려진 결정이고, 그때 "run 2는
승인되지 않았다"가 감사 문서에만 있었기 때문에 `status`를 `revoked`로 닫아야
했습니다.

`maxProviderDispatchedRuns`는 **절반만 강제됩니다.** 이 저장소는 실행 원장을
갖고 있지 않으므로 회차를 셀 수 없습니다. 강제되는 것은 live 실행이 자기가 몇
번째인지(`--run-ordinal`) 말해야 하고 그 숫자가 승인 범위 안이어야 한다는
것뿐이고, 나머지는 위 절차와 운영자의 지시입니다.

## 4. 블라인드 검토에서 특별히 볼 것 — §4.14 부분 문자열 잔여

`.github/audits/memory-eval-korean-numeral-amendment-2026-09-03.md` §4.14의
관찰입니다. **차단 사유가 아니라 이름 붙인 관찰 항목**으로 들고 갑니다.

숫자 표기 gold는 이미 정규형이라 규칙 없이 부분 문자열로 candidate에 닿습니다.
그래서 `9시` gold가 `시장`·`시간`·`시절`처럼 그 counter로 시작하는 **무관한
명사**를 통해 매칭됩니다. 한국어 숫자 규칙에 오른쪽 경계를 붙여도 막히지
않습니다 — 그 규칙은 **치환만** 제약하기 때문입니다. matcher 차원의 열린
질문이고, succ-9에도 그대로 있습니다.

검토자가 볼 것: 한국어 arm에서 **숫자·단위 gold가 매칭됐는데 그 매칭이 무관한
명사를 통해 일어난 case**가 있는지. 있다면 그 건수와 case id를 기록에 남깁니다 —
점수를 사후에 고치기 위해서가 아니라, matcher 질문에 실제 데이터를 붙이기
위해서입니다.

## 5. 승인 시 옮겨 적을 블록

`lib/memoryExtractionEvalRegister.ts`의 `gpt-5-6-luna::mem-extract-v8` 항목에서
`evalBudget: null`을 아래로 교체합니다. `ticket`은 이 문서이고, `approvedAt`은
승인한 날입니다.

```ts
evalBudget: {
    approvedBy: "@mposition",
    // 권고값: 모형 최악값 6.5574902 위에 estimator 오차 여유를 둔 값입니다.
    // 여유 0이면 6.56 / 13_120_000이고, 그 선택은 §2.3에 나란히 적혀 있습니다.
    maxUsd: 7.0,
    programmeMaxMicroUsd: 14_000_000,
    ticket:
        ".github/audits/memory-eval-v8-budget-proposal-2026-09-05.md",
    approvedAt: "2026-09-__",
    maxProviderDispatchedRuns: 2,
    approvedImplementationSha:
        "3503cd10c47a8a9e51b0766b1b52ee1d5f3ca3d7",
    boundTuple: {
        datasetVersion: "mem-eval-succ-9",
        datasetDigest:
            "626f71362046b7d88df9dbb07e2f51fa0e908c78192f74bd837fa88e9ce1d4e6",
        datasetManifestDigest:
            "82d9aa48fe96037b7493dae26594a73482d7ba4a915532caffc9be411085f40c",
        scoringContractVersion: "mem-score-v3.5",
        scoringContractDigest:
            "2d4bcb696c2dd87d586ab30bb8308c567b3ef3f57b0b17f6ff99e10de0cc33d4",
        promptVersion: "mem-extract-v8",
        promptDigest:
            "a1d804c6b9359b722c60b1309c7324176f72c54008d2a616fa78dd520a6b44ae",
    },
},
```

**일곱 항목 전부 이 트리에서 읽은 값입니다.** `harnessRunTuple()`이 지금 조립하는
것과 같고, `evalBudgetTupleFailures()`가 실행 시점에 다시 대조합니다 — 하나라도
어긋나면 유료 실행이 거절됩니다.

`approvedImplementationSha`는 **PR #1255의 merge commit**입니다. 실행의 commit은
이것의 **후손**이어야 하고 같아서는 안 됩니다 — 등록 PR은 자기 merge SHA를 담을
수 없고, 같은 계측기를 조립하는 이후 commit은 여전히 승인된 것을 실행하는
것입니다.

## 6. 이 승인이 하지 않는 것

- **pair를 approved로 만들지 않습니다.** candidate → approved는 §12.4의 사람
  절차(decision-grade eval, 블라인드 검토, 독립 재실행, 승인자 서명)이며 이
  예산은 그 첫 단계를 열 뿐입니다.
- **flag를 켜지 않습니다.** `memoryExtractionEnabled`·`memoryInjectionEnabled`는
  둘 다 OFF이고, 런타임 유효성은 register 승인보다 좁습니다 — approved ∧
  extraction flag ∧ 검증된 가격 ∧ 플랜 허용 ∧ promptVersion 일치 ∧ 운영 취소
  없음.
- **release gate를 통과시키지 않습니다.**
- **두 회차 실행을 지시하지 않습니다.** §3의 순서가 그 자체로 절차이고, ordinal
  2는 사람이 1회차를 읽은 뒤에 결정합니다.
