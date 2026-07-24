import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { readTextNoFollow } from "../../src/repo-map/source.js";
import { useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-repo-map-source-");

describe("Repo Map source reading", () => {
	it("拒绝超过扫描后字节上限的文件，而不是无上限读取", async () => {
		const filePath = path.join(temp.path, "grew.ts");
		await writeFile(filePath, "export const value = 1;\n".repeat(1024));
		const readBounded: (absolutePath: string, signal: AbortSignal | undefined, maxBytes: number) => Promise<string> = readTextNoFollow;

		await expect(readBounded(filePath, undefined, 32)).rejects.toMatchObject({
			name: "RepoMapReadLimitError",
			code: "REPO_MAP_READ_LIMIT_EXCEEDED",
			maxBytes: 32,
		});
	});
});
