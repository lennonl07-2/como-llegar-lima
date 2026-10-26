// scripts/osm-to-gtfs.js
//
// Convierte una exportacion "raw data" de Overpass API/Turbo (formato
// Overpass JSON: elements[] con nodes/ways/relations) en un feed GTFS
// SINTETICO: mismos paraderos y rutas reales que en OpenStreetMap, pero
// con horarios ESTIMADOS (no oficiales) porque OSM no incluye horarios
// reales de cada bus -- solo el trazado y el orden de paraderos.
//
// Que hace exactamente:
//  1. Lee todas las relaciones OSM con tags type=route y
//     route=bus|trolleybus|subway|light_rail dentro del area exportada.
//  2. Para cada relacion, extrae los miembros con role "stop"/"platform"
//     (el estandar PTv2 de OpenStreetMap) EN ORDEN -- ese orden define
//     la secuencia real de paraderos de la ruta.
//  3. Genera un horario sintetico: calcula tiempo de viaje entre
//     paraderos consecutivos usando distancia real (haversine) y una
//     velocidad promedio por tipo de servicio, y genera viajes (trips)
//     cada X minutos durante el horario de operacion tipico.
//
// Uso:
//   node scripts/osm-to-gtfs.js
//
// Espera el archivo en: backend/data/raw/overpass-export.json
// Escribe el feed en:   backend/data/gtfs/

const fs = require('fs');
const path = require('path');
const { haversineMeters } = require('../backend/gtfs/loader');

const RAW_DIR = path.join(__dirname, '..', 'backend', 'data', 'raw');
const OUT_DIR = path.join(__dirname, '..', 'backend', 'data', 'gtfs');

// Acepta tanto un unico "overpass-export.json" como varios archivos
// "overpass-export-*.json" (util cuando divides la consulta en partes
// para evitar timeouts del servidor publico de Overpass, ej. una
// exportacion para bus/trolleybus y otra para subway/light_rail).
function findRawFiles() {
  if (!fs.existsSync(RAW_DIR)) return [];
  return fs
    .readdirSync(RAW_DIR)
    .filter((f) => /^overpass-export.*\.json$/i.test(f))
    .map((f) => path.join(RAW_DIR, f));
}

// Velocidades promedio y frecuencias asumidas por tipo de servicio.
// Son aproximaciones razonables para Lima; ajustables aqui si notas que
// el tiempo estimado de tus rutas conocidas no cuadra con la realidad.
const MODE_PROFILES = {
  subway: { speedKmh: 32, headwayMinutes: 4, routeType: 1, label: 'Metro' },
  light_rail: { speedKmh: 32, headwayMinutes: 4, routeType: 1, label: 'Metro' },
  bus: { speedKmh: 16, headwayMinutes: 9, routeType: 3, label: 'Bus/Corredor' },
  trolleybus: { speedKmh: 16, headwayMinutes: 9, routeType: 3, label: 'Bus/Corredor' },
  minibus: { speedKmh: 14, headwayMinutes: 6, routeType: 3, label: 'Combi/Micro' },
  share_taxi: { speedKmh: 18, headwayMinutes: 5, routeType: 3, label: 'Colectivo' },
};

const SERVICE_START_SECONDS = 5 * 3600; // 05:00
const SERVICE_END_SECONDS = 23 * 3600; // 23:00
const DWELL_SECONDS_PER_STOP = 20; // tiempo estimado detenido en cada paradero

