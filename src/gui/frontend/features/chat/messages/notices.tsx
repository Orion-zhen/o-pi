import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { ChevronRight, X } from "lucide-react";
import type { GuiNotice } from "../../../../shared/protocol/state.ts";
import { clean } from "@/ui/content/format.ts";
import { Crossfade, Fade, Reveal } from "@/ui/motion/animated.tsx";
import { Feedback } from "@/ui/feedback.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/ui/collapsible.tsx";
import { IconButton } from "@/ui/icon-button.tsx";

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
	const errors = group.notices.filter((notice) => notice.type === "error").length;
	const warnings = group.notices.filter((notice) => notice.type === "warning").length;
	const summary = errors || warnings
		? [errors ? `${errors} 项错误` : "", warnings ? `${warnings} 项提醒` : ""].filter(Boolean).join("，")
		: `${group.notices.length} 条会话记录`;
	const problem = group.notices.findLast((notice) => notice.type === "error") ?? group.notices.findLast((notice) => notice.type === "warning");
	return <Reveal>
		<Collapsible className="notices" open={open} onOpenChange={onOpenChange}>
			<div className="notices-header">
				<CollapsibleTrigger className="disclosure-trigger"><ChevronRight className="disclosure-chevron" aria-hidden="true" />
					<span className="notice-heading"><Crossfade value={summary}>{summary}</Crossfade>
						<AnimatePresence>{!open && problem && <Fade key={problem.id} className="notice-preview">{clean(problem.text)}</Fade>}</AnimatePresence>
					</span>
				</CollapsibleTrigger>
				<IconButton label="清除会话记录" onClick={() => clear(group.notices.map((notice) => notice.id))}><X /></IconButton>
			</div>
			<CollapsibleContent>
				<AnimatePresence initial={false}>{group.notices.map((notice) =>
					<Feedback key={notice.id} compact tone={notice.type} message={clean(notice.text)} />,
				)}</AnimatePresence>
			</CollapsibleContent>
		</Collapsible>
	</Reveal>;
}
