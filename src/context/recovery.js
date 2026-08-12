// ===========================================
// context/recovery.js
// ===========================================
// 错误自愈管理器：工具失败时注入"救援指南"
//
// 两个层次：
//   层次一（基础）：把完整 stderr 塞回上下文（引擎自动做）
//   层次二（升级）：匹配错误特征，注入具体指导（这里做）
//
// 为什么不让 Agent 直接重试？
//   直接重试同样的命令 = 死循环（模块十的成因）
//   正确做法是让模型"理解后修正"，救援指南帮模型理解
// ===========================================

export class RecoveryManager {
  /**
   * 分析报错特征，返回增强后的报错信息
   * @param {string} toolName - 工具名
   * @param {string} rawError - 原始报错
   * @returns {string} 增强后的报错（含救援指南）
   */
  analyzeAndInject(toolName, rawError) {
    let hint = '';
    const lowerError = rawError.toLowerCase();

    switch (toolName) {
      case 'edit_file':
        if (rawError.includes('在文件中未找到 old_text') || rawError.includes('找不到该代码片段')) {
          hint = '你提供的 old_text 与文件当前内容不一致，或者缺少必要的缩进。请先使用 `read_file` 工具重新读取该文件，获取最新、准确的内容后，再重新发起编辑。';
        } else if (rawError.includes('匹配到了多处') || rawError.includes('提供更多上下文')) {
          hint = '你的 old_text 不够具体，命中了多个相同代码块。请在 old_text 中增加上下相邻的几行代码，以确保替换的唯一性。';
        }
        break;

      case 'read_file':
      case 'write_file':
        if (lowerError.includes('no such file or directory') || lowerError.includes('enoent')) {
          hint = '路径似乎不正确。请不要凭空猜测，先使用 `bash` 执行 `ls -la` 或 `find . -name` 命令查找正确的目录结构和文件名。';
        } else if (lowerError.includes('permission denied') || lowerError.includes('eacces')) {
          hint = '你没有权限操作该文件。请检查工作区限制，或者思考是否需要修改其他文件。';
        }
        break;

      case 'bash':
        if (lowerError.includes('command not found')) {
          hint = '系统中未安装该命令。请先思考：是否有替代命令？或者你需要先编写脚本进行安装？';
        } else if (rawError.includes('超时') || rawError.includes('timeout')) {
          // 匹配 30s 超时报错
          hint = '该命令执行被超时强杀。如果它是一个常驻服务（如 server 或 watch），请将其转入后台执行（例如使用 `nohup ... &`），不要阻塞主线程。';
        } else if (lowerError.includes('syntax error')) {
          hint = 'Bash 语法错误。请检查引号转义或特殊字符，确保命令在终端中可直接运行。';
        }
        break;
    }

    // 没匹配到特征，原样返回
    if (!hint) return rawError;

    // 匹配到了，拼接救援指南
    return `${rawError}\n\n[系统救援指南]: ${hint}`;
  }
}
