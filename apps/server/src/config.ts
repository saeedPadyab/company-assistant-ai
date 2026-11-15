import { config } from "dotenv"

config()

/** The web app's origin: the only browser origin allowed to call this server with cookies. */
export const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:3000"

/** This server's own public URL; Better Auth builds its links and cookie settings from it. */
export const SERVER_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:3001"
