# Chat 기록 페이지네이션 복구 독립 검토 제한 승인 기록

- approvedBy: `mposition` (현재 작업 지시에서 Claude 독립 검토와 `--skip-preflight` 예외 승인)
- approvedAt: `2026-09-22` (Australia/Brisbane, 현재 작업 지시 기준)
- author: `codex`
- independentReviewer: `claude-code-max` (저장된 Claude Code Max 구독 CLI)
- task: [task.json](./task.json)

이 기록은 지정된 변경의 읽기 전용 교차 검토 준비 범위만 명시한다. 사용자 메시지의
전자서명, 검토 통과, 테스트 통과, 제품 출시, commit·push·PR 병합·배포 또는
실제 공급자 실행 승인이 아니다. 최초 작성 시점에는 package와 review를 아직
실행하지 않았고, 이후 Claude round 0은 `request_changes`를 남겼다. 이번 문서
보강은 그 verdict를 통과로 소급하거나 추가 권한을 부여하는 기록이 아니다.

검토 기준은 base commit `ad2b51622992c29056706c443d80bdba928336e1`이다.
검토 diff에는 [task](./task.json)의 `writableScope`에 열거된 열여섯 제품·테스트
파일과 이 패키지의 `task.json`·`authorization.md`를 포함한다. 생성될
`docs/ops/cross-review/packages/chat-history-pagination-recovery-v1/records/`만
package 명령의 동일한 exact `--out` 및 `--diff-exclude` 경로로 제외한다.
`records/`를 `generatedPaths`에 다시 선언하지 않으며, source/test 파일이나
상위 패키지 디렉터리를 제외하지 않는다. 범위 밖 변경이 있거나 검사에 실패하면
검토를 진행하지 않는다.

`tests/e2e/support/app-fixtures.ts`는 공용 conversation GET
fixture가 실제 API의 필수 `messagePage`를 빠뜨려 기존
`model-change-send-barrier.spec.ts` 7건이 새 첫 페이지 검증에서 실패한 것을
바로잡는 최소 정합성 수정이다. 제품 API 계약을 완화하거나 첫 페이지 검증을
우회하는 변경이 아니다. 추가된 두 spec인
`tests/e2e/chat-markdown-theme.spec.ts`와
`tests/e2e/conversation-draft-isolation.spec.ts`도 동일한 필수 필드를 빠뜨린
독립 conversation detail GET fixture만 정합화한다. 검토자는 이 두 회귀와
cached revisit·model-change·loading golden의 재실행, pending/failed 표시 구분,
저장 완료됐으나 답변이 없는 Message의 복구 disposition을 확인한다.
Claude round 1에서 추가로 지적된 `tests/e2e/chat-send-history-race.spec.ts`도
독립 conversation detail GET fixture에 필수 `messagePage`가 빠져 있어, 검토
범위에 정확한 그 테스트 파일을 추가했다. 이 fixture의 최소 정합성 수정은 제품
첫 페이지의 fail-closed 검증을 약화하지 않는다.
그 disposition에는 7개 locale의 정확한 안내를 포함한다. durable Message 저장이
성공했지만 동시 최신 run에 밀려 답변 dispatch가 시작되지 않았을 때 기존
`sendPreparationChanged`의 '다시 보내라' 안내는 중복 Message를 만들 수 있으므로,
재전송을 지시하지 않고 reload 후 저장·답변 상태를 확인하도록 안내하는 범위에
한정한다.

Claude는 원 요구사항과 변경 diff를 먼저 읽고 작성자 설명·검증 기록을 그 뒤에
읽는다. 사용자가 승인한 `--skip-preflight`는 읽기 도구만 허용된 Claude child에서
쓰기 거부 probe를 입증할 수 없는 이번 검토에 한한 예외이며, preflight 통과나
쓰기 불가능성의 증거가 아니다. `--review-despite-check-failures` 또는 실패한
검사 우회는 허용하지 않는다. Claude child는 `--print --safe-mode
--output-format json --tools Read,Grep,Glob --allowedTools Read,Grep,Glob
--strict-mcp-config`의 읽기 전용 제한을 유지하고 shell·write 도구, 추가 MCP
접근과 모델 override를 받지 않는다.

