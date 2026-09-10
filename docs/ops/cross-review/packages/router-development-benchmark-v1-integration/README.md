# Router benchmark v1 통합 snapshot — 사후 독립 검토 보관

이 exchange는 **`passed`**, Claude 판정은 **`approve` / findings 0건**입니다.
이는 아래 별도 로컬 snapshot에 대한 실제 CLI 검토 결과입니다. 이미 병합된
PR의 사전 승인이나 실제 병합 commit 전체에 대한 판정으로 소급하지 않습니다.
이 폴더를 검토 브랜치에 보관하는 것은 develop 반영이나 추가 병합을 뜻하지 않습니다.

## 대상과 시간 순서

| 사건 | 식별자 / UTC 시각 |
|---|---|
| 실제 [PR #1311](https://github.com/mposition/Tomverse/pull/1311) 병합 | `f8d80a6797104da281c116eee12b01d5c7b25c2d`, `2026-09-10T02:03:08Z` |
| 실제 PR의 head | `0e853fd9ecebb0808dacefc6816a0d1f25148783` |
| 이번 검토의 별도 로컬 commit | `4d08d80a71e71148b2fc22c77102d79cbc916630` |
| 이번 검토의 비교 base | `5b7352564f507a722fbb1e3395b368ba5eae4299` |
| Claude CLI 검토 시작 | `2026-09-10T02:05:47.556Z` |
| 판정 수신 | `2026-09-10T02:09:23.944Z` |

GitHub API는 병합 계정을 `mposition`, `autoMergeRequest`를 null로 보고했습니다.
이 정보만으로 UI·CLI 등 실제 병합 경로를 추정하지 않습니다. 이 작업의 Codex
실행은 그 PR 병합을 수행하지 않았고, 외부 변경을 되돌리지 않았습니다.

- Task: `router-development-benchmark-v1-integration`, round `0`, 검토 범위 22파일
- 전체 검토 digest: `sha256:1f74cb072d9dda87bb80211aabfa8521d8f2f20e822aa882ebe5868f0f290c51`
- [통합 task](../router-development-benchmark-v1-integration.task.json),
  [한정 승인 receipt](../router-development-benchmark-v1-integration.authorization.md)
- [원본 package](package-round0.json), [검토 diff](change-round0.diff),
  [생성 prompt](review-prompt.md), [실제 CLI 응답](review-round0.events.jsonl),
  [실제 판정](verdict-round0.json), [집계 결과](exchange.json)

후속 읽기 전용 비교에서 실제 병합 commit과 이 로컬 snapshot 사이의 원래 task가
열거한 소스 10파일, `package-lock.json`, 원 task·검토 기록 11파일은 모두 원시
바이트가 같았습니다. 이 한정된 동일성 확인은 두 전체 tree가 같다는 주장이나
Claude 판정의 대상 digest를 바꾸는 근거가 아닙니다.

## 실제 검사와 실제 검토의 구분

깨끗한 통합 commit에서 기존 제어 프로그램의 package 모드가 재실행했습니다.

- Benchmark: **95/95**, 관련 Router 회귀: **181/181**. 두 실제 명령과 출력에서
  추출·검증한 tests/pass/fail/cancelled/skipped 수가 package에 보존되어 있습니다.
- Guard **8개 전부 통과**: 공식 `npm run typecheck`, 대상 6파일 lint,
  encoding·document references·policy references, router quality evaluation,
  원본 11파일 및 package.json 외 소스 9파일 바이트 보존,
  양쪽 부모 package scripts의 정확한 합집합과 non-script 필드·lock 불변 검사.
- `checkFailures: []`. 실패 검사를 무시하는 override는 사용하지 않았습니다.

Claude Code `2.1.261`의 실제 reviewer 명령은 다음과 같았습니다. 아래는 실행
이력이며 재실행 요청이 아닙니다. Prompt는 stdin으로 전달됐습니다.

```text
claude --print --safe-mode --output-format json --tools Read,Grep,Glob --allowedTools Read,Grep,Glob --strict-mcp-config
```

실제 소요 시간은 **216,333 ms**입니다. 검토 자식 환경 복사본에서만
`ANTHROPIC_API_KEY`를 대소문자 구분 없이 제거했고, 실행 직전의 별도 auth 조회는
`loggedIn=true`, `authMethod=claude.ai`, `apiProvider=firstParty`를 보고했습니다.
부모·영구 환경은 바꾸지 않았고 API-key fallback이나 모델 override는 없었습니다.
이는 저장된 subscription 로그인으로 수행한 검토입니다.

사용자가 한정 승인한 `--skip-preflight`만 기록했습니다. `preflight`는 **null**이며
통과로 바꾸지 않았습니다. `--review-despite-check-failures`는 사용하지 않았습니다.
CLI의 `totalCostUsd: 6.6172435`는 subscription 실행에서 도구가 보고한 추정값이지
실제 API 청구·invoice·추가 결제 관측이 아닙니다.

Reviewer에는 shell과 write 도구가 없었습니다. Claude는 파일과 기록을 읽어
판정했으며, 부모별 package 합집합·바이트 hash·commit 조상 관계는 **기록된 guard
실행에 의존했다**고 밝혔습니다. 이를 Claude가 직접 재실행한 검사로 표시하지
않습니다. 제어 프로그램은 판정 형식과 digest를 검사하고 기존 `replayExchange`로
`passed`를 계산했습니다. Codex가 이후 수행한 순수 replay 대조도 같은 결과였습니다.

검토자의 두 비차단 관찰은 원문 판정에 보존했습니다: 위 직접 재계산의 한계와,
기존 benchmark 문서의 과거 base에 묶인 static 수치가 현재 운영 증거는 아니라는
점입니다. findings로 바꾸거나 원본 문서·판정·소스를 수정하지 않았습니다.

## 보존 검사와 범위

원 task와 기존 v1 검토 기록 11파일, 통합 task·승인 receipt·소스, 실제 판정은
수정하지 않았습니다. Package diff의 digest와 생성 prompt의 renderer 바이트도
그대로 보존했습니다. 이후 archive commit에 포함되는 새 파일은 이 폴더 8개뿐입니다.

전체 `git diff --cached --check`는 생성 자료의 공백 17줄 때문에 **exit 2**를
보고합니다: 두 diff 파일의 각 4줄은 보호된 과거 prompt를 인용한 것이고,
새 prompt의 9줄은 그 4줄과 현재 guard 출력 formatter의 5줄입니다. 부모의 한정된
자료 보존 결정에 따라 이 바이트를 고치지 않았습니다. 새 README·수동 작성 문서의
diff 검사와 문서 guard 3종은 별도로 통과했습니다. 이는 이미 통과한 package
테스트·8개 guard의 실패를 무시하는 override가 아닙니다.

이 보관은 기존 `codex/router-benchmark-v1` 검토 브랜치에만 합니다. 새 PR,
재병합, 새 base 동기화, 기존 exchange 재개, provider benchmark 실행,
main 변경, production 배포 또는 품질·출시 승인은 수행하지 않습니다.
