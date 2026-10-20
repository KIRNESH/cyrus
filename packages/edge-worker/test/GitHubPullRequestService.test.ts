import { describe, expect, it, vi } from "vitest";
import {
	GitHubPullRequestService,
	type MergeRevalidationError,
} from "../src/GitHubPullRequestService.js";

interface FixtureOptions {
	repositoryFullName?: string;
	prRepositoryFullName?: string;
	prNumber?: number;
	state?: "open" | "closed";
	merged?: boolean;
	base?: string;
	head?: string;
	headSha?: string;
	checkConclusion?: string | null;
	combinedStatus?: string;
	requiredContexts?: string[];
}

function fixture(options: FixtureOptions = {}) {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const fullName = options.repositoryFullName ?? "cyrus/test";
	const prRepo = options.prRepositoryFullName ?? "cyrus/test";
	const headSha = options.headSha ?? "0123456789abcdef0123456789abcdef01234567";
	const fetchImpl = vi.fn(
		async (urlValue: string | URL, init?: RequestInit) => {
			const url = String(urlValue);
			calls.push({ url, init });
			const json = (body: unknown, status = 200) =>
				new Response(JSON.stringify(body), {
					status,
					headers: { "content-type": "application/json" },
				});
			if (url.endsWith("/repos/cyrus/test")) {
				return json({
					full_name: fullName,
					html_url: `https://github.test/${fullName}`,
					default_branch: "main",
					allow_squash_merge: true,
					allow_merge_commit: true,
					allow_rebase_merge: true,
				});
			}
			if (url.includes("/pulls/42/files")) {
				return json([
					{
						filename: "docs/a.md",
						status: "added",
						additions: 10,
						deletions: 0,
					},
				]);
			}
			if (
				url.endsWith("/pulls/42") &&
				(!init?.method || init.method === "GET")
			) {
				return json({
					number: options.prNumber ?? 42,
					html_url: "https://github.test/cyrus/test/pull/42",
					state: options.state ?? "open",
					merged: options.merged ?? false,
					merge_commit_sha: options.merged ? "existing-merge-sha" : null,
					base: { ref: options.base ?? "main", repo: { full_name: prRepo } },
					head: {
						ref: options.head ?? "feature/test",
						sha: headSha,
						repo: { full_name: "cyrus/test" },
					},
				});
			}
			if (url.includes("/check-runs")) {
				return json({
					check_runs: [
						{
							name: "test",
							status: "completed",
							conclusion: options.checkConclusion ?? "success",
							details_url: "https://checks.test/test",
						},
					],
				});
			}
			if (url.includes("/commits/") && url.includes("/status")) {
				return json({
					state: options.combinedStatus ?? "success",
					statuses: [],
				});
			}
			if (url.includes("required_status_checks")) {
				return json({ contexts: options.requiredContexts ?? ["test"] });
			}
			if (url.endsWith("/pulls/42/merge") && init?.method === "PUT") {
				return json({ merged: true, sha: "new-merge-sha", message: "merged" });
			}
			if (url.includes("/git/refs/heads/") && init?.method === "DELETE") {
				return new Response(null, { status: 204 });
			}
			return json({ error: "unexpected request" }, 500);
		},
	) as unknown as typeof fetch;
	return { service: new GitHubPullRequestService(fetchImpl), calls, headSha };
}

const request = {
	repositoryFullName: "cyrus/test",
	pullRequestNumber: 42,
	expectedBaseBranch: "main",
	expectedHeadBranch: "feature/test",
	token: "test-token",
};

describe("GitHubPullRequestService", () => {
	it.each([
		[
			"closed pull request",
			{ state: "closed" as const },
			"Pull request is closed without being merged",
		],
		[
			"wrong repository",
			{ prRepositoryFullName: "other/repo" },
			"different repository",
		],
		["wrong pull request", { prNumber: 41 }, "identity does not match"],
		["wrong base", { base: "release" }, "Base branch changed"],
		["wrong head", { head: "feature/other" }, "Head branch changed"],
		[
			"failed checks",
			{ checkConclusion: "failure" },
			"Check 'test' is failure",
		],
	])("refuses %s during inspection", async (_name, options, expected) => {
		const { service } = fixture(options);
		const result = await service.inspect(request);
		expect(result.failures.join("; ")).toContain(expected);
		expect(result.checksPassing && result.failures.length === 0).toBe(false);
	});

	it("refuses a changed head SHA after approval", async () => {
		const { service } = fixture({ headSha: "new-head-sha" });
		await expect(
			service.mergeApproved({
				...request,
				expectedHeadSha: "approved-head-sha",
			}),
		).rejects.toEqual(
			expect.objectContaining<Partial<MergeRevalidationError>>({
				name: "MergeRevalidationError",
				refreshApproval: true,
			}),
		);
	});

	it("revalidates and merges with the expected SHA, then deletes the feature branch", async () => {
		const { service, calls, headSha } = fixture();
		const result = await service.mergeApproved({
			...request,
			expectedHeadSha: headSha,
		});
		expect(result).toEqual({
			alreadyMerged: false,
			mergeCommitSha: "new-merge-sha",
			mergeCommitUrl: "https://github.test/cyrus/test/commit/new-merge-sha",
			pullRequestUrl: "https://github.test/cyrus/test/pull/42",
			branchDeleted: true,
		});
		const mergeCall = calls.find((call) =>
			call.url.endsWith("/pulls/42/merge"),
		);
		expect(mergeCall?.init?.method).toBe("PUT");
		expect(JSON.parse(String(mergeCall?.init?.body))).toEqual({
			sha: headSha,
			merge_method: "squash",
		});
		expect(calls.at(-1)).toMatchObject({
			url: expect.stringContaining("/git/refs/heads/feature/test"),
			init: expect.objectContaining({ method: "DELETE" }),
		});
	});

	it("treats an already merged pull request as idempotent without a second merge", async () => {
		const { service, calls, headSha } = fixture({ merged: true });
		const result = await service.mergeApproved({
			...request,
			expectedHeadSha: headSha,
		});
		expect(result.alreadyMerged).toBe(true);
		expect(result.mergeCommitSha).toBe("existing-merge-sha");
		expect(
			calls.filter(
				(call) =>
					call.url.endsWith("/pulls/42/merge") && call.init?.method === "PUT",
			),
		).toHaveLength(0);
	});
});
