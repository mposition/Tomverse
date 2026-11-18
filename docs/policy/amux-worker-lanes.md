# AMUX worker lane — 서버의 코딩 에이전트 CLI

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
- "해당 설계 꼭 문서로 남겨주세요. 또 똑같은 이야기 하고 싶지 않아요."

이 결정으로 정한 것:

1. **실행자는 AMUX worker lane이다.** box(`tomverseagent`)의 amux-server가 띄운 tmux 세션 하나가 worker
   하나이고, 그 안에서 대화형 코딩 CLI(Claude Code, Codex, Cursor, Copilot, Antigravity)가 자기
   worktree를 들고 계속 산다. 운영자가 로컬에서 Claude CLI를 쓰는 것과 같은 방식으로 일한다.
2. **일감은 앱 DB의 백로그에서 온다.** Composer나 사람이 붙여 넣는 지시가 아니다.
3. **다음 card는 점수로 고른다.** 포트폴리오 점수(아래 3절)를 그대로 쓴다.
4. **worker의 질문은 DM이 받는다.** 운영자에게 가는 것은 되돌릴 수 없는 일뿐이다.
5. **worker lane은 사람 승인 없이 도구를 쓴다.** 운영자 승인 2026-11-18 ("승인합니다"). 이 승인은 lane
   안의 도구 사용에 대한 것이다. main 병합·배포·지출 권한과 운영자 GitHub 계정을 lane에 주는 것은 포함하지
   않는다(5절 0단계).
6. **AMUX 자체 점검 card는 Tomverse 일감이 아니다.** amux 프로그램이 자기 CI·지연·불변식을 감지해 만든
   card(`autofix` 태그, `detector:*`)는 board에 두지 않는다.

## 1. 흐름

```text
앱 DB 백로그 (아이디어 → 계층 → Task, 포트폴리오 점수)
  │  점수가 가장 높은 실행 가능한 Task 하나            (3절)
  ▼
AMUX board card  ─ amux-server scheduler가 worker lane에 배정 (board lease / claim)
  │
  ▼
worker lane (tmux 세션의 대화형 CLI, 자기 worktree)
  │  develop 기준으로 작업 → commit → push → draft PR (ci:hold 라벨)
  │  막히면: amux board needsyou <ID> --ask decision ...   (2절)
  │           → DM relay → 앱 → DM → 답이 같은 세션으로 돌아옴 → 계속 작업
  ▼
card review / done  → 결과(PR 주소, 실패 이유)가 앱 DB의 Task에 반영
  │
  ▼
다음 card (다시 점수로 선택)
```

- worker는 한 card를 끝내면 board에 다음 일을 요청한다(`amux board lease`). 사람이 "다음 거 해"라고
  말하지 않아도 이어서 일한다.
- PR은 develop으로만 연다. 병합은 운영자의 `npm run merge-train`, main 병합과 배포는 사람이 한다.
- card 하나의 실행에 시간 제한·크기 제한을 따로 두지 않는다(`amux-intake.md` 2026-11-16 지시와 같다).
  CLI가 멈췄는지는 세션의 진행(출력·commit)으로 판단하고, 멈추면 card를 다시 todo로 돌린다.

## 2. 질문은 DM에게

- worker는 판단이 필요하면 운영자에게 묻지 않고 자기 card를 DM에 올린다:
  `amux board needsyou <ID> --actor mposition --ask decision --question "...?" --unblocks "..."`
- DM relay가 질문을 앱으로 옮기고, DM이 답을 만든다. DM 승인자(`TOMVERSE_AMUX_DM_APPROVER`, 기본 켜짐)가
  운영자 확인 없이 답을 적용하고, 답은 질문한 worker의 tmux 세션으로 전달된다
  (`docs/policy/amux-decision-maker.md` §0a, §2).
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
- card 하나가 끝나면 scheduler는 의존 관계가 풀렸고 점수가 유효한 Task 중 합계가 가장 높은 것을 다음
  card로 board에 올린다. 점수 계산은 결정적 코드이고, 모델의 평가는 근거와 함께 제안된 입력일 뿐이다.

