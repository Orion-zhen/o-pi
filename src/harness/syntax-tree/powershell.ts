import type { SyntaxNode } from "./types.ts";

const scalarWrappers = new Set(["command_name_expr", "path_command_name", "array_literal_expression", "unary_expression", "string_literal", "integer_literal"]);
const escapes: Readonly<Record<string, string>> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
const bareChar = /^[\p{L}\p{N}_./:\\%+=@*?-]$/u;

function decodeWord(text: string, quoted: boolean): string | undefined {
	if (quoted ? !(text.startsWith('"') && text.endsWith('"')) : text.startsWith("@")) return;
	if (/[\u2018-\u201e\0]/u.test(text)) return;
	const body = quoted ? text.slice(1, -1) : text;
	let value = "";
	for (let i = 0; i < body.length; i++) {
		const c = body.charAt(i);
		if (c === "`") {
			const next = body.charAt(++i);
			// 版本相关转义（如 `e、`u{...}）及续行不猜测。
			if (!next || /[\r\neu0]/u.test(next)) return;
			value += escapes[next] ?? next;
		} else if (quoted && c === '"' && body[i + 1] === '"') {
			value += '"'; i++;
		} else if (c === "$" || c === '"' || !quoted && !bareChar.test(c)) return;
		else value += c;
	}
	return value;
}

function singleQuoted(text: string): string | undefined {
	return /^'(?:[^'\u2018-\u201b\0]|'')*'$/u.test(text) ? text.slice(1, -1).replaceAll("''", "'") : undefined;
}

/** 从已确定的词首读取一个完整静态词。后续紧邻的拼接或表达式不算词边界。 */
export function scanStaticPowerShellWord(source: string, start: number): { start: number; end: number; value: string } | undefined {
	const token = /'(?:''|[^'])*'|"(?:`[^\r\n]|""|[^"`])*"|(?:`[^\r\n]|[\p{L}\p{N}_./:\\%+=-])+/uy;
	token.lastIndex = start;
	const text = token.exec(source)?.[0];
	if (!text) return;
	const end = token.lastIndex;
	if (end < source.length && !/[\s;|)}]/u.test(source.charAt(end))) return;
	const value = text.startsWith("'") ? singleQuoted(text) : decodeWord(text, text.startsWith('"'));
	return value === undefined ? undefined : { start, end, value };
}

/** 只解包覆盖整个词的标量节点，不把数组、表达式或内层字符串当成 argv。 */
export function staticPowerShellWord(node: SyntaxNode): string | undefined {
	while (scalarWrappers.has(node.type)) {
		const child = node.firstNamedChild;
		if (node.namedChildCount !== 1 || !child || child.startIndex !== node.startIndex || child.endIndex !== node.endIndex) return;
		node = child;
	}
	const text = node.text;
	switch (node.type) {
		case "verbatim_string_characters": return singleQuoted(text);
		case "expandable_string_literal": return node.namedChildCount ? undefined : decodeWord(text, true);
		case "generic_token": case "command_parameter": case "command_name": case "path_command_name_token": return decodeWord(text, false);
		case "decimal_integer_literal": return /^(?:0|[1-9]\d*)$/u.test(text) ? text : undefined;
	}
}

interface WordSpan {
	expression?: SyntaxNode;
	start: number;
	end: number;
	source: string;
	value: string | undefined;
	bounded: boolean;
}

export type PowerShellWord = WordSpan & (
	| { kind: "word" }
	| { kind: "list"; elements: PowerShellWord[] }
	| { kind: "parameter"; name: PowerShellWord; argument: PowerShellWord }
);

function word(node: SyntaxNode, check: () => void): PowerShellWord {
	const value = staticPowerShellWord(node), source = node.text;
	const array = node.type === "array_literal_expression";
	const span: WordSpan = { expression: node, start: node.startIndex, end: node.endIndex, source, value,
		bounded: value !== undefined || array && !/[\u2018-\u201e]/u.test(source) };
	if (array && node.namedChildCount > 1) {
		return { ...span, kind: "list", elements: node.namedChildren.map(child => { check(); return word(child, check); }) };
	}
	return { ...span, kind: "word" };
}

