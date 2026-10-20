# Cyrus Custom Source-Change Prompt

```text
You are modifying the Cyrus source repository to add a complete, persistent
approval-driven workflow. Read every repository instruction first, including
AGENTS.md and CLAUDE.md when present. Inspect the current source and tests before
editing. Do not assume an older implementation plan still matches the current
release.

The finished runtime workflow must be:

product idea in Linear
  -> read-only plan
  -> explicit plan approval
  -> persistent feature-child decomposition
  -> separate plan and approval for every child
  -> implementation in isolated worktrees
  -> Manual issues for human-only blockers
  -> safe wake-up after blocker verification
  -> pull request and required checks
  -> explicit merge approval
  -> revalidation and protected merge
  -> final parent summary only after all children are terminal

Current Cyrus already has useful primitives. Reuse the current activity,
interaction/elicitation, authorization, persistence, session-resume, Linear,
GitHub, worktree, parent-child session, and blocker-wake-up abstractions wherever
they are suitable. Extend existing mechanisms instead of creating parallel
systems.

Before changing application code:

1. Locate the current issue/session lifecycle, runner permission selection,
   approval/elicitation helper, persistence layer, userAccessControl checks,
   Linear issue/relation APIs, parent-child tracking, blocker wake-up code,
   pull-request service, and merge path.
2. Create docs/custom-workflow/gap-analysis.md.
3. For every requirement below, mark it Existing, Partial, or Missing and cite
   the current source files, symbols, and tests.
4. Record any schema migration, compatibility, configuration, and recovery risks.
5. Continue into implementation after the audit. Do not stop after producing only
   the audit unless a genuine architectural conflict makes safe implementation
   impossible.

CHANGE 1 — Persistent plan approval gate

Implement a runner-independent, persistent planning state machine with states
equivalent to:

planning -> awaiting_plan_approval -> implementing -> in_review

Requirements:

1. A newly delegated product/PRD issue or feature issue starts in a read-only
   scoper/planner mode.
2. Runtime planning may inspect the repository but may not write repository files,
   run mutating shell commands, create a branch, commit, push, or open a pull
   request.
3. When a usable plan is ready, post the plan to the Linear agent session, create
   an approval interaction using existing abstractions where possible, persist its
   correlation data, and park the session.
4. Approve resumes through the correct next mode: an approved parent enters
   orchestration; an approved feature child enters implementation.
5. Revise remains read-only, injects the requested changes, produces a new plan,
   invalidates the old approval, and asks again.
6. Reject or Cancel ends safely without implementation.
7. No response must never be treated as approval.
8. Outstanding approval state must survive daemon restart and session recovery.
9. Duplicate Linear webhooks and duplicate callbacks must be idempotent.
10. Only an identity accepted by the existing userAccessControl policy may approve,
    revise, reject, or cancel.
11. The design must work with Codex and Claude runners and must not contain
    runner-specific approval logic.

CHANGE 2 — Approved product decomposition

Requirements:

1. Only an approved parent product plan may create implementation children.
2. Create one Linear child issue for every independently reviewable feature.
3. Set the correct parentId, team, project, initial To Do-equivalent state, and
   Feature label through supported Linear APIs.
4. Delegation must use the supported Cyrus/Linear agent mechanism.
5. Every child must enter the planning approval gate. A Feature label must never
   bypass child planning.
6. Only an approved child receives a builder session and isolated worktree.
7. Persist the complete expected child set and each child's result.
8. The parent must not complete after only the first child finishes.
9. The final parent summary is produced only after all required children reach a
   terminal state.
10. Failed, rejected, and canceled children must be reported explicitly and must
    not be silently counted as success.
11. Replaying the same parent approval must not create duplicate children.
12. Initial concurrency must be conservative: create the child issue set, but run
    at most one child implementation at a time until concurrency is deliberately
    enabled and tested.
13. Dependencies between children must use persistent Linear relations. A blocked
    child may start only after all of its blockers are successfully resolved.

CHANGE 3 — Manual issues and human-only blockers

Create a Manual issue whenever work requires:

- a credential, secret, certificate, or account action
- spending money or accepting vendor lock-in
- DNS, OAuth, billing, identity, app-store, or provider-console action
- a host package or system-service change
- a production deployment decision
- an action outside the worktree or the current agent's authority

Requirements:

1. Assign the Manual issue to the authorized human, label it Manual, and do not
   delegate it to Cyrus.
2. Add a Linear blocked-by relation from the waiting agent issue to the Manual
   issue.
3. Persist and park the waiting work while the Manual issue is unresolved.
4. The Manual issue body must use this exact structure:

   ## Why
   One sentence explaining what is blocked.

   ## Options
   Include only when a real decision exists. State cost, effort, lock-in, risks,
   and a recommendation.

   ## Steps
   Exact browser actions or commands for the human.

   ## Hand-back
   State where the non-secret result belongs. Never ask for a secret in a Linear
   or GitHub comment.

   ## Verify
   State the non-secret verification Cyrus will run after completion.

5. When the Manual issue becomes Done, wake the waiting work through the existing
   or extended blocker mechanism and run the Verify step before continuing.
6. Failed verification must keep the dependent work blocked and report the reason.
7. Never request, echo, persist, or post a secret in Linear, GitHub, logs, activity
   messages, pull requests, or issue comments.
8. Repeated processing must not create duplicate Manual issues for the same
   blocker.
9. Manual blocker state and wake-up correlation must survive restart.

CHANGE 4 — Protected merge approval

Implement a persistent merge state machine with states equivalent to:

in_review -> awaiting_merge_approval -> merging -> done

Requirements:

1. Ask for merge approval only after the Cyrus-created pull request exists and all
   required checks pass.
2. The approval interaction must show repository, pull-request number, base branch,
   head branch, head SHA, changed-file summary, test/check results, and preview link
   when available.
3. No response, Reject, or Cancel must never merge.
4. Only an identity accepted by userAccessControl may approve.
5. Before merging, re-fetch and verify the repository identity, pull-request
   identity, open state, allowed base branch, expected head branch, unchanged head
   SHA, and passing required checks.
6. A stale approval, changed head SHA, closed pull request, wrong repository, wrong
   base, or failing check must refuse the merge and request a fresh valid approval
   when appropriate.
7. Respect GitHub rules and branch protection. Never use an administrative bypass.
8. Use the repository's intended merge strategy; default to squash only when it is
   compatible with existing repository behavior. Delete the feature branch only
   after successful merge.
9. Persist outstanding merge approval so restart recovery is safe.
10. Repeated callbacks must be idempotent. An already merged pull request must not
    trigger a second merge or an error loop.
11. Post the final pull-request and merge-commit links back to Linear.

CROSS-CUTTING REQUIREMENTS

1. Preserve existing Cyrus behavior outside this workflow.
2. Keep the implementation runner-independent and verify Codex-runner behavior.
3. Use typed, versioned persistent state with safe migration or backward-compatible
   defaults for existing installations.
4. Correlate approvals to the exact issue, session, plan revision, repository,
   pull request, and head SHA they authorize.
5. Validate all externally supplied identifiers and authorization decisions at the
   point of action, not only when an interaction is created.
6. Redact secrets and sensitive environment values from errors and logs.
7. Make retries, restarts, duplicate webhooks, and duplicate callbacks safe.
8. Document any new configuration key with a tested example. Do not invent a
   configuration mapping without connecting it to working runtime code.
9. Do not weaken sandboxing, tool permissions, branch protection, or existing tests.

REQUIRED TESTS

Add focused unit and integration tests covering at least:

- plan approve, revise, reject, cancel, and no-response behavior
- prevention of every repository mutation path before approval
- unauthorized approval attempts
- plan revision invalidating an earlier approval
- restart recovery while plan approval is pending
- duplicate plan callbacks and webhooks
- zero, one, and multiple decomposed children
- prevention of Feature-label approval bypass
- duplicate parent approval without duplicate children
- child failure/cancel/rejection and correct parent aggregation
- child dependencies and parent completion only after the complete child set
- Manual issue creation, assignment, body contract, and non-delegation
- Manual parking, restart recovery, wake-up, verification success/failure, and
  duplicate-delivery behavior
- merge approve, reject, cancel, and no-response behavior
- unauthorized merge approval
- stale/closed/wrong pull request, changed head SHA, wrong base, and failed checks
- duplicate merge callbacks and restart recovery
- successful merge posting the correct final links to Linear
- both Codex and Claude runner compatibility where shared runtime behavior is used

Add an integration acceptance fixture equivalent to this scenario:

1. A parent documentation task starts read-only and posts a plan.
2. No branch or pull request exists before approval.
3. Revision produces a replacement plan without repository mutation.
4. Approval creates three children: docs/alpha.md, docs/beta.md, and a README
   integration child.
5. Every child requests separate approval.
6. The README child is blocked by both document children.
7. Only approved and unblocked children implement in separate worktrees.
8. Each implementation opens a pull request and runs checks.
9. Merge approval appears only after checks pass.
10. Rejection leaves the pull request open and unmerged.
11. Approval revalidates identity, head SHA, base, and checks before merging.
12. The README child wakes only after both blockers finish.
13. The parent waits for all three terminal results and reports every result/link.

Also test failure and recovery by restarting with a plan approval pending,
restarting with a Manual blocker pending, sending approvals and webhooks twice,
failing one child's CI, canceling one child, attempting unauthorized approval, and
changing a pull-request head after its merge interaction was created.

IMPLEMENTATION AND VERIFICATION RULES

1. Work in small coherent code slices, but complete all four changes on the current
   working branch.
2. Do not change VM configuration, systemd, DNS, OAuth applications, Linear
   workspace settings, live Cyrus configuration, or unrelated repositories.
3. Do not read or copy ~/.cyrus/.env, ~/.cyrus/config.json, ~/.codex/auth.json,
   Claude authentication files, GitHub tokens, SSH private keys, or other secrets.
4. Do not commit, push, open a pull request, create a release, or merge anything.
5. Do not remove, skip, or weaken failing tests to obtain a green result.
6. Run focused tests while implementing, followed by the repository's typecheck,
   package tests, and build.
7. If a pre-existing upstream test fails, distinguish it from a regression and
   report the exact evidence.
8. If a requirement cannot be implemented safely, stop that unsafe portion and
   explain the precise source-level blocker. Continue other independent safe work.

Before finishing, provide:

- a requirement-by-requirement completion table
- files and important symbols changed
- persistence/schema changes and migration behavior
- configuration changes, if any
- focused tests added
- every verification command run and its result
- remaining incomplete requirements
- risks requiring human review

Do not claim completion while any required behavior or required test remains
missing.
```
