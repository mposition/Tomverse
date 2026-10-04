# Chat 완료 Message 복구 CI 후속 독립 검토 v1

PR #1410의 최초 Linux 통합 CI에서 기존 `memoryReleaseContracts` source 검사가
공유 `PUBLIC_CHAT_MESSAGE_SELECT` 도입을 이해하지 못해 9,033개 중 1개가
실패했다. 제품 동작 실패가 아니라 테스트가 이전 구현 형태를 고정한 문제였다.

이 exchange는 owner 대화 라우트가 공유 allowlist를 사용하고 그 allowlist가
`memoryUsedCount`와 `knowledgeChunkCount`를 직접 선택하는지 검사하도록 테스트를
수정했다. Claude는 세 라운드 모두 `approve`했지만 source 검사의 우회 가능성을
차례로 지적했다. 작성자는 금지 경로에서 공유 select와 serializer 사용을 모두
거부하도록 보강했다.

| 라운드 | commit | 변경 digest | finding | 제어 상태 |
| --- | --- | --- | --- | --- |
| 0 | `0beab239` | `sha256:26b5c8db…bcad369` | 2 | `awaiting_revision` |
| 1 | `d378d12b` | `sha256:f807ea0c…e90589f` | 1 | `awaiting_revision` |
| 2 | `a2c5960a` | `sha256:9be5f283…31d14e` | 1 | `on_hold / revisions_exhausted` |

마지막 finding은 whole-file 문자열 검색이 allowlist 밖의 주석에도 통과할 수
있다는 정밀도 문제다. 실제 공개 노출 결함은 아니지만 재현 가능해 새 v2
exchange에서 이어서 닫았다. v1의 `on_hold` 기록과 verdict는 수정하지 않는다.

검토는 Read·Grep·Glob만 허용한 Claude 저장 로그인으로 실행했고, 사용자가 이
후속에 허용한 `--skip-preflight` 예외를 각 verdict에 기록했다. provider/R2 호출,
유료 benchmark, 제품 코드 수정, push·merge·deploy는 검토 범위에 없었다. 이
디렉터리는 검토 뒤 영구 보존한 byte-identical 사본이며 package digest에는
포함되지 않는다.
