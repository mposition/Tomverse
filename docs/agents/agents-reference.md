# AGENTS.md 상세 원문 (참고용)

2026-10-19 운영자 결정으로 AGENTS.md를 짧은 핵심 규칙과 색인으로 줄였습니다. 이 파일은 그 이전 AGENTS.md의 영역별 상세 규칙 원문입니다. 해당 영역을 고칠 때 필요한 절만 읽습니다. AGENTS.md와 충돌하면 AGENTS.md(특히 "먼저 만들고, 되돌릴 수 없는 것에만 게이트를 둡니다")가 우선합니다.

# 소통 언어

이 저장소에서 작업할 때는 **사용자와의 모든 대화를 한국어로** 진행합니다.
설명, 계획, 작업 결과 보고, 질문, 확인 요청 모두 해당됩니다. 사용자가 영어로
질문하더라도 별도 요청이 없으면 한국어로 답합니다.

한국어로 쓰지 않는 것 — 저장소에 이미 자리 잡은 관례를 따릅니다.

- code identifier, 파일명, `data-testid`, test 제목
- 소스 코드 주석
- commit message, PR 제목과 본문
- 사용자에게 보이는 제품 문구(`locales/*.ts`가 언어별로 관리)

즉, **사람에게 말할 때는 한국어, 저장소에 남기는 코드·이력은 기존 영어 관례**
입니다. `.github/audits/` 아래 감사·작업 보고서처럼 이미 한국어로 작성된
문서는 계속 한국어로 씁니다.

## Development sessions deliver small working changes

For a feature or bug fix, choose the smallest useful behavior within the approved scope, implement it, and run the relevant test or check. Keep investigation and design focused on what is needed for that next code change. Do not substitute policy revisions, plans, or repeated independent reviews for working functionality.

Follow required approvals, policy gates, and independent review for the changes to which they apply. Once those requirements are clear, continue with code that is already authorized. If a decision blocks one change, name the exact blocker and complete another authorized, testable slice when available.

Report implemented and tested behavior separately from documentation, review, merge, and deployment. A plan or review alone is not implementation progress. For an explicitly documentation-only or review-only request, deliver that requested artifact without inventing a code task.

# 먼저 만들고, 되돌릴 수 없는 것에만 게이트를 둡니다

운영자 지시(2026-10-19). Tomverse는 매일 새로운 아이디어가 나오는 스타트업 플랫폼이고 사용자는 아직 거의 없습니다. 매일 새 아이디어를 **동작하는 기능으로 먼저** 보여 주는 것이 일입니다. 정책 개정이 개발 시간의 절반 이상을 쓰는 구조였고, 그것을 끝냅니다. 기본 자세는 공격적인 개발(Frontier Pioneer)입니다.

- **사람의 승인이 필요한 것은 되돌릴 수 없는 일뿐입니다.**
  - 실제 돈이 나가는 것(유료 호출 활성화, 상한 인상)
  - 외부로 나가는 것(게시, 발송)
  - 사용자 데이터 삭제
  - 자격증명과 보안 경계
  - production 병합과 배포
- 그 밖의 설계 결정은 운영자가 대화에서 정하면 끝입니다: 표, 데이터 형식, 상한값, 수집 방식, 서비스 구성, 에이전트의 내부 설계. 구현하고, 결정은 commit이나 PR에 한 줄로 남깁니다. **이런 결정에 정책 개정, 정책 버전 증가, 계획 문서, 사전 승인 기록을 요구하지 않습니다.**
- 정책 문서나 이 파일이 구현 세부(표 개수, 고정 페이지, 목록, 상한)를 적고 있는데 그 세부가 바뀌었다면, 그 서술이 낡은 것입니다. 코드와 같은 PR에서 서술을 고치되 별도 승인이나 버전은 필요 없습니다.
- 위험한 기능은 막지 말고 스위치 뒤에 둡니다. 기본값을 꺼 두고 먼저 배포합니다.
- **LLM이 할 수 있는 일은 LLM 호출로 풉니다(운영자 지시 2026-10-19).** Tomverse는 AI 플랫폼이고, LLM 호출로 개발 범위를 줄이는 것이 나아갈 방향입니다.
  - 웹 검색, 추출, 분류, 문안, 조사, 매칭을 위해 crawler·parser·휴리스틱을 직접 짜지 않습니다.
  - LLM 호출이 대신하는 기존의 손으로 짠 경로는 지웁니다. 코드 줄 수를 줄이는 것 자체가 목표입니다.
  - 결정적 코드는 되돌릴 수 없는 경계에만 둡니다: 비용 상한과 원장, 외부 게시 전 사람 승인, 삭제, 자격증명·보안.
  - 그 경계에서는 LLM 출력에 값싼 확인 하나를 거칩니다(예: 인용 URL이 승인된 host인지).
  - 에이전트를 설계하거나 고칠 때도 같은 기준으로 판단합니다.
- 먼저 만든다고 해서 책임을 넘기는 것이 아닙니다. 시험과, 완성된 diff에 대한 독립 검토 한 번은 그대로입니다.
- 이 절과 다른 절이 충돌하면 이 절이 우선합니다. 이미 있는 계약 중 되돌릴 수 없는 것(과금, 크레딧, 동의, 삭제, release blocker인 UI 계약)을 지키는 조건은 그대로 둡니다.

# 의미 있는 개발 사이클의 완료 보고

작은 오타·단순 문구 수정 같은 소규모 작업을 제외하고, 의미 있는 규모의 Chat
개발 마일스톤을 마칠 때마다 **전체 Chat 진행 상황을 한눈에 볼 수 있게** 보고합니다.

- 승인된 개발계획서의 기능 범위와 분모를 보고 간에 일관되게 사용합니다.
  분모를 바꿨다면 이유를 밝히고, 이전 수치와 그대로 비교하지 않습니다.
- 짧은 상태표나 상태줄로 **전체 진행도 · 이번에 완료한 것 · 남은 핵심 기능**을
  함께 보여 줍니다. 구현·검증·병합·배포 상태는 분리하며 서로를 대신하지 않습니다.
- 백분율은 확인한 기능별 근거로만 계산하고, 잠정 수치에는 **추정**과 산정 기준을
  명시합니다. 근거가 부족하면 산정 보류로 적으며, 정밀한 숫자를 지어내거나
  pending 릴리스 게이트를 곧바로 미구현 0%로 계산하지 않습니다.
- 이전에 같은 기준으로 보고한 값이 있으면 이번 변화량을 함께 적습니다.
- **다음 권장 작업을 우선순위 순서로** 제안하고, 이유·선행 조건·예상 효과를
  간단히 덧붙이며, 별도 승인이나 Claude 독립 검토가 필요한 경우 표시합니다.
  완료 결과와 전체 진행도, 이 다음 작업 제안까지 전달해야 한 사이클의
  완료 보고가 끝납니다.

다음 작업의 추천은 그 작업의 자동 착수, 신규 과금, 병합 또는 배포 승인이 아닙니다.

# 긴 목표는 단계에 묶어 둡니다

여러 사이클에 걸친 큰 목표(기능 활성화, 여러 PR로 나뉜 기능 개발)는 진행 중에
발견한 일에 끌려 원래 목표를 잃기 쉽습니다. 2026-10-10~11 AMUX v22 활성화는
활성화 중 찾은 버그를 차례로 고치느라 활성화 단계가 멈췄고, Chat-01은 규모가
커서 운영자가 틈틈이 지금 어디까지 왔는지를 따로 확인해야 했습니다.

- **진행 중 발견한 버그는 지금 목표의 다음 단계를 막을 때만 고칩니다.** 막지
  않으면 고치지 않고, 그 사이클 완료 보고의 다음 권장 작업에 적은 뒤 원래
  단계로 돌아옵니다. 막는지 판단이 서지 않으면 운영자에게 묻습니다. 되돌릴 수
  없는 피해(유출, 사용자 데이터 손실)가 진행 중이거나 그렇게 될 수 있는 문제(악용
  가능한 보안 취약점 등)는 다음 단계를 막지 않아도 목록으로 미루지 않고 바로
  운영자에게 알립니다.
- **긴 목표의 완료 보고에는 목표 대비 현재 위치를 넣습니다.** 목표 문장, 단계
  체크리스트의 완료 단계/전체, 마지막으로 단계가 진전한 때, 그 이후 어느 단계에도
  속하지 않은 작업의 수입니다. 지금 하는 일이 어느 단계에 속하는지 적고, 어느
  단계에도 속하지 않으면 그렇다고 적습니다. 체크리스트가 없으면 다음 사이클에
  만들어 운영자 확인을 받습니다. 이미 진행 중인 목표도 같습니다.
- **긴 목표에 속한 PR은 본문에 `Goal-Step:` 줄을 정확히 하나 넣습니다**(운영자
  결정 2026-10-12). 목표 ID는 현황판 ID가 있으면 그것을 쓰고, 없으면 운영자가
  정한 ID(영문 대문자·숫자·하이픈, 예: `AMUX-V22-ACT`)를 씁니다. 단계 ID는 영문·
  숫자·`.`·`_`·`-`만 쓰며 공백이 없습니다. 긴 목표에 속하지 않는 PR에는 넣지
  않습니다.

  ```
  Goal-Step: <목표 ID>/<단계 ID>             그 단계의 작업
  Goal-Step: <목표 ID>/<단계 ID> completes   이 PR이 병합되면 그 단계가 끝남
  Goal-Step: <목표 ID>/-                     어느 단계에도 속하지 않는 작업
  Goal-Step: <목표 ID>/op                    운영자의 별도 요청으로 하는 작업
  ```

  곁길을 단계로 적지 않습니다. 이 줄이 목표 대비 위치를 기계가 셀 수 있는 유일한
  근거입니다.

# 실행할 명령을 줄 때는 실행 위치를 먼저 적습니다

**사용자 환경은 Windows + PowerShell입니다.** 명령 블록을 주기 전에, 그 블록
바로 위에 **어디서 실행하는지** 한 줄로 적습니다. 셸 문법으로 암시하지
않습니다 — `$env:`가 PowerShell을 뜻한다는 것은 힌트이지 안내가 아니고,
사용자가 "이거 어디서 실행하나요"를 다시 묻게 되면 그 블록은 실패한 것입니다.

한 줄에 담는 것은 넷입니다.

1. **어느 기계** — 로컬 PC / Railway 서비스 shell / 이 컨테이너(제가 직접 실행)
   / Cloudflare·Stripe 같은 웹 대시보드.
2. **어느 셸** — PowerShell인지 bash인지. 사용자에게 주는 것은 기본이
   PowerShell입니다.
3. **어느 디렉터리** — 저장소 clone 안이라면 그렇게 적습니다.
4. **먼저 있어야 하는 것** — Node 22, `npm ci`, 어떤 환경변수, 어떤 권한의
   토큰인지.

예: `로컬 PC의 PowerShell, Tomverse clone 폴더 안. Node 22와 npm ci가 끝나
있어야 하고, R2 환경변수 4개가 필요합니다.`

## 함께 지키는 것

- **production 자격증명이 필요한지 아닌지를 밝힙니다.** 필요 없으면 "이건
  자격증명 없이 됩니다"라고 적습니다. 사용자가 그걸 모르면 안 해도 될 준비를
  합니다.
- **읽기 전용인지 쓰는지 적습니다.** 쓰는 명령은 무엇이 바뀌는지와 되돌리는
  방법을 같이 적습니다.
- **package.json에 script가 있으면 그 script를 줍니다.** `node`로 풀어 쓰지
  않습니다. script가 들고 있는 플래그가 곧 실행 조건이고, 풀어 쓰는 순간 그것을
  옮겨 적는 일이 사람 손에 넘어갑니다. 2026-08-28에 실제로 그랬습니다 —
  `audit:message-attachments`를 `node --import tsx …`로 풀어 주면서
  `--conditions=react-server`가 빠졌고, 운영자는 `server-only`가 던진 "This
  module cannot be imported from a Client Component module"를 받았습니다. 명령이
  아니라 제 전사(轉寫)가 틀린 것이었습니다.
  풀어 써야 할 이유가 있다면 **package.json에서 플래그를 그대로 복사**하고,
  왜 풀어 쓰는지 한 줄로 적습니다.
- **환경변수는 그 창에서만 산다는 것을 적습니다.** `$env:`는 PowerShell 창을
  닫으면 사라지므로, 이어지는 명령이 같은 창을 전제하면 그렇게 말합니다.
- **대시보드로 끝나는 일이면 스크립트를 주지 않습니다.** Cloudflare R2의
  lifecycle 규칙처럼 화면에서 두 번 클릭할 일에 clone과 `npm ci`를 요구하지
  않습니다. 스크립트는 판정을 자동화하거나 기록을 남길 때 함께 제시합니다.
- **비밀값을 대화에 붙여 달라고 하지 않습니다.** 출력에 자격증명·버킷 이름·
  object key가 없도록 스크립트를 만들고, "결과는 그대로 붙여도 안전합니다"를
  근거와 함께 적습니다.

# Accent colour roles

UI-012에서 승인된 정책(B안)입니다. accent 색은 **hue가 아니라 역할로** 지정합니다.
`app/globals.css`에 역할별 token이 정의돼 있고, `npm run check:accent-tokens`가
아래 규칙을 강제합니다. PR Fast Gate의 static 단계에서 실행됩니다.

## 역할과 token

| 역할 | token 접두사 | 현재 palette |
|---|---|---|
| AI Review | `accent-ai-review-start\|mid\|end-*`, `tomverse-accent-*`, `tomverse-review-*` | cyan → blue → purple |
| Deep Research | `accent-deep-research-*` | violet |
| 이미지 생성 | `accent-image-*` | fuchsia |
| AI 생성 파일 | `accent-generated-artifact-*` | emerald |
| Web Search | `accent-web-search-*` | sky |
| Model Catalogue | `accent-model-catalogue-*` | purple |
| Max plan | `accent-plan-max-*` | purple |
| Promotion | `accent-promotion-*` | emerald |
| Account identity | `accent-account-*` | teal |
| Account memory 제어 | `accent-account-memory-*` | teal |
| 성공·검증 상태 | `status-success-*` | emerald |
| 스위치 켜짐 상태 | `status-switch-on-*` | emerald |

## 규칙

1. **`cyan → blue → purple` gradient 전체 조합은 AI Review 전용으로 예약**합니다.
   다른 기능은 이 조합을 쓰지 않습니다. `accent-ai-review-*` token을 AI Review
   외 component에서 쓰면 검사에서 실패합니다.
2. **역할이 다르면 값이 같아도 token을 분리**합니다. `accent-promotion`과
   `status-success`는 오늘 둘 다 emerald지만 별개 결정이며, 한쪽을 바꿔도
   다른 쪽이 따라 움직여서는 안 됩니다. `accent-model-catalogue`와
   `accent-plan-max`(둘 다 purple), `accent-generated-artifact`(세 번째
   emerald)도 같습니다.
3. **guarded 파일 안에서는 raw accent utility 금지.** `bg-violet-500`,
   `text-emerald-600` 같은 직접 지정 대신 역할 token을 씁니다. 대상 hue는
   `cyan`, `emerald`, `fuchsia`, `purple`, `sky`, `teal`, `violet`입니다.
   `blue`·`zinc`(기본 인상)와 `red`·`amber`(오류·크레딧 상태)는 대상이 아닙니다.
4. **신규 역할은 token부터.** `app/globals.css`에 역할 namespace를 추가하고
   `scripts/check-accent-tokens.mjs`의 `KNOWN_ROLES`에 등록한 뒤 사용합니다.
   token 없는 역할 utility는 검사에서 실패합니다.
5. **guarded 목록은 역할을 token으로 옮긴 파일만** 포함합니다
   (`scripts/check-accent-tokens.mjs`의 `GUARDED_FILES`). admin console과
   일반 status 색은 아직 대상이 아니며, design decision 없이 범위를 넓히지
   않습니다.

예외가 필요하면 이 문서에 근거를 적고 나서 추가합니다.

# 브랜치 이름이 자동화 권한을 정합니다

**브랜치의 목적이 아니라 병합 대상이 자동화 권한을 결정합니다.** `claude/`,
`codex/`, `docs/`, `fix/`는 누가 왜 만들었는지를 말할 뿐 어디로 가는지를 말하지
않고, push 이벤트는 그것을 알아낼 방법이 없습니다 — 브랜치는 PR보다 먼저
존재합니다.

`Auto PR to Develop`은 이름에 **`to-develop` 경로 조각이 있는 브랜치에만**
develop PR을 만듭니다. 판정은 `scripts/auto-pr-branch-policy.mjs`가 하고
`tests/autoPrBranchPolicy.test.mjs`가 허용·거부 양쪽을 고정합니다.

```
claude/to-develop/image-generation   자동 PR
codex/to-develop/fix-picker          자동 PR
docs/to-develop/release-policy       자동 PR
to-develop/ime-submit                자동 PR

claude/to-main/dependabot-hold       없음 — main PR도 열 수 없습니다(아래 절)
release/**, hotfix/**                없음 — production에 닿습니다
dependabot/**, autofix/**,
feedback-autofix/**                  없음 — 각자 자기 PR을 엽니다
visual-baseline/**                   없음 — 골든 재기록은 사람이 diff를 보고 병합합니다
그 밖의 모든 이름                     없음
```

`to-develop`은 **경로 조각**이지 부분 문자열이 아닙니다.
`feature/to-development-notes`는 개발 노트에 관한 브랜치이고
`chore/to-develop-later`는 누군가의 약칭입니다. 둘 다 대상을 말한 것이
아닙니다.

이전 규칙은 `branches-ignore`에 예외를 쌓는 방식이었고, 그 목록은 **이미 한 번
당해 본 namespace만** 담을 수 있습니다. 2026-08-15에 `.github/dependabot.yml`
변경(기본 브랜치에서만 읽히는 파일)을 담은 브랜치가 main용으로 push되자 develop
PR #573이 먼저 열렸습니다 — 한 브랜치에 PR 둘, 그중 하나는 변경이 아무 효과도
없는 base였습니다. opt-in에서 모르는 브랜치는 **PR 없음**이고 비용은 `gh pr
create` 한 번이지만, opt-out에서는 **잘못된 base의 PR에 auto-merge까지 켜진
상태**입니다.

기존에 열린 PR과 브랜치는 그대로 둡니다. 새 규칙은 이 변경 이후 만드는
브랜치부터 적용합니다.

## main으로 가는 PR은 release와 hotfix뿐입니다

**기능은 develop으로 보내고, main에는 release가 가져갑니다.**
`.github/RELEASE_CHECKLIST.md` 7.9절의 세 경로 — `develop`(release),
`release/**`(선택 release), `hotfix/**`(사고·보안 권고) — 만 main에 닿습니다.
`to-main`이라는 이름은 경로가 아닙니다. 2026-10-02부터 PR Fast Gate가 이를
검사하며(`scripts/main-pr-source-policy.mjs`,
`tests/mainPrSourcePolicy.test.mjs`), 그 밖의 head는 필수 check가 실패합니다.

```
develop                              통과 — release
release/2026-10-02-consent           통과 — 선택 release (체크리스트 7.9.1)
hotfix/stripe-timeout                통과 — 체크리스트 7.9.2의 여섯 항목이 필요합니다
claude/hotfix/stripe-timeout         통과 — `hotfix`는 경로 조각
dependabot/**, autofix/**,
feedback-autofix-main/**             통과 — 각자의 승인 게이트가 있습니다
claude/to-main/..., codex/...        거부 — `gh pr edit <번호> --base develop`
```

