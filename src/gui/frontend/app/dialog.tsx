import { useEffect, useId, useState } from "react";
import { Clock3, ShieldCheck } from "lucide-react";
import type { GuiDialog, GuiDialogOption } from "../../shared/protocol/state.ts";
import type { Send } from "@/connection/connection.ts";
import { useOperation } from "@/connection/use-operation.ts";
import { clean } from "@/ui/content/format.ts";
import { Feedback } from "@/ui/feedback.tsx";
import { BashApproval } from "@/features/chat/tools/bash-approval.tsx";
import { Button } from "@/ui/button.tsx";
import { Input } from "@/ui/input.tsx";
import { Textarea } from "@/ui/textarea.tsx";
import { Dialog as DialogRoot, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/ui/dialog.tsx";

const labels: Record<GuiDialog["kind"], string> = {
	select: "请选择", bashApproval: "请选择", confirm: "请确认", input: "需要输入", secret: "需要输入", editor: "需要输入",
};
type ResponseControls = { respond: (value: string | null) => void; pending: boolean };

export function Dialog({ dialog, send, restoreFocus }: { dialog: GuiDialog; send: Send; restoreFocus: () => void }) {
	const { run: respond, pending, error } = useOperation((value: string | null) => send({ action: "dialog", id: dialog.id, value }));
	return <DialogRoot open onOpenChange={(open) => { if (!open) respond(null); }}>
		<DialogContent className="approval" onPointerDownOutside={(event) => event.preventDefault()}
			onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocus(); }}>
			<DialogHeader>
				<DialogDescription className="flex items-center gap-2"><ShieldCheck className="size-4" />{labels[dialog.kind]}</DialogDescription>
				<DialogTitle className="dialog-title">{clean(dialog.title)}</DialogTitle>
			</DialogHeader>
			{dialog.deadline !== null && <Deadline at={dialog.deadline} />}
			<DialogBody dialog={dialog} respond={respond} pending={pending} />
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

function DialogBody({ dialog, respond, pending }: { dialog: GuiDialog } & ResponseControls) {
	switch (dialog.kind) {
		case "bashApproval": return <><BashApproval approval={dialog.approval} /><Choices options={dialog.options} respond={respond} pending={pending} /></>;
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
