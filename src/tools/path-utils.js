import fs from 'node:fs';
import path from 'node:path';

function isOutside(relativePath) {
  return (
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  );
}

// Resolve a user-provided path and enforce a lexical workspace boundary.
// This is a path guard, not a process or container sandbox.
export function resolveWorkspacePath(workDir, requestedPath) {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
    throw new Error('文件路径不能为空');
  }

  const root = path.resolve(workDir);
  const target = path.resolve(root, requestedPath);
  const relative = path.relative(root, target);

  if (isOutside(relative)) {
    throw new Error(`路径位于工作区外，拒绝访问: ${requestedPath}`);
  }
  return target;
}

// Existing files need a second check because a path inside the workspace may
// be a symlink whose real target is outside it.
export function assertExistingPathInsideWorkspace(workDir, target) {
  const rootReal = fs.realpathSync(path.resolve(workDir));
  const targetReal = fs.realpathSync(target);
  const relative = path.relative(rootReal, targetReal);

  if (isOutside(relative)) {
    throw new Error('目标通过符号链接指向工作区外，拒绝访问');
  }
  return targetReal;
}
