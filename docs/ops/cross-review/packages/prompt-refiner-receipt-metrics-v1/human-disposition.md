# Prompt Refiner receipt·계측 계약 사람 disposition

- 결정일: 2026-09-15
- 결정자: `mposition`
- 대상 exchange: `prompt-refiner-receipt-metrics-v1`
- 마지막 검토 digest: `sha256:ef3a83844798555e9324e50dd5e522d0d6640805ee324ed92b7cea8ebc755b16`
- 결정: **알려진 residual을 수용하고 통합 진행**

`exchange.json`의 `on_hold (revisions_exhausted)` 상태와 round별 verdict는 수정하지
않는다. 이는 독립 검토 2회 수정 상한이 소진됐다는 사실의 기록이다. 2026-09-15
사용자는 Claude round 2의 권고와 아래 residual을 확인한 뒤 현재 변경을 push하고
PR·통합 CI까지 진행하도록 승인했다.

## 수용한 residual

`failureCodes.cancelled`는 dispatch 전 취소와 dispatch 후 취소를 하나의 flat count로
합친다. 개별 receipt에는 `outcome`과 `dispatchedAt`이 남으므로 원래 단계는 복구할 수
있고, Claude round 2도 모든 completion criterion이 충족됐다고 판정했다. 다만 현재
aggregate만으로는 두 취소 단계를 바로 읽을 수 없다.

이 수용은 Prompt Refiner 품질, provider/model 채택, 유료 실행, 제품 adapter 연결,
flag 활성화 또는 rollout을 승인하지 않는다. 두 단계 취소율이 운영 판단에 필요해질
때는 새 task와 새 독립 검토에서 aggregate를 분리한다.
