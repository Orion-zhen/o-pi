const TITLE = "o-pi";
const MESSAGE = "o-pi is waiting for you.";

/** 尽力发送原生通知，加载或后端错误不会向外传播。 */
export async function notifyWaiting(): Promise<void> {
	try {
		const { default: notifier } = await import("node-notifier");
		notifier.notify({ title: TITLE, message: MESSAGE }, () => {});
	} catch {
		// 通知不得中断 Agent 或权限审批。
	}
}
