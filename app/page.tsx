"use client";

import { useState, useEffect } from "react";

type SyncResult = {
  synced?: number;
  created?: number | string[];
  updated?: number | string[];
  total?: number;
  message?: string;
  error?: string;
  skipped?: string[];
};

export default function Home() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [loadingCol, setLoadingCol] = useState(false);
  const [resultCol, setResultCol] = useState<SyncResult | null>(null);
  const [catalogId, setCatalogId] = useState("");
  const [metaToken, setMetaToken] = useState("");
  const [loadingDel, setLoadingDel] = useState(false);
  const [loadingDesc, setLoadingDesc] = useState(false);
  const [resultDesc, setResultDesc] = useState<SyncResult | null>(null);
  const [csvUrl, setCsvUrl] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCsvUrl(`${window.location.origin}/api/catalog.csv`);
  }, []);

  function handleCopy() {
    navigator.clipboard.writeText(csvUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleDeleteCollections() {
    if (!confirm("¿Eliminar todos los conjuntos de Meta?")) return;
    setLoadingDel(true);
    try {
      const res = await fetch("/api/collections", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ catalogId: catalogId.trim() || undefined, metaToken: metaToken.trim() || undefined }),
      });
      const data = await res.json();
      setResultCol(data);
    } catch {
      setResultCol({ error: "No se pudo eliminar." });
    } finally {
      setLoadingDel(false);
    }
  }

  async function handleCollections() {
    setLoadingCol(true);
    setResultCol(null);
    try {
      const res = await fetch("/api/collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ catalogId: catalogId.trim() || undefined, metaToken: metaToken.trim() || undefined }),
      });
      const data = await res.json();
      setResultCol(data);
    } catch {
      setResultCol({ error: "No se pudo conectar con el servidor." });
    } finally {
      setLoadingCol(false);
    }
  }

  const [regenOffset, setRegenOffset] = useState(0);

  async function handleDesc(regenerate = false) {
    setLoadingDesc(true);
    if (!regenerate) setResultDesc(null);
    const offset = regenerate ? regenOffset : 0;
    try {
      const res = await fetch("/api/generate-descriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ regenerate, offset }),
      });
      const data = await res.json();
      setResultDesc(data);
      if (regenerate && data.offset != null) setRegenOffset(data.offset);
      if (!regenerate || data.pending === 0) setRegenOffset(0);
    } catch {
      setResultDesc({ error: "No se pudo conectar con el servidor." });
    } finally {
      setLoadingDesc(false);
    }
  }

  async function handleSync() {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const data = await res.json();
      setResult(data);
    } catch {
      setResult({ error: "No se pudo conectar con el servidor." });
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      <div className="bg-white rounded-2xl shadow-lg p-8 w-full max-w-md">
        {/* Header */}
        <div className="mb-8 text-center">
          <div className="text-4xl mb-3">🔄</div>
          <h1 className="text-2xl font-bold text-gray-900">Sync Repuestos</h1>
          <p className="text-gray-500 text-sm mt-1">
            Supabase <span className="mx-1">→</span> Airtable
          </p>
        </div>

        {/* Info cards */}
        <div className="grid grid-cols-2 gap-3 mb-6">
          <div className="bg-emerald-50 rounded-xl p-3 text-center">
            <p className="text-xs text-emerald-600 font-medium uppercase tracking-wide">Fuente</p>
            <p className="text-sm font-semibold text-emerald-800 mt-1">Supabase</p>
            <p className="text-xs text-emerald-600">supplier_products</p>
          </div>
          <div className="bg-blue-50 rounded-xl p-3 text-center">
            <p className="text-xs text-blue-600 font-medium uppercase tracking-wide">Destino</p>
            <p className="text-sm font-semibold text-blue-800 mt-1">Airtable</p>
            <p className="text-xs text-blue-600">Repuestos</p>
          </div>
        </div>

        {/* Sync button */}
        <button
          onClick={handleSync}
          disabled={loading}
          className="w-full py-3 px-6 rounded-xl font-semibold text-white transition-all
            bg-indigo-600 hover:bg-indigo-700 active:scale-95
            disabled:bg-indigo-300 disabled:cursor-not-allowed disabled:scale-100"
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              Sincronizando...
            </span>
          ) : (
            "Sincronizar ahora"
          )}
        </button>

        {/* Result */}
        {result && (
          <div
            className={`mt-5 rounded-xl p-4 text-sm ${
              result.error
                ? "bg-red-50 border border-red-200 text-red-700"
                : "bg-green-50 border border-green-200 text-green-800"
            }`}
          >
            {result.error ? (
              <p>❌ {result.error}</p>
            ) : result.message ? (
              <p>ℹ️ {result.message}</p>
            ) : (
              <div className="space-y-1">
                <p className="font-semibold">✅ Sincronización completa</p>
                <p>Total procesados: <strong>{result.total}</strong></p>
                <p>Creados: <strong>{result.created}</strong></p>
                <p>Actualizados: <strong>{result.updated}</strong></p>
              </div>
            )}
          </div>
        )}

        {/* Descripciones WhatsApp con DeepSeek */}
        <div className="mt-4 border-t border-gray-100 pt-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
            Descripciones para WhatsApp
          </p>
          <p className="text-xs text-gray-400 mb-3">Genera descripciones cortas con IA (de 20 en 20)</p>
          <div className="flex gap-2">
          <button
            onClick={() => handleDesc(false)}
            disabled={loadingDesc}
            className="flex-1 py-3 px-4 rounded-xl font-semibold text-white transition-all
              bg-orange-500 hover:bg-orange-600 active:scale-95
              disabled:bg-orange-300 disabled:cursor-not-allowed disabled:scale-100"
          >
            {loadingDesc ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                Generando...
              </span>
            ) : (
              "Generar pendientes"
            )}
          </button>
          <button
            onClick={() => handleDesc(true)}
            disabled={loadingDesc}
            title="Regenera todos (sobreescribe existentes)"
            className="py-3 px-4 rounded-xl font-semibold text-orange-600 border border-orange-300
              bg-white hover:bg-orange-50 transition-all active:scale-95
              disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ↺
          </button>
          </div>
          {resultDesc && (
            <div className={`mt-3 rounded-xl p-3 text-sm ${
              resultDesc.error
                ? "bg-red-50 border border-red-200 text-red-700"
                : "bg-orange-50 border border-orange-200 text-orange-800"
            }`}>
              {resultDesc.error ? (
                <p>❌ {resultDesc.error}</p>
              ) : (
                <div className="space-y-1">
                  <p className="font-semibold">✅ {resultDesc.message}</p>
                  {(resultDesc as {pending?: number}).pending != null && (resultDesc as {pending?: number}).pending! > 0 && (
                    <p className="text-xs">Presiona de nuevo para continuar con los siguientes 20.</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Colecciones Meta */}
        <div className="mt-4 border-t border-gray-100 pt-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Colecciones por modelo en Meta
          </p>
          <div className="mb-2">
            <label className="text-xs text-gray-500 mb-1 block">Token de Meta (opcional)</label>
            <input
              type="password"
              value={metaToken}
              onChange={(e) => setMetaToken(e.target.value)}
              placeholder="EAAxxxxxxxxx (vacío = usa el del .env)"
              className="w-full text-xs border border-gray-200 rounded-lg px-3 py-2 text-gray-700 focus:outline-none focus:ring-2 focus:ring-violet-300"
            />
          </div>
          <div className="mb-3">
            <label className="text-xs text-gray-500 mb-1 block">ID de catálogo (opcional)</label>
            <input
              type="text"
              value={catalogId}
              onChange={(e) => setCatalogId(e.target.value)}
              placeholder="Ej: 27022114080791679 (vacío = usa el del .env)"
              className="w-full text-xs border border-gray-200 rounded-lg px-3 py-2 text-gray-700 focus:outline-none focus:ring-2 focus:ring-violet-300"
            />
          </div>
          <div className="flex items-center justify-between mb-3">
            <span />
            <button
              onClick={handleDeleteCollections}
              disabled={loadingDel || loadingCol}
              className="text-xs px-3 py-1 rounded-lg border border-red-200 text-red-500 hover:bg-red-50 transition-colors disabled:opacity-40"
            >
              {loadingDel ? "Eliminando..." : "Eliminar todas"}
            </button>
          </div>
          <button
            onClick={handleCollections}
            disabled={loadingCol}
            className="w-full py-3 px-6 rounded-xl font-semibold text-white transition-all
              bg-violet-600 hover:bg-violet-700 active:scale-95
              disabled:bg-violet-300 disabled:cursor-not-allowed disabled:scale-100"
          >
            {loadingCol ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                Creando colecciones...
              </span>
            ) : (
              "Crear colecciones por marca"
            )}
          </button>
          {resultCol && (
            <div className={`mt-3 rounded-xl p-3 text-sm ${
              resultCol.error
                ? "bg-red-50 border border-red-200 text-red-700"
                : "bg-violet-50 border border-violet-200 text-violet-800"
            }`}>
              {resultCol.error ? (
                <p>❌ {resultCol.error}</p>
              ) : (
                <div className="space-y-1">
                  <p className="font-semibold">✅ {resultCol.message}</p>
                  {Array.isArray(resultCol.created) && resultCol.created.length > 0 && (
                    <p>Nuevas: <strong>{(resultCol.created as string[]).join(", ")}</strong></p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* CSV URL para Meta */}
        <div className="mt-6 bg-gray-50 rounded-xl p-4 border border-gray-200">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            URL del catálogo para Meta / WhatsApp
          </p>
          <div className="flex items-center gap-2">
            <code className="text-xs text-gray-700 bg-white border border-gray-200 rounded-lg px-3 py-2 flex-1 truncate">
              {csvUrl}
            </code>
            <button
              onClick={handleCopy}
              className="shrink-0 text-xs px-3 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
            >
              {copied ? "✓" : "Copiar"}
            </button>
          </div>
          <a
            href="/api/catalog.csv"
            target="_blank"
            className="text-xs text-indigo-500 hover:underline mt-2 inline-block"
          >
            Ver CSV →
          </a>
        </div>
      </div>
    </main>
  );
}
