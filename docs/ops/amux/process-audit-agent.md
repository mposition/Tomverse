# AMUX 프로세스 분석 정기 Agent

운영자 요청 2026-11-14: 2026-11-14 AMUX 전 과정 분석 보고서와 같은 분석이 정해진 주기로 돌고, 결과가 Admin ›
실행 보드 › 프로세스 분석(`/admin/amux-execution?tab=process-audit`, owner 전용)에 보이게 합니다.

## 어떻게 도는가

- **수치**는 앱이 결정적 SQL로 모읍니다(`lib/amuxProcessAuditStore.ts`의 `readProcessAuditMetrics`). 대상 기간은
  최근 14일입니다.
  - Task 생성·done·보관, 살아 있는 Task 상태, backlog를 막는 의존 카드
  - 예산을 다 쓴 todo, 일별 시도 수, 시도가 끝난 사유와 다음 시도까지 걸린 시간
  - escalation 사유·해결 시간, 열린 escalation, v52 검토 결과, v22 결과 검토, DM 요청 경로
  - 엔지니어링 run, 사람의 AMUX·엔지니어링 Admin 조작, 감사 로그 양
  - 읽기 전용 트랜잭션에서 집계 수치와 카드 표시 번호만 읽습니다. 카드 제목·본문, 이메일, 사람이 쓴 글은 읽지 않습니다.
- **해석·순위·제안**은 AMUX 박스의 Codex CLI 한 번으로 만듭니다(`scripts/amux-process-audit-runner.mjs`).
  - 정액 구독에 로그인된 CLI이고, API 키를 쓰지 않으므로 유료 호출이 아닙니다.
  - runner가 직접 관리하는 공개 저장소 clone을 `origin/develop`에 맞춘 뒤, 그 안에서 `--sandbox read-only`로 돌아 파일:줄을 인용합니다.
  - 웹검색은 끄고, 답은 `--output-schema`의 구조화된 JSON으로 받습니다.
- 앱은 모델의 글을 저장하기 전에 비밀값처럼 보이는 문자열과 이메일을 `[가림]`으로 바꿉니다(`maskProcessAuditText`).
  - 화면은 react-markdown으로 그리며, raw HTML과 링크는 렌더링하지 않습니다.
- **주기:** 박스의 user timer는 1시간마다 `POST /api/internal/amux-process-audit/context`로 "할 차례인지"만 묻습니다.
  - 차례가 아니면 앱은 아무것도 쓰지 않습니다.
  - 차례를 판단하는 기준은 Admin의 정기 실행 스위치(기본 꺼짐)와 주기(기본 7일, 1~30일)입니다.
  - "지금 실행"을 누르면 스위치가 꺼져 있어도 다음 확인 때 한 번 돕니다.
- **저장:** 보고서는 `AmuxProcessAuditReport`에 저장하고, 26주가 지난 행은 새 보고서를 저장할 때 같은 트랜잭션에서 지웁니다.
  - 지난 보고서의 결론(상위 항목, 바뀐 것)은 다음 실행의 입력이 되어 "지난 보고서 대비"를 만듭니다.
- **감사:** 운영자의 설정 변경(스위치, 주기, 지금 실행)은 `amux.process_audit.settings_changed` 감사 항목 하나로 기록됩니다.
  - 이 항목은 저장과 같은 트랜잭션에서 남깁니다.
  - 보고서 수신은 관측 기록이라 감사 체인에 넣지 않습니다.

## 비용

- 실제 지출은 없습니다. Codex 구독 한도를 AMUX 워커, 마케팅 생성기와 함께 씁니다.
- 실행 하나의 길이는 45분에서 끊습니다. 결과를 저장하지 못한 claim은 3시간 뒤 풀리고, 다음 확인 때 다시 시도합니다.
- 비교한 다른 경로는 Railway Agents의 유료 API 호출입니다. 이 경로는 쓰지 않습니다.
  - 파일:줄 인용을 하려면 모델이 코드를 읽어야 하고, 그러려면 도구 루프와 큰 입력이 필요합니다.
  - 2026-11-14 보고서 규모(코드 수십 파일)를 API로 읽으면 실행당 수십만 입력 토큰입니다.
  - 추정으로 실행당 US$1~5, 주 1회면 월 US$4~20입니다.
  - 이 경로를 만들려면 새 지출 adapter·ledger 연결과 운영자의 지출 승인이 필요해서 택하지 않았습니다.

