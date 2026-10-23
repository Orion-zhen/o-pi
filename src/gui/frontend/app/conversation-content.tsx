import { useCallback, useMemo } from "react";
import { AnimatePresence } from "motion/react";
import { Fade, Reveal } from "@/ui/motion/animated.tsx";
import { Button } from "@/ui/button.tsx";
import { DisclosureMemoryContext } from "@/ui/disclosure-memory.ts";
import { FileLinksContext } from "@/ui/content/file-links.ts";
import { Transcript } from "@/features/chat/transcript/transcript.tsx";
import { locateTranscript } from "@/features/chat/transcript/transcript-location.ts";
import type { TranscriptSource } from "@/features/chat/transcript/transcript-items.ts";
import type { useTranscriptScroll } from "@/features/chat/transcript/use-transcript-scroll.ts";
import { WorkspacePicker } from "@/features/workspace/workspace-picker.tsx";
import { NoticeGroupView, groupNotices } from "@/features/chat/messages/notices.tsx";
import { Welcome } from "./welcome/welcome.tsx";
import { WelcomeSurface } from "./welcome/welcome-surface.tsx";
import { StartupChangelog } from "./welcome/startup-changelog.tsx";
import type { useGui } from "./use-gui.ts";

type ConversationControls = Pick<ReturnType<typeof useGui>,
	"snapshot" | "notices" | "send" | "cwd" | "openFile" | "view" | "availableVersion" | "changelog" | "changelogShown"
	| "canSubmit" | "setPanel" | "editor" | "setDraft" | "guiConfig"
	| "activity" | "workspaceRoot" | "workspaces" | "connected" | "canNavigate" | "globalQuery" | "error" | "setError">;

/** 消息投影与渲染位于同一个异常边界内，不影响会话连接和输入草稿。 */
export function ConversationContent({ gui, target, workspaceWelcome, closeSidebar, clearLocation, transcript }: {
	gui: ConversationControls;
	target: string | undefined;
	workspaceWelcome: boolean;
	closeSidebar: () => void;
	clearLocation: () => void;
	transcript: Pick<ReturnType<typeof useTranscriptScroll>, "toEntry" | "followLatest">;
}) {
	const { snapshot, notices, send } = gui;
	const openFileLinksExternally = gui.guiConfig?.state === "ready" && gui.guiConfig.value.openFileLinksExternally;
	const fileLinks = useMemo(() => ({ cwd: gui.cwd, openFile: (path: string) => {
		if (openFileLinksExternally && window.opi) {
			void window.opi.openFile(gui.cwd, path).catch((error: unknown) => gui.setError(`无法打开文件：${error instanceof Error ? error.message : String(error)}`));
		} else gui.openFile(path);
	} }), [gui.cwd, gui.openFile, gui.setError, openFileLinksExternally]);
	const located = useMemo(() => snapshot ? locateTranscript(snapshot, target) : undefined, [snapshot?.entries, snapshot?.contextEntryIds, snapshot?.leafId, target]);
	const conversation = useMemo(() => snapshot && located ? {
		snapshot, ...located,
		source: { ...snapshot, messages: located.messages,
			...(located.preview ? { streamingMessage: null, liveTools: [], streaming: false, retrying: false, compacting: false } : {}),
		} satisfies TranscriptSource,
	} : null, [snapshot, located]);
	const count = conversation?.contextCount ?? 0;
	const noticeGroups = useMemo(() => groupNotices(notices), [notices]);
	const inlineGroups = useMemo(() => conversation?.preview ? [] : noticeGroups, [conversation?.preview, noticeGroups]);
	const noticeTail = count + (conversation?.snapshot.streamingMessage ? 1 : 0);
	const clearNoticeGroup = useCallback((ids: string[]) => { void send({ action: "clearNotices", ids }); }, [send]);
	const inlineNotices = Boolean(conversation && !conversation.preview && count > 0);
	return <>
		{conversation && gui.availableVersion && !conversation.preview && <div className="startup-version" role="status">Pi v{gui.availableVersion} 版本可用</div>}
		{conversation && gui.changelog && !conversation.preview && <StartupChangelog value={gui.changelog} shown={gui.changelogShown} />}
		<AnimatePresence initial={false} mode="wait" presenceAffectsLayout={false}>
			{workspaceWelcome && <Fade key="workspace-welcome" initial={false} className="welcome workspace-welcome">
				<WelcomeSurface>
					<div className="welcome-mark"><span className="app-logo" role="img" aria-label="opi" /></div>
					<h1>选择工作区</h1>
					<p>打开项目目录，或从侧栏恢复历史会话。</p>
					<WorkspacePicker gui={gui} close={closeSidebar} />
				</WelcomeSurface>
			</Fade>}
			{conversation && !count && !conversation.preview && <Fade key={`welcome-${conversation.snapshot.sessionId}`} initial={false} className="welcome">
				<WelcomeSurface><Welcome snapshot={conversation.snapshot} gui={gui} /></WelcomeSurface>
			</Fade>}
			{conversation && (count > 0 || conversation.preview) && <Fade className="flex min-w-0 flex-col" key={conversation.preview ? `${conversation.snapshot.sessionId}:${target}` : conversation.snapshot.sessionId}
				onAnimationComplete={() => { if (target) transcript.toEntry(target); }}>
				{conversation.preview && <div className="toolbar" role="status">正在只读预览历史分支或已压缩消息<Button variant="outline" onClick={() => { clearLocation(); requestAnimationFrame(transcript.followLatest); }}>返回当前会话</Button></div>}
				<FileLinksContext value={fileLinks}><DisclosureMemoryContext value={gui.view?.disclosures}>
					<Transcript source={conversation.source} entryIds={conversation.entryIds} prunedToolCallIds={conversation.prunedToolCallIds} groups={inlineGroups} tail={noticeTail} clear={clearNoticeGroup} />
				</DisclosureMemoryContext></FileLinksContext>
			</Fade>}
		</AnimatePresence>
		<AnimatePresence initial={false}>{conversation?.snapshot.bashOutput && <Reveal><pre className="live-output">{conversation.snapshot.bashOutput}</pre></Reveal>}</AnimatePresence>
		<AnimatePresence initial={false}>{!inlineNotices && noticeGroups.map((group) =>
			<NoticeGroupView key={group.anchor} group={group} live={group.anchor >= noticeTail} clear={clearNoticeGroup} />)}</AnimatePresence>
	</>;
}
