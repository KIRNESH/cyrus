import type { CyrusAgentSession, ILogger, RepositoryConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	type IChatToolResolver,
	type IMcpConfigProvider,
	type IRunnerSelector,
	RunnerConfigBuilder,
	WORKFLOW_MUTATION_TOOLS,
	WORKFLOW_READ_ONLY_TOOLS,
} from "../src/RunnerConfigBuilder.js";

const logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

function build(
	runnerType: "claude" | "codex",
	workflowMode: "planning" | "manual_verification" | "implementation",
	sandbox = false,
	sandboxWritablePaths?: string[],
) {
	const tools: IChatToolResolver = {
		buildChatAllowedTools: () => [],
	};
	const mcp: IMcpConfigProvider = {
		buildMcpConfig: () => ({
			"cyrus-tools": { command: "node", args: ["server.js"] },
			github: { command: "node", args: ["github.js"] },
		}),
		buildMergedMcpConfigPath: () => undefined,
	};
	const selector: IRunnerSelector = {
		determineRunnerSelection: () => ({ runnerType }),
		getDefaultRunner: () => runnerType,
		getDefaultModelForRunner: () => "test-model",
		getDefaultFallbackModelForRunner: () => undefined,
	};
	const builder = new RunnerConfigBuilder(tools, mcp, selector);
	const session = {
		id: "session-1",
		issueId: "issue-1",
		issue: { identifier: "TEST-1" },
		workspace: { path: "/worktree/test-1", isGitWorktree: false },
		repositories: [],
	} as unknown as CyrusAgentSession;
	return builder.buildIssueConfig({
		session,
		repository: {
			id: "repo-1",
			name: "Repo",
			repositoryPath: "/repo",
			baseBranch: "main",
		} as RepositoryConfig,
		sessionId: "session-1",
		systemPrompt: "system",
		allowedTools: [
			"Read(**)",
			"Edit(**)",
			"Write(**)",
			"Bash",
			"NotebookEdit",
			"Task",
			"EnterWorktree",
			"mcp__github",
		],
		allowedDirectories: ["/repo"],
		disallowedTools: [],
		linearWorkspaceId: "workspace-1",
		cyrusHome: "/tmp/cyrus",
		logger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "workspace-1",
		workflowMode,
		...(sandboxWritablePaths ? { sandboxWritablePaths } : {}),
		...(sandbox ? { sandboxSettings: { enabled: true } } : {}),
	}).config as Record<string, unknown>;
}

describe("RunnerConfigBuilder custom workflow permissions", () => {
	it("prevents every repository mutation path in Claude planning mode", () => {
		const config = build("claude", "planning", true, [
			"/home/operator/.supabase",
		]);
		expect(config.allowedTools).toEqual([...WORKFLOW_READ_ONLY_TOOLS]);
		for (const mutation of WORKFLOW_MUTATION_TOOLS) {
			expect(config.disallowedTools).toContain(mutation);
		}
		expect(config.hooks).toEqual({});
		expect(config.sandbox).toMatchObject({
			filesystem: expect.objectContaining({ allowWrite: [] }),
		});
	});

	it("forces a Codex read-only permission profile even when the global sandbox is off", () => {
		const config = build("codex", "planning", false);
		expect(config.allowedTools).toEqual([...WORKFLOW_READ_ONLY_TOOLS]);
		expect(config.sandbox).toBe("read-only");
		expect(config.sandboxSettings).toEqual({
			allowWrite: [],
			allowRead: ["/worktree/test-1", "/repo"],
		});
		expect(config.configOverrides).toEqual({
			sandbox_workspace_write: { network_access: false },
		});
	});

	it("exposes only the result callback MCP tool during Manual verification", () => {
		for (const runner of ["claude", "codex"] as const) {
			const config = build(runner, "manual_verification", false);
			expect(config.allowedTools).toEqual([
				...WORKFLOW_READ_ONLY_TOOLS,
				"mcp__cyrus-tools__linear_manual_verification_result",
			]);
			expect(config.allowedTools).not.toContain("mcp__github");
			expect(config.disallowedTools).toContain("Bash");
		}
	});

	it("preserves normal implementation permissions and hooks", () => {
		const config = build("claude", "implementation", true);
		expect(config.allowedTools).toContain("Bash");
		expect(config.allowedTools).toContain("Edit(**)");
		expect(config.hooks).not.toEqual({});
		expect(config.sandbox).toMatchObject({
			filesystem: expect.objectContaining({ allowWrite: ["/worktree/test-1"] }),
		});
	});
});
