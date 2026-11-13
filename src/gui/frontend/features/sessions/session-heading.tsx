import { useContext, useState } from "react";
import type { Send } from "@/connection/connection.ts";
import type { GuiAction } from "../../../shared/protocol/actions.ts";
import type { GuiSnapshot } from "../../../shared/protocol/state.ts";
import { NotificationErrorContext } from "@/ui/notifications.tsx";
import { Hint } from "@/ui/tooltip.tsx";
import { SessionNameInput } from "./session-name-input.tsx";
import { SessionTitle } from "./session-title.tsx";

export function SessionHeading({ name, titleGeneration, send }: Pick<GuiSnapshot, "name" | "titleGeneration"> & { send: Send<Extract<GuiAction, { action: "rename" }>> }) {
	const notifyError = useContext(NotificationErrorContext);
	const [editing, setEditing] = useState(false);
	return <div className="session-heading">
		{editing ? <SessionNameInput name={name} finish={(value) => {
			setEditing(false);
			if (value && value !== name) void send({ action: "rename", name: value }).catch(notifyError);
		}} /> : <Hint content="重命名"><button type="button" className="session-name" onClick={() => setEditing(true)}>
			<SessionTitle title={name || "新会话"} state={titleGeneration} />
		</button></Hint>}
	</div>;
}
