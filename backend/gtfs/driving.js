// gtfs/driving.js
// Respaldo para cuando una ruta de bus/combi no trajo geometria de calles
// utilizable desde OpenStreetMap (relacion sin "ways", o ways que no se
// pudieron encadenar). En vez de una linea recta que corta la ciudad en
// diagonal, le pedimos a un motor de ruteo vehicular real que trace un
// camino siguiendo calles de verdad entre el paradero de subida y el de
// bajada. No es el recorrido EXACTO del bus (no tenemos esa geometria),
// pero es muchisimo mas realista que una linea recta.

const OSRM_CAR_URL = 'https://routing.openstreetmap.de/routed-car/route/v1/driving';

async function getDrivingPath(fromLat, fromLon, toLat, toLon) {
  const url = `${OSRM_CAR_URL}/${fromLon},${fromLat};${toLon},${toLat}?overview=full&geometries=geojson`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'lima-transporte-publico-app/1.0 (proyecto personal)' },
    });
    if (!res.ok) throw new Error(`OSRM car respondio ${res.status}`);
    const data = await res.json();
    const route = data.routes?.[0];
    if (!route || !route.geometry?.coordinates?.length) throw new Error('Sin ruta vehicular');
    const points = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    return { points, real: true };
  } catch (err) {
    return { points: null, real: false };
  }
}

module.exports = { getDrivingPath };
