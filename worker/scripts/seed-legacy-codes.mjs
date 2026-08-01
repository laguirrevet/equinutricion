/**
 * Carga en KV los códigos antiguos que SÍ entregaste a un cliente real.
 *
 *   node scripts/seed-legacy-codes.mjs EN-MES-2026-CUHL EN-ANU-2026-ZVOG
 *   wrangler kv bulk put scripts/legacy-codes.kv.json --binding LICENSES --remote
 *
 * ⚠️  IMPORTANTE — por qué esto es selectivo y no carga los 200 de una vez:
 *
 * Los 200 códigos estuvieron dentro de index.html, que es un repositorio
 * público. Aunque ya los sacamos del archivo, siguen visibles para siempre en
 * el historial de git (`git log -p`). Cualquiera puede leerlos.
 *
 * Si los cargaras todos en KV, cualquier persona podría sacar uno del historial
 * y activar Premium gratis — justo el agujero que este cambio viene a cerrar.
 *
 * Carga únicamente los que le enviaste a alguien por WhatsApp y que todavía no
 * han sido activados. Quien ya activó su código conserva el acceso solo: la app
 * respeta el plan guardado en el teléfono hasta que venza.
 *
 * (Con --all los carga todos, pero asume el riesgo de arriba.)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const todos = args.includes('--all');
const pedidos = new Set(args.filter(a => !a.startsWith('--')).map(a => a.trim().toUpperCase()));

if (!todos && pedidos.size === 0) {
  console.error('Indica al menos un código:\n');
  console.error('  node scripts/seed-legacy-codes.mjs EN-MES-2026-CUHL EN-ANU-2026-ZVOG\n');
  console.error('Lee el comentario al inicio de este archivo antes de usar --all.');
  process.exit(1);
}

const catalogo = JSON.parse(readFileSync(join(here, 'legacy-codes.json'), 'utf8'));
const porCodigo = new Map(catalogo.map(c => [c.code, c]));

const seleccion = todos ? catalogo : [...pedidos].map(code => {
  const encontrado = porCodigo.get(code);
  if (!encontrado) {
    console.error(`✗ ${code} no existe en la lista original. Revisa que esté bien escrito.`);
    process.exit(1);
  }
  return encontrado;
});

const entries = seleccion.map(({ code, durationDays }) => ({
  key: `license:${code}`,
  value: JSON.stringify({
    plan: durationDays >= 365 ? 'anual' : 'mensual',
    durationDays,
    expiresAt: null, // el plazo empieza a correr cuando el cliente lo activa
    orderId: null,
    paymentId: null,
    devices: [],
    maxDevices: 3,
    legacy: true,
    createdAt: new Date().toISOString()
  })
}));

const outFile = join(here, 'legacy-codes.kv.json');
writeFileSync(outFile, JSON.stringify(entries, null, 2));

console.log(`${entries.length} código(s) listo(s) para cargar:`);
for (const { code, durationDays } of seleccion) console.log(`  ${code}  (${durationDays} días)`);
console.log('\nAhora ejecuta:');
console.log('  wrangler kv bulk put scripts/legacy-codes.kv.json --binding LICENSES --remote');
