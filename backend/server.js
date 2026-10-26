// server.js
// Punto de entrada. Carga el feed GTFS UNA vez en memoria al arrancar
// (por eso el primer arranque puede tardar unos segundos) y expone:
//
//   GET  /api/geocode?q=texto           -> sugerencias de direcciones
//   POST /api/route                     -> planifica un viaje (con alternativas)
//   GET  /api/health                    -> estado del feed cargado
//
// El frontend estatico (Leaflet) se sirve desde ../frontend

const path = require('path');
const express = require('express');
const cors = require('cors');

const { loadGtfs, haversineMeters } = require('./gtfs/loader');
const { planTripAlternatives, secondsToClock } = require('./gtfs/router');
const { geocode, reverseLabel } = require('./gtfs/geocode');
const { getWalkingRoute } = require('./gtfs/walking');
const { getDrivingPath } = require('./gtfs/driving');

const PORT = process.env.PORT || 3000;
const GTFS_DIR = process.env.GTFS_DIR || path.join(__dirname, 'data', 'gtfs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

let gtfs = null;
let loadError = null;

try {
  gtfs = loadGtfs(GTFS_DIR);
} catch (err) {
  loadError = err.message;
  console.error('\n[ERROR] No se pudo cargar el feed GTFS.');
  console.error(loadError);
  console.error(
    '\nRevisa el README.md: necesitas colocar los archivos GTFS (stops.txt, ' +
      'routes.txt, trips.txt, stop_times.txt, calendar.txt) en backend/data/gtfs/\n'
  );
}

app.get('/api/health', (req, res) => {
  if (!gtfs) {
    return res.status(503).json({ ok: false, error: loadError });
  }
  res.json({
    ok: true,
    stops: gtfs.stops.size,
    routes: gtfs.routes.size,
    trips: gtfs.trips.size,
    connections: gtfs.connections.length,
  });
});

app.get('/api/geocode', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 3) return res.json([]);
  try {
    const results = await geocode(q);
    res.json(results);
  } catch (err) {
    console.error('[geocode] error:', err.message);
    res.status(502).json({ error: 'No se pudo geocodificar en este momento.' });
  }
});

