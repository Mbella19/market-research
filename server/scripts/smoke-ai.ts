/** Manual check: `npx tsx server/scripts/smoke-ai.ts [effort]` — runs a real Codex call. */
import { codexHealth } from "../ai/codex.ts";
import type { Effort } from "../settings.ts";

const effort = (process.argv[2] ?? "low") as Effort;
console.log(`Running codex smoke test at effort="${effort}"...`);
const r = await codexHealth(effort);
console.log(JSON.stringify(r, null, 2));
process.exit(r.ok ? 0 : 1);
