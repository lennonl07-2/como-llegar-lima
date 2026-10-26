// gtfs/router.js
// Motor de planificacion de viajes multimodal (caminar + transporte publico)
// usando el Connection Scan Algorithm (CSA), el mismo enfoque academico
// detras de varios planificadores de transporte publico reales.
//
// Idea general:
//  1. Ubicamos los paraderos caminables desde el origen y hacia el destino.
//  2. Ordenamos TODAS las conexiones (tramo de un viaje entre 2 paradas
//     consecutivas) por hora de salida.
//  3. Barremos esa lista una sola vez: si podemos llegar a tiempo a la
//     parada de salida de una conexion, evaluamos si tomarla mejora la
//     hora de llegada a la parada destino de esa conexion.
//  4. Al final reconstruimos el itinerario paso a paso con punteros "padre".

const { haversineMeters } = require('./loader');

const MAX_ORIGIN_WALK_METERS = 1200; // ~15 min caminando
const MAX_DEST_WALK_METERS = 1200;
const WALK_SPEED_MPS = 1.3;
const MIN_TRANSFER_SECONDS = 90; // colchon minimo para bajar de un vehiculo y subir a otro

function dateStrFromOffset(baseDate, dayOffset) {
  const d = new Date(baseDate);
  d.setDate(d.getDate() + dayOffset);
  return (
    d.getFullYear().toString() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0')
  );
}

function isServiceActive(service, dateStr, weekday) {
  if (!service) return false;
  if (service.removed.has(dateStr)) return false;
  if (service.added.has(dateStr)) return true;
  if (!service.startDate || !service.endDate) return false;
  if (dateStr < service.startDate || dateStr > service.endDate) return false;
  return service.days[weekday];
}

/**
 * Encuentra paraderos dentro de un radio caminable de un punto lat/lon.
 */
function nearbyStops(gtfs, lat, lon, maxMeters) {
  const results = [];
  for (const stop of gtfs.stops.values()) {
    const d = haversineMeters(lat, lon, stop.lat, stop.lon);
    if (d <= maxMeters) {
      results.push({ stop_id: stop.stop_id, meters: d, seconds: Math.round(d / WALK_SPEED_MPS) });
    }
  }
  results.sort((a, b) => a.meters - b.meters);
  return results;
}

/**
 * Planifica un viaje desde (fromLat, fromLon) hasta (toLat, toLon).
 * departureDate: objeto Date (hora local) de cuando el usuario quiere salir.
 *
 * Devuelve { itinerary: [...pasos], summary } o { error }.
 */
