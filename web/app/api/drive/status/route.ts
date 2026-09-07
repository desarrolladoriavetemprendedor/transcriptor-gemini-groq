import { NextResponse } from "next/server";
import { readDriveJson } from "../../../lib/google-drive";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const recordId = new URL(request.url).searchParams.get("recordId");
  if (!recordId) return NextResponse.json({ error: "Falta recordId" }, { status: 400 });
  try {
    const record = await readDriveJson(recordId);
    return NextResponse.json(record);
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo consultar el trabajo";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
