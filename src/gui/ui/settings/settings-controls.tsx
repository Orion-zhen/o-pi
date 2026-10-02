import type { ReactNode } from "react";
import { Code, List, RotateCcw } from "lucide-react";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/icon-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import "./gui-settings.css";

export function SettingsHeading({ title, children }: { title: string; children?: ReactNode }) {
	return <header className="settings-section-heading"><h2>{title}</h2>
		{children && <div className="settings-heading-actions">{children}</div>}
	</header>;
}

export function SettingsSourceButton({ file, source = false, disabled, onClick }: {
	file: string; source?: boolean; disabled?: boolean; onClick: () => void;
}) {
	return <Tooltip><TooltipTrigger asChild>
		<Button variant="outline" size="sm" disabled={disabled} onClick={onClick}>
			{source ? <List aria-hidden="true" /> : <Code aria-hidden="true" />}
			{source ? "返回表单" : file.endsWith(".jsonc") ? "编辑 JSONC" : "编辑 JSON"}
		</Button>
	</TooltipTrigger><TooltipContent>{file}</TooltipContent></Tooltip>;
}

export function SettingsRow({ label, description, htmlFor, children, reset, disabled }: {
	label: string; description?: string | undefined; htmlFor?: string; children: ReactNode; disabled?: boolean;
	reset?: { value: unknown; defaultValue: unknown; apply: () => void };
}) {
	return <div className="preference-row">
		<div className="preference-label">
			<div className="preference-label-heading"><label htmlFor={htmlFor}>{label}</label>
				{reset && JSON.stringify(reset.value) !== JSON.stringify(reset.defaultValue)
					&& <IconButton size="icon-sm" label={`重置${label}`} disabled={disabled} onClick={reset.apply}><RotateCcw /></IconButton>}
			</div>
			{description && <small>{description}</small>}
		</div>
		<div className="preference-control">{children}</div>
	</div>;
}

export function SettingsActions({ dirty, saving, disabled, invalid = false, error, status, save, discard, reload }: {
	dirty: boolean; saving: boolean; disabled: boolean; invalid?: boolean; error: string; status: string;
	save: () => void; discard: () => void; reload?: () => void;
}) {
	const blocked = disabled || saving;
	return <footer className="settings-actions">
		<div className="settings-action-buttons">
			<Button disabled={blocked || invalid || !dirty} onClick={save}>{saving ? "保存中…" : "保存"}</Button>
			<Button variant="outline" disabled={blocked || !dirty} onClick={discard}>放弃修改</Button>
			{reload && <Button variant="ghost" disabled={blocked || dirty} onClick={reload}>重新读取</Button>}
			{dirty && <span className="settings-dirty" role="status">有未保存修改</span>}
		</div>
		{error && <p role="alert">{error}</p>}
		{status && <p role="status">{status}</p>}
	</footer>;
}