function csvEscape(value) {
  const s = String(value ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function writeCsv(filePath, header, rows) {
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(header.map((h) => csvEscape(row[h])).join(','));
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

function secondsToHHMMSS(totalSeconds) {
  const s = Math.round(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// --- Respaldo para rutas sin paraderos explicitos (role stop/platform) ---
// Muchas relaciones de bus en OSM Peru solo tienen el trazado de calles
// (miembros "way" sin rol) sin marcar cada paradero individualmente.
// En ese caso, reconstruimos el camino encadenando los "ways" en orden
// y generamos paraderos aproximados cada STEP_METERS a lo largo de la via.

const FALLBACK_STEP_METERS = 400;

function chainWayNodes(rel, waysById) {
  const wayMembers = rel.members.filter((m) => m.type === 'way');
  let chain = [];
  const nodeToWayName = new Map(); // node_id -> nombre de calle de la via de la que vino
  for (const wm of wayMembers) {
    const way = waysById.get(wm.ref);
    if (!way || !Array.isArray(way.nodes) || way.nodes.length === 0) continue;
    const streetName = way.tags?.name || null;
    for (const nid of way.nodes) {
      if (streetName && !nodeToWayName.has(nid)) nodeToWayName.set(nid, streetName);
    }
    if (chain.length === 0) {
      chain = chain.concat(way.nodes);
      continue;
    }
    const last = chain[chain.length - 1];
    if (way.nodes[0] === last) {
      chain = chain.concat(way.nodes.slice(1));
    } else if (way.nodes[way.nodes.length - 1] === last) {
      chain = chain.concat([...way.nodes].reverse().slice(1));
    } else {
      // segmento no contiguo (hueco en el mapeo) -- lo agregamos igual,
      // el muestreo por distancia simplemente saltara ese tramo
      chain = chain.concat(way.nodes);
    }
  }
  return { chain, nodeToWayName };
}

function sampleChain(nodeIds, nodesById, stepMeters) {
  const sampled = [];
  let accSinceLastSample = Infinity; // fuerza incluir el primer punto valido
  let prevNode = null;
  let lastValidId = null;
  for (const nid of nodeIds) {
    const node = nodesById.get(nid);
    if (!node || node.lat == null || node.lon == null) continue;
    if (prevNode) {
      accSinceLastSample += haversineMeters(prevNode.lat, prevNode.lon, node.lat, node.lon);
    }
    if (accSinceLastSample >= stepMeters) {
      sampled.push(nid);
      accSinceLastSample = 0;
    }
    prevNode = node;
    lastValidId = nid;
  }
  if (lastValidId && sampled[sampled.length - 1] !== lastValidId) {
    sampled.push(lastValidId);
  }
  return sampled;
}

// Elige nombres presentables para la ruta. Muchas relaciones de OSM en
// Peru usan "ref" como codigo tecnico interno (ej "X-CR23-I") que no
// significa nada para un pasajero. Cuando la relacion individual (un
// solo sentido/variante) no tiene un nombre decente, usamos el de su
// "route_master" (la agrupacion que sí suele llevar el nombre real del
// servicio, ej. "Corredor Rojo") si esta disponible.
function pickRouteNames(tags, profile, masterTags) {
  const ownRef = (tags.ref || '').trim();
  const ownName = (tags.name || '').trim();
  const masterRef = (masterTags?.ref || '').trim();
  const masterName = (masterTags?.name || '').trim();

  const looksLikeFriendlyRef = (r) => /^[0-9]{1,4}[A-Za-z]?$/.test(r);

  const name = ownName || masterName || '';
  const friendlyRef = looksLikeFriendlyRef(ownRef)
    ? ownRef
    : looksLikeFriendlyRef(masterRef)
    ? masterRef
    : '';
  const uglyRef = ownRef || masterRef || '';

  // Prioridad para el "short name" (la etiqueta principal que ve el
  // usuario): un numero de ruta amigable primero, si no hay eso el
  // nombre real del servicio, y si tampoco hay eso, un origen->destino
  // corto (mejor que un codigo tecnico interno sin significado).
  const fromTo = [tags.from, tags.to].filter(Boolean).join(' → ');
  let shortName = friendlyRef || name || fromTo || uglyRef || null;
  if (shortName && shortName.length > 32) shortName = `${shortName.slice(0, 31)}…`;

  let longName = name || fromTo || profile.label;

  if (shortName && longName && shortName === longName) {
    const route = [tags.from, tags.to].filter(Boolean).join(' — ');
    longName = route ? `${profile.label} · ${route}` : profile.label;
  }
  if (!shortName) shortName = longName;

  return { shortName, longName };
}

// Reduce puntos de shape consecutivos identicos/casi identicos (ruido de
// datos) para no inflar el archivo sin necesidad.
function dedupeCoords(coords) {
  const out = [];
  for (const c of coords) {
    const last = out[out.length - 1];
    if (!last || last.lat !== c.lat || last.lon !== c.lon) out.push(c);
  }
  return out;
}

function main() {
  const rawFiles = findRawFiles();
  if (rawFiles.length === 0) {
    console.error(`\nNo encuentro ningun overpass-export*.json en: ${RAW_DIR}`);
    console.error('Exporta primero desde Overpass Turbo (ver README, seccion OSM) y coloca el .json ahi.\n');
    process.exit(1);
  }

  const nodesById = new Map();
  const waysById = new Map();
  const relationsById = new Map();

  for (const filePath of rawFiles) {
    console.log(`Leyendo ${filePath} ...`);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const elements = raw.elements || [];
    for (const el of elements) {
      if (el.type === 'node') nodesById.set(el.id, el);
      else if (el.type === 'way') waysById.set(el.id, el);
      else if (el.type === 'relation') relationsById.set(el.id, el);
    }
  }
  const relations = Array.from(relationsById.values());

  console.log(
    `Elementos combinados de ${rawFiles.length} archivo(s): ${nodesById.size} nodos, ` +
      `${waysById.size} ways, ${relations.length} relaciones.`
  );

  const routeRelations = relations.filter(
    (r) => r.tags && r.tags.type === 'route' && MODE_PROFILES[r.tags.route]
  );

  // Mapea cada relacion "hija" (un sentido/variante especifico) a los
  // tags de su "route_master" (la agrupacion con el nombre real del
  // servicio), cuando existe.
  const masterTagsByChildId = new Map();
  const masterRelations = relations.filter((r) => r.tags && r.tags.type === 'route_master');
  for (const master of masterRelations) {
    for (const m of master.members) {
      if (m.type === 'relation') masterTagsByChildId.set(m.ref, master.tags);
    }
  }

  if (routeRelations.length === 0) {
    console.error(
      '\nNo se encontraron relaciones type=route con route=bus/trolleybus/minibus/share_taxi/subway/light_rail ' +
        'en el archivo exportado. Revisa que la consulta Overpass haya usado "out body; >; out skel qt;" ' +
        '(no solo geometria) para incluir las relaciones completas.\n'
    );
    process.exit(1);
  }

  const stopsOut = new Map(); // stop_id -> row
  const routesOut = [];
  const tripsOut = [];
  const stopTimesOut = [];
  const shapesOut = []; // shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence

  let usedRoutes = 0;
  let skippedRoutes = 0;
  let approximatedRoutes = 0;
  let routesWithShape = 0;

  for (const rel of routeRelations) {
    const mode = rel.tags.route;
    const profile = MODE_PROFILES[mode];

    // Geometria real de la via (encadenando los "ways" de la relacion en
    // orden). La usamos para 2 cosas: (a) dibujar el recorrido real en el
    // mapa (shapes.txt) y (b) como respaldo para generar paraderos
    // aproximados si la relacion no trae paraderos marcados.
    const { chain, nodeToWayName } = chainWayNodes(rel, waysById);

    // Miembros de parada, en el orden en que aparecen en la relacion
    // (convencion PTv2 de OpenStreetMap: el orden de los miembros con
    // role stop/platform es el orden real de la ruta).
    const stopMembers = rel.members.filter(
      (m) => m.type === 'node' && /^(stop|platform)/.test(m.role || '')
    );

    // Deduplicar paradas consecutivas repetidas (ida/vuelta mal mapeada,
    // o stop+platform del mismo lugar) sin perder el orden.
    const orderedStopIds = [];
    for (const m of stopMembers) {
      const node = nodesById.get(m.ref);
      if (!node || node.lat == null || node.lon == null) continue;
      const last = orderedStopIds[orderedStopIds.length - 1];
      if (last && last === m.ref) continue;
      orderedStopIds.push(m.ref);
    }

    let usedApproxStops = false;
    if (orderedStopIds.length < 2) {
      // Respaldo: esta ruta no tiene paraderos explicitos mapeados, pero
      // si tiene el trazado (ways) -- generamos paraderos aproximados
      // cada ~400m siguiendo la geometria real de la via.
      const sampled = sampleChain(chain, nodesById, FALLBACK_STEP_METERS);
      if (sampled.length < 2) {
        skippedRoutes++;
        continue; // ni paraderos ni trazado utilizable
      }
      orderedStopIds.length = 0;
      orderedStopIds.push(...sampled);
      approximatedRoutes++;
      usedApproxStops = true;
    }

    for (const nodeId of orderedStopIds) {
      if (!stopsOut.has(nodeId)) {
        const node = nodesById.get(nodeId);
        const officialName = node.tags?.name;
        let displayName = officialName;
        if (!displayName) {
          const streetName = nodeToWayName.get(nodeId);
          displayName = streetName
            ? `${streetName} (parada aprox.)`
            : `Parada aproximada`;
        }
        stopsOut.set(nodeId, {
          stop_id: `osm_${nodeId}`,
          stop_name: displayName,
          stop_lat: node.lat,
          stop_lon: node.lon,
          is_approx: officialName ? 0 : 1,
        });
      }
    }

    const routeId = `osm_rel_${rel.id}`;
    const masterTags = masterTagsByChildId.get(rel.id);
    const { shortName, longName } = pickRouteNames(rel.tags, profile, masterTags);
    const colour = rel.tags.colour || masterTags?.colour || '';

    routesOut.push({
      route_id: routeId,
      route_short_name: shortName,
      route_long_name: longName,
      route_type: profile.routeType,
      route_color: colour ? colour.replace('#', '') : '',
    });

    // Genera el shape (geometria real para dibujar en el mapa) a partir
    // del mismo chain de ways. Si la relacion no trajo ways utilizables,
    // no hay shape y el frontend usara una linea recta de respaldo solo
    // para esa ruta puntual.
    let shapeId = null;
    const shapeCoords = dedupeCoords(
      chain
        .map((nid) => nodesById.get(nid))
        .filter((n) => n && n.lat != null && n.lon != null)
        .map((n) => ({ lat: n.lat, lon: n.lon }))
    );
    if (shapeCoords.length >= 2) {
      shapeId = routeId;
      shapeCoords.forEach((c, i) => {
        shapesOut.push({
          shape_id: shapeId,
          shape_pt_lat: c.lat,
          shape_pt_lon: c.lon,
          shape_pt_sequence: i + 1,
        });
      });
      routesWithShape++;
    }

    // Tiempo acumulado entre paraderos consecutivos, segun distancia real y
    // velocidad promedio del modo, mas un tiempo fijo de detencion.
    const speedMps = (profile.speedKmh * 1000) / 3600;
    const cumulativeSeconds = [0];
    for (let i = 1; i < orderedStopIds.length; i++) {
      const a = nodesById.get(orderedStopIds[i - 1]);
      const b = nodesById.get(orderedStopIds[i]);
      const distMeters = haversineMeters(a.lat, a.lon, b.lat, b.lon);
      const travelSeconds = distMeters / speedMps + DWELL_SECONDS_PER_STOP;
      cumulativeSeconds.push(cumulativeSeconds[i - 1] + travelSeconds);
    }
    const cycleSeconds = cumulativeSeconds[cumulativeSeconds.length - 1];

    const headwaySeconds = profile.headwayMinutes * 60;
    let tripIndex = 0;
    for (
      let departure = SERVICE_START_SECONDS;
      departure + cycleSeconds <= SERVICE_END_SECONDS;
      departure += headwaySeconds
    ) {
      const tripId = `${routeId}_t${tripIndex++}`;
      tripsOut.push({
        trip_id: tripId,
        route_id: routeId,
        service_id: 'DAILY',
        trip_headsign: longName,
        shape_id: shapeId || '',
      });
      orderedStopIds.forEach((nodeId, seq) => {
        const t = departure + cumulativeSeconds[seq];
        stopTimesOut.push({
          trip_id: tripId,
          stop_id: `osm_${nodeId}`,
          arrival_time: secondsToHHMMSS(t),
          departure_time: secondsToHHMMSS(t),
          stop_sequence: seq + 1,
        });
      });
    }

    usedRoutes++;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  writeCsv(
    path.join(OUT_DIR, 'stops.txt'),
    ['stop_id', 'stop_name', 'stop_lat', 'stop_lon', 'is_approx'],
    Array.from(stopsOut.values())
  );
  writeCsv(
    path.join(OUT_DIR, 'routes.txt'),
    ['route_id', 'route_short_name', 'route_long_name', 'route_type', 'route_color'],
    routesOut
  );
  writeCsv(
    path.join(OUT_DIR, 'trips.txt'),
    ['trip_id', 'route_id', 'service_id', 'trip_headsign', 'shape_id'],
    tripsOut
  );
  writeCsv(
    path.join(OUT_DIR, 'stop_times.txt'),
    ['trip_id', 'stop_id', 'arrival_time', 'departure_time', 'stop_sequence'],
    stopTimesOut
  );
  writeCsv(
    path.join(OUT_DIR, 'shapes.txt'),
    ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence'],
    shapesOut
  );
  writeCsv(
    path.join(OUT_DIR, 'calendar.txt'),
    ['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date'],
    [
      {
        service_id: 'DAILY',
        monday: 1,
        tuesday: 1,
        wednesday: 1,
        thursday: 1,
        friday: 1,
        saturday: 1,
        sunday: 1,
        start_date: '20260101',
        end_date: '20271231',
      },
    ]
  );

  console.log(`\nListo. Feed GTFS sintetico generado en ${OUT_DIR}`);
  console.log(
    `  Rutas usadas: ${usedRoutes} (con paraderos aproximados por trazado: ${approximatedRoutes}, ` +
      `omitidas sin datos usables: ${skippedRoutes})`
  );
  console.log(`  Con geometria real para dibujar en el mapa: ${routesWithShape} de ${usedRoutes}`);
  console.log(`  Paraderos: ${stopsOut.size}`);
  console.log(`  Viajes generados: ${tripsOut.length}`);
  console.log(
    '\nRecuerda: los horarios son ESTIMADOS a partir de distancia + velocidad promedio,' +
      ' no son los horarios oficiales reales de cada bus.'
  );
}

main();
