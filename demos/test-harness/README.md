# calc-app

一个命令行计算器小工具，支持加减乘除。

## 文件
- `src/index.js` — 入口，解析命令行参数并输出结果

## 运行
```bash
node src/index.js add 2 3   # 输出 5
node src/index.js sub 5 2   # 输出 3
node src/index.js mul 4 5   # 输出 20
node src/index.js div 10 2  # 输出 5
```

## 已知问题
除法（div）运算结果不对，待修复。
