import type { ReactNode } from "react";
import { safeLink } from "./format.ts";

export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
	if (!safeLink(href)) return <span className={className}>{children}</span>;
	return <a href={href} className={className} target="_blank" rel="noreferrer" onClick={(event) => {
		if (window.opi) {
			event.preventDefault();
			void window.opi.openExternal(href);
		}
	}}>{children}</a>;
}
