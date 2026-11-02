import { useCallback, useLayoutEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { javascriptLanguage } from "@codemirror/lang-javascript";
import { tags } from "@lezer/highlight";

const highlighting = HighlightStyle.define([
	{ tag: [tags.propertyName, tags.number], color: "var(--syntax-number)" },
	{ tag: [tags.string], color: "var(--syntax-string)" },
	{ tag: [tags.bool, tags.null, tags.keyword], color: "var(--syntax-keyword)" },
	{ tag: [tags.punctuation], color: "var(--muted-foreground)" },
	{ tag: [tags.comment], color: "var(--muted-foreground)", fontStyle: "italic" },
]);

export default function SourceCodeEditor({ label, value, disabled, onChange }: {
	label: string; value: string; disabled: boolean; onChange: (value: string) => void;
}) {
	const view = useRef<EditorView>(null);
	const editable = useRef(new Compartment());
	const props = useRef({ value, disabled, onChange });
	const createState = useCallback(() => EditorState.create({
		doc: props.current.value,
		extensions: [
			lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(), history(),
			javascriptLanguage.configure({ top: "SingleExpression" }), syntaxHighlighting(highlighting),
			indentOnInput(), indentUnit.of("\t"), EditorState.tabSize.of(4), bracketMatching(),
			keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
			EditorView.contentAttributes.of({ "aria-label": label, "aria-multiline": "true", spellcheck: "false" }),
			editable.current.of(EditorState.readOnly.of(props.current.disabled)),
			EditorView.updateListener.of((update) => {
				if (update.docChanged) props.current.onChange(update.state.doc.toString());
			}),
		],
	}), [label]);
	const mount = useCallback((host: HTMLDivElement) => {
		const editor = new EditorView({ parent: host, state: createState() });
		view.current = editor;
		return () => { view.current = null; editor.destroy(); };
	}, [createState]);
	useLayoutEffect(() => {
		props.current = { value, disabled, onChange };
		const editor = view.current;
		if (!editor) throw new Error("源码编辑器尚未挂载");
		// 外部重置创建新的编辑状态，不保留已放弃内容的撤销历史。
		if (editor.state.doc.toString() !== value) editor.setState(createState());
		if (editor.state.readOnly !== disabled) editor.dispatch({ effects: editable.current.reconfigure(EditorState.readOnly.of(disabled)) });
	}, [createState, value, disabled, onChange]);
	return <div ref={mount} className="settings-source-code" />;
}
