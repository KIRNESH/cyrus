import { describe, expect, it } from "vitest";
import {
	CustomWorkflowCoordinator,
	parsePlannedChildren,
} from "../src/CustomWorkflowCoordinator.js";

function start(
	coordinator: CustomWorkflowCoordinator,
	issueId: string,
	kind: "parent" | "feature" = "feature",
	parentWorkflowIssueId?: string,
) {
	return coordinator.startPlanning({
		issueId,
		issueIdentifier: issueId.toUpperCase(),
		issueUrl: `https://linear.test/${issueId}`,
		sessionId: `session-${issueId}`,
		linearWorkspaceId: "workspace-1",
		repositoryId: "repo-1",
		kind,
		authorizedUserId: "user-1",
		delegateId: "cyrus-app-user",
		...(parentWorkflowIssueId ? { parentWorkflowIssueId } : {}),
		teamId: "team-1",
		projectId: "project-1",
		branchName: `feature/${issueId}`,
		baseBranch: "main",
	}).workflow;
}

function plan(
	coordinator: CustomWorkflowCoordinator,
	issueId: string,
	body = "Implement the approved feature safely.",
) {
	return coordinator.completePlanning(
		issueId,
		body,
		`result-${issueId}-${body}`,
	);
}

function decidePlan(
	coordinator: CustomWorkflowCoordinator,
	issueId: string,
	decision: "Approve" | "Revise" | "Reject" | "Cancel",
	deliveryId: string,
	feedback?: string,
) {
	const workflow = coordinator.get(issueId)!;
	return coordinator.handlePlanDecision({
		issueId,
		sessionId: workflow.sessionId,
		body: `[${decision}|${workflow.planApproval!.correlationId}]${feedback ? `: ${feedback}` : ""}`,
		userId: "user-1",
		authorized: true,
		deliveryId,
	});
}

function requestMerge(
	coordinator: CustomWorkflowCoordinator,
	issueId: string,
	headSha = "0123456789abcdef0123456789abcdef01234567",
) {
	return coordinator.requestMergeApproval(
		issueId,
		{
			repositoryId: "repo-1",
			repositoryFullName: "cyrus/test",
			pullRequestNumber: 42,
			pullRequestUrl: "https://github.test/cyrus/test/pull/42",
			baseBranch: "main",
			headBranch: `feature/${issueId}`,
			headSha,
			changedFiles: ["docs/alpha.md (added, +10/-0)"],
			checks: [{ name: "test", status: "success" }],
		},
		`merge-request-${issueId}-${headSha}`,
	);
}

function approveMerge(
	coordinator: CustomWorkflowCoordinator,
	issueId: string,
	deliveryId = `merge-decision-${issueId}`,
) {
	const workflow = coordinator.get(issueId)!;
	return coordinator.handleMergeDecision({
		issueId,
		sessionId: workflow.sessionId,
		body: `[Approve|${workflow.mergeApproval!.correlationId}]`,
		userId: "user-1",
		authorized: true,
		deliveryId,
	});
}

function finishMerged(coordinator: CustomWorkflowCoordinator, issueId: string) {
	coordinator.markInReview(issueId, "implemented");
	requestMerge(coordinator, issueId);
	approveMerge(coordinator, issueId);
	return coordinator.markMerged(
		issueId,
		"merge-sha",
		`https://github.test/cyrus/test/commit/${issueId}`,
	);
}

