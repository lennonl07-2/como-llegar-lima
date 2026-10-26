// app.js
// Toda la logica del cliente: mapa, autocompletado de direcciones (via
// nuestro backend, que a su vez usa Nominatim/OSM), y dibujo del
// itinerario devuelto por /api/route.

const LIMA_CENTER = [-12.0464, -77.0428];

const map = L.map('map').setView(LIMA_CENTER, 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
}).addTo(map);

let routeLayer = L.layerGroup().addTo(map);
let selected = { from: null, to: null };

const fromInput = document.getElementById('from-input');
const toInput = document.getElementById('to-input');
const fromSuggestions = document.getElementById('from-suggestions');
const toSuggestions = document.getElementById('to-suggestions');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const timeInput = document.getElementById('time-input');
const form = document.getElementById('search-form');
const swapBtn = document.getElementById('swap-btn');

// Hora de salida por defecto: ahora mismo
function nowLocalDatetimeValue() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}
timeInput.value = nowLocalDatetimeValue();

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

let requestSeq = { from: 0, to: 0 };
let inflightController = { from: null, to: null };

async function fetchSuggestions(query, side) {
  // Cancela la peticion anterior de este mismo campo si seguia en vuelo,
  // y descarta respuestas viejas que lleguen fuera de orden -- esto es lo
  // que causaba que el autocompletado pareciera "esperar" a que termines
  // de escribir: una respuesta antigua pisaba a una mas nueva.
  if (inflightController[side]) inflightController[side].abort();
  const controller = new AbortController();
  inflightController[side] = controller;
  const mySeq = ++requestSeq[side];

  try {
    const res = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`, {
      signal: controller.signal,
    });
    if (mySeq !== requestSeq[side]) return null; // llego una mas nueva mientras tanto, descartar
    if (!res.ok) return [];
    return res.json();
  } catch (err) {
    if (err.name === 'AbortError') return null;
    return [];
  }
}

function renderSuggestions(container, items, onPick) {
  container.innerHTML = '';
  if (items.length === 0) {
    container.classList.remove('visible');
    return;
  }
  for (const item of items) {
    const div = document.createElement('div');
    div.className = 'suggestion-item';
    div.textContent = item.label;
    div.addEventListener('click', () => onPick(item));
    container.appendChild(div);
  }
  container.classList.add('visible');
}

function wireAutocomplete(input, container, side) {
  const handler = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 3) {
      container.classList.remove('visible');
      return;
    }
    const items = await fetchSuggestions(q, side);
    if (items === null) return; // peticion cancelada u obsoleta, ignorar
    renderSuggestions(container, items, (item) => {
      input.value = item.label;
      selected[side] = { lat: item.lat, lon: item.lon, label: item.label };
      container.classList.remove('visible');
      updateMarker(side, item.lat, item.lon);
    });
  }, 200);

  input.addEventListener('input', () => {
    selected[side] = null;
    handler();
  });
  document.addEventListener('click', (e) => {
    if (!container.contains(e.target) && e.target !== input) {
      container.classList.remove('visible');
    }
  });
}

wireAutocomplete(fromInput, fromSuggestions, 'from');
wireAutocomplete(toInput, toSuggestions, 'to');

let markers = { from: null, to: null };
function updateMarker(side, lat, lon) {
  if (markers[side]) map.removeLayer(markers[side]);
  const color = side === 'from' ? '#2b8a3e' : '#c92a2a';
  markers[side] = L.circleMarker([lat, lon], {
    radius: 8,
    color,
    fillColor: color,
    fillOpacity: 0.9,
  }).addTo(map);
  if (markers.from && markers.to) {
    const group = L.featureGroup([markers.from, markers.to]);
    map.fitBounds(group.getBounds().pad(0.3));
  } else {
    map.setView([lat, lon], 15);
  }
}

swapBtn.addEventListener('click', () => {
  const fromVal = fromInput.value;
  const toVal = toInput.value;
  fromInput.value = toVal;
  toInput.value = fromVal;
  const tmp = selected.from;
  selected.from = selected.to;
  selected.to = tmp;
  if (selected.from) updateMarker('from', selected.from.lat, selected.from.lon);
  if (selected.to) updateMarker('to', selected.to.lat, selected.to.lon);
});

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
}

function minutesLabel(seconds) {
  const m = Math.round(seconds / 60);
  return m <= 1 ? '1 min' : `${m} min`;
}

let currentAlternatives = [];
let currentSelectedIndex = 0;

function routeNamesSummary(alt) {
  return alt.itinerary
    .filter((s) => s.kind === 'ride')
    .map((s) => s.routeName)
    .join(' + ');
}

function renderAlternativePicker(alternatives, selectedIndex) {
  if (alternatives.length <= 1) return null; // no hace falta selector si solo hay 1 opcion

  const wrap = document.createElement('div');
  wrap.className = 'alt-picker';
  alternatives.forEach((alt, idx) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'alt-card' + (idx === selectedIndex ? ' selected' : '');
    card.innerHTML = `
      <div class="alt-time">${alt.summary.totalMinutes} min</div>
      <div class="alt-routes">${routeNamesSummary(alt) || 'Solo caminando'}</div>
      <div class="alt-meta">${alt.summary.transfers > 0 ? alt.summary.transfers + ' transbordo(s)' : 'Sin transbordos'}</div>
    `;
    card.addEventListener('click', () => selectAlternative(idx));
    wrap.appendChild(card);
  });
  return wrap;
}

function selectAlternative(index) {
  currentSelectedIndex = index;
  renderResults();
  drawRouteOnMap(currentAlternatives[index].itinerary);
}

function renderResults() {
  resultsEl.innerHTML = '';

  const picker = renderAlternativePicker(currentAlternatives, currentSelectedIndex);
  if (picker) resultsEl.appendChild(picker);

  const data = currentAlternatives[currentSelectedIndex];

  const summary = document.createElement('div');
  summary.className = 'summary-card';
  summary.innerHTML = `
    <div class="big">${data.summary.totalMinutes} min</div>
    <div>Sale ${data.summary.departClock} · Llega ${data.summary.arriveClock}</div>
    <div>${data.summary.transfers > 0 ? data.summary.transfers + ' transbordo(s)' : 'Sin transbordos'}</div>
  `;
  resultsEl.appendChild(summary);

  for (const step of data.itinerary) {
    const row = document.createElement('div');
    row.className = 'step';
    if (step.kind === 'walk') {
      row.innerHTML = `
        <div class="step-icon walk">🚶</div>
        <div class="step-text">
          <div>${step.text}</div>
          <div class="muted">${minutesLabel(step.seconds)} caminando</div>
        </div>`;
    } else {
      const color = colorForRoute(step.routeName || 'ruta');
      row.innerHTML = `
        <div class="step-icon ride" style="background:${color}">🚌</div>
        <div class="step-text">
          <div class="route-name">${step.routeName}${step.routeLongName ? ' — ' + step.routeLongName : ''}</div>
          <div class="muted">Sube en "${step.boardStop}" (${step.departClock}) · Baja en "${step.alightStop}" (${step.arriveClock})</div>
        </div>`;
    }
    resultsEl.appendChild(row);
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (!selected.from || !selected.to) {
    setStatus('Elige una direccion de la lista de sugerencias para "Desde" y "Hacia".', true);
    return;
  }

  setStatus('Buscando rutas...');
  resultsEl.innerHTML = '';
  routeLayer.clearLayers();

  try {
    const res = await fetch('/api/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fromLat: selected.from.lat,
        fromLon: selected.from.lon,
        toLat: selected.to.lat,
        toLon: selected.to.lon,
        departure: timeInput.value ? new Date(timeInput.value).toISOString() : null,
      }),
    });
    const data = await res.json();

    if (!res.ok) {
      setStatus(data.error || 'No se encontro una ruta.', true);
      return;
    }

    setStatus('');
    currentAlternatives = data.alternatives;
    currentSelectedIndex = 0;
    renderResults();
    drawRouteOnMap(currentAlternatives[0].itinerary);
  } catch (err) {
    console.error(err);
    setStatus('Error de conexion con el servidor.', true);
  }
});

// Dibuja el recorrido real: caminatas como linea punteada gris, y cada
// tramo en bus/metro con la geometria real de la via (shapePoints que
// manda el backend) en el color de esa ruta. Si por algun motivo un
// tramo no trae geometria (ruta sin ways utilizables en OSM), cae de
// respaldo a una linea recta solo para ese tramo puntual.
const ROUTE_COLORS = ['#e8590c', '#1971c2', '#2f9e44', '#9c36b6', '#e64980', '#f08c00'];
function colorForRoute(routeName) {
  let hash = 0;
  for (let i = 0; i < routeName.length; i++) hash = (hash * 31 + routeName.charCodeAt(i)) >>> 0;
  return ROUTE_COLORS[hash % ROUTE_COLORS.length];
}

function drawRouteOnMap(itinerary) {
  const allPoints = [];

  for (const step of itinerary) {
    if (step.kind === 'walk') {
      const points = step.walkPoints && step.walkPoints.length >= 2
        ? step.walkPoints
        : (step.fromCoord && step.toCoord
            ? [[step.fromCoord.lat, step.fromCoord.lon], [step.toCoord.lat, step.toCoord.lon]]
            : null);
      if (points) {
        L.polyline(points, { color: '#6b6b6b', weight: 3, dashArray: '6 6' }).addTo(routeLayer);
        allPoints.push(...points);
      }
    } else if (step.kind === 'ride') {
      const color = colorForRoute(step.routeName || 'ruta');
      if (step.shapePoints && step.shapePoints.length >= 2) {
        L.polyline(step.shapePoints, { color, weight: 5, opacity: 0.9 }).addTo(routeLayer);
        allPoints.push(...step.shapePoints);
      } else if (step.boardCoord && step.alightCoord) {
        // Respaldo: sin geometria real para este tramo puntual
        const latlngs = [
          [step.boardCoord.lat, step.boardCoord.lon],
          [step.alightCoord.lat, step.alightCoord.lon],
        ];
        L.polyline(latlngs, { color, weight: 4, dashArray: '2 8' }).addTo(routeLayer);
        allPoints.push(...latlngs);
      }
      if (step.boardCoord) {
        L.circleMarker([step.boardCoord.lat, step.boardCoord.lon], {
          radius: 5,
          color,
          fillColor: color,
          fillOpacity: 1,
        }).addTo(routeLayer);
      }
      if (step.alightCoord) {
        L.circleMarker([step.alightCoord.lat, step.alightCoord.lon], {
          radius: 5,
          color,
          fillColor: '#fff',
          fillOpacity: 1,
          weight: 2,
        }).addTo(routeLayer);
      }
    }
  }

  if (allPoints.length > 0) {
    map.fitBounds(L.latLngBounds(allPoints).pad(0.15));
  }
}
