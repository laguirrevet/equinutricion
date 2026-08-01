/**
 * EquiNutrición — API de licencias Premium
 *
 * Cloudflare Worker que conecta la app (GitHub Pages, estática) con Mercado Pago.
 *
 * Endpoints:
 *   POST /api/checkout  → crea la preferencia de pago, devuelve el link de Mercado Pago
 *   POST /api/webhook   → Mercado Pago avisa el pago; aquí se emite la licencia
 *   POST /api/claim     → la app reclama la licencia al volver del pago
 *   POST /api/activate  → activación manual con código (reinstalación / otro teléfono)
 *
 * Secretos requeridos (wrangler secret put ...):
 *   MP_ACCESS_TOKEN      Access token de producción de Mercado Pago
 *   MP_WEBHOOK_SECRET    Clave secreta del webhook, para validar la firma
 *   SIGNING_PRIVATE_KEY  Clave privada ECDSA P-256 en formato JWK (JSON)
 */

// ═══════════════════════════════════════════════════════
// CONFIGURACIÓN
// ═══════════════════════════════════════════════════════

const PLANS = {
  mensual: {
    title: 'EquiNutrición Premium — Plan mensual',
    price: 4000,
    durationDays: 30,
    prefix: 'EN-M26'
  },
  anual: {
    // 365 días + el primer mes gratis que promete la app = 395
    title: 'EquiNutrición Premium — Plan anual',
    price: 35000,
    durationDays: 395,
    prefix: 'EN-A26'
  }
};

const MAX_DEVICES = 3;

// Sin I, O, 0, 1 — para que nadie confunda un código dictado por teléfono
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;

const MP_API = 'https://api.mercadopago.com';

// Cuánto vive una orden pendiente antes de que KV la borre sola (24 h)
const ORDER_TTL = 86400;

// ═══════════════════════════════════════════════════════
// UTILIDADES
// ═══════════════════════════════════════════════════════

const enc = new TextEncoder();

function b64urlEncode(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Comparación en tiempo constante — evita filtrar información por timing. */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function generateCode(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let body = '';
  for (const byte of bytes) body += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return `${prefix}-${body}`;
}

function normalizeCode(raw) {
  return String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
}

function addDays(date, days) {
  const out = new Date(date);
  out.setDate(out.getDate() + days);
  return out;
}

// ═══════════════════════════════════════════════════════
// RESPUESTAS Y CORS
// ═══════════════════════════════════════════════════════

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = allowedOrigins(env);
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  if (origin && allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(data, { status = 200, request, env } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(request ? corsHeaders(request, env) : {})
    }
  });
}

// ═══════════════════════════════════════════════════════
// FIRMA DE LICENCIAS (ECDSA P-256)
// ═══════════════════════════════════════════════════════

let cachedSigningKey = null;

async function getSigningKey(env) {
  if (cachedSigningKey) return cachedSigningKey;
  if (!env.SIGNING_PRIVATE_KEY) throw new Error('Falta el secreto SIGNING_PRIVATE_KEY');
  const jwk = JSON.parse(env.SIGNING_PRIVATE_KEY);
  cachedSigningKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  return cachedSigningKey;
}

/**
 * Emite el token que la app guarda y verifica offline con la clave pública.
 * Formato: base64url(payload).base64url(firma)
 */
async function signLicenseToken(env, { deviceId, code, plan, expiresAt }) {
  const payload = {
    v: 1,
    d: deviceId,
    c: code,
    p: plan,
    exp: Math.floor(new Date(expiresAt).getTime() / 1000),
    iat: Math.floor(Date.now() / 1000)
  };
  const payloadB64 = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const key = await getSigningKey(env);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    enc.encode(payloadB64)
  );
  return `${payloadB64}.${b64urlEncode(signature)}`;
}

// ═══════════════════════════════════════════════════════
// MERCADO PAGO
// ═══════════════════════════════════════════════════════

