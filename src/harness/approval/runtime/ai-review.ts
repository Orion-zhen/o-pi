export interface ReviewOpinion { decision: "allow" | "deny"; reason: string }
export type ReviewState = { kind: "running" } | { kind: "unavailable"; retryable: boolean } | ({ kind: "ready"; start: number; end: number | null } & ReviewOpinion);
export type ReviewPlan = "unavailable" | { delay: number; run(signal: AbortSignal): Promise<ReviewOpinion> };

/** 每个弹窗只有一个到期动作：结束人工等待，或采纳已经返回的建议。 */
export class DialogTiming {
	deadline: number | null = null;
	private timer?: ReturnType<typeof setTimeout>;
	private controller?: AbortController;

	constructor(private readonly timeout: number | undefined, private readonly expire: () => void) {
		this.waitForUser();
	}

	waitForUser(): void {
		this.stop();
		this.deadline = this.timeout ? Date.now() + this.timeout : null;
		if (this.timeout) this.timer = setTimeout(this.expire, this.timeout);
	}

	startReview(plan: ReviewPlan, update: (state: ReviewState) => void, apply: (opinion: ReviewOpinion) => void): void {
		if (plan === "unavailable") return update({ kind: "unavailable", retryable: false });
		this.controller = new AbortController();
		const { signal } = this.controller;
		void plan.run(signal).then(opinion => {
			const start = Date.now();
			if (signal.aborted || (this.deadline !== null && start >= this.deadline)) return;
			const end = plan.delay > 0 ? start + plan.delay : null;
			if (end !== null) {
				clearTimeout(this.timer);
				this.deadline = null;
				this.timer = setTimeout(() => apply(opinion), plan.delay);
			}
			update({ kind: "ready", ...opinion, start, end });
		}, () => { if (!signal.aborted) update({ kind: "unavailable", retryable: true }); });
		update({ kind: "running" });
	}

	stop(): void {
		this.controller?.abort();
		clearTimeout(this.timer);
	}
}