export interface PowerShellRedirectTarget { source: string; value: string | undefined; expression?: SyntaxNode; range?: { start: number; end: number } }
export type PowerShellRedirect = PowerShellRedirectTarget | { source: string; attachedOperand: string };

export function powerShellRedirect(node: SyntaxNode): PowerShellRedirectTarget | undefined {
	const [op, dest] = node.namedChildren;
	if (op?.type === "merging_redirection_operator") return;
	const parts = dest?.namedChildren.filter((child) => child.type !== "command_argument_sep");
	const target = parts?.length === 1 ? parts[0] : undefined;
	if (target?.text.toLowerCase() === "$null") return;
	return { source: node.text, value: target && staticPowerShellWord(target),
		...(target && { expression: target, range: { start: target.startIndex, end: target.endIndex } }) };
}

/** 裸词内部的反引号引用紧随的字符。用等长转义让 grammar 保留参数边界和源码偏移。 */
export function quotedWordNewlines(root: SyntaxNode, script: string, check: () => void): string {
	if (!/`\r?\n/u.test(script)) return script;
	let code = "", pos = 0;
	for (const node of root.descendantsOfType("generic_token")) {
		check();
		const end = node.endIndex;
		if (node.parent?.type !== "command_elements" || !/^[\p{L}\p{N}_./-]+`$/u.test(node.text)) continue;
		const cr = script.startsWith("\r\n", end);
		if ((!cr && script[end] !== "\n") || !/[\p{L}\p{N}_]/u.test(script.charAt(end + (cr ? 2 : 1)))) continue;
		// CRLF 中只引用 CR，LF 仍然结束语句。
		code += script.slice(pos, end) + (cr ? "r" : "n"); pos = end + 1;
	}
	return pos ? code + script.slice(pos) : script;
}

function joinedWord(script: string, start: number, end: number, bare = false): PowerShellWord {
	const source = script.slice(start, end), value = bare ? decodeWord(source, false) : undefined;
	return { kind: "word", start, end, source, value, bounded: value !== undefined };
}

type Separator = { text: "," | ":"; left: PowerShellWord };

function bindWord(script: string, { text, left }: Separator, right: PowerShellWord): PowerShellWord {
	const span = joinedWord(script, left.start, right.end);
	if (text === ":") return left.expression?.type === "command_parameter" ? { ...span, kind: "parameter", name: left, argument: right } : span;
	const operand = left.kind === "parameter" ? left.argument : left;
	const elements = operand.kind === "list" ? operand.elements : [operand];
	elements.push(right);
	const list: PowerShellWord = { ...joinedWord(script, operand.start, right.end), kind: "list", elements };
	return left.kind === "parameter" ? { ...span, kind: "parameter", name: left.name, argument: list } : list;
}

