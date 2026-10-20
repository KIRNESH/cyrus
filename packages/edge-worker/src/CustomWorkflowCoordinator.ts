import { createHash, randomUUID } from "node:crypto";
import {
	type CustomWorkflowKind,
	type CustomWorkflowPhase,
	createEmptyCustomWorkflowState,
	isCustomWorkflowTerminal,
	type ManualBlockerRecord,
	type PersistentChildResult,
	type PersistentCustomWorkflow,
	type PersistentCustomWorkflowState,
	type PlannedChildSpec,
	type PullRequestApprovalRecord,
} from "cyrus-core";

const DECISION_PATTERN =
	/^\[(Approve|Revise|Reject|Cancel)\|([^\]]+)](?:\s*[:-]\s*([\s\S]+))?$/i;

const ACTIVE_CHILD_PHASES = new Set<CustomWorkflowPhase>([
	"implementing",
	"in_review",
	"awaiting_merge_approval",
	"merging",
	"blocked_manual",
	"verifying_manual",
	"manual_verified",
]);

export interface StartPlanningInput {
	issueId: string;
	issueIdentifier: string;
	issueUrl?: string;
	sessionId: string;
	linearWorkspaceId: string;
	repositoryId: string;
	kind: CustomWorkflowKind;
	authorizedUserId: string;
	delegateId?: string;
	parentIssueId?: string;
	parentWorkflowIssueId?: string;
	teamId: string;
	projectId?: string;
	branchName?: string;
	baseBranch?: string;
}

export interface PlanDecisionResult {
	accepted: boolean;
	reason?: string;
	decision?: "approve" | "revise" | "reject" | "cancel";
	revisionFeedback?: string;
	effect?:
		| "decompose"
		| "start_implementation"
		| "wait_for_slot_or_dependencies"
		| "finish_parent"
		| "terminal";
}

export interface MergeDecisionResult {
	accepted: boolean;
	reason?: string;
	decision?: "approve" | "reject" | "cancel";
	effect?: "merge" | "return_to_review" | "terminal";
}

export interface PullRequestApprovalInput {
	repositoryId: string;
	repositoryFullName: string;
	pullRequestNumber: number;
	pullRequestUrl: string;
	baseBranch: string;
	headBranch: string;
	headSha: string;
	changedFiles: string[];
	checks: PullRequestApprovalRecord["checks"];
	previewUrl?: string;
}

export interface ManualBlockerInput {
	key: string;
	issueId: string;
	issueIdentifier: string;
	issueUrl?: string;
	verify: string;
}

export interface ParentCompletion {
	complete: boolean;
	results: Array<{
		key: string;
		title: string;
		result: PersistentChildResult;
	}>;
}

/** Build the exact Linear response used when every planned child is terminal. */
export function formatParentCompletionSummary(
	completion: ParentCompletion,
): string {
	const lines = completion.results.map(({ title, result }) => {
		const issueLink = result.issueUrl
			? `[${result.issueIdentifier ?? title}](${result.issueUrl})`
			: (result.issueIdentifier ?? title);
		const links = [
			result.pullRequestUrl
				? `[pull request](${result.pullRequestUrl})`
				: undefined,
			result.mergeCommitUrl
				? `[merge commit](${result.mergeCommitUrl})`
				: undefined,
		]
			.filter(Boolean)
			.join(", ");
		return `- ${issueLink}: **${result.status}**${result.result ? ` — ${result.result}` : ""}${links ? ` (${links})` : ""}`;
	});
	return `All planned children are terminal.\n\n${lines.join("\n")}`;
}

/**
 * Runner-independent state machine for plan, child, Manual, and merge gates.
 *
 * It deliberately performs no remote I/O. EdgeWorker owns Linear/GitHub/worktree
 * effects and persists this state after every accepted transition.
 */
export class CustomWorkflowCoordinator {
	private state: PersistentCustomWorkflowState;

	constructor(state?: PersistentCustomWorkflowState) {
		this.state = state ?? createEmptyCustomWorkflowState();
		if (this.state.version !== 1) {
			throw new Error(
				`Unsupported custom workflow state version ${String(this.state.version)}`,
			);
		}
		for (const workflow of Object.values(this.state.workflows)) {
			workflow.dependencyRelations ??= [];
			workflow.decompositionComplete ??= false;
		}
	}

