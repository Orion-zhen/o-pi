import type { ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { Code, List } from "lucide";
import { MorphIcon } from "morphicons/react";
import { Button } from "@/ui/button.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Disclosure } from "@/ui/disclosure.tsx";
import { Hint } from "@/ui/tooltip.tsx";
import { TextMorph } from "@/ui/motion/text-morph.tsx";
import { equalConfigValues } from "../../../harness/config-values.ts";
import "./settings.css";

export function SettingsHeading({ title, children }: { title: string; children?: ReactNode }) {
	return <header className="settings-section-heading"><h2>{title}</h2>
		{children && <div className="settings-heading-actions">{children}</div>}
	</header>;
}

export function SettingsSection({ title, actions, children, source = false }: { title: string; actions?: ReactNode; children: ReactNode; source?: boolean }) {
	return <section className={`settings-section${source ? " settings-section-source" : ""}`} aria-label={title}>
		<header className="settings-group-heading"><h3>{title}</h3>{actions && <div className="settings-heading-actions">{actions}</div>}</header>
		<div className="settings-section-body">{children}</div>
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
	return <Hint content={source ? "表单编辑" : "编辑配置文件"}>
		<Button variant="ghost" size="sm" disabled={disabled} onClick={onClick}>
			<MorphIcon icon={source ? List : Code} spring="smooth" size="1em" />
			{source ? "表单" : file.endsWith(".jsonc") ? "JSONC" : "JSON"}
		</Button>
	</Hint>;
}

export function SettingsRow({ label, htmlFor, children, reset, disabled, description, layout = "inline" }: {
	label: string; htmlFor?: string; children: ReactNode; disabled?: boolean; description?: ReactNode;
	layout?: "inline" | "fluid" | "wide";
	reset?: { value: unknown; defaultValue: unknown; apply: () => void };
}) {
	return <div className="preference-row" data-layout={layout}>
		<div className="preference-label">
			<label htmlFor={htmlFor}>{label}</label>
			{reset && !equalConfigValues(reset.value, reset.defaultValue)
				&& <IconButton size="icon-sm" label={`重置${label}`} tooltip="恢复默认" disabled={disabled} onClick={reset.apply}><RotateCcw /></IconButton>}
		</div>
		<div className="preference-control">{children}</div>
		{description && <div className="preference-description settings-description">{description}</div>}
	</div>;
}

export function SettingsActions({ count, saving, disabled, blocked, error, status, save, discard }: {
	count: number; saving: boolean; disabled: boolean; blocked: boolean; error: string; status: string;
	save: () => void; discard: () => void;
}) {
	const message = saving ? "保存中…" : count ? `${count} 个页面未保存` : status;
	return <footer className="settings-actions">
		<div className="settings-save-status" role="status" aria-label={message}><TextMorph>{message}</TextMorph></div>
		{error && <p role="alert">{error}</p>}
		<div className="settings-action-buttons">
			<Button disabled={disabled || saving || blocked || count === 0} aria-busy={saving} onClick={save}>保存</Button>
			<Button variant="outline" disabled={saving || count === 0} onClick={discard}>放弃</Button>
		</div>
	</footer>;
}
