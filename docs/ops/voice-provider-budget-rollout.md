# Voice provider usage 예산 (B-4) 운영 설정

`docs/policy/voice-input.md` §6.1-4가 만든 층에 **사람이 숫자를 넣는** 절차입니다.
§14의 B-4는 "코드 완료, 환경별 실제 한도 설정 대기"이고, 이 문서가 그 대기를
끝내기 위한 것입니다.

- **문서 종류**: 운영 절차. 결과는 여기에 적지 않습니다(§6 기록 초안 참조).
- **범위**: B-4만. **B-5(공급자 데이터 보존)와 B-6(실기기 검증)은 이 문서가
  건드리지 않고, 이 문서를 다 밟아도 해소되지 않습니다.**
- **production Voice flag는 이 절차에서 켜지 않습니다.**

---

## 0. 착수 시점에 확인된 사실

저장소 확인 기준 commit은 **`dde6ad87`**(PR #1282 병합)입니다. 브랜치가 아니라
SHA로 적습니다 — `develop`은 움직이고, 움직이는 순간 브랜치 링크는 이 상태를
가리키지 않습니다.

**B-4가 묻는 것**입니다.

| 항목 | staging | production | 출처 |
|---|---|---|---|
| 서비스 중 배포 | `dde6ad87` | `500ce79f` | Railway 배포 목록 |
| 배포 브랜치 | `develop` | `main` | 서비스 설정 |
| `VOICE_PROVIDER_SECONDS_PER_DAY` | **미설정** | **미설정** | 변수 **이름** 목록 |
| `VOICE_PROVIDER_SECONDS_PER_MONTH` | **미설정** | **미설정** | 같음 |
| 두 값의 **유효성** | **미확인** — §0.1 | **미확인** | — |
| 적용되는 규칙(production/development) | **미확인** — §0.1.1 | **미확인** | — |

**두 환경 모두 `VOICE_PROVIDER_SECONDS_*`가 없습니다.** B-4가 요구하는 설정은
아직 어느 쪽에도 존재하지 않습니다.

**맥락으로만 적는 것** — 아래는 B-4의 조건이 아니고, 판정에 섞지 않습니다.

| 항목 | staging | production | B-4와의 관계 |
|---|---|---|---|
| 기동 명령 | `next start` | `next start` | §0.1.1의 **정황**이지 판정이 아님 |
| `VOICE_TRANSCRIPTION_API_KEY` | 미설정 | 미설정 | **차단 사유 아님** — 아래 |
| `VOICE_INPUT_KILL_SWITCH` | 미설정 | 미설정 | **flag 상태의 증거 아님** — 아래 |
| `VOICE_INPUT_*` 주체별 override | 미설정 | 미설정 | §7의 다른 층(§1) |
| Voice flag(`feature.voiceInputEnabled`) | **미확인** | **미확인** | §0.2로만 확인 가능 |

- **`VOICE_TRANSCRIPTION_API_KEY`가 없는 것은 B-4의 문제가 아닙니다.**
  전용 키가 없으면 `OPENAI_API_KEY`로 내려가고(§11.3), 그 키는 두 환경에 다
  있습니다. 어느 계정으로 오디오가 나가는가는 **B-5**의 질문이고, 예산이
  설정됐는가는 B-4의 질문입니다. B-4 기록에 이 줄을 넣지 않습니다.
- **`VOICE_INPUT_KILL_SWITCH`가 비어 있다는 것은 flag가 꺼져 있다는 증거가
  아닙니다.** kill switch는 DB를 **덮어쓰는** 층이고, 비어 있다는 것은
  "덮어쓰지 않는다"는 뜻일 뿐입니다. 실제 상태는 `AppSetting`에 있고, 읽기
  전에는 **켜져 있을 수도 있습니다.** 그래서 두 환경 모두 `미확인`이며, §5는
  그 확인을 1단계로 둡니다.

### 0.1 값을 보지 않고 확인하는 방법

Railway의 **변수 조회**(`list-variables`)는 한 서비스의 모든 변수를 **값까지**
돌려주며, 세션 토큰으로 호출하면 평문입니다. 그것으로 숫자 두 개의 존재 여부를
확인하면 `DATABASE_URL`·`NEXTAUTH_SECRET`·provider API key가 전부 작업 기록에
남습니다. 그 대가는 확인하려던 사실에 비해 터무니없습니다.

**서비스 설정 조회(`get-service-config`)는 변수 이름만 돌려주고 값을 담지
않습니다.** 위 표는 그것으로 채웠습니다 — 존재 여부를 묻는 질문에는 존재 여부만
답하는 도구가 있고, 그것을 쓰면 됩니다.

**이름 목록이 답하지 못하는 것은 값의 유효성입니다.** 설정돼 있다는 것과 양의
정수이고 `month >= day`라는 것은 다른 사실이고, 이름만으로는 구분되지 않습니다.
그 판정은 §4의 검사기가 각 환경 안에서 하며, 그 출력에도 값은 없습니다.

### 0.1.1 어느 규칙이 적용되는지는 아직 관측되지 않았습니다

두 환경의 기동 명령이 `next start`이므로 **production 규칙이 적용될 것으로
예상**합니다 — Next.js가 그때 `NODE_ENV=production`을 씁니다.

**그러나 기동 명령은 정황이지 판정이 아닙니다.** 실제로 어느 규칙이 걸렸는지를
말하는 것은 그 환경 안에서 읽은 `NODE_ENV`이고, 그것을 출력하는 것은 검사기의
**첫 줄**입니다.

```
Voice provider usage budget (seconds) — production rule (NODE_ENV=production)
```

그 줄을 보기 전까지 이 칸은 `미확인`입니다. 기록에도 예상이 아니라 그 줄을
붙입니다.

**예상이 맞다면** 개발 fallback이 없으므로, 두 변수가 없는 상태에서 Voice
flag를 켜면 `/api/ready`가 즉시 `voiceProviderBudget: false`를 내고 배포
전체가 503이 됩니다. **결함이 아니라 fail-closed가 작동하는 모습**이고, §5가
변수를 먼저 넣는 이유입니다.

### 0.2 Voice flag를 읽는 방법

flag는 admin console에 토글이 없습니다 — `lib/appSettings.ts`에
`setVoiceInputEnabled`가 **없는 것이 의도된 결정**입니다(§14의 절차를 마지막
단계만 떼어 제공하지 않기 위해서). 그래서 읽기도 DB에서 합니다.

Railway의 해당 환경 Postgres shell에서, 읽기 전용:

```sql
SELECT value FROM "AppSetting" WHERE key = 'feature.voiceInputEnabled';
```

행이 없으면 꺼진 상태입니다. `VOICE_INPUT_KILL_SWITCH`가 비어 있지 않으면 DB
값과 무관하게 꺼집니다.

### 0.3 production은 아직 이 코드를 갖고 있지 않습니다

`e8815457`(#1280) · `0a25820a`(#1281) · `dde6ad87`(#1282)는 **`develop`에만
있고 `main`에 없습니다.** production이 서비스 중인 `500ce79f`에는
`voice-transcription-model-price` readiness 검사가 없습니다.

그러므로 production 환경변수를 지금 넣어도 되지만, **그 값이 맞는지
`/api/ready`가 말해 주는 것은 main이 이 커밋들을 받은 뒤**입니다. §5의 순서가
그렇게 짜여 있습니다.

---

## 1. 이 예산은 무엇이고, 무엇과 섞으면 안 되는가

**seconds입니다. USD가 아닙니다.** 이유는 §6.1-4에 있고 여기서 반복하지
않습니다. 이 문서에서 지켜야 할 형태만 적습니다.

| | `VOICE_PROVIDER_SECONDS_*` | `VOICE_INPUT_*` |
|---|---|---|
| 무엇을 묶나 | **배포 전체**가 공급자에 보내는 오디오 | **주체 한 명**의 사용 |
| 단위 | 초 (일·월) | 요청 수(일·분) + 초(일) |
| 코드 | `lib/voiceProviderBudget.ts` | `lib/voiceInputGuardrails.ts` |
| 기본값 | production에 **없음** — 명시 필수 | 있음(일 1,200초) |
| 상한 규칙 | 없음 | 초과분은 ceiling으로 clamp |

**한쪽으로 다른 쪽을 유도하지 않습니다.** 주체별 한도로 총액을 묶을 수 없고
(총액 = 한도 × 사람 수), 총액 예산으로 한 사람의 남용을 막을 수 없습니다.

### 1.1 금지: 초 예산을 USD로 환산해서 고르기

**공급자의 "Estimated cost" US$0.003/분으로도, B-3에서 관측된 토큰 요율로도
초 예산을 정하지 않습니다.** §6.1.3-3이 그 이유를 관측으로 보였습니다 —
분당 비용은 발화 밀도에 따라 움직이고, 관측된 표본에서 US$0.003/분까지의 여유는
26%뿐이었습니다. 초 → USD는 안정적인 관계가 아니고, 이 층은 그 관계를 안다고
주장하지 않습니다.

**초 예산은 "얼마를 쓸 것인가"가 아니라 "얼마나 많은 오디오가 여기서 나가도
되는가"의 답입니다.** 그것이 이 층이 잴 수 있는 유일한 것입니다.

---

## 2. 버킷 경계는 UTC입니다

`lib/voiceProviderBudgetLedger.ts`가 `Date.UTC(...)`로 버킷을 엽니다.

- **일 버킷**: UTC 00:00에 리셋 — **KST 09:00**
- **월 버킷**: 매월 1일 UTC 00:00에 리셋 — KST 기준 1일 09:00

운영상 의미가 둘 있습니다.

1. 한국 업무시간(KST 09:00~18:00)은 **UTC 00:00~09:00**, 즉 일 버킷이 열린
   직후 구간에 통째로 들어갑니다. 소진은 오전에 몰립니다.
2. "오늘 다 썼다"는 KST 기준 다음 날 오전 9시에 풀립니다. 밤에 막히면 아침까지
   막힌 채입니다.

### 2.1 거절이 가리키는 시각은 어느 버킷이 막았느냐에 따라 다릅니다

두 버킷은 서로 다른 시각에 회복되므로 하나의 답을 공유할 수 없습니다.

| 막은 버킷 | `resetAt` |
|---|---|
| 일 | 다음 UTC 자정 (KST 익일 09:00) |
| 월 | **다음 달 1일 UTC 00:00** |

월 예산이 소진됐는데 "내일 다시" 라고 답하면 사용자는 1일이 될 때까지 매일
같은 거절을 받고, 그때마다 받은 안내는 사실이 아니었던 것이 됩니다. 그래서
월 거절은 월 경계를 답합니다.

**운영상 의미**: 지원 문의에 "내일 풀린다"가 아니라 "다음 달 1일"이 찍혀 있으면
소진된 것은 일 예산이 아니라 **월 예산**입니다. 그 둘은 대응이 다릅니다 — 앞은
기다리면 되고, 뒤는 남은 기간을 멈춘 채로 둘지 한도를 올릴지 결정해야 합니다.

---

## 3. 값을 고르는 근거

### 3.1 해석에 쓸 수 있는 단위 — 전부 저장소 상수에서 나옵니다

| 단위 | 초 | 근거 |
|---|---|---|
| 최대 길이 클립 1개 | 120초 | `VOICE_CLIP_MAX_SECONDS` (§5.2) |
| 주체 1명이 하루 한도를 **전부** 쓴 경우 | 1,200초 | `VOICE_GUARDRAIL_DEFAULTS.secondsPerDay` |
| 같은 것, 환경변수로 ceiling까지 올린 경우 | 14,400초 | `VOICE_GUARDRAIL_CEILING.secondsPerDay` |

이 문서는 이 단위들을 **환산이 아니라 해석**으로 씁니다 — "3,600초"가 몇 명의
최대 사용일에 해당하는지는 산술이고, 그게 얼마인지는 산술이 아닙니다.

### 3.2 예약이 실제 오디오보다 클 수 있습니다

**길이를 읽지 못한 클립은 클립당 최대치(120초)로 예약합니다**(§5.2). Safari의
fragmented MP4가 `mvhd.duration = 0`을 쓸 수 있고, 그것은 거절이 아니라 부재로
처리되기 때문입니다.

그러므로 **예산 소진은 실제로 보낸 오디오 초보다 클 수 있습니다.** 정산이
공급자 보고 duration으로 되돌리지만, 예약 시점의 봉쇄는 최대치 기준입니다.
Safari 사용자가 있는 구간에서 예산이 예상보다 빨리 닳으면 이것이 원인일 수
있고, 한도를 올리기 전에 확인할 대상입니다.

### 3.3 가정 — 사용량 자료는 없습니다

**이 배포는 voice를 켠 적이 없으므로 사용량 관측이 존재하지 않습니다.** 아래
숫자는 예상 사용량에서 유도된 것이 아니고, 그렇게 읽어서도 안 됩니다.

세 안의 공통 가정은 하나입니다 — **bounded pilot exposure**: "이 배포에서
하루에 나가도 된다고 우리가 정한 오디오의 최대량". 각 안은 그 최대 노출량을
서로 다르게 잡은 것이고, 근거는 관측이 아니라 **감당하기로 한 노출의 크기**
입니다.

월 값은 **일 값 × 15**로 잡았습니다. 근거: 30배면 월 예산이 사실상 절대
걸리지 않아 층이 하나 사라지고, 15배면 "하루쯤 몰리는 것은 허용하되 매일
몰리는 것은 허용하지 않는다"가 됩니다. 코드가 강제하는 유일한 관계는
`month >= day`뿐이므로, 이 배수는 **바꿔도 되는 선택**입니다.

### 3.4 선택지 — 운영자가 고릅니다

**네 값 전부 사람이 정합니다. 이 표는 승인이 아니라 선택지입니다.**

| 안 | staging 일 | staging 월 | production 일 | production 월 |
|---|---|---|---|---|
| **A. 보수적 pilot** | 1,800 | 27,000 | 3,600 | 54,000 |
| **B. 기준** | 7,200 | 108,000 | 18,000 | 270,000 |
| **C. 확장** | 21,600 | 324,000 | 60,000 | 900,000 |

같은 숫자를 해석 단위로 옮기면:

| 안 | production 일 최대 노출 | = 최대길이 클립 | = 한도 소진 주체·일 |
|---|---|---|---|
| A | **1시간** | 30개 | 3명 |
| B | **5시간** | 150개 | 15명 |
| C | **약 16.7시간** | 500개 | 50명 |

각 안이 무엇을 감당하겠다는 뜻인지:

- **A — 이름을 아는 소수만.** B-6 실기기 검증과 내부 확인용. staging 값은
  `VOICE_PROVIDER_BUDGET_DEV_DEFAULTS`(1,800 / 18,000)와 일 한도가 같습니다 —
  개발 fallback이 "개발자가 천장을 눈치채도록" 일부러 작게 잡힌 값이고, pilot에
  그 크기가 맞다고 보는 안입니다.

  **A의 월 한도는 일 한도의 15배입니다**(production 3,600 / 54,000). 산술이
  말하는 것을 그대로 적습니다 — **매일 일 한도를 전부 쓰면 15일째에 월 예산이
  소진되고, 남은 보름 동안 voice는 멈춥니다.** 월 버킷은 다음 달 1일 UTC에야
  열립니다(§2).

  **이것은 결함이 아니라 pilot의 의도된 제한입니다.** 사용량 관측이 없는
  상태에서 매일 상한까지 쓰는 패턴이 나타났다면, 그것이 정상 사용인지 폭주인지
  이 배포는 아직 구분할 수 없습니다. 월 한도는 그 구분이 서기 전에 한 달치
  노출이 전부 나가는 것을 막습니다. 멈춤을 원치 않는다면 배수를 올리는 것이
  아니라 **관측을 근거로 안을 B로 올리는 것**이 맞는 순서입니다.
- **B — 예고된 공개.** 하루 5시간 오디오는 소규모 사용자 집단이 실제로 쓰는
  것을 흡수하면서, 잘못된 루프나 남용이 하루 안에 천장을 치게 둡니다.
- **C — 예산을 병목으로 두지 않음.** §7 주체별 guardrail이 실질 상한이 되고
  이 층은 재난 방지에 가깝습니다. **사용량 관측이 생긴 뒤에 고를 안이지, 켜기
  전에 고를 안이 아닙니다.**

**추천을 적지 않습니다.** 무엇을 감당할지는 이 저장소가 답할 수 없는 사실
(운영 예산, 공개 범위, 감시 여력)에 달려 있습니다.

**A는 권고값이지 시스템이 요구하는 최소값이 아닙니다.** B-6의 총 오디오는
보통 1분 미만입니다(항목당 5초 이하, 10회 남짓). 길이를 읽지 못한 클립이
120초로 예약되는 보수적 상황을 전부 합쳐도 A의 하루 한도에는 한참 못 미칩니다.
A를 권하는 이유는 검증이 막히지 않기 위해서가 아니라, **B-6과 초기 pilot에
재시도·재녹음·예상 못 한 반복까지 흡수할 운영 여유를 주기 위해서**입니다.
더 작은 값도 기술적으로 동작합니다.

---

## 4. 값을 넣지 않고 검증하는 방법

### 4.1 왜 별도 검사기가 필요한가

`/api/ready`는 **Voice flag가 켜져 있을 때만** 예산을 검사합니다
(`lib/voiceProviderBudgetReadiness.ts`: `ready: !flagEnabled || limits !== null`).
flag가 꺼져 있으면 예산이 없거나 망가져도 readiness는 통과하고, healthy일 때는
`reportOperationalDependencyStatus`가 **아무것도 기록하지 않습니다.**

그 계약 자체는 옳고 바꾸지 않습니다 — voice를 켠 적 없는 배포가 아무도 켜지
않은 기능 때문에 traffic을 거절당하면 안 됩니다. 문제는 **그래서 flag를 켜기
전에는 값이 맞는지 알 방법이 없었다는 것**이고, 그것은 §9.1의 "환경변수를 먼저,
flag를 나중에" 순서를 검증 없는 순서로 만듭니다.

### 4.2 검사기

```
npm run check:voice-provider-budget-env
```

- **읽기 전용.** 환경변수만 읽고 DB·네트워크·공급자에 닿지 않습니다.
- **숫자를 출력하지 않습니다.** env 이름, `set`/`MISSING`, 문제 코드,
  판정만 냅니다. 출력은 그대로 이슈나 기록에 붙여도 안전합니다.
- 사용할 수 없는 설정이면 **exit 1**.
- `--assume-production`으로 production 규칙을 강제로 적용해 볼 수 있습니다.

판정은 넷입니다.

| 판정 | 뜻 |
|---|---|
| `usable — both values are set and consistent` | 통과 |
| `usable, but NOT configured` | 개발 fallback이 값을 대신하고 있음. **flag를 켤 준비가 안 된 상태** |
| `usable, with a problem reported above` | 비-production 규칙에서만 통과. 같은 입력이 production에서는 거절 |
| `NOT usable` | 모든 요청을 거절하게 됨 |

### 4.3 `next start`는 production 규칙입니다

staging도 `next start`로 뜨고, Next.js는 그때 `NODE_ENV=production`을 씁니다.
**따라서 staging에도 개발 fallback이 적용되지 않으며 두 값을 명시해야
합니다.** 검사기가 첫 줄에 어느 규칙이 적용됐는지와 그 근거를 함께 출력하므로,
이 문장을 믿지 말고 출력을 보십시오.

### 4.4 CI에는 넣지 않습니다

이 검사는 **배포의 환경**을 읽습니다. CI runner에는 그 환경이 없으므로 PR Fast
Gate에 넣으면 항상 같은 답만 하는 검사가 됩니다.

---

## 5. 배포 순서 (env-first)

각 단계마다 **어디서 실행하는지**를 적습니다.

### 5.0 누가 무엇을 하는가, 그리고 왜

이 절차에서 사람이 실행하는 단계가 **두 종류**이고, 기록에서 섞으면 안 됩니다.

| 왜 사람이 하는가 | 어느 단계 | 해석·기록은 |
|---|---|---|
| **판단** — 감당할 노출량을 정하는 결정 | 값 선택(§3.4), 최종 서명 | 사람 |
| **접근 권한** — 에이전트에게 실행 수단이 없음 | 변수 설정, 검사기 실행, DB flag 쓰기 | **에이전트** |

두 번째 줄은 AGENTS.md가 말하는 "사람만 할 수 있는 것"이 **아닙니다.**
Railway MCP에 명령 실행 도구가 없고 CLI도 토큰도 이 컨테이너에 없어서 사람이
**대신 실행**하는 것뿐입니다. 그러므로 **출력의 해석과 기록 작성은 계속
에이전트의 몫이고**, 실행자에게 "이 출력을 읽고 판정하라"고 넘기지 않습니다.
실행자가 하는 것은 명령을 돌리고 나온 것을 그대로 전달하는 일입니다.

이 구분이 흐려지면 접근 권한의 한계가 사람의 작업으로 굳어집니다. 도구가
생기면 두 번째 줄은 에이전트로 돌아옵니다.

### 5.1 staging

1. **[Railway 웹 대시보드 — staging 환경, `Tomverse` 서비스]**
   Voice flag의 **현재 상태를 읽습니다**(§0.2). 아직 아무도 읽지 않았으므로
   꺼져 있다고 가정하지 않습니다 — `VOICE_INPUT_KILL_SWITCH`가 비어 있는 것은
   flag가 꺼져 있다는 증거가 아닙니다. 켜져 있다면 이 절차가 아니라
   롤백(§5.3)이 먼저입니다.

2. **[같은 화면]** 변수 두 개를 설정합니다. **쓰기 작업입니다.**
   `VOICE_PROVIDER_SECONDS_PER_DAY`, `VOICE_PROVIDER_SECONDS_PER_MONTH`.
   §3.4에서 고른 staging 값.

3. **[Railway staging 서비스 shell — bash]** 재배포가 끝난 뒤:
   ```
   npm run check:voice-provider-budget-env
   ```
   **출력 전체를 그대로 전달합니다** — 판정하지 않아도 됩니다. 첫 줄이 어느
   규칙이 걸렸는지 말하고(§0.1.1), 마지막 줄이 판정입니다. 자격증명은 필요
   없고 출력에 값이 없으므로, 어디에 붙여도 안전합니다.

   `usable — both values are set and consistent`가 아니면 다음 단계로 가지
   않습니다.

4. **[Railway 웹 대시보드]** staging이 `dde6ad87` 이상을 서비스 중인지
   확인합니다. 아니라면 `develop`을 배포합니다.

5. **[staging Postgres shell — 쓰기]** staging에서만 flag를 켭니다.
   ```sql
   INSERT INTO "AppSetting" (key, value) VALUES ('feature.voiceInputEnabled', 'true')
   ON CONFLICT (key) DO UPDATE SET value = 'true';
   ```

6. **[로컬 PowerShell 또는 브라우저]** readiness를 읽습니다. 자격증명 불필요,
   읽기 전용:
   ```powershell
   curl.exe -s https://<staging-host>/api/ready
   ```
   **두 가지를 함께 봅니다.**
   - `checks.voiceProviderBudget` = `true`
   - `checks.voiceModelPrice` = `true`

   둘 중 하나라도 `false`면 `ok`도 `false`이고 HTTP 503입니다. **flag를 끄고
   (§5.3) 원인을 고친 뒤 다시 옵니다.**

7. 이 시점부터 staging은 B-6(실기기 검증)을 실행할 수 있는 상태입니다. **B-6은
   이 문서의 범위가 아니고, `docs/ops/voice-input-staging-checklist.md`가
   따로 있습니다.**

### 5.2 production

**production flag는 이 절차에서 켜지 않습니다.** B-5와 B-6이 남아 있는 동안
production 활성화는 §14가 막습니다.

지금 할 수 있는 것은 **값을 미리 넣어 두는 것**뿐이고, 그것이 env-first의
production 쪽 절반입니다.

1. **[Railway 웹 대시보드 — production 환경]** 변수 두 개 설정. **쓰기.**
2. **[production 서비스 shell]** `npm run check:voice-provider-budget-env`.
   `500ce79f`에도 `lib/voiceProviderBudget.ts`는 있으므로 이 검사는 지금도
   동작합니다.
3. `/api/ready`는 **flag가 꺼져 있으므로 이 값들에 대해 아무 말도 하지
   않습니다.** 그것이 정상이고, 그래서 2번이 필요합니다.
4. `voice-transcription-model-price` 검사는 **main이 `dde6ad87`을 받은 뒤에야**
   production에 존재합니다(§0.3). 그 전까지 production readiness에 그 항목은
   없습니다.

### 5.3 롤백

**어느 단계에서 실패하든 되돌리는 것은 flag이지 변수가 아닙니다.**

1. **[Postgres shell — 쓰기]** flag를 끕니다.
   ```sql
   UPDATE "AppSetting" SET value = 'false' WHERE key = 'feature.voiceInputEnabled';
   ```
2. 더 급하면 **[Railway 웹 대시보드]** `VOICE_INPUT_KILL_SWITCH`에 아무 값이나
   넣습니다. DB를 읽지 않고 끕니다.
3. **변수를 지우지 않습니다.** 지우면 production에서 `/api/ready`가 실패하고,
   그것은 voice가 아니라 **배포 전체**를 unhealthy로 만듭니다. 잘못된 예산의
   답은 올바른 예산이지 예산 없음이 아닙니다.

---

## 6. 검증 기록 초안

**실행자는 관측을 전달하고, 초안은 에이전트가 씁니다**(§5.0). 실행자가 직접
채워야 하는 것은 **판정과 서명**뿐입니다. 지어낸 관측은 어느 칸에도 넣지
않습니다.

**B-4에 속하지 않는 것을 이 기록에 넣지 않습니다** — 전용 transcription 키의
유무(B-5), 주체별 guardrail override(§7), kill switch의 상태.

````
# B-4 provider 예산 운영 설정 기록

- 실행일(UTC):
- 실행자:
- staging deploy SHA(40자리):
- production deploy SHA(40자리):
- 선택한 안: A / B / C / 직접 지정
- 선택 근거(한 줄):

## 설정한 값

| 환경 | 일 | 월 |
|---|---|---|
| staging | | |
| production | | |

## 검사기 출력 (값이 없으므로 그대로 붙입니다)

staging:
```
(npm run check:voice-provider-budget-env 출력)
```

production:
```
(같은 것)
```

## 적용된 규칙 (검사기 첫 줄을 그대로)

- staging:
- production:

## Voice flag 상태 (§0.2로 읽은 값)

- staging (설정 전):
- staging (설정 후):
- production:

## staging /api/ready

- `checks.voiceProviderBudget`:
- `checks.voiceModelPrice`:
- `ok`:
- HTTP status:

## 판정

- [ ] staging 두 항목 healthy
- [ ] production 두 변수 설정·검사기 통과
- 판정(통과/조건부/실패):
- 서명:
````

---

## 7. B-4를 해결로 바꿀 수 있는 조건

**이 문서를 읽은 것은 조건이 아닙니다.** 아래가 전부 있어야 §14의 B-4를
`해결`로 바꿉니다.

1. **staging과 production 양쪽**에 두 변수가 사람이 고른 값으로 설정돼 있다.
2. 양쪽에서 `check:voice-provider-budget-env`가
   `usable — both values are set and consistent`를 냈고, 그 출력이 기록에
   있다. **그 출력의 첫 줄이 어느 규칙이 걸렸는지도 함께 남습니다** — 기동
   명령에서 추론한 것은 증거가 아닙니다(§0.1.1).
3. staging에서 flag를 켠 상태의 `/api/ready`가
   `voiceProviderBudget`과 `voiceModelPrice` **둘 다** healthy였고, 그 관측이
   기록에 있다.
4. 기록에 **선택한 값과 그 근거**가 적혀 있다. "기본값을 썼다"도 근거이지만,
   적혀 있어야 근거입니다.
5. 사람이 서명했다.

**3번을 production에서 요구하지 않는 이유**는 production flag가 B-5·B-6 때문에
켜질 수 없기 때문입니다. production 쪽 증거는 1·2번(값이 있고 검사기가
통과)까지이고, flag를 켜는 순간의 readiness 확인은 **B-5·B-6이 풀린 뒤 그
활성화 절차의 일부**입니다.

이 다섯이 갖춰지기 전까지 B-4는 **"결정·코드 완료, 환경별 실제 한도 설정
대기"** 그대로입니다.
