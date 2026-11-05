import { createContext, useCallback, useRef, useState } from "react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { Toast } from "radix-ui";
import { X } from "lucide-react";
import type { FeedbackTone } from "../../shared/protocol/events.ts";
import { FeedbackDetails, FeedbackIcon } from "./feedback.tsx";
import { useTextOverflow } from "./use-text-overflow.ts";
import { fade, settle } from "./motion/transitions.ts";
import { Crossfade, Fade } from "./motion/animated.tsx";
import { Button } from "./button.tsx";
import { IconButton } from "./icon-button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./collapsible.tsx";

export interface Notification { id: number; message: string; tone: FeedbackTone }
export const NotificationErrorContext = createContext<(error: unknown) => void>((error) => { throw error; });

export function useNotifications() {
	const [items, setItems] = useState<Notification[]>([]);
	const sequence = useRef(0);
	const notify = useCallback((message: string, tone: FeedbackTone) => {
		const item = { id: ++sequence.current, message, tone };
		setItems((items) => items.some((entry) => entry.message === message && entry.tone === tone) ? items : [...items, item]);
	}, []);
	const reportError = useCallback((error: unknown) => notify(error instanceof Error ? error.message : String(error), "error"), [notify]);
	const dismiss = useCallback((id: number) => setItems((items) => items.filter((item) => item.id !== id)), []);
	return { items, notify, reportError, dismiss };
}

export function Notifications({ items, dismiss, suspended }: {
	items: Notification[]; dismiss: (id: number) => void; suspended: boolean;
}) {
	const current = items[0];
	return <Toast.Provider label="通知" swipeDirection="up">
		<AnimatePresence mode="wait">
			{!suspended && current && <NotificationToast key={current.id} item={current} count={items.length} dismiss={() => dismiss(current.id)} />}
		</AnimatePresence>
		<div className="toast-layer"><Toast.Viewport className="toast-viewport" label="通知 ({hotkey})" /></div>
	</Toast.Provider>;
}

function NotificationToast({ item, count, dismiss }: { item: Notification; count: number; dismiss: () => void }) {
	const present = useIsPresent();
	const [expanded, setExpanded] = useState(false);
	const detailsButton = useRef<HTMLButtonElement>(null);
	const message = item.message.trim();
	const summary = message.replace(/[\r\n][\s\S]*/, "");
	const { ref, overflow } = useTextOverflow(summary);
	return <Toast.Root forceMount asChild open={present} onOpenChange={(open) => { if (!open) dismiss(); }}
		onEscapeKeyDown={(event) => {
			if (!expanded) return;
			event.preventDefault(); setExpanded(false); detailsButton.current?.focus();
		}}
		duration={expanded || item.tone === "error" || item.tone === "warning" ? Infinity : 3500}>
		<Collapsible asChild open={expanded} onOpenChange={setExpanded}>
		<motion.li {...fade} layout="size" transition={{ ...fade.transition, layout: settle }}
			className="toast floating-surface" data-tone={item.tone} inert={!present} aria-hidden={!present}>
			<FeedbackIcon tone={item.tone} />
			<div className="toast-content">
				<Toast.Description asChild><div ref={ref} className="toast-message">{summary}</div></Toast.Description>
				<div className="toast-actions">
					{(expanded || summary !== message || overflow) && <CollapsibleTrigger asChild><Button ref={detailsButton} size="sm" variant="ghost">{expanded ? "收起详情" : "详情"}</Button></CollapsibleTrigger>}
					<AnimatePresence>{count > 1 && <Fade className="toast-count" aria-label={`另有 ${count - 1} 条通知`}>
						<Crossfade value={String(count)}>+{count - 1}</Crossfade>
					</Fade>}</AnimatePresence>
				</div>
			</div>
			<Toast.Close asChild><IconButton className="toast-close" label="关闭通知"><X /></IconButton></Toast.Close>
			<CollapsibleContent className="toast-details" lazy><FeedbackDetails message={item.message} /></CollapsibleContent>
		</motion.li>
		</Collapsible>
	</Toast.Root>;
}
