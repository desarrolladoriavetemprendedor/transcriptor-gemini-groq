"""Worker de videos largos.

Este proceso no ejecuta modelos locales. Solo usa FFmpeg en CPU para crear
fragmentos de audio cuando Gemini agota su cuota; la transcripcion siempre la
hace Gemini o Groq.

Pensado para ejecutarse en Google Colab o en un worker persistente.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

import google.auth
import requests
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload, MediaIoBaseDownload, MediaInMemoryUpload


SCOPES = ["https://www.googleapis.com/auth/drive"]
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.7-flash")
GROQ_MODEL = os.getenv("GROQ_MODEL", "whisper-large-v3-turbo")
LANGUAGE = os.getenv("TRANSCRIPTION_LANGUAGE", "es")
FRAGMENT_SECONDS = int(os.getenv("GROQ_FRAGMENT_SECONDS", "600"))


def load_env_file() -> None:
    """Carga variables simples desde web/.env.local sin sobrescribir el entorno."""
    candidates = [Path(__file__).parent / "web" / ".env.local", Path.cwd() / ".env.local"]
    for path in candidates:
        if not path.exists():
            continue
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
        break


def require_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Falta la variable {name}")
    return value


def drive_service():
    refresh_token = os.getenv("GOOGLE_REFRESH_TOKEN", "").strip()
    if refresh_token and os.getenv("GOOGLE_CLIENT_ID") and os.getenv("GOOGLE_CLIENT_SECRET"):
        credentials = Credentials(
            token=None,
            refresh_token=refresh_token,
            token_uri="https://oauth2.googleapis.com/token",
            client_id=os.environ["GOOGLE_CLIENT_ID"],
            client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
            scopes=SCOPES,
        )
        credentials.refresh(Request())
    else:
        # En un servidor persistente se usa el refresh token configurado arriba.
        credentials, _ = google.auth.default(scopes=SCOPES)
        if not credentials.valid and credentials.expired and credentials.refresh_token:
            credentials.refresh(Request())
    return build("drive", "v3", credentials=credentials, cache_discovery=False)


def list_job_ids(service, control_folder_id: str) -> list[str]:
    query = f"'{control_folder_id}' in parents and trashed=false and mimeType='application/json'"
    ids: list[str] = []
    page_token = None
    while True:
        response = service.files().list(
            q=query,
            fields="nextPageToken,files(id)",
            pageToken=page_token,
            pageSize=100,
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        ).execute()
        ids.extend(item["id"] for item in response.get("files", []))
        page_token = response.get("nextPageToken")
        if not page_token:
            return ids


def ensure_drive_folder(service, name: str, parent_id: str, role: str) -> str:
    query = f"'{parent_id}' in parents and name='{name}' and mimeType='application/vnd.google-apps.folder' and trashed=false"
    response = service.files().list(
        q=query,
        fields="files(id)",
        pageSize=10,
        supportsAllDrives=True,
        includeItemsFromAllDrives=True,
    ).execute()
    if response.get("files"):
        return response["files"][0]["id"]
    folder = service.files().create(
        body={
            "name": name,
            "mimeType": "application/vnd.google-apps.folder",
            "parents": [parent_id],
            "appProperties": {"transcription_role": role},
        },
        fields="id",
        supportsAllDrives=True,
    ).execute()
    return folder["id"]


def read_record(service, record_id: str) -> dict[str, Any]:
    request = service.files().get_media(fileId=record_id, supportsAllDrives=True)
    buffer = io.BytesIO()
    downloader = MediaIoBaseDownload(buffer, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    return json.loads(buffer.getvalue().decode("utf-8"))


def update_record(service, record_id: str, record: dict[str, Any], status: str, **extra: Any) -> None:
    record = {**record, "status": status, **extra, "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    payload = json.dumps(record, ensure_ascii=False, indent=2).encode("utf-8")
    properties = {"transcription_job": str(record.get("jobId", "")), "transcription_status": status}
    service.files().update(
        fileId=record_id,
        body={"appProperties": properties},
        media_body=MediaInMemoryUpload(payload, mimetype="application/json", resumable=False),
        supportsAllDrives=True,
        fields="id",
    ).execute()
    record.clear()
    record.update(json.loads(payload.decode("utf-8")))


def download_drive_file(service, file_id: str, destination: Path) -> None:
    request = service.files().get_media(fileId=file_id, supportsAllDrives=True)
    with destination.open("wb") as handle:
        downloader = MediaIoBaseDownload(handle, request, chunksize=8 * 1024 * 1024)
        done = False
        while not done:
            _, done = downloader.next_chunk()


def delete_drive_file(service, file_id: str) -> None:
    try:
        service.files().delete(fileId=file_id, supportsAllDrives=True).execute()
    except Exception as exc:
        print(f"Aviso: no se pudo eliminar Drive {file_id}: {exc}")


def cleanup_temp_drive(service, record: dict[str, Any]) -> None:
    file_id = record.get("driveFileId")
    folder_id = record.get("tempFolderId")
    if folder_id:
        query = f"'{folder_id}' in parents and trashed=false"
        children = service.files().list(
            q=query,
            fields="files(id)",
            pageSize=100,
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        ).execute().get("files", [])
        child_ids = {child["id"] for child in children}
        for child_id in child_ids:
            delete_drive_file(service, child_id)
        if file_id and str(file_id) not in child_ids:
            delete_drive_file(service, str(file_id))
        delete_drive_file(service, str(folder_id))
    elif file_id:
        delete_drive_file(service, str(file_id))


def is_quota_error(error: Exception | str) -> bool:
    text = str(error).lower()
    return any(marker in text for marker in ("429", "quota", "resource_exhausted", "rate limit", "too many requests"))


def force_groq_for_test(filename: str) -> bool:
    configured = os.getenv("FORCE_GROQ_FILENAMES", "")
    names = [name.strip().lower() for name in configured.split(",") if name.strip()]
    return any(name in filename.lower() for name in names)


def transcribe_with_gemini(video_path: Path) -> str:
    if not GEMINI_API_KEY:
        raise RuntimeError("Falta GEMINI_API_KEY")
    from google import genai

    client = genai.Client(api_key=GEMINI_API_KEY)
    uploaded = client.files.upload(file=str(video_path))
    try:
        state = getattr(uploaded, "state", None)
        while state and getattr(state, "name", "") in ("PROCESSING", "PROVISIONING"):
            time.sleep(5)
            uploaded = client.files.get(name=uploaded.name)
            state = getattr(uploaded, "state", None)
        if state and getattr(state, "name", "") in ("FAILED", "ERROR"):
            raise RuntimeError(f"Gemini no pudo preparar el video: {state.name}")
        prompt = (
            "Transcribe este video completo en español. Devuelve únicamente la transcripción, "
            "sin resumen ni comentarios. Conserva el orden y separa los cambios de hablante "
            "cuando sean identificables."
        )
        response = client.models.generate_content(model=GEMINI_MODEL, contents=[uploaded, prompt])
        text = (getattr(response, "text", "") or "").strip()
        if not text:
            raise RuntimeError("Gemini devolvió una transcripción vacía")
        return text
    finally:
        try:
            client.files.delete(name=uploaded.name)
        except Exception:
            pass


def transcribe_groq(audio_path: Path) -> str:
    if not GROQ_API_KEY:
        raise RuntimeError("Falta GROQ_API_KEY")
    with audio_path.open("rb") as handle:
        response = requests.post(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
            files={"file": (audio_path.name, handle, "audio/mpeg")},
            data={"model": GROQ_MODEL, "language": LANGUAGE, "response_format": "verbose_json"},
            timeout=900,
        )
    if not response.ok:
        raise RuntimeError(f"Groq HTTP {response.status_code}: {response.text[:500]}")
    return (response.json().get("text") or "").strip()


def transcribe_with_groq(video_path: Path, service, record_id: str, record: dict[str, Any], workdir: Path) -> str:
    audio_pattern = workdir / "fragmento_%05d.mp3"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-threads", "1", "-i", str(video_path),
         "-vn", "-map", "0:a:0?", "-ac", "1", "-ar", "16000", "-b:a", "32k", "-f", "segment",
         "-segment_time", str(FRAGMENT_SECONDS), "-reset_timestamps", "1", str(audio_pattern)],
        check=True,
    )
    chunks = sorted(workdir.glob("fragmento_*.mp3"))
    if not chunks:
        raise RuntimeError("FFmpeg no encontró una pista de audio")
    texts: list[str] = []
    update_record(
        service, record_id, record, "processing", provider="groq",
        chunksDone=0, chunksTotal=len(chunks),
        phase=f"Fragmentos listos · {len(chunks)}", progressMode="chunks",
    )
    for index, chunk in enumerate(chunks, 1):
        print(f"  Groq fragmento {index}/{len(chunks)}")
        update_record(
            service, record_id, record, "processing", provider="groq",
            chunksDone=index - 1, chunksTotal=len(chunks),
            phase=f"Transcribiendo fragmento {index} de {len(chunks)}", progressMode="chunks",
        )
        text = transcribe_groq(chunk)
        if text:
            texts.append(text)
        update_record(
            service, record_id, record, "processing", provider="groq",
            chunksDone=index, chunksTotal=len(chunks),
            phase=f"Fragmento {index} de {len(chunks)} listo", progressMode="chunks",
        )
    result = "\n\n".join(texts).strip()
    if result:
        update_record(
            service, record_id, record, "processing", provider="groq",
            chunksDone=len(chunks), chunksTotal=len(chunks),
            phase="Uniendo fragmentos", progressMode="indeterminate",
        )
    if not result:
        raise RuntimeError("Groq devolvió una transcripción vacía")
    return result


def upload_result(service, folder_id: str, filename: str, text: str) -> str:
    payload = io.BytesIO((text.rstrip() + "\n").encode("utf-8"))
    media = MediaInMemoryUpload(payload.getvalue(), mimetype="text/plain", resumable=False)
    result = service.files().create(
        body={"name": filename, "parents": [folder_id], "mimeType": "text/plain"},
        media_body=media,
        fields="id",
        supportsAllDrives=True,
    ).execute()
    return result["id"]


def process_job(service, record_id: str, results_folder_id: str) -> None:
    record = read_record(service, record_id)
    if record.get("status") not in ("queued", "processing") or not record.get("driveFileId"):
        return
    name = str(record.get("filename", "video"))
    print(f"Procesando: {name}")
    update_record(
        service, record_id, record, "processing", provider="gemini",
        chunksDone=0, chunksTotal=0, phase="Descargando desde Drive",
        progressMode="indeterminate", error=None,
    )
    try:
        with tempfile.TemporaryDirectory(prefix="transcriptor-") as temporary:
            workdir = Path(temporary)
            suffix = Path(name).suffix or ".mp4"
            video_path = workdir / f"entrada_video{suffix}"
            download_drive_file(service, str(record["driveFileId"]), video_path)
            try:
                if force_groq_for_test(name):
                    raise RuntimeError("429 quota simulada para prueba")
                update_record(service, record_id, record, "processing", provider="gemini", chunksDone=0, chunksTotal=0, phase="Subiendo video a Gemini", progressMode="indeterminate")
                update_record(service, record_id, record, "processing", provider="gemini", chunksDone=0, chunksTotal=0, phase="Analizando el video con Gemini", progressMode="indeterminate")
                text = transcribe_with_gemini(video_path)
                provider = "gemini"
                print("  Transcripción terminada con Gemini")
            except Exception as gemini_error:
                if not is_quota_error(gemini_error):
                    raise
                print(f"  Gemini agotó la cuota; usando Groq: {gemini_error}")
                text = transcribe_with_groq(video_path, service, record_id, record, workdir)
                provider = "groq"
            result_name = Path(name).stem + ".txt"
            result_folder = str(record.get("resultsFolderId") or results_folder_id)
            update_record(service, record_id, record, "processing", provider=provider, chunksDone=1 if provider == "gemini" else record.get("chunksDone", 0), chunksTotal=1 if provider == "gemini" else record.get("chunksTotal", 0), phase="Guardando TXT", progressMode="indeterminate")
            result_id = upload_result(service, result_folder, result_name, text)
        cleanup_temp_drive(service, record)
        update_record(service, record_id, record, "completed", provider=provider, chunksDone=1, chunksTotal=1, phase="TXT listo", progressMode="complete", resultFileId=result_id, resultName=result_name, error=None)
        print("  Listo; video y carpeta temporal eliminados")
    except Exception as error:
        print(f"  ERROR: {error}")
        try:
            cleanup_temp_drive(service, record)
        finally:
            update_record(service, record_id, record, "error", phase="No se pudo completar", progressMode="complete", error=str(error)[:1000])


def main() -> None:
    load_env_file()
    global GEMINI_API_KEY, GROQ_API_KEY, GEMINI_MODEL, GROQ_MODEL, LANGUAGE, FRAGMENT_SECONDS
    GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
    GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
    GEMINI_MODEL = os.getenv("GEMINI_MODEL", GEMINI_MODEL)
    GROQ_MODEL = os.getenv("GROQ_MODEL", GROQ_MODEL)
    LANGUAGE = os.getenv("TRANSCRIPTION_LANGUAGE", LANGUAGE)
    FRAGMENT_SECONDS = int(os.getenv("GROQ_FRAGMENT_SECONDS", str(FRAGMENT_SECONDS)))
    parent_id = require_env("GOOGLE_DRIVE_PARENT_FOLDER_ID")
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="procesa los trabajos disponibles y termina")
    parser.add_argument("--poll", type=int, default=10, help="segundos entre revisiones")
    args = parser.parse_args()
    service = drive_service()
    control_id = os.getenv("GOOGLE_DRIVE_CONTROL_FOLDER_ID") or ensure_drive_folder(service, "Transcriptor - Control", parent_id, "control")
    results_id = os.getenv("GOOGLE_DRIVE_RESULTS_FOLDER_ID") or ensure_drive_folder(service, "Transcriptor - Resultados", parent_id, "results")
    while True:
        jobs = []
        for record_id in list_job_ids(service, control_id):
            try:
                record = read_record(service, record_id)
                if record.get("status") in ("queued", "processing") and record.get("driveFileId"):
                    jobs.append(record_id)
            except Exception as error:
                print(f"Aviso: no se pudo leer {record_id}: {error}")
        for record_id in jobs:
            process_job(service, record_id, results_id)
        if args.once or not jobs:
            if args.once:
                return
        time.sleep(max(2, args.poll))


if __name__ == "__main__":
    main()
