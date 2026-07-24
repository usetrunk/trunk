import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "object" && error !== null) {
    try {
      return JSON.stringify(error, (_, value: unknown) => (
        typeof value === "bigint" ? value.toString() : value
      ), 2);
    } catch {
      return String(error);
    }
  }

  return String(error);
}

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is required to apply database migrations");
  process.exitCode = 1;
} else {
  const client = postgres(databaseUrl, { max: 1 });

  try {
    await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
    console.log("Database migrations applied successfully");
  } catch (error) {
    console.error("Database migration failed:");
    console.error(describeError(error));
    process.exitCode = 1;
  } finally {
    await client.end({ timeout: 5 });
  }
}
