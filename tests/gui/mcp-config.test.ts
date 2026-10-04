import { describe, expect, it } from "vitest";
import { mcpObject, parseMcpConfig, validateMcpConfig, validateMcpServer } from "../../src/gui/mcp-validation.ts";
import { changeMcpTransport, copyMcpServer, createMcpDraft, createMcpServer, importMcpServers, mcpDraftIssues, mcpId, mcpServerSummary, mcpServerValue, nextMcpName, writeMcpDraft } from "../../src/gui/ui/settings/mcp-draft.ts";
import { parseMcpCommand } from "../../src/gui/ui/settings/mcp-command.ts";
import { mcpEditorContent, readMcpEditor } from "../../src/gui/ui/settings/mcp-editor.ts";

it("编辑、复制、删除服务保留凭据、未知字段与全局选项", () => {
	const original = {
		autoEnableCodemode: false, extra: { untouched: true },
		mcpServers: {
			docs: { type: "streamable-http", url: "https://user:secret@example.com/private?token=hidden", headers: { Authorization: "Bearer ${TOKEN}" }, oauth: { clientSecret: "!secret-helper", custom: 1 }, extra: [1, 2] },
			local: { command: "uvx", args: ["server", "path with spaces", ""], env: { TOKEN: "${LOCAL_TOKEN}" }, enabled: false },
		},
	};
	const draft = createMcpDraft(parseMcpConfig(JSON.stringify(original)));
	const server = draft.servers[0];
	if (!server) throw new Error("服务未加载");
	expect(mcpServerSummary(server)).toBe("example.com");
	expect(JSON.parse(writeMcpDraft(draft))).toEqual(original);
	const copy = copyMcpServer(server, nextMcpName(draft, "docs-copy"));
	draft.servers = [{ ...server, name: "renamed" }, copy];
	expect(JSON.parse(writeMcpDraft(draft))).toEqual({ ...original, mcpServers: { renamed: original.mcpServers.docs, "docs-copy": original.mcpServers.docs } });
});

it("草稿比较忽略界面状态与行 ID，保留未知字段中的同名属性", () => {
	const content = '{ "id": 1, "mcpServers": { "one": { "command": "node", "id": 2, "authMode": "extension", "env": { "KEY": "value" } } } }';
	const editor = readMcpEditor(content);
	if (editor.mode !== "form") throw new Error("表单未加载");
	expect(editor.draft.root).not.toHaveProperty("mcpServers");
	const server = editor.draft.servers[0];
	if (!server) throw new Error("服务未加载");
	editor.draft.servers = [{ ...copyMcpServer(server, server.name), authMode: "headers" }];
	expect(mcpEditorContent(editor)).toBe(content);
	editor.draft.root.id = 3;
	expect(JSON.parse(mcpEditorContent(editor) ?? "null").id).toBe(3);
});

it("复制与编辑中间态保留重复行，不能序列化时仍有未保存修改", () => {
	const editor = readMcpEditor('{"mcpServers":{"one":{"command":"node","env":{"KEY":"value"}}}}');
	if (editor.mode !== "form") throw new Error("表单未加载");
	const server = editor.draft.servers[0];
	if (!server?.maps.env) throw new Error("服务未加载");
	server.maps.env.push({ id: mcpId(), key: "KEY", value: "value" });
	const copy = copyMcpServer(server, "copy");
	expect(copy.maps.env?.map(({ key, value }) => ({ key, value }))).toEqual([
		{ key: "KEY", value: "value" }, { key: "KEY", value: "value" },
	]);
	expect(mcpEditorContent(editor)).toBeUndefined();
	server.maps.env.pop();
	expect(mcpEditorContent(editor)).toBe(editor.source);
});

it("认证模式只在读取时初始化，保存不包含界面状态", () => {
	const content = JSON.stringify({ mcpServers: {
		auto: { url: "https://example.com" },
		bearer: { url: "https://example.com", headers: { Authorization: "Bearer token", "X-Key": "value" } },
		headers: { url: "https://example.com", headers: { "X-Key": "value" } },
		provider: { url: "https://example.com", auth: { provider: "p" } },
	} });
	const draft = createMcpDraft(parseMcpConfig(content));
	expect(draft.servers.map(({ authMode }) => authMode)).toEqual(["auto", "bearer", "headers", "provider"]);
	expect(JSON.parse(writeMcpDraft(draft))).toEqual(JSON.parse(content));
});

