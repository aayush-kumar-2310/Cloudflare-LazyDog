import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.NOTES_DB, env.TEST_MIGRATIONS);
