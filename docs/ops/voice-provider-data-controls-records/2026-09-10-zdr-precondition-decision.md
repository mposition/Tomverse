# B-5 결정 기록 — ZDR을 초기 Production 필수조건으로 두지 않음 (2026-09-10)

`docs/policy/voice-input.md` §11.3의 결정 대기 항목 중 **"ZDR을 production
필수조건으로 둘 것인가"**에 대한 결정입니다.

**이 기록의 `§`는 문서를 함께 적습니다.** 맨 숫자만 쓰면
`docs/policy/voice-input.md`의 절로 읽힙니다.

**이 초안은 에이전트가 썼습니다.** 결정문과 근거는 사업자가 제시한 것을 옮긴
것이고, 관측 출처는 항목마다 밝혔습니다. **판정과 서명은 사람이 채웁니다.**

- **결정일(UTC)**: 2026-09-10
- **선행 기록**: `docs/ops/voice-provider-data-controls-records/2026-09-10-account-observation.md`
- **상태**: **결정됨 — 서명 대기**

---

## 결정

**ZDR 승인은 Tomverse Voice 초기 Production 출시의 필수조건으로 두지 않습니다.**

## 근거 둘, 그리고 그 둘이 서로를 대신하지 않는다는 것

**1. 공급자 endpoint 표** — `/v1/audio/transcriptions`의 abuse-monitoring
retention과 application-state retention이 모두 `None`입니다(§11.3.1,
2026-09-02 읽음).

**2. 조직의 API call logging이 `Disabled`** — 2026-09-10에 **운영자가 OpenAI
콘솔에서 확인**했습니다. 이 관측은 API로 읽은 것이 아닙니다: 조직 설정 조회가
403이므로(선행 기록) 에이전트는 이 값을 읽을 수 없고, 콘솔 화면이 유일한
출처입니다.

**두 근거는 서로 다른 것을 말하며, 한쪽이 다른 쪽을 증명하지 않습니다.**
콘솔 설정의 설명문은 "organization logs data from supported API calls …
Logged data is accessible **within your organization** for review, analysis,
and evaluation"입니다 — 즉 **조직이 자기 대시보드에서 내용을 다시 볼 수 있게
보관하느냐**입니다. endpoint 표의 `None`은 **공급자 쪽 보존**을 말합니다.
`Disabled`는 앞쪽을 껐다는 사실이고, 뒤쪽에 대해서는 아무 말도 하지 않습니다.
둘을 하나로 접으면 이 register가 반복해서 잡아 온 종류의 착오가 됩니다.

**콘솔 주석 하나를 함께 옮깁니다.** 화면은 "API calls from the Responses API
are logged by default. Use the `store=false` API parameter to disable
logging"이라고 적습니다. **Voice에는 적용되지 않습니다** — 전사는
`/v1/audio/transcriptions`를 부르고 Responses API를 쓰지 않기 때문이며,
적용되지 않는 이유를 적어 두는 것이 예외를 못 본 것과 다릅니다. Voice가
Responses API를 경유하게 되면 이 주석이 살아납니다(아래 재검토 조건 2).

## 잔여 불확실성

**같은 문서의 일반적인 "최대 30일" 설명과 endpoint 표의 관계에 대한 공급자
답변은 아직 없습니다**(§11.3.2-1). 이 결정은 그 답을 얻은 것이 아니라 **답이
없는 상태를 감수하기로 한 것**입니다.

## 위험 수용

초기 서비스 규모와 현재 사용 범위를 고려해 이 불확실성을 수용하며,
Production을 차단하지 않습니다.

## 이 결정이 정하지 않은 것

- **DPA 적용 근거와 처리 지역**(§11.3.2-3). 별개 판정이며 이 문서는 그것을
  다루지 않습니다. B-5 종료 전에 별도로 기록돼야 합니다.
- **ZDR 자체를 포기한다는 뜻이 아닙니다.** 필수조건에서 뺀 것이고, 자격
  신청과 승인은 그대로 열려 있습니다.
- **전용 Voice 프로젝트·API key**. §11.3.1이 적은 대로 공급자 요구사항이
  아니라 우리 쪽 정책 선택이고, 이 결정과 독립입니다.

## 재검토

**2026-12-01 이전**, 또는 아래 중 하나가 먼저 발생할 때.

| # | 조건 |
|---|---|
| 1 | OpenAI 문서의 audio retention 항목이 변경됨 |
| 2 | Voice가 `/audio/transcriptions` 외 Realtime·Chat audio 등으로 확대됨 |
| 3 | 기업·의료·금융 등 규제 또는 계약상 무보존 요구 고객을 받음 |
| 4 | OpenAI가 기본 상태에서도 고객 콘텐츠를 보존한다고 답변함 |
| 5 | 보안 사고나 개인정보 관련 문의가 발생함 |

**조건 2는 이 결정의 범위를 그대로 말합니다.** 근거 1은
`/v1/audio/transcriptions` **한 endpoint의 행**이고, 다른 endpoint는 표에서
다른 값을 가집니다. 다른 경로로 오디오를 보내는 순간 이 결정의 근거가 그
경로에 대해 존재하지 않습니다.

**재검토는 이 파일을 덮어쓰지 않습니다.** 새 기록을 추가해 전후 상태를
남깁니다 — 선행 기록과 같은 규칙입니다.

---

## 판정과 서명 (사람이 채웁니다)

- **판정**:
- **서명**:
- **일자(UTC)**:
