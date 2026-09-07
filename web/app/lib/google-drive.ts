const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";

export function driveConfig() {
  const required = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "GOOGLE_DRIVE_PARENT_FOLDER_ID"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Faltan variables de Drive: ${missing.join(", ")}`);
  return {
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN!,
    parentFolderId: process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID!,
  };
}

export async function driveAccessToken() {
  const config = driveConfig();
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
    grant_type: "refresh_token",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
  const payload = await response.json();
  if (!response.ok || typeof payload.access_token !== "string") throw new Error("No se pudo renovar el acceso a Google Drive");
  return payload.access_token as string;
}

export async function driveRequest(path: string, init: RequestInit = {}) {
  const token = await driveAccessToken();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(path.startsWith("http") ? path : `${DRIVE_API}${path}`, { ...init, headers });
}

export async function createDriveFolder(name: string, parentId: string, appProperties: Record<string, string>) {
  const response = await driveRequest("/files?supportsAllDrives=true&fields=id,name", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId], appProperties }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.id) throw new Error(payload.error?.message || "No se pudo crear la carpeta temporal");
  return payload as { id: string; name: string };
}

export async function ensureDriveFolder(name: string, parentId: string, appProperties: Record<string, string>) {
  const query = `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const response = await driveRequest(`/files?q=${encodeURIComponent(query)}&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,name)&pageSize=10`);
  const payload = await response.json() as { files?: Array<{ id: string; name: string }> };
  if (!response.ok) throw new Error("No se pudo buscar una carpeta de Drive");
  if (payload.files?.[0]) return payload.files[0];
  return createDriveFolder(name, parentId, appProperties);
}

export async function createDriveJson(name: string, parentId: string, data: unknown, appProperties: Record<string, string>) {
  const content = JSON.stringify(data, null, 2);
  const response = await driveRequest("/files?supportsAllDrives=true&fields=id,name", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/json", parents: [parentId], appProperties }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.id) throw new Error(payload.error?.message || "No se pudo crear el registro del trabajo");
  const fileId = payload.id as string;
  const upload = await driveRequest(`${DRIVE_UPLOAD_API}/${fileId}?uploadType=media&supportsAllDrives=true`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: content,
  });
  if (!upload.ok) {
    const detail = await upload.text();
    throw new Error(`No se pudo guardar el registro del trabajo: ${detail.slice(0, 500)}`);
  }
  return fileId;
}

export async function updateDriveJson(fileId: string, data: unknown, appProperties: Record<string, string>) {
  const content = JSON.stringify(data, null, 2);
  const response = await driveRequest(`${DRIVE_UPLOAD_API}/${fileId}?uploadType=media&supportsAllDrives=true`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Drive-App-Properties": JSON.stringify(appProperties) },
    body: content,
  });
  if (!response.ok) throw new Error("No se pudo actualizar el registro del trabajo");
  const metadata = await driveRequest(`/files/${fileId}?supportsAllDrives=true&fields=id,appProperties`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appProperties }),
  });
  if (!metadata.ok) throw new Error("No se pudo actualizar el estado del trabajo");
}

export async function readDriveJson(fileId: string) {
  const response = await driveRequest(`/files/${fileId}?alt=media&supportsAllDrives=true`);
  const text = await response.text();
  if (!response.ok) throw new Error("No se pudo leer el estado del trabajo");
  return JSON.parse(text) as Record<string, unknown>;
}

export async function startResumableUpload(name: string, mimeType: string, size: number, parentId: string, appProperties: Record<string, string>) {
  const response = await driveRequest(`${DRIVE_UPLOAD_API}?uploadType=resumable&supportsAllDrives=true&fields=id,name`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Upload-Content-Type": mimeType || "application/octet-stream",
      "X-Upload-Content-Length": String(size),
    },
    body: JSON.stringify({ name, parents: [parentId], appProperties }),
  });
  if (!response.ok) {
    const payload = await response.text();
    throw new Error(payload || "No se pudo iniciar la subida resumible");
  }
  const location = response.headers.get("location");
  if (!location) throw new Error("Drive no devolvió la URL de subida resumible");
  return location;
}

export async function driveMedia(fileId: string) {
  return driveRequest(`/files/${fileId}?alt=media&supportsAllDrives=true`);
}

export async function deleteDriveFile(fileId: string) {
  const response = await driveRequest(`/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) throw new Error(`No se pudo eliminar el archivo temporal (${response.status})`);
}

export async function deleteDriveTemp(fileId: string | null, folderId: string | null) {
  if (folderId) {
    const list = await driveRequest(`/files?q=${encodeURIComponent(`'${folderId}' in parents and trashed=false`)}&fields=files(id)&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true`);
    const payload = await list.json() as { files?: Array<{ id: string }> };
    if (!list.ok) throw new Error("No se pudo revisar la carpeta temporal");
    for (const child of payload.files || []) await deleteDriveFile(child.id);
    await deleteDriveFile(folderId);
    return;
  }
  if (fileId) await deleteDriveFile(fileId);
}
