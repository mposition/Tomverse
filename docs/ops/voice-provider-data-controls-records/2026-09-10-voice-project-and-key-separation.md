# B-5 관측 기록 (2회차) — Voice 전용 project·key 분리 (2026-09-10)

`docs/ops/voice-provider-data-controls-records/2026-09-10-account-observation.md`
가 **관측된 사실**로 적은 둘이 바뀌었습니다 — Voice가 다른 트래픽과 프로젝트를
공유한다는 것, 그리고 전용 키가 없다는 것.

**1회차 기록을 고치지 않습니다.** 그 파일은 2026-09-10 당시의 상태이고, 전후를
비교할 수 있어야 "언제부터 그랬는가"에 답할 수 있습니다(1회차의 "다음 관측을
덮어쓰지 않습니다").

**이 초안은 에이전트가 썼습니다.** 아래 "관측됨"은 도구가 돌려준 응답이고,
**판정과 서명은 사람이 채웁니다.**

- **관측일(UTC)**: 2026-09-10
- **수행**: 운영자(외부 쓰기). **관측**: Claude Code(읽기 전용)
- **상태**: **구성 완료 — 실제 트래픽 경로는 미확인**

---

## 1. 관측됨

식별자는 원본이 아니라 SHA-256 앞자리입니다(§6.1.3-4와 같은 규칙).

| 관측 | 결과 |
|---|---|
| `GET /v1/organization/projects` | `Tomverse Voice` 프로젝트가 **active**, 2026-09-10 생성, digest `afd8f62b001c` |
| `GET /v1/organization/projects/{voice}/api_keys` | 키 **1개** — `Voice Key`, 2026-09-10 생성, owner type `user` |
| `GET /v1/organization/projects/{voice}/data_retention` | HTTP 200, `{"object":"project.data_retention","type":"organization_default"}` |
| Railway `production` / Tomverse 서비스 | 환경변수 이름 목록에 **`VOICE_TRANSCRIPTION_API_KEY` 존재** |
| Railway `staging` / Tomverse 서비스 | 같음 |

## 2. 관측되지 않음 — 그리고 이것이 이 기록의 요점입니다

**`VOICE_TRANSCRIPTION_API_KEY`의 값이 위 `Voice Key`인지 확인되지 않았습니다.**

Railway는 이름만 돌려주고 값을 돌려주지 않습니다(`valuesRedacted: true`). 그것이
옳은 동작이고, 에이전트가 값을 볼 이유도 없습니다. 그러므로 **"전용 키가 배포에
설정됐다"까지가 관측이고, "그 변수가 이 키를 담고 있다"는 관측이 아닙니다.**

**이 구분은 형식적이지 않습니다.** 변수에 공용 `OPENAI_API_KEY` 값이 들어 있어도
위 다섯 줄은 전부 똑같이 통과합니다. 구성과 실제 경로는 다른 사실입니다.

**무엇이 이것을 판별하는가**: 전사 호출 한 번, 그리고 다음 날 Costs에
`Tomverse Voice` 프로젝트 line item이 나타나는지. **B-6의 유료 검증이 정확히 그
일을 하므로 이를 위한 별도 호출은 필요하지 않습니다** — B-6 실행 후의 Costs
읽기가 이 칸을 채웁니다.

**조직의 실효 retention 값도 여전히 관측되지 않습니다.** 새 프로젝트도
`organization_default`이고 조직 조회는 그대로 403입니다. 전용 프로젝트가 생겼다고
읽히게 되지 않았습니다.

## 3. 이 분리가 바꾸는 것과 바꾸지 않는 것

**바꾸는 것**: 비용 추적, key rotation, 사고 범위가 Voice에 한정됩니다.

**바꾸지 않는 것**: B-5. `docs/policy/voice-input.md` §11.3.1이 적은 대로 분리는
공급자 요구사항이 아니라 우리 쪽 정책 선택이며,
`docs/ops/voice-provider-data-controls-records/2026-09-10-zdr-precondition-decision.md`
도 같은 말을 합니다. **DPA 편입 요건도 아닙니다**(3회차 기록).

---

## 판정과 서명 (사람이 채웁니다)

- **판정**:
- **서명**:
- **일자(UTC)**:
