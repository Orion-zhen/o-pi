import { useState } from "react";
import type { Send } from "./dialog.tsx";
import { SessionNameInput } from "./session-name-input.tsx";

export function SessionHeading({ name, send }: { name: string; send: Send }) {
	const [editing, setEditing] = useState(false);
	return <div className="session-heading">
		{editing ? <SessionNameInput name={name} finish={(value) => {
			setEditing(false);
			if (value && value !== name) void send({ action: "rename", name: value });
		}} /> : <button type="button" className="session-name" title="重命名会话" onClick={() => setEditing(true)}>
			{name || "新会话"}
		</button>}
	</div>;
}
