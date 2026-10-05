import { memo, useState } from "react";
import { Fade } from "../components/animated";
import { fade, settle } from "../lib/motion";
import { MessageSquare, Pencil, Shield } from "lucide-react";
import type { Send } from "../runtime/connection.ts";
import type { SessionListItem } from "./session-list.ts";
import { Hint } from "../components/ui/tooltip";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";
import { ConfirmAction } from "../components/confirm-action.tsx";
import { SessionNameInput } from "./session-name-input.tsx";
import { ActivityBorder } from "../components/activity-border.tsx";

const dateFormat = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" });

export const HistorySessionRow = memo(function HistorySessionRow({ item, disabled, send, open, animated }: {
	item: SessionListItem; disabled: boolean; send: Send; open: (item: SessionListItem) => void; animated: boolean;
}) {
	const { path, title, modified, selected, activity } = item;
	const busy = activity !== undefined && activity.state !== "idle";
	const waiting = activity?.state === "waiting";
	const unread = activity?.unread === true;
	const [editing, setEditing] = useState(false);
	const [pending, setPending] = useState(false);
	const state = waiting ? "waiting" : busy ? "running" : unread ? "unread" : "idle";
	const content = <>
		<ActivityBorder state={state} />
		{editing ? <SessionNameInput name={title} finish={(name) => {
			setEditing(false);
			if (name === title || !path) return;
			setPending(true);
			void send({ action: "renameSession", path, name }).finally(() => setPending(false));
		}} /> : <Hint content={modified ? new Date(modified).toLocaleString("zh-CN") : undefined}><Button variant="ghost" className="history-session" aria-label={title}
			aria-current={selected ? "page" : undefined} data-unread={unread} aria-description={waiting ? "等待审批" : busy ? "运行中" : unread ? "有未读结果" : undefined} disabled={disabled || pending}
			onClick={() => open(item)}>
			{waiting ? <Shield className="approval-marker" fill="currentColor" role="img" aria-label="等待审批" /> : <MessageSquare />}<span className="history-session-title">{title}</span>
			{modified && <time dateTime={modified}>{dateFormat.format(new Date(modified))}</time>}
		</Button></Hint>}
		{path && <div className="row-actions">
			{!busy && <IconButton label={`重命名会话 ${title}`} tooltip="重命名" className="row-action-button" disabled={disabled || pending || editing}
				onClick={() => setEditing(true)}><Pencil /></IconButton>}
			{!busy && !waiting && !unread && <ConfirmAction label={`删除会话 ${title}`}
				disabled={disabled || pending || editing} allowShortcut confirm={() => send({ action: "deleteSession", path })} />}
		</div>}
	</>;
	const props = { className: "history-session-row overlay-list-row activity-frame", "data-current": selected, "data-editing": editing };
	return animated ? <Fade layout="position" transition={{ ...fade.transition, layout: settle }} {...props}>{content}</Fade> : <div {...props}>{content}</div>;
});
