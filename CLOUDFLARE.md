# Despliegue en Cloudflare Workers + D1

Esta adaptación reemplaza el servidor Express y `better-sqlite3` por un **Cloudflare Worker** con API Fetch nativa y una base **D1**. La interfaz existente se publica como Static Assets mediante Wrangler. La sincronización periódica se ejecuta con un Cron Trigger cada 15 minutos.

## 1. Requisitos

Se necesita una cuenta de Cloudflare con Workers habilitado, Node.js y Wrangler autenticado con `npx wrangler login`.

## 2. Crear D1 e inicializar el esquema

```bash
npx wrangler d1 create nuvio-iptv
npx wrangler d1 execute nuvio-iptv --remote --file=cloudflare/schema.sql
```

Copie el `database_id` que devuelve el primer comando en `wrangler.toml`, sustituyendo `REEMPLAZAR_CON_DATABASE_ID`.

## 3. Variables secretas

El token de administración no debe escribirse en `wrangler.toml` ni en Git:

```bash
npx wrangler secret put ADMIN_TOKEN
```

La variable opcional `PLAYLISTS_JSON` se puede establecer como variable cifrada si se desea sembrar listas durante una operación de inicialización, aunque para esta adaptación se recomienda crearlas desde `/configure/`.

## 4. Publicar

```bash
npx wrangler deploy
```

Después de publicar, abra `https://<nombre>.<subdominio>.workers.dev/configure/`. La URL para instalar el addon en Nuvio/Stremio es:

```text
https://<nombre>.<subdominio>.workers.dev/manifest.json
```

## 5. Desarrollo local

```bash
npx wrangler d1 execute nuvio-iptv --local --file=cloudflare/schema.sql
npx wrangler dev
```

El Cron Trigger puede probarse localmente con:

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled?format=json"
```

## Diferencias importantes

| Componente original | Adaptación Cloudflare |
| --- | --- |
| Express escuchando en el puerto 7010 | Handler Fetch del Worker |
| `better-sqlite3` y archivos en `data/` | Cloudflare D1 mediante `env.DB` |
| Caddy y Docker Compose | HTTPS y proxy gestionados por Cloudflare |
| `setInterval` del scheduler | Cron Trigger `*/15 * * * *` |
| `express.static` | Static Assets mediante `env.ASSETS` |
| Caché LRU local | Caché HTTP de Cloudflare y datos persistidos en D1 |

La ruta de sincronización manual (`POST /api/playlists/:id/sync`) fuerza una actualización. El Cron Trigger solo procesa listas habilitadas cuyo intervalo de refresco haya vencido.

## Limitación de listas muy grandes

El Worker conserva el modelo funcional del addon, pero esta primera versión materializa el cuerpo M3U antes de insertarlo en D1. Para listas de cientos de megabytes se recomienda dividir el proveedor, usar un endpoint de ingestión por páginas o mover la ingesta a un proceso Node persistente. Cloudflare Workers impone límites de memoria y CPU por invocación; consulte la [documentación oficial de límites de Workers][1]. D1 sí conserva compatibilidad con SQLite y FTS5, que queda preparado en `cloudflare/schema.sql`.[2]

## Referencias

[1]: https://developers.cloudflare.com/workers/platform/limits/ "Cloudflare Workers limits"
[2]: https://developers.cloudflare.com/d1/sql-api/sql-statements/ "Cloudflare D1 SQL statements"
[3]: https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/ "Cloudflare Scheduled Handler"
[4]: https://developers.cloudflare.com/workers/runtime-apis/nodejs/ "Cloudflare Node.js compatibility"
