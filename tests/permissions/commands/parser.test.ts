import { describe, expect, it } from "vitest";

import { parsePermissionCommand } from "../../../src/permissions/commands/command-parser.js";

describe("permissions command parser", () => {
	it("解析空参数", () => {
		const parsed = parsePermissionCommand("");
		expect(parsed.path).toEqual([]);
		expect(parsed.positionals).toEqual([]);
	});

	it("解析引号、嵌套引号和 shell 命令", () => {
		const parsed = parsePermissionCommand("explain bash \"git commit -m 'fix permissions'\"");
		expect(parsed.path).toEqual(["explain"]);
		expect(parsed.positionals).toEqual(["bash", "git commit -m 'fix permissions'"]);
	});

	it("解析包含空格的路径和布尔 flag", () => {
		const parsed = parsePermissionCommand("roots add \"/home/user/My Data\" read-only --session");
		expect(parsed.path).toEqual(["roots", "add"]);
		expect(parsed.positionals).toEqual(["/home/user/My Data", "read-only"]);
		expect(parsed.flags.get("session")).toBe(true);
	});

	it("支持 -- 后的位置参数", () => {
		const parsed = parsePermissionCommand("explain read -- \"/tmp/--json\" --json");
		expect(parsed.positionals).toEqual(["read", "/tmp/--json", "--json"]);
		expect(parsed.flags.get("json")).toBeUndefined();
	});

	it("未闭合引号报结构化错误", () => {
		expect(() => parsePermissionCommand("explain bash \"git status")).toThrow(/Unclosed quote/);
	});
});
