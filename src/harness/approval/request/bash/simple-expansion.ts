import type { SyntaxNode } from "../../../syntax-tree/types.ts";
import { readVariable, UNSET, type BashAnalysisContext } from "./branches.ts";
import { isOrdinaryVariable } from "./startup.ts";
import { walkNamedNodes } from "./syntax.ts";

const parameter = /^\$(?:([A-Za-z_][A-Za-z_0-9]*)|\{([A-Za-z_][A-Za-z_0-9]*)\})$/u;
const plainNodes = new Set(["redirected_statement", "command", "command_name", "file_redirect", "file_descriptor", "word", "string", "raw_string", "string_content", "variable_name", "comment"]);

// 只在启动选项和变量仍可确定的顶层前缀中收窄。未建模的语句之后沿用常规分析。
export function simpleExpansionSites(statements: readonly SyntaxNode[], check: () => void): Set<number> {
	const sites = new Set<number>();
	const assigned = new Set<string>();
	for (const statement of statements) {
		check();
		if (statement.type === "comment") continue;
		if (statement.type === "variable_assignment" && statement.nextSibling?.type !== "&") {
			const name = statement.childForFieldName("name")?.text;
			const rhs = statement.childForFieldName("value");
			if (name && isOrdinaryVariable(name) && statement.text.startsWith(`${name}=`) && (!rhs || literal(rhs.text) !== undefined)) { assigned.add(name); continue; }
		}
		if (statement.type === "case_statement") {
			if (process.platform !== "win32") sites.add(statement.id);
			break;
		}
		if (statement.type !== "command" && statement.type !== "redirected_statement") break;
		const fields: number[] = [];
		for (const node of walkNamedNodes(statement, check)) {
			const match = parameter.exec(node.text);
			if (["simple_expansion", "expansion", "command_name"].includes(node.type) && match) {
				if (process.platform !== "win32" || assigned.has(match[1] ?? match[2] ?? "")) fields.push(node.id);
			}
			else if (!plainNodes.has(node.type)) return sites;
		}
		for (const id of fields) sites.add(id);
		const command = statement.type === "command" ? statement : statement.childForFieldName("body");
		if (!/^(?:echo|:|true|false)$/u.test(command?.childForFieldName("name")?.text ?? "")) break;
	}
	return sites;
}

function scalar(source: string, context: BashAnalysisContext): string | undefined {
	const match = parameter.exec(source);
	const name = match?.[1] ?? match?.[2];
	if (!name || !isOrdinaryVariable(name)) return undefined;
	const value = readVariable(name, context);
	return value !== undefined && value !== UNSET && !("choices" in value) && !value.value.includes("\0") ? value.value : undefined;
}

export function singleField(node: SyntaxNode, context: BashAnalysisContext): string | undefined {
	if (!context.simpleSites?.has(node.id)) return undefined;
	const value = scalar(node.text, context);
	// 这些路径字符不含默认 IFS，也不引入文件名模式。
	return value !== undefined && /^[\p{L}\p{M}\p{N}_./:@%+=,-]+$/u.test(value) ? value : undefined;
}

function literal(source: string): string | undefined {
	if (/^[A-Za-z0-9_./:+-]+$/u.test(source)) return source;
	if (/^(?:'[ A-Za-z0-9_./:+-]*'|"[ A-Za-z0-9_./:+-]*")$/u.test(source)) return source.slice(1, -1);
	return undefined;
}

export function selectedCaseBody(node: SyntaxNode, subject: SyntaxNode, context: BashAnalysisContext, check: () => void): SyntaxNode[] | undefined {
	if (!context.simpleSites?.has(node.id)) return undefined;
	const arms = [];
	for (const item of node.namedChildren.filter((child) => child.type === "case_item")) {
		check();
		if (item.lastChild?.type !== ";;") return undefined;
		const patterns = item.childrenForFieldName("value").map((p) => p.text === "*" ? "*" : literal(p.text));
		if (patterns.some((p) => p === undefined)) return undefined;
		arms.push({ item, patterns });
	}
	const text = subject.text;
	const value = literal(text) ?? scalar(subject.type === "string" ? text.slice(1, -1) : text, context);
	if (value === undefined) return undefined;
	const selected = arms.find(({ patterns }) => patterns.includes(value) || patterns.includes("*"));
	if (!selected) return [];
	const children = selected.item.children;
	return children.slice(children.findIndex((child) => child.type === ")") + 1).filter((child) => child.isNamed);
}
