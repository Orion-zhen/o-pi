import { ArrowRight, RotateCcw } from "lucide-react";
import type { ThinkingSettings } from "../../../../../harness/openai-compatible-provider/thinking-settings.ts";
import { Checkbox } from "@/ui/checkbox.tsx";
import { Input } from "@/ui/input.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Disclosure } from "@/ui/disclosure.tsx";
import type { ChangeConfig } from "./service-draft.ts";

export function ServiceThinking({ mapping, disabled, change }: {
	mapping: ThinkingSettings;
	disabled: boolean;
	change: ChangeConfig;
}) {
	const targetLabel = "请求行为 / 映射值";
	const unavailable = disabled || !mapping.reasoning;

	return <Disclosure className="service-disclosure service-thinking" summary="思考等级映射" lazy>
		<table className="service-thinking-table" aria-label="思考等级映射">
			<thead><tr>
				<th scope="col" /><th scope="col">等级</th><th aria-label="映射到" />
				<th scope="colgroup" colSpan={2} className="service-thinking-heading">
					<span>{targetLabel}</span>
					{mapping.modified && <IconButton size="sm" className="service-thinking-reset" label="恢复默认映射" disabled={disabled}
						onClick={() => change(["thinkingLevelMap"], undefined)}>
						<RotateCcw /><span>恢复默认映射</span>
					</IconButton>}
				</th>
			</tr></thead>
			<tbody>{mapping.rows.map((row) => <tr key={row.level} data-available={row.available}>
				<td><Checkbox aria-label={`在 opi 中启用 ${row.level}`} checked={row.enabled} disabled={unavailable}
					onCheckedChange={(checked) => change(["thinkingLevelMap", row.level], checked === true ? row.enableValue : null)} /></td>
				<th scope="row"><code>{row.level}</code></th>
				<td><ArrowRight aria-hidden="true" /></td>
				<td data-label={targetLabel}>
					{!row.enabled ? <span className="service-tag">未在 opi 中启用</span>
						: row.mapsEffort ? <Input aria-label={`opi ${row.level} 对应的服务商值`} value={row.value}
							placeholder={row.defaultValue ?? "不发送等级值"}
							disabled={unavailable} autoComplete="off" spellCheck={false}
							onChange={(event) => change(["thinkingLevelMap", row.level], event.target.value)} />
						: <span>{mapping.reasoning ? row.effect : "未开启思考能力"}</span>}
				</td>
				<td>
					{row.modified ? <IconButton size="icon-sm" label={`恢复 ${row.level} 默认映射`} disabled={disabled}
						onClick={() => change(["thinkingLevelMap", row.level], undefined)}><RotateCcw /></IconButton>
						: <span className="service-tag">默认</span>}
				</td>
			</tr>)}</tbody>
		</table>
	</Disclosure>;
}
