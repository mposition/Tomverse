# 제품·리서치 Agent 정책

상태: **승인.** 최초 작성 2026-10-02. v1 승인 2026-10-03. v2 승인 YYYY-MM-DD.
approvedBy: mposition · approvedAt: YYYY-MM-DD · 정책 버전: v2
allowlistGenesisCommit: 8e3dbf64452ab75e3c6f080c8f5f531c02ace387

| 버전 | 승인 | 변경 |
|---|---|---|
| v1 | mposition 2026-10-03 | 최초 승인. 비공개 설계서(revision 15)의 공개 가능한 계약 |
| v2 | mposition YYYY-MM-DD | 개선 탐색 기능 추가(§10~§21). 관측 기능의 변경 넷: 각 외부 호출 직전의 상태 확인(§3), Agent 전체 kill switch와 쓰기 직렬화(§6), kill switch 중 보존 삭제 지연(§4), kill switch 중 침묵 검사 정지(§5). 비공개 설계서(revision 20)의 공개 가능한 계약 |

이 문서는 Claude가 설계하고 교차 vendor 독립 검토를 받은 비공개 설계서를 공개 계약으로 옮긴 것입니다. 내용 변경은 운영자
승인과 정책 버전 증가가 필요합니다. 승인은 단계별 착수 조건을 없애지 않으며, 어떤 Railway project·서비스·secret·토큰·
스위치·migration 변경도 그 자체로 허가하지 않습니다.

승인은 아래 단계를 **모두** 통과해야 인정합니다. 판정은 git·GitHub 기록만으로 재현할 수 있어야 하며, script로 자동화해도
게이트가 아니라 보고입니다.

| # | 판정 |
|---|---|
| 0 | `approvedBy`의 계정이, 이 정책 파일을 바꾼 PR의 **base에 있던** `docs/policy/agent-operator-allowlist.md` 목록에 있다. 그 목록 파일의 최초 commit이 위 `allowlistGenesisCommit`과 같다 |
| 1 | 이 정책 파일을 마지막으로 바꾼 commit을 찾는다 |
| 2 | 그 commit을 `develop`에 넣은 PR이 **정확히 하나**다 |
| 3 | 그 PR의 브랜치 이름에 `to-develop` 경로 조각이 없다 |
| 4 | 그 PR의 병합자가 사람이고 `approvedBy`와 같은 계정이다 |
| 5 | `approvedAt`이 그 병합의 UTC 날짜와 같다 |
| 6 | 그 PR이 이 정책 파일 하나만 바꾸고, 모든 commit의 작성자가 `approvedBy`이며 bot이 아니다 |

## 한 Agent, 두 기능 (v2)

이 Agent는 기능이 둘입니다.

| 기능 | 절 | 하는 일 |
|---|---|---|
| 관측 | §1~§9 | 열린 이슈의 기존 판정을 옮겨 적습니다(v1). 추천하지 않습니다 |
| 개선 탐색 | §10~§21 | production 공개 화면·카탈로그와 고정 명세의 렌더러를 결정적 규칙으로 살펴 개선 후보를 운영자에게 올립니다 |

두 기능은 **서비스와 자격증명, 스위치, Admin 표, 비용 기록, 시스템 actor 이름**을 섞지 않습니다. 공통인 것은 Agent 전체
kill switch(§17) 하나이며, LLM 없음(§2-1)·GitHub에 쓰지 않음(§2-2)·실패를 성공처럼 보이지 않음(§2-8)은 두 기능 모두에
적용됩니다. §1~§9에서 v2가 바꾼 곳은 **(v2)** 로 표시합니다. 그 밖의 관측 기능 계약은 v1 그대로입니다.

## 1. 이 Agent가 하는 일 (관측 기능)

열린 이슈마다 `scripts/report-issue-backlog-core.mjs`가 이미 낸 판정을 **한 행씩 옮겨 적습니다.** 소유자가 "다음에 무엇을
할까"를 정할 때 읽는 관측 자료이며, 다음 작업을 정하지 않습니다.

- 판정은 기존 core가 합니다. 이 Agent는 재구현하지 않고, verdict를 원천 값 그대로 저장합니다.
- 신호 셋(`pricing`·`probe`·`commits`)은 release branch(`develop`·`main`)별로 **따로** 저장합니다.
- 변환은 `lib/productResearchObservationCore.mjs`의 순수 함수뿐입니다. LLM이 없습니다.

## 2. 절대 조건

1. **LLM 없음.** 실행 경로·route·화면 어디에도 LLM 호출이나 키가 없습니다.
2. **GitHub에 쓰지 않습니다.** issue·label·comment·artifact·commit status·check·branch·PR 전부. GitHub 토큰은 읽기
   전용이며, GitHub를 상태 저장소나 승인 증거로 쓰지 않습니다(공통 기반의 상태 저장 위치 규칙).
3. **추천하지 않습니다(관측 기능).** payload 스키마에 추천·순위·우선도·"완료 확정" 필드가 없고, 검증기가 알 수 없는 key를
   거절합니다.
