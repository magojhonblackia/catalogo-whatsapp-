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
  filter: string
): Promise<{ id: string } | "duplicate" | "error"> {
  const res: Response = await fetch(GRAPH_URL, {
    method: "POST",
    headers: AT_HEADERS,
    body: JSON.stringify({ name: name.trim(), filter }),
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
    // 1. Leer marcas únicas desde Supabase
    const { data, error } = await supabase
      .from("supplier_products")
      .select("brand")
      .eq("businessId", BUSINESS_ID)
      .eq("inOffice", true)
      .not("brand", "is", null);

    if (error) throw new Error(`Supabase: ${error.message}`);

    // Deduplica marcas
    const brands = new Map<string, string>(); // key lowercase → raw value
    for (const p of data ?? []) {
      const brand = stripHtml(p.brand ?? "").trim();
      if (!brand) continue;
      if (!brands.has(brand.toLowerCase())) brands.set(brand.toLowerCase(), brand);
    }

    console.log("[collections] Marcas encontradas:", brands.size);

    // 2. Leer colecciones existentes en Meta
    const existing = await fetchAllSets();
    const existingByName = new Map<string, string>();
    for (const s of existing) existingByName.set(s.name.toLowerCase(), s.id);

    console.log("[collections] Existentes en Meta:", existing.length);

    const created: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];

    // 3. Crear una colección por marca con filtro brand eq
    for (const [, brandRaw] of brands) {
      if (existingByName.has(brandRaw.toLowerCase())) {
        skipped.push(brandRaw);
        continue;
      }

      const filter = JSON.stringify({ brand: { eq: brandRaw.trim() } });
      const result = await createSet(brandRaw, filter);

      if (typeof result === "object" && result.id) {
        created.push(brandRaw);
        console.log("[collections] Creada:", brandRaw);
      } else if (result === "duplicate") {
        skipped.push(brandRaw);
      } else {
        failed.push(brandRaw);
      }
    }

    return NextResponse.json({
      total: brands.size,
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
