# Google 이미지 thinking 상한 실측 — 실행 계획서

- 대상 정책: `docs/policy/image-generation.md` §12(가격 검증)·§15(eval 예산)
- 실행 도구: `scripts/measure-google-image-thinking-cap.mjs`
- 작성일: 2026-08-13
- 상태: **1단계 완료(2026-08-14), 1b단계 대기.** 실제 사용 예산 약 3,300µUSD
  (승인 $10의 0.03%).

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

### 실행 위치와 준비

명령은 **저장소 root**에서 실행한다(`scripts/`·`lib/`를 상대경로로 읽고, `tsx`가
저장소의 `node_modules`에 있다). 출력은 **저장소 밖**에 쓴다 — §5의 키 검사를
통과하기 전인 파일이 작업 트리 안에 있으면 확인 전에 commit될 수 있다.

```
cd /path/to/Tomverse
export GEMINI_API_KEY=...                       # 이 shell에만 존재
export EVIDENCE_DIR=~/tomverse-eval/google-image-thinking-cap
mkdir -p "$EVIDENCE_DIR"
```

파일명은 `<model>-<limit>-<UTC timestamp>.json`으로 둔다. 같은 조합을 재실행할
때 이전 결과를 덮어쓰지 않는 것이 요점이다 — 재실행은 대개 앞선 판정이 미결일
때 하고, 그 미결 자체가 증거다.

아래 네 단계는 **`--model`·`--limit`·`--repeats`만 다르고** 나머지 인자와
리다이렉션은 1단계와 같다. 각 단계에는 달라지는 부분만 적었다.

#### 증거 파일은 shell이 아니라 스크립트가 쓴다

`--out=<path>`를 쓴다. 리다이렉션(`>`)은 쓰지 않는다. 이유가 세 가지다.

- **표본마다 즉시 쓴다.** `>`로 받으면 JSON은 프로세스가 끝까지 살아남아 출력한
  뒤에야 존재한다. 2026-08-13 Windows 실행에서 Node가 teardown 중 libuv에서
  abort했고(`uv_async_send` on a closing handle), 그 시점에 이미 지불한 표본이
  있었다면 전부 사라졌을 것이다. 지금은 매 표본 직후 파일이 갱신된다.
- **인코딩을 shell이 정하지 않는다.** Windows PowerShell 5.1의 `>`는 UTF-16LE,
  PowerShell 7의 `>`는 BOM 없는 UTF-8이다. 같은 명령이 열려 있는 shell에 따라
  다른 파일을 만들고 한쪽은 JSON parser가 거부한다. `--out`은 프로세스 안에서
  UTF-8로 쓴다.
- **쓸 수 없는 경로를 첫 요청 전에 잡는다.** 증거를 남길 수 없는 실행은 아무것도
  사지 않아야 한다.

**stderr를 파일에 섞지 않는다.** `2>&1`을 붙이면 진단 출력이 JSON 안으로 들어가
파싱 불가가 된다. `--out`을 쓰면 애초에 이 문제가 없다.

```powershell
Set-Location C:\path\to\Tomverse

# 이력 파일에 키를 남기지 않으려면 직접 대입하지 말고 입력받는다
$sec = Read-Host 'Gemini API key' -AsSecureString
$env:GEMINI_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
$env:GEMINI_API_KEY.Length                       # 값이 아니라 길이만 확인

$EvidenceDir = "$HOME\tomverse-eval\google-image-thinking-cap"
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')

node --conditions=react-server --import tsx `
  scripts/measure-google-image-thinking-cap.mjs `
  --model=gemini-3.1-flash-lite-image `
  --limit=512 --prompts=2 --repeats=2 `
  --thinking=high --json `
  --out="$EvidenceDir\flash-lite-512-$stamp.json" `
  --i-accept-the-cost
"exit=$LASTEXITCODE"
```

