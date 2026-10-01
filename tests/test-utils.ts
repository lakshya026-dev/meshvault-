import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export function getUniqueTestDbPath(prefix = 'test'): string {
  const dir = path.resolve(process.cwd(), 'tests', 'temp');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.resolve(dir, `${prefix}_${randomUUID().slice(0, 8)}.db`);
}

export function cleanupTestFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
    }
    // Also cleanup WAL and SHM files if present
    const wal = `${filePath}-wal`;
    const shm = `${filePath}-shm`;
    if (fs.existsSync(wal)) fs.rmSync(wal, { force: true });
    if (fs.existsSync(shm)) fs.rmSync(shm, { force: true });
  } catch {
    // Windows file locking may momentarily delay file deletion; safe to ignore in test teardown
  }
}
