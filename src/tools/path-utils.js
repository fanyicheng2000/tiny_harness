import fs from 'node:fs';
import path from 'node:path';

// 判断从工作区根目录到目标路径的「相对路径」是否越出了工作区。
// 例如 relativePath 为 '../secret.txt' 或 '/etc/passwd' 时，都不允许工具继续访问。
function isOutside(relativePath) {
  return (
    relativePath === '..' || // 目标正好是工作区的父目录
    relativePath.startsWith(`..${path.sep}`) || // 目标在父目录或更外层，例如 ../other-project/a.js
    path.isAbsolute(relativePath) // relative() 在不同盘符等场景可能返回绝对路径，也视为工作区外
  );
}

// 将模型 / 用户传入的路径解析为绝对路径，并做第一层「字面路径」工作区边界校验。
// 例如 workDir 是 /project，requestedPath 是 src/a.js 时，返回 /project/src/a.js；
// requestedPath 是 ../secret.txt 时会拒绝，防止通过 ../ 读取或修改工作区外的文件。
// 注意：这是路径访问防护，不是进程级或容器级沙箱；它不能限制工具本身执行任意系统命令的能力。
export function resolveWorkspacePath(workDir, requestedPath) {
  // 路径工具只接受非空字符串，避免 path.resolve 收到 undefined 等非法输入后产生难理解的行为。
  if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
    throw new Error('文件路径不能为空');
  }

  // 将工作区目录标准化为绝对路径，例如 '.' → '/Users/me/project'。
  const root = path.resolve(workDir);
  // 基于 root 解析请求路径：相对路径会拼在 root 下；绝对路径会直接指向其自身。
  // path.resolve 同时会折叠 '.'、'..'，所以后续检查看到的是规范化后的真实字面位置。
  const target = path.resolve(root, requestedPath);
  // 计算 target 相对 root 的位置，以便判断 target 是否仍在 root 的子目录中。
  const relative = path.relative(root, target);

  if (isOutside(relative)) {
    throw new Error(`路径位于工作区外，拒绝访问: ${requestedPath}`);
  }
  // 返回已标准化且已通过边界检查的绝对路径，供 read / write / edit 工具使用。
  return target;
}

// 对「已存在」文件执行第二层检查：字面路径在工作区内，不代表文件实际位置也在其中。
// 例如 /project/link 是一个符号链接，但它可能指向 /etc/passwd；第一层检查无法识别这一跳转。
export function assertExistingPathInsideWorkspace(workDir, target) {
  // realpathSync 会解析符号链接，得到工作区和目标文件在磁盘上的真实绝对路径。
  const rootReal = fs.realpathSync(path.resolve(workDir));
  const targetReal = fs.realpathSync(target);
  const relative = path.relative(rootReal, targetReal);

  if (isOutside(relative)) {
    throw new Error('目标通过符号链接指向工作区外，拒绝访问');
  }
  // 返回真实路径，调用方后续应使用它，避免检查完成后又沿着符号链接访问到工作区外。
  return targetReal;
}
