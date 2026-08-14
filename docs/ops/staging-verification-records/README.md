# Staging 검증 실행 기록

`../external-import-staging-checklist.md`는 항목만 가진 template입니다. 실행
결과는 여기에 **실행 1회 = 파일 1개**로 남습니다.

## 파일 이름

```
YYYY-MM-DD__<40자리 deploy SHA>.md
```

전체 SHA를 씁니다. 축약 SHA는 시간이 지나면 충돌할 수 있고, 무엇보다 어느
커밋인지 확인하려면 저장소를 뒤져야 합니다. 날짜가 앞에 오는 것은 목록이
시간순으로 정렬되게 하기 위해서입니다.

## 규칙

1. **기록은 덮어쓰지 않습니다.** 재검증은 새 파일입니다. 과거 실행이 무엇을
   보고 무엇을 보지 않았는지가 그 기록의 가치이고, 고쳐 쓰면 사라집니다.
2. **비어 있던 항목을 나중에 통과로 채우지 않습니다.** 실행하지 않은 항목은
   `미기록`이며, 그것이 사실입니다.
3. **한 기록은 자기가 실행된 template revision을 적습니다.** 그래야 나중에
   추가된 항목을 "그때는 없던 항목"으로 읽을 수 있습니다.
4. **동결된 기록은 digest로 보호합니다.** `frozen: true`인 기록은
   `npm run check:staging-verification-records`가 본문 digest를 대조합니다.
   내용을 고치면 digest가 어긋나 검사가 실패하고, digest를 다시 계산해 넣는
   것은 diff에 드러나는 의도적 행위입니다. 자물쇠가 아니라 기록입니다.
5. **실행·판정·서명은 사람이 합니다.** 에이전트는 기록 파일의 뼈대를 만들 수
   있지만 결과·서명란을 채울 수 없습니다.

## 새 실행을 시작할 때

`_record-template.md`를 위 이름 규칙으로 복사하고, 실행하면서 채웁니다.
`frozen`은 서명이 끝난 뒤에 `true`로 바꾸고 digest를 적습니다.

```
node scripts/check-staging-verification-records.mjs --digest <파일>
```

이 명령이 그 파일의 digest를 출력합니다.
