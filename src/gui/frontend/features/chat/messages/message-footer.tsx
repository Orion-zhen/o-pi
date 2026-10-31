import { createContext, useContext, useMemo, type ReactNode } from "react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import type { GuiEntry } from "../../../../shared/messages/types.ts";
import type { Send } from "@/connection/connection.ts";
import { EntryActions } from "../../sessions/entry-actions.tsx";
import { isTreeEntryVisible } from "../../sessions/tree.ts";
import { listDepth, motionDuration, motionEase } from "@/ui/motion/transitions.ts";

const MessageActionsContext = createContext<{ entries: ReadonlyMap<string, GuiEntry>; visible: boolean; send: Send } | null>(null);

export function MessageActionsProvider({ entries, leafId, visible, send, children }: {
	entries: GuiEntry[]; leafId: string | null; visible: boolean; send: Send; children: ReactNode;
}) {
	const byId = useMemo(() => new Map(entries.filter((entry) => isTreeEntryVisible(entry, leafId)).map((entry) => [entry.id, entry])), [entries, leafId]);
	const value = useMemo(() => ({ entries: byId, visible, send }), [byId, visible, send]);
	return <MessageActionsContext value={value}>{children}</MessageActionsContext>;
}

export function MessageFooter({ entryId, children }: { entryId: string | undefined; children?: ReactNode }) {
	const actions = useContext(MessageActionsContext);
	const entry = entryId === undefined ? undefined : actions?.entries.get(entryId);
	return <div className="message-footer">
		<AnimatePresence initial={false}>
			{actions?.visible && entry && <FloatingActions key={entry.id} entry={entry} send={actions.send} />}
		</AnimatePresence>
		{children}
	</div>;
}

function FloatingActions({ entry, send }: { entry: GuiEntry; send: Send }) {
	const present = useIsPresent();
	const transition = { duration: present ? motionDuration[3] : motionDuration[2], ease: motionEase };
	return <motion.div className="message-actions-slot" inert={!present} aria-hidden={!present}
		initial={{ height: 0, marginTop: 0 }} animate={{ height: "auto", marginTop: "var(--space-3)" }} exit={{ height: 0, marginTop: 0 }} transition={transition}>
		<motion.div className="message-actions" initial={listDepth.hidden} animate={listDepth.visible} exit={listDepth.hidden} transition={transition}>
			<EntryActions entry={entry} send={send} />
		</motion.div>
	</motion.div>;
}