Claude Code Max의 저장된 `claude.ai` 로그인만 사용한다. Review child에서
`ANTHROPIC_*`, `CLAUDE_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` 및
Bedrock/Vertex/Foundry 전환 변수를 제거하고, 로그인 확인에 실패하면 중단한다.
Anthropic API 또는 API key fallback은 금지한다. 이 제한은 parent 환경이나
영구 설정을 바꾸라는 지시가 아니다.

검토는 후속 페이지 503·malformed 첫 200 응답·cached revisit·in-flight remount,
Review model-only 경합, draft 보존·retry와 숨겨진 전송 부재를 독립적으로 확인한다.
실제 provider 또는 R2 호출, 유료 실행, Railway staging/production 접근,
feature flag 변경, 자동 또는 수동 push·merge·deploy는 이 승인에 포함되지 않는다.

## Round 0 수정본의 로컬 검증 (2026-09-22)

이 항목은 작성자가 로컬에서 직접 실행한 결과이며 독립 검토 verdict나 Linux CI
결과가 아니다. 검토자는 명령·환경과 변경 diff를 독립적으로 확인한다.

- 자체 conversation GET fixture 두 곳의 `messagePage` 누락은 수정 전 해당 두
  E2E 실패로 재현했고, 수정 후
  `npm run test:e2e:run -- --project=desktop-chromium tests/e2e/chat-markdown-theme.spec.ts tests/e2e/conversation-draft-isolation.spec.ts`
  는 13/13 통과했다.
- `npm run test:e2e:run -- --project=desktop-chromium --project=mobile-chromium tests/e2e/chat-unified-workspace.spec.ts --grep "cached transcript"`
  는 2/2 통과했다.
- `npm run test:e2e:run -- --project=desktop-chromium --project=mobile-chromium tests/e2e/model-change-send-barrier.spec.ts tests/e2e/chat-state-visual-regression.spec.ts --grep "Loading state|barrier"`
  는 13 통과·17 의도된 skip·4 실패였다. 네 실패 모두 Windows `-win32.png`
  Loading-state golden 파일이 저장소에 없어서 발생한 것으로, 픽셀 비교 결과가
  아니다. golden을 생성·갱신하지 않았으며 기존 일반 Loading 클래스는 원래
  값으로 유지했다. Linux CI에서 해당 golden 비교를 따로 확인해야 한다.
- pending history load 중 전송 버튼 비활성·거짓 오류 toast 없음, 실제 실패 후
  오류·재시도는 E2E로 확인했다. 두 parent 전송 guard는 `loadFailed`일 때만
  실패 toast를 표시한다.
- Review model-only 저장 POST를 보류한 사이 새 global Review turn을 시작하는
  경합에서, durable Message가 저장되었지만 답변 요청은 시작되지 않았음을
  확인했다. 새 정확한 안내 기대값은 수정 전 E2E에서 실패했고, 수정 후 통과했다.
  페이지 reload는 같은 대화의 저장 질문을 다시 보여주며 provider 자동 재전송은
  없었다.
- 최종 묶음
  `npm run test:e2e:run -- --project=desktop-chromium tests/e2e/chat-unified-workspace.spec.ts tests/e2e/chat-markdown-theme.spec.ts tests/e2e/conversation-draft-isolation.spec.ts tests/e2e/model-change-send-barrier.spec.ts`
  는 119 통과·1 기존 skip·0 실패였다. Mobile focused 실행
  `npm run test:e2e:run -- --project=mobile-chromium tests/e2e/chat-unified-workspace.spec.ts tests/e2e/model-change-send-barrier.spec.ts --grep 'mobile composer|failed later history page|Review model-only follow-up|Review question saved behind|model change send barrier'`
  은 6 통과·7 desktop-only skip·0 실패였다.
- `node --conditions=react-server --import tsx --test --test-concurrency=1 tests/chatStreamRuntime.test.mjs`
  는 21/21 통과, `npm run build`(TypeScript 포함)와 `npm run typecheck`,
  변경된 15개 source/test/locale 파일의 `npm run lint -- <15 paths>`,
  `git diff HEAD --check`는 모두 exit 0이다. 전체 779파일 unit suite는 이
  최종 수정본에서 실행하지 않았으며 통과로 주장하지 않는다.

