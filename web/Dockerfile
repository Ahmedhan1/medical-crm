# MEDCORE web image: builds the SPA and serves it with nginx, proxying /api to the
# API container so the whole app is same-origin (no CORS). This is the documented
# BOX topology (/ -> static SPA, /api -> backend).
#
#   docker build -t medcore/web web/

FROM node:22-bookworm-slim AS build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM nginx:1.27-alpine AS web
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --retries=5 \
  CMD wget -qO- http://localhost/ >/dev/null 2>&1 || exit 1
