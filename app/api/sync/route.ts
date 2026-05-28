import { createClient } from "@supabase/supabase-js";
import Airtable from "airtable";
import { NextResponse } from "next/server";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(
  process.env.AIRTABLE_BASE_ID!
);

const TABLE = process.env.AIRTABLE_TABLE_NAME!;
const BUSINESS_ID = process.env.BUSINESS_ID!;

export async function POST() {
  try {
    // 1. Leer repuestos desde Supabase
    const { data: products, error } = await supabase
      .from("supplier_products")
      .select("id, name, description, price, salePrice, quality, brand, category, model, isNew, inOffice, createdAt")
      .eq("businessId", BUSINESS_ID)
      .order("createdAt", { ascending: false });

    if (error) throw new Error(`Supabase: ${error.message}`);
    if (!products || products.length === 0) {
      return NextResponse.json({ synced: 0, message: "No hay repuestos para sincronizar." });
    }

    // 2. Leer registros existentes en Airtable (por supplier_id para evitar duplicados)
    const existingRecords: Record<string, string> = {};
    await base(TABLE)
      .select({ fields: ["supplier_id"] })
      .eachPage((records, next) => {
        records.forEach((r) => {
          const sid = r.get("supplier_id") as string;
          if (sid) existingRecords[sid] = r.id;
        });
        next();
      });

    // 3. Separar en creates y updates
    const toCreate: Airtable.FieldSet[] = [];
    const toUpdate: { id: string; fields: Airtable.FieldSet }[] = [];

    for (const p of products) {
      const fields: Airtable.FieldSet = {
        supplier_id: p.id,
        Nombre: p.name ?? "",
        Descripcion: p.description ?? "",
        Precio: p.price ?? 0,
        PrecioVenta: p.salePrice ?? 0,
        Calidad: p.quality ?? "",
        Marca: p.brand ?? "",
        Categoria: p.category ?? "",
        Modelo: p.model ?? "",
        EsNuevo: p.isNew ?? false,
        EnOficina: p.inOffice ?? false,
      };

      if (existingRecords[p.id]) {
        toUpdate.push({ id: existingRecords[p.id], fields });
      } else {
        toCreate.push(fields);
      }
    }

    // 4. Crear en lotes de 10 (límite Airtable)
    let created = 0;
    for (let i = 0; i < toCreate.length; i += 10) {
      const batch = toCreate.slice(i, i + 10).map((fields) => ({ fields }));
      await base(TABLE).create(batch);
      created += batch.length;
    }

    // 5. Actualizar en lotes de 10
    let updated = 0;
    for (let i = 0; i < toUpdate.length; i += 10) {
      const batch = toUpdate.slice(i, i + 10).map(({ id, fields }) => ({ id, fields }));
      await base(TABLE).update(batch);
      updated += batch.length;
    }

    return NextResponse.json({
      synced: created + updated,
      created,
      updated,
      total: products.length,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const detail = (err as any)?.error ?? (err as any)?.statusCode ?? null;
    console.error("[sync] error:", message, detail);
    return NextResponse.json({ error: message, detail }, { status: 500 });
  }
}
