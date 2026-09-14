import { readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractAssets, type EmbeddedAsset } from "../../src/runtime/extract-assets.js";
import { preserveEnv, setTestHome, useTempDir } from "../helpers/lifecycle.js";

vi.mock("node:fs", { spy: true });

const temp = useTempDir("opi-extract-");
preserveEnv("HOME", "USERPROFILE");
let assets: EmbeddedAsset[];
let cache: string;
const id = "fixture-resources";

beforeEach(() => {
	setTestHome(temp.path);
	cache = path.join(temp.path, ".pi", "cache", "opi");
	const source = path.join(temp.path, "source");
	writeFileSync(source, "embedded resource");
	assets = [{ path: "pdf/cmaps/sample", source, executable: false }];
});

afterEach(() => {
	vi.mocked(renameSync).mockReset();
	vi.unstubAllGlobals();
});

function expectPublished(): void {
	expect(readdirSync(cache)).toEqual([id]);
	expect(readFileSync(path.join(cache, id, "pdf/cmaps/sample"), "utf8")).toBe("embedded resource");
}

describe("资源原子发布", () => {
	it("发布完整目录并复用缓存", () => {
		const destination = extractAssets(id, assets);
		expect(destination).toBe(path.join(cache, id));
		expectPublished();
		vi.mocked(renameSync).mockClear();
		expect(extractAssets(id, assets)).toBe(destination);
		expect(renameSync).not.toHaveBeenCalled();
	});

	it.each([
		["linux", "EEXIST"], ["linux", "ENOTEMPTY"], ["win32", "EPERM"],
	])("%s 的 %s 在另一进程已发布时复用完整目录", (platform, code) => {
		vi.stubGlobal("process", { ...process, platform });
		vi.mocked(renameSync).mockImplementationOnce(() => {
			extractAssets(id, assets);
			throw Object.assign(new Error("destination already published"), { code });
		});
		expect(extractAssets(id, assets)).toBe(path.join(cache, id));
		expectPublished();
	});

	it.each(["EPERM", "EACCES"])("未发布目标时传播 %s 并清理临时目录", (code) => {
		vi.stubGlobal("process", { ...process, platform: "win32" });
		const error = Object.assign(new Error("permission denied"), { code });
		vi.mocked(renameSync).mockImplementationOnce(() => { throw error; });
		expect(() => extractAssets(id, assets)).toThrow(error);
		expect(readdirSync(cache)).toEqual([]);
	});

	it.each([["linux", "EPERM"], ["win32", "EACCES"]])("%s 不因目标存在而吞掉 %s", (platform, code) => {
		vi.stubGlobal("process", { ...process, platform });
		const error = Object.assign(new Error("permission denied"), { code });
		vi.mocked(renameSync).mockImplementationOnce(() => {
			extractAssets(id, assets);
			throw error;
		});
		expect(() => extractAssets(id, assets)).toThrow(error);
		expectPublished();
	});

	it("Windows 不把同名文件视为已发布目录", () => {
		vi.stubGlobal("process", { ...process, platform: "win32" });
		const error = Object.assign(new Error("destination is a file"), { code: "EPERM" });
		vi.mocked(renameSync).mockImplementationOnce(() => {
			writeFileSync(path.join(cache, id), "not a directory");
			throw error;
		});
		expect(() => extractAssets(id, assets)).toThrow(error);
		expect(readdirSync(cache)).toEqual([id]);
	});
});
