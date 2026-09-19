import { useState } from "react";
import { Fade } from "./components/animated";
import { fade, settle } from "./lib/motion";
import { MessageSquare, Pencil, Shield } from "lucide-react";
import type { Send } from "./connection.ts";
import { IconButton } from "./components/icon-button";
import { Button } from "./components/ui/button";
import { ConfirmAction } from "./confirm-action.tsx";
import { SessionNameInput } from "./session-name-input.tsx";
import { ActivityBorder } from "./activity-border.tsx";

const dateFormat = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" });

export function HistorySessionRow({ path, title, modified, selected, disabled, busy, waiting, unread, send, open, animated = true }: {
	path: string | null; title: string; modified?: string | undefined; selected: boolean; disabled: boolean; busy: boolean; waiting: boolean; unread: boolean;
	send: Send; open: () => void; animated?: boolean;
}) {
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
		}} /> : <Button variant="ghost" className="history-session" aria-label={title}
			aria-current={selected ? "page" : undefined} data-unread={unread} aria-description={waiting ? "等待审批" : busy ? "运行中" : unread ? "有未读结果" : undefined} disabled={disabled || pending}
			title={modified ? `${title}\n${new Date(modified).toLocaleString("zh-CN")}` : title} onClick={open}>
			{waiting ? <Shield className="approval-marker" fill="currentColor" role="img" aria-label="等待审批" /> : <MessageSquare />}<span className="history-session-title">{title}</span>
			{modified && <time dateTime={modified}>{dateFormat.format(new Date(modified))}</time>}
		</Button>}
		{path && <div className="row-actions">
			<IconButton label={`重命名会话 ${title}`} className="row-action-button" disabled={disabled || busy || pending || editing}
				onClick={() => setEditing(true)}><Pencil /></IconButton>
			{!busy && !waiting && !unread && <ConfirmAction label={`删除会话 ${title}`} hint="永久删除会话，再次点击确认。Ctrl+点击直接删除"
				disabled={disabled || pending || editing} allowCtrl confirm={() => send({ action: "deleteSession", path })} />}
		</div>}
	</>;
	const props = { className: "history-session-row overlay-list-row activity-frame", "data-current": selected, "data-editing": editing };
	return animated ? <Fade layout="position" transition={{ ...fade.transition, layout: settle }} {...props}>{content}</Fade> : <div {...props}>{content}</div>;
}
