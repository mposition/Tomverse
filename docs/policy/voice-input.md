# 음성 입력 (Voice Input)

## 상태

- 문서 종류: 승인 대기 중인 설계·결정 문서
- 구현 상태: MVP 구현 완료, **production 비활성**
- production 활성화: **차단됨** — §6과 §14의 미결정 사항이 남아 있습니다
- 마지막 검토: 2026-08-30

이 문서는 감사 보고서가 아니라 계약입니다. 코드 주석의 `docs/policy/voice-input.md §N`
인용은 전부 이 문서의 절 번호를 가리킵니다.

---

## 1. 이 기능이 하는 일과, 절대 하지 않는 일

사용자가 채팅 입력창의 마이크를 눌러 말하면, 서버가 그 음성을 텍스트로 바꿔
**입력창에 넣어 줍니다.** 그게 전부입니다.

**변환된 텍스트는 자동으로 전송되지 않습니다.** 이것이 이 기능의 첫 번째
불변식이고, 나머지 설계가 그 주위에 배치돼 있습니다.

- `lib/voiceRecorderMachine.ts`의 effect 어휘에는 전송이 없습니다. 새 effect를
  추가하려면 `tests/voiceRecorderMachine.test.mjs`의 목록을 **의도적으로**
  고쳐야 합니다.
- `components/chat/useVoiceRecorder.ts`에는 submit callback도, send handler
  ref도, event dispatch도 없습니다.
- `tests/e2e/voice-input-composer.spec.ts`가 실제로 녹음한 뒤 `/api/chat`
  요청이 **0건**임을 확인합니다.

이유는 단순합니다. 음성 인식은 틀립니다. 틀린 문장이 사용자가 읽기 전에
전송되면 그 결과는 되돌릴 수 없습니다 — 모델 응답이 이미 생성되고 크레딧이
이미 차감됩니다. 사용자가 읽고 고칠 기회는 이 기능의 편의 사항이 아니라
안전장치입니다.

**이번 범위가 아닌 것**: native 앱, 답변 음성 재생(TTS), 실시간 양방향 voice
mode, 자동 전송.

---

## 2. 두 개의 스위치

| | rollout flag | kill switch |
|---|---|---|
| 위치 | `AppSetting["feature.voiceInputEnabled"]` | 환경변수 `VOICE_INPUT_KILL_SWITCH` |
| 기본값 | 없음 = off | 없음 = 켜짐 허용 |
| 켜는 방법 | §14 활성화 절차의 DB write | — |
| 끄는 방법 | 같은 row를 `"false"`로 | **아무 값이나 넣으면 즉시 off** |
| DB 필요 | 예 | **아니오** |
| 우선순위 | 낮음 | **항상 이김** |

판정은 `lib/voiceInputAccess.ts` 한 곳입니다. flag는 `"true"` 문자열만
활성화하고(누락·NULL·빈 문자열·`"1"`·`"TRUE"`는 전부 off), kill switch는
비어 있지 않은 **아무 값이나** off로 읽습니다.

그 비대칭이 요점입니다. 새벽 3시에 `VOICE_INPUT_KILL_SWITCH=y`라고 친 운영자는
자기가 무엇을 의도했는지 말한 것이고, "그건 제가 받는 네 가지 철자가 아니니
계속 서비스하겠습니다"라고 답하는 스위치는 아무도 원하지 않는 방향으로 실패한
스위치입니다.

kill switch가 DB를 읽지 않는 것도 의도입니다. 장애의 원인이 DB일 때도
동작해야 하고, 환경변수 배포는 코드 배포보다 빠릅니다.

**admin console에 토글이 없습니다.** `lib/appSettings.ts`에는
`setVoiceInputEnabled`가 존재하지 않으며, 이 부재는
`tests/appSettingWriters.test.mjs`에 근거와 함께 등록돼 있습니다. 이유는
§14입니다.

---

## 3. 하나의 boolean

UI가 보는 것은 `voiceInputEnabled` 하나이고, 서버가 세 가지 사실을 folding해
만듭니다 — rollout flag, kill switch, 로그인 여부(§4).

`components/chat/ReviewWorkspaceShell.tsx`가 요청마다 resolve하고
`ChatPageClient` → 두 shell → `ChatInput`으로 내려갑니다.

- **client가 flag를 다시 유도하지 않습니다.** Client Component의
  `process.env`는 build-time 치환이므로, client 쪽 사본은 운영자가 kill switch를
  당긴 뒤에도 계속 마이크를 그릴 것입니다.
- **false면 마이크를 아예 렌더링하지 않습니다** — 비활성화된 것이 아니라
  없습니다. 보이지만 거부하는 컨트롤은 이 배포가 의도적으로 켜지 않은 기능을
  광고하는 일입니다.

---

## 4. 익명 사용자는 제외합니다 — 그 근거

**MVP는 로그인 사용자 전용입니다.** 게스트는 마이크를 볼 수 없고, endpoint는
401 `VOICE_AUTHENTICATION_REQUIRED`로 거절합니다.

이 결정은 "게스트는 익명이니까"가 아닙니다. 게스트는 이미 파일을 첨부할 수
있고, 기존 abuse protection을 실제로 조사했습니다.

- signed guest cookie(`access.subjectKey`)가 주체를 식별합니다.
- Turnstile이 업로드를 gate합니다(`ensureGuestVerified`).
- 분당 3회·일 12회·일 25 MB 예산이 저장소 사용량을 제한합니다.

이 셋은 전부 **저장소**를 제한하며, 저장소는 이 제품이 이미 가격을 아는
비용입니다. transcription은 저장소가 아니라 **제3자에 대한 초당 과금 호출**이고,
오디오 1초가 사용자에게 얼마인지는 이 저장소에 정해진 답이 없습니다(§6).
게스트에게는 그것을 인출할 크레딧 계정도 플랜도 없으므로, 게스트를 허용한다는
것은 **cookie 하나를 근거로 값이 정해지지 않은 provider 호출을 제공한다**는
뜻입니다.

§6이 정해지면 게스트 허용은 `lib/voiceInputAccess.ts`의 정책 변경 한 곳이지,
composer와 route에 흩어진 수정이 아닙니다.

**플랜은 gate가 아닙니다.** 로그인한 모든 플랜(Free 포함)이 쓸 수 있습니다.
음성 입력은 타이핑을 대체하는 것이지 더 좋은 답을 사는 것이 아니고, 접근성
편의를 tier로 막는 것은 별개의 제품 결정입니다. `voiceInputRefusal()`이 `tier`를
받으면서 **의도적으로 읽지 않는** 것은 이 결정을 서명에 남기기 위해서입니다.

---

## 5. 서버가 강제하는 제한

### 5.1 언제나 강제되는 것

