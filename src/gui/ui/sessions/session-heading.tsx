import { useState } from "react";
import type { Send } from "../runtime/connection.ts";
import { Hint } from "../components/ui/tooltip";
import { SessionNameInput } from "./session-name-input.tsx";

export function SessionHeading({ name, send }: { name: string; send: Send }) {
	const [editing, setEditing] = useState(false);
	return <div className="session-heading">
		{editing ? <SessionNameInput name={name} finish={(value) => {
			setEditing(false);
			if (value && value !== name) void send({ action: "rename", name: value });
		}} /> : <Hint content="重命名"><button type="button" className="session-name" onClick={() => setEditing(true)}>
			{name || "新会话"}
		</button></Hint>}
	</div>;
}
