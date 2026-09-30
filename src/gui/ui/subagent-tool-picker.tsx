import type { GuiSnapshot } from "../contract.ts";
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";

export function SubagentToolPicker({ label, value, tools, disabled, change }: {
	label: string; value: readonly unknown[]; tools: GuiSnapshot["tools"] | null; disabled: boolean; change: (value: string[]) => void;
}) {
	const selected = value.filter((name): name is string => typeof name === "string");
	const availableTools = new Map(tools?.map((tool) => [tool.name, tool]));
	const names = new Set([...availableTools.keys(), ...selected]);
	return <div className="settings-tool-picker">
		<ToggleGroup type="multiple" variant="outline" size="sm" className="settings-tool-buttons" aria-label={label}
			value={selected} onValueChange={change} disabled={disabled || tools === null}>
			{[...names].map((name) => {
				const enabled = selected.includes(name);
				const unavailable = name === "subagent" ? "子代理不能调用 subagent。"
					: tools !== null && !availableTools.get(name)?.available ? "当前会话不可用。" : "";
				const last = enabled && selected.length === 1;
				const locked = last || (!enabled && unavailable !== "");
				return <Tooltip key={name}><TooltipTrigger asChild>
					<span className="settings-tool-option" tabIndex={locked ? 0 : undefined}>
						<ToggleGroupItem value={name} aria-label={name} disabled={locked} data-unavailable={unavailable !== ""}>
							{name}
						</ToggleGroupItem>
					</span>
				</TooltipTrigger><TooltipContent>
					{unavailable}{last ? "至少保留一个工具。" : enabled ? "点击移除。" : unavailable ? "不能启用。" : "点击启用。"}
				</TooltipContent></Tooltip>;
			})}
		</ToggleGroup>
		{tools === null && <p className="settings-description">选择工作区后可选择工具。</p>}
	</div>;
}
