import type { VercelRequest, VercelResponse } from "@vercel/node";
import { route } from "../src/router.js";

// The only Vercel function. vercel.json rewrites every path here as ?__path=<path>.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  await route(req, res);
}
