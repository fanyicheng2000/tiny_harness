// ===========================================
// tools/edit-file.js
// ===========================================
// 局部字符串替换工具
//
// 设计动机：
//   write_file 会整文件覆盖，对大文件不安全。
//   edit_file 只替换局部片段，更安全、更快。
//
// 核心难点：模型给的 old_text 经常和文件实际内容"几乎一样但不完全一样"
//   - 多了 / 少了缩进
//   - 换行符 \r\n vs \n
//   - 复制时混入了空白
//
// 解决方案：fuzzyReplace 四级渐进式匹配
//   L1 精确匹配  → L2 换行符归一化 → L3 TrimSpace → L4 逐行去缩进
//   一级一级试，命中即返回。越靠后容错越强，但误伤风险也越大。
// ===========================================

import fs from 'node:fs/promises';
import { ToolDefinition } from '../schema/message.js';
import {
  assertExistingPathInsideWorkspace,
  resolveWorkspacePath,
} from './path-utils.js';

export class EditFileTool {
  constructor(workDir) {
    this.workDir = workDir;
  }

  name() {
    return 'edit_file';
  }

  definition() {
    return new ToolDefinition({
      name: this.name(),
      description:
        '对现有文件进行局部的字符串替换。这比重写整个文件更安全、更快速。请提供足够的 old_text 上下文以确保匹配的唯一性。',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '要修改的文件路径',
          },
          old_text: {
            type: 'string',
            description: '文件中原有的文本。必须包含足够的上下文，以确保在文件中的唯一性。',
          },
          new_text: {
            type: 'string',
            description: '要替换成的新文本',
          },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    });
  }

  async execute(args) {
    const { path: relPath, old_text: oldText, new_text: newText } = args;

    let originalContent;
    let fullPath;
    try {
      fullPath = resolveWorkspacePath(this.workDir, relPath);
      fullPath = assertExistingPathInsideWorkspace(this.workDir, fullPath);
      originalContent = await fs.readFile(fullPath, 'utf8');
    } catch (err) {
      throw new Error(`读取文件失败，请确认路径是否正确: ${err.message}`);
    }

    const newContent = fuzzyReplace(originalContent, oldText, newText);

    try {
      await fs.writeFile(fullPath, newContent, 'utf8');
    } catch (err) {
      throw new Error(`写回文件失败: ${err.message}`);
    }

    return `✅ 成功修改文件: ${relPath}`;
  }
}

// ===========================================
// fuzzyReplace: 四级渐进式匹配
// ===========================================
function fuzzyReplace(originalContent, oldText, newText) {
  // L1: 精确匹配（最严格，0 容错）
  const exactCount = countOccurrences(originalContent, oldText);
  if (exactCount === 1) {
    return originalContent.replace(oldText, newText);
  }
  if (exactCount > 1) {
    throw new Error(`old_text 匹配到了 ${exactCount} 处，请提供更多的上下文代码以确保唯一性`);
  }

  // L2: 换行符归一化（兼容 Windows \r\n 和 Unix \n）
  const normalizedContent = originalContent.replaceAll('\r\n', '\n');
  const normalizedOld = oldText.replaceAll('\r\n', '\n');

  const normalizedCount = countOccurrences(normalizedContent, normalizedOld);
  if (normalizedCount === 1) {
    return normalizedContent.replace(normalizedOld, newText);
  }

  // L3: Trim Space 匹配（去掉 old_text 两端空白）
  const trimmedOld = normalizedOld.trim();
  if (trimmedOld !== '') {
    const trimmedCount = countOccurrences(normalizedContent, trimmedOld);
    if (trimmedCount === 1) {
      return normalizedContent.replace(trimmedOld, newText);
    }
  }

  // L4: 逐行去缩进匹配（最宽松，每行都 trim 后比对）
  return lineByLineReplace(normalizedContent, normalizedOld, newText);
}

// 统计子串出现次数（不重叠）
function countOccurrences(haystack, needle) {
  if (needle === '') return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

// L4: 逐行 trim 后匹配
// 用途：模型复制粘贴代码时常常丢缩进或加缩进，这里把每一行的缩进都忽略掉再比
function lineByLineReplace(content, oldText, newText) {
  const contentLines = content.split('\n');
  const oldLines = oldText.trim().split('\n');

  if (oldLines.length === 0 || contentLines.length < oldLines.length) {
    throw new Error('找不到该代码片段');
  }

  // 把要找的每一行都 trim 一下
  const trimmedOldLines = oldLines.map(l => l.trim());

  // 在 contentLines 里滑动窗口找匹配
  let matchCount = 0;
  let matchStartIndex = -1;
  let matchEndIndex = -1;

  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    let isMatch = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (contentLines[i + j].trim() !== trimmedOldLines[j]) {
        isMatch = false;
        break;
      }
    }
    if (isMatch) {
      matchCount++;
      matchStartIndex = i;
      matchEndIndex = i + oldLines.length;
    }
  }

  if (matchCount === 0) {
    throw new Error('在文件中未找到 old_text，请检查内容和缩进');
  }
  if (matchCount > 1) {
    throw new Error(`模糊匹配到了 ${matchCount} 处代码，请提供更多上下文以定位`);
  }

  // 拼装新内容：原内容前段 + newText + 原内容后段
  const newContentLines = [
    ...contentLines.slice(0, matchStartIndex),
    newText,
    ...contentLines.slice(matchEndIndex),
  ];
  return newContentLines.join('\n');
}
