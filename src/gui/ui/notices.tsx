import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { GuiNotice } from "../contract";
import { clean } from "./content";
import { Reveal } from "./components/animated";
import { Disclosure } from "./components/disclosure";
import { fade } from "./lib/motion";

export function Notices({ notices }: { notices: GuiNotice[] }) {
	const error = notices.findLast((notice) => notice.type === "error");
	const [open, setOpen] = useState(Boolean(error));
	useEffect(() => { if (error) setOpen(true); }, [error?.id]);
	return <AnimatePresence initial={false}>
		{notices.length > 0 && <Reveal>
			<Disclosure className="notices" open={open} onOpenChange={setOpen} summary={`通知 (${notices.length})`}>
				<AnimatePresence initial={false}>{notices.map((notice) => <motion.pre {...fade} className={notice.type} key={notice.id}>{clean(notice.text)}</motion.pre>)}</AnimatePresence>
			</Disclosure>
		</Reveal>}
	</AnimatePresence>;
}
