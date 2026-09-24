# Chat 저장 후 미전송 notice 후속 독립 검토 승인 기록

- approvedBy: `mposition` (현재 대화의 권장 순서 자동 개발과 Cursor CLI 독립 검토 지시)
- approvedAt: `2026-09-24` (Australia/Brisbane)
- author: `codex`
- independentReviewer: `cursor-cli`
- task: [task.json](./task.json)

원 `chat-history-pagination-recovery-v1` exchange는 round 2에서 `approve`와
재현 가능한 지적 세 건을 남겼고 수정 round가 소진돼
`on_hold(revisions_exhausted)`로 종료됐다. 이 후속 작업은 그 기록을 재개하거나
변경하지 않는다. 원 exchange의 첫 두 제품 지적만 별도 successor로 상속하며,
Linux visual base 대조 증거 지적은 제품 source 수정과 다른 검증 작업이므로 이
package에서 제품 수정으로 소급하지 않는다. 다만 이후 확보된 canonical Linux
증거는 이 successor에 그대로 기록한다: exact base
`ad2b51622992c29056706c443d80bdba928336e1`의 run `35954859255`와 feature
source head `93b18c8f37be46cbfce47658cc638e77aa008d63`의 run `35700992823`은 모두
Loading 표본 9/9 통과, 전체 27 통과/54 실패로 동일했다. 따라서 그 54건은 이
feature 이전에도 존재했으며 이 successor의 회귀 증거가 아니다.

제품 source lineage는
`93b18c8f37be46cbfce47658cc638e77aa008d63`이다. 이 successor의 package 비교
base는 그 직계 후속 audit-only commit
`bef622a565468fb9857639bc4ef24171c2c57a5f`이며, 해당 commit은 원 v1의
`authorization.md`와 `records/`만 추가하고 제품 source는 변경하지 않는다. 따라서
검토 변경 범위는 durable Message의 saved-but-undispatched notice를 identity와
originating conversation에 결속하는 아홉 제품·테스트 파일, 이 successor의
`task.json`과 `authorization.md`, 로컬 무과금 검증 및 Cursor CLI의 읽기 전용 독립
검토다. prompt payload, attachment, admission token 또는 context bundle을 conversation
전환 너머에 보관하지 않으며 provider 요청을 자동 재생하지 않는다.

사용자는 독립 검토가 필요할 때 Cursor CLI를 사용하도록 지시했고
`--skip-preflight` 예외도 승인했다. Reviewer는 repository와 package를 읽기
전용으로 검토하고 package digest에 verdict를 결속한다. Cursor CLI 외의 유료
provider API, 실제 Chat provider 호출, Railway staging/production 접근,
feature flag 변경, 실제 사용자 traffic, push·PR 병합·배포는 승인 범위 밖이다.

## 구현 결정

- durable 저장 여부는 명시적인 save receipt 뒤에만 `true`가 된다. payload 존재만
  보고 saved notice를 만들지 않으므로 guest 및 legacy save-failure 경로는 제외된다.
- 대화 전환을 넘는 것은 identity, conversation id, opaque turn/message id,
  selection ticket뿐이다. prompt와 실행 권한은 보관하지 않는다.
- provider 시작 여부는 `processedPromptKeys`가 아니라 `/api/chat` fetch 직전의
  callback으로 확인한다. 시작 callback은 pending receipt와 동일 opaque turn의
  저장된 disposition을 제거해, 늦은 receipt 뒤 실제 dispatch가 시작된 경우의
  false notice를 막는다. 이후 다른 sibling panel의 cleanup이 같은 turn을 보고해도
  provider-start set을 먼저 확인하고 exact persisted key를 제거한 뒤 종료하므로,
  이미 시작된 provider 요청이 다시 undispatched로 분류되지 않는다.
- 대화 선택 epoch와 URL surface의 실제 target을 동기적으로 기록해 A→B→A 및
  늦은 cleanup을 구분한다. notice는 origin conversation 선택 시 소비하고
  sessionStorage에서도 제거한다.
