# 5차 검토 요청 — 발견 대기열: 채택·제외, 재검토

4차 P2 4건에 대한 대응입니다. `git diff`(intent-to-add 포함)를 다시 봐 주세요.

## 대응

1. **패밀리 검사와 쓰기의 원자성.** 쓰기 트랜잭션이 먼저 `undecidedQueueUnchangedSince(tx, checkedIds)`를
   부릅니다: `LOCK TABLE "ModelLifecycleWorkItem" IN SHARE ROW EXCLUSIVE MODE`로 이 테이블의 모든
   writer와 다른 제외를 commit까지 막은 뒤, 지금 보이는 미결정 id가 트랜잭션 밖 패밀리 검사가 본
   집합에 모두 들어 있을 때만 진행합니다. 새로 생기거나 되돌아온 미결정 item이 있으면 409
   `FAMILY_MISMATCH`. 잠금 이후 READ COMMITTED의 문장 단위 스냅샷은 잠금 전 commit된 행을 모두
   보므로, 검사 이후 추가된 구성원은 여기서 드러납니다. 제출된 item 자체의 상태 변화는 기존
   `FOR UPDATE` + 전이 검증이 막습니다.
2. **제외 출발 상태.** DB CHECK가 `exclude`의 `fromStatus IN ('discovered','awaiting_decision','deferred')`를 강제.
3. **행위자.** DB CHECK `decision IS NULL OR btrim(coalesce(actorEmail,'')) <> ''`, `recordAdoptionDecision`도 행위자 검사.
   (`transitionWorkItems`는 기존 `actor_required`로 이미 거부합니다.)
4. **stage 정책.** 기존 정책(prerelease 결정은 stable release를 억제하지 않음)을 유지하고, 확인 문구
   (en/ko)와 §51에 그 예외를 밝혔습니다. 한국어 문구: "이 모델 패밀리는 이후 자동 스캔에서도 다시
   제안되지 않습니다. 단, 프리뷰·베타 버전을 제외한 경우 정식 출시 버전은 새로 제안될 수 있습니다."

## 요청

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고 명시해 주세요.
코드를 수정하지 말고 한국어로 답해 주세요.