4. **원천 enum을 합치거나 이름을 바꿔 저장하지 않습니다(관측 기능).** 사람이 보는 label은 고정 표에서만 바뀌고, 그 표에
   "추천"·"우선"·"다음 작업"·"착수"·"미완료"·"완료 확정"이 들어가면 테스트가 실패합니다(예외는 "미완료 증거 아님"과 섹션
   머리 문장뿐).

   **(v2)** 3·4번은 관측 기능의 조건입니다. 금지 어휘·머리 문장·버튼 금지 검사의 대상은 관측 component이고, 그 검사가
   관측 component를 실제로 가리키는지 테스트로 고정합니다. 개선 탐색의 제안은 별도 component·별도 하위 섹션이며 관측 행을
   참조하지도 정렬하지도 않습니다(§16).
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
- 실행 서비스가 내는 네트워크 호출은 **네 종류뿐이며, 전부 `github.com` 또는 본 앱(제출 URL의 origin)으로만 갑니다.**

  | # | 호출 | 자격증명 | 대상 | 상한 |
  |---|---|---|---|---|
  | 1 | git 전송(fetch) | **없음** | `https://github.com/<대상 저장소>` 하나. HTTPS만이며 ssh·git 프로토콜·submodule·LFS·대체 remote를 쓰지 않습니다 | 회차당 `git` 프로세스 1회, 두 release branch를 한 번에 가져옵니다 |
  | 2 | 이슈 목록 `GET` | 읽기 전용 토큰 | GitHub REST 이슈 목록 | 회차당 10회 |
  | 3 | 제출 `POST` | 제출 secret | 제출 URL 하나 | 회차당 1회 |
  | 4 | 상태 `GET` **(v2)** | 제출 secret | 본 앱 상태 URL 하나(제출 URL과 같은 origin의 고정 경로) | 회차당 최대 12회: 1·2·3번 호출 각각의 직전에 1회 |

  **(v2) 상태 확인.** 실행 서비스는 git 전송, 이슈 page 조회, 제출 **각각의 직전에** 앱 상태 URL을 부릅니다(첫 호출이 실행
  시작 확인을 겸합니다). 답은 Agent 전체 kill switch(§17)와 앱 스위치를 함께 본 것이며, 응답이 명시적인 `go`가 아니면(응답
  없음·오류·schema 밖·client 타임아웃 5초 초과 포함) 그 호출과 이후 호출을 하지 않고 exit 0입니다. 그 slot에는 행이 남지
  않습니다. kill switch가 켜진 뒤 끝까지 가는 것은 진행 중이던 호출 하나뿐이며, 그 결과는 제출되지 않습니다(제출 route도
  kill switch에서 거절, §6). 상태 URL은 변수가 아니라 고정 경로이므로 위 변수 목록은 바뀌지 않습니다.

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
- **(v2) kill switch가 켜진 동안 보존 삭제를 멈춥니다.** maintenance는 이 단계를 건너뛰고, 해제 뒤 첫 maintenance가 밀린
  행을 지웁니다. "90일 전에는 지우지 않는다"는 그대로이고, "90일이 지나면 지운다"는 kill switch가 켜져 있던 기간만큼 늦어질
  수 있습니다. 공개 이슈 제목에 우발적 개인정보가 있을 수 있으므로(§8) 이 지연은 길게 두지 않을 사정이며, kill switch는
  사람이 켜고 끄는 장치이고 Admin에 그 상태가 보입니다.
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
보존 기간 지난 행 삭제. 감사 metadata에 이슈 제목·payload 본문을 싣지 않습니다. **(v2)** 관측 기능의 시스템 action은
여전히 둘이며, Agent 전체 kill switch의 켜기·끄기는 사람의 감사 action입니다(§15).

**침묵 검사는 감사 기록이 아닙니다.** 아무 상태도 바꾸지 않고 운영 incident(`PRODUCT_RESEARCH_OBSERVATION_SILENT`)를
올릴 뿐이므로 해시 체인에 넣지 않습니다. 기준은 마지막 성공(없으면 앱 스위치를 처음 켠 시각) 이후 **26시간**이며, 하루 한
회차 + 창 1시간 = 25시간에 한 시간을 더한 값입니다. 창 안에서 늦은 실행 하나는 incident가 아니고, 통째로 빠진 회차는
incident입니다. 처음 켠 시각은 `AppSetting`의 `productResearch.enabledSince`에 **한 번** 기록하며, 그것이 없으면
"한 번도 성공하지 못한 Agent"와 "보존 sweep으로 행이 다 사라진 침묵"을 둘 다 경보할 수 없습니다.

**(v2) kill switch가 켜진 동안 침묵 검사를 멈춥니다.** kill switch는 기록 열람과 kill switch 변경만 남기는 장치이고, 그
동안의 침묵은 운영자가 건 정지라 경보할 대상이 아닙니다. 해제 뒤에는 **`max(마지막 성공, 마지막 kill switch 끄기 시각)`**
부터 26시간을 다시 셉니다. 끄기 시각은 kill switch 제어 행(§17)의 DB 시각입니다.

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
것뿐입니다. 관측 기능에는 자동 정지 트리거를 두지 않습니다(개선 탐색의 latch는 §17).

**(v2) Agent 전체 kill switch.** 관측 기능에도 §17의 kill switch가 적용됩니다. 켜져 있으면 실행 서비스는 첫 상태 확인에서
exit 0이고(§3), 제출 route는 본문을 읽기 전에 거절하며, 보존 삭제와 침묵 검사는 멈춥니다(§4, §5). Admin 기록 열람은
그대로입니다. owner가 Admin에서 켜고 끄는 사람의 장치이므로 위의 "자동 정지 트리거 없음"과 충돌하지 않습니다.

**(v2) 쓰기 직렬화.** 관측 회차 저장과 보존 삭제는 **첫 lock으로 감사 체인 lock**을 잡고, 그 뒤 kill switch 상태를 다시 읽어
켜져 있으면 쓰지 않습니다. kill switch 제어 행도 같은 lock을 먼저 잡으므로, route 앞단의 확인 뒤에 kill switch가 켜져도 그
요청은 lock 뒤 재확인에서 거절됩니다. 관측 표의 insert·delete trigger도 같은 확인을 해 writer가 순서를 어겨도 DB가
거절합니다. kill switch 상태를 읽을 수 없으면 켜진 것으로 봅니다.

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

세 값은 운영자가 정책 승인 PR에 적고, 그것이 없으면 승인 판정이 성립하지 않습니다.

**(v2)** 개선 탐색 기능의 개인정보는 §19이며, v2 승인 PR에도 같은 세 값을 두 기능 각각에 대해 적습니다.

## 9. 단계와 차단 기준 (관측 기능)

| 단계 | 내용 | 차단 기준 |
|---|---|---|
| 정책 | 이 문서 승인 | 위 승인 판정 전부 통과, APP 기록 존재 |
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

이 숫자를 바꾸는 것은 정책 변경이며 운영자 승인과 정책 버전 증가가 필요합니다. 단계 전환 판정과 서명은 운영자가 하며,
이 정책 승인이 전환을 대신하지 않습니다.

**(v2)** 관측 기능의 v2 변경(상태 확인, kill switch 직렬화, 보존 지연, 침묵 검사 정지)은 §20의 SC1에서 구현하며, 위 단계와
숫자는 바꾸지 않습니다. kill switch가 켜져 있던 구간에는 침묵 경보가 울리지 않으므로, 그 구간이 낀 30일 창은 P2 3번에 따라
판정에 쓰지 않습니다.

