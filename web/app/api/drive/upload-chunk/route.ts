import { NextResponse } from "next/server";
import { driveAccessToken, readDriveJson, updateDriveJson } from "../../../lib/google-drive";
import { notifyN8nWorker } from "../../../lib/n8n";

export const runtime = "nodejs";

export async function PUT(request: Request) {
  const sessionUrl = request.headers.get("x-drive-upload-session");
  const recordId = request.headers.get("x-drive-record-id");
  const jobId = request.headers.get("x-drive-job-id");
  const contentRange = request.headers.get("content-range");
  if (!sessionUrl || !recordId || !jobId || !contentRange) return NextResponse.json({ error: "Faltan datos de la subida" }, { status: 400 });
  try {
    const bytes = await request.arrayBuffer();
    const token = await driveAccessToken();
    const response = await fetch(sessionUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": request.headers.get("content-type") || "application/octet-stream",
        "Content-Length": String(bytes.byteLength),
        "Content-Range": contentRange,
      },
      body: bytes,
    });
    const raw = await response.text();
    const range = response.headers.get("range");
    if (response.status === 308) return NextResponse.json({ status: "uploading", range });
    if (!response.ok) return NextResponse.json({ error: raw || `Drive respondió ${response.status}` }, { status: response.status });
    const file = raw ? JSON.parse(raw) : {};
    const record = await readDriveJson(recordId);
    await updateDriveJson(recordId, { ...record, status: "queued", driveFileId: file.id, uploadedAt: new Date().toISOString() }, { transcription_job: jobId, transcription_status: "queued" });
    try {
      await notifyN8nWorker({ jobId, recordId, fileId: file.id });
      console.info(`[drive-upload:${jobId}] worker n8n notificado`);
    } catch (notificationError) {
      console.warn(`[drive-upload:${jobId}] no se pudo notificar a n8n`, notificationError);
    }
    console.info(`[drive-upload:${jobId}] subida terminada file=${file.id}`);
    return NextResponse.json({ status: "completed", fileId: file.id, file });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error al subir el fragmento a Drive";
    console.error(`[drive-upload:${jobId}] ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
