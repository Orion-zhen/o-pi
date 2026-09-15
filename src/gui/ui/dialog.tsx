import { useEffect, useState } from "react";
import type { GuiAction, GuiDialog } from "../contract.ts";
import { clean } from "./content.tsx";
export type Send = (action: GuiAction) => Promise<boolean>;

export function Dialog({ dialog, send }: { dialog: GuiDialog; send: Send }) {
	const [value, setValue] = useState(dialog.initial);
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	const respond = (value: string | null) => {
		void send({ action: "dialog", id: dialog.id, value });
	};
	return (
		<div className="modal-backdrop">
			<section role="dialog" aria-modal="true" aria-label={dialog.title} className="modal approval">
				<h2>{dialog.kind === "select" ? "请选择" : dialog.kind === "confirm" ? "请确认" : "需要输入"}</h2>
				<pre className="dialog-title">{clean(dialog.title)}</pre>
				{dialog.message && <pre>{clean(dialog.message)}</pre>}
				{dialog.deadline !== null && <p>剩余 {Math.max(0, Math.ceil((dialog.deadline - now) / 1000))} 秒</p>}
				{dialog.kind === "select" ? (
					<div className="choices">
						{dialog.options.map((option) => (
							<button key={option} onClick={() => respond(option)}>
								{clean(option)}
							</button>
						))}
					</div>
				) : dialog.kind === "confirm" ? (
					<button onClick={() => respond("yes")}>确认</button>
				) : (
					<form
						onSubmit={(event) => {
							event.preventDefault();
							respond(value);
						}}
					>
						{dialog.kind === "editor" ? (
							<textarea
								aria-label="输入内容"
								autoFocus
								rows={10}
								value={value}
								onChange={(event) => setValue(event.target.value)}
							/>
						) : (
							<input
								aria-label="输入内容"
								autoFocus
								autoComplete="off"
								type={dialog.kind === "secret" ? "password" : "text"}
								value={value}
								onChange={(event) => setValue(event.target.value)}
							/>
						)}
						<button type="submit">提交</button>
					</form>
				)}
				<button className="secondary" onClick={() => respond(null)}>
					取消 / 拒绝
				</button>
			</section>
		</div>
	);
}
