import { useState } from "react";
import type { Send } from "./connection.ts";
import { PanelDialog } from "./components/panel-dialog";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";

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
		<p>{file === "gui.jsonc" ? "保存后直接应用，不重载会话。" : "保存后重载。"}文件在编辑期间发生变更时会拒绝覆盖。</p>
		<Textarea aria-label={file === "gui.jsonc" ? "GUI 设置 JSONC" : "设置 JSON"} className="config-editor" value={text} onChange={(event) => setText(event.target.value)} />
		<Button variant="outline" size="sm" disabled={saving} onClick={() => void save()}>{file === "gui.jsonc" ? "保存并应用" : "保存并重载"}</Button>
	</PanelDialog>;
}
