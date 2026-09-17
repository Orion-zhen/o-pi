import { createContext, useContext, useState, type ComponentProps } from "react";
import { Collapsible as Primitive } from "radix-ui";

const Expanded = createContext(false);

function Collapsible({ open, defaultOpen = false, onOpenChange, ...props }: ComponentProps<typeof Primitive.Root>) {
	const [expanded, setExpanded] = useState(defaultOpen);
	const value = open ?? expanded;
	return <Expanded value={value}><Primitive.Root data-slot="collapsible" open={value} onOpenChange={(next) => {
		setExpanded(next);
		onOpenChange?.(next);
	}} {...props} /></Expanded>;
}

function CollapsibleTrigger(props: ComponentProps<typeof Primitive.Trigger>) {
	return <Primitive.Trigger data-slot="collapsible-trigger" {...props} />;
}

function CollapsibleContent({ className, children, lazy = false, ...props }: Omit<ComponentProps<typeof Primitive.Content>, "forceMount"> & { lazy?: boolean }) {
	const open = useContext(Expanded);
	const [mounted, setMounted] = useState(!lazy || open);
	if (open && !mounted) setMounted(true);
	return <Primitive.Content {...props} forceMount data-slot="collapsible-content" className={className} inert={!open} aria-hidden={!open}>
		{/* Radix 测量外层时会暂停过渡，动画放在内层以保留连续反向切换。 */}
		<div className="collapse-content" data-state={open ? "open" : "closed"}><div className="collapse-inner">{mounted && children}</div></div>
	</Primitive.Content>;
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
