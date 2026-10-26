# Cómo Llegar — Planificador de transporte público para Lima y Callao

App tipo Moovit/Google Maps enfocada solo en Lima Metropolitana y Callao.
Motor de rutas propio (no depende de Google Maps API ni de servicios de pago),
corriendo 100% en tu máquina.

## Qué hace

- Buscas una dirección de origen y una de destino (autocompletado real vía OSM).
- Calcula **hasta 3 alternativas de ruta** (con distintos buses/combis/
  corredores cuando existen) para que elijas cuál te conviene más — igual
  que Moovit te muestra varias opciones.
- Te muestra paso a paso: caminar, qué ruta/bus tomar, dónde subir y bajar,
  y en qué paradero hacer transbordo si aplica.
- Las caminatas y los recorridos en bus siguen calles y veredas reales en
  el mapa (no líneas rectas cruzando manzanas).
- Todo el mapa se dibuja con Leaflet + tiles de OpenStreetMap (gratis, sin
  API key, sin límite de uso).

## Arquitectura (por qué está armado así)

```
frontend/   -> HTML + JS plano con Leaflet. Sin build, sin npm, se sirve directo.
backend/    -> Node + Express. Carga el feed UNA vez en memoria al arrancar
               y expone 2 endpoints: /api/geocode y /api/route.
backend/gtfs/router.js -> el "cerebro": Connection Scan Algorithm (CSA),
               el mismo tipo de algoritmo académico detrás de planificadores
               de transporte público reales.
scripts/osm-to-gtfs.js -> convierte datos de OpenStreetMap (rutas de bus,
               Corredores, Metro ya mapeadas por la comunidad) al formato
               GTFS que el router entiende, con horarios ESTIMADOS.
```

## Sobre los datos — lectura importante

Investigué a fondo (incluyendo lo que ya revisaste tú en MobilityDatabase,
Transitland y Overpass) y la conclusión es: **Lima no tiene un feed GTFS
oficial publicado abiertamente.** Google Maps usa datos que le entregaron
directamente, pero no están disponibles para el público. Los resultados que
te salieron en Transitland ("Limassol", "Limay") eran falsos positivos por
coincidencia de texto, y el de MobilityDatabase era de bicis compartidas,
no de buses.

Por eso el camino real es: **usar OpenStreetMap**, donde la comunidad
peruana lleva mapeando los Corredores, el Metropolitano y la Línea 1 del
Metro desde 2014. No tiene horarios exactos, así que el script
`osm-to-gtfs.js` los estima con velocidad promedio por tipo de servicio —
suficiente para calcular rutas y transbordos correctamente; el minuto
exacto de cada bus puede variar un poco frente a la realidad.

## 1. Consigue los datos (único paso manual)

1. Abre **https://overpass-turbo.eu/**
2. Borra el contenido del editor (donde tenías la consulta de ejemplo) y
   pega exactamente esto:

   ```
   [out:json][timeout:180];
   (
     relation["type"="route"]["route"~"^(bus|trolleybus|minibus|share_taxi)$"](-12.35,-77.25,-11.60,-76.75);
     relation["type"="route"]["route"~"^(subway|light_rail)$"](-12.35,-77.25,-11.60,-76.75);
     relation["type"="route_master"](-12.35,-77.25,-11.60,-76.75);
   );
   out body;
   >;
   out skel qt;
   ```

   (Esas 4 coordenadas son el rectángulo que cubre Lima Metropolitana +
   Callao. Agregué `minibus` y `share_taxi` — así se etiquetan en OSM las
   combis/micros y los colectivos informales — y las relaciones
   `route_master`, que traen el nombre "bonito" real del servicio cuando
   la ruta individual solo tiene un código técnico interno.)

3. Click en **Ejecutar**. Puede tardar 20-60 segundos, es una consulta grande.
4. Click en **Exportar** → elige **"download as data (raw OSM data)"**
   (⚠️ NO elijas GeoJSON — ese formato pierde el orden de los paraderos
   que necesito para armar las rutas correctamente).
5. Te descarga un `.json`. Renómbralo a `overpass-export.json` y colócalo
   exactamente aquí:

   ```
   backend/data/raw/overpass-export.json
   ```

