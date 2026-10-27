import { useEffect, useId, useRef, useState } from "react";
import { resize } from "motion";
import { AnimatePresence, motion, type MotionStyle } from "motion/react";
import { fade, settle } from "@/ui/motion/transitions.ts";
import { Crossfade, ListItem, Reveal } from "@/ui/motion/animated.tsx";
import { FeedbackHighlight } from "@/ui/feedback-highlight.tsx";
import { AnimatedNumber } from "@/ui/motion/animated-number.tsx";
import { AnimatedBackground } from "@/ui/motion/animated-background.tsx";
import { Paperclip, X } from "lucide-react";
import { Blocks, CodeXml, CornerUpRight, ListEnd, Wrench } from "lucide";
import { MorphIcon } from "morphicons/react";
import { QueuedMessages } from "./queued-messages.tsx";
import { Hint } from "@/ui/tooltip.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Button } from "@/ui/button.tsx";
import { Textarea } from "@/ui/textarea.tsx";
import { InputHistory } from "./input-history.tsx";
import { SendButton } from "./send-button.tsx";
import type { Ref, RefObject } from "react";
import type { GuiPreferences } from "../../../../shared/config/preferences.ts";
import type { Send } from "@/connection/connection.ts";
import type { GuiPanel, GuiSnapshot } from "../../../../shared/protocol/state.ts";
import type { Query } from "../../../../shared/protocol/queries.ts";
import { hasContextMessages } from "../transcript/transcript-location.ts";
import type { SessionViews, SessionViewState } from "@/features/sessions/session-views.ts";
import { useSessionDraft } from "@/features/sessions/use-session-draft.ts";
import type { ImageAttachment } from "@/features/sessions/use-session-draft.ts";
import { ModelControls } from "@/features/models/model-controls.tsx";
import { modelSetup } from "@/features/models/model-setup.ts";
import { ContextUsage } from "./context-usage.tsx";
import { useSuggestionNavigation } from "./use-suggestion-navigation.ts";
import { useComposerQueries } from "./use-composer-queries.ts";
import { useFileDrop } from "./use-file-drop.ts";
import { fileReference } from "../../../../shared/file-reference.ts";
import { ImagePreviewButton } from "@/ui/media/image-preview.tsx";

// 跨组件挂载保持唯一，局域网 HTTP 不依赖 randomUUID 安全上下文。
let nextAttachmentId = 0;
const attachmentOrigin = { y: 6, rotate: -2, scale: 0.98 };

