import { useCallback, useMemo } from "react";
import { AnimatePresence } from "motion/react";
import type { useStartupMotion } from "./welcome/use-startup-motion.ts";
import { Fade } from "@/ui/motion/animated.tsx";
import { BashExecution } from "@/features/chat/messages/message.tsx";
import { MessageActionsProvider } from "@/features/chat/messages/message-footer.tsx";
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
import type { ReadySession } from "@/features/sessions/session-state.ts";

type ConversationControls = Pick<ReturnType<typeof useGui>,
	"session" | "globalSend" | "cwd" | "openFile" | "availableVersion" | "changelog" | "changelogShown"
	| "canSubmit" | "setPanel" | "editor" | "setDraft" | "guiConfig" | "sessionPanelOpen"
	| "activity" | "workspaceRoot" | "workspaces" | "connected" | "canNavigate" | "globalQuery" | "setError">;
type Props = {
	gui: ConversationControls; target: string | undefined; showWelcome: boolean;
	startup: Pick<ReturnType<typeof useStartupMotion>, "time" | "enterWelcome">;
	closeSidebar: () => void; clearLocation: () => void;
	transcript: Pick<ReturnType<typeof useTranscriptScroll>, "toEntry" | "followLatest">;
};

/** 就绪会话拥有消息组件，加载阶段不构造半成品消息视图。 */
export function ConversationContent(props: Props) {
	const { gui, showWelcome, startup, closeSidebar } = props;
	const session = gui.session;
	if (session?.state === "ready") return <SessionConversation key={session.target.id} {...props} session={session} />;
	return <>
		{showWelcome && <Fade initial={false} className="welcome workspace-welcome"><WelcomeSurface {...startup}>
			<h1>选择工作区</h1><p>打开项目目录，或从侧栏恢复历史会话。</p><WorkspacePicker gui={gui} close={closeSidebar} />
		</WelcomeSurface></Fade>}
		{session && groupNotices(session.notices).map((group) => <NoticeGroupView key={group.anchor} group={group} live
			clear={(ids) => { void session.send({ action: "clearNotices", ids }).catch(gui.setError); }} />)}
	</>;
}

function SessionConversation({ gui, session, target, showWelcome, startup, clearLocation, transcript }: Props & { session: ReadySession }) {
	const { snapshot, notices, send, view } = session;
	const openFileLinksExternally = gui.guiConfig?.state === "ready" && gui.guiConfig.value.openFileLinksExternally;
	const fileLinks = useMemo(() => ({ cwd: gui.cwd, openFile: (path: string) => {
		if (openFileLinksExternally && window.opi) {
			void window.opi.openFile(gui.cwd, path).catch((error: unknown) => gui.setError(`无法打开文件：${error instanceof Error ? error.message : String(error)}`));
		} else gui.openFile(path);
	} }), [gui.cwd, gui.openFile, gui.setError, openFileLinksExternally]);
	const located = useMemo(() => locateTranscript(snapshot, target), [snapshot.entries, snapshot.contextEntryIds, snapshot.leafId, target]);
	const source = useMemo(() => ({ ...snapshot, messages: located.messages,
		...(located.preview ? { streamingMessage: null, liveTools: [], streaming: false, retrying: false, compacting: false } : {}),
	} satisfies TranscriptSource), [snapshot, located]);
	const count = located.contextCount;
	const noticeGroups = useMemo(() => groupNotices(notices), [notices]);
	const inlineGroups = useMemo(() => located.preview ? [] : noticeGroups, [located.preview, noticeGroups]);
	const noticeTail = count + (snapshot.streamingMessage ? 1 : 0);
	const clearNoticeGroup = useCallback((ids: string[]) => { void send({ action: "clearNotices", ids }).catch(gui.setError); }, [send, gui.setError]);
	const inlineNotices = !located.preview && count > 0;
	return <>
		{gui.availableVersion && !located.preview && <div className="startup-version" role="status">Pi v{gui.availableVersion} 版本可用</div>}
		{gui.changelog && !located.preview && <StartupChangelog value={gui.changelog} shown={gui.changelogShown} />}
		<AnimatePresence initial={false} mode="wait" presenceAffectsLayout={false}>
			{showWelcome && <Fade key={`welcome-${snapshot.sessionId}`} initial={false} className="welcome">
				<WelcomeSurface {...startup}><Welcome snapshot={snapshot} gui={gui} /></WelcomeSurface>
			</Fade>}
			{(count > 0 || located.preview) && <Fade className="flex min-w-0 flex-col" key={located.preview ? `${snapshot.sessionId}:${target}` : snapshot.sessionId}
				onAnimationComplete={() => { if (target) transcript.toEntry(target); }}>
				{located.preview && <div className="toolbar" role="status">正在只读预览历史分支或已压缩消息<Button variant="outline" onClick={() => { clearLocation(); requestAnimationFrame(transcript.followLatest); }}>返回当前会话</Button></div>}
				<FileLinksContext value={fileLinks}><DisclosureMemoryContext value={view.disclosures}>
					<MessageActionsProvider entries={located.entriesById} visible={!gui.sessionPanelOpen} send={send}>
						<Transcript source={source} entryIds={located.entryIds} prunedToolCallIds={located.prunedToolCallIds} groups={inlineGroups} tail={noticeTail} clear={clearNoticeGroup} />
					</MessageActionsProvider>
				</DisclosureMemoryContext></FileLinksContext>
			</Fade>}
		</AnimatePresence>
		{!located.preview && snapshot.bashCommand !== null && <BashExecution command={snapshot.bashCommand} output={snapshot.bashOutput} />}
		<AnimatePresence initial={false}>{!inlineNotices && noticeGroups.map((group) =>
			<NoticeGroupView key={group.anchor} group={group} live={group.anchor >= noticeTail} clear={clearNoticeGroup} />)}</AnimatePresence>
	</>;
}
