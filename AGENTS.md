# Project Rule — Compute-Intensive Work Runs on GitHub Actions, Not This Machine

This rule is **hard-enforced and non-negotiable**. It applies to every agentic AI /
automated coding assistant working in this repository (Claude Code, Copilot,
Cursor, Codex, or any other tool), for every task, forever — unless the human
owner of this repo explicitly overrides it in that specific session.

## The rule

**Do not run compute-intensive work on this laptop.** This machine is a
low-spec development box used only for editing and light local iteration. All
builds, compiles, test suites, type-checks across the whole workspace, Docker
image builds, and desktop packaging **must run on GitHub Actions**, not
locally.

This is not a style preference — it's already load-bearing in this repo. See
the comment at the top of [deploy.yml](.github/workflows/deploy.yml): *"Build
ALL images on GitHub Actions -> push to GHCR -> the VPS only pulls and
restarts. Zero compilation on the shared production box (project rule)."* The
same principle extends to the dev laptop: if the VPS isn't allowed to compile,
neither is this machine.

### Forbidden locally (push to CI instead)

- `pnpm build`, `pnpm build:desktop`, `turbo run build`
- `cargo build`, `cargo test --workspace`, `cargo clippy --workspace ...` at
  full-workspace scope
- `docker build`, `docker compose build`, `docker compose up --build`
- `pnpm --filter @insightlibrary/desktop tauri build` (multi-OS desktop
  bundling)
- Any full `turbo run check` / `pnpm build` across all workspace packages
- Anything that spins up more than a single lightweight process, or that would
  peg CPU/RAM for more than a few seconds

### Allowed locally

- Reading, writing, and editing files
- `git` operations (status, diff, add, commit, log, branch)
- `gh` CLI to push commits and open PRs
- `pnpm install` when needed for editor tooling (language server, types)
- A quick lint/format/typecheck scoped to the **single file just edited**
  (e.g. an editor-integrated check), never a full workspace build
- Running the existing lightweight dev servers (`pnpm dev`) briefly to sanity
  check a UI change, if the user asks for it — not full builds

## No lengthy builds or CI flows — code, quick-check, commit, push, stop

This extends beyond "don't build locally" — **do not run or babysit lengthy
CI flows at all**, even remotely. The agent's job is to write the code, run
small/fast sanity checks, then commit and push. That's the end of the task.

- Do **not** proactively trigger `workflow_dispatch`, poll `gh run list`,
  `gh run watch`, or `gh run view --log`, or otherwise wait on/babysit a CI
  run after pushing. Push and stop.
- Do **not** chain multiple heavy verification steps "just to be safe" before
  handing back to the user.
- Favor majority-coding time over verification time: write the change, do a
  cheap, targeted check (single-file typecheck/lint, a single fast unit test
  if one already exists and runs in a couple of seconds), then commit and
  push once the work is actually done.
- **The user checks CI and reports errors back themselves.** Don't ask "want
  me to check the CI run?" — just finish the coding, commit, push, and tell
  the user it's pushed. If they come back with an error, fix it then.
- This applies on top of the compute-offload rule above, not instead of it:
  if a check would be heavy, don't run it locally *or* spend time
  orchestrating/monitoring it remotely — skip straight to commit + push.

### How to verify work instead of building locally

1. Do a small, fast, targeted check on just what changed (single-file
   typecheck/lint, or an existing single fast test) — not a full build, not a
   full test suite, not a full `turbo run check`.
2. Commit and push (or open a PR). `ci.yml` will run automatically on push/PR
   to `main` — that's expected and fine, but it runs unattended. Don't wait
   on it, watch it, or fetch its logs unless the user explicitly asks.
3. Report to the user that the change is committed/pushed. Stop there.
4. If the user later reports a CI or runtime error, fix that specific issue
   with the smallest possible local repro (one file, one test) — never a
   full rebuild.

### Why

This laptop has limited specs. Full builds, multi-crate Rust compiles, Docker
image builds, and Tauri desktop bundling are heavy enough to max out its CPU
and make it unusable. GitHub Actions runners exist precisely to absorb that
load for free — use them.

**Any agent working in this repo must follow this rule strictly, for every
task, without exception, regardless of how the task is phrased.** If a task
seems to require a full local build, stop and push to CI instead, or ask the
user how they'd like to proceed.
