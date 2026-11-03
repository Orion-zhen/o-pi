declare module "libheif-js/libheif-wasm/libheif-bundle.mjs" {
	interface Pixels {
		width: number;
		height: number;
		data: Uint8ClampedArray<ArrayBuffer>;
	}
	interface HeifImage {
		get_width(): number;
		get_height(): number;
		is_primary(): boolean;
		display(pixels: Pixels, callback: (pixels: Pixels | null) => void): void;
		free(): void;
	}
	interface HeifDecoder {
		decoder: number | null;
		decode(bytes: Uint8Array): HeifImage[];
	}
	interface LibHeif {
		HeifDecoder: new () => HeifDecoder;
		heif_context_free(context: number): void;
	}
	export default function loadLibHeif(): LibHeif;
}
