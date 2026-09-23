# Admin 사용 현황 탭 staging 검증 실행 기록

`../admin-usage-analytics-staging-checklist.md`는 항목만 가진 template입니다.
실행 결과는 여기에 **실행 1회 = 파일 1개**로 남습니다.

## 파일 이름

```
YYYY-MM-DD__<40자리 deploy SHA>.md
```

**merge SHA를 옮겨 적지 말고 실행 시점에 `GET /api/build-info`를 읽으십시오.**
staging은 develop에 병합된 것이 CI를 통과해야 재배포되므로, 병합 SHA와 서빙
SHA가 다를 수 있습니다. 2026-09-17 회차가 그랬습니다 — #1541이 병합됐지만
develop의 Admin E2E가 실패해 staging은 #1539에 머물렀습니다.

## 규칙

1. **기록은 덮어쓰지 않습니다.** 재검증은 새 파일입니다.
2. **비어 있던 항목을 나중에 통과로 채우지 않습니다.** 실행하지 않은 항목은
   `미기록`입니다.
3. **한 기록은 자기가 실행된 template revision을 적습니다.**
4. **동결된 기록은 digest로 보호합니다.** `frozen: true`인 기록은
   `npm run check:staging-verification-records`가 본문 digest를 대조합니다.
5. **판정과 서명은 사람이 씁니다.** 에이전트는 실행자가 보고한 관측을 옮겨 적어
   초안을 만들고, 지어낸 관측은 어느 쪽에서도 허용되지 않습니다.

## 새 실행을 시작할 때

```
npm run new:staging-verification-record -- --feature admin-usage-analytics --sha <staging에 실제 배포된 40자리 SHA>
```
