# 음성 입력 staging 검증 체크리스트

`docs/policy/voice-input.md` §15가 요구하는 검증입니다. **이 체크리스트의 실행과
서명은 production에서 `feature.voiceInputEnabled`를 켜기 위한 전제 조건 중
하나**이고(§14의 B-6), 나머지 다섯 개 차단 사유(B-1~B-5)는 이 문서로 해소되지
않습니다.

- **template revision**: `2026-08-31b`

## 이 문서는 template입니다

**여기에는 결과가 없습니다.** 체크박스는 항상 비어 있고, 그것이 이 파일의
상태입니다. 실행 결과는 날짜와 전체 deploy SHA로 이름 붙인 별도 파일로 남깁니다.
항목과 승인 기록이 한 파일에 있으면 승인란은 서명된 채 남고 그 위 항목만 조용히
바뀝니다 — 이미지 생성 쪽에서 실제로 겪은 실패입니다.

실행·판정·서명은 사람이 합니다. 에이전트는 항목을 갱신하고 실행자가 **보고한
관측**을 기록 초안에 옮겨 적을 수 있습니다. 쓸 수 없는 것은 **판정과 서명**뿐이며,
**지어낸 관측은 어느 쪽에서도 허용되지 않습니다.**

---

## 왜 항목이 이것뿐인가

AGENTS.md의 "사람에게 남기는 것은 사람만 할 수 있는 것뿐입니다"에 따라, 이
컨테이너에서 만들 수 있는 것은 전부 만들어 두었습니다.

이미 자동화되어 **여기서 다시 하지 않는 것**:

| 이미 증명된 것 | 어디서 |
|---|---|
| 상태 머신의 취소·경합·제한·오류 전이 | `tests/voiceRecorderMachine.test.mjs` |
| 실제 Chromium 녹음의 컨테이너·길이 파싱 | `tests/voiceClipInspection.test.mjs` + `tests/fixtures/voice/` |
| 크기·형식·길이·인증·예산·provider 실패의 서버 거절 | `tests/server-contract/voice-transcription-route.test.ts` |
| 원본 음성·transcript가 저장소·로그에 남지 않음 | `tests/voiceInputPrivacy.test.mjs` |
| 실제 브라우저 recorder로 녹음 → 자동 전송 안 됨 | `tests/e2e/voice-input-composer.spec.ts` |
| composer 기하(320/360/390/430px, 겹침 0, IME) | 같은 파일 |
| 7개 locale key parity와 번역 | `tests/localeParity.test.mjs`, `npm run check:locale-translation` |
| 생성 실패·start/stop 예외·녹음 중 오류의 자원 회수 | `tests/voiceCaptureAdapter.test.mjs` |
| 늦은 이벤트가 새 세션을 끝내거나 새 마이크를 닫지 못함 | 같은 파일 + `tests/voiceRecorderMachine.test.mjs` |
| 대화 전환 시 세션 종료·초안 격리·타이핑 보존 | `tests/e2e/voice-input-composer.spec.ts` |
| 대화/신원 경계 판정과 세션 scope 보존 상한 | `tests/voiceSessionScopes.test.mjs` |
| provider usage 형태 구분과 정산 근거 | `tests/voiceProviderSettlement.test.mjs` |
| 결과 불명 호출이 예약을 유지함 | `tests/server-contract/voice-transcription-route.test.ts` |

시료도 만들어 두었습니다: `scripts/make-voice-fixtures.mjs`가 실제
`MediaRecorder` 출력 3개(WebM 2.5s / MP4 3.0s / WebM 0.4s)를 생성하며, 각각의
기대 길이와 바이트 수는 그 테스트 파일에 정답지로 적혀 있습니다.

**남는 것은 넷 중 두 가지뿐입니다** — 실기기·실제 OS, 그리고 이 컨테이너가 만들
수 없는 시료. 그리고 판정·서명.

---

## 사전 조건

하나라도 어긋나면 검증이 아니라 **다른 것을 측정**하게 됩니다.

- [ ] staging이 서비스 중인 전체 40자리 deploy SHA를 확보했고 기록에 적었다
- [ ] `AppSetting["feature.voiceInputEnabled"] = "true"`
- [ ] `VOICE_INPUT_KILL_SWITCH`가 **없거나 비어 있다**
- [ ] `VOICE_TRANSCRIPTION_API_KEY` 또는 `OPENAI_API_KEY`가 설정돼 있다
- [ ] 로그인 계정 하나와 **비로그인 세션** 하나를 준비했다
- [ ] **provider 호출이 실제로 과금됩니다.** 아래 항목 대부분이 유료입니다

### 비용

유료 turn: 항목당 1회, 총 **약 10회**. 각 클립은 5초 이하로 녹음합니다.
`gpt-4o-mini-transcribe` 기준 총 1분 미만의 오디오이므로 금액은 무시할 수준이며,
정확한 단가는 §14 B-3이 정해지기 전까지 이 문서가 주장하지 않습니다.

---

## A. 실기기 — 합성 스트림으로 재현되지 않는 것