	serialize(): PersistentCustomWorkflowState {
		return structuredClone(this.state);
	}

	restore(state?: PersistentCustomWorkflowState): void {
		this.state = state ?? createEmptyCustomWorkflowState();
		if (this.state.version !== 1) {
			throw new Error(
				`Unsupported custom workflow state version ${String(this.state.version)}`,
			);
		}
		for (const workflow of Object.values(this.state.workflows)) {
			workflow.dependencyRelations ??= [];
			workflow.decompositionComplete ??= false;
		}
	}

	get(issueId: string): PersistentCustomWorkflow | undefined {
		return this.state.workflows[issueId];
	}

	getBySessionId(sessionId: string): PersistentCustomWorkflow | undefined {
		return Object.values(this.state.workflows).find(
			(workflow) => workflow.sessionId === sessionId,
		);
	}

	list(): PersistentCustomWorkflow[] {
		return Object.values(this.state.workflows);
	}

	startPlanning(input: StartPlanningInput): {
		workflow: PersistentCustomWorkflow;
		created: boolean;
	} {
		const existing = this.state.workflows[input.issueId];
		if (existing) {
			return { workflow: existing, created: false };
		}

		const now = Date.now();
		const workflow: PersistentCustomWorkflow = {
			...input,
			phase: "planning",
			planRevision: 0,
			plannedChildren: [],
			children: {},
			decompositionComplete: false,
			dependencyRelations: [],
			manualBlockers: {},
			createdAt: now,
			updatedAt: now,
		};
		this.state.workflows[input.issueId] = workflow;
		return { workflow, created: true };
	}

	completePlanning(
		issueId: string,
		plan: string,
		deliveryId: string,
	): {
		accepted: boolean;
		duplicate: boolean;
		workflow: PersistentCustomWorkflow;
		options: string[];
	} {
		const workflow = this.require(issueId);
		if (this.isDuplicate(deliveryId)) {
			return {
				accepted: false,
				duplicate: true,
				workflow,
				options: this.planDecisionOptions(workflow),
			};
		}
		if (workflow.phase !== "planning") {
			throw new Error(
				`Cannot complete planning for ${issueId} from phase ${workflow.phase}`,
			);
		}

		const normalizedPlan = plan.trim();
		if (!normalizedPlan) {
			throw new Error("A plan cannot be empty");
		}

		const plannedChildren =
			workflow.kind === "parent" ? parsePlannedChildren(normalizedPlan) : [];
		const revision = workflow.planRevision + 1;
		const planDigest = digest(normalizedPlan);
		const correlationId = `plan-${revision}-${planDigest.slice(0, 20)}`;

		workflow.plan = normalizedPlan;
		workflow.planRevision = revision;
		workflow.plannedChildren = plannedChildren;
		workflow.planApproval = {
			correlationId,
			revision,
			planDigest,
			status: "pending",
			createdAt: Date.now(),
		};
		workflow.phase = "awaiting_plan_approval";
		workflow.updatedAt = Date.now();
		this.markProcessed(deliveryId);

		return {
			accepted: true,
			duplicate: false,
			workflow,
			options: this.planDecisionOptions(workflow),
		};
	}

