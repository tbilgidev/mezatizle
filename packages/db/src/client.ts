import postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;

export function createSql(connectionString?: string): Sql {
  const url =
    connectionString ??
    process.env.DATABASE_URL ??
    "postgres://mezatizle:mezatizle@127.0.0.1:5432/mezatizle";
  return postgres(url, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 30,
  });
}
