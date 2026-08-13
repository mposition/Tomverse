# Google 이미지 thinking 상한 실측 — 실행 계획서

- 대상 정책: `docs/policy/image-generation.md` §12(가격 검증)·§15(eval 예산)
- 실행 도구: `scripts/measure-google-image-thinking-cap.mjs`
- 작성일: 2026-08-13
- 상태: **실행 대기.** 이 문서는 계획이며, 아직 어떤 유료 호출도 발생하지 않았다.

## 0. 승인된 것과 승인되지 않은 것

승인(2026-08-12, 제품 책임자):

> Google image thinking-cap eval에 총 **$10**의 계획 예산을 승인한다. 대상은
> `gemini-3.1-flash-lite-image`와 `gemini-3.1-flash-image`이며 Pro는 제외한다.
> $10은 추가 승인 없이 사용할 수 있는 행정적 한도이며 이를 초과하는 실행은
> 별도 승인한다.

승인되지 **않은** 것:

- `gemini-3-pro-image`에 대한 어떤 호출도 이 예산에 포함되지 않는다.
- 측정 결과가 긍정이더라도 **모델 활성화는 별개 결정**이다. §12는 상한 확인을
  요구하고, 판매 크레딧은 그 위에 다시 별도 승인이다.
- provider 노출 한도(`IMAGE_PROVIDER_GOOGLE_COST_*`) 설정은 이 실행에 포함되지
  않는다.

## 1. 요청당 계획 원가

아래 수치는 **측정된 원가가 아니라 예산 산정용 가정**이다. §12.1의 A-2 유도
(모델 카드의 출력 토큰 한도 전체가 과금 가능한 thinking·text 토큰이라고 보는
보수적 가정)를 요청당 상한으로 쓰고, 여기에 입력 프롬프트 예산 5,000µUSD를
더한 값이다. A-2는 정책이 **채택하지 않기로 한** 유도이며, 여기서는 예산이
모자라지 않게 하려는 용도로만 쓴다. 실제 청구액은 이보다 훨씬 낮을 것으로
예상되지만, 그 예상에 예산을 걸지 않는다.

| 모델 | 이미지 출력(1K) | A-2 text·thinking 상한 | 프롬프트 예산 | **요청당 계획 원가** |
|---|---:|---:|---:|---:|
| `gemini-3.1-flash-lite-image` | 33,600µ | 6,144µ (4,096 × $1.50/1M) | 5,000µ | **44,744µ ≈ $0.045** |
| `gemini-3.1-flash-image` | 67,000µ | 98,304µ (32,768 × $3.00/1M) | 5,000µ | **170,304µ ≈ $0.170** |

## 2. 실행 순서

정책 §12의 절차를 그대로 따른다. **한 단계의 판정을 보고 다음 단계를 정한다.**
아래 전부를 한 번에 실행하지 않는다.

`--limit`은 표에서 고르는 값이 아니라 임의의 양수이며, 카드 한도는 기본값일
뿐이다. 낮은 상한부터 시작하는 이유는 §12-7이다 — 모든 표본이 상한보다 한참
아래에서 끝나면 그 모델이 검소하다는 뜻이지 상한이 강제된다는 뜻이 아니고,
스크립트는 그 경우를 `inconclusive_limit_never_bound`로 보고한다.

### 1단계 — Flash Lite, 상한이 물리는 지점 찾기

카드 한도가 가장 낮아(4,096) 가장 먼저 물릴 가능성이 높다.

```
node --conditions=react-server --import tsx \
  scripts/measure-google-image-thinking-cap.mjs \
  --model=gemini-3.1-flash-lite-image \
  --limit=512 --prompts=2 --repeats=2 \
  --thinking=high --json --i-accept-the-cost \
  > evidence/flash-lite-512.json
```

4회, 계획 원가 178,976µ ≈ $0.18.

- `limit_does_not_bound_thinking` → **여기서 끝난다.** 반증 하나면 질문이
  닫히고, 세 모델 모두 `worst_case_cost_unbounded`를 유지한다. 2단계를 실행하지
  않는다.
- `inconclusive_limit_never_bound` → 상한을 더 낮춰 재실행(`--limit=256`).
- `consistent_with_limit_bounding_thinking` → 2단계로.

### 2단계 — Flash Lite, 카드 한도에서의 실제 최악

```
  --model=gemini-3.1-flash-lite-image \
  --limit=4096 --prompts=2 --repeats=3
```

6회, 계획 원가 268,464µ ≈ $0.27.

### 3단계 — Flash Image, 상한이 물리는 지점

1·2단계가 긍정일 때만 실행한다.