| 항목 | 값 | 강제 위치 |
|---|---|---|
| 최대 업로드 | 8 MB | `Content-Length` **와** 실제 도착 바이트 양쪽 |
| 최소 크기 | 2 KB | 실제 도착 바이트 |
| 허용 컨테이너 | `audio/webm`, `audio/mp4`, `audio/wav` | 선언 + **바이트 sniff** |
| transcript 최대 | 4,000자 | 잘라내지 않고 **거절** |

`Content-Length`는 주장이지 사실이 아니므로 양쪽을 봅니다. 선언한 media type과
실제 바이트가 어긋나면 `VOICE_CLIP_TYPE_MISMATCH`입니다 — 첨부 정책의 "이름이
정하고 MIME은 힌트" 규칙과 같은 방향입니다.

형식 표는 `lib/voiceInputFormats.ts` **하나**입니다. recorder의 선호 순서,
서버 allowlist, 컨테이너 sniff, provider 전달이 전부 여기서 파생됩니다. 첨부
형식 목록이 넷으로 갈라져 있던 사고를 반복하지 않기 위해서입니다.

`audio/ogg`가 없는 이유: Firefox는 기꺼이 녹음하지만 transcription provider가
받지 않습니다(OpenAI speech-to-text 문서, 2026-08-30 확인: `mp3`, `mp4`,
`mpeg`, `mpga`, `m4a`, `wav`, `webm`). 받아 놓고 변환하지 못하는 것은 거절을
**사용자가 조치할 수 있는 시점(녹음 전)에서 이미 말해 버린 뒤로** 옮기는
일입니다.

### 5.2 길이 제한 — 무엇이 hard이고 무엇이 best-effort인지

**제한: 클립당 120초**(거절 임계값은 recorder의 반올림 여유로 121초).

길이는 provider 호출 **전에** 컨테이너에서 읽습니다(`lib/voiceClipDuration.ts`).
이것이 실제로 무엇을 보장하는지는 **측정해서** 정했습니다. Chromium 1194의 실제
`MediaRecorder` 출력 기준:

- `audio/webm`은 `Segment > Info > TimecodeScale`과 `Duration`을 씁니다.
  2.5초 녹음이 2400.6(× 1 ms)을 선언했습니다.
- `audio/mp4`는 fragmented이고 `mvhd`가 채워집니다. 3.0초 녹음이
  timescale 1000에 duration 2960을 선언했습니다.

두 경우 모두 provider 호출 전 거절이 가능합니다.

**관측하지 않은 것: Safari.** production에서 MP4를 녹음하는 유일한 엔진이고 이
컨테이너에서 실행할 수 없습니다. fragmented MP4는 `mvhd.duration = 0`을 쓰고
길이를 fragment에 맡길 자격이 있으므로, `unknown`은 실제로 발생 가능한 결과이며
**거절이 아니라 부재로 처리합니다.** 길이를 읽지 못한 클립을 전부 거절하는
편이 깔끔했겠지만, 그것은 **어떤 엔진의 동작에 대한 추측을 근거로 그 엔진 전체에서
기능을 못 쓰게 만드는 일**입니다. 확인은
`docs/ops/voice-input-staging-checklist.md` D-3입니다.

길이를 읽지 못해도 다음 셋이 남습니다: 8 MB 상한, §7의 일일 초 예산(모르는
길이는 **클립당 최대치로 예약**), provider가 스스로 보고한 duration으로의 정산.

### 5.3 클라이언트도 같은 제한을 갖습니다

브라우저는 120초에서 recorder를 멈추고, 2 KB 미만 클립을 업로드 전에
거절합니다. 이것은 **선점(pre-emption)이지 강제(enforcement)가 아닙니다** —
서버가 독립적으로 같은 것을 검사합니다. 게스트 첨부 정책의 "client의 사본은
거절을 앞당길 뿐 정의하지 않는다"와 같은 규칙입니다.

recorder의 비트레이트는 32 kbps로 **고정**합니다. 브라우저에 맡기면 128 kbps로
녹음하는 기기가 옆 기기보다 예산을 네 배 빨리 씁니다.

---

## 6. 가격 — **미결정. production 활성화 차단 사유.**

**이 기능은 현재 크레딧을 차감하지 않습니다.** entitlement 층이 아예 없습니다.

이것은 "무료 정책"이 아니라 **정해지지 않았다는 사실의 정직한 구현**입니다.
AGENTS.md의 "가격·보존·제3자 전송에 관한 결정이 부족하면 추측하지 말고 별도
결정 문서에 미결정 사항을 명시하세요"에 따라, 여기에 무엇이 정해지지 않았는지
적습니다.

### 6.1 정해지지 않은 것

1. **오디오 1초의 사용자 가격.** 크레딧으로 환산할지, 무료 편의 기능으로 둘지,
   플랜에 초 할당량을 둘지. 셋은 서로 다른 결정이고 어느 것도 다른 것에서
   유도되지 않습니다.
2. **실패 시 처리.** transcript가 비어 돌아온 경우(=provider는 과금했고
   사용자는 아무것도 못 받음) 크레딧을 받을지, 환급할지, 애초에 받지 않을지.
3. **provider 원가의 검증.** `lib/modelPricing.ts`의
   `PENDING_VERIFIED_PRICE_REGISTER`는 **텍스트 모델**의 계층이고, 이미지 정책이
   그렇듯 audio는 **세 번째 계층**입니다. audio 초당 단가를 어느 register에
   담을지, 담당자·검증 티켓·기한을 누가 갖는지가 정해지지 않았습니다.
4. **provider 예산.** `CHAT_PROVIDER_*_COST_*`는 채팅 provider 예산이고 audio는
   그 안에 들어가지 않습니다. audio 전용 provider 예산을 둘지, 둔다면
   `/api/ready`가 production에서 그 부재를 실패로 볼지.

#### 6.1.1 공급자에게서 확인된 것 (2026-09-02 읽음)

**가격이 정해졌다는 뜻이 아닙니다.** 아래는 공급자가 공개한 숫자와 관측
경로이며, 1~4의 결정은 그대로 열려 있습니다.

**정가** — developers.openai.com `/api/docs/pricing`. 표의 열은
`Model | Use case | Input | Output | Estimated cost`입니다.

| 모델 | Input | Output | Estimated cost |
|---|---|---|---|
| `gpt-4o-mini-transcribe` | $1.25 / 1M tokens | $5.00 / 1M tokens | $0.003 / minute |
| `gpt-4o-transcribe` | $2.50 / 1M tokens | $10.00 / 1M tokens | $0.006 / minute |

**토큰 단가는 정가이고, 분당 숫자는 공급자가 이름 붙인 "Estimated cost"입니다.**
분당 정가로 옮겨 적지 않습니다 — 문서는 그것을 예상 비용이라 부르고, 두 숫자의
유도 관계를 설명하지 않습니다.

