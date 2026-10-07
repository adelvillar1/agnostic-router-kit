#!/usr/bin/env node
import { serveStdio } from "../lib/memory-mcp.mjs";

serveStdio().catch((e) => {
  console.error(e?.stack ?? e);
  process.exit(1);
});