## 설치 (운영자, 박스의 `tommy`)

전제는 두 가지입니다.
- 이 기능이 main에 있고 앱에 배포되어 있어야 합니다(migration 포함).
- 앱 Railway `Tomverse` › production에 `AMUX_PROCESS_AUDIT_SECRET`(32자 이상, 다른 서비스와 공유하지 않는 새 값)이 있어야 합니다.
  - 이 변수가 없으면 두 내부 route는 404입니다.
  - **비밀값 배치는 운영자 몫입니다.** 대화나 로그에 붙이지 않습니다.

1. 로컬 PC의 main checkout에서 번들을 만들어 박스에 올립니다.

   ```bash
   npm run build:amux-process-audit-box
   ```

   ```bash
   ssh -o IdentitiesOnly=yes -i ~/.ssh/tomverse-migration-20261001 tommy@192.168.0.7 "mkdir -p ~/.local/lib/tomverse-amux-process-audit ~/.config/tomverse-amux-process-audit ~/.local/share/tomverse-amux-process-audit"
   ```

   ```bash
   scp -o IdentitiesOnly=yes -i ~/.ssh/tomverse-migration-20261001 .next/amux-process-audit-box/amux-process-audit-runner.mjs tommy@192.168.0.7:.local/lib/tomverse-amux-process-audit/
   ```

2. 환경 파일을 만듭니다. 예시는 `scripts/systemd/tomverse-amux-process-audit.env.example`입니다.

   ```bash
   install -m 600 /dev/null ~/.config/tomverse-amux-process-audit/runner.env
   ```

3. 유닛을 설치합니다. `scripts/systemd/tomverse-amux-process-audit.service`와 `.timer`를 `~/.config/systemd/user/`에
   올린 뒤 실행합니다.

   ```bash
   systemctl --user daemon-reload
   ```

4. 한 번 돌려 봅니다. Admin에서 "지금 실행"을 누른 뒤 실행합니다.

   ```bash
   systemctl --user start tomverse-amux-process-audit.service
   ```

   ```bash
   journalctl --user -u tomverse-amux-process-audit.service -n 40 --no-pager
   ```

   - `amux_process_audit_stored`가 보이면 Admin 화면에 보고서가 생깁니다. 이 줄에는 토큰 수와 걸린 시간이 함께 찍힙니다.
   - `not_due`가 보이면 "지금 실행" 요청이 없는 상태입니다.

5. 괜찮으면 timer를 켜고, Admin에서 정기 실행을 켭니다.

   ```bash
   systemctl --user enable --now tomverse-amux-process-audit.timer
   ```

## 알려진 한계

- `runner.env`는 `tommy` 계정 파일입니다. CLI의 read-only sandbox는 홈 디렉터리를 읽을 수 있어서, 모델이 이 비밀값을 읽을 수 있습니다.
  - 이 비밀값으로 할 수 있는 일은 실행 claim과 보고서 저장뿐입니다.
  - 마케팅 생성기의 `generator.env`도 같은 한계를 가집니다.
- 모델이 수치를 잘못 옮길 수 있습니다. 원 수치는 보고서 행의 `metrics`에 앱이 직접 계산한 값으로 남습니다. runner가 보낸 값은 쓰지 않습니다.
- 박스가 꺼져 있던 기간의 실행은 나중에 메우지 않습니다. 켜진 뒤 첫 확인에서 차례가 지났으면 바로 돕니다.

## 끄기와 되돌리기

- Admin에서 정기 실행을 끄면 다음 확인부터 돌지 않습니다.
- 박스까지 멈추려면 timer를 끕니다.

  ```bash
  systemctl --user disable --now tomverse-amux-process-audit.timer
  ```

- 앱의 `AMUX_PROCESS_AUDIT_SECRET`을 지우면 두 route가 404가 되어 박스가 아무것도 받지 못합니다.

## 코드 갱신

설치 1번을 다시 하면 됩니다. 실행 중이 아닐 때 올립니다(`systemctl --user is-active tomverse-amux-process-audit.service`가
`inactive`). 박스는 main 병합으로 자동 갱신되지 않습니다.
