import { beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../../../src/gui/frontend/ui/tooltip.tsx";
import { useReactFixture } from "../../helpers/react-fixture.ts";
import { McpServerForm } from "../../../../src/gui/frontend/features/mcp/mcp-server-form.tsx";
import { importMcpServers, mcpDraftIssues } from "../../../../src/gui/frontend/features/mcp/mcp-draft.ts";

const render = useReactFixture();
beforeEach(() => {
	vi.stubGlobal("getComputedStyle", (element: HTMLElement) => element.style);
	vi.stubGlobal("HTMLFormElement", window.HTMLFormElement);
});

it("导入错误 MCP 配置后，字段旁显示校验信息，折叠分组标记待修复", async () => {
	const [server] = importMcpServers('{"url":"https://example.com/mcp","timeout":-1,"oauth":{"clientId":23},"enabled":"yes"}');
	if (!server) throw new Error("服务未导入");
	const issues = mcpDraftIssues([server]).flatMap(({ issues }) => issues);
	await render(<TooltipProvider><McpServerForm server={server} issues={issues} disabled={false} change={() => {}} /></TooltipProvider>);
	const alerts = [...document.querySelectorAll('[role="alert"]')].map((element) => element.textContent);
	for (const { message } of issues) expect(alerts.filter((text) => text?.includes(message))).toHaveLength(1);
	const groups = [...document.querySelectorAll('[data-slot="collapsible-trigger"]')].map((element) => element.textContent);
	expect(groups).toContain("工具与高级设置（需修复）");
	expect(groups).toContain("OAuth 高级设置（需修复）");
	expect(alerts).toContain("enabled：启用状态必须是布尔值。 请使用 JSON 修复。");
});

it.each([
	'{"url":"https://example.com/mcp","exposure":"invalid"}',
	'{"url":"https://example.com/mcp","oauth":{"clientRegistration":"invalid"}}',
])("从 JSON 导入的枚举错误只在对应字段显示一次：%s", async (content) => {
	const [server] = importMcpServers(content);
	if (!server) throw new Error("服务未导入");
	const issues = mcpDraftIssues([server]).flatMap(({ issues }) => issues);
	await render(<TooltipProvider><McpServerForm server={server} issues={issues} disabled={false} change={() => {}} /></TooltipProvider>);
	expect([...document.querySelectorAll('[role="alert"]')].map((element) => element.textContent)).toEqual(issues.map(({ message }) => message));
	const field = document.querySelector('[role="alert"]')?.closest(".mcp-field");
	expect(field?.querySelector('[role="radiogroup"]')).toBeTruthy();
});

it("工具规则保留逐行错误，合法选项与支持的别名不报错", async () => {
	const [server] = importMcpServers('{"command":"node","toolExposure":{"valid":"direct","alias":"codemode-deferred","invalid":"unknown","unfinished":""}}');
	if (!server) throw new Error("服务未导入");
	const issues = mcpDraftIssues([server]).flatMap(({ issues }) => issues);
	await render(<TooltipProvider><McpServerForm server={server} issues={issues} disabled={false} change={() => {}} /></TooltipProvider>);
	expect([...document.querySelectorAll(".mcp-pair")].map((row) => row.querySelector('[role="alert"]')?.textContent))
		.toEqual([undefined, undefined, "无效值：unknown", "无效值：空"]);
});
