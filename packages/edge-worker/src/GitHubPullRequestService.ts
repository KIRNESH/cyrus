import type { PullRequestCheckResult } from "cyrus-core";

export interface PullRequestInspectionRequest {
	repositoryFullName: string;
	pullRequestNumber: number;
	expectedBaseBranch: string;
	expectedHeadBranch: string;
	token: string;
}

export interface PullRequestInspection {
	repositoryFullName: string;
	pullRequestNumber: number;
	pullRequestUrl: string;
	baseBranch: string;
	headBranch: string;
	headSha: string;
	changedFiles: string[];
	checks: PullRequestCheckResult[];
	checksPassing: boolean;
	failures: string[];
	open: boolean;
	merged: boolean;
	mergeCommitSha?: string;
	repositoryHtmlUrl: string;
	defaultBranch: string;
	headRepositoryFullName: string;
	mergeMethods: {
		squash: boolean;
		merge: boolean;
		rebase: boolean;
	};
}

export interface MergeApprovedPullRequestRequest
	extends PullRequestInspectionRequest {
	expectedHeadSha: string;
}

export interface MergeApprovedPullRequestResult {
	alreadyMerged: boolean;
	mergeCommitSha: string;
	mergeCommitUrl: string;
	pullRequestUrl: string;
	branchDeleted: boolean;
}

export class MergeRevalidationError extends Error {
	constructor(
		message: string,
		readonly refreshApproval: boolean,
	) {
		super(message);
		this.name = "MergeRevalidationError";
	}
}

interface GitHubRepositoryResponse {
	full_name: string;
	html_url: string;
	default_branch: string;
	allow_squash_merge: boolean;
	allow_merge_commit: boolean;
	allow_rebase_merge: boolean;
}

interface GitHubPullRequestResponse {
	number: number;
	html_url: string;
	state: "open" | "closed";
	merged: boolean;
	merge_commit_sha: string | null;
	base: { ref: string; repo: { full_name: string } };
	head: { ref: string; sha: string; repo: { full_name: string } | null };
}

interface GitHubFileResponse {
	filename: string;
	status: string;
	additions: number;
	deletions: number;
}

interface GitHubCheckRunResponse {
	name: string;
	status: string;
	conclusion: string | null;
	details_url: string | null;
}

interface GitHubStatusResponse {
	context: string;
	state: string;
	target_url: string | null;
}

/** Minimal GitHub REST client used only for the protected merge boundary. */
export class GitHubPullRequestService {
	constructor(
		private readonly fetchImpl: typeof fetch = fetch,
		private readonly apiBaseUrl = "https://api.github.com",
	) {}

	async inspect(
		request: PullRequestInspectionRequest,
	): Promise<PullRequestInspection> {
		validateRepositoryFullName(request.repositoryFullName);
		if (
			!Number.isSafeInteger(request.pullRequestNumber) ||
			request.pullRequestNumber <= 0
		) {
			throw new Error("Pull-request number must be a positive integer");
		}
		if (!request.expectedBaseBranch || !request.expectedHeadBranch) {
			throw new Error("Expected base and head branches are required");
		}

		const repositoryPath = encodeRepository(request.repositoryFullName);
		const [repository, pullRequest, files] = await Promise.all([
			this.get<GitHubRepositoryResponse>(
				`/repos/${repositoryPath}`,
				request.token,
			),
			this.get<GitHubPullRequestResponse>(
				`/repos/${repositoryPath}/pulls/${request.pullRequestNumber}`,
				request.token,
			),
			this.getAllPages<GitHubFileResponse>(
				`/repos/${repositoryPath}/pulls/${request.pullRequestNumber}/files?per_page=100`,
				request.token,
			),
		]);

		const failures: string[] = [];
		if (
			repository.full_name.toLowerCase() !==
			request.repositoryFullName.toLowerCase()
		) {
			failures.push("Repository identity does not match");
		}
		if (pullRequest.number !== request.pullRequestNumber) {
			failures.push("Pull-request identity does not match");
		}
		if (
			pullRequest.base.repo.full_name.toLowerCase() !==
			request.repositoryFullName.toLowerCase()
		) {
			failures.push("Pull request belongs to a different repository");
		}
		if (pullRequest.base.ref !== request.expectedBaseBranch) {
			failures.push(
				`Base branch changed from ${request.expectedBaseBranch} to ${pullRequest.base.ref}`,
			);
		}
		if (pullRequest.head.ref !== request.expectedHeadBranch) {
			failures.push(
				`Head branch changed from ${request.expectedHeadBranch} to ${pullRequest.head.ref}`,
			);
		}
		if (pullRequest.state !== "open" && !pullRequest.merged) {
			failures.push("Pull request is closed without being merged");
		}

		const checkState = await this.fetchChecks(
			request.repositoryFullName,
			pullRequest.head.sha,
			pullRequest.base.ref,
			request.token,
		);
		failures.push(...checkState.failures);

		return {
			repositoryFullName: repository.full_name,
			pullRequestNumber: pullRequest.number,
			pullRequestUrl: pullRequest.html_url,
			baseBranch: pullRequest.base.ref,
			headBranch: pullRequest.head.ref,
			headSha: pullRequest.head.sha,
			changedFiles: files.map(
				(file) =>
					`${file.filename} (${file.status}, +${file.additions}/-${file.deletions})`,
			),
			checks: checkState.checks,
			checksPassing: checkState.failures.length === 0,
			failures,
			open: pullRequest.state === "open",
			merged: pullRequest.merged,
			...(pullRequest.merge_commit_sha
				? { mergeCommitSha: pullRequest.merge_commit_sha }
				: {}),
			repositoryHtmlUrl: repository.html_url,
			defaultBranch: repository.default_branch,
			headRepositoryFullName:
				pullRequest.head.repo?.full_name ?? request.repositoryFullName,
			mergeMethods: {
				squash: repository.allow_squash_merge,
				merge: repository.allow_merge_commit,
				rebase: repository.allow_rebase_merge,
			},
		};
	}

