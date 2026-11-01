# Persistent approval workflow gap analysis

Audit date: 2026-10-20

This audit compares the current `custom-workflow-v1` source tree with
`docs/custom-workflow/implementation-prompt.md`. Status means:

- **Existing** — current runtime behavior already satisfies the requirement.
- **Partial** — a reusable primitive exists, but the required workflow or safety
  property is not complete.
- **Missing** — no connected runtime implementation currently satisfies it.

## Current reusable architecture

| Area | Current source and tests | Finding |
| --- | --- | --- |
| Issue/session lifecycle | `EdgeWorker.handleAgentSessionCreatedWebhook`, `EdgeWorker.initializeAgentRunner`, `EdgeWorker.createCyrusAgentSession`; `AgentSessionManager.createCyrusAgentSession` / `completeSession`; `EdgeWorker.child-session-created-webhook.test.ts` | Mature runner-independent session lifecycle, but `createCyrusAgentSession` moves the issue to Started and creates a Git worktree before the first runner prompt. |
| Runner permissions | `ToolPermissionResolver.buildAllowedTools` / `buildDisallowedTools`; `RunnerConfigBuilder.buildIssueConfig` / `buildSandboxConfig`; `RunnerConfigBuilder.codex-sandbox.test.ts`, `EdgeWorker.dynamic-tools.test.ts` | Centralized Claude/Codex-compatible permission construction exists. There is no non-configurable planning policy that removes every repository mutation path. |
| Elicitation | `AskUserQuestionHandler.handleAskUserQuestion`; `AgentSessionManager.createElicitationActivity` / `createApprovalElicitation`; `AskUserQuestionHandler.test.ts`, `LinearActivitySink.test.ts` | Linear select/auth activities exist. `AskUserQuestionHandler` is in-memory; `SharedApplicationServer.registerApprovalRequest` is in-memory, expires after 30 minutes, is rejected at shutdown, and no `/approval` callback route is registered. |
| Persistence/recovery | `PersistenceManager`, `EdgeWorker.serializeMappings` / `restoreMappings`; `PersistenceManager.migration.test.ts`, `PersistenceManager.atomic-write.test.ts`, `EdgeWorker.missing-session-recovery.test.ts` | Atomic, versioned session persistence exists (v4.0), but it contains no plan approvals, merge approvals, expected child sets, Manual blockers, or parked-session payloads. |
| Authorization | `UserAccessControl.checkAccess`, `EdgeWorker.checkUserAccess`; `UserAccessControl.test.ts` | Global/repository allow/block policy exists. It is checked for session creation and ordinary prompts, but not for a durable approval action correlated to the responding activity's user. |
| Linear issue/relation APIs | `IIssueTrackerService`; `LinearIssueTrackerService`; `CLIIssueTrackerService.createIssue`; SDK-backed `Issue.inverseRelations`; cyrus-tools `linear_set_issue_relation` | Reads, updates, activities, and agent sessions are abstracted. `createIssue` and `createIssueRelation` are absent from `IIssueTrackerService`/`LinearIssueTrackerService`, and shared inputs omit `projectId`/`delegateId`. |
| Parent/child tracking | `GlobalSessionRegistry.setParentSession`; `EdgeWorker.linkChildSessionToParentIssueSession`; `AgentSessionManager.handleChildSessionCompletion`; `GlobalSessionRegistry.test.ts`, `AgentSessionManager.child-completion-pending-work.test.ts` | Session links persist, but each completed child resumes the parent immediately. There is no persisted expected set or aggregate terminal-result gate. |
| Blocker wake-up | `EdgeWorker.checkBlockedByDependencies`, `handleIssueStateChange`, `handleParkedSessionReprompt`; `EdgeWorker.child-session-created-webhook.test.ts` | Linear blocked-by parking/wake-up exists. Parked state is memory-only, errors fail open, canceled blockers are treated as resolved, and no Manual verification phase exists. |
| Pull requests/merge | Agents create PRs through tools/skills; `RunnerConfigBuilder` PR marker/stop hooks; `EdgeWorker.fetchPRBranchRefs`; `PrMarkerHook.test.ts`, `RunnerConfigBuilder.stop-hook-guardrail.test.ts`, `EdgeWorker.fetchPRBranchRef.test.ts` | PR-oriented prompts/hooks exist, but there is no PR ownership record, required-check service, persistent merge interaction, revalidation, or merge API path. |

## Change 1 — persistent plan approval gate

