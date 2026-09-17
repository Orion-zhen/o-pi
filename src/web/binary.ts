import "../harness/runtime/binary.ts";
import { runChildProcess } from "../harness/runtime/invocation.ts";

if (!(await runChildProcess())) await import("./main.ts");
