import { ProcessTerminal } from "@earendil-works/pi-tui";

/** 使用真实 renderer，仅替换终端 I/O，避免测试改动当前 shell。 */
export class RecordingTerminal extends ProcessTerminal {
	readonly writes: string[] = [];
	private input: ((data: string) => void) | undefined;
	private resize: (() => void) | undefined;
	private width = 80;
	private height = 24;

	override get columns(): number { return this.width; }
	override get rows(): number { return this.height; }
	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.input = onInput;
		this.resize = onResize;
	}
	override stop(): void { this.input = undefined; this.resize = undefined; }
	override write(data: string): void { this.writes.push(data); }

	send(data: string): void {
		if (this.input === undefined) throw new Error("Terminal is not started");
		this.input(data);
	}

	setSize(width: number, height: number): void {
		this.width = width;
		this.height = height;
		this.resize?.();
	}

	take(): string {
		return this.writes.splice(0).join("");
	}
}
