/**
 * Local development server: `npm run dev`, then use http://localhost:3000/mcp
 * Loads variables from .env.local / .env if present.
 */
import { createServer } from "node:http";
import { existsSync } from "node:fs";

for (const file of [".env.local", ".env.secrets.local", ".env"]) {
  if (existsSync(file)) process.loadEnvFile(file);
}

const { route } = await import("../src/router.js");
const port = Number(process.env.PORT ?? 3000);

createServer((req, res) => void route(req, res)).listen(port, () => {
  console.log(`Ivanti Neurons MCP gateway on http://localhost:${port}/mcp  (health: /health?probe=1)`);
});
