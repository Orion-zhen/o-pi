import { useEffect, useId, useState } from "react";
import { Clock3, ShieldCheck } from "lucide-react";
import { AnimatePresence } from "motion/react";
import type { GuiDialog, GuiDialogOption, GuiSudoStage } from "../../shared/protocol/state.ts";
import type { Send } from "@/connection/connection.ts";
import { useGuiQuery } from "@/connection/query-context.ts";
import { useOperation } from "@/connection/use-operation.ts";
import { clean } from "@/ui/content/format.ts";
import { Feedback } from "@/ui/feedback.tsx";
import { Fade, Reveal } from "@/ui/motion/animated.tsx";
import { BashApproval } from "@/features/chat/tools/bash-approval.tsx";
import { Button } from "@/ui/button.tsx";
import { Input } from "@/ui/input.tsx";
import { Textarea } from "@/ui/textarea.tsx";
import { Dialog as DialogRoot, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/ui/dialog.tsx";

const labels: Record<GuiDialog["kind"], string> = {
	select: "请选择", bashApproval: "命令审批", confirm: "请确认", input: "需要输入", secret: "需要输入", editor: "需要输入",
};
type ResponseControls = { respond: (value: string | null) => void; pending: boolean };

export function Dialog({ dialog, send, restoreFocus }: { dialog: GuiDialog; send: Send; restoreFocus: () => void }) {
	const responseId = dialog.kind === "bashApproval" && dialog.sudo?.kind === "prompting" ? dialog.sudo.id : dialog.id;
	const submit = (value: string | null) => send({ action: "dialog", id: responseId, value });
	const { run: respond, pending, error } = useOperation(submit);
	return <DialogRoot open onOpenChange={(open) => { if (!open) respond(null); }}>
		<DialogContent className="approval" onPointerDownOutside={(event) => event.preventDefault()}
			onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocus(); }}>
			<DialogHeader>
				<DialogDescription className="flex items-center gap-2"><ShieldCheck className="size-4" />{labels[dialog.kind]}</DialogDescription>
				<DialogTitle className="dialog-title">{clean(dialog.title)}</DialogTitle>
			</DialogHeader>
			{dialog.deadline !== null && <Deadline at={dialog.deadline} />}
			<DialogBody dialog={dialog} respond={respond} pending={pending} submit={submit} />
			<Feedback compact message={error} tone="error" />
		</DialogContent>
	</DialogRoot>;
}

function Deadline({ at }: { at: number }) {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Clock3 className="size-4" />
		剩余 {Math.max(0, Math.ceil((at - now) / 1000))} 秒
	</p>;
}

function Choices({ options, respond, pending }: { options: readonly GuiDialogOption[] } & ResponseControls) {
	return <div className="choices">{options.map(({ label, value }) =>
		<Button variant="outline" key={value} disabled={pending} onClick={() => respond(value)}>{clean(label)}</Button>,
	)}</div>;
}

function DialogBody({ dialog, respond, pending, submit }: { dialog: GuiDialog; submit(value: string | null): Promise<void> } & ResponseControls) {
	const query = useGuiQuery();
	switch (dialog.kind) {
		case "bashApproval": {
			const prompt = dialog.sudo?.kind === "waiting" ? undefined : dialog.sudo;
			return <><BashApproval approval={dialog.approval} reveal={() => query({ query: "approvalDetails", id: dialog.id })} />
			<div className="grid">
				<Fade className="col-start-1 row-start-1" initial={false} animate={{ opacity: prompt ? 0 : 1 }} inert={Boolean(prompt)} aria-hidden={Boolean(prompt)}>
					<Choices options={dialog.options} respond={respond} pending={pending || Boolean(dialog.sudo)} />
				</Fade>
				<AnimatePresence initial={false}>
					{prompt && <Fade key="password" className="col-start-1 row-start-1 grid">
						<SudoPasswordForm key={prompt.kind === "prompting" ? prompt.id : prompt.kind} prompt={prompt} submit={submit} />
					</Fade>}
				</AnimatePresence>
			</div></>;
		}
		case "select": return <><Choices options={dialog.options} respond={respond} pending={pending} />
			<div className="dialog-actions"><Button variant="outline" disabled={pending} onClick={() => respond(null)}>取消</Button></div></>;
		case "confirm": return <><pre>{clean(dialog.message)}</pre><div className="dialog-actions">
			<Button variant="outline" disabled={pending} onClick={() => respond(null)}>取消</Button>
			<Button disabled={pending} onClick={() => respond("yes")}>确认</Button>
		</div></>;
		case "input": case "secret": case "editor": return <DialogInput dialog={dialog} respond={respond} pending={pending} />;
	}
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

function DialogInput({ dialog, respond, pending }: { dialog: Extract<GuiDialog, { kind: "input" | "secret" | "editor" }> } & ResponseControls) {
	const formId = useId();
	const [value, setValue] = useState(dialog.initial);
	return <><form id={formId} className="dialog-form" onSubmit={(event) => { event.preventDefault(); respond(value); }}>
		{dialog.kind === "editor"
			? <Textarea aria-label="输入内容" autoFocus rows={10} disabled={pending} value={value} onChange={(event) => setValue(event.target.value)} />
			: <Input aria-label="输入内容" autoFocus autoComplete="off" type={dialog.kind === "secret" ? "password" : "text"}
				placeholder={clean(dialog.placeholder)} disabled={pending} value={value} onChange={(event) => setValue(event.target.value)} />}
	</form><div className="dialog-actions">
		<Button variant="outline" disabled={pending} onClick={() => respond(null)}>取消</Button>
		<Button type="submit" form={formId} disabled={pending}>提交</Button>
	</div></>;
}
