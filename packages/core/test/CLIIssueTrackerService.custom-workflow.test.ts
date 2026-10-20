import { IssueRelationType } from "@linear/sdk";
import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/issue-tracker/AgentEvent.js";
import { CLIIssueTrackerService } from "../src/issue-tracker/adapters/CLIIssueTrackerService.js";

describe("CLIIssueTrackerService custom workflow primitives", () => {
	let service: CLIIssueTrackerService;

	beforeEach(() => {
		service = new CLIIssueTrackerService();
		service.seedDefaultData();
	});

	it("persists parent, project, state, Feature label, and supported delegation", async () => {
		const parent = await service.createIssue({
			teamId: "team-default",
			title: "Parent",
			projectId: "project-1",
		});
		const featureLabel = await service.findOrCreateLabel(
			"Feature",
			"team-default",
		);
		const child = await service.createIssue({
			teamId: "team-default",
			title: "Child",
			description: "Approved child",
			parentId: parent.id,
			projectId: "project-1",
			stateId: "state-todo",
			delegateId: "cyrus-app-user",
			labelIds: [featureLabel],
		});
		expect(child.parentId).toBe(parent.id);
		expect(child.projectId).toBe("project-1");
		expect(child.stateId).toBe("state-todo");
		expect(child.delegateId).toBe("cyrus-app-user");
		expect(await service.getIssueLabels(child.id)).toEqual(["Feature"]);
	});

	it("creates a human-owned non-delegated Manual issue and durable blocker relation", async () => {
		const waiting = await service.createIssue({
			teamId: "team-default",
			title: "Waiting implementation",
		});
		const manualLabel = await service.findOrCreateLabel(
			"Manual",
			"team-default",
		);
		const manual = await service.createIssue({
			teamId: "team-default",
			title: "Configure DNS",
			description: "## Why\nA human action is required.",
			stateId: "state-todo",
			assigneeId: "user-default",
			parentId: waiting.id,
			labelIds: [manualLabel],
		});
		expect(manual.assigneeId).toBe("user-default");
		expect(manual.delegateId).toBeUndefined();
		expect(await service.getIssueLabels(manual.id)).toEqual(["Manual"]);

		const first = await service.createIssueRelation({
			issueId: manual.id,
			relatedIssueId: waiting.id,
			type: "blocks",
		});
		const duplicate = await service.createIssueRelation({
			issueId: manual.id,
			relatedIssueId: waiting.id,
			type: "blocks",
		});
		expect(duplicate.relationId).toBe(first.relationId);
		const refreshed = await service.fetchIssue(waiting.id);
		const relations = await refreshed.inverseRelations();
		expect(relations.nodes).toHaveLength(1);
		expect(relations.nodes[0]!.type).toBe(IssueRelationType.Blocks);
		expect((await relations.nodes[0]!.issue)?.id).toBe(manual.id);
	});

	it("emits delegation and responder identities for approval-gate F1 sessions", async () => {
		const events: AgentEvent[] = [];
		const transport = service.createEventTransport({
			platform: "cli",
			fastifyServer: {} as FastifyInstance,
		});
		transport.on("event", (event) => events.push(event));
		const issue = await service.createIssue({
			teamId: "team-default",
			title: "Approval workflow",
		});

		const payload = await service.createAgentSessionOnIssue({
			issueId: issue.id,
		});
		const session = await payload.agentSession;
		await service.promptAgentSession(session!.id, "[Approve|correlation]");

		const created = events[0];
		expect(created?.type).toBe("AgentSessionEvent");
		if (created?.type !== "AgentSessionEvent") throw new Error("wrong event");
		expect(created.action).toBe("created");
		expect(created.agentSession.creator?.id).toBe("user-default");
		expect(created.agentSession.comment?.body).toBe(
			"This thread is for an agent session",
		);

		const prompted = events[1];
		expect(prompted?.type).toBe("AgentSessionEvent");
		if (prompted?.type !== "AgentSessionEvent") throw new Error("wrong event");
		expect(prompted.action).toBe("prompted");
		expect(prompted.agentSession.comment?.body).toBe(
			"This thread is for an agent session",
		);
		expect(prompted.agentActivity?.userId).toBe("user-default");
	});
});