it("损坏和空文件保留原文，显式源码编辑不改变格式", () => {
	for (const content of ["", "{", '{"mcpServers":false}']) expect(mcpEditorContent(readMcpEditor(content))).toBe(content);
	const content = ' \n{"mcpServers":{}}\n';
	expect(mcpEditorContent(readMcpEditor(content))).toBe(content);
	expect(mcpEditorContent({ mode: "source", content })).toBe(content);
});

it("草稿保留重名和未完成的键值行，阻止静默覆盖", () => {
	const draft = createMcpDraft(parseMcpConfig('{"mcpServers":{"a-b":{"command":"node","env":{"KEY":"one"}},"other":{"command":"uvx"}}}'));
	const first = draft.servers[0], second = draft.servers[1];
	if (!first || !second) throw new Error("服务未加载");
	second.name = "a_b";
	first.maps.env?.push({ id: 1, key: "KEY", value: "two" }, { id: 2, key: "", value: "unfinished" });
	expect(mcpDraftIssues(draft, first)).toEqual(expect.arrayContaining([
		expect.objectContaining({ field: "name" }), expect.objectContaining({ field: "env" }),
	]));
	expect(first.maps.env).toHaveLength(3);
});

it("工具通配规则顺序和精确规则在表单回写中保留", () => {
	const draft = createMcpDraft(parseMcpConfig('{"mcpServers":{"tools":{"command":"node","exposure":"codemode-deferred","toolExposure":{"get_*":"deferred","*":"hidden","get_one":"direct"}}}}'));
	const server = draft.servers[0];
	if (!server?.maps.toolExposure) throw new Error("规则未加载");
	server.maps.toolExposure.reverse();
	const saved = parseMcpConfig(writeMcpDraft(draft));
	expect(validateMcpConfig(saved)).toEqual([]);
	expect(Object.keys(JSON.parse(writeMcpDraft(draft)).mcpServers.tools.toolExposure)).toEqual(["get_one", "*", "get_*"]);
});

it("切换传输只清理不适用的连接字段", () => {
	const original = createMcpServer("docs", { url: "https://example.com/mcp", auth: { provider: "provider" }, headers: { Authorization: "secret" }, oauth: { clientId: "id" }, enabled: false, timeout: 2.5, extra: true, toolExposure: { "*": "hidden" } });
	if (!mcpObject(original.config)) throw new Error("服务配置不是对象");
	const local = changeMcpTransport({ ...original, config: original.config }, false);
	expect(mcpServerValue(local)).toEqual({ type: "stdio", command: "", enabled: false, timeout: 2.5, extra: true, toolExposure: { "*": "hidden" } });
	const stdio = createMcpServer("docs", { command: "node", args: ["server"], env: { SECRET: "token" }, cwd: ".", description: "docs" });
	if (!mcpObject(stdio.config)) throw new Error("服务配置不是对象");
	const remote = changeMcpTransport({ ...stdio, config: stdio.config }, true);
	expect(mcpServerValue(remote)).toEqual({ type: "http", url: "", description: "docs" });
});

it("导入支持整份配置与单个服务，不导入全局选项", () => {
	expect(importMcpServers('{"autoEnableCodemode":false,"mcpServers":{"one":{"command":"npx"},"two":{"url":"https://example.com/mcp"}}}').map(({ name }) => name)).toEqual(["one", "two"]);
	const [single] = importMcpServers('{"command":"uvx","env":{"TOKEN":"${TOKEN}"}}');
	if (!single) throw new Error("服务未导入");
	expect(mcpServerValue(single)).toEqual({ command: "uvx", env: { TOKEN: "${TOKEN}" } });
	for (const text of ["[]", "{", "{}", '{"mcpServers":{}}', '{"mcpServers":[]}']) expect(() => importMcpServers(text)).toThrow();
});

it("损坏配置不能被当成空列表覆盖，单个损坏服务可保留修复", () => {
	for (const text of ["{", "[]", '{"mcpServers":true}']) expect(() => parseMcpConfig(text)).toThrow();
	const draft = createMcpDraft(parseMcpConfig('{"mcpServers":{"bad":false,"valid":{"command":"node"}}}'));
	expect(draft.servers).toHaveLength(2);
	expect(JSON.parse(writeMcpDraft(draft)).mcpServers.bad).toBe(false);
	expect(validateMcpConfig(parseMcpConfig(writeMcpDraft(draft)))).toHaveLength(1);
});

