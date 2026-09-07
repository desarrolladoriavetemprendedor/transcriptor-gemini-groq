import { NextResponse } from "next/server";
import { createDriveFolder, createDriveJson, driveConfig, ensureDriveFolder, startResumableUpload } from "../../../lib/google-drive";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const jobId = crypto.randomUUID();
  try {
    const body = await request.json() as { name?: string; mimeType?: string; size?: number };
    if (!body.name || !body.size) return NextResponse.json({ error: "Faltan nombre o tamaño del archivo" }, { status: 400 });
    const config = driveConfig();
    const controlFolder = await ensureDriveFolder("Transcriptor - Control", config.parentFolderId, { transcription_role: "control" });
    const resultsFolder = await ensureDriveFolder("Transcriptor - Resultados", config.parentFolderId, { transcription_role: "results" });
    const folder = await createDriveFolder(`Temporal - ${jobId}`, config.parentFolderId, { transcription_job: jobId, transcription_status: "uploading" });
    const record = {
      version: 1,
      jobId,
      status: "uploading",
      filename: body.name,
      mimeType: body.mimeType || "video/mp4",
      size: body.size,
      tempFolderId: folder.id,
      controlFolderId: controlFolder.id,
      resultsFolderId: resultsFolder.id,
      driveFileId: null,
      resultFileId: null,
      error: null,
    };
    const recordId = await createDriveJson(`job-${jobId}.json`, controlFolder.id, record, { transcription_job: jobId, transcription_status: "uploading" });
    const sessionUrl = await startResumableUpload(body.name, body.mimeType || "video/mp4", body.size, folder.id, { transcription_job: jobId, transcription_status: "uploaded" });
    console.info(`[drive-upload:${jobId}] sesión creada archivo=${body.name}`);
    return NextResponse.json({ jobId, recordId, folderId: folder.id, sessionUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo preparar la subida a Drive";
    console.error(`[drive-upload:${jobId}] ${message}`);
    return NextResponse.json({ error: message, jobId }, { status: 500 });
  }
}