async function mpFetch(env, path, options = {}) {
  if (!env.MP_ACCESS_TOKEN) throw new Error('Falta el secreto MP_ACCESS_TOKEN');
  const response = await fetch(`${MP_API}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${env.MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    throw new Error(`Mercado Pago ${response.status} en ${path}: ${text.slice(0, 400)}`);
  }
  return body;
}

/**
 * Valida la firma del webhook.
 * Manifiesto: id:<data.id>;request-id:<x-request-id>;ts:<ts>;
 * HMAC-SHA256 en hexadecimal usando MP_WEBHOOK_SECRET.
 */
async function verifyWebhookSignature(request, env, dataId) {
  const signatureHeader = request.headers.get('x-signature');
  const requestId = request.headers.get('x-request-id');
  if (!signatureHeader || !env.MP_WEBHOOK_SECRET) return false;

  let ts = null;
  let v1 = null;
  for (const part of signatureHeader.split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === 'ts') ts = value;
    else if (key === 'v1') v1 = value;
  }
  if (!ts || !v1) return false;

  // Mercado Pago exige minúsculas cuando el id es alfanumérico
  const normalizedId = String(dataId || '').toLowerCase();

  // Si un valor no viene en la notificación, se omite del manifiesto
  let manifest = '';
  if (normalizedId) manifest += `id:${normalizedId};`;
  if (requestId) manifest += `request-id:${requestId};`;
  manifest += `ts:${ts};`;

  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(env.MP_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const computed = toHex(await crypto.subtle.sign('HMAC', key, enc.encode(manifest)));
  return timingSafeEqual(computed, v1.toLowerCase());
}

// ═══════════════════════════════════════════════════════
// LICENCIAS
// ═══════════════════════════════════════════════════════

/**
 * Crea la licencia de una orden pagada. Idempotente: si el mismo pago ya
 * generó una licencia, devuelve la existente en vez de emitir otra.
 */
async function issueLicense(env, { orderId, paymentId, planKey }) {
  const paymentKey = `payment:${paymentId}`;
  const existing = await env.LICENSES.get(paymentKey);
  if (existing) return existing;

  const plan = PLANS[planKey];
  if (!plan) throw new Error(`Plan desconocido: ${planKey}`);

  const code = generateCode(plan.prefix);
  const license = {
    plan: planKey,
    durationDays: plan.durationDays,
    expiresAt: null, // se fija en la primera activación
    orderId,
    paymentId,
    devices: [],
    maxDevices: MAX_DEVICES,
    createdAt: new Date().toISOString()
  };

  await env.LICENSES.put(`license:${code}`, JSON.stringify(license));
  await env.LICENSES.put(paymentKey, code);

  const order = JSON.parse((await env.LICENSES.get(`order:${orderId}`)) || '{}');
  await env.LICENSES.put(
    `order:${orderId}`,
    JSON.stringify({ ...order, plan: planKey, status: 'paid', code, paymentId, paidAt: new Date().toISOString() }),
    { expirationTtl: ORDER_TTL }
  );

  // Se registra aquí, y no en quien llama, para que toda licencia deje rastro
  // sin importar por qué camino se emitió.
  console.log(`Licencia ${code} emitida — orden ${orderId}, pago ${paymentId}, plan ${planKey}`);

  return code;
}

/**
 * Registra un dispositivo en una licencia y devuelve el token firmado.
 * En la primera activación arranca el plazo del plan.
 */
async function activateLicense(env, code, deviceId) {
  const raw = await env.LICENSES.get(`license:${code}`);
  if (!raw) return { error: 'invalid' };

  const license = JSON.parse(raw);
  const now = new Date();

  if (!license.expiresAt) {
    license.expiresAt = addDays(now, license.durationDays).toISOString();
  } else if (new Date(license.expiresAt) < now) {
    return { error: 'expired' };
  }

  const devices = Array.isArray(license.devices) ? license.devices : [];
  if (!devices.includes(deviceId)) {
    if (devices.length >= (license.maxDevices || MAX_DEVICES)) {
      return { error: 'device_limit' };
    }
    devices.push(deviceId);
  }
  license.devices = devices;
  license.lastActivatedAt = now.toISOString();

  await env.LICENSES.put(`license:${code}`, JSON.stringify(license));

  const token = await signLicenseToken(env, {
    deviceId,
    code,
    plan: 'premium',
    expiresAt: license.expiresAt
  });

  return { token, code, expiresAt: license.expiresAt };
}

/** Límite por IP para que los códigos no se puedan adivinar por fuerza bruta. */
async function checkRateLimit(env, request, bucket, limit, windowSeconds) {
  const ip = request.headers.get('CF-Connecting-IP') || 'desconocida';
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `rl:${bucket}:${ip}:${window}`;
  const count = parseInt((await env.LICENSES.get(key)) || '0', 10);
  if (count >= limit) return false;
  await env.LICENSES.put(key, String(count + 1), { expirationTtl: windowSeconds * 2 });
  return true;
}

// ═══════════════════════════════════════════════════════
// ENDPOINTS
// ═══════════════════════════════════════════════════════

async function handleCheckout(request, env) {
  const body = await request.json().catch(() => ({}));
  const planKey = body.plan === 'anual' ? 'anual' : body.plan === 'mensual' ? 'mensual' : null;
  if (!planKey) return json({ error: 'plan_invalido' }, { status: 400, request, env });

  if (!(await checkRateLimit(env, request, 'checkout', 20, 3600))) {
    return json({ error: 'rate_limit' }, { status: 429, request, env });
  }

  // El precio lo decide el servidor. Nunca se acepta un monto del cliente.
  const plan = PLANS[planKey];
  const orderId = crypto.randomUUID();

  await env.LICENSES.put(
    `order:${orderId}`,
    JSON.stringify({ plan: planKey, status: 'pending', createdAt: new Date().toISOString() }),
    { expirationTtl: ORDER_TTL }
  );

  const appUrl = env.APP_URL;
  const returnUrl = `${appUrl}${appUrl.includes('?') ? '&' : '?'}order=${orderId}`;

  const preference = await mpFetch(env, '/checkout/preferences', {
    method: 'POST',
    body: JSON.stringify({
      items: [{
        id: planKey,
        title: plan.title,
        description: `Acceso Premium por ${plan.durationDays} días`,
        quantity: 1,
        currency_id: 'CLP',
        unit_price: plan.price
      }],
      external_reference: orderId,
      notification_url: `${env.API_URL}/api/webhook`,
      back_urls: { success: returnUrl, pending: returnUrl, failure: appUrl },
      auto_return: 'approved',
      statement_descriptor: 'EQUINUTRICION',
      metadata: { order_id: orderId, plan: planKey }
    })
  });

  return json({ orderId, initPoint: preference.init_point }, { request, env });
}

async function handleWebhook(request, env) {
  const url = new URL(request.url);
  const body = await request.json().catch(() => ({}));

  const dataId = url.searchParams.get('data.id') || body?.data?.id;
  const topic = url.searchParams.get('type') || url.searchParams.get('topic') || body?.type;

  // Solo interesan las notificaciones de pago; el resto se confirma y se ignora
  if (topic !== 'payment' || !dataId) return new Response('ok', { status: 200 });

  if (!(await verifyWebhookSignature(request, env, dataId))) {
    console.warn('Webhook con firma inválida, descartado');
    return new Response('firma invalida', { status: 401 });
  }

  // Nunca se confía en el cuerpo de la notificación: se consulta el pago a la API
  const payment = await mpFetch(env, `/v1/payments/${encodeURIComponent(dataId)}`);

  if (payment.status !== 'approved') {
    console.log(`Pago ${dataId} en estado ${payment.status}, sin licencia`);
    return new Response('ok', { status: 200 });
  }

  const orderId = payment.external_reference;
  if (!orderId) {
    console.warn(`Pago ${dataId} aprobado pero sin external_reference`);
    return new Response('ok', { status: 200 });
  }

  const order = JSON.parse((await env.LICENSES.get(`order:${orderId}`)) || 'null');
  const planKey = order?.plan || payment.metadata?.plan;
  if (!planKey || !PLANS[planKey]) {
    console.warn(`Orden ${orderId} sin plan reconocible`);
    return new Response('ok', { status: 200 });
  }

  await issueLicense(env, { orderId, paymentId: String(payment.id), planKey });

  return new Response('ok', { status: 200 });
}

async function handleClaim(request, env) {
  const body = await request.json().catch(() => ({}));
  const orderId = String(body.orderId || '').trim();
  const deviceId = String(body.deviceId || '').trim();
  if (!orderId || !deviceId) return json({ error: 'datos_incompletos' }, { status: 400, request, env });

  let order = JSON.parse((await env.LICENSES.get(`order:${orderId}`)) || 'null');
  if (!order) return json({ status: 'desconocida' }, { status: 404, request, env });

  // Red de seguridad: si el webhook no llegó, se le pregunta directo a Mercado Pago
  if (order.status !== 'paid') {
    try {
      const search = await mpFetch(
        env,
        `/v1/payments/search?external_reference=${encodeURIComponent(orderId)}&sort=date_created&criteria=desc`
      );
      const approved = (search.results || []).find(p => p.status === 'approved');
      if (approved) {
        // Si se llega hasta aquí, el webhook no hizo su trabajo. Vale la pena
        // saberlo: significa que quien pague y no vuelva a la app se queda sin licencia.
        console.warn(`Orden ${orderId} rescatada por /api/claim — el webhook no la emitió`);
        await issueLicense(env, { orderId, paymentId: String(approved.id), planKey: order.plan });
        order = JSON.parse((await env.LICENSES.get(`order:${orderId}`)) || 'null');
      }
    } catch (err) {
      console.warn(`No se pudo consultar el pago de la orden ${orderId}: ${err.message}`);
    }
  }

  if (!order || order.status !== 'paid' || !order.code) {
    return json({ status: 'pendiente' }, { request, env });
  }

  const result = await activateLicense(env, order.code, deviceId);
  if (result.error) return json({ status: 'error', error: result.error }, { status: 409, request, env });

  return json({ status: 'ok', ...result }, { request, env });
}

async function handleActivate(request, env) {
  if (!(await checkRateLimit(env, request, 'activate', 10, 3600))) {
    return json({ error: 'rate_limit' }, { status: 429, request, env });
  }

  const body = await request.json().catch(() => ({}));
  const code = normalizeCode(body.code);
  const deviceId = String(body.deviceId || '').trim();
  if (!code || !deviceId) return json({ error: 'datos_incompletos' }, { status: 400, request, env });

  const result = await activateLicense(env, code, deviceId);
  if (result.error) return json({ error: result.error }, { status: 404, request, env });

  return json({ status: 'ok', ...result }, { request, env });
}

// ═══════════════════════════════════════════════════════
// ROUTER
// ═══════════════════════════════════════════════════════

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (url.pathname === '/api/health') {
      return json({ ok: true }, { request, env });
    }

    if (request.method !== 'POST') {
      return json({ error: 'metodo_no_permitido' }, { status: 405, request, env });
    }

    try {
      switch (url.pathname) {
        case '/api/checkout': return await handleCheckout(request, env);
        case '/api/webhook':  return await handleWebhook(request, env);
        case '/api/claim':    return await handleClaim(request, env);
        case '/api/activate': return await handleActivate(request, env);
        default:              return json({ error: 'no_encontrado' }, { status: 404, request, env });
      }
    } catch (err) {
      console.error(`Error en ${url.pathname}: ${err.stack || err.message}`);
      return json({ error: 'error_interno' }, { status: 500, request, env });
    }
  }
};
