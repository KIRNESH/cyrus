import { describe, expect, it, vi } from "vitest";
import {
	CustomWorkflowCoordinator,
	formatParentCompletionSummary,
} from "../src/CustomWorkflowCoordinator.js";
import { GitHubPullRequestService } from "../src/GitHubPullRequestService.js";

interface PullRequestFixture {
	number: number;
	branch: string;
	headSha: string;
	file: string;
	check: "success" | "failure";
	merged: boolean;
	mergeSha?: string;
}

function start(
	coordinator: CustomWorkflowCoordinator,
	issueId: string,
	kind: "parent" | "feature",
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
		authorizedUserId: "human-1",
		delegateId: "cyrus-app-user",
		...(parentWorkflowIssueId ? { parentWorkflowIssueId } : {}),
		teamId: "team-1",
		projectId: "project-1",
		branchName: `feature/${issueId}`,
		baseBranch: "main",
	}).workflow;
}

function decidePlan(
	coordinator: CustomWorkflowCoordinator,
	issueId: string,
	decision: "Approve" | "Revise",
	deliveryId: string,
	feedback?: string,
) {
	const workflow = coordinator.get(issueId)!;
	return coordinator.handlePlanDecision({
		issueId,
		sessionId: workflow.sessionId,
		body: `[${decision}|${workflow.planApproval!.correlationId}]${feedback ? `: ${feedback}` : ""}`,
		userId: "human-1",
		authorized: true,
		deliveryId,
	});
}

function githubFixture(pullRequests: Map<number, PullRequestFixture>) {
	const calls: string[] = [];
	const fetchImpl = vi.fn(async (value: string | URL, init?: RequestInit) => {
		const url = String(value);
		calls.push(`${init?.method ?? "GET"} ${url}`);
		const json = (body: unknown, status = 200) =>
			new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			});
		if (url.endsWith("/repos/cyrus/test")) {
			return json({
				full_name: "cyrus/test",
				html_url: "https://github.test/cyrus/test",
				default_branch: "main",
				allow_squash_merge: true,
				allow_merge_commit: true,
				allow_rebase_merge: true,
			});
		}
		const prNumber = Number(/\/pulls\/(\d+)/.exec(url)?.[1]);
		const pr = pullRequests.get(prNumber);
		if (pr && url.includes(`/pulls/${prNumber}/files`)) {
			return json([
				{ filename: pr.file, status: "added", additions: 8, deletions: 0 },
			]);
		}
		if (
			pr &&
			url.endsWith(`/pulls/${prNumber}`) &&
			(!init?.method || init.method === "GET")
		) {
			return json({
				number: pr.number,
				html_url: `https://github.test/cyrus/test/pull/${pr.number}`,
				state: pr.merged ? "closed" : "open",
				merged: pr.merged,
				merge_commit_sha: pr.mergeSha ?? null,
				base: { ref: "main", repo: { full_name: "cyrus/test" } },
				head: {
					ref: pr.branch,
					sha: pr.headSha,
					repo: { full_name: "cyrus/test" },
				},
			});
		}
		const sha = /\/commits\/([^/]+)/.exec(url)?.[1];
		const bySha = [...pullRequests.values()].find(
			(candidate) => candidate.headSha === sha,
		);
		if (bySha && url.includes("/check-runs")) {
			return json({
				check_runs: [
					{
						name: "test",
						status: "completed",
						conclusion: bySha.check,
						details_url: `https://checks.test/${bySha.number}`,
					},
				],
			});
		}
		if (bySha && url.includes("/status")) {
			return json({ state: bySha.check, statuses: [] });
		}
		if (url.includes("required_status_checks")) {
			return json({ contexts: ["test"] });
		}
		if (
			pr &&
			url.endsWith(`/pulls/${prNumber}/merge`) &&
			init?.method === "PUT"
		) {
			pr.merged = true;
			pr.mergeSha = `merge-${prNumber}`;
			return json({ merged: true, sha: pr.mergeSha, message: "merged" });
		}
		if (url.includes("/git/refs/heads/") && init?.method === "DELETE") {
			return new Response(null, { status: 204 });
		}
		return json({ message: "unexpected test request" }, 500);
	}) as unknown as typeof fetch;
	return { service: new GitHubPullRequestService(fetchImpl), calls };
}