**관측 경로는 넷이고, 서로 다른 것을 셉니다.**

| # | 무엇 | 어디서 | 단위 |
|---|---|---|---|
| 1 | 요청이 쓴 토큰 | transcription 응답의 `usage` | input/output tokens |
| 2 | 이 앱이 잰 클립 길이 | `measured_clip`(`lib/voiceClipDuration.ts`) | 초 |
| 3 | 공급자가 집계한 길이 | Admin Usage API `GET /organization/usage/audio_transcriptions` | 초 (`seconds`, `num_model_requests`) |
| 4 | 실제 청구 금액 | Admin Costs API `GET /organization/costs` | USD |

3과 4는 **admin API key**가 필요하며 일반 요청 키와 다른 권한입니다.

**그래서 `provider_seconds` 정산에 대해 말할 수 있는 것은 이것뿐입니다.**
설정된 기본 모델 `gpt-4o-mini-transcribe`는 token-billed라 **동기 응답의
`usage`만으로는 초를 알 수 없고**, 그 경로에서는 정산이 `measured_clip`으로
떨어집니다. "공급자가 초를 전혀 보고하지 않는다"가 아닙니다 — 3의 Usage API는
집계된 `seconds`를 돌려줍니다. 다만 그것은 **요청 시점의 동기 값이 아니라
사후 집계**이므로, 요청 하나를 정산하는 데 쓸 수 없습니다.

**4는 요청별 대조가 되지 않습니다.** Costs API는 일 단위 버킷(`1d`)만
지원하고 `project_id`·`line_item`·`api_key_id` 단위로 집계합니다. 그러므로
대조는 **격리된 키 또는 프로젝트**에서, 또는 **다른 트래픽이 없는 구간**에서
집계 대 집계로 해야 합니다. (3의 Usage API는 `1m`·`1h`·`1d`를 지원해 더
촘촘하지만, 여전히 집계입니다.)

#### 6.1.2 제안 — 결정이 아닙니다

**아래 중 어느 것도 확정되지 않았습니다.** 6.1.1과 섞어 읽지 않도록 절을
나눠 둡니다. 사람이 승인하기 전에는 코드에도 register에도 넣지 않습니다.

- audio 전용 검증 register를 텍스트 모델의 `PENDING_VERIFIED_PRICE_REGISTER`와
  **분리해서** 만들자는 것 — 이름, 위치, 형식 전부 미정입니다.
- 그 register의 **소유자·검증 티켓·재검증 기한** — 1인 조직이라도 증거를 만든
  주체와 승인자는 구분되며, 승인자는 사람이어야 합니다.
- **`measured_clip`을 정산 근거로 승인**할지, 아니면 초 단위 동기 정산을 위해
  duration-billed 모델로 바꿀지. 뒤는 품질·가격이 함께 걸린 별개 결정입니다.
- ZDR 신청, DPA 체결, 조직·프로젝트 분리 (§11.3.2).

6.1.1은 §14의 B-3을 해제하지 않습니다. B-3이 요구하는 것은 **register의
소유자·티켓·기한**이고, 그것은 여기 없습니다. 유료 검증은 **실행하지
않았습니다.**

### 6.2 정해질 때까지 지켜지는 것

- entitlement 층을 **만들지 않습니다.** 절반만 구현된 과금은 없느니만
  못합니다.
- §7의 operational guardrail만 존재하며, 이름·오류 코드·bucket·환경변수를
  크레딧 층과 **절대 섞지 않습니다**.
- rollout flag는 off로 남고, admin console에 토글이 없습니다(§14).

---

## 7. Operational guardrail — entitlement가 아닙니다

`lib/voiceInputGuardrails.ts`(순수) + `lib/voiceInputBudget.ts`(DB).

AGENTS.md의 "Credit entitlement vs operational guardrail"이 요구하는 분리를
지킵니다. 어휘 전체가 별개입니다.

| | 이 층 | 절대 쓰지 않는 것 |
|---|---|---|
| 환경변수 | `VOICE_INPUT_*` | `CHAT_*` |
| bucket period | `voice-seconds-day` | `cost-*`, `op-cost-*` |
| 오류 코드 | `VOICE_OPERATIONAL_LIMIT_REACHED` | `OPERATIONAL_COST_GUARDRAIL_TRIGGERED`, 크레딧 코드 |

### 7.1 두 개의 다른 층

- **요청 횟수**는 평범한 abuse protection이고 다른 endpoint와 같은
  `consumeApiRateLimit`(scope `voice-transcription`)을 씁니다.
- **초 예산**이 실제로 지출을 제한하는 것입니다. provider가 초당 과금하므로,
  횟수만으로는 상한이 "클립당 최대치 × 횟수"가 되어 아무도 의도하지 않은
  큰 수가 됩니다.

기본값: 일 40회, 분 6회, **일 20분**. 환경변수 override는 상한(§`VOICE_GUARDRAIL_CEILING`)
**아래로만** 갈 수 있고, 넘으면 clamp 후 보고합니다. `0`이나 음수는 무시합니다 —
0은 모든 요청을 예산 메시지로 거절해서 장애처럼 읽히고, **끄는 것은 kill
switch의 일이며 그쪽은 그렇다고 말합니다.**

`lib/chatCostGuardrails.ts`가 override의 **하한**을 강제하는 것과 방향이
반대인 이유: 그쪽의 유도값은 사용자의 entitlement라 낮추면 지불한 것을 빼앗는
일이고, 이쪽은 entitlement가 없으므로 잘못될 수 있는 방향은 청구서가 커지는
쪽뿐입니다.

### 7.2 예약 후 정산 — 네 가지 근거

provider가 답하기 전에는 몇 초인지 모릅니다. 나중에만 기록하면 동시에 연
요청 수만큼 예산을 넘길 수 있으므로, 채팅 경로와 같은 모양을 씁니다.

**예약 기준**: 컨테이너가 선언한 길이(올림), 선언하지 않았으면 **클립당
최대치**. 길이를 말하지 않는 클립은 허용된 만큼 길다고 가정해야 합니다 —
fail-closed이고, 채팅 예약의 `conservative_default`와 같은 논리입니다.

**정산 근거는 네 가지이고 서로 다른 사실입니다**
(`VoiceSettlementBasis`, `lib/voiceInputGuardrails.ts`).

| 근거 | 무엇을 아는가 | 예약 처리 |
|---|---|---|
| `provider_seconds` | provider가 처리했다고 **스스로 보고한 초** | 그 값으로 정산 |
| `measured_clip` | **우리가** 컨테이너에서 읽은 길이 | 그 값으로 정산 |
| `reservation` | 아무 근거도 없음 | 예약 유지 |
| `not_billed` | 청구가 없었음을 **안다** | 전액 반환 |

