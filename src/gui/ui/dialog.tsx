import { useEffect, useId, useState } from "react";
import { Clock3, ShieldCheck } from "lucide-react";
import type { GuiDialog } from "../contract.ts";
import type { Send } from "./connection.ts";
import { clean } from "./content.tsx";
import { BashApproval } from "./bash-approval.tsx";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import {
	Dialog as DialogRoot,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "./components/ui/dialog";


export function Dialog({ dialog, send, restoreFocus }: { dialog: GuiDialog; send: Send; restoreFocus: () => void }) {
	const formId = useId();
	const [value, setValue] = useState(dialog.initial);
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (dialog.deadline === null) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [dialog.deadline]);
	const respond = (value: string | null) => {
		void send({ action: "dialog", id: dialog.id, value });
	};
	return (
		<DialogRoot
			open
			onOpenChange={(open) => {
				if (!open) respond(null);
			}}
		>
			<DialogContent
				className="approval"
				onPointerDownOutside={(event) => event.preventDefault()}
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					restoreFocus();
				}}
			>
				<DialogHeader>
					<DialogDescription className="flex items-center gap-2">
						<ShieldCheck className="size-4" />
						{dialog.kind === "select" ? "请选择" : dialog.kind === "confirm" ? "请确认" : "需要输入"}
					</DialogDescription>
					<DialogTitle className="dialog-title">{clean(dialog.title)}</DialogTitle>
				</DialogHeader>
				{dialog.bash && <BashApproval approval={dialog.bash} />}
				{dialog.message && dialog.kind !== "input" && dialog.kind !== "secret" && <pre>{clean(dialog.message)}</pre>}
				{dialog.deadline !== null && (
					<p className="flex items-center gap-2 text-sm text-muted-foreground">
						<Clock3 className="size-4" />
						剩余 {Math.max(0, Math.ceil((dialog.deadline - now) / 1000))} 秒
					</p>
				)}
				{dialog.kind === "select" ? (
					<div className="choices">
						{dialog.options.map((option) => (
							<Button variant="outline" key={option} onClick={() => respond(option)}>
								{clean(option)}
							</Button>
						))}
					</div>
				) : dialog.kind !== "confirm" ? (
					<form
						id={formId}
						className="dialog-form"
						onSubmit={(event) => {
							event.preventDefault();
							respond(value);
						}}
					>
						{dialog.kind === "editor" ? (
							<Textarea
								aria-label="输入内容"
								autoFocus
								rows={10}
								value={value}
								onChange={(event) => setValue(event.target.value)}
							/>
						) : (
							<Input
								aria-label="输入内容"
								autoFocus
								autoComplete="off"
								type={dialog.kind === "secret" ? "password" : "text"}
								placeholder={clean(dialog.message)}
								value={value}
								onChange={(event) => setValue(event.target.value)}
							/>
						)}
					</form>
				) : null}
				{(!dialog.bash || dialog.kind !== "select") && (
					<div className="dialog-actions">
						{!dialog.bash && <Button variant="outline" onClick={() => respond(null)}>取消</Button>}
						{dialog.kind === "confirm" ? (
							<Button onClick={() => respond("yes")}>确认</Button>
						) : dialog.kind !== "select" ? (
							<Button type="submit" form={formId}>提交</Button>
						) : null}
					</div>
				)}
			</DialogContent>
		</DialogRoot>
	);
}
