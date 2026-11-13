import { arr, bool, compile, lit, map, num, obj, oneOf, opt, str, union, unknown, type Static } from "@earendil-works/pi-schema";

// 只校验展示会读取的字段，扩展的其他数据原样保留。
const span = obj({ start: num(), end: num() }, { open: true });
const pathKind = oneOf(["directory", "file", "symlink", "other"]);
const searchNotes = {
	truncated_by: opt(arr(unknown())),
	scope_errors: opt(arr(obj({ path: str(), error: opt(obj({ message: str() }, { open: true })) }, { open: true }))),
};
const read = obj({
	path: str(), total_lines: num(),
	segments: arr(obj({ content: str(), start_line: num(), end_line: num() }, { open: true })),
	truncated: opt(bool()), continuation: opt(obj({ lines: str() }, { open: true })),
}, { open: true });
const diff = obj({
	diff: str(), lsp: opt(obj({ diagnostics: opt(obj({ file_errors: num(), file_warnings: num() }, { open: true })) }, { open: true })),
}, { open: true });
const grep = obj({
	regions: arr(obj({
		path: str(), declaration: opt(str()),
		display_lines: opt(arr(obj({ type: str(), line: opt(num()), text: str() }, { open: true }))),
	}, { open: true })), ...searchNotes,
}, { open: true });
const find = obj({ matches: arr(obj({ path: str(), kind: pathKind }, { open: true })), ...searchNotes }, { open: true });
const ls = obj({
	entries: arr(obj({ name: str(), type: pathKind }, { open: true })),
	truncated: bool(), continuation_hint: opt(str()),
}, { open: true });
const webSearch = obj({
	status: lit("success"), query: str(),
	results: arr(obj({ rank: num(), url: str(), title: str(), snippet: opt(str()), provider: opt(str()) }, { open: true })),
}, { open: true });
const webFetch = obj({
	status: lit("success"), scope: lit("static_response"), final_url: str(), title: opt(str()), preview: str(),
	format: str(), completeness: oneOf(["complete", "partial"]), http_status: num(),
	range: union([
		obj({ kind: lit("read"), start: num(), end: num(), total: num(), next_offset: opt(num()) }, { open: true }),
		obj({ kind: lit("find"), matches: num(), passages: arr(span), next_offset: opt(num()) }, { open: true }),
	]),
}, { open: true });
const run = {
	model: opt(str()), attempts: num(), durationMs: num(), output: str(), stderr: opt(str()), error: opt(str()), stopReason: opt(str()),
	usage: obj({ turns: num() }, { open: true }),
	events: arr(union([
		obj({ type: lit("text"), text: str() }, { open: true }),
		obj({ type: lit("tool"), name: str(), args: map(unknown()), status: opt(oneOf(["pending", "running", "completed", "error"])) }, { open: true }),
	])),
};
const subagent = obj({
	mode: oneOf(["parallel", "chain"]),
	tasks: arr(obj({ agent: str(), task: str() }, { open: true }), { minItems: 1 }),
	results: arr(union([
		obj({ ...run, status: lit("running") }, { open: true }),
		obj({ ...run, status: lit("completed"), exitCode: num(), outputFile: str() }, { open: true }),
	])), warnings: arr(str()),
}, { open: true });

export type GuiSubagentDetails = Static<typeof subagent>;
export type GuiSubagentRun = GuiSubagentDetails["results"][number];
export type GuiWebSearch = Static<typeof webSearch>;
export type GuiWebFetch = Static<typeof webFetch>;
export type ToolDetails =
	| { view: "raw" }
	| { view: "progress" }
	| { view: "read"; details: Static<typeof read> }
	| { view: "diff"; details: Static<typeof diff> }
	| { view: "grep"; details: Static<typeof grep> }
	| { view: "find"; details: Static<typeof find> }
	| { view: "ls"; details: Static<typeof ls> }
	| { view: "websearch"; details: GuiWebSearch }
	| { view: "webfetch"; details: GuiWebFetch }
	| { view: "subagent"; details: GuiSubagentDetails };

export const toolDetails = {
	read: compile(read).check, diff: compile(diff).check, grep: compile(grep).check,
	find: compile(find).check, ls: compile(ls).check,
	websearch: compile(webSearch).check, webfetch: compile(webFetch).check, subagent: compile(subagent).check,
};