- identity epoch는 대화 선택 ticket과 별도이며 page tree 교체를 넘어 browser-realm에서
  단조 증가한다. submit, prompt payload 및 model-only panel callback은 시작 epoch를
  캡처하고, durable-accepted/disposition/provider-start callback은 active identity,
  현재 namespace, submit fence의 identity key와 epoch가 모두 일치할 때만 상태를
  바꾼다. loading/unresolved 경계에서 submit fence key가 null이 된 경우도 old A
  callback을 승인하지 않는다. 따라서 account A로 돌아왔더라도 이전 A epoch의 늦은
  Message 응답은 저장된 notice나 toast를 만들지 않는다.
- browser identity fence는 React render가 아니라 layout commit에서만 채택한다. SSR은
  module-global active fence를 읽거나 쓰지 않으므로 같은 worker의 순차·동시 A/B render가
  다른 요청의 account namespace를 관측하거나 browser epoch를 소비하지 않는다.
- sessionStorage의 bounded owner marker는 ChatPage가 완전히 unmount된 동안 일어난
  identity 변경도 관측한다. 같은 identity의 새 tree는 opaque disposition을 복구하지만
  다른 identity의 최초 mount는 이전 disposition을 fail-closed로 제거하고 marker를
  새 identity로 다시 결속한다. marker에는 prompt나 실행 권한이 없다.
- 비동기 conversation lookup을 무효화하는 navigation-attempt ticket과 실제 선택을
  소유하는 committed ticket을 분리했다. committed ticket은 ownership, lock 및 surface
  검증이 끝난 뒤 실제 currentChat/router transition 직전에만 증가하므로 locked row를
  열었다 취소하는 행위는 A의 pending turn을 abandon하지 않는다.
- disposition 변경은 매번 최신 sessionStorage를 기준으로 적용하고 memory set을 그
  결과로 교체한다. 따라서 hydrate 전 add가 기존 key를 덮거나 stale closure가 이미
  소비된 key를 되살리지 않는다. memory/storage/pending registry는 모두 64개로
  제한하며 identity 전환 clear만 의도적으로 merge하지 않는다.
- 같은 window에서는 `storage` event가 발생하지 않으므로 prompt-free change event가
  활성 tree에 재확인을 요청한다. locked target의 취소는 실제 대화 전환이 아니므로
  disposition 승격은 lock/ownership/surface 검증 뒤 route/selection 직전에만 한다.
- global Message commit 응답이 같은 identity의 conversation/ticket 전환 뒤 도착하면
  departing selection이 나중에 승격할 pending entry를 만들지 않고 즉시 opaque
  disposition을 저장하고 change event를 보낸다. 새 conversation은 accepted Message가
  server id를 채택할 때까지 `new` origin을 current로 보는 기존
  `chatPreparedSendIsCurrent(false)` 계약을 그대로 사용한다.
- URL에서 넘겨받은 최초 conversation id는 실제 client selection이 그 id에 도달할
  때까지만 disposition 소비를 막는다. handoff가 settled된 뒤에는 보존된 초기 prop이
  이후 B의 origin notice를 영구 차단하지 않는다. locked target의 unlock 취소,
  owned 목록에 없는 target 및 사용자가 선택한 fallback도 handoff의 terminal
  abandoned 결과로 기록해, 실패한 URL target이 이후 conversation notice를 영구
  차단하지 않는다.
- global composer의 durable Message 이후 current 판정은 Chat뿐 아니라 Review 등 모든
  surface에서 캡처한 conversation id와 committed selection ticket을 먼저 비교한다.
  Review의 multi-model 계약은 Chat 전용 single-model helper와 분리하지만 A→B→A 뒤의
  늦은 commit이 provider payload를 발행할 권한은 주지 않는다.
- `conversation-left` cleanup은 origin id와 committed ticket이 아직 같더라도 opaque
  disposition을 먼저 저장한다. 단, 동일한 durable prompt payload가 이 tree에 계속
  mount돼 있고 provider가 시작되지 않은 responsive remount에서는 그 exact key만
  소비하지 않는다. payload가 full unmount 또는 active-row 재선택으로 사라지면 같은
  conversation에서 notice를 한 번 소비한다.
- continuation의 New Chat은 route를 떠나기 전에 current pending durable turns를
  disposition으로 승격한다. loopback-only deterministic barrier로 durable commit 뒤
  `onBeforeModelSend`가 대기하는 경계를 재현해, 새 Chat 이동 뒤 provider POST가 없고
  continuation 재진입에서 notice가 한 번 표시됨을 확인한다.