describe("CustomWorkflowCoordinator plan gate", () => {
	it("handles approve, revise, reject, cancel, and no response without implicit approval", () => {
		for (const decision of ["Approve", "Reject", "Cancel"] as const) {
			const coordinator = new CustomWorkflowCoordinator();
			start(coordinator, decision.toLowerCase());
			plan(coordinator, decision.toLowerCase());
			const noResponse = coordinator.handlePlanDecision({
				issueId: decision.toLowerCase(),
				sessionId: `session-${decision.toLowerCase()}`,
				body: "Looks good to me",
				userId: "user-1",
				authorized: true,
				deliveryId: `no-response-${decision}`,
			});
			expect(noResponse.accepted).toBe(false);
			expect(coordinator.get(decision.toLowerCase())!.phase).toBe(
				"awaiting_plan_approval",
			);
			const result = decidePlan(
				coordinator,
				decision.toLowerCase(),
				decision,
				`decision-${decision}`,
			);
			expect(result.accepted).toBe(true);
			expect(coordinator.get(decision.toLowerCase())!.phase).toBe(
				decision === "Approve"
					? "approved_waiting"
					: decision === "Reject"
						? "rejected"
						: "canceled",
			);
		}

		const coordinator = new CustomWorkflowCoordinator();
		start(coordinator, "revise");
		const first = plan(coordinator, "revise", "First plan");
		const oldCorrelation = first.workflow.planApproval!.correlationId;
		const revision = decidePlan(
			coordinator,
			"revise",
			"Revise",
			"revision",
			"Add rollback details",
		);
		expect(revision.revisionFeedback).toBe("Add rollback details");
		expect(coordinator.get("revise")!.phase).toBe("planning");
		plan(coordinator, "revise", "Replacement plan with rollback details");
		const stale = coordinator.handlePlanDecision({
			issueId: "revise",
			sessionId: "session-revise",
			body: `[Approve|${oldCorrelation}]`,
			userId: "user-1",
			authorized: true,
			deliveryId: "stale-old-plan",
		});
		expect(stale).toMatchObject({
			accepted: false,
			reason: "Plan approval is stale",
		});
		expect(coordinator.get("revise")!.planRevision).toBe(2);
	});

	it("rejects unauthorized, stale-session, and duplicate callbacks", () => {
		const coordinator = new CustomWorkflowCoordinator();
		start(coordinator, "feature");
		plan(coordinator, "feature");
		const correlationId =
			coordinator.get("feature")!.planApproval!.correlationId;
		expect(
			coordinator.handlePlanDecision({
				issueId: "feature",
				sessionId: "session-feature",
				body: `[Approve|${correlationId}]`,
				userId: "intruder",
				authorized: false,
				deliveryId: "unauthorized",
			}),
		).toMatchObject({ accepted: false, reason: "User is not authorized" });
		expect(
			coordinator.handlePlanDecision({
				issueId: "feature",
				sessionId: "wrong-session",
				body: `[Approve|${correlationId}]`,
				userId: "user-1",
				authorized: true,
				deliveryId: "wrong-session",
			}),
		).toMatchObject({
			accepted: false,
			reason: "Approval session does not match",
		});
		const accepted = decidePlan(
			coordinator,
			"feature",
			"Approve",
			"approve-once",
		);
		expect(accepted.effect).toBe("start_implementation");
		const duplicate = coordinator.handlePlanDecision({
			issueId: "feature",
			sessionId: "session-feature",
			body: `[Approve|${correlationId}]`,
			userId: "user-1",
			authorized: true,
			deliveryId: "approve-once",
		});
		expect(duplicate.accepted).toBe(false);
		expect(coordinator.get("feature")!.phase).toBe("approved_waiting");
	});

	it("recovers a pending approval across restart and prevents Feature-label bypass", () => {
		const before = new CustomWorkflowCoordinator();
		start(before, "feature");
		plan(before, "feature");
		expect(before.get("feature")!.phase).toBe("awaiting_plan_approval");
		expect(() => before.markImplementationStarted("feature")).toThrow();

		const after = new CustomWorkflowCoordinator(before.serialize());
		expect(after.get("feature")!.planApproval?.status).toBe("pending");
		decidePlan(after, "feature", "Approve", "after-restart");
		after.markImplementationStarted("feature");
		expect(after.get("feature")!.phase).toBe("implementing");
	});
});

