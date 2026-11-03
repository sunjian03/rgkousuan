/**
 * avatars.js —— 档案头像表情池（页面层共享，D2/D3/D8 使用）
 * 原型首页使用 emoji 动物头像，按档案在列表中的位置循环分配。
 */
export const AVATARS = ['🐣', '🐰', '🦊', '🐻', '🐼', '🐨'];

/** avatarOf(profiles, id)：按档案在列表中的索引循环取头像 */
export function avatarOf(profiles, id) {
  const i = profiles.findIndex((p) => p._id === id);
  return AVATARS[Math.max(0, i) % AVATARS.length];
}
