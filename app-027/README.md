# 剪纸刻绘刀路生成 · Paper-cut Plotter Studio

把剪纸纹样变成刻字机/刻绘机能直接切的刀路：轮廓闭合检查 → 自动留「连刀点」让小纸片不掉 → 按先内后外的顺序切割 → 导出 PLT 直接上机。

纯前端应用，**断网可用**（纹样库与字体随包打本地）。

## 技术栈

- Vue 3 + TypeScript + Vite（`<script setup>` 单文件组件，一个 `.vue` 内写 template/script/style scoped）
- 手写 CSS（无 UI 组件库、无游戏引擎/物理库/图表库）
- 状态：Vue 自带 `ref/reactive/computed/watch` + `localStorage` 持久化（未使用 Pinia/Vuex）
- 路由：vue-router（6 个页面）
- 自写实现：SVG path/变换矩阵解析、贝塞尔与圆弧离散化、自交检测、包含关系树、最近邻 + 2-opt、刀补与自交裁剪、PLT/G-code/SVG 导出

## 快速开始

```bash
npm install
npm run dev          # http://127.0.0.1:5173
npm run build        # 类型检查 + 生产构建
npm run preview      # 预览构建产物
```

## Docker 构建

```bash
docker compose build            # 多阶段构建（node:20-alpine → nginx:1.27-alpine）
docker compose up -d --build    # 如本机 8107 空闲
curl http://localhost:8107/healthz
docker compose down
```

- 端口映射 `8107:80`，`restart: unless-stopped`，`HEALTHCHECK` 请求 `/healthz`
- 运行阶段只拷 `dist/` 与 `nginx.conf`（SPA 回退、哈希资源 immutable、index.html no-cache、gzip）
- 构建上下文 0.36MB；运行镜像 21.08MB（`docker image inspect` 的 rootfs，基础镜像 nginx:1.27-alpine 本身 20.98MB）

## 目录结构

```
.
├── index.html
├── package.json / tsconfig.json / vite.config.ts
├── Dockerfile / docker-compose.yml / nginx.conf / .dockerignore / .gitignore
├── public/
│   ├── patterns/            # 10 个本地纹样 SVG（窗花/囍字/生肖/花边）
│   └── fonts/               # 本地打包字体 plotter-mono.ttf（自制点阵技术字体）
└── src/
    ├── main.ts / App.vue / router.ts / env.d.ts
    ├── styles/global.css    # 手写全局样式（含打印样式、窄窗口堆叠）
    ├── data/                # 纹样库索引、材料预设、上机指南文案
    ├── logic/               # 几何内核与业务实现
    │   ├── types.ts         # 数据模型（Pt/Contour/Shape/MaterialPreset/CutSettings/ExportCfg）
    │   ├── geometry.ts      # 面积/周长/点在多边形/自交检测（网格加速）/弧长取点
    │   ├── svg.ts           # SVG path 解析、transform 矩阵、圆弧→贝塞尔离散化
    │   ├── importer.ts      # SVG 导入（path/line/polygon/circle/rect/ellipse + viewBox 缩放）
    │   ├── cleanup.ts       # 路径清理：离散化、闭合检查、重复路径合并、自交检测
    │   ├── bridges.ts       # 连刀点规则与缺口开挖（吸附到单条直线段）
    │   ├── nesting.ts       # 包含关系树（面积 + 点在多边形）
    │   ├── order.ts         # 后序遍历（先内后外）+ 最近邻 + 2-opt
    │   ├── offset.ts        # 刀补偏置 + 凹角自交裁剪
    │   ├── exporters.ts     # PLT / G-code / SVG / A4 1:1 检查图、共边裁切
    │   ├── job.ts           # 多形状多图层任务、批量排版、仿真轨迹
    │   ├── pipeline.ts      # 单形状全流程编排 + 几何签名缓存
    │   ├── selftest.ts      # 验收自检（第 10 节全部用例）
    │   └── store.ts         # 项目/材料状态与持久化
    ├── components/PreviewCanvas.vue   # 预览画布（三种模式、放大镜、仿真、绘图交互）
    └── views/               # Home / Design / Layout / Export / Materials / Help
```

