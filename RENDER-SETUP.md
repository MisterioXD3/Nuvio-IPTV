# Guía paso a paso: desplegar el addon gratis en Render

Resultado final: el addon en `https://TU-SERVICIO.onrender.com/manifest.json`, con HTTPS
automático y sin tarjeta de crédito.

Tiempo aproximado: 20 minutos.

## Antes de empezar: límites del plan gratuito

- **Se duerme tras 15 minutos sin tráfico** y tarda ~50 s en despertar. En el Paso 7 tienes cómo
  evitarlo con un ping gratuito.
- **No hay disco persistente**: la base SQLite se borra en cada reinicio o despliegue. Para no
  perder la configuración, define la variable `PLAYLISTS_JSON` (Paso 6): el addon recrea y
  resincroniza esas listas solo al arrancar (unos segundos por cada 100 000 entradas).
- 512 MB de memoria, suficiente porque las listas se procesan en streaming.

Si prefieres una opción gratuita sin estas limitaciones, está Oracle Cloud
(ver [ORACLE-SETUP.md](ORACLE-SETUP.md)).

---

## Paso 1 — Subir el proyecto a GitHub

Render despliega desde un repositorio Git.

1. Crea una cuenta en https://github.com si no la tienes.
2. Crea un repositorio **privado** llamado `nuvio-iptv-addon` (sin README).
3. Sube el proyecto. Desde la carpeta descomprimida del zip:

```bash
cd nuvio-iptv-addon
git init
git add .
git commit -m "Addon IPTV para Nuvio"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/nuvio-iptv-addon.git
git push -u origin main
```

---

## Paso 2 — Crear la cuenta en Render

1. Entra en https://dashboard.render.com/register y regístrate **con GitHub** (así Render ya tiene
   acceso a tus repos).
2. No pide tarjeta para el plan gratuito.

---

## Paso 3 — Crear el servicio

El repositorio ya trae `render.yaml`, así que Render lo configura solo:

1. En el panel: **New +** → **Blueprint**.
2. Elige el repositorio `nuvio-iptv-addon` y pulsa **Connect**.
3. Render lee `render.yaml` y muestra el servicio `nuvio-iptv-addon` (Docker, plan Free,
   `ADMIN_TOKEN` generado automáticamente). Pulsa **Apply**.
4. La primera compilación tarda unos minutos (compila `better-sqlite3`). Verás los registros en
   vivo; cuando ponga *Live*, está listo.

Si prefieres no usar Blueprint: **New +** → **Web Service** → repositorio → *Runtime* **Docker**,
*Instance Type* **Free**, y añade a mano la variable `ADMIN_TOKEN` con un valor largo y aleatorio.

---

## Paso 4 — Recuperar el token de administración

En el servicio → pestaña **Environment** → variable `ADMIN_TOKEN` → botón del ojo para verla.
Cópiala.

---

## Paso 5 — Configurar tus listas

1. Abre `https://TU-SERVICIO.onrender.com/configure/` (la URL aparece arriba en el panel).
2. Pega el `ADMIN_TOKEN` cuando lo pida (queda guardado en ese navegador).
3. Añade tus listas M3U o cuentas Xtream; la primera sincronización arranca sola.
4. Marca cuáles quieres visibles en Nuvio y ordénalas.

Añádelo a Nuvio en **Ajustes → Addons → Añadir addon**:

```
https://TU-SERVICIO.onrender.com/manifest.json
```

---

## Paso 6 — Que las listas sobrevivan a los reinicios

En el servicio → **Environment** → **Add Environment Variable**:

- **Key**: `PLAYLISTS_JSON`
- **Value** (en una sola línea):

```json
[{"name":"Mi proveedor","kind":"xtream","url":"http://servidor:8080","username":"usuario","password":"clave","refreshHours":12},{"name":"Otra lista","kind":"m3u","url":"https://ejemplo.com/lista.m3u"}]
```

Campos admitidos: `name`, `kind` (`m3u` o `xtream`), `url`, `username`, `password`, `userAgent`,
`refreshHours`, `expiresAt`, `enabled`. En cada arranque el addon crea las listas que falten (por
URL), actualiza las existentes y lanza la sincronización.

---

## Paso 7 — Evitar que se duerma (opcional pero recomendable)

Un ping cada 10 minutos mantiene el servicio despierto y dentro de las 750 horas gratuitas al mes:

1. Entra en https://cron-job.org (gratis) y crea un *cronjob*.
2. URL: `https://TU-SERVICIO.onrender.com/health`
3. Intervalo: cada 10 minutos.

Así Nuvio no se encuentra con los ~50 s de arranque en frío.

---

## Mantenimiento

- **Actualizar**: haz `git push` a `main`; Render redespliega solo (`autoDeploy: true`).
- **Registros**: pestaña *Logs* del servicio.
- **Reiniciar**: *Manual Deploy* → *Restart service*. Al reiniciar solo sobreviven las listas
  declaradas en `PLAYLISTS_JSON`.

### Seguridad

- No compartas la URL de `/configure/` ni el `ADMIN_TOKEN`: dan acceso a tus credenciales Xtream.
- No publiques la URL del manifest.
