import { NextRequest, NextResponse } from "next/server";
import { loadEnv } from "@/lib/env";
import { verifyApkToken } from "@/lib/builds/apk-token";
import { fetchRunApk } from "@/lib/builds/artifacts";
import { getUsableToken } from "@/lib/github/credentials";
import { ARTIFACT_LIMIT } from "@/lib/github/actions";
import { github } from "@/lib/github/client";
import { consumeRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Signed link from the Telegram "Download APK" button. Streams the APK straight to the browser's downloads. */
export async function GET(req: NextRequest) {
  const env = loadEnv();
  const claims = verifyApkToken(req.nextUrl.searchParams.get("t"), env.encryptionKey);
  if (!claims) return new NextResponse("Link tidak valid atau sudah kedaluwarsa.", { status: 403 });
  if (!(await consumeRateLimit(`apk:${claims.u}`, 20, 3600).catch(() => true)))
    return new NextResponse("Terlalu banyak unduhan. Coba lagi nanti.", { status: 429 });

  const cred = await getUsableToken(claims.u, env).catch(() => null);
  if (!cred) return new NextResponse("Akun GitHub belum terhubung. Kirim /login ke bot.", { status: 401 });
  try {
    await github(cred.token, `/repos/${claims.repo}`);
    const apk = await fetchRunApk(cred.token, claims.repo, claims.run, ARTIFACT_LIMIT);
    if (!apk) return new NextResponse("APK tidak ditemukan atau artifact sudah kedaluwarsa.", { status: 404 });
    const data = apk.data;
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= data.length) return controller.close();
        controller.enqueue(data.subarray(offset, offset + 65536));
        offset += 65536;
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "application/vnd.android.package-archive",
        "content-length": String(data.length),
        "content-disposition": `attachment; filename="${apk.name.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
        "cache-control": "private, no-store",
      },
    });
  } catch {
    return new NextResponse("Gagal mengambil APK dari GitHub.", { status: 502 });
  }
}