## 10. 개선 탐색 기능이 하는 일 (v2)

매일 정해진 범위에서 Tomverse production을 **게스트로, 읽기만 하며** 살펴보고, 결정적 규칙으로 개선 후보("발견")를 찾아 Admin에
올립니다. 운영자가 채택하면 AMUX intake v4에 넣을 **정확한 문안**을 줍니다. 제출과 그 뒤는 intake·AMUX의 규칙을 따릅니다.

- 발견은 **질문**이며 결함 판정이 아닙니다. 이 기능은 아무것도 고치지 않습니다.
- 규칙은 코드에 있는 닫힌 목록입니다. 규칙 추가는 검토받는 코드 변경이고, 규칙 목록은 이 Agent의 쓰기 범위 밖입니다.
- 발견마다 붙는 근거는 **구조화된 관측 값**뿐입니다. 화면 이미지·렌더 이미지·파일을 저장하지 않습니다.

## 11. 절대 조건 (개선 탐색)

§2의 조건 중 범위를 관측 기능으로 적은 것(3·4번)을 뺀 나머지는 개선 탐색에도 그대로 적용됩니다. 그에 더해:

1. **고치지 않습니다.** 코드·설정·모델 registry·가격·크레딧·flag·AMUX·GitHub에 쓰지 않습니다. AMUX에 닿는 것은 채택한 발견을
   연결할 때 `AmuxIdeaSubmission` 한 행과 그 제출자를 읽는 것뿐입니다.
2. **로그인하지 않고 production 밖 화면을 보지 않습니다.** production 공개 page를 게스트로, GET·HEAD로만, 아무것도 누르지 않고
   봅니다.
3. **외부 JavaScript는 secret이 하나도 없는 browser 서비스에서만 실행합니다**(§13).
4. **provider·검색·LLM 호출이 없습니다.** 비용이 드는 호출은 §21의 결정과 이 정책의 개정 없이 열지 않습니다.
5. **사용자 콘텐츠를 입력으로 쓰지 않고, 화면을 이미지로 저장하지 않습니다.**
6. **봇 차단·CAPTCHA를 우회하지 않습니다.** 챌린지를 받으면 그 page를 멈추고 기록합니다.
7. **"문제 없음"을 증명했다고 말하지 않습니다.** 특히 Office 파일은 실제 application으로 여는 확인이 사람 몫입니다.
8. **성공한 run의 결과만 보이고 채택할 수 있습니다.** 실패·만료 run의 결과는 표시·채택하지 않습니다(§2-8을 개선 탐색에도 적용).
9. **결과를 모르면 재시도하지 않습니다.** 요청 id로 read-back을 한 번 하고, 확정되지 않으면 멈춥니다(§13).
10. **자기 게이트를 고치지 않습니다.** 규칙 목록·probe 명세·page 목록·정책·테스트·권한은 이 Agent의 쓰기 범위 밖입니다.
11. **관측 기능의 v1 보장을 약하게 만들지 않습니다.** 예외는 이 v2가 명시해 재승인하는 둘, kill switch 중 보존 삭제 지연(§4)과
    침묵 검사 정지(§5)입니다.

## 12. 규칙, 작업 단위, 탐색 대상

**규칙 계열**

| 계열 | 규칙 | 입력 |
|---|---|---|
| CAT | CAT-01 자체 검색 제공사인데 앱 검색(Brave)으로 검색하는 enabled 모델, CAT-02 대체 모델을 안내하지 못하는 운영 종료 모델, CAT-03 크레딧 가중치의 코드·DB 차이, CAT-04 출력 상한의 코드·DB 차이 | production 공개 카탈로그 / 앱 DB(앱 route 안에서 읽기만) |
| UI | UI-01 같은 origin 요청의 4xx·5xx, UI-02 콘솔 오류, UI-03 axe serious·critical, UI-04 320px 가로 넘침, UI-05 번역 key가 그대로 보임 | production 공개 page(게스트) |
| RND | RND-01 렌더러가 고정 명세에서 파일을 만들지 못함, RND-02 파일 구조 검사 실패, RND-03 한글이 있는 PDF에 한글 글리프 글꼴 없음, RND-04 PDF 래스터에서 텍스트가 page 밖, RND-05 파일 크기·쪽 수가 기대 범위 밖 | 코드에 고정된 명세로 서버 렌더러를 실행 |

- 관측 값은 규칙별 strict schema, 한 관측당 4 KiB 이하, 자유 문장 field 없음. 문자열 field는 길이 제한·정규화(NFC, 제어·bidi
  문자 제거)·`detectSecrets()`를 지나야 저장됩니다.
- **URL path schema:** `/` 하나로 시작하는 같은 origin 상대 경로, 512자 이하의 출력 가능한 ASCII, query·fragment 제거. `//`로
  시작하거나 scheme·역슬래시·`..` 구간이 있으면 거절합니다. 저장한 path는 표시용 텍스트이며 링크로 만들지 않습니다. Admin의
  "열기" 링크는 고정 page id에서 서버가 만듭니다.
- RND-02는 "문제 있음"만 말합니다. OOXML 구조 검사를 통과하고도 Office가 열지 못한 사례가 있기 때문입니다.

**작업 단위.** run은 시작할 때 할 일(카탈로그 버전, 규칙·page·probe id 목록, 최대 200개)을 선언하고 그 목록이 run에 고정됩니다.
단위마다 **외부 호출은 하나**입니다: `rule` = 입력 읽기 하나(카탈로그 GET 또는 DB 규칙 호출)와 판정, `page` = browser 호출 하나,
`probe` = 렌더러 probe 하나(외부 호출 없음). 실행 중 발견한 대상을 더 읽는 일은 없습니다.

**탐색 page 목록(20개, 고정).**

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

origin은 `https://tomverse.app` 하나입니다. 목록을 바꾸는 것은 정책 변경입니다. 봇 차단이 나온 page는 우회하지 않고 목록에서
빼는 것을 먼저 검토합니다.

