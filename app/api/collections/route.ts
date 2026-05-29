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

// Groups models by series: "iphone 11 pro" and "iphone 11 pro max" belong to series "iphone 11"
function groupModelsBySeries(models: string[]): Map<string, string[]> {
  const sorted = [...models].sort((a, b) => a.length - b.length);
  const seriesMap = new Map<string, string[]>();

  for (const model of sorted) {
    let foundSeries = false;
    for (const [base] of seriesMap) {
      if (model === base || model.startsWith(base + " ")) {
        seriesMap.get(base)!.push(model);
        foundSeries = true;
        break;
      }
    }
    if (!foundSeries) {
      seriesMap.set(model, [model]);
    }
  }

  return seriesMap;
}

async function getAllCollectionIds(): Promise<{ id: string; name: string }[]> {
  const results: { id: string; name: string }[] = [];
  let url: string | null = `${GRAPH_URL}?fields=id,name&limit=100`;
  while (url) {
    const res = await fetch(url, { headers: AT_HEADERS });
    const json = await res.json();
    if (!res.ok) throw new Error(`Meta GET: ${JSON.stringify(json.error)}`);
    results.push(...(json.data ?? []));
    url = json.paging?.next ?? null;
  }
  return results;
}

async function getExistingCollections(): Promise<Record<string, string>> {
  const results: { id: string; name: string }[] = [];
  let url: string | null = `${GRAPH_URL}?fields=id,name&limit=100`;
  while (url) {
    const res = await fetch(url, { headers: AT_HEADERS });
    const json = await res.json();
    if (!res.ok) throw new Error(`Meta GET collections: ${JSON.stringify(json.error)}`);
    results.push(...(json.data ?? []));
    url = json.paging?.next ?? null;
  }
  const map: Record<string, string> = {};
  for (const c of results) {
    map[c.name.toLowerCase()] = c.id;
  }
  return map;
}

async function createCollection(
  name: string,
  brand: string,
  models: string[]
): Promise<"created" | "duplicate" | "error"> {
  const filter = JSON.stringify({
    and: [
      { brand: { eq: brand.trim() } },
      { or: models.map((m) => ({ custom_label_0: { eq: m.trim() } })) },
    ],
  });
  console.log(`[collections] Creando "${name}" con filtro:`, filter);
  const res = await fetch(GRAPH_URL, {
    method: "POST",
    headers: AT_HEADERS,
    body: JSON.stringify({ name: name.trim(), filter }),
  });
  const json = await res.json();
  console.log(`[collections] Respuesta Meta para "${name}":`, JSON.stringify(json));
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

    // Deduplica por brand+model (normalizado a minúsculas para comparación)
    const brandModels = new Map<string, { brandRaw: string; models: Set<string> }>();
    for (const p of data ?? []) {
      const brand = stripHtml(p.brand ?? "").trim();
      const model = stripHtml(p.model ?? "").trim();
      if (!brand || !model) continue;
      const brandKey = brand.toLowerCase();
      if (!brandModels.has(brandKey)) {
        brandModels.set(brandKey, { brandRaw: brand, models: new Set() });
      }
      brandModels.get(brandKey)!.models.add(model.toLowerCase());
    }

    console.log("[collections] Marcas encontradas:", brandModels.size);

    // 2. Agrupar modelos por serie dentro de cada marca
    type CollectionDef = { name: string; brand: string; models: string[] };
    const collections: CollectionDef[] = [];

    for (const [, { brandRaw, models }] of brandModels) {
      const seriesMap = groupModelsBySeries([...models]);
      for (const [seriesBase, seriesModels] of seriesMap) {
        const name = `${brandRaw} ${seriesBase}`;
        collections.push({ name, brand: brandRaw, models: seriesModels });
      }
    }

    console.log("[collections] Colecciones a crear:", collections.length);

    // 3. Leer colecciones existentes en Meta
    const existing = await getExistingCollections();
    console.log("[collections] Colecciones existentes:", Object.keys(existing).length);

    // 4. Crear las que faltan
    const created: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];

    for (const { name, brand, models } of collections) {
      if (existing[name.toLowerCase()]) {
        skipped.push(name);
        continue;
      }
      const result = await createCollection(name, brand, models);
      if (result === "created") {
        created.push(name);
        console.log("[collections] Creada:", name, "| modelos:", models.join(", "));
      } else if (result === "duplicate") {
        skipped.push(name);
      } else {
        failed.push(name);
      }
    }

    return NextResponse.json({
      total: collections.length,
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

export async function DELETE() {
  try {
    const collections = await getAllCollectionIds();
    console.log("[collections] Eliminando", collections.length, "conjuntos...");

    let deleted = 0;
    const failed: string[] = [];

    for (const { id, name } of collections) {
      const res = await fetch(`https://graph.facebook.com/v19.0/${id}`, {
        method: "DELETE",
        headers: AT_HEADERS,
      });
      const json = await res.json();
      if (res.ok && json.success) {
        deleted++;
        console.log("[collections] Eliminado:", name);
      } else {
        failed.push(name);
        console.error("[collections] No se pudo eliminar:", name, JSON.stringify(json));
      }
    }

    return NextResponse.json({
      deleted,
      failed,
      message: `${deleted} conjuntos eliminados${failed.length ? `. No se pudieron eliminar: ${failed.join(", ")}` : ""}`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    console.error("[collections] DELETE ERROR:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
