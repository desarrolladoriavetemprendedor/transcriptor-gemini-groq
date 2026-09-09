"use client";

import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";

type Stage = "upload" | "messages" | "select" | "processing" | "done";
type FileKind = "web" | "drive" | "invalid";
type FileStatus = "ready" | "selected" | "omitted" | "uploading" | "processing" | "queued" | "done" | "invalid" | "failed";

type UploadFile = {
  id: string;
  file: File;
  kind: FileKind;
  status: FileStatus;
  durationSeconds: number | null;
  progress: number;
  provider?: string;
  chunksDone?: number;
  chunksTotal?: number;
  phase?: string;
  progressMode?: "percent" | "chunks" | "indeterminate" | "complete";
  driveRecordId?: string;
  driveFileId?: string;
};

type Result = { id: string; name: string; route: string; content?: string; driveFileId?: string };
type LogEntry = { id: string; time: string; level: "info" | "success" | "error"; message: string };

const MAX_WEB_BYTES = 4 * 1024 * 1024;
const MAX_WEB_DURATION = 15 * 60;
const LINK_TRANSCRIPTION_URL = "https://colab.research.google.com/drive/1Gqy5ylc_YMN7XnCjcBH6sTgK_oUTpa9v";

function formatBytes(value: number) {
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(seconds: number | null) {
  if (!seconds) return "duración pendiente";
  const minutes = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${secs} min`;
}

function isVideo(file: File) {
  if (file.type.startsWith("video/")) return true;
  return /\.(mp4|mov|mkv|webm|avi|m4v|mpeg|mpg)$/i.test(file.name);
}

function readDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const source = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(source);
      resolve(Number.isFinite(video.duration) ? video.duration : null);
    };
    video.onerror = () => {
      URL.revokeObjectURL(source);
      resolve(null);
    };
    video.src = source;
  });
}

function transcribeWebFile(file: File, onUploadProgress: (progress: number) => void): Promise<{ text: string; provider: string }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/transcribe");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onUploadProgress(Math.max(5, Math.min(45, 5 + Math.round(event.loaded / event.total * 40))));
    };
    request.onerror = () => reject(new Error("No se pudo enviar el archivo"));
    request.onload = () => {
      try {
        const data = JSON.parse(request.responseText) as { text?: string; provider?: string; error?: string };
        if (request.status < 200 || request.status >= 300) throw new Error(data.error || `HTTP ${request.status}`);
        resolve({ text: data.text || "", provider: data.provider || "gemini" });
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Respuesta invÃ¡lida del servidor"));
      }
    };
    const form = new FormData();
    form.append("file", file);
    request.send(form);
  });
}

function legacyStatusLabel(item: UploadFile) {
  if (item.status === "invalid") return "Se omitirá";
  if (item.status === "omitted") return "Omitido";
  if (item.status === "uploading") return "Subiendo";
  if (item.status === "processing" && item.provider === "groq" && item.chunksTotal) return `Groq ${item.chunksDone || 0}/${item.chunksTotal}`;
  if (item.status === "processing" && item.provider === "gemini") return "Gemini";
  if (item.status === "processing" && item.phase) return item.phase;
  if (item.status === "processing") return "Procesando";
  if (item.status === "queued") return "En espera";
  if (item.status === "done") return "Listo";
  if (item.status === "failed") return "Error";
  return "Listo";
}

function legacyProgressLabel(item: UploadFile) {
  if (item.phase) return item.phase;
  if (item.status === "uploading") return `Subiendo a Drive · ${item.progress}%`;
  if (item.status === "queued") return "En espera del worker";
  if (item.status === "processing" && item.provider === "groq" && item.chunksTotal) return `Groq · fragmento ${item.chunksDone || 0} de ${item.chunksTotal}`;
  if (item.status === "processing" && item.provider === "gemini") return "Gemini · transcribiendo en la nube";
  if (item.status === "processing") return "Transcribiendo en la nube";
  if (item.status === "done") return "TXT listo";
  return "";
}

function statusLabel(item: UploadFile) {
  if (item.status === "invalid") return "Se omitirá";
  if (item.status === "omitted") return "Omitido";
  if (item.status === "uploading") return "Subiendo";
  if (item.status === "processing") return "Procesando";
  if (item.status === "queued") return "Preparando";
  if (item.status === "done") return "Listo";
  if (item.status === "failed") return "No se pudo completar";
  return "Listo";
}

function progressLabel(item: UploadFile) {
  if (item.status === "uploading") return `Subiendo archivo · ${item.progress}%`;
  if (item.status === "queued") return "Preparando el procesamiento";
  const fragment = item.phase?.match(/(?:fragmento|Fragmento) (\d+) de (\d+)/);
  if (item.status === "processing" && fragment) return `Procesando parte ${fragment[1]} de ${fragment[2]}`;
  if (item.status === "processing" && item.phase?.includes("Uniendo")) return "Organizando la transcripción";
  if (item.status === "processing" && item.phase?.includes("Guardando")) return "Preparando el archivo de texto";
  if (item.status === "processing") return "Procesando el video";
  if (item.status === "done") return "Archivo listo";
  return "";
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const sessionStarted = useRef(false);
  const [stage, setStage] = useState<Stage>("upload");
  const [items, setItems] = useState<UploadFile[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [processingIndex, setProcessingIndex] = useState(0);
  const [processingTotal, setProcessingTotal] = useState(0);
  const [sessionReady, setSessionReady] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const validItems = useMemo(() => items.filter((item) => item.kind !== "invalid"), [items]);
  const selectedItems = useMemo(() => validItems.filter((item) => item.status === "selected"), [validItems]);
  const queuedItems = useMemo(() => items.filter((item) => item.status === "queued"), [items]);
  const activeItems = useMemo(() => items.filter((item) => ["uploading", "queued", "processing"].includes(item.status)), [items]);
  const trackedItems = useMemo(() => items.filter((item) => ["uploading", "queued", "processing", "done", "failed"].includes(item.status)), [items]);
  const overallProgress = trackedItems.length ? Math.round(trackedItems.reduce((total, item) => total + item.progress, 0) / trackedItems.length) : 0;
  const currentItem = activeItems[0] || trackedItems.find((item) => item.status === "processing") || trackedItems[trackedItems.length - 1];
  const currentIsIndeterminate = currentItem?.status === "processing" && currentItem.progressMode === "indeterminate";
  const currentHasChunks = currentItem?.status === "processing" && currentItem.progressMode === "chunks" && Boolean(currentItem.chunksTotal);
  const driveQueueKey = useMemo(() => items
    .filter((item) => item.driveRecordId && ["uploading", "queued", "processing"].includes(item.status))
    .map((item) => `${item.id}:${item.driveRecordId}:${item.status}`)
    .join("|"), [items]);
  const hasMessages = items.some((item) => item.kind === "invalid" || item.kind === "drive");

  useEffect(() => {
    if (sessionStarted.current) return;
    sessionStarted.current = true;
    void createInternalSession();
  }, []);

  useEffect(() => {
    if (stage !== "processing" || !driveQueueKey) return;
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      const currentJobs = items.filter((item) => item.driveRecordId && ["uploading", "queued", "processing"].includes(item.status));
      if (!currentJobs.length) return;
      let active = false;

      await Promise.all(currentJobs.map(async (item) => {
        try {
          const response = await fetch(`/api/drive/status?recordId=${encodeURIComponent(item.driveRecordId!)}`);
          const record = await response.json() as { status?: string; resultFileId?: string; error?: string; provider?: string; chunksDone?: number; chunksTotal?: number; phase?: string; progressMode?: UploadFile["progressMode"] };
          if (!response.ok) throw new Error(record.error || `HTTP ${response.status}`);
          const status = record.status || "queued";
          if (["queued", "uploading", "processing"].includes(status)) active = true;
          const progressMode = record.progressMode || (record.provider === "groq" && record.chunksTotal ? "chunks" : "indeterminate");
          const progress = status === "processing" && progressMode === "chunks" && record.chunksTotal
            ? Math.min(99, Math.round((record.chunksDone || 0) / record.chunksTotal * 100))
            : status === "processing" ? 1 : 0;
          if (status === "processing") {
            const phase = record.provider === "groq" && record.chunksTotal
              ? `Groq · fragmento ${record.chunksDone || 0} de ${record.chunksTotal}`
              : "Gemini · transcribiendo el video completo";
            setItems((all) => all.map((entry) => entry.id === item.id ? { ...entry, status: "processing", provider: record.provider, chunksDone: record.chunksDone, chunksTotal: record.chunksTotal, phase: record.phase || phase, progressMode, progress } : entry));
          } else if (status === "queued") {
            setItems((all) => all.map((entry) => entry.id === item.id ? { ...entry, status: "queued", phase: "En espera del worker", progressMode: undefined, progress: 0 } : entry));
          } else if (status === "completed" && record.resultFileId) {
            setItems((all) => all.map((entry) => entry.id === item.id ? { ...entry, status: "done", provider: record.provider, phase: "TXT listo", progressMode: "complete", progress: 100 } : entry));
            setResults((all) => all.some((result) => result.id === item.id) ? all : [...all, {
              id: item.id,
              name: item.file.name.replace(/\.[^/.]+$/, "") + ".txt",
              route: "Transcripción generada",
              driveFileId: record.resultFileId,
            }]);
            writeLog(`${item.file.name}: transcripción larga lista`, "success");
          } else if (status === "error") {
            setItems((all) => all.map((entry) => entry.id === item.id ? { ...entry, status: "failed", phase: "No se pudo completar", progress: 0 } : entry));
            writeLog(`${item.file.name}: ${record.error || "el worker devolvió un error"}`, "error");
          }
        } catch (error) {
          active = true;
          writeLog(`${item.file.name}: no se pudo consultar el estado`, "error", error);
        }
      }));

      if (!cancelled) {
        if (!active) {
          setBusy(false);
          setStage("done");
          writeLog("Procesamiento terminado; archivos temporales eliminados", "success");
        } else {
          timer = window.setTimeout(() => void poll(), 5000);
        }
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [stage, driveQueueKey]);

  function writeLog(message: string, level: LogEntry["level"] = "info", data?: unknown) {
    const prefix = `[Transcriptor] ${message}`;
    if (level === "error") console.error(prefix, data ?? "");
    else if (level === "success") console.info(prefix, data ?? "");
    else console.info(prefix, data ?? "");
    setLogs((current) => [...current.slice(-19), { id: `${Date.now()}-${Math.random()}`, time: new Date().toLocaleTimeString("es-PE"), level, message }]);
  }

  async function createInternalSession() {
    writeLog("Creando sesión interna de subida");
    try {
      const response = await fetch("/api/upload-session", { method: "POST" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setSessionReady(true);
      writeLog("Sesión interna lista", "success");
    } catch {
      setSessionReady(false);
      writeLog("No se pudo crear la sesión interna", "error");
    }
  }

  function cancelSession() {
    const recordIds = items
      .filter((item) => item.driveRecordId && ["uploading", "queued", "processing"].includes(item.status))
      .map((item) => item.driveRecordId!);
    if (recordIds.length) {
      void fetch("/api/drive/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordIds }),
      }).catch((error) => writeLog("No se pudo limpiar la cola de Drive", "error", error));
    }
    writeLog("Sesión cancelada; limpiando archivos temporales", "info");
    setItems([]);
    setResults([]);
    setStage("upload");
    setBusy(false);
    void createInternalSession();
  }

  async function inspectFiles(fileList: FileList | File[]) {
    setBusy(true);
    const incoming = Array.from(fileList);
    writeLog(`Validando ${incoming.length} archivo${incoming.length === 1 ? "" : "s"}`);
    const inspected = await Promise.all(incoming.map(async (file, index) => {
      const valid = isVideo(file);
      const durationSeconds = valid ? await readDuration(file) : null;
      const tooLarge = file.size > MAX_WEB_BYTES || (durationSeconds !== null && durationSeconds > MAX_WEB_DURATION);
      const kind: FileKind = !valid ? "invalid" : tooLarge ? "drive" : "web";
      writeLog(`${file.name}: ${!valid ? "omitido, no es video" : tooLarge ? "enrutado a procesamiento interno" : "video válido"}`);
      return {
        id: `${file.name}-${file.lastModified}-${index}`,
        file,
        kind,
        status: valid ? "selected" as FileStatus : "invalid" as FileStatus,
        durationSeconds,
        progress: 0,
      };
    }));
    setItems((current) => [...current, ...inspected]);
    setBusy(false);
  }

  function onInput(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files) void inspectFiles(event.target.files);
    event.target.value = "";
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length) void inspectFiles(event.dataTransfer.files);
  }

  function toggleSelection(id: string) {
    setItems((current) => current.map((item) => item.id === id
      ? { ...item, status: item.status === "selected" ? "ready" : "selected" }
      : item));
  }

  function selectAll() {
    setItems((current) => current.map((item) => item.kind === "invalid" ? item : { ...item, status: "selected" }));
  }

  function nextStep() {
    writeLog(`Siguiente paso solicitado; mensajes=${hasMessages}`);
    if (hasMessages) {
      setStage("messages");
      return;
    }
    void processSelected();
  }

  function continueAfterMessages() {
    writeLog(`Avisos revisados; videos válidos=${validItems.length}`);
    if (validItems.length > 1) {
      setStage("select");
      return;
    }
    if (validItems.length === 1) {
      void processSelected([validItems[0].id]);
      return;
    }
    setStage("select");
  }

  async function processSelected(ids = selectedItems.map((item) => item.id)) {
    const chosen = validItems.filter((item) => ids.includes(item.id));
    if (!chosen.length) {
      writeLog("No hay videos seleccionados para procesar", "error");
      return;
    }
    writeLog(`Iniciando procesamiento de ${chosen.length} video${chosen.length === 1 ? "" : "s"}`);
    const chosenIds = new Set(chosen.map((item) => item.id));
    setItems((current) => current.map((item) => item.kind === "invalid"
      ? item
      : chosenIds.has(item.id) ? { ...item, status: "processing", progress: 0, provider: undefined, chunksDone: undefined, chunksTotal: undefined, phase: "Preparando archivo" } : { ...item, status: "omitted", progress: 0 }));
    setStage("processing");
    setProcessingIndex(0);
    setProcessingTotal(chosen.length);
    setBusy(true);

    const generated: Result[] = [];
    let pendingLong = false;
    for (let index = 0; index < chosen.length; index += 1) {
      const current = chosen[index];
      writeLog(`Procesando ${current.file.name}`);
      setProcessingIndex(index);
      try {
        setItems((all) => all.map((item) => item.id === current.id ? { ...item, progress: current.kind === "web" ? 15 : 0, phase: current.kind === "web" ? "Enviando a la nube" : "Preparando subida a Drive" } : item));
        let text = "";
        let route = "Transcripción generada";
        if (current.kind === "web") {
          const data = await transcribeWebFile(current.file, (progress) => setItems((all) => all.map((item) => item.id === current.id ? { ...item, progress, phase: `Subiendo archivo · ${progress}%` } : item)));
          setItems((all) => all.map((item) => item.id === current.id ? { ...item, progress: 55, phase: "Gemini/Groq · transcribiendo en la nube" } : item));
          text = data.text;
          setItems((all) => all.map((item) => item.id === current.id ? { ...item, progress: 85, provider: data.provider, phase: `${data.provider === "groq" ? "Groq" : "Gemini"} · respuesta recibida` } : item));
          writeLog(`${current.file.name}: respuesta recibida de ${data.provider}`, "success");
        } else {
          pendingLong = true;
          setItems((all) => all.map((item) => item.id === current.id ? { ...item, status: "uploading", progressMode: "percent", progress: 0, phase: "Preparando subida a Drive" } : item));
          const uploaded = await uploadLargeToDrive(current);
          setItems((all) => all.map((item) => item.id === current.id ? {
            ...item,
            status: "queued",
            progressMode: undefined,
            progress: 0,
            phase: "En espera del worker",
            driveRecordId: uploaded.recordId,
            driveFileId: uploaded.fileId,
          } : item));
          writeLog(`${current.file.name}: subido a Drive, esperando worker`);
          continue;
        }
        setItems((all) => all.map((item) => item.id === current.id ? { ...item, progressMode: "complete", progress: 100, status: "done", phase: "TXT listo" } : item));
        generated.push({ id: current.id, name: current.file.name.replace(/\.[^/.]+$/, "") + ".txt", route, content: text + "\n" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Error desconocido";
        writeLog(`${current.file.name}: ${message}`, "error");
        setItems((all) => all.map((item) => item.id === current.id ? { ...item, status: "failed", phase: "No se pudo completar", progress: 0 } : item));
      }
    }
    setResults(generated);
    if (pendingLong) {
      setBusy(false);
      setStage("processing");
      writeLog("Hay archivos en espera; no se muestran descargas todavía");
      return;
    }
    setResults(generated);
    setBusy(false);
    setStage("done");
    writeLog("Procesamiento terminado; archivos temporales marcados para eliminación", "success");
  }

  async function uploadLargeToDrive(item: UploadFile) {
    const sessionResponse = await fetch("/api/drive/upload-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: item.file.name, mimeType: item.file.type || "video/mp4", size: item.file.size }),
    });
    const session = await sessionResponse.json() as { sessionUrl?: string; recordId?: string; jobId?: string; error?: string };
    if (!sessionResponse.ok || !session.sessionUrl || !session.recordId || !session.jobId) throw new Error(session.error || `No se pudo preparar la subida (HTTP ${sessionResponse.status})`);

    const chunkSize = 3 * 1024 * 1024;
    let start = 0;
    let fileId = "";
    while (start < item.file.size) {
      const end = Math.min(start + chunkSize, item.file.size);
      const response = await fetch("/api/drive/upload-chunk", {
        method: "PUT",
        headers: {
          "Content-Type": item.file.type || "application/octet-stream",
          "Content-Range": `bytes ${start}-${end - 1}/${item.file.size}`,
          "x-drive-upload-session": session.sessionUrl,
          "x-drive-record-id": session.recordId,
          "x-drive-job-id": session.jobId,
        },
        body: item.file.slice(start, end),
      });
      const data = await response.json() as { fileId?: string; error?: string };
      if (!response.ok) throw new Error(data.error || `Falló una parte de la subida (HTTP ${response.status})`);
      start = end;
      fileId = data.fileId || fileId;
      const progress = Math.min(98, Math.round(start / item.file.size * 95) + 5);
      setItems((all) => all.map((entry) => entry.id === item.id ? { ...entry, status: "uploading", progress, phase: `Subiendo a Drive · ${progress}%` } : entry));
    }
    return { recordId: session.recordId, fileId };
  }

  function downloadResult(result: Result) {
    writeLog(`Descargando ${result.name}`, "info");
    void (async () => {
      try {
        const response = result.driveFileId
          ? await fetch(`/api/drive/result?fileId=${encodeURIComponent(result.driveFileId)}`)
          : null;
        if (response && !response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = response
          ? await response.blob()
          : new Blob([result.content || ""], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = result.name;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        writeLog(`${result.name} descargado`, "success");
      } catch (error) {
        writeLog(`${result.name}: no se pudo descargar`, "error", error);
      }
    })();
  }

  const actionLabel = hasMessages ? "Siguiente" : "Procesar";

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">T</span><span>Transcriptor Pecuarius</span></div>
        <div className="topbar-actions">
          <a className="button button-link" href={LINK_TRANSCRIPTION_URL} target="_blank" rel="noreferrer">
            Procesar por Enlace
          </a>
          <div className={`connection ${sessionReady ? "online" : ""}`}><span />{sessionReady ? "Listo" : "Conectando"}</div>
        </div>
      </header>

      <section className="content">
        {stage !== "done" && <div className="intro"><h1>Sube tus videos</h1></div>}

        <section className="card workspace">
          {stage === "upload" && <>
            <div className={`upload-zone ${dragging ? "dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
              <div className="upload-icon">↑</div>
              <h2>Arrastra tus videos aquí</h2>
              <p>o elígelos desde tu equipo</p>
              <button className="button button-primary" onClick={() => inputRef.current?.click()} disabled={busy}>Elegir videos</button>
              <input ref={inputRef} className="file-input" type="file" multiple accept="*/*" onChange={onInput} />
            </div>
            {items.length > 0 && <><div className="list-heading"><strong>{items.length} archivo{items.length === 1 ? "" : "s"}</strong>{validItems.length > 1 && <span>Selecciona los que quieras procesar</span>}</div><FileList items={items} selectable={validItems.length > 1} onToggle={toggleSelection} /></>}
            <Actions onCancel={cancelSession} primaryLabel={actionLabel} onPrimary={nextStep} primaryDisabled={busy || !items.length || !validItems.length || (validItems.length > 1 && !selectedItems.length)} />
          </>}

          {stage === "messages" && <>
            <div className="section-title"><span className="step">01</span><div><h2>Revisa estos avisos</h2><p>Los archivos no válidos se omitirán.</p></div></div>
            <MessageList items={items} />
            <Actions onCancel={cancelSession} primaryLabel="Siguiente" onPrimary={continueAfterMessages} primaryDisabled={false} />
          </>}

          {stage === "select" && <>
            <div className="section-title"><span className="step">02</span><div><h2>Elige qué procesar</h2><p>Los demás archivos se omitirán y se eliminarán.</p></div></div>
            <FileList items={items} selectable onToggle={toggleSelection} />
            <div className="list-tools"><span>{selectedItems.length} seleccionados</span><button className="text-button" onClick={selectAll}>Seleccionar todos</button></div>
            <Actions onCancel={cancelSession} primaryLabel="Procesar" onPrimary={() => processSelected()} primaryDisabled={!selectedItems.length} />
          </>}

          {stage === "processing" && <>
            <div className="progress-summary">
              <div className="progress-summary-head"><strong>{currentIsIndeterminate ? "Procesando" : currentHasChunks ? "Fragmentos procesados" : "Avance general"}</strong><strong>{currentIsIndeterminate ? "…" : currentHasChunks ? `${currentItem?.chunksDone || 0}/${currentItem?.chunksTotal}` : `${overallProgress}%`}</strong></div>
              {currentIsIndeterminate ? <div className="progress-track progress-track-large is-indeterminate"><span /></div> : currentHasChunks ? <FragmentProgress done={currentItem?.chunksDone || 0} total={currentItem?.chunksTotal || 0} /> : <div className="progress-track progress-track-large"><span style={{ width: `${overallProgress}%` }} /></div>}
              {currentItem && <p><span>Archivo actual:</span> <strong>{currentItem.file.name}</strong><br /><small>{progressLabel(currentItem)}</small></p>}
            </div>
            <div className="section-title"><span className="step">03</span><div><h2>{queuedItems.length ? "Videos en espera" : "Procesando videos"}</h2><p>{queuedItems.length ? "El resultado aparecerá cuando termine." : `${processingIndex + 1} de ${processingTotal}`}</p></div></div>
            <FileList items={items} />
            <Actions onCancel={cancelSession} primaryLabel="Procesando…" onPrimary={() => undefined} primaryDisabled />
          </>}

          {stage === "done" && <>
            <div className="done-head"><span className="done-mark">✓</span><div><p className="eyebrow">PROCESO TERMINADO</p><h1>Transcripciones listas</h1><p className="subtitle">Los archivos temporales ya fueron eliminados.</p></div></div>
            <div className="result-list">{results.map((result) => <div className="result" key={result.id}><span className="result-file">TXT</span><div className="file-info"><strong>{result.name}</strong><small>{result.route}</small></div><button className="text-button" onClick={() => downloadResult(result)}>Descargar</button></div>)}</div>
            <Actions onCancel={cancelSession} primaryLabel="Nueva transcripción" onPrimary={cancelSession} primaryDisabled={false} />
          </>}
          <details className="activity-panel">
            <summary>Detalles del proceso ({logs.length})</summary>
            <div className="activity-list">{logs.length === 0 ? <span className="activity-empty">Sin eventos todavía.</span> : logs.map((log) => <div className={`activity-line ${log.level}`} key={log.id}><time>{log.time}</time><span>{log.message}</span></div>)}</div>
          </details>
        </section>
      </section>
    </main>
  );
}

