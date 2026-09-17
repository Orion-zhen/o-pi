import { useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { ListItem, Reveal } from "./components/animated";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
import { ArrowUp, CornerUpRight, History, ListEnd, Paperclip, Square, Trash2, Wrench, X } from "lucide-react";
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
import type { GuiAction, GuiSnapshot } from "../contract.ts";
import type { GuiView } from "./use-gui.ts";
import { ModelControls } from "./model-controls.tsx";
import { ContextUsage } from "./context-usage.tsx";
import { useSuggestionNavigation } from "./use-suggestion-navigation.ts";
import { useComposerQueries } from "./use-composer-queries.ts";

type ImageAttachment = Extract<GuiAction, { action: "prompt" }>["images"][number] & { id: number };
export function Composer({ gui, snapshot, onSubmit }: { gui: GuiView; snapshot: GuiSnapshot; onSubmit: () => void }) {
	const {
		connected,
		query,
		draft,
		setDraft,
		send,
		running,
		editor,
		setError,
	} = gui;
	const suggestions = useSuggestionNavigation(editor);
	const { argumentChoices, fileChoices, completeFiles, clearFiles } = useComposerQueries({
		draft, sessionId: snapshot.sessionId, connected, send, query, setError,
	});
	const upload = useRef<HTMLInputElement>(null);
	const attachmentId = useRef(0);
	const [images, setImages] = useState<ImageAttachment[]>([]);
	const hasContent = Boolean(draft.trim() || images.length);
	const queuedCount = snapshot.queue.steering.length + snapshot.queue.followUp.length;
	const stopping = running && !hasContent;
	const [behavior, setBehavior] = useState<"steer" | "followUp">("steer");
	const steering = behavior === "steer";
	const BehaviorIcon = steering ? CornerUpRight : ListEnd;
	const behaviorLabel = steering ? "Steering" : "Follow-up";
	const submit = () => {
		if (!hasContent || !gui.canSubmit) return;
		const text = draft;
		const attachments = images;
		setDraft("");
		setImages([]);
		clearFiles();
		onSubmit();
		void send({ action: "prompt", text, images: attachments.map(({ data, mimeType }) => ({ data, mimeType })), behavior }).then((ok) => {
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
					additions.push({ id: attachmentId.current++, data, mimeType });
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
		argumentChoices.length === 0 && /^\/\S*$/.test(draft)
			? snapshot.commands.filter((command) => `/${command.name}`.startsWith(draft))
			: [];
	return (
		<footer className="composer">
			<div className="composer-card">
				<AnimatePresence initial={false}>
				{queuedCount > 0 && (
					<Reveal key="queue"><Collapsible defaultOpen className="queue">
						<div className="queue-heading">
							<CollapsibleTrigger>待发送消息 ({queuedCount})</CollapsibleTrigger>
							<IconButton
								label="清空队列"
								onClick={(event) => {
									event.preventDefault();
									void send({ action: "clearQueue" });
								}}
							>
								<Trash2 />
							</IconButton>
						</div>
						<CollapsibleContent>
							<ol className="queue-list" aria-label="待发送消息">
								{(["steering", "followUp"] as const).flatMap((kind) => snapshot.queue[kind].map((text, index) => (
									<li key={`${kind}-${index}`}>
										<div className="queue-item">
											<span className="queue-kind">{kind === "steering" ? "引导" : "跟进"}</span>
											<span className="queue-message">{text || "（无文本）"}</span>
										</div>
									</li>
								)))}
							</ol>
						</CollapsibleContent>
					</Collapsible></Reveal>
				)}
				{images.length > 0 && (
					<Reveal key="images"><ul className="image-previews">
						<AnimatePresence initial={false}>
						{images.map((image, index) => (
							<ListItem className="image-preview" key={image.id}>
								<img src={`data:${image.mimeType};base64,${image.data}`} alt="待发送图片" />
								<IconButton
									label={`移除附件 ${index + 1}`}
									size="icon-sm"
									onClick={() => setImages((images) => images.filter((current) => current.id !== image.id))}
								>
									<X />
								</IconButton>
							</ListItem>
						))}
						</AnimatePresence>
					</ul></Reveal>
				)}
				</AnimatePresence>
				<AnimatePresence initial={false}>
				{choices.length + argumentChoices.length + fileChoices.length > 0 && <Reveal>
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
									clearFiles();
									editor.current?.focus();
								}}
							>
								<span className="suggestion-label">{file}</span>
							</Button>
						</li>
					))}
				</ul>
				</Reveal>}
				</AnimatePresence>
				<Textarea
					className="message-editor"
					ref={editor}
					aria-label="消息"
					placeholder="描述你的任务，或输入 / 命令、@ 引用文件…"
					rows={1}
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
						const enterSends = gui.guiConfig?.state === "ready" && gui.guiConfig.value.sendShortcut === "enter";
						if (event.key === "Enter" && !event.shiftKey && !event.altKey && ((event.ctrlKey || event.metaKey) || enterSends)) {
							event.preventDefault();
							submit();
						}
						if (event.key === "Tab") {
							const match = /@([^\s]*)$/.exec(draft);
							if (match) {
								event.preventDefault();
								void completeFiles(match[1] ?? "");
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
						<Button
							variant="ghost"
							size="sm"
							className="tool-count"
							aria-label={`工具：已启用 ${snapshot.tools.filter((tool) => tool.enabled).length} 个`}
							disabled={!gui.canSubmit}
							onClick={() => gui.setPanel({ kind: "tools" })}
						>
							<Wrench />{snapshot.tools.filter((tool) => tool.enabled).length}
						</Button>
						<IconButton
							label={`当前：${behaviorLabel}（${steering ? "引导" : "跟进"}），点击切换为 ${steering ? "Follow-up" : "Steering"}`}
							size="sm"
							className="message-behavior"
							onClick={() => setBehavior((current) => current === "steer" ? "followUp" : "steer")}
						>
							<BehaviorIcon /><span className="message-behavior-label">{behaviorLabel}</span>
						</IconButton>
					</div>
					<div className="composer-controls">
						<ModelControls snapshot={snapshot} send={send} disabled={!gui.canChangeSession} openManager={() => gui.setPanel({ kind: "model" })} />
						<ContextUsage snapshot={snapshot} />
						<IconButton
							label={stopping ? "停止" : "发送"}
							variant="default"
							className="send-button"
							onClick={stopping ? () => void send({ action: "abort" }) : submit}
							disabled={!connected || (!stopping && (!gui.canSubmit || !hasContent))}
						>
							{stopping ? <Square fill="currentColor" /> : running ? <BehaviorIcon /> : <ArrowUp />}
						</IconButton>
					</div>
				</div>
			</div>
		</footer>
	);
}