	handlePlanDecision(input: {
		issueId: string;
		sessionId: string;
		body: string;
		userId: string;
		authorized: boolean;
		deliveryId: string;
	}): PlanDecisionResult {
		const workflow = this.require(input.issueId);
		if (workflow.sessionId !== input.sessionId) {
			return { accepted: false, reason: "Approval session does not match" };
		}
		if (!input.authorized) {
			return { accepted: false, reason: "User is not authorized" };
		}
		if (this.isDuplicate(input.deliveryId)) {
			return { accepted: false, reason: "Duplicate delivery" };
		}
		if (
			workflow.phase !== "awaiting_plan_approval" ||
			workflow.planApproval?.status !== "pending"
		) {
			return { accepted: false, reason: "No plan approval is pending" };
		}

		const parsed = parseDecision(input.body);
		if (!parsed) {
			return { accepted: false, reason: "Prompt is not an approval decision" };
		}
		if (parsed.correlationId !== workflow.planApproval.correlationId) {
			return { accepted: false, reason: "Plan approval is stale" };
		}

		if (parsed.decision === "revise" && !parsed.feedback?.trim()) {
			return {
				accepted: false,
				reason: "Revision instructions are required",
			};
		}

		const now = Date.now();
		workflow.planApproval.status =
			parsed.decision === "approve"
				? "approved"
				: parsed.decision === "revise"
					? "revised"
					: parsed.decision === "reject"
						? "rejected"
						: "canceled";
		workflow.planApproval.decidedAt = now;
		workflow.planApproval.decidedByUserId = input.userId;
		workflow.updatedAt = now;
		this.markProcessed(input.deliveryId);

		switch (parsed.decision) {
			case "revise":
				workflow.phase = "planning";
				return {
					accepted: true,
					decision: "revise",
					revisionFeedback: parsed.feedback!.trim(),
				};
			case "reject":
				workflow.phase = "rejected";
				this.syncParentChild(workflow, "Plan rejected");
				return {
					accepted: true,
					decision: "reject",
					effect: "terminal",
				};
			case "cancel":
				workflow.phase = "canceled";
				this.syncParentChild(workflow, "Plan canceled");
				return {
					accepted: true,
					decision: "cancel",
					effect: "terminal",
				};
			case "approve":
				if (workflow.kind === "parent") {
					if (workflow.plannedChildren.length === 0) {
						workflow.phase = "done";
						return {
							accepted: true,
							decision: "approve",
							effect: "finish_parent",
						};
					}
					workflow.phase = "orchestrating";
					return {
						accepted: true,
						decision: "approve",
						effect: "decompose",
					};
				}

				workflow.phase = "approved_waiting";
				this.syncParentChild(workflow);
				return {
					accepted: true,
					decision: "approve",
					effect: this.canStartFeature(workflow)
						? "start_implementation"
						: "wait_for_slot_or_dependencies",
				};
		}
	}

	registerChildIssue(
		parentIssueId: string,
		childKey: string,
		child: Omit<PersistentChildResult, "status">,
	): void {
		const parent = this.require(parentIssueId);
		const spec = parent.plannedChildren.find((entry) => entry.key === childKey);
		if (!spec) {
			throw new Error(`Unknown child key ${childKey}`);
		}
		const existing = parent.children[childKey];
		if (existing?.issueId && existing.issueId !== child.issueId) {
			throw new Error(`Child ${childKey} is already bound to another issue`);
		}
		parent.children[childKey] = {
			status: existing?.status ?? "pending",
			...existing,
			...child,
		};
		parent.updatedAt = Date.now();
	}

	finishDecomposition(parentIssueId: string): void {
		const parent = this.require(parentIssueId);
		if (parent.phase !== "orchestrating") {
			throw new Error(`Parent ${parentIssueId} is not orchestrating`);
		}
		for (const spec of parent.plannedChildren) {
			if (!parent.children[spec.key]?.issueId) {
				throw new Error(`Child ${spec.key} has not been created`);
			}
			for (const dependency of spec.dependencies) {
				const relationKey = `${dependency}->${spec.key}`;
				if (!parent.dependencyRelations.includes(relationKey)) {
					throw new Error(
						`Dependency relation ${relationKey} has not been created`,
					);
				}
			}
		}
		parent.decompositionComplete = true;
		parent.updatedAt = Date.now();
	}

	hasDependencyRelation(parentIssueId: string, relationKey: string): boolean {
		return this.require(parentIssueId).dependencyRelations.includes(
			relationKey,
		);
	}

	recordDependencyRelation(parentIssueId: string, relationKey: string): void {
		const parent = this.require(parentIssueId);
		if (!parent.dependencyRelations.includes(relationKey)) {
			parent.dependencyRelations.push(relationKey);
			parent.updatedAt = Date.now();
		}
	}

