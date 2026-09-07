import { NextResponse } from "next/server";
import { deleteDriveFile, deleteDriveTemp, readDriveJson } from "../../../lib/google-drive";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { recordIds?: string[] };
    const recordIds = Array.isArray(body.recordIds) ? body.recordIds.filter(Boolean) : [];
    for (const recordId of recordIds) {
      const record = await readDriveJson(recordId);
      if (["completed", "error", "cancelled"].includes(String(record.status))) continue;
      await deleteDriveTemp(typeof record.driveFileId === "string" ? record.driveFileId : null, typeof record.tempFolderId === "string" ? record.tempFolderId : null);
      await deleteDriveFile(recordId);
    }
    console.info(`[drive-cancel] trabajos cancelados=${recordIds.length}`);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudieron cancelar los trabajos";
    console.error(`[drive-cancel] ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