| # | Status | Evidence and gap |
| --- | --- | --- |
| 1 | **Partial** | Scoper label prompts exist through `PromptBuilder.determineSystemPromptFromLabels`, but new PRD/Feature delegations are not forced through a planning state. Feature commonly selects builder directly. |
| 2 | **Missing** | `EdgeWorker.createCyrusAgentSession` creates a worktree and writes `.claude/settings.local.json` before the runner starts. Configurable tool lists can still include `Bash`, write tools, GitHub, and mutating MCP tools. |
| 3 | **Partial** | Activities and select/auth signals exist, but no code captures a completed plan, correlates/persists an approval, or parks the workflow. |
| 4 | **Missing** | There is no parent-vs-feature approval transition to orchestration vs implementation. |
| 5 | **Missing** | No plan revision counter, stale-approval invalidation, read-only revise turn, or replacement interaction exists. |
| 6 | **Missing** | Stop handling exists, but no explicit Reject/Cancel terminal transitions for a plan approval. |
| 7 | **Existing** | Existing code never implicitly interprets an absent callback as approval; however, this property is not yet embodied in a plan state machine. |
| 8 | **Missing** | Neither `SerializableEdgeWorkerState` nor session metadata stores pending plan approval correlation. |
| 9 | **Partial** | Issue update delivery has `processedIssueUpdateKeys`; plan webhook/callback delivery has no durable idempotency key. |
| 10 | **Partial** | `UserAccessControl` is reusable, but the actual responding activity user is not checked at an approval action point. |
| 11 | **Partial** | `IAgentRunner` and `RunnerConfigBuilder` are runner-independent and have Codex coverage, but approval behavior is not connected to them. |

## Change 2 — approved product decomposition

| # | Status | Evidence and gap |
| --- | --- | --- |
| 1 | **Missing** | No approved-parent state exists, so decomposition is not gated by it. |
| 2 | **Partial** | Linear and CLI SDKs can create issues, but only `CLIIssueTrackerService` exposes `createIssue`; no runtime decomposition service exists. |
| 3 | **Partial** | Shared `IssueCreateInput` has team/state/parent/labels, but lacks project/delegate fields in its declared contract and the Linear adapter has no create method. |
| 4 | **Partial** | Linear SDK `IssueCreateInput.delegateId` is available; current shared abstraction does not expose/use it for children. |
| 5 | **Missing** | Feature routing can select builder; no gate prevents a child-label bypass. |
| 6 | **Partial** | Every normal session gets an isolated worktree, but it is allocated before approval. |
| 7 | **Missing** | Persistence stores only child-session-to-parent-session links, not an expected child issue set or results. |
| 8 | **Missing** | `AgentSessionManager.handleChildSessionCompletion` resumes after every child; it cannot wait for the full set. |
| 9 | **Missing** | No complete-set terminal aggregation or final parent summary gate exists. |
| 10 | **Missing** | No typed child result captures success/failed/rejected/canceled outcomes. |
| 11 | **Missing** | No decomposition idempotency key or child creation journal exists. |
| 12 | **Partial** | Global `SessionSemaphore` can cap all runner concurrency, but there is no per-parent single-child implementation lease. |
| 13 | **Partial** | Persistent Linear relations and blocked-by inspection exist; parked state is volatile and canceled/failed blockers do not enforce successful resolution. |

## Change 3 — Manual issues and human-only blockers

| # | Status | Evidence and gap |
| --- | --- | --- |
| 1 | **Missing** | No Manual issue service, Manual label resolution, authorized-human assignment, or non-delegation invariant exists. |
| 2 | **Partial** | cyrus-tools can create a `blocks` relation, but no runtime Manual flow creates it automatically. |
| 3 | **Partial** | General blocked-by sessions park, but the map is not persisted and there is no Manual correlation. |
| 4 | **Missing** | No exact Manual body formatter/validator exists. |
| 5 | **Missing** | Generic wake-up starts the normal runner immediately; it does not run and gate on the declared non-secret Verify step. |
| 6 | **Missing** | There is no verification result state that keeps a failed verification blocked. |
| 7 | **Partial** | Secrets are not intentionally requested by current blocker code, but no Manual input sanitizer/redactor or prohibition is enforced. |
| 8 | **Missing** | No blocker fingerprint/idempotency mechanism exists. |
| 9 | **Missing** | `parkedSessions` and Manual wake-up data are absent from persisted state. |

## Change 4 — protected merge approval

