import { loadEnv } from "../src/lib/env";
import { activateTelegram } from "../src/lib/deployment/activate";
import { deploymentUrls, PRODUCTION_ORIGIN } from "../src/lib/deployment/urls";
async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help")) {
    console.log(
      "Usage: npm run telegram:activate -- [--check | --dry-run]\nDefault registers only after authenticated deployment readiness succeeds. --check performs probes and getWebhookInfo without setWebhook. --dry-run prints public URL configuration only. Secrets are read from existing ENV and never printed.",
    );
    return;
  }
  if ([...args].some((a) => !["--check", "--dry-run"].includes(a)))
    throw new Error("Unknown option; use --help.");
  if (args.has("--dry-run")) {
    console.log(
      JSON.stringify(
        {
          registered: false,
          ...deploymentUrls(process.env.APP_URL ?? PRODUCTION_ORIGIN),
        },
        null,
        2,
      ),
    );
    return;
  }
  const result = await activateTelegram(loadEnv(), fetch, !args.has("--check"));
  console.log(JSON.stringify(result, null, 2));
  if (result.lastDeliveryErrorAt)
    console.log(
      "A previous delivery error is recorded. Send /start privately and inspect getWebhookInfo again to verify current delivery.",
    );
}
main().catch((err) => {
  console.error(
    err instanceof Error ? err.message : "Activation failed; details omitted.",
  );
  process.exitCode = 1;
});
