
# Docker deploy

## Build & run
docker compose up --build -d

## Env
- Provide Stripe + CLIENT_URL env vars (compose reads from your shell or .env)
- Volume `./data:/app/data` persists the SQLite database

## Webhook
Expose `/stripe/webhook` publicly (use `stripe listen` locally during dev).
