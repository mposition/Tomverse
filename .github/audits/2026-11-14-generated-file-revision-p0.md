# Generated file revision P0 — local implementation evidence

시작: 2026-11-14, 최종 검증: 2026-11-15, Australia/Brisbane. 로컬 구현·검증 기록이며 운영 활성화,
실모델 품질 또는 Office 앱 호환성 실측 보고가 아니다.

## 구현 범위

| 단계 | 구현한 행동 |
| --- | --- |
| P0-A | 정확히 클릭한 ready artifact를 별도 입력 사본으로 준비하고, 원래 신원·대화의 최신 초안 앞에 보이는 수정 요청문과 첨부 chip을 함께 넣는다. 명시적 Send 후 기존 생성 도구로 새 파일을 만들며 원본과 새 결과를 유지한다. |
| P0-B | DOCX/PPTX에서 기존 parser가 추출한 text layer로 새 문서를 만든다. 준비의 nonempty/strict 검사와 Send의 실제 남은 추출 예산 검사를 적용한다. |

지원: TXT/MD, 기존 생성·첨부 허용 목록의 text/code/config 교집합, 한도 내 CSV,
DOCX/PPTX. XLSX 셀 구조 보존, PDF/ZIP 편집, canonical spec·version tree·migration,
WYSIWYG, Native 수정 CTA, 이미지 workspace는 포함하지 않는다. 기존 Native 다운로드는
변경하지 않았다. Office의 서식·이미지·슬라이드 구조 보존을 약속하지 않는다.

`GENERATED_ARTIFACT_REVISION_ENABLED`는 기본 꺼짐이다. 브라우저 검증은 기존
loopback E2E fixture에서만 cookie로 진입을 열었다. 운영 flag나 설정은 변경하지 않았다.
최신 사용자 turn의 Office 공통 strict overflow 검사는 연결 flag와 별개이며, 일반 Office
첨부와 그 turn의 archive 내부 Office에도 적용된다. 과거 Office의 기존 축약 처리는 유지한다.
Auto가 먼저 실행될 수 있으므로 overflow 거부를 Auto 비용 0으로 표현하지 않는다.

## 경계와 수명

- 서버가 owner·동일 conversation·현재 unlock·ready·형식·측정 크기를 검사한다.
  원본은 비파괴 bounded read로 읽고 별도의 private input key를 만든다.
- 기존 `PUT /api/chat`, upload 등록·bind·draft·create 도구를 재사용한다. 선택은
  모델 호출이나 자동 전송이 아니다. 보이는 요청문이 그대로 저장·전달된다.
- 같은 operation은 opaque uploadId로 수렴한다. storage I/O는 짧은 DB transaction
  밖에서 수행한다. 실패/동시 패자의 random key만 기존 cleanup queue로 회수하며,
  원본이나 등록·결속된 승자는 삭제하지 않는다.
- 원래 assistant/model history를 지워도 독립 사용자 첨부 사본은 남을 수 있다.
  대화 삭제는 그 대화의 메시지에 결속된 사본을 수거한다. 미전송 upload에는
  conversation FK가 없어 대화 삭제가 모두 수거한다고 보장하지 않는다.
  명시적 draft 첨부 제거와 계정 삭제의 기존 unbound cleanup을 사용한다.
- turn 5개 / 전체 이력 30개 / 파일 10MiB / 전체 25MiB / 추출 text 300,000자 상한을
  유지한다. 생성 한도와 입력 한도는 다르며, 무제한 반복 수정은 보장하지 않는다.
- 원본 artifact ID는 앱 선택에만 사용한다. 모델에는 기존 request-scoped attachment
  handle을 제공하고 objectKey·storage URL·bytes를 DTO나 새 로그로 노출하지 않는다.
  별도 provenance schema, `sourceAttachmentId` 오용, 숨은 providerContext metadata는 없다.

## 검증

