import { useEffect, useState } from "react";
import { Clock3, ShieldCheck } from "lucide-react";
import type { GuiDialog } from "../contract.ts";
import type { Send } from "./connection.ts";
import { clean } from "./content.tsx";
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
				{dialog.message && <pre>{clean(dialog.message)}</pre>}
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
				) : dialog.kind === "confirm" ? (
					<Button onClick={() => respond("yes")}>确认</Button>
				) : (
					<form
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
								value={value}
								onChange={(event) => setValue(event.target.value)}
							/>
						)}
						<Button type="submit">提交</Button>
					</form>
				)}
				<Button variant="ghost" onClick={() => respond(null)}>
					取消 / 拒绝
				</Button>
			</DialogContent>
		</DialogRoot>
	);
}