function Actions({ onCancel, primaryLabel, onPrimary, primaryDisabled }: { onCancel: () => void; primaryLabel: string; onPrimary: () => void; primaryDisabled: boolean }) {
  return <div className="footer-actions"><button className="button button-cancel" onClick={onCancel}>Cancelar</button><button className="button button-primary" onClick={onPrimary} disabled={primaryDisabled}>{primaryLabel}</button></div>;
}

function MessageList({ items }: { items: UploadFile[] }) {
  return <div className="message-list">{items.filter((item) => item.kind === "invalid" || item.kind === "drive").map((item) => <div className="message" key={item.id}><span>{item.kind === "invalid" ? "!" : "↗"}</span><div><strong>{item.file.name}</strong><br />{item.kind === "invalid" ? "No es un archivo de video y será eliminado." : "Se procesará automáticamente."}</div></div>)}</div>;
}

function FileList({ items, selectable = false, onToggle }: { items: UploadFile[]; selectable?: boolean; onToggle?: (id: string) => void }) {
  return <div className="file-list">{items.map((item) => <div className="file-row" key={item.id}>
    {selectable && item.kind !== "invalid" && <input type="checkbox" checked={item.status === "selected"} onChange={() => onToggle?.(item.id)} aria-label={`Seleccionar ${item.file.name}`} />}
    <span className="file-symbol">{item.kind === "invalid" ? "!" : "▣"}</span>
    <div className="file-info"><div className="file-name">{item.file.name}</div><div className="file-meta">{formatBytes(item.file.size)} · {formatDuration(item.durationSeconds)}{item.progress > 0 && item.progress < 100 ? ` · ${item.progress}%` : ""}</div></div>
    <span className={`status ${item.kind === "invalid" || item.status === "failed" ? "status-bad" : item.status === "queued" ? "status-drive" : "status-web"}`}>{statusLabel(item)}</span>
  </div>)}</div>;
}

function FragmentProgress({ done, total }: { done: number; total: number }) {
  if (!total) return null;
  return <div className="fragment-progress" aria-label={`${done} de ${total} fragmentos procesados`}>
    {Array.from({ length: total }, (_, index) => <span className={index < done ? "complete" : ""} key={index} />)}
  </div>;
}
