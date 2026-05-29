import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const BUSINESS_ID = process.env.BUSINESS_ID!;
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

async function createCollection(name: string): Promise<"created" | "duplicate" | "error"> {
  const filter = JSON.stringify({ brand: { i_contains: name.trim() } });
  const res = await fetch(GRAPH_URL, {
    method: "POST",
    headers: AT_HEADERS,
    body: JSON.stringify({ name: name.trim(), filter }),
  });
  const json = await res.json();
  if (res.ok) return "created";
  // Error 1798073 = conjunto duplicado — ignorar
  if (json.error?.error_subcode === 1798073) return "duplicate";
  console.error(`[collections] Error creando "${name}":`, JSON.stringify(json.error));
  return "error";
}

export async function POST() {
  try {
    // 1. Leer marcas únicas desde Supabase
    const { data, error } = await supabase
      .from("supplier_products")
      .select("brand")
      .eq("businessId", BUSINESS_ID)
      .eq("inOffice", true)
      .not("brand", "is", null);

    if (error) throw new Error(`Supabase: ${error.message}`);

    const brands = [...new Set((data ?? []).map((p) => p.brand).filter(Boolean))] as string[];
    console.log("[collections] Marcas encontradas:", brands);

    // 2. Leer colecciones existentes en Meta
    const existing = await getExistingCollections();
    console.log("[collections] Colecciones existentes en Meta:", Object.keys(existing));

    // 3. Crear todas, manejar duplicados sin fallar
    const created: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];

    for (const brand of brands) {
      if (existing[brand.toLowerCase().trim()]) {
        skipped.push(brand);
        continue;
      }
      const result = await createCollection(brand);
      if (result === "created") {
        created.push(brand);
        console.log("[collections] Creada:", brand);
      } else if (result === "duplicate") {
        skipped.push(brand);
        console.log("[collections] Duplicada (ignorada):", brand);
      } else {
        failed.push(brand);
      }
    }

    return NextResponse.json({
      total: brands.length,
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
