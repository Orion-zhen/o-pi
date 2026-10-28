import { memo, useState } from "react";
import { Fade } from "@/ui/motion/animated.tsx";
import { fade, listDepth, listDeparture } from "@/ui/motion/transitions.ts";
import { startupRow, useStartupLists } from "@/app/welcome/startup-entrance.tsx";
import { sessionListTiming } from "@/app/welcome/welcome-timing.ts";
import { Pencil } from "lucide-react";
import { MessageSquare } from "lucide";
import { MorphIcon } from "morphicons/react";
import { FilledShield } from "@/ui/icon-shapes.ts";
import type { Send } from "@/connection/connection.ts";
import type { SessionListItem } from "./session-list.ts";
import type { SessionSearchHit } from "../../../shared/session-search.ts";
import { SearchExcerptText } from "./search-excerpt.tsx";
import { Hint } from "@/ui/tooltip.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Button } from "@/ui/button.tsx";
import { ConfirmAction } from "@/ui/confirm-action.tsx";
import { SessionNameInput } from "./session-name-input.tsx";
import { SessionTitle } from "./session-title.tsx";
import { ActivityBorder } from "./activity-border.tsx";

const dateFormat = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" });

export const HistorySessionRow = memo(function HistorySessionRow({ item, index, count, disabled, send, open, animated, match }: {
	item: SessionListItem; index: number; count: number; disabled: boolean; send: Send; open: (item: SessionListItem) => void; animated: boolean;
	match?: SessionSearchHit | undefined;
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
			<MorphIcon icon={waiting ? FilledShield : MessageSquare} spring="smooth" size="1em"
				className={waiting ? "approval-marker" : undefined} {...(waiting ? { label: "等待审批" } : {})} /><span className="history-session-label"><span className="history-session-title">
				{match?.source === "title" ? <SearchExcerptText value={match.excerpt} /> : <SessionTitle title={title} state={activity?.titleGeneration} />}
			</span>{match && match.source !== "title" && <span className="history-session-excerpt">
				<SearchExcerptText value={match.excerpt} label={`${match.source === "user" ? "用户" : "助手"}: `} />
			</span>}</span>
			{modified && <time dateTime={modified}>{dateFormat.format(new Date(modified))}</time>}
		</Button></Hint>}
		{path && <div className="row-actions">
			<IconButton label={`重命名会话 ${title}`} tooltip="重命名" className="row-action-button" disabled={disabled || pending || editing}
				onClick={() => setEditing(true)}><Pencil /></IconButton>
			{!busy && !waiting && !unread && <ConfirmAction label={`删除会话 ${title}`}
				disabled={disabled || pending || editing} allowShortcut confirm={() => send({ action: "deleteSession", path })} />}
		</div>}
	</>;
	const props = { className: "history-session-row overlay-list-row activity-frame", "data-current": selected, "data-editing": editing };
	const lists = useStartupLists();
	const entrance = startupRow(lists, index, count, sessionListTiming);
	return <Fade {...props} {...(entrance ?? { initial: animated ? fade.initial : false, animate: { ...fade.animate, ...listDepth.visible } })}
		variants={{ exit: (visible: ReadonlySet<string>) => visible.has(item.key) ? { opacity: 1, transition: { duration: 0 } } : listDeparture }}
		exit="exit">{content}</Fade>;
});
