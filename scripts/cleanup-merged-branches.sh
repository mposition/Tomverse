#!/usr/bin/env bash
#
# develop 에 이미 병합된 원격 브랜치를 정리합니다.
#
# 두 가지 병합 형태를 모두 감지합니다:
#   1) merge / fast-forward  -> 브랜치 팁이 develop 의 조상
#   2) squash merge          -> develop 히스토리에 "(#<PR번호>)" 커밋이 존재
#
# 사용법:
#   ./scripts/cleanup-merged-branches.sh          # 삭제 대상만 출력 (dry-run)
#   ./scripts/cleanup-merged-branches.sh --apply  # 실제 삭제
#
set -euo pipefail

REMOTE="${REMOTE:-origin}"
BASE="${BASE:-develop}"
PROTECTED_RE='^(main|master|develop|release/.*)$'
APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

echo "==> fetching ${REMOTE}"
git fetch "$REMOTE" --prune

# 열린 PR 이 있는 브랜치는 병합 이력이 있어도 보존한다.
# (예: squash merge 후 같은 브랜치에서 후속 작업이 이어지는 경우)
open_heads=""
if command -v gh >/dev/null 2>&1; then
  open_heads="$(gh pr list --state open --json headRefName -q '.[].headRefName' 2>/dev/null || true)"
else
  echo "!! gh CLI 가 없어 열린 PR 을 확인할 수 없습니다." >&2
  echo "!! 열린 PR 의 브랜치가 삭제되지 않도록 목록을 직접 확인하세요." >&2
fi

to_delete=()
kept=()

while read -r ref; do
  branch="${ref#"${REMOTE}"/}"
  [[ "$branch" == "HEAD" ]] && continue
  [[ "$branch" =~ $PROTECTED_RE ]] && continue

  if grep -qxF "$branch" <<<"$open_heads"; then
    kept+=("$branch  (열린 PR 있음)")
    continue
  fi

  if git merge-base --is-ancestor "$ref" "${REMOTE}/${BASE}"; then
    to_delete+=("$branch")
    continue
  fi

  # squash merge 탐지: develop 로그에서 이 브랜치를 head 로 하던 PR 번호를 찾는다.
  pr=""
  if command -v gh >/dev/null 2>&1; then
    pr="$(gh pr list --state merged --base "$BASE" --head "$branch" \
            --json number -q '.[0].number' 2>/dev/null || true)"
  fi
  if [[ -n "$pr" ]] && git log "${REMOTE}/${BASE}" --oneline --fixed-strings \
       --grep="(#${pr})" | grep -q .; then
    to_delete+=("$branch")
  else
    kept+=("$branch  (${BASE} 에 미병합)")
  fi
done < <(git for-each-ref --format='%(refname:short)' "refs/remotes/${REMOTE}")

echo
echo "==> 보존 (${#kept[@]})"
printf '    %s\n' "${kept[@]:-(없음)}"

echo
echo "==> 삭제 대상 (${#to_delete[@]})"
if ((${#to_delete[@]} == 0)); then
  echo "    (없음)"
  exit 0
fi
for b in "${to_delete[@]}"; do
  printf '    %-55s %s\n' "$b" "$(git rev-parse --short "${REMOTE}/${b}")"
done

if ((APPLY == 0)); then
  echo
  echo "dry-run 입니다. 실제로 삭제하려면 --apply 를 붙여 다시 실행하세요."
  exit 0
fi

echo
git push "$REMOTE" --delete "${to_delete[@]}"
echo "완료. 되돌리려면 위에 출력된 SHA 로 브랜치를 다시 만들면 됩니다:"
echo "  git push ${REMOTE} <sha>:refs/heads/<branch>"
