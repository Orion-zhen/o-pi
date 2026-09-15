import { useState } from "react";
import type { GuiAction } from "../contract.ts";
import type { GuiView } from "./use-gui.ts";
import { ModelControls } from "./panels.tsx";
import { pretty } from "./content.tsx";

type ImageAttachment = Extract<GuiAction, { action: "prompt" }>["images"][number];
export function Composer({ gui, onSubmit }: { gui: GuiView; onSubmit: () => void }) {
	const {
		snapshot,
		status,
		draft,
		setDraft,
		send,
		running,
		editor,
		fileChoices,
		setFileChoices,
		completions,
		setError,
	} = gui;
	const [images, setImages] = useState<ImageAttachment[]>([]);
	const [behavior, setBehavior] = useState<"steer" | "followUp">("followUp");
	const submit = () => {
		if ((!draft.trim() && images.length === 0) || !snapshot || status !== "已连接") return;
		const text = draft;
		const attachments = images;
		setDraft("");
		setImages([]);
		setFileChoices([]);
		onSubmit();
		void send({ action: "prompt", text, images: attachments, behavior }).then((ok) => {
			if (!ok) {
				setDraft((current) => current || text);
				setImages((current) => (current.length ? current : attachments));
			}
		});
	};
	const attach = async (files: File[]) => {
		try {
			const additions: ImageAttachment[] = [];
			const texts: string[] = [];
			for (const file of files) {
				if (file.size > 3_000_000) throw new Error("单个上传附件暂限 3 MB。较大文件可通过 @路径 引用后端文件。");
				if (/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
					const data = await new Promise<string>((resolve, reject) => {
						const reader = new FileReader();
						reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
						reader.onerror = () => reject(reader.error);
						reader.readAsDataURL(file);
					});
					const mimeType =
						file.type === "image/jpeg"
							? "image/jpeg"
							: file.type === "image/webp"
								? "image/webp"
								: file.type === "image/gif"
									? "image/gif"
									: "image/png";
					additions.push({ data, mimeType });
				} else {
					const bytes = new Uint8Array(await file.arrayBuffer());
					if (bytes.includes(0) || file.type === "application/pdf")
						throw new Error("二进制附件请通过 @路径 引用后端文件。");
					const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
					texts.push(`<file path=${JSON.stringify(file.name)}>\n${content}\n</file>`);
				}
			}
			if (images.length + additions.length > 8) throw new Error("最多上传 8 张图片。");
			setImages((current) => [...current, ...additions]);
			if (texts.length) setDraft((text) => [text, ...texts].join("\n\n"));
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		}
	};
	const choices =
		draft.startsWith("/") && !draft.includes(" ")
			? (snapshot?.commands.filter((command) => `/${command.name}`.startsWith(draft)).slice(0, 10) ?? [])
			: [];
	return (
		<footer className="composer">
			{snapshot && <ModelControls snapshot={snapshot} send={send} />}
			{snapshot && snapshot.queue.steering.length + snapshot.queue.followUp.length > 0 && (
				<details open className="queue">
					<summary>
						待发送消息 <button onClick={() => void send({ action: "clearQueue" })}>清空队列</button>
					</summary>
					<pre>{pretty(snapshot.queue)}</pre>
				</details>
			)}
			{images.length > 0 && (
				<div className="image-previews">
					{images.map((image, index) => (
						<button
							key={index}
							aria-label="移除附件"
							onClick={() => setImages((images) => images.filter((_, current) => current !== index))}
						>
							<img src={`data:${image.mimeType};base64,${image.data}`} alt="待发送图片" />
							移除
						</button>
					))}
				</div>
			)}
			<div className="suggestions">
				{choices.map((choice) => (
					<button
						key={choice.name}
						onClick={() => {
							setDraft(`/${choice.name} `);
							editor.current?.focus();
						}}
					>
						{choice.name}
					</button>
				))}
				{completions?.text === draft &&
					completions.items.map((item) => (
						<button key={item.value} onClick={() => setDraft(`${draft.slice(0, draft.indexOf(" ") + 1)}${item.value}`)}>
							{item.label}
						</button>
					))}
				{fileChoices.map((file) => (
					<button
						key={file}
						onClick={() => {
							setDraft((text) => text.replace(/@[^\s]*$/, () => `@"${file}" `));
							setFileChoices([]);
						}}
					>
						{file}
					</button>
				))}
			</div>
			<textarea
				ref={editor}
				aria-label="消息"
				placeholder="输入任务、/命令、!Shell 或 @文件路径"
				rows={3}
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
				onPaste={(event) => {
					const files = [...event.clipboardData.files];
					if (files.length) {
						event.preventDefault();
						void attach(files);
					}
				}}
				onKeyDown={(event) => {
					if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing) {
						event.preventDefault();
						submit();
					}
					if (event.key === "Tab") {
						const match = /@([^\s]*)$/.exec(draft);
						if (match) {
							event.preventDefault();
							void send({ action: "files", prefix: match[1] ?? "" });
						}
					}
				}}
			/>
			<div className="toolbar">
				{snapshot && (
					<select
						aria-label="输入历史"
						value=""
						onChange={(event) => {
							setDraft(event.target.value);
							editor.current?.focus();
						}}
					>
						<option value="">输入历史</option>
						{[...snapshot.history].reverse().map((text, index) => (
							<option key={index} value={text}>
								{text.slice(0, 80)}
							</option>
						))}
					</select>
				)}
				<label className="file-button">
					附件
					<input
						type="file"
						multiple
						onChange={(event) => {
							void attach([...(event.target.files ?? [])]);
							event.target.value = "";
						}}
					/>
				</label>
				<select
					aria-label="排队方式"
					value={behavior}
					onChange={(event) => setBehavior(event.target.value === "steer" ? "steer" : "followUp")}
				>
					<option value="followUp">Follow-up</option>
					<option value="steer">Steer</option>
				</select>
				<button onClick={() => gui.command("/compact")}>压缩</button>
				<span className="spacer" />
				{running && (
					<button className="danger" onClick={() => void send({ action: "abort" })}>
						停止
					</button>
				)}
				<button className="primary" onClick={submit} disabled={!snapshot || status !== "已连接" || snapshot.busy}>
					{running ? "加入队列" : "发送"}
				</button>
			</div>
			{snapshot && (
				<div className="metrics">
					<span>
						{snapshot.context?.tokens ?? 0} / {snapshot.context?.contextWindow ?? snapshot.model?.contextWindow ?? 0}{" "}
						context
					</span>
					<span>
						{snapshot.tools.filter((tool) => tool.enabled).length} tools · {snapshot.stats.tokens.total} tokens · $
						{snapshot.stats.cost.toFixed(4)} est
					</span>
					<span>Ctrl/⌘ + Enter 发送</span>
				</div>
			)}
		</footer>
	);
}
