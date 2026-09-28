import { DefaultFolderIcon, DefaultFolderOpenedIcon, FileIcon as SymbolsFileIcon } from "@react-symbols/icons/utils";
import { Link } from "lucide-react";
import "./file-icon.css";

export function FileIcon({ name, kind, open = false }: {
	name: string;
	kind: "directory" | "file" | "symlink" | "other";
	open?: boolean;
}) {
	if (kind === "directory") {
		const Icon = open ? DefaultFolderOpenedIcon : DefaultFolderIcon;
		return <Icon className="file-type-icon" aria-hidden="true" focusable="false" />;
	}
	if (kind === "symlink") return <Link className="file-type-icon file-link-icon" aria-hidden="true" focusable="false" />;
	return <SymbolsFileIcon fileName={name.slice(name.lastIndexOf("/") + 1)} autoAssign className="file-type-icon" aria-hidden="true" focusable="false" />;
}
