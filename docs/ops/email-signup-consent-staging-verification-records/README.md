# 가입 동의·제품 내 안내 staging 검증 실행 기록

`../email-signup-consent-staging-checklist.md`는 항목만 가진 template입니다.
실행 결과는 여기에 **실행 1회 = 파일 1개**로 남습니다.

여기서 통과가 나오면 production에서 `feature.emailSignupConsentEnabled`를 켜는
결정만 남습니다.

## 파일 이름

```
YYYY-MM-DD__<40자리 deploy SHA>.md
```

전체 SHA를 씁니다. **merge SHA를 옮겨 적지 말고 실행 시점에
`GET /api/build-info`를 읽으십시오** — staging은 병합이 아니라 `test`가 가리키는
release candidate를 배포하므로(`npm run promote:test`, 2026-10-07 전에는 develop의
모든 병합), 병합 SHA와 서빙 SHA는 자주 다릅니다.

## 규칙

1. **기록은 덮어쓰지 않습니다.** 재검증은 새 파일입니다.
2. **비어 있던 항목을 나중에 통과로 채우지 않습니다.** 실행하지 않은 항목은
   `미기록`이며, 그것이 사실입니다.
3. **한 기록은 자기가 실행된 template revision을 적습니다.**
4. **동결된 기록은 digest로 보호합니다.** `frozen: true`인 기록은
   `npm run check:staging-verification-records`가 본문 digest를 대조합니다.
5. **실행·판정·서명은 사람이 합니다.** 통과·조건부·실패의 **판정**과 **서명**은
   사람만 씁니다. 그 둘은 에이전트가 비워 둡니다.

   **관측을 옮겨 적는 것은 에이전트가 합니다.** 실행자가 보고한 것 — 어느
   주소·계정으로 무엇을 체크하고 눌렀는지, 어떤 메일이 왔는지 — 과 그 계정의 DB
   행을 항목·관측 칸에 채워 초안을 만듭니다.

   경계는 **관측과 판정**입니다. "E1에 `objected` 1건이 있고
   `relationship_started`는 없다"는 관측이고, "그러므로 A-1은 통과다"는
   판정입니다. **지어낸 관측은 어느 쪽에서도 허용되지 않습니다.**

## 이 기능에만 있는 것 셋

**첫째, 기록에 주소를 남기지 않습니다.** staging DB는 production 사본이고,
테스트 주소도 사람의 메일함입니다. 기록은 계정을 `E1`·`G`·`M`처럼 역할 이름으로만
부르고, 주소·user id는 적지 않습니다.

**둘째, 정답은 DB 행입니다.** 화면에 무엇이 떴는지는 절반이고, 나머지 절반은
append-only 원장에 무엇이 남았는지입니다. 에이전트가 각 계정의
`SignupConsentAttempt`·`EmailPermissionEvent`·`ConsentRecord`·`EmailPreference`·
`EmailDelivery`를 읽기 전용으로 조회해 관측 칸에 옮깁니다.

**셋째, 계정은 한 번만 쓸 수 있습니다.** 가입 선택도 제품 내 안내도 계정마다 한
번이므로, 재검증은 새 주소와 새 OAuth 계정으로 합니다. production에 있던 계정은
staging에서도 기존 계정입니다.
