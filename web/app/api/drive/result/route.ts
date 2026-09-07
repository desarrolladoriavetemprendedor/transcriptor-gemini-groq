import { NextResponse } from "next/server";
import { driveMedia } from "../../../lib/google-drive";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const fileId = new URL(request.url).searchParams.get("fileId");
  if (!fileId) return NextResponse.json({ error: "Falta fileId" }, { status: 400 });
  try {
    const response = await driveMedia(fileId);
    if (!response.ok) return NextResponse.json({ error: "No se pudo descargar la transcripción" }, { status: response.status });
    return new NextResponse(await response.arrayBuffer(), { headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="transcripcion.txt"` } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo descargar la transcripción";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
