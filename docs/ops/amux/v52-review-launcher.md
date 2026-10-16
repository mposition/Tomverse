# AMUX v52 review launcher staging 준비

v52의 검토 호출은 worker의 모델이나 sidecar가 아니라 worker별 v22 bridge의
결정적 코드가 수행한다. `AMUX_EXECUTION_GRADE_CODE_LATCH`의 출고 값은 false이고,
운영 스위치 `TOMVERSE_AMUX_EXECUTION_GRADE`도 운영자가 staging에서 따로 켜기
전에는 닫혀 있다. 이 문서는 배치 준비이며 스위치 활성화 승인이 아니다.

worker별 bridge system unit의 전용 계정에 다음을 준비한다.

- `AMUX_V52_REVIEW_HELPER`: 이 commit의
  `scripts/amux-v52-review-runner.mjs`를 설치한 절대경로. 파일과 상위 디렉터리는
  root 소유이고 worker 및 group이 쓸 수 없어야 한다.
- `AMUX_V52_REVIEW_CLIENT`: 같은 commit의
  `tools/review-orchestrator/client/review.mjs`를 설치한 절대경로. 파일과 상위
  디렉터리는 root 소유이고 worker 및 group이 쓸 수 없어야 한다.
- `AMUX_V52_REVIEW_STATE_DIR`: 해당 bridge 계정 소유의 별도 절대경로. 권한은
  `0700`이며 시도별 제출 claim, 판정, 격리된 bare repository를 보관한다. 같은 worker의 재시작 뒤에도
  보존한다. 이 디렉터리가 없거나 안전하지 않으면 검토를 제출하지 않는다.
- `AMUX_V52_REVIEW_OBJECTS_DIR`: 해당 worker의 Task repository에 있는 Git
  object directory의 절대경로. bridge 계정에는 읽기 권한만 준다. helper는 worker
  소유 worktree에서 Git 명령을 실행하지 않는다. 이 object directory를 alternate로
  읽는 bridge 소유 bare repository를 state directory에 만들고, 검토 대상의 base와
  commit SHA만 ref로 묶는다. Git config와 ref는 worker가 쓸 수 없어야 한다.

검토 서버 SSH key와 SSH 설정은 bridge 계정의 `HOME`에만 둔다. worker 계정이
그 key를 읽거나 bridge의 state directory에 접근할 수 없어야 한다. bridge가
helper를 실행할 때 제품 내부 API secret은 자식 프로세스 환경에서 제거된다.
worker가 끝낸 변경은 sidecar가 로컬 commit과 AMUX ref에 묶고 원래 base로
worktree를 되돌린다. bridge는 commit 객체를 격리된 bare repository에서 확인한
뒤 자체 ref를 검토 클라이언트에 `--head-ref`로 전달한다. 클라이언트는 worker Git
ref를 수정하지 않는다.

배치 순서는 Prisma migration, 앱과 bridge 및 sidecar 바이너리, root 소유 helper와
review client, bridge별 object 읽기 권한과 state directory 순이다. 검토 서버가 사용하는
기존 독립 reviewer 선정 규칙은 그대로다. v52 contract 경로는 서버의 별도
경로 목록과 관계없이 두 독립 vendor를 명시적으로 요청하고 검증한다. helper 또는 review
서버 오류는 `unknown`으로 기록해 Task를 `blocked`로 넘기며, 제출 claim이 있으면
같은 diff를 다시 제출하지 않는다. 앱 기록 route의 응답이 불명확하면 앱 DB의
시도별 검토 기록을 먼저 읽는다.

검증할 때는 staging의 한 v4 Task에서 Task 등록, 같은 등급 배정, 정상 종료 후
로컬 commit과 검토 job, 앱의 `amux.review.recorded` 감사, 판정에 따른 상태 전이,
`develop` PR까지 각각 관측한다. `done`은 PR 병합 관측으로만 확인한다. 운영자가
코드 래치 PR을 병합한 뒤 운영 스위치를 staging에서 먼저 켜며, 에이전트는 두
스위치를 조작하거나 PR을 병합하지 않는다.
