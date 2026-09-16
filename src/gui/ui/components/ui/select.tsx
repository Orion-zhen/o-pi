import type * as React from "react";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;
export const SelectSeparator = SelectPrimitive.Separator;

export function SelectTrigger({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
	return (
		<SelectPrimitive.Trigger
			data-slot="select-trigger"
			className={cn(
				"inline-flex w-fit min-w-0 items-center justify-between gap-[0.5em] rounded-md border border-input bg-(--surface) px-[0.9em] py-[0.6em] text-sm leading-normal transition-[background-color,color,border-color,box-shadow] outline-none hover:bg-accent focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 disabled:pointer-events-none disabled:opacity-45 data-[state=open]:bg-accent [&>span:first-child]:min-w-0 [&>span:first-child]:truncate",
				className,
			)}
			{...props}
		>
			{children}
			<SelectPrimitive.Icon asChild>
				<ChevronDownIcon data-slot="select-icon" className="size-[1em] shrink-0 text-muted-foreground" />
			</SelectPrimitive.Icon>
		</SelectPrimitive.Trigger>
	);
}

export function SelectContent({ className, children, align = "end", sideOffset = 6, ...props }: React.ComponentProps<typeof SelectPrimitive.Content>) {
	return (
		<SelectPrimitive.Portal>
			<SelectPrimitive.Content
				data-slot="select-content"
				position="popper"
				align={align}
				sideOffset={sideOffset}
				collisionPadding={8}
				className={cn(
					"z-50 max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) max-w-(--radix-select-content-available-width) overflow-hidden rounded-lg border text-sm text-popover-foreground outline-none",
					className,
				)}
				{...props}
			>
				<SelectPrimitive.ScrollUpButton className="flex justify-center py-1 text-muted-foreground">
					<ChevronUpIcon className="size-[1em]" />
				</SelectPrimitive.ScrollUpButton>
				<SelectPrimitive.Viewport className="p-2">{children}</SelectPrimitive.Viewport>
				<SelectPrimitive.ScrollDownButton className="flex justify-center py-1 text-muted-foreground">
					<ChevronDownIcon className="size-[1em]" />
				</SelectPrimitive.ScrollDownButton>
			</SelectPrimitive.Content>
		</SelectPrimitive.Portal>
	);
}

export function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
	return (
		<SelectPrimitive.Item
			data-slot="select-item"
			className={cn(
				"grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-[1em] rounded-sm px-[0.75em] py-[0.625em] outline-none select-none data-[highlighted]:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-45",
				className,
			)}
			{...props}
		>
			<SelectPrimitive.ItemText className="min-w-0 wrap-anywhere">{children}</SelectPrimitive.ItemText>
			<span className="flex size-[1.15em] items-center justify-center text-primary">
				<SelectPrimitive.ItemIndicator><CheckIcon className="size-[1em]" /></SelectPrimitive.ItemIndicator>
			</span>
		</SelectPrimitive.Item>
	);
}