bash에서는 같은 명령을 `\`로 이어 쓰고 `$EVIDENCE_DIR`을 쓴다. `--out`은 동일하다.

**`$env:GEMINI_API_KEY`를 직접 타이핑하지 않는다.** PSReadLine이 명령 이력을
파일로 저장한다. 민감값 필터가 있지만 `apikey`·`secret`·`token` 같은 패턴을
보므로 밑줄이 들어간 `GEMINI_API_KEY`가 걸린다고 장담할 수 없다. 끝나면
`Remove-Item Env:\GEMINI_API_KEY`로 지운다.

**종료 코드가 1이어도 파일을 버리지 않는다.** 스크립트는
`limit_does_not_bound_thinking`에서 1로 끝나는데, 그것은 실패가 아니라 판정이고
그 JSON이 이 측정에서 가장 값진 증거다.

**`runComplete`를 먼저 본다.** 실행이 중간에 죽으면 파일은 남지만
`runComplete: false`, `verdict: "run_incomplete"`가 된다. 크래시가 남긴 파일이
결론처럼 읽히면 안 되므로 미완료 실행은 판정을 내지 않는다. 이때 `samples`에
있는 것은 이미 지불한 표본이므로 버리지 말고 다음 실행 결과와 함께 보관한다.

### 1단계 — Flash Lite, 상한이 물리는 지점 찾기

카드 한도가 가장 낮아(4,096) 가장 먼저 물릴 가능성이 높다.

```
node --conditions=react-server --import tsx \
  scripts/measure-google-image-thinking-cap.mjs \
  --model=gemini-3.1-flash-lite-image \
  --limit=512 --prompts=2 --repeats=2 \
  --thinking=high --json --i-accept-the-cost \
  --out="$EVIDENCE_DIR/flash-lite-512-$(date -u +%Y%m%dT%H%M%SZ).json"
```

4회, 계획 원가 178,976µ ≈ $0.18.

- `limit_does_not_bound_thinking` → **여기서 끝난다.** 반증 하나면 질문이
  닫히고, 세 모델 모두 `worst_case_cost_unbounded`를 유지한다. 2단계를 실행하지
  않는다.
- `inconclusive_limit_never_bound` → 상한을 더 낮춰 재실행(`--limit=256`).
- `consistent_with_limit_bounding_thinking` → **1b단계로.** 아래 결과가 그
  이유다 — 2단계로 바로 가지 않는다.

#### 1단계 결과 (2026-08-14, 실제 원가 약 3,300µUSD)

`--limit=512 --prompts=2 --repeats=2 --thinking=high`, 4회 전부 전송,
`stoppedEarly: null`, `verdict: consistent_with_limit_bounding_thinking`.

| # | prompt | input | output | thinking | 합계 vs 512 | status | 이미지 |
|---:|---:|---:|---:|---:|---|---|---:|
| 0 | 0 | 62 | 0 | **509** | within | `completed` | 0 |
| 1 | 1 | 56 | 0 | **509** | within | `completed` | 0 |
| 2 | 0 | 62 | 0 | **509** | within | `completed` | 0 |
| 3 | 1 | 56 | 0 | **509** | within | `completed` | 0 |

**이미지가 한 장도 나오지 않았다.** 네 번 모두 thinking이 예산을 다 쓰고
`total_output_tokens: 0`으로 끝났으며 `steps`가 비어 있다. 그래서 이미지 출력가
33,600µ는 청구되지 않았고, 실제 원가는 thinking 2,036 토큰(약 3,054µ)과 입력
236 토큰뿐이다 — 계획 178,976µ의 **1.8%**. (입력 토큰 단가는 우리 표에 검증된
값이 없다. thinking이 지배적이므로 이 결론은 바뀌지 않는다.)

**`status`가 `completed`인데 이미지가 없다.** 예산 소진을 `incomplete`로
보고하지 않으므로 adapter는 status가 아니라 parser로 판정해야 한다.
`generateWithGoogle`은 실제로 그렇게 하며, `parseGoogleImageResponse`가 null이면
재시도 없이 `provider_failed`로 끝낸다. 재시도하지 않는 것이 옳다 — 결정적으로
같은 결과를 다시 사게 된다.

**이 표본들은 예전 설계였다면 전부 버려졌다.** 이미지 없는 응답을 production
parser 하나로만 읽었다면 네 건이 모두 "판독 불능"으로 기록되고 실행은 1회에서
멈췄을 것이다. 이미지 판정과 usage 판정을 분리한 이유가 이것이다.

### 1b단계 — 509가 정말 *우리* 상한 때문인지 (필수)

**긍정 판정을 그대로 받으면 안 되는 이유가 하나 있다.** 509가 서로 다른 두
프롬프트에서 네 번 **완전히 동일**하다. 자연스러운 변동이 아니라 천장의
지문인데, 그 천장이 둘 중 어느 것인지를 이 실행은 구별하지 못한다.

- (A) 우리가 보낸 `max_output_tokens: 512`
- (B) `thinking_level: "high"`에 대한 모델 자체의 내부 thinking 상한

(B)라면 숫자는 똑같이 나오면서 `max_output_tokens`는 아무것도 bound하지 않는다.
즉 **같은 관측이 정반대 결론과 양립한다.**

상한을 낮춰 숫자가 따라오는지 보면 갈린다.

```
  --model=gemini-3.1-flash-lite-image \
  --limit=256 --prompts=2 --repeats=2
