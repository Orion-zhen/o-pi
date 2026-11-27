import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { bashRequest, commandCwd, usePolicyFixture } from "./policy-fixture.ts";

const fixture = usePolicyFixture();
const { decide, withPathFact } = fixture;
const shellTempRoot = os.tmpdir().replaceAll("\\", "/");

it.skipIf(process.platform === "win32")("后台构建日志和退出状态按可能的写入目标评估", async () => {
	const request = await bashRequest('log=$(mktemp /tmp/comfyui-thor-build.XXXXXX); (docker compose --progress plain build --no-cache comfyui >"$log" 2>&1; echo $? >"${log}.exit") </dev/null >/dev/null 2>&1 & echo "$log"');
	expect(decide(request)).toEqual({ kind: "allow" });
	const fallback = path.join(commandCwd, ".exit");
	for (const glob of [fallback, "/tmp/comfyui-thor-build.123456.exit"]) {
		const config = withPathFact(glob);
		expect(decide(request, config)).toMatchObject({ kind: "deny", rule_name: "protected" });
	}
});

it.skipIf(process.platform === "win32")("只有空输出对应的目标命中系统目录时，只询问该目标", async () => {
	const request = await bashRequest('f=$(mktemp /tmp/run.XXXXXX); echo ok >"${f}.status"', {}, "/etc");
	expect(decide(request, withPathFact("/etc/**", "ask"))).toMatchObject({ kind: "ask", items: [{
		unit: { target: { kind: "path", value: "/etc/.status" } },
	}] });
});

it.skipIf(process.platform === "win32")("变量别名和已知片段保留目录约束，不继承新文件身份", async () => {
	const command = 'f=$(mktemp "/etc/app.XXXXXX"); ext=.status; name="${f}${ext}"; alias="$name"; echo ok >"$alias"';
	const request = await bashRequest(command);
	expect(decide(request, withPathFact("/etc/**", "ask"))).toMatchObject({ kind: "ask", items: [{ unit: {
		target: { kind: "path", directory: "/etc" }, remember: false,
	} }] });
	expect(request.units).toContainEqual(expect.objectContaining({ target: { kind: "path", value: path.join(commandCwd, ".status") } }));
});

it.each([
	'read unknown; f=$(mktemp /tmp/app.XXXXXX); echo ok >"${f}${unknown}"',
	'f=$(mktemp /tmp/app.XXXXXX); echo ok >"${f}/../../etc/config"',
	'mktemp() { echo /etc/config; }; f=$(mktemp /tmp/app.XXXXXX); echo ok >"${f}.state"',
	'if test -n "$X"; then f=$(mktemp /etc/app.XXXXXX); else f=$(mktemp /tmp/app.XXXXXX); fi; echo ok >"${f}.state"',
])("无法证明目录约束时仍审批: %s", async (command) => {
	expect(decide(await bashRequest(command))).toMatchObject({ kind: "ask", reason: "确认动态命令" });
});

it("已证明仅影响 mktemp 临时目录的脚本默认放行", async () => {
	const request = await bashRequest(`
set -eu
root="$PWD"
tmpdir=$(mktemp -d)
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT
cat > "$tmpdir/input.txt" <<'EOF'
content
EOF
for engine in xelatex lualatex; do
	(cd "$tmpdir" && TOOL_INPUT="$root//:" "$engine" input.txt > result.txt)
done
`);
	expect(decide(request)).toEqual({ kind: "allow" });
});

it.each([
	["mktemp 静态模板", `tmp=$(mktemp /tmp/pi-XXXX.ts)\ncat > "$tmp"\nrm -f "$tmp"`],
	["安全重赋值", `tmp="${shellTempRoot}/a"\ntmp="${shellTempRoot}/b"\nrm -rf "$tmp"`],
	["声明式赋值", `readonly tmp=$(mktemp -d)\nrm -rf "$tmp"`],
	["分支合并", `if test -n x; then tmp="${shellTempRoot}/a"; else tmp="${shellTempRoot}/b"; fi\nrm -rf "$tmp"`],
	["EXIT trap", `cleanup() { rm -rf "$tmp"; }\ntrap cleanup EXIT\ntmp=$(mktemp -d)`],
	["Git 临时工作区", `tmp=$(mktemp -d)\ngit -C "$tmp" clean -fd`],
	["包装 cd", `tmp=$(mktemp -d)\n(command cd "$tmp" && rm -rf .)`],
	["嵌套 Shell cwd", `tmp=$(mktemp -d)\n(cd "$tmp" && bash -c "rm -rf .")`],
	["嵌套 Shell 参数", `bash -c 'rm -rf "$1"' _ "${shellTempRoot}/pi-approval-work"`],
	["受限参数展开", `tmp=$(mktemp -d)\nrm -rf "\${tmp:?}/child"`],
	["临时路径 glob", `rm -rf ${shellTempRoot}/pi-approval-*`],
	["已清除 EXIT trap", "trap 'git push origin main' EXIT\ntrap - EXIT\necho ok"],
] as const)("可证明局部副作用时默认放行: %s", async (_name, command) => {
	expect(decide(await bashRequest(command))).toEqual({ kind: "allow" });
});

