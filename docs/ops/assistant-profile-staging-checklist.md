# Assistant profile staging 검증 체크리스트

`docs/policy/external-conversation-import-and-memory.md` §14·§15가 요구하는
검증입니다. **이 체크리스트의 실행과 승인은 production에서
`feature.assistantProfilesEnabled`를 켜기 위한 전제 조건**입니다.

이 기능은 **production에서 한 번도 켜진 적이 없습니다.** 그 사실은 추정이 아니라
`.github/audits/assistant-profile-cross-conversation-exposure-2026-08-16.md`가
감사 로그·행 타임스탬프·해시 체인 세 가지로 확인한 것입니다. 같은 문서가 그
사실을 근거로 #632의 노출을 "없음"으로 종결했으므로, **이 기능의 production
동작은 지금까지 한 번도 관측된 적이 없습니다.** 이 체크리스트는 그 공백을 staging
에서 먼저 메우기 위한 것입니다.

실행·판정·서명은 사람이 합니다. 에이전트는 항목을 갱신할 수 있지만 실행 결과를
스스로 기입할 수 없습니다.

## 이 문서는 template입니다

**여기에는 결과가 없습니다.** 체크박스는 항상 비어 있고, 그것이 이 파일의
상태입니다. 실행 결과는 `assistant-profile-staging-verification-records/`에
**날짜와 전체 deploy SHA로 이름 붙인 별도 파일**로 남습니다.

- **template revision**: `2026-08-20` — 항목이 바뀌면 이 값을 올리고, 실행
  기록은 자기가 어느 revision으로 실행됐는지 적습니다.
- 실행 방법과 파일 이름 규칙:
  `assistant-profile-staging-verification-records/README.md`
- 기록 template:
  `assistant-profile-staging-verification-records/_record-template.md`

## 무엇이 되돌릴 수 없는가

직전 회차(이미지 생성)에서 되돌릴 수 없는 것은 **돈**이었습니다. 여기서는
다릅니다. **되돌릴 수 없는 것은 대화 상태입니다.**

`Conversation.selectedModels`와 `disabledPanels`에는 **변경 이력 테이블이
없습니다.** 위 노출 감사의 §6이 같은 말을 합니다 — 덮어써진 대화를 특정할 수
없고, 원래 값을 복원할 수도 없으며, 추정값으로 일괄 복구하면 영향받지 않은
대화까지 손상시킵니다. 그래서 **일괄 복구를 시도하지 않는 것**이 결정입니다.

여기에 pin된 profile version이 더해집니다. 어느 대화가 어느 revision에
묶여 있었는지도 이력이 없으므로, 조용히 앞으로 밀린 pin은 되돌릴 수 없습니다.

따라서 §B가 이 검증의 핵심이고, 다른 어떤 구획보다 먼저 신뢰되어야 합니다.
크레딧은 여기서 부차적입니다 — 잘못 과금된 turn은 환급할 수 있고, 덮어써진
대화 설정은 환급할 수 없습니다.

## 비용

**유료 구획은 §B·§C·§D·§E이며, 필요한 것은 일반 chat turn 몇 건뿐입니다.**
이미지 생성처럼 고정가 예약이나 provider 예산이 걸리지 않습니다.

| 구획 | 유료 turn | 무엇을 판별하는가 |
|---|---|---|
| A | 0 | flag가 꺼진 상태의 거절. 켜고 나면 다시 만들기 어렵습니다 |
| B | 2 | 서버 대화 행 2개를 만들기 위한 최소 turn. 교차 오염 여부 |
| C | 1 | 새 revision을 낸 뒤에도 기존 대화가 옛 revision으로 답하는가 |
| D | 1 | 적대적 instructions가 prompt 경계를 넘지 못하는가 |
| E | 1 | injection flag가 꺼진 동안 profile memory policy가 무효인가 |
| F–H | 0 | 화면·관측만 |

기본 모델(`gpt-5-6-luna`) Standard 기준 turn당 1크레딧이므로 **합계 5~6크레딧**
입니다. 프롬프트는 짧게 씁니다 — 판별 대상은 답의 품질이 아니라 경계입니다.