| # | Status | Evidence and gap |
| --- | --- | --- |
| 1 | **Missing** | No service observes a Cyrus PR plus required-check completion and creates a merge interaction. |
| 2 | **Missing** | No persisted PR snapshot or interaction body contains the required repository/branch/SHA/files/checks/preview fields. |
| 3 | **Existing** | Cyrus has no automatic merge today, so absence/Reject/Cancel cannot currently merge; the explicit merge state machine is missing. |
| 4 | **Missing** | No merge approval action-point authorization exists. |
| 5 | **Partial** | `fetchPRBranchRefs` verifies a PR for GitHub comment workspaces, but merge-time repository/PR/open/base/head/SHA/check validation does not exist. |
| 6 | **Missing** | There is no stale-approval refusal or refreshed approval behavior. |
| 7 | **Existing** | No admin-bypass merge code exists. A new merge path must preserve this. |
| 8 | **Missing** | No repository merge-policy selection, merge call, or post-success branch deletion exists. |
| 9 | **Missing** | Outstanding merge approval is not represented in persistence. |
| 10 | **Missing** | No durable callback idempotency or already-merged convergence exists. |
| 11 | **Missing** | No merge result posts PR and commit links to the Linear session. |

## Cross-cutting requirements

| # | Status | Evidence and gap |
| --- | --- | --- |
| 1 | **Partial** | Existing lifecycle is well tested, but interception must be limited to explicitly recognized PRD/product and Feature workflows. |
| 2 | **Partial** | Shared runner abstractions and Codex tests exist; the new workflow needs mode-specific compatibility tests. |
| 3 | **Partial** | Persistence is typed/versioned and atomic, but adding workflow state requires a v4-to-v5 compatible migration/default. |
| 4 | **Missing** | Exact plan revision, repository, PR, and head-SHA approval correlation is absent. |
| 5 | **Partial** | Repository routing/access checks validate some identifiers, but action-point revalidation for approvals and merge is absent. |
| 6 | **Partial** | Existing logging avoids deliberate token output; no workflow-specific secret redaction exists. |
| 7 | **Partial** | Some issue updates deduplicate in memory; durable workflow operations are not restart/idempotency safe. |
| 8 | **Existing** | No new workflow configuration exists. If none is introduced, no config documentation is required. |
| 9 | **Partial** | Current sandbox/tool controls can be reused, but the planning invariant requires an immutable narrower policy rather than operator-configurable defaults. |

## Schema, compatibility, configuration, and recovery risks

1. **Persistence version:** adding workflow records to the state document must
   migrate v4.0 files without discarding sessions. Missing workflow state must
   default to an empty versioned store. Unknown future versions must remain
   fail-safe.
2. **Crash consistency:** child creation, relation creation, and delegation are
   separate remote mutations. State must journal deterministic child identities
   and reconcile existing children after a crash so retries do not duplicate them.
3. **Old sessions:** sessions without workflow state must retain current behavior.
   Only newly recognized PRD/product or Feature delegations enter the new gate.
4. **Parked payloads:** webhook-rich objects are unsafe to serialize wholesale.
   Recovery should persist stable identifiers and reconstruct remote objects from
   the issue tracker.
5. **Identity:** the session creator is not necessarily the approval responder.
   The prompted activity `userId` must be fetched and checked through the existing
   access-control policy at every decision.
6. **Permissions:** allowlists differ by runner. The planning mode must use a
   provider-neutral read-only set and explicit mutation denials, and must not
   create a worktree or write local settings before approval.
7. **Linear delivery:** select response payload details can vary. Values should
   carry an opaque correlation token; plain text or an unrelated prompt must not
   approve.
8. **Child delegation:** Linear's supported `delegateId` field is available in
   SDK v60.0.0. The parent delegate/app-user ID must be captured, validated, and
   reused; Manual issues must omit it.
9. **Merge checks:** GitHub check-runs, commit statuses, and branch-protection
   required contexts can disagree or be temporarily incomplete. Approval must be
   created only from a stable passing snapshot and approval must re-fetch it.
10. **GitHub token lifetime:** installation tokens may rotate. Resolve the token
    at each observation/merge action; never persist or log it.
11. **Branch deletion:** delete only a same-repository feature branch after a
    confirmed merge. Never delete a fork branch or the base/default branch.
12. **Manual secrets:** Manual data is persisted and posted to Linear. Reject or
    redact credential-like material before either action, and permit only
    non-secret verification descriptions/results.
13. **Concurrency:** global runner limits do not guarantee one child per parent.
    A persistent parent-scoped implementation lease is required and must be
    reconstructed after restart.
14. **No configuration mapping is required:** the requested behavior can be
    driven by explicit PRD/product and Feature labels plus runtime state, avoiding
    a new unconnected config key.

## Implementation direction

Add one runner-independent workflow coordinator backed by the existing
`PersistenceManager`, issue-tracker abstraction, activity sink, runner config
builder, worktree creation, and user access control. Extend those abstractions
only where the current contracts lack issue/relation creation or lifecycle
callbacks. Do not use `SharedApplicationServer`'s volatile approval map as the
source of truth.
