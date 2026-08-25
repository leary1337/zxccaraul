# GitHub Environments для деплоя `zxccaraul`

Создайте в `Settings → Environments` окружения `staging` и/или `production`. Все перечисленные значения задаются внутри конкретного Environment: так один workflow может безопасно деплоить разные серверы, домены, базы и Compose projects.

## Обязательные variables

| Имя | Пример | Где используется | Описание |
| --- | --- | --- | --- |
| `SERVER_HOST` | `203.0.113.10` | prepare, deploy | DNS-имя или IP SSH-сервера. |
| `SERVER_PORT` | `22` | prepare, deploy | SSH-порт; также разрешается в UFW. |
| `SERVER_USERNAME` | `deploy` | prepare, deploy | Пользователь с SSH-доступом, passwordless `sudo` для первичной подготовки и доступом к Docker после неё. |
| `SERVER_APP_PATH` | `/opt/zxccaraul` | prepare, deploy | Абсолютный путь production bundle на сервере. Каталог должен принадлежать deploy-пользователю или создаваться им через `sudo`. На общем сервере у каждого Environment должен быть отдельный путь. |
| `APP_PUBLIC_URL` | `https://caraul.scanbet.pro` | prepare, deploy | Публичный HTTPS URL без path, query, credentials и явного порта. Для production используйте `https://caraul.scanbet.pro`; до prepare DNS должен резолвиться публично. |
| `LETSENCRYPT_EMAIL` | `ops@example.com` | prepare | Email регистрации и уведомлений Let’s Encrypt. |
| `GHCR_USERNAME` | `leary1337` | deploy | GitHub user, которому принадлежит `GHCR_PAT` и разрешено читать package образа. |
| `POSTGRES_DB` | `caraul` | deploy | Имя production/staging базы. Рекомендуются латинские буквы, цифры и `_`. |
| `POSTGRES_USER` | `caraul` | deploy | Владелец production/staging базы. Рекомендуются латинские буквы, цифры и `_`. |

## Опциональные variables

| Имя | Значение по умолчанию | Описание |
| --- | --- | --- |
| `APP_PORT` | `5173` | Loopback-порт хоста `127.0.0.1`, на который Nginx проксирует запросы. Для нескольких окружений на одном сервере задайте разные порты. |
| `APP_STATE_ID` | `main` | Ключ строки в `app_state`. Менять после запуска следует только намеренно: другое значение выглядит как отдельное пустое состояние приложения. |
| `COMPOSE_PROJECT_NAME` | `zxccaraul-<environment>` | Namespace контейнеров, сети, Postgres volume, Nginx site и htpasswd. Для нескольких окружений на одном сервере значения обязаны различаться. Допустимы строчные буквы, цифры, `_` и `-`. |

## Обязательные secrets

| Имя | Где используется | Описание |
| --- | --- | --- |
| `SERVER_PRIVATE_KEY` | prepare, deploy | Приватный SSH-ключ deploy-пользователя. Публичная часть должна быть в `~/.ssh/authorized_keys` на сервере. |
| `GHCR_PAT` | deploy | Classic PAT с минимум `read:packages` и доступом к приватному GHCR package. Если организация использует SSO, токен нужно авторизовать для неё. |
| `POSTGRES_PASSWORD` | deploy | Сильный уникальный пароль Postgres длиной не менее 20 символов без перевода строки. Он записывается на сервер только в файл Docker secret с mode `0600`. |
| `APP_HTPASSWD` | prepare | Полная строка `login:bcrypt-hash` для Nginx Basic Auth. Защищает и UI, и API. |

## Опциональный secret

| Имя | Описание |
| --- | --- |
| `SERVER_KEY_PASSPHRASE` | Passphrase от `SERVER_PRIVATE_KEY`, если приватный ключ зашифрован. Для ключа без passphrase оставьте secret незаданным. |

## Как подготовить значения

Сгенерируйте отдельный SSH-ключ для GitHub Actions и установите его публичную часть на сервер:

```bash
ssh-keygen -t ed25519 -a 100 -f ./zxccaraul-deploy -C github-actions-zxccaraul
ssh-copy-id -i ./zxccaraul-deploy.pub -p 22 deploy@203.0.113.10
```

Сгенерируйте пароль Postgres:

```bash
openssl rand -base64 36
```

Сгенерируйте bcrypt-строку Basic Auth (в secret копируется вся строка `karaul:$2y$...`):

```bash
docker run --rm httpd:2.4-alpine htpasswd -nbB karaul 'replace-with-a-long-password'
```

`GHCR_PAT` нужен только серверу для pull приватного образа. Сборка и push выполняются встроенным `GITHUB_TOKEN` репозитория с `packages: write`; отдельный write-token сохранять в secrets не требуется.

## Порядок запуска workflow

1. `Prepare deploy host` — после настройки DNS, при первом запуске, смене домена/порта или ротации `APP_HTPASSWD`.
2. `Build and deploy zxccaraul` — для каждого релиза. Можно оставить `release_tag` пустым.

Оба workflow используют общую concurrency group и не изменяют сервер одновременно. Deploy публикует новый image, копирует runtime bundle, делает предрелизный `pg_dump`, поднимает Compose с `--wait` и при ошибке возвращает прежние `.env`, Compose и Docker secret. Postgres volume при rollback не удаляется.

Если `staging` и `production` находятся на одном сервере, задайте им разные `APP_PUBLIC_URL`, `SERVER_APP_PATH`, `APP_PORT` и `COMPOSE_PROJECT_NAME`. Nginx-конфигурация и Basic Auth именуются по `COMPOSE_PROJECT_NAME`, поэтому два контура не перезаписывают друг друга.
