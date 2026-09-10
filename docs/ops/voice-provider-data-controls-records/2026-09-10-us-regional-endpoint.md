# B-5 결정·구현 기록 — Voice 전사를 미국 지역 endpoint로 고정 (2026-09-10)

`docs/policy/voice-input.md` §11.3.0의 근거 기록입니다. 같은 날의 처리 지역
결정(`2026-09-10-processing-region-decision.md`)이 **"지역 제한을 적용하지
않는다"**였고, 이 기록은 그것을 뒤집는 것이 아니라 **이전 국가를 고지에 적을 수
있게 특정**합니다.

**이 초안은 에이전트가 썼습니다.** 절마다 출처를 밝혔고, **판정과 서명은 사람이
채웁니다.**

- **기록일(UTC)**: 2026-09-10
- **상태**: **코드·고지 문구 구현 완료 — staging 미관측, 문구는 법률 승인 대상**

---

## 1. 공식 문서에서 확인된 사실

출처: `https://developers.openai.com/api/docs/guides/your-data`, **2026-09-10
읽음.** 이 저장소에서 직접 열렸습니다(`openai.com/policies/*`와 달리 403이
아닙니다).

| 확인 항목 | 문서가 말한 것 |
|---|---|
| `/v1/audio/transcriptions` regional storage | "All listed regions" |
| 같은 endpoint regional **processing** | "United States, Europe (EEA + Switzerland)" |
| 미국의 MAM·ZDR 필수 여부 | **"No"** |
| Global 프로젝트 key로 지역 host 사용 | *"As an alternative to creating a region-specific project, you can select regional processing for an individual request by using the prefixed domain with an API key from a project having Global geography."* |
| 지원 모델 | `tts-1, whisper-1, gpt-4o-tts, gpt-4o-transcribe, gpt-4o-mini-transcribe, gpt-transcribe` — **이 제품의 두 모델 모두 포함** |
| 적용 범위 | *"Data residency does not apply to system data, which may be processed and stored outside the selected region."* |
| 가격 | *"Data residency endpoints are charged a 10% uplift for models released on or after March 5, 2026, that are eligible for data residency."* |

**마지막 줄은 이 작업의 브리프가 예상하지 않은 사실입니다.** 지역 endpoint에는
가격 할증이 **조건부로** 있습니다. §5에서 다룹니다.

## 2. 제품 소유자의 결정

- **ZDR은 Production Voice의 필수조건이 아닙니다** — 2026-09-10 서명
  (`2026-09-10-zdr-precondition-decision.md`). **이 기록은 그 결정을 유지합니다.**
  미국 지역이 MAM·ZDR을 요구하지 않으므로 둘은 충돌하지 않습니다.
- **처리 지역은 미국으로 특정합니다.** 목적은 개인정보보호법 제28조의8이 요구하는
  **이전 국가**를 고지에 적을 수 있게 하는 것입니다.

## 3. 코드가 보장하는 것

| 보장 | 어디서 |
|---|---|
| 모든 Voice 전사가 `https://us.api.openai.com/v1/audio/transcriptions`로 나감 | `VOICE_TRANSCRIPTION_OPENAI_BASE_URL` 상수 + production binding이 명시 전달 |
| global endpoint로 돌아가는 **런타임 경로 없음** | 옛 `?? "https://api.openai.com"` 기본값 제거. Voice runtime source에 그 문자열이 없음(주석 제외) |
| **환경변수로 바꿀 수 없음** | `_URL`·`_HOST`·`REGION`·`GEOGRAPHY`·`ENDPOINT` 꼴 env 접근을 Voice runtime에서 금지하는 검사 |
| test injection은 명시 주입에서만 | `baseUrl`은 optional이고 생략 시 상수 |
| `//v1` 결합 사고 없음 | `voiceTranscriptionEndpoint()`가 후행 slash 제거 |
| multipart 표면 불변 | `file`·`model`·`response_format`(+선택 `language`), header는 `Authorization` 하나 |
| Chat·Image 등 미변경 | 다른 adapter에 `us.api.openai.com`이 없음을 단언 |

**되돌리면 실제로 실패합니다.** 옛 global 기본값을 복원하고 돌리니 9건 중 **3건이
red**였고(요청 URL, runtime source 스캔, binding 명시), 복원하니 다시 9건 green
입니다. 이름만 늘린 테스트가 아닙니다.

**key 계약은 바꾸지 않았습니다.** `VOICE_TRANSCRIPTION_API_KEY` → 공용 key
fallback 그대로입니다. §1이 인용한 대로 Global 프로젝트 key로 지역 host를 부를 수
있으므로, 새 프로젝트·key를 이 코드 변경의 전제로 만들지 않았습니다.

## 4. staging에서 아직 관측하지 않은 것

- **실제 요청이 미국 endpoint에 닿는다는 wire 증거.** 코드와 테스트가 보장하는
  것은 **요청이 그 URL로 만들어진다**는 것입니다. 그 host가 응답하고 이 key가
  거기서 유효하다는 것은 **실제 호출로만** 확인됩니다.
- **지역 식별자를 로그에 넣지 않은 이유가 여기 있습니다.** host가 상수이므로
  그 상수에서 유도한 로그 필드는 언제나 `"us"`만 내고, 요청이 어디에 닿았는지는
  말하지 못합니다. 장식이 아니라 증거가 되려면 응답 쪽 사실이어야 하는데 그런
  필드가 없습니다. **대체 증거는 B-6의 실제 호출 성공**이며, 실패하면
  `provider_rejected_credentials`나 `provider_unreachable`로 드러납니다.

## 5. 가격 — 다시 관측해야 하는가

