# Code 관리형 경로의 동시 실행 scope

**상태: 설계 정책입니다. 코드는 아직 없습니다.** TomverseCode의 관리형 모델 카탈로그
경로([TomverseCode product-strategy 17절](https://github.com/mposition/TomverseCode/blob/main/docs/design/product-strategy.md))를 맡는 Code 제품 서비스가 이
저장소에 생길 때 지킬 동시 실행 계약입니다.

`docs/policy/chat-concurrency-and-identity.md`가 정본입니다 — **동시 실행은 entitlement도
guardrail도 아닌 세 번째 층**이라는 규칙을 그대로 따르고, 이 문서는 코딩에 필요한
**별도 scope**만 정합니다. 크레딧·비용은 [code-task-cost-guardrails.md](./code-task-cost-guardrails.md)에
있습니다.

## 1. 왜 채팅 scope를 같이 쓰지 않는가

채팅의 주체 동시 실행 한도(`CHAT_USER_CONCURRENT`, 기본 3)는 **사람이 기다리는 응답 수**를
셉니다. 코딩 태스크는 다릅니다.

- Code는 **여러 태스크를 병렬로** 돌립니다(Fleet — 구성원마다 태스크 하나).
- 한 태스크 안에서도 **호출이 겹칩니다**(계획자 둘을 동시에 부르는 대조).
- 태스크는 몇 시간 살고, 대부분의 시간을 **사용자 승인 게이트 앞에서** 보냅니다.

채팅 scope를 같이 쓰면 두 방향으로 틀립니다. Fleet 하나가 채팅 슬롯을 전부 먹어 **같은
사용자가 채팅을 못 쓰게** 되고, 반대로 채팅 한도에 맞추면 Fleet이 한 구성원씩밖에 못 돕니다.
그래서 코딩은 **자기 scope**를 가지며 채팅 scope를 소비하지 않고, 채팅도 코딩 scope를 소비하지
않습니다.

## 2. 두 단위를 따로 센다

| scope | 무엇 | 언제 잡고 언제 푸나 | 층 |
|---|---|---|---|
| **태스크 슬롯** **[제안] `code-task:<userId>`** | 이 계정에서 **살아 있는 관리형 태스크** 수 | 태스크 예약(계획 승인) 때 잡고, 종료·중단 때 푼다 | `concurrency` |
| **호출 슬롯** **[제안] `code-call:<userId>`** | 이 계정에서 **지금 provider에 나가 있는** 관리형 호출 수 | 호출 시작에 잡고, 응답 종료·오류·취소에 푼다 | `concurrency` |

- **둘을 합치지 않습니다.** 태스크 슬롯만 세면 승인 게이트 앞에서 쉬는 태스크와 호출 중인
  태스크가 같아지고, 호출 슬롯만 세면 Fleet 구성원이 무한히 열립니다.
- 환경변수·오류 코드·사용자 문구가 채팅과 다릅니다: **[제안]** `CODE_USER_CONCURRENT_TASKS`,
  `CODE_USER_CONCURRENT_CALLS`, `CODE_TASK_CONCURRENCY_EXCEEDED`, `CODE_CALL_CONCURRENCY_EXCEEDED`.
  값은 **[미결정]** — 첫 값은 Code Fleet의 기본 구성원 수와 대조 호출(2)을 기준으로 정하고, 근거를
  이 표에 적습니다.
- **관리형 경로는 로그인 계정만** 씁니다. 게스트 scope와 IP 집계 상한(게스트 전용)은 두지
  않습니다. 계정 자체가 책임 단위입니다(chat-concurrency-and-identity.md §2와 같은 판단).

## 3. Fleet admission은 전부 아니면 전무

Fleet은 사용자 행동 하나(N개 구성원 시작)지만 태스크 N개입니다. 도착 순서대로 슬롯을 잡으면
"N개 중 일부만 시작했다"가 되고, Code는 그 상태를 사용자에게 설명할 방법이 없습니다.

채팅의 다중 모델 admission(chat-concurrency-and-identity.md §3)과 같은 계약입니다.

1. Fleet 시작 preflight가 **한 transaction 안에서 N개 태스크 슬롯**을 원자적으로 확인·예약합니다.
2. 서명·계정 결속·짧은 만료를 가진 admission token을 발급하고, 각 구성원 태스크가 조건부
   UPDATE로 자기 슬롯을 **한 번만** claim합니다.
3. token은 **어느 슬롯을 쓸지만** 정합니다. 모델 자격·크레딧·태스크 예약·guardrail은 구성원마다
   전부 다시 검사합니다.
4. 중간 실패는 되감깁니다(claim되지 않은 슬롯 즉시 반납, TTL 자동 회수).

크레딧 쪽 Fleet 합계 예산은 이 문서의 일이 아닙니다 — 태스크 예약이 구성원마다 따로 크레딧을
잡습니다([code-task-cost-guardrails.md](./code-task-cost-guardrails.md) §3).

## 4. lease 수명 — 승인 게이트 앞의 태스크

- **호출 슬롯**은 채팅 lease와 같습니다: 짧은 TTL + 스트림 heartbeat, 완료·오류·취소·연결
  끊김에서 결정적 해제, 15분 주기 reconciliation.
- **태스크 슬롯**은 몇 시간 살 수 있으므로 **Code Desktop이 heartbeat로 유지**합니다. 사용자가
  승인 게이트 앞에서 생각하는 동안에도 Desktop이 켜져 있으면 유지됩니다.
- **Desktop이 heartbeat를 멈추면 TTL 뒤 태스크를 `interrupted`로 확정**하고 태스크 슬롯과 태스크
  예약을 함께 풉니다. 다시 이어가려면 새 admission을 받습니다 — 자동 재개하지 않습니다.
- TTL 상수를 키워 긴 태스크를 살리지 않습니다. 긴 태스크는 heartbeat가 담당합니다
  (chat-concurrency-and-identity.md §4와 같은 이유).

## 5. 웹 원격 접속과의 관계

웹 원격 접속(중계)은 **슬롯을 늘리지 않습니다.** 웹에서 보는 태스크는 Desktop에서 도는 같은
태스크이며, 브라우저 연결 수는 이 scope의 단위가 아닙니다. 중계 채널 자체의 연결 상한이 필요하면
별도 scope와 `operational_admission` 층으로 설계합니다.

## 6. 관측

- 코딩용 한도 결정 로그의 `limitLayer`는 `concurrency`이며 `limitScope`로 태스크·호출을 가릅니다.
- `code_concurrency_rejected` — scope, active count, requested slots, limit. 계정은 해시된 usage
  key, **원시 코드·경로·프롬프트·IP는 넣지 않습니다.**
- `code_task_lease_expired` / `code_lease_reconciliation` — orphan과 heartbeat 끊김 지표.

## 7. 바꾸기 전에

- 채팅 동시 실행 한도를 올려 코딩을 통과시키지 않고, 코딩을 채팅 scope에 합치지 않습니다.
- 태스크 슬롯과 호출 슬롯을 하나로 합치지 않습니다(§2).
- Fleet admission을 도착 순서 방식으로 되돌리지 않습니다(§3).
- 태스크 lease를 고정 TTL로 바꾸지 않습니다(§4).
- 이 문서의 **[제안]·[미결정]** 값은 구현 PR에서 정하고, 그 PR이 이 문서를 함께 고칩니다.
