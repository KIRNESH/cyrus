import { describe, expect, it } from "vitest";
import {
	CYRUS_SANDBOX_PROFILE_ID,
	resolveCodexSandbox,
} from "../src/config/sandboxPolicy.js";

describe("resolveCodexSandbox", () => {
	it("returns a workspace-mode (broad reads) when no sandbox settings are given", () => {
		expect(
			resolveCodexSandbox({
				mode: "workspace-write",
				workingDirectory: "/repo/a",
				writableRoots: ["/repo/b"],
				networkAccess: true,
			}),
		).toEqual({
			kind: "workspace-mode",
			mode: "workspace-write",
			writableRoots: ["/repo/a", "/repo/b"],
			networkAccess: true,
		});
	});

	it("builds a read-restricted permission profile from sandbox settings", () => {
		expect(
			resolveCodexSandbox({
				mode: "workspace-write",
				workingDirectory: "/repo/a",
				writableRoots: ["/repo/b"],
				networkAccess: false,
				sandboxSettings: {
					allowWrite: ["/repo/a", "/repo/out"],
					allowRead: ["/repo/a", "/usr/lib"],
					denyRead: ["/home/secrets"], // honored by omission
				},
			}),
		).toEqual({
			kind: "profile",
			profileId: CYRUS_SANDBOX_PROFILE_ID,
			networkAccess: false,
			filesystem: {
				":minimal": "read",
				":workspace_roots": "write", // the worktree (cwd)
				":tmpdir": "write",
				":slash_tmp": "write",
				"/repo/b": "write", // extra writable root
				"/repo/out": "write", // allowWrite (beyond cwd)
				"/usr/lib": "read", // allowRead (not already writable)
			},
		});
	});

	it("uses native read-only with configured runtime workspace roots", () => {
		expect(
			resolveCodexSandbox({
				mode: "read-only",
				workingDirectory: "/repo/a",
				writableRoots: ["/repo/out"],
				networkAccess: false,
				sandboxSettings: {
					allowRead: ["/repo/a", "/repo/reference"],
					allowWrite: ["/repo/out"],
				},
			}),
		).toEqual({
			kind: "workspace-mode",
			mode: "read-only",
			networkAccess: false,
			writableRoots: ["/repo/a", "/repo/out", "/repo/reference"],
		});
	});

	it("uses native danger-full-access even with filesystem restrictions", () => {
		expect(
			resolveCodexSandbox({
				mode: "danger-full-access",
				workingDirectory: "/repo/a",
				writableRoots: ["/repo/out"],
				networkAccess: true,
				sandboxSettings: { allowRead: ["/repo/a"], allowWrite: ["/repo/out"] },
			}),
		).toEqual({
			kind: "workspace-mode",
			mode: "danger-full-access",
			writableRoots: ["/repo/a", "/repo/out"],
			networkAccess: true,
		});
	});

	it("drops non-absolute and empty paths", () => {
		expect(
			resolveCodexSandbox({
				mode: "workspace-write",
				workingDirectory: "/repo/a",
				writableRoots: ["relative/path", ""],
				networkAccess: true,
				sandboxSettings: { allowRead: ["also/relative", "/ok/read"] },
			}),
		).toEqual({
			kind: "profile",
			profileId: CYRUS_SANDBOX_PROFILE_ID,
			networkAccess: true,
			filesystem: {
				":minimal": "read",
				":workspace_roots": "write",
				":tmpdir": "write",
				":slash_tmp": "write",
				"/ok/read": "read",
			},
		});
	});
});
