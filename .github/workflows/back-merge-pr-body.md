Automated back-merge, opened because the merge could not land on `develop` directly — either it conflicted, or the push was refused.

> **Merge this with "Create a merge commit".** The whole value of this pull request is the second parent. Squashing or rebasing discards it, and the pull request then does nothing at all. #203 and #213 were both squashed, and both had to be redone.

`main` reached its current state as a squash commit, so `develop` and `main` share no commit for the released work even where they share its content. Git resolves a merge against the merge base, and with no shared commit for that work the base predates it — so the next change `develop` makes inside code `main` already carries looks like a conflicting edit on both sides. #200 cost eighteen conflicted files for exactly this reason.

Verify after merging:

```
git fetch origin develop && git merge-base --is-ancestor origin/main origin/develop; echo $?
```

`0` means the ancestry is restored. Anything else means this was squashed or rebased and the back-merge has to be redone.

See `.github/workflows/back-merge-main-to-develop.yml` for why this is automated rather than left to a step someone has to remember.
