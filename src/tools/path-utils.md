# `path-utils.js` 详细讲解：工作区路径边界保护

该文件提供两个路径守卫，防止文件类工具通过 `../`、绝对路径或符号链接访问工作区外内容。它是路径 guard，不是容器或进程级沙箱。

## `resolveWorkspacePath(workDir, requestedPath)`

```js
const root = path.resolve(workDir);
const target = path.resolve(root, requestedPath);
const relative = path.relative(root, target);
```

先把工作区与用户输入规范化为绝对路径，再计算 target 相对 root 的位置。`isOutside()` 检查三种越界表达：

- 相对结果恰为 `..`；
- 以 `../` 开头；
- 相对结果本身是绝对路径。

命中时抛错，正常时返回规范化路径。输入为空或非字符串也会拒绝。

这能阻止 `../../secret` 一类词法路径穿越，也能让新文件写入前确认目标在工作区内。

## `assertExistingPathInsideWorkspace(workDir, target)`

词法边界不够：工作区内的 `link` 可能是指向外部文件的符号链接。因此读取或编辑**已存在文件**时还要：

```js
const rootReal = fs.realpathSync(path.resolve(workDir));
const targetReal = fs.realpathSync(target);
```

`realpathSync` 解析所有符号链接，再次基于真实路径执行越界检查。通过后返回真实 target 路径。

`read_file`、`edit_file` 使用两层校验；`write_file` 只使用第一层，因为新目标可能不存在，无法 realpath。

## 边界

- `bash` 只将 cwd 设为工作区，Shell 命令仍可显式访问外部路径；路径工具不能隔离进程权限。
- 检查与随后打开文件之间仍可能存在符号链接竞态；高安全场景需 OS 沙箱、容器或基于文件描述符的安全 API。
- `path.relative()` 的行为与平台分隔符有关，代码通过 `path.sep` 适配当前系统。

## 总结

`path-utils.js` 将所有文件工具共享的边界规则集中起来：先拒绝词法逃逸，再为已有目标解析真实路径，减少工具各自实现导致的安全不一致。