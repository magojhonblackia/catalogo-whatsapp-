import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function stripHtml(value: string | null | undefined): string {
  if (!value) return "";
  return value.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
}

const AIRTABLE_TOKEN = process.env.AIRTABLE_API_KEY!;
const BASE_ID = process.env.AIRTABLE_BASE_ID!;
const TABLE = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME!);
const BUSINESS_ID = process.env.BUSINESS_ID!;
const AT_BASE = `https://api.airtable.com/v0/${BASE_ID}/${TABLE}`;
const AT_HEADERS = {
  Authorization: `Bearer ${AIRTABLE_TOKEN}`,
  "Content-Type": "application/json",
};

type AirtableRecord = { id: string; fields: Record<string, unknown> };

async function atGet(): Promise<AirtableRecord[]> {
  const records: AirtableRecord[] = [];
  let offset: string | undefined;
  do {
    const url = offset
      ? `${AT_BASE}?fields%5B%5D=supplier_id&offset=${offset}`
      : `${AT_BASE}?fields%5B%5D=supplier_id`;
    const res = await fetch(url, { headers: AT_HEADERS });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Airtable GET ${res.status}: ${body}`);
    }
    const json = await res.json();
    records.push(...json.records);
    offset = json.offset;
  } while (offset);
  return records;
}

async function atCreate(batch: Record<string, unknown>[]) {
  const res = await fetch(AT_BASE, {
    method: "POST",
    headers: AT_HEADERS,
    body: JSON.stringify({ records: batch.map((fields) => ({ fields })) }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Airtable POST ${res.status}: ${body}`);
  }
}

async function atUpdate(batch: { id: string; fields: Record<string, unknown> }[]) {
  const res = await fetch(AT_BASE, {
    method: "PATCH",
    headers: AT_HEADERS,
    body: JSON.stringify({ records: batch }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Airtable PATCH ${res.status}: ${body}`);
  }
}

export async function POST() {
  try {
    console.log("[sync] INICIO — BUSINESS_ID:", BUSINESS_ID, "TABLE:", process.env.AIRTABLE_TABLE_NAME);

    // 1. Leer repuestos desde Supabase
    const { data: products, error } = await supabase
      .from("supplier_products")
      .select("id, name, description, price, salePrice, quality, brand, category, model, isNew, inOffice, createdAt")
      .eq("businessId", BUSINESS_ID)
      .order("createdAt", { ascending: false });

    if (error) throw new Error(`Supabase: ${error.message}`);
    console.log("[sync] Supabase OK — productos:", products?.length ?? 0);

    if (!products || products.length === 0) {
      return NextResponse.json({ synced: 0, message: "No hay repuestos para sincronizar." });
    }

    // 2. Leer registros existentes en Airtable
    console.log("[sync] Leyendo Airtable...");
    const existing = await atGet();
    const existingMap: Record<string, string> = {};
    for (const r of existing) {
      const sid = r.fields["supplier_id"] as string;
      if (sid) existingMap[sid] = r.id;
    }
    console.log("[sync] Airtable existentes:", Object.keys(existingMap).length);

    // 3. Separar en creates y updates
    const toCreate: Record<string, unknown>[] = [];
    const toUpdate: { id: string; fields: Record<string, unknown> }[] = [];

    for (const p of products) {
      const fields: Record<string, unknown> = {
        supplier_id: p.id,
        Nombre: stripHtml(p.name),
        Descripcion: stripHtml(p.description),
        Precio: p.price ?? 0,
        PrecioVenta: p.salePrice ?? 0,
        Calidad: stripHtml(p.quality),
        Marca: stripHtml(p.brand),
        Categoria: stripHtml(p.category),
        Modelo: stripHtml(p.model),
        EsNuevo: p.isNew ?? false,
        EnOficina: p.inOffice ?? false,
      };
      if (existingMap[p.id]) {
        toUpdate.push({ id: existingMap[p.id], fields });
      } else {
        toCreate.push(fields);
      }
    }
    console.log("[sync] A crear:", toCreate.length, "— A actualizar:", toUpdate.length);

    // 4. Crear en lotes de 10
    let created = 0;
    for (let i = 0; i < toCreate.length; i += 10) {
      await atCreate(toCreate.slice(i, i + 10));
      created += Math.min(10, toCreate.length - i);
    }

    // 5. Actualizar en lotes de 10
    let updated = 0;
    for (let i = 0; i < toUpdate.length; i += 10) {
      await atUpdate(toUpdate.slice(i, i + 10));
      updated += Math.min(10, toUpdate.length - i);
    }

    console.log("[sync] COMPLETO — creados:", created, "actualizados:", updated);
    return NextResponse.json({ synced: created + updated, created, updated, total: products.length });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    console.error("[sync] ERROR:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
