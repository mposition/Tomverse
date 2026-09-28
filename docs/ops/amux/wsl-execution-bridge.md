# WSL execution bridge

상태: 코드 래치 `WSL_BRIDGE_CODE_LATCH`는 false다. 이 문서는 연결 계약이다. 활성화 승인 없이 runner를 켜지 않는다.

정책: `docs/policy/development-agent-orchestration.md` 버전 13.

## 방향

Tomverse가 카드, 추천, 승격, 승인, 실행 원장, 감사의 정본이다. 운영자 워크스테이션의 WSL이 그 정본에서 승인된 작업을 가져온다. Tomverse 서버는 워크스테이션으로 접속하지 않고, 워크스테이션은 새 외부 수신 포트를 열지 않는다.

Rust runtime과 BoardDriver는 같은 WSL 프로세스에 둔다. 클라우드 scheduler와 로컬 runner를 이 단계에서 서로 다른 프로세스로 나누지 않는다. Railway의 `tomverse-orchestrator`는 선택 루프로 남고, `TOMVERSE_AMUX_EXECUTE`는 이 계약의 활성화가 아니다.

## 로컬 실행

Bridge는 이미 실행 중인 로컬 AMUX 세션에만 작업을 넘긴다. 세션이 없으면 새로 만들지 않는다. Codex나 Claude 프로세스를 하나 더 띄우지 않는다.

전송은 `POST /api/sessions/<기존 세션>/send` 하나다. 본문은 `text`, `no_board: true`, `msg_id`만 가진다. `msg_id`는 Tomverse execution attempt id다. `/api/board`로 카드를 만들지 않는다.

로컬 응답에 `no_board_refused`가 있으면 그 전송은 배정이 아니다. 로컬 보드가 같은 작업의 카드를 만들려 한 것이므로 재전송하지 않고, Tomverse attempt를 완료로 정산하지 않는다.

로컬 전송이 2xx로 끝나도 작업은 끝나지 않았다. 완료는 worker 결과를 Tomverse에 정산했을 때다. 허용 결과는 `succeeded` → `review`, `failed` → `todo`, `blocked` → `blocked`뿐이다. `done`, 병합, 배포 승인은 결과가 아니다.

응답이 사라지면 같은 `msg_id`로 조회한 뒤에만 다음을 정한다. 조회가 기존 전송을 찾으면 다시 보내지 않는다. 조회 자체가 실패하면 새 배정을 멈춘다.

## 자격증명

Bridge 프로세스는 Tomverse 내부 API를 부르는 인증을 가질 수 있다. 그 값과 제품 DB 자격증명은 worker에게 넘기는 본문에 넣지 않는다. 이 변경이 강제하는 것은 그 본문 제외다. 환경변수를 비우는 것은 격리의 증거가 아니다. 프로세스, 파일시스템, 네트워크가 나뉘었다는 실측은 이 계약에 없고, 래치가 꺼져 있는 동안 그 실측을 활성화로 대체하지 않는다.

## 단절

로컬 AMUX에 닿지 않거나 WSL이 멈추면 새 배정을 하지 않는다. generation이 바뀌었거나 execution lease가 지난 결과는 거절한다.

## 활성화 전

`scripts/amux-wsl-bridge.mjs`는 래치가 false인 동안 소켓을 열지 않고 끝난다. 래치를 켜는 변경은 이 정책의 다음 버전이다.
