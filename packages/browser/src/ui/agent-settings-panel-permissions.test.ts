import { describe, it, expect } from 'vitest';
import type { SandboxPermissions, AgentConfig } from '@flo-monster/core';

describe('SandboxPermissions type', () => {
  it('should allow all permission types', () => {
    const perms: SandboxPermissions = {
      camera: true,
      microphone: false,
      geolocation: true,
    };
    expect(perms.camera).toBe(true);
    expect(perms.microphone).toBe(false);
    expect(perms.geolocation).toBe(true);
  });

  it('should allow partial permissions', () => {
    const perms: SandboxPermissions = {
      camera: true,
    };
    expect(perms.camera).toBe(true);
    expect(perms.microphone).toBeUndefined();
    expect(perms.geolocation).toBeUndefined();
  });

  it('should default to blocked when no permissions configured', () => {
    const config: AgentConfig = {
      id: 'test',
      name: 'Test',
      model: 'claude-sonnet',
      tools: [],
      maxTokens: 4096,
    };
    // No sandboxPermissions = all denied
    expect(config.sandboxPermissions).toBeUndefined();
  });

  it('should include sandboxPermissions in AgentConfig', () => {
    const config: AgentConfig = {
      id: 'test',
      name: 'Test',
      model: 'claude-sonnet',
      tools: [],
      maxTokens: 4096,
      sandboxPermissions: {
        camera: true,
        microphone: true,
        geolocation: false,
      },
    };
    expect(config.sandboxPermissions?.camera).toBe(true);
    expect(config.sandboxPermissions?.microphone).toBe(true);
    expect(config.sandboxPermissions?.geolocation).toBe(false);
  });
});

describe('Permission request message protocol', () => {
  it('should define valid permission types', () => {
    const validPermissions: Array<'camera' | 'microphone' | 'geolocation'> = [
      'camera',
      'microphone',
      'geolocation',
    ];
    expect(validPermissions).toHaveLength(3);
    expect(validPermissions).toContain('camera');
    expect(validPermissions).toContain('microphone');
    expect(validPermissions).toContain('geolocation');
  });

  it('should create well-formed permission_request messages', () => {
    const msg = {
      type: 'permission_request' as const,
      id: 'perm-123',
      agentId: 'agent-1',
      permission: 'camera' as const,
    };
    expect(msg.type).toBe('permission_request');
    expect(msg.id).toBe('perm-123');
    expect(msg.agentId).toBe('agent-1');
    expect(msg.permission).toBe('camera');
  });

  it('should create well-formed permission_result messages', () => {
    const granted = {
      type: 'permission_result' as const,
      id: 'perm-123',
      granted: true,
    };
    expect(granted.type).toBe('permission_result');
    expect(granted.granted).toBe(true);

    const denied = {
      type: 'permission_result' as const,
      id: 'perm-456',
      granted: false,
      error: 'Permission "camera" is not enabled for this agent.',
    };
    expect(denied.granted).toBe(false);
    expect(denied.error).toBeDefined();
  });
});

describe('Permission gating logic', () => {
  it('should deny permission when sandboxPermissions is undefined', () => {
    const config: AgentConfig = {
      id: 'test',
      name: 'Test',
      model: 'claude-sonnet',
      tools: [],
      maxTokens: 4096,
    };
    const permissions = config.sandboxPermissions;
    const permission = 'camera' as keyof SandboxPermissions;
    const allowed = permissions?.[permission] ?? false;
    expect(allowed).toBe(false);
  });

  it('should deny permission when specific permission is false', () => {
    const config: AgentConfig = {
      id: 'test',
      name: 'Test',
      model: 'claude-sonnet',
      tools: [],
      maxTokens: 4096,
      sandboxPermissions: {
        camera: false,
        microphone: true,
      },
    };
    const permissions = config.sandboxPermissions;
    expect(permissions?.camera).toBe(false);
    expect(permissions?.microphone).toBe(true);
  });

  it('should deny permission when specific permission is not set', () => {
    const config: AgentConfig = {
      id: 'test',
      name: 'Test',
      model: 'claude-sonnet',
      tools: [],
      maxTokens: 4096,
      sandboxPermissions: {
        camera: true,
      },
    };
    const permissions = config.sandboxPermissions;
    const geolocationAllowed = permissions?.geolocation ?? false;
    expect(geolocationAllowed).toBe(false);
  });

  it('should allow permission when enabled in config', () => {
    const config: AgentConfig = {
      id: 'test',
      name: 'Test',
      model: 'claude-sonnet',
      tools: [],
      maxTokens: 4096,
      sandboxPermissions: {
        camera: true,
        microphone: true,
        geolocation: true,
      },
    };
    const permissions = config.sandboxPermissions;
    expect(permissions?.camera).toBe(true);
    expect(permissions?.microphone).toBe(true);
    expect(permissions?.geolocation).toBe(true);
  });
});
