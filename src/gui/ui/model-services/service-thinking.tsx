import { ArrowRight, RotateCcw } from "lucide-react";
import type { ThinkingSettings } from "../../../harness/openai-compatible-provider/thinking-settings.ts";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { IconButton } from "../components/icon-button.tsx";
import { Disclosure } from "../components/disclosure.tsx";
import type { ChangeConfig } from "./service-draft.ts";

export function ServiceThinking({ mapping, disabled, change }: {
	mapping: ThinkingSettings;
	disabled: boolean;
	change: ChangeConfig;
}) {
	let hint = "未指定映射时由协议决定请求值。";
	if (!mapping.reasoning) hint = "当前未开启思考能力，可预先编辑映射。";
	else if (mapping.suffix) hint = "模型后缀默认值来自候选 ID，手动设置优先。保存并重载后生效。";

	return <Disclosure className="service-disclosure service-thinking" summary="思考等级映射" lazy>
		<div className="service-thinking-toolbar">
			<span className="service-tag">{hint}</span>
			{mapping.modified && <Button type="button" variant="ghost" size="sm" disabled={disabled}
				onClick={() => change(["thinkingLevelMap"], undefined)}>
				<RotateCcw />恢复默认映射
			</Button>}
		</div>
		<table className="service-thinking-table" aria-label="思考等级映射">
			<colgroup>
				<col className="service-thinking-check" /><col className="service-thinking-level" />
				<col className="service-thinking-arrow" /><col /><col className="service-thinking-state" />
			</colgroup>
			<thead><tr>
				<th scope="col">可选</th><th scope="col">UI 展示</th><th aria-label="映射到" />
				<th scope="col">{mapping.suffix ? "服务商模型 ID" : "服务商接收值"}</th><th aria-label="映射状态" />
			</tr></thead>
			<tbody>{mapping.rows.map((row) => <tr key={row.level} data-available={row.available}>
				<td><Checkbox aria-label={`在 opi 中启用 ${row.level}`} checked={row.enabled} disabled={disabled}
					onCheckedChange={(checked) => change(["thinkingLevelMap", row.level], checked === true ? row.enableValue : null)} /></td>
				<th scope="row"><code>{row.level}</code></th>
				<td><ArrowRight aria-hidden="true" /></td>
				<td>
					{!row.enabled ? <span className="service-tag">不支持</span>
						: mapping.suffix ? <code className="service-thinking-target">{row.targetModel}</code>
						: <Input aria-label={`opi ${row.level} 对应的服务商值`} value={row.value}
							placeholder={row.defaultValue ?? (row.omitsEffort ? "不发送等级值" : "协议默认")}
							disabled={disabled} autoComplete="off" spellCheck={false}
							onChange={(event) => change(["thinkingLevelMap", row.level], event.target.value)} />}
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
