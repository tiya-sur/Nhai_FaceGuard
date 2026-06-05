/**
 * SyncService.ts
 * Handles offline-to-online sync of authentication records with AWS,
 * then purges local data after confirmed upload.
 *
 * Flow:
 *   1. App stores records locally in SQLite (via localDB.ts) with synced: false
 *   2. SyncService watches for network connectivity
 *   3. On reconnect → batch upload unsynced records to AWS API Gateway → S3/DynamoDB
 *   4. On AWS 200 OK → mark records synced=true → purge after retention window
 */

import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
import { LocalDB, AuthRecord } from './localDB';

const AWS_ENDPOINT = 'https://your-api-id.execute-api.ap-south-1.amazonaws.com/prod/sync';
const BATCH_SIZE = 50;          // records per upload batch
const PURGE_AFTER_MS = 24 * 60 * 60 * 1000; // purge synced records after 24 h

export type SyncStatus = {
  syncing: boolean;
  lastSyncAt: string | null;
  pendingCount: number;
  errorMsg: string | null;
};

type SyncListener = (status: SyncStatus) => void;

class SyncService {
  private unsubscribeNetInfo?: () => void;
  private listeners: SyncListener[] = [];
  private syncing = false;
  private lastSyncAt: string | null = null;

  /** Call once at app startup */
  init() {
    this.unsubscribeNetInfo = NetInfo.addEventListener(this.handleNetChange);
  }

  destroy() {
    this.unsubscribeNetInfo?.();
  }

  /** Subscribe to status updates (for UI progress indicators) */
  addListener(fn: SyncListener) {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(l => l !== fn); };
  }

  private emit(extra: Partial<SyncStatus> = {}) {
    const base: SyncStatus = {
      syncing: this.syncing,
      lastSyncAt: this.lastSyncAt,
      pendingCount: 0,
      errorMsg: null,
      ...extra,
    };
    this.listeners.forEach(l => l(base));
  }

  private handleNetChange = async (state: NetInfoState) => {
    if (state.isConnected && state.isInternetReachable) {
      await this.syncNow();
    }
  };

  /** Manually trigger a sync attempt */
  async syncNow(): Promise<boolean> {
    if (this.syncing) return false;

    const pending = await LocalDB.getUnsynced();
    if (pending.length === 0) return true;

    this.syncing = true;
    this.emit({ syncing: true, pendingCount: pending.length });

    try {
      // Process in batches to avoid large payloads
      for (let i = 0; i < pending.length; i += BATCH_SIZE) {
        const batch = pending.slice(i, i + BATCH_SIZE);
        await this.uploadBatch(batch);
      }

      this.lastSyncAt = new Date().toISOString();
      this.syncing = false;
      this.emit({ syncing: false, pendingCount: 0, lastSyncAt: this.lastSyncAt });

      // Purge old synced records
      await this.purgeOldRecords();
      return true;
    } catch (err: any) {
      this.syncing = false;
      this.emit({ syncing: false, errorMsg: err.message ?? 'Sync failed' });
      return false;
    }
  }

  private async uploadBatch(records: AuthRecord[]): Promise<void> {
    const payload = records.map(r => ({
      userId: r.userId,
      confidence: r.confidence,
      livenessVerified: r.livenessVerified,
      timestamp: r.timestamp,
      deviceId: r.deviceId ?? 'unknown',
    }));

    const res = await fetch(AWS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: payload }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`AWS upload failed (${res.status}): ${text}`);
    }

    // Mark all as synced in local DB
    const ids = records.map(r => r.id!).filter(Boolean);
    await LocalDB.markSynced(ids);
  }

  /** Remove records that have been synced AND are older than PURGE_AFTER_MS */
  private async purgeOldRecords(): Promise<number> {
    const cutoff = new Date(Date.now() - PURGE_AFTER_MS).toISOString();
    const deleted = await LocalDB.purgeSyncedBefore(cutoff);
    console.log(`[SyncService] Purged ${deleted} old records`);
    return deleted;
  }

  /** Immediate purge of all synced records (e.g., on user logout) */
  async purgeAllSynced(): Promise<number> {
    return LocalDB.purgeSyncedBefore(new Date().toISOString());
  }
}

export const syncService = new SyncService();
