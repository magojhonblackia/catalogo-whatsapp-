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

const DEFAULT_TOKEN = process.env.META_ACCESS_TOKEN!;
const DEFAULT_CATALOG_ID = process.env.META_CATALOG_ID!;

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function graphUrl(catalogId: string) {
  return `https://graph.facebook.com/v22.0/${catalogId}/product_sets`;
}

async function fetchAllSets(catalogId: string, token: string): Promise<{ id: string; name: string }[]> {
  const results: { id: string; name: string }[] = [];
  let nextUrl: string | null = `${graphUrl(catalogId)}?fields=id,name&limit=100`;
  while (nextUrl) {
    const res: Response = await fetch(nextUrl, { headers: authHeaders(token) });
    const json = await res.json();
    if (!res.ok) throw new Error(`Meta GET: ${JSON.stringify(json.error)}`);
    results.push(...(json.data ?? []));
    nextUrl = json.paging?.next ?? null;
  }
  return results;
}

async function createSet(
  catalogId: string,
  token: string,
  name: string,
  filter: string
): Promise<{ id: string } | "duplicate" | "error"> {
  const res: Response = await fetch(graphUrl(catalogId), {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ name: name.trim(), filter }),
  });
  const json = await res.json();
  console.log(`[collections] Respuesta para "${name}":`, JSON.stringify(json));
  if (res.ok) return { id: json.id };
  if (json.error?.error_subcode === 1798073) return "duplicate";
  console.error(`[collections] Error creando "${name}":`, JSON.stringify(json.error));
  return "error";
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const catalogId: string = body.catalogId || DEFAULT_CATALOG_ID;
  const token: string = body.metaToken || DEFAULT_TOKEN;
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
    const existing = await fetchAllSets(catalogId, token);
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
      const result = await createSet(catalogId, token, brandRaw, filter);

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

export async function DELETE(request: Request) {
  const body = await request.json().catch(() => ({}));
  const catalogId: string = body.catalogId || DEFAULT_CATALOG_ID;
  const token: string = body.metaToken || DEFAULT_TOKEN;
  try {
    const collections = await fetchAllSets(catalogId, token);
    console.log("[collections] Eliminando", collections.length, "conjuntos...");

    let deleted = 0;
    const failed: string[] = [];

    for (const { id, name } of collections) {
      const res: Response = await fetch(`https://graph.facebook.com/v22.0/${id}`, {
        method: "DELETE",
        headers: authHeaders(token),
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