describe("CustomWorkflowCoordinator decomposition and aggregation", () => {
	it("parses zero, one, and multiple child plans", () => {
		expect(parsePlannedChildren("No implementation needed")).toEqual([]);
		expect(
			parsePlannedChildren(
				'<implementation_children>{"children":[{"key":"alpha","title":"Alpha","description":"Add alpha","dependencies":[]}]}</implementation_children>',
			),
		).toHaveLength(1);
		expect(
			parsePlannedChildren(
				'<implementation_children>{"children":[{"key":"alpha","title":"Alpha","description":"Add alpha","dependencies":[]},{"key":"readme","title":"README","description":"Integrate docs","dependencies":["alpha"]}]}</implementation_children>',
			),
		).toHaveLength(2);
		expect(() =>
			parsePlannedChildren(
				'<implementation_children>{"children":[{"key":"alpha","title":"Alpha","description":"Alpha","dependencies":["beta"]},{"key":"beta","title":"Beta","description":"Beta","dependencies":["alpha"]}]}</implementation_children>',
			),
		).toThrow("dependency cycle");
	});

	it("finishes a zero-child parent only after explicit approval", () => {
		const coordinator = new CustomWorkflowCoordinator();
		start(coordinator, "parent", "parent");
		plan(coordinator, "parent", "Documentation-only analysis; no code needed.");
		expect(coordinator.get("parent")!.phase).toBe("awaiting_plan_approval");
		expect(
			decidePlan(coordinator, "parent", "Approve", "parent-approve").effect,
		).toBe("finish_parent");
		expect(coordinator.get("parent")!.phase).toBe("done");
	});

	it("persists the full child set, dependencies, conservative concurrency, and all terminal results", () => {
		const coordinator = new CustomWorkflowCoordinator();
		const parent = start(coordinator, "parent", "parent");
		plan(
			coordinator,
			"parent",
			'<implementation_children>{"children":[{"key":"alpha","title":"docs/alpha.md","description":"Create alpha","dependencies":[]},{"key":"beta","title":"docs/beta.md","description":"Create beta","dependencies":[]},{"key":"readme","title":"README integration","description":"Integrate both docs","dependencies":["alpha","beta"]}]}</implementation_children>',
		);
		expect(
			decidePlan(coordinator, "parent", "Approve", "approve-parent").effect,
		).toBe("decompose");
		for (const key of ["alpha", "beta", "readme"]) {
			coordinator.registerChildIssue("parent", key, {
				issueId: key,
				issueIdentifier: key.toUpperCase(),
				issueUrl: `https://linear.test/${key}`,
			});
			start(coordinator, key, "feature", "parent");
			coordinator.bindFeatureToParent(key);
			plan(coordinator, key);
		}
		coordinator.recordDependencyRelation("parent", "alpha->readme");
		coordinator.recordDependencyRelation("parent", "beta->readme");
		coordinator.finishDecomposition("parent");

		expect(
			decidePlan(coordinator, "alpha", "Approve", "approve-alpha").effect,
		).toBe("start_implementation");
		coordinator.markImplementationStarted("alpha");
		expect(
			decidePlan(coordinator, "beta", "Approve", "approve-beta").effect,
		).toBe("wait_for_slot_or_dependencies");
		expect(
			decidePlan(coordinator, "readme", "Approve", "approve-readme").effect,
		).toBe("wait_for_slot_or_dependencies");
		expect(() => coordinator.markImplementationStarted("beta")).toThrow();
		expect(() => coordinator.markImplementationStarted("readme")).toThrow();
		expect(coordinator.getParentCompletion("parent").complete).toBe(false);

		expect(finishMerged(coordinator, "alpha")).toBe("beta");
		coordinator.markImplementationStarted("beta");
		expect(finishMerged(coordinator, "beta")).toBe("readme");
		coordinator.markImplementationStarted("readme");
		finishMerged(coordinator, "readme");

		const completion = coordinator.getParentCompletion("parent");
		expect(completion.complete).toBe(true);
		expect(completion.results.map(({ result }) => result.status)).toEqual([
			"done",
			"done",
			"done",
		]);
		coordinator.markParentDone("parent");
		expect(parent.phase).toBe("done");
		expect(parent.dependencyRelations).toEqual([
			"alpha->readme",
			"beta->readme",
		]);
	});

	it("reports failed, rejected, and canceled children instead of success", () => {
		const coordinator = new CustomWorkflowCoordinator();
		start(coordinator, "parent", "parent");
		plan(
			coordinator,
			"parent",
			'<implementation_children>{"children":[{"key":"failed","title":"Failed","description":"Fails","dependencies":[]},{"key":"rejected","title":"Rejected","description":"Rejected","dependencies":[]},{"key":"canceled","title":"Canceled","description":"Canceled","dependencies":[]}]}</implementation_children>',
		);
		decidePlan(coordinator, "parent", "Approve", "parent-approve");
		for (const key of ["failed", "rejected", "canceled"]) {
			coordinator.registerChildIssue("parent", key, { issueId: key });
			start(coordinator, key, "feature", "parent");
			coordinator.bindFeatureToParent(key);
			plan(coordinator, key);
		}
		coordinator.finishDecomposition("parent");
		decidePlan(coordinator, "failed", "Approve", "failed-approve");
		coordinator.markImplementationStarted("failed");
		coordinator.markFailed("failed", "CI failed");
		decidePlan(coordinator, "rejected", "Reject", "rejected-plan");
		decidePlan(coordinator, "canceled", "Cancel", "canceled-plan");
		const completion = coordinator.getParentCompletion("parent");
		expect(completion.complete).toBe(true);
		expect(completion.results.map(({ result }) => result.status)).toEqual([
			"failed",
			"rejected",
			"canceled",
		]);
	});

	it("keeps the conservative child slot while an implementation is Manual-blocked", () => {
		const coordinator = new CustomWorkflowCoordinator();
		start(coordinator, "parent", "parent");
		plan(
			coordinator,
			"parent",
			'<implementation_children>{"children":[{"key":"alpha","title":"Alpha","description":"Alpha","dependencies":[]},{"key":"beta","title":"Beta","description":"Beta","dependencies":[]}]}</implementation_children>',
		);
		decidePlan(coordinator, "parent", "Approve", "parent-approve");
		for (const key of ["alpha", "beta"]) {
			coordinator.registerChildIssue("parent", key, { issueId: key });
			start(coordinator, key, "feature", "parent");
			coordinator.bindFeatureToParent(key);
			plan(coordinator, key);
		}
		coordinator.finishDecomposition("parent");
		decidePlan(coordinator, "alpha", "Approve", "alpha-approve");
		coordinator.markImplementationStarted("alpha");
		coordinator.addManualBlocker("alpha", {
			key: "account",
			issueId: "manual-account",
			issueIdentifier: "MAN-1",
			verify: "Inspect non-secret account status",
		});
		expect(
			decidePlan(coordinator, "beta", "Approve", "beta-approve").effect,
		).toBe("wait_for_slot_or_dependencies");
		expect(coordinator.isFeatureReady("beta")).toBe(false);
	});

	it("fails descendants instead of stranding them when a dependency is unsuccessful", () => {
		const coordinator = new CustomWorkflowCoordinator();
		start(coordinator, "parent", "parent");
		plan(
			coordinator,
			"parent",
			'<implementation_children>{"children":[{"key":"alpha","title":"Alpha","description":"Alpha","dependencies":[]},{"key":"readme","title":"README","description":"README","dependencies":["alpha"]}]}</implementation_children>',
		);
		decidePlan(coordinator, "parent", "Approve", "parent-approve");
		for (const key of ["alpha", "readme"]) {
			coordinator.registerChildIssue("parent", key, { issueId: key });
			start(coordinator, key, "feature", "parent");
			coordinator.bindFeatureToParent(key);
			plan(coordinator, key);
		}
		coordinator.recordDependencyRelation("parent", "alpha->readme");
		coordinator.finishDecomposition("parent");
		decidePlan(coordinator, "alpha", "Approve", "alpha-approve");
		coordinator.markImplementationStarted("alpha");
		coordinator.markFailed("alpha", "CI failed");

		expect(coordinator.settleDependencyFailures("parent")).toEqual(["readme"]);
		expect(coordinator.get("readme")!.phase).toBe("failed");
		expect(coordinator.getParentCompletion("parent").complete).toBe(true);
		expect(
			coordinator.getParentCompletion("parent").results[1]?.result.result,
		).toContain("unsuccessful dependency alpha");
	});
});