describe("保存前校验服务字段", () => {
	it.each([
		{ command: "" }, { command: "node", args: "server" }, { command: "node", env: { KEY: 1 } },
		{ command: "node", timeout: 0 }, { command: "node", timeout: -1 }, { command: "node", enabled: "true" },
		{ url: "ftp://example.com" }, { url: "https://example.com", type: "sse" }, { url: "https://example.com", headers: [] },
		{ url: "http://example.com", auth: { provider: "p" } }, { url: "https://example.com", auth: { provider: "" } },
		{ command: "node", toolExposure: { "*": "unknown" } },
	])("拒绝 %j", (config) => expect(validateMcpServer("valid", config).length).toBeGreaterThan(0));

	it.each([
		{ callbackPort: 0 }, { callbackPort: 1.5 }, { callbackPort: 65536 },
		{ callbackUrl: "https://localhost/callback" }, { callbackUrl: "http://evil.example/callback" },
		{ callbackUrl: "http://localhost/callback?query=1" }, { callbackUrl: "http://localhost:123/callback", callbackPort: 456 },
		{ clientRegistration: "cimd", clientId: "id" }, { clientRegistration: "cimd", clientName: "name" },
		{ clientRegistration: "cimd", callbackUrl: "http://[::1]/callback" }, { clientRegistration: "cimd", callbackUrl: "http://localhost/other" },
		{ authServerMetadataUrl: "http://example.com/metadata" }, { clientName: " " },
		{ clientRegistration: ["dcr"] }, { clientRegistration: ["cimd"] },
	])("拒绝不合法的 OAuth %j", (oauth) => expect(validateMcpServer("valid", { url: "https://example.com", oauth }).length).toBeGreaterThan(0));

	it("接受完整 OAuth、回环认证与旧暴露别名", () => {
		expect(validateMcpConfig(parseMcpConfig(JSON.stringify({ autoEnableCodemode: true, mcpServers: {
			remote: { type: "streamable-http", url: "http://127.0.0.1/mcp", auth: { provider: "p" }, exposure: "codemode-deferred", toolExposure: { "*": "codemode-deferred" }, oauth: {
				clientId: "id", clientSecret: "${SECRET}", callbackUrl: "http://localhost:8765/callback", callbackPort: 8765,
				scope: "read write", clientName: "client", clientRegistration: "dcr", authServerMetadataUrl: "https://example.com/metadata",
			} },
		} })))).toEqual([]);
	});
});

it("源码与表单共用键名校验，表单额外拒绝 JSON 无法表达的重复行", () => {
	for (const config of [
		{ url: "https://example.com", headers: { Authorization: "one", authorization: "two" } },
		{ url: "https://example.com", headers: { "": "value" } },
		{ command: "node", env: { "": "value" } },
		{ command: "node", toolExposure: { "": "hidden" } },
	]) {
		const content = JSON.stringify({ mcpServers: { one: config } });
		const draft = createMcpDraft(parseMcpConfig(content));
		expect(validateMcpConfig(parseMcpConfig(content)).length).toBeGreaterThan(0);
		expect(draft.servers.flatMap((server) => mcpDraftIssues(draft, server)).length).toBeGreaterThan(0);
	}
});

it("源码拒绝空文本，不能通过切换表单绕过清空配置的要求", () => {
	for (const content of ["", " ", "\n\t"]) expect(() => parseMcpConfig(content)).toThrow("请使用 {} 清空配置");
});

it("启动命令粘贴保留引号内空格和空参数，不执行 shell", () => {
	expect(parseMcpCommand('npx -y server "path with spaces" \'\' path\\ with\\ spaces')).toEqual({ command: "npx", args: ["-y", "server", "path with spaces", "", "path with spaces"] });
	expect(parseMcpCommand('node "a\\\"b" \'$literal\'')).toEqual({ command: "node", args: ['a"b', "$literal"] });
	for (const command of ["", "node | cat", "node > output", "node && other", "KEY=value node", "node $(cmd)", "node `cmd`", "node \"unclosed", "node\\", "node\nother"]) expect(() => parseMcpCommand(command)).toThrow();
});
