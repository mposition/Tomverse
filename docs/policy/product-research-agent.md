# 제품·리서치 Agent 정책

상태: **승인.** 최초 작성 2026-10-02. v1 승인 2026-10-03. v2 병합 2026-10-12(UTC). v3 승인 2026-10-13.
approvedBy: mposition · approvedAt: 2026-10-13 · 정책 버전: v3
allowlistGenesisCommit: 8e3dbf64452ab75e3c6f080c8f5f531c02ace387

| 버전 | 승인 | 변경 |
|---|---|---|
| v1 | mposition 2026-10-03 | 최초 승인. 비공개 설계서(revision 15)의 공개 가능한 계약 |
| v2 | mposition, 병합 2026-10-12(UTC, #2411) | 개선 탐색 기능 추가(§10~§21). 관측 기능의 변경 넷: 각 외부 호출 직전의 상태 확인(§3), Agent 전체 kill switch와 쓰기 직렬화(§6), kill switch 중 보존 삭제 지연(§4), kill switch 중 침묵 검사 정지(§5). 비공개 설계서(revision 20)의 공개 가능한 계약 |
| v3 | mposition 2026-10-13 | 승인 기록 정정만. v2는 UTC 2026-10-12 22:16에 병합되어 `approvedAt` 2026-10-13과 승인 판정 5가 맞지 않았습니다. 본문은 v2와 같습니다 |
| 2026-10-19 | 운영자 결정(대화) | 개선 탐색을 LLM-first로 전환(§10~§14). v2·v3의 개선 탐색 장치(slot·latch·kill switch·page token·손으로 짠 규칙)와 관측 기능의 v2 변경 넷은 만들지 않았고 이 문서에서 뺐습니다 |

위 승인 기록은 v3까지의 이력입니다. 2026-10-19부터 이 문서는 AGENTS.md의 "먼저 만들고, 되돌릴 수 없는 것에만 게이트를
둡니다" 절을 따릅니다: 운영자 승인이 필요한 것은 되돌릴 수 없는 일(유료 호출 활성화와 상한, 외부 게시·발송, 사용자 데이터
삭제, 자격증명·보안 경계, production 병합·배포)뿐이고, 그 밖의 설계 결정은 운영자가 대화에서 정한 대로 코드와 함께 이
문서에 반영합니다. 정책 버전을 올리거나 승인 판정을 다시 거치지 않습니다.

## 1. 이 Agent가 하는 일 (관측 기능)

이 Agent는 기능이 둘입니다. **관측**(§1~§9)은 열린 이슈의 기존 판정을 옮겨 적고, **개선 탐색**(§10~§14)은 Tomverse를
돌아보고 LLM이 개선 제안을 냅니다. 둘은 서비스·변수·Admin 화면을 따로 씁니다.


열린 이슈마다 `scripts/report-issue-backlog-core.mjs`가 이미 낸 판정을 **한 행씩 옮겨 적습니다.** 소유자가 "다음에 무엇을
할까"를 정할 때 읽는 관측 자료이며, 다음 작업을 정하지 않습니다.

- 판정은 기존 core가 합니다. 이 Agent는 재구현하지 않고, verdict를 원천 값 그대로 저장합니다.
- 신호 셋(`pricing`·`probe`·`commits`)은 release branch(`develop`·`main`)별로 **따로** 저장합니다.
- 변환은 `lib/productResearchObservationCore.mjs`의 순수 함수뿐입니다. 기존 보고서의 판정을 그대로 옮기는 일이라 LLM을
  쓸 이유가 없습니다.

## 2. 지키는 것 (관측 기능)

1. **LLM을 쓰지 않습니다.** 관측 기능의 실행 경로·route·화면에는 LLM 호출이나 키가 없습니다(§1의 이유). 개선 탐색은 §10.
2. **GitHub에 쓰지 않습니다.** issue·label·comment·artifact·commit status·check·branch·PR 전부. GitHub 토큰은 읽기
   전용이며, GitHub를 상태 저장소나 승인 증거로 쓰지 않습니다(공통 기반의 상태 저장 위치 규칙).
