import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(\w):/, "$1:");
const ENV_FILES = [path.join(ROOT, "web", ".env.local"), path.join(ROOT, ".env.local")];

loadEnv();

const SCOPES = "https://www.googleapis.com/auth/drive";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";
const GEMINI_API = "https://generativelanguage.googleapis.com";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.7-flash";
const GROQ_MODEL = process.env.GROQ_MODEL || "whisper-large-v3-turbo";
const LANGUAGE = process.env.TRANSCRIPTION_LANGUAGE || "es";
const FRAGMENT_SECONDS = Number(process.env.GROQ_FRAGMENT_SECONDS || 600);

function loadEnv() {
  for (const file of ENV_FILES) {
    if (!fs.existsSync(file)) continue;
    for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const index = line.indexOf("=");
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
      if (!process.env[key]) process.env[key] = value;
    }
    break;
  }
}

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Falta la variable ${name}`);
  return value;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function googleAccessToken() {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: required("GOOGLE_CLIENT_ID"),
      client_secret: required("GOOGLE_CLIENT_SECRET"),
      refresh_token: required("GOOGLE_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error("No se pudo renovar el acceso a Google Drive");
  return data.access_token;
}

async function driveRequest(url, options = {}) {
  const token = await googleAccessToken();
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(url.startsWith("http") ? url : `${DRIVE_API}${url}`, { ...options, headers });
}

async function driveJson(url, options = {}) {
  const response = await driveRequest(url, options);
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(data.error?.message || text || `Drive HTTP ${response.status}`);
  return data;
}

async function ensureFolder(name, parentId, role) {
  const query = `'${parentId}' in parents and name='${name.replaceAll("'", "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const found = await driveJson(`/files?q=${encodeURIComponent(query)}&fields=files(id,name)&pageSize=10&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  if (found.files?.[0]) return found.files[0];
  return driveJson("/files?supportsAllDrives=true&fields=id,name", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId], appProperties: { transcription_role: role } }),
  });
}

async function createJsonFile(name, parentId, data, properties) {
  const metadata = await driveJson("/files?supportsAllDrives=true&fields=id", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/json", parents: [parentId], appProperties: properties }),
  });
  await updateJsonFile(metadata.id, data, properties);
  return metadata.id;
}

async function updateJsonFile(fileId, data, properties) {
  const content = JSON.stringify(data, null, 2);
  await driveJson(`${DRIVE_UPLOAD_API}/${fileId}?uploadType=media&supportsAllDrives=true`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: content,
  });
  await driveJson(`/files/${fileId}?supportsAllDrives=true&fields=id`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appProperties: properties }),
  });
}

async function readRecord(fileId) {
  return driveJson(`/files/${fileId}?alt=media&supportsAllDrives=true`);
}

async function updateRecord(fileId, record, status, extra = {}) {
  const next = { ...record, status, ...extra, updatedAt: new Date().toISOString() };
  await updateJsonFile(fileId, next, { transcription_job: String(next.jobId || ""), transcription_status: status });
  Object.keys(record).forEach((key) => delete record[key]);
  Object.assign(record, next);
}

async function listJobIds(folderId) {
  const query = `'${folderId}' in parents and trashed=false and mimeType='application/json'`;
  const data = await driveJson(`/files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  return (data.files || []).map((file) => file.id);
}

async function downloadDriveFile(fileId, destination) {
  const response = await driveRequest(`/files/${fileId}?alt=media&supportsAllDrives=true`);
  if (!response.ok || !response.body) throw new Error(`No se pudo descargar el video desde Drive (${response.status})`);
  const file = fs.createWriteStream(destination);
  await response.body.pipeTo(new WritableStream({ write(chunk) { return new Promise((resolve, reject) => file.write(Buffer.from(chunk), (error) => error ? reject(error) : resolve())); }, close() { file.end(); }, abort(error) { file.destroy(error); } }));
}

