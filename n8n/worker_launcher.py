"""Lanza una sola ejecución del worker sin crear procesos duplicados.

Pensado para ser llamado desde un nodo Execute Command de n8n en un VPS.
El worker real sigue siendo worker_largos.py.
"""

from __future__ import annotations

import fcntl
import os
import subprocess
import sys
from pathlib import Path


project_dir = Path(os.environ.get("TRANSCRIPTOR_PROJECT_DIR", "/opt/transcriptor")).resolve()
python_bin = os.environ.get("TRANSCRIPTOR_PYTHON", sys.executable)
lock_path = Path(os.environ.get("TRANSCRIPTOR_LOCK_FILE", "/tmp/transcriptor-worker.lock"))
log_path = Path(os.environ.get("TRANSCRIPTOR_LOG_FILE", "/tmp/transcriptor-worker.log"))
worker_path = project_dir / "worker_largos.py"

if not worker_path.is_file():
    raise SystemExit(f"No se encontró el worker: {worker_path}")

lock_path.parent.mkdir(parents=True, exist_ok=True)
log_path.parent.mkdir(parents=True, exist_ok=True)

lock_handle = lock_path.open("w")
try:
    fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print("El worker ya está ejecutándose; no se inicia otro.")
    lock_handle.close()
    raise SystemExit(0)

log_handle = log_path.open("a", encoding="utf-8")
process = subprocess.Popen(
    [python_bin, str(worker_path), "--once"],
    cwd=project_dir,
    stdin=subprocess.DEVNULL,
    stdout=log_handle,
    stderr=subprocess.STDOUT,
    start_new_session=True,
    pass_fds=(lock_handle.fileno(),),
)
log_handle.close()
print(f"Worker iniciado en segundo plano (PID {process.pid}). Log: {log_path}")
