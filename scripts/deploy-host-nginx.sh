#!/usr/bin/env bash
set -euo pipefail

APP_PATH="${1:?использование: deploy-host-nginx.sh <путь-приложения>}"

if [[ ! "${APP_PATH}" =~ ^/[A-Za-z0-9._/-]+$ ]] || [[ "${APP_PATH}" == "/" || "${APP_PATH}" == *//* ]] || [[ "${APP_PATH}" =~ (^|/)\.\.(/|$) ]]; then
  echo "путь приложения должен быть безопасным абсолютным POSIX-путём ниже корня: ${APP_PATH}" >&2
  exit 1
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "не найдена обязательная команда для настройки Nginx: $1" >&2
    exit 1
  fi
}

SUDO=""
if [[ "$(id -u)" -ne 0 ]]; then
  require_cmd sudo
  SUDO="sudo"
fi

require_cmd certbot
require_cmd install
require_cmd mktemp
require_cmd nginx
require_cmd sed

: "${APP_DOMAIN:?APP_DOMAIN обязателен}"
: "${APP_PORT:?APP_PORT обязателен}"
: "${DEPLOYMENT_ID:?DEPLOYMENT_ID обязателен}"
: "${LETSENCRYPT_EMAIL:?LETSENCRYPT_EMAIL обязателен}"

if [[ ! "${APP_DOMAIN}" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || [[ "${APP_DOMAIN}" != *.* ]]; then
  echo "APP_DOMAIN должен быть корректным DNS-именем без схемы и пути: ${APP_DOMAIN}" >&2
  exit 1
fi
if [[ ! "${APP_PORT}" =~ ^[0-9]+$ ]] || (( APP_PORT < 1 || APP_PORT > 65535 )); then
  echo "APP_PORT должен быть целым числом от 1 до 65535: ${APP_PORT}" >&2
  exit 1
fi
if [[ ! "${DEPLOYMENT_ID}" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]]; then
  echo "DEPLOYMENT_ID должен содержать 1..63 строчные буквы, цифры, _ или -: ${DEPLOYMENT_ID}" >&2
  exit 1
fi

TEMPLATE_DIR="${APP_PATH}/config/nginx"
DEPLOY_SECRETS_DIR="${APP_PATH}/.deploy-secrets"
HTPASSWD_SOURCE="${DEPLOY_SECRETS_DIR}/app_htpasswd"
HTPASSWD_TARGET="/etc/nginx/.htpasswd-${DEPLOYMENT_ID}"
SITE_TARGET="/etc/nginx/sites-available/${DEPLOYMENT_ID}.conf"
SITE_LINK="/etc/nginx/sites-enabled/${DEPLOYMENT_ID}.conf"
CERT_NAME="${APP_DOMAIN}"
CERT_DIR="/etc/letsencrypt/live/${CERT_NAME}"
CERTBOT_WEBROOT="/var/www/certbot"
RENEW_HOOK="/etc/letsencrypt/renewal-hooks/deploy/reload-nginx-${DEPLOYMENT_ID}.sh"

for required_file in "${TEMPLATE_DIR}/bootstrap.conf.tmpl" "${TEMPLATE_DIR}/app.conf.tmpl" "${HTPASSWD_SOURCE}"; do
  if [[ ! -s "${required_file}" ]]; then
    echo "не найден или пуст обязательный файл настройки Nginx: ${required_file}" >&2
    exit 1
  fi
done

render_template() {
  local source_file="$1"
  local target_file="$2"

  sed \
    -e "s/__APP_DOMAIN__/${APP_DOMAIN}/g" \
    -e "s/__APP_PORT__/${APP_PORT}/g" \
    -e "s/__CERT_NAME__/${CERT_NAME}/g" \
    -e "s/__DEPLOYMENT_ID__/${DEPLOYMENT_ID}/g" \
    "${source_file}" > "${target_file}"
}

reload_nginx() {
  ${SUDO} nginx -t
  if command -v systemctl >/dev/null 2>&1; then
    ${SUDO} systemctl reload nginx
  else
    ${SUDO} service nginx reload
  fi
}

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -f -- "${HTPASSWD_SOURCE}"
  rm -rf -- "${TMP_DIR}"
}
trap cleanup EXIT

render_template "${TEMPLATE_DIR}/bootstrap.conf.tmpl" "${TMP_DIR}/bootstrap.conf"
render_template "${TEMPLATE_DIR}/app.conf.tmpl" "${TMP_DIR}/app.conf"

${SUDO} install -d -m 0755 /etc/nginx/sites-available /etc/nginx/sites-enabled "${CERTBOT_WEBROOT}"
${SUDO} install -m 0640 -o root -g www-data "${HTPASSWD_SOURCE}" "${HTPASSWD_TARGET}"

if [[ ! -s "${CERT_DIR}/fullchain.pem" || ! -s "${CERT_DIR}/privkey.pem" ]]; then
  ${SUDO} install -m 0644 "${TMP_DIR}/bootstrap.conf" "${SITE_TARGET}"
  ${SUDO} ln -sfn "${SITE_TARGET}" "${SITE_LINK}"
  reload_nginx

  ${SUDO} certbot certonly \
    --webroot \
    --webroot-path "${CERTBOT_WEBROOT}" \
    --non-interactive \
    --agree-tos \
    --email "${LETSENCRYPT_EMAIL}" \
    --cert-name "${CERT_NAME}" \
    --keep-until-expiring \
    -d "${APP_DOMAIN}"
fi

${SUDO} install -m 0644 "${TMP_DIR}/app.conf" "${SITE_TARGET}"
${SUDO} ln -sfn "${SITE_TARGET}" "${SITE_LINK}"
reload_nginx

${SUDO} certbot certonly \
  --webroot \
  --webroot-path "${CERTBOT_WEBROOT}" \
  --non-interactive \
  --agree-tos \
  --email "${LETSENCRYPT_EMAIL}" \
  --cert-name "${CERT_NAME}" \
  --keep-until-expiring \
  -d "${APP_DOMAIN}"

HOOK_FILE="${TMP_DIR}/reload-nginx.sh"
{
  printf '%s\n' '#!/usr/bin/env bash'
  printf '%s\n' 'set -euo pipefail'
  printf '%s\n' 'nginx -t'
  printf '%s\n' 'systemctl reload nginx'
} > "${HOOK_FILE}"
${SUDO} install -D -m 0755 "${HOOK_FILE}" "${RENEW_HOOK}"
reload_nginx

echo "Nginx и TLS настроены для https://${APP_DOMAIN} -> 127.0.0.1:${APP_PORT}"
