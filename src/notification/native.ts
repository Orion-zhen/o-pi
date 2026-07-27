const TITLE = "o-pi";
const MESSAGE = "o-pi is waiting for you.";

interface DesktopNotifier {
	notify(notification: { title: string; message: string }, callback: () => void): unknown;
}

export type DesktopNotifierLoader = () => Promise<DesktopNotifier>;
export type WaitingNotifier = () => Promise<void>;

/** 尽力发送原生通知；加载或后端错误不会向外传播。 */
export async function notifyWaiting(loadNotifier: DesktopNotifierLoader = loadNodeNotifier): Promise<void> {
	try {
		const notifier = await loadNotifier();
		notifier.notify({ title: TITLE, message: MESSAGE }, () => {});
	} catch {
		// 通知不得中断 Agent 或权限审批。
	}
}

async function loadNodeNotifier(): Promise<DesktopNotifier> {
	const { default: notifier } = await import("node-notifier");
	return {
		notify(notification, callback) {
			return notifier.notify(notification, () => callback());
		},
	};
}