```
  --model=gemini-3.1-flash-image \
  --limit=2048 --prompts=2 --repeats=2
```

4회, 계획 원가 681,216µ ≈ $0.68.

### 4단계 — Flash Image, 카드 한도

```
  --model=gemini-3.1-flash-image \
  --limit=32768 --prompts=2 --repeats=3
```

6회, 계획 원가 1,021,824µ ≈ $1.02.

### 합계

| | 호출 | 계획 원가 |
|---|---:|---:|
| 1–2단계 (Flash Lite) | 10 | 447,440µ ≈ $0.45 |
| 3–4단계 (Flash Image) | 10 | 1,703,040µ ≈ $1.70 |
| **전체** | **20** | **2,150,480µ ≈ $2.15** |

승인된 $10의 **21.5%**다. 남는 여유는 재실행용이다 —
`inconclusive_limit_never_bound`가 나오면 상한을 낮춰 다시 사야 하고, 그것이
이 계획에서 가장 그럴듯한 재실행 사유다.

**스크립트는 금액을 집행하지 않는다.** 호출 수만 제한한다. $10을 지키는 것은
인자를 고르는 사람이다.

## 3. 조기 종료

스크립트는 두 경우에 남은 호출을 보내지 않고 멈춘다(`stoppedEarly`).

- `counterexample_found` — 상한을 넘긴 표본이 하나 나오면 질문이 끝난다.
  두 번째 표본이 그것을 더 참으로 만들지 못한다.
- 판독 불능(`no_usage_reported`·`unreadable_payload`·`http_error` 등) — usage
  카운터가 측정의 전부이므로, 그것을 보고하지 않는 응답은 낮은 표본이 아니라
  표본이 아니다.

## 4. 증거 보존

§12-8이 요구하는 다섯 가지는 `--json` 출력 한 파일에 모두 들어 있다.

| 요구 | JSON 필드 |
|---|---|
| 요청 JSON | `requestBodies[]` (프롬프트는 sha256으로 대체 — §10) |
| 원본 응답 | `samples[].response` (이미지 바이트는 sha256 + 길이로 대체) |
| 모델 ID | `modelId` · `apiModelId` |
| 응답 ID | `samples[].responseId` |
| 실행 일시 | `measuredAt` · `samples[].startedAt` |

두 곳의 대체는 버리는 것이 아니라 읽을 수 있게 만드는 것이다. 프롬프트 텍스트는
정책 §10이 저장을 금지하고, 이미지 base64는 1MB 안팎이라 텍스트로 감사할 수
없다. 같은 프롬프트는 같은 digest를 내므로 두 실행의 비교 가능성은 유지된다.
검증 대상 수치(`max_output_tokens`, `thinking_level`, usage 카운터, `status`,
step 종류·순서, `mime_type`)는 전부 원문 그대로다.

파일명은 `google-image-thinking-cap/<model>-<limit>-<UTC timestamp>.json`으로
두고, 판정이 끝나면 이 문서에 결과 표를 추가한다.

## 5. API 키 취급

- 키는 실행자의 환경에만 존재한다. `GOOGLE_GENERATIVE_AI_API_KEY` 또는
  `GEMINI_API_KEY`로 읽는다.
- 스크립트는 완성된 JSON 문자열 **전체**에 마스킹을 한 번 더 적용한다. 개별
  `detail` 필드는 이미 마스킹되지만, 이 출력은 사람이 티켓에 붙여 넣는 것이고
  아무도 생각하지 못한 필드로 키가 새는 것이 그 한 번이 막는 실패다.
- **그럼에도 전달 전에 손으로 한 번 더 검색한다.** 마스킹이 잡는 것은 알고 있는
  키 모양과 손에 쥔 키 값이다. 그 두 가지가 전부라는 보장은 없다.

```
grep -c -E 'AIza[A-Za-z0-9_-]{10,}|AQ\.[A-Za-z0-9_-]{10,}' evidence/*.json
grep -c "$GEMINI_API_KEY" evidence/*.json
```

둘 다 `0`이어야 전달한다.

## 6. 판정 이후

- `limit_does_not_bound_thinking` → 세 Google 모델 모두 `worst_case_cost_unbounded`
  유지. `thinkingCapMicroUsd`는 `null`로 둔다. **허위 상한을 넣지 않는다.**
- `consistent_with_limit_bounding_thinking` (두 모델 모두, 두 상한 이상에서) →
  §12의 상한 확인이 충족된다. 그 다음은 이 문서의 범위 밖인 별개 결정 두 개다:
  판매 크레딧 승인, 그리고 provider 노출 한도 승인 후 활성화.
- 그 외 판정은 전부 미결이다. 미결을 긍정으로 반올림하지 않는다.
