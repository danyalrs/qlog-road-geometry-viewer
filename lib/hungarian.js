/**
 * Hungarian algorithm (Munkres) for minimum-cost one-to-one assignment.
 * costMatrix[row][col] — rows = current observations, cols = previous tracks/features.
 * Returns Map rowIdx -> { colIdx, cost }.
 */

function hungarianAssign(costMatrix, threshold = Infinity) {
  if (!costMatrix?.length) return { assignments: new Map(), totalCost: 0 };

  const nRows = costMatrix.length;
  const nCols = costMatrix[0]?.length ?? 0;
  if (!nCols) return { assignments: new Map(), totalCost: 0 };

  const n = Math.max(nRows, nCols);
  const cost = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => {
      const c = i < nRows && j < nCols ? costMatrix[i][j] : 0;
      return c >= threshold || !Number.isFinite(c) ? 1e9 : c;
    })
  );

  const u = new Float64Array(n + 1);
  const v = new Float64Array(n + 1);
  const p = new Int32Array(n + 1);
  const way = new Int32Array(n + 1);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(n + 1).fill(Infinity);
    const used = new Uint8Array(n + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  const assignments = new Map();
  let totalCost = 0;
  for (let j = 1; j <= n; j++) {
    const i = p[j];
    const row = i - 1;
    const col = j - 1;
    if (row < nRows && col < nCols) {
      const c = costMatrix[row][col];
      if (c < threshold && Number.isFinite(c)) {
        assignments.set(row, { colIdx: col, cost: c });
        totalCost += c;
      }
    }
  }
  return { assignments, totalCost };
}

module.exports = { hungarianAssign };
