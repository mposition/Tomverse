# Chat 완료 Message 메타데이터 영속 복구 독립 검토 기록

최종 제어 상태는 **`passed`**이며 Claude round 2에서 종결됐다. 최종 판정은
`approve`, finding은 0건이다. 이는 아래 동결 source와 digest에 대한 코드 검토
종결이며, Linux 통합 CI·병합·배포·운영 데이터 또는 실제 provider/R2 검증을
뜻하지 않는다.

## 라운드별 기록

| 라운드 | 검토 source | 변경 digest | Claude 판정 | finding | 제어 상태 |
| --- | --- | --- | --- | --- | --- |
| 0 | `3dce702c` | `sha256:3834f503…f29fb50` | `approve` | 4 | `awaiting_revision` |
| 1 | `9e29305c` | `sha256:d4c5e3d2…f3babad` | `approve` | 2 | `awaiting_revision` |
| 2 | `46bbc98d` | `sha256:2e0575a8…c550a5` | `approve` | 0 | `passed` |

결론이 `approve`여도 열린 finding이 있던 round 0·1은 제어 프로그램이 통과로
승격하지 않았다. 작성자가 새 commit에서 수정한 뒤 새 digest로 재검토했다.
round 2는 이전 지적이 모두 닫히고 새 finding이 없어 `passed`로 종결됐다.

## 검토 범위와 마지막 증거

검토 대상은 완료된 일반 Chat `ChatResponseAttempt`의 POST 재연결과 GET polling이
대화 조회와 같은 공개 allowlist의 canonical assistant Message를 복구하는 변경이다.
검색 citation, 생성 artifact, 양수인 Memory·profile knowledge 사용 표시를
복원하되 object key·provider 내부 상태·attempt owner·lease·fingerprint는 노출하지
않는다. 잘못 결속되거나 누락된 완료 Message는 성공으로 추정하지 않고 provider를
재호출하지 않는다. Deep Research는 별도 persisted async-job 계약을 유지한다.

round 2 package는 다음을 같은 commit에서 실제 실행해 통과로 기록했다.

- 관련 client·server-order·attempt route·durable POST liveness와 전체 server
  contract를 `&&`로 묶은 단일 test command: 집중 **57/57**, 전체 **609/609**,
  실패·취소·skip·todo 0
- typecheck, production build, 수정 파일 ESLint, API cache-control,
  unconsumed response body, encoding, 문서 참조, 정책 절 참조, diff whitespace의
  guard 9개: 실패 0
- 별도 로컬 비정식 browser 근거: 설치된 system Chrome 핵심 시나리오 **2/2**.
  Playwright 고정 Chromium이 아니므로 Linux canonical/golden 증거로 승격하지 않는다.

## 독립 검토 실행 경계

모든 라운드는 author `codex`, reviewer `claude`로 실행했다. 사용자는 이 작업의
최초 검토와 최대 두 수정 검토에 한해 `--skip-preflight` 예외를 명시적으로
허용했다. 그 예외는 각 verdict의 `overrides`에 기록되어 있다. Claude에는
Read·Grep·Glob만 허용했고 `ANTHROPIC_API_KEY`를 child 환경에서 제거한 뒤 저장된
`claude.ai` 구독 로그인을 확인했다. 세 검토의 web search/fetch 요청은 0이며,
source 수정·provider/R2/Railway 호출·유료 benchmark·push·merge·deploy 권한은
검토자에게 주지 않았다.

## 파일의 의미

`exchange.json`은 세 라운드의 제어 프로그램 replay다. `package-round*.json`은
각 commit·digest·전체 diff·테스트와 guard 결과를, `verdict-round*.json`은 Claude
판정을, `review-round*.events.jsonl`은 읽기 전용 실행 event를 보존한다. 이
디렉터리의 사본은 round 2 검토가 끝난 뒤 영구 보존을 위해 추가한 기록이며 검토
대상 source digest에는 포함되지 않는다. package JSON 안에 전체 diff가 있으므로
중복 `change*.diff`와 `review-prompt.md`는 영구 추적 사본에서 제외했다.

다음 순서는 PR·Linux 통합 CI, 병합·배포 뒤 무과금 staging canonical Message
readback, Prompt Refiner 제안형 UI 계약, 별도 비용 승인 뒤 전체 모델 Router 품질
측정이다. 현재 전체 웹 Chat 계획 추정은 약 65%, 주관적 범위 55–75%이며 이번
검토 안정화로 추가 percentage point를 중복 계산하지 않는다.

2026-09-14 최초 PR Linux CI에서 기존 Memory source-contract 테스트가 공유
allowlist 도입을 이해하지 못한 실패 1건이 확인됐다. 후속 수정과 독립 검토는
동결된 이 기능 검토를 다시 쓰지 않고 별도
`chat-durable-message-metadata-recovery-ci-v1/` 및 `-ci-v2/` 기록으로 보존한다.
