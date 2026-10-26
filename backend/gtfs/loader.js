// gtfs/loader.js
// Lee los archivos GTFS estandar (texto CSV) desde disco y los convierte
// en estructuras en memoria listas para el motor de rutas (router.js).
//
// GTFS = General Transit Feed Specification (gtfs.org). Es el mismo
// formato que usa Google Maps / Moovit / Citymapper para describir rutas,
// paraderos y horarios de transporte publico.

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

function readCsv(dir, filename, required = true) {
  const filePath = path.join(dir, filename);
  if (!fs.existsSync(filePath)) {
    if (required) {
      throw new Error(
        `Falta el archivo GTFS requerido: ${filename} en ${dir}\n` +
        `Revisa el README para saber donde colocar los datos.`
      );
    }
    return [];
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  return parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
}

// Convierte "HH:MM:SS" (GTFS permite horas >= 24 para servicios nocturnos)
// a segundos desde medianoche.
function timeToSeconds(hhmmss) {
  if (!hhmmss) return null;
  const parts = hhmmss.split(':').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  const [h, m, s] = parts;
  return h * 3600 + m * 60 + s;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Carga un directorio GTFS (ya descomprimido) y devuelve las estructuras
 * en memoria que usa el router:
 *  - stops: Map(stop_id -> {stop_id, name, lat, lon})
 *  - routes: Map(route_id -> {route_id, short_name, long_name, type, color})
 *  - trips: Map(trip_id -> {trip_id, route_id, service_id, headsign})
 *  - services: Map(service_id -> {days:[0..6 bool], startDate, endDate, added:Set(date), removed:Set(date)})
 *  - stopTimesByTrip: Map(trip_id -> [{stop_id, arrival, departure, seq}, ...]) ordenado por seq
 *  - connections: array plano de conexiones {tripId, routeId, fromStop, toStop, depTime, arrTime}
 *    (una por cada tramo entre dos paradas consecutivas de un viaje) -- listo para Connection Scan Algorithm
 *  - footpaths: Map(stop_id -> [{stop_id, seconds}]) transbordos a pie entre paraderos cercanos
 */
function loadGtfs(gtfsDir, opts = {}) {
  const maxWalkTransferMeters = opts.maxWalkTransferMeters ?? 350;
  const walkSpeedMps = opts.walkSpeedMps ?? 1.3; // ritmo peatonal urbano promedio

  console.log(`[gtfs] Cargando feed desde: ${gtfsDir}`);

  const stopsRaw = readCsv(gtfsDir, 'stops.txt');
  const routesRaw = readCsv(gtfsDir, 'routes.txt');
  const tripsRaw = readCsv(gtfsDir, 'trips.txt');
  const stopTimesRaw = readCsv(gtfsDir, 'stop_times.txt');
  const calendarRaw = readCsv(gtfsDir, 'calendar.txt', false);
  const calendarDatesRaw = readCsv(gtfsDir, 'calendar_dates.txt', false);
  const shapesRaw = readCsv(gtfsDir, 'shapes.txt', false);

  // --- stops ---
  const stops = new Map();
  for (const s of stopsRaw) {
    const lat = parseFloat(s.stop_lat);
    const lon = parseFloat(s.stop_lon);
    if (Number.isNaN(lat) || Number.isNaN(lon)) continue;
    stops.set(s.stop_id, {
      stop_id: s.stop_id,
      name: s.stop_name || s.stop_id,
      lat,
      lon,
      isApprox: s.is_approx === '1',
    });
  }

  // --- routes ---
  const routes = new Map();
  for (const r of routesRaw) {
    routes.set(r.route_id, {
      route_id: r.route_id,
      short_name: r.route_short_name || '',
      long_name: r.route_long_name || '',
      type: r.route_type,
      color: r.route_color ? `#${r.route_color}` : null,
    });
  }

  // --- trips ---
  const trips = new Map();
  for (const t of tripsRaw) {
    trips.set(t.trip_id, {
      trip_id: t.trip_id,
      route_id: t.route_id,
      service_id: t.service_id,
      headsign: t.trip_headsign || '',
      shape_id: t.shape_id || null,
    });
  }

  // --- shapes: geometria real del recorrido, para dibujar en el mapa ---
  const shapes = new Map(); // shape_id -> [{lat, lon, seq}] ordenado
  for (const s of shapesRaw) {
    const lat = parseFloat(s.shape_pt_lat);
    const lon = parseFloat(s.shape_pt_lon);
    if (Number.isNaN(lat) || Number.isNaN(lon)) continue;
    if (!shapes.has(s.shape_id)) shapes.set(s.shape_id, []);
    shapes.get(s.shape_id).push({
      lat,
      lon,
      seq: parseInt(s.shape_pt_sequence, 10) || 0,
    });
  }
  for (const arr of shapes.values()) {
    arr.sort((a, b) => a.seq - b.seq);
  }

  // --- services (calendar + calendar_dates) ---
  const dayCols = [
    'sunday',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
  ];
  const services = new Map();
  for (const c of calendarRaw) {
    services.set(c.service_id, {
      days: dayCols.map((d) => c[d] === '1'),
      startDate: c.start_date,
      endDate: c.end_date,
      added: new Set(),
      removed: new Set(),
    });
  }
  for (const cd of calendarDatesRaw) {
    if (!services.has(cd.service_id)) {
      services.set(cd.service_id, {
        days: [false, false, false, false, false, false, false],
        startDate: null,
        endDate: null,
        added: new Set(),
        removed: new Set(),
      });
    }
    const svc = services.get(cd.service_id);
    if (cd.exception_type === '1') svc.added.add(cd.date);
    else if (cd.exception_type === '2') svc.removed.add(cd.date);
  }

  // --- stop_times agrupado por trip, ordenado por stop_sequence ---
  const stopTimesByTrip = new Map();
  for (const st of stopTimesRaw) {
    if (!stopTimesByTrip.has(st.trip_id)) stopTimesByTrip.set(st.trip_id, []);
    stopTimesByTrip.get(st.trip_id).push({
      stop_id: st.stop_id,
      arrival: timeToSeconds(st.arrival_time),
      departure: timeToSeconds(st.departure_time),
      seq: parseInt(st.stop_sequence, 10),
    });
  }
  for (const arr of stopTimesByTrip.values()) {
    arr.sort((a, b) => a.seq - b.seq);
  }

  // --- connections planas (una por tramo entre paradas consecutivas) ---
  const connections = [];
  for (const [tripId, seq] of stopTimesByTrip.entries()) {
    const trip = trips.get(tripId);
    if (!trip) continue;
    for (let i = 0; i < seq.length - 1; i++) {
      const from = seq[i];
      const to = seq[i + 1];
      if (from.departure == null || to.arrival == null) continue;
      connections.push({
        tripId,
        routeId: trip.route_id,
        fromStop: from.stop_id,
        toStop: to.stop_id,
        depTime: from.departure,
        arrTime: to.arrival,
      });
    }
  }
  connections.sort((a, b) => a.depTime - b.depTime);

  // --- footpaths: transbordos a pie entre paraderos cercanos ---
  // Nota: fuerza bruta O(n^2). Para el tamano tipico de un feed de una
  // ciudad (miles de paraderos) esto corre en un par de segundos al
  // iniciar el servidor; se cachea despues en memoria.
  const stopList = Array.from(stops.values());
  const footpaths = new Map();
  const cellSize = 0.01; // grados (~1.1km) para indexar en grilla y no comparar todos contra todos
  const grid = new Map();
  const cellKey = (lat, lon) =>
    `${Math.floor(lat / cellSize)}:${Math.floor(lon / cellSize)}`;
  for (const s of stopList) {
    const k = cellKey(s.lat, s.lon);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(s);
  }
  for (const s of stopList) {
    const [cx, cy] = cellKey(s.lat, s.lon).split(':').map(Number);
    const nearby = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(`${cx + dx}:${cy + dy}`);
        if (bucket) nearby.push(...bucket);
      }
    }
    const links = [];
    for (const other of nearby) {
      if (other.stop_id === s.stop_id) continue;
      const d = haversineMeters(s.lat, s.lon, other.lat, other.lon);
      if (d <= maxWalkTransferMeters) {
        links.push({ stop_id: other.stop_id, seconds: Math.round(d / walkSpeedMps) });
      }
    }
    footpaths.set(s.stop_id, links);
  }

  console.log(
    `[gtfs] Cargado: ${stops.size} paraderos, ${routes.size} rutas, ${trips.size} viajes, ` +
      `${connections.length} conexiones, footpaths calculados.`
  );

  return {
    stops,
    routes,
    trips,
    services,
    stopTimesByTrip,
    connections,
    footpaths,
    walkSpeedMps,
    shapes,
  };
}

module.exports = { loadGtfs, haversineMeters, timeToSeconds };
