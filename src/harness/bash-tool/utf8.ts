import { StringDecoder } from "node:string_decoder";

export function takeHeadBytes(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.byteLength <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && isContinuation(bytes[end])) end -= 1;
	return bytes.subarray(0, end).toString("utf8");
}

export function takeTailBytes(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.byteLength <= maxBytes) return text;
	let start = bytes.byteLength - maxBytes;
	while (start < bytes.byteLength && isContinuation(bytes[start])) start += 1;
	return bytes.subarray(start).toString("utf8");
}

/** 窗口从字符中间开始时，跳过不完整的 UTF-8 前缀。 */
export function trimLeadingUtf8Continuation(bytes: Buffer): Buffer {
	let start = 0;
	while (start < bytes.byteLength && isContinuation(bytes[start])) start += 1;
	return bytes.subarray(start);
}

/** 预览前缀不输出末尾尚未完整的字符。 */
export function decodeUtf8Prefix(bytes: Buffer): string {
	return new StringDecoder("utf8").write(bytes);
}

function isContinuation(byte: number | undefined): boolean {
	return byte !== undefined && (byte & 0xc0) === 0x80;
}
