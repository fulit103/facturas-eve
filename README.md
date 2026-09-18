# Agente de facturas

Agente administrativo que recibe facturas por Telegram o Web Chat, las interpreta con LlamaIndex y las registra en Airtable.

Construido con [eve](https://eve.dev/docs), el framework de agentes de Vercel.

## Cómo funciona

```
Telegram ──► agent/channels/telegram.ts   (webhook verificado + upload policy)
Web Chat ──► app/ + /eve/v1/*             (Next.js + useEveAgent)
Desktop  ──► desktop/ (Electron) ──► proxy local ──► /eve/v1/*
                      │
                      ▼
             eve stagea el adjunto en /workspace/attachments (sandbox)
                      │
                      ▼
             agent/instructions.md         (decide qué hacer)
                      │
        ┌─────────────┴─────────────┐
        ▼                           ▼
  extract_invoice              save_invoice
  LlamaParse ──► markdown      dedupe ──► Airtable
  markdown  ──► InvoiceSchema
```

`extract_invoice` nunca escribe en Airtable y `save_invoice` nunca vuelve a leer el documento. Esa separación es deliberada: si Airtable falla, el agente reintenta solo el guardado sin pagar otra extracción.

### Sobre el SDK de LlamaIndex

Se usa `@llamaindex/llama-cloud`, el SDK oficial de LlamaParse en TypeScript. El paquete anterior, `llama-cloud-services`, está deprecado: su propio aviso indicaba mantenimiento hasta el 1 de mayo de 2026 y su última publicación fue en febrero de 2026.

`client.parsing.parse()` resuelve upload, polling y reintentos en una sola llamada, y acepta los bytes como `File`, así que la factura nunca se escribe en el disco local.

## Estructura

```
agent/
  agent.ts                     modelo del agente
  instructions.md              identidad y reglas de comportamiento
  channels/
    eve.ts                     canal HTTP (Web Chat, REPL, TUI)
    telegram.ts                webhook de Telegram + upload policy
  tools/
    extract_invoice.ts         documento -> factura estructurada
    save_invoice.ts            factura estructurada -> fila en Airtable
  lib/
    auth.ts                    HTTP Basic para el Web Chat en producción
    invoice-schema.ts          InvoiceSchema + normalización
    llamaindex.ts              LlamaParse + extracción estructurada
    airtable.ts                cliente REST de Airtable
    attachments.ts             validación de MIME, tamaño y rutas
    idempotency.ts             claves de deduplicación
app/
  _components/                 UI del chat (useEveAgent)
  page.tsx, s/                 rutas del Web Chat
desktop/                       app Electron (Vite + proxy autenticado)
next.config.ts                 integración eve/next (withEve)
proxy.ts                       protege la UI con Basic auth en producción
evals/
  evals.config.ts
  fixtures/                    PDFs de prueba
  invoice/*.eval.ts            casos de evaluación del agente
tests/                         pruebas unitarias (vitest)
```

`agent/lib/` es la convención de eve para código compartido del agente ([Project Structure](https://eve.dev/docs/concepts/project-structure)), por eso `lib/` vive dentro de `agent/` y se importa como `#lib/...`.

## Instalación

```bash
pnpm install
```

Copiá el archivo de variables y completalo:

```bash
cp .env.example .env.local
```

## Variables de entorno

| Variable | Requerida | Para qué sirve |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | sí | Responder mensajes y descargar adjuntos con `getFile`. |
| `TELEGRAM_WEBHOOK_SECRET_TOKEN` | sí | Verificar el header `X-Telegram-Bot-Api-Secret-Token` de cada update. |
| `TELEGRAM_BOT_USERNAME` | solo en grupos | Detectar menciones `@bot` y comandos `/ask@bot`. |
| `AIRTABLE_API_KEY` | sí | Personal access token con `data.records:read` y `data.records:write`. |
| `AIRTABLE_BASE_ID` | sí | Id de la base, empieza con `app`. |
| `AIRTABLE_TABLE_NAME` | no | Nombre de la tabla. Por defecto `Invoices`. |
| `LLAMA_CLOUD_API_KEY` | sí | LlamaParse, para leer PDFs e imágenes. |
| `AI_GATEWAY_API_KEY` | ver abajo | Credencial del AI Gateway de Vercel. |
| `INVOICE_EXTRACTION_MODEL` | no | Modelo de extracción estructurada. Por defecto `openai/gpt-5.6-luna`. |
| `FACTURAS_WEB_USERNAME` | sí (Web Chat en prod.) | Usuario HTTP Basic del Web Chat. |
| `FACTURAS_WEB_PASSWORD` | sí (Web Chat en prod.) | Contraseña HTTP Basic del Web Chat. |

Sobre el AI Gateway: `eve link` enlaza el proyecto de Vercel y escribe `VERCEL_OIDC_TOKEN` o `AI_GATEWAY_API_KEY` en `.env.local` automáticamente. Solo tenés que setear `AI_GATEWAY_API_KEY` a mano si no vas a enlazar un proyecto de Vercel.

Ningún secreto se escribe en el código ni aparece en los logs: los errores de Airtable se reportan por status, sin URL ni token.

## Crear el bot de Telegram

1. Abrí [@BotFather](https://t.me/BotFather) en Telegram.
2. `/newbot`, elegí nombre y username.
3. Copiá el token que te da en `TELEGRAM_BOT_TOKEN`.
4. Poné el username (sin `@`) en `TELEGRAM_BOT_USERNAME`.
5. Generá un secreto propio para el webhook:

```bash
openssl rand -hex 32
```

Guardalo en `TELEGRAM_WEBHOOK_SECRET_TOKEN`.

## Configurar el webhook

eve monta la ruta `POST /eve/v1/telegram` y **no** llama a `setWebhook` por vos. Después de desplegar, registrá la URL:

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://TU-APP.vercel.app/eve/v1/telegram","secret_token":"'"$TELEGRAM_WEBHOOK_SECRET_TOKEN"'","allowed_updates":["message","callback_query"]}'
```

Reemplazá `TU-APP.vercel.app` por el dominio real que te devuelve `eve deploy`.

Para verificar que quedó registrado:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
```

Para borrarlo (por ejemplo, al volver a desarrollo local):

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/deleteWebhook"
```

## Configurar Airtable

1. Creá una base nueva en [airtable.com](https://airtable.com).
2. Copiá el id de la base desde la URL (`https://airtable.com/appXXXXXXXX/...`) a `AIRTABLE_BASE_ID`.
3. Creá un personal access token en [airtable.com/create/tokens](https://airtable.com/create/tokens) con los scopes `data.records:read` y `data.records:write`, dándole acceso a esa base.
4. Nombrá la tabla `Invoices` (o cambiá `AIRTABLE_TABLE_NAME`).

### Campos que debe tener la tabla

Los nombres tienen que coincidir exactamente, respetando mayúsculas y espacios.

| Campo | Tipo en Airtable | Notas |
| --- | --- | --- |
| `Invoice Number` | Single line text | Texto, nunca número: `FE-001234` debe conservarse tal cual. |
| `Issue Date` | Date | Formato ISO `YYYY-MM-DD`. |
| `Due Date` | Date | Formato ISO `YYYY-MM-DD`. |
| `Supplier Name` | Single line text | |
| `Supplier Tax ID` | Single line text | NIT/RUT como texto. |
| `Customer Name` | Single line text | |
| `Customer Tax ID` | Single line text | |
| `Subtotal` | Number | Decimal. |
| `Tax` | Number | Decimal. |
| `Total` | Number | Decimal. |
| `Currency` | Single line text | Código ISO: `COP`, `USD`, `EUR`. |
| `Description` | Long text | |
| `CUFE` | Single line text | Código de factura electrónica colombiana. |
| `Source File` | Single line text | Nombre del archivo recibido. |
| `Telegram User ID` | Single line text | |
| `Telegram Chat ID` | Single line text | |
| `Created At` | Date (con hora) | Se guarda como ISO 8601. |
| `Idempotency Key` | Single line text | **Marcalo como único.** Es la clave de deduplicación. |

Los campos vacíos se omiten en lugar de enviarse como `null`, así que Airtable no rechaza columnas tipadas.

## Idempotencia

Telegram puede reenviar el mismo webhook, y vos podés reenviar el mismo archivo por error. Antes de insertar, `save_invoice` hace dos verificaciones:

1. **`Idempotency Key`** — SHA-256 del contenido del archivo (`sha256:<hex>`). Los mismos bytes siempre dan la misma clave.
2. **Proveedor + número de factura** — `Supplier Tax ID` + `Invoice Number`. Atrapa el caso de la misma factura escaneada dos veces, donde los bytes difieren.

Si cualquiera de las dos encuentra un registro, la tool devuelve `duplicate: true` con el `recordId` existente y no crea una fila nueva.

> El `file_unique_id` de Telegram no se expone a las tools en el canal nativo de eve (los adjuntos llegan como archivos stageados en el sandbox), así que la clave primaria es el hash del contenido. Para este caso es más confiable: sobrevive a reenvíos desde cualquier chat.

## Seguridad

Hay dos controles en cadena:

1. **En el canal** (`agent/channels/telegram.ts`): `uploadPolicy` rechaza tipos no permitidos y archivos de más de 15 MB antes de que eve descargue nada.
2. **En la tool** (`agent/lib/attachments.ts`): revalida sobre los bytes reales — magic bytes de PDF/JPEG/PNG, coincidencia con la extensión, tamaño, y bloqueo de rutas fuera de `/workspace/attachments`.

Solo se aceptan `application/pdf`, `image/jpeg` y `image/png`. El contenido del archivo nunca se ejecuta: se lee como bytes y se envía a LlamaParse.

## Web Chat

Interfaz web generada con `eve add channel/web`. Corre junto al agente en el mismo proyecto Next.js.

### Desarrollo local

```bash
pnpm dev
```

Abrí `http://localhost:3000`. En local, `localDev()` permite usar el chat sin HTTP Basic.

- `/` — landing
- `/s` — nueva conversación
- `/s/[sessionId]` — reanudar una sesión durable

Desde el chat podés adjuntar PDF, JPG o PNG (máx. 15 MB) y pedir que se registre la factura.

### Autenticación en producción

El Web Chat usa HTTP Basic (`agent/lib/auth.ts`). `proxy.ts` protege las rutas de la UI; `/eve/v1/*` queda protegido por el canal eve.

Configurá `FACTURAS_WEB_USERNAME` y `FACTURAS_WEB_PASSWORD` en Vercel (Preview y Production). Sin esas variables, el acceso desde el browser queda bloqueado.

> HTTP Basic con credenciales compartidas sirve para uso interno o demo privada. Para varios usuarios con sesiones aisladas, reemplazá `appAuth` por un proveedor de identidad real (Auth.js, Clerk, etc.).

Telegram y Web Chat son canales independientes: no comparten historial de conversación.

## App de escritorio (Electron)

La app en `desktop/` reutiliza el mismo chat React. El proceso principal guarda HTTP Basic en `safeStorage` y expone un proxy en `127.0.0.1` hacia `/eve/v1/*`, así el renderer no ve las credenciales y no hace falta abrir CORS en eve.

### Desarrollo

En una terminal, el Web Chat / agente:

```bash
pnpm dev
```

En otra:

```bash
cp desktop/.env.example desktop/.env
pnpm dev:desktop
```

`FACTURAS_EVE_HOST` apunta al origen de eve (`http://localhost:3000` en local, o el deploy de Vercel). En local podés dejar usuario y contraseña vacíos (`localDev()`). En producción usá las mismas credenciales que `FACTURAS_WEB_USERNAME` / `FACTURAS_WEB_PASSWORD`.

Las sesiones se guardan en el hash (`#/s/<sessionId>`). Reabrir ese hash reanuda el stream.

### Empaquetado (macOS)

```bash
pnpm package:desktop
```

Genera `desktop/release/` (dmg y zip). Configurá `FACTURAS_EVE_HOST` en `desktop/.env` antes del build, o ingresalo en la pantalla de login.

### REPL sin interfaz web

```bash
pnpm run dev:eve
```

O el REPL clásico:

```bash
pnpm exec eve dev --no-ui
```

Para probar el webhook de Telegram contra tu máquina necesitás una URL pública (por ejemplo un túnel) y registrarla con el `setWebhook` de arriba.

## Pruebas

```bash
pnpm typecheck
pnpm test
```

Las pruebas unitarias no consumen LlamaCloud, el AI Gateway ni Airtable: el parser se inyecta como dependencia y Airtable se sirve desde un stub en memoria.

Cobertura:

| Archivo | Qué prueba |
| --- | --- |
| `tests/invoice-schema.test.ts` | `InvoiceSchema` con factura válida, normalización de montos, fechas, moneda, NIT y número de factura. |
| `tests/attachments.test.ts` | Rechazo de `.exe`, ejecutables disfrazados de `.pdf`, tamaño máximo y traversal de rutas. |
| `tests/extract-invoice.test.ts` | Pipeline de extracción con parser mockeado. |
| `tests/extract-invoice-tool.test.ts` | La tool `extract_invoice` con la librería mockeada. |
| `tests/save-invoice.test.ts` | La tool `save_invoice` y el cliente de Airtable, incluyendo duplicados. |
| `tests/idempotency.test.ts` | Estabilidad de las claves de deduplicación. |

## Evals

Los evals ejercitan el agente completo, así que **sí** consumen LlamaCloud, el AI Gateway y Airtable. Configurá las variables antes de correrlos:

```bash
pnpm eval
```

Un caso puntual:

```bash
pnpm exec eve eval invoice/saves-after-extraction
```

| Eval | Verifica |
| --- | --- |
| `invoice/extracts-from-pdf` | Un PDF dispara `extract_invoice`. |
| `invoice/saves-after-extraction` | Extracción válida seguida de `save_invoice`. |
| `invoice/no-tools-for-plain-question` | Una pregunta sin factura no llama herramientas. |
| `invoice/asks-for-missing-critical-field` | Sin número de factura, pregunta en lugar de guardar. |
| `invoice/duplicate-not-reinserted` | La misma factura dos veces no se inserta de nuevo. |
| `invoice/rejects-unsupported-file` | Un archivo no permitido se rechaza. |

> `invoice/duplicate-not-reinserted` escribe una fila real en Airtable la primera vez que corre. Usá una base de pruebas.

## Deploy a Vercel

```bash
pnpm exec eve link
pnpm exec eve deploy
```

`eve link` enlaza el proyecto y trae la credencial del AI Gateway. Después cargá el resto de las variables en el proyecto de Vercel (Settings → Environment Variables):

`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET_TOKEN`, `TELEGRAM_BOT_USERNAME`, `AIRTABLE_API_KEY`, `AIRTABLE_BASE_ID`, `AIRTABLE_TABLE_NAME`, `LLAMA_CLOUD_API_KEY`, `FACTURAS_WEB_USERNAME`, `FACTURAS_WEB_PASSWORD`.

Volvé a desplegar y registrá el webhook de Telegram con la URL de producción. El Web Chat queda disponible en la misma URL del proyecto de Vercel.
