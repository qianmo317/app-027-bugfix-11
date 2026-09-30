import { PAPER_KINDS, type MaterialPreset } from '@/logic/types'

/** 默认材料预设（可编辑、可新增，保存在本地） */
export function defaultMaterials(): MaterialPreset[] {
  const byPaper = (key: string) => PAPER_KINDS.find((p) => p.paper === key)!
  const build = (id: string, name: string, paper: string, bladeOffsetMm: number): MaterialPreset => {
    const k = byPaper(paper)
    return { id, name, paper, force: k.force, speedMmS: k.speedMmS, passes: k.passes, bladeOffsetMm, backing: k.backing }
  }
  return [
    build('mat-cardstock', '卡纸标准（白卡 250g）', 'cardstock', 0.25),
    build('mat-xuan', '宣纸精细（轻压多遍）', 'xuan', 0.2),
    build('mat-sticker', '不干胶（不伤底纸）', 'sticker', 0.25),
    build('mat-flock', '植绒（高刀压慢速）', 'flock', 0.3),
    build('mat-kraft', '牛皮纸打样', 'kraft', 0.25),
    build('mat-red', '红纸剪纸（非遗）', 'red-paper', 0.25),
  ]
}

export function paperLabel(paper: string): string {
  return PAPER_KINDS.find((p) => p.paper === paper)?.label ?? paper
}