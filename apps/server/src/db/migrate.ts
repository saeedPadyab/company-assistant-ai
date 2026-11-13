import { config } from "dotenv"
import { drizzle } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import postgres from "postgres"

config()

const url = process.env.DATABASE_URL
if (!url) throw new Error("DATABASE_URL is not set")

const sql = postgres(url, { max: 1 })
await sql`CREATE EXTENSION IF NOT EXISTS vector`
await migrate(drizzle(sql), { migrationsFolder: "./drizzle" })
await sql.end()