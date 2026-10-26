// scripts/prepare-data.js
// Detecta automaticamente que fuente de datos colocaste y prepara el
// feed GTFS en backend/data/gtfs/ para que el servidor lo cargue.
//
//  - Si existe backend/data/raw/gtfs.zip           -> lo descomprime (feed real oficial)
//  - Si existe backend/data/raw/overpass-export.json -> lo convierte (feed sintetico desde OSM)
//
// Uso: node scripts/prepare-data.js

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RAW_DIR = path.join(__dirname, '..', 'backend', 'data', 'raw');
const ZIP_PATH = path.join(RAW_DIR, 'gtfs.zip');

const hasZip = fs.existsSync(ZIP_PATH);
const hasOverpass =
  fs.existsSync(RAW_DIR) &&
  fs.readdirSync(RAW_DIR).some((f) => /^overpass-export.*\.json$/i.test(f));

if (!hasZip && !hasOverpass) {
  console.error('\nNo encontre ninguna fuente de datos en backend/data/raw/.');
  console.error('Coloca uno de estos dos archivos ahi:');
  console.error('  - gtfs.zip                (feed GTFS oficial, si lo consigues)');
  console.error('  - overpass-export.json    (exportacion de Overpass Turbo, ver README)');
  console.error('    (tambien acepta varios archivos overpass-export-bus.json, overpass-export-metro.json, etc.)');
  console.error('\nEl camino recomendado por ahora es overpass-export.json -- ver README seccion "Consigue los datos".\n');
  process.exit(1);
}

if (hasZip) {
  console.log('Encontrado gtfs.zip -> usando feed GTFS oficial.');
  execSync(`node "${path.join(__dirname, 'unzip-gtfs.js')}"`, { stdio: 'inherit' });
} else {
  console.log('Encontrado(s) overpass-export*.json -> generando feed sintetico desde OpenStreetMap.');
  execSync(`node "${path.join(__dirname, 'osm-to-gtfs.js')}"`, { stdio: 'inherit' });
}
