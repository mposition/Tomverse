# AMUX v52 review launcher staging 준비

v52의 검토 호출은 worker의 모델이나 sidecar가 아니라 worker별 v22 bridge의
결정적 코드가 수행한다. `AMUX_EXECUTION_GRADE_CODE_LATCH`는 true다.
래치가 켜지면 운영 스위치와 별개로 비용 catalog 승인 때 route와 worker의
단일 등급 일치 검사가 적용된다. 실행의 같은 등급 배정·contract 경로 검사·
검토 서버 호출은 `TOMVERSE_AMUX_EXECUTION_GRADE`가 정확히 `enabled`일 때만
열린다. 운영자가 staging에서 스위치를 켜기 전에는 실행 경로가 닫혀 있다.
이 문서는 배치 준비이며 스위치 활성화 승인이 아니다.

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
서버가 job id를 돌려주지 않으면(요청 실패) attempt를 `unknown`으로 닫지 않고, state 파일에
실패 횟수와 다음 시각을 적어 15초에서 시작해 두 배씩(최대 5분) 기다린 뒤 같은 diff를 다시
제출한다(운영자 결정 2026-11-16). bridge는 이 응답(`waiting`)을 진행 중으로 본다. 같은
commit의 job이 둘 생겨도 attempt가 저장한 job id만 읽으므로 판정은 틀리지 않는다. job id를
아는 attempt는 읽기만 다시 하고 제출하지 않는다. helper가 저장소를 준비하지 못해도 같은
방식으로 기다린다. 앱 기록 route의 응답이 불명확하면 앱 DB의 시도별 검토 기록을 먼저 읽는다.

판정이 `reject`이면 helper는 검토 서버 `status`가 이미 돌려준 구조화 findings와 reviewer별 이유 코드로
지적 문서(JSON, reviewer·severity·summary·file·line, 한도 없음)를 만들어 최종 결과와 state 파일에 함께
남기고, bridge는 그것을 기록 요청의 `findings_summary` 텍스트로 그대로 보낸다(운영자 결정 2026-11-15, 앞선
2026-11-14 결정의 8줄 요약을 대체). 어떤 reviewer가 지적을 적지 않고 거절했으면 그 slot의 report 글을
읽어(8초 제한, 실패해도 판정은 그대로) 같은 문서에 `note`로 넣는다. 앱은 비밀값처럼 보이는 줄을 지우고 링크를
`[link]`로 바꾼 뒤 판정 행 옆에 암호화된 content unit(`AmuxV52ReviewFindings`, 보존은 Task 종료 후 90일)으로
저장하고, Admin 카드 상세·운영자 확인 대기·Decision Maker 카드·다음 시도의 prompt가 읽는다. 본문은 요청
digest와 감사 metadata에 들어가지 않고(감사에는 digest와 개수만) 판정을 바꾸지 않는다. 내용이 없는 이전 기록과
보존 기한이 지난 기록은 검토 job id와 CLI 안내를 보인다. 배치 순서는 앱(migration 포함)이 먼저고, 그다음
bridge와 helper다. 앱은 JSON 문서와 이전 helper의 줄 텍스트를 모두 받는다. 이전 앱은 모르는 필드가 있는 요청을
거절하고, 한도가 넓어진 helper의 큰 `findings_summary`(최대 4,000,000자)를 받지 못한다.

같은 reviewer 공급사가 한 Task의 최근 두 검토를 연달아 거절하면 앱은 다음 시도의 delivery에
`review_avoid_vendors`를 싣고, bridge는 helper 입력의 `avoidReviewerVendors`로, helper는 review client에
`--avoid-vendor`로 넘긴다. bridge의 delivery profile은 모르는 필드를 거절하므로 앱은
`TOMVERSE_AMUX_V52_REVIEW_AVOID_VENDORS=enabled`일 때만 이 필드를 보낸다(기본 꺼짐). 새 bridge와 helper,
review client·서버를 모두 배치한 뒤에만 켠다.

검증할 때는 staging의 한 v4 Task에서 Task 등록, 같은 등급 배정, 정상 종료 후
로컬 commit과 검토 job, 앱의 `amux.review.recorded` 감사, 판정에 따른 상태 전이,
`develop` PR까지 각각 관측한다. `done`은 PR 병합 관측으로만 확인한다. 운영자가
코드 래치 PR을 병합한 뒤 운영 스위치를 staging에서 먼저 켜며, 에이전트는 두
스위치를 조작하거나 PR을 병합하지 않는다.
