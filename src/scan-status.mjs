// 價格清單可沿用上一輪，最近完整成功時間只在整輪無錯誤時更新。
export function scanStatus(previous, summary, { failed, errors, count }) {
  return {
    ...(failed ? previous : {}),
    ...summary,
    ...(!failed && { count }),
    error: errors.join('; '),
    lastSuccess: !failed && !errors.length ? summary.t : previous?.lastSuccess ?? null,
    needsHuman: errors.some(e => e.includes('人機驗證')),
  };
}