function planTrip(gtfs, { fromLat, fromLon, toLat, toLon, departureDate, excludeRouteIds }) {
  const depDate = departureDate || new Date();
  const weekday = depDate.getDay(); // 0=domingo
  const dateStr = dateStrFromOffset(depDate, 0);
  const depSeconds =
    depDate.getHours() * 3600 + depDate.getMinutes() * 60 + depDate.getSeconds();
  const excluded = excludeRouteIds || new Set();

  // Cache de servicios activos hoy (evita recalcular por cada conexion)
  const activeServiceCache = new Map();
  const isTripActive = (tripId) => {
    const trip = gtfs.trips.get(tripId);
    if (!trip) return false;
    if (activeServiceCache.has(trip.service_id)) {
      return activeServiceCache.get(trip.service_id);
    }
    const active = isServiceActive(gtfs.services.get(trip.service_id), dateStr, weekday);
    activeServiceCache.set(trip.service_id, active);
    return active;
  };

  const originStops = nearbyStops(gtfs, fromLat, fromLon, MAX_ORIGIN_WALK_METERS);
  const destStops = nearbyStops(gtfs, toLat, toLon, MAX_DEST_WALK_METERS);

  if (originStops.length === 0) {
    return { error: 'No hay paraderos de transporte publico cerca del origen (dentro de ~900m).' };
  }
  if (destStops.length === 0) {
    return { error: 'No hay paraderos de transporte publico cerca del destino (dentro de ~900m).' };
  }

  const destSet = new Map(destStops.map((s) => [s.stop_id, s.seconds]));

  // earliestArrival[stop_id] = mejor hora de llegada (segundos) encontrada hasta ahora
  const earliestArrival = new Map();
  // parent[stop_id] = info de como llegamos aqui, para reconstruir el itinerario
  const parent = new Map();

  for (const s of originStops) {
    const arriveAt = depSeconds + s.seconds;
    earliestArrival.set(s.stop_id, arriveAt);
    parent.set(s.stop_id, { type: 'walk_start', seconds: s.seconds });
  }

  // Aplica tambien los footpaths desde los paraderos de origen (por si el
  // usuario puede caminar un poco mas y alcanzar una conexion mas rapida)
  for (const s of originStops) {
    const links = gtfs.footpaths.get(s.stop_id) || [];
    for (const link of links) {
      const arriveAt = depSeconds + s.seconds + link.seconds;
      const current = earliestArrival.get(link.stop_id);
      if (current === undefined || arriveAt < current) {
        earliestArrival.set(link.stop_id, arriveAt);
        parent.set(link.stop_id, {
          type: 'walk_start',
          seconds: s.seconds + link.seconds,
        });
      }
    }
  }

  // tripBoarded[tripId] = segundos en que "subimos" a ese viaje por primera vez
  // (permite saber que ya estamos abordo sin pagar de nuevo el colchon de transbordo)
  const tripBoardedAt = new Map();

  let bestArrival = Infinity;
  let bestDestStop = null;

  for (const conn of gtfs.connections) {
    // Como las conexiones estan ordenadas por hora de salida, si ya
    // encontramos una llegada mejor que la salida actual, podemos cortar.
    if (conn.depTime > bestArrival) break;

    if (!isTripActive(conn.tripId)) continue;
    if (excluded.has(conn.routeId)) continue;

    const arrivalAtFrom = earliestArrival.get(conn.fromStop);
    if (arrivalAtFrom === undefined) continue;

    // Si ya veniamos abordo de este mismo viaje, no necesitamos colchon de transbordo.
    const alreadyOnTrip = tripBoardedAt.get(conn.tripId) !== undefined;
    const readyTime = alreadyOnTrip ? arrivalAtFrom : arrivalAtFrom + MIN_TRANSFER_SECONDS;

    if (conn.depTime < readyTime) continue; // no llegamos a tiempo a tomar este tramo

    if (!alreadyOnTrip) tripBoardedAt.set(conn.tripId, conn.depTime);

    const currentBestAtTo = earliestArrival.get(conn.toStop);
    if (currentBestAtTo === undefined || conn.arrTime < currentBestAtTo) {
      earliestArrival.set(conn.toStop, conn.arrTime);
      parent.set(conn.toStop, {
        type: 'ride',
        tripId: conn.tripId,
        routeId: conn.routeId,
        fromStop: conn.fromStop,
        toStop: conn.toStop,
        depTime: conn.depTime,
        arrTime: conn.arrTime,
      });

      // Propaga a paraderos cercanos caminando (transbordo a pie)
      const links = gtfs.footpaths.get(conn.toStop) || [];
      for (const link of links) {
        const arriveWalking = conn.arrTime + link.seconds;
        const currentAtLink = earliestArrival.get(link.stop_id);
        if (currentAtLink === undefined || arriveWalking < currentAtLink) {
          earliestArrival.set(link.stop_id, arriveWalking);
          parent.set(link.stop_id, {
            type: 'walk_transfer',
            fromStop: conn.toStop,
            toStop: link.stop_id,
            seconds: link.seconds,
            arrTime: arriveWalking,
          });
        }
      }

      if (destSet.has(conn.toStop)) {
        const totalArrival = conn.arrTime + destSet.get(conn.toStop);
        if (totalArrival < bestArrival) {
          bestArrival = totalArrival;
          bestDestStop = conn.toStop;
        }
      }
    }
  }

  if (bestDestStop === null) {
    return {
      error:
        'No se encontro una ruta en transporte publico para este horario. Intenta con otro horario u origen/destino.',
    };
  }

  // --- Reconstruir el itinerario recorriendo los punteros "parent" hacia atras ---
  const rawSteps = [];
  let cursor = bestDestStop;
  const guardLimit = 200;
  let guard = 0;
  while (cursor && guard < guardLimit) {
    guard++;
    const p = parent.get(cursor);
    if (!p) break;
    rawSteps.push({ stop_id: cursor, ...p });
    if (p.type === 'walk_start') break;
    cursor = p.fromStop;
  }
  rawSteps.reverse();

  // Convierte los pasos crudos en instrucciones legibles, fusionando
  // tramos consecutivos del mismo viaje en un solo "toma el bus X".
  const itinerary = [];

  const originStopInfo = gtfs.stops.get(originStops[0].stop_id);
  itinerary.push({
    kind: 'walk',
    walkType: 'to_stop',
    stopName: originStopInfo?.name,
    stopIsApprox: !!originStopInfo?.isApprox,
    text: `Camina hasta el paradero "${originStopInfo?.name}"`,
    seconds: originStops[0].seconds,
    fromCoord: { lat: fromLat, lon: fromLon },
    toCoord: originStopInfo ? { lat: originStopInfo.lat, lon: originStopInfo.lon } : null,
  });

  let i = 0;
  while (i < rawSteps.length) {
    const step = rawSteps[i];
    if (step.type === 'walk_start') {
      i++;
      continue;
    }
    if (step.type === 'walk_transfer') {
      const fromStopInfo = gtfs.stops.get(step.fromStop);
      const toStopInfo = gtfs.stops.get(step.toStop);
      itinerary.push({
        kind: 'walk',
        walkType: 'to_stop',
        stopName: toStopInfo?.name,
        stopIsApprox: !!toStopInfo?.isApprox,
        text: `Camina hasta el paradero "${toStopInfo?.name}"`,
        seconds: step.seconds,
        fromCoord: fromStopInfo ? { lat: fromStopInfo.lat, lon: fromStopInfo.lon } : null,
        toCoord: toStopInfo ? { lat: toStopInfo.lat, lon: toStopInfo.lon } : null,
      });
      i++;
      continue;
    }
    if (step.type === 'ride') {
      // fusiona tramos consecutivos del mismo trip
      let j = i;
      while (
        j + 1 < rawSteps.length &&
        rawSteps[j + 1].type === 'ride' &&
        rawSteps[j + 1].tripId === step.tripId
      ) {
        j++;
      }
      const last = rawSteps[j];
      const route = gtfs.routes.get(step.routeId);
      const trip = gtfs.trips.get(step.tripId);
      const boardStop = gtfs.stops.get(step.fromStop);
      const alightStop = gtfs.stops.get(last.toStop);
      const routeName = route ? route.short_name || route.long_name : step.routeId;
      const routeLongName = route && route.long_name !== routeName ? route.long_name : '';
      itinerary.push({
        kind: 'ride',
        routeId: step.routeId,
        routeName,
        routeLongName,
        boardStop: boardStop?.name,
        boardStopIsApprox: !!boardStop?.isApprox,
        alightStop: alightStop?.name,
        alightStopIsApprox: !!alightStop?.isApprox,
        boardCoord: boardStop ? { lat: boardStop.lat, lon: boardStop.lon } : null,
        alightCoord: alightStop ? { lat: alightStop.lat, lon: alightStop.lon } : null,
        departSeconds: step.depTime,
        arriveSeconds: last.arrTime,
        stopsCount: j - i + 2,
        shapeId: trip?.shape_id || null,
      });
      i = j + 1;
      continue;
    }
    i++;
  }

  const finalWalkSeconds = destSet.get(bestDestStop);
  const bestDestStopInfo = gtfs.stops.get(bestDestStop);
  itinerary.push({
    kind: 'walk',
    walkType: 'to_destination',
    stopName: bestDestStopInfo?.name,
    stopIsApprox: !!bestDestStopInfo?.isApprox,
    text: `Camina desde "${bestDestStopInfo?.name}" hasta tu destino`,
    seconds: finalWalkSeconds,
    fromCoord: bestDestStopInfo ? { lat: bestDestStopInfo.lat, lon: bestDestStopInfo.lon } : null,
    toCoord: { lat: toLat, lon: toLon },
  });

  const totalSeconds = bestArrival - depSeconds;

  return {
    itinerary,
    summary: {
      departSeconds: depSeconds,
      arriveSeconds: bestArrival,
      totalMinutes: Math.round(totalSeconds / 60),
      transfers: itinerary.filter((s) => s.kind === 'ride').length - 1,
    },
  };
}

