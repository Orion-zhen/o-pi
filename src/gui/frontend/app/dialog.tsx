import { useEffect, useId, useState } from "react";
import { Clock3, ShieldCheck } from "lucide-react";
import { ApprovalActions, Choices, type ResponseControls } from "./approval-actions.tsx";
import type { GuiDialog } from "../../shared/protocol/state.ts";
import type { Send } from "@/connection/connection.ts";
import { useGuiQuery } from "@/connection/query-context.ts";
import { useOperation } from "@/connection/use-operation.ts";
import { clean } from "@/ui/content/format.ts";
import { Feedback } from "@/ui/feedback.tsx";
import { ShellApproval } from "@/features/chat/tools/shell-approval.tsx";
import { ToolApproval } from "@/features/chat/tools/tool-approval.tsx";
import { Button } from "@/ui/button.tsx";
import { Input } from "@/ui/input.tsx";
import { Textarea } from "@/ui/textarea.tsx";
import { Dialog as DialogRoot, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/ui/dialog.tsx";

const labels: Record<GuiDialog["kind"], string> = {
	select: "请选择", toolApproval: "工具审批", shellApproval: "命令审批", confirm: "请确认", input: "需要输入", secret: "需要输入", editor: "需要输入",
};

export function Dialog({ dialog, send, restoreFocus }: { dialog: GuiDialog; send: Send; restoreFocus: () => void }) {
	const submit = (value: string | null) => send({ action: "dialog", id: dialog.id, value,
		...("stage" in dialog && "token" in dialog.stage && { token: dialog.stage.token }),
	});
	const { run: respond, pending, error } = useOperation(submit);
	const approval = dialog.kind === "shellApproval" || dialog.kind === "toolApproval";
	return <DialogRoot open onOpenChange={(open) => { if (!open) respond(null); }}>
		<DialogContent className={approval ? "approval review-panel" : "approval"} {...(approval && { "aria-describedby": undefined })} onOpenAutoFocus={event => {
				if (approval && event.target instanceof HTMLElement) { event.preventDefault(); event.target.focus(); }
			}} onPointerDownOutside={(event) => event.preventDefault()}
			onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocus(); }}>
			<DialogHeader>
				{!approval && <DialogDescription className="flex items-center gap-2"><ShieldCheck className="size-4" />{labels[dialog.kind]}</DialogDescription>}
				<DialogTitle className="dialog-title">{approval && <ShieldCheck aria-hidden="true" className="size-[1em] shrink-0" />}{clean(dialog.title)}</DialogTitle>
			</DialogHeader>
			{!approval && dialog.deadline !== null && <Deadline at={dialog.deadline} />}
			<DialogBody dialog={dialog} respond={respond} pending={pending} submit={submit} />
			<Feedback compact message={error} tone="error" />
		</DialogContent>
	</DialogRoot>;
}

function Deadline({ at, deny = false }: { at: number; deny?: boolean }) {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Clock3 className="size-4" />
		{Math.max(0, Math.ceil((at - now) / 1000))} 秒{deny ? "后超时拒绝" : "后结束"}
	</p>;
}

function DialogBody({ dialog, respond, pending, submit }: { dialog: GuiDialog; submit(value: string | null): Promise<void> } & ResponseControls) {
	const query = useGuiQuery();
	switch (dialog.kind) {
		case "shellApproval": case "toolApproval": return <>
			{dialog.kind === "shellApproval" ? <ShellApproval approval={dialog.approval} reveal={() => query({ query: "approvalDetails", id: dialog.id })} /> : <ToolApproval {...dialog} />}
			<ApprovalActions deadline={dialog.deadline !== null && <Deadline at={dialog.deadline} deny={dialog.stage.kind === "choose"} />} dialog={dialog} respond={respond} pending={pending} submit={submit} />
		</>;
		case "select": return <><Choices options={dialog.options} respond={respond} pending={pending} />
			<div className="dialog-actions"><Button variant="outline" disabled={pending} onClick={() => respond(null)}>取消</Button></div></>;
		case "confirm": return <><pre>{clean(dialog.message)}</pre><div className="dialog-actions">
			<Button variant="outline" disabled={pending} onClick={() => respond(null)}>取消</Button>
			<Button disabled={pending} onClick={() => respond("yes")}>确认</Button>
		</div></>;
		case "input": case "secret": case "editor": return <DialogInput dialog={dialog} respond={respond} pending={pending} />;
	}
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
