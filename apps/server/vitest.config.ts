import { config } from "dotenv"
import { defineConfig } from "vitest/config"

config()

export default defineConfig({
    test: {
        // All server tests share one seeded database, and some change it for a moment
        // (a user moved to another team). One file at a time keeps them from seeing each other.
        fileParallelism: false,
    },
})
