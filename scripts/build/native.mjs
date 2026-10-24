import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { hostPlatform } from "./platform.mjs";

const require = createRequire(import.meta.url);
const install = promisify(execFile);
const bindings = [["canvas", "@napi-rs/canvas"], ["resvg", "@resvg/resvg-js"]];

export async function prepareNativeModules(platform, directory) {
	let resolve = require.resolve;
	if (platform.name !== hostPlatform().name) {
		const dependencies = {};
		for (const [, wrapper] of bindings) {
			const spec = `${wrapper}-${platform.nativeSuffix}`;
			const { optionalDependencies } = JSON.parse(await readFile(require.resolve(`${wrapper}/package.json`), "utf8"));
			const version = optionalDependencies[spec];
			if (!version) throw new Error(`${wrapper} 未提供 ${platform.name} 的预编译包`);
			dependencies[spec] = version;
		}
		await mkdir(directory, { recursive: true });
		const manifest = path.join(directory, "package.json");
		await writeFile(manifest, JSON.stringify({ private: true, dependencies }));
		const args = ["install", "--no-save", "--ignore-scripts", "--os", platform.os, "--cpu", platform.arch];
		if (platform.libc) args.push("--libc", platform.libc);
		console.log(`Installing native modules for ${platform.name}`);
		await install(process.execPath, args, { cwd: directory });
		resolve = createRequire(manifest).resolve;
	}
	return bindings.map(([name, wrapper]) => [name, resolve(`${wrapper}-${platform.nativeSuffix}`)]);
}
