import { useEffect, useState } from "react";
import { ArrowRight, FolderOpen } from "lucide-react";
import type { GuiView } from "./use-gui.ts";
import { IconButton } from "./components/icon-button";
import { Input } from "./components/ui/input";

export function WorkspacePicker({ gui, close }: { gui: GuiView; close: () => void }) {
	const [workspace, setWorkspace] = useState(gui.snapshot?.cwd ?? "");
	const [pending, setPending] = useState(false);
	useEffect(() => setWorkspace(gui.snapshot?.cwd ?? ""), [gui.snapshot?.cwd]);
	const open = async (directory: string) => {
		setPending(true);
		try {
			if (await gui.send({ action: "workspace", path: directory })) close();
		} finally {
			setPending(false);
		}
	};
	const disabled = pending || Boolean(gui.snapshot?.busy) || gui.running || gui.status !== "已连接";
	return (
		<form
			className="workspace-form"
			onSubmit={(event) => {
				event.preventDefault();
				void open(workspace);
			}}
		>
			<Input
				aria-label="工作目录"
				placeholder="输入工作目录的路径"
				value={workspace}
				onChange={(event) => setWorkspace(event.target.value)}
				disabled={disabled}
			/>
			<div className="flex justify-end gap-1">
				{window.opi && (
					<IconButton
						label="选择目录"
						disabled={disabled}
						onClick={() => {
							void window.opi
								?.chooseDirectory()
								.then(async (directory) => {
									if (directory) {
										setWorkspace(directory);
										await open(directory);
									}
								})
								.catch((error: unknown) => gui.setError(String(error)));
						}}
					>
						<FolderOpen />
					</IconButton>
				)}
				<IconButton type="submit" label="打开工作目录" disabled={disabled || !workspace.trim()}>
					<ArrowRight />
				</IconButton>
			</div>
		</form>
	);
}
