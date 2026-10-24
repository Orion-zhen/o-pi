import { useState } from "react";
import type { Send } from "@/connection/connection.ts";
import { PanelDialog } from "@/ui/panel-dialog.tsx";
import { Button } from "@/ui/button.tsx";
import { Textarea } from "@/ui/textarea.tsx";
import "./settings.css";

export function ConfigEditor({ file, content, send, close, restoreFocus }: {
	file: "settings.json" | "gui.jsonc"; content: string; send: Send; close: () => void; restoreFocus: () => void;
}) {
	const [original] = useState(content);
	const [text, setText] = useState(content || "{}\n");
	const [saving, setSaving] = useState(false);
	const save = async () => {
		setSaving(true);
		try {
			const ok = await send(file === "gui.jsonc" ? { action: "saveGuiConfig", original, content: text }
				: { action: "saveConfig", file, original, content: text });
			if (ok) close();
		} finally { setSaving(false); }
	};
	return <PanelDialog title={file} close={close} restoreFocus={restoreFocus}>
		<div className="gui-settings settings-config-editor">
		<Textarea aria-label={file === "gui.jsonc" ? "GUI 设置 JSONC" : "设置 JSON"} className="settings-source" value={text} onChange={(event) => setText(event.target.value)} />
		<footer className="settings-actions"><div className="settings-action-buttons">
			<Button disabled={saving || text === (original || "{}\n")} onClick={() => void save()}>{saving ? "保存中…" : file === "gui.jsonc" ? "保存并应用" : "保存并重载"}</Button>
		</div></footer>
		</div>
	</PanelDialog>;
}
