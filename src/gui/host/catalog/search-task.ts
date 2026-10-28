import { randomUUID } from "node:crypto";
import type { SessionSearchPage } from "../../shared/session-search.ts";
import type { SearchBatch, SessionSearch } from "./session-search.ts";

interface Task {
	id: string;
	controller: AbortController;
	iterator: AsyncGenerator<SearchBatch, void>;
	pending: boolean;
	timer: ReturnType<typeof setTimeout> | undefined;
}

/** 每个客户端只保留当前搜索，旧请求不能操作替换后的任务。 */
export class SessionSearchTask {
	private task: Task | undefined;

	constructor(private search: SessionSearch, private reportError: (error: unknown) => void) {}

	async start(cwd: string, text: string): Promise<SessionSearchPage> {
		const closing = this.close();
		const id = randomUUID();
		const controller = new AbortController();
		this.task = { id, controller, iterator: this.search.search(cwd, text, controller.signal), pending: false, timer: undefined };
		await closing;
		controller.signal.throwIfAborted();
		return this.next(id);
	}

	async next(id: string): Promise<SessionSearchPage> {
		const task = this.task;
		if (!task || task.id !== id) throw new Error("搜索任务已结束，请重新搜索。");
		if (task.pending) throw new Error("上一批搜索结果尚未返回。");
		task.pending = true;
		clearTimeout(task.timer);
		try {
			const result = await task.iterator.next();
			task.controller.signal.throwIfAborted();
			if (result.done) throw new Error("搜索任务已结束。");
			const done = result.value.scanned === result.value.total;
			if (done) await this.cancel(id);
			else {
				// HTTP 响应丢失或界面放弃拉取后，释放无人消费的扫描游标。
				task.timer = setTimeout(() => { void this.cancel(id).catch(this.reportError); }, 60_000);
				task.timer.unref();
			}
			return { id, ...result.value, done };
		} catch (error) {
			await this.cancel(id);
			throw error;
		} finally { task.pending = false; }
	}

	async cancel(id: string): Promise<void> {
		if (this.task?.id === id) await this.close();
	}

	async close(): Promise<void> {
		const task = this.task;
		if (!task) return;
		this.task = undefined;
		clearTimeout(task.timer);
		task.controller.abort();
		await task.iterator.return();
	}
}
