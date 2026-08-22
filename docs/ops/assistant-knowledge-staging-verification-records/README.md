# Assistant knowledge staging 검증 실행 기록

`../assistant-knowledge-staging-checklist.md`는 항목만 가진 template입니다.
실행 결과는 여기에 **실행 1회 = 파일 1개**로 남습니다.

규칙은 외부 import·이미지 생성·assistant profile 기록과 같습니다. 네 번째로
같은 규칙을 적는 이유도 같습니다 — 이 구조가 만들어진 계기가 **문서 하나가
낡은 채로 공식적으로 보였던 일**이기 때문입니다.

## 파일 이름

```
YYYY-MM-DD__<40자리 deploy SHA>.md
```

전체 SHA를 씁니다. 축약 SHA는 시간이 지나면 충돌할 수 있고, 무엇보다 어느
커밋인지 확인하려면 저장소를 뒤져야 합니다.

## 규칙

1. **기록은 덮어쓰지 않습니다.** 재검증은 새 파일입니다.
2. **비어 있던 항목을 나중에 통과로 채우지 않습니다.** 실행하지 않은 항목은
   `미기록`이며, 그것이 사실입니다.
3. **한 기록은 자기가 실행된 template revision을 적습니다.**
4. **동결된 기록은 digest로 보호합니다.** `frozen: true`인 기록은
   `npm run check:staging-verification-records`가 본문 digest를 대조합니다.
5. **실행·판정·서명은 사람이 합니다.** 에이전트는 기록 파일의 뼈대를 만들 수
   있지만 결과·서명란을 채울 수 없습니다.

## 이 기능에만 있는 규칙

6. **파일 원문과 chunk 내용을 기록에 넣지 않습니다.** 판별 대상은 경계이지
   내용이 아닙니다. "계정 2의 파일명이 답에 나타나지 않음", "excerpt 3개가
   전부 계정 1의 파일에서 나옴"처럼 관측만 적습니다. 이 규칙을 어기면 유출을
   검증하는 문서가 유출 경로가 됩니다.

7. **실행 전 파일 배치를 먼저 적습니다.** 어느 계정의 어느 profile에 어떤
   파일을 두었는지를 나중에 적으면, 무엇이 인용됐어야 하는지 판정할 원본이
   존재하지 않습니다.

8. **정리 의무에 R2가 포함됩니다.** 이 회차는 staging의 R2에 object를 만듭니다.
   행만 지우고 cleanup queue를 소진하지 않으면 bytes가 남습니다. 잔여 tombstone
   수를 세어 적습니다.

## 새 실행을 시작할 때

기록은 손으로 복사하지 말고 생성합니다.

```
npm run new:staging-verification-record -- --feature assistant-knowledge --sha <staging에 실제 배포된 40자리 SHA>
```

`--preview`를 붙이면 파일을 쓰지 않고 출력만 합니다. 이미 있는 파일은
덮어쓰지 않습니다.

SHA는 git에서 읽지 않고 반드시 인자로 받습니다. 중요한 것은 staging이
**실제로 서빙하고 있는** 커밋이고, 이 기계는 그것을 알 방법이 없습니다.
`GET /api/build-info`가 그 값을 돌려줍니다.

## SHA를 production과 대조할 때

**main으로 가는 릴리스는 squash됩니다.** 그래서 staging에서 검증한 RC SHA는
production 이력에 나타나지 않고, 앞으로도 나타나지 않습니다. production에서
그 SHA를 찾으면 못 찾습니다.

대조는 SHA가 아니라 **내용**으로 합니다.

```
git diff <staging sha> <production sha> -- lib/assistantKnowledge*.ts 'app/api/assistant-profiles/**'
```

비어 있으면 두 배포의 knowledge 표면이 같다는 뜻이고, 그 결과를 기록의 실행
환경표에 적습니다. 2026-08-21 assistant profile 회차에서 이 구분이 없어
"RC가 production에 배포되었는가"를 SHA로 판정하려다 막혔습니다.

## 이 체크리스트가 짧은 이유

항목이 6개입니다. 적어서 부실한 것이 아니라, **CI가 실제 PostgreSQL에서 이미
증명하는 계약을 손으로 다시 하지 않기로** 한 결과입니다. 근거 표는 체크리스트
앞부분에 있습니다.

항목을 늘리려는 사람은 먼저 물어야 합니다 — **이것을 CI가 증명하지 못하는
이유가 무엇인가.** 답할 수 없으면 그 항목은 test에 속하지 이 문서에 속하지
않습니다. 그 질문이 이 회차를 27항목에서 6항목으로 줄인 것이고, 1인 조직에서
실제로 실행되는 검증과 미뤄지는 검증을 가르는 지점입니다.
