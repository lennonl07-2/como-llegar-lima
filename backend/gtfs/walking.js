// gtfs/walking.js
// Calcula la ruta peatonal REAL (siguiendo veredas/calles) entre dos
// puntos, en vez de una linea recta que puede cruzar manzanas o casas.
//
// Usa el servicio publico de ruteo de FOSSGIS/OpenStreetMap (el mismo
// backend que usa el boton "Cómo llegar" de openstreetmap.org), perfil
// "foot" (a pie). Es gratuito, sin API key.
//
// Si el servicio no responde (caido, sin internet, etc.) hacemos
// fallback a una linea recta para no romper la respuesta completa.

const OSRM_FOOT_URL = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot';

async function getWalkingRoute(fromLat, fromLon, toLat, toLon) {
  const url = `${OSRM_FOOT_URL}/${fromLon},${fromLat};${toLon},${toLat}?overview=full&geometries=geojson`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'lima-transporte-publico-app/1.0 (proyecto personal)' },
    });
    if (!res.ok) throw new Error(`OSRM foot respondio ${res.status}`);
    const data = await res.json();
    const route = data.routes?.[0];
    if (!route || !route.geometry?.coordinates?.length) throw new Error('Sin ruta peatonal');

    // GeoJSON viene como [lon, lat] -- Leaflet quiere [lat, lon]
    const points = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    return {
      points,
      seconds: Math.round(route.duration),
      meters: Math.round(route.distance),
      real: true,
    };
  } catch (err) {
    // Fallback: linea recta, con tiempo estimado a 1.3 m/s
    const { haversineMeters } = require('./loader');
    const meters = haversineMeters(fromLat, fromLon, toLat, toLon);
    return {
      points: [[fromLat, fromLon], [toLat, toLon]],
      seconds: Math.round(meters / 1.3),
      meters: Math.round(meters),
      real: false,
    };
  }
}

module.exports = { getWalkingRoute };
