# Custom workflow planning recovery

Date: 2026-11-01. Tested the `custom-workflow-v1` working tree against a fresh
F1 rate-limiter repository with the Codex app-server and `gpt-6.1-sol`. No live
Cyrus service, VM, Linear workspace, or GitHub repository was modified.

## Scope

F1 applies because the change alters Feature planning permissions, failure
state transitions, approval gating, and the handoff into an implementation
worktree. The drive checked:

- delegated Feature routing into read-only planning;
- local source inspection with no planning-time MCP servers or web search;
- a recoverable startup failure that leaves the issue open;
- a source-grounded plan followed by explicit approval;
- isolated worktree creation and implementation-runner startup.

## Startup-error isolation

The original configuration was reproduced with `CYRUS_SANDBOX=1`. Before the
runner-factory fix, DEF-1 ended with `failed to load workspace requirements`,
zero model tokens, a visible error, and a Retry/Cancel interaction. The issue
remained open and no implementation started.

A one-setting-at-a-time app-server matrix established:

| Configuration | Result |
| --- | --- |
| Native Codex read-only | Source inspection succeeded |
| Cyrus named permission profile, network disabled | Failed loading workspace requirements |
| Same named profile, network enabled | Same failure |
| Native read-only with only an additional runtime root | Source inspection succeeded |

The effective planning configuration was being widened later in
`EdgeWorker.buildRunnerForType`: its explicit `read-only` mode was overwritten
by the global Codex mode, selecting the named profile. The corrected factory
preserves the narrower workflow mode. The app-server request also avoids
duplicating `cwd` in `runtimeWorkspaceRoots`; additional repository roots remain
available read-only.

## End-to-end result

With `CYRUS_SANDBOX=1`, DEF-1 inspected `src/rate-limiter.ts`, `src/types.ts`,
`package.json`, and repository instructions using read-only local commands. It
posted a concrete fixed-window implementation plan and an approval elicitation.
No worktree existed before approval. The correlated Approve response created an
isolated `DEF-1` worktree and started the implementation runner.

A second disposable run without the unrelated global egress profile confirmed
the same plan and approval transition. Its implementation model call was then
rejected by the ChatGPT account usage limit before edits; the worktree and
implementation session had already been created. This external quota prevented
observing completed sample edits, but did not affect the workflow transition
under test.

The injected failure/restart/retry path is covered by the acceptance fixture:
one parent and one Feature child remain exactly two workflows across restart,
retry returns to planning, a replacement plan still requires approval, and no
duplicate sub-issue is created.

## Automated checks

- Codex runner full package: 78 passed.
- Edge-worker full package: 905 passed with 1 skipped after allowing its
  localhost proxy tests.
- Core tests: 197 passed.
- Core, Codex runner, and edge-worker type checks passed.
- Monorepo build passed.

