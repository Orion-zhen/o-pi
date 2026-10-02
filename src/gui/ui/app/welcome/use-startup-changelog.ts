import { useCallback, useEffect, useRef, useState } from "react";
import type { GlobalQuery, GuiChangelog, GuiConnection, Query } from "../../../contract.ts";
import type { SessionSnapshot } from "../gui-controls.ts";

export function useStartupChangelog(connected: boolean, snapshot: SessionSnapshot | null, selectedId: string | null,
	query: Query<GlobalQuery>, send: GuiConnection["send"], onError: (message: string) => void) {
	const started = useRef(false);
	const displayed = useRef(false);
	const selected = useRef(selectedId);
	selected.current = selectedId;
	const [notice, setNotice] = useState<{ sessionId: string; value: GuiChangelog }>();
	const finish = useCallback((shown: boolean) => {
		void send({ action: "startupChangelog", shown }, null).catch((error: unknown) => onError(String(error)));
	}, [send, onError]);

	useEffect(() => {
		if (!connected || !snapshot || started.current) return;
		// 恢复会话不消耗更新提示，切换会话和重连也不重新检测。
		if (snapshot.messages.length) { started.current = true; return; }
		const read = () => {
			if (document.visibilityState !== "visible" || started.current) return;
			started.current = true;
			void query({ query: "startupChangelog" }).then((value) => {
				if (!value) return;
				if (selected.current !== snapshot.sessionId) { finish(false); return; }
				setNotice({ sessionId: snapshot.sessionId, value });
			}).catch((error: unknown) => onError(String(error)));
		};
		read();
		document.addEventListener("visibilitychange", read);
		return () => document.removeEventListener("visibilitychange", read);
	}, [connected, snapshot, query, finish, onError]);

	useEffect(() => {
		if (notice && notice.sessionId !== selectedId) {
			setNotice(undefined);
			if (!displayed.current) finish(false);
		}
	}, [notice, selectedId, finish]);

	const shown = useCallback(() => {
		if (displayed.current) return;
		displayed.current = true;
		finish(true);
	}, [finish]);
	return { changelog: notice?.sessionId === selectedId ? notice.value : undefined, changelogShown: shown };
}
