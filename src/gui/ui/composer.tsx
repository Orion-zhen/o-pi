import { useRef, useState } from "react";
import { ArrowUp, History, Paperclip, Square, Trash2, Wrench, X } from "lucide-react";
import { IconButton } from "./components/icon-button";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import type { GuiAction } from "../contract.ts";
import type { GuiView } from "./use-gui.ts";
import { ModelControls } from "./model-controls.tsx";
import { pretty } from "./content.tsx";
import { ContextUsage } from "./context-usage.tsx";
import { useSuggestionNavigation } from "./use-suggestion-navigation.ts";

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
	const suggestions = useSuggestionNavigation(editor);
	const upload = useRef<HTMLInputElement>(null);
	const [images, setImages] = useState<ImageAttachment[]>([]);
	const hasContent = Boolean(draft.trim() || images.length);
	const stopping = running && !hasContent;
	const connected = Boolean(snapshot && status === "已连接");
	const submit = () => {
		if (!hasContent || !connected || snapshot?.busy) return;
		const text = draft;
		const attachments = images;
		setDraft("");
		setImages([]);
		setFileChoices([]);
		onSubmit();
		void send({ action: "prompt", text, images: attachments, behavior: "followUp" }).then((ok) => {
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
	const argumentChoices = completions?.text === draft ? completions.items : [];
	const choices =
		argumentChoices.length === 0 && /^\/\S*$/.test(draft)
			? (snapshot?.commands.filter((command) => `/${command.name}`.startsWith(draft)) ?? [])
			: [];
	return (
		<footer className="composer">
			<div className="composer-card">
				{snapshot && snapshot.queue.steering.length + snapshot.queue.followUp.length > 0 && (
					<details open className="queue">
						<summary>
							待发送消息{" "}
							<IconButton
								label="清空队列"
								onClick={(event) => {
									event.preventDefault();
									void send({ action: "clearQueue" });
								}}
							>
								<Trash2 />
							</IconButton>
						</summary>
						<pre>{pretty(snapshot.queue)}</pre>
					</details>
				)}
				{images.length > 0 && (
					<div className="image-previews">
						{images.map((image, index) => (
							<div className="image-preview" key={index}>
								<img src={`data:${image.mimeType};base64,${image.data}`} alt="待发送图片" />
								<IconButton
									label={`移除附件 ${index + 1}`}
									size="icon-sm"
									onClick={() => setImages((images) => images.filter((_, current) => current !== index))}
								>
									<X />
								</IconButton>
							</div>
						))}
					</div>
				)}
				<ul {...suggestions} className="suggestions" aria-label="输入建议">
					{choices.map((choice) => (
						<li key={choice.name}>
							<Button
								variant="ghost"
								tabIndex={-1}
								className="suggestion-command"
								title={`/${choice.name}: ${choice.description}`}
								onClick={() => {
									setDraft(`/${choice.name} `);
									editor.current?.focus();
								}}
							>
								<span className="suggestion-label">/{choice.name}</span>
								<span className="suggestion-description">{choice.description}</span>
							</Button>
						</li>
					))}
					{argumentChoices.map((item) => (
						<li key={item.value}>
							<Button
								variant="ghost"
								tabIndex={-1}
								className={item.description ? "suggestion-command" : undefined}
								title={item.description ? `${item.label}: ${item.description}` : item.label}
								onClick={() => {
									setDraft(`${draft.replace(/\s.*$/s, "")} ${item.value}`);
									editor.current?.focus();
								}}
							>
								<span className="suggestion-label">{item.label}</span>
								{item.description && <span className="suggestion-description">{item.description}</span>}
							</Button>
						</li>
					))}
					{fileChoices.map((file) => (
						<li key={file}>
							<Button
								variant="ghost"
								tabIndex={-1}
								title={file}
								onClick={() => {
									setDraft((text) => text.replace(/@[^\s]*$/, () => `@"${file}" `));
									setFileChoices([]);
									editor.current?.focus();
								}}
							>
								<span className="suggestion-label">{file}</span>
							</Button>
						</li>
					))}
				</ul>
				<Textarea
					className="message-editor"
					ref={editor}
					aria-label="消息"
					placeholder="描述你的任务，或输入 / 命令、@ 引用文件…"
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
						if (event.nativeEvent.isComposing || suggestions.onKeyDown(event)) return;
						if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
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
				<div className="composer-bottom">
					<div className="composer-actions">
						<IconButton label="附件" onClick={() => upload.current?.click()}>
							<Paperclip />
						</IconButton>
						<input
							ref={upload}
							className="hidden"
							aria-label="上传附件"
							type="file"
							multiple
							onChange={(event) => {
								void attach([...(event.target.files ?? [])]);
								event.target.value = "";
							}}
						/>
						{snapshot && (
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<IconButton label="输入历史" disabled={!snapshot.history.length}>
										<History />
									</IconButton>
								</DropdownMenuTrigger>
								<DropdownMenuContent
									align="end"
									className="history-menu"
									onCloseAutoFocus={(event) => {
										event.preventDefault();
										editor.current?.focus();
									}}
								>
									<DropdownMenuLabel>输入历史</DropdownMenuLabel>
									{[...snapshot.history].reverse().map((text, index) => (
										<DropdownMenuItem key={index} onSelect={() => setDraft(text)}>
											{text.slice(0, 120)}
										</DropdownMenuItem>
									))}
								</DropdownMenuContent>
							</DropdownMenu>
						)}
						{snapshot && <Button
							variant="ghost"
							size="sm"
							className="tool-count"
							aria-label={`工具：已启用 ${snapshot.tools.filter((tool) => tool.enabled).length} 个`}
							disabled={!connected || snapshot.busy}
							onClick={() => void send({ action: "view", view: "tools" })}
						>
							<Wrench />{snapshot.tools.filter((tool) => tool.enabled).length}
						</Button>}
					</div>
					<div className="composer-controls">
						{snapshot && <ModelControls snapshot={snapshot} send={send} />}
						{snapshot && <ContextUsage snapshot={snapshot} />}
						<IconButton
							label={stopping ? "停止" : "发送"}
							variant="default"
							className="send-button"
							onClick={stopping ? () => void send({ action: "abort" }) : submit}
							disabled={!connected || (!stopping && (snapshot?.busy || !hasContent))}
						>
							{stopping ? <Square fill="currentColor" /> : <ArrowUp />}
						</IconButton>
					</div>
				</div>
			</div>
		</footer>
	);
}