```

- thinking ≈ 253 → 숫자가 상한을 따라온다. (A)이며 긍정 근거가 성립한다.
- thinking = 509 → 256을 넘겼다. **반증이다.** `limit_does_not_bound_thinking`
  으로 질문이 닫히고 세 모델 모두 `worst_case_cost_unbounded`를 유지한다.

4회, 이미지가 나오지 않을 것이므로 실제 원가는 1단계보다 낮다(약 1,600µ).
**2단계보다 먼저 실행한다.** 2단계(4,096)는 상한 근처에 가지 않을 것이라
`inconclusive_limit_never_bound`가 나오기 쉽고, 두 가설을 구별하지 못한다.

### 2단계 — Flash Lite, 카드 한도에서의 실제 최악

1b가 (A)일 때만 실행한다.

```
  --model=gemini-3.1-flash-lite-image \
  --limit=4096 --prompts=2 --repeats=3
```

6회, 계획 원가 268,464µ ≈ $0.27. **여기서는 이미지가 나올 것이므로 이 단계가
예산의 대부분을 쓴다.**

두 가지를 함께 본다. 첫째, §12가 **둘 이상의 상한값**을 요구하므로 이 단계 없이
절차가 끝나지 않는다. 둘째, production이 실제로 보내는 값이 4,096이므로 **이
상한에서 이미지가 나오는지 자체가 제품 질문이다** — 1단계에서 본 것은 "상한이
낮으면 thinking이 예산을 다 쓰고 아무것도 안 나온다"이고, 4,096에서도 그렇다면
그 모델은 가격 이전에 동작하지 않는 것이다.

여기서 `inconclusive_limit_never_bound`가 나오는 것은 정상이다. 스크립트의 판정은
**실행 단위**이고 §12의 "둘 이상의 상한값"은 실행을 가로지르므로, 어떤 단일
실행도 그 조건을 혼자 충족할 수 없다. 최종 판단은 증거 파일들을 놓고 사람이
조립한다.

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

`runComplete`가 `false`면 그 파일은 중단된 실행의 부분 기록이며 판정이 없다.

두 곳의 대체는 버리는 것이 아니라 읽을 수 있게 만드는 것이다. 프롬프트 텍스트는
정책 §10이 저장을 금지하고, 이미지 base64는 1MB 안팎이라 텍스트로 감사할 수
없다. 같은 프롬프트는 같은 digest를 내므로 두 실행의 비교 가능성은 유지된다.
검증 대상 수치(`max_output_tokens`, `thinking_level`, usage 카운터, `status`,
step 종류·순서, `mime_type`)는 전부 원문 그대로다.

판정이 끝나면 이 문서에 결과 표를 추가하고, §5를 통과한 JSON을 저장소로
옮겨 함께 남긴다.

## 5. API 키 취급

- 키는 실행자의 환경에만 존재한다. `GOOGLE_GENERATIVE_AI_API_KEY` 또는
  `GEMINI_API_KEY`로 읽는다.
- 스크립트는 완성된 JSON 문자열 **전체**에 마스킹을 한 번 더 적용한다. 개별
  `detail` 필드는 이미 마스킹되지만, 이 출력은 사람이 티켓에 붙여 넣는 것이고
  아무도 생각하지 못한 필드로 키가 새는 것이 그 한 번이 막는 실패다.
- **그럼에도 전달 전에 손으로 한 번 더 검색한다.** 마스킹이 잡는 것은 알고 있는
  키 모양과 손에 쥔 키 값이다. 그 두 가지가 전부라는 보장은 없다.

검사는 JSON을 쓴 그 shell에서, 증거 디렉터리를 대상으로 실행한다. `$GEMINI_API_KEY`
가 살아 있는 shell이어야 두 번째 검사가 의미를 가진다.

```
[ -n "$GEMINI_API_KEY" ] || echo "!! 키 변수가 비어 있음 -- 두 번째 검사는 무의미"

