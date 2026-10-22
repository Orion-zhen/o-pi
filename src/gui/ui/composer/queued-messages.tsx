import { useState } from "react";
import { AnimatePresence } from "motion/react";
import { Trash2 } from "lucide-react";
import type { GuiSnapshot } from "../../contract";
import { ListItem } from "../components/animated";
import { AnimatedNumber } from "../components/motion-primitives/animated-number";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { IconButton } from "../components/icon-button";

function QueueRows({ messages, label }: { messages: readonly string[]; label: string }) {
	const [list, setList] = useState(() => ({ items: messages.map((text, id) => ({ text, id })), nextId: messages.length }));
	if (messages.length !== list.items.length || messages.some((text, index) => text !== list.items[index]?.text)) {
		// 从头消费、尾部追加，按重叠部分保留身份，避免重复文本使用相同 key。
		const start = list.items.findIndex((_, offset) => list.items.slice(offset).every((item, index) => item.text === messages[index]));
		const remaining = start < 0 ? [] : list.items.slice(start);
		let nextId = list.nextId;
		setList({ items: messages.map((text, index) => remaining[index] ?? { text, id: nextId++ }), nextId });
	}
	return <AnimatePresence initial={false} mode="popLayout">
		{list.items.map(({ text, id }) => <ListItem key={id} exit={{ opacity: 0, x: -4 }}>
			<div className="queue-item"><span className="queue-kind">{label}</span><span className="queue-message">{text || "（无文本）"}</span></div>
		</ListItem>)}
	</AnimatePresence>;
}

export function QueuedMessages({ queue, clear }: { queue: GuiSnapshot["queue"]; clear: () => void }) {
	return <Collapsible defaultOpen className="queue">
		<div className="queue-heading">
			<CollapsibleTrigger>待发送消息 (<AnimatedNumber value={queue.steering.length + queue.followUp.length} />)</CollapsibleTrigger>
			<IconButton label="清空队列" onClick={(event) => { event.preventDefault(); clear(); }}><Trash2 /></IconButton>
		</div>
		<CollapsibleContent>
			<ol className="queue-list" aria-label="待发送消息">
				<QueueRows messages={queue.steering} label="引导" />
				<QueueRows messages={queue.followUp} label="跟进" />
			</ol>
		</CollapsibleContent>
	</Collapsible>;
}
