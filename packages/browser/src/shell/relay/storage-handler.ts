import type { IframeToShell, ShellToIframe } from '@flo-monster/core';
import type { AuditManager } from '../audit-manager.js';
import { openDB, idbGet, idbPut, idbDelete, idbKeys } from '../../utils/idb-helpers.js';

export async function handleStorageRequest(
  msg: Extract<IframeToShell, { type: 'storage_request' }>,
  agentId: string,
  target: Window,
  auditManager: AuditManager | null,
): Promise<void> {
  try {
    const dbName = `flo-agent-${agentId}`;
    const db = await openDB(dbName);
    let result: unknown = null;

    switch (msg.action) {
      case 'get': {
        result = await idbGet(db, 'store', msg.key || '');
        break;
      }
      case 'set': {
        await idbPut(db, 'store', msg.key || '', msg.value);
        result = { ok: true };
        break;
      }
      case 'delete': {
        await idbDelete(db, 'store', msg.key || '');
        result = { ok: true };
        break;
      }
      case 'list': {
        result = await idbKeys(db, 'store');
        break;
      }
    }

    db.close();

    // Log to audit
    auditManager?.append(agentId, {
      source: 'agent',
      action: msg.action,
      key: msg.key,
    });

    target.postMessage({
      type: 'storage_result',
      id: msg.id,
      result,
    } satisfies ShellToIframe, '*');
  } catch (err) {
    target.postMessage({
      type: 'storage_result',
      id: msg.id,
      result: null,
      error: String(err),
    } satisfies ShellToIframe, '*');
  }
}