**탐색 대상과 제출 대상.** 탐색 대상은 production뿐입니다(dev·Test는 호스트 전체가 Cloudflare Access 뒤에 있습니다). 제출 대상은
walker가 배포된 환경의 앱입니다. shadow(§20)에서는 staging walker가 production 공개 page와 카탈로그를 보고 Test 앱의 Scout 내부
route로 제출하며, `/api/internal`은 Access 우회 경로라 Access 자격증명이 필요 없습니다(S0에서 확인). DB 규칙(CAT-03·04)은 제출
대상 앱의 DB를 읽으므로 shadow 기간의 그 발견은 Test DB에 대한 것이고 Admin이 환경을 표시합니다. 게스트 분석 이벤트는 동의가
있어야 저장되고 동의 요청은 abort되므로, 탐색은 제품 분석 이벤트를 남기지 않습니다(요청 로그와 per-IP read budget에는 남습니다).

**렌더러 probe.** 형식마다 코드에 고정된 합성 명세(한글·영문 혼합 제목, 긴 표, 긴 단어, 여러 쪽)와 기대 범위(파일 크기, 쪽·슬라이드
수, 반드시 있어야 할 part)를 둡니다. 명세는 `admit*Spec()`을 먼저 통과해야 하며, 통과하지 못하면 probe 정의 오류로 run 실패이고
발견이 아닙니다. 검사는 zip·OOXML part 존재, PDF parse, PDF 글꼴과 한글 포함 여부, PDF 래스터의 텍스트 위치이며, Office 파일을
렌더하지 않습니다. 파일과 래스터는 walker 메모리에서만 다루며 저장하지 않습니다.

## 13. 실행 위치, 자격증명, 시간 상한 (개선 탐색)

| 주체 | 위치 | 가진 자격증명 | 외부 코드 실행 | 시간 상한 |
|---|---|---|---|---|
| walker | Agent 전용 Railway project의 cron, 매일 18:00 UTC, `restartPolicyType` `NEVER` | 제출 secret 하나 | 없음(자기 이미지 코드와 고정 명세의 렌더러만) | process 45분에 감독 프로세스가 강제 종료 |
| browser 서비스 | 같은 project의 private network 전용 장기 HTTP 서비스(공개 domain 없음) | **없음**(page token 검증용 공개키만) | production 공개 page의 JavaScript(Chromium sandbox 안) | 요청당 60초 강제 종료 |
| Scout maintenance 서비스 | 같은 project의 cron, 매일 03:30 UTC | Scout maintenance secret 하나 | 없음 | process 150초 강제 종료, route client 120초 |
| 앱 route | 본 앱 | 기존 DB 연결, page token 서명 개인키(새 앱 secret) | 없음 | 아래 DB 상한 |

- 어느 서비스에도 제품 DB·GitHub·배포·LLM·provider 자격증명, 로그인 세션, Cloudflare Access 자격증명이 없습니다. walker는
  Chromium을 띄우지 않습니다. 서비스 변수는 walker가 제출 secret과 스위치, Scout maintenance가 그 secret과 스위치, browser
  서비스가 포트·Chromium 실행 값·공개키뿐이며 S0이 이름 목록을 확인합니다.
- **walker와 run 마감:** process 시작 후 2분 안에 run 시작을 받지 못하면 exit 1입니다. 앱·browser 호출마다 남은 시간이 그
  호출의 최대에 5초를 더한 것보다 작으면 그 호출과 이후 호출을 하지 않고 exit 1이며, 그 run은 다음 run 시작이 만료로
  닫습니다(§14).
- **앱에 있는 판정 계산:** DB 규칙, 제출 Guard와 run 성공 판정, 표시·전이 판정, 보존 삭제 Guard, page token 발급과 live 확인. 모두
  결정적이고 LLM이 없으며, 외부 page에서 나온 문자열은 검사의 데이터일 뿐 실행하지 않습니다. 이 중 하나가 LLM이나 외부 텍스트 실행을
  쓰게 되면 그 능력은 자격증명 없는 서비스로 옮깁니다.
- **browser 서비스의 실행 gate(page token):**
  1. walker가 page마다 앱에 page token을 요청합니다(제출 secret). 앱은 kill switch off, Scout 스위치 on, latch 없음, 그 run이
     열려 있고 마감 전일 때만 발급합니다.
  2. token은 앱의 Ed25519 개인키로 서명한 `{runId, pageId, exp}`이고 `exp = min(발급 + 90초, run 마감)`입니다. nonce는 없습니다.
     같은 network의 다른 서비스는 제출 secret이 없어 token을 얻을 수 없고, 가로챈 token을 다시 써도 아래 live 확인이 같은
     조건을 요구하므로 할 수 있는 일은 `exp`가 지나기 전, 그 run이 열린 동안 같은 공개 page를 다시 읽는 것뿐이며 그 횟수도 browser
     서비스의 동시 1개·시간당 60개 상한에 묶이기 때문입니다.
  3. browser 서비스는 공개키로 서명을, 그리고 `pageId` 일치와 `exp`(자기 시계 기준, 허용 오차 5초)를 검증합니다.
  4. **Chromium을 띄우기 직전에** 그 token을 앱의 page permit route(`POST`, token이 곧 인증)로 보내 그 순간의 kill switch·스위치·
     latch·run 상태·마감을 다시 확인받고, `go`가 아니거나 응답이 없으면 띄우지 않습니다. 그래서 kill switch를 켠 뒤에는 새 page가
     시작되지 않으며, 확인 직후에 켜졌다면 그 page 하나만 끝까지 돌고 그 결과의 제출은 거절됩니다.
  5. 서명 키 교체는 운영자가 앱의 개인키와 browser 서비스의 공개키를 함께 바꾸는 것이며, 교체 사이의 token은 거절됩니다.
- **browser 서비스의 규칙:** 입력은 page id와 page token뿐이고 URL은 받지 않습니다(page id → URL 표는 이미지 코드에 고정, 모르는 id
  거절). 요청마다 새 browser context를 만들고 닫습니다. 그 page URL로만 navigate하고 클릭·입력·form 제출을 하지 않습니다(320px
  검사는 viewport 변경). 모든 요청은 interception을 지나며 **GET·HEAD 밖 method와 허용 밖 origin을 abort**하고(허용 origin은
  `https://tomverse.app`과 S0에서 확정하는 first-party 정적 자원 origin), redirect의 최종 URL도 검사하며, WebSocket·service worker·
  다운로드·권한 요청을 막습니다. abort는 method·origin별 수만 응답하고, abort 때문에 생긴 콘솔 오류는 UI-02에서 뺍니다. sandbox가
  켜지지 않으면 실행하지 않습니다(sandbox를 끄는 인자는 정적 검사로 금지). page 원문과 콘솔 문장은 응답에 싣지 않습니다(해시·규칙
  id·숫자만). 동시 요청 1개, 시간당 60개를 서비스가 직접 강제하며, 스스로 아무것도 시작하지 않습니다. Node 쪽 fetch 대상은 앱
  page permit route 하나입니다.
