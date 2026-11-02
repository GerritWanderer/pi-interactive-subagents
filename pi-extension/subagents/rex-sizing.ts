/** Rex session.view / `session inspect` tiled layout, using only public fields.
 * See `rex api describe session.view` and `session.resize_pane`.
 */
export type SplitAxis = "horizontal" | "vertical";
export interface RexLayoutNode {
  rect?: number[];
  block_id?: string | null;
  split?: {
    split_id?: string | null;
    direction: SplitAxis;
    ratio: number;
    before: RexLayoutNode;
    after: RexLayoutNode;
  } | null;
}

export interface ResizeStep {
  direction: SplitAxis;
  before_block_id: string;
  after_block_id: string;
  ratio: number;
}

/** Equal columns/rows for the tree, not equal leaf areas. Perpendicular splits
 * share their axis span, so stacked panes don't count as extra columns.
 * Rex accepts any block from each side to identify the innermost matching border.
 * Malformed/stale layouts fail closed; insignificant ratio deltas are skipped.
 */
export function planEqualShares(layout: RexLayoutNode | null | undefined): ResizeStep[] {
  const steps: ResizeStep[] = [];
  function visit(node: RexLayoutNode): { columns: number; rows: number; first: string; last: string } {
    if (!node || typeof node !== "object") throw new Error("Missing layout node");
    if (!node.split) {
      if (typeof node.block_id !== "string" || !node.block_id) throw new Error("Missing block ID");
      return { columns: 1, rows: 1, first: node.block_id, last: node.block_id };
    }
    const { direction, ratio, before, after } = node.split;
    if (node.block_id || !["horizontal", "vertical"].includes(direction) ||
        !Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) throw new Error("Invalid split");
    const a = visit(before);
    const b = visit(after);
    const horizontal = direction === "horizontal";
    const aSpan = horizontal ? a.columns : a.rows;
    const bSpan = horizontal ? b.columns : b.rows;
    const target = aSpan / (aSpan + bSpan);
    if (Math.abs(target - ratio) >= 0.005) {
      steps.push({ direction, before_block_id: a.last, after_block_id: b.first, ratio: target });
    }
    return {
      columns: horizontal ? a.columns + b.columns : Math.max(a.columns, b.columns),
      rows: horizontal ? Math.max(a.rows, b.rows) : a.rows + b.rows,
      first: a.first,
      last: b.last,
    };
  }
  if (!layout) return [];
  try {
    visit(layout);
    return steps;
  } catch {
    return [];
  }
}
