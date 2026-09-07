type WorkerNotification = {
  jobId: string;
  recordId: string;
  fileId?: string;
};

export async function notifyN8nWorker(payload: WorkerNotification) {
  const webhookUrl = process.env.N8N_WORKER_WEBHOOK_URL?.trim();
  if (!webhookUrl) return;

  const secret = process.env.N8N_WORKER_WEBHOOK_SECRET?.trim();
  if (!secret) throw new Error("Falta N8N_WORKER_WEBHOOK_SECRET");

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-worker-secret": secret,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`n8n respondió ${response.status}`);
  }
}