function findNearestShapeIndex(shapePoints, lat, lon) {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < shapePoints.length; i++) {
    const d = haversineMeters(lat, lon, shapePoints[i].lat, shapePoints[i].lon);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function sliceShapeForRide(step) {
  if (!step.shapeId || !step.boardCoord || !step.alightCoord) return null;
  const shape = gtfs.shapes.get(step.shapeId);
  if (!shape || shape.length < 2) return null;

  const boardIdx = findNearestShapeIndex(shape, step.boardCoord.lat, step.boardCoord.lon);
  const alightIdx = findNearestShapeIndex(shape, step.alightCoord.lat, step.alightCoord.lon);

  const start = Math.min(boardIdx, alightIdx);
  const end = Math.max(boardIdx, alightIdx);
  let slice = shape.slice(start, end + 1);
  if (boardIdx > alightIdx) slice = slice.reverse();

  if (slice.length < 2) return null;
  return slice.map((p) => [p.lat, p.lon]);
}

// Cache de resultados de geocodificacion en reversa para no repetir la
// misma consulta si un mismo paradero aproximado aparece en varias
// alternativas de ruta dentro de la misma peticion.
async function labelFor(cache, name, isApprox, lat, lon) {
  if (!isApprox || lat == null || lon == null) return name;
  const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  if (cache.has(key)) return cache.get(key);
  const label = await reverseLabel(lat, lon);
  cache.set(key, label);
  return label;
}

/**
 * Toma un itinerario "crudo" (salido de planTrip) y le agrega:
 *  - trazado peatonal real para las caminatas (en vez de linea recta)
 *  - nombre legible para paraderos aproximados (reverse geocoding)
 *  - geometria real para los tramos en bus/metro (shape del GTFS, o si
 *    no hay, un trazado vehicular real como respaldo -- nunca una linea
 *    recta cruzando la ciudad)
 */
async function enrichItinerary(rawItinerary, labelCache) {
  const walkSteps = rawItinerary.filter((s) => s.kind === 'walk');
  const walkRoutes = await Promise.all(
    walkSteps.map((s) =>
      s.fromCoord && s.toCoord
        ? getWalkingRoute(s.fromCoord.lat, s.fromCoord.lon, s.toCoord.lat, s.toCoord.lon)
        : Promise.resolve(null)
    )
  );
  const walkRouteByStep = new Map();
  walkSteps.forEach((s, idx) => walkRouteByStep.set(s, walkRoutes[idx]));

  const itinerary = [];
  for (const step of rawItinerary) {
    if (step.kind === 'walk') {
      const walkRoute = walkRouteByStep.get(step);
      const resolvedName = await labelFor(
        labelCache,
        step.stopName,
        step.stopIsApprox,
        step.walkType === 'to_destination' ? step.fromCoord?.lat : step.toCoord?.lat,
        step.walkType === 'to_destination' ? step.fromCoord?.lon : step.toCoord?.lon
      );
      const text =
        step.walkType === 'to_destination'
          ? `Camina desde "${resolvedName}" hasta tu destino`
          : `Camina hasta el paradero "${resolvedName}"`;
      itinerary.push({
        ...step,
        stopName: resolvedName,
        text,
        seconds: walkRoute ? walkRoute.seconds : step.seconds,
        walkPoints: walkRoute ? walkRoute.points : null,
        walkIsReal: walkRoute ? walkRoute.real : false,
      });
    } else if (step.kind === 'ride') {
      const [boardLabel, alightLabel] = await Promise.all([
        labelFor(labelCache, step.boardStop, step.boardStopIsApprox, step.boardCoord?.lat, step.boardCoord?.lon),
        labelFor(labelCache, step.alightStop, step.alightStopIsApprox, step.alightCoord?.lat, step.alightCoord?.lon),
      ]);

      let shapePoints = sliceShapeForRide(step);
      const hasExactShape = !!shapePoints;
      let shapeIsReal = hasExactShape;
      if (!shapePoints && step.boardCoord && step.alightCoord) {
        // Respaldo: esta ruta no trajo geometria propia desde OSM. En vez
        // de una linea recta cruzando la ciudad, trazamos un camino
        // vehicular real entre el paradero de subida y el de bajada.
        const driving = await getDrivingPath(
          step.boardCoord.lat,
          step.boardCoord.lon,
          step.alightCoord.lat,
          step.alightCoord.lon
        );
        if (driving.points) {
          shapePoints = driving.points;
          shapeIsReal = true; // sigue calles reales, aunque no sea el trazado exacto del bus
        }
      }

      itinerary.push({
        ...step,
        boardStop: boardLabel,
        alightStop: alightLabel,
        departClock: secondsToClock(step.departSeconds),
        arriveClock: secondsToClock(step.arriveSeconds),
        shapePoints,
        shapeIsExact: hasExactShape,
      });
    } else {
      itinerary.push(step);
    }
  }

  const walkDeltaSeconds = itinerary
    .filter((s) => s.kind === 'walk')
    .reduce((acc, s, idx) => acc + (s.seconds - walkSteps[idx].seconds), 0);

  return { itinerary, walkDeltaSeconds };
}

function rawFallbackItinerary(rawItinerary) {
  // Si el enriquecimiento entero falla (sin internet, servicios caidos),
  // devolvemos el itinerario base para no dejar al usuario sin nada.
  return rawItinerary.map((step) =>
    step.kind === 'ride'
      ? {
          ...step,
          departClock: secondsToClock(step.departSeconds),
          arriveClock: secondsToClock(step.arriveSeconds),
          shapePoints: sliceShapeForRide(step),
        }
      : step
  );
}

app.post('/api/route', async (req, res) => {
  if (!gtfs) {
    return res.status(503).json({ error: 'El feed GTFS no esta cargado. Revisa el servidor.' });
  }
  const { fromLat, fromLon, toLat, toLon, departure } = req.body || {};
  if ([fromLat, fromLon, toLat, toLon].some((v) => typeof v !== 'number')) {
    return res.status(400).json({ error: 'Faltan coordenadas de origen/destino.' });
  }
  const departureDate = departure ? new Date(departure) : new Date();

  const altResult = planTripAlternatives(gtfs, { fromLat, fromLon, toLat, toLon, departureDate }, 3);
  if (altResult.error) return res.status(404).json({ error: altResult.error });

  const labelCache = new Map(); // compartido entre alternativas -- evita repetir reverse geocoding
  const enrichedAlternatives = [];

  for (const alt of altResult.alternatives) {
    try {
      const { itinerary, walkDeltaSeconds } = await enrichItinerary(alt.itinerary, labelCache);
      const adjustedArrival = alt.summary.arriveSeconds + walkDeltaSeconds;
      enrichedAlternatives.push({
        itinerary,
        summary: {
          ...alt.summary,
          arriveSeconds: adjustedArrival,
          totalMinutes: Math.round((adjustedArrival - alt.summary.departSeconds) / 60),
          departClock: secondsToClock(alt.summary.departSeconds),
          arriveClock: secondsToClock(adjustedArrival),
        },
      });
    } catch (err) {
      console.error('[route] error enriqueciendo alternativa:', err.message);
      enrichedAlternatives.push({
        itinerary: rawFallbackItinerary(alt.itinerary),
        summary: {
          ...alt.summary,
          departClock: secondsToClock(alt.summary.departSeconds),
          arriveClock: secondsToClock(alt.summary.arriveSeconds),
        },
      });
    }
  }

  res.json({ alternatives: enrichedAlternatives });
});

app.listen(PORT, () => {
  console.log(`\nLima Transporte corriendo en http://localhost:${PORT}`);
  if (!gtfs) {
    console.log('(el feed GTFS no cargo -- revisa el mensaje de error arriba)');
  }
});