E2E는 `OscillatorNode`를 `MediaStream`으로 넘겨 recorder를 돌립니다. 그것이
증명하지 못하는 것은 **실제 마이크 권한 UI, 실제 OS의 오디오 경로, 그리고
브라우저의 녹음 표시등**입니다.

### A-1. iOS Safari (실기기)

- [ ] 마이크 버튼을 누르면 **iOS의 권한 시트**가 뜬다
- [ ] 허용하면 녹음이 시작되고 경과 시간이 올라간다
- [ ] Safari의 **녹음 표시(주소창 인디케이터)** 가 켜진다
- [ ] 정지 → 변환 → 입력창에 문장이 들어오고 **전송되지 않는다**
- [ ] 취소하면 표시등이 **즉시 꺼진다** (자동 테스트가 track 수로만 확인하는 것)
- [ ] 거부한 뒤 다시 누르면 `VOICE_PERMISSION_DENIED` 문장이 뜨고, 그 문장이
      iOS 설정에서 고치는 방법을 말한다

판정 기준: 위 여섯 개가 전부 관측돼야 통과. 하나라도 미관측이면 **미기록**이며
통과가 아닙니다.

### A-2. Android Chrome (실기기)

- [ ] A-1과 같은 여섯 항목
- [ ] 화면 키보드가 올라온 상태에서 마이크 버튼이 **가려지지 않는다**
- [ ] 녹음 중 상태 row가 입력창을 **밀어 올리지 않는다**(입력 한 줄 유지)

### A-3. 통화·다른 앱과의 경합 (실기기, 둘 중 하나)

- [ ] 녹음 중 전화가 오거나 다른 앱이 마이크를 가져가면, 앱이 멈추지 않고
      오류 문장으로 끝난다 (`VOICE_DEVICE_UNAVAILABLE` 또는 빈 녹음)

관측된 코드를 기록에 그대로 적습니다. **어떤 코드가 나와야 한다고 미리 정하지
않았습니다** — 이 경로는 OS가 recorder를 어떻게 끝내는지에 달려 있고, 그것을
알아내는 것이 이 항목의 목적입니다.

---

## B. 이 컨테이너가 만들 수 없는 시료

### B-1. Safari가 저장한 MP4의 길이 선언 — **정책 §5.2의 미확인 항목**

`lib/voiceClipDuration.ts`는 Chromium의 fragmented MP4에서 `mvhd.duration`이
채워지는 것을 **측정했지만**, Safari가 같은지는 확인하지 못했습니다. fragmented
MP4는 `mvhd.duration = 0`을 쓰고 길이를 fragment에 맡길 자격이 있습니다.

- [ ] iOS/macOS Safari에서 **약 5초**를 녹음한다
- [ ] 브라우저 devtools의 Network에서 `POST /api/chat/voice-transcription`의
      요청 본문을 파일로 저장한다 (`voice-safari.mp4`)
- [ ] 그 파일을 에이전트에게 전달한다

**판정은 사람이 하지 않습니다.** 파일을 받으면 에이전트가
`inspectVoiceClip()`을 돌려 `durationSource`가 `mp4`인지 `unknown`인지 보고하고,
기록에 그 결과를 적습니다. 사람이 하는 것은 **Safari로 녹음해서 파일을 꺼내
오는 것**뿐입니다 — 그 브라우저가 여기 없기 때문입니다.

결과가 `unknown`이면 그것은 실패가 아니라 **정책 §5.2가 이미 예상한 결과**이고,
그때는 서버 로그의 `durationSource: "unknown"` 비율을 §7 예산과 함께 다시
봅니다.

### B-2. Firefox의 컨테이너 협상

Firefox는 기본이 Ogg이고, 이 제품은 Ogg를 받지 않습니다(§5.1).

- [ ] 데스크톱 Firefox에서 녹음이 **성공한다** (recorder가 WebM으로 협상)
- [ ] 요청의 `Content-Type`이 `audio/webm`이다
- [ ] 만약 실패한다면 `VOICE_UNSUPPORTED_BROWSER` 문장이 뜬다 (조용한 실패 금지)

셋 중 어느 쪽이 관측됐는지 그대로 적습니다.

---

## C. 유료 turn과 그 답의 판정

자동 테스트는 provider를 mock합니다. 실제 인식 품질은 사람만 판정합니다.

- [ ] **한국어** 한 문장을 말하고, 입력창의 문장이 말한 내용과 맞는지 본다
- [ ] **영어** 한 문장으로 같은 것
- [ ] **한국어 문장 안에 영어 단어**를 섞어 말하고, 언어 자동 감지가
      한쪽으로 고정되지 않는지 본다 (§12)
- [ ] **아무 말도 하지 않고** 3초 녹음 → `VOICE_TRANSCRIPT_EMPTY` 문장이 뜬다
- [ ] 이미 타이핑한 문장이 있는 상태에서 녹음 → **뒤에 붙는다**(대체 아님)
- [ ] 변환된 문장을 **고치고 지울 수 있다**

각 항목에 실제로 말한 문장과 실제로 나온 문장을 기록에 적습니다. "잘 나왔다"는
관측이 아닙니다.

---

## D. 로그 확인 (실행자 관측, 에이전트 대조)

