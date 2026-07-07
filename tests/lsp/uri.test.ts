import path from "node:path";
import { describe, expect, it } from "vitest";

import { fileUriToPath, pathToFileUri } from "../../src/lsp/uri.js";

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
});