function secondsToClock(seconds) {
  const s = ((seconds % 86400) + 86400) % 86400;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Calcula hasta `maxAlternatives` itinerarios distintos: el mejor, y
 * luego variantes forzando a NO usar ninguna de las rutas (buses/metro)
 * ya usadas en las alternativas anteriores. Asi el usuario puede elegir
 * entre, por ejemplo, "el Corredor Rojo" o "la combi tal" para el mismo
 * viaje.
 *
 * No siempre hay 3 alternativas genuinamente distintas disponibles (a
 * veces solo existe una forma razonable de llegar) -- en ese caso
 * devuelve las que sí encontro.
 */
function planTripAlternatives(gtfs, params, maxAlternatives = 3) {
  const alternatives = [];
  const excluded = new Set();
  let firstError = null;

  for (let attempt = 0; attempt < maxAlternatives; attempt++) {
    const result = planTrip(gtfs, { ...params, excludeRouteIds: excluded });
    if (result.error) {
      if (attempt === 0) firstError = result.error;
      break; // ya no hay mas alternativas posibles
    }
    alternatives.push(result);
    const usedRouteIds = result.itinerary
      .filter((s) => s.kind === 'ride')
      .map((s) => s.routeId);
    if (usedRouteIds.length === 0) break; // viaje solo a pie, no hay como diversificar
    usedRouteIds.forEach((id) => excluded.add(id));
  }

  if (alternatives.length === 0) {
    return { error: firstError || 'No se encontro ninguna ruta.' };
  }
  return { alternatives };
}

module.exports = { planTrip, planTripAlternatives, nearbyStops, secondsToClock };