3. **추천하지 않습니다.** payload 스키마에 추천·순위·우선도·"완료 확정" 필드가 없고, 검증기가 알 수 없는 key를 거절합니다.
4. **원천 enum을 합치거나 이름을 바꿔 저장하지 않습니다.** 사람이 보는 label은 고정 표에서만 바뀌고, 그 표에 "추천"·
   "우선"·"다음 작업"·"착수"·"미완료"·"완료 확정"이 들어가면 테스트가 실패합니다(예외는 "미완료 증거 아님"과 섹션 머리
   문장뿐).
5. **숫자를 지어내지 않습니다.** 요약 수는 행에서 재계산해 대조하며, 어긋나면 저장을 거절합니다.
6. **잘라내지 않습니다.** 이슈가 행 수 상한(200)을 넘으면 실패이고 일부만 싣지 않습니다.
7. **외부 텍스트는 데이터입니다.** 이슈 제목은 정규화(NFC, 제어·bidi 문자 제거)·길이 제한(256 code point)·secret scan을
   지나야 저장됩니다. scan은 앱이 이미 쓰는 `detectSecrets()`(`lib/engineeringAgentSecretPatterns.ts`)이며,
   제출 수락 판정(`lib/productResearchObservationSubmission.ts`) 안에서 **저장 전에** 돌아갑니다. 한 건이라도
   걸리면 그 회차 전체를 거절하고, 행을 빼지 않습니다 — 행을 빼면 저장된 관측이 자기가 설명한다고 주장하는 backlog와
   달라지고, 화면에는 빠진 사실이 남지 않습니다. 보고하는 것은 규칙 id뿐입니다. 이슈 본문·작성자·label은 저장하지
   않으며, 화면에서는 escape된 텍스트로만 보입니다.

8. **실패를 성공처럼 보이지 않습니다.** 실패·갱신 없음 상태에서 이전 성공 내용을 싣지 않고, 부분 결과가 없습니다.
9. **결과를 모르면 재시도하지 않습니다.** 제출이 타임아웃·연결 실패로 끝나면 같은 회차를 다시 보내지 않습니다.
10. **registry·가격·크레딧·출력 상한·release gate registry·`GATE_EVIDENCE`·`AGENTS.md`·backlog branch에 쓰지 않습니다.**

## 3. 실행 위치와 자격증명 (관측 기능)

- 실행은 **Agent 전용 Railway project**의 cron 서비스입니다. GitHub Actions를 쓰지 않습니다. 그 project에는 제품 DB
  서비스와 공유 변수가 없고, IaC 파일 하나가 project 전체를 소유합니다.
- 실행 서비스의 변수는 다음뿐입니다: 스위치, 제출 URL, 제출 secret(32자 이상, 환경별 직접 값), 대상 저장소 한정 읽기 전용
  fine-grained 토큰(Issues: read), builder용 git 설정 변수 하나. **제품 DB 자격증명은 없습니다.**
- 실행 서비스가 내는 네트워크 호출은 **세 종류뿐이며, 전부 `github.com` 또는 본 앱 제출 URL 한 곳으로만 갑니다.**

  | # | 호출 | 자격증명 | 대상 | 상한 |
  |---|---|---|---|---|
  | 1 | git 전송(fetch) | **없음** | `https://github.com/<대상 저장소>` 하나. HTTPS만이며 ssh·git 프로토콜·submodule·LFS·대체 remote를 쓰지 않습니다 | 회차당 `git` 프로세스 1회, 두 release branch를 한 번에 가져옵니다 |
  | 2 | 이슈 목록 `GET` | 읽기 전용 토큰 | GitHub REST 이슈 목록 | 회차당 10회 |
  | 3 | 제출 `POST` | 제출 secret | 제출 URL 하나 | 회차당 1회 |

  **clone에는 자격증명을 쓰지 않습니다.** 대상 저장소는 공개이므로 익명 fetch로 두 release branch를 받을 수 있고,
  그래서 실행 서비스의 GitHub 토큰에 Contents 권한이 없습니다. Issues: read 토큰으로는 git object를 가져올 수 없는 것이
  맞으며, 그것이 이 설계의 결함이 아니라 clone이 토큰을 쓰지 않는다는 뜻입니다. **토큰이 존재하는 이유는 접근이 아니라
  REST rate limit입니다** — 익명 60회/시간은 회차당 10회 조회에 충분하지 않을 수 있고, 인증 시 5,000회/시간입니다.
  대상 저장소가 비공개로 바뀌면 clone은 Contents: read를 요구하게 되므로, 그 변경은 이 정책의 개정 사유입니다.

  builder용 변수(`RAILPACK_DEPLOY_APT_PACKAGES`)는 자격증명이 아니라 이미지에 설치할 패키지 이름이며, 값은 `git`
  하나입니다.

  **git 전송은 이슈 조회 10회 상한에 포함되지 않습니다.** 서로 다른 것을 세는 상한이기 때문입니다 — 10회는 page 수에
  비례해 늘어나는 REST 호출의 상한이고, git 전송은 회차당 1회로 고정이며 page가 없습니다. 둘을 한 숫자로 합치면 이슈가
  늘어 page가 늘었을 때 clone이 먼저 막히고, 그것은 "이슈가 많다"와 아무 관계가 없는 실패입니다.

  clone은 `--filter=blob:none --no-tags` bare partial clone이며, 받는 것은 두 release branch의 commit·tree와 판정이
  이름 댄 blob뿐입니다. 저장소에 쓰지 않습니다.