- [ ] 위 실행 동안의 staging 로그에서 `event: "voice_transcription"` 라인을
      전부 꺼내 에이전트에게 전달한다

에이전트가 대조합니다: 필드가 §11.2의 목록뿐인지, transcript나 오디오의
흔적이 없는지, `keySource`가 무엇인지. **사람은 로그를 꺼내 주기만 합니다.**

---

## E. kill switch

- [ ] `VOICE_INPUT_KILL_SWITCH=1`을 배포한다
- [ ] 새로고침하면 마이크 버튼이 **사라진다** (비활성화가 아니라 없음)
- [ ] 그 상태에서 `POST /api/chat/voice-transcription`을 직접 호출하면
      503 `VOICE_INPUT_DISABLED`
- [ ] 변수를 지우고 배포하면 마이크가 돌아온다

이 항목은 **유료가 아니고 가장 중요합니다.** 끄는 방법이 동작하지 않는 기능은
production에 갈 수 없습니다.

---

## F. 회귀 — 깨뜨리지 않았는지

- [ ] 한국어 IME로 타이핑 → 조합 중 글자가 보이고 전송된다
- [ ] 파일 첨부 → 첨부 카드가 뜨고 전송된다
- [ ] 멀티 모델 선택 → 모델 수가 바뀌고 크레딧 추정이 따라온다
- [ ] 전송 → 응답 → **중단** 버튼이 동작한다
- [ ] 위 넷을 **마이크가 켜진 상태에서** 다시 한 번

### F-2. 계정 전환 (실기기 아님, 브라우저면 충분)

같은 탭에서 계정 A로 녹음을 시작하고 변환을 기다리는 동안 로그아웃 후 계정
B로 로그인합니다.

- [ ] 세션이 `VOICE_SCOPE_CHANGED`로 끝난다
- [ ] 계정 B의 입력창에 **아무것도 추가되지 않는다**

판정 규칙 자체는 `voiceSessionBoundaryChanged()`로 단위 테스트돼 있지만,
**계정 A→B 전환을 끝에서 끝까지 실행한 관측은 아직 없습니다.** 이 항목이 그
관측입니다. 유료 turn이 아닙니다.

마지막 항목이 요점입니다. 앞의 넷은 flag off로도 동작해야 하고, 이 기능이
깨뜨릴 수 있는 것은 컨트롤이 하나 늘어난 composer입니다.

---

## 차단 / 비차단

이 체크리스트 안에서도 무게가 다릅니다. 기준은 AGENTS.md의 "검증 범위는
되돌릴 수 없는 것에 비례합니다" — **틀렸을 때 되돌릴 수 없는가**입니다.

**차단(이것이 실패하면 flag를 켜지 않습니다)**

- **E. kill switch.** 끄는 방법이 동작하지 않는 기능은 production에 갈 수
  없습니다. 유료가 아닙니다.
- **A-1 / A-2의 마이크 표시등과 취소.** 제품이 듣고 있지 않은데 듣고 있는
  것처럼 보이거나, 그 반대인 것은 되돌릴 수 없는 신뢰 문제입니다.
- **C의 "자동 전송되지 않음" 확인.** 잘못 인식된 문장이 전송되면 모델 응답과
  크레딧 차감이 이미 일어난 뒤입니다.
- **F의 회귀 4종.** 기존 기능이 깨지는 것은 이 기능을 끄는 것으로 복구되지
  않습니다.

**비차단(기록하고 넘어갈 수 있습니다)**

- **B-1 Safari MP4 길이 선언.** `unknown`이어도 §5.2가 이미 예상한 결과이고,
  바이트 상한·일일 초 예산이 남습니다. 결과를 **기록**하되 flag를 막지
  않습니다.
- **B-2 Firefox 컨테이너 협상.** 실패해도 그 브라우저에서만 쓸 수 없고,
  조용한 실패가 아니라 명시적 안내로 끝나는지가 확인 대상입니다.
- **A-3 통화 경합.** 어떤 코드가 나오는지 **알아내는** 항목입니다. 미리 정한
  기대값이 없으므로 관측을 적는 것이 통과입니다.
- **C의 인식 품질.** 품질은 모델 선택의 문제이고 flag로 되돌릴 수 있습니다.

## 판정

| 구획 | 판정 | 근거 |
|---|---|---|
| A. 실기기 | | |
| B. 시료 | | |
| C. 유료 turn | | |
| D. 로그 | | |
| E. kill switch | | |
| F. 회귀 | | |

건너뛴 구획은 **미기록**이며, 판정란에 **무엇을 왜 건너뛰었는지** 적습니다.
그러면 그 기록은 비어 있는 것이 아니라 범위를 밝힌 것이 됩니다.

**서명**:
**날짜**:
**deploy SHA**:
**template revision**:

---

## 이 문서가 통과해도 production은 열리지 않습니다

`docs/policy/voice-input.md` §14의 B-1~B-5가 남습니다 — 가격, 실패 시 과금,
provider 원가 검증 계층, audio provider 예산, provider 데이터 보존. 그 다섯은
검증이 아니라 **결정**이고, 이 체크리스트로는 해소되지 않습니다.
