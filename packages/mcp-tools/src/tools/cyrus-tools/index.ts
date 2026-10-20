import { tmpdir } from "node:os";
import { basename, extname } from "node:path";
import { IssueRelationType, type LinearClient } from "@linear/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "fs-extra";
import OpenAI from "openai";
import { z } from "zod";
import { registerImageTools } from "../image-tools/index.js";
import { registerSoraTools } from "../sora-tools/index.js";
import { registerGetAgentSessionContentsTool } from "./get-agent-session-contents.js";
import {
	type FailureModesHttpClient,
	type ResolveSessionFromCwd,
	registerLogFailureModeTool,
} from "./log-failure-mode.js";

/**
 * Detect MIME type based on file extension
 */
function getMimeType(filename: string): string {
	const ext = extname(filename).toLowerCase();
	const mimeTypes: Record<string, string> = {
		// Images
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".gif": "image/gif",
		".svg": "image/svg+xml",
		".webp": "image/webp",
		".bmp": "image/bmp",
		".ico": "image/x-icon",

		// Documents
		".pdf": "application/pdf",
		".doc": "application/msword",
		".docx":
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		".xls": "application/vnd.ms-excel",
		".xlsx":
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		".ppt": "application/vnd.ms-powerpoint",
		".pptx":
			"application/vnd.openxmlformats-officedocument.presentationml.presentation",

		// Text
		".txt": "text/plain",
		".md": "text/markdown",
		".csv": "text/csv",
		".json": "application/json",
		".xml": "application/xml",
		".html": "text/html",
		".css": "text/css",
		".js": "application/javascript",
		".ts": "application/typescript",

		// Archives
		".zip": "application/zip",
		".tar": "application/x-tar",
		".gz": "application/gzip",
		".rar": "application/vnd.rar",
		".7z": "application/x-7z-compressed",

		// Media
		".mp3": "audio/mpeg",
		".wav": "audio/wav",
		".mp4": "video/mp4",
		".mov": "video/quicktime",
		".avi": "video/x-msvideo",
		".webm": "video/webm",

		// Other
		".log": "text/plain",
		".yml": "text/yaml",
		".yaml": "text/yaml",
	};

	return mimeTypes[ext] || "application/octet-stream";
}

/**
 * Options for creating Cyrus tools with session management capabilities
 */
export interface CyrusToolsOptions {
	/**
	 * Callback to register a child-to-parent session mapping
	 * Called when a new agent session is created
	 */
	onSessionCreated?: (childSessionId: string, parentSessionId: string) => void;

	/**
	 * Callback to deliver feedback to a parent session
	 * Called when feedback is given to a child session
	 */
	onFeedbackDelivery?: (
		childSessionId: string,
		message: string,
	) => Promise<boolean>;

	/**
	 * The ID of the current parent session (if any)
	 */
	parentSessionId?: string;

	/** Create and persist a human-owned Manual blocker for the current session. */
	onManualBlockerRequested?: (input: {
		sessionId: string;
		key: string;
		title: string;
		why: string;
		options?: string;
		steps: string;
		handBack: string;
		verify: string;
	}) => Promise<{
		issueIdentifier: string;
		issueUrl?: string;
		created: boolean;
	}>;

	/** Record the read-only verification result for a completed Manual issue. */
	onManualVerificationResult?: (input: {
		sessionId: string;
		blockerKey: string;
		success: boolean;
		result: string;
	}) => Promise<{ resumeImplementation: boolean }>;

	/** Validate a PR/check snapshot and post a persistent merge interaction. */
	onMergeApprovalRequested?: (input: {
		sessionId: string;
		pullRequestNumber: number;
		previewUrl?: string;
	}) => Promise<{ pullRequestUrl: string; headSha: string; created: boolean }>;

	/**
	 * Optional dependencies for the `log_failure_mode` tool. When omitted,
	 * the tool is not registered (e.g. in CLI mode without a control plane).
	 */
	failureModes?: {
		resolveSessionFromCwd: ResolveSessionFromCwd;
		httpClient: FailureModesHttpClient;
	};
}

/**
 * Create a standard MCP SDK server with Cyrus tools.
 */
