import { useState } from "react";
import type { Send } from "@/connection/connection.ts";
import type { GuiSnapshot } from "../../../shared/protocol/state.ts";
import { Hint } from "@/ui/tooltip.tsx";
import { SessionNameInput } from "./session-name-input.tsx";
import { SessionTitle } from "./session-title.tsx";

export function SessionHeading({ name, titleGeneration, send }: Pick<GuiSnapshot, "name" | "titleGeneration"> & { send: Send }) {
	const [editing, setEditing] = useState(false);
	return <div className="session-heading">
		{editing ? <SessionNameInput name={name} finish={(value) => {
			setEditing(false);
			if (value && value !== name) void send({ action: "rename", name: value });
		}} /> : <Hint content="重命名"><button type="button" className="session-name" onClick={() => setEditing(true)}>
			<SessionTitle title={name || "新会话"} state={titleGeneration} />
		</button></Hint>}
	</div>;
}