describe("custom workflow acceptance fixture", () => {
	it("runs revised parent planning, three separately approved children, protected merges, dependencies, and final links", async () => {
		const coordinator = new CustomWorkflowCoordinator();
		const worktrees = new Set<string>();
		const branches = new Set<string>();
		const pullRequests = new Map<number, PullRequestFixture>();
		const { service, calls } = githubFixture(pullRequests);
		start(coordinator, "parent", "parent");
		const firstPlan =
			'<implementation_children>{"children":[{"key":"alpha","title":"docs/alpha.md","description":"Create alpha documentation","dependencies":[]},{"key":"beta","title":"docs/beta.md","description":"Create beta documentation","dependencies":[]},{"key":"readme","title":"README integration","description":"Link both documents from README","dependencies":["alpha","beta"]}]}</implementation_children>';
		coordinator.completePlanning("parent", firstPlan, "parent-plan-1");
		expect(worktrees.size).toBe(0);
		expect(branches.size).toBe(0);
		expect(pullRequests.size).toBe(0);

		expect(
			decidePlan(
				coordinator,
				"parent",
				"Revise",
				"parent-revise",
				"Make the README child depend on both document children.",
			).decision,
		).toBe("revise");
		coordinator.completePlanning(
			"parent",
			`Create two standalone documents, then integrate them.\n${firstPlan}`,
			"parent-plan-2",
		);
		expect(worktrees.size).toBe(0);
		expect(branches.size).toBe(0);

		expect(
			decidePlan(coordinator, "parent", "Approve", "parent-approve").effect,
		).toBe("decompose");
		for (const key of ["alpha", "beta", "readme"]) {
			coordinator.registerChildIssue("parent", key, {
				issueId: key,
				issueIdentifier: key.toUpperCase(),
				issueUrl: `https://linear.test/${key}`,
			});
			// Reconciliation of the same approved parent is idempotent.
			coordinator.registerChildIssue("parent", key, {
				issueId: key,
				issueIdentifier: key.toUpperCase(),
				issueUrl: `https://linear.test/${key}`,
			});
			start(coordinator, key, "feature", "parent");
			coordinator.bindFeatureToParent(key);
			coordinator.completePlanning(key, `Plan ${key}`, `plan-${key}`);
		}
		coordinator.recordDependencyRelation("parent", "alpha->readme");
		coordinator.recordDependencyRelation("parent", "beta->readme");
		coordinator.finishDecomposition("parent");
		expect(Object.keys(coordinator.get("parent")!.children)).toEqual([
			"alpha",
			"beta",
			"readme",
		]);
		expect(
			new Set(
				["alpha", "beta", "readme"].map(
					(key) => coordinator.get(key)!.planApproval!.correlationId,
				),
			).size,
		).toBe(3);

		expect(
			decidePlan(coordinator, "alpha", "Approve", "approve-alpha").effect,
		).toBe("start_implementation");
		coordinator.markImplementationStarted("alpha");
		worktrees.add("alpha");
		branches.add("feature/alpha");
		expect(
			decidePlan(coordinator, "beta", "Approve", "approve-beta").effect,
		).toBe("wait_for_slot_or_dependencies");
		expect(
			decidePlan(coordinator, "readme", "Approve", "approve-readme").effect,
		).toBe("wait_for_slot_or_dependencies");

		const implement = (key: string, prNumber: number, file: string) => {
			if (coordinator.get(key)!.phase === "approved_waiting") {
				coordinator.markImplementationStarted(key);
			}
			worktrees.add(key);
			branches.add(`feature/${key}`);
			pullRequests.set(prNumber, {
				number: prNumber,
				branch: `feature/${key}`,
				headSha: String(prNumber).padStart(40, "0"),
				file,
				check: "success",
				merged: false,
			});
			coordinator.markInReview(key, `${file} implemented and checks passed`);
		};
		const requestApproval = async (key: string, prNumber: number) => {
			const workflow = coordinator.get(key)!;
			const inspection = await service.inspect({
				repositoryFullName: "cyrus/test",
				pullRequestNumber: prNumber,
				expectedBaseBranch: "main",
				expectedHeadBranch: `feature/${key}`,
				token: "test-token",
			});
			expect(inspection.failures).toEqual([]);
			return coordinator.requestMergeApproval(
				key,
				{
					repositoryId: workflow.repositoryId,
					repositoryFullName: inspection.repositoryFullName,
					pullRequestNumber: inspection.pullRequestNumber,
					pullRequestUrl: inspection.pullRequestUrl,
					baseBranch: inspection.baseBranch,
					headBranch: inspection.headBranch,
					headSha: inspection.headSha,
					changedFiles: inspection.changedFiles,
					checks: inspection.checks,
				},
				`merge-request:${key}:${prNumber}:${inspection.headSha}`,
			);
		};
		const approveAndMerge = async (key: string, prNumber: number) => {
			const workflow = coordinator.get(key)!;
			const approval = workflow.mergeApproval!;
			const decision = coordinator.handleMergeDecision({
				issueId: key,
				sessionId: workflow.sessionId,
				body: `[Approve|${approval.correlationId}]`,
				userId: "human-1",
				authorized: true,
				deliveryId: `approve-merge-${key}-${approval.createdAt}`,
			});
			expect(decision.effect).toBe("merge");
			const merged = await service.mergeApproved({
				repositoryFullName: approval.repositoryFullName,
				pullRequestNumber: prNumber,
				expectedBaseBranch: approval.baseBranch,
				expectedHeadBranch: approval.headBranch,
				expectedHeadSha: approval.headSha,
				token: "test-token",
			});
			return {
				next: coordinator.markMerged(
					key,
					merged.mergeCommitSha,
					merged.mergeCommitUrl,
				),
				merged,
			};
		};

		implement("alpha", 41, "docs/alpha.md");
		await requestApproval("alpha", 41);
		const alpha = coordinator.get("alpha")!;
		const rejected = coordinator.handleMergeDecision({
			issueId: "alpha",
			sessionId: alpha.sessionId,
			body: `[Reject|${alpha.mergeApproval!.correlationId}]`,
			userId: "human-1",
			authorized: true,
			deliveryId: "reject-alpha-merge",
		});
		expect(rejected.effect).toBe("return_to_review");
		expect(pullRequests.get(41)).toMatchObject({ merged: false });
		await requestApproval("alpha", 41);
		expect((await approveAndMerge("alpha", 41)).next).toBe("beta");

		expect(worktrees).not.toContain("beta");
		implement("beta", 42, "docs/beta.md");
		await requestApproval("beta", 42);
		expect((await approveAndMerge("beta", 42)).next).toBe("readme");

		expect(coordinator.isFeatureReady("readme")).toBe(true);
		implement("readme", 43, "README.md");
		await requestApproval("readme", 43);
		await approveAndMerge("readme", 43);
		expect(worktrees).toEqual(new Set(["alpha", "beta", "readme"]));
		expect(calls.filter((call) => call.includes("/merge"))).toHaveLength(3);

		const completion = coordinator.getParentCompletion("parent");
		expect(completion.complete).toBe(true);
		coordinator.markParentDone("parent");
		const linearFinalResponse = formatParentCompletionSummary(completion);
		for (const prNumber of [41, 42, 43]) {
			expect(linearFinalResponse).toContain(
				`https://github.test/cyrus/test/pull/${prNumber}`,
			);
			expect(linearFinalResponse).toContain(
				`https://github.test/cyrus/test/commit/merge-${prNumber}`,
			);
		}
		expect(linearFinalResponse).toContain("docs/alpha.md implemented");
		expect(linearFinalResponse).toContain("docs/beta.md implemented");
		expect(linearFinalResponse).toContain("README.md implemented");
	});

	it("does not create merge approval while a child's CI is failing", async () => {
		const coordinator = new CustomWorkflowCoordinator();
		start(coordinator, "failing", "feature");
		coordinator.completePlanning("failing", "Plan", "failing-plan");
		decidePlan(coordinator, "failing", "Approve", "failing-approve");
		coordinator.markImplementationStarted("failing");
		coordinator.markInReview("failing");
		const pullRequests = new Map<number, PullRequestFixture>([
			[
				44,
				{
					number: 44,
					branch: "feature/failing",
					headSha: "4".repeat(40),
					file: "docs/failing.md",
					check: "failure",
					merged: false,
				},
			],
		]);
		const { service, calls } = githubFixture(pullRequests);
		const inspection = await service.inspect({
			repositoryFullName: "cyrus/test",
			pullRequestNumber: 44,
			expectedBaseBranch: "main",
			expectedHeadBranch: "feature/failing",
			token: "test-token",
		});
		expect(inspection.failures).toContain("Check 'test' is failure");
		expect(coordinator.get("failing")!.phase).toBe("in_review");
		expect(coordinator.get("failing")!.mergeApproval).toBeUndefined();
		expect(calls.some((call) => call.includes("/merge"))).toBe(false);
	});
});