- 전체 실행 hard timeout은 15분이며, 그 시점에 살아 있는 child를 끝내고 프로세스를 종료합니다. 정상 완료는 timer를 정리하고
  exit 0입니다.
- 제품 상태는 본 앱 내부 route로만 바꿉니다. 인증은 32자 이상 secret, Bearer, SHA-256 후 constant-time 비교, POST,
  `no-store`, 타임아웃입니다(마케팅 정책 §4와 같은 규율).

## 4. 저장과 보존 (관측 기능)

**예정 slot의 정의부터 적습니다.** 아래 전부가 이 한 정의에 달려 있습니다.

- slot은 **매일 21:30 UTC의 그 instant**이며, 초와 밀리초가 0인 분 경계입니다(DB의 CHECK가 강제). cron도 같은
  `30 21 * * *`이고, 시각은 UTC로만 적습니다 — 운영자가 읽는 07:30 Australia/Brisbane은 같은 instant의 다른 표기이며
  두 번째 일정이 아닙니다.
- 어떤 moment가 어느 slot에 속하는지는 `slotForInstant()` 한 함수가 정합니다. 그 instant 이전은 **전날 slot**이며, 그래서
  21:31에 끝난 실행과 00:05에 뜬 실행이 같은 답을 냅니다.
- 한 slot은 **제출 창 1시간**을 갖습니다(`[slot, slot+1h)`). 창 밖 제출은 DB가 거절하며, 이것이 공통 기반이 DB에 요구하는
  단 하나 — 늦은 실행이 성공으로 기록되지 않는다 — 입니다. 거절은 행을 남기지 않고, 행 없음이 침묵 검사의 입력입니다.
- `submittedAt`은 **DB가 씁니다.** 제출자가 정할 수 있으면 놓친 창 안에 행을 넣을 수 있고, 보존 sweep이 닿지 않는 곳으로
  행을 옮길 수 있습니다.

그 위에서:

- 관측 회차는 본 앱 테이블 하나에 **insert만** 합니다. update는 DB가 거절합니다 — 고칠 것이 없습니다. 회차의 답은 그
  실행이 본 것이고, 나중의 편집은 어떤 실행도 관측하지 않은 내용을 저장된 행이 말하게 만듭니다.
- 같은 slot에는 한 행만 들어갑니다. unique 제약이고 read-then-insert가 아닙니다 — 같은 slot의 두 실행(재시도된 cron,
  손으로 돌린 서비스)이 둘 다 "아직 행 없음"을 읽고 둘 다 쓰는 것을 막는 것이 그 제약의 일입니다. 중복·선점·거절 요청은
  어떤 테이블에도 쓰지 않습니다.
- payload digest는 서버가 정규화된 객체에서 다시 계산합니다. 제출자가 보낸 digest는 쓰지 않으며, digest field를 담은
  본문은 조용히 무시하지 않고 거절합니다 — 무시하면 제출자는 서버가 검사했다고 믿습니다.
- **보존 90일.** 그 전에 삭제하는 것은 DB가 거절하고, 지난 행은 기존 maintenance cleanup이 감사와 같은 트랜잭션에서
  지웁니다. 최신 행 예외는 없습니다.
- 사람이 보는 곳은 Admin 공통 Agent digest 영역의 이 Agent 섹션 하나입니다. 승인·거절 버튼이 없습니다(결정할 항목이 없음).
  화면이 "가장 최근 기록 회차"로 보여 주는 것은 **직전 예정 slot이 성공했을 때만** 그 slot입니다. 실패·기록 없음이면 이전
  성공의 행을 보여 주지 않습니다(§2 조건 8) — 어제의 관측은 틀린 것이 아니지만 지금의 backlog 상태에 대한 답이 아닙니다.