	bindFeatureToParent(issueId: string): void {
		const workflow = this.require(issueId);
		this.syncParentChild(workflow);
	}

	markImplementationStarted(issueId: string): void {
		const workflow = this.require(issueId);
		if (workflow.kind !== "feature" || workflow.phase !== "approved_waiting") {
			throw new Error(
				`Cannot start implementation for ${issueId} from ${workflow.phase}`,
			);
		}
		if (!this.canStartFeature(workflow)) {
			throw new Error(
				"Child dependencies or parent concurrency slot are not ready",
			);
		}
		workflow.phase = "implementing";
		workflow.updatedAt = Date.now();
		this.syncParentChild(workflow);
	}

	markInReview(issueId: string, result?: string): void {
		const workflow = this.require(issueId);
		if (workflow.phase !== "implementing") {
			throw new Error(`Cannot enter review from ${workflow.phase}`);
		}
		workflow.phase = "in_review";
		workflow.updatedAt = Date.now();
		this.syncParentChild(workflow, result);
	}

	requestMergeApproval(
		issueId: string,
		input: PullRequestApprovalInput,
		deliveryId: string,
	): {
		accepted: boolean;
		duplicate: boolean;
		approval: PullRequestApprovalRecord;
	} {
		const workflow = this.require(issueId);
		if (
			this.isDuplicate(deliveryId) &&
			workflow.mergeApproval?.status === "pending"
		) {
			return {
				accepted: false,
				duplicate: true,
				approval: workflow.mergeApproval,
			};
		}
		if (workflow.phase !== "implementing" && workflow.phase !== "in_review") {
			throw new Error(`Cannot request merge approval from ${workflow.phase}`);
		}

		const correlationId = `merge-${input.pullRequestNumber}-${input.headSha.slice(0, 16)}-${randomUUID().slice(0, 8)}`;
		const approval: PullRequestApprovalRecord = {
			...input,
			correlationId,
			status: "pending",
			createdAt: Date.now(),
		};
		workflow.mergeApproval = approval;
		workflow.phase = "awaiting_merge_approval";
		workflow.updatedAt = Date.now();
		this.markProcessed(deliveryId);
		this.syncParentChild(workflow);
		return { accepted: true, duplicate: false, approval };
	}

	handleMergeDecision(input: {
		issueId: string;
		sessionId: string;
		body: string;
		userId: string;
		authorized: boolean;
		deliveryId: string;
	}): MergeDecisionResult {
		const workflow = this.require(input.issueId);
		if (workflow.sessionId !== input.sessionId) {
			return { accepted: false, reason: "Approval session does not match" };
		}
		if (!input.authorized) {
			return { accepted: false, reason: "User is not authorized" };
		}
		if (this.isDuplicate(input.deliveryId)) {
			return { accepted: false, reason: "Duplicate delivery" };
		}
		if (
			workflow.phase !== "awaiting_merge_approval" ||
			workflow.mergeApproval?.status !== "pending"
		) {
			return { accepted: false, reason: "No merge approval is pending" };
		}

		const parsed = parseDecision(input.body);
		if (!parsed || parsed.decision === "revise") {
			return { accepted: false, reason: "Prompt is not a merge decision" };
		}
		if (parsed.correlationId !== workflow.mergeApproval.correlationId) {
			return { accepted: false, reason: "Merge approval is stale" };
		}

		const now = Date.now();
		workflow.mergeApproval.status =
			parsed.decision === "approve"
				? "approved"
				: parsed.decision === "reject"
					? "rejected"
					: "canceled";
		workflow.mergeApproval.decidedAt = now;
		workflow.mergeApproval.decidedByUserId = input.userId;
		workflow.updatedAt = now;
		this.markProcessed(input.deliveryId);

		if (parsed.decision === "approve") {
			workflow.phase = "merging";
			this.syncParentChild(workflow);
			return { accepted: true, decision: "approve", effect: "merge" };
		}

		workflow.phase = parsed.decision === "reject" ? "in_review" : "canceled";
		this.syncParentChild(
			workflow,
			parsed.decision === "cancel"
				? "Merge approval canceled; pull request remains open"
				: undefined,
		);
		return {
			accepted: true,
			decision: parsed.decision,
			effect: parsed.decision === "reject" ? "return_to_review" : "terminal",
		};
	}

