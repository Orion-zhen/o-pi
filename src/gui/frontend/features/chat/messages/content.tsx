import type { ReactNode } from "react";
import { MarkdownText } from "@/ui/content/markdown.tsx";
import { record, pretty } from "@/ui/content/format.ts";
import { Disclosure } from "@/ui/disclosure.tsx";
import { SessionImage } from "./session-image.tsx";

export function Content({ value }: { value: unknown }): ReactNode {
	if (typeof value === "string") return <MarkdownText text={value} />;
	if (Array.isArray(value)) return value.map((block, index) => <Content key={index} value={block} />);
	if (!record(value)) return <pre>{pretty(value)}</pre>;
	if (value.type === "text" && typeof value.text === "string") return <MarkdownText text={value.text} />;
	if (value.type === "thinking" && typeof value.thinking === "string")
		return (
			<Disclosure className="thinking" summary="思考" lazy>
				<MarkdownText text={value.thinking} />
			</Disclosure>
		);
	if (value.type === "image") {
		if (typeof value.imageId === "string" && typeof value.mimeType === "string" && /^image\/(png|jpeg|gif|webp)$/.test(value.mimeType))
			return <SessionImage id={value.imageId} mime={value.mimeType} />;
		return <span>[无法显示的图片格式]</span>;
	}
	return <pre>{pretty(value)}</pre>;
}
