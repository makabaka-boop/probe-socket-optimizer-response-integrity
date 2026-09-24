// 求解响应协议验收：只有「属于当前矩阵 + 结构完整 + 能对原矩阵精确复算」的
// 200/ok 响应才允许成为可操作方案。
//
// 老化台可能经代理/缓存/滚动升级中的旧服务拿到看似成功（HTTP 200、status=ok）
// 但实际属于另一个矩阵、缺行短列、重复/越界列、落在禁配格、总价对不上、
// 分析标记残缺错位的响应。任何一项不满足都拒绝采用：不展示、不可排除、
// 不留旧高亮。
//
// 旧版兼容：完全缺少 pairFlags 字段（字段不存在/undefined）时仍可展示分配，
// 只是不渲染任何分析标记；字段一旦存在，就必须与同一次 assignment 逐行、
// 逐字段完整对应，否则整份响应（连同方案一起）拒绝。

const MAX_COST = 1_000_000_000_000;

function fail(reason) {
  return { ok: false, reason };
}

/**
 * @param {unknown} data  已解析的响应 JSON（解析失败由调用方按 BAD_RESPONSE 处理）
 * @param {number} n      本次请求矩阵的规模；响应必须属于这一份矩阵
 * @param {Array<Array<number|null>>} costs 本次请求的矩阵，用于精确复算
 * @returns {{ ok: true, assignment: number[], totalCost: number, pairFlags: Array<{forced:boolean,alternatives:number}>|null }
 *        | { ok: false, reason: string }}
 */
export function verifySolveResponse(data, n, costs) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return fail('响应体不是 JSON 对象');
  }

  // —— 身份：n 必须与当前矩阵一致（防止缓存/旧服务返回别的规模的方案）——
  if (!Number.isInteger(n) || !Array.isArray(costs) || costs.length !== n) {
    return fail('本地矩阵状态异常，无法验收响应');
  }
  if (data.n !== n) {
    return fail(`响应 n=${String(data.n)} 与当前矩阵 n=${n} 不符（响应属于另一份矩阵）`);
  }

  // —— assignment：必须是长度 n 的 0..n-1 排列 ——
  const { assignment } = data;
  if (!Array.isArray(assignment)) {
    return fail('响应缺少 assignment 数组');
  }
  if (assignment.length !== n) {
    return fail(`assignment 长度 ${assignment.length} 与 n=${n} 不一致（缺行/多行）`);
  }
  const usedCols = new Set();
  for (let i = 0; i < n; i++) {
    const j = assignment[i];
    if (typeof j !== 'number' || !Number.isInteger(j)) {
      return fail(`assignment[${i}] 不是整数列下标`);
    }
    if (j < 0 || j >= n) {
      return fail(`assignment[${i}]=${j} 越界（合法列 0..${n - 1}）`);
    }
    if (usedCols.has(j)) {
      return fail(`assignment 中列 ${j} 重复出现（不是完美匹配，列不唯一）`);
    }
    usedCols.add(j);
    // 展示配对不能落在禁配格
    const row = costs[i];
    if (!Array.isArray(row) || j >= row.length || row[j] === null || row[j] === undefined) {
      return fail(`assignment[${i}]=${j} 落在禁配格（该探针-测试座组合不允许）`);
    }
    if (typeof row[j] !== 'number' || !Number.isInteger(row[j]) || row[j] < 0 || row[j] > MAX_COST) {
      return fail(`assignment[${i}]=${j} 对应的本地代价不合法，无法精确复算`);
    }
  }

  // —— totalCost：安全整数且能由配对对当前矩阵精确复算 ——
  const { totalCost } = data;
  if (typeof totalCost !== 'number' || !Number.isInteger(totalCost)) {
    return fail('totalCost 不是整数');
  }
  if (!Number.isSafeInteger(totalCost) || totalCost < 0) {
    return fail('totalCost 超出精确整数范围或为负');
  }
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += costs[i][assignment[i]];
  }
  if (!Number.isSafeInteger(sum) || sum !== totalCost) {
    return fail(`totalCost=${totalCost} 与配对对当前矩阵的精确复算值 ${sum} 不一致`);
  }

  // —— pairFlags：字段不存在=旧版合法响应（只展示分配，不显示分析标记）；
  //    字段一旦存在，必须与同一次 assignment 完整对应 ——
  let pairFlags = null;
  if (data.pairFlags !== undefined) {
    const rawFlags = data.pairFlags;
    if (!Array.isArray(rawFlags)) {
      return fail('pairFlags 字段存在但不是数组（标记必须与 assignment 逐行对应）');
    }
    if (rawFlags.length !== n) {
      return fail(
        `pairFlags 长度 ${rawFlags.length} 与 assignment 长度 ${n} 不一致（标记残缺或错位）`
      );
    }
    pairFlags = new Array(n);
    for (let i = 0; i < n; i++) {
      const f = rawFlags[i];
      if (f === null || typeof f !== 'object' || Array.isArray(f)) {
        return fail(`pairFlags[${i}] 不是标记对象（标记残缺或错位）`);
      }
      if (typeof f.forced !== 'boolean') {
        return fail(`pairFlags[${i}].forced 不是稳定布尔值`);
      }
      if (typeof f.alternatives !== 'number' || !Number.isInteger(f.alternatives) || f.alternatives < 0) {
        return fail(`pairFlags[${i}].alternatives 不是非负整数`);
      }
      // 协议不变量：forced ⇔ alternatives === 0
      if (f.forced !== (f.alternatives === 0)) {
        return fail(
          `pairFlags[${i}] 的 forced(${f.forced}) 与 alternatives(${f.alternatives}) 自相矛盾`
        );
      }
      // forced=false 时至少有一条可替换连线，且不可能超过 n-1
      if (f.alternatives > n - 1) {
        return fail(`pairFlags[${i}].alternatives=${f.alternatives} 超出 n-1=${n - 1}`);
      }
      pairFlags[i] = { forced: f.forced, alternatives: f.alternatives };
    }
  }

  return { ok: true, assignment: assignment.slice(), totalCost, pairFlags };
}
