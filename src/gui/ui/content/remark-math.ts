import type { Extension as FromMarkdownExtension } from "mdast-util-from-markdown";
import type { Code, Construct, Extension, State, Token, Tokenizer } from "micromark-util-types";
import type { Processor } from "unified";
import type {} from "remark-parse";

const environments = [
	"equation", "equation*", "align", "align*", "alignat", "alignat*", "aligned", "alignedat",
	"gather", "gather*", "gathered", "multline", "multline*", "split", "displaymath", "math",
	"matrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix", "smallmatrix", "cases",
];
const openings = ["\\(", "\\[", ...environments.map((name) => `\\begin{${name}}`)];

declare module "micromark-util-types" {
	interface Token {
		guiMathComplete?: true;
		guiMathFlow?: true;
	}
	interface TokenTypeMap {
		guiMath: "guiMath";
		guiMathData: "guiMathData";
	}
}

function character(code: number): string {
	return code === -5 || code === -4 || code === -3 ? "\n" : code < 0 ? "\t" : String.fromCharCode(code);
}

function delimiters(opening: string): { close: string; display: boolean } {
	if (opening === "$" || opening === "$$") return { close: opening, display: opening === "$$" };
	if (opening === "\\(") return { close: "\\)", display: false };
	if (opening === "\\[") return { close: "\\]", display: true };
	return { close: opening.replace("\\begin", "\\end"), display: true };
}

const nonLazyContinuation: Construct = {
	partial: true,
	tokenize(effects, ok, nok) {
		return (code) => {
			effects.enter("lineEnding");
			effects.consume(code);
			effects.exit("lineEnding");
			return (next) => this.parser.lazy[this.now().line] ? nok(next) : ok(next);
		};
	},
};

function mathTokenizer(flow: boolean): Tokenizer {
	return function (effects, ok, nok) {
		let opening = "";
		let close = "";
		let value = "";
		let token: Token;
		let match = 0;
		let openMatch = 0;
		let nested = 0;
		let escaped = false;
		let singleDollar = false;
		let dataOpen = false;
		const previous = this.previous;
		const interrupt = this.interrupt;

		return start;

		function start(code: Code): State | undefined {
			if (code === 36 && (previous === 36 || (previous !== null && previous >= 48 && previous <= 57))) return nok(code);
			token = effects.enter("guiMath");
			if (flow) token.guiMathFlow = true;
			effects.enter("guiMathData");
			dataOpen = true;
			return open(code);
		}

		function open(code: Code): State | undefined {
			if (code === null) return nok(code);
			opening += character(code);
			effects.consume(code);
			if (opening === "$") return dollar;
			if (openings.includes(opening)) {
				const delimiter = delimiters(opening);
				if (flow && !delimiter.display) return nok;
				close = delimiter.close;
				return opened;
			}
			return openings.some((candidate) => candidate.startsWith(opening)) ? open : nok;
		}

		function dollar(code: Code): State | undefined {
			if (code === 36) {
				opening = close = "$$";
				effects.consume(code);
				return opened;
			}
			if (flow) return nok(code);
			singleDollar = true;
			close = "$";
			if (code === null || /\s/.test(character(code))) return nok(code);
			return body(code);
		}

		function opened(code: Code): State | undefined {
			if (flow && interrupt) return ok(code);
			return body(code);
		}

		function incomplete(code: Code): State | undefined {
			if (singleDollar && /^\d/.test(value)) return nok(code);
			if (dataOpen) effects.exit("guiMathData");
			effects.exit("guiMath");
			return ok(code);
		}

		function body(code: Code): State | undefined {
			if (code === null) return incomplete(code);
			const char = character(code);
			if (char === "\n") {
				if (singleDollar) return incomplete(code);
				return flow ? effects.check(nonLazyContinuation, newline, incomplete)(code) : newline(code);
			}
			value += char;
			if (!dataOpen) effects.enter("guiMathData");
			dataOpen = true;
			effects.consume(code);
			if (match > 0 && char === close[match]) match++;
			else match = !escaped && char === close[0] ? 1 : 0;
			if (opening.startsWith("\\begin")) {
				if (openMatch > 0 && char === opening[openMatch]) openMatch++;
				else openMatch = !escaped && char === opening[0] ? 1 : 0;
				if (openMatch === opening.length) { nested++; openMatch = 0; }
			}
			escaped = char === "\\" && !escaped;
			if (match !== close.length) return body;
			if (nested === 0) return finish;
			nested--;
			match = 0;
			return body;
		}

		function newline(code: Code): State | undefined {
			value += "\n";
			if (dataOpen) effects.exit("guiMathData");
			effects.enter("lineEnding");
			effects.consume(code);
			effects.exit("lineEnding");
			dataOpen = false;
			match = openMatch = 0;
			escaped = false;
			return body;
		}

		function finish(code: Code): State | undefined {
			const tex = value.slice(0, -close.length);
			if (opening.startsWith("$") && (!tex.trim() || code === 36)) return nok(code);
			if (singleDollar && (/\s$/.test(tex) || (code !== null && code >= 48 && code <= 57))) return nok(code);
			if (tex.trim()) token.guiMathComplete = true;
			if (dataOpen) effects.exit("guiMathData");
			effects.exit("guiMath");
			if (!flow) return ok(code);
			if (code === 32 || code === -1 || code === -2) {
				effects.enter("whitespace");
				return after(code);
			}
			return code === null || character(code) === "\n" ? ok(code) : nok(code);
		}

		function after(code: Code): State | undefined {
			if (code === 32 || code === -1 || code === -2) {
				effects.consume(code);
				return after;
			}
			effects.exit("whitespace");
			return code === null || character(code) === "\n" ? ok(code) : nok(code);
		}
	};
}

const text = { tokenize: mathTokenizer(false) };
const flow = { tokenize: mathTokenizer(true), concrete: true };
const syntax: Extension = { text: { 36: text, 92: text }, flow: { 36: flow, 92: flow } };
const fromMarkdown: FromMarkdownExtension = {
	enter: {
		guiMath(token) {
			const source = this.sliceSerialize(token);
			const opening = source.startsWith("$$") ? "$$" : source.startsWith("$") ? "$"
				: source.startsWith("\\begin{") ? source.slice(0, source.indexOf("}") + 1) : source.slice(0, 2);
			const { close, display } = delimiters(opening);
			const complete = token.guiMathComplete === true;
			const tex = opening.startsWith("\\begin") ? source : source.slice(opening.length, -close.length);
			if (token.guiMathFlow) this.enter({ type: "paragraph", children: [] }, token);
			this.enter({
				type: "inlineCode",
				value: complete ? tex : source,
				data: {
					hName: "span",
					hProperties: complete ? { dataMathSource: source, dataMathTex: tex, dataMathDisplay: display }
						: { className: display ? ["math-formula", "math-display"] : ["math-formula"] },
					hChildren: [{ type: "text", value: complete ? tex : source }],
				},
			}, token);
		},
	},
	exit: {
		guiMath(token) {
			this.exit(token);
			if (token.guiMathFlow) this.exit(token);
		},
	},
};

export function remarkMath(this: Processor): void {
	const data = this.data();
	(data.micromarkExtensions ??= []).push(syntax);
	(data.fromMarkdownExtensions ??= []).push(fromMarkdown);
}