## 2. Prepara los datos

```bash
cd lima-transporte
npm install --prefix backend
npm run prepare-data --prefix backend
```

El script detecta automáticamente que colocaste el archivo de Overpass y
genera el feed GTFS sintético en `backend/data/gtfs/`. Verás en consola
cuántas rutas, paraderos y viajes generó.

Si en el futuro alguna vez aparece un GTFS oficial real de Lima, el mismo
comando lo detecta solo con que coloques `backend/data/raw/gtfs.zip` en
vez del archivo de Overpass — no hay que tocar nada más.

## 3. Corre el servidor

```bash
npm start --prefix backend
```

Abre **http://localhost:3000** — ahí está la app completa (mapa + buscador).

## Servicios externos que usa la app (todos gratis, sin API key)

- **Nominatim** (OpenStreetMap) — geocodifica las direcciones que escribes,
  y también resuelve el nombre aproximado ("cerca de Jr. Ica 245") de los
  paraderos que no tienen nombre oficial en OSM.
- **routing.openstreetmap.de (perfil foot)** — calcula el trazado peatonal
  real para cada tramo a pie, siguiendo veredas y calles en vez de una
  línea recta. Es el mismo servicio que usa el botón "Cómo llegar" de
  openstreetmap.org.
- **routing.openstreetmap.de (perfil car)** — respaldo para cuando una
  ruta de bus/combi no trajo geometría propia desde OSM: traza un camino
  siguiendo calles reales entre el paradero de subida y el de bajada (no
  es el recorrido exacto del bus, pero es real, no una línea recta
  cruzando la ciudad).

Si alguno de estos servicios está caído o sin respuesta, la app no se
rompe: cae de respaldo a línea recta para ese tramo puntual y sigue
funcionando con el resto.

## Sobre las alternativas de ruta

Cuando hay más de una forma razonable de llegar, la app calcula hasta 3
opciones: la más rápida, y luego variantes forzando a NO usar ninguna de
las rutas ya usadas en las opciones anteriores. Así puedes ver, por
ejemplo, "Corredor Rojo, 25 min" junto a "La Chalaca + combi 105, 31 min"
y elegir la que prefieras. No siempre hay 3 alternativas genuinamente
distintas — a veces solo existe una forma razonable de llegar con el
transporte mapeado en tu zona, y ahí solo aparecerá una opción.

## Limitaciones actuales (a propósito, para no sobre-construir de una)

- **Horarios estimados, no oficiales.** El conversor asume velocidad
  promedio por tipo de servicio (Metro, Corredor/bus, combi, colectivo)
  y frecuencia fija de 5am a 11pm todos los días. Es una aproximación
  razonable para planear, no el horario exacto minuto a minuto.
- **Nombres de rutas**: uso el `name` de OSM cuando existe, si no el de
  su `route_master`, si no un número de ruta amigable, y si nada de eso
  existe en los datos, muestro origen→destino en vez de inventar un
  nombre coloquial que no está en la fuente. Si conoces el nombre real
  de alguna ruta que sale como código o como "A → B" y quieres que se
  vea bien, se puede corregir agregando el tag `name` a esa relación
  directamente en OpenStreetMap (osm.org/edit) — así queda arreglado
  para siempre y no solo en tu copia local.
- **Nombres de paraderos aproximados** ("cerca de Jr. X") son eso —
  aproximados por geocodificación en reversa, no el nombre oficial del
  paradero, porque esa ruta específica no tiene paraderos marcados
  individualmente en OpenStreetMap.
- **Cobertura depende de qué tan mapeado esté en OSM.** Si una ruta
  específica no aparece, probablemente esa relación todavía no está
  completa en OpenStreetMap.

## Siguiente iteración sugerida

1. Afinar las velocidades/frecuencias del conversor comparando con
   tiempos reales que tú conozcas de memoria (ej. "el Corredor Rojo de
   Javier Prado a Centro tarda tanto").
2. Guardar búsquedas frecuentes / "ir a casa" con un click.
3. Deploy gratuito: Render.com o Railway (planes free) para tenerlo
   accesible desde el celular sin dejar tu PC prendida.