- **walker의 응답 처리:** browser 서비스의 응답은 신뢰하지 않는 데이터이며 strict schema·길이·정규화·secret 검사를 통과한 값만
  제출합니다. 어떤 값도 실행·평가하거나 URL로 쓰지 않습니다. walker의 fetch 대상은 상수(공개 카탈로그 URL, browser 서비스 주소,
  앱 Scout route)로 정적 검사합니다.
- **단위의 시간 상한(앱 확인 호출 포함):** 단위 = 앱 확인 호출 하나(`rule`·`probe`는 상태 GET, `page`는 page token 발급, 둘 다
  client 5초) + 외부 호출 하나(카탈로그 GET 20초, DB 규칙 호출 20초, browser 호출 75초) 또는 렌더러 probe(120초). 단위 상한은
  `rule` 25초, `page` 80초, `probe` 125초이고, run의 남은 시간이 단위 상한 + 5초보다 작으면 그 단위를 시작하지 않습니다.
- **slot:** 매일 18:00:00 UTC instant(DB CHECK), 시작 창 `[slot, slot + 1시간)`. slot은 run 시작 때 DB가 계산하며 호출자는 보낼 수
  없고, **slot당 run 행은 하나**입니다(slot unique 제약, `runRequestId`도 unique). 같은 `runRequestId`의 재요청은 기존 run을
  돌려주고, 같은 slot에 다른 `runRequestId`로 온 시작은 행을 만들지 않고 거절합니다(§14). run 마감 `deadlineAt` = DB 시계로
  시작 + 40분이며 process 강제 종료(45분)보다 앞섭니다. run에 속한 쓰기(발견·관측 묶음, run 종료)는 마감 뒤면 삽입 때와 COMMIT
  때(commit 예비시간 200 ms) DB가 거절합니다. **예외는 다음 run 시작이 쓰는 만료 전이 하나**이며, 그 전이는 같은 트랜잭션의 만료
  사건과 감사가 있어야 받아들여집니다(§14 판정 2).
- **앱 route의 시간:** 트랜잭션 첫 문장에서 `statement_timeout` 2초, `idle_in_transaction_session_timeout` 1초를 local로 두고,
  PostgreSQL 17 이상에서만 `transaction_timeout`을 연산별 값으로 둡니다. 연산마다 문장 수 A를 고정하고 앱이 유도한 최대는 3A+5초이며
  (DB 강제가 아님), A는 statement budget 테스트로 고정합니다. 가장 작은 연산도 A = 2(11초)이므로 statement·idle 상한은 언제나
  `transaction_timeout`보다 짧습니다. PostgreSQL 16의 트랜잭션 점유와 17의 `BEGIN`~`SET`·COMMIT durable 구간은 묶이지 않습니다.
  배포 PostgreSQL 버전은 S0에서 운영자가 읽어 기록합니다. DB가 반드시 강제하는 것은 하나, **늦은 run은 성공으로 기록되지
  않는다**입니다(위 slot 항목).
- **결과 불명:** run 시작은 walker가 만든 `runRequestId`, 발견 묶음은 `batchId`를 싣고, 응답이 불명이면 그 id로 한 번 read-back한
  뒤 확정되지 않으면 더 보내지 않고 멈춥니다. 다음 run 시작이 §14의 판정으로 latch를 겁니다.

## 14. 저장, 상태, 보존 (개선 탐색)

모든 표는 본 앱 DB에 두고 단일 writer만 씁니다. 시간은 모두 DB 시계입니다. 표에 사람을 식별하는 열이 없습니다(사람 행위자는 각
사건이 가리키는 감사 행에만 있습니다). 사용자 콘텐츠가 없으므로 data-domain registry 대상이 아닙니다.

**같은 트랜잭션 감사.** 모든 상태 변경은 같은 트랜잭션의 사건 행에 결속됩니다. 사건 행은 감사 행을 unique FK로 가리키고, trigger가
그 감사 행이 같은 트랜잭션에서 쓰였는지와 action·target·actor 종류를 확인합니다. run 행은 사건을 FK로 갖지 않고, COMMIT 때 deferred
trigger가 같은 트랜잭션의 시작·종료·만료 사건을 확인합니다.

**run의 성공 계약(DB가 강제).** run 종료가 `succeeded`이려면 선언 단위마다 결과 행이 있고 모두 `completed`이며, 단위마다 저장된
관측 수가 그 단위 결과가 말한 수와 같고, 관측 수 상한 초과가 0이어야 합니다. 아니면 `failed`만 기록됩니다. 관측 수 상한(run당
묶음 20개 × 50건)에 닿으면 잘라내지 않고 그 run을 `failed`로 끝냅니다. 카탈로그 버전이 앱과 다르면 그 run은 `failed`입니다.

**run 시작 판정.** 같은 `runRequestId`의 재요청은 판정 전에 기존 run을 돌려줍니다(결과 불명 뒤의 read-back과 같은 답). 그 밖의
시작은 run 시작 route가 감사 체인 lock을 잡은 뒤 같은 트랜잭션에서 차례로 봅니다. **먼저**, 지금 slot에 run 행이 이미 있으면 아래
판정 0~4를 보기 전에 새 행을 만들지 않고 거절하며 latch도 쓰지 않습니다(slot unique 제약이 DB에서 같은 것을 강제). 같은 slot의
재시도가 latch를 부르지 않게 하기 위해서이며, 그래서 하루에 시작되는 run은 많아야 하나입니다.

0. owner의 Scout 활성화 기록이 없으면 거절합니다. 첫 run은 활성화 시각보다 엄격히 뒤에 시작하는 첫 slot(`effectiveFirstSlot`)부터
   받습니다.
