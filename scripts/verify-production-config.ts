import { isProductionService, validateProductionConfig } from "../packages/operations/src/production-config.js";

const service = process.argv.slice(2).find((argument) => argument !== "--");
if (!isProductionService(service)) {
  throw new Error("Usage: pnpm deploy:preflight -- <api|web|worker|backup|temporal>");
}
const issues = validateProductionConfig(service, process.env);
process.stdout.write(`${JSON.stringify({ service, valid: issues.length === 0, issues }, null, 2)}\n`);
if (issues.length > 0) process.exitCode = 1;
