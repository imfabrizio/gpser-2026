// Coordinate di una città tramite Nominatim (OpenStreetMap, gratuito, senza chiave). Si chiama solo al salvataggio dell'evento, mai a ogni visita.
export async function geocodifica(luogo) {
  const q = String(luogo || '').replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (q.length < 2) return null;
  try {
    const r = await globalThis.fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=it&q=${encodeURIComponent(q)}`,
      { headers: { 'User-Agent': 'GareCRI/1.0 (gestione gare CRI)', 'Accept-Language': 'it' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const [x] = await r.json();
    const lat = Number(x?.lat), lng = Number(x?.lon);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat: +lat.toFixed(6), lng: +lng.toFixed(6), nome: x.display_name } : null;
  } catch { return null; }
}
// «44.4056, 10.5912» (come lo copia Google Maps) → { lat, lng }
export function leggiCoordinate(testo) {
  const m = String(testo || '').match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (!m) return null; const lat = Number(m[1]), lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}
