import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

function replaceOnce(source, before, after, file) {
	if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) {
		throw new Error(`Upstream build adapter no longer matches: ${file}`);
	}
	return source.replace(before, after);
}

/** 适配依赖资源路径和加载时机，不改写 Pi 模块。升级依赖时严格检查文本匹配。 */
export function runtimePlugin() {
	return {
		name: "opi-runtime-assets",
		setup(build) {
			build.onResolve({ filter: /^undici$/ }, () => ({ path: require.resolve("undici/index.js") }));
			// UMD 工厂中的相对 require 无法在 Node 单文件产物中解析。
			build.onResolve({ filter: /^jsonc-parser$/ }, () => ({ path: require.resolve("jsonc-parser/lib/esm/main.js") }));
			build.onLoad({ filter: /[\\/](@napi-rs[\\/]canvas|@resvg[\\/]resvg-js)[\\/]js-binding\.js$/ }, ({ path }) => ({
				contents: `module.exports = require(process.env.PI_OPI_RESOURCE_DIR + "/native/${path.includes("canvas") ? "canvas" : "resvg"}.node");`,
				loader: "js",
			}));
			build.onLoad({ filter: /[\\/]photon-node[\\/]photon_rs\.js$/ }, async ({ path }) => ({
				contents: replaceOnce(await readFile(path, "utf8"),
					"require('path').join(__dirname, 'photon_rs_bg.wasm')",
					'process.env.PI_OPI_RESOURCE_DIR + "/wasm/photon_rs_bg.wasm"', path),
				loader: "js",
			}));
			build.onLoad({ filter: /[\\/]pdfjs-dist[\\/]legacy[\\/]build[\\/]pdf\.mjs$/ }, async ({ path }) => {
				const source = replaceOnce(await readFile(path, "utf8"),
					'process.type !== "browser"', 'process.type !== "browser" && process.type !== "utility"', path);
				if (source.split('require("@napi-rs/canvas")').length !== 3) throw new Error(`PDF canvas adapter no longer matches: ${path}`);
				return { contents: 'import * as opiCanvas from "@napi-rs/canvas";\n' + source.replaceAll('require("@napi-rs/canvas")', "opiCanvas"), loader: "js" };
			});
			build.onLoad({ filter: /[\\/]node-notifier[\\/]notifiers[\\/](notificationcenter|toaster|balloon)\.js$/ }, async ({ path }) => ({
				contents: (await readFile(path, "utf8")).replaceAll("__dirname", '(process.env.PI_OPI_RESOURCE_DIR + "/notifier/notifiers")'),
				loader: "js",
			}));
		},
	};
}
