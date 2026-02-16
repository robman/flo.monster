import type { ToolHandler, ToolResult, ToolContext } from '@flo-monster/core';
import { generateRequestId } from '@flo-monster/core';

export function createCapabilitiesTool(): ToolHandler {
  return {
    definition: {
      name: 'capabilities',
      description: 'Discover your runtime environment. Call with no arguments for a full snapshot (platform, tools, viewport, permissions, hub, extensions). Call with a probe argument for specific feature detection (webgl, webaudio, webrtc, webgpu, wasm, offscreencanvas, sharedarraybuffer, storage, network, tool).',
      input_schema: {
        type: 'object',
        properties: {
          probe: { type: 'string', description: 'Feature to probe: webgl, webaudio, webrtc, webgpu, wasm, offscreencanvas, sharedarraybuffer, storage, network, tool' },
          url: { type: 'string', description: 'URL to check (for network probe)' },
          name: { type: 'string', description: 'Tool name to check (for tool probe)' },
        },
      },
    },
    async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const id = generateRequestId('cap');
      const action = input.probe ? 'probe' : 'snapshot';

      ctx.sendToShell({
        type: 'capabilities_request',
        id,
        action,
        probe: input.probe as string | undefined,
        probeArgs: {
          ...(input.url ? { url: input.url } : {}),
          ...(input.name ? { name: input.name } : {}),
        },
      });

      try {
        const response = await ctx.waitForResponse(id) as {
          result?: unknown;
          error?: string;
        };

        if (response.error) {
          return { content: `Capabilities error: ${response.error}`, is_error: true };
        }

        return { content: JSON.stringify(response.result, null, 2) };
      } catch (err) {
        return { content: `Capabilities timeout: ${String(err)}`, is_error: true };
      }
    },
  };
}
