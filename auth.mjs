import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import { createRequire } from "module";

const _require = createRequire(import.meta.url);
// Share the single better-sqlite3 connection from db/connection.cjs
// to avoid two drivers writing to the same file simultaneously.
const { db } = _require("./db/connection.cjs");

const PORT = process.env.PORT || 3001;
const BASE_URL = process.env.BETTER_AUTH_URL || `http://localhost:${PORT}`;

// Sessions are unsigned without a secret, so refuse to run unprotected.
if (!process.env.BETTER_AUTH_SECRET) {
    const msg = "BETTER_AUTH_SECRET is not set. Generate one: openssl rand -hex 32";
    if (process.env.NODE_ENV === "production") throw new Error(msg);
    console.warn(`WARNING: ${msg}`);
}

// Only these origins may send authenticated requests. "*" would let any site
// on the internet ride along with the user's session cookie.
const TRUSTED_ORIGINS = (process.env.TRUSTED_ORIGINS || BASE_URL)
    .split(",").map(o => o.trim()).filter(Boolean);

// Same reason as the CORS list in server.cjs: the Vite dev server is a
// different origin from the API. Development only.
if (process.env.NODE_ENV !== "production") {
    const VITE_PORT = process.env.VITE_PORT || 5173;
    TRUSTED_ORIGINS.push(`http://localhost:${VITE_PORT}`, `http://127.0.0.1:${VITE_PORT}`);
}

export const auth = betterAuth({
    baseURL: BASE_URL,
    database: db,
    emailAndPassword: {
        enabled: true,
    },
    plugins: [admin()],
    session: {
        expiresIn: 60 * 60 * 24 * 7, // 7 days
        updateAge: 60 * 60 * 24, // refresh every day
    },
    trustedOrigins: TRUSTED_ORIGINS,
});

// Auto-migrate: create tables if missing
try {
    const { getMigrations } = await import("better-auth/db/migration");
    const { runMigrations } = await getMigrations(auth.options);
    await runMigrations();
    console.log("Auth tables ready");
} catch (e) {
    // Tables already exist
}
