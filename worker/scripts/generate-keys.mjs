/**
 * Genera el par de claves ECDSA P-256 que firma las licencias.
 *
 *   node scripts/generate-keys.mjs
 *
 * Entrega dos cosas:
 *   1. La clave PRIVADA  → se carga como secreto del Worker. Nunca al repositorio.
 *   2. La clave PÚBLICA  → se pega en index.html. Es pública a propósito:
 *      solo sirve para verificar firmas, no para crearlas.
 *
 * Ejecutar una sola vez. Si generas un par nuevo, todas las licencias ya
 * emitidas dejan de validar y los usuarios tendrán que reactivar con su código.
 */

import { webcrypto as crypto } from 'node:crypto';

const pair = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify']
);

const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);

// La app solo necesita estos campos para verificar
const publicForApp = { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y };

console.log('─'.repeat(70));
console.log('1) CLAVE PRIVADA — secreto del Worker');
console.log('─'.repeat(70));
console.log('Ejecuta:  wrangler secret put SIGNING_PRIVATE_KEY');
console.log('Y pega exactamente esta línea cuando te la pida:\n');
console.log(JSON.stringify(privateJwk));

console.log('\n' + '─'.repeat(70));
console.log('2) CLAVE PÚBLICA — va en index.html');
console.log('─'.repeat(70));
console.log('Reemplaza el valor de LICENSE_PUBLIC_KEY por:\n');
console.log(JSON.stringify(publicForApp, null, 1));

console.log('\n' + '─'.repeat(70));
console.log('Guarda la clave privada en un lugar seguro (un gestor de contraseñas).');
console.log('Si la pierdes, tendrás que reemitir todas las licencias.');
console.log('─'.repeat(70));
