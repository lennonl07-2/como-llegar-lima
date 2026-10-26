// scripts/prepare-data.js
// Descomprime backend/data/raw/gtfs.zip -> backend/data/gtfs/
// Uso: node scripts/prepare-data.js

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const RAW_ZIP = path.join(__dirname, '..', 'backend', 'data', 'raw', 'gtfs.zip');
const OUT_DIR = path.join(__dirname, '..', 'backend', 'data', 'gtfs');

if (!fs.existsSync(RAW_ZIP)) {
  console.error(`\nNo encuentro el archivo: ${RAW_ZIP}`);
  console.error('Descarga el GTFS.zip de Lima/Callao y colocalo exactamente en esa ruta.');
  console.error('Ver README.md seccion "Consigue los datos" para el link.\n');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

console.log(`Descomprimiendo ${RAW_ZIP} -> ${OUT_DIR}`);
const zip = new AdmZip(RAW_ZIP);
zip.extractAllTo(OUT_DIR, true);

const expected = ['stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt'];
const missing = expected.filter((f) => !fs.existsSync(path.join(OUT_DIR, f)));

if (missing.length > 0) {
  // Algunos feeds vienen con una subcarpeta adentro del zip; buscamos un nivel mas.
  const entries = fs.readdirSync(OUT_DIR, { withFileTypes: true });
  const subDir = entries.find((e) => e.isDirectory());
  if (subDir) {
    const nested = path.join(OUT_DIR, subDir.name);
    for (const file of fs.readdirSync(nested)) {
      fs.renameSync(path.join(nested, file), path.join(OUT_DIR, file));
    }
    fs.rmdirSync(nested);
  }
}

const stillMissing = expected.filter((f) => !fs.existsSync(path.join(OUT_DIR, f)));
if (stillMissing.length > 0) {
  console.error(`\nFaltan archivos esperados del GTFS: ${stillMissing.join(', ')}`);
  console.error('Revisa que el zip descargado sea un feed GTFS valido y completo.\n');
  process.exit(1);
}

console.log('Listo. Datos GTFS preparados en backend/data/gtfs/');