`provider_seconds`와 `measured_clip`을 구분하는 이유: 앞은 상대의 청구에 대한
진술이고 뒤는 오디오에 대한 우리 측정입니다. 값이 같아도 근거가 다르므로
로그에 `settlementBasis`로 남깁니다.

**토큰은 초로 환산하지 않습니다.** §7.3을 보십시오.

### 7.3 provider가 무엇을 보고하는가 — 확인된 사실

공식 문서 확인(OpenAI, `POST /v1/audio/transcriptions`, 2026-08-31 열람):

- `usage`는 두 형태 중 하나입니다 — `{type:"duration", seconds}` 또는
  `{type:"tokens", input_tokens, output_tokens, total_tokens}`.
- **`gpt-4o-transcribe`·`gpt-4o-mini-transcribe`는 토큰 과금**,
  `whisper-1`은 시간 과금입니다.
- 최상위 `duration` 필드는 **`verbose_json` 응답(`TranscriptionVerbose`)에만**
  있습니다. 이 port가 요청하는 `json` 응답에는 없습니다.

**여기서 발견된 결함**: adapter가 `json`을 요청하면서 최상위 `duration`만
읽었으므로, 성공한 모든 호출에서 `durationSeconds`가 `null`이었습니다. "provider가
청구한 값으로 정산한다"는 문장은 실제로 아무것도 움직이지 않았습니다.

**현재 설정 모델은 토큰 과금이므로 provider가 보고하는 초가 없습니다.**
따라서 이 배포에서 성공 경로의 정산 근거는 사실상 `measured_clip`(컨테이너를
읽을 수 있을 때)이거나 `reservation`(읽을 수 없을 때)입니다. 토큰 수를 초나
금액으로 환산하지 않습니다 — 승인된 환산율이 없고, 만드는 순간 §6.1이 미결로
둔 결정을 코드가 대신 내리는 것이 됩니다.

**토큰 수는 로그에도 남기지 않습니다.** `output_tokens`는 transcript 길이의
대리 지표이고, §11.2는 transcript의 길이를 transcript 자체만큼 단호하게
금지합니다. 로그에는 **단위의 종류**(`usageKind`: `duration`·`tokens`·`absent`)만
남깁니다.

**이것은 원가 집계가 아닙니다.** 이 저장소는 audio 1초·1토큰의 실제 원가를
측정할 수 없고, 그 검증은 §14 B-3으로 남아 있습니다.

### 7.4 실패를 세 가지로 나눕니다 — §7의 이전 문장에서 바뀐 부분

**이전 계약**: "실패한 호출은 0으로 정산합니다 — provider가 거절한 클립에
과금하지 않았는데 예약을 남겨 두면 우리 장애에 사용자의 하루 예산을 쓰는
일입니다."

그 문장은 **provider가 거절한** 경우에 대해 맞습니다. 문제는 코드가 *모든*
실패를 그렇게 처리했다는 것입니다. 타임아웃은 provider가 일을 하지 않았다는
증거가 아니고, 파싱하지 못한 2xx는 오히려 **일이 끝났을 가능성이 높습니다.**

그래서 실패를 `VoiceTranscriptionDisposition` 세 가지로 나눕니다.

| disposition | 언제 | 예산 |
|---|---|---|
| `not_sent` | 요청을 아예 보내지 않음(키 없음) | 전액 반환 |
| `refused` | provider가 답했고 그 답이 거절(401/403, 4xx, 429) | 전액 반환 |
| `indeterminate` | 보냈고 결과를 모름(타임아웃·연결 끊김·5xx·2xx 파싱 실패) | **예약 유지** |

**변경 이유와 대가**: `indeterminate`를 미청구로 확정하는 것은 근거 없는
낙관이고, 공급자가 불안정할 때 정확히 그 순간에 guardrail이 작동을 멈추게
합니다. 대가는 실제로 청구되지 않은 호출이 사용자의 그날 예산 일부를 차지할 수
있다는 것입니다. 이 대가를 받아들이는 근거는 셋입니다 — (1) 이것은 지출
guardrail이지 entitlement가 아니고, (2) 사용자에게 청구되는 크레딧이 **없으며**,
(3) 예산은 다음 UTC 일에 초기화됩니다.

**429는 5xx와 다르게 분류합니다.** rate limit은 "시작하지 않겠다"는 거절이고,
5xx는 "무슨 일이 있었는지 모른다"입니다.

`provider_rate_limited`가 `provider_unavailable`에서 분리된 것도 이 때문입니다.

### 7.5 예약과 정산은 같은 bucket을 씁니다

`reserveVoiceSeconds()`가 돌려주는 `VoiceSecondsReservation`이 자기
`periodStart`를 들고 다니고, 정산·해제는 **그 bucket**을 갱신합니다.

**고쳐진 결함**: 정산이 실행 시점의 UTC 날짜를 다시 계산했으므로,
23:59:58에 예약하고 00:00:01에 정산한 클립은 **다음 날의 행**을 향해 `UPDATE`를
보냈습니다. 그 행은 없거나 다른 날의 것이므로 예약은 영원히 반환되지 않고,
사용자는 그만큼의 예산을 하루 동안 조용히 잃었습니다.

핸들은 **1회용**입니다(`settled`). 중복 callback이나 `finally` 뒤에 도는
`catch`가 예산을 두 번 돌려주지 못하고, 핸들이 지역 변수이므로 다른 요청의
예약에 닿을 수도 없습니다.

## 8. 상태 머신

`lib/voiceRecorderMachine.ts`는 **순수 reducer**입니다. `MediaRecorder`도
`fetch`도 timer도 React도 없고, `components/chat/useVoiceRecorder.ts`가 그것들을
소유하는 adapter입니다.

이 분리는 장식이 아닙니다. 실제로 이 기능을 깨뜨리는 순서들 — 취소 후에 도착한
blob, 포기한 뒤에 도착한 권한 응답, 같은 tick에 겹친 제한과 정지 — 은 실제
recorder를 돌려서 안정적으로 재현할 수 없고, 전부 reducer에 대한 단위
테스트입니다.

### 8.1 상태

`idle` → `permission_pending` → `recording` → `stopping` → `transcribing` →
`idle`, 그리고 어디서든 `error`.

effect는 데이터로 이름만 붙이고 hook이 수행합니다:
`request_microphone`, `start_capture`, `stop_capture`, `discard_capture`,
`release_microphone`, `upload_clip`. **submit은 없습니다**(§1).

### 8.2 session 계수

`MediaRecorder`는 `stop()`이 즉시 반환하고 마지막 `dataavailable`이 나중에
옵니다. 취소하고 곧바로 다시 녹음한 사용자는 서로 다른 recorder 둘의 callback을
동시에 갖고 있고, 오래된 쪽도 자기 바이트를 전달할 자격이 있습니다.