**실행 종료와 재시작.** hard timeout 15분에 도달하면 살아 있는 child를 끝내고 프로세스가 **exit 1**로 종료합니다. 정상
완료는 timer를 정리하고 exit 0이며, 스위치가 unset인 회차도 exit 0입니다(할 일이 없는 것은 실패가 아닙니다). 서비스의
`restartPolicyType`은 **`NEVER`**입니다 — 결과를 모르는 실행을 플랫폼이 다시 띄우면 그 slot에 두 번째 답을 보내게 되고,
그것은 답이 없는 것보다 나쁩니다. 설령 재시작되어도 slot unique 제약과 창 검사가 두 번째 행을 거절합니다.

## 5. 감사 (관측 기능)

시스템 행위는 `writeSystemAuditLog`로 상태 변경과 **같은 트랜잭션**에 남깁니다. actor 이름은 닫힌 목록에 등재해야 생기고,
감사 테이블 직접 쓰기는 금지입니다. 기록되는 action은 둘이며 **상태를 바꾸는 것이 둘뿐이기 때문**입니다 — 관측 회차 저장,
보존 기간 지난 행 삭제. 감사 metadata에 이슈 제목·payload 본문을 싣지 않습니다.

**침묵 검사는 감사 기록이 아닙니다.** 아무 상태도 바꾸지 않고 운영 incident(`PRODUCT_RESEARCH_OBSERVATION_SILENT`)를
올릴 뿐이므로 해시 체인에 넣지 않습니다. 기준은 마지막 성공(없으면 앱 스위치를 처음 켠 시각) 이후 **26시간**이며, 하루 한
회차 + 창 1시간 = 25시간에 한 시간을 더한 값입니다. 창 안에서 늦은 실행 하나는 incident가 아니고, 통째로 빠진 회차는
incident입니다. 처음 켠 시각은 `AppSetting`의 `productResearch.enabledSince`에 **한 번** 기록하며, 그것이 없으면
"한 번도 성공하지 못한 Agent"와 "보존 sweep으로 행이 다 사라진 침묵"을 둘 다 경보할 수 없습니다.

## 6. 스위치 (관측 기능)

스위치는 **이름이 같고 사는 곳이 다른 변수 둘**입니다. 이름은 양쪽 모두 `PRODUCT_RESEARCH_AGENT_ENABLED`입니다.

| 스위치 | 어디 | 무엇을 제어하는가 |
|---|---|---|
| 서비스 | Agent project의 실행 서비스 변수 | 실행 시작. unset이면 clone·GitHub 조회·제출을 하지 않고 exit 0 |
| app | 본 앱 환경변수 | 수신·표시·침묵 검사. unset이면 제출 route는 404, Admin 섹션은 꺼짐 안내 |

**꺼짐은 unset 또는 빈 문자열뿐입니다.** 값이 있으면 그것이 `false`든 `0`이든 **켜짐**입니다 — 스위치가 답하는 질문은
"운영자가 설정했는가"이고, 그 단어의 뜻을 해석하기 시작하면 아무도 읽을 수 없는 스위치가 됩니다. 끄려면 변수를
**지웁니다.**

전체 정지는 둘 다 지우는 것입니다. 입력 하나라도 읽지 못하면 꺼짐(fail-closed)이고, 해제는 운영자가 변수를 다시 설정하는
것뿐입니다. 자동 정지 트리거는 두지 않습니다.

## 7. 비용 (관측 기능)

LLM·외부 유료 API 비용이 0입니다. 비용 namespace는 `agent:product-research`이며 사용자 크레딧·플랜·Chat provider 예산과
섞지 않습니다. 구조적 상한은 하루 1회 실행 × 15분과 실행당 GitHub 조회 10회입니다. 월 금액 기준은 **운영자 경보 기준**이며
자동 차단 수단이 아닙니다.

## 8. 개인정보 (APP, 관측 기능)

공개 이슈 제목에도 사람 이름 같은 **우발적 개인정보**가 들어 있을 수 있습니다. 그래서 제목 외 이슈 필드를 저장하지 않고,
보존을 90일로 두고, Admin 권한으로 접근을 제한하고, 외부 채널로 보내지 않으며, 표시는 escape된 텍스트로만 합니다.

