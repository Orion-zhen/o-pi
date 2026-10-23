import { powerMonitor, powerSaveBlocker, session } from "electron";

export function installDesktopPower(resume: () => void, notice: (text: string) => void) {
	let enabled = false;
	let running = false;
	let suspended = false;
	let disposed = false;
	let blocker: number | undefined;
	const update = () => {
		const prevent = enabled && running && !suspended && !disposed;
		if (prevent && blocker === undefined) blocker = powerSaveBlocker.start("prevent-app-suspension");
		else if (!prevent && blocker !== undefined) { powerSaveBlocker.stop(blocker); blocker = undefined; }
	};
	const onSuspend = () => {
		suspended = true;
		update();
		if (running) notice("系统进入睡眠，网络请求可能中断。唤醒后请检查会话状态。");
	};
	const onResume = () => {
		suspended = false;
		update();
		// 只更新后续连接使用的系统代理，不重放任务或关闭仍有效的连接。
		void session.defaultSession.forceReloadProxyConfig().catch((error: unknown) => { if (!disposed) notice(`系统代理刷新失败: ${String(error)}`); });
		resume();
		if (running) notice("系统已唤醒。请检查任务是否中断，Desktop 不会因唤醒重新提交任务。");
	};
	powerMonitor.on("suspend", onSuspend);
	powerMonitor.on("resume", onResume);
	return {
		configure(value: boolean) { enabled = value; update(); },
		activity(value: boolean) { running = value; update(); },
		dispose() {
			disposed = true;
			update();
			powerMonitor.off("suspend", onSuspend);
			powerMonitor.off("resume", onResume);
		},
	};
}
