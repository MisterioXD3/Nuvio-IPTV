# Guía paso a paso: desplegar el addon gratis en Oracle Cloud

Resultado final: el addon corriendo 24/7 en una máquina gratuita de Oracle, con HTTPS válido y una
URL tipo `https://mi-iptv.duckdns.org/manifest.json` para pegar en Nuvio.

Tiempo aproximado: 30-45 minutos, la mayor parte esperando a la verificación de la cuenta.

---

## Paso 1 — Crear la cuenta de Oracle Cloud (gratis)

1. Entra en https://signup.cloud.oracle.com
2. Elige tu país y crea la cuenta con tu correo.
3. Te pedirá una **tarjeta de crédito o débito**: es solo para verificar identidad. Hace un cargo
   temporal de ~1 € que se devuelve. Mientras no cambies a "Pago según uso", **no se cobra nada**.
4. Elige una **región** cercana (por ejemplo *Spain Central (Madrid)* o *Germany Central
   (Frankfurt)*). La región no se puede cambiar después.
5. Confirma el teléfono por SMS y espera el correo de activación (de minutos a un par de horas).

> Consejo: las máquinas ARM gratuitas se agotan a menudo en algunas regiones. Si el Paso 3 falla
> con "Out of capacity", reintenta a otra hora o elige otra región al crear la cuenta.

---

## Paso 2 — Crear tu clave SSH

En **tu ordenador** (PowerShell en Windows, Terminal en Mac/Linux):

```bash
ssh-keygen -t ed25519 -f ~/.ssh/oracle_iptv -N ""
```

Esto crea dos ficheros:

- `~/.ssh/oracle_iptv.pub` → la clave **pública**, la que subirás a Oracle.
- `~/.ssh/oracle_iptv` → la clave **privada**, nunca la compartas.

Muestra la pública para copiarla:

```bash
cat ~/.ssh/oracle_iptv.pub          # Windows: type $env:USERPROFILE\.ssh\oracle_iptv.pub
```

---

## Paso 3 — Crear la máquina Always Free

1. En la consola de Oracle: menú ☰ → **Compute** → **Instances** → **Create instance**.
2. **Name**: `nuvio-iptv`.
3. **Image and shape** → *Edit*:
   - **Image**: `Canonical Ubuntu 22.04`.
   - **Shape**: pestaña *Ampere* → `VM.Standard.A1.Flex` → **4 OCPU** y **24 GB** de memoria
     (es el máximo del plan gratuito; con 1 OCPU / 6 GB también funciona de sobra).
   - Comprueba que aparece la etiqueta **Always Free eligible**.
4. **Networking**: deja la VCN que crea por defecto y marca **Assign a public IPv4 address**.
5. **Add SSH keys** → *Paste public keys* → pega el contenido de `oracle_iptv.pub`.
6. **Boot volume**: por defecto (50 GB) está bien.
7. **Create**. En 1-2 minutos verás la instancia en estado *Running* con su **Public IP address**:
   apúntala, la llamaremos `IP_PUBLICA`.

---

## Paso 4 — Abrir los puertos 80 y 443

Oracle bloquea el tráfico en dos sitios: el cortafuegos de la nube y el de Ubuntu.

**4a. En la nube:** en la página de la instancia, pulsa el enlace de la **Subnet** → **Security
Lists** → *Default Security List* → **Add Ingress Rules** y añade dos reglas:

| Source CIDR | IP Protocol | Destination Port Range |
| --- | --- | --- |
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

**4b. En Ubuntu:** lo haremos en el Paso 6 con un comando.

---

## Paso 5 — Conectarte por SSH

```bash
ssh -i ~/.ssh/oracle_iptv ubuntu@IP_PUBLICA
```

Acepta la huella con `yes`. Ya estás dentro de la máquina.

---

## Paso 6 — Preparar la máquina

Copia y pega todo este bloque en la sesión SSH:

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git
sudo usermod -aG docker ubuntu

# Abrir 80 y 443 en el cortafuegos de Ubuntu (Oracle trae iptables muy restrictivo)
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save 2>/dev/null || sudo apt install -y iptables-persistent
```

Cierra la sesión (`exit`) y vuelve a entrar para que el grupo `docker` tenga efecto.

---

## Paso 7 — Un dominio gratis con HTTPS

Nuvio necesita HTTPS, y para eso hace falta un nombre de dominio. El más rápido y gratuito es
**DuckDNS**:

1. Entra en https://www.duckdns.org e inicia sesión con Google/GitHub.
2. Crea un subdominio, por ejemplo `mi-iptv` → obtendrás `mi-iptv.duckdns.org`.
3. En el campo **current ip** pon la `IP_PUBLICA` de tu instancia y pulsa **update ip**.

Si ya tienes un dominio propio, basta con crear un registro `A` que apunte a `IP_PUBLICA`.

---

## Paso 8 — Desplegar el addon

En la sesión SSH:

```bash
git clone <URL_DE_TU_REPO> nuvio-iptv-addon      # o sube el zip con scp y descomprímelo
cd nuvio-iptv-addon/deploy

cat > .env <<EOF
DOMAIN=mi-iptv.duckdns.org
ADMIN_TOKEN=$(openssl rand -hex 24)
EOF

docker compose up -d --build
grep ADMIN_TOKEN .env      # apunta este token, lo necesitarás para entrar a la configuración
```

La primera compilación tarda unos minutos (compila `better-sqlite3` para ARM). Caddy pide el
certificado a Let's Encrypt automáticamente; en ~30 s tendrás HTTPS.

Comprobación:

```bash
curl -s https://mi-iptv.duckdns.org/health
# {"ok":true,...}
```

Si algo falla: `docker compose logs -f`.

---

## Paso 9 — Configurar tus listas

1. Abre `https://mi-iptv.duckdns.org/configure/` en el navegador.
2. Te pedirá el `ADMIN_TOKEN` del Paso 8 (queda guardado en ese navegador).
3. Añade tus listas M3U o cuentas Xtream; la primera sincronización arranca sola.
4. Marca cuáles quieren verse en Nuvio y ordénalas a tu gusto.

---

## Paso 10 — Añadirlo a Nuvio

En Nuvio: **Ajustes → Addons → Añadir addon** y pega:

```
https://mi-iptv.duckdns.org/manifest.json
```

Cada lista visible aparece como catálogos separados de TV, Películas y Series.

---

## Mantenimiento

```bash
cd ~/nuvio-iptv-addon && git pull && cd deploy && docker compose up -d --build   # actualizar
docker compose logs -f addon                                                     # ver registros
docker compose restart addon                                                     # reiniciar
```

Los datos viven en un volumen Docker (`deploy_addon-data`), así que sobreviven a reinicios y
actualizaciones.

### Seguridad

- No compartas la URL de `/configure/` ni el `ADMIN_TOKEN`: dan acceso a tus credenciales Xtream.
- La URL del manifest sí puedes usarla en tus dispositivos, pero cualquiera que la tenga puede ver
  tus catálogos; no la publiques.
- Mantén la instancia en el plan gratuito: no la cambies a "Pago según uso" sin querer.
