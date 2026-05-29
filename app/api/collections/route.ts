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
    if (!foundSeries) seriesMap.set(model, [model]);
  }
  return seriesMap;
}

async function fetchAllSets(): Promise<{ id: string; name: string }[]> {
  const results: { id: string; name: string }[] = [];
  let nextUrl: string | null = `${GRAPH_URL}?fields=id,name&limit=100`;
  while (nextUrl) {
    const res: Response = await fetch(nextUrl, { headers: AT_HEADERS });
    const json = await res.json();
    if (!res.ok) throw new Error(`Meta GET: ${JSON.stringify(json.error)}`);
    results.push(...(json.data ?? []));
    nextUrl = json.paging?.next ?? null;
  }
  return results;
}

async function createSet(
  name: string,
  filter: string,
  parentId?: string
): Promise<{ id: string } | "duplicate" | "error"> {
  const body: Record<string, string> = { name: name.trim(), filter };
  if (parentId) body.parent_id = parentId;

  const res: Response = await fetch(GRAPH_URL, {
    method: "POST",
    headers: AT_HEADERS,
    body: JSON.stringify(body),
  });
  const json = await res.json();
  console.log(`[collections] Respuesta para "${name}":`, JSON.stringify(json));
  if (res.ok) return { id: json.id };
  if (json.error?.error_subcode === 1798073) return "duplicate";
  console.error(`[collections] Error creando "${name}":`, JSON.stringify(json.error));
  return "error";
}

export async function POST() {
  try {
    // 1. Leer marca+modelo únicos desde Supabase
    const { data, error } = await supabase
      .from("supplier_products")
      .select("brand, model")
      .eq("businessId", BUSINESS_ID)
      .eq("inOffice", true)
      .not("brand", "is", null)
      .not("model", "is", null);

    if (error) throw new Error(`Supabase: ${error.message}`);

    // Agrupar modelos por marca
    const brandMap = new Map<string, { brandRaw: string; models: Set<string> }>();
    for (const p of data ?? []) {
      const brand = stripHtml(p.brand ?? "").trim();
      const model = stripHtml(p.model ?? "").trim();
      if (!brand || !model) continue;
      const key = brand.toLowerCase();
      if (!brandMap.has(key)) brandMap.set(key, { brandRaw: brand, models: new Set() });
      brandMap.get(key)!.models.add(model.toLowerCase());
    }

    console.log("[collections] Marcas:", brandMap.size);

    // 2. Leer conjuntos existentes en Meta (indexados por nombre en minúsculas)
    const existing = await fetchAllSets();
    const existingByName = new Map<string, string>();
    for (const s of existing) existingByName.set(s.name.toLowerCase(), s.id);

    console.log("[collections] Existentes en Meta:", existing.length);

    const createdParents: string[] = [];
    const createdChildren: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];

    // 3. Por cada marca: crear conjunto padre + conjuntos hijo por serie
    for (const [, { brandRaw, models }] of brandMap) {
      // --- Conjunto padre (marca) ---
      let parentId = existingByName.get(brandRaw.toLowerCase());
      if (parentId) {
        skipped.push(brandRaw);
      } else {
        const parentFilter = JSON.stringify({ brand: { eq: brandRaw.trim() } });
        const result = await createSet(brandRaw, parentFilter);
        if (result === "error") {
          failed.push(brandRaw);
          console.error("[collections] No se pudo crear padre:", brandRaw);
          continue;
        } else if (result === "duplicate") {
          skipped.push(brandRaw);
          continue;
        } else {
          parentId = result.id;
          createdParents.push(brandRaw);
          console.log("[collections] Padre creado:", brandRaw, "id:", parentId);
        }
      }

      // --- Conjuntos hijo por serie ---
      const seriesMap = groupModelsBySeries([...models]);
      for (const [seriesBase, seriesModels] of seriesMap) {
        const childName = `${brandRaw} ${seriesBase}`;
        if (existingByName.has(childName.toLowerCase())) {
          skipped.push(childName);
          continue;
        }
        const childFilter = JSON.stringify({
          and: [
            { brand: { eq: brandRaw.trim() } },
            { or: seriesModels.map((m) => ({ custom_label_0: { eq: m.trim() } })) },
          ],
        });
        const result = await createSet(childName, childFilter, parentId);
        if (result === "error") {
          failed.push(childName);
        } else if (result === "duplicate") {
          skipped.push(childName);
        } else {
          createdChildren.push(childName);
          console.log("[collections] Hijo creado:", childName, "| modelos:", seriesModels.join(", "));
        }
      }
    }

    return NextResponse.json({
      createdParents,
      createdChildren,
      skipped,
      failed,
      message: `${createdParents.length} marcas nuevas, ${createdChildren.length} series nuevas, ${skipped.length} ya existían${failed.length ? `, ${failed.length} fallaron` : ""}.`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    console.error("[collections] ERROR:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const collections = await fetchAllSets();
    console.log("[collections] Eliminando", collections.length, "conjuntos...");

    let deleted = 0;
    const failed: string[] = [];

    for (const { id, name } of collections) {
      const res: Response = await fetch(`https://graph.facebook.com/v19.0/${id}`, {
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