1. latch가 지금 set이거나, 지금 slot의 시작 창 안에서 latch가 한 번이라도 set이었으면 거절합니다.
2. 마감이 지난 `open` run이 있으면 가장 오래된 하나를 `expired`로 닫고 latch를 걸고 거절합니다. 만료의 이유는 구분하지 않습니다.
3. `effectiveFirstSlot`부터 직전 slot까지 **설명되지 않은 slot**이 있으면 가장 오래된 것을 이유로 latch를 걸고 거절합니다. slot이
   설명되는 경우는 넷뿐입니다: run 행이 있음, kill switch가 그 slot의 시작 창 전체 동안 켜져 있었음, 그 slot을 이유로 건 latch가
   이후 해제됨, 그 slot의 시작 창 안에서 latch가 한 번이라도 set이었음.
4. 기준점(가장 최근 latch 해제, 없으면 `effectiveFirstSlot`) 뒤의 run 중 마지막 세 개가 모두 `failed`이면 latch를 걸고 거절합니다.
5. 그 밖이면 시작합니다.

**발견과 fingerprint.** 발견의 fingerprint는 (규칙 id, 규칙 버전, 환경, 대상 id, 정규화 관측 digest)의 digest이고 unique입니다.
정규화 관측 digest는 그 규칙의 schema가 **식별 field**로 지정한 값만으로 계산하며, run id·관측 시각·관측 횟수·응답 시간처럼
회차마다 달라지는 값은 넣지 않습니다. 식별 field 목록은 규칙 정의(코드)의 일부이고, 그 목록이나 판정을 바꾸면 규칙 버전이
오릅니다. 그래서 같은 문제는 매일 같은 발견에 관측만 더하고(한 run에서 한 발견의 관측은 하나, (발견, run) unique), 식별 field의
값이 달라진 근거는 새 발견이 됩니다.

**사람의 결정.** 사람의 결정은 발견마다 순번이 붙는 append-only 사건이며 허용
전이는 직전 사건 종류만으로 정합니다: 없음 → 거절·보류·채택, 보류 → 거절·보류·채택, 채택 → 연결, 거절·연결 → 없음. 표시와
거절·보류·채택은 **성공 run의 관측이 있는 발견**에만 허용됩니다. 연결은 직전 사건이 채택인지로만 판정하므로 관측이 만료된 뒤에도
할 수 있고, 앱은 그 AMUX idea id의 `AmuxIdeaSubmission` 행이 있고 그 제출자가 연결하는 owner와 같은지 확인합니다. 거절한 발견은
다시 올리지 않으며, 근거가 바뀌면 fingerprint가 바뀌어 새 발견이 됩니다.

**사람 쓰기의 멱등.** 사람의 모든 쓰기(발견 결정, latch 해제, kill switch·Scout 활성화 제어 행)는 Admin이 만든 `requestId`를
싣습니다. 같은 id의 재요청은 같은 내용·같은 사람일 때만 기존 행을 돌려주고 아니면 거절하며, 응답이 불명이면 Admin이 그 id로
read-back을 보여 줍니다. latch와 제어 행은 `version`이 1씩 늘어나는 append-only 표이며 가장 큰 `version`이 상태입니다.

**채택과 intake 초안.** 채택은 같은 트랜잭션에서 결정 사건, 사람 감사, intake 초안(템플릿 버전, 본문 4 KiB 이하, 본문 sha256)을
씁니다. 본문은 발견과 그 순간의 성공 관측으로 만든 결정적 템플릿이며 LLM 문장이 아닙니다. 화면은 저장된 본문을 보여 줍니다. 채택은
하루(UTC) 최대 50건이며 DB가 셉니다.

**보존.**

| 대상 | 보존 | 삭제 |
|---|---|---|
| 관측 값 | 관측 시각부터 **90일**(insert 때 DB가 정한 `retentionUntil`, 발견 상태와 무관) | Scout maintenance 서비스가 묶음으로 삭제. 회수 불가 |
| intake 초안 본문 | 채택부터 **1년** | 본문만 비우고 digest·버전·사건 연결은 남김. 회수 불가 |
| 발견, run, 선언 단위·단위 결과, 모든 사건·latch·제어 행 | **삭제 경로 없음**. DB가 DELETE를 거절 | 이 행들은 감사 행과 묶이고, 현행 감사 로그도 지우는 경로가 없습니다. 나중에 삭제가 필요하면 별도 정책 개정 |

보존 기간 전의 삭제는 DB가 거절하고, 삭제는 같은 트랜잭션의 보존 사건과 감사를 요구합니다. Scout maintenance 서비스는 매 실행에서
초안 본문 비우기 한 묶음(최대 500행)과 관측 삭제 한 묶음(최대 2,000행)을 이 순서로 각각 별도 트랜잭션에서 처리합니다. 서비스는 매
route 호출에 남은 시간을 싣고, route는 각 트랜잭션을 시작하기 전에 남은 시간이 그 연산의 앱 유도 최대 + 5초보다 작으면 시작하지
않고 그때까지의 결과를 답합니다. 하루 최대 유입(관측 1,000건, 초안 50건)보다 처리량이 커서 밀림이 쌓이지 않고, 남은 것은 다음
실행이 같은 질의로 다시 고릅니다(결과를 모르는 실행을 재시도하지 않음). Scout 스위치가 꺼져 있어도 보존 삭제는 계속하고, kill
switch가 켜진 동안은 미뤄집니다. 관측 기능의 보존 삭제는 기존 공유 maintenance cleanup에 그대로 둡니다(§4).

**침묵 검사.** 마지막 성공 run(없으면 Scout 활성화 시각) 뒤 26시간 동안 성공 run이 없으면 운영 incident를 올립니다(§5와 같은
기준, 감사 기록이 아님). kill switch가 켜진 동안은 멈추고, 해제 뒤에는 `max(마지막 성공, 마지막 kill switch 끄기 시각)`부터 다시
셉니다.

**Scout 스위치를 끄는 것도 slot을 비웁니다.** 스위치는 DB 밖 환경변수라 앱이 그 이력을 알 수 없으므로, 스위치를 꺼 둔 날의 slot은
다음 run 시작에서 설명되지 않은 slot이 되어 latch가 걸립니다. 운영자가 확인하고 latch를 풀면 됩니다. 멈춘 동안 slot을 비우지 않으려면
kill switch를 씁니다.

## 15. 감사 (개선 탐색)

