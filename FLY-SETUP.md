# Guía paso a paso: desplegar el addon en Fly.io

Resultado final: el addon en `https://TU-APP.fly.dev/manifest.json`, con HTTPS automático, disco
persistente para la base SQLite y suspensión automática cuando no hay tráfico (despierta en ~1 s).

Tiempo aproximado: 15 minutos.

---

## Paso 1 — Crear la cuenta

1. Entra en https://fly.io/app/sign-up y regístrate (puedes usar GitHub).
2. Fly pide una **tarjeta** para verificar la cuenta. No cobra mientras te mantengas dentro del
   uso pequeño: una máquina `shared-cpu-1x` de 512 MB con un volumen de 1 GB entra en el consumo
   mínimo mensual, y con la suspensión automática la máquina solo corre cuando Nuvio la usa.
3. Confirma el correo.

---

## Paso 2 — Instalar la CLI

En **tu ordenador**:

```bash
# Mac / Linux
curl -L https://fly.io/install.sh | sh

# Windows (PowerShell)
pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"
```

Luego:

```bash
fly auth login
```

---

## Paso 3 — Desplegar

Desde la carpeta del proyecto (el repo ya incluye `fly.toml` y `Dockerfile`):

```bash
cd nuvio-iptv-addon

# 1. Crear la app sin desplegar todavía (elige un nombre libre, p. ej. mi-iptv-addon)
fly launch --copy-config --no-deploy --name mi-iptv-addon --region mad

# 2. Disco persistente de 1 GB para la base SQLite
fly volumes create nuvio_iptv_data --size 1 --region mad --yes

# 3. Token para proteger la interfaz de configuración
fly secrets set ADMIN_TOKEN=$(openssl rand -hex 24)

# 4. Desplegar
fly deploy
```

La primera compilación tarda unos minutos (compila `better-sqlite3`).

Comprobación:

```bash
curl -s https://mi-iptv-addon.fly.dev/health
# {"ok":true,...}
```

Recupera el token cuando lo necesites:

```bash
fly ssh console -C "printenv ADMIN_TOKEN"
```

---

## Paso 4 — Configurar tus listas

1. Abre `https://mi-iptv-addon.fly.dev/configure/`.
2. Introduce el `ADMIN_TOKEN` cuando lo pida (queda guardado en ese navegador).
3. Añade tus listas M3U o cuentas Xtream; la primera sincronización arranca sola.
4. Marca cuáles quieres visibles en Nuvio y ordénalas.

---

## Paso 5 — Añadirlo a Nuvio

**Ajustes → Addons → Añadir addon**:

```
https://mi-iptv-addon.fly.dev/manifest.json
```

---

## Notas de uso

- **Suspensión**: con `auto_stop_machines = "suspend"` la máquina se congela sin tráfico y
  reanuda en ~1 s conservando la memoria. Si prefieres que nunca se detenga, pon
  `min_machines_running = 1` en `fly.toml`.
- **Listas muy grandes**: 512 MB bastan porque el M3U se procesa en streaming, pero si sincronizas
  varias listas de cientos de miles de entradas a la vez, sube la memoria:
  `fly scale memory 1024`.
- **Espacio**: 350 000 entradas ocupan bastante menos de 1 GB en SQLite. Para ampliar:
  `fly volumes extend <id> --size 3`.
- **Actualizar**: `git pull && fly deploy`.
- **Registros**: `fly logs`.
- **Coste**: revisa el consumo en https://fly.io/dashboard → *Billing*. Sin `min_machines_running`
  y con un solo volumen pequeño, la factura suele quedarse en 0.

### Seguridad

- Define siempre `ADMIN_TOKEN`: sin él, cualquiera con la URL puede ver y editar tus listas y las
  credenciales Xtream.
- No publiques la URL del manifest.
