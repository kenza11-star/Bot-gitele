import { after, NextRequest, NextResponse } from "next/server";
import { loadEnv } from "@/lib/env";
import { handleWorkflowRun, verifySignature, type WorkflowRunEvent } from "@/lib/builds/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** GitHub App webhook. Only finished workflow runs do anything; the reply is immediate and the work continues after it. */
export async function POST(req: NextRequest) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET ?? "";
  const raw = await req.text();
  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"), secret)) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  const event = req.headers.get("x-github-event");
  if (event !== "workflow_run") return NextResponse.json({ ok: true });

  let payload: WorkflowRunEvent;
  try {
    payload = JSON.parse(raw) as WorkflowRunEvent;
  } catch {
    return new NextResponse("bad request", { status: 400 });
  }
  const delivery = req.headers.get("x-github-delivery") ?? "";
  if (!delivery) return new NextResponse("bad request", { status: 400 });

  after(async () => {
    try {
      await handleWorkflowRun(payload, delivery, loadEnv());
    } catch (err) {
      console.error("[github-webhook]", err instanceof Error ? err.name : "unknown");
    }
  });
  return NextResponse.json({ ok: true });
}
