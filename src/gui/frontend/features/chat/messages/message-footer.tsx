import { createContext, useContext, useMemo, type ReactNode } from "react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import type { GuiEntry } from "../../../../shared/messages/types.ts";
import type { Send } from "@/connection/connection.ts";
import { EntryActions } from "../../sessions/entry-actions.tsx";
import { visibleEntryMessage, type EntryMessage } from "../../sessions/tree.ts";
import { listDepth, motionDuration, motionEase } from "@/ui/motion/transitions.ts";

interface MessageActions { entries: ReadonlyMap<string, GuiEntry>; leafId: string | null; visible: boolean; send: Send }
const MessageActionsContext = createContext<MessageActions | null>(null);

export function MessageActionsProvider({ entries, leafId, visible, send, children }: MessageActions & { children: ReactNode }) {
	const value = useMemo(() => ({ entries, leafId, visible, send }), [entries, leafId, visible, send]);
	return <MessageActionsContext value={value}>{children}</MessageActionsContext>;
}

export function MessageFooter({ entryId, children }: { entryId: string | undefined; children?: ReactNode }) {
	const actions = useContext(MessageActionsContext);
	const entry = entryId === undefined ? undefined : actions?.entries.get(entryId);
	const message = actions && entry ? visibleEntryMessage(entry, actions.leafId) : undefined;
	return <div className="message-footer">
		<AnimatePresence initial={false}>
			{actions?.visible && entry && message && <FloatingActions key={entry.id} entry={entry} message={message} send={actions.send} />}
		</AnimatePresence>
		{children}
	</div>;
}

function FloatingActions({ entry, message, send }: { entry: GuiEntry; message: EntryMessage; send: Send }) {
	const present = useIsPresent();
	const transition = { duration: present ? motionDuration[3] : motionDuration[2], ease: motionEase };
	return <motion.div className="message-actions-slot" inert={!present} aria-hidden={!present}
		initial={{ height: 0, marginTop: 0 }} animate={{ height: "auto", marginTop: "var(--space-3)" }} exit={{ height: 0, marginTop: 0 }} transition={transition}>
		<motion.div className="message-actions" initial={listDepth.hidden} animate={listDepth.visible} exit={listDepth.hidden} transition={transition}>
			<EntryActions entry={entry} message={message} send={send} />
		</motion.div>
	</motion.div>;
}
