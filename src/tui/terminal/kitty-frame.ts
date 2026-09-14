import { visibleWidth } from "@earendil-works/pi-tui";

const BEGIN = "\x1b[?2026h";
const END = "\x1b[?2026l";
const TOKENS = /\x1b\[(\d+);1H\x1b\[2K|\x1b_G([^\x1b]*)\x1b\\/g;
const PLACEMENT_KEYS = new Set(["i", "p", "x", "y", "w", "h", "X", "Y", "c", "r", "C", "z", "U"]);

interface Placement {
	row: number;
	column: number;
	rows: number;
	sequence: string;
}

/** 仅保存当前可见 placement，不持有图片数据或接管上游上传缓存。 */
export class KittyFrameAdapter {
	private readonly visible = new Map<string, Placement>();

	rewrite(frame: string): string {
		// 退出后上游可能把记录回放到普通屏幕，其输出不是全屏坐标帧。
		if (frame.includes("\x1b[?1049l")) {
			this.visible.clear();
			return frame;
		}
		if ((!frame.includes("\x1b_G") && this.visible.size === 0) || !frame.startsWith(BEGIN) || !frame.endsWith(END)) return frame;
		const text: string[] = [];
		const graphics: string[] = [];
		const changedRows = new Set<number>();
		const painted = new Set<string>();
		let row: number | undefined;
		let lineStart = 0;
		let retainedStart = 0;
		let continuation = false;
		for (const match of frame.matchAll(TOKENS)) {
			if (match[1] !== undefined) {
				if (continuation) throw new Error("Kitty transmission interrupted by a row write");
				row = Number(match[1]);
				changedRows.add(row);
				lineStart = match.index + match[0].length;
				continue;
			}
			const body = match[2];
			if (body === undefined) continue;
			const controls = body.slice(0, body.includes(";") ? body.indexOf(";") : body.length);
			const action = control(controls, "a");
			if (action === "d") {
				const deletion = control(controls, "d");
				if (deletion === "a" || deletion === "A") this.visible.clear();
				else if (deletion === "i" || deletion === "I") this.visible.delete(control(controls, "i") ?? "");
				continue;
			}
			if (!continuation && action !== "T" && action !== "p") continue;
			if (!continuation) {
				const id = control(controls, "i");
				const rows = Number(control(controls, "r"));
				// 当前 Pi 为每张图片分配 ID，以 C=1 禁止光标移动，并明确给出行数。
				if (row === undefined || id === undefined || control(controls, "C") !== "1" || !Number.isInteger(rows) || rows < 1) {
					throw new Error("Unsupported fullscreen Kitty placement");
				}
				const column = visibleWidth(frame.slice(lineStart, match.index)) + 1;
				const placementControls = controls.split(",").filter((value) => PLACEMENT_KEYS.has(value.slice(0, value.indexOf("="))));
				this.visible.set(id, { row, column, rows, sequence: `\x1b_Ga=p,q=2,${placementControls.join(",")}\x1b\\` });
				painted.add(id);
				graphics.push(`\x1b[${row};${column}H`);
			}
			graphics.push(match[0]);
			continuation = control(controls, "m") === "1";
			text.push(frame.slice(retainedStart, match.index));
			retainedStart = match.index + match[0].length;
		}
		if (continuation) throw new Error("Incomplete fullscreen Kitty transmission");
		// 滚动条、弹窗等差分帧可能只改图片的下方行，没有新的图片行。
		for (const [id, placement] of this.visible) {
			if (painted.has(id)) continue;
			if ([...changedRows].some((changed) => changed >= placement.row && changed < placement.row + placement.rows)) {
				graphics.push(`\x1b[${placement.row};${placement.column}H${placement.sequence}`);
			}
		}
		if (graphics.length === 0) return frame;
		text.push(frame.slice(retainedStart, -END.length));
		// 分块顺序和裁剪参数不变，在同一同步帧末尾绘制并恢复最终光标与属性。
		return `${text.join("")}\x1b7${graphics.join("")}\x1b8${END}`;
	}
}

function control(controls: string, key: string): string | undefined {
	return new RegExp(`(?:^|,)${key}=([^,]+)`).exec(controls)?.[1];
}
