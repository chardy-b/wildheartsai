import { runWorkerFromEnvironment } from "./pi-runner.js";
void runWorkerFromEnvironment().catch(() => { process.exitCode = 1; });
