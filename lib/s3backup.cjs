const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const Sentry = require('../sentry.server.cjs');
const { createGzip } = require('zlib');
const { createReadStream, unlink } = require('fs');
const { promisify } = require('util');
const path = require('path');
const os = require('os');
const { pipeline } = require('stream/promises');

const unlinkAsync = promisify(unlink);

const S3_ENDPOINT   = process.env.S3_ENDPOINT   || 'https://s3.selectel.ru';
const S3_REGION     = process.env.S3_REGION      || 'ru-1';
const S3_BUCKET     = process.env.S3_BUCKET      || '';
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY  || '';
const S3_SECRET_KEY = process.env.S3_SECRET_KEY  || '';
const S3_PREFIX     = process.env.S3_PREFIX       || 'ozon-viewer/';
const BACKUP_RETAIN = parseInt(process.env.BACKUP_RETAIN || '7', 10);

function isConfigured() {
    return S3_BUCKET && S3_ACCESS_KEY && S3_SECRET_KEY;
}

function makeClient() {
    return new S3Client({
        endpoint: S3_ENDPOINT,
        region: S3_REGION,
        credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
        forcePathStyle: true,
    });
}

// Creates a consistent SQLite snapshot, gzips it, uploads to S3, then cleans up old backups.
async function runBackup(db) {
    if (!isConfigured()) {
        console.log('[Backup] S3 not configured — skipping');
        return;
    }

    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `backup_${ts}.db.gz`;
    const s3Key = `${S3_PREFIX}${fileName}`;
    const tmpPath = path.join(os.tmpdir(), `ozon_backup_${ts}.db`);

    console.log(`[Backup] Starting backup → s3://${S3_BUCKET}/${s3Key}`);

    try {
        // Consistent hot backup via better-sqlite3 (no writes blocked)
        await db.backup(tmpPath);

        // Gzip and stream directly to S3
        const chunks = [];
        await pipeline(
            createReadStream(tmpPath),
            createGzip(),
            async function* (source) {
                for await (const chunk of source) chunks.push(chunk);
            }
        );
        const gzipped = Buffer.concat(chunks);

        const client = makeClient();
        await client.send(new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: s3Key,
            Body: gzipped,
            ContentType: 'application/gzip',
            ContentLength: gzipped.length,
        }));

        console.log(`[Backup] Uploaded ${(gzipped.length / 1024 / 1024).toFixed(1)} MB → ${s3Key}`);

        // Падение очистки не должно выглядеть как падение бэкапа — бэкап уже загружен
        try {
            await pruneOldBackups(client);
        } catch (pruneErr) {
            console.error('[Backup] Upload OK, but prune of old backups FAILED (old backups accumulate):', pruneErr.message);
            Sentry.withScope(scope => {
                scope.setTag('operation', 'backup_prune');
                Sentry.captureException(pruneErr);
            });
        }
    } finally {
        unlinkAsync(tmpPath).catch(unlinkErr =>
            console.warn(`[Backup] Failed to remove tmp file ${tmpPath}:`, unlinkErr.message));
    }
}

async function pruneOldBackups(client) {
    const list = await client.send(new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: S3_PREFIX,
    }));

    const objects = (list.Contents || [])
        .filter(o => o.Key.endsWith('.db.gz'))
        .sort((a, b) => b.LastModified - a.LastModified);

    const toDelete = objects.slice(BACKUP_RETAIN);
    if (toDelete.length === 0) return;

    await client.send(new DeleteObjectsCommand({
        Bucket: S3_BUCKET,
        Delete: { Objects: toDelete.map(o => ({ Key: o.Key })) },
    }));

    console.log(`[Backup] Pruned ${toDelete.length} old backup(s), keeping ${BACKUP_RETAIN}`);
}

module.exports = { runBackup, isConfigured };
