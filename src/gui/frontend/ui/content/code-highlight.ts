import SyntaxHighlighter from "react-syntax-highlighter/dist/esm/prism-light";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import c from "react-syntax-highlighter/dist/esm/languages/prism/c";
import cpp from "react-syntax-highlighter/dist/esm/languages/prism/cpp";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import diff from "react-syntax-highlighter/dist/esm/languages/prism/diff";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";

for (const [name, grammar] of Object.entries({ bash, c, cpp, css, diff, go, javascript, json, jsx, markdown, markup, python, rust, tsx, typescript, yaml }))
	SyntaxHighlighter.registerLanguage(name, grammar);

const extensions: Record<string, string> = {
	js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", mts: "typescript", cts: "typescript",
	jsx: "jsx", tsx: "tsx", json: "json", jsonc: "json", css: "css", html: "markup", xml: "markup", svg: "markup",
	py: "python", rs: "rust", go: "go", c: "c", h: "c", cpp: "cpp", hpp: "cpp", sh: "bash", bash: "bash",
	zsh: "bash", yml: "yaml", yaml: "yaml", md: "markdown", diff: "diff", patch: "diff",
};
export function fileLanguage(path: string): string {
	return extensions[path.split(".").at(-1)?.toLowerCase() ?? ""] ?? "text";
}
export { SyntaxHighlighter };
