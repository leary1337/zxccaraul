#!/usr/bin/env bash
set -euo pipefail

APP_PATH="${1:?использование: deploy-release.sh <путь-приложения>}"

if [[ ! "${APP_PATH}" =~ ^/[A-Za-z0-9._/-]+$ ]] || [[ "${APP_PATH}" == "/" || "${APP_PATH}" == *//* ]] || [[ "${APP_PATH}" =~ (^|/)\.\.(/|$) ]]; then
  echo "путь приложения должен быть безопасным абсолютным POSIX-путём ниже корня: ${APP_PATH}" >&2
  exit 1
fi

RELEASE_DIR="${APP_PATH}/release"
ENV_PATH="${APP_PATH}/.env"
COMPOSE_PATH="${APP_PATH}/docker-compose.prod.yml"
SECRET_DIR="${APP_PATH}/secrets"
SECRET_PATH="${SECRET_DIR}/postgres_password"
BACKUP_DIR="${APP_PATH}/backups"

cleanup_sensitive_release() {
  rm -f -- "${RELEASE_DIR}/secrets/postgres_password"
}
trap cleanup_sensitive_release EXIT

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "не найдена обязательная команда production deploy: $1" >&2
    exit 1
  fi
}

require_cmd docker
require_cmd gzip
require_cmd install
require_cmd mktemp

for required_file in \
  "${RELEASE_DIR}/runtime.env" \
  "${RELEASE_DIR}/docker-compose.prod.yml" \
  "${RELEASE_DIR}/secrets/postgres_password"; do
  if [[ ! -s "${required_file}" ]]; then
    echo "release bundle неполон: не найден или пуст ${required_file}" >&2
    exit 1
  fi
done

docker compose version >/dev/null
docker compose \
  --env-file "${RELEASE_DIR}/runtime.env" \
  -f "${RELEASE_DIR}/docker-compose.prod.yml" \
  config --quiet

ROLLBACK_DIR="$(mktemp -d "${APP_PATH}/.deploy-rollback.XXXXXX")"
HAD_ENV=0
HAD_COMPOSE=0
HAD_SECRET=0

if [[ -f "${ENV_PATH}" ]]; then
  cp -p "${ENV_PATH}" "${ROLLBACK_DIR}/runtime.env"
  HAD_ENV=1
fi
if [[ -f "${COMPOSE_PATH}" ]]; then
  cp -p "${COMPOSE_PATH}" "${ROLLBACK_DIR}/docker-compose.prod.yml"
  HAD_COMPOSE=1
fi
if [[ -f "${SECRET_PATH}" ]]; then
  cp -p "${SECRET_PATH}" "${ROLLBACK_DIR}/postgres_password"
  HAD_SECRET=1
fi

cleanup_release_files() {
  rm -rf -- "${ROLLBACK_DIR}" "${RELEASE_DIR}"
}

rollback() {
  local original_status="$?"
  trap - ERR
  set +e

  echo "Deploy завершился ошибкой; восстанавливаем предыдущую конфигурацию без удаления volume Postgres" >&2

  if (( HAD_ENV == 1 && HAD_COMPOSE == 1 && HAD_SECRET == 1 )); then
    install -m 0600 "${ROLLBACK_DIR}/runtime.env" "${ENV_PATH}"
    install -m 0644 "${ROLLBACK_DIR}/docker-compose.prod.yml" "${COMPOSE_PATH}"
    install -d -m 0700 "${SECRET_DIR}"
    install -m 0600 "${ROLLBACK_DIR}/postgres_password" "${SECRET_PATH}"

    if ! docker compose --env-file "${ENV_PATH}" -f "${COMPOSE_PATH}" up -d --remove-orphans --wait --wait-timeout 180; then
      echo "Предыдущая конфигурация восстановлена на диске, но её контейнеры не вернулись в healthy; требуется ручная диагностика" >&2
    fi
  else
    if [[ -f "${ENV_PATH}" && -f "${COMPOSE_PATH}" ]]; then
      docker compose --env-file "${ENV_PATH}" -f "${COMPOSE_PATH}" down --remove-orphans
    fi
    rm -f -- "${ENV_PATH}" "${COMPOSE_PATH}" "${SECRET_PATH}"
  fi

  cleanup_release_files
  exit "${original_status}"
}
trap rollback ERR

if (( HAD_ENV == 1 && HAD_COMPOSE == 1 && HAD_SECRET == 1 )); then
  install -d -m 0700 "${BACKUP_DIR}"
  BACKUP_NAME="postgres-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"

  docker compose --env-file "${ENV_PATH}" -f "${COMPOSE_PATH}" up -d --wait --wait-timeout 120 db
  docker compose --env-file "${ENV_PATH}" -f "${COMPOSE_PATH}" exec -T db \
    sh -eu -c 'pg_dump --clean --if-exists --no-owner --no-privileges --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"' \
    | gzip -9 > "${ROLLBACK_DIR}/${BACKUP_NAME}"

  if [[ ! -s "${ROLLBACK_DIR}/${BACKUP_NAME}" ]]; then
    echo "предрелизная резервная копия Postgres пуста; deploy остановлен" >&2
    false
  fi
  install -m 0600 "${ROLLBACK_DIR}/${BACKUP_NAME}" "${BACKUP_DIR}/${BACKUP_NAME}"
  echo "Резервная копия Postgres сохранена: ${BACKUP_DIR}/${BACKUP_NAME}"
fi

install -m 0600 "${RELEASE_DIR}/runtime.env" "${ENV_PATH}"
install -m 0644 "${RELEASE_DIR}/docker-compose.prod.yml" "${COMPOSE_PATH}"
install -d -m 0700 "${SECRET_DIR}"
install -m 0600 "${RELEASE_DIR}/secrets/postgres_password" "${SECRET_PATH}"

docker compose --env-file "${ENV_PATH}" -f "${COMPOSE_PATH}" pull app
docker compose --env-file "${ENV_PATH}" -f "${COMPOSE_PATH}" up -d --remove-orphans --wait --wait-timeout 180

trap - ERR
cleanup_release_files

echo "Production release развёрнут; app и Postgres находятся в healthy состоянии"
