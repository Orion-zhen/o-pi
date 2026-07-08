import { describe, expect, it } from "vitest";

import { parseCodeUnits } from "../../src/file-tools/grep/parser.js";

function symbols(filePath: string, text: string): Array<[string, string | undefined, string | undefined]> {
	return parseCodeUnits(filePath, text).units.map((unit) => [unit.kind, unit.name, unit.qualifiedName]);
}

describe("grep parser", () => {
	it("通过 tree-sitter 提取 TypeScript/Python/Go/Rust 符号", () => {
		expect(
			symbols(
				"auth.ts",
				"export class AuthService {\n  async login() { return issueToken(); }\n}\nexport const makeSession = () => null;\n",
			),
		).toEqual([
			["class", "AuthService", "AuthService"],
			["method", "login", "AuthService.login"],
			["declaration", "makeSession", "makeSession"],
		]);

		expect(symbols("worker.py", "class Worker:\n  def run(self):\n    pass\ndef top():\n  pass\n")).toEqual([
			["class", "Worker", "Worker"],
			["function", "run", "Worker.run"],
			["function", "top", "top"],
		]);

		expect(symbols("server.go", "package main\ntype Server struct{}\nfunc Start() {}\nfunc (s Server) Stop() {}\n")).toEqual([
			["type", "Server", "Server"],
			["function", "Start", "Start"],
			["function", "Stop", "Stop"],
		]);

		expect(symbols("server.rs", "pub struct Server;\nimpl Server { pub fn start(&self) {} }\npub fn stop() {}\n")).toEqual([
			["type", "Server", "Server"],
			["module", "Server", "Server"],
			["function", "start", "Server.start"],
			["function", "stop", "stop"],
		]);
	});

	it("函数内部局部声明不拆分为独立 grep region", () => {
		const parsed = parseCodeUnits("a.ts", "export function demo() {\n  const Token = 'Token';\n  return Token;\n}\n");
		expect(parsed.units.map((unit) => unit.qualifiedName)).toEqual(["demo"]);
	});
});
