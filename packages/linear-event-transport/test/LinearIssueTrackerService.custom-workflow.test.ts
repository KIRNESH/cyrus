import { IssueRelationType, type LinearClient } from "@linear/sdk";
import { describe, expect, it, vi } from "vitest";
import { LinearIssueTrackerService } from "../src/LinearIssueTrackerService.js";

describe("LinearIssueTrackerService custom workflow relations", () => {
	it("reuses an existing inverse relation after a retry", async () => {
		const createIssueRelation = vi.fn();
		const client = {
			issue: vi.fn().mockResolvedValue({
				inverseRelations: vi.fn().mockResolvedValue({
					nodes: [
						{
							id: "relation-existing",
							type: IssueRelationType.Blocks,
							issue: Promise.resolve({ id: "manual-1" }),
						},
					],
				}),
			}),
			createIssueRelation,
		} as unknown as LinearClient;
		const service = new LinearIssueTrackerService(client);

		await expect(
			service.createIssueRelation({
				issueId: "manual-1",
				relatedIssueId: "feature-1",
				type: "blocks",
			}),
		).resolves.toEqual({ success: true, relationId: "relation-existing" });
		expect(createIssueRelation).not.toHaveBeenCalled();
	});

	it("creates the supported Linear relation when no matching relation exists", async () => {
		const createIssueRelation = vi.fn().mockResolvedValue({
			success: true,
			issueRelation: Promise.resolve({ id: "relation-new" }),
		});
		const client = {
			issue: vi.fn().mockResolvedValue({
				inverseRelations: vi.fn().mockResolvedValue({ nodes: [] }),
			}),
			createIssueRelation,
		} as unknown as LinearClient;
		const service = new LinearIssueTrackerService(client);

		await expect(
			service.createIssueRelation({
				issueId: "alpha",
				relatedIssueId: "readme",
				type: "blocks",
			}),
		).resolves.toEqual({ success: true, relationId: "relation-new" });
		expect(createIssueRelation).toHaveBeenCalledWith({
			issueId: "alpha",
			relatedIssueId: "readme",
			type: IssueRelationType.Blocks,
		});
	});
});
