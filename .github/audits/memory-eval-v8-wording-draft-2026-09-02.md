# mem-extract-v8 문안 초안과 B+ 근거 목록 — 2026-09-02

승인 범위는 **v8 문안 초안과 B+ 근거 목록까지**입니다. `mem-extract-v8`
구현, successor dataset 작성·동결, 새 pair·예산·유료 실행은 포함하지
않습니다. 이 문서는 아무것도 구현하지 않았고 `lib/memoryExtractionPrompt.ts`도
건드리지 않았습니다.

## 1. 문안 초안

`MEMORY_EXTRACTION_POLARITY_RULE`의 규칙 문장은 **바꾸지 않습니다.** run #13이
보여 준 것은 규칙이 틀렸다는 것이 아니라 규칙만으로는 지켜지지 않는다는
것이었습니다(44/44 한 방향). 그래서 추가하는 것은 **완결된 예시**뿐이고,
scorer 기준도 완화하지 않습니다.

규칙 끝에 이어 붙일 문안입니다.

> Two complete answers, one in each language. In both, the statement says the
> thing is not so of the user, so the polarity is `negated` — the negation
> lives in the statement and in the field together, never in only one of them.
>
> ```json
> {
>   "kind": "expertise",
>   "polarity": "negated",
>   "statement": "The user has no experience flying a drone.",
>   "confidence": 0.9,
>   "sensitivity": "standard",
>   "expiresAt": null,
>   "evidence": [
>     { "messageLabel": "M2", "quote": "I have never flown a drone" }
>   ]
> }
> ```
>
> ```json
> {
>   "kind": "expertise",
>   "polarity": "negated",
>   "statement": "사용자는 낚시를 해 본 경험이 없습니다.",
>   "confidence": 0.9,
>   "sensitivity": "standard",
>   "expiresAt": null,
>   "evidence": [
>     { "messageLabel": "M4", "quote": "저는 낚시를 해 본 적이 없습니다" }
>   ]
> }
> ```
>
> Writing `"polarity": "affirmed"` beside either statement would be wrong. The
> statement is an assertion, but what it asserts is a denial, and the field
> reports what the statement claims.

두 예시가 같은 `kind`인 것은 의도입니다. 언어만 다르고 나머지를 고정하면 읽는
쪽에서 **바뀌는 변수가 polarity 하나**로 보입니다. `expertise`를 고른 것은
`KIND_GUIDE`가 "no experience in a domain"을 명시적으로 expertise로 두기
때문이며, kind 선택이 논쟁거리가 되지 않습니다.

마지막 문단이 실패 형태를 직접 이름 댑니다 — run #13에서 모델이 한 것이
정확히 "부정을 문장에 쓰고 필드는 affirmed로 두는" 것이었습니다.

## 2. schema·parser 검증 (실행 결과)

예시 두 건을 실제 `parseExtractionOutput()`에 넣어 확인했습니다. 합성 대화를
label map으로 만들어 evidence quote 검증까지 실제로 통과시켰습니다.

```
problems: []   accepted: 2 / 2
  expertise · negated · "The user has no experience flying a drone."
      <- quote verified: "I have never flown a drone"
  expertise · negated · "사용자는 낚시를 해 본 경험이 없습니다."
      <- quote verified: "저는 낚시를 해 본 적이 없습니다"
```

필수 필드 일곱(`kind`, `polarity`, `statement`, `confidence`, `sensitivity`,
`expiresAt`, `evidence`)을 모두 갖췄고 `unknown_field`도 없습니다. 인용문은
`evidenceQuoteOccursIn()`이 원문에서 실제로 찾아 검증했습니다.

## 3. 중복 검사

**첫 시도는 잘못된 범위로 했고 그 때문에 예시 하나를 버렸습니다.** 처음 고른
en 소재 `pottery`는 decision set 본문 검사에서 "겹침 없음"으로 나왔지만,
`lib/` 전체를 보니 `batch163DurableEn.ts`에 "I glaze pottery for a living"이
있었습니다. decision set만 본 검사가 regression corpus를 놓친 것입니다.
`drone`으로 교체했습니다.

최종 검사는 `lib/**/*.ts` 전체(decision set + regression corpus + 교체본
tranche 포함) 대상입니다.

| 검사 대상 | 결과 |
|---|---|
| EN 대화문 / KO 대화문 | 겹침 없음 |
| EN statement / KO statement | 겹침 없음 |
| EN quote / KO quote | 겹침 없음 |
| 토큰 `drone` / `낚시` | 겹침 없음 |

두 소재 모두 트리 어디에도 등장하지 않습니다.

## 4. B+ 근거 목록 — v8 문안을 선택하는 데 사용한 run #13 사례

**합성 예시라는 사실은 B+를 면제하지 않습니다.** §12.1의 경계는 문구 복사가
아니라 **규칙을 만들거나 수정·선택하는 데 쓰였는가**입니다.

> | 규칙을 **만들거나 수정·선택**하는 데 쓰임 | **B+ 이동** |
> | **이미 동결된** 규칙으로 polarity만 배정 | 유지 가능 |

v8의 방향("규칙은 그대로 두고 완결된 negated 예시를 추가한다")은 run #13의
**polarity 불일치 44건이 전부 `negated → affirmed` 한 방향**이라는 집계에서
선택됐습니다. 그 집계는 44건 전부에서 나왔습니다.

### 4.1 목록 (44건, 고정)

`assistant_only:en` (4) — `401` `403` `405` `406`

`assistant_only:ko` (3) — `307` `403` `405`

`durable_facts:en` (17) — `11` `103` `155` `187` `188` `317` `406` `414`
`417` `422` `427` `429` `431` `433` `436` `439` `441`

`durable_facts:ko` (20) — `6` `38` `57` `88` `101` `102` `155` `167` `188`
`319` `404` `408` `410` `411` `412` `414` `416` `423` `425` `428`

(모두 `succ-` 접두사와 cell 이름이 붙은 전체 id입니다. 예: `succ-durable-ko-6`.)

### 4.2 판단이 필요한 지점

두 가지 읽기가 가능하고, **사람이 정해야 합니다.**

**A안 — 44건 전부 이동 (보수적).** 선택 근거가 된 것은 개별 문장이 아니라
"44/44 한 방향"이라는 집계이고, 그 집계는 44건 전부가 만들었습니다.
최종 B+ = **54건**.

**B안 — 개별적으로 읽은 것만 이동 (좁게).** 제가 진단 문서에 인용해 개별로
읽은 것은 8건(`assistant_only` 7 + `injection-en-402`)입니다. 나머지 36건은
숫자로만 집계됐습니다. 최종 B+ = **18건**.

**A안을 권합니다.** 과대 산정의 비용은 대체 case를 더 쓰는 것이고, 과소
산정의 비용은 평가기가 자기 답을 보는 것입니다. 계약이 §12.1을 만든 이유가
후자입니다. 다만 반대 논거도 적어 둡니다 — **v8은 규칙을 바꾸지 않습니다.**
문안은 이미 동결된 polarity 규칙의 예시일 뿐이므로, "규칙 형성"이 아니라
"규칙 예시화"로 볼 여지가 있습니다.

## 5. 최종 B+ 범위 (A안 기준)

```
합집합 54건 = polarity 근거 44 + 기존 10   (교집합 0)
```

| cell | 이탈 | 전체 |
|---|---:|---:|
| `assistant_only:en` | 8 | 125 |
| `assistant_only:ko` | 6 | 125 |
| `durable_facts:en` | 18 | 200 |
| `durable_facts:ko` | 20 | 200 |
| `injection_directives:en` | 1 | 125 |
| `injection_directives:ko` | 1 | 125 |

### 5.1 floor 결과 — 제약이 더 빡빡해집니다

```
assistant_only:ko  이탈 6건이 전부 subtype 3/4   현재 38, floor 38
    -> 대체본 6건 전부 subtype 3 또는 4 여야 함
assistant_only:en  이탈 8건이 전부 subtype 3/4   현재 38, floor 38
    -> 대체본 8건 전부 subtype 3 또는 4 여야 함
```

앞선 문서의 "7건 전부 subtype 3/4"보다 커졌습니다 — polarity 근거로 빠지는
`assistant_only` 7건도 전부 subtype 3 또는 4이기 때문입니다. **여유는 여전히
0**이고, 14건 전부를 subtype 3/4로 써야 합니다.

`durable_facts`는 38건이 빠지지만 subtype 제약이 없고 cell당 200건이라 여유가
있습니다.

## 6. 다음 단계 (승인 범위 밖)

1. §4.2의 A안/B안 확정
2. 확정된 최종 B+ 범위로 신규 case 작성 — `assistant_only` 대체본은 subtype
   3/4 필수
3. successor dataset 조립 · 검수 · 동결
4. `mem-extract-v8` 구현 — dataset 동결 후 별도 승인
5. 새 pair · 예산 · 유료 실행 — 각각 별도 승인

## 7. 이 문서가 바꾸지 않은 것

`lib/memoryExtractionPrompt.ts`를 포함해 코드는 한 줄도 바뀌지 않았습니다.
succ-6 동결본과 세 digest, `mem-score-v3.4`, `mem-extract-v7`, 예산 기록,
registry의 모든 pair, MEMORY-02·03, release gate, `feature.memoryExtractionEnabled`,
`feature.memoryInjectionEnabled` — 전부 그대로입니다.
