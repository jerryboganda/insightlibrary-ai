# InsightLibrary AI — Project Instructions

## HARD RULE — Compute-intensive work runs on GitHub Actions, never locally

This machine is a low-spec dev laptop. **Never run builds, full test suites,
Docker image builds, or desktop packaging on it.** This rule is enforced for
every task, in every session, with no exceptions unless the user explicitly
overrides it in that session's chat. Full policy and the allowed/forbidden
command lists live in [AGENTS.md](AGENTS.md) — read it before doing any
build/CI/compile-related work in this repo.

Quick version:
- Forbidden here: `pnpm build`, `pnpm build:desktop`, `turbo run build`,
  `cargo build`/`cargo test --workspace`/`cargo clippy --workspace` at full
  scope, `docker build`, `docker compose build`, Tauri desktop builds.
- Allowed locally: editing files, git/gh commands, `pnpm install`, a
  single-file lint/typecheck, briefly running `pnpm dev` if asked.

If a task seems to call for a full local build or compile, push to CI instead
of running it here — do not ask "should I build this locally," just route it
to GitHub Actions per this rule.

## HARD RULE — No lengthy builds or CI flows; code, quick-check, commit, push, stop

Don't run or babysit lengthy CI flows at all, even remotely — this includes
NOT triggering `workflow_dispatch`, NOT polling `gh run list`/`gh run
watch`/`gh run view --log`, and NOT waiting on a pushed run's result. Spend
the time on coding, not verification:

1. Write the change.
2. Do one small, fast, targeted check (single-file lint/typecheck, or an
   existing single fast test) — never a full build or full test suite.
3. Commit and push once the work is done.
4. Tell the user it's pushed and stop. Don't offer to check CI.

The user checks CI/runtime results and reports errors back themselves — fix
issues only when they report them, with the smallest possible local repro.
