import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const BUSINESS_ID = process.env.BUSINESS_ID!;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY!;

const SITE_URL = process.env.SITE_URL ?? "https://jcreparaciones.com";

function stripHtml(value: string | null | undefined): string {
  if (!value) return "";
  return value.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function buildProductUrl(brand: string, model: string, category: string): string {
  if (!brand || !model || !category) return "";
  const modelSlug = slug(model);
  const marcaParam = modelSlug.split("-")[0];
  const servicioParam = `${slug(brand)}-${modelSlug}-${slug(category)}`;
  return `${SITE_URL}/reparacion/${marcaParam}/${modelSlug}/${servicioParam}`;
}

function formatPrice(price: number): string {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(price);
}

function getWarranty(name: string, category: string): string {
  const text = `${name} ${category}`.toLowerCase();
  if (text.includes("bater")) return "3 meses de garantía";
  if (text.includes("display") || text.includes("pantalla") || text.includes("visor") || text.includes("reglassing")) return "1 mes de garantía";
  return "1 mes de garantía";
}

async function generateDesc(product: {
  name: string;
  brand: string;
  model: string;
  category: string;
  quality: string;
  salePrice: number;
}): Promise<string> {
  const warranty = getWarranty(product.name, product.category);

  const prompt = `Eres un experto en redacción para tiendas de reparación de celulares en Colombia.
Genera la descripción de este repuesto en formato WhatsApp. Sigue EXACTAMENTE esta estructura:

[emoji relacionado al tipo de repuesto] [Nombre del producto]

[1 oración que describe el repuesto y genera confianza en la calidad]

• [Beneficio clave 1]
• [Beneficio clave 2]
• [Beneficio clave 3]
• Instalación disponible
• ${warranty}

💰 ${formatPrice(product.salePrice)}

Datos del producto:
- Nombre: ${product.name}
- Marca: ${product.brand}
- Modelo: ${product.model}
- Categoría: ${product.category}
- Calidad: ${product.quality}

Reglas:
- Usa tuteo informal (tú, tu equipo)
- El emoji del título debe corresponder al tipo de repuesto (🔋 batería, 📱 pantalla/display, ⚡ carga/flex, 📷 cámara, 🔊 bocina, etc.)
- Los bullets deben ser cortos y específicos del producto
- La garantía ya está incluida en los bullets, NO la repitas en otro lugar
- Si el producto es una batería y la calidad NO es "Original", NO menciones "100% de salud" ni porcentajes de salud en los ajustes — eso solo aplica para baterías originales
- No inventes características que no correspondan al repuesto
- Responde SOLO con el texto del mensaje, sin explicaciones`;

  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
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
    const offset = body.offset ?? 0;

    let query = supabase
      .from("supplier_products")
      .select("id, name, brand, model, category, quality, salePrice, price")
      .eq("businessId", BUSINESS_ID)
      .eq("inOffice", true)
      .limit(20);

    if (!regenerate) {
      query = query.is("whatsappDesc", null);
    } else {
      query = query.range(offset, offset + 19);
    }

    const { data: products, error } = await query;

    if (error) throw new Error(`Supabase: ${error.message}`);

    if (!products || products.length === 0) {
      return NextResponse.json({ done: true, message: "Todos los productos ya tienen descripción para WhatsApp." });
    }

    console.log("[desc] Generando descripciones para", products.length, "productos...");

    let generated = 0;
    const errors: string[] = [];

    for (const p of products) {
      try {
        const cleanBrand = stripHtml(p.brand);
        const cleanModel = stripHtml(p.model);
        const cleanCategory = stripHtml(p.category);

        const desc = await generateDesc({
          name: stripHtml(p.name),
          brand: cleanBrand,
          model: cleanModel,
          category: cleanCategory,
          quality: stripHtml(p.quality),
          salePrice: p.salePrice ?? p.price ?? 0,
        });

        const productUrl = buildProductUrl(cleanBrand, cleanModel, cleanCategory);
        const fullDesc = productUrl
          ? `${desc}\n\n🔗 Ver más información:\n${productUrl}`
          : desc;

        await supabase
          .from("supplier_products")
          .update({ whatsappDesc: fullDesc })
          .eq("id", p.id);

        generated++;
        console.log("[desc] OK:", stripHtml(p.name));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${stripHtml(p.name)}: ${msg}`);
        console.error("[desc] Error en", p.name, msg);
      }
    }

    const totalRes = await supabase
      .from("supplier_products")
      .select("id", { count: "exact", head: true })
      .eq("businessId", BUSINESS_ID)
      .eq("inOffice", true);

    const totalCount = totalRes.count ?? 0;

    if (regenerate) {
      // En modo regenerar: muestra cuántos procesó en este lote y cuántos quedan por lote
      const offset = body.offset ?? 0;
      const nextOffset = offset + generated;
      const remaining = totalCount - nextOffset;
      return NextResponse.json({
        generated,
        errors,
        pending: remaining,
        done: nextOffset,
        total: totalCount,
        offset: nextOffset,
        message: `${generated} regeneradas. Progreso: ${nextOffset}/${totalCount}${remaining > 0 ? ` — faltan ${remaining}` : " ✓ Todos listos"}`,
      });
    }

    const withDescRes = await supabase
      .from("supplier_products")
      .select("id", { count: "exact", head: true })
      .eq("businessId", BUSINESS_ID)
      .eq("inOffice", true)
      .not("whatsappDesc", "is", null);

    const done = withDescRes.count ?? 0;
    const pending = totalCount - done;

    return NextResponse.json({
      generated,
      errors,
      pending,
      done,
      total: totalCount,
      message: `${generated} generadas. Progreso: ${done}/${totalCount}${pending > 0 ? ` — faltan ${pending}, presiona de nuevo` : " ✓ Todos listos"}`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    console.error("[desc] ERROR:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
