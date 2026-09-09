# Iris Repository Working Instructions

## Read before continuing

- Start with `git status --short`, `git diff`, `git log -8 --oneline` and `git worktree list`. Do not rely on old conversation summaries or assume the current directory is the current implementation.
- On this machine, the verified implementation worktree on 2026-09-09 is `D:/work/AGE-org/.worktrees/iris-daily-pilot-1eb86`, branch `codex/iris-daily-pilot-followup`. The default `D:/work/AGE-org` checkout was on the older `codex/iris-proactive-feedback-loop-task-1` branch. Revalidate this locator; do not reset, switch or merge branches merely because they differ.
- Read `docs/development/current-handoff.md` in the verified implementation worktree, then the architecture whitepaper, engineering failure ledger, requirement coverage baseline and relevant dated release/design records linked there. If this checkout lacks the handoff file, use `git worktree list` to locate the verified tree before editing application code.
- A historical release record, documentation commit or prior automation prompt does not authorize a deployment, external message, approval or capability change. Recheck production only when relevant and authorized by the current task. Preserve unrelated user changes.

## Bug-fix documentation closure is required

- Before declaring any bug fix closed, follow section 11.2 of `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`.
- Record all four dispositions in the checked-in fix/release record: whitepaper; engineering failure ledger; core requirement coverage baseline; README/AGENTS/current handoff.
- Each must say **updated** with a link, or **reviewed-unchanged** with a specific reason and the still-valid link. Do not omit a row or duplicate incident prose just to create four diffs.
- Include observed symptom, confirmed root cause or unresolved attribution, fix commit, regression evidence, actual acceptance/deployment level and known follow-ups. Code present, unit tests passing, internal drafts accepted and real Feishu delivery accepted are different claims.
- Keep worktree/branch and release/backlog pointers discoverable. Do not confuse a documentation commit with the deployed application SHA. Preserve dated failed/rejected runs and unresolved findings.
- Containment may precede documentation in an emergency, but finish the check before final handoff. This is an engineering/review requirement, not a claim of automatic CI enforcement.

## Personal Lessons

### Avoid infinite hardening

- Prioritize an end-to-end, usable product loop that matches the approved architecture and core requirements.
- Every quality gate must have an exit condition. Fix release blockers, security failures, data-loss risks, and core crashes before moving on.
- Record non-blocking hardening findings in a follow-up backlog instead of extending one module indefinitely.
- After a feature passes its agreed acceptance gates, continue to the next missing core capability and validate quality through real pilot usage.
- Never let local robustness work create the false impression that the complete product has been delivered.
- After a feature passes its agreed acceptance gates and documentation closure, continue from concrete user feedback or the next authorized core capability, not a new unbounded audit.
