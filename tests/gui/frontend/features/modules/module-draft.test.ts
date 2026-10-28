import { readFileSync } from "node:fs";
import { applyEdits, modify } from "jsonc-parser";
import { expect, it } from "vitest";
import { parseModuleDraft, readModuleConfig } from "../../../../../src/gui/frontend/features/modules/module-draft.ts";

const defaults = readModuleConfig(readFileSync(new URL("../../../../../agent/defaults/web-tools.jsonc", import.meta.url), "utf8"));

it("网络设置继承未修改的代理字段，表单重置后恢复默认", () => {
	const content = '// 自定义代理\n{"network":{"proxy":{"enabled":true,"http_proxy":"http://127.0.0.1:7890"}}}';
	const draft = parseModuleDraft(content, defaults);
	expect(draft.error).toBe("");
	expect(draft.value).toMatchObject({ network: { proxy: {
		enabled: true, http_proxy: "http://127.0.0.1:7890", https_proxy: "", socks5_proxy: "",
	} } });
	const reset = applyEdits(content, modify(content, ["network", "proxy"], undefined, {}));
	expect(parseModuleDraft(reset, defaults).value).toEqual(defaults);
	expect(parseModuleDraft("", defaults).value).toEqual(defaults);
});

it("搜索引擎调整保留顺序，清空排除域名不会重新继承默认列表", () => {
	const draft = parseModuleDraft('{"websearch":{"primary_providers":["brave_api","exa_api","tavily","exa_mcp"],"exclude_domains":[]}}', defaults);
	expect(draft.error).toBe("");
	expect(draft.value).toMatchObject({ websearch: {
		primary_providers: ["brave_api", "exa_api", "tavily", "exa_mcp"], exclude_domains: [],
	} });
});

it("未完成的 JSONC 不伪装成默认配置", () => {
	const draft = parseModuleDraft('{"network":', defaults);
	expect(draft.value).toBeUndefined();
	expect(draft.error).toBe("JSONC 必须是有效对象。");
});
