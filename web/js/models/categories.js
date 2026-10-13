/**
 * categories.js —— 活动分类定义
 *
 * 用户诉求（v1.2 精简）：
 *   只保留三个分类 —— 学术 / 就业 / 其他，越简洁越好。
 *   - 学术：学术会议、学术报告、讲座、论坛…… 统一归为「学术」
 *   - 就业：宣讲、招聘、双选会、实习…… 统一归为「就业」
 *   - 其他：剩下的全部
 *
 * 学术类（academic: true）在卡片上多显示一行「报告人」。
 * 注意：学术类的「活动名称」本身就是会议名 / 报告题目，不再单独维护会议名，
 * 避免同一个信息让用户填两遍（v1.1 的 meetingName 字段已废弃）。
 */

/** 分类 id 常量 */
export const CATEGORY = {
  ACADEMIC: 'academic',   // 学术（含会议 / 报告 / 讲座 / 论坛）
  JOB: 'job',             // 就业（含宣讲 / 招聘 / 实习）
  OTHER: 'other',         // 其他
};

/**
 * 分类元数据
 * academic: 是否学术类（决定是否多显示报告人）
 * color:    主色（左边框、时间文字、标签）
 * soft:     浅色背景（标签底色）
 * border:   标签边框色
 */
export const CATEGORIES = {
  [CATEGORY.ACADEMIC]: {
    id: CATEGORY.ACADEMIC,
    label: '学术',
    short: '学术',
    academic: true,
    color: '#1d4ed8',
    soft: '#eff5ff',
    border: '#c7dbfe',
    icon: '📖',
  },
  [CATEGORY.JOB]: {
    id: CATEGORY.JOB,
    label: '就业',
    short: '就业',
    academic: false,
    color: '#c2410c',
    soft: '#fff3e9',
    border: '#fcd9b6',
    icon: '💼',
  },
  [CATEGORY.OTHER]: {
    id: CATEGORY.OTHER,
    label: '其他',
    short: '其他',
    academic: false,
    color: '#64748b',
    soft: '#f4f6f9',
    border: '#dde3ec',
    icon: '📌',
  },
};

/** 供下拉选择用的有序列表（学术 → 就业 → 其他） */
export const CATEGORY_LIST = [CATEGORY.ACADEMIC, CATEGORY.JOB, CATEGORY.OTHER]
  .map((id) => CATEGORIES[id]);

/** 默认分类 */
export const DEFAULT_CATEGORY = CATEGORY.OTHER;

/**
 * v1.1 旧分类 id → v1.2 新分类 id 的映射。
 * 让历史数据（IndexedDB 里已存的 7 类）在升级后依然落在合理的分类上，
 * 用户无感知，不需要重新分类。
 */
export const LEGACY_CATEGORY_MAP = {
  academic_meeting: CATEGORY.ACADEMIC,
  academic_report: CATEGORY.ACADEMIC,
  lecture: CATEGORY.ACADEMIC,       // 讲座 / 论坛 归入学术
  recruit: CATEGORY.JOB,
  teaching_meeting: CATEGORY.OTHER, // 教学 / 工作会议
  campus: CATEGORY.OTHER,           // 校园活动
  other: CATEGORY.OTHER,
};

/**
 * 归一化分类 id：兼容 v1.1 的旧 id 与脏数据。
 * @param {string} id 任意分类 id
 * @returns {string} v1.2 的合法分类 id
 */
export function normalizeCategory(id) {
  if (!id) return DEFAULT_CATEGORY;
  if (CATEGORIES[id]) return id;                       // 已是新 id
  if (LEGACY_CATEGORY_MAP[id]) return LEGACY_CATEGORY_MAP[id]; // 旧 id 迁移
  return DEFAULT_CATEGORY;                             // 未知 → 其他
}

/** 取分类元数据（容错：旧 id 自动迁移，未知 id 回退到 other） */
export function getCategory(id) {
  return CATEGORIES[normalizeCategory(id)];
}

/** 是否学术类 */
export function isAcademic(id) {
  return !!getCategory(id).academic;
}

/** 分类的展示名 */
export function categoryLabel(id) {
  return getCategory(id).label;
}

/**
 * 生成 CSS 自定义属性，用于给卡片/标签上色
 * @returns {object} 形如 { '--cat': '#1d4ed8', '--cat-soft': '#eff5ff', '--cat-border': '#c7dbfe' }
 */
export function categoryVars(id) {
  const c = getCategory(id);
  return {
    '--cat': c.color,
    '--cat-soft': c.soft,
    '--cat-border': c.border,
  };
}
