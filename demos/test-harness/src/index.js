// calc-app: 命令行计算器
const [op, ...nums] = process.argv.slice(2);
const a = Number(nums[0]);
const b = Number(nums[1]);

function calc(op, a, b) {
  switch (op) {
    case 'add': return a + b;
    case 'sub': return a - b;
    case 'mul': return a * b;
    case 'div': return a * b;   // BUG: 应该是 a / b
    default: return '未知操作';
  }
}

if (!op) {
  console.log('用法: node src/index.js <add|sub|mul|div> <a> <b>');
} else {
  console.log(calc(op, a, b));
}