describe("CustomWorkflowCoordinator Manual and merge gates", () => {
	it("parks, recovers, verifies, retries failure, and deduplicates Manual blockers", () => {
		const coordinator = new CustomWorkflowCoordinator();
		start(coordinator, "manual");
		plan(coordinator, "manual");
		decidePlan(coordinator, "manual", "Approve", "approve-manual");
		coordinator.markImplementationStarted("manual");
		const first = coordinator.addManualBlocker("manual", {
			key: "dns",
			issueId: "manual-dns",
			issueIdentifier: "MAN-1",
			verify: "Resolve the public DNS record without mutation",
		});
		expect(first.created).toBe(true);
		expect(
			coordinator.addManualBlocker("manual", {
				key: "dns",
				issueId: "different-id",
				issueIdentifier: "MAN-2",
				verify: "different",
			}).created,
		).toBe(false);

		const restored = new CustomWorkflowCoordinator(coordinator.serialize());
		expect(restored.get("manual")!.phase).toBe("blocked_manual");
		expect(restored.manualIssueCompleted("manual-dns")).toHaveLength(1);
		expect(restored.manualIssueCompleted("manual-dns")).toHaveLength(0);
		expect(
			restored.recordManualVerification("manual", "dns", false, "DNS missing"),
		).toEqual({ resumeImplementation: false });
		expect(restored.get("manual")!.phase).toBe("blocked_manual");
		restored.manualIssueCompleted("manual-dns");
		expect(
			restored.recordManualVerification("manual", "dns", true, "DNS resolves"),
		).toEqual({ resumeImplementation: true });
		expect(restored.get("manual")!.phase).toBe("manual_verified");
		restored.markImplementationResumed("manual");
		expect(restored.get("manual")!.phase).toBe("implementing");
		expect(
			restored.recordManualVerification("manual", "dns", true, "DNS resolves"),
		).toEqual({ resumeImplementation: false });
	});

	it("requires explicit authorized correlated merge decisions and survives restart", () => {
		const coordinator = new CustomWorkflowCoordinator();
		start(coordinator, "merge");
		plan(coordinator, "merge");
		decidePlan(coordinator, "merge", "Approve", "approve-feature");
		coordinator.markImplementationStarted("merge");
		coordinator.markInReview("merge");
		requestMerge(coordinator, "merge");
		const restored = new CustomWorkflowCoordinator(coordinator.serialize());
		const correlation = restored.get("merge")!.mergeApproval!.correlationId;
		const noResponse = restored.handleMergeDecision({
			issueId: "merge",
			sessionId: "session-merge",
			body: "Ship it",
			userId: "user-1",
			authorized: true,
			deliveryId: "merge-no-response",
		});
		expect(noResponse.accepted).toBe(false);
		const unauthorized = restored.handleMergeDecision({
			issueId: "merge",
			sessionId: "session-merge",
			body: `[Approve|${correlation}]`,
			userId: "intruder",
			authorized: false,
			deliveryId: "merge-unauthorized",
		});
		expect(unauthorized.reason).toBe("User is not authorized");
		expect(approveMerge(restored, "merge", "merge-approved").effect).toBe(
			"merge",
		);
		expect(
			restored.handleMergeDecision({
				issueId: "merge",
				sessionId: "session-merge",
				body: `[Approve|${correlation}]`,
				userId: "user-1",
				authorized: true,
				deliveryId: "merge-approved",
			}).accepted,
		).toBe(false);
	});

	it("Reject leaves the pull request in review and allows a fresh approval", () => {
		const coordinator = new CustomWorkflowCoordinator();
		start(coordinator, "reject");
		plan(coordinator, "reject");
		decidePlan(coordinator, "reject", "Approve", "reject-plan");
		coordinator.markImplementationStarted("reject");
		coordinator.markInReview("reject");
		requestMerge(coordinator, "reject");
		const workflow = coordinator.get("reject")!;
		const result = coordinator.handleMergeDecision({
			issueId: "reject",
			sessionId: workflow.sessionId,
			body: `[Reject|${workflow.mergeApproval!.correlationId}]`,
			userId: "user-1",
			authorized: true,
			deliveryId: "reject-decision",
		});
		expect(result.effect).toBe("return_to_review");
		expect(workflow.phase).toBe("in_review");
		expect(workflow.mergeApproval?.status).toBe("rejected");

		const refreshed = requestMerge(coordinator, "reject");
		expect(refreshed.accepted).toBe(true);
		expect(refreshed.approval.status).toBe("pending");
		expect(approveMerge(coordinator, "reject").effect).toBe("merge");
	});

	it("Cancel leaves merge terminal without entering merging", () => {
		const coordinator = new CustomWorkflowCoordinator();
		const issueId = "cancel";
		start(coordinator, issueId);
		plan(coordinator, issueId);
		decidePlan(coordinator, issueId, "Approve", `${issueId}-plan`);
		coordinator.markImplementationStarted(issueId);
		coordinator.markInReview(issueId);
		requestMerge(coordinator, issueId);
		const workflow = coordinator.get(issueId)!;
		const result = coordinator.handleMergeDecision({
			issueId,
			sessionId: workflow.sessionId,
			body: `[Cancel|${workflow.mergeApproval!.correlationId}]`,
			userId: "user-1",
			authorized: true,
			deliveryId: `${issueId}-decision`,
		});
		expect(result.effect).toBe("terminal");
		expect(workflow.phase).toBe("canceled");
	});

	it("invalidates a merge approval when the PR head changes", () => {
		const coordinator = new CustomWorkflowCoordinator();
		start(coordinator, "stale");
		plan(coordinator, "stale");
		decidePlan(coordinator, "stale", "Approve", "stale-plan");
		coordinator.markImplementationStarted("stale");
		coordinator.markInReview("stale");
		requestMerge(coordinator, "stale");
		approveMerge(coordinator, "stale");
		coordinator.markMergeStale("stale", "head SHA changed");
		expect(coordinator.get("stale")!.phase).toBe("in_review");
		expect(coordinator.get("stale")!.mergeApproval?.status).toBe("stale");
	});
});
