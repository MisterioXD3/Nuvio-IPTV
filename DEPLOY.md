# Desplegar gratis

Nuvio necesita que el addon esté accesible por **HTTPS público**. Estas son las opciones
gratuitas, de mejor a peor para listas grandes.

| Opción | Siempre encendido | Disco persistente | Esfuerzo |
| --- | --- | --- | --- |
| Oracle Cloud Always Free + Cloudflare Tunnel | Sí | Sí | Medio |
| Fly.io | Se suspende y despierta solo | Sí (volumen 1 GB) | Bajo |
| Render free | No (duerme a los 15 min) | No | Muy bajo |

## 1. Oracle Cloud Always Free (recomendada)

VM ARM gratuita permanente (hasta 4 vCPU / 24 GB) con disco propio, ideal para listas de cientos
de miles de entradas. Guía completa desde cero, incluida la creación de la cuenta y el HTTPS:
**[ORACLE-SETUP.md](ORACLE-SETUP.md)**. Resumen:

```bash
# En la VM (Ubuntu 22.04+)
sudo apt update && sudo apt install -y docker.io git
git clone <TU_REPO> nuvio-iptv-addon && cd nuvio-iptv-addon
sudo docker build -t nuvio-iptv .
sudo docker run -d --restart unless-stopped \
  -p 7010:7010 -v /opt/nuvio-data:/app/data \
  -e ADMIN_TOKEN='pon-un-token-largo' \
  --name nuvio-iptv nuvio-iptv
```

HTTPS gratis sin abrir puertos, con Cloudflare Tunnel:

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 \
  -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared
cloudflared tunnel login
cloudflared tunnel create nuvio
cloudflared tunnel route dns nuvio iptv.tu-dominio.com
cloudflared tunnel run --url http://localhost:7010 nuvio
```

Manifest para Nuvio: `https://iptv.tu-dominio.com/manifest.json`

## 2. Fly.io

Incluye `fly.toml` con volumen persistente y suspensión automática (arranca en ~1 s al recibir
una petición).

```bash
fly auth login
fly launch --copy-config --no-deploy
fly volumes create nuvio_iptv_data --size 1
fly secrets set ADMIN_TOKEN=pon-un-token-largo
fly deploy
```

Manifest: `https://<app>.fly.dev/manifest.json`

## 3. Render (plan free)

Conecta el repositorio en Render; `render.yaml` ya define el servicio Docker.

Limitaciones del plan gratuito: el servicio **duerme tras 15 min sin tráfico** (primer arranque
~50 s) y **no hay disco persistente**, así que la base SQLite se recrea y las listas se
resincronizan al arrancar. Con listas muy grandes, esa resincronización tarda unos segundos por
cada 100 000 entradas.

Manifest: `https://<servicio>.onrender.com/manifest.json`

## Después de desplegar

1. Abre `https://TU_DOMINIO/configure/` y añade tus listas.
2. Define siempre `ADMIN_TOKEN`: sin él, cualquiera con la URL puede ver y editar tus listas y
   credenciales Xtream. Con el token, la UI lo pide y lo guarda en el navegador.
3. Añade `https://TU_DOMINIO/manifest.json` en Nuvio (Ajustes → Addons).