export function createCyrusToolsServer(
	linearClient: LinearClient,
	options: CyrusToolsOptions = {},
): McpServer {
	const server = new McpServer({
		name: "cyrus-tools",
		version: "1.0.0",
	});
	registerGetAgentSessionContentsTool(server, linearClient);

	server.registerTool(
		"linear_upload_file",
		{
			description:
				"Upload a file to Linear. Returns an asset URL that can be used in issue descriptions or comments.",
			inputSchema: {
				filePath: z
					.string()
					.describe("The absolute path to the file to upload"),
				filename: z
					.string()
					.optional()
					.describe(
						"The filename to use in Linear (optional, defaults to basename of filePath)",
					),
				contentType: z
					.string()
					.optional()
					.describe(
						"MIME type of the file (optional, auto-detected if not provided)",
					),
				makePublic: z
					.boolean()
					.optional()
					.describe(
						"Whether to make the file publicly accessible (default: false)",
					),
			},
		},
		async ({ filePath, filename, contentType, makePublic }) => {
			try {
				const stats = await fs.stat(filePath);
				if (!stats.isFile()) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									success: false,
									error: `Path ${filePath} is not a file`,
								}),
							},
						],
					};
				}

				const fileBuffer = await fs.readFile(filePath);
				const finalFilename = filename || basename(filePath);
				const finalContentType = contentType || getMimeType(finalFilename);
				const size = stats.size;

				const uploadPayload = await linearClient.fileUpload(
					finalContentType,
					finalFilename,
					size,
					{ makePublic },
				);

				if (!uploadPayload.success || !uploadPayload.uploadFile) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									success: false,
									error: "Failed to get upload URL from Linear",
								}),
							},
						],
					};
				}

				const { uploadUrl, headers, assetUrl } = uploadPayload.uploadFile;
				const uploadHeaders: Record<string, string> = {
					"Content-Type": finalContentType,
					"Cache-Control": "public, max-age=31536000",
				};

				for (const header of headers) {
					uploadHeaders[header.key] = header.value;
				}

				const uploadResponse = await fetch(uploadUrl, {
					method: "PUT",
					headers: uploadHeaders,
					body: fileBuffer,
				});

				if (!uploadResponse.ok) {
					const errorText = await uploadResponse.text();
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									success: false,
									error: `Failed to upload file: ${uploadResponse.status} ${uploadResponse.statusText} - ${errorText}`,
								}),
							},
						],
					};
				}

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: true,
								assetUrl,
								filename: finalFilename,
								size,
								contentType: finalContentType,
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
				};
			}
		},
	);

	server.registerTool(
		"linear_agent_give_feedback",
		{
			description:
				"Provide feedback to a child agent session to continue its processing.",
			inputSchema: {
				agentSessionId: z
					.string()
					.describe("The ID of the child agent session to provide feedback to"),
				message: z
					.string()
					.describe("The feedback message to send to the child agent session"),
			},
		},
		async ({ agentSessionId, message }) => {
			if (!agentSessionId) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: "agentSessionId is required",
							}),
						},
					],
				};
			}

			if (!message) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: "message is required",
							}),
						},
					],
				};
			}

			if (options.onFeedbackDelivery) {
				try {
					await options.onFeedbackDelivery(agentSessionId, message);
				} catch (error) {
					console.error("[CyrusTools] Failed to deliver feedback:", error);
				}
			}

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							success: true,
						}),
					},
				],
			};
		},
	);

	server.registerTool(
		"linear_create_manual_blocker",
		{
			description:
				"Create a human-owned, non-delegated Manual issue and block the current agent issue. Use only for credentials/accounts, spending/vendor lock-in, DNS/OAuth/billing/identity/provider consoles, host services/packages, production deployment decisions, or actions outside the worktree/agent authority. Never include or request a secret.",
			inputSchema: {
				key: z
					.string()
					.regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i)
					.describe("Stable idempotency key for this blocker"),
				title: z.string().min(1).describe("Concise Manual issue title"),
				why: z
					.string()
					.min(1)
					.describe("One sentence explaining what is blocked"),
				options: z
					.string()
					.optional()
					.describe(
						"Only for a real decision: cost, effort, lock-in, risks, recommendation",
					),
				steps: z
					.string()
					.min(1)
					.describe("Exact browser actions or commands for the human"),
				handBack: z
					.string()
					.min(1)
					.describe(
						"Where a non-secret result belongs; never request a secret",
					),
				verify: z
					.string()
					.min(1)
					.describe("Non-secret verification Cyrus will run after completion"),
			},
		},
		async ({
			key,
			title,
			why,
			options: decisionOptions,
			steps,
			handBack,
			verify,
		}) => {
			if (!options.parentSessionId || !options.onManualBlockerRequested) {
				return toolError("Manual blocker workflow is unavailable");
			}
			try {
				const result = await options.onManualBlockerRequested({
					sessionId: options.parentSessionId,
					key,
					title,
					why,
					...(decisionOptions ? { options: decisionOptions } : {}),
					steps,
					handBack,
					verify,
				});
				return toolSuccess(result);
			} catch {
				return toolError(
					"Manual blocker creation was refused. Check that the body contains no secrets or requests to post secrets.",
				);
			}
		},
	);

	server.registerTool(
		"linear_manual_verification_result",
		{
			description:
				"Report the non-secret result of the required read-only verification after a Manual issue is completed. Failure keeps the workflow blocked.",
			inputSchema: {
				blockerKey: z.string().min(1),
				success: z.boolean(),
				result: z.string().min(1).describe("Non-secret verification evidence"),
			},
		},
		async ({ blockerKey, success, result }) => {
			if (!options.parentSessionId || !options.onManualVerificationResult) {
				return toolError("Manual verification workflow is unavailable");
			}
			try {
				return toolSuccess(
					await options.onManualVerificationResult({
						sessionId: options.parentSessionId,
						blockerKey,
						success,
						result,
					}),
				);
			} catch {
				return toolError("Manual verification result was refused");
			}
		},
	);

	server.registerTool(
		"github_request_merge_approval",
		{
			description:
				"Request explicit merge approval for the current issue after its Cyrus-created pull request exists and all required checks pass. Cyrus re-fetches the PR and checks; never call this before CI is green.",
			inputSchema: {
				pullRequestNumber: z.number().int().positive(),
				previewUrl: z.string().url().optional(),
			},
		},
		async ({ pullRequestNumber, previewUrl }) => {
			if (!options.parentSessionId || !options.onMergeApprovalRequested) {
				return toolError("Merge approval workflow is unavailable");
			}
			try {
				return toolSuccess(
					await options.onMergeApprovalRequested({
						sessionId: options.parentSessionId,
						pullRequestNumber,
						...(previewUrl ? { previewUrl } : {}),
					}),
				);
			} catch {
				return toolError(
					"Merge approval request was refused. Verify the pull request identity and required checks before retrying.",
				);
			}
		},
	);

	server.registerTool(
		"linear_set_issue_relation",
		{
			description:
				"Create a relationship between two Linear issues. Use this to set 'blocks', 'related', or 'duplicate' relationships. For Graphite stacking workflows, use 'blocks' type where the blocking issue is the one that must be completed first.",
			inputSchema: {
				issueId: z
					.string()
					.describe(
						"The BLOCKING issue (the one that must complete first). For 'blocks' type: this issue blocks relatedIssueId. Example: 'PROJ-123' or UUID",
					),
				relatedIssueId: z
					.string()
					.describe(
						"The BLOCKED issue (the one that depends on issueId). For 'blocks' type: this issue is blocked by issueId. Example: 'PROJ-124' or UUID",
					),
				type: z
					.enum(["blocks", "related", "duplicate"])
					.describe(
						"The type of relation: 'blocks' (issueId blocks relatedIssueId - use for Graphite stacking), 'related' (issues are related), 'duplicate' (issueId is a duplicate of relatedIssue)",
					),
			},
		},
		async ({ issueId, relatedIssueId, type }) => {
			try {
				const issue = await linearClient.issue(issueId);
				const relatedIssue = await linearClient.issue(relatedIssueId);

				if (!issue) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									success: false,
									error: `Issue ${issueId} not found`,
								}),
							},
						],
					};
				}

				if (!relatedIssue) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									success: false,
									error: `Related issue ${relatedIssueId} not found`,
								}),
							},
						],
					};
				}

				const relationTypeMap: Record<
					"blocks" | "related" | "duplicate",
					IssueRelationType
				> = {
					blocks: IssueRelationType.Blocks,
					related: IssueRelationType.Related,
					duplicate: IssueRelationType.Duplicate,
				};
				const relationType = relationTypeMap[type];

				const result = await linearClient.createIssueRelation({
					issueId: issue.id,
					relatedIssueId: relatedIssue.id,
					type: relationType,
				});

				const relation = await result.issueRelation;

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: true,
								relationId: relation?.id,
								message: `Successfully created '${type}' relation: ${issue.identifier} ${type} ${relatedIssue.identifier}`,
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
				};
			}
		},
	);

	server.registerTool(
		"linear_get_child_issues",
		{
			description:
				"Get all child issues (sub-issues) for a given Linear issue. Takes an issue identifier like 'CYHOST-91' and returns a list of child issue ids and their titles.",
			inputSchema: {
				issueId: z
					.string()
					.describe(
						"The ID or identifier of the parent issue (e.g., 'CYHOST-91' or UUID)",
					),
				limit: z
					.number()
					.optional()
					.describe(
						"Maximum number of child issues to return (default: 50, max: 250)",
					),
				includeCompleted: z
					.boolean()
					.optional()
					.describe(
						"Whether to include completed child issues (default: true)",
					),
				includeArchived: z
					.boolean()
					.optional()
					.describe(
						"Whether to include archived child issues (default: false)",
					),
			},
		},
		async ({
			issueId,
			limit = 50,
			includeCompleted = true,
			includeArchived = false,
		}) => {
			try {
				const finalLimit = Math.min(Math.max(1, limit), 250);
				const issue = await linearClient.issue(issueId);

				if (!issue) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									success: false,
									error: `Issue ${issueId} not found`,
								}),
							},
						],
					};
				}

				const filter: any = {};
				if (!includeCompleted) {
					filter.state = { type: { neq: "completed" } };
				}
				if (!includeArchived) {
					filter.archivedAt = { null: true };
				}

				const childrenConnection = await issue.children({
					first: finalLimit,
					...(Object.keys(filter).length > 0 && { filter }),
				});
				const children = await childrenConnection.nodes;

				const childrenData = await Promise.all(
					children.map(async (child) => {
						const [state, assignee] = await Promise.all([
							child.state,
							child.assignee,
						]);

						return {
							id: child.id,
							identifier: child.identifier,
							title: child.title,
							state: state?.name || "Unknown",
							stateType: state?.type || null,
							assignee: assignee?.name || null,
							assigneeId: assignee?.id || null,
							priority: child.priority,
							priorityLabel: child.priorityLabel,
							createdAt: child.createdAt.toISOString(),
							updatedAt: child.updatedAt.toISOString(),
							url: child.url,
							archivedAt: child.archivedAt?.toISOString() || null,
						};
					}),
				);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									success: true,
									parentIssue: {
										id: issue.id,
										identifier: issue.identifier,
										title: issue.title,
										url: issue.url,
									},
									childCount: childrenData.length,
									children: childrenData,
								},
								null,
								2,
							),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
				};
			}
		},
	);

	server.registerTool(
		"linear_get_agent_sessions",
		{
			description:
				"Get all agent sessions. Returns a paginated list of agent sessions with their details including status, timestamps, and associated issues.",
			inputSchema: {
				first: z
					.number()
					.optional()
					.describe(
						"Number of items to fetch from the beginning (default: 50, max: 250)",
					),
				after: z
					.string()
					.optional()
					.describe("Cursor to start fetching items after"),
				before: z
					.string()
					.optional()
					.describe("Cursor to start fetching items before"),
				last: z
					.number()
					.optional()
					.describe("Number of items to fetch from the end"),
				includeArchived: z
					.boolean()
					.optional()
					.describe(
						"Whether to include archived agent sessions (default: false)",
					),
				orderBy: z
					.enum(["createdAt", "updatedAt"])
					.optional()
					.describe(
						"Field to order results by (default: updatedAt). Can be 'createdAt' or 'updatedAt'",
					),
			},
		},
		async ({
			first = 50,
			after,
			before,
			last,
			includeArchived = false,
			orderBy,
		}) => {
			try {
				const finalFirst = first
					? Math.min(Math.max(1, first), 250)
					: undefined;
				const finalLast = last ? Math.min(Math.max(1, last), 250) : undefined;

				const variables: any = {};
				if (finalFirst !== undefined) variables.first = finalFirst;
				if (after) variables.after = after;
				if (before) variables.before = before;
				if (finalLast !== undefined) variables.last = finalLast;
				if (includeArchived !== undefined)
					variables.includeArchived = includeArchived;
				if (orderBy) variables.orderBy = orderBy;

				const sessionsConnection = await linearClient.agentSessions(variables);
				const sessions = await sessionsConnection.nodes;

				const sessionsData = sessions.map((session) => ({
					id: session.id,
					createdAt: session.createdAt.toISOString(),
					updatedAt: session.updatedAt.toISOString(),
					startedAt: session.startedAt?.toISOString() || null,
					endedAt: session.endedAt?.toISOString() || null,
					dismissedAt: session.dismissedAt?.toISOString() || null,
					archivedAt: session.archivedAt?.toISOString() || null,
					externalLink: session.externalLink || null,
					summary: session.summary || null,
					plan: session.plan || null,
					sourceMetadata: session.sourceMetadata || null,
				}));

				const pageInfo = await sessionsConnection.pageInfo;

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									success: true,
									count: sessionsData.length,
									sessions: sessionsData,
									pageInfo: {
										hasNextPage: pageInfo.hasNextPage,
										hasPreviousPage: pageInfo.hasPreviousPage,
										startCursor: pageInfo.startCursor,
										endCursor: pageInfo.endCursor,
									},
								},
								null,
								2,
							),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
				};
			}
		},
	);

	server.registerTool(
		"linear_get_agent_session",
		{
			description:
				"Get a single agent session by ID. Returns detailed information about the agent session including its status, timestamps, associated issue, and metadata.",
			inputSchema: {
				sessionId: z
					.string()
					.describe("The ID of the agent session to retrieve (UUID)"),
			},
		},
		async ({ sessionId }) => {
			try {
				const session = await linearClient.agentSession(sessionId);

				if (!session) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									success: false,
									error: `Agent session ${sessionId} not found`,
								}),
							},
						],
					};
				}

				const [issue, creator, appUser, comment, sourceComment, dismissedBy] =
					await Promise.all([
						session.issue,
						session.creator,
						session.appUser,
						session.comment,
						session.sourceComment,
						session.dismissedBy,
					]);

				const sessionData = {
					id: session.id,
					createdAt: session.createdAt.toISOString(),
					updatedAt: session.updatedAt.toISOString(),
					startedAt: session.startedAt?.toISOString() || null,
					endedAt: session.endedAt?.toISOString() || null,
					dismissedAt: session.dismissedAt?.toISOString() || null,
					archivedAt: session.archivedAt?.toISOString() || null,
					externalLink: session.externalLink || null,
					summary: session.summary || null,
					plan: session.plan || null,
					sourceMetadata: session.sourceMetadata || null,
					issue: issue
						? {
								id: issue.id,
								identifier: issue.identifier,
								title: issue.title,
								url: issue.url,
								description: issue.description,
								priority: issue.priority,
								priorityLabel: issue.priorityLabel,
							}
						: null,
					creator: creator
						? {
								id: creator.id,
								name: creator.name,
								email: creator.email,
								displayName: creator.displayName,
							}
						: null,
					appUser: appUser
						? {
								id: appUser.id,
								name: appUser.name,
							}
						: null,
					comment: comment
						? {
								id: comment.id,
								body: comment.body,
								createdAt: comment.createdAt.toISOString(),
							}
						: null,
					sourceComment: sourceComment
						? {
								id: sourceComment.id,
								body: sourceComment.body,
								createdAt: sourceComment.createdAt.toISOString(),
							}
						: null,
					dismissedBy: dismissedBy
						? {
								id: dismissedBy.id,
								name: dismissedBy.name,
								email: dismissedBy.email,
							}
						: null,
				};

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									success: true,
									session: sessionData,
								},
								null,
								2,
							),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
				};
			}
		},
	);

	// Register the log_failure_mode tool whenever the harness wires it up
	// (EdgeWorker provides the cwd→session resolver and an HTTP client to
	// cyrus-hosted). Omitted in CLI mode where there is no control plane.
	if (options.failureModes) {
		registerLogFailureModeTool(server, {
			resolveSessionFromCwd: options.failureModes.resolveSessionFromCwd,
			httpClient: options.failureModes.httpClient,
			fallbackSessionId: options.parentSessionId,
		});
	}

	// Register OpenAI-based tools if OPENAI_API_KEY is available
	const openaiApiKey = process.env.OPENAI_API_KEY;
	if (openaiApiKey) {
		const openaiClient = new OpenAI({
			apiKey: openaiApiKey,
			timeout: 600 * 1000, // 10 minutes
		});
		const outputDirectory = tmpdir();

		registerImageTools(server, openaiClient, outputDirectory);
		registerSoraTools(server, openaiClient, outputDirectory);
	}

	return server;
}

function toolSuccess(value: unknown) {
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify({ success: true, ...asRecord(value) }),
			},
		],
	};
}

function toolError(error: string) {
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify({ success: false, error }),
			},
		],
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null
		? Object.fromEntries(Object.entries(value))
		: { result: value };
}