async function deleteDriveFile(fileId) {
  const response = await driveRequest(`/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) throw new Error(`No se pudo eliminar un archivo temporal (${response.status})`);
}

async function cleanupTemp(record) {
  if (!record.tempFolderId) return;
  const query = `'${record.tempFolderId}' in parents and trashed=false`;
  const data = await driveJson(`/files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  for (const child of data.files || []) await deleteDriveFile(child.id);
  await deleteDriveFile(record.tempFolderId);
}

async function uploadResult(folderId, filename, text) {
  const metadata = await driveJson("/files?supportsAllDrives=true&fields=id", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: filename, parents: [folderId], mimeType: "text/plain" }),
  });
  await driveJson(`${DRIVE_UPLOAD_API}/${metadata.id}?uploadType=media&supportsAllDrives=true`, {
    method: "PATCH",
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: `${text.trim()}\n`,
  });
  return metadata.id;
}

function isQuotaError(error) {
  return /429|quota|resource_exhausted|rate limit|too many requests/i.test(String(error));
}

async function geminiTranscribe(videoPath, mimeType, displayName) {
  const apiKey = required("GEMINI_API_KEY");
  const buffer = await fsp.readFile(videoPath);
  const start = await fetch(`${GEMINI_API}/upload/v1beta/files?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(buffer.length),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });
  if (!start.ok) throw new Error(`Gemini upload start HTTP ${start.status}: ${(await start.text()).slice(0, 500)}`);
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini no devolvió la URL de subida");
  const finish = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Length": String(buffer.length), "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
    body: buffer,
  });
  const uploaded = await finish.json();
  if (!finish.ok || !uploaded.file?.name || !uploaded.file?.uri) throw new Error(`Gemini upload HTTP ${finish.status}: ${JSON.stringify(uploaded).slice(0, 500)}`);
  const fileName = uploaded.file.name;
  try {
    let file = uploaded.file;
    while (file.state?.name === "PROCESSING" || file.state?.name === "PROVISIONING") {
      await sleep(5000);
      const stateResponse = await fetch(`${GEMINI_API}/v1beta/${fileName}?key=${encodeURIComponent(apiKey)}`);
      file = await stateResponse.json();
    }
    if (["FAILED", "ERROR"].includes(file.state?.name)) throw new Error(`Gemini no pudo preparar el video: ${file.state.name}`);
    const response = await fetch(`${GEMINI_API}/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ file_data: { mime_type: mimeType, file_uri: uploaded.file.uri } }, { text: "Transcribe este video completo en español. Devuelve únicamente la transcripción, sin resumen ni comentarios. Conserva el orden y separa los cambios de hablante cuando sean identificables." }] }] }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`Gemini HTTP ${response.status}: ${JSON.stringify(data).slice(0, 700)}`);
    const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
    if (!text) throw new Error("Gemini devolvió una transcripción vacía");
    return text;
  } finally {
    await fetch(`${GEMINI_API}/v1beta/${fileName}?key=${encodeURIComponent(apiKey)}`, { method: "DELETE" }).catch(() => undefined);
  }
}

async function groqTranscribe(audioPath) {
  const form = new FormData();
  form.append("file", new Blob([await fsp.readFile(audioPath)], { type: "audio/mpeg" }), path.basename(audioPath));
  form.append("model", GROQ_MODEL);
  form.append("language", LANGUAGE);
  form.append("response_format", "verbose_json");
  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${required("GROQ_API_KEY")}` },
    body: form,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Groq HTTP ${response.status}: ${JSON.stringify(data).slice(0, 500)}`);
  return String(data.text || "").trim();
}

async function groqTranscribeVideo(videoPath, recordId, record, workdir) {
  const pattern = path.join(workdir, "fragmento_%05d.mp3");
  await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-threads", "1", "-i", videoPath, "-vn", "-map", "0:a:0?", "-ac", "1", "-ar", "16000", "-b:a", "32k", "-f", "" + "segment", "-segment_time", String(FRAGMENT_SECONDS), "-reset_timestamps", "1", pattern], { maxBuffer: 1024 * 1024 });
  const chunks = (await fsp.readdir(workdir)).filter((name) => /^fragmento_\d+\.mp3$/.test(name)).sort().map((name) => path.join(workdir, name));
  if (!chunks.length) throw new Error("FFmpeg no encontró una pista de audio");
  const texts = [];
  await updateRecord(recordId, record, "processing", { provider: "groq", chunksDone: 0, chunksTotal: chunks.length, phase: `Fragmentos listos · ${chunks.length}`, progressMode: "chunks" });
  for (let index = 0; index < chunks.length; index += 1) {
    const number = index + 1;
    await updateRecord(recordId, record, "processing", { provider: "groq", chunksDone: index, chunksTotal: chunks.length, phase: `Transcribiendo fragmento ${number} de ${chunks.length}`, progressMode: "chunks" });
    const text = await groqTranscribe(chunks[index]);
    if (text) texts.push(text);
    await updateRecord(recordId, record, "processing", { provider: "groq", chunksDone: number, chunksTotal: chunks.length, phase: `Fragmento ${number} de ${chunks.length} listo`, progressMode: "chunks" });
  }
  const result = texts.join("\n\n").trim();
  if (!result) throw new Error("Groq devolvió una transcripción vacía");
  await updateRecord(recordId, record, "processing", { provider: "groq", chunksDone: chunks.length, chunksTotal: chunks.length, phase: "Uniendo fragmentos", progressMode: "indeterminate" });
  return result;
}

