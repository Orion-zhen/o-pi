import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileToolsConfigProvider } from "../../../src/harness/file-tools/config.ts";
import { preserveEnv, useTempDir } from "../../helpers/lifecycle.ts";

const temp = useTempDir("o-pi-file-config-");
preserveEnv("PI_FILE_TOOLS_CONFIG", "PI_FILE_TOOLS_PROJECT_CONFIG", "PI_FILE_TOOLS_PROJECT_ROOT");
let provider: FileToolsConfigProvider;
beforeEach(() => {
	provider = new FileToolsConfigProvider();
	process.env.PI_FILE_TOOLS_CONFIG = path.join(temp.path, "user.jsonc");
	delete process.env.PI_FILE_TOOLS_PROJECT_CONFIG;
	delete process.env.PI_FILE_TOOLS_PROJECT_ROOT;
});
afterEach(() => provider.dispose());
const save = (config: unknown) => writeFile(path.join(temp.path, "user.jsonc"), JSON.stringify(config));
async function load(cwd = temp.path) {
	const result = await provider.load(cwd);
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

describe("文件工具配置", () => {
	it("稀疏覆盖保留默认保护，配置更改和修复在后续调用生效", async () => {
		const defaults = await load();
		expect(defaults.filesystem.blockedPaths).toEqual(expect.arrayContaining(["~/.ssh/id_*", "~/.aws/credentials", ".env"]));
		await save({ limits: { ls_entries: 0 } });
		await expect(provider.load(temp.path)).resolves.toMatchObject({ ok: false });
		await save({ limits: { ls_entries: 12 } });
		expect((await load()).limits).toEqual({ ...defaults.limits, ls_entries: 12 });
	});

	it.each([{ unknown: true }, { limits: { read_max_file_bytes: 1023 } }, { limits: { read_pdf_pages: 101 } }])(
		"拒绝非法配置 %j", async (config) => {
			await save(config);
			await expect(provider.load(temp.path)).resolves.toMatchObject({ ok: false });
		},
	);

	it("项目追加保护路径并覆盖限制，各工作区并发读取互不串用", async () => {
		await save({ blocked_path: ["user-block/"], ignored_path: ["user-ignore/"], limits: { write_max_file_bytes: 2048 } });
		const roots = ["a", "b"].map((name) => path.join(temp.path, name));
		await Promise.all(roots.map(async (root, index) => {
			const directory = path.join(root, ".pi/configs");
			await mkdir(directory, { recursive: true });
			await writeFile(path.join(directory, "file-tools.jsonc"), JSON.stringify({
				blocked_path: ["project-block/"], ignored_path: ["project-ignore/"],
				limits: { ls_entries: index + 1 }, ignore: { builtin_profile: "performance" },
			}));
		}));
		const values = await Promise.all(roots.map(load));
		expect(values.map((value) => value.limits.ls_entries)).toEqual([1, 2]);
		for (const value of values) expect(value).toMatchObject({
			filesystem: {
				blockedPaths: ["user-block/", "project-block/"],
				visibility: { ignoredPaths: ["user-ignore/", "project-ignore/"], ignore: { builtinProfile: "performance" } },
			},
			limits: { write_max_file_bytes: 2048 },
		});
	});

	it.each(["piignore", "gitignore", "git_tracked_files_bypass"])("项目不能改写用户开关 %s", async (field) => {
		await save({ ignore: { [field]: false } });
		const project = path.join(temp.path, "project.jsonc");
		process.env.PI_FILE_TOOLS_PROJECT_CONFIG = project;
		await writeFile(project, JSON.stringify({ ignore: { [field]: true } }));
		await expect(provider.load(temp.path)).resolves.toMatchObject({
			ok: false, error: { details: { path: project, fields: [`ignore.${field}`] } },
		});
	});
});
