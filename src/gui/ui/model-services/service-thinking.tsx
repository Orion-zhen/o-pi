import { ArrowRight, RotateCcw } from "lucide-react";
import type { ConfigObject } from "../../../harness/openai-compatible-provider/validation.ts";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { IconButton } from "../components/icon-button.tsx";
import { Disclosure } from "../components/disclosure.tsx";
import type { ChangeConfig } from "./service-draft.ts";
import { thinkingMapping } from "./thinking-mapping.ts";

export function ServiceThinking({ provider, defaults, configured, modelId, disabled, change }: {
	provider: ConfigObject; defaults: ConfigObject; configured: ConfigObject; modelId: string; disabled: boolean; change: ChangeConfig;
}) {
	const mapping = thinkingMapping(provider, defaults, configured, modelId);
	return <Disclosure className="service-disclosure service-thinking" summary="思考等级映射" lazy>
		<div className="service-thinking-toolbar">
			<span className="service-tag">{!mapping.reasoning ? "开启思考能力后可配置等级。" : mapping.suffix ? "模型后缀模式按 opi 等级生成模型 ID，不使用映射值。" : "未指定映射时由协议决定请求值。"}</span>
			<Button type="button" variant="ghost" size="sm" disabled={disabled || !mapping.modified} onClick={() => change(["thinkingLevelMap"], undefined)}><RotateCcw />恢复默认映射</Button>
		</div>
		<table className="service-thinking-table" aria-label="思考等级映射">
			<colgroup><col className="service-thinking-check" /><col className="service-thinking-level" /><col className="service-thinking-arrow" /><col /><col className="service-thinking-state" /></colgroup>
			<thead><tr><th scope="col">可选</th><th scope="col">UI 展示</th><th aria-label="映射到" /><th scope="col">{mapping.suffix ? "服务商模型 ID" : "服务商接收值"}</th><th aria-label="映射状态" /></tr></thead>
			<tbody>{mapping.rows.map((row) => <tr key={row.level} data-available={row.available}>
				<td><Checkbox aria-label={`在 opi 中启用 ${row.level}`} checked={row.available} disabled={disabled || !mapping.reasoning}
					onCheckedChange={(checked) => change(["thinkingLevelMap", row.level], checked === true ? row.enableValue : null)} /></td>
				<th scope="row"><code>{row.level}</code></th>
				<td><ArrowRight aria-hidden="true" /></td>
				<td>{!row.available ? <span className="service-tag">不支持</span> : mapping.suffix ? <code className="service-thinking-target">{row.targetModel}</code>
					: <Input aria-label={`opi ${row.level} 对应的服务商值`} value={row.value} placeholder={row.placeholder}
						disabled={disabled || !mapping.reasoning} autoComplete="off" spellCheck={false}
						onChange={(event) => change(["thinkingLevelMap", row.level], event.target.value)} />}</td>
				<td>{row.modified ? <IconButton size="icon-sm" label={`恢复 ${row.level} 默认映射`} disabled={disabled}
					onClick={() => change(["thinkingLevelMap", row.level], undefined)}><RotateCcw /></IconButton> : <span className="service-tag">默认</span>}</td>
			</tr>)}</tbody>
		</table>
	</Disclosure>;
}