**이 테이블은 저장소의 data-domain registry 대상이 아닙니다.** `docs/policy/tomverse-chat-data-domain-registry.yaml`과
`npm run check:data-domain-registry`가 다루는 것은 **user-linked model** — 즉 `User`를 가리키는 열이 있는 것 — 이고,
`ProductResearchObservation`에는 그런 열이 없습니다. 거기 등재하려면 공개 이슈 제목에 `User` 연결을 억지로 붙여야 하며,
그것은 지금 없는 개인 연결을 만드는 일입니다. 그래서 등재하지 않고, 검사도 이 테이블을 요구하지 않습니다.

정책 승인 전에 기록해야 하는 것은 **운영자의 APP 확인값**이며 위 registry와 별개 산출물입니다. 셋입니다.

| 항목 | 무엇을 기록하는가 |
|---|---|
| APP 3 | 제목을 수집하는 것이 이 Agent의 기능에 필요하다는 판단과 근거 |
| APP 5 | 통지 방식, 또는 통지가 합리적으로 불필요한 근거 |
| APP 8 | 본 앱 DB와 두 Railway project의 실제 처리 지역, 국외 제공 해당 여부 |

세 값은 운영자가 v1 승인 PR(#1975)에 기록했습니다.

## 9. 단계와 차단 기준 (관측 기능)

| 단계 | 내용 | 차단 기준 |
|---|---|---|
| 정책 | 이 문서 승인 | 완료(v1, 2026-10-03) |
| P0B0 | 보고서 CLI의 commit 고정 입력, 관측 table core, 실행 서비스 probe 모드, Agent project IaC | fixture 전부 통과 |
| S0 | staging에서 아래 넷을 측정 | **넷 중 하나라도 어긋나면 보류** |
| P0B1 | 제출 route·테이블·migration(스위치 기본 off), 보존·침묵 검사, Admin 섹션 | fixture 전부 통과 |
| P1 | staging 실행과 관찰 창 | 아래 P1 조건 미충족 |
| P2 | production 실행과 표시 | 아래 P2 조건 미충족 |

**S0은 넷을 측정하고 넷 다 통과해야 합니다.** 앞의 둘만 차단 기준으로 적으면, 제품 DB가 남아 있거나 쓰기 권한이 붙은
토큰이 설정된 project에서도 S0이 통과합니다.

| # | 측정 | 통과 조건 |
|---|---|---|
| 1 | 배포 이미지의 git | `git --version`이 성공하고, 버전이 2.19 이상(= `--filter=blob:none` 지원) |
| 2 | partial clone 결과 | 고정 입력으로 낸 보고가 전체 checkout의 것과 **byte 동일**. 저장소 안에서 `tests/issueBacklogPartialClone.test.mjs`가 네트워크·자격증명 없이 고정합니다 |
| 3 | 읽기 토큰 권한 | 대상 저장소 하나, Issues: read 하나. 다른 권한이 하나라도 붙어 있으면 **발급을 다시 합니다** |
| 4 | Agent project 경계 | 그 project에 DB 서비스 0개, 공유 변수 0개 |

전환 조건은 숫자로 적습니다. "창 조건"·"가동 검증"처럼 이름만 있는 기준은 운영자가 같은 자료를 보고 서로 다른 답을 낼
수 있고, 그러면 차단이 차단으로 기능하지 않습니다.

**P1 → P0B1 완료 후 staging 관찰 창.** 모두 충족해야 P2 착수 판정을 할 수 있습니다.

1. 연속 **14** 예정 slot에서, 각 slot의 성공 행이 **정확히 1개**다. 0개(침묵)와 2개 이상(중복)은 둘 다 실패다.
2. 각 행의 `submittedAt`이 그 slot의 **1시간** 창 안이다. DB가 강제하므로 운영자가 따로 셀 것은 없고, 창을 벗어난
   제출은 행이 아니라 1번의 0개로 나타납니다.
3. 14 slot 동안 payload digest 불일치·요약 수 불일치·행 수 상한 초과로 거절된 제출이 **0**건이다.
4. 14 slot 동안 실패 회차가 있어도 되지만, 실패 회차가 **이전 성공 내용을 담은 행을 만든 적이 0**건이다.
5. 90일 보존 삭제가 아직 일어나지 않는 구간이므로, 이 창에서 삭제 건수는 **0**이어야 한다.

중간에 조건이 깨지면 창은 **처음부터 다시 셉니다.** 깨진 slot만 빼고 이어 세는 것은 "연속 14"가 아닙니다.

**P2 → production 가동 검증과 30일 판정.**

1. **가동 검증**: production 첫 예정 slot에서 행이 정확히 1개 생기고, 그 행의 verdict 분포가 같은 commit을 고정 입력으로
   준 로컬 CLI 실행 결과와 **같다**. 다르면 P2는 보류다.
2. **30일 판정**: 이후 연속 **30** 예정 slot 중 성공 slot이 **27 이상**(90%)이고, 그 30 slot 동안 위 P1의 3·4 조건
   위반이 **0**건이다.
3. 30일 창에서 **26시간** 이상 성공이 없는 구간이 생기면 침묵 경보가 울려야 하고, 울리지 않았다면 그 창은 판정에
   쓰지 않는다 — 측정 수단이 작동하지 않은 기간이기 때문이다.

단계 전환 판정과 서명은 운영자가 합니다.

## 10. 개선 탐색 (LLM-first)

운영자 결정 2026-10-19. 매일 Tomverse를 돌아보고 고칠 만한 것을 찾아 운영자에게 제안하고, 운영자가 고르면 AMUX
아이디어로 보냅니다. **판단은 LLM이 하고, 코드는 수집·저장·경계만 맡습니다.** 손으로 짠 UI·렌더링 규칙은 없습니다.

1. **walker**가 대상마다 화면을 모읍니다: production 공개 page의 desktop·320px screenshot과 콘솔 오류·실패한 같은 origin
   요청, 고정 명세로 만든 PDF·DOCX·XLSX·PPTX의 이미지, 카탈로그 불일치(0단계 보고서 `report:product-consistency`).
2. walker가 대상 하나씩 앱의 `POST /api/internal/product-research/scout`로 보냅니다.
3. **앱이 LLM을 한 번 부릅니다**(`lib/productResearchScoutLlm.ts`, support-triage와 같은 방식). 입력은 그 대상의 이미지와
   신호, 그리고 같은 대상에 이미 낸 제안 제목들(반복을 막기 위해서)이고, 출력은 제안 최대 5개(제목·영역·심각도·근거·제안)의
   JSON입니다. 판정 경계는 `lib/productResearchScoutCore.ts`가 검사합니다.
4. 제안은 `ProductResearchSuggestion` 표에 쌓이고, Admin의 "개선 제안" 목록에서 운영자가 **거절**하거나
   **AMUX로 보내기**를 누릅니다. 보낸 뒤의 분석·카드는 AMUX intake 규칙을 따릅니다.

## 11. 지키는 것 (개선 탐색)

1. **밖으로 나가는 것이 없습니다.** 게시·발송·GitHub 쓰기가 없고, AMUX로 보내는 것은 운영자의 클릭입니다.
2. **유료 호출은 꺼진 채로 배포합니다.** owner가 Admin에서 이미지 입력이 되는 enabled 모델을 고르고 하루 호출 상한(UTC 하루,
   기본 0)을 정하기 전에는 아무것도 쓰지 않습니다. 두 설정은 비용을 정하므로 owner만, 최근 로그인 상태에서 바꾸며 이전·이후 값이
   감사 기록에 남습니다. 호출은 대상당 한 번이고, 호출 전에 원장(`ProductResearchScoutLlmCall`)에 한 줄을 써서 상한을 차감하며,
   `maxRetries: 0`과 출력 상한이 있고, 로그와 원장에는 토큰 수만 남깁니다.
3. **walker는 제출 secret 하나만 갖습니다.** LLM 키·제품 DB 자격증명은 앱에만 있습니다.
4. **production 공개 page를 게스트로, GET·HEAD로만 봅니다.** 클릭·입력·form 제출이 없습니다.
5. **봇 차단·CAPTCHA를 우회하지 않습니다.** 챌린지나 오류 상태의 문서는 renderer에 닿기 전에 그 자리에서 멈춥니다(§12).
6. **이미지와 파일은 모델 호출에만 쓰고 저장하지 않습니다.** 저장하는 것은 제안 문장과 대상 id입니다.
7. 화면과 신호는 Tomverse 자신의 것이지만 모델에게는 **데이터**로 넘깁니다(프롬프트의 태그 안).

## 12. 대상과 browser 규칙

**대상**: 아래 20개 page, 렌더러 probe 4종(`lib/productResearchScoutRendererProbes.mjs`), 카탈로그. origin은
`https://tomverse.app` 하나이며, 언어는 browser locale로 정합니다(`lib/productResearchScoutBrowserPolicy.mjs`).

| page id | URL | 언어 |
|---|---|---|
| `home.en` | `/` | en |
| `pricing.en` | `/pricing` | en |
| `models.en` | `/models` | en |
| `compare-ai-models.en` | `/compare-ai-models` | en |
| `chatgpt-vs-claude.en` | `/chatgpt-vs-claude` | en |
| `ai-for-file-analysis.en` | `/ai-for-file-analysis` | en |
| `about.en` | `/about` | en |
| `faq.en` | `/faq` | en |
| `support.en` | `/support` | en |
| `help-centre.en` | `/support/help-centre` | en |
| `privacy.en` | `/privacy` | en |
| `terms.en` | `/terms` | en |
| `safety.en` | `/safety` | en |
| `chat-guest.en` | `/chat`(게스트) | en |
| `home.ko` | `/` | ko |
| `pricing.ko` | `/pricing` | ko |
| `models.ko` | `/models` | ko |
| `faq.ko` | `/faq` | ko |
| `support.ko` | `/support` | ko |
| `chat-guest.ko` | `/chat`(게스트) | ko |

목록은 운영자가 대화에서 바꾸면 코드와 이 표를 같이 고칩니다.

**browser 규칙**(2026-10-13 측정, `scripts/agents/product-research-scout-s0-probe.mjs fixture`):

- browser 수준 CDP Fetch session이 모든 target의 모든 요청과 **redirect의 매 단계**를 보내기 전에 판정합니다: GET·HEAD만,
  허용 origin만. Playwright의 route 가로채기만으로는 redirect가 새고, host resolver 규칙만으로는 같은 host의 다른 port가
  새는 것을 측정했습니다. resolver 규칙은 두 번째 층으로 둡니다.
- 문서 응답은 CDP가 붙잡은 채 읽어, `cf-mitigated: challenge`나 400 이상이면 실패시킵니다. iframe·뒤늦은 navigation도
  같습니다.
- WebSocket·service worker·다운로드·권한 요청은 막고, Chromium sandbox는 켠 채로만 띄웁니다.
- production 20개 page가 시도하는 다른 origin은 googletagmanager와 Turnstile뿐이며, 둘 다 막습니다.

## 13. 변수와 켜는 순서

| 설정 | 어디 | 무엇 |
|---|---|---|
| `PRODUCT_RESEARCH_SCOUT_ENABLED` | 앱과 walker | 꺼짐은 unset·빈 문자열. 앱에서 꺼져 있으면 route는 404 |
| `PRODUCT_RESEARCH_SCOUT_INGEST_SECRET` | 앱과 walker | 32자 이상. Bearer로 비교 |
| `PRODUCT_RESEARCH_SCOUT_INGEST_URL` | walker | 그 환경 앱의 `https://…/api/internal/product-research/scout` |
| 모델·하루 호출 상한 | Admin › Engineering agent › Product research (`AppSetting` 두 행) | owner가 정함. 모델이 없으면 route는 `model_off`, 상한을 다 쓰면 `daily_cap_reached`로 답함 |

켜는 순서: Railway에서 Chromium sandbox를 한 번 확인(`Product Research Scout Probe`의 `all`) → 앱 변수 → Admin에서 모델과 하루
상한 지정(owner) → walker 스위치. walker는 Railway cron `Product Research Scout`로 매일 18:00 UTC(04:00 AEST)에 돕니다.

## 14. 보류 — 자격증명이나 유료 생성 승인이 필요한 것

같은 구조에 입력만 더하는 일이지만, 아래는 되돌릴 수 없는 경계에 닿으므로 운영자가 정할 때 엽니다.

- 테스트 계정으로 실제 PDF·Office·이미지 **생성**을 호출하고 그 결과를 LLM이 평가하기(테스트 계정 자격증명, 생성 비용).
- 로그인 화면(채팅·설정 등) 탐색(같은 테스트 계정).
- dev·Test 화면 탐색(Cloudflare Access 서비스 토큰).