모든 late event는 `sessionId`를 갖고, 현재 상태의 것과 다르면 **버립니다.**
이것이 없으면 취소한 녹음의 오디오가 그것을 대체한 녹음의 composer에
들어갑니다 — 흐름의 버그가 아니라, **사용자가 명시적으로 버린 것을 제품이
전사하는 일**입니다.

hook에는 두 번째 방어가 있습니다: reducer의 session 검사가 *상태*를 지키고,
`discardedRef` 검사가 *draft*를 지킵니다.

### 8.3 UI

composer 계약(`docs/ui-contracts/mobile-chat-composer.md`)의 anatomy를 지킵니다.

- **버튼**은 actions row에, 다른 44px 컨트롤들과 함께.
- **상태**(경과 시간, 취소, 오류)는 textarea **위의 자기 row**에.

상태를 버튼 옆에 두면 actions row에서 자라고 wrap하다가 320px composer에서 Send를
밖으로 밀어냅니다. 상태 row는 rest 상태에서 `null`을 반환하므로 평소에는 높이를
차지하지 않습니다.

- **정지와 취소는 다른 컨트롤입니다.** 정지는 "이걸 쓴다", 취소는 "버린다"이고,
  누르는 시간에 따라 둘 다 되는 하나의 컨트롤은 이 흐름에서 실수가 복구
  불가능해지는 유일한 지점이 됩니다.
- **취소는 `transcribing` 중에도 가능합니다.** 마음이 바뀐 사용자는 기다림을
  멈출 자격이 있고, 뒤에 도착하는 transcript는 §8.2가 버립니다.
- **transcript는 draft에 append합니다**, 대체하지 않습니다. 절반 타이핑하고
  나머지를 말하는 것은 정상적인 사용법이고, 대체는 이 마이크를 undo 없이 작업을
  조용히 파괴할 수 있는 composer 유일의 컨트롤로 만듭니다.
- 제한 도달은 녹음을 **정지**시킬 뿐 **버리지 않습니다.** 120초 제한을 지키려고
  120초의 발화를 버리는 것은 제한이 그것에 도달한 사람을 벌하는 일입니다.
- 색: 녹음 중 `red`(status 색, guarded hue 아님), 나머지 zinc/blue. **accent
  role token을 새로 만들지 않았습니다** — 이 기능에 필요 없는 색 결정이고
  맞춰야 할 네 번째 대상이 늘 뿐입니다.

### 8.4 녹음은 시작한 대화에 속합니다

**`ChatInput`은 대화를 바꿔도 remount되지 않습니다.** 그래서 A에서 시작한
변환의 결과가 B가 열린 뒤에 도착하면, 그대로 **B의 초안에 붙었습니다.**

이제 세 지점에서 막습니다.

1. **세션은 시작 시점의 draft scope를 붙잡습니다.** `onTranscript`는 화면에
   열려 있는 대화가 아니라 **그 scope**를 함께 돌려줍니다.
2. **scope나 로그인 신원이 바뀌면 세션을 끝냅니다**(`scope_changed` →
   `VOICE_SCOPE_CHANGED`). 녹음도 변환 대기도 마찬가지이며, 클립은 버리고
   마이크를 닫습니다. 사용자에게는 "다른 대화로 이동해 중단됐고 추가된 내용은
   없다"고 한 문장으로 알립니다.

   **신원은 사람 단위로 비교합니다.** 키는
   `identityNamespaceKey`(`account:<userId>`)이며, 처음 구현은 `"guest"`/
   `"account"` 두 값뿐이라 **같은 탭에서 계정 A가 계정 B로 바뀌는 것을 보지
   못했습니다.** 그것이 이 규칙에서 가장 중요한 전환입니다 — 정리 문제가 아니라
   개인정보 경계이기 때문입니다.

   **아직 모르는 신원은 변경이 아니지만, 비교 기준을 덮어쓰지도 않습니다.**
   session provider는 hydration 뒤에 확정되므로 `null → account:x`를 변경으로
   보면 방금 시작한 녹음을 취소하게 되고, refetch로 인한 `account:x → null`도
   마찬가지입니다. 그런데 그 `null`을 **비교 기준으로 저장하면** 막으려던 구멍이
   그대로 다시 열립니다.

   ```
   A → null    변경 아님, 그리고 기준이 null이 됨
   null → B    한쪽이 null이라 변경 아님
   ```

   결과는 **세션이 살아 있는 채로 계정이 A에서 B로 바뀐 것**입니다. 그래서
   기준은 **마지막으로 실제로 알려진 신원**을 유지하고, `null`은 기록의 값이
   아니라 공백입니다. `A → null → B`는 A와 B를 비교해 세션을 끝내고,
   `A → null → A`는 끝내지 않습니다.

   판정은 `resolveVoiceSessionBoundary()` 한 곳이며, **다음 비교 기준을 함께
   돌려줍니다** — 호출부가 `nextIdentity`를 그냥 저장하면 위 결함이 되돌아오기
   때문입니다. 네 경로 전부 `tests/voiceSessionScopes.test.mjs`가 순차로
   구동합니다.

   **브라우저에서 실행되는 것은 그중 셋이고, 나머지는 이 앱이 만들지 않는
   상태입니다.** `tests/e2e/voice-input-composer.spec.ts`가 `A → A`(취소 안 됨),
   `A → B`, 로그아웃을 실제 next-auth refetch 경로로 구동합니다. `null`이 끼는
   두 경로는 `app/(site)/(application)/layout.tsx`가 session을 서버에서 확정해
   넘기므로 이 화면에서 발생하지 않습니다 — `status`가 `"loading"`이 되지 않고,
   refetch 중에도 이전 session이 유지되어 `sessionUserId`가 비지 않습니다.
   규칙은 그대로 둡니다. `null`은 "아직 모른다"의 표현이고, 어떤 화면이
   `SessionProvider`에 session을 넘기지 않게 되는 순간 다시 발생합니다.
