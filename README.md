# Transcriptor Gemini + Groq

Aplicación web para transcribir videos usando Gemini como proveedor principal y Groq como respaldo cuando Gemini agota su cuota.

## Arquitectura

- Los videos pequeños se procesan desde la web.
- Los videos grandes se suben por partes a Google Drive.
- `worker_largos.py` descarga temporalmente los videos y actualiza el estado del trabajo.
- Gemini y Groq hacen la transcripción en la nube; no se usa GPU ni Whisper local.
- Cuando Groq es necesario, FFmpeg solo extrae y divide el audio usando CPU.
- Al terminar, el TXT se guarda en Drive y se eliminan el video y la carpeta temporal.

## Web

```powershell
cd web
npm install
npm run dev
```

Copia `web/.env.example` como `web/.env.local` y completa las claves de Gemini, Groq y Google Drive.

## Worker de videos largos

Instala las dependencias y ejecútalo desde la raíz:

```powershell
pip install -r worker_largos_requirements.txt
python worker_largos.py --poll 10
```

Para producción se puede usar `Dockerfile.worker` en un servicio persistente como Railway, Render, Cloud Run con instancia mínima o una máquina virtual.

Consulta [WORKER_LARGOS.md](WORKER_LARGOS.md) para configurar OAuth de Google Drive y el despliegue.

## Seguridad

No subas `.env.local`, claves API, `client_secret.json` ni refresh tokens. El repositorio ignora esas credenciales y también los videos de prueba.