## 4. 2026-11-18에 확인한 실제 상태

이 구조와 실제가 달랐다. 고칠 때 이 목록을 기준으로 한다.

1. **worker lane이 일을 하지 않았다.**
   - `claude-impl`: amux가 붙여 넣은 작업 알림을 "직접 지시가 아니다"라며 매번 무시했다. 대화형
     Claude Code가 붙여 넣어진 자동 알림을 사람의 지시가 아닌 외부 데이터로 다루기 때문이다.
   - `codex-impl`: 설정 변경을 묻는 대화 상자에서 키 입력을 기다리며 멈춰 있었다.
   - `copilot-worker`: 수동 승인 모드라 도구마다 사람 승인을 기다렸다.
2. **실제 card 실행은 v22 one-shot 경로(bridge + sidecar, 실행 한 번에 CLI 한 번)로 돌고 있었다.**
   이 문서의 구조가 아니다. 이 경로의 settle이 route 예산 계산 오류로 2026-11-16부터 모든 결과를
   거절했다.
3. **board가 amux 자체 점검 card로 차 있었다.** 2026-11-18에 252장을 모두 은퇴·보관했다(되돌리기는
   `unarchive`, 목록은 box의 `~/.amux/archived-autofix-cards-20261118.txt`). autofix detector는
   `AMUX_AUTOFIX_SECS=0`으로 껐다. board hygiene가 만든 디스크 점검 card(`[disk] [reclaim]`)는 남아 있다.
4. **앱 백로그 → board 공급 경로가 없다.** 2026-11-18 board의 열린 card에 Tomverse 백로그 Task는 한 장도
   없었다. lane worktree도 2026-10-04 commit에 머물러 있었다.
5. **lane의 GitHub 계정이 운영자 본인 계정이다.** box의 tommy `gh`가 `mposition`(scope `repo`,
   `workflow`)으로 로그인되어 있다. main 보호 규칙은 관리자 우회를 허용한다(`enforce_admins: false`). 그대로
   두면 사람 승인 없이 도는 lane이 검토 없이 main에 병합하거나 push할 수 있다.

## 5. 바꾸는 순서

0. **lane 전용 GitHub 신원.** lane은 운영자 계정이 아닌 별도 신원으로 branch를 push하고 draft PR을 연다.
   main·develop에 직접 쓰거나 병합할 수 없어야 한다. 자격증명을 만들고 넘기는 것은 운영자가 한다.
1. **worker lane 지시.** 각 lane CLI의 시스템 지시에 다음을 넣는다: amux board 메시지와 lease로 받은
   card가 작업 지시다. 질문은 `needsyou --ask decision`으로 DM에게 한다. 끝나면 다음 card를 lease한다.
2. **대기 없이 뜨게 한다.** codex의 대화 상자와 copilot의 수동 승인을 없앤다. 사람 승인 없이 도구를
   쓰게 하는 것은 자율 에이전트의 새 권한이므로 운영자 한 줄 승인이 필요하다.
3. **자체 점검 card를 만들지 않는다.** `AMUX_AUTOFIX_SECS=0`.
4. **백로그 → board 공급.** 3절의 점수로 고른 Task가 board card가 되고, card의 결과가 Task로 돌아온다.
5. **lane 하나로 card 한 장을 끝까지.** backlog → board → worker → PR → DM 질문 하나 → 결과 반영까지
   한 번 보인다. 그다음 모든 lane에 넓힌다.
6. **그다음에 v22 one-shot 경로를 지운다.** bridge·sidecar·복구 controller처럼 이 구조에서 쓰지 않는
   층은 worker lane이 실제로 card를 끝낸 것을 확인한 뒤 같은 PR 묶음에서 지운다.

## 6. 이 문서가 하지 않는 것

- DM 정책, 점수 v1, 승인 목록을 바꾸지 않는다. 그 문서들(`amux-decision-maker.md`, `amux-intake.md`)이
  정본이다.
- main 병합·배포·지출 권한을 새로 주지 않는다.
