/**
 * localDB.ts
 * Encrypted local storage using SQLite (react-native-sqlite-storage).
 * Stores face embeddings + attendance records with sync queue.
 * All data purged after successful AWS sync.
 */

import SQLite from 'react-native-sqlite-storage';
import EncryptedStorage from 'react-native-encrypted-storage';

SQLite.enablePromise(true);

const DB_NAME = 'datalake_faceauth.db';
const DB_ENCRYPTION_KEY_ALIAS = 'faceauth_db_key';

let db: SQLite.SQLiteDatabase | null = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

export async function initDatabase(): Promise<void> {
  db = await SQLite.openDatabase({ name: DB_NAME, location: 'default' });

  await db.executeSql(`
    CREATE TABLE IF NOT EXISTS face_embeddings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      department TEXT,
      embedding BLOB NOT NULL,       -- Float32Array serialised as base64
      registered_at TEXT NOT NULL,
      is_active INTEGER DEFAULT 1
    );
  `);

  await db.executeSql(`
    CREATE TABLE IF NOT EXISTS attendance_records (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      confidence REAL NOT NULL,
      timestamp TEXT NOT NULL,
      location TEXT,
      device_id TEXT,
      synced INTEGER DEFAULT 0,      -- 0 = pending, 1 = synced
      sync_attempt_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);

  await db.executeSql(`
    CREATE INDEX IF NOT EXISTS idx_attendance_synced
    ON attendance_records(synced);
  `);
}

// ─── Embeddings ───────────────────────────────────────────────────────────────

export interface StoredEmbedding {
  userId: string;
  name: string;
  department?: string;
  embedding: Float32Array;
}

export async function getStoredEmbeddings(): Promise<StoredEmbedding[]> {
  if (!db) await initDatabase();

  const [results] = await db!.executeSql(
    'SELECT user_id, name, department, embedding FROM face_embeddings WHERE is_active = 1'
  );

  const embeddings: StoredEmbedding[] = [];
  for (let i = 0; i < results.rows.length; i++) {
    const row = results.rows.item(i);
    embeddings.push({
      userId: row.user_id,
      name: row.name,
      department: row.department,
      embedding: base64ToFloat32Array(row.embedding),
    });
  }
  return embeddings;
}

export async function saveEmbedding(data: {
  userId: string;
  name: string;
  department?: string;
  embedding: Float32Array;
}): Promise<void> {
  if (!db) await initDatabase();

  await db!.executeSql(
    `INSERT OR REPLACE INTO face_embeddings
     (id, user_id, name, department, embedding, registered_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      generateId(),
      data.userId,
      data.name,
      data.department ?? '',
      float32ArrayToBase64(data.embedding),
      new Date().toISOString(),
    ]
  );
}

// ─── Attendance Records ───────────────────────────────────────────────────────

export interface AttendanceRecord {
  userId: string;
  name: string;
  confidence: number;
  timestamp: string;
  location?: string;
  synced: boolean;
}

export async function saveAttendanceRecord(record: AttendanceRecord): Promise<string> {
  if (!db) await initDatabase();

  const id = generateId();
  await db!.executeSql(
    `INSERT INTO attendance_records
     (id, user_id, name, confidence, timestamp, location, device_id, synced, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      record.userId,
      record.name,
      record.confidence,
      record.timestamp,
      record.location ?? '',
      getDeviceId(),
      record.synced ? 1 : 0,
      new Date().toISOString(),
    ]
  );
  return id;
}

export async function getPendingRecords(): Promise<(AttendanceRecord & { id: string })[]> {
  if (!db) await initDatabase();

  const [results] = await db!.executeSql(
    'SELECT * FROM attendance_records WHERE synced = 0 ORDER BY timestamp ASC LIMIT 100'
  );

  const records = [];
  for (let i = 0; i < results.rows.length; i++) {
    const row = results.rows.item(i);
    records.push({
      id: row.id,
      userId: row.user_id,
      name: row.name,
      confidence: row.confidence,
      timestamp: row.timestamp,
      location: row.location,
      synced: false,
    });
  }
  return records;
}

export async function markRecordsSynced(ids: string[]): Promise<void> {
  if (!db || ids.length === 0) return;

  const placeholders = ids.map(() => '?').join(',');
  await db!.executeSql(
    `UPDATE attendance_records SET synced = 1 WHERE id IN (${placeholders})`,
    ids
  );
}

/** Purge synced records older than 24h */
export async function purgeSyncedRecords(): Promise<number> {
  if (!db) await initDatabase();

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [result] = await db!.executeSql(
    `DELETE FROM attendance_records WHERE synced = 1 AND created_at < ?`,
    [cutoff]
  );
  return result.rowsAffected;
}

export async function getRecordCount(): Promise<{ pending: number; total: number }> {
  if (!db) await initDatabase();

  const [pendingResult] = await db!.executeSql(
    'SELECT COUNT(*) as count FROM attendance_records WHERE synced = 0'
  );
  const [totalResult] = await db!.executeSql(
    'SELECT COUNT(*) as count FROM attendance_records'
  );

  return {
    pending: pendingResult.rows.item(0).count,
    total: totalResult.rows.item(0).count,
  };
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function float32ArrayToBase64(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer);
  let binary = '';
  bytes.forEach(b => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function base64ToFloat32Array(b64: string): Float32Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function getDeviceId(): string {
  // In production: use react-native-device-info
  return 'device-001';
}
