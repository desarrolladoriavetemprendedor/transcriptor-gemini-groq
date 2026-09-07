# Transcriptor

MVP web preparado para Vercel. Conserva los notebooks existentes en la raiz y vive de forma independiente dentro de `web/`.

## Ejecutar

```bash
npm install
npm run dev
```

Despues abre `http://localhost:3000`.

## Variables de entorno

Copia `.env.example` como `.env.local` y completa las claves de Gemini y Groq.
Para videos largos también completa las variables OAuth de Google Drive. Las
claves nunca deben usar el prefijo `NEXT_PUBLIC_`.

## Integracion actual

- `POST /api/upload-session`: crea la sesion temporal interna.
- `POST /api/transcribe`: recibe un archivo pequeno, intenta Gemini y cambia a Groq si Gemini devuelve cuota o limite.
- El limite directo esta en `DIRECT_TRANSCRIPTION_MAX_BYTES` y por defecto es 4 MB debido al limite de cuerpo de las funciones de Vercel.
- Los archivos que superen ese limite se suben por partes a Drive y quedan en cola para `worker_largos.py`.
- Los archivos que no sean video se omiten.
- La pantalla consulta el estado del worker y solo muestra la descarga cuando el TXT existe.
- La pantalla muestra actividad tecnica y logs en la consola del navegador y del servidor.

## Worker de videos largos

El worker está en la raíz del proyecto. Consulta `WORKER_LARGOS.md` para
instalarlo en Colab y ejecutarlo. No usa GPU ni modelos locales: FFmpeg solo
extrae audio en CPU; la transcripción la realizan Gemini o Groq.
