#!/usr/bin/env bash
set -euo pipefail

APP_PATH="${1:?использование: prepare-deploy-host.sh <путь-приложения>}"

if [[ ! "${APP_PATH}" =~ ^/[A-Za-z0-9._/-]+$ ]] || [[ "${APP_PATH}" == "/" || "${APP_PATH}" == *//* ]] || [[ "${APP_PATH}" =~ (^|/)\.\.(/|$) ]]; then
  echo "путь приложения должен быть безопасным абсолютным POSIX-путём ниже корня: ${APP_PATH}" >&2
  exit 1
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "не найдена обязательная команда подготовки хоста: $1" >&2
    exit 1
  fi
}

SUDO=""
if [[ "$(id -u)" -ne 0 ]]; then
  require_cmd sudo
  SUDO="sudo"
fi

require_cmd grep
require_cmd install
require_cmd mkdir
require_cmd tee

: "${APP_DOMAIN:?APP_DOMAIN обязателен}"
: "${APP_PORT:?APP_PORT обязателен}"
: "${DEPLOYMENT_ID:?DEPLOYMENT_ID обязателен}"
: "${LETSENCRYPT_EMAIL:?LETSENCRYPT_EMAIL обязателен}"
: "${SSH_PORT:?SSH_PORT обязателен}"

if [[ ! "${SSH_PORT}" =~ ^[0-9]+$ ]] || (( SSH_PORT < 1 || SSH_PORT > 65535 )); then
  echo "SSH_PORT должен быть целым числом от 1 до 65535: ${SSH_PORT}" >&2
  exit 1
fi
if [[ ! "${DEPLOYMENT_ID}" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]]; then
  echo "DEPLOYMENT_ID должен содержать 1..63 строчные буквы, цифры, _ или -: ${DEPLOYMENT_ID}" >&2
  exit 1
fi

if [[ ! -f /etc/os-release ]]; then
  echo "не найден /etc/os-release; поддерживаются только Ubuntu и Debian" >&2
  exit 1
fi

# shellcheck disable=SC1091
source /etc/os-release

case "${ID:-}" in
  ubuntu|debian)
    ;;
  *)
    echo "неподдерживаемый дистрибутив ${ID:-unknown}; поддерживаются только Ubuntu и Debian" >&2
    exit 1
    ;;
esac

APT_UPDATED=0

apt_update_once() {
  if [[ "${APT_UPDATED}" -eq 0 ]]; then
    ${SUDO} apt-get update
    APT_UPDATED=1
  fi
}

package_installed() {
  dpkg -s "$1" >/dev/null 2>&1
}

ensure_packages() {
  local missing=()
  local package_name

  for package_name in "$@"; do
    if ! package_installed "${package_name}"; then
      missing+=("${package_name}")
    fi
  done

  if [[ "${#missing[@]}" -gt 0 ]]; then
    apt_update_once
    ${SUDO} env DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"
  fi
}

enable_service() {
  local service_name="$1"
  ${SUDO} systemctl enable --now "${service_name}"
}

ensure_docker_repository() {
  local architecture
  local codename
  local repository_url
  local repository_line

  ensure_packages ca-certificates curl gnupg
  ${SUDO} install -d -m 0755 /etc/apt/keyrings

  if [[ ! -s /etc/apt/keyrings/docker.gpg ]]; then
    curl -fsSL "https://download.docker.com/linux/${ID}/gpg" | ${SUDO} gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    ${SUDO} chmod a+r /etc/apt/keyrings/docker.gpg
    APT_UPDATED=0
  fi

  architecture="$(dpkg --print-architecture)"
  codename="${VERSION_CODENAME:-}"
  if [[ -z "${codename}" ]]; then
    echo "VERSION_CODENAME пуст; образ хоста не поддерживается Docker repository" >&2
    exit 1
  fi

  repository_url="https://download.docker.com/linux/${ID}"
  repository_line="deb [arch=${architecture} signed-by=/etc/apt/keyrings/docker.gpg] ${repository_url} ${codename} stable"

  if [[ ! -f /etc/apt/sources.list.d/docker.list ]] || [[ "$(< /etc/apt/sources.list.d/docker.list)" != "${repository_line}" ]]; then
    printf '%s\n' "${repository_line}" | ${SUDO} tee /etc/apt/sources.list.d/docker.list >/dev/null
    APT_UPDATED=0
  fi
}

configure_docker_group() {
  local current_user
  current_user="$(id -un)"

  if [[ "${current_user}" == "root" ]]; then
    return
  fi
  if ! id -nG "${current_user}" | tr ' ' '\n' | grep -qx docker; then
    ${SUDO} usermod -aG docker "${current_user}"
    echo "Пользователь ${current_user} добавлен в группу docker; следующий deploy должен идти в новой SSH-сессии"
  fi
}

configure_firewall() {
  ${SUDO} ufw default deny incoming >/dev/null
  ${SUDO} ufw default allow outgoing >/dev/null
  ${SUDO} ufw allow "${SSH_PORT}/tcp" >/dev/null
  ${SUDO} ufw allow 80/tcp >/dev/null
  ${SUDO} ufw allow 443/tcp >/dev/null
  ${SUDO} ufw --force enable >/dev/null
}

ensure_docker_repository
ensure_packages docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin nginx certbot gzip ufw

enable_service docker
enable_service nginx
if systemctl list-unit-files certbot.timer >/dev/null 2>&1; then
  enable_service certbot.timer
fi

configure_docker_group
configure_firewall

${SUDO} rm -f /etc/nginx/sites-enabled/default
mkdir -p "${APP_PATH}/secrets"

chmod +x "${APP_PATH}/scripts/deploy-host-nginx.sh"
"${APP_PATH}/scripts/deploy-host-nginx.sh" "${APP_PATH}"

${SUDO} docker compose version >/dev/null
${SUDO} nginx -v >/dev/null 2>&1
${SUDO} certbot --version >/dev/null

echo "Хост подготовлен; теперь запустите workflow Deploy"