it("短路失败没有注册 EXIT 清理，也不读取 cache 的启动值", async () => {
	const command = `cache=$(mktemp -d) && export PLAYWRIGHT_BROWSERS_PATH="$cache" && trap 'rm -rf "$cache"' EXIT && bun run playwright install --only-shell chromium && bun run playwright test`;
	for (const env of [{}, { cache: "/workspace/old" }]) {
		const request = await bashRequest(command, env);
		expect(request.detail.environment).toBeUndefined();
		expect(decide(request)).toEqual({ kind: "allow" });
	}
});

it("退出时按注册分支的目录和最终文件名检查报告", async () => {
	const request = await bashRequest(`if test -f release; then dir=dist; trap 'echo done >"$dir/build.$ext"' EXIT; else dir=preview; trap 'echo done >"$dir/test.$ext"' EXIT; fi; ext=log`);
	for (const target of ["dist/build.log", "preview/test.log"]) expect(decide(request, withPathFact(`${request.cwd}/${target}`)).kind).toBe("deny");
	expect(decide(request, withPathFact(`${request.cwd}/preview/build.log`)).kind).toBe("allow");
});

it("退出时仍检查条件声明的清理函数写入", async () => {
	const request = await bashRequest('if test -f release; then finish() { echo done >>report.log; }; fi; trap finish EXIT');
	expect(decide(request, withPathFact(`${request.cwd}/report.log`)).kind).toBe("deny");
});

it.each([
	`cache=$(mktemp -d) && trap 'rm -rf "$cache"' EXIT; cache=/workspace/data`,
	`cache=$(mktemp -d) && trap 'rm -rf "$cache"' EXIT; if test -f flag; then cache=/workspace/data; fi`,
	`cache=$(mktemp -d) && trap 'rm -rf "$cache"' EXIT; read cache`,
	`prepare() { read cache; }; run() { prepare; }; cache=$(mktemp -d) && trap 'rm -rf "$cache"' EXIT; run`,
	`cache=/workspace/data; trap 'rm -rf "$cache"' EXIT; test -f ready || exit 1; cache=$(mktemp -d)`,
])("注册后清理目标不再保证是临时目录时仍审批: %s", async (command) => {
	expect(decide(await bashRequest(command))).toMatchObject({ kind: "ask", reason: "确认清理范围" });
});

it("if 条件成功注册的 EXIT 动作不继承失败分支的工作目录", async () => {
	const request = await bashRequest(`cache=$(mktemp -d); if cd "$cache" && test -f ready; then trap 'rm -rf ./cache' EXIT; fi`);
	expect(decide(request)).toEqual({ kind: "allow" });
});

it("同一 EXIT 动作仍检查可达的启动值", async () => {
	const request = await bashRequest(`if test -f ready; then cache=$(mktemp -d); fi; trap 'rm -rf "$cache"' EXIT`, { cache: "/workspace/archive" });
	expect(request.detail.environment).toEqual({ cache: "/workspace/archive" });
	expect(decide(request)).toMatchObject({ kind: "ask", reason: "确认清理范围" });
});

it("EXIT 动作超出分支预算时不按部分结果放行", async () => {
	const cases = Array.from({ length: 9 }, (_, i) => `${i}) trap 'echo ${i}' EXIT;;`);
	const request = await bashRequest(`read mode; case "$mode" in ${cases.join(" ")} esac`);
	expect(decide(request)).toMatchObject({ kind: "ask", reason: "确认动态命令" });
});

it("系统临时目录后代中的递归删除默认放行，但目录根本身仍询问", async () => {
	const tempRoot = os.tmpdir();
	expect(decide(await bashRequest(`rm -rf "${path.join(tempRoot, "pi-approval", "work")}"`))).toEqual({ kind: "allow" });
	expect(decide(await bashRequest(`rm -rf "${tempRoot}"`))).toMatchObject({ kind: "ask" });
});

it("默认要求审批时，临时目录中的 rmdir -p 不享受临时范围豁免", async () => {
	fixture.config.tools.shell.default_action = "ask";
	const target = `"${shellTempRoot}/prototype/output"`;
	expect(decide(await bashRequest(`rmdir ${target}`)).kind).toBe("allow");
	expect(decide(await bashRequest(`rmdir -p ${target}`)).kind).toBe("ask");
});

it("目录名不是临时豁免的依据", async () => {
	expect(decide(await bashRequest("rm -rf var/tmp/pi-approval-work")).kind).toBe("ask");
});

it.each([
	`tmpdir=/etc\nrm -rf "$tmpdir"`,
	`tmpdir=$(mktemp -d)\nread tmpdir\nrm -rf "$tmpdir"`,
	`tmpdir=$(mktemp -d)\nsudo rm -rf "$tmpdir"`,
	`tmp='/tmp/a /etc'\nrm -rf $tmp`,
	'tmp=$(mktemp -d); git --no-optional-locks -C "$tmp" clean -fd',
	`if test -n "$X"; then cd /tmp/a && true; else cd /etc && true; fi\nrm -rf .`,
	`tmp=$(mktemp -d)\n(cd "$tmp" && bash -c 'cd /etc; rm -rf .')`,
	`tmp=/etc\ntest -n "$X" && tmp=/tmp/a\nrm -rf "$tmp"`,
	`tmp="/etc/$(mktemp)"\nrm -rf "$tmp"`,
])("临时范围无法静态证明时仍询问: %s", async (command) => {
	expect(decide(await bashRequest(command)).kind).toBe("ask");
});
