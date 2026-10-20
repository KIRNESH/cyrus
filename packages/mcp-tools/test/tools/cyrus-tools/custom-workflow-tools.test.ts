import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCyrusToolsServer } from "../../../src/tools/cyrus-tools/index.js";

function parse(result: Awaited<ReturnType<Client["callTool"]>>) {
	const content = result.content as Array<{ type: string; text: string }>;
	return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

describe("cyrus-tools custom workflow callbacks", () => {
	let client: Client;
	let server: ReturnType<typeof createCyrusToolsServer>;
	const onManualBlockerRequested = vi.fn();
	const onManualVerificationResult = vi.fn();
	const onMergeApprovalRequested = vi.fn();

	beforeEach(async () => {
		onManualBlockerRequested.mockResolvedValue({
			issueIdentifier: "MAN-1",
			issueUrl: "https://linear.test/MAN-1",
			created: true,
		});
		onManualVerificationResult.mockResolvedValue({
			resumeImplementation: true,
		});
		onMergeApprovalRequested.mockResolvedValue({
			pullRequestUrl: "https://github.test/cyrus/test/pull/42",
			headSha: "approved-sha",
			created: true,
		});
		server = createCyrusToolsServer({} as never, {
			parentSessionId: "session-1",
			onManualBlockerRequested,
			onManualVerificationResult,
			onMergeApprovalRequested,
		});
		client = new Client({ name: "workflow-test", version: "1.0.0" });
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		await client.connect(clientTransport);
	});

	afterEach(async () => {
		await client.close();
		await server.close();
		vi.clearAllMocks();
	});

	it("binds Manual creation and verification to the current session", async () => {
		const created = await client.callTool({
			name: "linear_create_manual_blocker",
			arguments: {
				key: "dns",
				title: "Configure DNS",
				why: "The documentation preview is blocked on a public DNS record.",
				steps: "Create the documented CNAME in the provider console.",
				handBack: "Mark this issue Done after the public hostname resolves.",
				verify: "Resolve the hostname and inspect its public CNAME.",
			},
		});
		expect(parse(created)).toMatchObject({
			success: true,
			issueIdentifier: "MAN-1",
		});
		expect(onManualBlockerRequested).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "session-1", key: "dns" }),
		);

		const verified = await client.callTool({
			name: "linear_manual_verification_result",
			arguments: {
				blockerKey: "dns",
				success: true,
				result: "The public CNAME resolves to docs.example.test.",
			},
		});
		expect(parse(verified)).toEqual({
			success: true,
			resumeImplementation: true,
		});
		expect(onManualVerificationResult).toHaveBeenCalledWith({
			sessionId: "session-1",
			blockerKey: "dns",
			success: true,
			result: "The public CNAME resolves to docs.example.test.",
		});
	});

	it("requests merge approval through the protected callback and hides failures", async () => {
		const approved = await client.callTool({
			name: "github_request_merge_approval",
			arguments: { pullRequestNumber: 42 },
		});
		expect(parse(approved)).toMatchObject({
			success: true,
			pullRequestUrl: "https://github.test/cyrus/test/pull/42",
		});
		expect(onMergeApprovalRequested).toHaveBeenCalledWith({
			sessionId: "session-1",
			pullRequestNumber: 42,
		});

		onMergeApprovalRequested.mockRejectedValueOnce(
			new Error("Authorization: Bearer secret-token"),
		);
		const refused = await client.callTool({
			name: "github_request_merge_approval",
			arguments: { pullRequestNumber: 42 },
		});
		expect(JSON.stringify(refused)).not.toContain("secret-token");
		expect(parse(refused).success).toBe(false);
	});
});
