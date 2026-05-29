import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const BUSINESS_ID = process.env.BUSINESS_ID!;

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
}
const META_TOKEN = process.env.META_ACCESS_TOKEN!;
const CATALOG_ID = process.env.META_CATALOG_ID!;
const GRAPH_URL = `https://graph.facebook.com/v19.0/${CATALOG_ID}/product_sets`;

const AT_HEADERS = {
  Authorization: `Bearer ${META_TOKEN}`,
  "Content-Type": "application/json",
};

async function getExistingCollections(): Promise<Record<string, string>> {
  const res = await fetch(`${GRAPH_URL}?fields=id,name&limit=100`, { headers: AT_HEADERS });
  const json = await res.json();
  if (!res.ok) throw new Error(`Meta GET collections: ${JSON.stringify(json.error)}`);
  const map: Record<string, string> = {};
  for (const c of json.data ?? []) {
    map[c.name.toLowerCase()] = c.id;
  }
  return map;
}

async function createCollection(name: string, brand: string, model: string): Promise<"created" | "duplicate" | "error"> {
  const filter = JSON.stringify({
    brand: { i_contains: brand.trim() },
    custom_label_0: { i_contains: model.trim() },
  });
  const res = await fetch(GRAPH_URL, {
    method: "POST",
    headers: AT_HEADERS,
    body: JSON.stringify({ name: name.trim(), filter }),
  });
  const json = await res.json();
  if (res.ok) return "created";
  if (json.error?.error_subcode === 1798073) return "duplicate";
  console.error(`[collections] Error creando "${name}":`, JSON.stringify(json.error));
  return "error";
}

export async function POST() {
  try {
    // 1. Leer combinaciones únicas marca+modelo desde Supabase
    const { data, error } = await supabase
      .from("supplier_products")
      .select("brand, model")
      .eq("businessId", BUSINESS_ID)
      .eq("inOffice", true)
      .not("brand", "is", null)
      .not("model", "is", null);

    if (error) throw new Error(`Supabase: ${error.message}`);

    // Deduplica por brand+model
    const seen = new Set<string>();
    const pairs: { brand: string; model: string; name: string }[] = [];
    for (const p of data ?? []) {
      const brand = stripHtml(p.brand ?? "").trim();
      const model = stripHtml(p.model ?? "").trim();
      if (!brand || !model) continue;
      const key = `${brand}__${model}`.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        pairs.push({ brand, model, name: `${brand} ${model}` });
      }
    }
    console.log("[collections] Modelos encontrados:", pairs.length);

    // 2. Leer colecciones existentes en Meta
    const existing = await getExistingCollections();
    console.log("[collections] Colecciones existentes:", Object.keys(existing).length);

    // 3. Crear todas, manejar duplicados sin fallar
    const created: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];

    for (const { brand, model, name } of pairs) {
      if (existing[name.toLowerCase()]) {
        skipped.push(name);
        continue;
      }
      const result = await createCollection(name, brand, model);
      if (result === "created") {
        created.push(name);
        console.log("[collections] Creada:", name);
      } else if (result === "duplicate") {
        skipped.push(name);
      } else {
        failed.push(name);
      }
    }

    return NextResponse.json({
      total: pairs.length,
      created,
      skipped,
      failed,
      message: `${created.length} creadas, ${skipped.length} ya existían${failed.length ? `, ${failed.length} fallaron` : ""}.`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    console.error("[collections] ERROR:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
