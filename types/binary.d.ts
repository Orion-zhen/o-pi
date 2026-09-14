declare module "opi:assets" {
	export const id: string;
	export const assets: readonly {
		readonly path: string;
		readonly source: string;
		readonly executable: boolean;
	}[];
}
