import { X } from "lucide-react";
import { errorSummary } from "../../diagnostics.ts";
import { IconButton } from "../components/icon-button";

export function ErrorBanner({ message, dismiss }: { message: string; dismiss: () => void }) {
	const summary = errorSummary(message);
	return <div role="alert" className="error-banner">
		<div className="error-banner-content">
			<p>{summary}</p>
			{summary !== message && <details><summary>错误详情</summary><pre>{message}</pre></details>}
		</div>
		<IconButton label="关闭错误提示" onClick={dismiss}><X /></IconButton>
	</div>;
}
