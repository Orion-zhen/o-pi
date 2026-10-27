declare module "*character.svg?welcome" {
	const layers: ReturnType<typeof import("../scripts/welcome/svg.ts").welcomeCharacter>;
	export default layers;
}

declare module "*reveal.svg?welcome" {
	const guides: ReturnType<typeof import("../scripts/welcome/svg.ts").welcomeReveal>;
	export default guides;
}
