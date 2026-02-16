import type { IframeToShell, ShellToIframe } from '@flo-monster/core';
import type { AgentStorageProvider } from '../../storage/agent-storage.js';
import { parseFrontmatter, simpleGlobMatch } from './frontmatter.js';

export async function handleFileRequest(
  msg: Extract<IframeToShell, { type: 'file_request' }>,
  agentId: string,
  target: Window,
  getProvider: () => Promise<AgentStorageProvider>,
): Promise<void> {
  try {
    const provider = await getProvider();
    let result: string;

    switch (msg.action) {
      case 'read_file': {
        result = await provider.readFile(agentId, msg.path);
        break;
      }
      case 'write_file': {
        await provider.writeFile(agentId, msg.path, msg.content || '');
        result = 'File written: ' + msg.path;
        break;
      }
      case 'delete_file': {
        await provider.deleteFile(agentId, msg.path);
        result = 'Deleted: ' + msg.path;
        break;
      }
      case 'mkdir': {
        await provider.mkdir(agentId, msg.path);
        result = 'Directory created: ' + msg.path;
        break;
      }
      case 'list_dir':
      case 'list_files': {
        const entries = await provider.listDir(agentId, msg.path);
        const names = entries.map(e => e.name + (e.isDirectory ? '/' : ''));
        result = names.length > 0 ? names.join('\n') : '(empty directory)';
        break;
      }
      case 'frontmatter': {
        // Parse directory and pattern from msg.path
        // e.g., "saves/*.srcdoc.md" -> dir="saves", pattern="*.srcdoc.md"
        // e.g., "*.srcdoc.md" -> dir=".", pattern="*.srcdoc.md"
        const pathStr = msg.path || '*';
        const lastSlash = pathStr.lastIndexOf('/');
        const dir = lastSlash >= 0 ? pathStr.slice(0, lastSlash) : '.';
        const pattern = lastSlash >= 0 ? pathStr.slice(lastSlash + 1) : pathStr;

        const fmEntries = await provider.listDir(agentId, dir);
        const results: { path: string; frontmatter: Record<string, unknown> }[] = [];

        for (const entry of fmEntries) {
          if (entry.isDirectory) continue;
          if (!simpleGlobMatch(pattern, entry.name)) continue;
          try {
            const content = await provider.readFile(agentId, entry.path);
            const fm = parseFrontmatter(content);
            if (fm) {
              results.push({ path: entry.path, frontmatter: fm });
            }
          } catch {
            // Skip files that can't be read
          }
        }

        result = JSON.stringify(results);
        break;
      }
      default:
        throw new Error('Unknown files action: ' + msg.action);
    }

    target.postMessage({
      type: 'file_result',
      id: msg.id,
      result,
    } satisfies ShellToIframe, '*');
  } catch (err) {
    target.postMessage({
      type: 'file_result',
      id: msg.id,
      result: null,
      error: String(err),
    } satisfies ShellToIframe, '*');
  }
}
