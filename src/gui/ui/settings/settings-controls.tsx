import type { ReactNode } from "react";
import { Code, List, RotateCcw } from "lucide-react";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/icon-button";
import { Disclosure } from "../components/disclosure";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import "./gui-settings.css";

export function SettingsHeading({ title, children }: { title: string; children?: ReactNode }) {
	return <header className="settings-section-heading"><h2>{title}</h2>
		{children && <div className="settings-heading-actions">{children}</div>}
	</header>;
}

export function SettingsSection({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
	return <section className="settings-section" aria-label={title}>
		<header className="settings-group-heading"><h3>{title}</h3>{actions && <div className="settings-heading-actions">{actions}</div>}</header>
		{children}
	</section>;
}

export function SettingsDisclosure({ title, children }: { title: string; children: ReactNode }) {
	return <Disclosure className="settings-disclosure" summary={title}>
		<div className="settings-disclosure-body">{children}</div>
	</Disclosure>;
}

export function SettingsSourceButton({ file, source = false, disabled, onClick }: {
	file: string; source?: boolean; disabled?: boolean; onClick: () => void;
}) {
	return <Tooltip><TooltipTrigger asChild>
		<Button variant="ghost" size="sm" disabled={disabled} onClick={onClick}>
			{source ? <List aria-hidden="true" /> : <Code aria-hidden="true" />}
			{source ? "表单" : file.endsWith(".jsonc") ? "JSONC" : "JSON"}
		</Button>
	</TooltipTrigger><TooltipContent>{file}</TooltipContent></Tooltip>;
}

export function SettingsRow({ label, htmlFor, children, reset, disabled, layout = "inline" }: {
	label: string; htmlFor?: string; children: ReactNode; disabled?: boolean;
	layout?: "inline" | "fluid" | "wide";
	reset?: { value: unknown; defaultValue: unknown; apply: () => void };
}) {
	return <div className="preference-row" data-layout={layout}>
		<div className="preference-label">
			<label htmlFor={htmlFor}>{label}</label>
			{reset && JSON.stringify(reset.value) !== JSON.stringify(reset.defaultValue)
				&& <IconButton size="icon-sm" label={`重置${label}`} disabled={disabled} onClick={reset.apply}><RotateCcw /></IconButton>}
		</div>
		<div className="preference-control">{children}</div>
	</div>;
}

export function SettingsActions({ count, saving, disabled, blocked, error, status, save, discard }: {
	count: number; saving: boolean; disabled: boolean; blocked: boolean; error: string; status: string;
	save: () => void; discard: () => void;
}) {
	return <footer className="settings-actions">
		<div className="settings-save-status" role="status">{saving ? "保存中…" : count ? `${count} 个页面未保存` : status}</div>
		{error && <p role="alert">{error}</p>}
		<div className="settings-action-buttons">
			<Button disabled={disabled || saving || blocked || count === 0} aria-busy={saving} onClick={save}>保存</Button>
			<Button variant="outline" disabled={saving || count === 0} onClick={discard}>放弃</Button>
		</div>
	</footer>;
}