3. **세션→scope 기록은 상한이 있고, 조회 실패는 fail-closed입니다.**
   `lib/voiceSessionScopes.ts`가 최신 두 세션만 남깁니다. **scope를 읽는 시점은
   `onTranscript`이고, adapter는 그것을 `transcription_succeeded` 직전에
   부릅니다** — 즉 읽는 순간 세션은 아직 live이고 읽히는 항목은 최신 항목입니다.
   **지금 코드에서는 1개로도 충분합니다.** 머신이 busy(=`transcribing` 포함)
   중에는 `start_requested`를 무시하므로 이전 업로드가 끝나기 전에 새 세션이
   자기 항목을 기록할 수 없고, 버려진 세션은 `onTranscript` **앞의**
   `discarded` 검사에서 걸러져 scope를 묻지도 않습니다. 2를 유지하는 이유는
   지금 존재하는 경합이 아니라 **이름 댈 수 있는 변경 하나에 대한 여유**입니다
   — 이전 클립이 변환 중일 때 새 녹음을 시작할 수 있게 하면 첫 번째 조건이
   사라집니다. 반대로 아무것도 지우지 않던 처음 구현은 composer가 mount돼
   있는 동안 녹음마다 한 항목씩 늘었습니다. 종료 경로 네 곳에 `delete`를
   뿌리는 대신 **보존 규칙 하나**로 둔 이유는, 뿌리는 쪽은 하나만 빠뜨려도
   원래대로 돌아가기 때문입니다.

   **상한이 안전한 것은 조회 실패를 실패로 보고하기 때문입니다.** `scopeFor()`는
   `string | null`이 아니라 `{ known: true, scopeId } | { known: false }`를
   돌려줍니다. `null`은 **실재하는 scope**(새 대화 초안)이므로, 제거된 세션에
   대해 `null`을 돌려주면 늦게 도착한 transcript가 **새 대화 초안에 기록**됩니다.
   `known: false`면 hook은 **아무 데도 쓰지 않고 버립니다** — 추측해서 쓰는 것은
   말한 적 없는 대화에 문장을 넣는 일입니다.
4. **쓰기는 scope를 명시하고 함수형으로 합니다** —
   `setDraftText((current) => append(current, text), scopeId)`. scope 명시가
   대화를 맞추고, 함수형 갱신이 **기다리는 동안 사용자가 친 글을 보존**합니다.
   값을 캡처해 쓰면 그 글이 덮어써집니다.

**전체 remount로 해결하지 않았습니다.** 첨부 업로드·포커스·IME·다른 대화의
초안이 모두 그 remount에 딸려 초기화되기 때문입니다.

탭 전환을 넘나드는 백그라운드 녹음 복구는 만들지 않았습니다.

#### 초안의 신원 격리는 별개 계약입니다

Voice의 경계는 **음성 세션**에 있습니다. 이 항목에서 Voice가 보장하는 것은
하나뿐입니다 — **A의 음성 transcript가 B의 입력창에 추가되지 않는다.** 계정이
바뀌면 세션을 끝내고 클립을 버리므로 추가될 문장 자체가 없습니다.

타이핑한 초안과 첨부는 그 경계 밖이고, Voice의 F-2 검증 중에 **계정 B가 계정 A의
초안을 그대로 본다**는 별개 결함이 발견됐습니다. 2026-09-02에 초안 key가 대화와
사람을 함께 지목하도록 고쳐졌습니다: docs/policy/conversation-draft-identity-scope.md.

두 계약은 같은 방향으로 맞물립니다. 음성 세션의 scope는 **초안 key**이고 그 key가
신원을 담으므로, transcript는 그것을 말한 사람의 초안에만 기록될 수 있습니다.

### 8.5 자원을 소유하는 층은 따로 있습니다

`lib/voiceCaptureAdapter.ts`. framework-free이고 의존성을 주입받으므로,
`stop()`이 예외를 던지는 브라우저를 테스트가 만들 수 있습니다.

reducer 테스트는 머신이 **올바른 effect를 지목한다**는 것만 증명합니다. track이
정말 멈췄는지, timer가 지워졌는지, 예외를 던진 정리 단계가 뒤의 단계를
건너뛰지 않았는지는 증명하지 못합니다 — reducer는 effect를 수행하지 않기
때문입니다. 그 주장들은 `tests/voiceCaptureAdapter.test.mjs`입니다.

규칙 넷:

1. **정리는 멱등입니다.** `destroy()` 이후를 포함해 몇 번 불려도 안전합니다.
2. **정리는 던지지 않고, 중간에 멈추지 않습니다.** 각 단계가 격리돼 있어
   `stop()`이 던져도 track은 멈추고 timer는 지워집니다. effect 실행 루프도
   effect마다 격리돼 있습니다 — 취소는 `discard` 다음에 `release`를 내는데,
   던지는 `discard`가 `release`를 데려가면 버린 녹음의 마이크가 열린 채로
   남습니다.
3. **세션을 확인합니다.** 끝난 세션의 effect는 무시합니다. 특히
   `release_microphone`이 세션을 들고 다니므로, 늦은 해제가 **새 세션의
   마이크를 닫을 수 없습니다.**
4. **실패는 자기가 연 것을 닫습니다.** 오류를 보고하고 스트림을 열어 두는
   경로가 없습니다.

### 8.6 녹음 시작 뒤의 실패

`permission_granted` 다음 상태는 `recording`입니다. 그런데 어댑터는 그 뒤에도
실패를 보고합니다 — `new MediaRecorder(...)`가 던지거나, `recorder.start()`가
던지거나, `recorder.onerror`가 발생합니다.

**고쳐진 결함**: reducer는 `unsupported`를 `idle`·`permission_pending`에서만,
`device_unavailable`을 `permission_pending`에서만 받았습니다. 위 세 가지는 전부
`recording`(또는 `stopping`)에서 오므로 **전이가 버려졌고**, 머신은 마이크가
열린 채 `recording`에 남았습니다. `onerror`의 경우 tick timer까지 돌았습니다.
빠져나갈 길은 취소뿐이었고 이유는 아무 데도 표시되지 않았습니다.

이제 두 이벤트 모두 모든 live 상태에서 세션을 끝내고, `discard_capture` +
`release_microphone`을 함께 냅니다. `recorder.stop()`이 던지면 `onstop`은
오지 않으므로 그것도 `device_unavailable`로 보고합니다 — 그렇지 않으면 머신이
오지 않을 클립을 영원히 기다립니다.

**`unsupported`는 세션을 들고 다닙니다.** 세션 없는 형태는 누르는 순간의
사전 점검(=`idle`)에서만 유효합니다. 예전에는 `permission_pending`에서도
받았으므로, 끝난 세션의 늦은 `unsupported` 하나가 **그것을 대체한 새 세션을
끝내고 마이크를 해제**했습니다.

---

## 9. 활성화·비활성화 방법

### 켜기 (staging)

```sql
INSERT INTO "AppSetting" ("key", "value")
VALUES ('feature.voiceInputEnabled', 'true')
ON CONFLICT ("key") DO UPDATE SET "value" = 'true';
```

그리고 `VOICE_TRANSCRIPTION_API_KEY`(또는 `OPENAI_API_KEY`)가 있어야 합니다.
`VOICE_INPUT_KILL_SWITCH`는 **없거나 비어 있어야** 합니다.

### 즉시 끄기 (production kill switch)

```
VOICE_INPUT_KILL_SWITCH=1
```

