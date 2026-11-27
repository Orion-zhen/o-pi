import { POWERSHELL_GRAMMAR } from "../../../syntax-tree/grammars.ts";
import { parseSyntaxTree } from "../../../syntax-tree/parser.ts";
import { quotedWordNewlines } from "../../../syntax-tree/powershell.ts";
import type { SyntaxNode, SyntaxTreeDocument } from "../../../syntax-tree/types.ts";
import type { ShellArgv } from "../../types.ts";
import { partialCmdInputs } from "./cmd-input.ts";
import type { AnalysisInput } from "./units.ts";

type ParseResult =
	| { kind: "parsed"; tree: SyntaxTreeDocument; code: string; allowSessionMemory: boolean }
	| { kind: "invalid-script" }
	| { kind: "opaque"; reason: string; commands?: ShellArgv[] };

/** 成功时调用方接管最终语法树。只有待执行的整段脚本可以证明本次调用没有副作用。 */
export async function parsePowerShell(input: AnalysisInput, signal?: AbortSignal): Promise<ParseResult> {
	let code = input.code;
	let tree = await parseWithPathRecovery(code, signal);
	try {
		if (!tree || tree.root.hasError || code.includes("\0")) {
			if (input.kind === "final-script" && tree?.root.hasError && await hasDefiniteSyntaxError(tree, code, signal)) return { kind: "invalid-script" };
			const reason = tree?.root.hasError ? syntaxFailure(tree) : "PowerShell input could not be parsed.";
			return { kind: "opaque", reason: input.depth ? `Nested PowerShell: ${reason}` : reason,
				...(tree?.root.hasError && input.kind !== "redirect" && { commands: partialCmdInputs(tree, code) }) };
		}
		if (input.kind !== "redirect") code = quotedWordNewlines(tree.root, code, tree.control.check);
		if (code !== input.code) {
			const repaired = await parseWithPathRecovery(code, signal);
			tree.dispose();
			tree = repaired;
			if (!tree || tree.root.hasError) return { kind: "opaque", reason: "Cannot resolve an escaped newline." };
		}
		const result: ParseResult = { kind: "parsed", tree, code, allowSessionMemory: code === input.code };
		tree = undefined;
		return result;
	} finally { tree?.dispose(); }
}

/** grammar 可能把参数模式的 $dir/file.ts 当作表达式。只恢复重解析后占据完整命令参数的普通路径。 */
async function parseWithPathRecovery(code: string, signal?: AbortSignal): Promise<SyntaxTreeDocument | undefined> {
	const original = await parseSyntaxTree(POWERSHELL_GRAMMAR, code, signal);
	if (!original?.root.hasError) return original;
	let repaired: SyntaxTreeDocument | undefined;
	try {
		const ranges = new Map<number, number>();
		const tail = /(?:\/[\w.-]+)+(?=$|[\s;|])/uy;
		for (const v of original.root.descendantsOfType("variable")) {
			original.control.check();
			if (!/^\$(?:env:)?[a-z_]\w*$/iu.test(v.text) || !/[ \t]/u.test(code.charAt(v.startIndex - 1)) || code[v.startIndex - 2] === "`") continue;
			if (!isCommandOperand(v)) continue;
			tail.lastIndex = v.endIndex;
			if (tail.test(code)) ranges.set(v.startIndex, tail.lastIndex);
		}
		if (!ranges.size) return original;
		const masked = code.replace(/\$/gu, (dollar, index: number) => ranges.has(index) ? "_" : dollar);
		// 同一回调也为 Node.text 提供文本。建树后恢复原文，保留偏移、插值和审批目标。
		let text = masked;
		repaired = await parseSyntaxTree(POWERSHELL_GRAMMAR, i => text.slice(i, i + 4096), signal);
		text = code;
		if (!repaired || repaired.root.hasError) return original;
		for (const [start, end] of ranges) {
			repaired.control.check();
			const word = repaired.root.descendantForIndex(start, end);
			if (word?.type !== "generic_token" || word.parent?.type !== "command_elements" || word.startIndex !== start || word.endIndex !== end) return original;
		}
		original.dispose();
		const result = repaired; repaired = undefined; return result;
	} catch (error) { original.dispose(); throw error; }
	finally { repaired?.dispose(); }
}

function isCommandOperand(variable: SyntaxNode): boolean {
	for (let node = variable.parent; node; node = node.parent) {
		if (node.type === "command_elements") return true;
		if (node.type === "expandable_string_literal" || node.type === "expandable_here_string_literal" || node.type === "parenthesized_expression") break;
	}
	return false;
}

/** 只确认源码和错误节点共同证明的语法错误。恢复节点本身不能证明 PowerShell 会拒绝脚本。 */
async function hasDefiniteSyntaxError(tree: SyntaxTreeDocument, code: string, signal?: AbortSignal): Promise<boolean> {
	const error = tree.root.isError ? tree.root : tree.root.lastNamedChild;
	if (!error?.isError || /[^ \t\r\n]/u.test(code.slice(error.endIndex))) return false;
	const prefix = code.slice(0, error.startIndex);
	// using module 等指令涉及解析期加载，不据此证明整段没有副作用。
	if (/\busing\b/iu.test(prefix)) return false;
	// 前文只含普通词和语句分隔符，不可能把末尾的括号当作字符串、注释或停止解析后的数据。
	if (!/[^\w$.:/; \t\r\n-]/u.test(prefix)) {
		if (error.text === ")" || error.text === "}") return true;
		if (/^if\s*\(\s*$/iu.test(error.text) && /(?:^|[;\n])[ \t]*$/u.test(prefix)) return true;
	}
	// 参数中的 { 开始脚本块。grammar 可能把它吃进前一个裸词，直到 } 才报错。
	if (error.firstChild?.type !== "}" || !/^[\w./ \t-]*\{[a-z][\w-]*(?:,[\w-]+)+$/iu.test(prefix)
		|| !/^\}[\w./ \t-]*$/u.test(error.text)) return false;
	const body = prefix.slice(prefix.indexOf("{") + 1);
	const block = await parseSyntaxTree(POWERSHELL_GRAMMAR, body, signal);
	if (!block) return false;
	try {
		// 命令名后紧跟逗号，缺少首个参数。数值数组和语言关键字不按命令处理。
		const command = block.root.descendantsOfType("command")[0];
		const name = command?.childForFieldName("command_name");
		const sep = command?.childForFieldName("command_elements")?.firstChild;
		block.control.check();
		return command?.text === body && name?.endIndex === body.indexOf(",") && sep?.firstChild?.isMissing === true;
	} finally { block.dispose(); }
}

function syntaxFailure(tree: SyntaxTreeDocument): string {
	let node = tree.root;
	while (!node.isError && !node.isMissing) {
		tree.control.check();
		const next = node.children.find(c => c.hasError || c.isMissing);
		if (!next) break;
		node = next;
	}
	return `Syntax not recognized at line ${node.startPosition.row + 1}, column ${node.startPosition.column + 1}.`;
}
