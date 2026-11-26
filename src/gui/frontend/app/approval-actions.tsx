import { useId, useState } from "react";
import { ShieldX } from "lucide-react";
import { AnimatePresence } from "motion/react";
import type { GuiApprovalContent, GuiDialogOption, GuiSudoStage } from "../../shared/protocol/state.ts";
import { useOperation } from "@/connection/use-operation.ts";
import { Button } from "@/ui/button.tsx";
import { clean } from "@/ui/content/format.ts";
import { Feedback } from "@/ui/feedback.tsx";
import { Input } from "@/ui/input.tsx";
import { Fade, Reveal } from "@/ui/motion/animated.tsx";
import { Textarea } from "@/ui/textarea.tsx";

export type ResponseControls = { respond: (value: string | null) => void; pending: boolean };

export function Choices({ options, respond, pending }: { options: readonly GuiDialogOption[] } & ResponseControls) {
	return <div className="choices">{options.map(({ label, value }) =>
		<Button variant="outline" key={value} disabled={pending} onClick={() => respond(value)}>{clean(label)}</Button>,
	)}</div>;
}

export function ApprovalActions({ dialog, respond, pending, submit }: ResponseControls & { dialog: GuiApprovalContent; submit(value: string | null): Promise<void> }) {
	const { stage } = dialog;
	const editing = stage.kind !== "choose" && stage.kind !== "waiting";
	return <div className="grid shrink-0 border-t border-(--divider) pt-4">
		<Fade className="col-start-1 row-start-1 grid content-start gap-3" initial={false} animate={{ opacity: editing ? 0 : 1 }} inert={editing} aria-hidden={editing}>
			<Choices options={dialog.options} respond={respond} pending={pending || stage.kind !== "choose"} />
			{dialog.kind === "toolApproval" && <div className="dialog-actions"><Button variant="outline" disabled={pending || editing} onClick={() => respond(null)}>取消</Button></div>}
		</Fade>
		<AnimatePresence initial={false}>
			{stage.kind === "instruction" && <Reveal key="instruction" className="col-start-1 row-start-1 self-center"><InstructionForm respond={respond} pending={pending} /></Reveal>}
			{(stage.kind === "prompting" || stage.kind === "submitted") && <Fade key="password" className="col-start-1 row-start-1 grid">
				<SudoPasswordForm key={stage.kind === "prompting" ? stage.token : stage.kind} prompt={stage} submit={submit} />
			</Fade>}
		</AnimatePresence>
	</div>;
}

function InstructionForm({ respond, pending }: ResponseControls) {
	const id = useId();
	const [value, setValue] = useState("");
	return <form className="grid gap-3 p-1" onSubmit={(event) => { event.preventDefault(); respond(value); }}>
		<div className="flex flex-wrap items-baseline justify-between gap-x-3">
			<label htmlFor={id} className="font-medium">给 Agent 的说明</label>
			<span className="inline-flex items-center gap-1 text-sm text-muted-foreground"><ShieldX className="size-4" />已拒绝</span>
		</div>
		<Textarea id={id} autoFocus rows={3} className="field-sizing-fixed resize-none" placeholder="说明拒绝原因，或告诉代理下一步怎么做。"
			readOnly={pending} value={value} onChange={(event) => setValue(event.target.value)} />
		<div className="dialog-actions"><Button type="button" variant="outline" disabled={pending} onClick={() => respond(null)}>跳过说明</Button>
			<Button type="submit" disabled={pending || !value.trim()}>发送说明</Button></div>
	</form>;
}

function SudoPasswordForm({ prompt, submit }: { prompt: Exclude<GuiSudoStage, { kind: "waiting" }>; submit(value: string | null): Promise<void> }) {
	const id = useId();
	const { run, pending, error } = useOperation((form?: HTMLFormElement) => {
		if (!form) return submit(null);
		const value = new FormData(form).get("password") as string;
		form.reset();
		return submit(value);
	});
	const disabled = pending || prompt.kind === "submitted";
	const retry = prompt.kind === "prompting" && prompt.retry;
	return <form className="grid content-center gap-3" onSubmit={(event) => { event.preventDefault(); run(event.currentTarget); }}>
		<div className="grid gap-2"><div className="flex flex-wrap items-baseline justify-between gap-x-3">
			<label htmlFor={id}>密码</label><span className="text-sm text-muted-foreground">验证 <code>{clean(prompt.account)}</code></span>
		</div>
			<div><Input name="password" id={id} type="password" autoFocus required autoComplete="off" disabled={disabled} aria-invalid={retry} aria-describedby={retry ? `${id}-error` : undefined} />
				{retry && <Reveal><p id={`${id}-error`} role="alert" className="pt-2 text-sm text-destructive">认证未通过，请重新输入。</p></Reveal>}
			</div>
		</div>
		<Feedback compact message={error} tone="error" />
		<div className="dialog-actions"><Button type="reset" variant="outline" disabled={disabled} onClick={() => run()}>取消</Button>
			<Button type="submit" disabled={disabled}>验证并执行</Button></div>
	</form>;
}