async function processJob(recordId, resultsFolderId) {
  const record = await readRecord(recordId);
  if (!["queued", "processing"].includes(record.status) || !record.driveFileId) return;
  const name = String(record.filename || "video");
  console.log(`Procesando: ${name}`);
  await updateRecord(recordId, record, "processing", { provider: "gemini", chunksDone: 0, chunksTotal: 0, phase: "Descargando desde Drive", progressMode: "indeterminate", error: null });
  const workdir = await fsp.mkdtemp(path.join(os.tmpdir(), "transcriptor-"));
  const videoPath = path.join(workdir, `entrada_video${path.extname(name) || ".mp4"}`);
  let provider = "gemini";
  try {
    await downloadDriveFile(record.driveFileId, videoPath);
    try {
      if (String(process.env.FORCE_GROQ_FILENAMES || "").toLowerCase().includes(name.toLowerCase())) throw new Error("429 quota simulada para prueba");
      await updateRecord(recordId, record, "processing", { provider: "gemini", phase: "Subiendo video a Gemini", progressMode: "indeterminate" });
      await updateRecord(recordId, record, "processing", { provider: "gemini", phase: "Analizando el video con Gemini", progressMode: "indeterminate" });
      const mimeType = record.mimeType || "video/mp4";
      var text = await geminiTranscribe(videoPath, mimeType, name);
      console.log("  Transcripción terminada con Gemini");
    } catch (error) {
      if (!isQuotaError(error)) throw error;
      provider = "groq";
      console.log(`  Gemini agotó la cuota; usando Groq: ${error}`);
      text = await groqTranscribeVideo(videoPath, recordId, record, workdir);
    }
    const resultName = `${path.basename(name, path.extname(name))}.txt`;
    await updateRecord(recordId, record, "processing", { provider, phase: "Guardando TXT", progressMode: "indeterminate" });
    const resultId = await uploadResult(String(record.resultsFolderId || resultsFolderId), resultName, text);
    await cleanupTemp(record);
    await updateRecord(recordId, record, "completed", { provider, chunksDone: 1, chunksTotal: 1, phase: "TXT listo", progressMode: "complete", resultFileId: resultId, resultName, error: null });
    console.log("  Listo; video y carpeta temporal eliminados");
  } catch (error) {
    console.error(`  ERROR: ${error}`);
    try { await cleanupTemp(record); } finally { await updateRecord(recordId, record, "error", { phase: "No se pudo completar", progressMode: "complete", error: String(error).slice(0, 1000) }); }
  } finally {
    await fsp.rm(workdir, { recursive: true, force: true });
  }
}

async function main() {
  const parentId = required("GOOGLE_DRIVE_PARENT_FOLDER_ID");
  const control = await ensureFolder("Transcriptor - Control", parentId, "control");
  const results = await ensureFolder("Transcriptor - Resultados", parentId, "results");
  const ids = await listJobIds(control.id);
  const jobs = [];
  for (const id of ids) {
    try {
      const record = await readRecord(id);
      if (["queued", "processing"].includes(record.status) && record.driveFileId) jobs.push(id);
    } catch (error) { console.error(`Aviso: no se pudo leer ${id}: ${error}`); }
  }
  for (const id of jobs) await processJob(id, results.id);
}

const once = process.argv.includes("--once");
if (once) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
} else {
  const poll = Number(process.env.WORKER_POLL_SECONDS || 10);
  while (true) { await main(); await sleep(Math.max(2, poll) * 1000); }
}
