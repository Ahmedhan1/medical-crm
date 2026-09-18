# MEDCORE — Docker Deployment (single host / MEDCORE BOX)

The fastest supported way to run MEDCORE on a server or MEDCORE BOX. Three
containers: PostgreSQL, the MEDCORE API, and the web UI (nginx serving the SPA and
proxying `/api` to the API — one same-origin surface, no CORS).

## Prerequisites
- Docker Engine 24+ with the Compose plugin.
- ~2 GB RAM, ~5 GB disk to start (plus your data and backups).

## Install & run
```bash
git clone <your MEDCORE repo/package> medcore && cd medcore
cp .env.docker.example .env          # then edit .env and set real secrets
#   POSTGRES_PASSWORD  and  AUTH_PEPPER  are required.
#   Generate a strong pepper:
#   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

docker compose up -d --build         # builds images and starts db + api + web
docker compose exec api npm run seed:admin   # ONE-TIME: creates admin, prints a
                                             # one-time password (store it!)
```
Open `http://<host>:8080/` (change the port with `MEDCORE_HTTP_PORT`). Sign in as
`admin` with the printed password and change it immediately.

The API **migrates the database on boot**, so there is no manual migration step.
Data lives in named volumes (`db-data`, `medcore-state`) and survives image
rebuilds and upgrades.

## Health & operations
```bash
docker compose ps                    # container health
docker compose exec api curl -fsS http://localhost:4000/health/detailed
docker compose logs -f api           # PHI-free application logs
docker compose exec api npm run backup -- backup        # create a backup
docker compose exec api npm run backup -- list
docker compose exec api npm run license -- status
```
Backups are written to the `medcore-state` volume at `/data/backups`. **Copy them
off the host** (`docker cp` or a bind mount) — a backup on the same host does not
protect against host loss.

## Update
```bash
docker compose exec api npm run backup -- backup   # pre-update backup
git pull                                           # or drop in the new package
docker compose up -d --build                       # rebuild + restart; migrates on boot
docker compose exec api curl -fsS http://localhost:4000/health
```
Migrations are forward-only and transactional; if boot migration fails the old
data is intact — restore the pre-update backup.

## License
Clinical-core works without a license. To enable commercial features, set
`LICENSE_PUBLIC_KEY` in `.env`, then:
```bash
docker compose exec api npm run license -- install-id     # -> send id to vendor
# receive license.json, copy it into the state volume, then:
docker compose cp license.json api:/data/license/incoming.json
docker compose exec api npm run license -- activate /data/license/incoming.json
```
See `docs/customer/LICENSE.md`.

## Arabic/RTL PDF (optional)
The base API image does not bundle Chromium (it is ~150–300 MB and only needed for
Arabic/RTL PDF). To enable it on a box that needs Arabic documents, add a Chromium
layer to the API image and set `PDF_CHROMIUM_PATH`; the Latin PDF renderer needs no
browser. See `docs/platform/MEDCORE-BOX.md`.

## WhatsApp/GOWA (optional)
Set `WHATSAPP_GOWA_BASE_URL` and `WHATSAPP_GOWA_BASIC_AUTH` in `.env` to point at a
GOWA gateway, then pair from the WhatsApp screen. Left unset, WhatsApp is disabled
(safe no-op). Live pairing is an operational step performed on the deployment; it
is not part of the code build.

## Security notes
- Only the web tier is published (`:8080`); the API and database are internal to
  the compose network.
- Put a TLS-terminating reverse proxy (or the vendor BOX HTTPS) in front of `:8080`
  for clinic-wide use.
- Secrets come only from `.env`/environment and are never baked into an image.
- The database port is not exposed to the host.
