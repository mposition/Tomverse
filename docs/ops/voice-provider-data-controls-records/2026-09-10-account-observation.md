# B-5 provider 데이터 통제 관측 기록 — 2026-09-10

`docs/policy/voice-input.md` §11.3의 "이 계정의 실제 설정"(§11.3.2-2)에 대한
첫 관측입니다.

**이 기록의 `§`는 문서를 함께 적습니다.** 맨 숫자만 쓰면
`docs/policy/voice-input.md`의 절로 읽힙니다.

**이 초안은 에이전트가 썼습니다.** 아래 "관측됨"은 전부 도구가 돌려준 응답이고,
**판정과 서명은 사람이 채웁니다.** 지어낸 관측은 어느 칸에도 넣지 않습니다.

- **관측일(UTC)**: 2026-09-10
- **관측자**: Claude Code (읽기 전용)
- **사용 자격증명**: 조직 admin key. 이 관측은 **읽기 전용**이고 계정 설정을
  바꾸지 않았습니다.
- **상태**: **관측 완료 — 외부 승인·정책 결정에 차단됨**

**`실패`도 `B-5 해결`도 아닙니다.** 읽을 수 있는 것은 읽었고, 읽을 수 없는
것이 무엇인지도 확인됐습니다. 남은 것은 저장소가 답할 수 없는 종류입니다.

---

## 1. 관측됨

계정 식별자는 원본이 아니라 SHA-256 앞자리로 적습니다
(`docs/policy/voice-input.md` §6.1.3-4가 `costObservation`에 대해 정한 것과 같은
규칙). 원본을 가진 사람은 대조할 수 있고, 나머지는 어느 계정인지 알 수 없습니다.

| 관측 | 결과 |
|---|---|
| `GET /v1/organization/data_retention` | **HTTP 403**, `code: not_eligible`, `type: invalid_request_error` |
| 그 응답의 message | "Data retention controls are not enabled for this organization. Get in touch with our sales team to learn more about these offerings and inquire about eligibility." (URL은 공급자 문서 링크) |
| `GET /v1/organization/projects/{project}/data_retention` | **HTTP 200**, `{"object":"project.data_retention","type":"organization_default"}` |
| Voice 트래픽의 프로젝트 | 조직 digest `b66052e69849`, 프로젝트 digest `35539b590847` |
| 같은 프로젝트의 다른 트래픽 | **있음** — 2026-09-09 cost bucket에서 transcribe line item 3건과 그 외 모델 line item 10건이 **같은 프로젝트 digest**를 씁니다 |
| 이 환경의 Voice 전용 키 | **없음** — `VOICE_TRANSCRIPTION_API_KEY`가 존재하지 않고, 관측된 전사 호출은 공용 `OPENAI_API_KEY`로 나갔습니다 (§6.1.6-5) |

**403이 증명하는 것은 좁습니다.** 관측 시점에 이 조직에서 data retention
controls가 **활성화·프로비저닝되지 않았다**는 것입니다. 영구적인 자격 거절도,
향후 승인 불가도 증명하지 않습니다. 응답 자신이 영업 접촉을 안내하며, 그것은
자격 심사가 남아 있다는 뜻이지 끝났다는 뜻이 아닙니다.

**프로젝트의 `organization_default`가 말하는 것도 좁습니다.** 프로젝트가 조직
설정을 **상속하도록 구성돼 있다**는 사실이며, 상속한 값이 무엇인지는 말하지
않습니다. 조직 조회가 403인 동안 **실효 retention 값은 미확정**입니다.

출처:
[조직 설정 조회](https://developers.openai.com/api/reference/python/resources/admin/subresources/organization/subresources/data_retention/methods/retrieve),
[프로젝트 설정 조회](https://developers.openai.com/api/reference/python/resources/admin/subresources/organization/subresources/projects/subresources/data_retention/methods/retrieve).

## 2. 관측되지 않음

**여기 있는 것을 위 표에서 유도하지 않습니다.**

- **조직의 실효 retention type.** 조회가 403이므로 값 자체가 없습니다.
- **ZDR 승인·신청·거절 이력.** 어떤 endpoint도 이것을 돌려주지 않았고, 403은
  "신청한 적 없음"과 "신청했으나 미승인"을 구분하지 않습니다.
- **기본 상태에서 실제 customer content가 보존되는지.** 설정 조회가 막힌 것과
  데이터가 어떻게 다뤄지는지는 별개 질문이며, 후자는 이 API로 관측되지
  않습니다.

## 3. 결정 대기 (사람)

- **ZDR을 production 필수조건으로 둘 것인가.** 이제 실제 분기입니다 —
  필수조건이면 B-5가 영업 일정에 묶이고, 아니면 그 이유가 기록으로 남아야
  합니다.
- **Voice 전용 프로젝트·API key를 만들 것인가.** ZDR 자격과 무관하게 지금
  가능하며 비용 추적·key rotation·사고 범위를 Voice에 한정합니다. **외부 쓰기
  작업이므로 사람의 승인 뒤에 진행합니다.**
- **DPA 편입 근거와 처리 지역.** 개인정보처리방침의 제3자 전송·국외 처리 고지를
  포함합니다.

**전용 프로젝트·key 분리만으로 B-5를 닫지 않습니다.** 그것은 §11.3.1이 이미
"요구사항이 아니라 우리 쪽 정책 선택"이라고 적은 항목이고, B-5가 묻는 계정
설정·계약을 대신하지 않습니다.

## 4. 외부 답변 대기 (공급자)

- **endpoint 표의 `None`과 같은 문서의 "최대 30일" 문장의 관계**
  (§11.3.2-1). 이 관측은 그것을 좁히지 못합니다 — 설정 조회가 막혀 있으므로
  계정 쪽에서 확인할 방법이 없고, 문서 두 곳의 우선관계는 여전히 공급자만
  답할 수 있습니다.

---

## 다음 관측을 덮어쓰지 않습니다

ZDR이 승인되거나 조직 설정이 바뀌면 **이 파일을 고치지 않고 두 번째 기록을
추가합니다.** 전후 상태가 남아야 "언제부터 그랬는가"에 답할 수 있고, 덮어쓰면
그 질문이 사라집니다. `docs/ops/voice-provider-budget-records/`가 회차별로 파일을
두는 것과 같은 이유입니다.

---

## 판정과 서명 (사람이 채웁니다)

- **판정**:
- **ZDR을 production 필수조건으로 두는가**:
- **서명**:
- **일자(UTC)**:
