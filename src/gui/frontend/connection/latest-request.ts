export type Remote<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "error"; message: string };

/** 一个读取槽只发布最后一次请求。取消停止发布，任务的资源释放仍由任务自身负责。 */
export class LatestRequest {
	private controller: AbortController | undefined;
	cancel(): void { this.controller?.abort(); this.controller = undefined; }
	async run<T>(task: (publish: (value: T) => void, signal: AbortSignal) => Promise<T>, receive: (result: Exclude<Remote<T>, { state: "loading" }>) => void): Promise<void> {
		this.cancel();
		const controller = new AbortController();
		this.controller = controller;
		const publish = (value: T) => { if (!controller.signal.aborted) receive({ state: "ready", value }); };
		let value: T;
		try { value = await task(publish, controller.signal); }
		catch (error) {
			if (!controller.signal.aborted) receive({ state: "error", message: error instanceof Error ? error.message : String(error) });
			return;
		}
		publish(value);
	}
}