interface ComposerControls {
	connected: boolean;
	query: Query;
	send: Send;
	setError: (message: string) => void;
	canSubmit: boolean;
	setPanel: (panel: GuiPanel | undefined) => void;
	editor: RefObject<HTMLTextAreaElement | null>;
	views: SessionViews;
}
export function Composer({ ref, style, gui, view, snapshot, preferences, onSubmit, referenceVersion = 0 }: {
	ref: Ref<HTMLElement>; style: MotionStyle; gui: ComposerControls; view: SessionViewState; snapshot: GuiSnapshot;
	preferences: GuiPreferences | undefined; onSubmit: () => void; referenceVersion?: number;
}) {
	const { draft, setDraft, images, setImages, behavior, setBehavior } = useSessionDraft(view, gui.views);
	const initialReferenceVersion = useRef(referenceVersion);
	const seenImages = useRef(new Set(images.map((image) => image.id)));
	useEffect(() => { for (const image of images) seenImages.current.add(image.id); }, [images]);
	const running = snapshot.running;
	const codemode = snapshot.modelTools.includes("codemode");
	const toolCount = codemode ? snapshot.tools.filter((tool) => tool.name !== "codemode"
		&& (tool.callable || tool.exposure === "model-only" && tool.enabled)).length : snapshot.modelTools.length;
	const mcpEnabled = snapshot.tools.some((tool) => tool.mcp && tool.enabled);
	const toolIcon = codemode ? CodeXml : mcpEnabled ? Blocks : Wrench;
	const {
		connected,
		query,
		send,
		editor,
		setError,
	} = gui;
	const [inputHeight, setInputHeight] = useState<number>();
	useEffect(() => {
		if (editor.current) return resize(editor.current, (_, { height }) => setInputHeight(height));
	}, [editor]);
	const { active: activeSuggestion, ...suggestions } = useSuggestionNavigation(editor);
	const suggestionHighlight = useId();
	const { argumentChoices, fileChoices, completeFiles, clearFiles } = useComposerQueries({
		draft, sessionId: snapshot.sessionId, connected, send, query, setError,
	});
	const upload = useRef<HTMLInputElement>(null);
	const fileDrop = useFileDrop();
	const hasContent = Boolean(draft.trim() || images.length);
	const setup = modelSetup(snapshot);
	const queuedCount = snapshot.queue.steering.length + snapshot.queue.followUp.length;
	const stopping = snapshot.compacting || running && !hasContent;
	const steering = behavior === "steer";
	const behaviorIcon = steering ? CornerUpRight : ListEnd;
	const behaviorLabel = steering ? "Steering" : "Follow-up";
	const submit = () => {
		if (!hasContent || !gui.canSubmit) return;
		if (setup && !draft.startsWith("/") && !draft.startsWith("!")) {
			gui.setPanel({ kind: setup.kind });
			return;
		}
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
					additions.push({ id: nextAttachmentId++, data, mimeType });
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
	const drop = async (files: File[]) => {
		if (!window.opi) { await attach(files); return; }
		try {
			const items = await window.opi.prepareDrop(snapshot.cwd, files);
			const attachments = files.filter((_file, index) => items[index]?.kind === "attachment");
			const references: string[] = [];
			for (const item of items) {
				if (item.kind === "workspace") { await send({ action: "workspace", path: item.path }); return; }
				if (item.kind === "reference") references.push(fileReference(item.path));
			}
			if (references.length) setDraft((text) => `${text}${text && !/\s$/.test(text) ? " " : ""}${references.join("")}`);
			if (attachments.length) await attach(attachments);
		} catch (error) { setError(error instanceof Error ? error.message : String(error)); }
	};
	const choices =
		argumentChoices.length === 0 && /^\/\S*$/.test(draft)
			? snapshot.commands.filter((command) => `/${command.name}`.startsWith(draft))
			: [];
	return (
		<motion.footer className="composer" ref={ref} style={style}>
			<AnimatePresence initial={false}>
			{setup && hasContextMessages(snapshot) && <Reveal><div className="flex flex-wrap items-center justify-center gap-2 pb-2 text-sm text-muted-foreground" role="status">
				<span>{setup.kind === "auth" ? "发送消息前，请先配置模型服务。" : "发送消息前，请先选择可用模型。"}</span>
				<Button variant="link" size="sm" disabled={!gui.canSubmit} onClick={() => gui.setPanel({ kind: setup.kind })}>{setup.action}</Button>
			</div></Reveal>}
			</AnimatePresence>
			<div
				className="composer-card"
				ref={fileDrop.ref}
				data-file-drop={fileDrop.state}
				onDrop={(event) => {
					const files = [...event.dataTransfer.files];
					if (!files.length) return;
					event.preventDefault();
					void drop(files);
					editor.current?.focus({ preventScroll: true });
				}}
			>
				{referenceVersion !== initialReferenceVersion.current && <FeedbackHighlight key={referenceVersion} />}
				<div className="composer-scroll">
				<AnimatePresence initial={false}>
				{queuedCount > 0 && (
					<Reveal key="queue"><QueuedMessages queue={snapshot.queue} clear={() => { void send({ action: "clearQueue" }); }} /></Reveal>
				)}
				{images.length > 0 && (
					<Reveal key="images"><ul className="image-previews">
						<AnimatePresence propagate>
						{images.map((image, index) => (
							<ListItem className="image-preview" key={image.id} initial={seenImages.current.has(image.id) ? false : fade.initial}>
								<ImagePreviewButton src={`data:${image.mimeType};base64,${image.data}`} alt={`待发送图片 ${index + 1}`}>
									<motion.img src={`data:${image.mimeType};base64,${image.data}`} alt="待发送图片"
										initial={seenImages.current.has(image.id) ? false : attachmentOrigin}
										animate={{ y: 0, rotate: 0, scale: 1 }} exit={attachmentOrigin} transition={settle} />
								</ImagePreviewButton>
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
				<motion.ul layoutScroll {...suggestions} className="suggestions" aria-label="输入建议">
					{choices.map((choice) => (
						<li key={choice.name}>
							<Button
								variant="ghost"
								tabIndex={-1}
								className="suggestion-command animated-background-target"
								data-suggestion={`command:${choice.name}`}
								onClick={() => {
									setDraft(`/${choice.name} `);
									editor.current?.focus();
								}}
							>
								<AnimatedBackground active={activeSuggestion === `command:${choice.name}`} layoutId={suggestionHighlight} />
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
								className={`animated-background-target${item.description ? " suggestion-command" : ""}`}
								data-suggestion={`argument:${item.value}`}
								onClick={() => {
									setDraft(`${draft.replace(/\s.*$/s, "")} ${item.value}`);
									editor.current?.focus();
								}}
							>
								<AnimatedBackground active={activeSuggestion === `argument:${item.value}`} layoutId={suggestionHighlight} />
								<span className="suggestion-label">{item.label}</span>
								{item.description && <span className="suggestion-description">{item.description}</span>}
							</Button>
						</li>
					))}
					{fileChoices.map((file) => (
						<li key={file}>
							<Hint content={file}><Button
								variant="ghost"
								tabIndex={-1}
								className="animated-background-target"
								data-suggestion={`file:${file}`}
								onClick={() => {
									setDraft((text) => text.replace(/@[^\s]*$/, () => `@"${file}" `));
									clearFiles();
									editor.current?.focus();
								}}
							>
								<AnimatedBackground active={activeSuggestion === `file:${file}`} layoutId={suggestionHighlight} />
								<span className="suggestion-label">{file}</span>
							</Button></Hint>
						</li>
					))}
				</motion.ul>
				</Reveal>}
				</AnimatePresence>
				<motion.div className="composer-input" initial={false} animate={{ height: inputHeight ?? "auto" }} transition={settle}>
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
						const enterSends = preferences?.sendShortcut === "enter";
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
				<div className="composer-drop-hint" role="status" aria-hidden={fileDrop.state === "idle"}>
					<Paperclip aria-hidden="true" />
					<span>{fileDrop.state === "over" ? "松开即可添加" : "拖到此处添加附件"}</span>
				</div>
				</motion.div>
				</div>
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
						<InputHistory history={snapshot.history} select={setDraft} focusEditor={() => editor.current?.focus()} />
						<Hint content={`工具 · ${codemode ? "codemode" : "普通模式"}${mcpEnabled ? " · MCP 已启用" : ""}`}><Button
							variant="ghost"
							size="sm"
							className="tool-count"
							aria-label={`工具：可用 ${toolCount} 个${codemode ? "，codemode 模式" : ""}${mcpEnabled ? "，MCP 已启用" : ""}`}
							disabled={!gui.canSubmit}
							onClick={() => gui.setPanel({ kind: "tools" })}
						>
							<MorphIcon icon={toolIcon} spring="smooth" size="1em" /><AnimatedNumber value={toolCount} />
						</Button></Hint>
						<IconButton
							label={`当前：${behaviorLabel}（${steering ? "引导" : "跟进"}），点击切换为 ${steering ? "Follow-up" : "Steering"}`}
							tooltip={steering ? "切换为跟进" : "切换为引导"}
							size="sm"
							className="message-behavior"
							onClick={() => setBehavior((current) => current === "steer" ? "followUp" : "steer")}
						>
							<MorphIcon icon={behaviorIcon} spring="smooth" size="1em" /><span className="message-behavior-label"><Crossfade value={behavior}>{behaviorLabel}</Crossfade></span>
						</IconButton>
					</div>
					<div className="composer-controls">
						<ModelControls snapshot={snapshot} send={send} disabled={!gui.canSubmit} openManager={() => gui.setPanel({ kind: "model" })} />
						<ContextUsage snapshot={snapshot} />
						<SendButton
							mode={snapshot.compacting ? "stop-compaction" : stopping ? "stop" : running ? steering ? "steer" : "follow-up" : "send"}
							onActivate={stopping ? () => void send({ action: "abort" }) : submit}
							disabled={!connected || (!stopping && (!gui.canSubmit || !hasContent))}
						/>
					</div>
				</div>
			</div>
		</motion.footer>
	);
}
