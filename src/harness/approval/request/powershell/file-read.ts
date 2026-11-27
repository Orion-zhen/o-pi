import path from "node:path";
import type { SyntaxNode } from "../../../syntax-tree/types.ts";
import type { ShellArgv } from "../../types.ts";
import type { Binding, Environment, Flow } from "./flow.ts";
import { filePath } from "./locations.ts";
import { scalar } from "./values.ts";

/** .NET 使用进程工作目录解析相对路径，不随 Set-Location 改变。 */
function readPath(value: string | undefined, cwd: string | undefined): string | undefined {
	if (process.platform !== "win32" && value?.startsWith("/")) return path.posix.normalize(value);
	return filePath(value, cwd, true);
}

export function fileRead(node: SyntaxNode, flow: Flow, env: Environment, cwd: string | undefined): { commands: ShellArgv[]; operand: SyntaxNode; output: Binding } | undefined {
	if (node.type !== "invokation_expression") return;
	const [receiver, op, member, args] = node.children;
	if (receiver?.type !== "type_literal" || !/^\[(?:System\.)?IO\.File\]$/iu.test(receiver.text) || op?.text !== "::") return;
	const method = member?.text.toLowerCase(), arg = args?.childForFieldName("argument_expression_list");
	if ((method !== "readalllines" && method !== "readalltext") || !arg || arg.namedChildCount !== 1) return;
	const paths = (scalar(arg, flow, env)?.values ?? [undefined]).map(value => readPath(value, cwd));
	const raw = method === "readalltext";
	return { operand: arg, commands: paths.map(p => ["get-content", ...(raw ? ["-raw"] : []), "-literalpath", p ?? { source: arg.text, unresolved: true }]),
		output: { type: raw ? "string" : "unknown", values: [undefined] } };
}
