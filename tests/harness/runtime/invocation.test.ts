import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { childInvocation } from "../../../src/harness/runtime/invocation.ts";

afterEach(() => vi.unstubAllGlobals());

it("桌面协调进程复用后端入口并强制使用 Node 模式，不启动窗口", () => {
	const entry = path.resolve("dist/desktop/app/backend.mjs");
	const env = { ...process.env, ELECTRON_RUN_AS_NODE: "0" };
	vi.stubGlobal("process", { ...process, versions: { ...process.versions, electron: "42.0.0" }, argv: [process.execPath, entry], env });
	const args = ["--opi-discord-daemon", "presence.sock"];
	expect(childInvocation(args)).toEqual({
		command: process.execPath, args: [entry, ...args], env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
	});
	expect(env.ELECTRON_RUN_AS_NODE).toBe("0");
});
