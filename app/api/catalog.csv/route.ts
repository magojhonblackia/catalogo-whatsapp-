import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const BUSINESS_ID = process.env.BUSINESS_ID!;

// Meta requiere estos campos en el CSV
const CSV_HEADERS = [
  "id",
  "title",
  "description",
  "availability",
  "condition",
  "price",
  "link",
  "image_link",
  "brand",
  "google_product_category",
];

function escapeCSV(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export async function GET() {
  const { data: products, error } = await supabase
    .from("supplier_products")
    .select("id, name, description, price, salePrice, quality, brand, category, model, isNew, inOffice")
    .eq("businessId", BUSINESS_ID)
    .eq("inOffice", true);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!products || products.length === 0) {
    const csv = CSV_HEADERS.join(",") + "\n";
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  const rows = products
    .filter((p) => p.salePrice != null && p.salePrice > 0)
    .map((p) => {
    const price = p.salePrice;
    const condition = p.isNew ? "new" : "used";
    const description = p.description
      ? p.description
      : [p.brand, p.model, p.category].filter(Boolean).join(" — ");

    return [
      escapeCSV(p.id),
      escapeCSV(p.name),
      escapeCSV(description || p.name),
      escapeCSV("in stock"),
      escapeCSV(condition),
      escapeCSV(`${price} COP`),
      escapeCSV(""),          // link — sin tienda web se deja vacío
      escapeCSV(""),          // image_link — agregar URL si tienes imágenes
      escapeCSV(p.brand ?? ""),
      escapeCSV(p.category ?? ""),
    ].join(",");
  });

  const csv = [CSV_HEADERS.join(","), ...rows].join("\n");

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
