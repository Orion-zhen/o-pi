import { useEffect, useRef } from "react";
import type { GuiSnapshot } from "../contract.ts";
import type { Send } from "./dialog.tsx";

/** 合并流式变更，读取操作不触发快照发布。 */
export function useSessionInfoRefresh(snapshot: GuiSnapshot | null | undefined, status: string, send: Send) {
	const latest = useRef({ snapshot, status });
	const dirty = useRef(false);
	const pending = useRef(false);
	const schedule = useRef<() => void>(() => {});
	useEffect(() => {
		let active = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const refresh = async () => {
			if (!active || pending.current) return;
			const { snapshot, status } = latest.current;
			if (!snapshot || snapshot.busy || status !== "已连接") return;
			dirty.current = false;
			pending.current = true;
			try { await send({ action: "sessionInfo" }); }
			finally {
				pending.current = false;
				if (active && dirty.current) schedule.current();
			}
		};
		schedule.current = () => {
			if (timer || pending.current) return;
			timer = setTimeout(() => { timer = undefined; void refresh(); }, 150);
		};
		return () => { active = false; clearTimeout(timer); };
	}, [send]);
	useEffect(() => {
		latest.current = { snapshot, status };
		dirty.current = true;
		schedule.current();
	}, [snapshot, status]);
}
