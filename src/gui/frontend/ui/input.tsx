import * as React from "react";
import { cn } from "./class-names.ts";
import { fieldSize, type FieldDensity } from "./control-size.ts";

function Input({ className, type, density = "default", ...props }: React.ComponentProps<"input"> & { density?: FieldDensity }) {
	return (
		<input
			type={type}
			data-slot="input"
			className={cn(
				"w-full min-w-0 rounded-md border border-input bg-(--surface) text-sm leading-normal transition-[border-color,box-shadow] outline-none file:inline-flex file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45",
				"focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25",
				"aria-invalid:border-destructive aria-invalid:ring-destructive/20",
				fieldSize[density],
				className,
			)}
			{...props}
		/>
	);
}

export { Input };
