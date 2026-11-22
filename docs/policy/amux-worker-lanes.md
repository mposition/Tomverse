# AMUX worker — 서버의 코딩 에이전트 CLI

이 문서는 AMUX로 Tomverse를 개발하는 **기본 구조**다. AMUX 실행 방식을 바꾸거나 새 실행 경로를
제안하기 전에 이 문서를 먼저 읽는다. 여기 적힌 구조와 다른 길을 만들려면 운영자가 대화에서 이 문서를
바꾸라고 해야 한다.

## 0. 운영자 결정 (2026-11-18, 대화)

채팅 원문:

- "제가 원하는건 지금 제가 글을 적고 있는 Claude CLI같은 코딩 에이전트들이 Tomverse 개발 전용으로
  서버에서 작동된다고 생각하시면 됩니다. 작업도 Composer가 아니라 데이터베이스에 있는 백로그에서
  가져오는거구요."
- "AMUX는 기존대로 써 주셔야됩니다. 옛 AMUX층을 쓰라는게 아니구요. AMUX의 워커들을 코딩 에이전트
  CLI처럼 쓰라는겁니다."
- "다른 코딩 에이전트들처럼 질문이 나오면 운영자에게 보내는게 아니라 DM에게 보내는 구조일겁니다."
- "한 카드를 프로세스하고 나서 다음 카드가 뭐가 될수 있는지를 위한 점수제는 유지해주셔야 됩니다."
- "기존 Tomverse AMUX 자동화 프로세스를 최대한 활용해주세요."
- "지금 운영자 계정 그대로 쓰시죠. … 해보고 추후 제한을 시도하는게 낫지 제한부터 걸기 시작하면 또 완성
  못할겁니다."
- "해당 설계 꼭 문서로 남겨주세요. 또 똑같은 이야기 하고 싶지 않아요."

이 결정으로 정한 것:

1. **실행 경로는 기존 Tomverse AMUX 자동화다.** 백로그·점수·자동 승격·worker 배정·실행·DM·검토 서버·CI
   자동 수정·게시까지 이미 있는 흐름을 그대로 쓴다. 새 실행 경로를 만들지 않는다.
2. **worker는 코딩 에이전트 CLI처럼 일한다.** 실행은 v22 로컬 CLI 흐름(운영자 결정 2026-11-15,
   `development-agent-orchestration.md` "v22 worker 실행: 로컬 CLI 흐름")이다. box의 sidecar가 worker의
   CLI(Claude Code, Codex, Cursor, Copilot, Antigravity)를 그 worker의 checkout에서 돌린다. 운영자가
   로컬에서 CLI를 쓰는 것과 같게, 우리가 만든 시간·크기·횟수 제한을 두지 않는다(아래 4절).
3. **일감은 앱 DB의 백로그에서 온다.** Composer나 사람이 붙여 넣는 지시가 아니다.
4. **다음 card는 점수로 고른다.** 포트폴리오 점수(3절)를 그대로 쓴다.
5. **worker의 질문은 DM이 받는다.** 운영자에게 가는 것은 되돌릴 수 없는 일뿐이다(2절).
6. **worker는 사람 승인 없이 도구를 쓴다**(운영자 승인 2026-11-18, "승인합니다").
7. **GitHub은 운영자 계정을 그대로 쓴다**(운영자 결정 2026-11-18). 제한은 먼저 돌려 본 뒤에 필요하면
   건다. main 병합과 production 배포는 여전히 사람이 한다. worker 지시가 그렇게 말하고, 기술적으로 막지는
   않는다.
8. **AMUX 자체 점검 card는 Tomverse 일감이 아니다.** amux 프로그램이 자기 CI·지연·불변식을 감지해 만든
   card(`autofix` 태그, `detector:*`)는 board에 두지 않는다.

## 1. 흐름

```text
앱 DB 백로그 (아이디어 → 계층 → Task, 포트폴리오 점수)
  │  자동 승격: 점수가 가장 높은 실행 가능한 Task를 todo로        (3절)
  ▼
claim: 배정 가능한 worker 하나에 card 하나                  (v22WorkerClaimService)
  │
  ▼
box: bridge → sidecar → worker CLI (worker checkout, develop 기준, 로컬 CLI 흐름)
  │  brief·DM 답·이전 결론·검토 지적은 .amux/context/ 파일로 받는다
  │  막히면: 결과 끝에 AMUX_OWNER_QUESTION → DM → 답이 오면 card가 다시 todo
  ▼
결과·patch 기록 → settle → 검토 서버(v52) → 게시(draft PR) → CI 자동 수정 → merge lane
  │
  ▼
다음 card (다시 점수로)
```

- PR은 develop으로만 연다. develop 병합은 merge lane과 DM 병합 권한(`amux-decision-maker.md` §0a 5항),
  main 병합과 배포는 사람이 한다.
- 인프라 실패(로그인 거부, 사용량 소진, 네트워크 등)는 card의 시도로 세지 않고 대기 후 다시 배정된다.
- worker CLI의 출력 검사는 보안상 의미 있는 것만 엄격하게 본다(운영자 지시 2026-11-21). 실패로 보는 것은 허용 밖 도구,
  하위 agent, 권한 모드 불일치, 결과 없음·깨진 결과, JSON이 아닌 줄이다. 처음 보는 이벤트·단계 종류는 이름과
  어떤 키에도 도구·명령·파일·경로·URL·권한을 뜻하는 말이 없으면 통과시키고, journal에 이름과 개수만 남긴다
  (`amux v22 unrecognized_events`, `lib/amux/cliStreamUnknownKind.mjs`). 같은 규칙을 v19 채널 검사와 검토 서버의
  Antigravity 검사에도 쓴다.

## 2. 질문은 DM에게

- worker는 판단이 필요하면 결과를 `AMUX_OWNER_QUESTION: {...}`으로 끝낸다. 그 run은 끝나고 card는 답을
  기다린다. 질문은 DM relay를 거쳐 DM에게 간다(`development-agent-orchestration.md`, v22 owner question).
- DM 승인자(`TOMVERSE_AMUX_DM_APPROVER`, 기본 켜짐)가 운영자 확인 없이 답을 적용한다. 답을 받은 card는
  todo로 돌아가고, 다음 run이 그 답을 context 파일로 받는다(`amux-decision-maker.md` §0a, §2).
- DM이 다루는 유형은 `decision`, `judgment`, `budget`, `credential`, `access`, `external`이다.
  `customer_outbound`와 되돌릴 수 없는 행위는 유형과 관계없이 운영자에게 간다(같은 정책 §0-1).
- 운영자에게 가는 것은 이 목록뿐이다: 실제 돈이 나가는 일, Tomverse 밖으로 나가는 게시·발송, 사용자
  데이터 삭제, 자격증명과 보안 경계, main 병합과 production 배포, 자율 에이전트에게 새 권한을 주는 일.

## 3. 다음 card를 고르는 점수 (유지)

포트폴리오 점수 v1(`lib/amux/portfolioScoreCore.ts`, 운영자 승인 2026-10-05, `amux-intake.md`)을 그대로
쓴다. 각 평가는 0~5이고, 합계는 다음과 같다.

| 항목 | 배점 |
|---|---|
| Initiative 가치 | ×4 (최대 20) |
| Epic 가치 | ×3 (최대 15) |
| Feature 가치 | ×2 (최대 10) |
| Story 영향 | ×2 (최대 10). Story가 없는 Task는 이 몫을 Task 기여로 옮긴다 |
| Task 기여 | ×4 (Story 없으면 ×6) |
| 긴급성 | ×2 (최대 10) |
| 의존성 해소 | ×1 (최대 5) |
| worker 적합도 | ×1 (최대 5) |
| 예상 노력 | −×2 |
| 실행 위험 | −×1 |
| 불확실성 | high −10, medium −5 |

- 입력이 그대로인 점수는 시스템이 활성 기간을 연장한다(항상 켜짐, 2026-11-16).
- card 하나가 끝나면 자동 승격이 의존 관계가 풀렸고 점수가 유효한 Task 중 합계가 가장 높은 것을 다음
  card로 올린다. 점수 계산은 결정적 코드이고, 모델의 평가는 근거와 함께 제안된 입력일 뿐이다.

## 4. 제한 정리 (운영자 지시 2026-11-18)

운영자가 남은 제한 네 가지를 없애라고 했다.

| 제한 | 지금 |
|---|---|
| 살아 있다는 신호가 3시간 없으면 실행을 끊음 | 없앴다. 실행은 CLI가 끝나거나 운영자가 멈출 때만 끝난다. 마지막 진행 시각은 worker 건강 신호(`run_progress`)로 남긴다 |
| 같은 결과 실패 3번이면 사람·DM에게 넘김, 30번 폭주 방지선 | 없앤다. 결과 실패는 대기 후 다시 배정된다. 유료 재시도의 자기 한도는 실제 돈이라 남는다 |
| transaction마다 DB call 수 상한 | 없앴다. 선언한 call 수는 시간 예산 계산에만 쓰고, 최악의 계획이 route보다 길면 남은 시간 안에서 돈다 |
| patch 4 MiB, 한 번의 전송 32 MiB | 없앴다. 결과 방향은 #4077(조각 전송, DB CHECK, 게시 단계, 승인 digest v2), 내려가는 방향(재개 context, DM 증거)과 sidecar의 표시 4 MiB·메모리 32 MiB는 #4089에서 같은 조각 기법으로 없앴다(`docs/policy/amux-v22-result-transfer.md` 9·10절). 남는 것은 외부 한계뿐이다 |

## 5. 2026-11-18에 확인한 것

1. **기존 흐름이 2026-11-16부터 card 결과를 하나도 기록하지 못했다.** settle의 최악 계획(80 call,
   24,200 ms)이 route 예산(24,000 ms)보다 길어 시작 전에 거절됐다. 2026-11-18에 고쳤다(4절 세 번째 줄).
2. **box의 tmux worker lane은 이 흐름의 실행자가 아니다.** amux-server의 tmux 세션들은 board 알림을
   지시로 받지 않거나(`claude-impl`), 대화 상자에서 멈춰 있었다(`codex-impl`, `copilot-worker`).
   Tomverse card는 v22 bridge·sidecar로 실행된다.
3. **board가 amux 자체 점검 card로 차 있었다.** 252장을 모두 은퇴·보관했다(되돌리기는 `unarchive`,
   목록은 box의 `~/.amux/archived-autofix-cards-20261118.txt`). autofix detector는
   `AMUX_AUTOFIX_SECS=0`으로 껐다. board hygiene가 만든 디스크 점검 card(`[disk] [reclaim]`)는 남아 있다.

## 6. 이 문서가 하지 않는 것

- DM 정책, 점수 v1, 승인 목록을 바꾸지 않는다. 그 문서들(`amux-decision-maker.md`, `amux-intake.md`)이
  정본이다.
- main 병합·배포·지출 권한을 새로 주지 않는다.
