import { describe, expect, it } from "vitest";
import {
	assertNonSecretText,
	formatManualIssueBody,
	redactSensitiveText,
} from "../src/ManualIssueContract.js";

describe("Manual issue contract", () => {
	it("formats the exact required headings and omits Options when no decision exists", () => {
		expect(
			formatManualIssueBody({
				why: "A human must configure the provider console.",
				steps: "1. Open the provider console.\n2. Enable the callback.",
				handBack: "Mark this issue Done after the public callback is visible.",
				verify:
					"Fetch the public callback endpoint and confirm a 200 response.",
			}),
		).toBe(`## Why
A human must configure the provider console.

## Steps
1. Open the provider console.
2. Enable the callback.

## Hand-back
Mark this issue Done after the public callback is visible.

## Verify
Fetch the public callback endpoint and confirm a 200 response.`);
	});

	it("includes Options only for a real decision", () => {
		const body = formatManualIssueBody({
			why: "The vendor plan requires a human purchasing decision.",
			options:
				"Free: no cost, more effort, no lock-in. Paid: $10, low effort, vendor lock-in risk. Recommend Free.",
			steps: "Choose the approved plan in the vendor console.",
			handBack: "Record only the selected plan name here.",
			verify: "Read the public account tier endpoint.",
		});
		expect(body).toContain("## Options\nFree:");
	});

	it.each([
		"password=hunter2",
		"sk-123456789012345678901234567890",
		"Paste the access token into a Linear comment",
		"Share the private key in the GitHub issue",
	])("refuses secret values and requests: %s", (unsafe) => {
		expect(() =>
			formatManualIssueBody({
				why: "A human action is required.",
				steps: unsafe,
				handBack: "Mark Done.",
				verify: "Check a public endpoint.",
			}),
		).toThrow(/secret/i);
		expect(() => assertNonSecretText(unsafe)).toThrow(/secret/i);
	});

	it("redacts credential-shaped values before errors are logged", () => {
		expect(
			redactSensitiveText("request failed: api_key=super-secret-value"),
		).toBe("request failed: [REDACTED]");
	});
});