**기존 `costObservation` 둘은 global endpoint에서 얻은 값이며 덮어쓰지
않았습니다.** 지역 endpoint의 요율이 같다고 추정하지도 않았습니다.

문서의 할증 규칙은 **2026-03-05 이후 출시 모델**에만 적용됩니다. 이 제품의 두
모델은 `GET /v1/models`의 `created`가 **2025-03-15**로, 컷오프 이전입니다.
2026-09-02 청구의 line item 이름도 `gpt-4o-mini-transcribe-2025-12-15`로 컷오프
이전 snapshot입니다.

**그러나 이것은 확정이 아닙니다.** `AGENTS.md`가 `GET /v1/models`를 가격 출처로
쓰지 말라고 못 박고 있고, 모델 객체의 `created`가 문서가 말하는 "released"와
같은 날짜라는 보장도 없습니다. **정황은 할증 없음을 가리키지만, 문서만으로
확정할 수 없습니다.**

**제안**: B-6의 첫 승인된 실제 전사 호출을 **지역 확인과 비용 관측에 함께**
씁니다. 그 호출은 이미 승인·예산 안에 있고, 다음 날 Costs를 읽으면 지역
endpoint의 실제 요율이 나옵니다 — 별도 유료 호출이 필요하지 않습니다. 요율이
기존 관측과 다르면 **3회차 `costObservation`**으로 추가하고 기존 둘은 그대로
둡니다(global 시점의 사실이므로).

**이 작업에서 유료 호출은 하지 않았습니다.**

## 6. 개인정보처리방침 — 사람의 승인이 필요한 문구

제28조의8 제2항 항목을 현재 `privacyPolicy.voiceInput`과 대조했습니다.

| # | 항목 | 현재 | 이번에 확정 가능 |
|---|---|---|---|
| 1 | 이전되는 개인정보 | 있음(녹음) | — |
| 2 | **이전 국가** | 없음 | **미국** |
| 3 | **이전 시점·방법** | 없음 | 사용자가 녹음을 끝내고 전사를 요청할 때, 암호화된 HTTPS API 전송 |
| 4 | **이전받는 법인의 정확한 명칭·연락처** | 없음 | **불가 — blocker** |
| 5 | 이용 목적 | 있음 | 음성을 텍스트로 변환 |
| 6 | **보유·이용 기간** | 없음(위탁자 것만) | **보수적 문구만 제안** |
| 7 | **거부 방법·절차** | 없음 | 마이크 권한을 허용하지 않거나 Voice를 쓰지 않고 텍스트 입력 사용 |
| 8 | **거부 효과** | 없음 | Voice 전사 불가, 텍스트 대화는 계속 가능 |

**두 blocker는 2026-09-10에 운영자가 해소했고, 여덟 항목을 7개 locale 전부에
넣었습니다.** `privacyPolicy.voiceInputTransfer1`–`8`과 제목 key이며,
`PrivacyPolicy.tsx`가 Voice 섹션 아래에 목록으로 렌더링합니다 — 한 문단에 여덟
답을 밀어 넣으면 어느 것도 찾을 수 없어 감사되지 않기 때문입니다.

**4번 — 법인명과 연락처: `OpenAI OpCo, LLC` / `privacy@openai.com`.** 운영자가
제시했고 **이 저장소가 대조하지 않았습니다** — 계약 원문이 egress 프록시에서
403입니다(`2026-09-10-dpa-incorporation.md` §1). 다만 이 값은 이제 **사용자에게
보이는 법정 고지**이므로, 계약서의 표기와 다르면 고지가 틀립니다. 문구 승인 시
계약 원문과 대조해야 하는 첫 번째 줄입니다.

**6번 — 보유·이용 기간: 원칙적으로 최대 30일(악용 모니터링), 법령상 의무나
OpenAI의 서비스·제3자 보호에 합리적으로 필요한 경우 연장.** 이것이 §11.3.2-1의
`None` 대 30일 긴장을 **보수적으로 정리한 것**임을 적어 둡니다 — endpoint 표가
틀렸다고 선언한 것이 아니라, **고지에서는 더 긴 쪽을 적기로 한 선택**입니다.
사용자에게 실제보다 짧게 말하는 위험을 피하는 방향이고, 공급자 답변이 오면
줄이는 것은 안전하지만 늘리는 것은 그렇지 않습니다.

**"미국에서만 모든 데이터가 처리된다"고 쓰지 않았습니다.** 고지는 **녹음과 그
전사 결과**가 미국으로 이전된다고 적으며, §1이 인용한 system data 예외를 이
문장이 넘어서지 않습니다.

## 7. B-5를 해결로 표시하지 않았습니다

코드가 병합돼도 B-5는 열려 있습니다. 완료 조건은 최소한 이 여섯입니다.

1. 미국 endpoint 고정 코드 병합 — **이 변경**
2. 개인정보처리방침 국외이전 필수 항목 승인 — **문구는 구현됨, 법률 승인 미완(§6)**
3. 그 코드가 포함된 staging 전체 deploy SHA — **미관측**
4. 그 deploy에서 실제 Voice 요청 성공 — **미관측**
5. 요청이 미국 endpoint를 썼다는 코드·테스트·운영 증거 — **코드·테스트는 있음,
   운영 증거 미관측(§4)**
6. 사람의 B-5 판정과 서명 — **미완**

**B-6 체크리스트의 template revision은 올리지 않았습니다.** 참조할 B-5 결정
기록이 아직 서명되지 않았고, 존재하지 않는 기록을 미리 가리키지 않습니다.

---

## 판정과 서명 (사람이 채웁니다)

- **판정**:
- **서명**:
- **일자(UTC)**:
