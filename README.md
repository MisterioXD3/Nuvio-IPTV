# Nuvio IPTV Addon

Addon con protocolo Stremio (compatible con Nuvio) para servir **varias listas IPTV grandes**
desde un solo servidor, con **interfaz web de configuración**, **caché** y sincronización
programada.

## Qué hace

- Varias listas M3U/M3U8 y cuentas **Xtream Codes** en paralelo, cada una con su propio catálogo.
- **Interfaz web** (`/configure/`) para elegir qué listas son visibles en Nuvio, reordenarlas
  arrastrando, ver los recursos de cada lista (canales, películas, series y grupos), la fecha de
  última sincronización y la fecha de vencimiento de la suscripción.
- **Caché en memoria** (LRU con TTL) de catálogos, metadatos y streams + cabeceras
  `Cache-Control`/ETag para que Nuvio cargue al instante.
- Sincronización incremental: `ETag`/`If-Modified-Since` y hash del contenido para no reescribir
  la base cuando la lista no cambió.
- Clasificación automática en `tv`, `movie` y `series`, con géneros tomados de `group-title`.
- Búsqueda por lista mediante índice FTS5 con normalización de acentos.

## Rendimiento medido

Medido en esta máquina con listas sintéticas (`scripts/generate-playlist.js`):

| Escenario | Resultado |
| --- | --- |
| Sincronizar 200 000 entradas (34 MB) | 4,5 s |
| Sincronizar 150 000 entradas (26 MB) | 3,1 s |
| Catálogo paginado, 1 000 peticiones | p50 1,8 ms · p95 4,4 ms · p99 7,5 ms |
| Catálogo con caché vacía | p50 1,7 ms · p95 5,6 ms |
| Total indexado en la prueba | 350 000 entradas |

Claves del rendimiento:

- El M3U se **descarga y analiza en streaming**: la memoria no crece con el tamaño de la lista.
- Las filas se insertan por lotes de 5 000 en una tabla de *staging* y se cambian a la tabla viva
  en una sola transacción, así el addon sigue respondiendo con la versión anterior mientras
  sincroniza.
- SQLite en modo WAL, `mmap` y consultas que usan índices compuestos
  `(playlist_id, type, position)` y `(playlist_id, type, group_name, position)`.
- Cada respuesta cacheada lleva en la clave un número de revisión global: al cambiar la
  configuración o terminar una sincronización, la caché queda invalidada sin recorrerla.

## Uso

```bash
npm install
npm start           # http://localhost:7010
```

1. Abre `http://localhost:7010/configure/`.
2. Añade tus listas (M3U o Xtream). La primera sincronización arranca sola.
3. Copia la URL del manifest que muestra la cabecera y añádela en Nuvio:
   **Ajustes → Addons → Añadir addon** con `http://TU_SERVIDOR:7010/manifest.json`.

En Xtream Codes basta con la URL base del servidor más usuario y contraseña: el addon construye
la URL `get.php` y lee la fecha real de vencimiento desde `player_api.php`.

### Docker

```bash
docker build -t nuvio-iptv .
docker run -d -p 7010:7010 -v $PWD/data:/app/data --name nuvio-iptv nuvio-iptv
```

## Configuración (variables de entorno)

| Variable | Por defecto | Descripción |
| --- | --- | --- |
| `PORT` / `HOST` | `7010` / `0.0.0.0` | Puerto y dirección de escucha |
| `DATA_DIR` | `./data` | Carpeta de la base SQLite |
| `RESPONSE_CACHE_TTL_MS` | `300000` | TTL de la caché de respuestas |
| `RESPONSE_CACHE_MAX_ENTRIES` | `2000` | Entradas máximas en la caché |
| `CATALOG_PAGE_SIZE` | `100` | Elementos por página de catálogo |
| `SCHEDULER_INTERVAL_MS` | `60000` | Cada cuánto se revisan las listas vencidas |
| `SYNC_TIMEOUT_MS` | `600000` | Tiempo máximo de una descarga |
| `DEFAULT_USER_AGENT` | `VLC/3.0.20 LibVLC/3.0.20` | User-Agent para descargas y reproducción |
| `ADMIN_TOKEN` | *(vacío)* | Si se define, la API `/api/*` exige `Authorization: Bearer <token>` |

## API de configuración

| Método | Ruta | Descripción |
| --- | --- | --- |
| `GET` | `/api/playlists` | Listas con recursos, fechas y estado |
| `POST` | `/api/playlists` | Crear lista y sincronizar |
| `PATCH` | `/api/playlists/:id` | Renombrar, ocultar, cambiar refresco o vencimiento |
| `DELETE` | `/api/playlists/:id` | Eliminar lista y sus entradas |
| `POST` | `/api/playlists/reorder` | `{ "ids": [3,1,2] }` para fijar el orden |
| `POST` | `/api/playlists/:id/sync` | Sincronizar (`{"force":true}` ignora ETag y hash) |
| `GET` | `/api/playlists/:id/groups` | Grupos por tipo con su número de elementos |
| `GET` | `/api/stats` | Totales, aciertos de caché, memoria |
| `POST` | `/api/cache/clear` | Vaciar la caché de respuestas |

## Desarrollo

```bash
npm test                                          # pruebas unitarias y de extremo a extremo
node scripts/generate-playlist.js 200000 big.m3u  # lista sintética
node scripts/benchmark.js http://127.0.0.1:7010 iptv-1-tv 1000
```