배포하면 끝입니다. DB를 읽지 않고, stored flag가 무엇이든 이깁니다. 되돌리려면
변수를 지웁니다.

### 되돌리기 (rollout flag)

```sql
UPDATE "AppSetting" SET "value" = 'false' WHERE "key" = 'feature.voiceInputEnabled';
```

row를 지워도 같습니다(누락 = off).

---

## 10. STT provider port

`lib/voiceTranscriptionPortCore.ts`(framework-free) +
`lib/voiceTranscriptionPort.ts`(`server-only` binding). `lib/emailProviderPort*.ts`와
같은 모양이고 같은 이유입니다.

- **method는 `transcribe` 하나**입니다. 모델 목록, 사용량 조회, streaming,
  번역, 화자 분리, 음성 합성은 전부 의도적으로 없습니다. 그것들은 어떤
  provider가 가진 능력이지 이 제품이 요구하기로 한 것이 아니고, port가 그것들을
  키우면 provider를 교체할 때 아무도 부르지 않는 기능을 다시 구현해야 합니다.
  `VOICE_TRANSCRIPTION_PORT_SURFACE`가 이름을 고정하고
  `tests/voiceInputPrivacy.test.mjs`가 강제합니다.
- **UI component가 provider를 직접 부르지 않습니다.** hook이 아는 것은
  endpoint URL 하나입니다.
- **key는 `VOICE_TRANSCRIPTION_API_KEY`가 우선**이고 없으면 `OPENAI_API_KEY`로
  fallback합니다. 전용 변수가 먼저인 이유는 "채팅에 답하는 계정"과 "음성을
  전사하는 계정"이 같은 결정이 아니기 때문입니다(§11.3). 어느 쪽이 쓰였는지는
  구조화 로그의 `keySource`에 남습니다.
- 기본 모델은 `gpt-4o-mini-transcribe`이고 `VOICE_TRANSCRIPTION_MODEL`로
  바꿉니다. §6이 열려 있는 동안의 올바른 기본값은 **꺼 두는 비용이 가장 적은
  것**입니다.

---

## 11. 보존과 제3자 전송

### 11.1 원본 음성은 저장하지 않습니다

한 요청이 지속되는 동안 메모리에만 존재하고, 그 뒤에는 없습니다. **나중에
sweeper가 지우는 것이 아니라 애초에 어디에도 쓰지 않습니다.**

- 업로드 준비 단계 없음, object key 없음, row 없음, `GET` 없음.
- `tests/voiceInputPrivacy.test.mjs`가 voice module 전체를 훑어
  `writeR2Object`·`prisma.message`·`writeFileSync` 류의 호출이 없음을
  확인합니다. 예외는 `lib/voiceInputBudget.ts` 하나이고, 그것이 쓰는 것은
  hash된 사용자 키에 달린 **초 카운터**입니다.
- **취소한 녹음은 어디로도 전송되지 않습니다.** hook은 버려진 session에 대해
  Blob을 조립조차 하지 않습니다.

### 11.2 로그에 남지 않는 것

오디오, transcript, transcript의 길이, transcript의 앞부분, API key, provider
응답 본문.

요청당 구조화 이벤트 하나가 남고 필드는 다음뿐입니다 — **outcome, mediaType,
durationSource, durationSeconds, reservedSeconds, releasedSeconds,
settlementBasis, usageKind, disposition, providerFailure, providerStatus,
keySource**. 전부 이 코드가 고른 코드이거나 컨테이너에서 측정한 숫자입니다.
필드가 하나라도 늘면 `tests/voiceInputPrivacy.test.mjs`가 실패합니다.

**`usageKind`는 단위의 종류일 뿐 수치가 아닙니다.** provider의 토큰 수는 남기지
않습니다 — `output_tokens`는 transcript 길이의 대리 지표이고, 이 절은 그것을
transcript 자체만큼 단호하게 금지합니다(§7.3).

provider 실패는 **코드와 HTTP status로만** 보고합니다. 일부 provider는 오류
본문에 요청을 되비추고, 그 요청은 오디오입니다. `fetch`가 throw한 error도
검사하지도 로깅하지도 않습니다 — 일부 runtime에서 message에 요청이 들어 있습니다.

### 11.3 어디로 가는가

오디오는 transcription provider(현재 **OpenAI**)로 갑니다. 그쪽 약관에 따라 다른
국가에서 처리될 수 있습니다.

**미결정**: OpenAI 계정의 audio 데이터 보존 설정, zero-data-retention 적용
여부, 별도 계정/조직/DPA 분리 여부. `VOICE_TRANSCRIPTION_API_KEY`를 별도로 둔
것은 그 결정이 내려질 때 **코드 변경 없이** 반영할 수 있게 하기 위해서이고,
결정 자체는 아직 없습니다. 이것도 §14의 차단 사유입니다.

#### 11.3.1 공급자 문서에서 확인된 것 (2026-09-02 읽음)

아래는 **OpenAI 공식 문서를 읽어 확인한 사실**이며, 이 계정의 설정도 체결된
계약도 아닙니다. 그 구분이 이 절의 요점입니다.

출처: developers.openai.com `/api/docs/guides/your-data`,
"Storage requirements and retention controls per endpoint" 표.

| Endpoint | Data used for training | Abuse monitoring retention | Application state retention | ZDR eligible | Eyes Off / Safety Retention eligible |
|---|:-:|:-:|:-:|:-:|:-:|
| `/v1/audio/transcriptions` | No | None | None | Yes | No |

- **이 endpoint는 ZDR 대상에 포함됩니다.**
- **ZDR은 사전 승인제입니다** — 문서의 표현은 "subject to prior approval by
  OpenAI"이고, 자격 확인은 영업 접촉입니다.
- **별도 조직이나 별도 API key는 문서상 요구되지 않습니다.** 승인 후
  **조직 또는 프로젝트 단위**로 data controls에서 설정합니다. 그러므로
  "조직을 나눌 것인가"는 요구사항이 아니라 **우리 쪽 정책 선택**입니다.
- API 데이터는 기본적으로 학습에 쓰이지 않습니다.

#### 11.3.2 확인되지 않은 것 — 추정으로 메우지 않습니다

1. **표의 `None`과 같은 문서의 "최대 30일" 문장의 관계.** 같은 페이지가
   "abuse monitoring logs are generated for all API feature usage and retained
   for up to 30 days"라고도 적습니다. 표는 이 endpoint에 대해 `None`입니다.
   **문서는 둘의 우선관계를 설명하지 않으며, 이 저장소는 그것을 추정으로
   해소하지 않습니다.** OpenAI 확인 대기입니다.
2. **이 계정의 실제 설정.** ZDR 승인 여부, 활성 상태, 조직·프로젝트의 data
   controls 값. 자격증명이 필요하고 이 문서는 그것을 읽지 않았습니다.
