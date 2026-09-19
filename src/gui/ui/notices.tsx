import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight, X } from "lucide-react";
import type { GuiNotice } from "../contract";
import { clean } from "./content";
import { Reveal } from "./components/animated";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
import { IconButton } from "./components/icon-button";
import { fade } from "./lib/motion";

export interface NoticeGroup {
	anchor: number;
	notices: GuiNotice[];
}

/** 同一锚点到达的连续通知合成一组。 */
export function groupNotices(notices: GuiNotice[]): NoticeGroup[] {
	const groups: NoticeGroup[] = [];
	for (const notice of notices) {
		const last = groups[groups.length - 1];
		if (last && last.anchor === notice.anchor) last.notices.push(notice);
		else groups.push({ anchor: notice.anchor, notices: [notice] });
	}
	return groups;
}

/** 时间线内联通知组：位于末尾时展开，后续消息到达后自动折叠。 */
export function NoticeGroupView({ group, live, clear }: { group: NoticeGroup; live: boolean; clear: (ids: string[]) => void }) {
	const [open, setOpen] = useState(live);
	const latest = group.notices[group.notices.length - 1];
	useEffect(() => { setOpen(live); }, [latest?.id, live]);
	return <NoticeGroupContent group={group} clear={clear} open={open} onOpenChange={setOpen} />;
}

export function NoticeGroupContent({ group, clear, open, onOpenChange }: {
	group: NoticeGroup; clear: (ids: string[]) => void; open: boolean; onOpenChange: (open: boolean) => void;
}) {
	return <Reveal>
		<Collapsible className="notices" open={open} onOpenChange={onOpenChange}>
			<div className="notices-header">
				<CollapsibleTrigger className="disclosure-trigger"><ChevronRight className="disclosure-chevron" aria-hidden="true" />通知 ({group.notices.length})</CollapsibleTrigger>
				<IconButton label="清除通知" onClick={() => clear(group.notices.map((notice) => notice.id))}><X /></IconButton>
			</div>
			<CollapsibleContent>
				<AnimatePresence initial={false}>{group.notices.map((notice) => <motion.pre {...fade} className={notice.type} key={notice.id}>{clean(notice.text)}</motion.pre>)}</AnimatePresence>
			</CollapsibleContent>
		</Collapsible>
	</Reveal>;
}
