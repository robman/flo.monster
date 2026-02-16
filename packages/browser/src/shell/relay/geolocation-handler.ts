import type { AgentContainer } from '../../agent/agent-container.js';
import type { PermissionApprovalDialog } from '../../ui/permission-approval-dialog.js';
import type { PermissionApprovalResult } from '../../ui/permission-approval-dialog.js';

export interface GeolocationContext {
  permissionApprovals: Map<string, PermissionApprovalResult>;
  permissionApprovalDialog: PermissionApprovalDialog | null;
  setPermissionApprovalDialog: (dialog: PermissionApprovalDialog) => void;
  onPermissionChange: ((agentId: string, permission: string, enabled: boolean) => void) | null;
}

export const activeWatches = new Map<string, { watchId: number; agentId: string }>();

export async function handleGeolocationGet(
  msg: { type: 'geolocation_get'; id: string; agentId: string; enableHighAccuracy?: boolean; timeout?: number; maximumAge?: number },
  agent: AgentContainer,
  target: Window,
  ctx: GeolocationContext,
): Promise<void> {
  // Check geolocation permission
  const geoEnabled = agent.config.sandboxPermissions?.geolocation ?? false;

  if (!geoEnabled) {
    const cacheKey = `${agent.id}:geolocation`;
    const cached = ctx.permissionApprovals.get(cacheKey);

    if (cached) {
      if (!cached.approved) {
        target.postMessage({
          type: 'geolocation_error',
          id: msg.id,
          error: 'Geolocation permission was denied.',
          code: 1,
        }, '*');
        return;
      }
      // cached.approved = true — fall through
    } else {
      // Show approval dialog
      const { PermissionApprovalDialog } = await import('../../ui/permission-approval-dialog.js');
      if (!ctx.permissionApprovalDialog) {
        const dialog = new PermissionApprovalDialog();
        ctx.permissionApprovalDialog = dialog;
        ctx.setPermissionApprovalDialog(dialog);
      }

      const result = await ctx.permissionApprovalDialog.show(agent.config.name, 'geolocation');
      ctx.permissionApprovals.set(cacheKey, result);

      if (!result.approved) {
        target.postMessage({
          type: 'geolocation_error',
          id: msg.id,
          error: 'Geolocation permission was denied by the user.',
          code: 1,
        }, '*');
        return;
      }

      // Update agent config
      const updatedPermissions = { ...agent.config.sandboxPermissions, geolocation: true };
      agent.updateConfig({ sandboxPermissions: updatedPermissions });

      // Notify for persistence if "Allow Always"
      if (result.persistent && ctx.onPermissionChange) {
        ctx.onPermissionChange(agent.id, 'geolocation', true);
      }
    }
  }

  // Check geolocation availability
  if (!navigator.geolocation) {
    target.postMessage({
      type: 'geolocation_error',
      id: msg.id,
      error: 'Geolocation not supported',
      code: 2,
    }, '*');
    return;
  }

  const options: PositionOptions = {};
  if (msg.enableHighAccuracy !== undefined) options.enableHighAccuracy = msg.enableHighAccuracy;
  if (msg.timeout !== undefined) options.timeout = msg.timeout;
  if (msg.maximumAge !== undefined) options.maximumAge = msg.maximumAge;

  navigator.geolocation.getCurrentPosition(
    (position) => {
      target.postMessage({
        type: 'geolocation_position',
        id: msg.id,
        coords: {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          altitude: position.coords.altitude,
          altitudeAccuracy: position.coords.altitudeAccuracy,
          heading: position.coords.heading,
          speed: position.coords.speed,
        },
        timestamp: position.timestamp,
      }, '*');
    },
    (err) => {
      target.postMessage({
        type: 'geolocation_error',
        id: msg.id,
        error: err.message,
        code: err.code,
      }, '*');
    },
    options,
  );
}

export async function handleGeolocationWatchStart(
  msg: { type: 'geolocation_watch_start'; id: string; agentId: string; enableHighAccuracy?: boolean; timeout?: number; maximumAge?: number },
  agent: AgentContainer,
  target: Window,
  ctx: GeolocationContext,
): Promise<void> {
  // Check geolocation permission
  const geoEnabled = agent.config.sandboxPermissions?.geolocation ?? false;

  if (!geoEnabled) {
    const cacheKey = `${agent.id}:geolocation`;
    const cached = ctx.permissionApprovals.get(cacheKey);

    if (cached) {
      if (!cached.approved) {
        target.postMessage({
          type: 'geolocation_error',
          id: msg.id,
          error: 'Geolocation permission was denied.',
          code: 1,
        }, '*');
        return;
      }
      // cached.approved = true — fall through
    } else {
      // Show approval dialog
      const { PermissionApprovalDialog } = await import('../../ui/permission-approval-dialog.js');
      if (!ctx.permissionApprovalDialog) {
        const dialog = new PermissionApprovalDialog();
        ctx.permissionApprovalDialog = dialog;
        ctx.setPermissionApprovalDialog(dialog);
      }

      const result = await ctx.permissionApprovalDialog.show(agent.config.name, 'geolocation');
      ctx.permissionApprovals.set(cacheKey, result);

      if (!result.approved) {
        target.postMessage({
          type: 'geolocation_error',
          id: msg.id,
          error: 'Geolocation permission was denied by the user.',
          code: 1,
        }, '*');
        return;
      }

      // Update agent config
      const updatedPermissions = { ...agent.config.sandboxPermissions, geolocation: true };
      agent.updateConfig({ sandboxPermissions: updatedPermissions });

      // Notify for persistence if "Allow Always"
      if (result.persistent && ctx.onPermissionChange) {
        ctx.onPermissionChange(agent.id, 'geolocation', true);
      }
    }
  }

  // Check geolocation availability
  if (!navigator.geolocation) {
    target.postMessage({
      type: 'geolocation_error',
      id: msg.id,
      error: 'Geolocation not supported',
      code: 2,
    }, '*');
    return;
  }

  const options: PositionOptions = {};
  if (msg.enableHighAccuracy !== undefined) options.enableHighAccuracy = msg.enableHighAccuracy;
  if (msg.timeout !== undefined) options.timeout = msg.timeout;
  if (msg.maximumAge !== undefined) options.maximumAge = msg.maximumAge;

  const watchId = navigator.geolocation.watchPosition(
    (position) => {
      target.postMessage({
        type: 'geolocation_position',
        id: msg.id,
        coords: {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          altitude: position.coords.altitude,
          altitudeAccuracy: position.coords.altitudeAccuracy,
          heading: position.coords.heading,
          speed: position.coords.speed,
        },
        timestamp: position.timestamp,
      }, '*');
    },
    (err) => {
      target.postMessage({
        type: 'geolocation_error',
        id: msg.id,
        error: err.message,
        code: err.code,
      }, '*');
    },
    options,
  );

  activeWatches.set(msg.id, { watchId, agentId: msg.agentId });
}

export function handleGeolocationWatchStop(
  msg: { type: 'geolocation_watch_stop'; id: string; agentId: string },
  _agent: AgentContainer,
  target: Window,
): void {
  const entry = activeWatches.get(msg.id);
  if (entry) {
    navigator.geolocation.clearWatch(entry.watchId);
    activeWatches.delete(msg.id);
  }

  target.postMessage({
    type: 'geolocation_watch_stopped',
    id: msg.id,
  }, '*');
}

export function cleanupGeolocationWatches(agentId: string): void {
  for (const [id, entry] of activeWatches) {
    if (entry.agentId === agentId) {
      navigator.geolocation.clearWatch(entry.watchId);
      activeWatches.delete(id);
    }
  }
}