**§D·§E는 답 내용을 읽어야 하므로 모델을 바꾸지 않습니다.** 여러 모델을 비교할
이유가 이 검증에는 없습니다.

## 사전 조건

실행 전에 확인합니다. 하나라도 어긋나면 검증이 아니라 **다른 것을 측정**하게
됩니다.

- staging이 서비스 중인 전체 40자리 deploy SHA를 `GET /api/build-info`에서
  읽어 기록에 적었다. git에서 추측하지 않는다
- 그 SHA가 production이 서비스 중인 SHA와 같다. 다르다면
  `git diff <staging> <production>`으로 assistant profile 표면이 동일함을
  확인하고 그 결과를 기록에 적는다
- `feature.assistantProfilesEnabled`가 **아직 꺼져 있다** — §A를 먼저 실행합니다
- `feature.assistantKnowledgeEnabled`는 **이번 회차 내내 꺼둡니다.** 이 검증의
  대상이 아니고, 켜면 R2 object와 quota가 함께 들어옵니다
- `feature.memoryInjectionEnabled`가 꺼져 있다 — §E가 그 전제를 확인합니다
- 로그인 계정 1개와 비로그인 세션을 준비했다
- **크레딧이 실제로 차감됩니다.** 위 비용 표 참조

## A. Fail-closed (flag off)

flag가 꺼진 상태에서 먼저 봅니다. 켜고 나면 다시 만들기 어려운 상태입니다.

- [ ] `/settings/assistants`가 목록이 아니라 비활성 안내를 렌더한다
- [ ] 로그인 상태에서 `GET /api/assistant-profiles`가 403 이고 코드가
      `ASSISTANT_PROFILES_DISABLED`이다
- [ ] 비로그인 상태에서 같은 요청이 **401**이다 — flag 상태를 알려주지 않는다
      (인증이 flag보다 먼저 판정된다)
- [ ] 컴포저 도구 메뉴에 assistant 행(`tools-assistant-row`)이 렌더되지 않는다
- [ ] 위 요청 어느 것도 `AssistantProfile`·`AssistantProfileVersion` 행을
      만들지 않는다

## B. 다른 대화를 건드리지 않는다 (핵심 계약, 유료)

**이 구획이 이 검증의 이유입니다.** #632는 한 대화에서 profile을 고른 응답이
다른 대화의 `selectedModels`를 덮어썼고, 오류도 없고 새로고침해도 살아남았으며,
사후에 어느 대화가 당했는지 알 방법이 없었습니다.

준비: 서버 대화 **2개**를 만들고 **서로 다른 모델 조합**을 고릅니다. 같은
조합이면 덮어쓰기가 일어나도 보이지 않습니다. 두 대화의
`selectedModels`·`disabledPanels`를 실행 전에 기록에 적습니다.

- [ ] 대화 1에서 profile을 고른 뒤, 대화 2의 `selectedModels`와
      `disabledPanels`가 **한 글자도 바뀌지 않았다**
- [ ] 대화 1의 PATCH가 **응답하기 전에** 대화 2로 전환했을 때도 같다 —
      이것이 #632의 실제 발생 조건이다
- [ ] 두 대화를 새로고침한 뒤 서버가 돌려주는 값이 실행 전 기록과 같다
- [ ] §14.0: **기존** 대화에 profile을 연결해도 그 대화의 `selectedModels`가
      profile의 모델 목록으로 교체되지 않는다 (보존이 기본값)
- [ ] §14.0: **새** 대화를 profile과 함께 만들면 profile의 `modelIds`가 초기
      선택이 된다 (채택은 생성 시점뿐)
- [ ] profile을 해제(`assistant-option-none`)해도 `selectedModels`가 바뀌지
      않는다

마지막 두 항목이 §14.0의 표를 그대로 실행한 것입니다. 하나는 채택하고 하나는
보존하는 것이 의도이며, 둘이 같아지면 어느 쪽으로 같아지든 결함입니다.

## C. 버전 고정 (유료)

