import path from "node:path";
import { describe, expect, it } from "vitest";

import { fileUriToPath, pathToFileUri, workspaceRelativePath } from "../../src/lsp/uri.js";

describe("lsp uri", () => {
	it("本地路径和 file URI 可互转", () => {
		const filePath = path.resolve("/tmp/o pi/你好.ts");
		const uri = pathToFileUri(filePath);
		expect(uri).toMatch(/^file:\/\//);
		expect(fileUriToPath(uri)).toBe(filePath);
	});

	it("拒绝非 file URI", () => {
		expect(fileUriToPath("https://example.com/a.ts")).toBeUndefined();
		expect(fileUriToPath("not a uri")).toBeUndefined();
	});

	it("接受 workspace 内以两个点开头的文件名", () => {
		const root = path.resolve("/tmp/workspace");
		const file = path.join(root, "..config.ts");
		expect(workspaceRelativePath(root, file)).toBe("..config.ts");
	});
});