export function powerShellCommand(command: SyntaxNode, script: string, check: () => void) {
	const name = command.childForFieldName("command_name");
	if (!name) throw new Error("Missing PowerShell command_name field.");
	const operator = command.namedChildren.find((child) => child.type === "command_invokation_operator")?.text;
	const args: PowerShellWord[] = [], redirects: PowerShellRedirect[] = [];
	let pending: Separator | undefined, last: PowerShellWord | undefined;
	let separated = true, redirectEnd = 0, hasRedirection = false;
	function finishWord() {
		if (last) args.push(last);
		last = undefined; pending = undefined;
	}
	for (const node of command.childForFieldName("command_elements")?.children ?? []) {
		check();
		if (node.startIndex < redirectEnd) continue;
		if (node.type === "command_argument_sep" && node.text !== ":" || node.type === "comment") { separated = true; continue; }
		if (node.type === "redirection") {
			hasRedirection = true;
			const target = powerShellRedirect(node);
			if (target) redirects.push(target);
			finishWord(); separated = true; continue;
		}
		// grammar 不一定为参数间的空白产生节点。反引号只转义第一个空白，其余仍分词。
		const gap = last ? script.slice(last.end, node.startIndex) : "";
		const horizontal = /^[ \t]+$/u.test(gap);
		if (horizontal) separated = true;
		let escapedSpace = last && separated && /(?:^|[^`])(?:``)*`$/u.test(last.source);
		if (last && escapedSpace && horizontal && gap.length > 1) {
			last = joinedWord(script, last.start, last.end + 1, true);
			escapedSpace = false;
		}
		// grammar 把紧贴文件名的重定向（如 2>>log）词化为单个 generic_token。
		const attached = node.type === "generic_token" && separated && !pending && !escapedSpace && /^(?:[1-6*])?>>?(.+)$/su.exec(node.text);
		if (attached && attached[1]) {
			hasRedirection = true;
			if (attached[1].toLowerCase() !== "$null") {
				const range = scanStaticPowerShellWord(script, node.endIndex - attached[1].length);
				if (range && range.end >= node.endIndex && range.end <= command.endIndex) {
					// 紧贴的带引号目标可能被 grammar 按空格拆开，其余片段不是新参数。
					redirectEnd = range.end;
					redirects.push({ source: script.slice(node.startIndex, range.end), value: range.value, range });
				} else redirects.push({ source: node.text, attachedOperand: attached[1] });
			}
			finishWord(); separated = true; continue;
		}
		// 逗号列表、冒号绑定或紧邻的片段不是多个独立的静态参数。
		if (last && (node.type === "," || node.type === "command_argument_sep")) {
			pending = { text: node.type === "," ? "," : ":", left: last };
			last = joinedWord(script, last.start, node.endIndex);
		} else if (pending) {
			last = bindWord(script, pending, word(node, check));
			pending = undefined;
		} else if (last && (!separated || escapedSpace)) {
			const bare = !!escapedSpace && horizontal && (node.type === "generic_token" || node.type === "command_parameter");
			last = joinedWord(script, last.start, node.endIndex, bare);
		} else {
			finishWord();
			last = word(node, check);
		}
		separated = false;
	}
	finishWord();
	return { name: word(name, check), operator, args, redirects, hasRedirection };
}

function stableScriptArgument(word: PowerShellWord): boolean {
	const script = word.value;
	if (!script || !script.trim() || script.trim() === "-") return false;
	// 未引用的词可能展开。引用的字符串仍需排除 Windows 原生传参模式会重新转义的内容。
	if (!/^["']/u.test(word.source)) return /^[a-z][a-z0-9 ./_-]*$/iu.test(script);
	return !/["\0]/u.test(script) && !script.endsWith("\\");
}

/** 区分数据参数和交给 PowerShell 再次解释的代码。只递归解析有唯一静态源码的形式。 */
export function powerShellCodeInput(program: string, words: readonly PowerShellWord[], args: readonly (string | undefined)[] = words.map(word => word.value)) {
	const name = program.split(/[/\\]/u).at(-1)?.toLowerCase();
	if (name === "invoke-expression" || name === "iex") {
		const offset = args[0]?.toLowerCase() === "-command" ? 1 : 0;
		return { mode: "expression" as const, script: args.length === offset + 1 ? args[offset] : undefined };
	}
	if (!name || !/^(?:powershell|pwsh)(?:\.exe)?$/u.test(name)) return;
	let pos = 0;
	while (/^-(?:noprofile|nologo|noninteractive)$/iu.test(args[pos] ?? "")) pos++;
	const mode = args[pos]?.toLowerCase();
	if (mode === "-file" && args[pos + 1] !== undefined && args[pos + 1] !== "-") return;
	const operand = (mode === "-c" || mode === "-command") && args.length === pos + 2 ? words[pos + 1] : undefined;
	const staticScript = operand !== undefined && stableScriptArgument(operand) && name === program.toLowerCase()
		&& args.slice(0, pos).some(a => a?.toLowerCase() === "-noprofile");
	return { mode: "child" as const, script: operand && args[pos + 1], staticScript };
}
