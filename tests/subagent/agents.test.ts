import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { formatAgents } from "../../src/subagent/commands.js";
import { discoverAgents, resolveSubagentTools } from "../../src/subagent/agents.js";
import { loadSubagentConfig } from "../../src/subagent/config.js";
import { preserveEnv, setTestHome, useTempDir } from "../helpers/lifecycle.js";

let dir: string;
const agentDirEnv = "PI_CODING_AGENT_DIR";
const temp = useTempDir("o-pi-subagent-agents-");
preserveEnv(agentDirEnv, "HOME", "USERPROFILE");

beforeEach(async () => {
	dir = temp.path;
	process.env[agentDirEnv] = path.join(dir, "agent");
	setTestHome(dir);
	await mkdir(path.join(dir, "agent", "agents"), { recursive: true });
});

describe("subagent agent discovery", () => {
	it("加载用户 Agent 并解析 tools", async () => {
		await writeFile(path.join(dir, "agent", "agents", "scout.md"), agentMarkdown("scout", "Scout", "read, grep"));
		const found = discoverAgents(dir, await loadSubagentConfig(dir));
		expect(found.agents[0]).toMatchObject({ name: "scout", tools: ["read", "grep"], source: "user" });
	});

	it.each([
		[undefined, false],
		["false", false],
		["true", true],
	] as const)("解析 fork: %s", async (forkValue, expected) => {
		const forkLine = forkValue === undefined ? "" : `fork: ${forkValue}\n`;
		await writeFile(path.join(dir, "agent", "agents", "fork.md"), `---\nname: fork\ndescription: Fork\n${forkLine}tools: read\n---\nFork body.`);

		const found = discoverAgents(dir, await loadSubagentConfig(dir));

		expect(found.agents[0]).toMatchObject({ fork: expected, body: "Fork body." });
		expect(found.warnings.some((warning) => warning.includes("unknown frontmatter"))).toBe(false);
	});

	it.each([
		["fork: \"true\"", "string"],
		["fork: 1", "number"],
		["fork: { enabled: true }", "object"],
	])("拒绝非布尔 fork (%s)", async (line) => {
		await writeFile(path.join(dir, "agent", "agents", "bad-fork.md"), `---\nname: bad-fork\ndescription: Bad\n${line}\n---\nBody.`);

		const found = discoverAgents(dir, await loadSubagentConfig(dir));

		expect(found.agents).toHaveLength(0);
		expect(found.warnings[0]).toContain("fork must be a boolean");
	});

	it.each([
		["model: null", "model must be a non-empty string"],
		["timeout_ms: 0", "timeout_ms must be an integer between"],
		["tools: read, read", "tools must not contain duplicates"],
	])("在 frontmatter 边界拒绝无效可选字段 (%s)", async (line, message) => {
		await writeFile(
			path.join(dir, "agent", "agents", "invalid.md"),
			`---\nname: invalid\ndescription: Invalid\n${line}\n---\nBody.`,
		);

		const found = discoverAgents(dir, await loadSubagentConfig(dir));

		expect(found.agents).toHaveLength(0);
		expect(found.warnings[0]).toContain(message);
	});

	it("统一解析 Agent Markdown 的执行元数据", async () => {
		await writeFile(
			path.join(dir, "agent", "agents", "worker.md"),
			"---\nname: worker\ndescription: Worker\nmodel: provider/model\ntools: read, edit\ntimeout_ms: 120000\nauto_confirm: true\n---\nImplement the task.",
		);

		const found = discoverAgents(dir, await loadSubagentConfig(dir));

		expect(found.agents[0]).toMatchObject({
			name: "worker",
			description: "Worker",
			body: "Implement the task.",
			fork: false,
			model: "provider/model",
			tools: ["read", "edit"],
			timeoutMs: 120000,
			autoConfirm: true,
		});
	});

	it("忽略用户目录和项目目录中的 .agents/agents", async () => {
		const project = path.join(dir, "project");
		await mkdir(path.join(dir, ".agents", "agents"), { recursive: true });
		await mkdir(path.join(project, ".agents", "agents"), { recursive: true });
		await writeFile(path.join(dir, ".agents", "agents", "user.md"), agentMarkdown("user", "User", "read"));
		await writeFile(path.join(project, ".agents", "agents", "project.md"), agentMarkdown("project", "Project", "read"));

		const found = discoverAgents(project, { ...await loadSubagentConfig(dir), allowProjectAgents: true });

		expect(found.agents).toEqual([]);
	});

	it("项目 Agent 默认关闭，显式开启后加载", async () => {
		await mkdir(path.join(dir, ".pi", "agents"), { recursive: true });
		await writeFile(path.join(dir, ".pi", "agents", "project.md"), agentMarkdown("project", "Project", "read"));
		expect(discoverAgents(dir, await loadSubagentConfig(dir)).agents.map((agent) => agent.name)).not.toContain("project");
		expect(discoverAgents(dir, { ...await loadSubagentConfig(dir), allowProjectAgents: true }).agents.map((agent) => agent.name)).toContain("project");
	});

	it("同名默认用户 Agent 胜出，固定配置可允许项目覆盖", async () => {
		await writeFile(path.join(dir, "agent", "agents", "same.md"), agentMarkdown("same", "User", "read"));
		await mkdir(path.join(dir, ".pi", "agents"), { recursive: true });
		await writeFile(path.join(dir, ".pi", "agents", "same.md"), agentMarkdown("same", "Project", "read, grep"));
		const base = { ...await loadSubagentConfig(dir), allowProjectAgents: true };
		expect(discoverAgents(dir, base).agents.find((agent) => agent.name === "same")?.description).toBe("User");
		expect(discoverAgents(dir, { ...base, projectAgentsOverrideUser: true }).agents.find((agent) => agent.name === "same")?.description).toBe("Project");
	});

	it("实际传递工具取配置与 registered tools 的交集", async () => {
		await writeFile(path.join(dir, "agent", "agents", "worker.md"), agentMarkdown("worker", "Worker", "read, grep, made_up, edit"));
		const agent = discoverAgents(dir, await loadSubagentConfig(dir)).agents[0];
		if (agent === undefined) throw new Error("worker agent was not discovered");
		expect(resolveSubagentTools(agent, await loadSubagentConfig(dir), ["read", "edit", "subagent"])).toEqual(["read", "edit"]);
	});

	it("/agents 展示 registered tools 交集", async () => {
		await writeFile(path.join(dir, "agent", "agents", "worker.md"), agentMarkdown("worker", "Worker", "read, write"));
		const found = discoverAgents(dir, await loadSubagentConfig(dir));
		const text = formatAgents(found.agents, await loadSubagentConfig(dir), ["read", "write"], {
			model: "test/model",
			tools: ["read", "write"],
			cwd: dir,
		});
		expect(text).toContain("tools: read, write");
		expect(text).toContain("write: yes");
	});

	it("/agents 对 fork 展示父会话最终配置而非声明", async () => {
		await writeFile(
			path.join(dir, "agent", "agents", "forker.md"),
			"---\nname: forker\ndescription: Forker\nfork: true\nmodel: ignored/model\ntools: write\n---\nBody.",
		);
		const found = discoverAgents(dir, await loadSubagentConfig(dir));

		const text = formatAgents(found.agents, await loadSubagentConfig(dir), ["write", "read", "subagent"], {
			model: "parent/model",
			tools: ["read", "subagent"],
			cwd: dir,
		});

		expect(text).toContain("mode: fork");
		expect(text).toContain("model: parent/model");
		expect(text).toContain("tools: read, subagent");
		expect(text).toContain(`cwd: ${dir}`);
		expect(text).not.toContain("ignored/model");
	});

	it("缺少 tools 使用只读默认，缺少 name 拒绝", async () => {
		await writeFile(path.join(dir, "agent", "agents", "a.md"), `---\nname: a\ndescription: A\n---\nbody`);
		await writeFile(path.join(dir, "agent", "agents", "bad.md"), `---\ndescription: Bad\n---\nbody`);
		const found = discoverAgents(dir, await loadSubagentConfig(dir));
		expect(found.agents.find((agent) => agent.name === "a")?.tools).toEqual(["read", "grep", "find", "ls"]);
		expect(found.warnings.some((warning) => warning.includes("name is required"))).toBe(true);
	});

	it.skipIf(process.platform === "win32")("拒绝项目 Agent 符号链接逃逸", async () => {
		const outside = path.join(dir, "outside.md");
		await writeFile(outside, agentMarkdown("outside", "Outside", "read"));
		await mkdir(path.join(dir, ".pi", "agents"), { recursive: true });
		await symlink(outside, path.join(dir, ".pi", "agents", "outside.md"));
		const found = discoverAgents(dir, { ...await loadSubagentConfig(dir), allowProjectAgents: true });
		expect(found.agents.map((agent) => agent.name)).not.toContain("outside");
	});

});

function agentMarkdown(name: string, description: string, tools: string): string {
	return `---\nname: ${name}\ndescription: ${description}\ntools: ${tools}\n---\nbody`;
}
