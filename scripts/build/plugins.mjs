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
			build.onLoad({ filter: /[\\/]jiti[\\/]lib[\\/]jiti-static\.mjs$/ }, async ({ path }) => {
				// 字面量 require 仍被 Bun 打包，但首次加载外部扩展时才执行模块。
				let source = replaceOnce(await readFile(path, "utf8"),
					'import _createJiti from "../dist/jiti.cjs";\n// Static import so Bun bundles babel.cjs into compiled binaries\nimport _babelTransform from "../dist/babel.cjs";', "", path);
				source = replaceOnce(source, "transform: _babelTransform", 'transform: require("../dist/babel.cjs")', path);
				source = replaceOnce(source, "return _createJiti(id, opts, {", 'return require("../dist/jiti.cjs")(id, opts, {', path);
				return { contents: source, loader: "js" };
			});
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
				const source = await readFile(path, "utf8");
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