	reconcileAlreadyMerged(
		issueId: string,
		input: PullRequestApprovalInput,
		mergeCommitSha: string,
		mergeCommitUrl: string,
	): string | undefined {
		const workflow = this.require(issueId);
		if (
			workflow.phase !== "implementing" &&
			workflow.phase !== "in_review" &&
			workflow.phase !== "awaiting_merge_approval" &&
			workflow.phase !== "merging"
		) {
			throw new Error(
				`Cannot reconcile an already-merged pull request from ${workflow.phase}`,
			);
		}
		workflow.mergeApproval = {
			...input,
			correlationId: `already-merged-${input.pullRequestNumber}-${input.headSha.slice(0, 16)}`,
			status: "already_merged",
			createdAt: Date.now(),
			mergeCommitSha,
			mergeCommitUrl,
		};
		workflow.phase = "done";
		workflow.updatedAt = Date.now();
		this.syncParentChild(
			workflow,
			"Pull request was already merged externally",
		);
		return this.activateNextChild(workflow.parentWorkflowIssueId);
	}

	markMergeStale(issueId: string, reason: string): void {
		const workflow = this.require(issueId);
		if (!workflow.mergeApproval) {
			throw new Error("No merge approval exists");
		}
		workflow.mergeApproval.status = "stale";
		workflow.phase = "in_review";
		workflow.updatedAt = Date.now();
		this.syncParentChild(workflow, reason);
	}

	markMerged(
		issueId: string,
		mergeCommitSha: string,
		mergeCommitUrl: string,
	): string | undefined {
		const workflow = this.require(issueId);
		if (workflow.phase === "done") {
			return this.activateNextChild(workflow.parentWorkflowIssueId);
		}
		if (workflow.phase !== "merging") {
			throw new Error(`Cannot mark ${issueId} merged from ${workflow.phase}`);
		}
		if (workflow.mergeApproval) {
			workflow.mergeApproval.mergeCommitSha = mergeCommitSha;
			workflow.mergeApproval.mergeCommitUrl = mergeCommitUrl;
		}
		workflow.phase = "done";
		workflow.updatedAt = Date.now();
		this.syncParentChild(workflow);
		return this.activateNextChild(workflow.parentWorkflowIssueId);
	}

	markFailed(issueId: string, reason: string): string | undefined {
		const workflow = this.require(issueId);
		workflow.phase = "failed";
		workflow.updatedAt = Date.now();
		this.syncParentChild(workflow, reason);
		return this.activateNextChild(workflow.parentWorkflowIssueId);
	}

	markCanceled(issueId: string, reason: string): string | undefined {
		const workflow = this.require(issueId);
		workflow.phase = "canceled";
		workflow.updatedAt = Date.now();
		this.syncParentChild(workflow, reason);
		return this.activateNextChild(workflow.parentWorkflowIssueId);
	}

	markParentDone(parentIssueId: string): void {
		const parent = this.require(parentIssueId);
		if (parent.kind !== "parent") {
			throw new Error(`${parentIssueId} is not a parent workflow`);
		}
		if (!this.getParentCompletion(parentIssueId).complete) {
			throw new Error(
				`Parent ${parentIssueId} still has non-terminal children`,
			);
		}
		parent.phase = "done";
		parent.updatedAt = Date.now();
	}

	activateNextReadyChild(
		parentIssueId: string | undefined,
	): string | undefined {
		return this.activateNextChild(parentIssueId);
	}

