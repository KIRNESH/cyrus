import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";

describe("AgentSessionManager.getSessionsByBaseBranch", () => {
	let manager: AgentSessionManager;

	beforeEach(() => {
		const noopLogger = {
			info: () => {},
			warn: () => {},
			error: () => {},
			debug: () => {},
			withContext: function () {
				return this;
			},
		} as any;
		manager = new AgentSessionManager(undefined, undefined, noopLogger);
	});

	it("returns sessions tracking the specified base branch and repository", () => {
		manager.createCyrusAgentSession(
			"session-1",
			"issue-1",
			{
				id: "issue-1",
				identifier: "TEST-1",
				title: "Test Issue",
				description: "test",
				branchName: "test-1",
			},
			{ path: "/tmp/ws1", isGitWorktree: true },
			"linear",
			[
				{
					repositoryId: "repo-a",
					branchName: "test-1",
					baseBranchName: "main",
				},
			],
		);

		manager.createCyrusAgentSession(
			"session-2",
			"issue-2",
			{
				id: "issue-2",
				identifier: "TEST-2",
				title: "Test Issue 2",
				description: "test",
				branchName: "test-2",
			},
			{ path: "/tmp/ws2", isGitWorktree: true },
			"linear",
			[
				{
					repositoryId: "repo-a",
					branchName: "test-2",
					baseBranchName: "develop",
				},
			],
		);

		const sessions = manager.getSessionsByBaseBranch("main", "repo-a");
		expect(sessions).toHaveLength(1);
		expect(sessions[0]!.id).toBe("session-1");
	});

	it("returns empty array when no sessions track the base branch", () => {
		manager.createCyrusAgentSession(
			"session-1",
			"issue-1",
			{
				id: "issue-1",
				identifier: "TEST-1",
				title: "Test Issue",
				description: "test",
				branchName: "test-1",
			},
			{ path: "/tmp/ws1", isGitWorktree: true },
			"linear",
			[
				{
					repositoryId: "repo-a",
					branchName: "test-1",
					baseBranchName: "main",
				},
			],
		);

		const sessions = manager.getSessionsByBaseBranch("develop", "repo-a");
		expect(sessions).toHaveLength(0);
	});

	it("filters by repository ID correctly", () => {
		manager.createCyrusAgentSession(
			"session-1",
			"issue-1",
			{
				id: "issue-1",
				identifier: "TEST-1",
				title: "Test Issue",
				description: "test",
				branchName: "test-1",
			},
			{ path: "/tmp/ws1", isGitWorktree: true },
			"linear",
			[
				{
					repositoryId: "repo-a",
					branchName: "test-1",
					baseBranchName: "main",
				},
			],
		);

		// Same branch name but different repo
		const sessions = manager.getSessionsByBaseBranch("main", "repo-b");
		expect(sessions).toHaveLength(0);
	});

	it("returns multiple sessions tracking the same base branch", () => {
		manager.createCyrusAgentSession(
			"session-1",
			"issue-1",
			{
				id: "issue-1",
				identifier: "TEST-1",
				title: "Test Issue",
				description: "test",
				branchName: "test-1",
			},
			{ path: "/tmp/ws1", isGitWorktree: true },
			"linear",
			[
				{
					repositoryId: "repo-a",
					branchName: "test-1",
					baseBranchName: "main",
				},
			],
		);

		manager.createCyrusAgentSession(
			"session-2",
			"issue-2",
			{
				id: "issue-2",
				identifier: "TEST-2",
				title: "Test Issue 2",
				description: "test",
				branchName: "test-2",
			},
			{ path: "/tmp/ws2", isGitWorktree: true },
			"linear",
			[
				{
					repositoryId: "repo-a",
					branchName: "test-2",
					baseBranchName: "main",
				},
			],
		);

		const sessions = manager.getSessionsByBaseBranch("main", "repo-a");
		expect(sessions).toHaveLength(2);
	});

	it("only returns active sessions (not completed ones)", async () => {
		manager.createCyrusAgentSession(
			"session-1",
			"issue-1",
			{
				id: "issue-1",
				identifier: "TEST-1",
				title: "Test Issue",
				description: "test",
				branchName: "test-1",
			},
			{ path: "/tmp/ws1", isGitWorktree: true },
			"linear",
			[
				{
					repositoryId: "repo-a",
					branchName: "test-1",
					baseBranchName: "main",
				},
			],
		);

		// Complete the session
		await manager.completeSession("session-1", {
			type: "result",
			subtype: "success",
			duration_ms: 1,
			duration_api_ms: 1,
			is_error: false,
			num_turns: 1,
			result: "done",
			stop_reason: null,
			total_cost_usd: 0,
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation: null,
			},
		});

		const sessions = manager.getSessionsByBaseBranch("main", "repo-a");
		expect(sessions).toHaveLength(0);
	});

	it("clears provider continuation state before a fresh planning retry", () => {
		const session = manager.createCyrusAgentSession(
			"session-retry",
			"issue-retry",
			{
				id: "issue-retry",
				identifier: "TEST-RETRY",
				title: "Retry planning",
				description: "test",
				branchName: "test-retry",
			},
			{ path: "/tmp/retry", isGitWorktree: false },
		);
		const stop = vi.fn();
		session.agentRunner = {
			stop,
		} as unknown as NonNullable<typeof session.agentRunner>;
		session.claudeSessionId = "claude-old";
		session.geminiSessionId = "gemini-old";
		session.codexSessionId = "codex-old";
		session.cursorSessionId = "cursor-old";
		session.opencodeSessionId = "opencode-old";

		const reset = manager.resetRunnerContinuation("session-retry");

		expect(stop).toHaveBeenCalledOnce();
		expect(reset.agentRunner).toBeUndefined();
		expect(reset.claudeSessionId).toBeUndefined();
		expect(reset.geminiSessionId).toBeUndefined();
		expect(reset.codexSessionId).toBeUndefined();
		expect(reset.cursorSessionId).toBeUndefined();
		expect(reset.opencodeSessionId).toBeUndefined();
	});
});
