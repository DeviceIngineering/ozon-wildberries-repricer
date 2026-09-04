/**
 * Loads .env into process.env for local (non-Docker) runs.
 *
 * In Docker the variables arrive through `environment:` in the compose file, so
 * nothing read .env before — which meant that outside Docker `cp .env.example
 * .env` silently did nothing: the server opened the default database while the
 * seed script wrote the admin into another one, and login failed with no clue
 * as to why.
 *
 * Deliberately dependency-free and deliberately small. Real environment
 * variables always win, so `DB_PATH=./x.db npm run seed` still overrides the
 * file, and CI needs no .env at all.
 *
 * Supports: KEY=value, `export KEY=value`, # comments, blank lines, single or
 * double quoted values with \n escapes inside double quotes.
 */

const fs = require('fs');
const path = require('path');

function parse(contents) {
    const out = {};
    for (const rawLine of contents.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
        const eq = withoutExport.indexOf('=');
        if (eq === -1) continue;

        const key = withoutExport.slice(0, eq).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

        let value = withoutExport.slice(eq + 1).trim();

        if (value.startsWith('"') && value.endsWith('"') && value.length > 1) {
            value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r');
        } else if (value.startsWith("'") && value.endsWith("'") && value.length > 1) {
            value = value.slice(1, -1);
        } else {
            // Strip a trailing inline comment, but only when it is spaced off,
            // so a value like pass#word survives.
            const hash = value.indexOf(' #');
            if (hash !== -1) value = value.slice(0, hash).trim();
        }

        out[key] = value;
    }
    return out;
}

/**
 * @param {string} [file] Path to the env file. Defaults to .env in the project root.
 * @returns {string[]} Names of the variables actually applied.
 */
function loadEnv(file) {
    const envPath = file || path.join(__dirname, '..', '.env');
    let contents;
    try {
        contents = fs.readFileSync(envPath, 'utf8');
    } catch {
        return []; // No .env is normal: Docker and CI pass real variables.
    }

    const applied = [];
    for (const [key, value] of Object.entries(parse(contents))) {
        if (process.env[key] === undefined) {
            process.env[key] = value;
            applied.push(key);
        }
    }
    return applied;
}

module.exports = { loadEnv, parse };
