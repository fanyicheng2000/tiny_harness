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

  // L2: 换行符归一化（兼容 Windows \r\n 和 Unix \n）。
  //
  // 同一段代码在 Windows 文件中可能是 "第一行\r\n第二行"，而模型提供的 old_text
  // 往往是 "第一行\n第二行"。肉眼看起来都换行了，但字符串并不相等，L1 精确匹配会失败。
  // 这里先把“文件内容”和“模型给出的旧文本”中的 \r\n 统一替换为 \n，再重新比较。
  const normalizedContent = originalContent.replaceAll('\r\n', '\n');
  const normalizedOld = oldText.replaceAll('\r\n', '\n');

  // 仍然要求恰好只出现 1 次才替换：出现 0 次继续尝试更宽松的 L3；
  // 出现多次也不能随便替换，否则可能误改多个相同代码块。
  const normalizedCount = countOccurrences(normalizedContent, normalizedOld);
  if (normalizedCount === 1) {
    // 注意这里返回的是“换行已统一为 \n”的完整文件内容；这是 L2 为兼容跨平台换行做出的结果。
    return normalizedContent.replace(normalizedOld, newText);
  }

  // L3: 去掉 old_text 最前和最后的空白后再匹配。
  //
  // 模型复制代码时，常会在片段开头多带一个空行/空格，或在结尾多带换行；
  // 这些“包在代码块外侧”的空白通常不影响真正想替换的代码，却会让 L2 无法精确命中。
  // trim() 只移除整个 old_text 两端的空格、制表符、换行，不会删除中间代码行的缩进。
  const trimmedOld = normalizedOld.trim();

  // 空字符串不能作为替换目标：它会在任意位置都能“匹配”，没有唯一含义。
  if (trimmedOld !== '') {
    // 仍在“已统一为 \n 的文件内容”中查找，只有恰好命中一处才允许替换，防止误改。
    const trimmedCount = countOccurrences(normalizedContent, trimmedOld);
    if (trimmedCount === 1) {
      // 替换时只替换去掉片段两端多余空白后的代码；文件中该代码本身的内部缩进保持不变。
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

// L4：最后一级、最宽松的替换策略——逐行忽略首尾空白后匹配。
//
// 前面的 L1/L2/L3 都要求 old_text 的“每一行内部缩进”基本一致；但模型复制粘贴代码时，
// 常会把 4 个空格缩进写成 2 个、完全漏掉缩进，或额外加上缩进。此方法会将候选片段与文件
// 中对应的每一行分别 trim() 后比较，找到唯一匹配的连续行区间，再用 newText 替换原始行区间。
//
// 注意：它只忽略“每行两端的空白”，不会忽略行中间的字符差异；并且仍要求唯一命中，
// 因此比直接模糊搜索更安全。由于容错最强、误匹配风险也最高，所以放在四级策略最后。
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