- App Router가 Chat/Review 사이에서 client tree를 보존할 수 있으므로 URL handoff는
  이미 열린 client conversation보다 먼저 적용한다. 한 번 적용했다는 boolean 대신
  적용한 conversation id를 기록하고 URL이 이름 없는 상태를 거치면 re-arm한다.
  ownership, lock 및 surface 검사는 계속 `handleSelectConversation` 경로가 수행한다.

## 검증 및 잔여 범위

fresh production build 뒤 history/context response 경합, 전역 durable-undispatched와
late commit response, Review model-only cross-surface, locked-selection 취소, rapid
conversation A→B→A, identity A→B/A→B→A 및 full-unmount identity handoff 경합
focused E2E는 desktop/mobile Chromium에서 38/38 통과했다. 여기에는 최초 URL A
handoff가 settled된 뒤 B의 늦은 disposition을 B에서 한 번 소비하는 회귀와 Review
전역 composer의 late commit 뒤 A→B→A에서 provider dispatch 0건·A notice 1건을
확인하는 회귀, locked initial URL handoff 취소 및 missing/unowned initial URL
handoff 뒤 B의 disposition이 B에서 한 번 소비되는 회귀, same-conversation full
unmount 및 active-row 재선택 뒤 notice 1건, continuation New Chat 뒤 origin notice
1건·provider dispatch 0건이 포함된다. Review와 continuation의 다중 panel 회귀는
첫 panel의 실제 provider POST 뒤 둘째 panel의 cleanup을 실행해 provider POST 1건,
savedQuestionNotSent notice 0건, persisted disposition 0건을 desktop/mobile에서
각각 확인한다. 고정 200ms sleep은
fixture의 context/Message response-settled 상태 poll로 교체했다. 각
유형의 assertion은 다음과 같이 다르다. Chat/Review abandonment는 다른 conversation의
notice 0건, origin notice 1건, saved question provider dispatch 0건과 해당 테스트가
확인하는 durable Message 1건을 검증한다. late global commit은 B notice 0건,
첫 origin 복귀 notice 1건, provider dispatch 0건과 durable Message 1건을 검증한다.
lock 취소는 notice 0건과 current
conversation 불변을 검증하며 durable count는 assertion하지 않는다. same-identity
rapid conversation A→B→A는 origin notice 1건과 provider dispatch 0건을 검증한다.
identity A→B/A→B→A는 old identity notice 0건과 old prompt provider dispatch
0건을 검증한다. full-unmount A disposition→B mount→A mount는 persisted A
disposition이 B mount에서 제거되고 돌아온 A에서 old notice/provider dispatch가
0건임을 검증한다. Review 경합은 surface handoff가 언어 query를 보존하지 않는 기존
동작 때문에 도착 locale의 동일 i18n copy를 검사하며, notice event와 화면 toast를
함께 확인한다. `npm run
typecheck`, 변경 아홉 파일 scoped ESLint, production build 및 `git diff --check`도
통과했고 bounded storage/owner 및 SSR/unresolved identity unit은 13/13 통과했다. 독립 Cursor CLI 검토 결과는 source와
package digest를 고정한 뒤 별도 record에 결속한다.

이 successor는 sidebar/URL surface 선택과 responsive remount 경계를 다룬다.
conversation 삭제 때 남은 opaque notice를 즉시 purge하는 별도 UX와 모든 guest
negative path의 확대 행렬은 새 제품 동작을 요구하므로 이 task의 pass 조건으로
간주하지 않는다. 삭제된 id는 다시 선택될 수 없어 notice가 노출되거나 provider
호출로 바뀌지 않으며, 보관량은 64개로 제한된다.

이 successor의 새 `records/`만 package 명령의 동일한 exact `--out` 및
`--diff-exclude` 경로로 제외하고 `generatedPaths`에는 넣지 않는다. package round 0은
audit-only base 이후의 아홉 제품·테스트 파일과 이 successor의 `task.json` 및
`authorization.md`를 검토 diff로 포함해야 한다. 범위 밖 파일 변경이나 검사 실패는
우회하지 않는다. 원 v1 package와 `records/`의 바이트 및 상태는 audit-only base에
포함된 선행 기록으로 보존하며 successor 검토 diff나 out 경로로 다시 포함하지 않는다.
