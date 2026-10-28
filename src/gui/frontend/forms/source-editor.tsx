import { lazy, Suspense } from "react";
import "./source-editor.css";

const SourceCodeEditor = lazy(() => import("./source-code-editor.tsx"));

export function SourceEditor({ file, label, value, disabled = false, onChange }: {
	file: string; label: string; value: string; disabled?: boolean; onChange: (value: string) => void;
}) {
	return <div className="settings-source-editor" data-disabled={disabled || undefined}>
		<div className="settings-source-file" title={file}>{file.split(/[\\/]/).at(-1)}</div>
		<Suspense fallback={<div className="settings-source-loading" aria-busy="true" />}>
			<SourceCodeEditor label={label} value={value} disabled={disabled} onChange={onChange} />
		</Suspense>
	</div>;
}
