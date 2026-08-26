# memory extraction eval — 진단 기록 (v1 · v2)

`(gpt-5-6-luna, mem-extract-v1)`과 `(gpt-5-6-luna, mem-extract-v2)`에서 실행한
것들의 기록입니다. **어느 것도 decision-grade 결과가 아니며**, 셋 다 §12.3
판정을 만들지 않았습니다. 남기는 이유는 이것들이 무엇을 밝혀냈고 얼마를
썼는지가 이후 결정의 근거이기 때문입니다.

관련 문서 — 절차는 `docs/ops/memory-extraction-decision-grade-run.md`, 표본은
`docs/ops/memory-extraction-eval-dataset.md`, 계약은
`docs/policy/external-conversation-import-and-memory.md` §12.

## 실행 목록

| # | pair | 유형 | 케이스 | 결과 | 비용 |
|---|---|---|---|---|---|
| 1 | `mem-extract-v1` | live, 전체 시도 | 5 / 1,150 | `abortedOnConsecutiveFailures` | US$0.0012 |
| 2 | `mem-extract-v2` | probe (`--limit=10`) | 10 | failures 0 | US$0.0028 |
| 3 | `mem-extract-v2` | probe (`--limit=10`) | 10 | failures 0, 케이스별 상세 | US$0.0028 |

합계 **US$0.0068**. 승인 예산 US$20 중이며, 이 지출은 프로그램에 계상됩니다
(누적 원장은 없으므로 사람이 뺍니다 — `lib/memoryExtractionEvalRegister.ts`).

실행 1은 그 앞에 두 번의 dispatch가 더 있었고 둘 다 **비용 0**이었습니다 —
provider 호출이 SDK 검증에서 죽었기 때문입니다(system 메시지, 그리고 harness가
스스로 정한 출력 상한).

## 실행 1 — v1의 배선 결함

5건 연속 파싱 불가로 중단했습니다. 사유는 `unknown_field`와
`confidence_invalid`.

**원인**: system prompt가 `Return JSON only, matching the requested schema`라고
하면서 **그 schema를 요청하지 않았습니다.** `MEMORY_EXTRACTION_OUTPUT_SCHEMA`는
export돼 있었고 주석에 "structured-output API에 넘길 수 있도록 plain object로
둔다"라고 적혀 있었지만, 어댑터도 프롬프트 본문도 그것을 넘기지 않았습니다.
모델은 요청된 적 없는 schema에 맞추라는 말을 듣고 필드 이름과 `confidence`
타입을 추측했습니다.

이것은 eval의 결함이 아니라 **제품의 결함**이며 flag를 켜면 production에서도
같습니다. eval이 첫 실제 실행에서 릴리스 차단 사유를 찾아냈습니다.

## 실행 2·3 — v2는 배선을 고쳤고, 그래서 계약이 읽혔습니다

v2가 schema를 Structured Outputs로 실제 요청합니다. **failures 0** — request,
schema, parser, validator가 실제 답변 위에서 맞물립니다. probe가 답하기로 한
질문은 여기까지이고 답은 예입니다.

그리고 처음으로 측정값을 읽을 수 있게 되자 **네 가지 계약 결함**이 드러났습니다.
durable 8건에서 11건을 뽑아 3건이 매칭됐는데, **매칭 실패의 대부분이 모델
오류가 아닙니다.**

### A. 프롬프트가 출력 언어를 정하지 않습니다

```
durable-ko-1  expected: occupation + [간호사]
  [kind 일치, 토큰 불일치]  "The user works as a nurse at a university hospital."
durable-ko-2  expected: preference + [존댓말]
  "The user prefers answers in polite Korean honorifics."
durable-ko-3  → 사용자는 내년까지 일본어로…  [MATCH]
```

추출은 옳고 언어만 다릅니다. system prompt는 3인칭 서술문만 요구하고 **언어를
말하지 않습니다.** ko 정답 라벨은 한국어 토큰이라, 모델이 영어를 고르면 맞는
추출이 실패합니다. ko 4건 중 2건.

### B. kind taxonomy가 상호 배타적이지 않습니다

| case | 라벨 | 모델 |
|---|---|---|
| `durable-en-2` | `preference` | `verbosity` |
| `durable-ko-2` | `preference` | `tone` |
| `durable-en-1` | `occupation` | + `expertise` |
| `durable-en-4` | `project` | + `recurring_context` |

`KIND_GUIDE`는 factual과 answer-style 두 목록을 나열할 뿐 **어느 쪽이 우선인지
말하지 않습니다.** 모델은 일관되게 구체적인 쪽을 골랐고 라벨은 포괄적인
`preference`를 썼습니다. 매칭은 kind 완전 일치를 요구하므로 전부 실패입니다.

### C. v2가 채점 의미를 바꿨습니다

```
durable-en-3  [not adopted]  constraint · bulk-safe false — "lactose intolerant…"
durable-ko-4  [not adopted]  constraint · bulk-safe false — "shellfish allergy…"
```

