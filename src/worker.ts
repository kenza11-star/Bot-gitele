import { runWorker, verifyWorkerConfiguration } from "./lib/worker/runtime";
import { closeDb } from "./lib/db";
async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help")) {
    console.log(
      "GitHub Manager worker\nUsage: npm run worker -- [--once | --check | --help]\nLoad the same environment as Next.js; apply migrations through 0007 first.\nDefault: continuous job/notification/cleanup loops. --once: drain one job.",
    );
    return;
  }
  if ([...args].some((a) => !["--once", "--check"].includes(a)))
    throw new Error("Unknown worker option; use --help");
  const stop = new AbortController();
  process.once("SIGTERM", () => stop.abort());
  process.once("SIGINT", () => stop.abort());
  try {
    if (args.has("--check")) {
      await verifyWorkerConfiguration();
      console.log("Worker configuration and database schema verified");
      return;
    }
    await runWorker(stop.signal, args.has("--once"));
  } finally {
    await closeDb();
  }
}
main().catch((error) => {
  console.error(
    "Worker stopped:",
    error instanceof Error ? error.name : "unknown error",
  );
  process.exitCode = 1;
});
