import * as React from "react";
import { cn } from "@/lib/utils";
import { Tooltip as TooltipPrimitive } from "radix-ui";

function TooltipProvider({ delayDuration = 0, disableHoverableContent = true, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
	return <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} disableHoverableContent={disableHoverableContent} {...props} />;
}

function TooltipContent({
	className,
	sideOffset = 6,
	children,
	...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
	return (
		<TooltipPrimitive.Portal>
			<TooltipPrimitive.Content
				data-slot="tooltip-content"
				sideOffset={sideOffset}
				className={cn(
					"pointer-events-none z-50 w-fit max-w-[min(24rem,calc(100vw-1rem))] origin-(--radix-tooltip-content-transform-origin) rounded-md bg-foreground px-3 py-1.5 text-[length:var(--text-caption)] text-left [overflow-wrap:anywhere] text-background",
					className,
				)}
				{...props}
			>
				{children}
				<TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" />
			</TooltipPrimitive.Content>
		</TooltipPrimitive.Portal>
	);
}

function Hint({ content, children, side = "top", disabled = false }: {
	content: string | undefined;
	children: React.ReactElement;
	side?: React.ComponentProps<typeof TooltipContent>["side"];
	disabled?: boolean;
}) {
	const [open, setOpen] = React.useState(false);
	React.useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
	if (!content) return children;
	return <TooltipPrimitive.Root open={open && !disabled} onOpenChange={setOpen}>
		<TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
		<TooltipContent side={side}>{content}</TooltipContent>
	</TooltipPrimitive.Root>;
}

export { Hint, TooltipProvider };