	async mergeApproved(
		request: MergeApprovedPullRequestRequest,
	): Promise<MergeApprovedPullRequestResult> {
		const inspection = await this.inspect(request);
		if (inspection.merged) {
			if (
				inspection.repositoryFullName.toLowerCase() !==
					request.repositoryFullName.toLowerCase() ||
				inspection.baseBranch !== request.expectedBaseBranch ||
				inspection.headBranch !== request.expectedHeadBranch ||
				inspection.headSha !== request.expectedHeadSha
			) {
				throw new MergeRevalidationError(
					"Already-merged pull request identity does not match the approval",
					false,
				);
			}
			if (!inspection.mergeCommitSha) {
				throw new MergeRevalidationError(
					"GitHub reports the pull request merged without a merge commit SHA",
					false,
				);
			}
			return this.mergedResult(
				inspection,
				inspection.mergeCommitSha,
				false,
				true,
			);
		}
		if (!inspection.open) {
			throw new MergeRevalidationError("Pull request is no longer open", true);
		}
		if (inspection.headSha !== request.expectedHeadSha) {
			throw new MergeRevalidationError(
				"Pull-request head changed after approval",
				true,
			);
		}
		if (inspection.failures.length > 0 || !inspection.checksPassing) {
			throw new MergeRevalidationError(
				`Pull request failed revalidation: ${inspection.failures.join("; ")}`,
				true,
			);
		}

		const mergeMethod = inspection.mergeMethods.squash
			? "squash"
			: inspection.mergeMethods.merge
				? "merge"
				: inspection.mergeMethods.rebase
					? "rebase"
					: null;
		if (!mergeMethod) {
			throw new MergeRevalidationError(
				"Repository does not allow a supported merge strategy",
				false,
			);
		}

		const repositoryPath = encodeRepository(request.repositoryFullName);
		const merged = await this.requestJson<{
			merged: boolean;
			sha: string;
			message: string;
		}>(
			`/repos/${repositoryPath}/pulls/${request.pullRequestNumber}/merge`,
			request.token,
			{
				method: "PUT",
				body: JSON.stringify({
					sha: request.expectedHeadSha,
					merge_method: mergeMethod,
				}),
			},
		);
		if (!merged.merged || !merged.sha) {
			throw new MergeRevalidationError(
				`GitHub refused the protected merge: ${merged.message}`,
				true,
			);
		}

		let branchDeleted = false;
		const sameRepository =
			inspection.headRepositoryFullName.toLowerCase() ===
			inspection.repositoryFullName.toLowerCase();
		const safeFeatureBranch =
			inspection.headBranch !== inspection.baseBranch &&
			inspection.headBranch !== inspection.defaultBranch;
		if (sameRepository && safeFeatureBranch) {
			const encodedRef = inspection.headBranch
				.split("/")
				.map(encodeURIComponent)
				.join("/");
			const response = await this.fetchImpl(
				`${this.apiBaseUrl}/repos/${repositoryPath}/git/refs/heads/${encodedRef}`,
				{
					method: "DELETE",
					headers: this.headers(request.token),
				},
			);
			branchDeleted =
				response.ok || response.status === 422 || response.status === 404;
		}

		return this.mergedResult(inspection, merged.sha, branchDeleted, false);
	}