	settleDependencyFailures(parentIssueId: string): string[] {
		const parent = this.require(parentIssueId);
		const newlyFailed: string[] = [];
		let anySettled = false;
		let changed = true;
		while (changed) {
			changed = false;
			for (const spec of parent.plannedChildren) {
				const child = parent.children[spec.key];
				if (
					!child ||
					["done", "rejected", "canceled", "failed"].includes(child.status)
				) {
					continue;
				}
				const unsuccessfulDependency = spec.dependencies.find((dependency) => {
					const status = parent.children[dependency]?.status;
					return (
						status === "failed" ||
						status === "rejected" ||
						status === "canceled"
					);
				});
				if (!unsuccessfulDependency) continue;
				const dependencyStatus =
					parent.children[unsuccessfulDependency]?.status;
				const reason = `Blocked by unsuccessful dependency ${unsuccessfulDependency} (${dependencyStatus})`;
				child.status = "failed";
				child.result = reason;
				anySettled = true;
				if (child.issueId) {
					const workflow = this.state.workflows[child.issueId];
					if (workflow && !isCustomWorkflowTerminal(workflow.phase)) {
						workflow.phase = "failed";
						workflow.updatedAt = Date.now();
						newlyFailed.push(workflow.issueId);
					}
				}
				changed = true;
			}
		}
		if (anySettled) parent.updatedAt = Date.now();
		return newlyFailed;
	}

	isFeatureReady(issueId: string): boolean {
		const workflow = this.require(issueId);
		return (
			workflow.phase === "approved_waiting" && this.canStartFeature(workflow)
		);
	}

	addManualBlocker(
		issueId: string,
		input: ManualBlockerInput,
	): { blocker: ManualBlockerRecord; created: boolean } {
		const workflow = this.require(issueId);
		const existing = workflow.manualBlockers[input.key];
		if (existing) {
			return { blocker: existing, created: false };
		}
		const blocker: ManualBlockerRecord = {
			...input,
			status: "pending",
			createdAt: Date.now(),
		};
		workflow.manualBlockers[input.key] = blocker;
		workflow.phase = "blocked_manual";
		workflow.updatedAt = Date.now();
		this.syncParentChild(workflow, `Blocked by ${input.issueIdentifier}`);
		return { blocker, created: true };
	}

	manualIssueCompleted(manualIssueId: string): PersistentCustomWorkflow[] {
		const waiting: PersistentCustomWorkflow[] = [];
		for (const workflow of Object.values(this.state.workflows)) {
			const blocker = Object.values(workflow.manualBlockers).find(
				(entry) => entry.issueId === manualIssueId,
			);
			if (
				!blocker ||
				blocker.status === "verified" ||
				blocker.status === "verifying"
			) {
				continue;
			}
			blocker.status = "verifying";
			workflow.phase = "verifying_manual";
			workflow.updatedAt = Date.now();
			this.syncParentChild(workflow, `Verifying ${blocker.issueIdentifier}`);
			waiting.push(workflow);
		}
		return waiting;
	}

	recordManualVerification(
		issueId: string,
		blockerKey: string,
		success: boolean,
		result: string,
	): { resumeImplementation: boolean } {
		const workflow = this.require(issueId);
		const blocker = workflow.manualBlockers[blockerKey];
		if (!blocker) throw new Error(`Unknown Manual blocker ${blockerKey}`);
		if (blocker.status === "verified") {
			return { resumeImplementation: false };
		}
		const targetStatus = success ? "verified" : "verification_failed";
		if (
			blocker.status === targetStatus &&
			blocker.verificationResult === result
		) {
			return { resumeImplementation: false };
		}
		if (blocker.status !== "verifying") {
			throw new Error(
				`Manual blocker ${blockerKey} is not awaiting verification`,
			);
		}
		blocker.status = targetStatus;
		blocker.verificationResult = result;
		workflow.updatedAt = Date.now();

		if (!success) {
			workflow.phase = "blocked_manual";
			this.syncParentChild(workflow, `Manual verification failed: ${result}`);
			return { resumeImplementation: false };
		}

		const allVerified = Object.values(workflow.manualBlockers).every(
			(entry) => entry.status === "verified",
		);
		workflow.phase = allVerified ? "manual_verified" : "blocked_manual";
		this.syncParentChild(workflow, result);
		return { resumeImplementation: allVerified };
	}

	markImplementationResumed(issueId: string): void {
		const workflow = this.require(issueId);
		if (workflow.phase !== "manual_verified") {
			throw new Error(`Cannot resume implementation from ${workflow.phase}`);
		}
		workflow.phase = "implementing";
		workflow.updatedAt = Date.now();
		this.syncParentChild(workflow);
	}

