# Generated file revision P1 — local implementation and evidence

## 구현 범위

P0의 독립 입력 사본과 보이는 수정 요청문을 재사용하여 XLSX 값 수정, 실제 source/version
관계와 Web/Native 버전 선택을 구현했다. 기존 `GENERATED_ARTIFACT_REVISION_ENABLED`는
기본 꺼짐이다. Native는 기존 Chat/Parity 스위치와 서버 capability도 함께 따른다.
운영 설정·DB·AMUX를 변경하지 않았다.

기준 main은 새로 fetch한 `c8cb7c62e192814b8522786a8749d38769073661`이며 P0 이후
관련 main 변경은 없었다. P0의 `074b4f6c6`에서 별도
`codex/generated-file-revision-p1` branch와 독립 worktree를 만들었다. 원래 작업 폴더의
수정과 의존성을 보존하고 이 checkout의 lockfile로 `npm ci`했다. 설치된 Next.js 16.4.5의
로컬 route/client guide를 읽고 구현했다. 구현 commit은
`3571bb92a4f16396685027639339319578259bc4`다.

### XLSX

- 성공적으로 생성한 XLSX의 검증된 WorkbookSpec을 bounded canonical snapshot으로
  보관한다. 모델은 기존 `create_spreadsheet`의 request-scoped `att_N` handle과 명시적
  `cellUpdates`를 사용한다. 지정한 기존 데이터 셀의 값만 바꾸고 다른 sheet·순서·제목·
  열 정의·행/셀·값 타입·width·명명된 표시 형식·header style·freeze 설정을 재사용한다.
- 변경하지 않은 항목을 두 번 연속 수정하고 기존 실제 writer/parser 결과와 원본 hash를
  확인했다. XML 정규화 후 sheet 이름 충돌, null/빈 문자열/false/0/date, 빈 행과 최대
  데이터 행 끝부분도 다룬다. 전체 명세와 Send의 실제 남은 추출 예산을 모두 검사한다.
- 명세가 없는 이전 XLSX는 기존 OfficeParser worker와 spreadsheet grid reader로
  typed value와 물리적 행/열 위치를 읽는다. `workbook-values` mode와 편집 가능한
  요청문으로 원래 너비·표시 layout 보존의 한계를 알린다. 지원하지 않는 formula·merge·
  hidden/unknown 구조나 불완전 추출은 거절한다. 새 parser를 추가하지 않았다.
- 수식·매크로·차트·pivot·임의의 셀 서식, 행/열 추가·삭제나 범용 Office round-trip을
  추가하지 않는다. 새 canonical snapshot도 기존 renderer가 표현하는 값 전용 범위다.

### 버전 계보와 독립 사본

additive migration `20261115010000_generated_artifact_revision_lineage`는 artifact의
nullable canonical/parent/group과 upload/attachment의 별도 source/snapshot을 추가한다.
Attachment→Attachment 용도인 `sourceAttachmentId`를 artifact ID로 쓰지 않는다.
source 삭제는 `SET NULL`로 FK만 끊고 독립 사본의 내용과 남은 버전 그룹을 보존한다.
소유자의 계정 JSON export에는 새로 보관한 canonical 내용을 포함한다. 일반 앱·공유 DTO,
로그와 모델 권한 필드에는 canonical 내용·objectKey·storage URL을 추가 노출하지 않는다.

부모는 현재 turn에서 실제로 읽고 검증한 입력의 명시적 `revisionOf`로만 정한다. 파일명·
최신 카드·현재 모델로 추정하지 않는다. 무관한 생성물과 text-only 답변에는 가짜 관계가
없다. 과거 P0 파일의 관계도 소급 추측하지 않아 부모가 기록되지 않은 파일은
"No recorded source"로 표시한다.

새 versions GET은 현재 owner·conversation·unlock·ready와 cursor scope를 검사하고
같은 실제 그룹의 ready 버전을 최대 50개씩 반환한다. Web/Native는 명시적으로 열 때만
조회하고, 같은 이름의 분기에서도 정확한 부모로 이동하거나 특정 버전을 선택한다.
원래 다운로드는 유지한다. Native의 versions GET과 unbound cleanup DELETE는 기존
verified bearer 경계에 좁게 등록했고 cookie 세션과 구분한다.

기존 unbound discard와 bind의 동시 실행에서 결속된 객체가 삭제될 수 있는 경로도
해결했다. 공통 object lock 아래 DB 상태를 다시 읽고 cleanup tombstone을 먼저 기록한다.
bind 승자의 사본은 유지하고 discard 승자 이후의 bind는 실패한다. 등록도 같은 key의
cleanup tombstone을 확인한다. 실제 PostgreSQL의 양방향 경합으로 검증했다.

### Native와 draft

ready 카드의 정확한 artifact 선택은 일반 chip과 보이는 요청문을 원래 신원·대화의
최신 draft에 넣는다. 자동 Send나 숨은 wrapper가 없다. 준비 중 작성문·첨부·대화 전환,
재시도 operation, 동명 충돌과 양방향 5개 제한 경합을 보존한다. 이미 진행 중인 Send가
끝나도 나중에 준비된 chip은 보내지 않은 draft에 남는다. 불명확한 Send 결과는 기존
saved-response 확인을 유지하고 자동 재전송하지 않는다. text-only 결과에 가짜 파일
성공/실패 카드를 만들지 않는다.

