// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, act, cleanup } from '@testing-library/react';
import React from 'react';
import App from '../src/App.jsx';
import { verifySolveResponse } from '../src/verifySolveResponse.js';

// jsdom 不提供 ResizeObserver 与真实布局，补一个空实现即可（虚拟化仍会按 overscan 渲染）。
beforeEach(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const DEFAULT_4X4 = [
  [90, 75, 120, 60],
  [35, 80, 55, 200],
  [110, 40, 95, 130],
  [65, 150, 70, 100],
];

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function okResp(assignment, totalCost, n = 4, pairFlags) {
  return jsonResponse(200, { status: 'ok', n, assignment, totalCost, pairFlags });
}

const ALL_FLEXIBLE_4 = [
  { forced: false, alternatives: 1 },
  { forced: false, alternatives: 1 },
  { forced: false, alternatives: 1 },
  { forced: false, alternatives: 1 },
];
const ALL_FORCED_4 = [
  { forced: true, alternatives: 0 },
  { forced: true, alternatives: 0 },
  { forced: true, alternatives: 0 },
  { forced: true, alternatives: 0 },
];

describe('App 页面：请求锁定 / 编辑清方案 / 排除重算', () => {
  it('请求期间锁定编辑与提交，返回后展示方案；之后编辑立即清除旧方案', async () => {
    const d = deferred();
    const fetchMock = vi.fn(() => d.promise);
    vi.stubGlobal('fetch', fetchMock);

    const { getByText, getByDisplayValue, findByText, queryByText, container } = render(<App />);

    // 发起求解
    fireEvent.click(getByText('求解最小分配'));

    // 请求进行中：出现锁定提示，提交按钮与规模输入都被禁用
    await findByText('请求进行中：编辑已锁定，等待服务器返回精确最优方案……');
    const solveBtn = getByText('求解中…').closest('button');
    expect(solveBtn.disabled).toBe(true);
    expect(getByDisplayValue('4').disabled).toBe(true);
    // 矩阵格也被锁定（禁配标记按钮禁用）
    const lockedMarks = container.querySelectorAll('.cell button');
    expect(lockedMarks.length).toBeGreaterThan(0);
    lockedMarks.forEach((b) => expect(b.disabled).toBe(true));

    // 服务器返回
    await act(async () => {
      d.resolve(okResp([3, 0, 1, 2], 205));
    });
    await findByText('最优分配方案');
    expect(getByText('205')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 请求结束后直接编辑一个格：旧方案立即消失
    const cell90 = Array.from(container.querySelectorAll('.cell-value')).find(
      (b) => b.textContent === '90'
    );
    fireEvent.click(cell90);
    const input = container.querySelector('.cell-input');
    fireEvent.change(input, { target: { value: '123' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(queryByText('最优分配方案')).toBeNull();
  });

  it('排除配对：该格被设为禁配并经同一接口重算，展示替代最优方案', async () => {
    const bodies = [];
    const fetchMock = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      // 第一次：原矩阵最优；之后：排除 [0][3] 后的替代问题
      const isExcluded = body.costs[0][3] === null;
      if (!isExcluded) return okResp([3, 0, 1, 2], 205);
      // 替代方案：探针 1 改配座 3（列下标 2，代价 120）
      return okResp([2, 0, 1, 3], 295);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { getByText, getAllByText, findByText } = render(<App />);
    fireEvent.click(getByText('求解最小分配'));
    await findByText('最优分配方案');

    // 排除第一对（探针 1 → 座 4，即 [0][3]）
    const firstExclude = getAllByText('排除此配对')[0];
    fireEvent.click(firstExclude);

    await findByText('295');
    expect(bodies).toHaveLength(2);
    // 经同一接口
    expect(fetchMock.mock.calls[0][0]).toBe('/api/solve');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/solve');
    // 重算载荷中该格确为禁配，其余不变
    const nextCosts = bodies[1].costs;
    expect(nextCosts[0][3]).toBeNull();
    expect(nextCosts[0][0]).toBe(90);
    expect(nextCosts).toEqual(
      DEFAULT_4X4.map((row, i) => (i === 0 ? row.map((v, j) => (j === 3 ? null : v)) : row))
    );
  });

  it('排除后返回 409 NO_PERFECT_ASSIGNMENT：展示无解且清除旧方案', async () => {
    const fetchMock = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.costs[0][3] === null) {
        return jsonResponse(409, {
          status: 'error',
          error: 'NO_PERFECT_ASSIGNMENT',
          message: '禁配关系下不存在覆盖全部探针与测试座的完美匹配',
        });
      }
      return okResp([3, 0, 1, 2], 205);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { getByText, getAllByText, findByText, queryByText } = render(<App />);
    fireEvent.click(getByText('求解最小分配'));
    await findByText('最优分配方案');

    fireEvent.click(getAllByText('排除此配对')[0]);

    await findByText(/NO_PERFECT_ASSIGNMENT/);
    // 旧方案被清除
    expect(queryByText('最优分配方案')).toBeNull();
  });

  it('422 INVALID_INPUT：展示输入错误且无方案残留', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse(422, {
        status: 'error',
        error: 'INVALID_INPUT',
        message: '第 2 行长度 1 与 n=2 不一致（错维度）',
      })
    );
    const { getByText, findByText, queryByText } = render(<App />);
    fireEvent.click(getByText('求解最小分配'));
    await findByText(/INVALID_INPUT/);
    expect(queryByText('最优分配方案')).toBeNull();
  });

  it('必然/可替换标记与方案同一次更新：按行渲染徽标与解释，且只针对展示配对', async () => {
    // 前两条必然、后两条可替换
    const flags = [
      { forced: true, alternatives: 0 },
      { forced: true, alternatives: 0 },
      { forced: false, alternatives: 2 },
      { forced: false, alternatives: 1 },
    ];
    vi.stubGlobal('fetch', async () => okResp([3, 0, 1, 2], 205, 4, flags));
    const { getByText, getAllByText, findByText, container } = render(<App />);
    fireEvent.click(getByText('求解最小分配'));
    await findByText('最优分配方案');

    // 徽标数量与配对一致（只数配对卡片，不含下方图例）；文案可解释必然/可替换
    const pairsBox = container.querySelector('.pairs');
    expect(pairsBox.querySelectorAll('.pair-flag.is-forced')).toHaveLength(2);
    expect(pairsBox.querySelectorAll('.pair-flag.is-flexible')).toHaveLength(2);
    expect(getAllByText('可替换 ×2')).toHaveLength(1);
    expect(getAllByText('可替换 ×1')).toHaveLength(1);
    // 汇总结论
    expect(getByText(/共 2 条必然/)).toBeTruthy();

    // 矩阵高亮：展示配对格按标记加 class（n=4 全部在视口内）
    const forcedCells = container.querySelectorAll('.cell.match-forced');
    const flexibleCells = container.querySelectorAll('.cell.match-flexible');
    expect(forcedCells).toHaveLength(2);
    expect(flexibleCells).toHaveLength(2);
  });

  it('响应缺 pairFlags 时不渲染任何标记（不臆造、不崩）', async () => {
    vi.stubGlobal('fetch', async () => okResp([3, 0, 1, 2], 205));
    const { getByText, findByText, queryByText, container } = render(<App />);
    fireEvent.click(getByText('求解最小分配'));
    await findByText('最优分配方案');
    expect(container.querySelector('.pairs').querySelectorAll('.pair-flag')).toHaveLength(0);
    expect(container.querySelectorAll('.pair-flag')).toHaveLength(0);
    expect(container.querySelectorAll('.cell.match-forced')).toHaveLength(0);
  });

  it('编辑后旧标记随方案一起清除，不会残留上一轮结论', async () => {
    vi.stubGlobal('fetch', async () => okResp([3, 0, 1, 2], 205, 4, ALL_FORCED_4));
    const { getByText, findByText, queryByText, container } = render(<App />);
    fireEvent.click(getByText('求解最小分配'));
    await findByText('最优分配方案');
    expect(container.querySelector('.pairs').querySelectorAll('.pair-flag.is-forced')).toHaveLength(4);

    // 改一个格：方案与标记同时消失
    const cell90 = Array.from(container.querySelectorAll('.cell-value')).find(
      (b) => b.textContent === '90'
    );
    fireEvent.click(cell90);
    const input = container.querySelector('.cell-input');
    fireEvent.change(input, { target: { value: '123' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(queryByText('最优分配方案')).toBeNull();
    expect(container.querySelectorAll('.pair-flag')).toHaveLength(0);
    expect(container.querySelectorAll('.cell.match-forced')).toHaveLength(0);
  });

  it('排除配对重算：标记随新方案重新分析，不沿用排除前的可替换结论', async () => {
    const fetchMock = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.costs[0][3] === null) {
        // 替代问题：新展示的 4 条配对全部必然
        return okResp([2, 0, 1, 3], 295, 4, ALL_FORCED_4);
      }
      // 原方案：全部可替换
      return okResp([3, 0, 1, 2], 205, 4, ALL_FLEXIBLE_4);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { getByText, getAllByText, findByText, container } = render(<App />);
    fireEvent.click(getByText('求解最小分配'));
    await findByText('最优分配方案');
    const pairsBox = container.querySelector('.pairs');
    expect(pairsBox.querySelectorAll('.pair-flag.is-flexible')).toHaveLength(4);
    expect(pairsBox.querySelectorAll('.pair-flag.is-forced')).toHaveLength(0);

    fireEvent.click(getAllByText('排除此配对')[0]);
    await findByText('295');
    // 新方案：4 条必然，且旧的“可替换”徽标一个不剩（同一次更新切换）
    expect(container.querySelector('.pairs').querySelectorAll('.pair-flag.is-forced')).toHaveLength(4);
    expect(container.querySelector('.pairs').querySelectorAll('.pair-flag.is-flexible')).toHaveLength(0);
  });

  it('排除后 409：方案与标记一并清除，不保留排除前的必然徽标', async () => {
    const fetchMock = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.costs[0][3] === null) {
        return jsonResponse(409, {
          status: 'error',
          error: 'NO_PERFECT_ASSIGNMENT',
          message: '禁配关系下不存在覆盖全部探针与测试座的完美匹配',
        });
      }
      return okResp([3, 0, 1, 2], 205, 4, ALL_FORCED_4);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { getByText, getAllByText, findByText, queryByText, container } = render(<App />);
    fireEvent.click(getByText('求解最小分配'));
    await findByText('最优分配方案');
    expect(container.querySelector('.pairs').querySelectorAll('.pair-flag.is-forced')).toHaveLength(4);

    fireEvent.click(getAllByText('排除此配对')[0]);
    await findByText(/NO_PERFECT_ASSIGNMENT/);
    expect(queryByText('最优分配方案')).toBeNull();
    expect(container.querySelectorAll('.pair-flag')).toHaveLength(0);
    expect(container.querySelectorAll('.cell.match-forced')).toHaveLength(0);
  });
});

// —— 协议验收：代理/缓存/滚动升级旧服务可能回 200/ok 但响应不属于当前矩阵、
// 结构残缺或无法精确复算。任何这种响应都不得成为可操作方案。——
const PERF = { n: 4, assignment: [3, 0, 1, 2], totalCost: 205 };

// 把第 i 行第 j 列改成指定值（数字）。
function setCellValue(container, i, j, value) {
  const cell = container.querySelectorAll('.cell')[i * 4 + j];
  fireEvent.click(cell.querySelector('.cell-value, .forbidden-mark'));
  const input = cell.querySelector('.cell-input');
  fireEvent.change(input, { target: { value: String(value) } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

// 把第 i 行第 j 列置为禁配（清空）。
function setCellForbidden(container, i, j) {
  const cell = container.querySelectorAll('.cell')[i * 4 + j];
  fireEvent.click(cell.querySelector('.cell-value, .forbidden-mark'));
  const input = cell.querySelector('.cell-input');
  fireEvent.change(input, { target: { value: '' } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('App 页面：200/ok 畸形响应的协议验收', () => {
  async function renderAndSolve(body, { jsonParse = true } = {}) {
    vi.stubGlobal(
      'fetch',
      async () =>
        jsonParse
          ? jsonResponse(200, body)
          : { ok: true, status: 200, json: async () => { throw new Error('bad json'); } }
    );
    const utils = render(<App />);
    fireEvent.click(utils.getByText('求解最小分配'));
    await utils.findByText(/BAD_RESPONSE/);
    return utils;
  }

  // 对每一类畸形响应都必须满足的统一断言：稳定协议错误码、结果清理、
  // 矩阵零误标、排除按钮不存在（无可操作方案）。
  function assertRejectedCleanly(container, queryByText) {
    // 不展示任何方案区
    expect(queryByText('最优分配方案')).toBeNull();
    // 没有任何配对卡片，自然也没有可继续排除的按钮
    expect(container.querySelectorAll('.pair')).toHaveLength(0);
    expect(container.querySelectorAll('.exclude')).toHaveLength(0);
    // 矩阵零误标：无匹配格、无必然/可替换高亮、无占用列头
    expect(container.querySelectorAll('.cell.matched')).toHaveLength(0);
    expect(container.querySelectorAll('.cell.match-forced')).toHaveLength(0);
    expect(container.querySelectorAll('.cell.match-flexible')).toHaveLength(0);
    expect(container.querySelectorAll('.matched-head')).toHaveLength(0);
    // 无任何分析徽标或图例
    expect(container.querySelectorAll('.pair-flag')).toHaveLength(0);
    expect(container.querySelector('.flags-legend')).toBeNull();
  }

  const malformedCases = [
    ['缺行：assignment 短数组', { status: 'ok', n: 4, assignment: [3, 0, 1], totalCost: 135 }],
    ['多行：assignment 过长', { status: 'ok', n: 4, assignment: [3, 0, 1, 2, 2], totalCost: 205 }],
    ['重复列', { status: 'ok', n: 4, assignment: [3, 0, 1, 3], totalCost: 275 }],
    ['越界列（=n）', { status: 'ok', n: 4, assignment: [4, 0, 1, 2], totalCost: 205 }],
    ['越界列（负数）', { status: 'ok', n: 4, assignment: [-1, 0, 1, 2], totalCost: 205 }],
    ['列下标非整数', { status: 'ok', n: 4, assignment: [3.5, 0, 1, 2], totalCost: 205 }],
    ['assignment 不是数组', { status: 'ok', n: 4, assignment: { 0: 3 }, totalCost: 205 }],
    ['totalCost 不符', { status: 'ok', n: 4, assignment: [3, 0, 1, 2], totalCost: 999 }],
    ['totalCost 非数字', { status: 'ok', n: 4, assignment: [3, 0, 1, 2], totalCost: '205' }],
    ['n 不符（更大矩阵的方案）', { status: 'ok', n: 5, assignment: [3, 0, 1, 2], totalCost: 205 }],
    ['n 不符（更小矩阵的方案）', { status: 'ok', n: 3, assignment: [3, 0, 1, 2], totalCost: 205 }],
    ['缺 n 字段', { status: 'ok', assignment: [3, 0, 1, 2], totalCost: 205 }],
    ['status 不是 ok', { status: 'stale', n: 4, assignment: [3, 0, 1, 2], totalCost: 205 }],
    ['pairFlags 长度不足', { status: 'ok', ...PERF, pairFlags: ALL_FORCED_4.slice(0, 3) }],
    ['pairFlags 长度过长', { status: 'ok', ...PERF, pairFlags: [...ALL_FORCED_4, { forced: true, alternatives: 0 }] }],
    ['pairFlags 为 null', { status: 'ok', ...PERF, pairFlags: null }],
    ['pairFlags 不是数组', { status: 'ok', ...PERF, pairFlags: { 0: ALL_FORCED_4[0] } }],
    ['单项标记为 null（错位）', { status: 'ok', ...PERF, pairFlags: [ALL_FORCED_4[0], null, ALL_FORCED_4[2], ALL_FORCED_4[3]] }],
    ['forced 非布尔（字符串）', {
      status: 'ok',
      ...PERF,
      pairFlags: [{ forced: 'true', alternatives: 0 }, ...ALL_FORCED_4.slice(1)],
    }],
    ['alternatives 非整数', {
      status: 'ok',
      ...PERF,
      pairFlags: [{ forced: true, alternatives: 0.5 }, ...ALL_FORCED_4.slice(1)],
    }],
    ['forced/alternatives 自相矛盾', {
      status: 'ok',
      ...PERF,
      pairFlags: [{ forced: true, alternatives: 2 }, ...ALL_FORCED_4.slice(1)],
    }],
    ['alternatives 为负', {
      status: 'ok',
      ...PERF,
      pairFlags: [ALL_FORCED_4[0], ALL_FORCED_4[1], { forced: false, alternatives: -1 }, ALL_FORCED_4[3]],
    }],
  ];

  for (const [name, body] of malformedCases) {
    it(`${name}：稳定报 BAD_RESPONSE，清理结果且矩阵零误标`, async () => {
      const { queryByText, container } = await renderAndSolve(body);
      assertRejectedCleanly(container, queryByText);
    });
  }

  it('成功响应体不是合法 JSON：同样稳定报 BAD_RESPONSE 且零误标', async () => {
    const { queryByText, container } = await renderAndSolve(null, { jsonParse: false });
    assertRejectedCleanly(container, queryByText);
  });

  it('配对落在禁配格：拒绝采用，不把禁配格误标为方案', async () => {
    // 先把默认矩阵的 [0][3]（方案配对之一，代价 60）置为禁配
    const utils = render(<App />);
    setCellForbidden(utils.container, 0, 3);
    // 旧服务/缓存仍返回包含该禁配格的“最优方案”
    vi.stubGlobal('fetch', async () => jsonResponse(200, { status: 'ok', ...PERF }));
    fireEvent.click(utils.getByText('求解最小分配'));
    await utils.findByText(/BAD_RESPONSE/);
    assertRejectedCleanly(utils.container, utils.queryByText);
    // 该格仍只是禁配格，没有被高亮成匹配
    const forbiddenCell = utils.container.querySelectorAll('.cell')[3];
    expect(forbiddenCell.classList.contains('forbidden')).toBe(true);
  });

  it('编辑矩阵后收到旧矩阵尺寸的缓存响应：n 不符，拒绝且不留上一轮高亮', async () => {
    // 第一轮：合法 4×4 全必然方案
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { status: 'ok', ...PERF, pairFlags: ALL_FORCED_4 }))
      // 第二轮：矩阵改为 3×3，却拿到旧的 n=4 缓存响应
      .mockResolvedValueOnce(
        jsonResponse(200, { status: 'ok', n: 4, assignment: [3, 0, 1, 2], totalCost: 205 })
      );
    vi.stubGlobal('fetch', fetchMock);

    const { getByText, getByDisplayValue, findByText, queryByText, container } = render(<App />);
    fireEvent.click(getByText('求解最小分配'));
    await findByText('最优分配方案');
    expect(container.querySelectorAll('.cell.match-forced')).toHaveLength(4);

    // 改为 n=3（编辑会清掉旧方案），再求解
    fireEvent.change(getByDisplayValue('4'), { target: { value: '3' } });
    fireEvent.click(getByText('应用'));
    expect(queryByText('最优分配方案')).toBeNull();
    fireEvent.click(getByText('求解最小分配'));
    await findByText(/BAD_RESPONSE/);
    assertRejectedCleanly(container, queryByText);
    // 3×3 矩阵上绝不能出现 n=4 的列下标或高亮
    expect(container.querySelectorAll('.cell')).toHaveLength(9);
  });

  it('被拒绝后编辑再求解得到合法响应：可恢复为正常可操作方案', async () => {
    // 第一轮缺行被拒；编辑把 [0][0] 90→85 后，第二轮给出与新矩阵精确相符的方案
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { status: 'ok', n: 4, assignment: [3, 0, 1], totalCost: 135 }) // 缺行
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { status: 'ok', n: 4, assignment: [3, 0, 1, 2], totalCost: 205, pairFlags: ALL_FORCED_4 })
      );
    vi.stubGlobal('fetch', fetchMock);

    const { getByText, findByText, queryByText, container } = render(<App />);
    fireEvent.click(getByText('求解最小分配'));
    await findByText(/BAD_RESPONSE/);
    assertRejectedCleanly(container, queryByText);

    // 改一个格（不在配对方上）：错误随编辑清除
    setCellValue(container, 0, 0, 85);
    expect(queryByText(/BAD_RESPONSE/)).toBeNull();
    // 再次求解：同一份当前矩阵的合法方案被采用
    fireEvent.click(getByText('求解最小分配'));
    await findByText('最优分配方案');
    expect(queryByText(/BAD_RESPONSE/)).toBeNull();
    expect(container.querySelectorAll('.pair')).toHaveLength(4);
    expect(container.querySelectorAll('.exclude')).toHaveLength(4);
    expect(container.querySelectorAll('.cell.match-forced')).toHaveLength(4);
    expect(getByText(/与服务器一致/)).toBeTruthy();
  });

  it('旧版合法响应（完全无 pairFlags 字段）：展示分配但不渲染任何分析标记', async () => {
    vi.stubGlobal('fetch', async () => okResp([3, 0, 1, 2], 205)); // 不带 pairFlags
    const { getByText, findByText, container } = render(<App />);
    fireEvent.click(getByText('求解最小分配'));
    await findByText('最优分配方案');

    // 方案可展示、可复算、可排除
    expect(container.querySelectorAll('.pair')).toHaveLength(4);
    expect(container.querySelectorAll('.exclude')).toHaveLength(4);
    expect(getByText(/与服务器一致/)).toBeTruthy();
    expect(container.querySelectorAll('.cell.matched')).toHaveLength(4);
    // 但不渲染任何分析标记：无徽标、无图例、无必然/可替换高亮
    expect(container.querySelectorAll('.pair-flag')).toHaveLength(0);
    expect(container.querySelector('.flags-legend')).toBeNull();
    expect(container.querySelectorAll('.cell.match-forced')).toHaveLength(0);
    expect(container.querySelectorAll('.cell.match-flexible')).toHaveLength(0);
  });

  it('合法标记响应：逐行对应渲染必然/可替换徽标与矩阵高亮，方案可操作', async () => {
    const flags = [
      { forced: true, alternatives: 0 },
      { forced: true, alternatives: 0 },
      { forced: false, alternatives: 2 },
      { forced: false, alternatives: 1 },
    ];
    vi.stubGlobal('fetch', async () => okResp([3, 0, 1, 2], 205, 4, flags));
    const { getByText, findByText, container } = render(<App />);
    fireEvent.click(getByText('求解最小分配'));
    await findByText('最优分配方案');
    expect(container.querySelectorAll('.pair')).toHaveLength(4);
    expect(container.querySelectorAll('.exclude')).toHaveLength(4);
    expect(container.querySelectorAll('.cell.match-forced')).toHaveLength(2);
    expect(container.querySelectorAll('.cell.match-flexible')).toHaveLength(2);
    expect(getByText(/共 2 条必然/)).toBeTruthy();
  });

  it('标记顺序错位会被拒绝（不会把未知配对误标为“可替换”）', async () => {
    // flags 看似齐全，但其中一项类型畸形，代表与本次 assignment 无法完整对应
    const shifted = [
      ALL_FLEXIBLE_4[1],
      ALL_FLEXIBLE_4[2],
      ALL_FLEXIBLE_4[3],
      'oops',
    ];
    const { queryByText, container } = await renderAndSolve({ status: 'ok', ...PERF, pairFlags: shifted });
    assertRejectedCleanly(container, queryByText);
  });
});

describe('verifySolveResponse：协议验收纯函数', () => {
  const costs = DEFAULT_4X4;
  const okBody = {
    status: 'ok',
    n: 4,
    assignment: [3, 0, 1, 2],
    totalCost: 205,
    pairFlags: ALL_FORCED_4,
  };

  it('完整合法响应通过，pairFlags 被规范化保留', () => {
    const v = verifySolveResponse(okBody, 4, costs);
    expect(v.ok).toBe(true);
    expect(v.assignment).toEqual([3, 0, 1, 2]);
    expect(v.totalCost).toBe(205);
    expect(v.pairFlags).toEqual(ALL_FORCED_4);
  });

  it('完全缺 pairFlags 字段：通过且 pairFlags=null（旧版兼容）', () => {
    const { pairFlags, ...legacy } = okBody;
    expect(pairFlags).toBeDefined();
    const v = verifySolveResponse(legacy, 4, costs);
    expect(v.ok).toBe(true);
    expect(v.pairFlags).toBeNull();
  });

  it('pairFlags 显式为 undefined 属性等价于缺失（旧版兼容）', () => {
    const v = verifySolveResponse({ ...okBody, pairFlags: undefined }, 4, costs);
    expect(v.ok).toBe(true);
    expect(v.pairFlags).toBeNull();
  });

  const rejectCases = [
    ['n 不符', { ...okBody, n: 3 }],
    ['assignment 短数组', { ...okBody, assignment: [3, 0, 1] }],
    ['重复列', { ...okBody, assignment: [3, 0, 1, 3], totalCost: 275 }],
    ['越界列', { ...okBody, assignment: [4, 0, 1, 2] }],
    ['totalCost 不符', { ...okBody, totalCost: 206 }],
    ['禁配格', null], // 下方特化
    ['pairFlags 长度不足', { ...okBody, pairFlags: ALL_FORCED_4.slice(0, 2) }],
    ['pairFlags=null', { ...okBody, pairFlags: null }],
    ['forced 非法', {
      ...okBody,
      pairFlags: [{ forced: 1, alternatives: 0 }, ...ALL_FORCED_4.slice(1)],
    }],
    ['矛盾标记', {
      ...okBody,
      pairFlags: [{ forced: false, alternatives: 0 }, ...ALL_FORCED_4.slice(1)],
    }],
  ];

  for (const [name, body] of rejectCases) {
    it(`${name}：返回 ok=false 且带原因`, () => {
      let v;
      if (body === null) {
        const withForbidden = costs.map((r) => r.slice());
        withForbidden[0][3] = null;
        v = verifySolveResponse(okBody, 4, withForbidden);
      } else {
        v = verifySolveResponse(body, 4, costs);
      }
      expect(v.ok).toBe(false);
      expect(typeof v.reason).toBe('string');
      expect(v.reason.length).toBeGreaterThan(0);
    });
  }

  it('非对象响应（null/数组/数字）被拒绝', () => {
    expect(verifySolveResponse(null, 4, costs).ok).toBe(false);
    expect(verifySolveResponse([1, 2], 4, costs).ok).toBe(false);
    expect(verifySolveResponse(42, 4, costs).ok).toBe(false);
  });

  it('n=1 边界：唯一格合法方案通过，缺标记旧版也通过', () => {
    expect(verifySolveResponse({ status: 'ok', n: 1, assignment: [0], totalCost: 7 }, 1, [[7]]).ok).toBe(true);
  });
});