	private async fetchChecks(
		repositoryFullName: string,
		headSha: string,
		baseBranch: string,
		token: string,
	): Promise<{ checks: PullRequestCheckResult[]; failures: string[] }> {
		const repositoryPath = encodeRepository(repositoryFullName);
		const [checkRunsPayload, statusPayload, requiredContexts] =
			await Promise.all([
				this.get<{ check_runs: GitHubCheckRunResponse[] }>(
					`/repos/${repositoryPath}/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100`,
					token,
				),
				this.get<{ state: string; statuses: GitHubStatusResponse[] }>(
					`/repos/${repositoryPath}/commits/${encodeURIComponent(headSha)}/status?per_page=100`,
					token,
				),
				this.getRequiredContexts(repositoryPath, baseBranch, token),
			]);

		const checks: PullRequestCheckResult[] = [];
		const byName = new Map<string, PullRequestCheckResult>();
		for (const run of checkRunsPayload.check_runs) {
			const status =
				run.status !== "completed"
					? "pending"
					: run.conclusion === "success" ||
							run.conclusion === "neutral" ||
							run.conclusion === "skipped"
						? "success"
						: "failure";
			byName.set(run.name, {
				name: run.name,
				status,
				...(run.details_url ? { detailsUrl: run.details_url } : {}),
			});
		}
		for (const status of statusPayload.statuses) {
			if (byName.has(status.context)) continue;
			byName.set(status.context, {
				name: status.context,
				status:
					status.state === "success"
						? "success"
						: status.state === "pending"
							? "pending"
							: "failure",
				...(status.target_url ? { detailsUrl: status.target_url } : {}),
			});
		}
		checks.push(...byName.values());

		const failures: string[] = [];
		for (const context of requiredContexts) {
			const check = byName.get(context);
			if (!check) failures.push(`Required check '${context}' has not reported`);
			else if (check.status !== "success") {
				failures.push(`Required check '${context}' is ${check.status}`);
			}
		}
		for (const check of checks) {
			if (check.status !== "success") {
				failures.push(`Check '${check.name}' is ${check.status}`);
			}
		}
		if (
			statusPayload.statuses.length > 0 &&
			statusPayload.state !== "success"
		) {
			failures.push(`Combined commit status is ${statusPayload.state}`);
		}
		return { checks, failures: [...new Set(failures)] };
	}

	private async getRequiredContexts(
		repositoryPath: string,
		baseBranch: string,
		token: string,
	): Promise<string[]> {
		const response = await this.fetchImpl(
			`${this.apiBaseUrl}/repos/${repositoryPath}/branches/${encodeURIComponent(baseBranch)}/protection/required_status_checks`,
			{ headers: this.headers(token) },
		);
		if (response.status === 404) return [];
		if (!response.ok) {
			throw new Error(
				`GitHub required-check lookup failed (${response.status})`,
			);
		}
		const body = (await response.json()) as {
			contexts?: string[];
			checks?: Array<{ context: string }>;
		};
		return [
			...(body.contexts ?? []),
			...(body.checks ?? []).map((check) => check.context),
		];
	}

	private async get<T>(path: string, token: string): Promise<T> {
		return this.requestJson<T>(path, token, { method: "GET" });
	}

	private async getAllPages<T>(path: string, token: string): Promise<T[]> {
		const values: T[] = [];
		for (let page = 1; page <= 100; page++) {
			const separator = path.includes("?") ? "&" : "?";
			const response = await this.fetchImpl(
				`${this.apiBaseUrl}${path}${separator}page=${page}`,
				{ headers: this.headers(token) },
			);
			if (!response.ok) {
				throw new Error(`GitHub request failed (${response.status})`);
			}
			const pageValues = (await response.json()) as T[];
			values.push(...pageValues);
			if (pageValues.length < 100) break;
		}
		return values;
	}

	private async requestJson<T>(
		path: string,
		token: string,
		init: RequestInit,
	): Promise<T> {
		const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
			...init,
			headers: { ...this.headers(token), ...init.headers },
		});
		if (!response.ok) {
			throw new Error(`GitHub request failed (${response.status})`);
		}
		return (await response.json()) as T;
	}

	private headers(token: string): Record<string, string> {
		return {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			"X-GitHub-Api-Version": "2022-11-28",
		};
	}

	private mergedResult(
		inspection: PullRequestInspection,
		sha: string,
		branchDeleted: boolean,
		alreadyMerged: boolean,
	): MergeApprovedPullRequestResult {
		return {
			alreadyMerged,
			mergeCommitSha: sha,
			mergeCommitUrl: `${inspection.repositoryHtmlUrl}/commit/${sha}`,
			pullRequestUrl: inspection.pullRequestUrl,
			branchDeleted,
		};
	}
}

function validateRepositoryFullName(value: string): void {
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
		throw new Error("Invalid GitHub repository identity");
	}
}

function encodeRepository(value: string): string {
	return value.split("/").map(encodeURIComponent).join("/");
}