근거는 수치입니다. 2026-09-20~10-02에 main에 병합된 PR 80건 중 78건이 기능
브랜치였고, 각각 CI를 두 번 돌았으며(PR과 main push), develop으로 되돌아오는
back-merge가 아홉 번 자동으로, 한 번(#1794, 충돌 34개 파일)은 손으로 필요했습니다.

규칙 이전에 main으로 열려 있던 PR 4건(#1798, #1858, #1880, #1882)은
`scripts/main-pr-source-policy.mjs`의 예외 목록으로 통과시킵니다. 이 목록은 줄기만 하고,
테스트가 새 항목 추가를 막습니다.

## workflow는 PR을 열기만 하고 auto-merge를 켜지 않습니다

`Auto PR to Develop`은 PR을 열 뿐 **병합하지도, auto-merge를 켜지도 않습니다**
(2026-10-02 운영자 결정). auto-merge가 켜진 PR은 check가 통과하는 순간 GitHub가
병합하므로, Railway가 무엇을 하고 있든 상관없이 몇 분 간격으로 병합된 PR들이
staging에 "Wait for CI" 배포를 겹겹이 쌓았습니다.

병합은 운영자가 로컬에서 실행하는 merge train(`npm run merge-train`,
`scripts/merge-train.mjs`)이 맡습니다. 가장 오래된 non-draft·CI 통과 PR을 하나씩
병합하고, 그 환경에 진행 중인 Railway 배포가 하나라도 있으면 hold합니다. 자기가
병합한 배포가 실패하면 멈추고 재시도하지 않습니다.

이전 규칙의 교훈은 그대로입니다. 2026-09-05에 PR #1256은 사람이 auto-merge를
끈 뒤 push 한 번에 workflow가 다시 켜서, 병합을 보류하라는 지시가 있던 상태로
병합됐습니다. 자동화가 사람이 끈 스위치를 다시 켜서는 안 됩니다.

`tests/autoPrAutoMergeArming.test.mjs`와 `security-regression-check`가 workflow에
`gh pr merge`·`--auto`가 없음을 고정합니다. 개별 PR에 auto-merge가 필요하면
**사람이 켭니다.**

## PR은 draft로 시작하고, 끝나면 ready로 바꿉니다

**draft PR에서는 PR CI가 아무것도 돌지 않습니다**(2026-10-03). `Auto PR to Develop`은
PR을 `--draft`로 열고, 브랜치 작업을 마친 세션이 직접 ready로 바꿉니다. ready로
바꾸는 순간 전체 검사가 한 번 돌고, 녹색이 되면 merge train이 가져갑니다(merge
train은 draft를 건너뜁니다).

```
gh pr ready <번호>        작업 완료 — CI 시작
gh pr ready <번호> --undo 다시 손볼 때 — 이후 push는 CI를 돌리지 않음
```

- **작업 중에는 draft로 둡니다.** push할 때마다 약 20개 job이 돌던 것이 이 규칙의
  이유입니다. 동시 실행 한도를 40으로 올린 뒤에도 2026-10-03에 실행 40·대기 68이었고,
  Railway가 기다리는 develop·main push 검사가 그 뒤에 줄을 섰습니다.
- **CI 결과가 필요하면 ready로 바꿉니다.** draft 상태로는 검사 결과를 얻을 수 없으니,
  로컬에서 먼저 확인할 수 있는 것(`npm run test:unit`, 관련 check script)은 로컬에서
  돌립니다.
- 판정은 PR workflow들의 job 조건 하나이고, `tests/draftPrCiSkip.test.mjs`가 모든
  job과 `ready_for_review` trigger, Auto PR의 `--draft`를 함께 고정합니다.

## develop은 dev에, Test는 `test` 브랜치에 배포됩니다

2026-10-07부터 환경이 셋입니다. **develop 병합이 닿는 곳은 dev**(`dev.tomverse.app`)이고,
staging(사람에게는 Test, `staging.tomverse.app`)은 `test` 브랜치를 배포합니다. `test`는
사람이 고른 release candidate로 `npm run promote:test -- --sha=<commit>`만 옮깁니다.

- "develop에 병합했으니 staging에서 확인"은 이제 틀린 문장입니다. 병합 직후의 동작은 dev에서
  보고, 고정된 SHA로 하는 검증(체크리스트·기록)은 그 SHA로 `test`를 옮긴 뒤 Test에서 합니다.
- merge train은 dev 배포가 끝나기를 기다립니다. `test`로 병합하는 레인은 없습니다.
- Railway 환경 이름은 `staging` 그대로이고, 환경 판정(`lib/deploymentEnvironment.ts`)도 `staging`
  입니다. Test 전용 게이트는 계속 staging에서만 동작합니다.
- release 경로는 `.github/RELEASE_CHECKLIST.md` 7.9, 승격 절차와 한 번만 하는 전환은
  `docs/ops/dev-test-lanes.md`.

# 다음 작업 고를 때 — 열린 이슈를 그대로 믿지 않습니다

이슈가 **열려 있다**는 것과 **아직 안 됐다**는 것은 다른 사실입니다. 이 저장소는
수정을 먼저 넣고 이슈를 나중에 닫으므로, 열린 목록을 그대로 후보로 쓰면 이미
끝난 일을 다시 제안하게 됩니다. 2026-08-12에 열린 이슈 6건이 전부 이미
해결된 상태였습니다.

작업 후보를 고르기 전에 실행합니다.

```
npm run report:issue-backlog -- --issues-file <열린 이슈 JSON>
```

`GITHUB_TOKEN`이 있으면 `--issues-file` 없이 API에서 직접 읽습니다.

- 판정 근거는 `scripts/report-issue-backlog-core.mjs`에 있습니다. 세 신호를
  각각 따로 보고하며 하나의 boolean으로 합치지 않습니다 — `pricing`(profile
  존재 + pending register 이탈), `probe`(이슈별 손으로 쓴 완료 조건),
  `commits`(이슈 번호를 언급한 commit, 셋 중 가장 약한 신호).
- **내용 검사는 release branch마다 따로** 합니다. `develop`과 `main`의 간격은
  이슈마다 다르게 걸치므로, 한쪽만 읽고 "고쳐졌다"고 답하면 반대쪽에 대해
  틀립니다.
- 착수해도 되는 것은 `candidates`(= `open_work`)뿐입니다.
  `landed_but_unverified`는 사람이 확인할 대상이지 시작할 작업이 아닙니다.
- `blocked`는 **열려 있고 끝나지도 않았지만 시작해서는 안 되는** 것입니다.
  probe의 `blockedOn`이 무엇을 기다리는지 이름을 대며, 대개 저장소가 답할 수 없는
  사실(운영 DB, 결제 제공자 상태)입니다. 그것을 모른 채 시작하면 멈추거나
  추측하게 되고, 추측이 곧 결과가 됩니다 — 예: 어떤 프로모션이 살아 있는지 모르는
  채 생성을 막으면 진행 중인 캠페인이 끊깁니다. 보고서가 `blocked on`으로 무엇을
  읽어야 하는지 알려 주므로, 그것부터 구하고 나서 착수합니다.
- 새 이슈의 완료 조건이 generic 신호에 안 잡히면 `ISSUE_PROBES`에 추가합니다.
  증명하지 못하는 부분은 `remainder`에 적습니다 — 그래야 부분 완료가 완료로
  보고되지 않습니다.
- 이 script는 보고 전용이라 gate가 아닙니다. 단 하나의 비정상 종료는
  `lib/modelPricing.ts` 해석이 실제 module과 어긋날 때이며, 그때는 출력 전체를
  믿을 수 없다는 뜻입니다.

# 검증 범위는 되돌릴 수 없는 것에 비례합니다

**이 저장소는 1인 조직입니다.** staging 검증의 모든 항목을 매 회차 실행하는
것은 감당할 수 있는 일이 아니고, 그렇게 요구하면 검증 자체가 미뤄집니다.
그래서 범위를 정하는 규칙을 여기에 둡니다.

**항목을 릴리스 차단으로 올리는 근거는 단 하나 — 틀렸을 때 되돌릴 수 없는가.**

- **되돌릴 수 없음** = 이력 테이블이 없어 원상 복구가 불가능하거나(예:
  `Conversation.selectedModels`, pin된 profile version), 유출처럼 회수가
  성립하지 않거나, 사용자 데이터가 사라지는 것.
- **되돌릴 수 있음** = 고쳐서 배포하면 끝나는 것. 라벨·문구·breadcrumb·탭
  배치·편의 기능이 여기 속합니다. 잘못된 과금도 여기입니다 — 환급됩니다.

"중요해 보인다", "완성도가 떨어진다"는 차단 근거가 아닙니다. **무엇이 복구
불가인지 한 줄로 적을 수 없으면 차단이 아닙니다.**

## 에이전트가 검증을 설계할 때

1. 체크리스트를 통째로 요구하지 않습니다. **차단 항목부터 제시하고, 나머지는
   선택지로 알립니다.** 총 항목 수와 유료 turn 수를 먼저 말합니다.
2. 유료 항목은 **무엇을 판별하는지** 한 줄로 설명합니다. 설명할 수 없는 유료
   turn은 제안하지 않습니다.
3. 사람이 범위를 줄이면 그대로 따릅니다. 건너뛴 구획은 기록의 `미기록`이며,
   판정란에 **무엇을 왜 건너뛰었는지** 적습니다 — 그러면 그 기록은 비어 있는
   것이 아니라 범위를 밝힌 것이 됩니다.
4. 차단·비차단 갈래는 각 체크리스트 안에 적습니다. 예:
   `docs/ops/assistant-profile-staging-checklist.md`의
   "무엇이 flag를 막고, 무엇이 막지 않는가".

## 사람에게 남기는 것은 사람만 할 수 있는 것뿐입니다

범위를 줄이는 것과 **준비를 떠넘기지 않는 것**은 다른 규칙이고, 1인 조직에서는
뒤쪽이 더 자주 검증을 멈춥니다. 항목이 세 개여도 그 셋을 하려면 시료를 만들고
숫자를 세고 기록 파일을 만들어야 한다면, 실제 비용은 세 개가 아닙니다.

**에이전트가 만들 수 있는 것을 사람에게 만들라고 하지 않습니다.**

- **시료는 에이전트가 만들어 건넵니다.** zip, GIF(정지·애니메이션), 대용량
  파일, 텍스트·코드·마크업, 암호 걸린 문서까지 전부 이 컨테이너에서 만들
  수 있습니다. "이런 파일들을 준비하세요" 목록은 준비를 떠넘긴 것입니다.
- **셈과 대조는 에이전트가 합니다.** 제외 개수 검산, digest 계산, 기록 파일
  생성, SHA 대조는 script이지 사람의 판단이 아닙니다. 사람에게 PowerShell을
  붙여 주는 것은 그 일을 넘긴 것이지 도운 것이 아닙니다.
- **시료에는 정답지를 같이 냅니다.** 무엇이 들어 있고 무엇이 왜 빠져야 하는지
  적힌 manifest가 없으면, 사람은 답을 판정할 근거 없이 판정하게 됩니다.

**사람만 할 수 있는 것**은 이 넷뿐이고, 항목을 남길 근거도 이 넷입니다.

1. **실기기·실제 OS** — 파일 선택기의 MIME 보고처럼 합성 `File`로 재현되지
   않는 것.
2. **이 컨테이너가 만들 수 없는 시료** — 진짜 Microsoft Office가 저장한
   파일처럼, 만들 수 있는 도구가 여기 없는 것. LibreOffice로 만든 것은
   대체물이 아닙니다.
3. **유료 turn과 그 답의 판정** — 크레딧을 쓰는 결정과, 답이 문서 내용과
   맞는지 보는 눈.
4. **판정과 서명** — 통과·조건부·실패의 결정.

**여기에 안 들어가는 것을 사람에게 요구할 때는 왜 못 하는지 한 줄로 적습니다.**
적을 수 없으면 그 일은 에이전트 것입니다.

### 기록을 채우는 경계는 관측과 판정입니다

4번이 덮는 것은 **판정과 서명**이지 기록 파일 전체가 아닙니다. 사람이 실행하며
보고한 것 — 무엇이 나왔고 어떤 오류 코드였고 몇 크레딧을 썼는지 — 을 항목·증거·
크레딧 칸에 옮겨 적어 초안을 만드는 것은 에이전트가 합니다. 본 것을 다시
타이핑하게 만드는 것은 준비를 떠넘기는 일이고, 1인 조직에서 그 비용이 기록을
미루게 만듭니다.

"토스트에 2개라고 떴다"는 관측이고 "그러므로 이 회차는 통과다"는 판정입니다.
**지어낸 관측을 적는 것은 어느 쪽에서도 허용되지 않으며**, 초안은 그것이
초안임을 문서 안에서 밝히고 실행자가 각 줄을 확인한 뒤 commit 합니다.
자세한 규칙은 각 기능의 `*-staging-verification-records/README.md` 5번입니다.

## 검증을 건너뛴다는 뜻이 아닙니다

차단 항목은 줄이지 않습니다. 줄이는 것은 **차단이 아닌 항목을 지금 할지
나중에 할지**뿐입니다. flag를 켠 뒤에 발견된 라벨 오류는 고치면 되지만,
덮어써진 대화 설정은 고칠 수 없습니다.

# 릴리스 게이트에서 일감을 고를 때

`docs/release-gates/tomverse-chat-v1.yaml`의 40개 게이트가 전부 `status: pending`
입니다. **이는 정상이며 고칠 대상이 아닙니다** — registry는 `metadata.status:
draft`이고 `governance.implementationStatus: planned`이며, 검증기는 `--release`
에서만 승인과 증거를 강제합니다(PR Fast Gate는 `--release` 없이 실행).

다만 draft 상태에서는 "pending"이라는 한 단어가 서로 다른 세 상황을 덮습니다.
구분해서 보려면 실행합니다.

```
npm run report:release-gate-evidence
npm run report:release-gate-evidence -- --condition memory-release-b-enabled=false
```

- 판정 근거는 `scripts/report-release-gate-evidence-core.mjs`의 `GATE_EVIDENCE`
  이며 **손으로 쓴 매핑**입니다. 게이트의 `evidence` 문구에서 파일을 추측하지
  않습니다 — 아무도 안 본 게이트에 대해 확신을 지어내는 것이 이 도구가 막으려는
  실패입니다. 매핑 없는 게이트는 `unmapped`으로 보고합니다.
- **`evidence_present`는 통과가 아닙니다.** 게이트가 이름 댄 산출물이 트리에
  있다는 뜻일 뿐이고, 대부분의 기준은 이 저장소에 없는 production·부하 데이터
  위에서 정의됩니다. 임계값 판단은 사람이 합니다.
- **이 도구는 registry에 쓰지 않습니다.** status 전환도 `evidenceRefs` 채우기도
  하지 않습니다. 승인은 registry에 기록되는 사람의 행위이고, 보고서가 자기
  대상을 편집하면 registry가 존재하는 이유인 감사 기록이 사라집니다.
- **`appliesWhen`은 저장소 사실이 아니라 런타임 조건입니다.** MEMORY 4건은
  `AppSetting`의 `feature.memoryExtractionEnabled`·`feature.memoryInjectionEnabled`
  에 달려 있으므로, 조건을 주지 않으면 `applicability_unknown`으로 남깁니다.
  꺼져 있다고 가정하면 blocking 프라이버시·안전 게이트 4건을 조용히 면제하게
  됩니다.
- 착수 후보는 `nothing built yet`입니다. `built, nothing measures it`은 보통
  기능이 아니라 테스트나 리포트 한 건입니다.

`nothing built yet` 11건 중 **BILLING-04만 다른 작업에 막혀 있지 않습니다.**
Planner·context manifest·moderation은 선행 작업 대기이고, store·native auth는 이
저장소에서 만들 수 없습니다. BILLING-04에 착수하기 전에 읽습니다.

- `docs/policy/goodwill-credit-grants.md`

goodwill 지급은 Stripe 환불도 구매 취소도 아닌 **세 번째 것**이며, 대응 결제가
없으므로 멱등성을 빌려올 수 없습니다. 설계 문서(docs/policy/goodwill-credit-grants.md §8)의 여섯 가지(1회·기간 상한,
이중 승인 임계값, 만료, 소진 순서, 환불 상호작용, 사용자 가시성)는 finance-ops의
결정이며 **정해지기 전에는 구현하지 않습니다.**

# Credit entitlement vs operational guardrail

크레딧·비용 한도를 건드리기 전에 읽습니다.

- `docs/policy/credit-and-cost-limits.md`

절대 조건:

- **사용자 entitlement는 크레딧입니다.** 플랜 크레딧과 구매 크레딧이 사용
  권한을 정하며, 그 위에 숨은 USD 한도를 두지 않습니다.
- **operational guardrail은 별개 층입니다.** 이름(`CHAT_COST_GUARDRAIL_*`),
  오류 코드(`OPERATIONAL_COST_GUARDRAIL_TRIGGERED`, `PROVIDER_BUDGET_EXHAUSTED`),
  버킷(`op-cost-*`), 지표를 entitlement와 섞지 않습니다.
- guardrail 한도는 플랜 크레딧에서 유도하며, 환경변수 override는 유도값
  아래로 내려갈 수 없습니다(`lib/chatCostGuardrails.ts`가 강제).
- 모든 enabled premium 모델은 `lib/modelPricing.ts`에 명시적 가격 profile을
  가져야 합니다. `npm run check:model-pricing`이 PR Fast Gate에서 fail-closed로
  검사합니다.
- **`ModelRegistryEntry`의 가격 컬럼이 `NULL`이면 코드 profile을 상속하고,
  숫자면 관리자 override입니다.** seed는 항상 `NULL`을 쓰고 reconciliation은 이
  세 컬럼을 아예 쓰지 않습니다. 해석된 가격을 행에 다시 넣으면 장문 tier가
  사라지고 `costSource`가 전부 override로 보고돼 fallback 지표가 0%가 됩니다.
  확인은 `npm run check:model-pricing-db`.
- **`creditWeight`에는 그 `NULL` 구분이 없습니다.** `ModelRegistryEntry.creditWeight`는
  `Int` non-nullable이라 모든 행이 숫자를 갖고, 어떤 행도 그 숫자의 출처를 말하지
  못합니다. `ensureModelRegistrySeeded()`는 `skipDuplicates: true`로 넣으므로 이미
  있는 행을 다시 보지 않고, 갱신은 `STATIC_CATALOG_RECONCILIATION_MODEL_IDS`에
  등록된 모델에만 닿습니다. **그래서 `lib/models.ts`의 `creditWeight`를 고쳐도
  기존 행에는 반영되지 않고, 코드는 계속 옛 값을 말합니다.**
  2026-08-15에 `perplexity/sonar`가 이 상태로 발견됐습니다 — 코드 16, 청구 20.
  `npm run report:model-credit-weights`가 코드와 DB의 차이를 나열합니다. **gate가
  아니라 보고입니다**: 행이 카탈로그와 다른 것은 `PUT /api/admin/models`가 만들라고
  있는 상태이고, 의도된 override와 편집 실패는 컬럼만 봐서 구분되지 않습니다.
  새 모델의 크레딧을 바꿀 때는 코드만 고치지 말고 이 보고로 실제 행을 확인합니다.
- **`maxOutputTokens`·`reservationOutputTokens`에도 그 `NULL` 구분이 없습니다.**
  가격 컬럼과 달리 seed가 해석된 숫자를 써 넣으므로, 저장된 숫자는 관리자
  override일 수도 그때의 profile 화석일 수도 있고 컬럼은 둘을 구분하지 못합니다.
  `registryRowToModel()`이 그 숫자를 신뢰하고 chat route가
  `streamText({ maxOutputTokens })`로 넘기므로 **화석은 낡은 표시가 아니라 모든
  답변에 걸리는 상한입니다.** 2026-08-23에 `claude-sonnet-5`가 이 상태로
  발견됐습니다 — profile 128,000, 운영 행 4,096(2026-07-17 seed 당시의
  `advanced` fallback), trace `2e4327a9`가 reasoning으로 4,095 토큰을 쓰고
  `AI_EMPTY_RESPONSE.MAX_TOKENS`로 끝났습니다. profile의 출력 한도를 바꾸면
  모델을 `STATIC_CATALOG_RECONCILIATION_MODEL_IDS`에 등록해야 기존 행에
  도달합니다. **상한과 예약을 함께 움직이지 않습니다** — 앞은 능력이고 뒤는
  entitlement입니다. `npm run report:model-token-limits`가 차이를 actor 유무와
  함께 나열하며, `report:model-credit-weights`와 같이 **gate가 아니라
  보고입니다**: docs/policy/credit-and-cost-limits.md.
- **reconciliation에는 scope가 둘입니다.** 기본은 검토된 메타데이터 블록 전체를
  쓰고, `OUTPUT_CAP_ONLY_RECONCILIATION_MODEL_IDS`는 `maxOutputTokens` 한
  필드만 씁니다. 상한 하나 때문에 전체 scope로 등록하지 않습니다 —
  `creditWeight`가 함께 쓰이고, `perplexity/sonar`는
  docs/policy/perplexity-sonar-credit-price-hold.md가 그 값을 묶어 두었으며 그
  문서가 이 목록을 위험 경로로 지목합니다
  (docs/policy/perplexity-sonar-credit-price-hold.md §5는 다른 모델도 같을 수
  있다고 적습니다). 2026-08-23에 열두 모델이 상한 전용 scope로 들어갔습니다.
  `gpt-5-5-thinking`은 상한이 이미 맞고 예약만 어긋나서
  `RESERVATION_ONLY_RECONCILIATION_MODEL_IDS`로 따로 들어갔으며, 그 6,144는
  docs/policy/credit-and-cost-limits.md §4가 이미 확정한 값입니다 — **이미
  내려진 결정을 옮기는 것이지 새로 정하는 것이 아닙니다.** 2026-08-25에
  `gpt-5-5`·`gemini-3-1-pro`가 같은 scope에 들어갔습니다(2,048 → 4,096).
  **예약 전용 scope에 등록하는 근거는 차이가 아니라 provenance입니다** —
  actor 컬럼 부재, `updatedAt` = `createdAt`, `AdminAuditLog` 0건, 배치
  write임을 보이는 공유 timestamp를 운영 DB에서 확인하고, 저장된 숫자가 그
  seed 시점 트리의 class 기본값과 일치함까지 대조합니다. 하나라도 불명확하면
  등록하지 않고 보고만 합니다. p90 basis를 새로
  적용하는 것은 여전히 별개이고 9개 조건이 필요합니다.
- **처리 tier를 요청에 넣지 않습니다.** 모든 profile이 Standard 가격이며, 이는
  아무 요청도 `service_tier`를 지정하지 않는 동안에만 참입니다(생략 시 OpenAI
  기본값은 `auto`). `npm run check:model-pricing`이 request-side tier 지정을
  fail-closed로 막습니다.
- **`GET /v1/models`는 가격 출처가 아닙니다.** 계정별 모델 가시성만 확인합니다
  (`npm run check:openai-model-access`).
- **cache write 가격은 측정된 곳에서 과금합니다**(2026-08-30 개정,
  `CACHE_WRITE_PRICING_IS_BILLED_WHERE_MEASURED`). 이전 계약
  (`..._IS_RECORDED_NOT_BILLED`)은 write 토큰을 보고하는 adapter가 하나도 없을
  때 맞았고, Anthropic prompt caching이 그 전제를 깼습니다. 과금 조건은
  **양쪽**입니다 — tier의 검증된 요율 **그리고** provider가 보고한 write 토큰
  수. 요율이 없는 write는 비용 0이되 `unpricedCacheWriteTokens`로 보고합니다.
- **Anthropic first-party 요청에만 5분 prompt caching을 겁니다.** 판정은
  `lib/anthropicPromptCaching.ts`의 경로 표 하나이고, MiniMax는 같은
  `createAnthropic()` SDK를 쓰지만 provider가 다르므로 제외입니다. AI SDK의
  `usage.inputTokens`는 **총합**(`noCache + cacheRead + cacheWrite`)이라 두 캐시
  수치를 **빼야** 합니다. 캐시 요청은 0.25배 write premium을 provider budget에
  미리 예약하되 `usageCredits`에는 닿지 않습니다: docs/policy/anthropic-prompt-caching.md.
- **가격 변경은 `priceSchedule`로 효력일 전에 적어 둡니다**(2026-08-30).
  `effectiveFrom`은 UTC instant이고 경계는 포함이며, 각 항목은 새
  `pricingVersion`을 갖습니다. override 우선순위와 소급 금지는 그대로입니다.
  **Claude Sonnet 5의 2026-09-01 US$3/US$15 인상은 2026-08-10에 취소됐으므로
  예약하지 않습니다** — 공식 pricing 페이지의
  `claude-sonnet-5-introductory-pricing` 각주. **`verifiedAt`(읽은 날)과
  `effectiveFrom`(청구 경계)은 별개 field이고**, 공급자가 날짜만 발표하면
  경계는 그 **다음 UTC 일의 첫 instant**로 잡습니다 — 실행 시점에 공개되지
  않았던 결정으로 소급 청구하지 않기 위해서입니다.
- 가격이 아직 검증되지 않은 premium 모델은 `PENDING_VERIFIED_PRICE_REGISTER`에
  담당자·검증 티켓·등록일·기한·production 승인과 함께 등록합니다. 기한(최대
  90일)이 지나면 같은 검사가 경고에서 실패로 바뀝니다. fallback 사용 비율과
  예약 대비 정산 비율은 `GET /api/admin/fallback-pricing`에서 봅니다.
- **provider 예산은 production에서 반드시 명시합니다.** production 기본값은
  없고, 활성 provider에 `CHAT_PROVIDER_*_COST_MICROUSD_PER_DAY`/`_PER_MONTH`가
  없으면 `/api/ready`가 실패합니다. 단일 계정의 plan guardrail보다 낮은 값은
  바닥으로 올려 강제하고 보고합니다. 환경변수를 **먼저** 배포하고 코드를
  나중에 배포합니다. 현황은 `GET /api/admin/provider-budgets`에서 봅니다.
- 가격 변경은 소급 적용하지 않습니다. `pricingVersion`과 `costSource`를
  reservation·settlement snapshot에 저장합니다.
- 사용자 응답에 원시 내부 USD를 노출하지 않습니다. `internal*` 진단 필드는
  `publicChatErrorDetails()`가 제거하고, Admin Console과 구조화 로그에만
  남깁니다.
- 모든 오류 응답의 `resetAt`은 생성 시점보다 미래여야 합니다.
- **크레딧을 예약·환급하는 트랜잭션은 `lockCreditAccount(tx, userId)`를 가장
  먼저 잡습니다**(docs/policy/credit-and-cost-limits.md §9). `reserveAddOnCredits()`는 읽어서 판정하고
  차감하는데 `CreditLot.remainingCredits`에 CHECK도 사후 검사도 없어서, 잠금이
  없으면 같은 잔액을 읽은 두 경로가 모두 통과해 잔액이 음수가 됩니다. 순서도
  계약입니다 — workflow advisory 잠금(`memory-extraction:*` 등)보다 **앞**이며,
  종료 여부 같은 조건 분기 **안**에서 잠그지 않습니다.
- **`CreditLot`의 non-negative CHECK는 그 잠금의 대체물이 아닙니다.** CHECK는
  직렬화를 못 하므로 잠금 없는 경로를 안전하게 만들지 못하고, 조용히 틀린
  잔액을 실패한 트랜잭션으로 바꿀 뿐입니다. `NOT VALID`로 배포했으므로
  validate는 `npm run report:credit-lot-invariants`가 0을 보고한 뒤 **별도
  migration**으로 합니다 — production에서 손으로 validate하면 schema 비교가
  drift로 잡습니다.
- 이 계약을 어기는 변경은 릴리스 차단 사유입니다.

# Conversation.productKey

`Conversation.productKey`, 그 CHECK 제약, 또는 productKey를 쓰는 생성 경로를
건드리기 전에 읽습니다.

- `docs/policy/conversation-product-key.md`

절대 조건:

- **`kind`를 제품 정체성으로 재사용하지 않습니다**(docs/policy/conversation-product-key.md §5). `kind`는
  `lib/conversationKindGuard.ts`가 소유하는 **서버 authorization·modality 경계**
  이고, `productKey`는 사용자가 수행하는 제품 작업입니다. 두 축은 직교하며 어느
  것도 다른 하나를 대체하지 않습니다.
- **`selectionMode`로 제품을 유도하거나 백필하지 않습니다.** Chat에서 사용자가
  모델을 직접 골라도 그 대화는 Chat입니다. 그리고 manual 복귀가 sticky state를
  지우므로(`Conversation_manual_has_no_sticky_state_check`) "Auto였던 적이 있나"를
  나중에 물을 수조차 없습니다.
- **허용값은 `chat` · `review` · `studio` 셋뿐이고 `code`는 없습니다.** Code가
  Conversation을 쓰기 시작할 때 `lib/conversationProduct.ts`의
  `CONVERSATION_PRODUCT_KEYS`와 DB CHECK에 **함께** 추가합니다
  (`npm run check:enum-constraints`가 어긋남을 잡습니다).
- **DB default를 두지 않습니다.** `review` default는 컬럼을 빼먹은 writer를
  Review를 의도한 writer처럼 보이게 만듭니다. 전환 기간의 NULL은 "아직 안 정해짐"
  이고 그것이 백필의 대상 목록입니다.
- **Auto는 Chat 전용이며 규칙은 허용 하나로 씁니다**, 금지 목록이 아니라.
  v1.1은 `review + auto`만 금지했고 `studio + auto`가 통과했습니다.
- **NOT VALID 제약은 writer 누락을 막지 못합니다.** 셋 다 `productKey IS NULL`을
  통과시킵니다. 누락은 공통 생성 서비스 · 직접 `conversation.create` 정적 검사 ·
  writer coverage 테스트가 막으며, 이 셋은 제약과 별개로 계속 필요합니다.
- **`VALIDATE CONSTRAINT`와 `NOT NULL`은 각각 별도 migration이고 별도 증거를
  갖습니다.** docs/policy/conversation-product-key.md §7의 조건이 충족되기 전에는 작성하지 않습니다.
  `tests/integration/conversation-product-key.db.test.ts`가 조기 전환을 실패로
  만듭니다.

# Chat concurrency and identity namespace

게스트 동시 실행 scope, lease 수명, guest→로그인 전환의 대화 ID를 건드리기 전에
읽습니다.

- `docs/policy/chat-concurrency-and-identity.md`

- **동시 실행은 entitlement도 guardrail도 아닌 세 번째 층입니다.** `limitLayer`는
  주체 한도가 `concurrency`, IP 집계 상한이 `operational_admission`입니다.
  크레딧·플랜·provider 예산과 코드도 문구도 섞지 않습니다.
- **게스트의 동시 실행 한도는 signed guest cookie(`access.subjectKey`) 기준입니다.**
  `access.ipKey`로 되돌리면 같은 NAT의 서로 다른 게스트가 서로의 한도를 소비합니다.
- **IP 집계 상한은 별개로 유지합니다**(`CHAT_IP_CONCURRENT`,
  `CHAT_IP_CONCURRENCY_EXCEEDED`). 게스트 한도 아래로 설정할 수 없고, 기존 IP
  기준 분당·일일·토큰·비용 abuse protection을 대체하지 않습니다.
  `CHAT_GUEST_CONCURRENT`를 올려 문제를 덮지 않습니다.
- **다중 모델 비교는 전부 승인되거나 전부 거절됩니다.** aggregate preflight가 한
  transaction에서 슬롯을 예약하고, 서명·subject 결속·만료를 가진 admission token을
  각 모델 요청이 조건부 UPDATE로 한 번만 소비합니다. token은 어느 슬롯을 쓸지만
  정하며 모델·소유권·크레딧·비용 검사를 대체하지 않습니다.
- **lease는 고정 TTL이 아니라 heartbeat로 유지합니다.** 완료·provider 오류·취소·
  연결 끊김·스트림 생성 실패·deep research 인계 모두에서 결정적으로 해제하고,
  실패는 구조화 이벤트로 남기며 15분 주기 reconciliation이 orphan을 정리합니다.
- **계정 API에는 현재 identity namespace의 서버 Conversation ID만 전달합니다.**
  `guest_` 접두사 검사는 보안 경계가 아니라 상태 invariant이고, 소유권은 계속
  서버가 정합니다. `guest_*`를 DB Conversation ID로 인정하거나
  `CONVERSATION_FORBIDDEN`을 완화하지 않습니다.
- **로그인 시 guest localStorage를 삭제하지 않습니다.** 전환은 *선택*만 해제하고
  guest snapshot은 import modal이 결정할 수 있도록 보존합니다.

# Code managed-path credits, guardrail and concurrency

Code 제품 서비스(TomverseCode 관리형 모델 카탈로그 경로)의 예약·정산·동시 실행을
만들거나 건드리기 전에 읽습니다. **설계 정책이며 코드는 아직 없습니다.**

- `docs/policy/code-task-cost-guardrails.md`
- `docs/policy/code-concurrency.md`

- **코딩 전용 크레딧 풀이나 숨은 USD 한도를 만들지 않습니다.** 채팅과 같은 크레딧·
  `op-cost-*`·provider 예산을 쓰고, 코딩을 따로 막는 장치는 guardrail이거나 동시 실행입니다.
- **예약은 태스크 단위, 정산은 호출 단위입니다.** 정산을 모르면 예약만큼 쓴 것으로 치고
  0으로 해제하지 않습니다. 잠금은 `lockCreditAccount()`가 먼저입니다
  (docs/policy/credit-and-cost-limits.md §9).
- **코딩은 채팅의 rate·동시 실행 scope를 쓰지도, 소비하지도 않습니다.** 태스크 슬롯과
  호출 슬롯을 따로 세고, Fleet admission은 전부 아니면 전무입니다.
- **관리형 코딩 호출은 Conversation을 만들지 않고 `Conversation.productKey`에 `code`를 넣지
  않습니다.** 제품 귀속은 서버가 Code 자격증명에서 유도합니다.

# 프로모션 할인과 통화

프로모션의 할인 형태, `discountAmountCents`, Admin billing PATCH의 프로모션
분기를 건드리기 전에 읽습니다.

- `docs/policy/promotion-discount-currency.md`

절대 조건:

- **신규 프로모션은 정률만입니다.** 고정액 할인은 승인된 상태로 deprecated이고
  (docs/policy/promotion-discount-currency.md §2, rollout 승인 2026-08-16,
  활성 0개 확인), 다중 통화로 확장하지 않습니다.
- **`discountAmountCents`는 USD 금액입니다.** 다른 통화의 가격에 비율로 환산해
  적용하지 않습니다. 그 환산이 이 정책을 만든 사고입니다.
- **컬럼은 삭제하지 않습니다.** 과거 상환 기록이 프로모션 행을 가리키므로
  당시 할인을 재구성할 수 없게 됩니다. 삭제는
  docs/policy/promotion-discount-currency.md §5의 세 조건을 확인한 뒤 별도 migration입니다.
- **판정은 `fixedAmountPromotionRefusal()` 한 곳에 있습니다**
  (`lib/billingPromotionAdminPolicy.ts`). Admin API와 Admin 패널이 같은 함수를
  부릅니다.
  docs/policy/promotion-discount-currency.md §4 행렬을 route와 component에
  각각 옮겨 적지 않습니다.
- **판정은 요청 본문이 아니라 저장된 행과 비교합니다.** 패널이 매 저장마다
  프로모션 목록 전체를 PATCH하므로, 본문만 보고 고정액을 거절하면 기존 코드가
  하나라도 있는 동안 billing 폼 전체가 잠깁니다.
- **거절은 어떤 write보다 먼저** 합니다. plan·price·promotion이 한 요청에 실려
  오므로 늦게 거절하면 절반만 적용된 상태가 남습니다.
- **좁히는 편집은 계속 허용합니다** — 비활성화, 종료일 단축, 할인액 인하, 플랜
  제거, 상한 인하. 비활성화까지 막으면 살아 있는 프로모션을 끌 수단이 없어집니다.
- 통화 판정 자체(`promotionCurrencyFailure()`, `PROMOTION_CURRENCY_NOT_SUPPORTED`)
  는 별개 계층이며 validation과 Checkout이 공유합니다. 완화하지 않습니다.
# 가격 카탈로그 default는 fixture가 아닙니다

`DEFAULT_BILLING_PRICE_CATALOG`(`lib/billingPriceCatalog.ts`)의 숫자를 고치기
전에 읽습니다.

- docs/policy/promotion-discount-currency.md §8

**이 표는 세 상황에서 실제로 청구됩니다.** `AppSetting` 행 없음(첫 read가
default를 DB에 씁니다), 저장값 JSON 파싱 실패, schema 검증 실패. 그러므로 여기의
숫자를 바꾸는 것은 **가격 변경**이고, 테스트 값 조정이 아닙니다.

- **필드 하나가 빠지면 카탈로그 전체가 버려집니다.** 손상된 항목만이 아니라
  멀쩡한 값까지 default로 되돌아갑니다.
- **값은 승인된 것만 넣습니다.** 2026-08-16에 production 저장값(20건)에 맞췄고,
  근거는 `npm run report:billing-price-catalog`의 production read입니다. 환율로도
  비율로도 유도하지 않습니다.
- **부분 정렬 금지.** 20건은 한 transaction에서 저장됐고, 어떤 절단선을 잡아도
  일관성이 깨집니다 — Pro AUD 월간만 옮기면 연간가가 월 12회 결제보다 비싸집니다.
- **fallback은 조용하지 않아야 합니다.** `billing_price_catalog_fallback` 구조화
  이벤트가 세 상태를 구분해 남기고 `served: compiled_default`를 함께 적습니다.
  정상 경로에서는 아무것도 남기지 않습니다 — 매 요청 로그는 진짜 신호를 묻습니다.
- **두 reader 모두 source를 반환합니다.** Admin 패널은 저장된 행의 `updatedAt`을
  카탈로그 옆에 그리므로, source 없이는 그 행이 가진 적 없는 숫자 옆에 최근
  타임스탬프가 붙습니다.
- **`AdminAuditLog`는 가격 이력이 아닙니다.** `billing.updated`는 가격이 바뀌었다는
  사실(`localizedPricesUpdated`)만 남기고 이전·이후 값은 남기지 않습니다. 과거
  가격은 이 로그로 재구성할 수 없습니다.
- 값 변경은 `tests/billingPriceCatalogDefaults.test.mjs`를 함께 고쳐야 합니다.
  전체 비교이므로 언급되지 않은 가격이 조용히 움직일 수 없고, 연간 할인 구간·
  Max > Pro·크레딧팩 단조성 불변식이 자릿수 실수를 잡습니다.

# Plan change (Pro <-> Max)

플랜 변경 CTA나 `/api/billing/checkout`의 차단 분기를 건드리기 전에 읽습니다.

- `docs/policy/plan-change.md`

**Pro↔Max 온라인 변경은 전용 엔드포인트로만 합니다.** `/api/billing/checkout`은
변경을 수행하지 않으며 앞으로도 하지 않습니다.

- 서버는 동일 플랜 재구매와 다운그레이드를 `PLAN_CHANGE_NOT_SUPPORTED`로,
  활성 구독 상태의 상위 플랜 요청을 `ACTIVE_SUBSCRIPTION_EXISTS`로 각각 409
  차단합니다. **이 세 분기는 그대로 둡니다.** 풀면 신규 구독 Checkout으로 변경을
  우회할 수 있게 되고, 한 계정이 두 플랜을 동시에 결제합니다.
- 변경은 `app/api/billing/plan-change/**`(preview · confirm · 조회 · 예약 취소)가
  수행하고, 판정은 `lib/planChangeStateMachine.ts`(순수), Stripe 실행은
  `lib/planChangeService.ts`가 맡습니다. 이 분담을 섞지 않습니다.
- **결제 전에 권한을 올리지 않습니다.** 업그레이드는
  `proration_behavior=always_invoice` + `payment_behavior=pending_if_incomplete`로
  보내고, 계정의 plan은 오직 `syncSubscription()`이 Stripe에서 다시 읽은 구독으로
  옮깁니다.
- **다운그레이드는 Subscription Schedule을 직접 관리합니다.** Customer Portal은
  같은 interval의 Price 여러 개를 한 Product에 두지 못하므로 이 변경을 담지
  못합니다. Portal을 실행 경로로 되돌리지 않습니다.
- **`cancel_at_period_end`를 자동으로 해제하지 않습니다.** 별도 opt-in(별도 label을
  가진 별도 control)에서 온 `resumeRenewal`이 있을 때만 해제합니다.
- **같은 interval끼리만 허용합니다.** 월간↔연간 변경은 아직 없습니다. 구독
  interval을 모르는 계정은 CTA가 `manage_plan`(고객지원)으로 남습니다.
- 크레딧 산식은 `lib/planChangeCredits.ts`에 있습니다. 플랜 변경은 월 사용량을
  초기화하지도, 추가 지급하지도, 이미 쓴 크레딧을 회수하지도 않습니다.
  업그레이드와 다운그레이드가 같은 함수를 씁니다.

# Default model (GPT 6 Luna)

`DEFAULT_MODEL_ID`, 게스트 기본값, `gpt-5-4-mini`의 lifecycle을 건드리기 전에
읽습니다.

- `docs/policy/default-model-luna-migration.md`

- **"기본 모델"은 두 개의 다른 결정입니다.** 게스트 첫 대화는 DB의
  `AppSetting["guestDefaultModelId"]`이고 brand trio 중 **선두만** 정합니다.
  신규 로그인 계정은 `DEFAULT_MODEL_ID` → `APP_DEFAULTS.defaultModelId` →
  `app/api/user/settings/route.ts`가 만드는 행입니다. 둘을 섞지 않습니다. `npm run check:default-models`가 양쪽을
  함께 읽고 PR Fast Gate에서 검사합니다.
- **trio 밖의 모델은 `guestDefaultModelId`로 저장할 수 없습니다.** resolver가
  무시하므로 저장은 되고 효과는 없는 설정이 됩니다. `guestDefaultLeadRejection()`
  이 거부합니다.
- **기본 모델은 `gpt-6-luna`입니다**(2026-10-12, 이전 `gpt-5-6-luna`).
  `lib/models.ts`의 `DEFAULT_MODEL_ID`, `lib/appDefaults.ts`의
  `GUEST_DEFAULT_MODEL_ID`와 `GUEST_BRAND_TRIO_MODEL_IDS`가 함께 움직입니다.
  한쪽만 바꾸지 않습니다. 같은 날 trio의 Anthropic 자리는
  `claude-haiku-5-5`로 옮겼습니다. `gpt-5-6-luna`는 은퇴하지 않았습니다.
- **기본 모델을 가리키는 DB 컬럼 기본값은 없습니다**(2026-10-12). `UserSettings.defaultModel`과
  `Conversation.selectedModels`는 NOT NULL이지만 `@default`가 없어서, 기본 모델 변경에
  migration이 필요하지 않습니다. 대신 모든 쓰기 경로가 값을 직접 넣습니다 —
  `tests/userSettingsDefaultModelWriters.test.mjs`와 `createConversation`의 필수
  `selectedModels`, 그리고 기본값이 없어져 필수가 된 Prisma create 타입이 이를 지킵니다.
  `npm run check:default-models`는 두 컬럼에 `@default`가 다시 생기면 실패합니다.
- **게스트 기본 3모델은 OpenAI 1개 · Anthropic 1개 · Gemini 1개입니다**(플랫폼
  전략, 2026-10-12 운영자 결정). 그래서 Anthropic 자리의 **Claude Haiku 계열만**
  가격이 게스트 개방 조건(최악 턴 ≤ standard 1크레딧의 3배 커버)에 맞지 않아도
  허용합니다. Haiku 5.5의 100,000토큰 장문 tier가 입력 상한 안에서 원가를 낮게
  기록할 수 있다는 위험까지 수용한 결정이며, 다른 모델의 같은 경계는 이 예외가
  아닙니다: docs/policy/credit-and-cost-limits.md "Haiku 계열을 게스트 Anthropic
  자리로 여는 예외".
- **기본 3모델 구성은 Admin 설정입니다**(2026-10-12 운영자 결정, 정책 문서
  "기본 3모델 구성은 Admin 설정입니다"). `AppSetting["guestBrandTrioModelIds"]`가
  정하고, 코드 trio는 행이 없거나 읽을 수 없을 때의 비상값입니다. 저장 검증은
  `guestBrandTrioRejection()`(활성 · 공개 · Guest · Standard · 검증된 가격 · 서로
  다른 3개 · OpenAI · Anthropic · Gemini 각 1개) 한 곳이고, 선두는 그 구성 안에서만 고르며 구성과 한 트랜잭션으로 저장합니다.
  구성을 쓰는 모든 곳(첫 렌더, 신규 계정, Admin 설명, 서버 선두 판정,
  `check:default-models`)은 `getPublicAppSettings()` 또는 `readGuestLeadFacts()`가
  해석한 같은 구성을 받습니다 — 컴파일된 trio를 직접 읽지 않습니다.
- **은퇴한 구성원의 자리는 대체 모델이 이어받습니다.** resolver에
  `resolveReplacement`를 넘기면 비활성 구성원의 `replacementModelId` 체인을 따라가
  같은 자리·같은 순서에 넣고, 자격이 없을 때만 fallback 목록으로 채웁니다. 서버와
  브라우저가 같은 catalogue에 묶어야 첫 렌더가 어긋나지 않습니다.
- **기본 선택을 계산할 때는 `createDefaultLineupEligibilityCheck()`를 씁니다.**
  호출자의 자격 검사(새 계정 첫 비교는 Free, 나머지는 게스트)에
  `isDefaultLineupServable`을 더한 것이라 `limited`·비공개가 된 구성 모델은
  승계됩니다. 사람이 고른 선택의 clamp는 게스트 자격 그대로입니다.
- **`gpt-5-4-mini`는 은퇴하지 않았습니다.** enabled·publiclyListed 상태를
  유지하는 것은 의도된 관찰 기간입니다.
- **수치 eval 통과는 은퇴의 필요조건이지 충분조건이 아닙니다.** 정책 문서
  4.3(수치)과 4.6(사용량·고정 사용자 비율, 도구 호환성, support·공유 링크,
  안내·유예기간, staging 검증)을 **모두** 충족해야 은퇴할 수 있습니다.
- **eval 표본 하한은 규칙마다 다릅니다.** 합산 규칙(오류율·빈 응답률)은 arm당
  ≥300(권장 500), **시나리오별 5%p 규칙은 시나리오당 ≥100**입니다 —
  `--repeats=25`면 시나리오당 25회라 해상도가 4%p여서 5%p 기준을 판정할 수
  없습니다. 판정은 점추정이 아니라 Wilson 95% 구간 경계로 합니다.
- **`--repeats=25`를 돌렸다는 사실만으로 decision-grade가 아닙니다.** 정책 문서
  4.5.1의 절차 — 사전 점검, 네 arm 동일 commit·동일 실행, `--json` 증거 보존
  (manifest·원본 기록·블라인드 검토 세트), 블라인드 정성 검토, 다른 시간대
  독립 재실행, staging 수동 검증 — 을 모두 묶어야 인용할 수 있습니다.
  `scripts/evalDefaultModel.mjs`가 `SMOKE RUN`·`PARTIAL RUN`·`UNDERPOWERED`·
  dirty tree를 경고로 출력합니다.
- **긴급 운영 비활성화는 품질 eval과 분리합니다.** 공급자 장애·폐기·보안 사유는
  4.3·4.6을 기다리지 않고 운영 lifecycle로 즉시 내릴 수 있으며, 이는 이 문서의
  은퇴가 아닙니다(4.7). `operationalReason`이 제품 은퇴와 운영 중단을 구분해야
  합니다.
- OpenAI는 `gpt-5.4-mini`를 계속 서비스합니다. 은퇴하더라도 공급자 종료가
  아니라 **Tomverse 제품 카탈로그 결정**입니다.
- **은퇴는 마케팅 갱신과 한 변경으로 배포합니다.** 공개 마케팅이 지목하는 모델
  ID는 `lib/marketingModelReferences.ts` 하나뿐이고
  `tests/marketingModelReferences.test.mjs`가 이를 강제합니다. 문구·CTA·배지·결과
  라벨·ko/en·SEO metadata·deep link·캡처 fixture는 사람이 함께 옮깁니다. mini로
  생성된 예시 답변은 이름만 바꾸지 말고 재생성하거나 과거 결과임을 유지합니다.
- **`reservationOutputBasis`를 p90으로 바꾸려면 정책 문서 3.1의 9개 조건**
  (모델별 독립 산출, 기간·표본 수, workload 분리, 정산된 출력·과금 reasoning
  토큰, 중단·부분 응답 포함, 동질 표본, 감사 보관, 안전 여유·floor, drift 감시)
  을 충족하고 새 `pricingVersion`으로 구분합니다. 그 전까지는
  `conservative_default`를 유지합니다.
- 두 모델 모두 Guest 계층 Standard **1크레딧**입니다. 은퇴 평가 중에 크레딧을
  임의로 바꾸지 않고, 기존 mini 사용자를 Terra·Sol 같은 상위 유료 모델로
  자동 이동시키지 않습니다.
- 사용자 선택 상태(`UserSettings.defaultModel`,
  `Conversation.selectedModels`)의 일괄 이전은
  `scripts/run-default-model-reconciliation.mjs`가 담당하며 **은퇴 배포와 함께**
  실행합니다. dry run은 자유롭지만 **쓰기에는 `--approved-retirement`·티켓·
  실행자·대상/대체 모델이 모두 필요하고, CI와 build/start/deploy/migrate
  lifecycle에서는 어떤 승인으로도 쓰지 않습니다.** `Conversation.selectedModels`는 문자열 치환이 아니라 JSON 배열로
  파싱해 변환하고, malformed 값은 파괴하지 않고 보고합니다.
- 과거 `Message.modelId`, usage reservation/settlement의 modelId와 pricing
  snapshot, 결제 ledger, `catalogDeleted`는 소급 변경하지 않습니다.
- **"새 대화 기본 조합"은 세 번째 독립 결정입니다**(정책 문서 1.2).
  `UserSettings.newConversationModelIds`(`Json?`, default 없음)가 로그인
  사용자의 새 대화 시작 상태의 source of truth이고, `NULL`은
  `[defaultModel]`로 해석합니다. 해석은 `lib/newConversationModels.ts`의
  공통 resolver만 담당합니다. 조합을 저장하는 모든 쓰기 경로는 첫 항목과
  `defaultModel`을 같은 transaction에서 동기화합니다.
- **읽기 경로는 DB를 rewrite하지 않습니다.** `GET /api/user/settings`가
  비활성 기본 모델을 발견해도 stored 값은 보존하고 effective 상태와
  `modelSelectionNotice`만 반환합니다. 영구 변경은 사용자의 명시적 재저장
  또는 승인된 retirement reconciliation뿐입니다. 저장 성공 응답은 요청
  echo가 아니라 실제 DB 저장값만 반환합니다. UI 계약은
  `docs/ui-contracts/account-model-settings.md`.

# 공유 package와 framework 순수성

`packages/**`, workspace 설정, `transpilePackages`, `eslint.config.mjs`의
`no-restricted-imports` 규칙을 건드리기 전에 읽습니다.

- `docs/policy/shared-packages.md`

절대 조건:

- **`packages/*`는 세 환경에서 그대로 돌아야 합니다** — Next.js 서버, 브라우저
  번들, Capacitor shell. 한 곳에서만 해석되는 import 하나가 공유 package를
  "디렉터리만 다른 app 코드"로 되돌립니다.
- **금지 import**: `next`·`next/*`, `server-only`·`@/*`·`@prisma/client`·
  `next-auth`, `node:*`와 bare Node builtin, `@capacitor/*`·`react-native`.
  플랫폼 의존은 port로 주입합니다.
- **package는 `dependencies`·`peerDependencies`를 선언하지 않습니다.**
  dependency block은 어떤 소스 파일도 이름을 대지 않은 채 framework가 돌아오는
  경로입니다. `"type": "module"`은 필수입니다.
- **package tsconfig는 root를 `extends`하지 않습니다.** `lib`는 `["ES2022"]`,
  `types`는 `[]`, `paths` 없음 — `window`·`process`·`Buffer`가 해석되지 않는
  것이 요점입니다. ESLint는 금지된 *import*를, 이쪽은 금지된 *global*을
  잡습니다.
- **PACKAGE-01 지표는 ESLint 자체 API로 셉니다**
  (`npm run check:shared-packages`). 별도 scanner를 만들어 두 숫자가 어긋나게
  하지 않습니다.
- **seed는 이동이지 재export shim이 아닙니다.** `lib/`에 shim을 남기면 예전
  import 경로가 계속 동작하므로 경계를 강제하는 것이 아무것도 없습니다.
- **PACKAGE-01은 `approved`입니다**(2026-08-12, `@mposition`). 증거는
  `docs/release-gates/evidence/PACKAGE-01-2026-08-12.md`에 commit SHA와 CI run
  링크로 남아 있고, 그 승인이 덮는 범위는 **존재하는 두 package가 한 commit에서
  framework-neutral했다**는 것까지입니다 — `chat-ui`·`api-client`가 생기면
  다시 읽습니다.
- **artefact가 있다는 것과 승인 가능한 증거가 있다는 것은 다릅니다.** registry는
  `evidenceRefs`에 immutable link 또는 artifact identifier를 요구합니다. script가
  tree에 있다는 사실은 그 어느 것도 아닙니다.
- **한 사람이 두 역할을 겸하는 것은 registry에 기록된 허용입니다**
  (`approvalPolicy.soleApproverAllowed`). 1인 조직에서 "서로 다른 두 사람"
  규칙은 엄격한 것이 아니라 충족 불가능하며, 모든 blocking gate가 영원히
  승인 불가가 됩니다. 남은 분리는 **증거를 만든 주체(대개 자동화)와 승인자가
  다르다**는 것이고, 승인자는 사람이어야 합니다. 두 번째 담당자가 생기면
  `soleApproverAllowed`를 `false`로 되돌리는 한 줄이면 됩니다 — validator가
  그 field를 읽습니다.
- 승인 없이 `status`·`approvedBy`·`approvedAt`·`evidenceRefs`를 건드리지
  않습니다.
- 표준 `tsc` project를 build matrix라고 부르지 않습니다. bundler가 아닙니다.

<!-- BEGIN:mobile-chat-composer-invariant -->
# 채팅 첨부 형식과 압축파일

채팅 입력으로 받는 파일 — 형식 목록, MIME 판정, 업로드 검증, ZIP 해제 — 을
건드리기 전에 읽습니다.

- `docs/policy/chat-attachment-formats.md`

절대 조건:

- **형식은 표 하나입니다.** `lib/chatAttachmentFormats.ts`의
  `CHAT_ATTACHMENT_FORMATS`에서 picker의 `accept`, 클라이언트의 확장자→MIME
  정규화, 업로드 준비·finalize 허용 목록, 메시지 처리 분기, 게스트 부분집합,
  사용자 안내가 전부 파생됩니다. 두 번째 목록을 만들지 않습니다 — 목록이
  넷으로 갈라져 있던 것이 이 정책을 만든 사고입니다.
- **목록에 있다는 것은 실제로 읽을 수 있다는 뜻입니다.** 확장자만 허용하고
  분석에 실패하는 가짜 지원은 금지입니다. 그래서 `.doc`·`.xls`·`.ppt`·`.rtf`는
  안전한 파서가 없어 목록에 없습니다.
- **이름이 정하고 MIME은 힌트입니다.** 브라우저가 MIME을 비워도 알려진
  확장자면 처리하고, 이름과 MIME이 각각 다른 형식을 가리키면 거절합니다.
  확장자가 없으면 거절합니다.
- **거절 기준은 "열면 실행되는가"입니다.** `.sh`·`.ps1`·`.py`는 지원하고
  `.exe`·`.msi`·`.bat`은 거절합니다. 어떤 소스코드도 실행·컴파일·동적 import
  하지 않습니다.
- **finalize는 실제 바이트를 봅니다.** 로그인 경로도 R2 메타데이터가 아니라
  `validateChatAttachmentUpload()`를 통과해야 하고, 실패한 객체는 즉시
  삭제합니다.
- **깨진 인코딩은 오류이지 복구 대상이 아닙니다.** U+FFFD로 조용히 치환하지
  않습니다. BOM이 있는 UTF-16은 변환합니다.
- **애니메이션 GIF는 첫 프레임으로 대체하지 않고 거절합니다.** 판정은
  `lib/gifStructure.ts`의 블록 walk이며 libvips의 페이지 수가 아닙니다.
- **ZIP은 중앙 디렉터리를 먼저 읽고, 거절하거나 고르고, 그 다음에만 풉니다.**
  푼 크기는 디렉터리가 약속한 크기와 대조하고, 어긋나면 거절입니다. 디스크에
  쓰지 않습니다. 중첩 깊이는 0입니다.
- **압축 한도는 외부 대화 가져오기의 한도와 다릅니다.** 그쪽은 브라우저에서
  열고 서버에 보내지 않으며, 이쪽은 채팅 요청 안에서 서버가 풉니다.
  `lib/externalImportLimits.ts`의 숫자를 빌려오지 않습니다.
- **내부 항목은 일반 첨부와 같은 함수를 지납니다.** 컨테이너가 이미지 개수,
  payload 상한, 추출 텍스트 예산, OCR 허용량을 우회하는 길이 되어서는 안 됩니다.
- **오류에 항목 경로·파서 메시지·R2 key·파일 내용을 싣지 않습니다.** 코드만
  전달하고 문장은 `lib/chatAttachmentErrorCopy.ts`가 locale로 옮깁니다.
- **Office 97-2003과 RTF는 자체 파서로 읽습니다**(`lib/legacyOffice/**`,
  진입점 `lib/legacyOfficeText.ts`). 복호화하지 않고(암호 문서는
  `ATTACHMENT_ENCRYPTED`), 매크로 저장소·임베디드 객체·그림을 열지 않으며,
  아무것도 실행·평가·fetch 하지 않습니다. 파싱했는데 텍스트가 없으면 거절이지
  빈 문자열이 아닙니다.
- **이 네 파서는 워커가 아니라 예산으로 묶습니다.** eval된 워커는 저장소
  `lib/`의 모듈을 `require`할 수 없으므로 `sharp`·`officeparser`·`pdfjs`의
  방식을 쓸 수 없습니다. 대신 `lib/legacyOffice/budget.ts`의 deadline·byte
  상한·문자 상한·iteration backstop이 모든 루프에 걸립니다. 이 파일들에 새
  루프를 넣을 때 `budget.tick()`을 빼면 그 방어가 사라집니다.
- **바이너리 파서의 정상 경로는 진짜 문서로 테스트합니다**
  (`tests/fixtures/legacyOffice/`). 자체 writer가 만든 파일로만 검증하면 둘이
  서로 동의한다는 것만 증명합니다. 거절 경로는
  `tests/support/compoundFile.mjs`로 바이트 단위로 만듭니다.

# 이미지 생성 (v2: 멀티 모델 비교)

이미지 생성 관련 코드를 건드리기 전에 읽습니다.

- `docs/policy/image-generation.md` (v2 개정 docs/policy/image-generation.md §11–docs/policy/image-generation.md §15 포함)

절대 조건:

- **핵심 계약은 멀티 모델 비교입니다.** 단일 모델 요청은 1-모델 그룹의
  특수한 경우입니다. 채팅 admission token은 재사용하지 않습니다 —
  `modelIds` 단일 POST가 한 트랜잭션에서 그룹·target·attempt·예약·
  admission·budget을 원자 생성하고, 거절은 행도 비용도 남기지 않습니다.
- **그룹 상태는 저장하지 않습니다.** 각 target의 최신 attempt에서
  파생하며, 재시도는 새 그룹이 아니라 같은 target의 새 attempt입니다.
  succeeded target 재실행은 거부합니다(이중 과금 금지).
- **고정 성공 가격은 최악 원가가 유한할 때만 유지됩니다.** thinking
  상한을 공식 문서로 확인할 수 없는 모델은 fail-closed로 비활성입니다.
  `ceil(maxCost/900µ)`이 수학적 최소 크레딧이고 판매 크레딧은 별도
  승인입니다. 이미지 가격 검증은 텍스트 모델의
  `PENDING_VERIFIED_PRICE_REGISTER`와 별개 계층입니다.
- **budget은 provider별 총액입니다**(`IMAGE_PROVIDER_{P}_COST_*`).
  모델별은 관측 차원일 뿐입니다. 동시성은 workflow(활성 그룹 수)와
  execution(provider별 job 수) 두 층입니다.
- **Guest·Free는 전 위치 잠금 노출**(비노출·마지막 단계 차단 금지)이고,
  이미지 결과 비교는 `comparison-action-rail`의 원칙만 차용하며 계약·
  컴포넌트를 직접 재사용하지 않습니다. AI Review는 이미지 대화에서 계속
  금지입니다.
- **v1 flag는 staging 검증 전용입니다.** 멀티 모델 UX 완성 전 production
  공개 활성화 금지, Google 모델은 가격 검증 통과 전 활성화 금지.

# 사용자 입력 첨부파일

사용자가 보낸 파일의 저장, 참조, 조회 응답, 삭제를 건드리기 전에 읽습니다.

- `docs/policy/user-attachment-persistence.md`

절대 조건:

- **클라이언트는 저장 위치를 말하지 않습니다.** 업로드 완료 단계가 발급한
  불투명한 `uploadId`, 또는 저장된 메시지의 `attachmentId`로만 참조합니다.
  `messageAttachmentReferenceSchema`는 `.strict()`이며 `objectKey`·`data`·
  `bytes`·`path`가 실린 참조를 파싱 단계에서 거절합니다. 게스트만 예외이고,
  그 key는 게스트 자신의 서명된 신원에서 유도되므로 key가 곧 권한입니다.
- **해석은 `userId`를 `where` 안에 넣습니다.** 남의 id는 "거절"이 아니라
  "없음"이고, 차이를 보고할 분기가 존재하지 않습니다.
- **`objectKey`·바이트·data URL·추출 본문·서명 URL은 어떤 응답에도 넣지
  않습니다.** 대화 조회는 `PUBLIC_MESSAGE_ATTACHMENT_SELECT` 6개 필드만
  이름 대며 `include`를 쓰지 않습니다. 입력 첨부에는 다운로드 route가 없습니다.
- **메시지 저장과 첨부 결속은 한 트랜잭션입니다.** `(messageId, ordinal)`
  unique가 멱등성 키이므로 재전송된 pre-save가 카드를 복제하지 않습니다.
- **첨부만 있는 메시지를 파일명 문자열로 대체하지 않습니다.** `content`는 비어
  있을 수 있고, 그것이 이 정책이 고친 결함입니다.
- **한 모델의 assistant history 초기화는 공통 사용자 첨부를 지우지 않습니다.**
  첨부는 세 패널이 공유하는 질문에 속합니다. 삭제는 대화·계정 전체에서만
  일어나고, DB 트랜잭션에서 tombstone을 먼저 남긴 뒤 15분 cron이 객체를
  지웁니다. 실패·재시도·최종 상태는 구조화 로그로 남깁니다.
- **모델에게는 요청 범위 handle(`att_1`)만 줍니다.** row id도 storage key도
  주지 않습니다.
- guest localStorage 대화의 기존 첨부 동작은 바뀌지 않습니다.

# AI 생성 파일 (Generated Artifact)

채팅 답변이 만들어 내는 실제 파일 — tool 정의, 명세, 형식 표, 생성기, 저장,
다운로드 권한, 수명주기 — 를 건드리기 전에 읽습니다.

- `docs/policy/generated-artifacts.md`

절대 조건:

- **앱이 파일을 만들지 못했으면 만들었다고 말하지 않습니다.** 코드블록,
  base64, sandbox 경로(`/mnt/data/...`), 가짜 링크는 파일의 대체물이 아닙니다.
  파일 생성 요청의 결과는 다운로드 가능한 artifact이고, 안 되면 왜 안 되는지와
  무엇을 하면 되는지를 말합니다.
- **구조가 있는 형식에서 모델은 명세만 만들고 바이트는 서버가 만듭니다.**
  tool은 형식마다가 아니라 종류마다 하나입니다 — `create_spreadsheet`,
  `create_document`, `create_presentation`, `create_text_file`,
  `create_archive`. 입력은 Zod로 검증된 명세이며, tool schema는 힌트일 뿐이라
  `admit*Spec()`이 `execute` 안에서 다시 판정합니다. 명세에 `formula` 필드는
  없고 writer는 `<f>` 요소를 쓰지 않습니다.
- **소스 코드·마크업·설정은 모델이 텍스트를 직접 씁니다.** Python module에는
  "그 텍스트"가 아닌 명세가 없기 때문이고, 대신 제한된 크기·이 앱이 정한
  확장자·구조 검사(JSON·YAML·XML·SVG)·다운로드 전용 전달이 적용됩니다.
  SVG의 `<script>`·event handler·`javascript:`는 거절합니다.
- **형식은 표 하나입니다.** `lib/generatedArtifactFormats.ts`의
  `ARTIFACT_FORMAT_TABLE`이 확장자·media type·kind·검증·label을 함께 정합니다.
  형식 추가는 표의 행 하나 + `lib/generatedArtifactRenderers.ts`의 분기 하나 +
  migration의 `format` CHECK뿐이고, 그 밖의 어디에도 형식별 분기를 만들지
  않습니다.
- **실행되는 형식은 만들지 않습니다**(`REFUSED_ARTIFACT_EXTENSIONS`). 기준은
  "열면 실행되는가"이므로 `.sh`·`.ps1`·`.py`는 지원하고 `.exe`·`.msi`·`.bat`은
  거절합니다. 같은 목록이 아카이브 항목에도 적용되므로 zip으로 우회할 수
  없습니다. 아카이브 경로는 정규화하지 않고 **거절**합니다.
- **조용한 퇴행이 없습니다.** 모든 turn이 artifact system block을 하나 싣고,
  tool을 못 쓰는 turn은 그 사실을 말하라고 지시받습니다. 가용성 판정은
  `planGeneratedArtifactTool()` 한 곳이며, 검증되지 않은 모델은 fail-closed
  입니다(`ARTIFACT_TOOL_CAPABILITIES`).
- **게스트는 MVP에서 파일을 만들 수 없습니다.** tool은 등록되지만 즉시
  거절하고, UI는 `blocked` 카드와 로그인 CTA를 보여 줍니다. 표·코드로 대신하지
  않습니다.
- **생성은 객체 먼저·행 나중, 삭제는 행 먼저·객체 나중**입니다. 행은 assistant
  메시지와 같은 트랜잭션에서 쓰고, 메시지를 쓰지 못한 모든 종료 경로는
  `releaseSafely()`에서 객체를 회수하며, tombstone queue와 orphan sweep이
  15분 cron에서 나머지를 정리합니다.
- **`objectKey`·저장소 URL·서명 URL은 클라이언트에 가지 않습니다.**
  클라이언트가 보는 것은 `ChatStreamArtifact` allowlist뿐이고, 다운로드는
  `GET /api/artifacts/{id}` 하나뿐입니다. 모델이 만든 URL은 다운로드 URL이
  아닙니다.
- **소유권·잠금 실패는 전부 404**입니다(잠금만 423). 조회 자체가 `userId`로
  범위를 잡으므로 "없음"과 "남의 것"을 구분할 분기가 존재하지 않습니다.
- **web search와의 충돌은 검색이 이깁니다.** 강제된 native 검색
  (`toolChoice: "required"`)과 Google grounding에서는 artifact tool을 등록하지
  않습니다. Anthropic 검색은 공존합니다.
- **요청한 형식으로 만듭니다.** xlsx를 csv로, docx를 md로 대체하지 않습니다.
  표에 없는 확장자는 지원하지 않는다고 말합니다.
- **시작만 하고 실행되지 못한 tool 호출도 카드를 남깁니다**(docs/policy/generated-artifacts.md §9).
  출력 길이 제한으로 끝난 turn(`incomplete`/`length`)에서 `tool-input-start`는
  났지만 실행에 도달하지 못한 artifact tool 호출은 `turn_incomplete` 실패로
  기록합니다. 추적은 `lib/generatedArtifactTurnTracker.ts`, 기록은
  `recordIncompleteToolCalls()`입니다. **native tool은 세지 않고**, 부분 tool
  input은 읽지도 남기지도 않으며, 상한과 ordinal·persistence 계약은 그대로입니다.
  `maxOutputTokens`나 `ARTIFACT_LIMITS`를 올리는 것은 이 결함의 답이 아닙니다.
- **billing의 `allowDownloads`를 재사용하지 않습니다.** 그 권한은 대화 TXT
  내보내기의 것이며, 생성 파일은 로그인한 모든 계정이 쓸 수 있습니다:
  docs/policy/generated-artifacts.md §11.
- **"최대 3개"는 top-level artifact 상한입니다**(docs/policy/generated-artifacts.md §13). 문서 개수 상한이 아니며,
  archive는 그중 하나로 세면서 100개를 담습니다. 이 상한을 올려 batch 요구를
  해결하지 않습니다 — archive 안에 서버 렌더링 문서를 넣는 것이 답입니다.
  system prompt에서 `N files per answer` 같은 문장은 금지이며
  `tests/generatedArtifactToolPolicy.test.mjs`가 이를 강제합니다.
- **첨부된 DOCX 템플릿은 복사해서 채웁니다**(docs/policy/generated-artifacts.md §13.4). 추출 텍스트로 다시 쓰면
  styles·theme·표·header/footer·section·이미지가 사라집니다. 매크로·OLE·
  external relationship·altChunk·외부를 읽는 field code·비정상 ZIP entry는
  **제거가 아니라 거절**입니다. 필수 placeholder 누락과 미해결 placeholder는
  배치 전체를 실패시킵니다 — 부분 성공은 없습니다.
- **batch tool은 handle 두 개와 이름 규칙만 받습니다.** bytes·base64·XML·
  objectKey·로컬 경로를 담을 field가 schema에 없고 `.strict()`이므로 추가할 수도
  없습니다. 행 값은 서버가 스프레드시트에서 직접 읽습니다.
- **OOXML package 변경은 검사기가 아니라 대상 application에서 확인합니다.**
  master마다 theme part를 하나씩 쓰고, `<a:spLocks noGrp="1"/>`를 쓰는 shape는
  자기 `<p:ph>`를 갖습니다. theme을 공유한 deck은 ECMA-376 XSD와 Microsoft
  OpenXmlValidator를 Office 2007~2021 여섯 버전 모두에서 통과하면서 PowerPoint가
  열지 못했습니다: docs/policy/generated-artifacts.md §4.

# Trace 기반 오류 신고 자동화

feedback의 Trace 검증, `errorReportToken`, `TraceErrorEvidence`, chat 오류
응답 builder를 건드리기 전에 읽습니다.

- `docs/policy/trace-feedback-automation.md`

절대 조건:

- **Trace ID 문자열은 인증 수단이 아닙니다.** provenance
  (`server_generated`/`client_supplied`/`client_fallback`/`unknown`)를
  구분하고, 사용자 입력 Trace만으로 자동화 적격성을 인정하지 않습니다.
- **token은 서버가 직접 생성한 Trace의 server-classified 오류에만 중앙
  발급합니다** (`issueChatErrorReportGrant` 한 곳). client/Edge Trace와
  client-classified `EMPTY_RESPONSE`에는 발급하지 않고, 정상 stream에
  선발급하지 않습니다. token 모듈은 Node 전용이며 `proxy.ts`/Edge bundle에
  import하지 않습니다.
- **원시 token은 저장·전송 금지.** feedback 제출 body 1회가 유일한 예외이고
  서버는 검증 후 즉시 버립니다. `Message.errorReport`는 runtime 전용이며
  모든 직렬화는 `lib/chatMessageSerialization.ts`의 allowlist를 통합니다.
- **evidence identity는 Trace ID와 독립입니다.** `traceId`를 PK·unique·
  upsert key로 쓰지 않고, 연결은 token payload의 `occurrenceId`로만 합니다.
- **feedback 제출과 Trace 검증은 분리됩니다.** 검증 실패는 신고 저장을 막지
  않습니다. verification/classification/evidence availability는 독립 관찰로
  별도 저장하며, client 분류를 server 사실로 승격하지 않습니다.
- **Phase 2는 diagnosis-only shadow mode입니다**
  (`FEEDBACK_AUTOFIX_SHADOW_ENABLED` 뒤에서 fail-closed).
  `FeedbackAutoFixCase`는 증거 수집·결정적 분류·진단 요약까지만 하며, 코드
  수정·branch·PR·LLM 호출이 없습니다. 상태 전이는
  `lib/feedbackAutoFixCore.ts`의 그래프만 허용하고 진단 요약에 사용자
  본문을 넣지 않습니다.
- **Phase 3(자동 수정)은 인프라만 존재하고 운영은 비활성입니다**
  (`FEEDBACK_AUTOFIX_ENABLED` + sync secret + 수동 dispatch 3중 잠금,
  docs/policy/trace-feedback-automation.md §9.1). LLM confidence를 자동 게이트로 쓰지 않고, 결정적
  Red→Green 증명 없는 자동 수정을 금지하며, 자동 생성 수정이 만드는 것은
  `develop` PR뿐이고 auto-merge는 켜지 않습니다. change policy는
  `lib/feedbackAutoFixPolicy.ts`가 정의하며 파이프라인 자기 자신을 수정
  대상에서 제외합니다. staging 배포를 production 해결로 표시하지 않습니다.
- **승격은 소유자 승인 + 사람의 GitHub 병합 + 서버 관측입니다**
  (docs/policy/trace-feedback-automation.md §9.3). **자동화는 어떤 PR도 병합하지 않고 `--admin`도 쓰지 않습니다.**
  승인은 PR head와 change manifest(경로별 before/after blob)에 묶이고, main
  승격 PR은 manifest가 승인과 완전히 같을 때만 인정합니다. GitHub·배포 사실은
  workflow 보고가 아니라 서버가 **읽기 전용** 자격증명으로 직접 읽으며, 배포는
  Railway control plane의 단일 live deployment + 다중 표본 + 10분 안정화 창으로만
  판정합니다. 서버에 GitHub 쓰기 토큰을 두지 않습니다.
- **검증된 Trace 신고는 `reviewing`으로 접수됩니다.** 사용자 입력 Trace는
  `open`에 남고, 자동 전환은 사용자에게 메일을 보내지 않으며 운영자 메일은
  `support_feedback` 한 통입니다. `Feedback.status`를 `resolved`로 바꾸는 것은
  운영자뿐입니다.

# 이메일 알림

이메일 발송 경로, 수신 동의·수신 거부, suppression, 관할권 판정, 발송 템플릿을
건드리기 전에 읽습니다.

- `docs/policy/email-notifications.md`

이 문서는 감사 보고서가 아니라 승인된 계약입니다. `.github/audits/`에 있던
초안을 `docs/policy/`로 옮긴 것이며, 코드 주석의 인용은 전부 이 경로를 가리킵니다.

절대 조건:

- **차선(lane)이 둘이고 보증이 서로 반대입니다.** credential synchronous
  lane(로그인 코드 등)은 요청 안에서 예산 안에 보내고 실패를 즉시 알리며,
  standard lane은 outbox에 넣고 cron drain이 끝까지 재시도합니다. 수명이 10분인
  자격증명을 15분 주기 큐에 넣지 않습니다(§9.4a).
- **enqueue는 호출자의 transaction 안에서 합니다.** fire-and-forget 발송을
  되살리지 않습니다 — 그것이 이 시스템이 대체한 것입니다(docs/policy/email-notifications.md §2.4).
- **security·billing 수신 설정은 끌 수 없습니다**(`LOCKED_EMAIL_PURPOSES`,
  DB CHECK). marketing은 동의가 있어야 보내고, 동의 철회는 purpose 범위
  suppression을 함께 씁니다.
- **신고 처리 결과 답변은 동의가 아니라 주소로 판정합니다**(정책 v12,
  docs/policy/email-notifications.md §3). 신고자가 시작한 요청에 대한 응답이므로
  transactional이고, 접수·검토중 알림만 동의 기반입니다. 세 단계를 한 조건으로
  묶지 않습니다 — `feedbackStageRecipient()`가 유일한 판정이고, 운영자 화면은
  "보낼 수 있는가"를 그 함수로 말해야 합니다. 2026-09-15에 세 단계를 하나로 묶은
  조건 때문에 운영자가 쓴 답변이 아무에게도 가지 않았습니다.
- **suppression은 주소 기준이라 계정 삭제 후에도 남습니다.** transactional은
  hard bounce에서만 막고 complaint로는 막지 않습니다(docs/policy/email-notifications.md §13.3). Resend의 suppression은
  계정·region 전체 범위라는 확인된 제약이 있으므로, marketing 활성화 전에
  발송 계정 분리를 결정합니다(docs/policy/email-notifications.md §5.3.1, A18).
- **IP로 추정한 국가는 기록하고 판정에 쓰되, 더 강한 신호가 이깁니다**(소유자 승인
  2026-09-29, S0). 신호 우선순위는 결제 국가·자기 신고 → 직전 동의 시점의 관할권 →
  **IP 추정 국가**이고, 사용자는 설정에서 언제든 국가를 정정합니다(자기 신고가 추정을
  덮습니다). 추정이 언어·시간대가 가리키는 나라와 다르면 두 후보를 모두 통과해야
  보내며, 한 후보씩만 판정하는 동안에는 그 경우를 충돌로 보고 보류합니다. 추정조차
  없으면 `ZZ`이고 marketing은 보내지 않습니다(docs/policy/email-notifications.md §6).
- **국가 규칙은 데이터입니다.** `JurisdictionProfile`·`JurisdictionCountryMap`은
  `EmailPolicyVersion`에 묶이고, 활성화는 사람이 승인해 registry에 기록하는
  행위입니다. 코드가 status를 스스로 `active`로 올리지 않습니다(§12.5).
- **자격증명 본문은 어디에도 남기지 않습니다.** 코드·magic link는
  `EmailEvent.payload`, `renderDataSnapshot`, 로그 어디에도 넣지 않습니다.
  standard lane의 snapshot은 봉투 암호화하고 보관 기한이 지나면 지웁니다(docs/policy/email-notifications.md §10.3).
- **스트림마다 발송 도메인이 다릅니다.** marketing은 `MARKETING_EMAIL_FROM`이
  없으면 transactional 주소로 대체되지 않고 **거부**합니다 — 대체는 프로모션
  스팸 신고를 로그인 코드가 나가는 도메인에 얹는 일이고, 증상은 로그인 메일이
  안 온다는 신고로만 나타납니다. 두 스트림을 같은 도메인에 설정하면
  `/api/ready`가 실패합니다. 절차는 `docs/ops/email-sending-domains.md`.
- **unsubscribe는 로그인 없이 한 번에 됩니다.** RFC 8058 one-click을 지원하고,
  marketing에 서명 키가 없으면 헤더 없이 보내는 대신 발송을 거부합니다(docs/policy/email-notifications.md §11.3).
- marketing은 위 suppression 경계 결정 전까지 production에서 비활성입니다.

# 마케팅 자동화

마케팅 게시·승인·채널 연결·Guard·마케팅 테이블, 그리고 시스템 actor 감사 기록을
건드리기 전에 읽습니다.

- `docs/policy/marketing-automation.md`

절대 조건:

- **사람 감사와 시스템 감사는 하나의 해시 체인입니다.** 두 writer 모두
  `lib/adminAudit.ts`의 같은 append 함수를 지나며, 감사 테이블에 직접 쓰지
  않습니다. 시스템 기록은 `writeSystemAuditLog()`만 쓰고, 호출자의
  트랜잭션이 필수입니다. `npm run check:protected-table-writers`가 writer 밖의
  직접 쓰기와 새 runtime SQL 호출을 PR Fast Gate에서 막습니다.
- **시스템 actor는 닫힌 목록입니다**(`lib/adminAuditSystemActors.ts`).
  `metadata.systemActor`는 예약 키라서 두 writer 모두 호출자가 넣은 값을
  거절합니다. "사람이 승인했는가"를 묻는 검사는 `auditRowActorKind()`로 판정하고
  `unknown`을 사람으로 취급하지 않습니다.
- **마케팅 변경 권한은 `marketing:write`이고 owner·ops만 갖습니다**
  (`lib/adminAuthCore.ts`). 모든 변경 route가 권한과 step-up을 route 안에서
  직접 검사합니다.
- **마케팅 승인은 `AdminActionApproval`을 쓰지 않습니다.** 시스템 초안을 사람
  1명이 승인하는 별도 계약입니다: docs/policy/marketing-automation.md §6.
- **Instagram·TikTok은 자율 모드로 졸업하지 않습니다**(정책 문서의 O15).
- 구현 단계는 docs/policy/marketing-automation.md §14가 대략의 순서입니다. 아래 경로 목록은 안내이고, 새 기능이 여기에
  항목을 추가할 의무는 없습니다.
- **S2a(읽기)**: `app/(site)/(application)/admin/marketing/**`,
  `app/api/admin/marketing/route.ts`, `lib/marketingConsoleRead.ts`,
  `lib/marketingConsoleSections.ts`, `components/admin/AdminMarketingPanel.tsx`,
  `lib/adminMessages/marketing.ts`. 읽기는 일반 관리자 인증만 요구합니다
  (docs/policy/marketing-automation.md §6.1의 기록 열람). `marketing:write`도 step-up도 요구하지 않습니다 — 재인증이 만료된
  운영자가 "왜 아무것도 안 나갔지"를 보러 왔을 때 거절하면 막힌 파이프라인이
  아니라 고장 난 콘솔로 읽힙니다.
- **S2b1(계정 쓰기)**: `app/api/admin/marketing/accounts/**`,
  `app/api/admin/marketing/settings/route.ts`, `lib/marketingAdminMutations.ts`.
  **모든 변경 route는 `runMarketingAdminMutation`을 지납니다** — 권한·step-up·
  스위치 판정·감사와 상태 변경의 같은 트랜잭션이 거기 한 곳에 있고,
  `tests/marketingS2b1Store.test.mjs`의 sweep이 우회를 실패로 만듭니다.
  게이트는 셋입니다: 수동 승인(초안 스위치 + kill switch 아님), 계정 제어
  (kill switch만), 그리고 **멈추거나 좁히는 변경은 아무것도 요구하지 않습니다** —
  스위치가 거절할 수 있는 정지는 정지가 아닙니다.
- **S2d(게시기)**: `app/api/internal/marketing-publisher/route.ts`,
  `app/api/_marketing/zernioAdapter.ts`, `lib/marketingPublisherRun.ts`,
  `lib/marketingPublisherBatch.ts`, `lib/zernioPublishAdapter.ts`.
  **`ZERNIO_API_KEY`는 `app/` 경계에서만 읽고 `lib/`에는 만들어진 adapter만
  넘깁니다.** publisher의 트랜잭션은 전부 `lib/marketingPublisherRun.ts`의 이름
  붙은 bounded 연산이며, vendor 호출은 트랜잭션 밖에서만 합니다
  (`tests/marketingPublisherBoundedCallers.test.mjs`). statement 예산은 측정값이고
  `tests/marketingPublisherStatementBudget.test.ts`가 고정합니다 — store 연산에
  statement를 더하면 그 테스트가 먼저 알립니다.
- **S2e(staging webhook shadow)**: `app/api/webhooks/zernio/route.ts`,
  `app/api/admin/marketing/webhook/**`, `lib/marketingWebhookCore.ts`,
  `lib/marketingWebhookReceiver.ts`, `lib/marketingWebhookSettings.ts`.
  **staging이 아니면 수신기는 본문을 읽지 않고 404이며, shadow 기록·fault arm·
  의도적 5xx 어느 것도 일어나지 않습니다**(배포 표식 환경변수와 해석된 배포
  환경이 둘 다 staging — `marketingWebhookIsStaging()`). `ZERNIO_WEBHOOK_SECRET`은 route와,
  운영자가 staging에서 실행하는 검증 기록 생성기의 서명 변조 probe에서만 읽습니다(값은 출력하지
  않고 HMAC 계산에만 씁니다, 운영자 승인 2026-10-02). 게시물은 바꾸지 않습니다 — 적용은 S2f이고
  staging 서명 이후입니다.
- **S2e-verification(검증 기록과 서명)**: `lib/marketingWebhookRecordDraft.ts`,
  `lib/marketingWebhookVerification.ts`, `scripts/marketing-webhook-verification-record.mjs`,
  `app/api/admin/marketing/webhook/verification-sign/route.ts`. **증거는 현재 빌드가 현재 설정에서
  답한 전달만**입니다 — 수신기가 응답마다 pipeline fingerprint와 설정 digest를 찍고, 생성기는 그
  표식이 맞는 전달만 셉니다. **fingerprint는 사건을 정하는 코드만 hash합니다**(운영자 결정
  2026-10-15, docs/policy/marketing-automation.md §8.1.1의 "조건 1–5에 영향을 주는 코드"):
  webhook 모듈(접근 모듈의 pipeline 파일 목록)은 파일 전체, 그 밖에 닿는 파일은 webhook 경로가 쓰는
  최상위 선언과 그 import 연결, 그리고 로드될 때 실행되는 최상위 코드만 주석 없이(`scripts/marketing-webhook-pipeline-sources.mjs`가 AST로 따라가며 손으로 고르지
  않습니다), 감사 체인·DB client(공용 모듈 목록)는 0입니다 — 새 감사 actor나 다른
  기능의 store 함수가 서명된 기록과 production 적용을 멈추게 하지 않기 위해서입니다. 새 `lib/marketingWebhook*.ts`는
  파일 전체 목록에 들어가야 하며 테스트가 강제합니다. schema는 수신 경로가 쓰는 모델·그 enum·datasource·generator만
  감시하고(운영자 결정 2026-10-03), 감시 모델 안의 감시 밖 모델을 가리키는 relation 필드(다른 기능의 역참조)는
  뺍니다(2026-10-15).
- **서명 가능 여부 보고**: `npm run report:marketing-webhook-record-signability`
  (`scripts/report-marketing-webhook-record-signability.mjs`,
  `scripts/report-marketing-webhook-record-signability-core.mjs`). 트리의 기록마다
  서명 route의 `checkMarketingWebhookRecordForSigning()`을 **그대로 불러** 그 답을
  출력합니다. **판정을 복제하지 않습니다** — 보고가 fingerprint를 자기 손으로
  비교하면 콘솔이 거절하는 기록을 signable이라고 말할 수 있고,
  `tests/marketingWebhookRecordSignability.test.mjs`가 그 회귀를 거부합니다.
  읽기 전용이며 gate가 아니고, signable이라는 출력은 서명 승인이 아닙니다 —
  서명은 production 콘솔에서 사람이 하는 행위이고, 콘솔은 production이 실제로
  돌리는 트리를 읽습니다.
- **S2f(production 설정 세대와 적용)**: `lib/marketingWebhookProductionConfig.ts`,
  `tests/marketingWebhookProductionConfig.test.ts`. staging 기록은 수신 경로만 증명하고
  production은 **따로 서명한 설정 세대**로 묶습니다(S1 r7 amendment 1). 환경을 건너는
  것은 pipeline fingerprint 하나이고, production digest는 이름부터 `production`이라 staging
  digest를 대신 내밀 수 없습니다. apply scope는 digest에 넣지 않습니다 — 범위를 좁혀도
  서명이 무효가 되지 않게 하고, 범위는 서명된 세대와 따로 대조합니다. 배포 commit은
  출처로 기록할 뿐 비교하지 않습니다 — fingerprint를 바꾸지 않는 release가 production
  적용을 조용히 멈추게 해서는 안 됩니다. 세대는 `OLD+1`이고, 저장값을 읽지 못했거나
  거절하는 값이면 그 위에 서명하지 않습니다.
- **S2f 적용 store**: `applyMarketingWebhookEvent()`·`marketingWebhookApplyTransition()`
  (`lib/marketingStore.ts` — 게시물 테이블의 유일한 writer), `tests/marketingWebhookApplyTransition.test.mjs`,
  `tests/integration/marketing-automation-schema.db.test.ts`의 webhook apply 절. 게시물은 provider post id
  **와** 이벤트의 채널로 찾고 행 잠금 아래에서 판정합니다. 중복 제거는 staging shadow 색인이 아니라
  그 게시물 이력의 `webhook_event` digest이며, 중복은 아무것도 쓰지 않습니다. 전이는 DB whitelist보다
  좁습니다 — 같은 상태는 확인(이력만 추가), 살아 있는 게시물의 플랫폼 삭제만 `removed_by_platform`으로
  옮기고, **`outcome_unknown`은 polling처럼 이벤트로도 풀지 않습니다**(사람만). 나머지는 게시물을 건드리지
  않고 `status_refused`만 씁니다.
- **S2f production 수신**: `lib/marketingWebhookProductionApply.ts`, `lib/marketingWebhookReceiver.ts`의
  `production` 경로, `app/api/webhooks/zernio/route.ts`, `recordMarketingWebhookApplyNotPermitted()`.
  **배포가 production이라고 밝히고 production 설정 세대가 서명돼 있을 때만** 본문을 읽습니다 — 그 전과
  dev·라벨 없는 빌드는 S2e처럼 읽지 않고 404입니다. 서명·envelope 다음에는 latch·shadow·상태 조회 없이
  production 경로로 넘깁니다. 판정은 판정 모듈의 `webhookApply` 하나이며, 감사 체인 잠금을 잡은 같은
  트랜잭션에서 판정하고 적용합니다 — scope·서명 writer도 그 잠금을 먼저 잡으므로 판정과 쓰기 사이에
  설정이 바뀌지 않습니다. 검증 기록의 서명은 별도 서명 파일이 아니라 서명된 세대의 감사 행이 이름 댄
  행이고, 지금 트리의 기록 digest로 다시 검증합니다. 판정이 거절하면 게시물을 읽지 않고
  `status_refused`(`apply_not_permitted`, 닫힌 사유)만 남기며, 우리 계정이 아닌 이벤트는 감사도 남기지
  않습니다. 판정 모듈은 kill switch 값을 받지 못하면 모든 기능을 거절하므로 실제 값을 넘깁니다.
- **S2f 서명**: `lib/marketingWebhookProductionConfigStore.ts`,
  `app/api/admin/marketing/webhook/production-config/route.ts`(POST, 서명),
  `app/api/admin/marketing/webhook/production-config/live/route.ts`(GET, 서명 전 화면이 볼 값),
  `tests/marketingWebhookProductionConfigStore.test.ts`. **배포가 스스로 production이라고 밝힐 때만**(APP_ENV 또는 RAILWAY_ENVIRONMENT_NAME) 서명합니다 — `resolveDeploymentEnvironment()`는 라벨 없는 production 빌드도 production이라 답하므로 쓰지 않습니다. 서명할 때 화면이 본
  값(다음 세대·기록·기록 서명 audit·배포 commit·fingerprint·실제 설정 digest)을 감사 행에 그대로
  묶고 store가 같은 트랜잭션에서 하나씩 다시 계산해 움직인 값을 거절합니다. 방금 쓴 감사 행은
  apply가 쓸 검증기로 다시 읽고, 검증되지 않으면 쓰기와 함께 되돌립니다. 거절 class는 store에
  닿지 않는 `lib/marketingWebhookProductionConfig.ts`에 둡니다 — route sweep이 트랜잭션 밖에서
  store 경로의 이름을 쓰는 것을 실패로 만듭니다.
- **S2f apply scope**: `app/api/admin/marketing/webhook/apply-scope/route.ts`(PATCH),
  `setMarketingWebhookProductionApplyScope()`. 값은 `{recordId, productionConfigGeneration, scope}`이고
  저장 바이트의 sha-256(`absent` 포함)으로 CAS합니다. 비어 있지 않은 범위는 그 세대가 서명돼 있고
  지금도 실제 설정을 묶으며, 모든 쌍을 그 기록이 관측했을 때만 저장합니다. **서명된 세대를 읽는
  모든 곳은 기록 파일의 지금 digest를 감사 요구 조건에 넣습니다** — 서명 행이 그 digest를 묶었으므로,
  같은 ID로 다시 쓴 기록(관측 쌍 추가 등)은 행과 맞지 않아 옛 서명으로 새 쌍을 덮지 못합니다.
  **빈 범위는 멈춤이라 아무것도 요구하지 않고**(서명·기록 없이도, kill switch 중에도) production에서만
  씁니다. 판정 모듈(`lib/marketingAutomationAccess.ts`)은 아직 이 형태를 읽지 못해 거절합니다 — 그
  모듈은 Prompt Refiner closure에 봉인돼 있어 repin이 필요하므로, 판정 연결은 production apply
  slice에서 한 번에 합니다.
- **S2f 콘솔**: `components/admin/MarketingWebhookProduction.tsx`,
  `tests/client/marketingWebhookProductionRender.test.tsx`, 읽기 route의 `?recordId=` 조회
  (`readMarketingWebhookProductionRecord()`). 서버가 production이라고 답할 때만 그리며, 서명에 보내는
  값은 운영자가 옮겨 적지 않고 화면이 읽은 값을 그대로 씁니다 — 기록 digest와, 그 바이트에 서명한
  검증된 감사 행도 서버가 찾아 줍니다. 범위는 서명된 세대의 기록이 관측한 쌍 중에서만 고르고,
  범위 비우기는 따로 언제나 제공합니다. 상태가 있는 wrapper와 hook 없는 view로 나눈 것은 render
  테스트가 view를 함수로 불러 각 action의 body를 직접 읽기 위해서입니다.
- **S3(생성 서비스와 A1·A3·A5)**: 계획 작성은 운영자 승인(2026-10-16)으로 Claude, 검토는 Codex입니다.
- **S3a(draft 접수)**: `app/api/internal/marketing-drafts/route.ts`, `lib/marketingDraftIntakeCore.ts`,
  `lib/marketingDraftIntakeStore.ts`, `tests/marketingDraftIntakeCore.test.mjs`,
  `tests/integration/marketing-draft-intake.db.test.ts`. **생성기는 신뢰하지 않습니다** — 제출에는 판정·상태·
  mode·템플릿·링크·예약 필드가 없고(strict), 앱의 Guard가 다시 판정합니다. 인증은 생성기 전용 secret
  하나(게시기 route와 같은 규칙), 서명은 마감 시각까지 포함한 요청 전체의 HMAC, 저장 key는 서버가 유도하고,
  같은 key에 다른 본문이 오면 접수 감사 행의 digest와 달라 conflict입니다. 판정·사실·Guard·게시물·
  `guard_result` 이력·감사가 감사 체인 잠금 뒤 한 트랜잭션이고, PG17 `transaction_timeout`을 마감까지
  남은 시간으로 걸어 늦은 성공을 서버가 되돌립니다. **이 빌드에서는 모든 제출이 거절됩니다** — 생성
  예산(S3c)과 가격 경보(S3d)가 아직 없어 접수 판정이 닫혀 있습니다. 감사 actor는 기존 `marketing-guard`입니다.
- **S3b(생성기 문맥)**: `app/api/internal/marketing-generator-context/route.ts`, `lib/marketingGeneratorContext.ts`,
  `lib/marketingGeneratorAuth.ts`(두 생성기 route가 공유하는 인증), `tests/integration/marketing-generator-context.db.test.ts`.
  POST만, run id 하나만 받고, 승인 모드 계정·근거를 뺀 claim 투영·최신 brief·시장 사실을 돌려줍니다. **URL은
  생성기에 가지 않습니다** — 모델은 URL을 쓰지 않으므로(docs/policy/marketing-automation.md §7.3) 시장 사실의 출처 URL도 빼고 보냅니다.
  자산은 id·실을 수 있는 플랫폼·alt가 있는 locale만 보냅니다(alt 문장·출처·표시 규칙은 보내지 않음).
- **S3a2(사실을 쓰기 트랜잭션 안에서)**: `lib/marketingFactResolution.ts`, `lib/marketingClaimGates.ts`,
  `lib/billingConfig.ts`의 `getBillingPlansWithFieldSources(database)`, `lib/billingPriceCatalog.ts`의
  `readBillingPriceCatalogSource()`, `tests/marketingFactResolution.test.mjs`. **사실은 호출자의 트랜잭션 하나와
  DB 시계로 읽습니다** — 게이트·요금제·카탈로그 출처·모델 행·사용 이력이 같은 client를 지나고, 정해진 순서로
  한 번에 하나씩 읽습니다. READ COMMITTED에서는 문장마다 snapshot이 다르므로, 가격·모델 사실이 기대는 행은
  읽기 전에 `FOR SHARE`로 잡아 commit까지 바뀌지 않게 하고, **잠금이 실제로 잡은 행만 사실로 인정합니다** — 잠금 뒤에
  삽입돼 읽기에만 보이는 행은 없는 것으로 보고 거절합니다(`holdMarketingFactRows()`,
  `tests/integration/marketing-fact-row-hold.db.test.ts`). 접수 트랜잭션을 REPEATABLE READ로 올리지 않는 것은
  snapshot이 감사 체인 잠금보다 먼저 잡혀 같은 key 재제출 확인과 원장 소비가 기다리는 동안 commit된 행을 못 보기
  때문입니다. 새 draft는 `resolveMarketingFactsWithSnapshot()`이 읽은 행(요금제 행·카탈로그 출처·
  모델 행의 id와 `updatedAt`, 증거 문장의 digest)으로 snapshot을 만들고, Guard 판정은 그 snapshot digest에
  묶입니다. 그래서 claim·asset이 있는 draft도 접수합니다. **카탈로그 reader는 행을 만들지 않습니다** — 기존
  `getBillingPriceCatalogWithMeta()`는 행이 없으면 기본값을 써 넣으므로 쓰기 트랜잭션 안의 사실 읽기에 쓰지
  않습니다. 모델 행은 `lib/modelRegistry.ts`를 고치지 않고(Prompt Refiner closure 파일) id로 읽어 기존
  `registryRowToModel()`로 바꿉니다. 접수 한 건의 트랜잭션 호출 수는
  `tests/integration/marketing-draft-intake.db.test.ts`가 고정합니다(지금 21회).
- **S3f(생성기 보고서 접수)**: `app/api/internal/marketing-intel-reports/route.ts`, `lib/marketingIntelReportCore.ts`,
  `lib/marketingIntelReportStore.ts`, `tests/marketingIntelReportCore.test.mjs`,
  `tests/integration/marketing-intel-reports.db.test.ts`. 생성기 secret으로 쓸 수 있는 보고서는 `brief`·`market_intel`
  둘뿐입니다. key는 앱이 종류·run·보고서 id로 유도하고, 같은 key에 다른 바이트가 오면 conflict이며, 이미 기록된
  보고서는 모든 게이트보다 먼저 되읽습니다. 마감은 draft 접수와 같은 helper로 겁니다. **시장 사실은 사람이 승인한
  경쟁사의 공식 host 위에서 온 것만 저장합니다** — 같은 트랜잭션에서 등록부의 승인 행을 FOR SHARE로 읽은
  host입니다(`holdApprovedMarketingCompetitorHosts()`; 운영자 결정 2026-10-19로 A3가 웹 검색을 쓰므로 고정 페이지 대조는
  하지 않습니다). 그 밖의 사실은 저장하지 않고 `unrepresentableFactCount`에 더합니다. `market_intel` 보고서는
  후보(`competitorCandidates`, 최대 5개)를 함께 서명해 보낼 수 있고, 후보는 제안으로만 저장됩니다. registry에 없는 claim을 이름 대는 brief는 거절합니다. 감사 actor는
  `marketing-generator`이고 범위는 `MarketingReport`의 `marketing_report.generator_recorded` 하나입니다.
- **S3e1(생성기 LLM adapter)**: `lib/marketingLlmClientCore.ts`, `tests/marketingLlmClientCore.test.mjs`. 생성기
  서비스가 `--experimental-strip-types`로 불러 쓰는 `MarketingLlmClient`이며, 순서가 계약입니다: 예약 → (포기하면
  release) → dispatch → **첫 소비 영수증일 때만 공급사 HTTP 1회** → 받은 값으로 settle, 쓸 만한 답이 없으면 unknown.
  재시도는 어디에도 없고(429·503·연결 끊김도 1회), dispatch 영수증 뒤에는 공급사를 부르지 않았어도 unknown이며,
  예산 action의 답을 잃으면 추측하지 않고 멈춥니다(만료 sweep이 닫음). 요청 본문은 계획서의 허용 목록 그대로입니다.
  **`service_tier`를 보내는 요청은 저장소 전체에서 이 한 줄뿐입니다** — `lib/modelPricing.ts` profile이 아니라 사람이
  정한 pin(모든 tier 중 최악 단가)으로 가격이 정해지고 예약 snapshot이 tier를 기록하므로,
  `scripts/check-processing-tier-core.mjs`가 이 파일의 원장 상수 한 줄만 예외로 받고 literal이나 다른 파일은
  그대로 실패시킵니다. 모델 선택·첫 pin·서비스 배선은 S3e2 이후입니다(D4).
  **원장이 `settled`로 닫지 않은 답은 쓰지 않습니다**(2026-10-18) — `unknown_retained`(token 초과·모델·tier 불일치)이면 client는
  본문 없이 `retained`를 돌려주고 A3·A5는 실행을 멈춥니다. 비용이 pin과 다르다는 뜻이므로 확인되지 않은 결과입니다(공통 기반 규칙 7).
- **S3e2(A5 문안 생성 core)**: `lib/marketingGeneratorDraftingCore.ts`, `tests/marketingGeneratorDraftingCore.test.mjs`.
  모델에게는 고정 system 지시와, S3b 문맥 중 그 계정·locale의 조각을 **데이터로** 줍니다. 답은 하나의 JSON 객체만
  받고(아니면 통째로 거절), 초안마다 링크·문맥에 없는 claim·asset id·접수 schema 위반이면 그 초안만 버리고 사유별로
  셉니다. `logicalDraftId`·채널·locale·kind는 서비스가 정하며, 서명된 제출 본문은 접수 core의 서명 그대로입니다.
  서비스가 strip-types로 불러야 하므로 `lib/marketingDraftIntakeCore.ts`의 schema import는 상대 경로입니다. 판정은 여전히
  앱의 Guard입니다.
- **S3e3(생성기 한 주기와 감독자)**: `lib/marketingGeneratorCycleCore.ts`, `scripts/marketing-generator-worker.mjs`,
  `scripts/marketing-generator-service.mjs`, `tests/marketingGeneratorCycle.test.mjs`. 한 실행은 문맥을 읽고, 승인 모드
  계정마다 A5를 한 번 부르고, 호출마다 그 호출의 원장 key로 초안을 제출합니다. **멈추는 쪽을 택합니다** — 예약 거절과
  결과 불명은 그 자리에서 실행을 끝냅니다. **다시 보내는 것은 제출 하나뿐입니다** — 답을 잃었거나 5xx이면 서명된 같은
  바이트를 최대 세 번까지 보내고(접수가 key로 되읽음), 공급사는 다시 부르지 않으며 4xx는 다시 보내지 않습니다. 감독자는
  게시기와 같은 모양으로 마감에 worker를 SIGKILL하고, worker에는 변수 넷만 넘깁니다. **worker는 가격 pin이 있는 모델이
  아니면 시작하지 않습니다** — 지금은 pin이 없어 항상 거절합니다. `.railway/agent-runners.ts` 배선은 D4(전용 OpenAI
  프로젝트·키·pin) 뒤입니다.
- **S3d(가격 경보)**: `lib/marketingPriceAlertCore.ts`, `lib/marketingPriceAlert.ts`, `tests/marketingPriceAlert.test.mjs`.
  가격 출처 거절(docs/policy/marketing-automation.md §7.2(2))은 **기존 운영 알림**으로 보냅니다(운영자 결정 D5, 2026-10-17) —
  `reportOperationalIncident()`가 `OPS_ALERT_EMAIL`(없으면 `ADMIN_ALERT_EMAIL`)과 설정된 chat webhook으로 직접 보내고,
  본문은 Admin 링크와 게시물 id뿐입니다. **준비 상태는 그 수신자 변수가 있는가**이며, Guard 문맥·draft 접수·자율
  admission이 같은 판정을 읽습니다(고정 상수는 지웠고, 위치가 밀리지 않게 같은 줄 수의 주석으로 남김). 수신자가 없으면
  Guard는 가격 claim을 `alert_path_not_ready`로 승인에 보내고 draft 접수는 닫혀 있습니다. 경보는 접수 트랜잭션이
  commit된 뒤 route가 보내며, 실패해도 접수 결과를 바꾸지 않습니다.
- **S3h1(보존 정리)**: `lib/marketingRetention.ts`, store의 `purgeExpiredMarketingRows()`,
  `lib/maintenance.ts`의 `marketing_retention` 단계, `tests/integration/marketing-retention.db.test.ts`.
  **무엇을 지울지는 DB가 정합니다** — 보존 기한·legal hold·플랫폼 도달·draft 상태·90일 규칙은 delete trigger가
  강제하고, 보존 설정을 트랜잭션 안에서 켜는 곳은 이 writer 하나뿐입니다(보호 테이블 검사가 허용 목록으로
  강제). 지운 행마다 같은 트랜잭션에 `marketing-retention` 감사 행을, 지운 것이 있는 실행만 `retention_run`
  보고서를 남깁니다. 일일 정리 cron의 한 단계이며 표마다 한 번에 200행까지입니다.
- **S3h2(남는 게시물의 보존)**: store의 `purgeExpiredMarketingPostContent()`·`compactMarketingPostHistory()`·
  `planMarketingHistoryCompaction()`, `tests/marketingRetentionCompaction.test.mjs`. 게시물 행은 남기고 본문
  (`envelope`)만 게시 후 24개월에 지우며, history의 `attempt`·`webhook_event` 항목은 90일 뒤 종류별 요약과 닫는
  항목으로 바꿉니다. **판정은 여전히 update trigger의 것이고, writer의 선택은 그보다 좁아야 합니다** — 본문
  정리는 종결 상태만(재대기할 수 있는 `failed`, 확인 중인 `outcome_unknown`, 게시 전 상태는 본문을 유지), 시각
  기준은 trigger보다 1 ms(압축은 일광절약 차이까지 1시간) 이르게, history 시각은 µs까지 비교합니다. 선택한 행을
  trigger가 거절하면 그 batch 전체가 실패하기 때문입니다. 압축은 `historyVersion` CAS이고, failed 게시물의 재대기
  기준 실패 항목은 남깁니다. 세 보존 writer는 `beginMarketingRetention()` 하나에서 보존 설정을 켭니다. 결과는 기존
  `retention_run` 모양 그대로(`compactedRowCount` = 제자리에서 바뀐 행)이며, webhook fingerprint를 움직이지 않도록
  store에 최상위 계산식을 두지 않습니다. 공개 버킷 이미지는 삭제 port가 생길 때입니다.
- **S3c1(LLM 비용 원장 표와 결정적 핵심)**: `lib/marketingLlmBudgetCore.ts`,
  `prisma/migrations/20261016120000_marketing_llm_call_ledger/migration.sql`, `tests/marketingLlmBudgetCore.test.mjs`,
  `tests/integration/marketing-llm-call-ledger.db.test.ts`. 정책 v4의 다섯 번째 표 `MarketingLlmCall`입니다. **예약은 최대
  비용이 상한 안에 들어갈 때만 받고, 월 합계는 정산된 호출을 보고 토큰 × pin 최악 단가 + 과금될 수 있는 검색 수(예약액
  이하)로, 열린 호출과 unknown 호출은 예약액으로 셉니다**(운영자 결정 2026-10-23, `MARKETING_LLM_COUNTED_MICRO_USD_SQL`).
  모델 선택지와 pin은 런타임 모델 카탈로그(Admin › Models)에서 오며, 카탈로그는 감사 잠금 밖에서 읽거나(예약) 호출자 트랜잭션의 연결로 읽습니다(설정 저장·생성기 context). 상태 전이·
  증거 1회 설정·시각·사유와 관측 열의 짝·보존 삭제는 trigger와 CHECK가 직접 SQL에도 강제하고, 예약 시각은 writer가 DB
  시계에서 한 번 읽어 그 월을 잠그며 trigger는 다시 계산하지 않고 검증만 합니다. 운영자가 고른 모델이 카탈로그에서 가격이 확인된 OpenAI 모델이 아니면 예약은 `model_not_pinned`입니다.
  writer·route·sweep은 S3c2 이후입니다.
- **S3c2(원장 writer)**: `lib/marketingLlmBudgetStore.ts`, `tests/integration/marketing-llm-budget-store.db.test.ts`,
  `lib/adminAuditSystemActors.ts`의 `marketing-generator`(원장 다섯 action·`MarketingLlmCall`만). 모든 action은 감사 chain →
  UTC 월 → 행 순서로 잠그고, **재생은 현재 설정을 읽기 전에** 저장된 digest로 답합니다 — pin 교체·adapter 배포·kill
  switch가 이미 기록된 요청의 답을 바꾸지 않습니다. 새 쓰기만 마감·kill switch·상한·pin을 읽으며, dispatch 영수증의
  `firstConsumption`은 한 번만 `true`입니다. action별 statement 수는 시험이 고정합니다. route·만료 sweep·legal hold는
  S3c3입니다.
- **S3c3a(생성기 예산 route)**: `app/api/internal/marketing-llm-budget/route.ts`, `lib/marketingLlmBudgetRequest.ts`,
  `tests/integration/marketing-llm-budget-route.db.test.ts`. 생성기 bearer secret, 4KB 상한, action별 strict schema, 그리고
  **budget HMAC이 action·deadline·모든 필드를 덮습니다** — 가로챈 요청을 더 늦은 deadline이나 다른 call의 필드로 다시
  보낼 수 없습니다. action마다 트랜잭션 하나이며, 트랜잭션 안의 실패는 전부 되돌려지므로 같은 요청을 다시 보내면
  커밋된 것을 읽어 옵니다. 예약 pin은 트랜잭션을 열기 전에 카탈로그에서 읽습니다.
- **S3c3b(만료 sweep)**: store의 `expireMarketingLlmCalls()`, `lib/marketingLlmExpiry.ts`(15분 주기 maintenance 단계),
  `tests/integration/marketing-llm-expiry.db.test.ts`. 15분 안에 dispatch되지 않은 예약은 `released`, 1시간 안에 보고되지
  않은 dispatch는 예약액 그대로 `unknown_retained`입니다. 만료 종결은 action `expire`라 그 뒤의 생성기 보고는 conflict이고,
  행마다 트랜잭션 하나입니다. **sweep은 감사 chain·월·행 잠금 어느 것도 기다리지 않습니다** — 생성기 요청이 행보다 먼저
  chain과 월을 잡으므로, 기다리면 그 뒤에 줄을 서게 됩니다. 셋 중 하나라도 잡혀 있으면 그 행은 다음 실행으로 넘기고, 실패한
  행은 세어 보고하되 나머지는 계속 처리합니다. kill switch 중에는 아무것도 하지 않습니다.
- **S3c3c(원장 legal hold·보존)**: `app/api/admin/marketing/llm-calls/[callId]/legal-hold/route.ts`, store의
  `setMarketingLlmCallLegalHold()`·`purgeExpiredMarketingLlmCalls()`, `lib/marketingRetention.ts`의 네 번째 표,
  `prisma/migrations/20261016150000_marketing_llm_call_legal_hold_decision/migration.sql`,
  `tests/integration/marketing-llm-hold-retention.db.test.ts`. hold는 `runMarketingAdminMutation`을 지나고 그 사람 감사 행이
  바로 그 결정의 증거일 때만 쓰입니다(설정은 막지 않고 해제는 kill switch가 막습니다). **결정은 자기가 대체하는 결정을
  이름 댑니다** — 행이 마지막 hold 결정의 감사 id(`legalHoldAuditLogId`)를 갖고, DB가 flag와 그 id를 함께만, 쓰인 적 없는
  id로만 바꿉니다. 이전 해제 감사 행의 재사용도, 옛 hold를 보고 보낸 지연 해제도 새 hold를 풀지 못합니다. 보존은 닫혔고 hold가 없으며 24개월이
  지난 행만 지우고 행마다 `marketing-retention` 감사 행을 남깁니다. **`retention_run` 보고서는 쓰지 않습니다** — 그 보고서의
  표 목록이 webhook pipeline의 감시 소스라 원장을 넣으면 fingerprint가 움직이고 서명된 검증이 다시 열립니다.
- **S3c4(접수와 원장의 결속)**: `lib/marketingDraftIntakeCore.ts`(제출 v2), `lib/marketingDraftIntakeStore.ts`, store의
  `consumeMarketingLlmCallsForSubmission()`. 제출은 자기를 만든 원장 호출을 `llmCallRequestKeys`로 이름 대고, **서명·제출
  digest·draft의 접수 digest·원장의 consumer digest가 모두 같은 canonical 바이트**에 묶입니다. 접수는 이름 댄 호출이 모두
  같은 run의 draft용이고 닫혀 있으며 아직 소비되지 않았거나 이 제출이 소비했을 때만 받고, 같은 트랜잭션에서 소비를
  기록합니다. 응답을 잃은 생성기는 서명된 같은 제출을 그대로 다시 보냅니다(deadline이 다르면 다른 제출이라 conflict).
  예산 reader는 이제 "상한을 읽을 수 있다"이고, 월 상한으로 막는 것은 예약입니다.
- **S3f-R1(경쟁사 등록부)**: `lib/marketingCompetitorCore.ts`, `lib/marketingCompetitorStore.ts`,
  `prisma/migrations/20261017120000_marketing_competitor_registry/migration.sql`, `tests/marketingCompetitorCore.test.mjs`,
  `tests/integration/marketing-competitor-registry.db.test.ts`(운영자 결정 2026-10-17: 경쟁사는 상수가 아니라 DB 등록부와
  사람의 승인). **A3는 제안만 하고 사람이 정합니다** — 제안은 `marketing-generator`의
  `marketing_competitor.proposed` 감사와 함께 `proposed`로 들어가고, 이미 있는 id는 그대로 둡니다(거절을 다시 여는
  제안 없음). 승인·거절·은퇴·추가는 사람의 감사 행이 있어야 하며, `MarketingCompetitor_write_guard`가 그 행의
  action·대상·actor·`previousDecisionAuditLogId`(없으면 `':none'`)와 **승인이면 이름과 host까지** 대조합니다. 화면이
  본 결정과 현재 결정이 다르면 `competitor_decision_conflict`입니다. 행은 지우지 않고 은퇴시킵니다. migration은 시장
  분석의 11개를 `seed` 제안으로만 넣으며 아무것도 승인하지 않습니다. 사실 필터는 R2부터 이 등록부를 읽고, 사람이
  결정하는 Admin 화면과 route는 R3입니다.
- **S3f-R3a(경쟁사 결정 route)**: `app/api/admin/marketing/competitors/route.ts`(사람이 승인된 경쟁사를 추가),
  `app/api/admin/marketing/competitors/[competitorId]/decision/route.ts`(승인·거절·은퇴),
  `tests/integration/marketing-competitor-routes.db.test.ts`. 둘 다 `runMarketingAdminMutation`을 지나고, 감사 metadata는
  정규화된 뒤의 이름·host를 적습니다(write guard가 저장값과 정확히 대조). **승인·추가는 host를 출처로 만드는 시작이라 kill
  switch가 막고, 거절·은퇴는 출처를 줄이는 정지라 아무것도 막지 않습니다.** 화면이 본 결정과 다르거나 상태가 허락하지
  않는 이동은 409이고 감사 행을 남기지 않습니다. 거절의 상태 코드는 `MarketingCompetitorRefusedError`가 들고 다닙니다 —
  route sweep이 `refusal` 안의 호출과 store 식별자를 막기 때문입니다.
- **S3f-R3b(경쟁사 Admin 화면)**: `/admin/marketing?tab=competitors` — `lib/marketingConsoleSections.ts`,
  `lib/marketingConsoleRead.ts`, `components/admin/AdminMarketingPanel.tsx`, `lib/adminMessages/marketing.ts`. 승인된 것이
  먼저, 최대 100건이고 화면이 그 수와, 잘렸다면 잘렸다는 사실을 말합니다. 행마다 그 행이 보여 준
  `decisionAuditLogId`로 결정하며, 승인은 이름·host를 고쳐서 보낼 수 있습니다. A3의 근거 URL은 https만 새 탭·
  `rel="noopener noreferrer nofollow"` 링크로 보입니다(S3f-R5c) — 사람이 근거를 열어 보고 판정합니다.
- **S3f-R4(생성기 문맥의 등록부)**: `lib/marketingGeneratorContext.ts`의 `competitors`. `tracked`는 승인된 경쟁사와 사람이
  승인한 host이고, `knownIds`는 상태와 무관하게 등록부가 아는 id 전부이며 자르지 않습니다(거절도 답이므로 다시 제안하지 않게;
  크기는 문맥 route의 byte 상한이 자르지 않고 거절합니다).
  host는 이름이지 URL이 아니며, A5 메시지에는 싣지 않습니다(`tests/marketingGeneratorDraftingCore.test.mjs`).
- **S3f-R5a(추적 페이지, 지금은 쓰지 않음)**: `prisma/migrations/20261017180000_marketing_competitor_tracked_pages/migration.sql`,
  `MarketingCompetitor.trackedPages`(운영자 결정 2026-10-17: 사실은 사람이 승인한 고정 페이지에서, 웹 검색은 신규 경쟁사 탐색에만).
  페이지는 그 행의 공식 host 위의 https URL이고(DB CHECK), 제안 상태에는 없으며, 이름·host처럼 승인으로만 바뀌고 승인 감사 행의
  `trackedPages`와 정확히 대조됩니다. 2026-10-19 운영자 결정으로 A3가 웹 검색으로 바뀌어 이 열은 읽히지 않습니다.
- **S3f-R5b(A3 실행)**: `lib/marketingA3Core.ts`, `lib/marketingA3CycleCore.ts`, `scripts/marketing-generator-worker.mjs`,
  `tests/marketingA3Core.test.mjs`, `tests/marketingA3Cycle.test.mjs`. **경쟁사마다 LLM 웹 검색 한 번입니다**(운영자 결정
  2026-10-19: LLM이 할 수 있는 일은 LLM 호출로, 직접 crawling 코드는 지움). 검색은 그 경쟁사의 공식 domain으로
  제한되고(`allowed_domains`) 호출당 검색 횟수는 pin의 `maxWebSearchCalls`로 묶이며, 원장은 모델이 검색 뒤마다 다시 읽는 입력(컨텍스트 창 ×
  (검색 수 + 1))과 출력 상한, 검색 단가를 합친 최대 비용을 예약합니다(adapter profile `web-search-v1`; pin에 검색 단가가 없으면 예약 거절). 사실의 경쟁사 id·확인 시각은 서비스가
  정하고, 출처는 공급사가 실제로 인용한 URL이면서 공식 host 위여야 합니다(query·fragment 제거). 결과를 모르는 호출이나 답이
  없는 제출은 실행 전체를 멈추고 보고서를 내지 않으며, 시간 몫(20분)을 넘기면 보고서 없이 A5로 넘어갑니다. pin이 없으면(D4)
  worker는 시작하지 않습니다.
- **S3f-R5c(신규 경쟁사 탐색)**: 같은 파일들. 추적 경쟁사 다음에 **실행당 한 번, domain 제한 없는 웹 검색**을 같은
  `web-search-v1` profile로 합니다(`allowedDomains`가 비면 client가 `filters`를 빼고 보냅니다). 산출물은
  `competitorCandidates`뿐이며(`readMarketingA3Discovery()`), 후보는 근거 URL이 1~5개이고 모두 같은 응답의 인용·검색
  출처 URL과 문자열로 같아야 하고(정규화 없음), 문맥의 `knownIds`에 있는 id는 버립니다. 앱의 후보 schema도 근거
  1개 이상을 요구합니다(`marketingCompetitorCandidateSchema`). 이 호출이 결과를 모르면 실행 전체가 멈추고 보고서를 내지 않습니다.

# 엔지니어링 Agent

engineering Agent의 판정·상태·게시·등록 코드, 그리고 그 에이전트가 AMUX에 붙는
경로를 건드리기 전에 읽습니다.

- `docs/policy/engineering-agent.md`

절대 조건:

- **작업은 승격된 AMUX 카드로만 받습니다.** GitHub issue·label·comment는 작업
  원천도 승인 증거도 아닙니다. 에이전트가 AMUX backlog에 카드를 **등록**할 수는
  있지만 승격하지 않으며, 등록 원천과 상한은 docs/policy/engineering-agent.md §2.2가
  고정합니다.
- **허용 판정은 본 앱 하나가 하고, 본 앱은 patch를 적용하지 않습니다.** 본 앱은
  Git tree 목록만 검증하며, 게시 서비스의 검사는 거절만 할 수 있습니다.
- **에이전트는 어떤 PR도 승인·병합하지 않고 auto-merge를 켜지 않습니다.** 공개된
  PR의 승인 증거는 docs/policy/engineering-agent.md §9-10의 일곱 조건입니다.
  예외 내용: engineering-agent.md v6 3항 조건(졸업, 허용 목록, base 정책 테스트, 결속·최신성, 교차 검토, off 스위치)을 모두 충족한 develop 결정적 병합 호출 하나뿐이고, auto-merge는 켜지 않으며 승인도 하지 않습니다.
- **상태 전이는 `lib/engineeringAgentCore.ts`의 표에만 있습니다.** trigger·store·
  테스트는 그 표에서 생성하거나 대조하며, 전이를 다른 곳에 옮겨 적지 않습니다.
  특히 lease 만료는 게시 항목을 `queued`로 되돌리지 않고 `needs_lookup`으로
  보냅니다 — 조회 없이 다시 쓰는 경로가 생기지 않게 하는 것이 그 표의 목적입니다.
- **소비된 capability는 되돌아가지 않습니다.** 조회 전용 claim은 capability를
  발급하지도 소비하지도 않습니다.
- **판정 코드는 런타임 내장 모듈만 import합니다.** 초안·게시 서비스가 clone한
  트리의 의존성을 설치·실행하지 않고 그 코드를 불러 쓰기 때문입니다.
- 구현 단계는 docs/policy/engineering-agent.md §14가 대략의 순서입니다. 아래 경로 목록은 안내이고, 새 기능이 여기에
  항목을 추가할 의무는 없습니다.
- **P1a(결정적 핵심)**: `lib/engineeringAgentCore.ts`,
  `tests/engineeringAgentCore.test.mjs`.
- **P1b(소유권 manifest와 tier)**: `lib/agentAuthorityFiles.ts`, `lib/agentPushPolicy.ts`,
  `tests/agentAuthorityFiles.test.mjs`, `tests/agentPushPolicy.test.mjs`. **새 최상위
  디렉터리나 에이전트·AMUX 이름이 든 파일을 추가하면 manifest 분류가 먼저입니다** —
  `tests/agentAuthorityFiles.test.mjs`가 분류되지 않은 것을 실패로 만듭니다.
- **P1e(tree 목록 검증)**: `lib/engineeringAgentTreeVerify.ts`,
  `tests/engineeringAgentTreeVerify.test.mjs`. **patch를 적용하는 코드를 여기에 넣지
  않습니다** — 본 앱은 tree 목록의 hash를 다시 계산하고 비교할 뿐입니다.
- **P1f(capability와 불일치)**: `lib/engineeringAgentCapability.ts`,
  `lib/engineeringAgentStateMismatch.ts`, `tests/engineeringAgentCapability.test.mjs`.
  교차 잠금 순서는 `CROSS_LOCK_ORDER` 하나이며 AMUX가 자기 순서를 바꾸면 함께
  바뀌어야 합니다.
- **P1g(등록 Guard와 secret 검사)**: `lib/engineeringAgentRegistrationGuard.ts`,
  `lib/engineeringAgentSecretPatterns.ts`, `tests/engineeringAgentRegistrationGuard.test.mjs`.
  모델의 등록 제안은 여섯 필드뿐이며 우선순위·승격·담당자를 담을 자리가 없습니다.
- **P1d(자격증명 도달 분석)**: `lib/agentCredentialReachability.ts`,
  `tests/agentCredentialReachability.test.mjs`. **workflow를 바꾸면 이 테스트의 base 결과
  고정값을 확인합니다** — 전체 금지가 풀리는 것은 사람 검토 제외와 cache 격리 기록뿐입니다.
- **P1c(통제 평면 slice)**: `lib/agentControlPlaneSlice.ts`,
  `tests/agentControlPlaneSlice.test.mjs`. **slice는 게이트가 닿는 제품 파일입니다**
  (정책 v6 2항) — 런타임 통제 평면 파일에서 import를 따라(다른 파일을 거쳐도) 닿는 파일과,
  그 파일들이 경로로 지목하는 파일입니다. 게이트를 부르기만 하는 파일이나 아무 게이트도
  닿지 않는 제품 파일은 이미지에 있어도 slice가 아닙니다. 앱 런타임의 import가 하나라도
  풀리지 않거나 런타임 통제 평면 코드에 동적 로딩을 넣으면 분석 자체가 실패합니다.
- **P1h(모델 호출)**: `lib/engineeringAgentModelCall.ts`,
  `tests/engineeringAgentModelCall.test.mjs`. 모델 도구는 `read_file` 하나이고, 이 모듈은
  하위 프로세스·평가·네트워크 global·환경변수·로그를 쓰지 않습니다. 구문 검사는 정직한
  회귀만 잡으므로, **모듈을 고치면 테스트의 `REVIEWED_MODULE_SHA256`이 실패하고 그 digest를
  갱신하는 변경이 곧 독립 검토의 대상**입니다(docs/policy/engineering-agent.md §8).
- **v5 승인·병합 관측**: `lib/engineeringAgentPrApprovalCore.ts`(docs/policy/engineering-agent.md §9-10 일곱 조건, 순수),
  `lib/engineeringAgentPrObserver.ts`, `lib/amux/reviewMergeObserved.ts`,
  `app/api/internal/engineering-agent/observe/pull-requests/route.ts`. **승인은 병합 전에만 기록하고**,
  "아직 리뷰 없음"은 기록하지 않고 다음 주기에 다시 읽습니다. 병합 전에 승인이 기록된 PR의 병합만
  v22 `implement` 카드를 `done`으로 바꾸고, 그렇지 않은 병합은 상태 불일치로 사람에게 갑니다.
- **tier 비율 보고**: `npm run report:engineering-agent-tiers`. 최근 병합들을 앱과 같은
  판정으로 다시 계산해 개수만 출력하며, 아무것도 쓰지 않습니다(docs/policy/engineering-agent.md §14).

# AMUX Decision Maker

AMUX worker의 질문에 답 제안을 만드는 Decision Maker(DM)의 판정·저장·전송·runner 코드를
건드리기 전에 읽습니다.

- `docs/policy/amux-decision-maker.md`

절대 조건:

- **v1은 제안 모드만입니다.** DM의 출력은 운영자가 Admin에서 확정하기 전에는 worker에게 가지
  않습니다. 자율 경로를 만들지 않습니다 — 그것은 v2 정책과 공통 기반 원칙 3의 별도 개정입니다.
- **라우팅은 `lib/amux/decisionMakerCore.ts`의 `routeDmQuestion()` 한 곳입니다.** 모든 검사를
  실행하고 모든 거절 사유를 남기며, 결과는 `dm_proposal`과 `operator` 둘뿐입니다.
- 용어 목록·비밀 경로 목록·경로 문법·출력 상한은 테스트의 고정값이 기준입니다. 바꿀 때는 코드와 테스트를
  함께 고치며, 정책 버전 개정은 필요 없습니다.
- DM은 승인 게이트에서 사람으로 인정되지 않고, 운영자가 확정한 답도 승인 계약의 승인이 아닙니다.
- 구현 단계는 docs/policy/amux-decision-maker.md §12가 대략의 순서입니다. 아래 경로 목록은 안내이고, 새 기능이
  여기에 항목을 추가할 의무는 없습니다.
- **S0(계정 격리 실측)**: `scripts/amux-decision-maker-s0/measure-isolation`,
  `scripts/amux-decision-maker-s0/isolation.conf.example`, `docs/ops/amux/decision-maker-s0.md`,
  `tests/amuxDecisionMakerS0Isolation.test.mjs`. 운영자가 Ubuntu runner에서 root로 실행하며 유료 turn이 없습니다
  (CLI에는 `--version`만). **`isolated`는 모든 control이 성공하고 모든 격리 검사가 막혔을 때뿐입니다** — control이
  하나라도 실패하면 거부가 아무것도 증명하지 않으므로 `incomplete`입니다. 거부를 보는 대상마다 그 대상이 실재한다는 control(경로 존재, root에서의
  endpoint 응답, root로의 process 읽기)이 먼저입니다. 보호 디렉터리는 목록·진입·안쪽 파일 읽기를 따로 잽니다. 설정은 해석만 하고 실행하지 않으며, 출력에
  파일 내용·환경·자격증명이 없습니다. sudo 권한은 root가 `sudo -l -U`로 묻고 계정이 직접 시도하지 않습니다.
  실측 기록은 `docs/ops/amux/decision-maker-s0-records/`에 두며, 서명 전의 기록은 S2 선행 조건의 증거가 아닙니다.
- **S1a(결정적 핵심)**: `lib/amux/decisionMakerCore.ts`, `tests/amuxDecisionMakerCore.test.mjs`.
  I/O가 없습니다. DB·route·DM 호출은 다음 단계입니다.
- **S1b(스위치 저장소)**: `lib/amux/decisionMakerSwitchCore.ts`, `lib/amux/decisionMakerSwitchStore.ts`,
  `lib/amux/decisionMakerSwitchSystemAudit.ts`,
  `prisma/migrations/20261008030000_amux_decision_maker_switch/migration.sql`,
  `tests/amuxDecisionMakerSwitch.test.mjs`, `tests/integration/amux-decision-maker-switch.db.test.ts`.
  스위치는 append-only 사건 표이고 scope마다 가장 새 사건이 상태입니다. **값은 DB CHECK가 닫습니다** —
  인스턴스는 `off`·`proposal`, kill switch는 `on`·`off`뿐이고, 시스템은 인스턴스를 `off`로 latch만
  합니다. 사건마다 같은 트랜잭션의 감사 행을 trigger가 요구하며, latch 뒤 사람의 첫 변경은
  `amux.decision.latch_release`입니다. 읽기 실패나 목록 밖의 행은 전부 `null`(fail-closed)이고,
  `routeDmQuestion()`이 `settings_unreadable`로 운영자에게 보냅니다. 표를 읽고 쓰는 곳은 store
  하나이며, 시스템 감사는 별도 모듈이 씁니다(한 파일이 두 writer를 부르지 않습니다). route·Admin
  화면·DM 호출은 없습니다.
- **S1c(요청 원장)**: `lib/amux/decisionMakerRequestCore.ts`, `lib/amux/decisionMakerRequestStore.ts`,
  `lib/amux/decisionMakerRequestSystemAudit.ts`,
  `prisma/migrations/20261008090000_amux_decision_maker_switch_serialization/migration.sql`,
  `prisma/migrations/20261008090100_amux_decision_maker_request_ledger/migration.sql`,
  `tests/amuxDecisionMakerRequest.test.mjs`, `tests/integration/amux-decision-maker-request.db.test.ts`.
  요청은 (카드 id, 질문 revision)당 한 행이고 고칠 수 없으며, 상태는 append-only 사건 표의 합입니다.
  **전이 그래프는 trigger가 강제하고 `dmEventRefusal()`·`dmEventSwitchRefusal()`이 같은 그래프를
  옮깁니다** — 한쪽만 바꾸지 않습니다. 배정 마감(생성 + 2분)과 결과 마감(배정 + 30분)은 DB 시계이고,
  배정·전송 의도·DM 출력(제안·이관·검증 실패)은 삽입 때와 COMMIT 때(`AX001`) 모두 마감에서 commit
  예비시간 200 ms를 뺀 D로 거부되며, writer는 같은 마감을 `requireLeaseAt`으로 fence에 넘깁니다. 종결
  결과는 요청당 하나이고 (요청, 결과 digest) 쌍으로 멱등입니다. 사건마다 같은 트랜잭션의 감사 행을
  요구합니다 — 배정·종료는 router, 전송·결과는 요청의 인스턴스 actor입니다.
  **스위치 값은 호출자가 넘기지 않습니다.** 라우팅·전송 의도·결과는 store가 audit chain lock(모든
  스위치 변경도 먼저 잡는 lock) 뒤에 S1b reader로 직접 읽고, trigger는 스위치 gate(스위치 trigger는
  배타, 원장 trigger는 공유)를 잡은 뒤 다시 읽어 kill switch on·인스턴스 off에서 DM 라우팅·전송
  의도를, kill switch on에서 제안을 거부합니다. lock 순서는 audit chain lock → 스위치 gate →
  요청·scope lock입니다. 원장 trigger와 S1b 스위치 trigger는 lock 뒤에 읽으므로 READ COMMITTED가
  아니면 거부합니다. 운영자 직접 답의 종료, 본문, 보존, digest 키, 판정, 전달, route·Admin 화면·DM
  호출은 없습니다.
- **S1d(본문 저장소·보존)**: `lib/amux/decisionMakerBodyCore.ts`, `lib/amux/decisionMakerBodyStore.ts`,
  `lib/amux/decisionMakerBodySystemAudit.ts`, `lib/amux/decisionMakerDigestKeys.ts`,
  `prisma/migrations/20261008120000_amux_decision_maker_body_store/migration.sql`,
  `tests/amuxDecisionMakerBody.test.mjs`, `tests/integration/amux-decision-maker-body.db.test.ts`.
  본문은 docs/policy/amux-decision-maker.md §10의 다섯 필드뿐이고(필드당 한 행, 상한은 CHECK) 고칠 수
  없습니다. 본문 행은 열린 DM 요청에만, 그것이 속한 것을 쓴 같은 트랜잭션의 감사 행(카드는 route, DM
  출력은 그 종류의 result, 운영자 답은 그 요청을 target으로 하는 edit_confirm)과 함께 들어갑니다. **종결
  결과마다 `AmuxDecisionMakerResultDetail` 한 행이 결과와 같은 트랜잭션에 남습니다** — 출력 종류,
  select가 고른 선택지 id, `irreversible`(docs/policy/amux-decision-maker.md §6: Admin이 판정 전에 먼저
  보임)와 그 결과를 digest한 key check 값이며, 원장의 일부라 지우지 않고 자유 텍스트가 없습니다. 선택지
  id는 S1a 문법(영숫자·`_`·`-`, 32자)이고, 어기거나 겹치는 카드는 라우팅이 DM에 보내지 않습니다.
  **digest 키는 30일 key period마다 하나이고 서버 비밀 `AMUX_DM_DIGEST_KEYS`에만 있습니다** — DB에는
  key check 값만 둡니다. 요청의 period는 그 DB 시계 `createdAt`에서 나오고, 요청 키 K_R = HMAC(K_P, 요청
  id)로 선택지 집합 digest(라우팅 때 store가 카드의 선택지로 계산하고, 결과는 같은 선택지 목록을
  가져와야 받아들여짐), broker의 payload·manifest digest, 앱이 저장한 출력으로 계산하는 결과 digest,
  본문 digest를 모두 keyed로 만듭니다. 평문 hash는 어디에도 없습니다. 결과는 레지스트리가 그 키를
  등록했고 파기하지 않았을 때만 commit됩니다. 보존은 별도 append-only 사건 표입니다: 요청이
  닫히면(assign_discarded·stale_close) 같은 문장에서 trigger가 `retention_set`(닫힘 + 2160시간, 고정
  길이)을 한 번 쓰고, hold는 사람의 `hold_set`·`hold_release`이며 열린 hold는 hold 사건 수로만 셉니다.
  본문 삭제는 hold가 없을 때 router의 `.body_purge`(보존 기한 뒤) 또는 사람의 `.body_erase`(개인정보
  삭제 예외) 감사와 같은 트랜잭션에서만 됩니다. 키 파기는 period가 끝났고 본문·열린 hold·열린 요청이
  남지 않았을 때만 기록되며, 그 뒤로는 그 period의 본문을 쓸 수 없습니다.
  docs/policy/amux-decision-maker.md §6의 표대로 이 단계의 쓰기는 kill switch 중에도 모두 허용되므로
  스위치를 읽지 않습니다. 같은 변경에서 S1c의 스위치 읽기 실패는 트랜잭션을 이미 중단시키므로 writer가
  그 자리에서 `settings_unreadable`을 던지고 아무것도 쓰지 않습니다(SAVEPOINT는
  docs/policy/amux-decision-maker.md §9의 12문장을 넘깁니다). 라우팅·결과 제출·배정은 이 store의 세
  조합을 거쳐서만 부릅니다. **카드 본문은 라우팅이 같은 트랜잭션에서 씁니다**(2026-10-09) —
  `recordDecisionMakerRequestWithCardText()`가 DM으로 라우팅된 새 요청에만 `dmCardText()`(S1a의 JSON
  직렬화, `format` 표시 포함)를 그 route 감사에 묶어 저장하고, 운영자 라우팅은 본문이 없습니다. 본문
  guard가 카드를 그 요청의 route 트랜잭션에만 받으므로 나중에 채울 수 없습니다.
  docs/policy/amux-decision-maker.md §5의 16 KiB와 카드 secret 검사는 이 직렬화 바이트로 판정하므로 DM으로
  가는 카드는 언제나 본문 store가 받습니다. Admin은
  `readDecisionMakerCardText()`로 읽습니다. cron·route·Admin 화면은 없습니다.
- **S1e(운영자 판정·전달)**: `lib/amux/decisionMakerJudgmentCore.ts`,
  `lib/amux/decisionMakerJudgmentStore.ts`, `lib/amux/decisionMakerJudgmentSystemAudit.ts`,
  `prisma/migrations/20261008130000_amux_decision_maker_stale_close_hours/migration.sql`,
  `prisma/migrations/20261008130100_amux_decision_maker_judgment_delivery/migration.sql`,
  `tests/amuxDecisionMakerJudgment.test.mjs`, `tests/integration/amux-decision-maker-judgment.db.test.ts`.
  판정은 요청당 하나(`confirm`·`edit_confirm`·`reject`)이고 사람의 `amux.decision.<kind>` 감사가 같은
  트랜잭션에서 **요청**을 target으로 합니다(S1d 본문 guard가 이미 그렇게 묶음). **판정이 요청을
  닫습니다** — 판정 표의 trigger가 같은 문장에서 같은 종류의 닫힘 사건을 원장에 쓰고, 원장의 event
  guard는 그 판정 행 옆에서만 받으며, S1d 닫힘 trigger가 그때부터 보존(2160시간)을 시작합니다. 원장의
  닫힘 종류는 다섯이고(request core의 닫힘 목록과 같음), event guard·본문 guard·보존 guard·키 guard와
  request store의 네 읽기(상태, 열린 요청 수, stale 후보, Admin의 최근 요청)가 같은 목록을 씁니다 — 한쪽만 바꾸지 않습니다. 확정(`confirm`·`edit_confirm`)은 kill switch 중 거부되고 거절은
  허용되며, Admin이 보여 준 값(답·근거 본문의 keyed digest, select의 선택지, `irreversible`, 스냅샷
  상태·SHA·manifest digest)이 저장값과 모두 같을 때만 됩니다. 고친 답은 S1d 본문 store가 판정 직전 같은
  트랜잭션에 쓰고 판정이 그 digest를 기록합니다. 선언 정확도는 기본 `not_judged`, `mismatched`면
  `effect_class`·`resolution`·`paths` 중 하나 이상입니다. 전달은 확정 뒤 결정 한 번(kill switch 중 거부),
  그 뒤 영수증 또는 `delivery_unknown` 한 번, `delivery_unknown`에만 사람의 해결 한 번입니다 —
  docs/policy/amux-decision-maker.md §10이 영수증 action을 따로 두지 않으므로 결정과 영수증 모두 router의
  `amux.decision.deliver`입니다. docs/policy/amux-decision-maker.md §4의 보고는 읽기만 하며 분모가 비면 `insufficient_evidence`이고 스위치·졸업과 닿지 않습니다. 같은 변경에서 원장의
  stale close를 `720 hours`로 고정했습니다(이전 `30 days`는 DST에서 한 시간 어긋남). 함수 네 개를
  교체하는 migration은 header 선언이 하나뿐이라 이전 본문 digest를 첫 DO 블록에서 대조합니다.
  route·Admin 화면·bridge는 없습니다.
- **S1f1(스위치 route)**: `app/api/admin/amux/decision-maker/switches/route.ts`,
  `lib/amux/dbBoundary.ts`의 `decisionMakerSwitchRead`·`decisionMakerSwitchChange`,
  `tests/server-contract/admin-amux-decision-maker-switches-route.test.ts`. 읽기는 관리자 누구나이고
  (kill switch 중에도 DM 기록 열람은 허용), 변경은 `ops:write`와 최근 step-up을 body보다 먼저 검사합니다.
  두 handler는 첫 줄부터 `withAmuxRouteBudget` 안에서 돌므로 세션·rate limit·body에 쓴 시간이 15초
  예산에서 빠지고, 남은 시간이 경계 예산보다 짧으면 트랜잭션을 시작하지 않습니다
  (`tests/server-contract/admin-amux-decision-maker-switches-route-budget.test.ts`).
  route는 S1b store를 AMUX DB 경계 안에서 직접 부르며 감사는 store가 씁니다. **경계 상한은 store의 가장
  긴 문장 수 + setup + fence입니다** — `tests/amuxDecisionMakerSwitch.test.mjs`가 그 셈을, switch DB
  테스트가 하나 줄인 상한의 거부를 고정하므로 store에 문장을 더하면 상한도 함께 올립니다. 결과를 모르면
  `outcome_unknown`(503)으로 답하고 다시 보내지 않고 GET으로 확인합니다. Admin 화면·라우팅 route·bridge는
  없습니다.
- **S1f2(스위치 화면)**: `components/admin/AmuxDecisionMakerSwitchPanel.tsx`,
  `lib/adminMessages/amuxDecisionMaker.ts`, `/admin/amux-settings?tab=decision-maker`(`lib/adminNavigation.ts`,
  `lib/adminNavigationLocale.ts`, `app/(site)/(application)/admin/amux-settings/page.tsx`),
  `tests/client/amuxDecisionMakerSwitchRender.test.tsx`. 화면은 S1f1 route만 부르고, 바꿀 수 있는 값은
  `dmSwitchChangesFor()`가 정책 목록에서 지금 값만 뺀 것입니다(읽을 수 없는 scope는 전부). 권한이 없으면
  상태와 이유만 보이고, 428은 `AdminApiFailureNotice`로 재인증 링크를 보입니다. **표시 중인 상태를
  유지하는 것은 아무것도 쓰지 않았음이 증명된 답뿐입니다** — 쓰기 전 거절(400·403·404·413·428·429)과
  본문까지 읽은 503 `switch_change_failed`. 그 밖의 모든 답(저장, `outcome_unknown`, 본문을 못 읽은 503,
  다른 status, 응답 없음) 뒤에는 `runDmSwitchChange()`가 GET으로 상태를 다시 읽고, 그 읽기가 끝나기
  전에는 어떤 버튼도 풀지 않습니다. 다시 읽기에 실패하면 상태를 표시하지 않고 "다시 읽기"만
  남깁니다 — 확인되지 않은 상태 위에서 같은 변경을 다시 보내 latch를 풀 수 없게 하기 위해서입니다. 탭에
  badge는 없습니다.
- **S1f3(라우팅 route)**: `app/api/internal/amux/decision-maker/requests/route.ts`,
  `lib/amux/dbBoundary.ts`의 `decisionMakerRouting`(상한 12),
  `tests/server-contract/amux-decision-maker-routing-route.test.ts`,
  `tests/server-contract/amux-decision-maker-routing-route-budget.test.ts`. bridge가 부를 판정 route이며
  **`TOMVERSE_AMUX_DM_ROUTING=enabled`가 아니면 body를 읽기 전에 409 `dm_routing_disabled`입니다** — 이
  route를 부르는 bridge 경로가 S2(docs/policy/amux-decision-maker.md §12)이므로, 그 승인 전에는 스위치와
  상관없이 요청 원장에 아무것도 쓰지 않습니다. 판정은 body store의
  `recordDecisionMakerRequestWithCardText()` 하나이고(route는 인증·body·key ring·예산·경계만), 같은 (카드,
  질문 revision)은 기존 요청을 돌려주므로 결과 불명 뒤 같은 질문을 다시 보내는 것은 조회입니다. key ring
  오류는 DB에 닿기 전에 503이며 로그에는 코드만 남깁니다. 응답과 로그에 카드 문구·digest·감사 id는
  없습니다. **경계 상한 12는 라우팅의 가장 긴 경우(무결성 키, DM으로 가는 새 질문과 그 카드 본문) +
  setup + fence와 같고**, `tests/amuxDecisionMakerBody.test.mjs`가 그 셈을, body DB 테스트가 하나 줄인
  상한의 거부를 고정합니다. bridge·DM 호출은 없습니다.
- **S1f4(선언 정확도 보고 화면)**: `components/admin/AmuxDecisionMakerReportPanel.tsx`,
  `lib/adminMessages/amuxDecisionMaker.ts`의 `adminAmuxDecisionMakerReportMessages`,
  `lib/amux/dbBoundary.ts`의 `decisionMakerReportRead`(상한 4), Decision Maker 탭
  (`app/(site)/(application)/admin/amux-settings/page.tsx`),
  `tests/client/amuxDecisionMakerReportRender.test.tsx`. 화면은 S1e의
  `readDecisionMakerDeclarationAccuracyReport()`를 페이지가 AMUX DB 경계 안에서 읽어 넘긴 값만 그립니다 —
  요청도 버튼도 없습니다. 수치는 각자의 분자/분모로 보이고, 분모가 비면 `insufficient_evidence`를 말로
  보이며 0%로 쓰지 않습니다. 읽기에 실패하면 수치 없이 그 사실만 보이고, 스위치 읽기와 따로 실패합니다.
  docs/policy/amux-decision-maker.md §0-2의 졸업 기준과 비교하지 않습니다. **경계 상한 4는 보고의 두 문장 +
  setup + fence이고**, `tests/amuxDecisionMakerJudgment.test.mjs`가 그 셈을, judgment DB 테스트가 kill
  switch 중의 읽기와 하나 줄인 상한의 거부를 고정합니다. 제안 열람·판정 화면은 S2입니다.
- **S1g(보존 정리 sweep)**: `lib/amux/decisionMakerRetentionSweep.ts`, request store의
  `listDecisionMakerStaleCloseCandidates()`, body store의 `readDecisionMakerDigestKeyRegistry()`,
  `lib/amux/dbBoundary.ts`의 `decisionMakerRetentionRead`(상한 5)·`decisionMakerStaleClose`(9)·
  `decisionMakerBodyPurge`(9)·`decisionMakerDigestKeyRotate`(9)·`decisionMakerDigestKeyDestroy`(10),
  `app/api/internal/maintenance/credit-reservations/route.ts`의 연결, `tests/amuxDecisionMakerRetentionSweep.test.mjs`.
  docs/policy/amux-decision-maker.md §10의 시스템 정리를 15분 maintenance 실행에 붙였습니다: 현재·다음 key period
  키를 쓰기 시작하고(ring에 있고 registry에 없을 때), 720시간 열린 요청을 `stale_close`로 닫고, 보존이 지난 본문을
  지우고, 본문이 남지 않은 끝난 period의 키 파기를 기록합니다. **후보는 한 읽기 트랜잭션에서 읽고 쓰기는 항목마다
  자기 경계 트랜잭션에서 store가 lock 아래 다시 판정합니다** — sweep 파일에는 SQL이 없고 스위치를 읽지 않습니다
  (docs/policy/amux-decision-maker.md §6 표상 kill switch 중에도 허용). 오류가 나면 그 자리에서 멈추고 같은 실행에서 다시 보내지 않으며, 결과를 모르는
  쓰기는 다음 실행의 읽기가 정합니다. 경계 상한은 각 쓰기의 무결성 키 포함 최대 문장 수 + setup + fence이고,
  request·body 테스트의 문장 수 loop가 고정합니다. 키 파기 기록 뒤 `AMUX_DM_DIGEST_KEYS`에서 그 period를 지우는 것은
  운영자입니다.
- **S2-4a(Admin 요청 목록)**: `lib/amux/decisionMakerAdminCore.ts`, `lib/amux/decisionMakerAdminRead.ts`,
  request store의 `readRecentDecisionMakerRequestLedger()`, body store의 `readDecisionMakerResultDetailsForAdmin()`,
  judgment store의 `readDecisionMakerJudgmentsForAdmin()`, `components/admin/AmuxDecisionMakerRequestsPanel.tsx`,
  `lib/adminMessages/amuxDecisionMaker.ts`의 `adminAmuxDecisionMakerRequestsMessages`, `lib/amux/dbBoundary.ts`의
  `decisionMakerRequestListRead`(상한 5), `/admin/amux-settings?tab=decision-maker`,
  `tests/amuxDecisionMakerAdminList.test.mjs`, `tests/client/amuxDecisionMakerRequestsRender.test.tsx`. 최근 요청 50건의
  라우팅·상태·전달을 보이며, 보이는 건수와 그것이 전체 수가 아님을 화면에 적습니다. **각 표는 그것을 쓰는 store만
  읽습니다** — 요청과 사건은 request store, 결과 상세는 body store, 판정과 전달은 judgment store가 한 문장씩 읽고,
  `decisionMakerAdminRead.ts`는 SQL 없이 셋을 합칩니다. read 경계의 REPEATABLE READ가 세 문장을 한 snapshot으로
  묶으므로, 상한은 세 문장 + setup + fence입니다. 본문은 읽지 않고, 원장이 만들 수 없는 행(인스턴스와 공급사의 대응,
  `provider_unverified`와 빈 인스턴스, 사건 순서)이 하나라도 있으면 목록 전체를 읽지 못한 것으로 보입니다. 되돌릴 수
  없는 제안은 상태보다 먼저 표시합니다. 제안 열람·판정은 S2-4b입니다.
- **S2-4b1(Admin 요청 상세)**: `lib/amux/decisionMakerAdminRead.ts`의 `readDecisionMakerRequestDetailForAdmin()`,
  `components/admin/AmuxDecisionMakerRequestDetailPanel.tsx`, `adminAmuxDecisionMakerRequestDetailMessages`,
  `lib/amux/dbBoundary.ts`의 `decisionMakerRequestDetailRead`(상한 7),
  `/admin/amux-settings?tab=decision-maker&request=<id>`, `tests/client/amuxDecisionMakerRequestDetailRender.test.tsx`.
  요청 하나의 카드·DM 답·근거·이관 사유·고친 답·스냅샷을 보이며, 목록과 같은 원장 읽기를 그 id로 좁혀 쓰고 같은 검사를
  지납니다. **본문은 판정할 수 있는 관리자(`ops:write`)에게만 읽어 보입니다** — 그 밖의 관리자에게는 본문을 읽지 않고
  이유만 보입니다. 판정에 넘길 값(`shown`: 답·근거 본문의 keyed digest, select의 선택지, `irreversible`, 스냅샷 상태·SHA·
  manifest digest)은 열린 제안의 본문과 전송이 모두 있을 때만 계산하며, judgment DB 테스트가 그 값으로 판정 store가 확정을
  기록함을 고정합니다. worker와 모델이 쓴 글은 markup이 아닌 글자로만 보입니다. 판정 route와 버튼은 S2-4b2입니다.
- **S2-4b2(Admin 판정)**: `app/api/admin/amux/decision-maker/judgments/route.ts`,
  `components/admin/AmuxDecisionMakerJudgmentPanel.tsx`, `adminAmuxDecisionMakerJudgmentMessages`,
  `lib/amux/dbBoundary.ts`의 `decisionMakerJudgment`(상한 12), `tests/server-contract/admin-amux-decision-maker-judgments-route.test.ts`,
  `tests/client/amuxDecisionMakerJudgmentRender.test.tsx`. 상세 화면의 열린 제안에서 그대로 확정·고쳐서 확정·거절과 선언 정확도를
  기록합니다. route는 `ops:write`와 최근 step-up을 body보다 먼저 검사하고(낡은 step-up은 428과 재인증 링크), 고친 답일 때만
  DB 전에 digest key ring을 읽으며, 판정은 S1e store가 한 트랜잭션에서 씁니다. **확정은 상세 화면이 보인 `shown` 값을 그대로
  보내고**, store가 저장값과 다르면 거절합니다. store의 거절은 409와 그 이유입니다. **판정은 한 번만 보냅니다** — 기록·거절·결과
  불명 뒤에는 모든 버튼을 잠그고 다시 읽기 링크만 두며, 트랜잭션 전 거절(400·403·404·413·428·429)과 rollback을 말한 503만 버튼을
  돌려줍니다(`runDmJudgment()`). 화면은 확정한 답이 승인 계약의 승인이 아님을 적습니다. 이 route는 전달 경로를 부르지 않으므로
  여기서 worker에게 가는 것은 없습니다. 상한 12는 무결성 키가 있는 고친 답 확정의 10문장 + setup + fence이고, judgment unit
  테스트가 그 셈을, judgment DB 테스트가 하나 줄인 상한의 거부를 고정합니다.
- **S2-4c(Admin의 cleanup_unknown 표시)**: `lib/amux/decisionMakerAdminCore.ts`의 `cleanupUnknownAtMs`·`dmAdminSwitchLatchesFromRows()`,
  request store의 `readRecentDecisionMakerRequestLedger()`가 같은 문장에서 싣는 `cleanupUnknownAtEpochMs`, switch store의
  `readDecisionMakerSwitchRowsForAdmin()`과 `decisionMakerAdminRead.ts`의 `readDecisionMakerSwitchesForAdmin()`,
  `AmuxDecisionMakerRequestsPanel.tsx`·`AmuxDecisionMakerRequestDetailPanel.tsx`·`AmuxDecisionMakerSwitchPanel.tsx`, 각 messages의
  `cleanupUnknown*`·`latchReasons`, `tests/amuxDecisionMakerAdminList.test.mjs`와 세 client render 테스트. S2-2a3가 원장에 남긴
  `cleanup_unknown` 보고를 운영자가 봅니다. **요청 목록은 상태 옆에 "정리 확인 못 함" 표시를 더하고(상태를 대체하지 않음) 표시된 요청 중
  몇 건인지 한 문장으로 말하며, 상세는 보고 시각과 해야 할 일을 문구로만 적습니다.** 표시는 본문이 아니라 닫힌 플래그와 DB 시계이므로
  목록에서 모든 관리자에게 보이고, 해야 할 일의 문구는 상세(`ops:write`)에 있습니다. **디렉터리 경로·요청 디렉터리 이름·명령은 화면에
  넣지 않습니다** — 요청 id는 화면 글자로 쓰지 않는 기존 관례를 따르며, 운영자는 카드 id와 보고 시각으로 runner에서 가립니다.
  스위치 패널은 시스템이 끈 인스턴스에 그 이유(`cleanup_latch`·`validation_latch`)를 보입니다 — 이전에는 이유를 아예 읽지 않았습니다.
  이유는 인스턴스의 **가장 새 스위치 사건**이 시스템의 latch일 때만이고(사람이 해제하거나 바꾸면 사라짐), 상태와 같은 문장에서 읽으므로
  `decisionMakerSwitchRead`의 상한(3)은 그대로입니다. 패널이 변경·재읽기로 상태를 API에서 다시 받은 뒤에는 이유를 보이지 않습니다(API 응답은
  이유를 싣지 않음). 요청 목록·상세의 문장 수와 경계(5·7)도 그대로입니다: 새 열은 기존 원장 문장의 집계에 들어갑니다. 새 열이 없는 행은
  원장이 만든 행이 아닌 것으로 보아 목록 전체를 읽지 못한 것으로 둡니다.
- **S2-2a(bridge·broker 내부 route)**: `app/api/internal/amux/decision-maker/assignments/route.ts`,
  `app/api/internal/amux/decision-maker/assignments/discard/route.ts`,
  `app/api/internal/amux/decision-maker/transmissions/route.ts`,
  `app/api/internal/amux/decision-maker/transmissions/outcome/route.ts`,
  `app/api/internal/amux/decision-maker/results/route.ts`, `app/api/internal/amux/decision-maker/results/lookup/route.ts`,
  `app/api/internal/amux/decision-maker/results/unknown/route.ts`, `lib/amux/decisionMakerInternalRoute.ts`,
  `lib/amux/dbBoundary.ts`의 `decisionMakerAssignment`(상한 11)·`decisionMakerAssignmentDiscard`(9)·
  `decisionMakerTransmitIntent`(11, S2-2a2에서 10에서 올림)·`decisionMakerTransmitOutcome`(9)·`decisionMakerResultSubmission`(12)·
  `decisionMakerResultLookupRead`(3)·`decisionMakerResultUnknown`(9),
  `tests/server-contract/amux-decision-maker-broker-routes.test.ts`,
  `tests/server-contract/amux-decision-maker-broker-routes-budget.test.ts`. 라우팅 뒤에 bridge·broker가 부르는 원장 기록
  route이며, S1f3과 같이 **`TOMVERSE_AMUX_DM_ROUTING=enabled`가 아니면 body를 읽기 전에 409 `dm_routing_disabled`**이고 key
  ring도 DB도 건드리지 않습니다. route는 인증·body·key ring·예산·경계만 하고 판정은 동작마다 store 함수 하나입니다 — 배정과
  결과 제출은 body store의 조합, 나머지는 request store이며, route에는 SQL도 스위치 읽기도 없습니다. store가 돌려준 거절은
  `unknown_request` 404, `digest_key_unavailable`·`settings_unreadable` 503, 그 밖은 409이고, 결과 제출은 원장의 확정
  답(accepted·existing·rejected·already_rejected)이 모두 200과 그 status입니다. **요청 키 K_R은 배정 응답에만 있습니다** —
  broker가 payload·manifest·결과 digest를 keyed로 만들고 잃은 결과를 조회하는 데 쓰며, period 키는 어떤 응답에도 없고 로그에는
  key ring 오류 코드만 남습니다. 결과 응답을 잃으면 다시 제출하지 않고 `results/lookup`(읽기 경계, 쓰기 없음)으로 확인하고,
  확인하지 못하면 `results/unknown`입니다. **경계 상한은 각 store 연산의 무결성 키 포함 최대 문장 수 + setup + fence**이고,
  request·body unit 테스트가 그 셈을, body DB 테스트가 하나 줄인 상한의 거부를 고정합니다. 전달·판정 route와 worker에게 가는
  경로는 없습니다.
- **S2-2a2(latch 호출)**: request store의 `recordDecisionMakerValidationLatch()`·
  `readDecisionMakerInstanceResultKinds()`·`readDecisionMakerInstanceLoad()`(이전 `readDecisionMakerThroughput()`), switch store의
  `readDecisionMakerSwitchesWithBoundariesOrThrow()`, switch core의 `decisionMakerSwitchReadFromRows()`, request core의
  `dmValidationLatchDecision()`·`dmSwitchInputWithOwedLatch()`, `lib/amux/decisionMakerInternalRoute.ts`의
  `settleDmValidationLatch()`, `lib/amux/dbBoundary.ts`의 `decisionMakerValidationLatch`(상한 10)·`decisionMakerTransmitIntent`(11),
  `lib/amux/decisionMakerRetentionSweep.ts`의 첫 단계. docs/policy/amux-decision-maker.md §8의 검증 실패 연속 3건이 인스턴스를
  `off`로 latch합니다. **연속은 그 인스턴스의
  종결 결과를 원장 순서로 셉니다** — 다른 종결 결과(제안·이관·시간 초과·DM 불가)가 끼면
  끊기고, 거절·unknown 결과는 세지도 끊지도 않습니다. 어디서부터 세는지는 S2-2a4가 고쳤습니다(아래 항목): 가장 새 validation
  latch와 그 뒤의 `amux.decision.latch_release`만 경계이고, 사람의 일반 mode 변경은 경계가 아닙니다(이 조각의 처음 구현은 사람의
  변경이면 무엇이든 경계로 삼아 docs/policy/amux-decision-maker.md §8을 어겼습니다). 풀리지 않은 validation latch가 있으면 아무것도
  쓰지 않으므로 같은 실패열은 한 번만 latch됩니다. 최근 100건 안에 3연속이 하나라도 있으면 latch가 밀린(owed) 것입니다. **밀린
  latch는 쓰이기 전에도 인스턴스를 끕니다** —
  라우팅과 전송 의도가 쓰는 스위치 읽기 한 문장이 인스턴스마다 셈의 경계를 함께 돌려주고, 라우팅은 처리량
  문장에 결과 종류 배열을 실어(문장 수 그대로) 밀린 latch를 `instance_off`로 운영자에게 보내며, 전송 의도는 결과 종류 읽기 한
  문장을 더해 의도를 쓰지 않고 `instance_off`로 거부하면서 그 latch를 같은 트랜잭션에 씁니다(이 함수에서 쓰기가 있는 유일한
  거부). 그래서 세 번째 실패의 commit과 latch 사이에도 공급사 전송이 없습니다. 결과 route는 검증 실패 결과의 commit 뒤 별도
  경계에서 latch를 확인하고(결과 제출 트랜잭션은 이미 10문장이라 docs/policy/amux-decision-maker.md §9의 12를 넘음, 실패해도 결과
  응답은 그대로이며 로그는 코드만), 15분 보존 sweep이 두 인스턴스를 보존 작업보다 먼저 다시 확인합니다. **sweep의 latch 확인은
  인스턴스마다 실패 경계가 따로입니다** — 한 인스턴스 확인이 실패하면 코드만 담은 구조화 로그를 남기고 세기만 하며, 다른 인스턴스
  확인과 docs/policy/amux-decision-maker.md §10의 보존 정리(키 교체·stale 종료·본문 삭제·키 파기)는 그대로 진행합니다. 이 막음은
  store가 하며 DB trigger는 원장 삽입 때 밀린 latch를 보지 않습니다. latch는 끄기만 하므로 kill switch를 보지 않고, 다시 켜는
  것은 운영자의 `amux.decision.latch_release`뿐입니다. cleanup_unknown 보고는 원장 사건 종류가 필요해 migration을 갖는 별도
  조각입니다. 경계 상한은 각 연산의 무결성 키 포함 최대 문장 수 + setup + fence이고, request unit 테스트가 그 셈을, request·body
  DB 테스트가 하나 줄인 상한의 거부를 고정합니다.
- **S2-2a3(cleanup_unknown)**: `prisma/migrations/20261017160000_amux_decision_maker_cleanup_unknown/migration.sql`,
  `app/api/internal/amux/decision-maker/cleanup/unknown/route.ts`, request store의 `recordDecisionMakerCleanupUnknown()`·
  `recordDecisionMakerCleanupLatch()`·`readDecisionMakerInstanceLatchInputs()`·`readDecisionMakerInstanceNewestCleanupUnknown()`,
  request core의 `dmCleanupLatchDecision()`·`dmOwedLatchReason()`, `lib/amux/decisionMakerInternalRoute.ts`의
  `settleDmCleanupLatch()`, `lib/amux/dbBoundary.ts`의 `decisionMakerCleanupUnknown`(상한 9)·`decisionMakerCleanupLatch`(10),
  `lib/amux/decisionMakerRetentionSweep.ts`의 인스턴스별 첫 확인, switch store·core의 `cleanupEventId`(latch가 처리한 보고)와
  그것을 싣는 스위치 읽기, `prisma/schema.prisma`의 그 열과 관계. docs/policy/amux-decision-maker.md §5의 "지웠는지 확인하지 못하면
  `cleanup_unknown`으로 두고 그 인스턴스를 `off`로 latch한다"입니다. broker가 요청 자신의 인스턴스로 보고하면 원장에 사건 종류
  `cleanup_unknown`(열세 번째 종류)이 그 인스턴스 actor의 `amux.decision.cleanup_unknown` 감사와 같은 트랜잭션에 남습니다. **요청당
  하나이고**(부분 유일 index와 trigger), 배정 뒤에만 받으며(broker는 전송 의도 전에 요청 디렉터리를 만듭니다), 마감이 없고, 요청이
  닫힌 뒤·결과 뒤·kill switch 중에도 받습니다. **닫힘 종류가 아닙니다** — docs/policy/amux-decision-maker.md §6의 종결 결과도 사람의 판정도 아니므로 보고 전에 저장된
  제안은 운영자에게 열린 채 남고, 닫힌 뒤 온 보고도 기록됩니다. 그래서 닫힘 목록과 그것을 쓰는 guard·store 읽기는 바뀌지 않습니다.
  같은 보고를 다시 보내면 기록된 사건을 돌려주고 아무것도 쓰지 않으며, 다른 인스턴스의 보고는 그 전에 거절합니다. **latch는 보고가
  commit된 뒤 별도 경계에서 씁니다**(보고 7 + 스위치 읽기 + latch 5는 setup·fence와 15로 docs/policy/amux-decision-maker.md §9의 12를
  넘음) — route는 기록했든 이미 있었든 그 확인을 돌리고, 실패해도 답은 보고의 것이며 로그는 코드만입니다. **`cleanup_latch`는 자기가
  처리한 보고의 원장 사건 id를 스위치 사건의 `cleanupEventId`에 담고, 보고를 처리한 것으로 치는 것은 그 이름이 붙은 latch 하나뿐입니다**
  — 시각으로 비교하지 않습니다. 이전 보고의 latch와 다음 보고가 같은 DB ms에 놓일 수 있기 때문입니다(검토 r-20261017-123200-7609b7,
  보고는 off 중에도 받음). 판정은 "인스턴스의 가장 새 보고(원장 sequence 순) id = 가장 새 `cleanup_latch`가 담은 id"이고, latch는 언제나
  audit chain lock 아래 읽은 가장 새 보고를 이름 대므로 가장 새 latch와만 비교해도 정확합니다. DB는 그 이름을 `cleanup_latch`에만
  있게(CHECK), 보고당 한 번(unique), 지울 수 없는 원장 사건을(제한 FK), 그리고 latch와 같은 인스턴스의 `cleanup_unknown` 보고만(교체한
  스위치 guard) 받습니다. 그래서 사람의 일반 mode 변경(같은 값 재저장, off 뒤 proposal, 검토 r-20261017-115136-888d76)과 다른 원인의
  latch, 다른 보고의 latch는 보고를 처리하지 않고 latch는 밀린 채 남아 다음 라우팅·전송 의도·sweep이 씁니다. 보고는 요청당 하나라
  재전송은 같은 사건이므로, 재전송·재확인·해제 뒤 늦은 재전송은 다시 끄지 않습니다. migration은 두 함수(원장 event guard와 스위치
  guard)를 바꾸므로 이전 본문 digest를 첫 DO 블록에서 대조하고, 새 열 때문에 baseline guard의 schema 비교에 보이므로 header 선언은
  두지 않습니다. **밀린 latch는 쓰이기 전에도 인스턴스를 끕니다** — 라우팅은 처리량 문장에, 전송 의도는 결과 종류 읽기 문장에 가장 새
  보고 id를, 스위치 읽기는 가장 새 latch가 담은 id를 실어(문장 수 그대로) `instance_off`로 막고, 전송 의도는 밀린 latch를 같은 트랜잭션에 씁니다. 둘 다 밀렸으면 `cleanup_latch`가
  먼저입니다. 15분 sweep은 인스턴스마다 정리 latch 확인 뒤 docs/policy/amux-decision-maker.md §8 확인을 하며 각 확인이 따로 실패 경계입니다. DB trigger는 원장 삽입 때
  밀린 latch를 보지 않고, latch는 끄기만 하므로 kill switch를 보지 않습니다. 경계 상한은 각 연산의 무결성 키 포함 최대 문장 수 +
  setup + fence이고, request unit 테스트가 그 셈을, request DB 테스트가 하나 줄인 상한의 거부를 고정합니다. Admin 화면 표시는
  S2-4c입니다.
- **S2-2a4(검증 실패 셈의 경계)**: `prisma/migrations/20261017200000_amux_decision_maker_validation_count_boundary/migration.sql`,
  switch core의 `DmValidationCountBoundary`·`decisionMakerSwitchReadFromRows()`, switch store의
  `readDecisionMakerSwitchesWithBoundariesOrThrow()`, request core의 `dmValidationCountWindow()`·`dmValidationLatchDecision()`·
  `dmOwedLatchReason()`, request store의 세 결과 읽기(`readDecisionMakerInstanceLoad()`·`readDecisionMakerInstanceResultKinds()`·
  `readDecisionMakerInstanceLatchInputs()`), `prisma/schema.prisma`의 원장 사건 `switchSequence`. docs/policy/amux-decision-maker.md §8의
  "해제는 운영자만"입니다. **셈은 인스턴스의 가장 새 `validation_latch`와 그 뒤 첫 사람의 사건부터만 시작합니다** — 스위치 guard가
  시스템 사건 뒤 첫 사람의 사건을 `amux.decision.latch_release`로만 받으므로 그 사건이 곧 해제입니다. validation latch가 없으면
  모든 결과(최근 100건)를 세고, 풀리지 않았으면 아무것도 밀리지 않으며(같은 실패열은 한 번만), 풀렸으면 그 해제 뒤의 결과만
  셉니다. 사람의 일반 mode 변경(같은 값 재저장, off 뒤 proposal, 해제 뒤의 변경), `cleanup_latch`와 그 해제는 경계가 아닙니다 —
  세 번째 실패 뒤 latch가 쓰이기 전에 mode를 다시 저장하면 latch가 사라지던 결함이 이것이고, `cleanup_latch`는 검증 실패열을
  처리하지 않으므로 둘 다 밀렸으면 둘 다 씁니다. **해제 앞뒤는 결과가 받아들여질 때 본 스위치 상태로 가릅니다** — 시각도 원장
  sequence도 아닙니다. 해제 전에 commit된 실패가 해제와 같은 DB ms에 놓일 수 있고, 원장 sequence는 INSERT가 시작될 때 뽑혀
  guard가 gate를 기다리기 전이므로 audit chain lock이 없으면(entryHash 없는 감사 행은 잡지 않음) commit 순서가 아닙니다 — 실패가
  N을 뽑고 해제가 쥔 gate를 기다리는 동안 gate를 잡지 않는 다른 요청의 assign이 N+1로 commit할 수 있습니다(검토
  r-20261018-012448-8f45bd, 처음 구현의 `ledgerSequence`가 이 경로로 해제 뒤 실패를 영구히 빠뜨렸습니다). 그래서 교체한 원장
  guard가 결과마다, 이미 결과에 공유로 잡는 스위치 gate 뒤에 그 인스턴스의 가장 새 스위치 사건 sequence를 읽어
  `switchSequence`에 씁니다(writer가 준 값과 상관없이, 다른 종류는 NULL). 스위치 변경은 gate를 exclusive로 commit까지 쥐므로
  해제는 결과의 읽기보다 통째로 앞이거나(결과가 해제나 그 뒤 사건을 봄) 통째로 뒤이며, 해제 뒤 셈은 `switchSequence`가 해제의
  sequence 이상인 결과입니다. migration 전에 쓰인 결과(값 없음)만 해제의 DB 시계로 가르며 같은 ms의 결과는 셉니다(latch가
  빨라지는 쪽). migration은 원장 guard 하나를 바꾸므로 이전 본문 digest(20261017160000의 본문)를 첫 DO 블록에서 대조하고, 새 열
  때문에 baseline guard의 schema 비교에 보이므로 header 선언은 두지 않습니다. 문장 수는 그대로입니다 — 경계는 이미 보내던 스위치
  읽기 한 문장의 LATERAL 두 개에, 해제 sequence는 이미 보내던 결과 읽기의 조건에 실렸고 trigger 안의 읽기는 셈에 들지 않으므로
  라우팅 12·전송 의도 11·latch 확인 10·결과 제출 12(각각 setup·fence 포함)가 바뀌지 않습니다. 이 조각이 바꾸는
  것은 검증 실패 latch의 셈뿐이며 kill switch와 인스턴스 `off`의 판정, 해제 action의 판정은 바꾸지 않습니다.
- **S2-3a(전용 launcher의 결정적 핵심)**: `lib/amux/decisionMakerLauncherCore.ts`,
  `lib/amux/decisionMakerLauncherFs.ts`, `lib/amux/decisionMakerLauncherProcess.ts`,
  `tests/amuxDecisionMakerLauncherCore.test.mjs`, `tests/amuxDecisionMakerLauncherFs.test.mjs`,
  `tests/amuxDecisionMakerLauncherProcess.test.mjs`, `tests/support/amuxDmLauncherFixture.mjs`.
  정책 버전 2의 고정 실행 조건(docs/policy/amux-decision-maker.md §5a)을 코드로 옮긴 것이며, **core 테스트가 그 절의 본문을 읽어
  argv·실행 파일 sha256·고정 환경·삭제/남김 목록·거부 argv를 대조합니다** — 정책과 코드 한쪽만 바꾸면 실패합니다. 시작 허가는
  preflight의 빈 거부 목록 하나뿐이고, 그 목록은 모든 검사를 돌려 전부 보고합니다. 실행 digest(`amux-json-v1`의 sha256)는 앱의
  `amuxCanonicalJson`으로 계산하고 기록값은 core의 상수이며, 그 값을 테스트가 다시 고정합니다. **전송 의도는
  route의 기록 응답이 이 요청 id·인스턴스의 것이고, 그 payload digest가 stdin으로 보낼 바이트의 `dmPayloadDigest(K_R, …)`와
  같을 때만 증거입니다.** payload는 호출 순간 첫 비동기 경계 전에 한 번 복사하고, 그 복사본 하나로 digest를 검사하고 stdin에
  보냅니다 — 호출자가 그 뒤 버퍼를 바꿔도 보내는 바이트는 기록과 같습니다. **요청은 경로를 넘기지 않습니다.** 요청 디렉터리는
  S0이 만든 broker 소유 `/var/lib/amux-dm/requests` 아래, 임시 디렉터리는 계정 홈의 `dm-scratch` 아래에 요청 id 한 단계로만
  생기고, 읽기·만들기·지우기 전에 `/`부터 각 디렉터리를 lstat로 확인합니다(link 아님, S0의 소유자, 그룹·다른 사용자 쓰기 없음,
  홈과 임시 디렉터리는 `0700`). 지울 대상도 같은 기준을 통과해야 하고, 확인한 부모 안에서 옆 이름으로 rename한 뒤 inode가
  같아야 합니다. **재귀 `rm`은 쓰지 않습니다** — 직접 깊이 우선으로 돌며 link·파일·특수 파일은 unlink만 하고, 하위 디렉터리는
  정리 계정 소유이고 그룹·다른 사용자 쓰기가 없을 때만, link를 따르지 않고 연 inode가 lstat과 같을 때만 들어가 비운 뒤 `rmdir`합니다.
  그래서 정리 중에 항목을 바꿔치기할 수 있는 주체는 root와 정리하는 계정의 다른 프로세스뿐입니다. 확인에 실패하면 그 자리에서
  멈추고 아무것도 읽거나 지우지 않으며 `cleanup_unknown`입니다. 결과는
  codex `-o` 파일과 claude `structured_output`에서만 읽고, 스키마의 `output` 감싸개만 벗겨 앱의 출력 검증
  (docs/policy/amux-decision-maker.md §6)에 넘깁니다. 정리는 둘로 나뉩니다 — launcher(공급사 계정)는 거부·실패·시간 초과·
  launcher 오류를 포함한 모든 종료 경로에서 임시 디렉터리와 CLI 상태를 지우고 확인하며, broker는 launcher가 돌아온 뒤 언제나
  `dmCleanupRequestDirectory()`로 요청 디렉터리를 지웁니다. 남김 목록 밖에 무엇이든 남거나 확인하지 못하면 `cleanup_unknown`을
  결과와 따로 보고합니다(latch는 앱의 일). 실행 파일·스키마의 root 소유 경로와 임시 디렉터리 위치는 정책 본문에 없는 launcher
  상수입니다. 테스트용 host만 다른 실행 파일 sha256·timeout·소유자를 받고, 시스템 host에서는 sha256·timeout override가 거부됩니다.
  broker·bridge·route 호출·설치·unit은 없습니다.
- **S2-3b(broker와 runner 설치 파일)**: `lib/amux/decisionMakerBrokerCore.ts`, `lib/amux/decisionMakerBroker.ts`,
  `lib/amux/decisionMakerLauncherService.ts`, `lib/amux/decisionMakerSocketLine.ts`, launcher Fs의
  `dmCreateRequestDirectory()`·`dmRequestRootState()`·`dmVendorGroupId()`, `scripts/amux-dm-broker.mjs`,
  `scripts/amux-dm-launcher.mjs`, `scripts/build-amux-decision-maker.mjs`(`npm run build:amux-decision-maker`),
  `scripts/install-amux-decision-maker.sh`, `scripts/systemd/amux-dm-broker.{socket,service}`,
  `scripts/systemd/amux-dm-launcher-{openai,anthropic}.socket`·`@.service`, `tests/amuxDecisionMakerBrokerCore.test.mjs`,
  `tests/amuxDecisionMakerBroker.test.mjs`, `tests/amuxDecisionMakerInstall.test.mjs`, `tests/amuxDecisionMakerInstallShell.test.mjs`,
  `scripts/amux-decision-maker-release-out.mjs`, `tests/amuxDecisionMakerReleaseOut.test.mjs`, `tests/support/amuxDmBrokerFixture.mjs`.
  **sudo·setuid 없이 계정을 나누는 것은 systemd입니다** — bridge는 broker 소켓(`/run/amux-dm-broker/broker.sock`, broker 소유·
  `tomverse-bridge` 그룹·`0660`)에, broker만 공급사별 launcher 소켓(`/run/amux-dm-launcher/<instance>.sock`, broker 소유·`0600`)에
  닿고, launcher 소켓은 `Accept=yes`·`MaxConnections=1`이라 연결마다 그 공급사 계정의 unit 하나가 뜹니다. 그 unit의
  `KillMode=control-group`·`RuntimeMaxSec=32min`이 launcher가 죽어도 CLI가 요청을 넘어 살지 못하게 하는 backstop입니다(launcher
  자신은 30분에 죽임). 소켓 파일의 소유·권한은 systemd가 만들고 broker는 넘겨받은 fd에서만 듣습니다. **프로토콜은 연결 하나에
  요청 하나, 양쪽 한 줄씩**(JSON 한 줄, 줄마다 상한과 기한)입니다. launcher는 먼저 자기 인스턴스로 `ready`를 보내고 그 뒤에만
  요청을 읽으므로, `ready` 전에 끊긴 연결은 아무것도 보내지 않은 것이 증명됩니다. broker는 앱 route를 부르지 않습니다 — bridge가
  전송 의도를 기록한 뒤 그 바이트·K_R·의도 응답을 보내면, broker가 의도를 그 바이트와 대조하고(아니면 디렉터리도 launcher도 없음),
  요청 루트에 진행 중이 아닌 것이 없음을 확인하고(있으면 거부와 `cleanup_unknown`), S0이 만든 홈의 그룹으로 빈 요청 디렉터리
  (broker 소유, `0750`)를 만들고, launcher의 한 답을 받은 뒤 **어떤 경로에서든** 그 디렉터리를 지우고 bridge에 한 줄로 답합니다.
  답에는 `transmission`(`process_ended`·`not_started`·`unknown` — 영수증 기록용), docs/policy/amux-decision-maker.md §9의 결과 digest를 붙인 결과(출력·시간 초과·DM 불가),
  `cleanup`(범위와 종류만, 경로 없음)이 있습니다. 같은 인스턴스의 두 번째 요청은 아무것도 건드리지 않고 `busy`입니다. 카드는
  stdin으로만 가고 요청 디렉터리는 비어 있으며, S2b 스냅샷은 없습니다. **설치는 dry run이 기본입니다** — build가 만든 릴리스 디렉터리
  (번들·스키마·unit·설치기·`manifest.sha256`)를 root 소유 위치로 옮겨 그 manifest의 sha256을 주고 실행하며, `--apply`일 때만
  docs/policy/amux-decision-maker.md §5a의 경로로 CLI를 복사(복사본의 sha256을 정책 값과 대조)하고 `daemon-reload`까지만 합니다.
  **같은 바이트만으로는 그대로 두지 않습니다** — root 소유·root 그룹·정확한 mode·링크 1개인 일반 파일일 때만 `same`이고, 바이트가
  같아도 그 밖이면 `repair`로 다른 바이트(`replace`)처럼 `/var/backups/tomverse-amux-dm/<시각>/`에 보존한 뒤 목적지 디렉터리 안에서
  만든 사본을 rename으로 원자 교체합니다. 목적지의 link·디렉터리는 거부합니다. **목적지와 백업으로 가는 길의 이미 있는 모든 디렉터리**는
  link 아님·root 소유·그룹/기타 쓰기 없음이어야 하며, dry run이 보고하고 apply가 첫 변경 직전과 각 이동 직전에 다시 확인합니다
  (검토 r-20261017-113433-e16efc 1·2). release의 `systemd/`도 같은 검사를 받고, 백업 디렉터리는 실행마다 새로 만들며 이미 있으면
  멈춥니다(재검토 r-20261017-114940-a271fb의 sweep). 빌드의 `--out`은 저장소·홈·파일시스템 루트와 그 조상을 언제나 거부하고, **경로 자신과
  이미 있는 모든 조상 중 하나라도 link이거나 realpath가 적힌 경로와 다르면 기본 경로라도 거부합니다**. 비어 있지 않은 디렉터리는 빌드가 남긴
  표식(`.amux-decision-maker-release`)이 있고 그 밖의 항목이 모두 release 자신의 일반 파일일 때만 쓰며, 재귀 삭제 없이 그 파일들만 이름으로
  지웁니다(검토 3, 재검토). 표식을 포함해 이름이 둘 이상인(hard link) 항목이 있으면 `hard_link`로 거부하고, 빌드는 기존 항목을 먼저 unlink한
  뒤 모든 파일을 배타적 생성(`wx`, `COPYFILE_EXCL`)으로만 씁니다 — 기존 파일 안에 쓰지 않습니다(세 번째 검토 r-20261017-121031-9ff0a9).
  unit을 enable·start하지 않고, CLI는 `--version`만(nobody, 네트워크 없는 namespace, 빈
  환경) 실행하며, 앱의 `TOMVERSE_AMUX_DM_ROUTING`은 그대로 꺼져 있습니다. bridge relay(S2-2b)와 cleanup_unknown 보고 route는
  없습니다.
- **S2-2b1(선택지별 효과 등급·경로와 정책 버전 2)**: `lib/amux/decisionMakerCore.ts`의 `DmCardOption`, 효과 등급 목록과 변경
  경로 상한, `dmOptionEffectWellFormed()`, 카드 텍스트 형식 `amux-dm-card-text-v2`, 정책 버전 상수, request core의 `parseDmCard()`,
  `tests/amuxDecisionMakerCardFields.test.mjs`.
  카드의 선택지는 `{ id, label, effect, paths }`입니다(docs/policy/amux-decision-maker.md §4, §5). **이름은 앱의 camelCase이고,
  로컬 AMUX가 저장하는 snake_case(`context_paths`)는 bridge relay(S2-2b2)가 바꿉니다** — 선택지의 네 키는 양쪽이 같은 단어입니다.
  효과 등급은 정책 표의 여섯이고 변경 등급(`branch_code_change`·`docs_change`·`test_change`)만 경로 1~50개를 갖습니다. **로컬
  AMUX는 선언을 거절하지 않고 없거나 틀린 선언을 `other`·경로 없음으로 기록하므로**(`dm_ask.rs`의 `recorded_effect`), 앱에 오는
  선택지는 언제나 그 기록 형식입니다. 라우터는 등급으로 라우팅하지 않고(docs/policy/amux-decision-maker.md §4, 버전 2도 같음)
  그 형식 밖의 선택지만 `input_limit_exceeded`로 운영자에게 보내며 `other`로 고쳐 쓰지 않습니다 — 본문 저장소의 카드 텍스트가
  라우터가 판정한 카드여야 하기 때문입니다. 선택지의 경로는 맥락 경로와 같은 경로 문법을 따르고, 카드 secret 검사와 16 KiB 카드
  텍스트에 들어가며, 용어 목록의 입력은 아닙니다(맥락 경로도 아님). 테스트가 로컬 `dm_ask.rs`의 목록·상한과 정책의 효과 등급 표를
  직접 읽어 대조하므로 한쪽만 바꾸면 실패합니다. **결과 제출의 선택지는 계속 `{ id, label }`이고 선택지 집합 digest도 그 둘만
  묶습니다** — 등급·경로가 바뀌면 로컬 AMUX에서 새 질문 revision, 곧 새 요청입니다. 카드 텍스트 v1(선택지 `{ id, label }`)은 읽지
  않습니다. 그것을 쓰는 경로는 처음부터 `TOMVERSE_AMUX_DM_ROUTING`으로 닫힌 라우팅 route 하나였고, 읽지 못한 텍스트는 Admin에
  카드가 아니라 unreadable로 보입니다. **정책 버전 상수는 2입니다**(2026-10-17 승인) — 새 요청 행이 그 값을 결속 값으로 남기고,
  결과는 상수가 아니라 행에 저장된 값과 대조하므로 이전 행은 자기 버전으로 결속됩니다. bridge relay는 결과 결속에 저장된 값을
  보내야 합니다. 요청 행의 CHECK는 `>= 1`이라 migration이 없습니다. 용어 목록·비밀 경로 목록·경로 문법·출력 상한은 바뀌지
  않았습니다. Admin 화면의 등급·경로 표시와 docs/policy/amux-decision-maker.md §4의 경로별 분류 기록은 없습니다.
- **S2-2b2(bridge relay)**: `apps/tomverse-orchestrator/src/dm_relay.rs`, `apps/tomverse-orchestrator/src/dm_relay/wire.rs`,
  `apps/tomverse-orchestrator/src/dm_relay/flow.rs`, `apps/tomverse-orchestrator/src/dm_relay/io.rs`,
  `apps/tomverse-orchestrator/src/tomverse_api.rs`의 Decision Maker POST 도우미, `apps/tomverse-orchestrator/src/wsl_bridge.rs`의 시작
  한 줄, `vendor/amux/crates/amux-server/src/api/dm_relay.rs`(로컬 표시 route와 그 등록), `tests/amuxDecisionMakerBridgeRelay.test.mjs`.
  relay 프로세스 하나(bridge 바이너리의 `--dm-relay` 모드, 계정 `tomverse-bridge`)가 로컬 AMUX의 `needsyou` typed ask를 **한 번에 하나씩** 앱 원장으로 옮깁니다:
  라우팅 → 배정 → 로컬 DM 대기 표시(compare-and-swap, 실패하면 배정 폐기) → payload → 전송 의도 → broker → 결과 → cleanup_unknown
  보고 → 전송 영수증 → 표시 해제. **`TOMVERSE_AMUX_DM_RELAY=enabled`가 아니면 아무것도 읽지도 쓰지도 않습니다**(앱의 라우팅
  스위치는 별개이고 둘 다 꺼져 있습니다). **relay는 자기 unit 하나에서만 돕니다** — 모든 bridge unit이 같은 `bridge.env`를 읽고 relay는 매 tick 처음에 로컬 표시를
  전부 풀므로, bridge가 아니라 바이너리의 `--dm-relay` 모드를 `scripts/systemd/tomverse-amux-dm-relay.service` 하나가 돌리고(worker
  bridge는 relay를 시작하지 않음), 스위치와 token은 그 unit만 읽는 `/etc/tomverse-bridge/dm-relay.env`에 둡니다
  (`tests/amuxDmRelayUnit.test.mjs`). token이 없거나 형식이 틀리면 exit 2로 끝나고 다시 시작하지 않습니다. **broker는 전송 의도의 기록 응답을 받은 뒤에만 부릅니다** — 그 응답을 잃으면 보내지 않습니다.
  **결과 응답을 잃으면 다시 제출하지 않고** `results/lookup`으로만 확정하며, 확정하지 못하면 `results/unknown`입니다
  (docs/policy/amux-decision-maker.md §9). 라우팅은 질문당 하나라 결과를 모르면 다음 scan에서 다시 묻는 것이 조회이고, 그 밖의 앱
  쓰기(배정·폐기·전송 의도·영수증·`results/unknown`)의 결과를 모르거나 cleanup 보고가 기록되지 않으면(그 인스턴스의 latch를 확인하지
  못함) 다시 보내지 않고 **relay만 멈춥니다** — 새 질문을
  받지 않고 표시 해제만 계속하며, 사람이 bridge를 다시 시작할 때까지입니다. worker loop는 멈추지 않습니다. 표시는 결과와 무관하게
  해제하고, 결과 마감이 broker 응답보다 먼저 오면 그때 해제한 뒤 broker 응답(정리 보고)은 계속 기다립니다. **매 tick 처음에 로컬
  AMUX의 표시 목록 전체(`GET /api/dm-relay/pending`)를 읽어 모두 풉니다** — 질문 사이에는 진행 중인 요청이 없으므로 남은 표시는 전부
  해제를 확인하지 못했거나 멈춘 프로세스가 남긴 것이고, 목록은 표의 것이라 카드의 위치·상태·revision과 무관합니다(검토
  r-20261018-022220-384dfe). **scan은 카드 id 순서로 직전 scan이 연 마지막 카드 다음부터 최대 100개를 열고**(끝에서 처음으로
  돌아감) 라우팅할 첫 질문에서 멈추므로, 처리한 질문이 `needsyou`에 남아 앞에 쌓여도 뒤의 질문이 굶지 않고, 한 scan의 일은
  질문 하나입니다. broker 응답은 이 요청·인스턴스의 것이고 결과 digest가 K_R로 다시 계산한
  값과 같을 때만 믿으며, 그 밖은 잃은 응답(전송 결과 불명, DM 불가, cleanup 불명 보고)입니다. 영수증은 프로세스가 돌고 끝났을 때만
  `receipt`이고, 시작하지 않은 경우도 앱 어휘에 없어 `unknown`(보낸 것으로 침, docs/policy/amux-decision-maker.md §10)입니다. payload는
  고정 지시문과 한 줄 JSON 카드이며, 지시문은 카드가 데이터이고 그 안의 지시를 따르지 말라고 적습니다
  (docs/policy/amux-decision-maker.md §5). 지시문의 sha256은 `DM_INSTRUCTION_SHA256`이고 Rust 테스트가 고정합니다. 로컬 AMUX의 route(`/api/dm-relay/pending`의 GET 목록·POST 설정,
  `/api/dm-relay/pending/release`)는 `/api/board` 밖에 있고 relay 토큰(헤더 `x-amux-dm-relay-token`, bridge 환경 파일의
  `TOMVERSE_AMUX_DM_RELAY_LOCAL_TOKEN`)을 요구합니다. AMUX 서버는 그 토큰의 SHA-256(`AMUX_DM_RELAY_TOKEN_SHA256`)만 갖고, 값이
  없거나 형식이 틀리면 모든 route가 닫힙니다. 어느 route에도 결과를 받는 필드가 없으므로 DM 출력이 worker에게 가는 경로는 없습니다.
  앱 규칙을 Rust로 옮긴 값(digest, 상한, 소켓 경로, broker 기한, route와 응답 envelope, 정책 버전, 선택지 효과 필드)은 node 테스트가
  앱 모듈에 대조합니다. **선택지 `effect`·`paths`(`DM_SEND_OPTION_EFFECTS`)와 결과 결속의 정책 버전(`DM_REQUEST_POLICY_VERSION`)은
  S2-2b1과 함께 바뀝니다** — 앱의 라우팅·배정 응답에 저장된 정책 버전이 없어 relay는 앱 상수와 같은 값을 갖고, 두 앱 버전이 함께
  받는 카드 형식이 없으므로 그 병합과 같은 변경에서 둘을 올리며 테스트가 이를 강제합니다. 운영자 확정 뒤 전달(S2-2b3), 스냅샷(S2b),
  Admin 화면은 없습니다.
- **S2-2b3(확정 답 전달)**: `app/api/internal/amux/decision-maker/deliveries/next/route.ts`,
  `app/api/internal/amux/decision-maker/deliveries/route.ts`, `app/api/internal/amux/decision-maker/deliveries/outcome/route.ts`,
  `lib/amux/decisionMakerDeliveryCore.ts`, `lib/amux/decisionMakerDeliveryRead.ts`, `lib/amux/decisionMakerDeliveryRoute.ts`,
  judgment store의 `readNextDecisionMakerDeliveryJudgment()`, `lib/amux/dbBoundary.ts`의 `decisionMakerDeliveryCandidateRead`(상한 7)·
  `decisionMakerDeliveryDecision`(10)·`decisionMakerDeliveryOutcome`(9), `apps/tomverse-orchestrator/src/dm_relay/delivery.rs`와
  relay의 `tick`, `vendor/amux/crates/amux-server/src/api/dm_relay.rs`의 `/api/dm-relay/answers`·`/answers/check`·`/answers/unknown`,
  `vendor/amux/crates/amux-server/src/api/board_typed_ask.rs`의 `POST /api/board/{id}/typed-ask/answer`, 대시보드 `_focusAnswer`·
  `_focusDecide`의 `_focusClaimAnswer`, `tests/amuxDecisionMakerDelivery.test.mjs`,
  `tests/server-contract/amux-decision-maker-delivery-routes.test.ts`, `tests/integration/amux-decision-maker-delivery.db.test.ts`.
  relay의 매 tick이 question scan **앞에서** 운영자가 확정한 답을 최대 하나 전달합니다: 다음 확정 답 읽기 → 로컬 확인 → 앱의 전달
  결정 → 로컬 전달(답변 기록 claim, 그 claim을 이긴 경우에만 전송과 카드 기록) → 영수증. **읽기 route는 `confirm`·`edit_confirm`
  판정이 있고 전달 결정이 없는 요청만 돌려주고**, 그 판정이 요청을 닫은 사건과 같은지 다시 확인하며(아니면 읽지 못한 상태), kill
  switch 중에는 스위치만 읽고 409 `kill_switch_on`입니다(docs/policy/amux-decision-maker.md §6 표의 "bridge의 확정 답 조회·전달").
  **relay는 앱이 전달 결정을 기록했다고 답한 뒤에만 로컬 전달 route를 부릅니다** — 결정 응답을 잃으면 보내지 않고 멈춥니다. 각 표는
  그것을 쓰는 store가 한 문장씩 읽고(`decisionMakerDeliveryRead.ts`에는 SQL이 없음), 읽기는 스위치·판정·요청·결과 상세·본문
  5문장 + setup + fence입니다. 결정은 8문장, 결과는 7문장(무결성 키 포함)이고 경계 상한은 각각 + 2이며, unit 테스트가 그 셈을, DB
  테스트가 하나 줄인 상한의 거부를 고정합니다. **worker 메시지는 앱이 만듭니다** — `[Decision Maker <인스턴스> (<모델>) 제안,
  <operator-confirmed|operator-edited>, re <카드>]` 다음 줄에 답(select는 `선택지: <id>`, free text는 DM의 답, 고쳐서 확정은 운영자의
  답), 빈 줄 뒤 "승인 계약의 승인이 아니다. 사람 승인이 필요한 게이트는 따로 요청한다."이며, 모델 이름과 문장은 unit 테스트가
  docs/policy/amux-decision-maker.md §7의 표와 본문에 대조합니다. bridge는 첫 줄이 그 인스턴스·판정·카드의 머리말인지, 로컬 AMUX는 그
  카드를 이름 대는 머리말인지 확인합니다. 카드 기록은 같은 글을 `` `answered` ``로 붙이며(session header 없는 PATCH라 알림 없음),
  답 본문이 지워진 확정은 `undeliverable`로 건너뜁니다. 로컬 route는 S2-2b2의 relay 토큰 뒤에 있고 `/api/board` 밖입니다.
  **확인(`answers/check`)은 읽기만 합니다** — 카드가 아직 그 질문 revision을 묻고 아무도 답하지 않았는지, 그리고 lane이 자동 전송을
  받는지(`deliver_automated`과 같은 관문: archived·paused·isolated·not running·permission dialog면 거부, turn 경계가 아니면 `busy`).
  아니면 relay는 결정을 쓰지 않고 cursor로 지나갑니다(앱 판정 시각·요청 id 순, 끝나면 처음부터). **질문 revision만으로는 소유자 변경을
  보지 못합니다** — 카드를 다른 worker나 attempt에 넘겨도 revision은 그대로이므로, 앱의 읽기가 docs/policy/amux-decision-maker.md §9의 결속 값
  (`worker`=묻는 worker, `session`=AMUX 세션, `session_attempt`=시도 번호, S2-2b2 relay가 라우팅 때 보낸 카드 owner session과 최신 task attempt)을
  싣고, 확인과 claim 모두 현재 카드의 owner session(`issues.session`)이 worker이자 session이고 최신 `task_attempts` 번호가 그 attempt일 때만
  통과합니다(아니면 `owner_changed`·`attempt_changed`, 검토 r-20261018-065705-65cb2a). **전달(`answers`)은 요청당 한 번만
  부릅니다** — 같은 확인 뒤 한 트랜잭션에서 결속을 다시 읽고(바뀌었으면 `binding_changed`로 아무것도 claim하지 않음)
  `dm_ask::claim_answer(DmConfirmed{request_id})`, 이 요청이 이긴 claim에서만 메시지 id
  `dm-answer:<요청 id>`를 `send_dedup`에 예약하고 lane의 boundary 전송(automation, `from_steering`, 큐 없음)을 한 뒤 검증된 전송만
  영수증으로 받습니다. 결과가 불명확하면(응답 유실, 미검증, 입력창에 남음) 다시 보내지 않고 앱에 `delivery_unknown`을 기록한 뒤
  `answers/unknown`이 **그 세션을 먼저 일시 정지(AMUX pause)하고 나서** 메시지 id의 영수증을 읽습니다(docs/policy/amux-decision-maker.md §9).
  일시 정지가 확인되지 않으면 relay가 멈춥니다. **영수증과 `unknown`은 앱이 기록했다고 답한 것만 기록입니다** — 거절(DB busy 503,
  route 꺼짐 409)이든 응답 유실이든 기록이 아니므로 relay가 멈추고 빠진 기록을 코드로 남기며(`delivery_receipt_record_refused`·
  `delivery_unknown_record_refused` 등), 세션 pause는 그대로 합니다. 결정이 있는 요청은 다시 읽히지 않으므로 계속 진행하면 결과 기록이
  영구히 빠집니다(검토 r-20261018-062643-057a27). **직접 답과 확정 답은 같은 답변 기록을 먼저 써야 보냅니다** — 대시보드의 직접 답(Answer와
  Approve/Reject)도 보내기 전에 `typed-ask/answer`로 claim합니다. 대시보드는 typed-ask GET으로 질문 revision을 읽어(Answer는 창을 열기 전에
  읽고 창에 그 질문을 보임, Approve/Reject는 누를 때) 그 revision을 body(`{"question_revision": <n> | null}`)에 싣고, 서버는 claim
  트랜잭션 안에서 그 revision이 현재 revision일 때만 claim합니다. 다르면 `question_changed`로 아무것도 claim하지 않고 보내지도 않습니다 —
  창을 연 뒤 worker가 다시 물은 새 질문을 옛 답이 차지하지 않게 하기 위해서입니다(같은 검토). **대시보드는 `claimed`일 때만 보냅니다** —
  `already_answered`는 확정 DM 답이든 운영자 자신의 앞선 답(다른 탭, 두 번 누름)이든 보내지 않고 알립니다(질문 revision 하나에 답 한 번,
  검토 r-20261018-065705-65cb2a; `tests/amuxDecisionMakerDashboardAnswer.test.mjs`가 app.js의 함수를 직접 실행해 고정). typed revision이 없는
  카드는 claim할 것이 없고 그대로 보냅니다. worker 신원 header가 있는 요청은 운영자 claim을 할 수 없습니다. **전달된 답의 카드 기록이 실패하면**
  영수증(worker에게는 도착했으므로 사실)은 기록하되 relay가 `delivery_card_record_failed`로 멈춥니다 — 결정이 있는 요청은 다시 읽히지 않아
  docs/policy/amux-decision-maker.md §7의 카드 기록이 영구히 빠지므로, 재시도 route 대신 명시적으로 멈춥니다(재시도는 bridge 재시작에도 남는 밀린 기록 저장소가 필요합니다). 이 조각이 남긴 세 빈틈 — 전달 결정 뒤
  아무것도 보내지 않은 경우의 어휘, bridge가 결정과 결과 사이에 죽어 남은 결정, 운영자의 직접 답이 먼저일 때 앱 요청을 닫는 것
  (docs/policy/amux-decision-maker.md §2-7 마지막 문장) — 은 S2-2b4가 메웁니다.
- **S2-2b4(전달 경로의 남은 빈틈)**: `prisma/migrations/20261018120000_amux_decision_maker_delivery_gaps/migration.sql`,
  `app/api/internal/amux/decision-maker/deliveries/unsettled/route.ts`,
  `app/api/internal/amux/decision-maker/requests/direct-answer/route.ts`, outcome route의 `reason`, judgment store의
  `recordDecisionMakerDeliveryOutcome()`·`readNextDecisionMakerUnsettledDelivery()`, request store의
  `closeDecisionMakerRequestOnDirectAnswer()`, `lib/amux/decisionMakerDeliveryRead.ts`의 `readDecisionMakerUnsettledDelivery()`,
  `lib/amux/dbBoundary.ts`의 `decisionMakerDeliveryUnsettledRead`(상한 4)·`decisionMakerDirectAnswerClose`(10), Admin 상세의
  `amux-dm-detail-not-sent`, `apps/tomverse-orchestrator/src/dm_relay/delivery.rs`의 `local_delivery()`·`settle_unsettled()`,
  `apps/tomverse-orchestrator/src/dm_relay/direct.rs`, `vendor/amux/crates/amux-server/src/api/dm_relay.rs`의
  `/api/dm-relay/answers/operator`·`/answers/receipt`, `vendor/amux/crates/amux-server/src/db/dm_ask.rs`의 `operator_answers_after()`.
  **전달 결과는 요청당 하나이고 셋입니다** — `delivery_receipt`·`delivery_unknown`·`delivery_not_sent`(partial unique index). 미전송은
  닫힌 사유 컬럼 `notSentReason`(`answered_by_operator`·`question_changed`·`binding_changed`·`lane_refused`·`send_refused`·`local_refused`, CHECK와
  judgment core의 사유 목록이 같은 목록이고 `check:enum-constraints`가 대조)을 갖고, 사유는 미전송 사건에만 있습니다(shape CHECK).
  감사는 router의 `amux.decision.deliver`이며 docs/policy/amux-decision-maker.md §10 목록 안입니다. relay는 로컬 전달이 **보내지
  않았음을 증명하는 답**(다른 claim이 이김, revision·결속이 바뀜, claim 전 lane 거부, claim 뒤 전송 거절, claim 트랜잭션 rollback)만
  미전송으로 기록하고, 그 밖의 불명확한 답은 그대로 `unknown`과 pause입니다. 미전송 기록이 확인되지 않으면 멈춥니다. **claim 뒤 전송
  거절(`send_refused`)만 질문을 차지한 채 남습니다**(답변 기록은 고칠 수 없음) — 대시보드의 직접 답도 거절되므로 Admin 상세는 사유마다
  다음 행동을 따로 말하고, 이 사유만 worker가 다시 물어야 한다고 안내합니다(검토 r-20261018-121437-f0d9ce). **직접 답은 앱 요청을 닫습니다** — 새 닫힘
  종류 `direct_answer_close`는 router가 `dm_proposal`로 라우팅된 열린 요청에만 쓰고, 감사는 docs/policy/amux-decision-maker.md §10 목록 안의 `amux.decision.assign_discarded`로
  남깁니다(event guard와 보존 guard가 CASE로 대응). 닫힌 요청은 판정을 받을 수 없으므로 **확정되지 않은 제안이 이 경로로 전달되는 일은
  없고**, 그 뒤 도착한 DM 결과는 거부됩니다(DB 테스트). 닫힘 목록을 쓰는 원장 event guard·본문 guard·보존 guard·키 guard·판정 guard와
  request store의 네 SQL 목록, request core의 닫힘 목록(router 셋 + 판정 셋)이 함께 여섯 종류로 바뀌었습니다 — 한쪽만 바꾸지 않습니다. relay는 매
  tick 전달 앞에서 로컬 AMUX의 `operator` 답변 기록을 (시각, 카드, revision) 순으로 읽어(한 번에 50건) 각 질문을 앱에 보고합니다.
  요청 없음·DM이 아닌 라우팅·이미 닫힘은 실패가 아니라 답이고, 앱 문법에 맞지 않는 기록은 보고하지 않고 지나갑니다. **읽기 위치는
  rowid가 아니라 마지막으로 지난 기록의 key이고 다음 읽기는 그 뒤부터입니다** — AMUX가 매일 VACUUM해 rowid가 바뀔 수 있고, 시각만으로는
  한 초에 page 하나를 넘는 기록에서 멈춥니다(검토 r-20261018-121437-f0d9ce). 대시보드는 writer를 기다리기 전에 기록 시각을 정하므로
  늦게 commit된 기록이 이미 지난 key보다 앞설 수 있어, 목록 끝에 닿으면 본 가장 새 시각에서 10분 앞으로 되돌아가 그 창을 다시 읽고
  이미 보고한 기록은 건너뜁니다. 시작 위치는 31일 전(stale close 720시간 + 하루)이고 메모리에만 있어 재시작은 같은 창을 다시 보고하며,
  닫힘이 멱등이라 아무것도 더 쓰지 않습니다.
  **bridge가 결정과 결과 사이에 죽어 남은 결정은 시작 때 다시 보내지 않고 정리합니다** — relay는 첫 전달 전에 결과 없는 가장 오래된
  결정을 하나씩 읽어(`deliveries/unsettled`, 결정 시각·카드·revision·결속·메시지 id, 본문 없음, kill switch를 읽지 않음) 로컬의 `dm-answer:<요청 id>` 예약과
  답변 기록(`answers/receipt`, 읽기만 하고 pause·전송 없음)으로 판정합니다: 수신 확인 → 영수증(그래도 docs/policy/amux-decision-maker.md §7 카드 기록을 확인할 수 없어
  `delivery_recovered_card_record_unconfirmed`로 멈춤), 예약만 있음 → `unknown`(세션 pause 먼저), 예약 없음 + 운영자 기록 → 미전송
  `answered_by_operator`, 예약 없음 + 기록 없음 + revision이 지나감 → 미전송 `question_changed`, 그 밖은 `unknown`입니다. 읽지 못하면
  아무것도 쓰지 않고 다음 tick에 다시 묻고, 정리가 끝나기 전에는 전달하지 않습니다. 문장 수: unsettled 읽기 2(+ setup·fence = 4),
  직접 답 닫기 최대 8(스위치를 읽지 않음, 상한 10), 미전송 결과는 기존 outcome 경계(9) 안입니다. flow.rs의 거절을
  성공으로 읽던 세 곳(배정 폐기, 전송 결과, 결과 unknown)은 각자 기록됐다는 답만 성공으로 받고 나머지는 멈춥니다. **남은 것**: `send_refused`의
  claim은 남으므로 그 질문 revision에는 worker가 다시 물을 때까지 아무도 답할 수 없습니다. 결정 전에 운영자가 이미 답한 확정은 확인
  단계가 결정 없이 지나가며 계속 순회합니다. 직접 답으로 세는 것은 대시보드 claim(`source='operator'`)뿐입니다. writer 대기에는 상한이
  없으므로 되감는 창(10분)보다 늦게 commit된 운영자 기록은 보고되지 않을 수 있습니다 — 그 요청은 판정되거나 stale로 닫힐 때까지 열려
  있고, 답변 기록이 질문을 차지하고 있어 확정 제안이 전달되지는 않습니다.

# AMUX 카드 표시 번호

`AmuxWorkItem.displayKey`, Feature의 `displayPrefix`, `AmuxCardDisplayKeyCounter`, 그리고 카드를
만드는 경로의 번호 할당을 건드리기 전에 읽습니다.

- `docs/policy/amux-card-display-key.md`

- **번호는 표시용 이름이고 Task ID를 대체하지 않습니다.** API·링크·로그·복구 기록·승인 결속은
  계속 Task ID를 씁니다.
- **한 번 쓴 번호와 Feature PREFIX는 바뀌지 않습니다.** DB trigger가 변경과 비우기를 거부하고,
  카드에 쓰인 번호는 `AmuxCardDisplayKeyIssued`에 남아 카드가 삭제돼도 다시 쓰이지 않습니다.
  카운터는 1씩만 증가하며 지워지지 않습니다.
- **할당은 `allocateAmuxCardDisplayKey(tx, prefix)` 하나이고 카드를 쓰는 트랜잭션 안에서 합니다.**
  카운터에 직접 쓰지 않습니다(`npm run check:protected-table-writers`).
- **Feature 없는 카드의 PREFIX는 등록 경로별 고정 목록입니다**
  (`lib/amux/cardDisplayKeyCore.ts`의 예약 목록). 새 등록 경로는 `docs/policy/amux-card-display-key.md §4`를 먼저 개정합니다.
- **S2(schema와 할당기)**: `lib/amux/cardDisplayKeyCore.ts`, `lib/amux/cardDisplayKeyAllocator.ts`,
  `prisma/migrations/20261014100000_amux_card_display_key/migration.sql`,
  `tests/amuxCardDisplayKeyCore.test.mjs`, `tests/integration/amux-card-display-key.db.test.ts`.
- **S3a(고정 PREFIX 경로)**: 대화 intake(INTAKE), 로컬 intake(LOCAL), engineering agent(ENG),
  workboard import(WORKBOARD), AMUX snapshot 동기화(SYNC)가 새 카드에 번호를 줍니다.
  `tests/amuxCardDisplayKeyWriters.test.mjs`가 카드를 만드는 모든 파일을 찾아, 번호를 주지 않는
  새 경로를 실패로 만듭니다.
- **S3b(v4 Feature PREFIX)**: `docs/policy/amux-intake.md` v17 절. 분석 chunk schema 4에서 Feature 제안이
  `displayPrefix`를 가질 수 있고, `create_node`가 같은 트랜잭션에서 Feature에 쓰며(이미 쓰인 값이면
  `chooseAmuxFeatureDisplayPrefix()`가 고르는 번호 붙은 값), v4 카드는 그 Feature의 PREFIX로 번호를 받습니다.
  PREFIX 없는 Feature 아래 카드는 번호 없이 등록되고 S4 backfill이 채웁니다.
- **S4(backfill)**: `/admin/amux-execution?tab=cards`의 owner 전용 패널과
  `app/api/admin/amux/card-display-key-backfill/route.ts`. 계획은 `lib/amux/cardDisplayKeyBackfillCore.ts`
  (순수)가 정하고, 적용은 같은 트랜잭션에서 계획을 다시 계산해 운영자가 본 digest와 같을 때만 쓰며 사람
  감사를 남깁니다. raw UPDATE로 `updatedAt`과 다른 컬럼을 건드리지 않습니다.

# AI Review (교차검토) 품질과 M5

AI Review의 프롬프트·reviewer 패널·인용 검증·평가·운영 계측·항목 피드백,
그리고 **AI Review를 설명하는 제품 문구**를 건드리기 전에 읽습니다.

- `docs/policy/ai-review-m5-quality-contract.md`
- `docs/ui-contracts/ai-review-evidence-chain.md`

절대 조건:

- **상태는 셋이고 서로를 함의하지 않습니다** — `instrument scaffolding
  complete`(도구가 있고 연결됐다), `M5 readiness complete`(그 도구가 믿을 수
  있는 숫자를 낼 수 있다: 동결된 충분한 decision dataset, 서명된 threshold,
  다섯 zero-tolerance 규칙의 판정 경로, attempt 단위 계측, 계산 가능한 정산
  대조, 순서 있는 전환), `M5 eligible`(production에 겨눴고 사람이 서명했다).
  `judgeM5()`가 세 목록을 각각 받고 각각 전부 충족을 요구합니다.
  **readiness 항목은 파일 존재로 충족되지 않습니다** — 평가기는 정답이 정해진
  fixture로 실제 실행해 검사합니다. 실제 운영 데이터 없이 M5라고 선언하지
  않습니다.
- **precision은 gold가 exhaustive인 case에서만 계산합니다 — 분모뿐 아니라
  분자도.** 분자를 빠뜨리면 심어 둔 것 하나를 맞히고 판정 불가능한 99개를
  덧붙인 검토자가 precision 100%로 보고됩니다. recall은 모든 case를 셉니다.
- **zero-tolerance 다섯 규칙 모두 판정 경로가 있어야 합니다.** 셋은 용어
  목록으로 선별하고 둘은 사람만 판정하며, **블라인드 시트는 다섯 전부를
  묻습니다** — 목록은 자기가 담은 표현만 찾으므로 recall은 사람의 몫입니다.
  선별은 검토자 자신의 문장(`reviewerProse`, 인용 제외)만 읽고, case 자신이
  말하는 용어는 금지 목록에서 뺍니다.
- **품질 임계값은 버전을 가지고 승인 gate에 연결됩니다.**
  `approvedEntryProblems()`가 승인 항목의 수치를 그 항목이 이름 댄 threshold
  집합과 대조하고, arm별 격차와 붕괴 arm까지 봅니다. 미승인 집합에 기댄 승인은
  거부됩니다.
- **reviewer health는 `ComparisonReviewRunAttempt`에서 계산합니다.** run 행의
  slot은 결과를 만든 reviewer이고 attempt는 실제로 일어난 일입니다. 둘을
  합치면 fallback이 앞선 실패를 지웁니다.
- **전환은 시간 순서를 지키고, 재방문은 두 종류가 다른 이름을 갖습니다.**
  `accountAgeReturnDay*`는 계정 나이 기준이라 AI Review retention이
  아니며, `reviewAnchoredReturnDay*`가 그 질문의 답입니다.
- **source grounding은 사실 정확도가 아닙니다.** `exactQuoteMatchRate`는
  reviewer의 인용문이 그 인용문이 귀속된 답변에 실제로 있는지만 말합니다.
  `lib/sourceGrounding.ts`가 저장된 `confidence`를 이 이름으로 번역하는 유일한
  경계이고, 그 위로는 "출처 일치도"만 씁니다.
- **두 reviewer가 있다는 사실과 두 reviewer가 합의했다는 사실은 다릅니다.**
  `computeReviewAgreement()`가 재는 것은 출처 일치도 등급이 같은가와 정확히 같은
  문구를 몇 개 인용했는가뿐입니다. 이를 "결론에 동의했다"로 표시하면 계약
  위반입니다.
- **"서로 다른 provider"라고 말하지 않습니다.** 두 번째 reviewer는 모델 id가
  다른 다음 후보로 고르므로 같은 provider의 두 모델이 뽑히는 구성이 가능합니다.
  실제로 그랬는지는 `ComparisonReviewRun.crossProvider`가 매 실행 기록합니다.
- **client analytics를 서버 신뢰성 지표로 쓰지 않습니다.** reliability는
  `ComparisonReviewRun`(서버가 모델을 부르는 경로에서 씀), adoption은
  `ProductAnalyticsEvent`(동의 필요)이고 둘을 한 점수로 접지 않습니다. 두
  계측기의 차이는 `telemetryCoverage()`가 비교로만 보고합니다.
- **`ComparisonReviewRun`에 사용자 콘텐츠를 넣지 않습니다.** 질문·답변·검토
  문장·인용문·파일명이 들어갈 수 있는 컬럼이 없어야 하며,
  `contentFreeViolations()`와 두 테스트가 이를 강제합니다.
- **표본이 부족하면 `insufficient_evidence`입니다.** 0점도 M5도 아닙니다. 모든
  scorecard 지표가 자기 분모와 제외 조건을 갖고 다닙니다.
- **유료 평가는 fail-closed입니다.** `--live` 없이는 아무것도 호출하지 않고,
  `--live`가 있어도 사람이 승인한 `evalBudget`·동결된 decision set·깨끗한 named
  commit·미사용 run ordinal이 모두 필요합니다. `evalBudget`과 register의
  `approved` 전환은 **사람이 씁니다.**
- **평가 dataset을 만든 에이전트가 사람 승인까지 대신하지 않습니다.**
  `fabricated_safety_claim`과 `false_consensus_safety`는 사람만 판정하며,
  harness는 그 둘에 대해 0을 지어내지 않고 블라인드 검토 기록이 없는 artifact를
  증거에서 제외합니다.
- **캐시된 `ComparisonReview`를 읽을 수 없게 만들지 않습니다.** 저장된 result는
  읽을 때 스키마로 검증되므로, claim에 필드를 추가하면 사용자가 이미 크레딧을
  치른 결과가 사라지고 다시 과금됩니다. 항목 id를 저장하지 않고 파생하는 이유가
  이것입니다.
- scorecard와 보고서는 **자기가 평가하는 register·flag·release gate를 수정하지
  않습니다.**

## Mobile chat composer invariant

Before changing `ChatInput.tsx`, `MobileChatShell.tsx`, composer styles, tool chips, or mobile bottom-dock layout, read:

- `docs/ui-contracts/mobile-chat-composer.md`

Non-negotiable requirements:

- The mobile textarea must always own a dedicated full-width row with at least one complete visible input line.
- Tool, web-search, deep-research, attachment, billing, and model-status controls must never consume the textarea's horizontal row, overlap it, or float above it.
- Increasing ChatMessageList height must never reduce the textarea to residual horizontal space.
- Do not use absolute positioning, negative margins, transforms, or shared grid cells to place controls beside or over the textarea.
- Any mobile composer layout change must include bounding-box, overlap, horizontal-overflow, Korean IME, 320px-width, and 200% text-scaling regression coverage.
- A change that violates this contract is a release blocker.
<!-- END:mobile-chat-composer-invariant -->

<!-- BEGIN:mobile-sidebar-drawer-invariant -->
## Mobile sidebar drawer invariant

Before changing the drawer in `MobileChatShell.tsx`, `ChatSidebar.tsx`'s
`isMobileDrawer` layout, `useVisualViewport.ts`, or the account footer inside the
drawer, read:

- `docs/ui-contracts/mobile-sidebar-drawer.md`

Non-negotiable requirements:

- Every drawer control must be visible or reachable by one vertical scroll on any
  supported viewport, including one shortened by browser chrome, rotation or the
  on-screen keyboard.
- Reachable is measured from the control's centre point with
  `elementFromPoint`, not with `toBeAttached()` or a programmatic `.click()`.
- Exactly one scroll owner at a time: when the drawer scrolls, the conversation
  list must not also be a scroller, and the owner must contain every control.
- The short/tall switch reads the visible viewport (`useShortViewport()`), never
  `window.innerHeight`, a CSS `max-height` query, a device name or a UA string.
- No control may be hidden, demoted behind a "more" affordance, or have its touch
  target, text size, accessible name or focus ring reduced to make room.
- Safe-area insets, modal semantics, focus trapping and focus return are
  preserved, and the page behind the drawer never scrolls in its place.
- Any related change must keep `tests/e2e/mobile-short-viewport-drawer.spec.ts`
  passing across its full viewport/state matrix.
- A change that violates this contract is a release blocker.
<!-- END:mobile-sidebar-drawer-invariant -->

<!-- BEGIN:comparison-action-rail-invariant -->
## Comparison action rail invariant

Before changing `ComparisonActionRail.tsx`, `lib/comparisonReadiness.ts`, the bottom workflow dock in either shell, or the rail's copy, read:

- `docs/ui-contracts/comparison-action-rail.md`

Non-negotiable requirements:

- Desktop and mobile must use the same state-driven disclosure policy: decide with `shouldShowVisualStatus()` in `lib/comparisonReadiness.ts`, never with `layout === "mobile"`, a media query, or any other shell-shaped condition.
- In the normal, all-complete, runnable state the status sentence ("Comparing N completed answers") is visually hidden in both shells, and leaves no row height or bottom gap behind.
- Visually hidden means `sr-only`: the sentence stays in the DOM and in the accessibility tree, and each action keeps the comparison target count in its own `aria-describedby`.
- Generating, too-few-answers, excluded, analysis-running and per-action credit-shortfall states must be visible on screen, with each action describing only its own price and its own reason.
- Any related change must include the desktop *and* mobile state matrix tests (`tests/comparisonReadiness.test.mjs`, `tests/e2e/comparison-action-rail.spec.ts`).
- A change that violates this contract is a release blocker.
<!-- END:comparison-action-rail-invariant -->

<!-- BEGIN:typography-invariant -->
## Typography and font system invariant

Before changing `lib/fonts.ts`, the font tokens or `@utility type-*` roles in `app/globals.css`, `components/DocumentShell.tsx`'s font wiring, or `lib/emailTypography.ts`, read:

- `docs/ui-contracts/typography.md`

Non-negotiable requirements:

- Every `font-family` resolves through `--font-ui` or `--font-code`. Never hard-code a family, and never register a font variable that the rendered UI does not actually use.
- Locale families are selected by `:lang()` over the whole subtree, never by per-glyph fallback: `Geist` by default, `Noto Sans KR` for `:lang(ko)`, `Noto Sans SC` for `:lang(zh)`.
- Only the Latin UI face is preloaded. `Geist_Mono`, `Noto_Sans_KR` and `Noto_Sans_SC` stay `preload: false`; verify with `node scripts/report-font-preload.mjs` after a build.
- Webfonts are self-hosted through `next/font`. The browser must never request Google's servers.
- Customer text is never below 11px; body copy and primary controls start at 14px; mobile text inputs stay at 16px.
- `font-black` (900) is limited to headline-sized text (≥18px) and short brand expressions; small buttons, chips, badges and labels use 500–700.
- Monospace is only for code, model IDs, build metadata, verification codes and preserved-formatting input.
- Emails use the single web-safe stack in `lib/emailTypography.ts` and never load a webfont.
- Any related change must keep `tests/typographyPolicy.test.mjs` and `tests/e2e/font-system.spec.ts` passing, and must re-run the mobile composer contract specs.
- A change that violates this contract is a release blocker.
<!-- END:typography-invariant -->
<!-- BEGIN:image-generation-workspace-invariant -->
## Image generation workspace invariant

Before changing `components/images/ImageGenerationWorkspace.tsx`, `components/chat/NewConversationLauncher.tsx`, `components/chat/ImageModelTabPanel.tsx`, the `Chat | Image` tabs in `ModelPickerPanel.tsx`, or the image entry points in `ChatInput.tsx`/`ChatSidebar.tsx`/`ChatPageClient.tsx`, read:

- `docs/ui-contracts/image-generation-workspace.md`

Non-negotiable requirements:

- There are exactly four entry points (sidebar split button, mobile drawer rows, composer tools menu, catalogue image tab) and no standalone "new image" button. Switching to the image draft creates no server row.
- Guest and Free see every entry point locked, with the requirement stated up front and the click routed to sign-in or `/pricing` — never hidden, never blocked only at the last step. With the flag off nothing renders at all.
- Image generation models are their own catalogue tab. They are never mixed into the chat model list, and the chat list's `modelSupportsImageInput` filter (image *input*) is never reused to mean generation.
- The comparison limit reaches the composer as a **prop resolved on the server** (`imageGroupMaxModels()`, `lib/imageGroupLimits.ts` — the same function admission calls). The client never reads `process.env`, never hard-codes the number, and never derives it from `IMAGE_INLINE_MODEL_DISCOVERY_LIMIT`, which is a separate decision about one row of UI. Exceeding the limit refuses the change without altering the selection, states the reason, and still allows deselecting an already selected model; `IMAGE_MODEL_SELECTION_INVALID` gets its own message rather than a generic retry.
- Every registered image model is listed, including one held by the price-verification rule; a held row is stated as a hold and is not selectable. The tab quotes "from N credits"; only the composer quotes an exact price.
- The workspace follows the mobile composer contract's shape: the textarea owns a dedicated full-width row and no control shares, overlaps or floats above it.
- An image conversation never mounts `ChatInput`, `ChatApp` or the comparison action rail, never enables AI Review, and never imports `ComparisonActionRail`/`shouldShowVisualStatus()` — only their principles.
- Group state is derived from the latest attempt per target, never stored: one card per target, a retry replaces its card in place, and a succeeded target offers no re-run.
- Prices are quoted before submission, per model and in total; a model with no resolvable price cannot be submitted.
- Generated images always carry the AI-generated label; signed asset URLs are never persisted and R2 keys never reach the client.
- Visual role is `accent-image-*` only; the AI Review gradient is reserved.
- Any related change must keep `tests/e2e/image-generation-workspace.spec.ts` passing on desktop **and** mobile, and must re-run the mobile composer, sidebar drawer and model picker specs.
- A change that violates this contract is a release blocker.
<!-- END:image-generation-workspace-invariant -->
<!-- BEGIN:settings-navigation-invariant -->
## Settings navigation invariant

Before changing the Data tab's entries in `AuthButton.tsx`, `lib/settingsNavigation.ts`, `lib/accountSettingsEvents.ts`, `components/settings/**`, or the top of `/settings/imports` and `/settings/memory`, read:

- `docs/ui-contracts/settings-navigation.md`

Non-negotiable requirements:

- Two movements, two controls, both rendered. A detail page navigates *up* to settings by name (`settingsSectionHref()`), never with `router.back()`; leaving settings *entirely* is a separate one-click exit to `/chat` (`settingsExitHref()`, no query string) rendered once by the `/settings` route shell for every screen under it. Neither control is merged into the other, and no detail component renders its own copy of the exit.
- "Back to settings" and the exit must both work from a directly-opened detail-page URL, on every shell and in every sidebar state, and must not disturb the browser's own Back button (the deep link is dropped with `replaceState`, never a pushed entry). The exit is not an `X`: it names the chat and carries a `MessageSquare`-family icon, with the full phrase as its accessible name at every width.
- External import and account memory stay separate features with separate detail pages and separate state, presented as separate rows under one group (`settingsNav.dataAndPersonalization`) — not merged, and not two stacked full-width cards.
- Every entry's action label names its own purpose; a generic label repeated across entries ("Open settings") is a violation. A "back" label must name where the link actually goes, in every locale.
- Desktop and mobile use the same hierarchy, order and wording; only the desktop breadcrumb trail is extra. Nothing here may be decided by `layout === "mobile"`, a UA string or a device name.
- A row is one link with an explicit accessible name (title + action), its description and status in `aria-describedby`, a visible focus ring, and keyboard activation. Returning from a detail page restores that row's scroll position and focus.
- Any related change must keep `tests/settingsNavigation.test.mjs` and `tests/e2e/settings-information-architecture.spec.ts` passing on the desktop *and* mobile projects.
- A change that violates this contract is a release blocker.
<!-- END:settings-navigation-invariant -->
<!-- BEGIN:admin-console-ia-invariant -->
## Admin Console information architecture invariant

Before changing `lib/adminNavigation.ts`, `components/admin/adminNavigationIcons.ts`, `lib/adminNavigationBadges.ts`, `components/admin/AdminConsoleShell.tsx`, `AdminSidebar.tsx`, `AdminCommandPalette.tsx`, `AdminPageTabs.tsx`, **any panel under `components/admin/`**, or any route under `app/(site)/(application)/admin/**`, read:

- `docs/ui-contracts/admin-console-ia.md`

Non-negotiable requirements:

- **Every retired `/admin/*` URL keeps a redirect.** Bookmarks, runbooks and `href`s already written into audit summaries point at them, so deleting a route without leaving one behind is a release blocker. A redirect carries the request's own query to the destination but never its own stale `tab`.
- A section lives in `?tab=`, not in component state. Tabs are `<Link>`s, the page's server component reads `searchParams`, and only the open section's data is loaded.
- Adding an entry means adding it in three places at once: the route table in `lib/adminNavigation.ts`, an icon in `adminNavigationIcons.ts`, and a real route segment. There is no catch-all `[section]` route — an unknown admin URL must answer 404, not 200.
- A badge is for work, not decoration: only entries an operator acts on carry one, and an unknown count renders nothing rather than zero.
- The layout loads counts; a page loads its own data. Nothing that only one workspace displays may move into `admin/layout.tsx`. A panel showing the newest N rows states N on screen and does not present its own counters as totals.
- **A step-up refusal offers the way back.** A control refused because the
  administrator's sign-in is no longer recent renders
  `adminRecentAuthenticationHref(<this screen's path>)` — the step-up URL that
  carries a callback and keeps the console session. **A toast alone is a
  defect**: it names the remedy and gives no way to reach it, so the screen
  reads as broken rather than gated. This has been got wrong three times;
  `tests/adminReauthenticationCta.test.mjs` fails any panel that can be refused
  and cannot render the link.
- Authorization is out of this contract's scope and was not changed by it: `writeRoles` in the route table drives the sidebar's "Read" marker only, and access is still decided server-side by `lib/adminAuth.ts` and each `/api/admin/**` handler.
- Any related change must keep `tests/adminNavigation.test.mjs` and the `tests/e2e-admin/**` suite (`npm run test:e2e:admin`, the "Admin Console E2E (PostgreSQL)" workflow) passing.
- A change that violates the redirect rule is a release blocker; the rest is ordinary review.
<!-- END:admin-console-ia-invariant -->
<!-- BEGIN:auto-model-selection-invariant -->
## Auto model selection invariant

Before changing `components/chat/AutoRoutingToggle.tsx`, `components/chat/AutoRoutedByBadge.tsx`, `lib/autoRoutingUi.ts`, `lib/autoProductBoundary.ts`, `lib/autoRoutingCopy.ts`, or the `selectionMode` handling in `app/api/conversations/[conversationId]/route.ts`, read:

- `docs/ui-contracts/auto-model-selection.md`
- `docs/ui-contracts/chat-product-switcher.md` for Chat/Review entry routes,
  product navigation, draft isolation and Smart Adaptive presentation.

Non-negotiable requirements:

- **`offered` is the only input.** It already folds the feature flag, the conversation's product and cohort eligibility together, so no surface may derive availability from the flag alone.
- The owner-approved initial release in
  `docs/policy/chat-refiner-initial-auto-release-v1.md` may supply a separate,
  server-verified exact-deployment authority under its v1 contract while the
  three measurement attestations remain pending. The versioned v2 contract in
  `docs/policy/chat-refiner-stable-release-authority-v2.md` uses a new Owner
  audit target bound to the execution-source fingerprint and effective
  controls; the original commit and deployment remain audit provenance.
  The operator's 2026-10-13 decision in
  `docs/policy/chat-operator-controlled-availability-v3.md` supersedes v2's
  source-change reactivation rule and automatic global operational pauses.
  The latest Owner activation persists across source/deployment changes;
  operational observations never change the enabled state. Current execution
  controls, price/audit proof, per-request refusal/fallback and unknown cost
  holds remain enforced.
  Availability, mode storage and turn routing
  must share that authority. It never marks a gate passed, extends a staging
  drill into production or relaxes manifest enforcement, plan, product,
  cohort, rollout or kill controls.
- **The product is decided before the cohort, in `lib/autoProductBoundary.ts`, and all three consumers share it** — surface entry, `offered`, and turn routing. `product_not_chat` is an `AutoSelectionRefusal`/`AutoUiRefusal` and never an `AutoCohortRefusal`: a Review conversation was not a subject of the cohort question, and counting it as a refusal dilutes the rollout percentage with Review traffic. The refusal carries no cohort. A row whose `productKey` is still NULL resolves through `PRODUCT_KEY_READ_MODE` and is refused; a turn with no conversation is `no_conversation` instead. There is no disabled state and no greyed row: a control that flips, saves and changes nothing cannot be told apart from Auto agreeing with the user every time.
- No user-facing string may name a bucket, a percentage, a cohort salt or a readiness gate. A client that could read its own bucket could work out the rollout percentage.
- No locale may promise a better, best, optimal or smartest model. `ROUTE-01` measures non-inferiority, which is a far weaker claim than that copy would be making, and `tests/autoRoutingUi.test.mjs` fails the build on the words.
- The badge renders only on a turn Auto actually routed. A turn that fell back to the user's own model gets none, or it claims a routing decision that did not happen.
- Returning a conversation to `manual` is accepted unconditionally, including when Auto is no longer offered — it is how a conversation leaves a mode the account can no longer act on, and how Auto's sticky state is cleared.
- Auto never appears as a row in the model catalogue: it has no context window, price or provider, and the credit estimate would have nothing to show for it.
- A change that violates this contract is a release blocker.
<!-- END:auto-model-selection-invariant -->

<!-- BEGIN:prompt-refiner-suggestion-invariant -->
## Prompt Refiner suggestion invariant

Before changing the Prompt Refiner surface or request boundary in
`ChatInput.tsx`, `PromptRefinerSuggestionPanel.tsx`,
`lib/promptRefinerSuggestion.ts`, `lib/promptRefinerModelPrompt.ts`,
`lib/promptRefinerReceiptCore.ts`, `lib/promptRefinerExecutionContract.ts`, or
`lib/promptRefinerShadowHarness.ts`, `lib/promptRefinerShadowJournal.ts`,
`lib/promptRefinerShadowSource.ts`,
`lib/promptRefinerShadowAdmissionCore.ts`,
`scripts/prompt-refiner-shadow-harness.mjs`, the frozen shadow corpus,
`docs/ops/prompt-refiner-shadow/evidence/admission-readiness-v1.*`,
`tests/promptRefinerShadowAdmissionCore.test.mjs`, or their tests, read:

- `docs/ui-contracts/prompt-refiner-suggestion.md`
- `docs/ui-contracts/chat-e04-staging-fixture.md`
- `docs/policy/prompt-refiner-observability.md`
- `docs/ops/prompt-refiner-shadow-harness.md`

Non-negotiable requirements:

- Manual mode shows a suggestion before send and requires an explicit
  use-or-keep decision. The approved Auto exception may create only a
  server-owned accepted decision during an ordinary human Send, and only for
  a stored Chat conversation already in Auto mode with a currently valid
  v1 exact-deployment or v2 stable-source Auto release. Neither mode sends a
  turn by itself.
- The durable user Message keeps the user's original bytes. Only an accepted
  suggestion may become the Router/provider execution prompt.
- One request is bound to one exact draft snapshot and request id. Editing the
  draft makes a late response stale; it never overwrites newer user work.
- The caller leaves `ready` after either decision. After acceptance, any draft
  edit that no longer matches the resolution's displayPrompt discards that
  resolution and restores ordinary user authorship.
- The Refiner receives only the current user-turn text as untrusted quoted
  data. It receives no history, attachment content, Memory, profile knowledge,
  tool result, Router candidates, provider identity or model identity.
- Refiner provider/model attribution belongs to an internal receipt and never
  replaces the answering-model badge.
- Server execution and user disposition are separate immutable receipts. No
  receipt may carry prompt/proposal bytes or digests, user/conversation/session
  identity, attachment/Memory/profile/Router data, or provider error prose.
  Unknown token/cost telemetry is null, not zero. Duplicate, orphan, binding
  mismatch and time reversal fail closed.
- Reliability, stale and choice metrics keep different denominators: provider
  failure is over dispatched execution; stale is over all requests; explicit
  choice is over successful suggestions; acceptance is over explicit choices.
  Empty populations are null and no descriptive aggregate approves quality,
  a release gate or rollout.
- No provider call, billing, automatic offer, Router coupling or rollout is
  implied by the composer seam. Each requires its own approved server-owned
  gate and evidence.
- The execution preregistration is pure and fail-closed. Exact contract,
  refiner, model/catalog/pricing identity, output cap, timeout, retry zero and
  request/stage cost ceilings are frozen. The gate also resolves the effective
  input/output rates through `resolveModelPricing()` so a per-model environment
  or runtime registry override cannot bypass the 0.2/1.2 pin. Its effective
  output cap must be at least 4,096; a larger capability is allowed but never
  replaces the Refiner request's exact 4,096 cap. Caching is disabled, and the
  generic model reservation-output setting must not reduce this contract's
  4,096-token worst-case reservation. The standalone server-only authority
  passes its runtime model row through this gate inside both reserve and
  consume. Its global order is fixed stage row, model-registry table SHARE,
  then reservation row, covering both an existing registry row and an
  absent-row insert. The reservation BEFORE INSERT trigger validates and locks;
  only the AFTER INSERT trigger may bind counters to the exact aggregate of
  already-visible tombstones. A stage must start at zero, and a direct stage
  counter update therefore cannot mint a slot. Direct inserts, unique conflicts
  and the 101st row cannot bypass or split accounting. The database also owns
  terminal timestamps and turns a late consume/release into expiry. It binds
  requestId + stage + canonical
  contract digest + server-minted reservation id. Naive DB timestamp columns
  compare and store only `clock_timestamp() AT TIME ZONE 'UTC'`; expiry sweeps
  filter and order in SQL and apply their caller limit before `FOR UPDATE`, so
  the limit bounds both mutation count and lock footprint. One-time consume and
  permanent terminal tombstones remain DB-enforced.
  A repeated request returns the existing active fact before stage/runtime
  revalidation; a terminal fact is a discriminated non-success and is never a
  reusable lease. A future dispatch must use the exact digest returned by
  consume together with the checked-in execution/reservation contract constants,
  and must not reload/reinterpret the registry after that boundary. It has no stage
  seed/admin writer or product authority. Existing frozen v1 admission
  therefore still refuses before dispatch with
  `reservation_authority_unavailable`; a caller-made lease or atomic boolean is
  never proof. Only a separately approved new contract may connect an
  authority consumed fact to `admitted: true`. The product v1 authority is a
  separate contract and must not consume these one-shot slots or tombstones.
- The current server gate folds the default-off AppSetting, environment kill
  switch, adapter readiness and a valid versioned release readback into one
  answer. V1 remains exact-deployment-bound; v2 requires a checked serving
  runtime, stable execution-source and effective-control digest, and its own
  Owner audit. A stored flag or deployed adapter alone must never expose product
  controls. Legacy activation still requires signed B03G latency-only evidence
  and its limited audit. The separate initial release in
  `docs/policy/chat-refiner-initial-auto-release-v1.md` preserves those failed
  or pending records and requires its own canonical owner activation pair.
  Missing/invalid runtime identity, DB uncertainty, absent applicable
  authority, product audit failure, candidate/price/config drift or kill switch
  keeps explicit and Auto closed. The loopback E2E fixture carries no product
  authority. A separate owner rollout action may write only
  `feature.promptRefinerEnabled` with recent authentication, same-origin
  validation and a canonical audit in the same transaction. Enabling requires
  valid activation; disabling must remain available. Neither action changes
  kill controls or resumes the durable Auto stop latch.
- Product proposal/prepare accepts only owner-bound conversation, scope epoch
  and draft revision identifiers. The server captures exact draft bytes and
  claims one durable `(owner, scope, epoch, draft, revision, mode)` attempt
  before budget/provider work. Browser proposal text, mode and booleans grant
  no authority. Concurrent duplicate, reconnect, terminal and billing-unknown
  states cannot dispatch again. The Refiner product deadline is at most 13,000
  ms from the authenticated route handler through admission and held publish;
  retry count is zero and a late provider result cannot become a suggestion.
- Product Auto has a durable operational stop latch. Across the latest 100
  completed product Refiner requests, p90 preparation latency above 6,000 ms
  or more than five original fallbacks pauses Auto; critical safety,
  dispatch/cost unknown and audit failure pause it immediately. Later success,
  a rolling-window change or a new deployment never resumes it. Resume requires
  an owner review bound by CAS to the exact paused generation, cause and audit
  record. Once a pause commits, a new Auto consume is refused; manual explicit
  acceptance remains a separate mode and does not inherit Auto authority.
- A Refiner request, ready proposal and accepted resolution are bound to both
  the exact draft bytes and the `identity + mounted surface + conversation`
  scope. Changing any scope member discards them even when the next draft has
  identical text; text equality never transfers Refiner state across scopes.
- Every Refiner action keeps a 44px touch target and states why it is disabled.
- The requesting, failed, and ready state regions are polite live statuses. A
  genuinely new state identity receives focus without scrolling. An initially
  mounted bound state or the same identity reappearing after a draft edit does
  not steal focus; a completed decision returns focus to the textarea.
- `promptRefinerModelMessages()` is the explicit `prompt-refiner` surface in
  the PLANNER-03 report. Every adversarial corpus item must retain the exact
  two-message boundary: system rules first, then only the canonical
  `inputScope + sourceText` JSON user message. A model-facing caller or
  provider adapter must use this builder and keep that report green. The
  loopback fixture caller still reaches only its no-cost E2E route and is not
  a model-facing path.
- The provider-free shadow harness accepts only the fixed, reviewed synthetic
  corpus and exact bytes from a full commit SHA allowlist. It has no live,
  plugin, adapter, credential, authority, product or provider mode. Model-shaped
  fixture output goes through `parseBenchmarkJson()`, an exact
  `refinedPrompt` object and the existing prompt bounds; repair and partial
  salvage are forbidden. Its content-free journal uses durable intent before
  evaluation, a hash chain plus a separate witness, an unrecoverable `wx`
  lock, strict terminals and no retry of an unknown intent. Journal and witness
  headers bind the exact full source ref and canonical allowlist identity
  digest; a different source snapshot can never resume the run. Git child reads
  must disable lazy fetch and replacement objects, and fail closed unless every
  pinned object is local;
  `package-lock.json` has a dedicated 4 MiB source cap, other non-corpus source
  files have a 1 MiB cap, and Git capture remains bounded above both. Tests read
  the current lockfile size dynamically and require it to be non-empty and at
  most the declared cap; no incidental byte count is pinned. The source
  identity binds pinned repository bytes, not installed `node_modules`, package
  manager caches, install environments, or an installation attestation; a local
  completion is not dependency-installation provenance.
  `max-cases` accepts only unsigned ASCII decimal notation. A clean interruption
  after the final terminal finalizes completion without a zero-remaining resume,
  while a final-case mismatch remains a replayable non-resumable stop. Structural message
  boundary evidence and behavioral fixture outcome remain separate metrics;
  zero structural violations must never be described as model compliance or
  injection resistance. A completed local run is not model-quality, release,
  admission or rollout evidence.
- The admission-readiness core is proposal-only and verifies only the immutable
  historical evidence snapshot named by its checked-in manifest. It does not
  validate the current checkout or runtime environment and must always emit
  `currentCheckoutValidated: false`,
  `runtimeSourceRevalidationRequired: true`, `executionAdmitted: false`, and
  `awaiting_explicit_admin_cost_approval`. It has no approvedBy/approvedAt
  input, writer, DB/Prisma mutation, admin/API/script caller, receipt, feature
  flag, product import, provider, network or credential path. No caller may use
  this proposal as writer authorization. A future durable writer must re-run
  exact current source, manifest and environment validation immediately before
  binding human cost approval; that requirement cannot be satisfied by a
  caller-supplied identity boolean.

Any related change must keep `tests/promptRefinerSuggestion.test.mjs`,
`tests/client/promptRefinerSuggestionRender.test.tsx` and the mobile composer
contract tests passing. `tests/e2e/prompt-refiner-chat-input.spec.ts` is the
actual ChatInput fixture gate for focus, IME, narrow width and text scaling.
<!-- END:prompt-refiner-suggestion-invariant -->
<!-- BEGIN:chat-starter-catalog-invariant -->
## Chat starter catalogue invariant

Before changing `lib/chatStarterCatalog.ts`, `lib/chatStarterAvailability.ts`,
`lib/chatStarterAccess.ts`, `lib/chatStarterCapabilityResolution.ts`,
`components/chat/ChatStarterGallery.tsx`, the starter wiring in
`ChatWelcomeScreen.tsx` / `ChatPageClient.tsx` / `ReviewWorkspaceShell.tsx`, or
`scripts/check-starter-catalog.mjs`, read:

- `docs/ui-contracts/chat-starter-catalog.md`

Non-negotiable requirements:

- **A card says what the viewer gets, not which feature exists.** No card copy
  in any of the seven locales may claim a better, best, optimal or smartest
  anything, and none may use an em dash or an en dash.
- **`available`, `locked` and `hidden` are three different answers.** A flag
  that is off is `hidden` -- offering a lock with nothing behind it is a sales
  promise the build cannot keep. A viewer who could unlock it is `locked`, with
  the requirement stated on the card before the click, never after it. Existence
  is decided before entitlement, so a dead flag never produces "upgrade to Pro",
  and a guest meets sign-in before pricing.
- **Anything undecidable is `hidden`.** An unknown flag key, an unresolved
  capability and an unloaded plan each fail closed; none of them guesses.
- **The registry may grow without limit; the screen may not.**
  `CHAT_STARTER_MAX_VISIBLE` and the selection order live in
  `lib/chatStarterAvailability.ts` and nowhere else. When a locked card exists
  the ceiling gives up a *runnable* card, never the last lock -- a gallery that
  only ever shows what the viewer can already do discloses nothing.
- **A click seeds and stops.** It writes the existing draft store
  (`lib/conversationDraftStore.ts`), never a second draft path; it never sends,
  never overwrites text the person typed, never quotes a price, and never
  prints a conversation title.
- **`requires.flagKeys` holds imported constants, never string literals.**
  `npm run check:starter-catalog` refuses a `"feature.…"` literal in the
  catalogue, and proves every flag constant, capability resolver, evidence path
  and locale string still resolves. It runs in PR Fast Gate's static stage.
- **Adding an entry is three things**: a row in the table, its three strings
  (short label, outcome sentence, seed) in all seven locales, and an `evidence`
  path that exists. Icons are derived from the entry's own accent role and task
  kind; a fourth step is the one somebody forgets.
- **The short label is a promise too.** On a touch screen nothing is hovered, so
  the label is all the card says; it follows the outcome sentence's rules. A
  locked card shows the requirement badge before its label and is drawn as
  loudly as a runnable one.
- **The composer stays in the bottom dock on a new chat.** The welcome screen
  holds only the greeting, the mobile recent-chats row and the starters,
  centred with auto margins between the header and the dock; it never holds a
  composer slot again. The gallery's shape comes from its own width (a `rem`
  container query), never from which shell rendered it, and the desktop welcome
  screen lists no recent conversations -- the sidebar already does.
- **No new accent role.** A card wears the role its feature already owns, or
  the neutral blue/zinc; the AI Review gradient stays reserved even on a card
  describing AI Review.
- The whole surface is behind default-off `feature.chatStarterEnabled` with the
  `CHAT_STARTER_KILL_SWITCH` override, resolved server-side. Off renders
  nothing at all -- not a disabled teaser.
- Any related change must keep `tests/chatStarterCatalog.test.mjs` and
  `tests/e2e/chat-starter-catalog.spec.ts` passing on desktop *and* mobile, and
  must re-run the mobile composer and sidebar drawer specs.
- A card that promises a feature this build does not have is a release blocker.
  Everything else here is ordinary review.
<!-- END:chat-starter-catalog-invariant -->

<!-- BEGIN:independent-review-requests -->
# 독립 검토는 검토 서버에 요청합니다

작업을 마치고 독립 검토가 필요하면 **reviewer를 직접 고르지 않습니다.** 다른
공급사의 앱이나 CLI를 손으로 부르지 않고 검토 서버에 요청합니다. 서버가 작성자와
**모델 공급사가 다른** reviewer를 부하에 따라 배정하고, 판정을 결정적 규칙으로
돌려줍니다. 설치와 동작은 `tools/review-orchestrator/README.md`에 있습니다.

1. **검토할 변경을 commit합니다.** commit되지 않은 변경은 서버로 가지 않습니다.
2. **요청합니다.** 클라이언트는 운영자 PC의 고정 위치에 있으므로 어느 브랜치에서나
   같은 명령을 씁니다. 이 도구가 들어 있는 checkout에서는 `npm run -s review --`도 같습니다.

   ```
   node "$HOME/bin/review.mjs" submit --author <자기 이름> --scope "<무엇을 왜 바꿨는지 한두 줄>"
   ```

   - `--author`는 **지금 작업한 앱 자신**입니다. Claude Code는 `claude`, Codex는
     `codex`, Cursor는 `cursor`이고, Cursor는 실제로 쓴 모델의 공급사를
     `--author-vendor`(`anthropic`·`openai`·`xai`·`google` 등)로 함께 적습니다.
     서버가 이 값으로 같은 공급사를 빼므로, 다른 앱의 이름을 쓰지 않습니다.
   - base는 클라이언트가 고릅니다. `origin/develop`과 `origin/main`의 분기점 중 **더 가까운 것**이
     base가 되므로 `--base`는 붙이지 않습니다. 먼 기준점은 이미 병합된 남의 변경을 끌고 와서
     reviewer를 둘로 늘리고 대기열을 막습니다(2026-10-02, 대기 20건 전부가 그랬습니다).
   - 계약 경로(migration, 과금, 정책 문서 등)를 건드린 변경은 서버가 reviewer를 두 명으로
     올립니다. 더 필요하면 `--reviewers 2`를 붙입니다.
   - 같은 브랜치의 다음 검토 round라면 `--focus <지난 round의 마지막 commit>`을 붙입니다.
     reviewer에게는 그 commit 이후의 diff만 보여 주고, 지시 파일과 계약 경로 판정은 base부터
     전체를 기준으로 합니다. push하지 않은 commit도 focus가 될 수 있습니다.
3. **기다립니다.** `node "$HOME/bin/review.mjs" wait <jobId>`를 종료 코드가 3이 아닐 때까지
   반복합니다. 한 번에 최대 9분 기다리므로 명령 하나의 시간 제한 안에 들어갑니다.
4. **결과대로 처리합니다.**
   - `0` accept: 결과를 보고합니다.
   - `1` reject: 지적을 고치고 commit한 뒤 **새로 submit**합니다. 같은 job을 다시 쓰지 않습니다.
   - `2` unknown: **다시 보내지 않습니다.** `report <jobId>`의 원문과 함께 사람에게 알립니다.
     결과를 모르는 것을 다른 reviewer로 몰래 다시 보내면 부하가 한쪽으로 쏠립니다.
   - `64`·`65`: 요청이나 서버의 오류입니다. 오류 출력을 그대로 사람에게 알립니다.
     SSH 접속 오류(`Permission denied`, `Could not resolve hostname`)도 여기에 속합니다.

검토 결과는 **신호이지 승인이 아닙니다.** accept가 병합이나 배포 승인을 대신하지
않고, 정책 문서가 기록을 요구하는 별도 교차 검토 절차가 있으면 그 절차를 따릅니다.
<!-- END:independent-review-requests -->

<!-- BEGIN:agent-delegation-policy -->
# 작업을 어느 모델에 보낼지

**모델 선택은 비용 결정이 아니라 복구 가능성 결정입니다.** 이 저장소에는 틀려도
고쳐서 배포하면 끝나는 변경과, 고칠 수 없는 변경이 섞여 있습니다. 앞쪽에 최상위
모델을 쓰는 것은 낭비이고, 뒤쪽에 저가 모델을 쓰는 것은 사고입니다. 기준은
"검증 범위는 되돌릴 수 없는 것에 비례합니다" 절과 같습니다.

역할 정의는 두 도구에 같은 내용으로 들어 있습니다.

- Codex: `.codex/agents/*.toml`
- Claude Code: `.claude/agents/*.md`

| 역할 | Codex | Claude Code | 무엇을 맡는가 |
|---|---|---|---|
| `contract` | `gpt-5.6-sol` / xhigh | `opus` / xhigh | 되돌릴 수 없는 변경 |
| `impl` | `gpt-5.3-codex` / medium | `sonnet` / high | 그 밖의 모든 코드 변경 |
| `chore` | `gpt-5.3-codex` / low | `haiku` | 판단이 필요 없는 기계적 작업 |
| `review` | — | `opus` / xhigh (read-only) | 다른 역할이 만든 diff 검토 |

## `contract` 로 보내는 것

아래 중 하나라도 걸리면 `contract` 입니다. 애매하면 `contract` 입니다 --
잘못 올리면 비용이 들고, 잘못 내리면 복구가 안 됩니다.

- `lib/modelPricing.ts`, `lib/credit*`, `lib/chatCostGuardrails.ts`,
  `lib/models.ts` 의 `creditWeight`·`maxOutputTokens`·`reservationOutputTokens`
- `prisma/migrations/**`, schema 의 CHECK 제약, `VALIDATE CONSTRAINT`,
  `NOT NULL` 전환
- `Conversation.productKey` 와 그것을 쓰는 생성 경로
- `docs/ui-contracts/` 가 이름을 댄 파일 -- 위반이 release blocker 로
  적혀 있는 것들
- 프로모션 할인, 가격 카탈로그 default, 플랜 변경, 이메일 발송 경로

## `chore` 의 경계

`chore` 는 **판단이 필요 없을 때만** 씁니다. 어느 파일을 고칠지 스스로 정해야
하거나, 정책 문서를 읽어야 답이 나오거나, 기존 코드에 없는 패턴을 만들어야
하면 `impl` 입니다. 역할 정의에도 같은 조건이 적혀 있고, 해당하면 멈추고
올리라고 지시돼 있습니다.

## 모델을 내려도 게이트는 내려가지 않습니다

역할을 나눠도 통과 기준은 하나입니다. 어느 역할이 만든 변경이든 PR Fast Gate 의
static 단계를 그대로 지납니다 -- `npm run lint`, `check:accent-tokens`,
`check:model-pricing`, `check:enum-constraints`, `check:default-models`,
`check:starter-catalog`, `check:shared-packages`, 그리고 해당 기능의 e2e spec.

**저가 모델을 쓴다는 것은 검증을 줄인다는 뜻이 아닙니다.** 게이트가 기계적으로
같은 것을 묻기 때문에, 실행 모델이 무엇이든 통과선은 움직이지 않습니다.

## 자동 위임을 과신하지 않습니다

Claude Code 는 `description` 을 보고 자동 위임하지만 보장되지 않고, Codex 는
대체로 명시적 지시를 필요로 합니다. 중요한 작업은 역할을 직접 지목하십시오 --
"이건 contract 로", "impl 에 맡겨". 자동 분류에 기대다가 계약 파일이 `impl` 로
가는 것이 이 정책이 막으려는 실패입니다.
<!-- END:agent-delegation-policy -->
