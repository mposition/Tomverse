# Chat 영속 초안·응답 복구 독립 검토 기록

**최종 제어 상태는 `on_hold / revisions_exhausted`, 최종 reviewer 결론은
`approve`다.** 두 값을 혼합해 `passed`라고 표현하지 않는다. 제어 프로그램이
재현 가능한 finding이 남은 마지막 수정 라운드를 통과로 승격하지 않기 때문에
exchange는 사람이 disposition을 결정하는 상태로 종결됐다.

## 라운드별 기록

| 라운드 | 검토 source | 변경 digest | Claude 판정 | finding |
| --- | --- | --- | --- | --- |
| 0 | `a6ea0837` | `sha256:5dda55cc…b367b27` | `request_changes` | 4 |
| 1 | `6c950c23` | `sha256:d3dab6e9…d71d84` | `request_changes` | 5 |
| 2 | `3defa1a9` | `sha256:6b7f8382…bc9a0a` | `approve` | warning 1, nit 2 |

`exchange.json`은 세 라운드의 제어 프로그램 replay다. `package-round*.json`은
고정 commit·digest·전체 diff·테스트와 guard 결과를, `verdict-round*.json`은
Claude의 판정을, `review-round*.events.jsonl`은 읽기 전용 검토 실행 기록을
보존한다. plain `change*.diff`와 `review-prompt.md`는 package JSON에서 결정적으로
재생성되는 중복 파일이고, 포함된 과거 source 공백이 통합 diff의 새 whitespace
오류로 오인되지 않도록 영구 추적 사본에서는 제외했다.

모든 검토는 author `codex`, reviewer `claude`로 실행했다. 사용자가 이번 작업에
한해 허용한 `--skip-preflight` 예외가 verdict에 기록되어 있다. Claude에는
Read·Grep·Glob만 허용했고 source 수정, provider/R2/Railway 호출, 유료 benchmark,
push·merge·deploy 권한은 주지 않았다.

## 마지막 판정 뒤 처리

Claude는 round 1의 5건이 모두 닫혔다고 확인하고 PR·통합 CI 진행을 권고했다.
마지막 세 finding은 비차단이었다. 그중 실제 동작과 응답 증거에 관한 두 건은
exchange 종결 뒤 commit `040e998a`에서 별도 보완했다.

1. GET-only 복구 polling 중 실제 취소 기능이 없는 전역 Stop을 숨겼다. live
   stream의 transcript 중지 동작과 기존 Review의 전역 Stop은 유지한다.
2. exact Message replay가 더 새로운 draft를 보존했을 때 `draftConsumed: true`를
   반환하지 않고, 실제 삭제가 발생한 트랜잭션에만 그 필드를 반환한다.
3. receipt는 exact draft text와 첨부 provenance를 URL에 노출하지 않도록 read-only
   POST를 유지했다. write와 provider 호출은 없으며 이 설계 편차를 정책에 명시했다.

**commit `040e998a`는 Claude가 검토한 round 2 digest에 포함되지 않는다.** 새
exchange를 열거나 승인 범위를 늘려 재검토하지 않았다. 해당 보완의 로컬 근거는
서버 집중 테스트 91/91, 네 브라우저 project의 관련 E2E 12/12, production build
88 routes, typecheck·수정 파일 lint·diff whitespace 통과다. Linux 통합 CI,
staging/production 배포와 실제 provider/R2 검증은 이 기록의 범위 밖이다.