Native chip은 기존 신원·대화 device draft 아래 opaque upload 메타데이터로 reload 후
복원한다. 기존 24시간 local TTL과 logout clear를 따르지만 서버 객체의 만료는 아니다.
원래 assistant/model history 삭제 후 독립 사본은 남을 수 있다. 대화 삭제는 해당 대화의
메시지에 결속된 사본을 수거한다. 아직 미전송인 upload에는 conversation FK가 없으므로
대화 삭제만으로 일괄 수거를 보장하지 않는다. 명시적 첨부 제거와 계정 삭제의 기존
unbound cleanup을 재사용하며 별도 입력 다운로드나 공유는 추가하지 않았다.

## 로컬 검증

| 묶음 | 결과 |
| --- | --- |
| Core / formats / renderer / attachment / draft / lineage UI unit regression | 385 통과 |
| 최종 XLSX/Office/grid helper, 실제 renderer 경계 | 32 통과 |
| 기존 Core/XLSX/collector/tool policy regression | 170 통과 |
| 최종 SDK schema/collector/workbook revision | 68 통과 |
| Server contract: copy/versions/Native bearer/collector/Send/download/resend/DTO | 177 통과, 기존 TODO 1, 실패 0 |
| 전용 PostgreSQL guarded conversations lane | 331 통과, 실패 0 |
| Native transport/draft/history unit | 51 통과 |
| Native revision + 기존 composer/completion browser | 30 통과 |
| Native text-only browser | 1 통과 |
| Web card/revision/draft isolation/identity/attachment browser | 146 통과/2 비대상 제외 + fixture 보완 후 2 통과 |
| Mobile composer regression | 26 통과 |
| `npm run typecheck`, `npm run lint` | 통과 |
| `npm run build`, `npm run build:mobile-shell` | 통과 |
| Prisma validate/generate, pricing/accent/enum checks | 통과 |
| Capacitor local bundle / Native token boundary | 통과: remote server 0, token boundary 70 files |

이 표의 focused 실행은 서로 중복되므로 합산한 전체 테스트 수로 보고하지 않는다.
기존 TXT/MD의 잘못된 도구 호출 안내 TODO 1개는 유지한다. 올바른 `create_document`의
실제 TXT/MD 생성과 P0의 두 차례 수정 경로는 유지한다.

Web의 새 업로드 경합 fixture에 빠진 일반 업로드 mock을 추가하고 준비 chip을 기다린
뒤 지연한 upload finalize를 풀도록 보완했다. 최초 전체 묶음의 나머지 146건은 통과했고,
보완한 경합은 desktop/mobile 두 건 모두 다시 통과했다. 여섯 번째 chip이 생기지 않고
사용되지 않은 upload만 정리되는지 확인했다. Native에서도 별도 양방향 경합을 검사했다.
모바일 composer의 기존 회귀는 첨부 5개, 좁은 화면, 한국어 IME, keyboard/rotation과
200% text/page scaling을 포함한다.

DB는 별도 PostgreSQL 17 cluster의 loopback 테스트 DB만 사용했다.
`npm run test:db:integration`의 대상 검사를 통과하고 전체 migration history와 schema
drift를 검사했다. 초기 runner의 mocked suite 배치와 fixture의 필수 title 누락을 고친
뒤 전체 conversations lane 257+18+4+15+37건이 모두 통과했다. 원본 hash·권한·잠금·
source 삭제·snapshot 수명·계정 export/삭제·멱등성·경합·rollback·cleanup을 검사했다.
검증 후 전용 PostgreSQL을 중지했다. 운영 migration은 실행하지 않았다.

독립 checkout으로 P0 분석 환경의 누락 의존성을 피했다. officeparser 설치 시
Node 22.22.2/선언 engine 22.23.4 차이 경고가 있지만 실제 worker 검사는 통과했다.
웹 빌드에는 기존 dynamic filesystem tracing 관련 Turbopack warning 12개가 있다.
lint는 큰 ChatPageClient의 Babel 안내 외 실패가 없었다.

storage/provider는 로컬 adapter fixture다. 실제 XLSX writer와 Office parser 결과는
검사했지만 유료/실모델 품질, 실제 Excel/Word/PowerPoint 앱 호환성, 물리 Native 기기,
운영 storage I/O를 실측한 결과는 아니다. turn 5개·전체 이력 30개·파일 10MiB·전체
25MiB·추출 텍스트 300,000자와 기존 token/reservation/settlement를 유지한다. Send의
overflow는 최종 provider 전 거절하지만 앞선 Auto 비용까지 0임을 뜻하지 않는다.

## 독립 검토와 배포 상태

완성 commit에 대해 저장소 검토 서버에 `r-20261114-145625-cf7a02`를 한 번 요청했다.
migration·사본 접근/삭제·Native 인증 경계를 포함하며 두 독립 공급사가 배정됐다.
서버의 공식 결과는 **unknown (`no_verdict_block` 두 건)** 이다. 한 검토자는 원문에
accept와 blocker/major 없음이라고 썼지만 최종 protocol 판정 블록이 없었고, 다른
검토자도 최종 판정을 내지 않았다. 따라서 이를 accept로 보고하지 않는다.
`tools/review-orchestrator/README.md`의 unknown 재요청 금지에 따라 다시 submit하지
않았다. 재요청 여부는 운영자 결정으로 남긴다.
검토 후 변경은 위 browser fixture 두 줄과 이 검증 기록이며 접근·삭제 경계는 동일하다.

PR 생성·push·CI 시작/재실행·merge·deploy·운영 활성화·유료 모델 실행·AMUX 변경은
수행하지 않았다. 다음 검증 우선순위는 검토 unknown 처리, 승인된 실모델과 Office 앱/
물리 기기 확인이다. 범용 workbook 구조 편집·다른 포맷의 canonical round-trip,
PDF/ZIP 편집·WYSIWYG·이미지 workspace 변경은 별도 범위다.