## Round 1 독립 검토 후속 (2026-09-22)

[round 1 verdict](./records/verdict-round1.json)는 `request_changes`와 지적 3건을
남겼다. 이는 위의 Round 0 수정본 로컬 검증을 취소하거나 새 수정본의 검증
통과를 뜻하지 않는다.

1. `chat-send-history-race.spec.ts`의 독립 conversation detail GET fixture에는
   실제 API의 필수 `messagePage`가 빠져 있다. Claude가 예측한 새 Chat 첫 전송
   E2E 실패는 fixture 수정 전 이 Windows 최종 build에서 2/2 통과해 재현되지
   않았다. 새 전송이 늦은 GET보다 먼저 runtime revision을 선점한 경로다. 따라서
   이 파일의 `messagePage` 한 줄 보강은 재현된 실패의 수정이 아니라 실제 API
   형식과의 정합성 수정이며, 범위에 포함해 두 경합 테스트를 다시 확인한다.
2. 이전 계정의 model-only Message POST가 계정 전환 뒤 끝날 때
   saved-but-unanswered toast가 새 계정 화면에 나타날 수 있다. 현재 identity와
   owner key를 전송 후에도 대조하고, 해당 계정 전환 경합을 브라우저로 검증한다.
3. 이전 로컬 검증의 Windows Loading-state 4건 실패는 `-win32.png` golden
   부재였으므로 픽셀 비교 증거가 아니다. 정본 Linux runner에서 golden 갱신
   없이 Loading-state desktop/mobile 비교를 수행하고, cached revisit 및
   model-change의 desktop/mobile 회귀도 함께 확인한다.

이 항목은 수정 계획과 남은 증거의 한계를 기록한다. 새 source/test 수정,
Linux visual 비교, mobile 전체 회귀, 다음 Claude verdict의 결과를 여기서
선행 성공으로 주장하지 않는다. `records/`의 기존 review 결과는 변경하지 않는다.

## Round 1 수정본의 최종 로컬 검증 (2026-09-22)

아래 결과는 Windows 로컬 실행이며 새 독립 verdict나 정본 Linux visual 증거가
아니다. 검토자는 명령 범위와 실제 diff를 별도로 대조해야 한다.

- desktop Chromium의 다섯 관련 spec은 **123 pass · 1 existing skip · 0 fail**이다.
- mobile Chromium의 `chat-unified-workspace`, `model-change-send-barrier`,
  `chat-send-history-race` 세 spec은 **102 pass · 9 desktop-only skip · 0 fail**이다.
- guest→account identity transition의 A→B 및 A→B→A 경합은 수정 전 기대값이
  실패하는 red를 확인했고, 수정 후 desktop·mobile 합계 **12/12 pass**로 green을
  확인했다. 이전 identity의 saved-but-unanswered toast가 새 identity에 나타나지
  않는 경계를 포함한다.
- `chat-send-history-race`는 fixture 수정 전에도 Windows 최종 build에서 **2/2
  pass**여서 Claude가 예측한 실패는 재현되지 않았다. 새 Chat 전송이 late GET보다
  먼저 revision을 선점한 결과이며, `messagePage` 추가는 실제 conversation detail
  API와 fixture를 맞추는 정합성 수정이다.
- runtime unit은 **21/21 pass**이고, typecheck·변경 범위 lint·diff check는 모두
  **exit 0**이다.
- 전체 `npm run test:unit`은 **exit 0**이다. server는 **10,109 tests =
  10,108 pass · 1 existing skip · 0 fail**, client는 **59/59 pass · 0 fail**이다.
- `ubuntu-24.04` 정본 runner의 Loading-state visual golden 비교는 아직
  **pending**이다. Windows의 golden 파일 부재와 위 기능 회귀 통과는 Linux 픽셀
  비교를 대신하지 않으며 snapshot을 갱신했다는 주장도 하지 않는다.
