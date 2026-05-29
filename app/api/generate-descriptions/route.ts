import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const BUSINESS_ID = process.env.BUSINESS_ID!;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY!;

function stripHtml(value: string | null | undefined): string {
  if (!value) return "";
  return value.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
}

async function generateDesc(product: {
  name: string;
  brand: string;
  model: string;
  category: string;
  quality: string;
  description: string;
}): Promise<string> {
  const prompt = `Escribe una descripción corta y factual para este repuesto de celular.
Máximo 2 oraciones. Sin emojis. Sin saludos. Sin tono vendedor. Solo describe qué es el repuesto y para qué sirve.

Producto: ${product.name}
Marca: ${product.brand}
Modelo: ${product.model}
Categoría: ${product.category}
Calidad: ${product.quality}

Ejemplo del formato esperado: "Batería original para iPhone 13 Pro Max. Restaura la autonomía completa del equipo y muestra 100% de salud en ajustes."

Responde SOLO con la descripción, sin comillas ni explicaciones adicionales.`;

  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 120,
      temperature: 0.7,
    }),
  });

  const json = await res.json();
  if (!res.ok) throw new Error(`DeepSeek: ${JSON.stringify(json.error ?? json)}`);
  return json.choices?.[0]?.message?.content?.trim() ?? "";
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const regenerate = body.regenerate === true;

    // 1. Leer productos (sin desc o todos si regenerate=true)
    let query = supabase
      .from("supplier_products")
      .select("id, name, brand, model, category, quality, description")
      .eq("businessId", BUSINESS_ID)
      .eq("inOffice", true)
      .limit(20);

    if (!regenerate) query = query.is("whatsappDesc", null);

    const { data: products, error } = await query; // procesamos de 20 en 20 para no agotar créditos

    if (error) throw new Error(`Supabase: ${error.message}`);

    if (!products || products.length === 0) {
      return NextResponse.json({ done: true, message: "Todos los productos ya tienen descripción para WhatsApp." });
    }

    console.log("[desc] Generando descripciones para", products.length, "productos...");

    let generated = 0;
    const errors: string[] = [];

    for (const p of products) {
      try {
        const desc = await generateDesc({
          name: stripHtml(p.name),
          brand: stripHtml(p.brand),
          model: stripHtml(p.model),
          category: stripHtml(p.category),
          quality: stripHtml(p.quality),
          description: stripHtml(p.description),
        });

        await supabase
          .from("supplier_products")
          .update({ whatsappDesc: desc })
          .eq("id", p.id);

        generated++;
        console.log("[desc] OK:", stripHtml(p.name));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${p.name}: ${msg}`);
        console.error("[desc] Error en", p.name, msg);
      }
    }

    const remaining = await supabase
      .from("supplier_products")
      .select("id", { count: "exact", head: true })
      .eq("businessId", BUSINESS_ID)
      .eq("inOffice", true)
      .is("whatsappDesc", null);

    return NextResponse.json({
      generated,
      errors,
      pending: remaining.count ?? 0,
      message: `${generated} descripciones generadas. Pendientes: ${remaining.count ?? 0}`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    console.error("[desc] ERROR:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
