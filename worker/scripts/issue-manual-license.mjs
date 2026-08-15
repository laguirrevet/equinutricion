/**
 * Emite a mano una licencia Premium, sin pasar por Mercado Pago.
 *
 * Para los casos que no son una compra: convenios, canjes, cortesías, clientes
 * que pagaron por transferencia. La licencia queda igual que una comprada —
 * mismo formato de código, misma firma, misma activación — solo que sin pago
 * asociado.
 *
 *   node scripts/issue-manual-license.mjs --plan anual --cliente "Criadero X" --desde 2026-08-18
 *
 * Opciones:
 *   --plan      mensual | anual                      (por defecto: anual)
 *   --cliente   a quién se le entrega                (queda guardado en KV)
 *   --desde     AAAA-MM-DD en que empieza a correr   (por defecto: al activar)
 *   --dias      duración                             (365 con --desde; si no, la del plan)
 *   --equipos   dispositivos permitidos              (por defecto: 3)
 *
 * Sin --desde, el plazo arranca cuando el cliente activa el código, igual que
 * una licencia comprada. Con --desde, la ventana queda fija: vence ese día del
 * año siguiente pase lo que pase, y activar antes o después no la mueve.
 *
 * El script solo escribe el archivo; la carga en KV es el comando que imprime
 * al final. Nada se aplica hasta ejecutarlo.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

// Debe coincidir con PLANS y CODE_ALPHABET en src/index.js
const PLANS = {
  mensual: { durationDays: 30, prefix: 'EN-M26' },
  anual: { durationDays: 395, prefix: 'EN-A26' }
};
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;
const MAX_DEVICES = 3;

// Chile en agosto está en UTC-4; el código vence al final del día local
const CHILE_OFFSET = '-04:00';

const here = dirname(fileURLToPath(import.meta.url));

function arg(nombre, porDefecto = null) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i === -1 || !process.argv[i + 1] ? porDefecto : process.argv[i + 1];
}

const planKey = arg('plan', 'anual');
const plan = PLANS[planKey];
if (!plan) {
  console.error(`Plan desconocido: ${planKey}. Usa mensual o anual.`);
  process.exit(1);
}

const cliente = arg('cliente');
const desde = arg('desde');
const equipos = parseInt(arg('equipos', String(MAX_DEVICES)), 10);

if (desde && !/^\d{4}-\d{2}-\d{2}$/.test(desde)) {
  console.error(`--desde debe ser AAAA-MM-DD, no "${desde}".`);
  process.exit(1);
}

const dias = parseInt(arg('dias', String(desde ? 365 : plan.durationDays)), 10);

// El módulo sesga los últimos valores del byte, pero el alfabeto tiene 32
// símbolos y 256 es múltiplo exacto: aquí el reparto es uniforme.
let cuerpo = '';
for (const byte of randomBytes(CODE_LENGTH)) cuerpo += CODE_ALPHABET[byte % CODE_ALPHABET.length];
const code = `${plan.prefix}-${cuerpo}`;

let expiresAt = null;
let venceEl = null;
if (desde) {
  // Vence al terminar el día del aniversario: --desde 2026-08-18 --dias 365
  // da hasta el 18 de agosto de 2027 completo. Es un día más que los 365
  // exactos, y es a propósito: nadie entiende que un año contado desde el 18
  // se acabe el 17, y el margen juega a favor del cliente.
  const fin = new Date(`${desde}T00:00:00${CHILE_OFFSET}`);
  fin.setDate(fin.getDate() + dias);
  venceEl = fin.toISOString().slice(0, 10);
  expiresAt = new Date(`${venceEl}T23:59:59.999${CHILE_OFFSET}`).toISOString();
}

const license = {
  plan: planKey,
  durationDays: dias,
  expiresAt,
  orderId: null,
  paymentId: null,
  devices: [],
  maxDevices: equipos,
  manual: true,
  ...(cliente ? { cliente } : {}),
  ...(desde ? { startsAt: desde } : {}),
  createdAt: new Date().toISOString()
};

const outFile = join(here, 'manual-license.kv.json');
writeFileSync(outFile, JSON.stringify([{ key: `license:${code}`, value: JSON.stringify(license) }], null, 2));

console.log(`\n  Código:   ${code}`);
console.log(`  Plan:     ${planKey} (${dias} días)`);
if (cliente) console.log(`  Cliente:  ${cliente}`);
console.log(`  Vigencia: ${desde ? `${desde} → ${venceEl} inclusive (${expiresAt})` : 'arranca al activar'}`);
console.log(`  Equipos:  ${equipos}`);
console.log('\nPara cargarlo:');
console.log('  npx wrangler kv bulk put scripts/manual-license.kv.json --binding LICENSES --remote\n');
