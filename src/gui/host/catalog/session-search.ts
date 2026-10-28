import type { SessionSearchHit, SessionSearchPage, SearchExcerpt } from "../../shared/session-search.ts";
import { compileSearch, SearchMatcher } from "./search-matcher.ts";
import { readSessionFile } from "./session-reader.ts";
import type { GuiSessionCatalog } from "./sessions.ts";

export type SearchBatch = Omit<SessionSearchPage, "id" | "done">;
const concurrency = 4;
const batchSize = 32;

async function searchFile(file: string, patterns: ReturnType<typeof compileSearch>, signal: AbortSignal): Promise<SessionSearchHit | undefined> {
	let matcher: SearchMatcher | undefined;
	let found = patterns.map(() => false);
	let excerpt: SearchExcerpt | undefined;
	let hit: SessionSearchHit | undefined;
	try {
		await readSessionFile(file, {
			start() { found = patterns.map(() => false); excerpt = undefined; },
			textStart(role) { matcher = !role || role === "user" || role === "assistant" ? new SearchMatcher(patterns) : undefined; },
			text(chunk) { matcher?.write(chunk); },
			textEnd(type) {
				if (!matcher) return;
				const result = matcher.finish();
				if (type !== "text") return;
				for (let index = 0; index < found.length; index++) found[index] ||= matcher.found[index] === true;
				excerpt ??= result;
			},
			record(record) {
				if (record.type !== "message" || record.role !== "user" && record.role !== "assistant" || !excerpt || !found.every(Boolean)) return false;
				hit = { path: file, source: record.role, excerpt };
				return true;
			},
		}, signal);
	} catch (error) {
		// 目录快照取得后，会话可能已由另一个窗口删除。
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
	}
	return hit;
}

/** 所有客户端共享文件并发预算，查询之间不共享正文或匹配状态。 */
export class SessionSearch {
	private active = 0;
	private waiting = new Set<() => void>();
	constructor(private catalog: GuiSessionCatalog) {}

	private async read(file: string, patterns: ReturnType<typeof compileSearch>, signal: AbortSignal): Promise<SessionSearchHit | undefined> {
		signal.throwIfAborted();
		if (this.active >= concurrency) await new Promise<void>((resolve, reject) => {
			const abort = () => { this.waiting.delete(grant); reject(signal.reason); };
			const grant = () => {
				this.waiting.delete(grant); signal.removeEventListener("abort", abort); this.active++; resolve();
			};
			this.waiting.add(grant);
			signal.addEventListener("abort", abort, { once: true });
		});
		else this.active++;
		try { signal.throwIfAborted(); return await searchFile(file, patterns, signal); }
		finally { this.active--; this.waiting.values().next().value?.(); }
	}

	async *search(cwd: string, text: string, signal: AbortSignal): AsyncGenerator<SearchBatch, void> {
		const patterns = compileSearch(text);
		const sessions = (this.catalog.value ?? await this.catalog.read()).filter((item) => item.cwd === cwd);
		signal.throwIfAborted();
		const remaining: string[] = [];
		let hits: SessionSearchHit[] = [];
		let scanned = 0;
		const total = sessions.length;
		for (const session of sessions) {
			signal.throwIfAborted();
			const matcher = new SearchMatcher(patterns);
			matcher.write(session.title);
			const excerpt = matcher.finish();
			if (excerpt && matcher.found.every(Boolean)) {
				hits.push({ path: session.path, source: "title", excerpt }); scanned++;
			} else remaining.push(session.path);
			if (hits.length === batchSize && scanned < total) { yield { hits, scanned, total }; hits = []; }
		}
		yield { hits, scanned, total };
		if (!remaining.length) return;
		hits = [];

		// 至多保留一批结果和四个在途文件。暂停拉取时不会继续启动扫描。
		const controller = new AbortController();
		const combined = AbortSignal.any([signal, controller.signal]);
		const pending = new Map<number, Promise<{ index: number; hit: SessionSearchHit | undefined }>>();
		const files = remaining.entries();
		const fill = () => {
			while (pending.size < concurrency) {
				const entry = files.next();
				if (entry.done) break;
				const [index, file] = entry.value;
				const task = this.read(file, patterns, combined).then((hit) => ({ index, hit }));
				// 在暂停拉取或处理其他文件期间，拒绝仍由下面的消费循环接收。
				void task.catch(() => {});
				pending.set(index, task);
			}
		};
		try {
			fill();
			let published = performance.now();
			while (pending.size) {
				combined.throwIfAborted();
				const result = await Promise.race(pending.values());
				pending.delete(result.index); scanned++;
				if (result.hit) hits.push(result.hit);
				if (scanned < total && (hits.length >= batchSize || performance.now() - published >= 50)) {
					yield { hits, scanned, total };
					hits = []; published = performance.now();
				}
				fill();
			}
			yield { hits, scanned, total };
		} finally {
			controller.abort();
			await Promise.allSettled(pending.values());
		}
	}
}
