import type { ReactNode } from "react";
import { safeLink } from "./format.ts";
import { Hint } from "../tooltip.tsx";

export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
	if (!safeLink(href)) return <span className={className}>{children}</span>;
	return <Hint content={href}><a href={href} className={className} target="_blank" rel="noreferrer" onClick={(event) => {
		if (window.opi) {
			event.preventDefault();
			void window.opi.openExternal(href);
		}
	}}>{children}</a></Hint>;
}
