import path from "node:path";
import { pathToFileURL } from "node:url";
import { root } from "./runtime.mjs";

export function fromRoot(relativePath) {
	return path.join(root, relativePath);
}

export async function loadTypeScript(relativePath, options = {}) {
	const module = await import(pathToFileURL(fromRoot(relativePath)).href);
	return options.defaultExport ? module.default : module;
}

export function writeJson(value) {
	process.stdout.write(JSON.stringify(value));
}

export { root };
