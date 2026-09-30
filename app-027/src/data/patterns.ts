export type PatternEntry = {
  slug: string
  name: string
  category: '窗花' | '囍字' | '生肖' | '花边'
  file: string
  desc: string
  /** 用例特征（用于验收对照） */
  traits: string[]
}

/** 内置纹样库（本地打包在 public/patterns/，离线可用） */
export const PATTERN_LIBRARY: PatternEntry[] = [
  {
    slug: 'window-flower-classic',
    name: '经典八角窗花',
    category: '窗花',
    file: 'window-flower-classic.svg',
    desc: '双环外框 + 8 片主花瓣 + 中心八瓣花核',
    traits: ['嵌套 3 层', '曲线（贝塞尔）'],
  },
  {
    slug: 'concentric-three',
    name: '同心三层窗花',
    category: '窗花',
    file: 'concentric-three.svg',
    desc: '五重同心圆 + 12 片花瓣，用于验证包含关系树',
    traits: ['嵌套 3 层以上', '同心结构'],
  },
  {
    slug: 'self-cross-flower',
    name: '缠枝自交花',
    category: '窗花',
    file: 'self-cross-flower.svg',
    desc: '含八角星与蝴蝶结自交路径',
    traits: ['自交路径'],
  },
  {
    slug: 'open-spiral',
    name: '盘长未闭合纹',
    category: '窗花',
    file: 'open-spiral.svg',
    desc: '方形盘长螺旋与云头曲线均为未闭合折线',
    traits: ['未闭合路径'],
  },
  {
    slug: 'petal-scatter',
    name: '雪花散点碎片',
    category: '窗花',
    file: 'petal-scatter.svg',
    desc: '20 个小碎片（面积小于阈值）+ 对称成对绘制的散点',
    traits: ['小碎片', '跳刀测试'],
  },
  {
    slug: 'xi-double-happiness',
    name: '囍字团花',
    category: '囍字',
    file: 'xi-double-happiness.svg',
    desc: '双喜字由方框笔画组成，外圈团花包裹',
    traits: ['直边方框', '矩形轮廓'],
  },
  {
    slug: 'zodiac-rabbit',
    name: '生肖·兔',
    category: '生肖',
    file: 'zodiac-rabbit.svg',
    desc: '长耳兔头与身体，耳朵使用旋转变换矩阵',
    traits: ['变换矩阵（rotate）'],
  },
  {
    slug: 'zodiac-dragon',
    name: '生肖·龙',
    category: '生肖',
    file: 'zodiac-dragon.svg',
    desc: '螺旋龙身使用 SVG 圆弧（A 指令）绘制',
    traits: ['圆弧（A 指令）'],
  },
  {
    slug: 'lace-border',
    name: '回纹花边',
    category: '花边',
    file: 'lace-border.svg',
    desc: '240×80mm 长花边，回纹折线单元重复',
    traits: ['折线（polyline）', '长条形'],
  },
  {
    slug: 'butterfly-marriage',
    name: '双蝶婚庆',
    category: '花边',
    file: 'butterfly-marriage.svg',
    desc: '婚庆双蝶，翅膀由三次贝塞尔曲线构成',
    traits: ['贝塞尔曲线', 'scale 变换'],
  },
]

export function patternByFile(file: string): PatternEntry | undefined {
  return PATTERN_LIBRARY.find((p) => p.file === file)
}

/** 本地读取纹样 SVG 文本（同源静态资源，无外网请求） */
export async function fetchPatternText(file: string): Promise<string> {
  const res = await fetch(`${import.meta.env.BASE_URL}patterns/${file}`)
  if (!res.ok) throw new Error(`纹样读取失败：${file}（HTTP ${res.status}）`)
  return res.text()
}

export const PATTERN_CATEGORIES = ['全部', '窗花', '囍字', '生肖', '花边'] as const