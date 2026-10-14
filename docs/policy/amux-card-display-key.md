# AMUX 카드 표시 번호

approvedBy: mposition · approvedAt: 2026-10-14 · policy version: 1

상태: **승인됨.** 운영자 `mposition`이 2026-10-14에 아래 결정 1~5를 내렸고, 같은 날
6~8의 세부 선택(PREFIX 저장 위치, Feature 없는 카드의 PREFIX, PREFIX 고유성)을
승인했다. 이 문서는 그 결정을 기록하는 독립 계약이며, `development-agent-orchestration.md`의
버전 번호를 쓰지 않는다. 그 문서와 `amux-intake.md`의 어떤 실행·승인·승격 계약도 바꾸지 않는다.

## 1. 왜

카드의 정본 식별자는 Task ID(`AmuxWorkItem.id`)다. 그러나 사람이 부르기 어렵고, 원천이 있는
카드는 `sourceKey`(대개 HMAC hex 또는 GUID)가 함께 보여 운영자가 두 식별자를 같은 카드의 것으로
알아보지 못한 일이 있었다. 표시 번호는 사람이 읽고 말하고 검색하는 이름이다. **Task ID를
대체하지 않는다** — API, 링크, 로그, 복구 기록, 승인 결속은 계속 Task ID를 쓴다.

## 2. 결정 (운영자 mposition, 2026-10-14)

1. 모든 `AmuxWorkItem`은 바뀌지 않는 표시 번호 `AMUX-<PREFIX>-<NNN>`을 갖는다. 예: GitHub 연계
   Feature의 첫 Task는 `AMUX-GITHUB-001`.
2. PREFIX는 Feature마다 하나이며, 그 Feature를 보고 agent 또는 등록 주체가 고른다. 운영자는
   입력하지 않는다. 짧은 대문자 코드로 2~16자, `A-Z`와 `0-9`만 쓴다.
3. 번호는 PREFIX마다 001부터 시작하고, 최소 3자리로 0을 채운다. 999 다음은 1000이다. 번호는
   재사용하지 않고 바꾸지 않는다. 카드가 보관·완료·취소되어도 그대로다.
4. 기존 카드에도 번호를 준다(backfill).
5. 카드 목록·상세·검색은 번호를 보여 주고 번호로 찾는다.
6. **PREFIX는 Feature 노드에 고정한다.** 한 번 정해진 Feature의 PREFIX는 바뀌지 않으며, 그
   Feature 아래 카드는 모두 그 PREFIX를 쓴다.
7. **Feature가 없는 카드는 등록 경로별 고정 PREFIX를 쓴다**(§4). 이 PREFIX는 예약되어 어느
   Feature도 쓸 수 없다.
8. **PREFIX는 Feature마다 고유하다.** 두 Feature가 같은 PREFIX를 가질 수 없으므로, 번호만 보고
   어느 Feature인지 알 수 있다. 이미 쓰인 PREFIX를 고른 등록은 다른 코드를 골라야 한다.

## 3. 형식과 불변식

- 번호 형식: `^AMUX-[A-Z0-9]{2,16}-(00[1-9]|0[1-9][0-9]|[1-9][0-9]{2,8})$`. 숫자 부분은 1 이상이며
  3자리 미만이면 0을 채우고, 3자리 이상이면 앞에 0을 붙이지 않는다. 상한은 9자리다.
- 카드의 번호 컬럼은 비어 있을 수 있다(backfill 전의 기존 카드). 한 번 값이 들어가면 바꾸거나
  비울 수 없고, DB가 이를 거부한다.
- 번호는 전역 고유이고 DB unique 제약이 이를 강제한다.
- PREFIX별 순번 카운터는 1씩만 증가하며 줄거나 삭제되지 않는다. 할당은 카드를 쓰는 트랜잭션
  안에서 카운터를 증가시키고 그 값을 같은 트랜잭션에서 카드에 쓴다. 트랜잭션이 실패하면
  카운터 증가도 함께 되돌아가므로 번호가 소비되지 않는다.
- Feature의 PREFIX 컬럼은 Feature 노드에서만 값을 가질 수 있고, 한 번 정해지면 바꾸거나 비울 수
  없으며, Feature 사이에 고유하고, §4의 예약 PREFIX를 쓸 수 없다.

## 4. 등록 경로별 고정 PREFIX

Feature가 없는 카드는 그 카드를 만든 경로의 PREFIX를 쓴다. 이 목록 밖의 경로가 생기면 이 문서를
먼저 개정한다.

| PREFIX | 경로 |
|---|---|
| `WORKBOARD` | 비공개 workboard import (`tomverse_private_workboard`) |
| `INTAKE` | 대화 intake (`codex-conversation`) |
| `LOCAL` | 로컬 agent intake (`local-agent-intake`) |
| `ENG` | engineering agent 등록 (`engineering-product-backlog`, `engineering-develop-ci`, `engineering-dependabot-ci`) |
| `IDEA` | Feature 없이 등록된 v4 아이디어 카드 (`admin-idea-v4`) |
| `SYNC` | AMUX snapshot 동기화로 만들어진 카드 (원천 없음) |
| `LEGACY` | backfill 시점에 원천도 Feature도 없는 기존 카드 |

v4 카드가 Feature 아래에 있으면(`parentFeatureNodeId`, 또는 부모 Story의 Feature) 이 표가 아니라
그 Feature의 PREFIX를 쓴다.

## 5. Backfill

- 기존 카드 번호는 report-first script로 정한다. 기본은 dry-run이며 Feature별 제안 PREFIX와 카드별로
  줄 번호를 표로 출력한다. 운영자가 그 표를 확인하고 명시적으로 승인한 뒤에만 적용한다.
- 같은 PREFIX 안의 기존 카드는 `createdAt`, 같으면 `id` 순으로 번호를 받는다.
- 적용은 저장소의 감사 규칙이 요구하는 감사 기록과 같은 트랜잭션에서 쓴다.
- backfill은 카드의 다른 컬럼, 상태, revision, 승인·실행 기록을 바꾸지 않는다.

## 6. 닫힌 범위

이 계약은 표시와 검색에 쓰는 이름 하나를 더할 뿐이다. 다음을 바꾸지 않는다.

- 카드 상태, 승격, claim, worker 배정, 실행, 비용, 승인 결속, 감사 체인의 의미.
- API·링크·로그·복구 기록이 쓰는 Task ID. 번호로 카드를 조회하는 쓰기 API를 만들지 않는다.
- `sourceSystem`·`sourceKey`의 의미와 중복 판정.
- 환경 변수, 코드 래치, Railway 설정, 권한.

## 7. 구현 단계

각 단계는 별도 PR로 develop에 보낸다.

- **S2 schema와 할당기**: 카드의 nullable unique 번호 컬럼과 형식 CHECK, 불변 trigger, PREFIX별
  카운터 테이블, Feature 노드의 PREFIX 컬럼과 그 제약, 순수 핵심 모듈과 호출자 트랜잭션 안의 할당
  함수.
- **S3 생성 경로 연결**: 카드를 만드는 모든 경로가 새 카드에 번호를 준다. Feature PREFIX를 v4
  intake 제안에 넣는 요청 schema 변경은 `amux-intake.md` 개정안을 운영자에게 먼저 제시한다.
- **S4 backfill**: §5.
- **S5 표시와 검색**: 목록·상세에서 번호를 주 식별자로, Task ID를 그 옆에 보이고, 번호로 검색한다.
