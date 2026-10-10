export type MaterialBatchPlan = {
  /** 接受的文件数量（受剩余容量限制）。 */
  accepted: number;
  /** 因容量不足被舍弃的文件数量。 */
  overflow: number;
  /** 剩余容量为 0，一个都加不进去。 */
  full: boolean;
};

/**
 * 计算一次素材批次中有多少文件可以被接受：受「当前已存在的同类型素材数量」
 * 和「模型上限」共同约束，超过上限的部分被舍弃并在 UI 上提示。
 */
export function planMaterialBatch(current: number, max: number, fileCount: number): MaterialBatchPlan {
  const available = Math.max(0, max - current);
  const accepted = Math.min(available, fileCount);
  return {
    accepted,
    overflow: fileCount - accepted,
    full: accepted === 0,
  };
}
