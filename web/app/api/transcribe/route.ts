import { NextResponse } from "next/server";

export const runtime = "nodejs";

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

class ProviderError extends Error {
  status: number;
  quota: boolean;

  constructor(message: string, status = 500, quota = false) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.quota = quota;
  }
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new ProviderError(`Falta configurar ${name}`);
  return value;
}

function providerMessage(payload: unknown, fallback: string) {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string") return error;
    if (typeof error === "object" && error !== null && "message" in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
  }
  return fallback;
}

function isQuota(status: number, payload: unknown) {
  if (status === 429) return true;
  const text = JSON.stringify(payload).toLowerCase();
  return text.includes("resource_exhausted") || text.includes("quota") || text.includes("rate limit");
}

function extractGeminiText(payload: unknown) {
  const candidates = (payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }).candidates;
  const text = candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
  if (!text) throw new ProviderError("Gemini no devolvió texto", 502);
  return text;
}

async function transcribeWithGemini(file: File) {
  const key = required("GEMINI_API_KEY");
  const model = process.env.GEMINI_MODEL || "gemini-3.7-flash";
  const language = process.env.TRANSCRIPTION_LANGUAGE || "es";
  const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ parts: [
        { text: `Transcribe literalmente este video en ${language}. Devuelve únicamente la transcripción, sin resumen ni comentarios. Conserva párrafos naturales y no inventes palabras.` },
        { inline_data: { mime_type: file.type || "video/mp4", data: base64 } },
      ] }],
      generationConfig: { temperature: 0 },
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new ProviderError(providerMessage(payload, "Gemini rechazó la solicitud"), response.status, isQuota(response.status, payload));
  return extractGeminiText(payload);
}

async function transcribeWithGroq(file: File) {
  const key = required("GROQ_API_KEY");
  const model = process.env.GROQ_MODEL || "whisper-large-v3-turbo";
  const language = process.env.TRANSCRIPTION_LANGUAGE || "es";
  const form = new FormData();
  form.append("file", new Blob([await file.arrayBuffer()], { type: file.type || "video/mp4" }), file.name);
  form.append("model", model);
  form.append("language", language);
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");

  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  const payload = await response.json();
  if (!response.ok) throw new ProviderError(providerMessage(payload, "Groq rechazó la solicitud"), response.status, isQuota(response.status, payload));
  const text = typeof payload?.text === "string" ? payload.text.trim() : "";
  if (!text) throw new ProviderError("Groq no devolvió texto", 502);
  return text;
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  try {
    const data = await request.formData();
    const file = data.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "Debes enviar un archivo en el campo file", requestId }, { status: 400 });

    const maxBytes = Number(process.env.DIRECT_TRANSCRIPTION_MAX_BYTES || DEFAULT_MAX_BYTES);
    if (file.size > maxBytes) return NextResponse.json({ error: `El archivo supera el límite directo de ${Math.round(maxBytes / 1024 / 1024)} MB; debe seguir la ruta interna`, requestId }, { status: 413 });

    console.info(`[transcribe:${requestId}] inicio archivo=${file.name} bytes=${file.size}`);
    try {
      const text = await transcribeWithGemini(file);
      console.info(`[transcribe:${requestId}] completado proveedor=gemini`);
      return NextResponse.json({ text, provider: "gemini", requestId });
    } catch (error) {
      const providerError = error instanceof ProviderError ? error : new ProviderError(String(error));
      console.error(`[transcribe:${requestId}] Gemini error=${providerError.message}`);
      if (!providerError.quota) throw providerError;
      console.info(`[transcribe:${requestId}] cambiando a Groq por cuota o límite`);
      const text = await transcribeWithGroq(file);
      console.info(`[transcribe:${requestId}] completado proveedor=groq`);
      return NextResponse.json({ text, provider: "groq", fallback: true, requestId });
    }
  } catch (error) {
    const providerError = error instanceof ProviderError ? error : new ProviderError("Error interno de transcripción");
    console.error(`[transcribe:${requestId}] fallo=${providerError.message}`);
    return NextResponse.json({ error: providerError.message, requestId }, { status: providerError.status >= 400 ? providerError.status : 500 });
  }
}