	getParentCompletion(parentIssueId: string): ParentCompletion {
		this.settleDependencyFailures(parentIssueId);
		const parent = this.require(parentIssueId);
		const results = parent.plannedChildren.map((spec) => ({
			key: spec.key,
			title: spec.title,
			result: parent.children[spec.key] ?? { status: "pending" as const },
		}));
		return {
			complete:
				results.length === parent.plannedChildren.length &&
				results.every(({ result }) =>
					["done", "rejected", "canceled", "failed"].includes(result.status),
				),
			results,
		};
	}

	planDecisionOptions(workflow: PersistentCustomWorkflow): string[] {
		const correlationId = workflow.planApproval?.correlationId;
		if (!correlationId) return [];
		return [
			`[Approve|${correlationId}]`,
			`[Revise|${correlationId}]`,
			`[Reject|${correlationId}]`,
			`[Cancel|${correlationId}]`,
		];
	}

	mergeDecisionOptions(workflow: PersistentCustomWorkflow): string[] {
		const correlationId = workflow.mergeApproval?.correlationId;
		if (!correlationId) return [];
		return [
			`[Approve|${correlationId}]`,
			`[Reject|${correlationId}]`,
			`[Cancel|${correlationId}]`,
		];
	}

	private canStartFeature(workflow: PersistentCustomWorkflow): boolean {
		if (!workflow.parentWorkflowIssueId) return true;
		const parent = this.state.workflows[workflow.parentWorkflowIssueId];
		if (!parent) return false;
		if (!parent.decompositionComplete) return false;
		const childEntry = Object.entries(parent.children).find(
			([, child]) => child.issueId === workflow.issueId,
		);
		if (!childEntry) return false;
		const [childKey] = childEntry;
		const spec = parent.plannedChildren.find((entry) => entry.key === childKey);
		if (!spec) return false;

		const dependenciesDone = spec.dependencies.every(
			(key) => parent.children[key]?.status === "done",
		);
		if (!dependenciesDone) return false;

		return !Object.values(this.state.workflows).some(
			(candidate) =>
				candidate.issueId !== workflow.issueId &&
				candidate.parentWorkflowIssueId === workflow.parentWorkflowIssueId &&
				ACTIVE_CHILD_PHASES.has(candidate.phase),
		);
	}

	private activateNextChild(
		parentIssueId: string | undefined,
	): string | undefined {
		if (!parentIssueId) return undefined;
		const parent = this.state.workflows[parentIssueId];
		if (!parent) return undefined;
		for (const spec of parent.plannedChildren) {
			const child = parent.children[spec.key];
			if (!child?.issueId) continue;
			const workflow = this.state.workflows[child.issueId];
			if (
				workflow?.phase === "approved_waiting" &&
				this.canStartFeature(workflow)
			) {
				return workflow.issueId;
			}
		}
		return undefined;
	}

	private syncParentChild(
		workflow: PersistentCustomWorkflow,
		result?: string,
	): void {
		if (!workflow.parentWorkflowIssueId) return;
		const parent = this.state.workflows[workflow.parentWorkflowIssueId];
		if (!parent) return;
		const child = Object.values(parent.children).find(
			(entry) => entry.issueId === workflow.issueId,
		);
		if (!child) return;
		child.status = childStatusForPhase(workflow.phase);
		child.sessionId = workflow.sessionId;
		if (result) child.result = result;
		if (workflow.mergeApproval) {
			child.pullRequestUrl = workflow.mergeApproval.pullRequestUrl;
			child.mergeCommitUrl = workflow.mergeApproval.mergeCommitUrl;
		}
		parent.updatedAt = Date.now();
	}

	private require(issueId: string): PersistentCustomWorkflow {
		const workflow = this.state.workflows[issueId];
		if (!workflow) throw new Error(`No custom workflow for issue ${issueId}`);
		return workflow;
	}

	private isDuplicate(deliveryId: string): boolean {
		return Object.hasOwn(this.state.processedDeliveries, deliveryId);
	}

