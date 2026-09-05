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
측정된 mean prompt tokens     3,654 (succ-9의 1,150 case)
per-call output ceiling      4,096
runs                         2  (§12.4 독립 재실행)

input only, 2회 합계          US$1.68        측정값
output 1,024 토큰 가정, 2회    US$4.51        가정값 — 아무도 측정한 적 없음
모든 답변이 상한에 닿으면, 2회  US$12.99       최악값
```

**상한은 가정이 아니라 최악값에서 잡습니다.** 정상 동작하는 실행은 그 아래에
있고, 그렇지 않은 실행이야말로 상한이 존재하는 이유입니다. 상한에 걸려 잘린
실행은 decision-grade가 아니므로, 승인할 숫자는 US$12.99이지 US$4.51이
아닙니다.

- **회차당 US$6.495** — `maxUsd`. `accruedCostUsd`는 매 호출마다 0에서
  시작하므로, 여기에 프로그램 총액을 적으면 그 금액이 두 번 쓰입니다.
- **프로그램 총액 US$12.99** = `programmeMaxMicroUsd: 12_990_000`.
- 반올림하지 않습니다 — 올림한 상한은 아무도 계산하지 않은 상한입니다.

이 추정에 **포함되지 않는 것**: 블라인드 검토 세트 생성, 실패 후 재실행,
공급자 측 반올림. 그리고 채택된 dataset의 평균 프롬프트 길이로 계산하므로 더 긴
대화는 더 비쌉니다.

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
    maxUsd: 6.495,
    programmeMaxMicroUsd: 12_990_000,
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
