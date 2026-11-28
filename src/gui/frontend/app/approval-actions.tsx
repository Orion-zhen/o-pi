import { useId, useState, type ReactNode } from "react";
import { ShieldX } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { ApprovalStatus, ChoiceButton } from "./approval-review.tsx";
import type { ApprovalChoice } from "../../../harness/approval/runtime/interaction.ts";
import type { GuiApprovalContent, GuiDialogOption, GuiSudoStage } from "../../shared/protocol/state.ts";
import { useOperation } from "@/connection/use-operation.ts";
import { Button } from "@/ui/button.tsx";
import { clean } from "@/ui/content/format.ts";
import { Feedback } from "@/ui/feedback.tsx";
import { Input } from "@/ui/input.tsx";
import { Fade } from "@/ui/motion/animated.tsx";
import { settle } from "@/ui/motion/transitions.ts";
import { Textarea } from "@/ui/textarea.tsx";

export type ResponseControls = { respond: (value: string | null) => void; pending: boolean };

export function Choices({ options, respond, pending }: { options: readonly GuiDialogOption[] } & ResponseControls) {
	return <div className="choices">{options.map(({ label, value }) =>
		<Button variant="outline" key={value} disabled={pending} onClick={() => respond(value)}>{clean(label)}</Button>,
	)}</div>;
}

export function ApprovalActions({ dialog, respond, pending, submit, deadline }: ResponseControls & { dialog: GuiApprovalContent; submit(value: string | null): Promise<void>; deadline: ReactNode }) {
	const { stage } = dialog;
	const review = stage.kind === "choose" ? stage.review : undefined;
	let actions: ReactNode;
	if (stage.kind === "instruction") actions = <Fade key="instruction"><InstructionForm respond={respond} pending={pending} /></Fade>;
	else if (stage.kind === "prompting" || stage.kind === "submitted") actions = <Fade key="password">
		<SudoPasswordForm key={stage.kind === "prompting" ? stage.token : stage.kind} prompt={stage} submit={submit} />
	</Fade>;
	else {
		const button = (value: ApprovalChoice) => {
			const option = dialog.options.find(option => option.value === value);
			return option && <ChoiceButton option={option} review={review} respond={respond} pending={pending || stage.kind === "waiting"} />;
		};
		actions = <Fade key="choices" className="approval-choices">
			<div className="approval-choice-group">{button("Deny with instruction")}{button("Deny")}</div>
			<div className="approval-choice-group">{button("Allow for session")}{button("Allow once")}</div>
		</Fade>;
	}
	return <motion.footer className="approval-footer" layout="size" transition={settle}>
		<ApprovalStatus review={review} deadline={deadline} />
		<div className="relative"><AnimatePresence initial={false} mode="popLayout">{actions}</AnimatePresence></div>
	</motion.footer>;
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
				{retry && <Fade><p id={`${id}-error`} role="alert" className="pt-2 text-sm text-destructive">认证未通过，请重新输入。</p></Fade>}
			</div>
		</div>
		<Feedback compact message={error} tone="error" />
		<div className="dialog-actions"><Button type="reset" variant="outline" disabled={disabled} onClick={() => run()}>取消</Button>
			<Button type="submit" disabled={disabled}>验证并执行</Button></div>
	</form>;
}
