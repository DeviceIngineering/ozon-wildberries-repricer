import { auth } from "./auth.mjs";
import Database from "better-sqlite3";

const DB_PATH = process.env.DB_PATH || "./ozon.db";
const EMAIL = process.env.ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.ADMIN_PASSWORD;
const NAME = process.env.ADMIN_NAME || "Admin";

// No default password: this account can change prices on every connected store.
if (!PASSWORD || PASSWORD.length < 12) {
    console.error(
        "ADMIN_PASSWORD is required and must be at least 12 characters.\n" +
        "Set it in .env or inline:  ADMIN_PASSWORD='...' npm run seed"
    );
    process.exit(1);
}

async function seed() {
    try {
        const user = await auth.api.signUpEmail({
            body: { email: EMAIL, password: PASSWORD, name: NAME },
        });
        console.log("Admin user created:", user.user.email);

        // Set role directly via SQL (setRole API requires auth headers)
        const db = new Database(DB_PATH);
        db.prepare("UPDATE user SET role = 'admin' WHERE email = ?").run(EMAIL);
        db.close();
        console.log("Role set to admin");
        console.log(`\nLogin: ${EMAIL}`);
    } catch (err) {
        if (err.message?.includes("already exists") || err.body?.code === "USER_ALREADY_EXISTS") {
            console.log("Admin user already exists, skipping.");
        } else {
            console.error("Error creating admin:", err.message || err);
        }
    }
    process.exit(0);
}

seed();
