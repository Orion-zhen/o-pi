import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-file-tools-benchmark-");
const worker = fileURLToPath(new URL("../../scripts/workers/bench-file-tools-worker.mjs", import.meta.url));

it("注册基准宿主支持真实扩展注册、首次 ls 和关闭", async () => {
	const config = path.join(temp.path, "file-tools.jsonc");
	await writeFile(config, "{}\n");
	const { stdout } = await promisify(execFile)(process.execPath, [worker], {
		cwd: temp.path,
		timeout: 10_000,
		env: { ...process.env, PI_FILE_TOOLS_CONFIG: config, PI_FILE_TOOLS_PROJECT_CONFIG: config },
	});
	const result: unknown = JSON.parse(stdout);
	expect(result).toEqual({ registrationMs: expect.any(Number), firstToolMs: expect.any(Number) });
});