	private markProcessed(deliveryId: string): void {
		this.state.processedDeliveries[deliveryId] = Date.now();
		const entries = Object.entries(this.state.processedDeliveries);
		if (entries.length <= 5_000) return;
		entries
			.sort(([, left], [, right]) => left - right)
			.slice(0, entries.length - 5_000)
			.forEach(([key]) => {
				delete this.state.processedDeliveries[key];
			});
	}
}

function childStatusForPhase(
	phase: CustomWorkflowPhase,
): PersistentChildResult["status"] {
	if (phase === "planning") return "planning";
	if (phase === "awaiting_plan_approval") return "awaiting_plan_approval";
	if (phase === "approved_waiting") return "approved_waiting";
	if (
		phase === "implementing" ||
		phase === "blocked_manual" ||
		phase === "verifying_manual" ||
		phase === "manual_verified"
	) {
		return "implementing";
	}
	if (phase === "in_review") return "in_review";
	if (phase === "awaiting_merge_approval" || phase === "merging") {
		return "awaiting_merge_approval";
	}
	if (isCustomWorkflowTerminal(phase)) return phase;
	return "pending";
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function parseDecision(body: string): {
	decision: "approve" | "revise" | "reject" | "cancel";
	correlationId: string;
	feedback?: string;
} | null {
	const match = DECISION_PATTERN.exec(body.trim());
	if (!match) return null;
	const rawDecision = match[1]!.toLowerCase();
	if (
		rawDecision !== "approve" &&
		rawDecision !== "revise" &&
		rawDecision !== "reject" &&
		rawDecision !== "cancel"
	) {
		return null;
	}
	return {
		decision: rawDecision,
		correlationId: match[2]!,
		...(match[3] ? { feedback: match[3] } : {}),
	};
}

/**
 * Parse the machine-readable decomposition emitted by the parent planner.
 * A plan with no decomposition block intentionally represents zero children.
 */
export function parsePlannedChildren(plan: string): PlannedChildSpec[] {
	const tagged =
		/<implementation_children>\s*([\s\S]*?)\s*<\/implementation_children>/i.exec(
			plan,
		);
	if (!tagged) return [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(tagged[1]!);
	} catch (error) {
		throw new Error(
			`Invalid implementation_children JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.children)) {
		throw new Error("implementation_children must contain a children array");
	}

	const children: PlannedChildSpec[] = parsed.children.map((value, index) => {
		if (!isRecord(value)) {
			throw new Error(`Child ${index + 1} must be an object`);
		}
		const key = readNonEmptyString(value.key, `Child ${index + 1} key`);
		if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(key)) {
			throw new Error(`Child key '${key}' is invalid`);
		}
		const dependencies = Array.isArray(value.dependencies)
			? value.dependencies.map((dependency, dependencyIndex) =>
					readNonEmptyString(
						dependency,
						`Child ${key} dependency ${dependencyIndex + 1}`,
					),
				)
			: [];
		return {
			key,
			title: readNonEmptyString(value.title, `Child ${key} title`),
			description: readNonEmptyString(
				value.description,
				`Child ${key} description`,
			),
			dependencies: [...new Set(dependencies)],
		};
	});

	const keys = new Set<string>();
	for (const child of children) {
		if (keys.has(child.key))
			throw new Error(`Duplicate child key '${child.key}'`);
		keys.add(child.key);
	}
	for (const child of children) {
		for (const dependency of child.dependencies) {
			if (dependency === child.key) {
				throw new Error(`Child '${child.key}' cannot depend on itself`);
			}
			if (!keys.has(dependency)) {
				throw new Error(
					`Child '${child.key}' depends on unknown child '${dependency}'`,
				);
			}
		}
	}
	const byKey = new Map(children.map((child) => [child.key, child]));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (key: string): void => {
		if (visiting.has(key)) {
			throw new Error(`Child dependency cycle includes '${key}'`);
		}
		if (visited.has(key)) return;
		visiting.add(key);
		for (const dependency of byKey.get(key)?.dependencies ?? []) {
			visit(dependency);
		}
		visiting.delete(key);
		visited.add(key);
	};
	for (const child of children) visit(child.key);
	return children;
}

function readNonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
