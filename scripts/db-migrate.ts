import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

function stringifyForLog(value: unknown): string {
  const seen = new WeakSet<object>();

  try {
    return JSON.stringify(value, (key, nestedValue: unknown) => {
      if (/url|password|secret|token/i.test(key)) {
        return "[redacted]";
      }

      if (typeof nestedValue === "bigint") {
        return nestedValue.toString();
      }

      if (typeof nestedValue === "object" && nestedValue !== null) {
        if (seen.has(nestedValue)) {
          return "[circular]";
        }

        seen.add(nestedValue);
      }

      return nestedValue;
    }, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const details = Object.fromEntries(
      Object.getOwnPropertyNames(error)
        .filter((key) => key !== "stack" && key !== "message")
        .map((key) => [key, (error as unknown as Record<string, unknown>)[key]])
    );
    const serializedDetails = Object.keys(details).length > 0
      ? `\n${stringifyForLog(details)}`
      : "";

    return `${error.stack ?? error.message}${serializedDetails}`;
  }

  if (typeof error === "object" && error !== null) {
    return stringifyForLog(error);
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
