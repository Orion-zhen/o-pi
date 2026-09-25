import { CloseEvent, ErrorEvent } from "undici";
import type { OpenService } from "./service-client.ts";
import type { SocketEvent, SocketOptions } from "./services-contract.ts";

/** SDK 继续使用标准 WebSocket 接口，连接由主进程的 Chromium 网络栈持有。 */
export function createDesktopWebSocket(open: OpenService): typeof WebSocket {
	return class DesktopWebSocket extends EventTarget implements WebSocket {
		static readonly CONNECTING = 0;
		static readonly OPEN = 1;
		static readonly CLOSING = 2;
		static readonly CLOSED = 3;
		readonly CONNECTING = 0;
		readonly OPEN = 1;
		readonly CLOSING = 2;
		readonly CLOSED = 3;
		readonly url: string;
		binaryType: BinaryType = "blob";
		bufferedAmount = 0;
		readyState: WebSocket["readyState"] = 0;
		protocol = "";
		extensions = "";
		onopen: WebSocket["onopen"] = null;
		onclose: WebSocket["onclose"] = null;
		onerror: WebSocket["onerror"] = null;
		onmessage: WebSocket["onmessage"] = null;
		private readonly port: Promise<Electron.MessagePortMain>;
		private sending = Promise.resolve();

		constructor(url: string | URL, protocols?: string | string[] | SocketOptions) {
			super();
			const parsed = new URL(url);
			if (parsed.protocol === "http:") parsed.protocol = "ws:";
			if (parsed.protocol === "https:") parsed.protocol = "wss:";
			if (!["ws:", "wss:"].includes(parsed.protocol) || parsed.hash) throw new DOMException("Invalid WebSocket URL", "SyntaxError");
			this.url = parsed.href;
			const options = typeof protocols === "string" ? { protocols: [protocols] }
				: Array.isArray(protocols) ? { protocols } : protocols ?? {};
			this.port = open({ kind: "websocket", url: this.url, options });
			void this.port.then((port) => {
				port.on("message", ({ data }: Electron.MessageEvent) => this.receive(data as SocketEvent));
				port.once("close", () => this.disconnected());
				port.start();
			}, () => this.disconnected());
		}
		send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
			if (this.readyState === this.CONNECTING) throw new DOMException("WebSocket is connecting", "InvalidStateError");
			const bytes = typeof data === "string" ? Buffer.byteLength(data) : data instanceof Blob ? data.size : data.byteLength;
			this.bufferedAmount += bytes;
			if (this.readyState !== this.OPEN) return;
			this.sending = this.sending.then(async () => {
				const payload = typeof data === "string" ? data : data instanceof Blob ? new Uint8Array(await data.arrayBuffer())
					: ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
				(await this.port).postMessage({ kind: "send", data: payload, bytes });
			}).catch((error: unknown) => {
				this.receive({ kind: "error", message: String(error) });
				void this.port.then((port) => port.close(), () => {});
			});
		}
		close(code?: number, reason = ""): void {
			if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) throw new DOMException("Invalid close code", "InvalidAccessError");
			if (Buffer.byteLength(reason) > 123) throw new DOMException("Close reason too long", "SyntaxError");
			if (this.readyState === this.CLOSING || this.readyState === this.CLOSED) return;
			this.readyState = this.CLOSING;
			void this.sending.then(async () => (await this.port).postMessage({ kind: "close", code, reason })).catch(() => this.disconnected());
		}
		private disconnected(): void {
			if (this.readyState === this.CLOSED) return;
			this.receive({ kind: "error", message: "Desktop WebSocket service closed" });
			this.receive({ kind: "close", code: 1006, reason: "Desktop WebSocket service closed", wasClean: false });
		}
		private receive(event: SocketEvent): void {
			if (event.kind === "open") {
				if (this.readyState !== this.CONNECTING) return;
				this.readyState = this.OPEN;
				this.protocol = event.protocol;
				this.extensions = event.extensions;
				const opened = new Event("open");
				this.dispatchEvent(opened);
				this.onopen?.call(this, opened);
			} else if (event.kind === "message") {
				const data = typeof event.data === "string" || this.binaryType === "arraybuffer" ? event.data : new Blob([event.data]);
				const message = new MessageEvent("message", { data });
				this.dispatchEvent(message);
				this.onmessage?.call(this, message);
			} else if (event.kind === "drain") this.bufferedAmount -= event.bytes;
			else if (event.kind === "error") {
				const error = new ErrorEvent("error", { message: event.message, error: new Error(event.message) });
				this.dispatchEvent(error);
				this.onerror?.call(this, error);
			} else {
				this.readyState = this.CLOSED;
				const closed = new CloseEvent("close", event);
				this.dispatchEvent(closed);
				this.onclose?.call(this, closed);
				void this.port.then((port) => port.close(), () => {});
			}
		}
	};
}
