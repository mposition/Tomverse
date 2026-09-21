# AMUX staging 검증 실행 기록

`../staging-checklist.md`는 결과가 없는 template이다.

실제 실행은 **1회 = 파일 1개**로 이 디렉터리에 남긴다.

## 파일명

    YYYY-MM-DD__<40자리 deploy SHA>.md

반드시 staging이 실제로 서빙하는 전체 SHA를 사용한다.

로컬 checkout의 `git rev-parse HEAD`를 staging SHA라고 추측하지 않는다.

## 새 실행 생성

staging deploy SHA를 실제로 확인한 뒤에만 실행한다.

    npm run new:staging-verification-record -- \
      --feature amux \
      --sha <staging이 실제로 서빙하는 40자리 SHA>

구조 확인만 할 때는 파일을 쓰지 않는 preview를 사용한다.

    npm run new:staging-verification-record -- \
      --feature amux \
      --sha 0000000000000000000000000000000000000000 \
      --preview

zero SHA는 preview 구조 검사에만 사용하며 실제 record로 저장하지 않는다.

## 기록 규칙

1. 과거 record를 덮어쓰지 않는다.
2. 실행하지 않은 항목은 `미기록`으로 남긴다.
3. 관측한 사실과 사람의 판정을 구분한다.
4. secret, token, task prompt, 사용자 데이터는 저장하지 않는다.
5. 실행자/승인자/result는 사람이 작성한다.
6. 완료 후 digest를 계산하고 `frozen: true`로 동결한다.
7. checker가 통과한 뒤에만 completed record를 commit한다.

digest:

    node scripts/check-staging-verification-records.mjs \
      --digest <record-file>

전체 검사:

    npm run check:staging-verification-records

빈 record는 공식 결과처럼 보이면 안 되므로 commit하지 않는다.
