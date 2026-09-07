import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

const SESSION_MINUTES = 20;

export async function POST() {
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_MINUTES * 60_000).toISOString();

  console.info(`[upload-session] creada ${id}; expira ${expiresAt}`);

  // En producción este registro debe persistirse en una base de datos y debe
  // crear una subida directa a Vercel Blob o una sesión resumible de Drive.
  // No se guarda estado en memoria porque las funciones de Vercel son efímeras.
  return NextResponse.json({
    id,
    token: id,
    expiresAt,
    uploadPrefix: `temp/${id}/`,
    mode: "demo",
  });
}
