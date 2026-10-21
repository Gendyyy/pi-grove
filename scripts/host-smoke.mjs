#!/usr/bin/env node
/**
 * host-smoke.mjs — load the extension in a real pi process and prove a turn still runs.
 * Unit tests cover the renderer; this catches registration and host-API breakage.
 */
import { spawn } from "node:child_process";

const LIMIT_MS = 180_000;

/** Run pi headless and collect both streams, whatever the exit path. */
function smoke() {
  return new Promise((resolve) => {
    const child = spawn("pi", ["-p", "reply with the single word ok", "--no-session"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => child.kill("SIGKILL"), LIMIT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** True when the failure came from the model provider, not from the extension. */
function isProviderOutage(text) {
  return /Endpoint is unavailable|Upstream request failed|server_error|rate.?limit|429|50[0-9]:/.test(text);
}

const { code, stdout, stderr } = await smoke();
const detail = (stdout + stderr).trim();

if (isProviderOutage(detail)) {
  console.log("skipped: the provider is unavailable, so no turn could run\n" + detail);
  process.exit(0);
}
if (/extension|renderer/i.test(stderr)) {
  console.error("pi reported an extension problem:\n" + stderr.trim());
  process.exit(1);
}
if (code !== 0 || !/ok/i.test(stdout)) {
  console.error("pi did not answer cleanly (exit " + code + "):\n" + detail);
  process.exit(1);
}
console.log("ok: pi answered with the extension loaded");
