// 在已登录管理端的浏览器中，以 read-only evaluate 执行并保存返回结果。
() => {
  const wrap = document.querySelector('.table-wrap');
  const table = wrap.querySelector('table');
  const rows = [...document.querySelectorAll('#agent-rows tr')];
  const headers = [...table.querySelectorAll('th')];
  const checks = [];
  const check = (name, pass) => checks.push({ name, pass });
  check('记录已加载', rows.length > 0);
  check('页面无横向溢出', document.documentElement.scrollWidth <= innerWidth + 1);
  check('名称列有足够阅读宽度', rows.every(row => row.cells[1].clientWidth >= 220));
  check('表头与数据列对齐', rows.every(row => [...row.cells].every((cell, index) =>
    Math.abs(cell.getBoundingClientRect().left - headers[index].getBoundingClientRect().left) <= 1)));
  check('操作单元格与整行等高', rows.every(row =>
    Math.abs(row.cells[row.cells.length - 1].getBoundingClientRect().height - row.getBoundingClientRect().height) <= 1));
  check('状态文字保持一行', rows.every(row => {
    const status = row.querySelector('.status-dot');
    return status.getBoundingClientRect().height <= +getComputedStyle(status).lineHeight.replace('px', '') + 1;
  }));
  check('编辑和删除按钮在单元格内', rows.every(row => {
    const actions = row.cells[row.cells.length - 1];
    const cell = actions.getBoundingClientRect();
    const buttons = [...actions.querySelectorAll('button')];
    return buttons.length === 2 && buttons.every(button => {
      const rect = button.getBoundingClientRect();
      return rect.left >= cell.left && rect.right <= cell.right + 1 && rect.bottom <= cell.bottom + 1;
    });
  }));
  check('宽屏完整展示或窄屏可横向滚动', innerWidth >= 1024
    ? wrap.scrollWidth <= wrap.clientWidth + 1
    : wrap.scrollWidth <= wrap.clientWidth + 1 || ['auto', 'scroll'].includes(getComputedStyle(wrap).overflowX));
  return { viewport: { width: innerWidth, height: innerHeight }, rows: rows.length,
    tableWidth: table.getBoundingClientRect().width, containerWidth: wrap.clientWidth,
    checks, passed: checks.every(item => item.pass) };
};
