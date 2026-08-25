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

실행·판정·서명은 사람이 합니다. 에이전트는 항목을 갱신하고 실행자가 보고한
관측을 기록 초안에 옮겨 적을 수 있습니다. 쓸 수 없는 것은 **판정과 서명**뿐이며,
지어낸 관측은 어느 쪽에서도 허용되지 않습니다 — 기록 README의 5번 참조.

## 이 문서는 template입니다

**여기에는 결과가 없습니다.** 체크박스는 항상 비어 있고, 그것이 이 파일의
상태입니다. 실행 결과는 `assistant-profile-staging-verification-records/`에
**날짜와 전체 deploy SHA로 이름 붙인 별도 파일**로 남습니다.

- **template revision**: `2026-08-24a` — 항목이 바뀌면 이 값을 올리고, 실행
  기록은 자기가 어느 revision으로 실행됐는지 적습니다.

  `2026-08-20`에서 `2026-08-20a`로 올린 이유는 발견성·생성 UX 변경(#690)이 §F의
  진입점을 옮기고 §I의 생성 흐름을 새로 만들었기 때문입니다 — 그 전 revision으로
  실행된 기록은 §I를 몰랐던 실행으로 읽어야 합니다.

  `2026-08-21a`로 다시 올린 이유는 **§F의 항목이 제품보다 낡아 있었기**
  때문입니다. #695가 탭 이름을 `AI 개인화`로 정하고 #696이 어시스턴트를 자기
  탭으로 분리했는데 §F는 여전히 `AI 설정` 탭 하나와 `나만의 AI 프로필`
  breadcrumb, 탭 다섯 개를 기대하고 있었습니다. **낡은 기대는 정상 동작을
  fail로 적게 만들고, 그것이 이 파일이 template인 이유를 무너뜨립니다.**
  `9c91042` 회차가 §F에 도달하기 전에 발견해 고쳤습니다.

  `2026-08-24a`로 올린 이유는 **§I가 §F와 같은 방식으로 낡았기** 때문입니다.
  #868이 모델 선택을 체크박스 목록에서 라디오 두 개(`계정 기본 모델 따르기` /
  `직접 지정`)로 바꾸고, profile이 **모델을 지정하지 않는 것**을 유효한 상태로
  만들었습니다(정책 §14.0a). 그 전 문구는 `고급 설정`을 열면 체크박스가 보이길
  기대하므로, 지금 제품에서는 **정상 동작이 fail로 적히게 됩니다.** 같은 변경이
  거절 문구를 코드 기반 현지화로 옮겼고(#868·#892), 그것을 볼 자리가 없어 §J를
  새로 만들었습니다.
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

## 무엇이 flag를 막고, 무엇이 막지 않는가

**62개 항목이 전부 릴리스 차단 사유는 아닙니다.** 그런데 목록만 보면 전부
그렇게 보이고, 그것이 1인 조직에서 검증을 감당 못 할 일로 만듭니다. 그래서
여기에 갈라 적습니다.

기준은 이 문서 앞의 것과 같습니다 — **되돌릴 수 있는가.**

### 차단 (flag를 켜기 전에 반드시)

| 구획 | 왜 차단인가 |
|---|---|
| **A** Fail-closed | flag가 실제로 막는지 모르면 켜는 행위 자체가 무의미하다. 0크레딧 |
| **B** 대화 격리 | `selectedModels`·`disabledPanels`에 변경 이력이 없다. 덮어쓰면 복구 불가 |
| **C** 버전 고정 | 어느 대화가 어느 revision에 있었는지도 이력이 없다. 밀린 pin은 되돌릴 수 없다 |
| **D-2** 적대적 지시문 | 사용자 텍스트가 system prompt 자리에 들어간다. 경계가 뚫리면 유출이고, 유출은 회수되지 않는다 |
| **E** Memory 경계 | 주입 flag가 꺼진 동안 개인 데이터가 prompt에 들어가면 프라이버시 사고다 |
| **G-1** 삭제 고아 | profile 삭제가 대화를 못 열게 만들면 사용자 데이터 손실이다 |
| **H** 관측 | flag를 콘솔로 켰다는 증거(`AdminAuditLog` 해시 체인)가 남아야 한다. 0크레딧 |

**합계: A 5 + B 7 + C 7 + D 1 + E 3 + G 1 + H 4 = 28항목, 유료 turn 6~7건.**

숫자가 `26`에서 바뀐 것은 새 항목 하나(§B의 §14.0a) 때문만이 아닙니다. 세던
값이 목록과 어긋나 있었습니다 — B와 C는 이미 각각 7항목이었고 전체도 53이었는데
`26`과 `52`로 적혀 있었습니다. **D와 G는 구획 전체가 아니라 이름 댄 항목
하나씩**이며(적대적 지시문 / 삭제 고아), 그 둘의 `D-2`·`G-1`은 위치 번호가
아니라 그 항목을 가리키는 이름으로 읽습니다 — 항목이 늘면서 위치가 밀렸습니다.

### 차단 아님 (켠 뒤에 고쳐도 되는 것)

| 구획 | 왜 아닌가 |
|---|---|
| **D**의 나머지 | prompt 조립·토큰 계상·model identity의 정확성. 틀리면 고쳐서 배포하면 되고, 과금 오류는 환급된다 (적대적 지시문 항목만 차단) |
| **F** 진입점·노출 | 라벨·breadcrumb·탭 배치. 잘못돼도 아무것도 파괴하지 않고 앞으로 고칠 수 있다 |
| **G-2·G-3** | 표시 문구와 계정 삭제 cascade. 후자는 릴리스 A에서 이미 검증됐다 |
| **I** 생성·발견 | 생성 UX의 편의성. 단 **"생성 실패 시 사용할 수 없는 profile이 남지 않는다"** 한 항목은 데이터 정합성이라 차단으로 올린다 |
| **J** 거절 문구 | 문구는 고쳐서 배포하면 된다. 잘못된 문장이 파괴하는 것은 없다 |

**차단 아닌 항목은 `미기록`으로 남기고 서명해도 됩니다.** 판정란에 어느 구획을
왜 건너뛰었는지 적으면, 그 기록은 비어 있는 것이 아니라 **범위를 밝힌** 것이
됩니다.

### 이 갈래를 바꾸려면

항목을 차단으로 올리는 근거는 **되돌릴 수 없음**입니다. "중요해 보인다"는
근거가 아닙니다. 새 항목을 차단에 넣을 때는 무엇이 복구 불가인지 한 줄로
적으십시오. 적을 수 없으면 차단이 아닙니다.

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
| I | 1 | 채팅에서 만든 profile이 그 대화에 실제로 붙는가 (#690) |
| J | 0 | 거절 문구만. 저장이 실패하는 경로라 크레딧을 쓰지 않습니다 |

기본 모델(`gpt-5-6-luna`) Standard 기준 turn당 1크레딧이므로 **합계 6~7크레딧**
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
- [ ] §14.0a: **모델을 지정하지 않은** profile로 새 대화를 만들면 계정의 새
      대화 선택이 그대로 선다 — 그 profile을 만들던 날의 기본 모델로 고정되지
      않는다. 같은 대화 생성에서 함께 보므로 **유료 turn이 늘지 않습니다**
- [ ] profile을 해제(`assistant-option-none`)해도 `selectedModels`가 바뀌지
      않는다

마지막 두 항목이 §14.0의 표를 그대로 실행한 것입니다. 하나는 채택하고 하나는
보존하는 것이 의도이며, 둘이 같아지면 어느 쪽으로 같아지든 결함입니다.

## C. 버전 고정 (유료)

- [ ] 새 대화가 profile의 **최신 active revision**에 pin된다
- [ ] revision을 새로 publish한 뒤에도 기존 대화의 pin이 **움직이지 않는다**
- [ ] 그 대화가 `superseded`로 표시된다 — 점이 아니라 **문구**로
      (`tools-assistant-superseded-badge`, "새 개정 있음")
- [ ] 어시스턴트 목록에서 그 profile 행이 **pin된 개정**을 말한다
      (`assistant-option-{id}-detail` = "개정 1 사용 중 · 최신 3"). 최신 개정
      번호만 적힌 행에 체크 표시가 붙으면 이동하지 않은 대화가 이동한 것으로
      읽힙니다
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

`flag_off`가 관측되는 것은 **injection flag가 꺼져 있는 동안뿐**입니다.
`decideMemoryInjection()`(`lib/memoryInjectionGate.ts`)은 `guest` → `flag_off`
→ `no_approved_pair` → `account_off` → `conversation_off` 순으로 판정하므로,
flag가 꺼져 있으면 승인된 extraction pair가 없어도 `flag_off`가 먼저 나옵니다 —
**이 구획의 전제가 성립합니다.** Admin Console이 "injection refuses with
`no_approved_pair`"라고 적는 것은 **flag를 켰을 때** 걸리는 다음 관문을 말한
것입니다.

**flag를 켠 뒤에 이 구획을 다시 볼 때는 기대값이 달라집니다.** 승인된 pair가
없으면 사유는 `no_approved_pair`이고, 그 상태에서는 이 항목이 판별하려는
`flag_off` 대 `profile_off` 구분을 관측할 수 없습니다. 그때는 pair가 승인된 뒤에
실행합니다 (`docs/ops/memory-extraction-eval-program-kickoff.md`).

## F. 진입점과 노출

**정보 구조가 세 번 바뀌었습니다.** #690이 profile과 memory를 Data 탭 밖으로
꺼냈고, #695가 그 탭 이름을 `AI 개인화`로 정했으며, #696이 어시스턴트를 자기
탭으로 분리했습니다. 아래 항목은 **마지막 상태**를 기준으로 합니다.

지금의 탭은 여섯입니다 — `계정 · 환경설정 · AI 어시스턴트 · AI 개인화 ·
데이터 · 플랜`(`lib/accountSettingsEvents.ts`의 `ACCOUNT_SETTINGS_TABS`).
어느 행이 어느 탭에 사는지는 `lib/settingsNavigation.ts`의
`SETTINGS_SECTION_TAB` 하나가 정하며, 그것이 breadcrumb와 "설정으로 돌아가기"의
목적지를 함께 결정합니다.

- [ ] 설정에 `AI 어시스턴트` 탭이 있고, 그 안에서 어시스턴트 목록을 보고 새
      어시스턴트를 만들 수 있다
- [ ] 설정에 `AI 개인화` 탭이 있고, 그 안에 memory 행과 새 대화 모델 조합이
      있다
- [ ] `데이터` 탭에는 어시스턴트 행과 memory 행이 **없다** — 가져오기·계정
      데이터·이메일 알림만 남는다
- [ ] 어시스턴트 행의 action label이 자기 목적을 말한다
      (`docs/ui-contracts/settings-navigation.md` 계약)
- [ ] 상세 페이지의 breadcrumb가 `설정 / AI 어시스턴트 / 나의 AI 어시스턴트`
      이다 — `AI 설정`도 `데이터 및 개인화`도 아니다
- [ ] `AI 개인화` 탭에 머물던 시절의 deep link(`?settings=ai&settingsSection=assistants`)
      가 여전히 어시스턴트 탭을 연다 — 구획을 옮겨도 북마크가 죽지 않는다
      (`SETTINGS_SECTION_TAB`이 tab을 결정하므로 손으로 쓴 tab 값은 무시된다)
- [ ] 컴포저 도구 메뉴의 어시스턴트 행에서 어시스턴트를 고르고 해제할 수 있다
- [ ] 비로그인 세션에는 진입점이 없다 — 어시스턴트는 계정에 속한다
- [ ] 상세 페이지에서 "설정으로 돌아가기"가 직접 연 URL에서도 동작하고, 돌아간
      뒤 그 행에 focus가 있다
- [ ] 모바일 320px에서 컴포저 textarea가 전용 full-width 행을 유지한다
      (`docs/ui-contracts/mobile-chat-composer.md` 계약)
- [ ] 모바일에서 설정 탭 **여섯 개**가 잘리거나 라벨이 읽을 수 없게 좁아지지
      않는다

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

## I. 생성과 발견 (#690, 유료 turn 1건)

이 구획은 발견성·생성 UX 변경과 함께 추가됐습니다. **되돌릴 수 없는 것과
무관하지만, 한 번도 사람 눈으로 본 적이 없는 새 경로**입니다.

되돌릴 수 없는 것이 여기에도 하나 있습니다 — **생성이 실패했는데 사용할 수
없는 profile이 남는 상태**입니다. 남으면 목록에 보이고 picker에 뜨는데 대화를
시작하지 못하며, 사용자는 그것이 고장인지 미완성인지 구분할 수 없습니다.

- [ ] `/settings/assistants/new`가 이름·지시문·설명만 보여준다. 아이콘과
      모델은 닫힌 `고급 설정` 안에 있다
- [ ] `고급 설정`을 열면 모델 구획이 **라디오 두 개**로 시작한다 —
      `계정 기본 모델 따르기`가 선택돼 있고, 모델 목록은 **보이지 않는다**.
      (2026-08-21a까지는 체크박스 목록이 바로 보이길 기대했습니다. #868 이후
      그 기대는 정상 동작을 fail로 적게 만듭니다)
- [ ] `직접 지정`을 고르면 모델이 **이름으로 고르는 목록**으로 나타난다 —
      쉼표로 구분한 내부 ID 입력창이 아니다
- [ ] 그때 계정 기본 모델 **하나가 미리 선택돼 있고, 그 마지막 하나는 해제되지
      않는다**. 해제 대신 "지정하지 않으려면 다른 쪽을 고르라"는 안내가 보인다
- [ ] 아무것도 건드리지 않고 만든 profile이 **모델을 지정하지 않은 채** 저장된다
      (`GET /api/assistant-profiles/{id}`의 `currentVersion.models`가 `[]`)
- [ ] 이름과 지시문만으로 만든 profile이 **즉시 picker에 나타나고 대화를
      시작할 수 있다** (두 번째 저장 없이)
- [ ] 지시문을 비운 채 제출하면 그 필드에 오류가 붙고 focus가 이동하며,
      **요청이 나가지 않는다**
- [ ] 컴포저 → 어시스턴트 → `새 프로필 만들기` → 최소 폼 → `만들고 이 대화에
      사용` → **원래 대화로 돌아오고 그 profile이 붙어 있다**
- [ ] 복귀한 대화의 `selectedModels`가 §B의 사전 기록과 같다 — 생성 왕복이
      모델 설정을 건드리지 않는다
- [ ] profile이 하나도 없을 때 picker가 안내 문장이 아니라 `새 프로필 만들기`를
      primary로 보여준다
- [ ] 편집 화면의 주 버튼이 `변경사항 저장`이고, 성공 메시지가 개정 번호를
      말하지 않는다. version history에는 개정 번호가 그대로 있다
- [ ] **신고된 결함의 회귀**: 모델을 지정한 profile을 편집해 `계정 기본 모델
      따르기`로 바꾸고 저장하면 오류 없이 새 개정이 만들어진다. 2026-08-23까지
      이 동작은 `Invalid request payload.`로 거절됐습니다 (#868)
- [ ] 생성이 서버 오류로 실패했을 때 **목록에 사용할 수 없는 profile이 남지
      않는다** (staging에서 만들기 어려우면 `n/a`로 두고 이유를 적습니다 —
      DB 통합 테스트가 이 계약을 덮고 있습니다)

## J. 거절 문구 (0크레딧)

#868과 #892가 이 화면의 실패 문구를 서버 문장에서 **코드 기반 현지화**로
옮겼습니다(`lib/assistantProfileErrorCopy.ts`). 그 전에는 저장이 실패하면
API가 운영자용으로 쓴 영어 문장이 한국어 화면에 그대로 떴고, 어느 칸이
문제인지도 말하지 않았습니다.

**되돌릴 수 없는 것은 없습니다** — 문구는 고쳐서 배포하면 됩니다. 그래서 이
구획은 차단이 아니고, 크레딧도 쓰지 않습니다. 여기 있는 이유는 **한 번도 사람
눈으로 본 적이 없는 표면**이기 때문입니다.

- [ ] 비로그인 상태로 `/settings/assistants/new`에서 만들기를 눌렀을 때, 화면
      언어의 문장이 나오고 **영어 원문(`Unauthorized`)이 보이지 않는다**.
      문구가 "로그인 상태가 아니어서"라고 말하고, 로그인한 적 없는 방문자에게
      "로그인이 풀렸다"고 말하지 않는다 (#892)
- [ ] 그 화면을 떠나지 않은 채 입력한 이름·지시문이 **그대로 남아 있다** —
      문구가 약속하는 것이 실제로 참인지 확인합니다
- [ ] 저장 실패 알림 어디에도 **오류 코드 문자열**(`ASSISTANT_...`)이 그대로
      노출되지 않는다
- [ ] (선택) 비활성 모델을 지정한 profile로 저장을 시도하면 플랜을 언급하는
      자기 문장이 나온다. staging에서 비활성 모델을 만들기 어려우면 `n/a`로
      두고 이유를 적습니다 — `tests/assistantProfileErrorCopy.test.mjs`가 모든
      코드에 문구가 있다는 것을 이미 강제합니다

## 실행 기록

결과는 여기에 적지 않습니다.
`assistant-profile-staging-verification-records/README.md`를 따릅니다.
