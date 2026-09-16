import * as React from "react";
import { cn } from "@/lib/utils";
import { ChevronDownIcon } from "lucide-react";

function NativeSelect({
	className,
	size = "default",
	...props
}: Omit<React.ComponentProps<"select">, "size"> & { size?: "sm" | "default" }) {
	return (
		<div
			className="group/native-select grid w-fit grid-cols-[minmax(0,1fr)_auto] items-center has-[select:disabled]:opacity-50"
			data-slot="native-select-wrapper"
		>
			<select
				data-slot="native-select"
				data-size={size}
				className={cn(
					"col-span-2 col-start-1 row-start-1 w-full min-w-0 appearance-none rounded-md border border-input bg-(--surface) px-[0.9em] py-[0.6em] pr-[2.5em] text-sm leading-normal transition-[border-color,box-shadow] outline-none disabled:pointer-events-none disabled:cursor-not-allowed data-[size=sm]:py-[0.45em]",
					"focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25",
					"aria-invalid:border-destructive aria-invalid:ring-destructive/20",
					className,
				)}
				{...props}
			/>
			<ChevronDownIcon
				className="pointer-events-none col-start-2 row-start-1 mr-[0.75em] size-[1em] text-muted-foreground opacity-50 select-none"
				aria-hidden="true"
				data-slot="native-select-icon"
			/>
		</div>
	);
}

function NativeSelectOption({ className, ...props }: React.ComponentProps<"option">) {
	return (
		<option data-slot="native-select-option" className={cn("bg-[Canvas] text-[CanvasText]", className)} {...props} />
	);
}

function NativeSelectOptGroup({ className, ...props }: React.ComponentProps<"optgroup">) {
	return (
		<optgroup
			data-slot="native-select-optgroup"
			className={cn("bg-[Canvas] text-[CanvasText]", className)}
			{...props}
		/>
	);
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption };
