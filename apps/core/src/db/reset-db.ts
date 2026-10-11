/**
 * Wipes all rows in public tables (keeps schema + drizzle migrations).
 * For local test resets only — requires --yes and blocks non-local hosts unless --force.
 */
import postgres from "postgres";

const defaultUrl = "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const databaseUrl = process.env.DATABASE_URL ?? defaultUrl;

const args = new Set(process.argv.slice(2));
const confirmed = process.env.CONFIRM === "reset" || args.has("--yes");
const forceRemote = process.env.FORCE === "1" || args.has("--force");

function hostOf(url: string): string {
  const normalized = url.replace(/^postgres(ql)?:\/\//, "http://");
  return new URL(normalized).hostname;
}

function assertSafeTarget(): void {
  const host = hostOf(databaseUrl);
  const local = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!local && !forceRemote) {
    console.error(
      `Refusing to reset database at host "${host}". Use FORCE=1 or --force only if you mean it.`,
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  if (!confirmed) {
    console.error("Destructive reset. Re-run with --yes or CONFIRM=reset.");
    process.exit(1);
  }
  assertSafeTarget();

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const rows = await sql<{ tablename: string }[]>`
      select tablename
      from pg_tables
      where schemaname = 'public'
        and tablename not like 'drizzle%'
        and tablename not like '__drizzle%'
    `;
    if (rows.length === 0) {
      console.log("No public tables to truncate.");
      return;
    }
    const quoted = rows.map((row) => `"${row.tablename.replace(/"/g, '""')}"`).join(", ");
    await sql.unsafe(`truncate table ${quoted} restart identity cascade`);
    console.log(`Truncated ${rows.length} tables on ${hostOf(databaseUrl)} (${new URL(databaseUrl.replace(/^postgres(ql)?:\/\//, "http://")).pathname.slice(1) || "postgres"}).`);
  } finally {
    await sql.end();
  }
}

await main();
