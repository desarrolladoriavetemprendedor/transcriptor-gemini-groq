# Worker de videos largos

El worker procesa los trabajos que la web deja en Drive. No usa Whisper local,
PyTorch, CUDA ni la tarjeta de video. FFmpeg se usa unicamente en CPU para
extraer y partir el audio cuando se necesita Groq; Gemini y Groq hacen la
transcripcion en la nube.

## Donde se ejecuta

No se usa Google Colab. El worker debe ejecutarse en un servicio persistente,
por ejemplo Railway, Render, Cloud Run con una instancia minima activa, o una
maquina virtual. El archivo `Dockerfile.worker` ya instala Python, FFmpeg y
las dependencias necesarias.

Variables requeridas en ese servicio:

```env
GEMINI_API_KEY=...
GROQ_API_KEY=...
GEMINI_MODEL=gemini-3.7-flash
GROQ_MODEL=whisper-large-v3-turbo
TRANSCRIPTION_LANGUAGE=es
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
GOOGLE_DRIVE_PARENT_FOLDER_ID=...
```

Las carpetas `Transcriptor - Control` y `Transcriptor - Resultados` se crean
automaticamente dentro de la carpeta principal. No hace falta configurar IDs
separados para ellas.

## Generar el refresh token

El client ID y el secreto identifican la aplicacion, pero Google necesita una
autorizacion de tu cuenta para permitir acceso permanente al Drive. Genera esa
autorizacion una sola vez en tu PC:

```bash
pip install google-auth-oauthlib
python obtener_refresh_token.py client_secret.json
```

Copia las tres lineas que imprime a las variables del servicio persistente y a
`web/.env.local`. No subas `client_secret.json` ni el refresh token al
repositorio.

## Ejecutarlo sin Docker

```bash
pip install -r worker_largos_requirements.txt
python worker_largos.py --poll 10
```

## Ejecutarlo con Docker

```bash
docker build -f Dockerfile.worker -t transcriptor-worker .
docker run --env-file worker.env transcriptor-worker
```

La web en Vercel sube cada video por partes y consulta el estado. El worker
descarga temporalmente el video, intenta Gemini y solo si Gemini agota cuota
extrae audio con FFmpeg en CPU para enviar fragmentos a Groq. Al terminar sube
el TXT a Drive y elimina el video original y la carpeta temporal. Si ocurre un
error tambien elimina esos archivos y deja el trabajo como `error`.

Para una prueba controlada se puede configurar opcionalmente
`FORCE_GROQ_FILENAMES=video 2.mp4`; eso simula una cuota agotada de Gemini
solo para ese nombre y no debe configurarse en producción.