## 验收结果

`/help` 页面内置「运行验收自检」，一键跑完规格书第 10 节全部用例。生产构建实测 **19/19 通过**（自检总耗时 182ms），控制台无任何 error/warning。

| 第 10 节验收项 | 实测结果 |
| --- | --- |
| 导入 10 个真实窗花 SVG（含嵌套 3 层 / 自交 / 未闭合各一），问题清单与人工检查一致 | 10 个文件全部导入：27/23/6/4/24/23/28/12/10/23 条轮廓；盘长未闭合纹 2 条未闭合、缠枝自交花 2 条自交、雪花散点 2 条重复（已合并）；干净文件（经典八角窗花）0 误报；编辑页问题清单可点选定位，一键闭合后未闭合 2 → 0 |
| 连刀点缺口宽度与设定一致（±0.05mm） | 1312 个连刀点，最大偏差 **0.0000mm**（缺口吸附在单条直线段内，不跨折角） |
| 轮廓几何偏差 ≤ 0.1mm | 最大偏差 **0.00000mm**；被挖掉的最大周长 30.500mm，面积 0.0000mm²（均已重算记录） |
| 小碎片 100% 生成连刀点 | 面积 < 4mm² 的碎片 21 个，**21/21 已连刀**（每片 2 个，均匀分布） |
| 大轮廓按长度规则数量正确 | 每 12mm 一个：校验 139 条大轮廓，数量全部吻合 |
| 包含关系树嵌套 3 层正确 | 同心三层窗花 maxDepth = **5**（外圆 1 → 内圆 2 → 花瓣 3 …） |
| 切割顺序为先内后外 | 校验 132 组父子关系，内层全部排在外层之前 |
| 跳刀优化 ≥ 15% | 雪花散点：朴素顺序 1544.7mm → 最近邻+2-opt **516.3mm（−66.6%）** |
| 导出 PLT 坐标在纸幅内、原点在左下 | X 400~6400、Y 5480~11480（0.025mm/单位，纸幅上限 8400×11880）；内部最大 y=160.00mm → 导出最小 y=5480（左下原点）；PLT 预览 `IN;SP1; PU…PD…` |
| G-code 单位与进给正确 | `G21`（mm）+ `G90`，进给 `F2400`（40mm/s × 60），pass 段 1/1 |
| A4 检查图 1:1，校验尺误差 ≤ 1mm | 100mm 校验尺几何长度 **100.000mm**（误差 0.000mm），SVG 物理尺寸 210mm×297mm；打印时选「实际大小/100%」 |
| 5000 点轮廓全流程 < 300ms | 5000 点主轮廓 + 40 个碎片：清理 + 连刀 + 排序 **21.8~25.4ms** |
| 刀补（刀偏置）自交裁剪 | 五角星凹角偏置后无自交；超出轮廓尺度时明确警告并保留原路径（不输出坏路径） |

界面自测也逐条走完：三种预览模式（成品轮廓 / 刀路·顺序 / 连刀点放大 ×8）、矩形/圆形/多边形绘制、手工放连刀点、对称生成、批量排版（含共边裁切）、刀路仿真动画、材料参数卡打印、PLT/G-code/SVG 下载、A4 1:1 打印检查图。

## 说明

- 内部单位统一为毫米（3 位小数）；导出 PLT 时按 `1 unit = 0.025mm` 换算并把原点翻到左下（`y′ = 纸幅高 − y`）。
- 纹样库里 `雪花散点碎片` 内含同一图形画两遍（其中一条点序反向）用于演示重复路径合并；`缠枝自交花`、`盘长未闭合纹` 分别用于演示自交与未闭合提示。
- 未实现（刻意不做）：AI 图像转矢量、艺术字、素材商城、云账号与分享、机器通信与远程控制。只做路径清理 + 连刀点 + 切割顺序 + 导出刀路。