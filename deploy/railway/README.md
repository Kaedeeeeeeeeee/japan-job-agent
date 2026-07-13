# Railway Singapore deployment runbook

Deploy one private Railway project in Singapore with services `web`, `api`, `worker`, `temporal`, a PostgreSQL 16 + pgvector service, and a private Bucket. Each source-backed service must point Railway Config as Code at its matching file in this directory.

Required references and secrets:

- API: `DATABASE_URL`, `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, bucket credentials.
- Web: `API_BASE_URL=http://api.railway.internal:3000`, `AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, `ALLOWED_GITHUB_LOGIN=Kaedeeeeeeeeee`.
- Worker: API database/Bucket variables plus `TEMPORAL_ADDRESS=temporal.railway.internal:7233`.
- Temporal: `DB=postgres12`, `POSTGRES_SEEDS`, `POSTGRES_USER`, `POSTGRES_PWD`, `DBNAME=temporal`, `VISIBILITY_DBNAME=temporal_visibility` using private PostgreSQL networking.

After first deployment run `pnpm temporal:schedules` in the Worker service. Configure a weekly cron service using the Worker image and `pnpm backup:database`; set Bucket credentials and keep logical dumps private. Railway managed daily volume backups are the first recovery layer; the weekly Bucket dump is independent.

Before enabling production traffic:

1. Create the company-owned GitHub OAuth application and exact callback URL; never use personal test credentials.
2. Confirm `/signin` rejects every login except `Kaedeeeeeeeeee`.
3. Run `pnpm backup:restore-verify` against an isolated restore database.
4. Set a Railway usage notification at JPY 5,000 equivalent and record the alert screenshot/date in the deployment audit.
5. Keep API, Temporal, PostgreSQL, and Bucket private. Only Web receives a public domain; Railway can probe the API health path on the private service.

Railway CLI authentication is intentionally not stored in the repository.