| 기록 | 감사 action | actor |
|---|---|---|
| run 시작·종료·만료 | `product_research.scout.run_started`·`.run_finished`·`.run_expired` | 시스템 `product-research-scout-runner` |
| 발견 묶음 제출 | `product_research.scout.findings_submitted` | 시스템 `product-research-scout-runner` |
| latch 설정 | `product_research.scout.latch_set` | 시스템 `product-research-scout-runner` |
| 보존 삭제·본문 비우기 | `product_research.scout.retention_purged` | 시스템 `product-research-scout-maintenance` |
| latch 해제 | `product_research.scout.latch_released` | 사람(owner) |
| 발견 거절·보류·채택·연결 | `product_research.finding.dismissed`·`.snoozed`·`.adopted`·`.linked` | 사람 |
| Scout 활성화 | `product_research.scout.activated` | 사람(owner) |
| kill switch 켜기·끄기 | `product_research.kill_switch.on`·`.off` | 사람(owner) |

시스템 actor 둘은 닫힌 목록에 추가합니다. 한 상태 변경에 감사 행 하나이며, 감사 metadata에 관측 값·문안을 싣지 않습니다.

## 16. Admin과 채택

- 공통 Agent digest 영역의 이 Agent 섹션 안에 관측 표와 **분리된 "개선 제안" 하위 섹션**을 둡니다(별도 component). 관측 표의
  "추천 아님" 계약은 그대로입니다.
- **권한:** 모든 변경 route가 권한과 최근 step-up을 route 안에서 직접 검사합니다. 거절·보류·채택은 새 권한
  `product-research:write`(owner·ops). 연결·latch 해제·kill switch·Scout 활성화는 owner만. step-up이 거절되면 되돌아갈 링크를
  보여 줍니다.
- **표시:** 열린 발견(성공 run의 관측이 있고, 결정이 없거나 보류 기한이 지난 것)을 계열(CAT → RND → UI), 성공 관측의 최초 시각,
  fingerprint 순으로 정렬해 **앞의 10개**만 보이고 나머지는 수만 표시합니다. 규칙별 최근 14일 채택률(분모: 그 기간 거절·채택 수,
  분모 0이면 `insufficient_evidence`)을 보입니다.
- **채택 흐름:** 채택 → 저장된 intake 문안과 복사 버튼, v4 아이디어 입력 화면 링크 → owner가 v4 화면에서 직접 제출(v4의 권한·
  step-up·gate·rate limit·결과 불명 처리가 그대로 적용) → 원하면 owner가 AMUX idea id를 연결. 이 Agent는 v4 제출 경로에 끼어들지
  않으며, v4 분석 실행은 회차마다 운영자 확인이 필요합니다.

## 17. 스위치, kill switch, latch

| 장치 | 위치 | 효과 |
|---|---|---|
| `PRODUCT_RESEARCH_SCOUT_ENABLED` | walker 서비스 변수 + 앱 환경변수 | 개선 탐색 활동의 스위치. 꺼짐은 unset·빈 문자열뿐(§6과 같은 해석) |
| Agent 전체 kill switch | 앱 DB의 제어 사건 표(가장 큰 version의 kill 종류 행). owner가 Admin에서 step-up과 사람 감사로 변경 | 아래 행렬. 관측 기능에도 적용(§6) |
| latch | 앱 DB의 latch 사건 표 | §14 run 시작 판정이 set. 해제는 owner가 step-up과 사람 감사로만. 자동 복귀 없음 |
| Scout maintenance 서비스 스위치 | 그 서비스 변수 | 그 서비스의 실행만 제어. Scout 스위치와 무관하며, 꺼 둔 동안 밀린 보존 삭제는 다시 켠 뒤 처리(꺼짐 해석은 §6과 같음) |

| 동작 | kill switch on | Scout 스위치 off | latch set |
|---|---|---|---|
| walker 실행 | ✗ | ✗ | ✗ |
| page token 발급, browser live 확인 | ✗(새 page 없음) | ✗ | ✗ |
| Scout 제출 route | ✗(본문 전 거절) | ✗(404) | run 시작 ✗, 열린 run의 제출·종료·read-back ✓ |
| 관측 기능 서비스·제출 route | ✗ | ✓ | ✓ |
| Scout maintenance 서비스(보존 삭제) | ✗(해제 뒤 처리) | ✓(기존 데이터 정리는 계속) | ✓ |
| 관측 보존 삭제 | ✗(해제 뒤 처리, §4) | ✓ | ✓ |
| 관측·개선 탐색 침묵 검사 | ✗(해제 뒤 기준 재설정, §5·§14) | ✓ | ✓ |
| Admin 기록 열람 | ✓ | 관측 ✓, 개선 제안은 꺼짐 안내 | ✓ |
| Admin 사람 결정(보류·거절·채택·연결) | ✗ | ✗ | ✓ |
| Admin latch 해제(owner) | ✗ | ✗ | ✓ |
| Admin Scout 활성화(owner, 한 번) | ✗ | ✓ | ✓ |
| **Admin kill switch 변경(owner)** | **✓** | ✓ | ✓ |

**kill switch 변경 route는 kill switch가 거절하지 않는 유일한 쓰기입니다.** 사람이 건 정지는 사람이 풀어야 하기 때문입니다.
kill switch는 모두 멈추고, 기능 스위치는 그 기능의 활동만 멈춥니다.

- **확인 시점:** walker는 각 단위의 외부 호출과 각 제출 직전마다 앱 확인 호출(상태 GET, `page`는 page token 발급)을 하고, `go`가
  아니면 남은 호출을 하지 않고 run 종료도 보내지 않은 채 끝냅니다. kill switch가 켜진 뒤 끝까지 가는 것은 진행 중이던 외부 호출 하나뿐이며
  그 결과는 제출되지 않습니다. 그 run은 다음 시작이 만료로 닫고 latch를 걸며, kill switch를 끈 뒤 owner가 latch를 한 번 풀면 다음
  slot부터 돕니다.
- **직렬화:** Agent의 모든 쓰기(관측·개선 탐색 양쪽, 사람 결정, latch, 제어 행)는 첫 lock으로 감사 체인 lock을 잡고 그 뒤 kill switch
  상태를 다시 읽어 on이면 쓰지 않습니다. 각 표의 trigger도 같은 확인을 합니다. 입력을 읽을 수 없으면 kill switch on으로 봅니다.