grep -rEl 'AIza[A-Za-z0-9_-]{10,}|AQ\.[A-Za-z0-9_-]{10,}' "$EVIDENCE_DIR" \
  && echo "!! 위 파일에 키 모양 문자열이 있음" || echo "OK: 키 모양 없음"

grep -rlF -- "$GEMINI_API_KEY" "$EVIDENCE_DIR" \
  && echo "!! 위 파일에 키 값이 그대로 있음" || echo "OK: 키 값 없음"
```

`grep -l`은 걸린 **파일명만** 출력하므로 출력이 없는 것이 통과다. `-c`를 쓰면
파일마다 `0`이 줄줄이 나와 통과와 실패가 비슷하게 보인다. `-F`와 `--`는 키에
`-`나 `.`이 들어 있어도 패턴이 아니라 문자열로 읽히게 한다.

PowerShell에서는 같은 검사를 이렇게 한다. `-List`와 `Path`만 뽑는 것이 요점이다
— `Select-String`은 기본적으로 **걸린 줄을 그대로 출력**하므로, 키가 정말 새어
있으면 그 검사가 키를 화면에 한 번 더 찍는다.

```powershell
$shape = Select-String -Path "$EvidenceDir\*.json" -List `
  -Pattern 'AIza[A-Za-z0-9_-]{10,}|AQ\.[A-Za-z0-9_-]{10,}' |
  Select-Object -ExpandProperty Path
if ($shape) { Write-Warning "!! 키 모양 문자열: $shape" } else { "OK: 키 모양 없음" }

if ($env:GEMINI_API_KEY) {
  $exact = Select-String -Path "$EvidenceDir\*.json" -List -SimpleMatch `
    -Pattern $env:GEMINI_API_KEY |
    Select-Object -ExpandProperty Path
  if ($exact) { Write-Warning "!! 키 값: $exact" } else { "OK: 키 값 없음" }
} else {
  Write-Warning "!! 키 변수가 비어 있음 -- 두 번째 검사를 건너뛰었다"
}
```

빈 변수는 검사를 건너뛰고 경고한다. 빈 pattern으로 검사를 돌리면 전 파일이
걸리거나 오류가 나는데, 어느 쪽이든 답이 아니면서 답처럼 보인다.

두 검사가 모두 `OK`일 때만 전달한다.

## 6. 판정 이후

- `limit_does_not_bound_thinking` → 세 Google 모델 모두 `worst_case_cost_unbounded`
  유지. `thinkingCapMicroUsd`는 `null`로 둔다. **허위 상한을 넣지 않는다.**
- `consistent_with_limit_bounding_thinking` (두 모델 모두, 두 상한 이상에서) →
  §12의 상한 확인이 충족된다. 그 다음은 이 문서의 범위 밖인 별개 결정 두 개다:
  판매 크레딧 승인, 그리고 provider 노출 한도 승인 후 활성화.
- 그 외 판정은 전부 미결이다. 미결을 긍정으로 반올림하지 않는다.
