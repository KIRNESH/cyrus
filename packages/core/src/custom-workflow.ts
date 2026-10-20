/** Persistent schema for the approval-driven product workflow. */
export const CUSTOM_WORKFLOW_STATE_VERSION = 1 as const;

export type CustomWorkflowKind = "parent" | "feature";

export type CustomWorkflowPhase =
	| "planning"
	| "awaiting_plan_approval"
	| "orchestrating"
	| "approved_waiting"
	| "implementing"
	| "in_review"
	| "awaiting_merge_approval"
	| "merging"
	| "blocked_manual"
	| "verifying_manual"
	| "manual_verified"
	| "done"
	| "rejected"
	| "canceled"
	| "failed";

export type CustomWorkflowTerminalPhase =
	| "done"
	| "rejected"
	| "canceled"
	| "failed";

export interface PlannedChildSpec {
	/** Stable key emitted by the approved parent plan. */
	key: string;
	title: string;
	description: string;
	/** Keys of sibling children that must finish successfully first. */
	dependencies: string[];
}

export interface PersistentChildResult {
	status:
		| "pending"
		| "planning"
		| "awaiting_plan_approval"
		| "approved_waiting"
		| "implementing"
		| "in_review"
		| "awaiting_merge_approval"
		| CustomWorkflowTerminalPhase;
	issueId?: string;
	issueIdentifier?: string;
	issueUrl?: string;
	sessionId?: string;
	result?: string;
	pullRequestUrl?: string;
	mergeCommitUrl?: string;
}

export interface PlanApprovalRecord {
	correlationId: string;
	revision: number;
	planDigest: string;
	status: "pending" | "approved" | "revised" | "rejected" | "canceled";
	createdAt: number;
	decidedAt?: number;
	decidedByUserId?: string;
}

export interface PullRequestCheckResult {
	name: string;
	status: "pending" | "success" | "failure";
	detailsUrl?: string;
}

export interface PullRequestApprovalRecord {
	correlationId: string;
	repositoryId: string;
	repositoryFullName: string;
	pullRequestNumber: number;
	pullRequestUrl: string;
	baseBranch: string;
	headBranch: string;
	headSha: string;
	changedFiles: string[];
	checks: PullRequestCheckResult[];
	previewUrl?: string;
	status:
		| "pending"
		| "approved"
		| "rejected"
		| "canceled"
		| "stale"
		| "already_merged";
	createdAt: number;
	decidedAt?: number;
	decidedByUserId?: string;
	mergeCommitSha?: string;
	mergeCommitUrl?: string;
}

export interface ManualBlockerRecord {
	/** Stable caller-provided key, unique within the waiting workflow. */
	key: string;
	issueId: string;
	issueIdentifier: string;
	issueUrl?: string;
	verify: string;
	status: "pending" | "verifying" | "verified" | "verification_failed";
	createdAt: number;
	verificationResult?: string;
}

export interface PersistentCustomWorkflow {
	issueId: string;
	issueIdentifier: string;
	issueUrl?: string;
	sessionId: string;
	linearWorkspaceId: string;
	repositoryId: string;
	kind: CustomWorkflowKind;
	phase: CustomWorkflowPhase;
	/** Authorized delegator/human used for child delegation and Manual assignment. */
	authorizedUserId: string;
	/** Linear app-user/delegate ID used only for Cyrus-owned child issues. */
	delegateId?: string;
	parentIssueId?: string;
	parentWorkflowIssueId?: string;
	teamId: string;
	projectId?: string;
	branchName?: string;
	baseBranch?: string;
	planRevision: number;
	plan?: string;
	planApproval?: PlanApprovalRecord;
	plannedChildren: PlannedChildSpec[];
	children: Record<string, PersistentChildResult>;
	/** True only after the complete child set and dependency relations are durable. */
	decompositionComplete: boolean;
	/** Dependency pairs already persisted in Linear, encoded as blocker->blocked. */
	dependencyRelations: string[];
	manualBlockers: Record<string, ManualBlockerRecord>;
	mergeApproval?: PullRequestApprovalRecord;
	createdAt: number;
	updatedAt: number;
}

export interface PersistentCustomWorkflowState {
	version: typeof CUSTOM_WORKFLOW_STATE_VERSION;
	workflows: Record<string, PersistentCustomWorkflow>;
	/** Webhook/activity/callback delivery IDs already applied. */
	processedDeliveries: Record<string, number>;
}

export function createEmptyCustomWorkflowState(): PersistentCustomWorkflowState {
	return {
		version: CUSTOM_WORKFLOW_STATE_VERSION,
		workflows: {},
		processedDeliveries: {},
	};
}

export function isCustomWorkflowTerminal(
	phase: CustomWorkflowPhase,
): phase is CustomWorkflowTerminalPhase {
	return (
		phase === "done" ||
		phase === "rejected" ||
		phase === "canceled" ||
		phase === "failed"
	);
}
