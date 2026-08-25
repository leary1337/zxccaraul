# Караул

Mobile-first PWA для подготовки ежедневной раскладки караула и генерации PNG.

## Локальный запуск без Docker

```bash
npm install
npm start
```

Откройте `http://localhost:5173`.

Если `DATABASE_URL` не задан, приложение продолжит работать с локальным запасным сохранением в браузере. Для серверного сохранения укажите Postgres:

```bash
DATABASE_URL=postgres://caraul:caraul_password@localhost:5432/caraul npm start
```

Демо-вход: `1234`.

Проверка процесса доступна на `GET /healthz`, а готовность приложения вместе с Postgres — на `GET /readyz`.

## Деплой через Docker

```bash
cp .env.example .env
docker compose up -d --build
```

По умолчанию приложение будет доступно на `http://localhost:5173`.

Postgres хранит данные в Docker volume `postgres_data`, поэтому сотрудники, отсутствия, название приложения, блоки и раскладки сохраняются между перезапусками.

Для доступа с другого устройства в локальной сети оставьте `APP_BIND_ADDRESS=0.0.0.0`. Если внешний доступ не нужен, задайте `APP_BIND_ADDRESS=127.0.0.1`.

## Production-деплой

Репозиторий содержит самостоятельный production-контур, построенный по модели `arb-deploy`:

- [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) проверяет JavaScript, shell-скрипты и оба Compose-файла;
- [`.github/workflows/prepare-host.yml`](./.github/workflows/prepare-host.yml) один раз подготавливает Ubuntu/Debian: Docker, Compose, Nginx, firewall, Basic Auth и TLS от Let’s Encrypt;
- [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml) проверяет исходники, публикует приватный образ в GHCR и разворачивает healthy-релиз через SSH;
- [`docker-compose.prod.yml`](./docker-compose.prod.yml) запускает приложение и Postgres в изолированной сети, публикуя приложение только на loopback хоста;
- [`scripts/deploy-release.sh`](./scripts/deploy-release.sh) перед обновлением сохраняет `pg_dump`, ждёт healthcheck и восстанавливает прежнюю конфигурацию при ошибке.

Postgres-пароль передаётся контейнерам как Docker secret и не записывается в `DATABASE_URL` или production `.env`. Runtime image фиксируется по immutable digest, поэтому rollback не зависит от повторного использования Docker tag. Данные находятся в named volume конкретного `COMPOSE_PROJECT_NAME`. Скрипт rollback никогда не удаляет этот volume.

### Первый запуск

1. Создайте в GitHub Environments окружение `staging` и/или `production`.
2. Заполните variables и secrets по [GITHUB_ACTIONS_ENV.md](./GITHUB_ACTIONS_ENV.md). Для production задайте `APP_PUBLIC_URL=https://caraul.scanbet.pro`.
3. Направьте DNS-имя из `APP_PUBLIC_URL` на сервер и откройте входящие TCP-порты `80`, `443` и SSH-порт.
4. Запустите workflow `Prepare deploy host` для выбранного Environment.
5. После его успеха запустите `Build and deploy zxccaraul`. Пустой `release_tag` автоматически заменяется первыми 12 символами commit SHA.

Повторные релизы требуют только шага 5. Для смены домена, loopback-порта, SSH-порта или `APP_HTPASSWD` обновите GitHub Environment и повторно запустите `Prepare deploy host`, затем обычный deploy.

### Эксплуатация на сервере

В примерах `/opt/zxccaraul` замените значением `SERVER_APP_PATH`:

```bash
cd /opt/zxccaraul
docker compose --env-file .env -f docker-compose.prod.yml ps
docker compose --env-file .env -f docker-compose.prod.yml logs --tail=200 app db
curl --fail http://127.0.0.1:5173/readyz
```

Перед каждым повторным deploy создаётся архив `backups/postgres-<UTC>.sql.gz`. Для восстановления сначала остановите запись в приложение, затем выполните:

```bash
gzip -dc backups/postgres-20260825T120000Z.sql.gz \
  | docker compose --env-file .env -f docker-compose.prod.yml exec -T db \
      sh -c 'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"'
```

Резервные копии не удаляются автоматически: срок хранения нужно определить отдельно и включить каталог `backups/` в резервное копирование хоста.

Важно: встроенный PIN `1234` — только интерфейсная демо-блокировка. Реальную защиту production URL и API обеспечивает Nginx Basic Auth из GitHub secret `APP_HTPASSWD`.

## Что хранится в БД

Состояние приложения сохраняется в таблице `app_state` в JSONB-формате:

- название приложения;
- сотрудники и их должности/доп. профессии;
- отсутствия;
- раскладки по датам;
- созданные блоки и назначения сотрудников.

При создании новой даты приложение автоматически берет последний шаблон блоков из предыдущих раскладок и создает пустую раскладку на новый день.

## PNG

Серверный PNG создается из HTML/CSS через Playwright:

- `POST /api/roster-card/png`
- `POST /api/roster-card/html`

В Docker используется образ Playwright, поэтому Chromium и системные зависимости уже входят в контейнер.
