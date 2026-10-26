// gtfs/geocode.js
// Geocodificacion gratuita usando Nominatim (el motor de busqueda de
// OpenStreetMap). No requiere API key. Acotamos la busqueda a la caja
// geografica de Lima Metropolitana + Callao para evitar resultados de
// otras ciudades del Peru o del mundo.
//
// Politica de uso de Nominatim (importante si esto pasa a produccion real):
//   - Maximo 1 solicitud por segundo.
//   - Hay que mandar un User-Agent identificable.
//   - Para uso con mucho trafico, lo correcto es alojar tu propia instancia
//     de Nominatim o usar un proveedor con SLA. Para uso personal/proyecto
//     esta bien usar el servidor publico.

const LIMA_CALLAO_VIEWBOX = {
  // esquina suroeste, esquina noreste (lon,lat,lon,lat) -- caja amplia
  // que cubre Lima Metropolitana y la Provincia Constitucional del Callao
  left: -77.25,
  top: -11.6,
  right: -76.75,
  bottom: -12.35,
};

let lastRequestTime = 0;
async function throttle() {
  const now = Date.now();
  // 500ms de espaciado entre llamadas reales a Nominatim. Con el debounce
  // y la cancelacion de peticiones obsoletas del lado del cliente, las
  // llamadas que realmente llegan aqui ya estan naturalmente espaciadas;
  // este throttle es solo un colchon de seguridad adicional.
  const wait = Math.max(0, 500 - (now - lastRequestTime));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestTime = Date.now();
}

async function geocode(query) {
  await throttle();
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: '6',
    countrycodes: 'pe',
    viewbox: `${LIMA_CALLAO_VIEWBOX.left},${LIMA_CALLAO_VIEWBOX.top},${LIMA_CALLAO_VIEWBOX.right},${LIMA_CALLAO_VIEWBOX.bottom}`,
    bounded: '1',
  });
  const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'lima-transporte-publico-app/1.0 (proyecto personal)',
      'Accept-Language': 'es',
    },
  });
  if (!res.ok) throw new Error(`Nominatim respondio ${res.status}`);
  const data = await res.json();
  return data.map((r) => ({
    label: r.display_name,
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
  }));
}

// Cache en memoria (vive mientras corre el servidor) para no repetir la
// misma consulta de reverse-geocoding si varias busquedas caen cerca del
// mismo punto aproximado.
const reverseCache = new Map();
function cacheKey(lat, lon) {
  // Redondeamos a ~11m de precision -- suficiente para no perder
  // reutilizacion util sin mezclar puntos distintos.
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

/**
 * Dado un punto (lat, lon) sin nombre oficial de paradero, devuelve una
 * etiqueta legible tipo "Jr. Ica 245" o, si no hay numeracion, el nombre
 * de la via mas cercana. Se usa solo para los paraderos APROXIMADOS que
 * genera el conversor OSM->GTFS cuando una ruta no trae paraderos
 * mapeados explicitamente.
 */
async function reverseLabel(lat, lon) {
  const key = cacheKey(lat, lon);
  if (reverseCache.has(key)) return reverseCache.get(key);

  await throttle();
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    format: 'jsonv2',
    zoom: '18',
  });
  const url = `https://nominatim.openstreetmap.org/reverse?${params.toString()}`;
  let label = 'Punto de la ruta';
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'lima-transporte-publico-app/1.0 (proyecto personal)',
        'Accept-Language': 'es',
      },
    });
    if (res.ok) {
      const data = await res.json();
      const addr = data.address || {};
      const road = addr.road || addr.pedestrian || addr.footway;
      if (road && addr.house_number) {
        label = `${road} ${addr.house_number}`;
      } else if (road) {
        label = `cerca de ${road}`;
      } else if (data.display_name) {
        label = data.display_name.split(',')[0];
      }
    }
  } catch (err) {
    // deja el label por defecto 'Punto de la ruta'
  }

  reverseCache.set(key, label);
  return label;
}

module.exports = { geocode, reverseLabel };
