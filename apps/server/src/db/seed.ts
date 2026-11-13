import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { closeDb, db } from "./client.js"
import { teams, users } from "./schema.js"

config()

await db.insert(teams).values([{ name: "Marketing" }, { name: "Engineering" }]).onConflictDoNothing()

const marketing = await db.select().from(teams).where(eq(teams.name, "Marketing"))
const engineering = await db.select().from(teams).where(eq(teams.name, "Engineering"))

await db
    .insert(users)
    .values([
        { email: "sara@example.com", name: "Sara", role: "employee", teamId: marketing[0].id },
        { email: "manager@example.com", name: "Mina", role: "manager", teamId: marketing[0].id },
        { email: "hr@example.com", name: "Ali", role: "hr", teamId: engineering[0].id },
    ])
    .onConflictDoNothing()

await closeDb()