3. **DPA 체결 여부와 체결 방법.** 원문을 읽지 못했습니다 —
   `help.openai.com`은 이 환경의 egress 프록시가 차단하고 `openai.com/policies/*`
   는 403입니다. **검색 요약을 근거로 확정하지 않습니다.**

11.3.1을 근거로 §14의 B-5를 해제하지 않습니다. B-5가 묻는 것은 **계정 설정과
계약**이고, 여기서 확인된 것은 **공급자 문서의 기본값과 자격**입니다.

### 11.4 사용자에게 말하는 곳

두 곳입니다.

1. **녹음하는 그 자리** — 상태 row의 `chat.voicePrivacyNote`. 데이터에 대한
   약속은 데이터가 만들어지는 지점에 있어야 한다는, 게스트 첨부와 같은 규칙.
2. **개인정보 처리방침** — `privacyPolicy.voiceInput`, 7개 locale 전부. "외부 AI
   제공업체" 절 안의 한 문장이 아니라 **자기 절**입니다: 여기서 중요한 약속은
   *녹음*이 어떻게 되는가이고, 그것은 전송이 아니라 보존에 관한 진술입니다.

---

## 12. 언어

한국어와 영어가 우선 지원 대상입니다.

**언어를 고정하지 않습니다.** provider에 `language`를 보내지 않고 자동 감지에
맡깁니다. 고정하면 문장 중간에 언어를 바꾸는 사용자에게 **맞는 언어를 감지하는
대신 틀린 언어로 전사**하게 됩니다.

transcript는 **말한 대로** 돌려줍니다. 필터·교정·대문자화·구두점 추가·번역·
moderation을 하지 않습니다(`lib/voiceTranscript.ts`). 이 텍스트는 사용자가 읽고
보내는 편집 가능한 draft이므로, 조용히 개선하면 **인식기가 틀렸다는 사실을
사용자가 알아챌 수 없게** 됩니다.

공백 정규화, 무음 결과 거절, 과도한 길이 **거절**(잘라내기 아님)만 합니다.
잘린 transcript는 잘렸다는 표시 없이 문장 중간에서 끝나고, 사용자는 그것이
자기가 한 말이라고 믿고 보냅니다.

---

## 13. 오류 문구

`lib/voiceInputErrorCopy.ts`가 refusal code → locale key를 매핑합니다.
`lib/chatAttachmentErrorCopy.ts`와 같은 모양이고, 그 파일이 기록한 사고 때문에
존재합니다: 모든 실패가 한 문장("문제가 발생했습니다, 다시 시도해 주세요")을
내는 흐름은 그것을 보는 사람 대부분에게 틀린 조언을 합니다.

마이크 차단, 녹음 불가 브라우저, 빈 녹음, 인식된 말 없음, 일일 한도, provider
장애는 **고치는 방법이 여섯 가지로 다르고**, 그중 "다시 시도"가 맞는 것은
하나뿐입니다.

서버는 코드만 보내고 문장은 client가 locale로 옮깁니다. 서버가 영어 문장을
쓰면 그 문장만 7개 locale 중 어디에도 번역되지 않습니다.

---

## 14. production 활성화를 막는 것

**아래가 전부 해결되기 전에는 production에서 켜지 않습니다.** admin console에
토글이 없는 이유가 이것입니다 — 토글은 이 절차의 마지막 단계를 앞의 세 단계
없이 제공하는 일입니다.

| # | 미결정 사항 | 필요한 것 |
|---|---|---|
| B-1 | 오디오 1초의 사용자 가격 (§6.1-1) | 제품·finance 결정. 크레딧/무료/할당량 중 하나 |
| B-2 | 실패 시 과금 처리 (§6.1-2) | 같은 결정의 일부 |
| B-3 | provider 원가 검증 계층 (§6.1-3) | audio register의 소유자·티켓·기한 |
| B-4 | audio provider 예산 (§6.1-4) | 둘지 여부, `/api/ready`가 강제할지 |
| B-5 | provider 데이터 보존 (§11.3) | OpenAI 계정 설정 확인, 별도 계정/DPA 여부 |
| B-6 | 실기기 검증 (§15) | `docs/ops/voice-input-staging-checklist.md` 서명 |

B-1~B-4는 **§6이 열려 있다는 하나의 사실**의 네 얼굴입니다. B-5는 별개이고
법무 성격입니다. B-6은 사람만 할 수 있습니다.

**2026-09-02에 B-5와 B-3의 공급자 쪽 사실을 조사해 §11.3.1과 §6.1.1에
적었습니다. 둘 다 해제되지 않았습니다.**

- **B-5**는 공급자 문서의 기본값과 ZDR 자격을 확인했을 뿐이고, 이 항목이 묻는
  **계정 설정과 계약**은 답해지지 않았습니다. 문서 안에서도 조정되지 않은
  진술이 하나 남아 있습니다(§11.3.2-1).
- **B-3**은 정가와 네 개의 관측 경로를 확인했을 뿐이고, 이 항목이 묻는
  **register의 소유자·티켓·기한**은 없습니다. 유료 검증은 실행하지 않았습니다.

조사가 끝났다는 것과 결정이 내려졌다는 것은 다릅니다. 이 표는 결정을 셉니다.

---

## 15. 사람만 할 수 있는 검증

AGENTS.md의 "사람에게 남기는 것은 사람만 할 수 있는 것뿐입니다"에 따라, 이
컨테이너에서 만들 수 있는 것은 전부 만들었습니다.

- 실제 `MediaRecorder` 시료 3개를 **생성했습니다**
  (`tests/fixtures/voice/`, `scripts/make-voice-fixtures.mjs`).
- 컨테이너 파싱·길이 계산·거절 경로는 전부 자동 테스트입니다.
- E2E는 합성 `MediaStream`으로 **실제 브라우저 recorder**를 돌립니다.

남는 것은 넷 중 두 가지에 해당합니다 — **실기기·실제 OS**와 **이 컨테이너가
만들 수 없는 시료**. 목록과 판정 기준은
`docs/ops/voice-input-staging-checklist.md`에 있고, **관측하지 않은 결과를
통과로 기록하지 않습니다.**

---

## 16. 바꾸기 전에

- §1(자동 전송 없음), §4(로그인 전용), §11.1(원본 미보존)을 완화하는 변경은
  **릴리스 차단 사유**입니다.
- 형식을 추가하려면 `lib/voiceInputFormats.ts`의 행 하나입니다. 다른 어디에도
  형식별 분기를 만들지 않습니다.
- guardrail 어휘를 크레딧·채팅 층과 섞지 않습니다(§7).
- §6이 정해지면 이 문서를 먼저 고치고, 그 다음에 코드를 고칩니다.
