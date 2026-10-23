import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import { normalizePath, type Plugin } from "vite";

// 仅业务代码保留排错名称，避免为所有依赖重复生成名称元数据。
export function applicationNames(): Plugin {
	const sourceRoot = normalizePath(fileURLToPath(new URL("../../src/", import.meta.url)));
	return {
		name: "application-names",
		apply: "build",
		enforce: "post",
		async transform(code, id) {
			if (!id.startsWith(sourceRoot) || !/\.[cm]?[jt]sx?$/.test(id)) return;
			return transform(code, { loader: "js", target: "esnext", keepNames: true, sourcemap: "external", sourcefile: id });
		},
	};
}
