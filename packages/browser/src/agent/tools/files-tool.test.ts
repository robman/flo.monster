import { describe, it, expect } from 'vitest';
import workerCode from '../worker-bundle.js?raw';

describe('Files Tool validation (worker-bundle)', () => {
  it('worker bundle contains null byte validation', () => {
    expect(workerCode).toContain("indexOf('\\0')");
  });

  it('worker bundle contains path length validation', () => {
    expect(workerCode).toContain('path.length > 512');
  });

  it('worker bundle contains unknown action handling', () => {
    // Unknown action is now handled in the shell (message-relay), but the worker
    // still sends the action via postMessage. The worker no longer has the
    // 'Unknown files action' string since that logic moved to the shell.
    // Instead, verify the worker uses postMessage-based file_request pattern.
    expect(workerCode).toContain('file_request');
  });

  it('worker bundle uses postMessage for file operations', () => {
    expect(workerCode).toContain("type: 'file_request'");
    expect(workerCode).toContain('file_result');
  });

  it('worker bundle does not use OPFS directly', () => {
    // The navigateToDir and navigator.storage.getDirectory calls should be removed
    expect(workerCode).not.toContain('navigator.storage.getDirectory');
    expect(workerCode).not.toContain('async function navigateToDir');
  });

  it('worker bundle keeps validateFilePath for client-side validation', () => {
    expect(workerCode).toContain('function validateFilePath');
    expect(workerCode).toContain('Path is required and must be a string');
    expect(workerCode).toContain('Path must not contain null bytes');
    expect(workerCode).toContain('Path must not exceed 512 characters');
    expect(workerCode).toContain('Path must have at least one segment');
  });

  it('worker bundle allows root path for directory operations', () => {
    // handleFilesTool should skip validateFilePath for root paths on directory ops
    expect(workerCode).toContain("var isRootPath = (path === '.' || path === '/' || path === './' || path === '' || path === 'root')");
    expect(workerCode).toContain("var isDirOp = (action === 'list_dir' || action === 'list_files' || action === 'mkdir')");
    expect(workerCode).toContain("if (!isDirOp || !isRootPath)");
    // When root path and dir op, sends '.' as the path
    expect(workerCode).toContain("path: isRootPath && isDirOp ? '.' : path");
  });
});
