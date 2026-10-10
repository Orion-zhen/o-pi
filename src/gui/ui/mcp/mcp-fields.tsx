import { useEffect, useId, useState, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { Reveal } from "../components/animated.tsx";
import { ArrowDown, ArrowUp, Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { mcpExposures, type McpIssue } from "../../mcp-validation.ts";
import { IconButton } from "../components/icon-button.tsx";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { mcpId, type McpPair } from "./mcp-draft.ts";
import { exposureOptions } from "./mcp-exposure.tsx";

export const mcpText = (value: unknown): string => typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);

export function McpField({ label, field, issues = [], hint, children }: {
	label: string; field?: string; issues?: readonly McpIssue[]; hint?: string; children: ReactNode;
}) {
	return <div className="mcp-field"><span className="mcp-field-label">{label}</span>{children}
		{hint && <p className="settings-description">{hint}</p>}
		{issues.filter((issue) => issue.field === field).map((issue, index) => <p role="alert" key={index}>{issue.message}</p>)}
	</div>;
}

export function McpTextField({ label, value, onChange, secret = false, hint, issues = [], field, placeholder, numeric = false }: {
	label: string; value: unknown; onChange: (value: string) => void; secret?: boolean; hint?: string; issues?: readonly McpIssue[];
	field: string; placeholder?: string; numeric?: boolean;
}) {
	const id = useId();
	return <div className="mcp-field"><label htmlFor={id}>{label}</label>
		{secret ? <McpSecret id={id} label={label} value={mcpText(value)} change={onChange} />
			: numeric ? <McpNumberInput id={id} label={label} value={value} change={onChange} placeholder={placeholder} invalid={issues.some((issue) => issue.field === field)} />
				: <Input id={id} aria-label={label} value={mcpText(value)} placeholder={placeholder}
					aria-invalid={issues.some((issue) => issue.field === field)} onChange={(event) => onChange(event.target.value)} />}
		{secret && typeof value === "string" && value.startsWith("!") && <p className="settings-warning">命令取值：连接时执行，编辑时不执行。</p>}
		{hint && <p className="settings-description">{hint}</p>}
		{issues.filter((issue) => issue.field === field).map((issue, index) => <p role="alert" key={index}>{issue.message}</p>)}
	</div>;
}

function McpNumberInput({ id, label, value, change, placeholder, invalid }: {
	id: string; label: string; value: unknown; change: (value: string) => void; placeholder: string | undefined; invalid: boolean;
}) {
	const [text, setText] = useState(mcpText(value));
	useEffect(() => setText(mcpText(value)), [value]);
	return <Input id={id} aria-label={label} value={text} inputMode="decimal" placeholder={placeholder} aria-invalid={invalid}
		onChange={(event) => { setText(event.target.value); change(event.target.value); }} />;
}

export function McpSecret({ id, label, value, change }: { id?: string; label: string; value: string; change: (value: string) => void }) {
	const [visible, setVisible] = useState(false);
	return <div className="mcp-secret"><Input id={id} aria-label={label} type={visible ? "text" : "password"} autoComplete="off" spellCheck={false}
		value={value} onChange={(event) => change(event.target.value)} />
		<IconButton label={`${visible ? "隐藏" : "显示"}${label}`} tooltip={visible ? "隐藏" : "显示"} size="icon-sm" onClick={() => setVisible(!visible)}>{visible ? <EyeOff /> : <Eye />}</IconButton>
	</div>;
}

export function McpChoice<T extends string>({ label, value, options, change, disabled }: {
	label: string; value: string; options: readonly (readonly [T, ReactNode])[]; change: (value: T) => void; disabled: boolean;
}) {
	return <Select value={value} onValueChange={(value) => change(value as T)} disabled={disabled}>
		<SelectTrigger aria-label={label}><SelectValue>{options.find(([key]) => key === value)?.[1] ?? `无效值：${value || "空"}`}</SelectValue></SelectTrigger>
		<SelectContent>{options.map(([key, title]) => <SelectItem key={key} value={key}>{title}</SelectItem>)}</SelectContent>
	</Select>;
}

export function McpPairs({ label, rows, change, disabled, kind = "secret", hiddenId }: {
	label: string; rows: readonly McpPair[]; change: (rows: McpPair[]) => void; disabled: boolean; kind?: "secret" | "exposure"; hiddenId?: number | undefined;
}) {
	const update = (id: number, patch: Partial<McpPair>) => change(rows.map((row) => row.id === id ? { ...row, ...patch } : row));
	const move = (row: McpPair, index: number, delta: number) => {
		const next = [...rows];
		next.splice(index, 1);
		next.splice(index + delta, 0, row);
		change(next);
	};
	return <div className="mcp-pairs">
		<AnimatePresence initial={false}>{rows.filter((row) => row.id !== hiddenId).map((row, index) => <Reveal key={row.id}><div className="mcp-pair">
			<Input aria-label={`${label}名称 ${index + 1}`} placeholder={kind === "exposure" ? "工具名称或 get_*" : "名称"} value={row.key} onChange={(event) => update(row.id, { key: event.target.value })} />
			{kind === "exposure" ? <McpChoice label={`${label}方式 ${index + 1}`} value={row.value === "codemode-deferred" ? "codemode" : mcpText(row.value)} options={exposureOptions} disabled={disabled} change={(value) => update(row.id, { value })} />
				: <McpSecret label={`${label}值 ${index + 1}`} value={mcpText(row.value)} change={(value) => update(row.id, { value })} />}
			<div className="mcp-row-actions">
				{kind === "exposure" && <><IconButton size="icon-sm" label={`上移规则 ${index + 1}`} tooltip="上移规则" disabled={index === 0} onClick={() => move(row, index, -1)}><ArrowUp /></IconButton>
					<IconButton size="icon-sm" label={`下移规则 ${index + 1}`} tooltip="下移规则" disabled={index === rows.length - 1} onClick={() => move(row, index, 1)}><ArrowDown /></IconButton></>}
				<IconButton size="icon-sm" label={`删除${label} ${index + 1}`} tooltip="删除条目" onClick={() => change(rows.filter(({ id }) => id !== row.id))}><Trash2 /></IconButton>
			</div>
			{typeof row.value === "string" && row.value.startsWith("!") && <p className="settings-warning">命令取值：连接时执行，编辑时不执行。</p>}
		</div></Reveal>)}</AnimatePresence>
		<Button variant="outline" size="sm" className="mcp-add-row" onClick={() => change([...rows, { id: mcpId(), key: "", value: kind === "exposure" ? mcpExposures[0] : "" }])}><Plus />添加{label}</Button>
	</div>;
}
