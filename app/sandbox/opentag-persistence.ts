import { join } from "node:path";
import {
  sqlitePersistence,
  type SqlitePersistenceHandle,
} from "./sqlite-persistence.js";

export type OpentagSqlitePersistence = SqlitePersistenceHandle;

let instance: OpentagSqlitePersistence | undefined;

function defaultSqliteUrl(): string {
  const fromEnv = process.env.OPENTAG_SQLITE_URL?.trim();
  if (fromEnv) return fromEnv;
  return join(process.cwd(), ".data", "opentag.sqlite");
}

export function opentagSqlitePersistence(): OpentagSqlitePersistence {
  return (instance ??= sqlitePersistence({
    url: defaultSqliteUrl(),
    migrate: true,
  }));
}

export function __resetOpentagSqlitePersistenceForTests(): void {
  if (instance) {
    instance.close();
    instance = undefined;
  }
}
