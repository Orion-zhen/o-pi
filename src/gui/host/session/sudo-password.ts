import { randomUUID } from "node:crypto";
import { hostname, userInfo } from "node:os";
import type { Askpass } from "../../../harness/bash-runtime/askpass.ts";
import type { DialogResponse } from "../../shared/protocol/actions.ts";
import type { GuiDialog, GuiSudoStage } from "../../shared/protocol/state.ts";

type Approval = Extract<GuiDialog, { kind: "bashApproval" }>;
type Prompt = Extract<GuiSudoStage, { kind: "prompting" }>;
type State = Exclude<GuiSudoStage, Prompt> | { kind: "hidden" } | { kind: "closed" }
	| { kind: "prompting"; prompt: Prompt; finish(value?: string): void };

export interface DialogOwner { refreshDialogs(): void }

/** 审批 ID 保持不变，每次索取密码使用独立的一次性响应 ID。 */
export class SudoPassword {
	private state: State = { kind: "waiting" };
	constructor(readonly toolCallId: string, readonly owner: DialogOwner, private approval: Approval) {}

	get dialog(): Approval | undefined {
		const state = this.state;
		if (state.kind === "closed" || state.kind === "hidden") return;
		return { ...this.approval, deadline: null, stage: state.kind === "prompting" ? state.prompt : state };
	}

	readonly ask: Askpass = async (retry, signal) => {
		if (signal.aborted || this.state.kind === "closed") return;
		const prompt: Prompt = { kind: "prompting", token: randomUUID(), account: `${userInfo().username}@${hostname()}`, retry };
		return new Promise((resolve) => {
			const abort = () => finish();
			const finish = (value?: string) => {
				signal.removeEventListener("abort", abort);
				this.state = value === undefined ? { kind: "closed" } : { kind: "submitted", account: prompt.account };
				this.owner.refreshDialogs();
				resolve(value);
			};
			this.state = { kind: "prompting", prompt, finish };
			signal.addEventListener("abort", abort, { once: true });
			this.owner.refreshDialogs();
		});
	};

	respond({ id, token, value }: DialogResponse): boolean {
		if (id !== this.approval.id) return false;
		const state = this.state;
		if (state.kind === "prompting" && token === state.prompt.token) {
			if (value !== null && /[\r\n\0]/u.test(value)) throw new Error("密码不能包含换行或空字符。");
			state.finish(value ?? undefined);
			return true;
		}
		if ((state.kind !== "waiting" && state.kind !== "submitted") || token !== undefined || value !== null) return false;
		this.state = { kind: "hidden" };
		this.owner.refreshDialogs();
		return true;
	}

	close(): void {
		if (this.state.kind === "prompting") this.state.finish();
		else if (this.state.kind !== "closed") {
			this.state = { kind: "closed" };
			this.owner.refreshDialogs();
		}
	}
}