| 묶음 | 결과 |
| --- | --- |
| Unit / renderer / formats / attachment / draft / lifecycle | 328 통과 |
| Server contract: copy API, collector, Send, download, resend, unavailable/repeated attachment | 152 통과, 기존 TODO 1, 실패 0 |
| PostgreSQL: 새 사본, 기존 artifact/attachment/availability/resend, import lifecycle | 111 통과 |
| 기존 card / draft isolation / identity / attachment persistence browser | 119 통과, 비대상 1 제외 |
| 새 revision browser (desktop/mobile) | 19 통과, desktop-only 대화 전환 1 제외 |
| Mobile composer: 첨부 5개·320px·IME·200% text/page scaling | 26 통과 |
| `npm run lint` | 통과 (대형 ChatPageClient의 Babel 안내만 있음) |
| `npm run typecheck` | 로컬 프로세스 heap 8GB로 통과 |
| `npm run build` | 통과 (기존 파일 추적 범위 관련 Turbopack warning 12개) |

브라우저는 기존 전체 묶음에서 fixture 재진입·계정 복귀 설정 문제를 발견해 테스트만
고쳤고, 최종 새 revision 묶음을 재실행했다. 준비 중 5개 제한·cleanup, source와 무관한
opaque uploadId, 원문 그대로 Send, 계정/대화 격리, 새 document에서 draft 복원,
provider 실패 중 작성한 새 초안 보존, 두 차례 명시적 Send와 원본+새 카드 유지를 확인했다.

실제 writer/parser fixture로 TXT/MD/JSON/Python/CSV/DOCX/PPTX를 두 차례 수정하여
새 파일 내용과 원본 hash 불변을 확인했다. text-only 응답에는 가짜 failed 카드를
만들지 않는다. 이는 결정적인 도구 fixture이며 실모델이 올바른 도구·내용을 선택한다는
품질 측정이 아니다. R2와 provider는 로컬 adapter fixture이며 운영 storage I/O,
유료 모델 실행과 실제 Word/PowerPoint 열기는 수행하지 않았다.
기존 TODO 1개는 TXT/MD를 잘못된 `create_text_file` 도구로 호출했을 때 올바른
`create_document`를 더 명확히 안내하는 보완이다. 올바른 기존 도구의 TXT/MD
실파일 생성과 두 차례 재작성은 실제 renderer로 검증했다.

DB는 별도 로컬 PostgreSQL 17의 테스트 전용 DB만 사용했다. 기존
`npm run test:db:integration`의 대상 검사를 통과하고 migration 전체와 schema drift를
검사했다. 최초 conversations 묶음은 251 통과/6 실패였으며, initdb가 상속한 Brisbane
시간대 때문에 raw NOW()와 UTC timestamp 만료 비교가 어긋났다. 테스트 DB만 UTC로
맞춘 후 실패한 import lifecycle을 포함한 위 111개가 모두 통과했다. 운영 DB는 사용하지
않았고, 검증 후 해당 테스트 PostgreSQL은 중지했다.

기본 Node heap 4GB의 타입 검사 OOM은 환경 실패로 구분했다. 독립 worktree에서
lockfile 기준 `npm ci`로 설치하여 `pdf-lib` 누락을 해결했다. 원래 저장소 의존성은
변경하지 않았다. officeparser의 설치 시 Node engine 경고는 남지만 실제 worker의
DOCX/PPTX strict 추출·overflow·재작성 검사는 통과했다.

## 독립 검토와 상태

기준 main: `c8cb7c62e192814b8522786a8749d38769073661`. 요청에 지정된
`6f61c0c8dd35a58b2ae8f459c7703c515215f716` 이후 diff는 `.railway/agent-runners.ts`
한 파일이었으며 이번 기능 경로는 동일했다. 별도 `codex/generated-file-revision-p0`
worktree에서 구현했고 기존 작업 폴더의 수정을 되돌리지 않았다.

검토 `r-20261114-134123-0bef06`: 구현 commit
`e9455410102f8183357e204c3e2683f1094706c9`에 대해 Anthropic·Google 두 검토자 모두
accept. blocker/major 없음. 일반 최신 Office strict 검사의 공통 적용은 의도된 변경으로
문서화했다. 첨부 5개 상수의 기존 중복은 작은 정리 후속이며 한도 자체를 바꾸지 않았다.
검토 후 추가 변경은 browser fixture·검증 기록이며 접근·삭제 경계는 동일하다.

PR 생성·push·merge·deploy·유료 모델 실행·운영 활성화·AMUX 변경은 수행하지 않았다.
다음 우선순위는 별도 승인 범위의 실모델/Office 앱 검증이고, P1은 XLSX 구조 보존과
영속 source/version 관계, Native 수정 선택이다.
