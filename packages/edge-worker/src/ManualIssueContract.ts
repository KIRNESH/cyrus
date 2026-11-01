export interface ManualIssueBodyInput {
	why: string;
	options?: string;
	steps: string;
	handBack: string;
	verify: string;
}

const SECRET_VALUE_PATTERNS = [
	/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
	/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
	/\bsk-[A-Za-z0-9_-]{20,}\b/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
	/\b(?:password|passwd|api[_ -]?key|client[_ -]?secret|access[_ -]?token)\s*[:=]\s*\S+/i,
];

const SECRET_REQUEST_PATTERNS = [
	/\b(?:paste|post|comment|send|share|reply with|put)\b[^.\n]{0,48}\b(?:secret|password|private key|api key|access token|credential)\b/i,
	/\b(?:secret|password|private key|api key|access token|credential)\b[^.\n]{0,48}\b(?:in|into|to)\b[^.\n]{0,24}\b(?:linear|github|comment|pull request|issue)\b/i,
];

export function assertManualIssueContentIsSafe(
	input: ManualIssueBodyInput,
): void {
	const values = [
		input.why,
		input.options ?? "",
		input.steps,
		input.handBack,
		input.verify,
	];
	for (const value of values) {
		for (const pattern of [
			...SECRET_VALUE_PATTERNS,
			...SECRET_REQUEST_PATTERNS,
		]) {
			if (pattern.test(value)) {
				throw new Error(
					"Manual issue content must not contain or request secrets; use a non-secret hand-back and verification result",
				);
			}
		}
	}

	if (!input.why.trim() || /[\r\n]/.test(input.why.trim())) {
		throw new Error("Manual issue Why must be one non-empty sentence");
	}
	if (!input.steps.trim() || !input.handBack.trim() || !input.verify.trim()) {
		throw new Error("Manual issue Steps, Hand-back, and Verify are required");
	}
}

export function assertNonSecretText(value: string): void {
	for (const pattern of [
		...SECRET_VALUE_PATTERNS,
		...SECRET_REQUEST_PATTERNS,
	]) {
		if (pattern.test(value)) {
			throw new Error("Workflow text contains secret-shaped material");
		}
	}
}

export function formatManualIssueBody(input: ManualIssueBodyInput): string {
	assertManualIssueContentIsSafe(input);
	const sections = [`## Why\n${input.why.trim()}`];
	if (input.options?.trim()) {
		sections.push(`## Options\n${input.options.trim()}`);
	}
	sections.push(
		`## Steps\n${input.steps.trim()}`,
		`## Hand-back\n${input.handBack.trim()}`,
		`## Verify\n${input.verify.trim()}`,
	);
	return sections.join("\n\n");
}

/** Redact credential-shaped material before workflow errors reach logs/activities. */
export function redactSensitiveText(value: string): string {
	let redacted = value;
	for (const pattern of SECRET_VALUE_PATTERNS) {
		const flags = pattern.flags.includes("g")
			? pattern.flags
			: `${pattern.flags}g`;
		redacted = redacted.replace(
			new RegExp(pattern.source, flags),
			"[REDACTED]",
		);
	}
	return redacted;
}