- [ ] 새 대화가 profile의 **최신 active revision**에 pin된다
- [ ] revision을 새로 publish한 뒤에도 기존 대화의 pin이 **움직이지 않는다**
- [ ] 그 대화가 `superseded`로 표시된다 (`tools-assistant-superseded-dot`)
- [ ] 그 상태에서 turn을 보내면 **옛 revision의 instructions**로 답한다
- [ ] 최신으로 이동(`assistant-move-to-latest`)은 **사용자가 눌러야만** 일어난다
- [ ] 이동 후에도 이미 저장된 과거 답변은 소급해 바뀌지 않는다

## D. Prompt 경계 (§9.1 · §10, 유료)

profile instructions는 사용자가 쓴 텍스트가 system prompt로 들어가는 자리입니다.

- [ ] profile instructions가 **system message 안에 한 번만** 나타나고, 대화
      내용보다 **앞**에 온다
- [ ] fence marker와 `ignore previous instructions` 류를 본문에 넣은 profile을
      만들어 보냈을 때, 그 문장이 경계를 넘지 못한다
- [ ] profile이 붙은 요청의 context bundle `profileTokens`가 0이 아니고,
      해제하면 0이 된다
- [ ] 대화 도중 profile을 바꾸면 이전 bundle이 **stale로 거절**되고 조용히
      재사용되지 않는다
- [ ] 응답에 표시되는 model identity가 실제 Tomverse 모델이다 (§14 마지막 줄)

## E. Memory와의 경계 (injection flag OFF, 유료)

정책 §15의 문서상 순서는 Injection이 Profiles보다 앞이지만, 실제 활성화 순서는
Profiles가 앞입니다. **이 구획이 그 순서가 안전하다는 것을 확인하는 자리입니다.**

- [ ] `memoryInjectionEnabled`가 꺼진 상태에서 profile의 memory policy가
      `on`이어도 prompt에 memory block이 들어가지 않는다
- [ ] 그 turn의 `memoryUsedCount`가 0이다
- [ ] 거절 사유가 `flag_off`로 관측된다 — `profile_off`가 아니다
      (profile이 껐기 때문이 아니라 운영 flag가 껐기 때문이라는 구분)

## F. 진입점과 노출

- [ ] 설정 → 데이터 그룹에 assistants 행이 있고, 그 행의 action label이 자기
      목적을 말한다 (`settings-navigation` 계약)
- [ ] 컴포저 도구 메뉴의 assistant 행에서 profile을 고르고 해제할 수 있다
- [ ] 비로그인 세션에는 진입점이 없다 — profile은 계정에 속한다
- [ ] 상세 페이지에서 "설정으로 돌아가기"가 직접 연 URL에서도 동작한다
- [ ] 모바일 320px에서 컴포저 textarea가 전용 full-width 행을 유지한다
      (mobile-chat-composer 계약)

## G. 삭제

- [ ] profile을 삭제해도 그 profile에 묶여 있던 대화가 삭제되지 않고, 열리며,
      과거 답변이 남는다
- [ ] 삭제된 profile에 묶인 대화가 그 사실을 표시하고, 새 turn을 보낼 수 있다
- [ ] 계정 삭제 시 profile과 version이 함께 지워진다

## H. 관측

**assistant profile 전용 admin endpoint는 없습니다.** 이미지 생성의
`GET /api/admin/image-generation`에 해당하는 것이 없으므로, 관측은 아래 셋과
소유자 자신의 대화 읽기로 합니다. 전용 panel을 만들 이유는 아직 없습니다 —
집계할 수치가 flag 값 하나뿐입니다.

- [ ] `GET /api/admin/app-settings`의 `assistantProfilesEnabled`가 의도한 값
- [ ] flag를 바꾼 저장이 `AdminAuditLog`에 2행(전·후)으로 남았다
- [ ] `GET /api/admin/audit-integrity`가 `valid: true`
- [ ] §B의 대화 상태는 소유자 자신의 `GET /api/conversations/{id}` 응답으로
      확인한다 — 계정 식별자가 저장소로 나가지 않는다

## 실행 기록

결과는 여기에 적지 않습니다.
`assistant-profile-staging-verification-records/README.md`를 따릅니다.