`bulkSafe = accepted && sensitivity === "standard"`이고, validator는 모델이
신고한 sensitivity에서 **시작해 올리기만 합니다**(`lib/memoryValidatorCore.ts`).
v1에서 `sensitivity`는 선택 필드라 대개 생략돼 `standard`로 떨어졌습니다.
**v2의 strict schema가 전 필드를 필수로 만들면서** 모델이 건강 정보를 명시적으로
`sensitive`로 신고하기 시작했고, 그러면 `adopted`에 들어가지 않아 정답과 매칭될
수 없습니다.

동결된 dataset은 이 두 건을 "추출되어야 함"으로 적었고 모델의 판단은 "확인 없이
저장하면 안 됨"입니다. **둘 다 옳은데 채점이 하나만 통과시킵니다** — "정확히
추출됐지만 검토 대기"와 "추출 실패"가 구분되지 않습니다.

### D. gold label이 완전하지 않습니다

`durable-en-1`은 2턴 대화에서 3건을 뽑았습니다(`occupation` 매칭 + `expertise` +
`decision`). 라벨은 하나만 열거합니다. 맞는 추가 추출도 precision을 깎습니다.

### 합쳐진 효과

§12.3은 precision Wilson 하한 0.95를 요구하며 이는 400건에서 오답 3건까지입니다.
A·B·C·D 중 **어느 것도 모델 품질이 아닌데 넷 다 precision과 recall을 깎습니다.**
그러므로 이 계약 위에서의 전체 실행은 모델이 아무리 좋아도 해석 불가능한 숫자를
냅니다.

한 가지 안심되는 신호: **critical false acceptances 0.** `assistant_only` 2건
모두 아무것도 뽑지 않았습니다. 표본이 2건이라 결론은 아니지만 방향은 맞습니다.

## 이 기록이 남기는 상태

- `mem-extract-v1`·`mem-extract-v2` 네 register entry 모두 `revoked`입니다.
  예산 기록은 지우지 않습니다 — 승인과 지출이 실재했기 때문이고,
  `decideEvalRunMode`가 status를 먼저 읽으므로 닫힌 pair가 남은 예산을 쓸 수
  없습니다.
- `mem-eval-seed-11`은 동결된 채로 남습니다. 이 dataset으로 낸 것은 진단뿐이며
  **decision-grade 근거로 재사용하지 않습니다.** 후속 `datasetVersion`이 A–D를
  반영해 만들어집니다.
- 승인된 판정은 존재한 적이 없으므로, 재작업 규칙
  (`docs/ops/memory-extraction-eval-dataset.md` §7.3)이 무효화할 verdict가
  없습니다.

## 후속 — `mem-extract-v3` [2026-08-26]

네 결함이 v3 프롬프트에 반영됐습니다(.github/audits/memory-eval-scoring-contract-amendment-2026-08-25.md §1·§2·§9).

| 결함 | v3가 바꾼 것 |
|---|---|
| A 출력 언어 | 인용한 사용자 근거의 언어를 쓰고, 혼합이면 다수, 동률이면 최근 근거. assistant 발화는 언어를 정하지 않음 |
| B kind 불일치 | kind는 상호 배타적이며 3단계 판정 순서(전용 style → `communication_style` residual → `preference`) |
| B `decision` | 확정·실행 결정만. 검토·비교·고민은 어느 kind로도 추출하지 않음 |
| C sensitivity | 건강 정보는 추출하되 언제나 `sensitive`. 최소화한 파생 문장도 sensitive. 제3자는 의료 프로필이 아니라 사용자 중심 제약으로만 |
| D gold 완전성 | 프롬프트가 아니라 dataset·scorer 쪽에서 해결(schema 2, `goldCompleteness`) |

fingerprint는 `fdba01bf…5698eec7`이고 `tests/memoryExtractionPromptFingerprint.test.mjs`가
고정합니다. **fingerprint는 프롬프트가 몰래 바뀌지 않았다는 것만 말하고 무엇을
말하는지는 말하지 못하므로**, 규칙 자체는
`tests/memoryExtractionPromptV3Rules.test.mjs`가 발송되는 bytes에 대해 따로
단언합니다 — 규칙을 지우고 버전을 올리면 fingerprint 검사는 깨끗이 통과합니다.

v3 pair 둘(`gpt-5-6-luna`·`gpt-5-4-mini`)은 **예산 없는 candidate**로 등록했습니다.
예산은 버전 bump를 따라오지 않습니다 — v2의 US$20은 v2에 대한 승인입니다
(.github/audits/memory-eval-scoring-contract-amendment-2026-08-25.md §6).
따라서 live 실행은 `no_eval_budget`으로 거부되고, 예산이 생기더라도 schema-2
dataset이 채택·동결되기 전에는 `legacy_dataset_schema`로 거부됩니다.
