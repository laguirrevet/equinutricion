# API de licencias Premium — EquiNutrición

Worker de Cloudflare que cobra con Mercado Pago y emite las licencias Premium de la app.

La app (`../index.html`) sigue siendo un archivo estático en GitHub Pages. Este Worker es la única
pieza con servidor, y existe porque Mercado Pago necesita un webhook al que avisar los pagos.

## Cómo funciona

```
App  ──POST /api/checkout──►  Worker  ──►  Mercado Pago (crea la preferencia)
                                                  │
                                        usuario paga
                                                  │
     Worker  ◄──POST /api/webhook──────────────────┘
       └─ valida la firma, consulta el pago a la API, crea la licencia en KV

App  ──POST /api/claim──►  Worker  ──►  token firmado  ──►  la app queda Premium
```

La app guarda un **token firmado con ECDSA P-256** y lo verifica sola, sin conexión, con la clave
pública que lleva embebida. Por eso el Premium sigue funcionando en modo avión, y por eso nadie
puede falsificar una licencia aunque el HTML sea público.

---

## Instalación paso a paso

### 1. Node.js

Descárgalo de [nodejs.org](https://nodejs.org) (versión LTS) e instálalo.

> **Importante:** después de instalarlo, cierra y vuelve a abrir VS Code por completo. Las
> terminales que ya estaban abiertas siguen con el entorno viejo y te dirán que `node` no existe,
> aunque esté bien instalado.

```bash
cd worker
npm install
npx wrangler login
```

Si `npm install` avisa que hay *install scripts* pendientes, apruébalos: son el motor de Cloudflare
y el compilador, y wrangler no funciona sin ellos.

```bash
npm approve-scripts esbuild workerd
```

### 2. Crear el almacén de licencias

```bash
npx wrangler kv namespace create LICENSES
```

Copia el `id` que imprime y pégalo en `wrangler.toml`, en `PEGAR_AQUI_EL_ID_DEL_NAMESPACE`.

### 3. Generar las claves de firma

```bash
npm run keys
```

Te entrega dos cosas:

- **Clave privada** → cárgala como secreto (paso 4). Guárdala también en tu gestor de contraseñas.
- **Clave pública** → pégala en `../index.html`, reemplazando los valores `PEGAR_CLAVE_PUBLICA_X`
  y `PEGAR_CLAVE_PUBLICA_Y` en la constante `LICENSE_PUBLIC_KEY`.

> Si algún día generas claves nuevas, todas las licencias emitidas dejan de valer y los clientes
> tendrán que reactivar con su código.

### 4. Credenciales de Mercado Pago

En [mercadopago.cl/developers](https://www.mercadopago.cl/developers) → **Tus integraciones** →
crea una aplicación de tipo *Pagos online / Checkout Pro*.

De ahí necesitas dos valores:

| Dónde | Qué copiar |
|---|---|
| Credenciales de producción | **Access token** |
| Webhooks → configurar notificaciones | **Clave secreta** |

En la configuración de webhooks, indica la URL `https://TU-WORKER.workers.dev/api/webhook` y marca
el evento **Pagos**.

Luego carga los tres secretos:

```bash
npx wrangler secret put MP_ACCESS_TOKEN
npx wrangler secret put MP_WEBHOOK_SECRET
npx wrangler secret put SIGNING_PRIVATE_KEY
```

### 5. Desplegar

```bash
npm run deploy
```

Cloudflare te dará una URL como `https://equinutricion-api.tu-cuenta.workers.dev`. Con ella:

1. Ponla en `wrangler.toml` → `API_URL`, y vuelve a ejecutar `npm run deploy`.
2. Ponla en `../index.html` → constante `API_BASE`.
3. Confírmala en la configuración de webhooks de Mercado Pago.

### 6. Códigos antiguos

Solo si tienes clientes con un código que aún no han activado:

```bash
node scripts/seed-legacy-codes.mjs EN-MES-2026-XXXX EN-ANU-2026-YYYY
npx wrangler kv bulk put scripts/legacy-codes.kv.json --binding LICENSES --remote
```

Lee la advertencia al inicio de ese script antes de usarlo: los 200 códigos originales quedaron
en el historial público de git, así que **no conviene cargarlos todos**. Quien ya activó su código
conserva el acceso automáticamente, sin hacer nada.

---

## Probar antes de cobrar de verdad

Usa primero las credenciales de **prueba** (no las de producción) y los
[usuarios y tarjetas de prueba](https://www.mercadopago.cl/developers/es/docs/checkout-pro/additional-content/your-integrations/test/accounts)
de Mercado Pago.

```bash
npm run tail    # logs del Worker en vivo, en otra terminal
```

Recorrido mínimo:

1. Comprar el plan mensual desde la app y completar el pago de prueba.
2. Ver en `npm run tail` la línea `Licencia ... emitida para la orden ...`.
3. Comprobar que la app vuelve sola y muestra "¡Ya eres Premium!".
4. Cerrar la app, **activar modo avión**, abrirla de nuevo: debe seguir Premium.
5. Probar el código de respaldo en otro teléfono desde "¿Ya tienes un código?".
6. Probar un código inventado: debe rechazarlo.

Recién entonces cambia a credenciales de producción, vuelve a desplegar y haz **una compra real
del plan mensual** como verificación final.

---

## Endpoints

| Ruta | Quién la llama | Para qué |
|---|---|---|
| `POST /api/checkout` | La app | Crea la preferencia y devuelve el link de pago |
| `POST /api/webhook` | Mercado Pago | Avisa el pago; aquí se emite la licencia |
| `POST /api/claim` | La app | Reclama la licencia al volver del pago |
| `POST /api/activate` | La app | Activa con código (reinstalación / otro teléfono) |
| `GET /api/health` | Tú | Comprobar que el Worker responde |

## Decisiones de seguridad

- **El precio se fija en el servidor** (`PLANS` en `src/index.js`), nunca se acepta del cliente.
- **El webhook se verifica dos veces**: firma HMAC-SHA256 y, además, se consulta el pago
  directamente a la API de Mercado Pago. El cuerpo de la notificación nunca se cree.
- **Emisión idempotente**: Mercado Pago reintenta las notificaciones; un mismo pago nunca genera
  dos licencias.
- **Límite por IP** en `/api/activate` (10 intentos/hora) para que los códigos no se puedan adivinar.
- **Token atado al dispositivo**: copiarlo a otro teléfono no sirve. Cada licencia admite 3
  dispositivos, que se activan con el código.

## Precios y planes

Se cambian en `PLANS`, al inicio de `src/index.js`:

| Plan | Precio | Días |
|---|---|---|
| `mensual` | $4.000 | 30 |
| `anual` | $35.000 | 395 (365 + el primer mes gratis que promete la app) |

Si cambias un precio, actualízalo también en el modal de planes de `../index.html`.