## 18. 비용 (개선 탐색)

provider·검색·LLM·사용자 크레딧 비용은 0이며, 사용자 크레딧과 Chat provider 예산에 닿지 않습니다. 인프라 비용(세 서비스의 Railway
실행 시간과 전송, DB 저장)은 `agent:product-research`의 인프라 범주이며, 공통 비용 기록의 발행자가 아직 없으므로 "발행자 없음"으로
보고합니다. 구조적 상한: walker 하루 1회 × 45분, browser 요청당 60초 × 시간당 60개, maintenance 하루 1회 × 150초, 관측 run당 약
4 MiB. 운영자가 Railway 사용량을 대시보드에서 보며 이는 경보 기준이지 자동 차단 수단이 아닙니다.

## 19. 개인정보 (APP, 개선 탐색)

개선 탐색이 저장하는 것은 규칙 id, 모델 id, URL path, 상태 코드, axe 규칙 id, 해시, 글꼴 이름, 수치, 그리고 그것으로 만든 intake
문안입니다. 화면 이미지와 page 원문을 저장하지 않고, 문자열은 정규화·길이 제한·secret 검사를 거치며, Admin 권한으로만 보입니다.
운영자 식별은 기존 감사 로그에만 있습니다. 새 외부 처리자가 없습니다(Railway, Cloudflare는 제품이 이미 쓰는 처리자). 이 정책의 승인
PR에 운영자가 APP 3·5·8 확인값을 개선 탐색에 대해서도 적습니다(§8과 같은 형식).

## 20. 단계와 차단 기준 (개선 탐색)

차단 기준은 "틀렸을 때 되돌릴 수 없는가"입니다. 개선 탐색에서 회수 불가인 것은 §14의 두 보존 삭제뿐이며, 그 기간은 이 정책이
정합니다. 나머지 잘못은 스위치나 kill switch로 멈추고 고쳐서 배포하면 끝납니다. (13)이 SC1을 막는 이유는 회수 불가 삭제 경로가
secret 범위와 남은 시간 확인을 갖추기 전에는 저장을 시작하지 않기 위해서입니다.

| 단계 | 내용 | 다음 단계 조건 |
|---|---|---|
| 정책 | 이 문서 v2 승인 | 승인 판정 전부 통과, APP 기록 존재 |
| S0 | 아래 13개 측정 | 운영자 서명. (1)·(2) 실패 → 해당 계열 보류, (3) 차단 → 탐색 보류, (4)·(9)·(11) 실패 → UI 계열 보류, **(13) 실패 → SC1 보류** |
| SC1 | 표·migration(스위치 기본 off, trigger)·store·route·Admin 하위 섹션·채택 흐름·제어 행(kill switch·Scout 활성화)·latch·Scout maintenance 서비스와 route, 관측 기능의 v2 변경(상태 GET, kill switch 직렬화, 보존 지연, 침묵 정지), CAT 규칙 | fixture 통과, shadow 7 slot 관찰에서 운영자가 발견 수와 소음을 확인해 서명 |
| SC2 | browser 서비스와 UI 규칙, 렌더러 probe | fixture 통과, shadow 7 slot 관찰, 운영자 서명 |
| production | production 앱으로 제출, 스위치 on | SC2 서명 |

**S0 측정:** (1) Railway에서 walker 이미지 크기·run 시간; (2) 렌더러 probe와 검사 도구가 walker 이미지에서 동작; (3) production 공개
page가 봇 차단을 내는지; (4) browser interception이 GET·HEAD 밖 method, 허용 밖 origin, redirect, WebSocket을 실제로 막는지
(fixture page), first-party 정적 자원 origin 목록 확정; (5) walker 서비스 변수 이름이 제출 secret과 스위치뿐인지; (6) 공개 카탈로그
per-IP read budget과 충돌하지 않는지; (7) Test 앱의 `/api/internal` Scout route가 Access 자격증명 없이 닿는지; (8) 운영자가 production
PostgreSQL 버전을 읽어 기록; (9) browser 서비스 변수에 secret이 없고, token 없이·서명 불일치·만료·다른 page id이거나 live 확인이
`go`가 아니면 Chromium을 띄우지 않는지; (10) browser 서비스의 상시 실행과 유휴 sleep의 cold start·비용; (11) Railway 컨테이너에서
Chromium sandbox가 켜지는지; (12) browser 서비스가 private network로만 닿고 공개 domain이 없는지; (13) Scout maintenance 서비스 변수가
그 secret과 스위치뿐이고, route가 남은 시간이 부족하면 트랜잭션을 시작하지 않는지. 언어(`ko`) page가 실제로 그 언어로 렌더되는지도
(3)에서 함께 봅니다.

이 숫자를 바꾸는 것은 정책 변경입니다. 단계 전환 판정과 서명은 운영자가 하며, 이 정책 승인이 전환을 대신하지 않습니다.

## 21. 보류 기능 — 이 정책은 승인하지 않습니다

아래는 v2에 들어 있지 않고, 열려면 정책 개정과 독립 검토가 따로 필요합니다. 순서는 v2 운영(SC2 서명) 뒤에 정합니다.

| # | 기능 | 먼저 필요한 것 |
|---|---|---|
| B0 | production 밖(dev·Test) 화면 탐색 | Access용 새 자격증명과 Access 정책 변경(운영자 결정) |
| B1 | 로그인 탐색 | Scout 계정 인증 방식 결정과 독립 보안 검토, B0 |
| B2 | 모델·이미지 생성까지 포함한 유료 probe | Agent 비용을 사용자 크레딧·Chat provider 예산과 실제로 분리하는 방법(제품의 Agent 주체 예산 또는 공통 기반 예외), 모델 생성 파일을 secret 없는 서비스에서 처리, probe 목록·월 상한의 사람 승인, B1 |
| B3 | LLM 품질 평가 | 공통 기반의 외부 텍스트 원칙에 대한 좁은 예외(공급사·모델·rubric·전송 범위·상한), §2-1의 범위 축소 |
| B4 | 채택 한 번으로 intake v4 저장 | AMUX intake의 계약 변경(공용 admission, 미리 정한 id 또는 digest 계약, 출처 field) |
| B5 | page에서 찾은 링크 확인 | 실행 전에 대상이 고정되는 단위 설계 |
