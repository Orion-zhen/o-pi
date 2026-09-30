import { memo } from "react";
import { outputPreview, type ToolOutput } from "../messages.ts";
import { Disclosure } from "./components/disclosure";
import { pretty } from "./content.tsx";
import { useToolOutput } from "./payload.tsx";
import { ParameterValue } from "./tool-parameters.tsx";
import { ToolResult } from "./tool-results.tsx";
import type { ToolActivity } from "./transcript-items.ts";

/** 普通调用和嵌套调用共用结果渲染及大载荷按需读取。 */
export function ToolBody({ tool }: { tool: ToolActivity }) {
	const id = tool.output?.kind === "reference" ? tool.output.id : undefined;
	const loaded = useToolOutput(id);
	if (id && !loaded.value) return <p className="tool-note" role={loaded.error ? "alert" : "status"}>{loaded.error || "正在读取工具结果…"}</p>;
	const resolved = { ...tool, output: loaded.value ?? outputPreview(tool.output) };
	return <div className="activity-body">
		{tool.args !== undefined && <Disclosure className="tool-parameters" summary="参数" lazy><ParameterValue value={tool.args} /></Disclosure>}
		<ToolResult tool={resolved} />
		<Disclosure className="tool-raw" summary="原始数据" lazy><RawToolData args={tool.args} output={resolved.output} /></Disclosure>
	</div>;
}

const RawToolData = memo(function RawToolData({ args, output }: { args: unknown; output: ToolOutput | undefined }) {
	return <pre>{pretty({ arguments: args, result: output })}</pre>;
});
