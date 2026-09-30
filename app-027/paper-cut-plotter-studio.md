# 剪纸刻绘刀路生成 · Paper-cut Plotter Studio

> 类型：前端 Web 应用（纯前端）｜难度：★★★★｜技术栈：**Vue 3 + TypeScript + Vite**（`<script setup>` 单文件组件；自写 SVG 路径解析与排样；禁用 UI 组件库、游戏引擎与图表库，见 README §5.1）

## 1. 一句话简介

把剪纸纹样变成刻字机/刻绘机能直接切的刀路：轮廓闭合检查、自动留「连刀点」让小纸片不掉、按先内后外的顺序切割，导出 PLT 直接上机。

## 2. 真实场景与痛点

- 非遗剪纸、纸艺店、婚庆布置都开始用刻绘机切纹样，但设计软件只给图形，不给能上机的刀路。
- **小纸片会掉**：镂空纹样里的小岛（如花瓣心、窗花芯）切完就散落，必须留极窄的连刀点（bridge），这个窄口要靠经验手工开，开大了难看、开小了掉落。
- 路径不闭合会切不穿，重叠路径会同一个地方切两遍（刀尖磨损、纸张起毛）。
- 切割顺序不对：先切外轮廓会让内层失去支撑，切出来就歪了。
- 刻字机认 HPGL（PLT），单位是 0.025mm，原点在左下角——手写导出经常搞错坐标方向，上机就切到纸外面。

## 3. 目标用户

- 非遗剪纸传承人与工作室、纸艺/婚庆布置店。
- 手作爱好者（有桌面刻绘机的）。
- 包装打样（纸盒小批量试制）。

## 4. 核心功能（MVP）

1. **纹样输入**：导入 SVG（解析 `path`/`line`/`polygon`/`circle`，支持变换矩阵）、内置纹样库（窗花、囍字、生肖、花边）、矩形/圆形/多边形绘制工具。
2. **路径清理**（核心）：
   - 贝塞尔曲线按容差离散化为折线；
   - **闭合检查**（首尾点距离 > 容差的标为「未闭合」并提示，可一键闭合）；
   - **重复路径合并**（完全重叠或反向重叠的去除）；
   - 自交检测与提示（自交处切不干净）。
3. **连刀点生成**（核心）：为每个闭合轮廓按规则插入 N 个极窄缺口（默认 0.3\~0.8mm），规则可选：
   - 按片段面积：面积 < 阈值的碎片**必须**连刀；
   - 按轮廓长度：每 L mm 一个连刀点；
   - 手工放置：在预览图上点选位置。
4. **切割顺序与跳刀**：构建轮廓包含关系树 → **后序遍历（先内后外）**；同层轮廓用最近邻 + 2-opt 缩短跳刀距离；显示跳刀路径与总跳刀长度。
5. **材料参数卡**：纸张类型（卡纸/宣纸/不干胶/植绒）、刀压、速度、重复次数、垫板；保存为材料预设，导出工艺卡（可打印）。
6. **导出**：PLT（HPGL）、G-code（自组装的桌面机）、SVG（带连刀点的可切版本）；A4 排版图（1:1 检查用，含 100mm 校验尺）。

## 5. 进阶功能

- 图层与多色纸分层切割（一次排好多种纸的切割顺序）。
- 批量排版（同一纹样在一张纸上排满，含间距与共边裁切）。
- 刀路仿真（按顺序动画演示刀尖轨迹，检查是否会切到已切好的部分）。
- 纹样对称生成（镜像/旋转/四方连续）。

## 6. 页面结构

```
/                 纹样库与新建
/design/:id       编辑（左工具栏 | 中预览（含刀路/跳刀/连刀点三种显示）| 右属性与规则）
/layout/:id       排版与切割顺序（顺序列表、跳刀长度、材料参数卡）
/export/:id       导出（格式、单位、原点、A4 检查图）
/materials        材料预设库
/help             上机指南（格式与常见问题）
```

## 7. 数据模型

```ts
type Pt = { x: number; y: number };                       // 内部单位：mm
type Contour = { id: string; points: Pt[]; closed: boolean;
                 area: number; length: number;            // 派分值，用于连刀与排序
                 holes: string[];                         // 直接子轮廓（内层）
                 bridges: { atIndex: number; widthMm: number }[];
                 warnings: ('not_closed'|'self_intersect'|'duplicate')[] };
type Shape = { id: string; name: string; contours: Contour[]; layer: number };
type MaterialPreset = { id: string; name: string; paper: string; force: number; speedMmS: number;
                        passes: number; bladeOffsetMm: number };
type CutSettings = { order: 'inner_first'; bridgeRule: 'by_area'|'by_length'|'manual';
                     areaThresholdMm2: number; bridgeWidthMm: number; bridgeEveryMm: number;
                     travelOptimize: 'nearest'|'nearest_2opt' };
type ExportCfg = { format: 'plt'|'gcode'|'svg'; unit: 'mm'|'0.025mm'; origin: 'bottom_left'|'top_left';
                   yFlip: boolean; scale: number };
```

## 8. 关键实现点

- **单位统一 mm**（内部一律 mm，浮点保留 3 位）；导出 PLT 时转 HPGL 单位 `1 unit = 0.025mm`，**并把原点从左上翻到左下**（`y' = maxY − y`）——这一步做错就会整张切到纸外：必须有导出用例断言坐标范围。
- **连刀点算法**（不能只是「随机挖一段」）：
  ```
  对每个闭合轮廓：
    1) 计算面积 A 与周长 L
    2) 若 A < areaThreshold → 必须连刀（碎片风险），至少 2 个，分布尽可能均匀
    3) 否则按 L / bridgeEveryMm 取整得数量 n（n ≥ 0）
    4) 在轮廓上按等弧长取 n 个锚点，每个锚点处沿轮廓挖掉宽度 bridgeWidthMm 的段，
       缺口两端各保留平滑过渡（避免刀路折角）
  ```
  挖缺口会**改变几何**：必须重新计算面积/周长并记录偏差，**轮廓几何偏差 ≤ 0.1mm**（用例断言）。
- **包含关系树**：用「点在多边形内 + 面积排序」判定父子（外层面积大者为父）；嵌套 3 层以上必须正确（用例：同心三层窗花）。
- **切割顺序**：后序遍历 = 先切最内层、最后切最外层（保证内层有支撑、外层不被拖动）；同层跳刀用最近邻 + 2-opt，**必须比朴素顺序减少 ≥ 15% 的跳刀长度**（有断言，否则优化没意义）。
- **刀补（blade offset）**：刻刀有刀刃偏置，闭合轮廓需要按 `bladeOffset` 做内/外偏置；偏置会产生自交（凹角处），必须做自交裁剪，处理不了的要**明确警告**而不是输出坏路径。
- **性能**：5000 点的轮廓清理 + 连刀 + 排序 < 300ms（不要每次渲染都重算，按形状缓存，参数变化才失效）。
- **离线**：纹样库与字体本地打包，无网络可用。

## 9. 交互与视觉要点

- 预览三种模式：成品轮廓 / 刀路（含顺序编号）/ 连刀点放大视图（缺口处自动放大 8 倍标出）。
- 未闭合、自交、重复路径用不同颜色标出并列出问题清单，可点选定位。
- 切割顺序用数字气泡标注，跳刀用虚线，一眼看出是否来回乱跳。
- 材料参数卡可打印贴在机器旁（含刀压/速度/重复次数）。

## 10. 验收标准

- 导入 10 个真实窗花 SVG（含嵌套 3 层、自交、未闭合各一），问题清单与人工检查一致。
- 连刀点：缺口宽度与设定一致（±0.05mm），轮廓几何偏差 ≤ 0.1mm（断言）。
- 小碎片（面积 < 阈值）100% 生成连刀点（断言）；大轮廓按长度规则数量正确。
- 包含关系树嵌套 3 层正确（断言）；切割顺序为先内后外。
- 跳刀优化：同一纹样下 2-opt 后总跳刀长度比朴素顺序短 ≥ 15%（断言）。
- 导出 PLT：坐标全部落在纸幅范围内、原点在左下（断言坐标符号）；G-code 单位与进给正确。
- A4 检查图 1:1 打印校验尺误差 ≤ 1mm。
- 5000 点轮廓全流程 < 300ms。

## 11. 边界（刻意不做）

不做 AI 图像转矢量（描摹）与艺术字生成、不做在线素材商城与订单、不做云端账号与作品分享、不做机器通信与远程控制（只导出文件）——核心只做**路径清理 + 连刀点 + 切割顺序 + 导出刀路**，避开黑名单中的电商订单、社交分享方向。

## 12. 容器化与构建（Docker）

- **Dockerfile（多阶段）**：`node:20-alpine` 构建 → `nginx:1.27-alpine` 只拷 `dist/` 与 `nginx.conf`
- **docker-compose.yml**：服务名 `app-027`，端口 **`8107:80`**，`restart: unless-stopped`；`HEALTHCHECK` 请求 `/healthz`
- **nginx.conf**：SPA 回退；哈希资源 `immutable`；`index.html` no-cache；gzip（纹样 SVG 较大）
- 无后端依赖，**断网可用**（工作室常常没有稳定网络）
- 纹样库与字体放 `public/` 随镜像打包（**不要 ignore**）

```bash
cd frontend/app-027
docker compose up -d --build
curl http://localhost:8107/healthz
docker compose down
```

- **验收**：`http://localhost:8107` 完成「导入窗花 → 清理路径 → 生成连刀点 → 排序 → 导出 PLT」；镜像 < 60MB。

### 忽略文件（.dockerignore / .gitignore）

- **`.dockerignore`**：`node_modules`、`dist`、`.git`、`.gitignore`、`.env`、`.env.*`、`*.log`、`coverage`、`.vscode`、`.idea`、`Dockerfile`、`nginx.conf`、`README.md`
  - `node_modules` 必须排除；**保留** `package-lock.json`、`public/patterns/`（纹样库）、`public/fonts/`
  - 仅忽略本地设计草稿（`design-src/`、`*.ai`、`*.cdr`）与上机测试文件（`tmp-plot/`）
- **`.gitignore`**：`node_modules/`、`dist/`、`.env*`、`*.log`、`coverage/`、`.DS_Store`、`.vscode/`、`.idea/`，另排客户纹样与刀路输出（`clients/`、`exports/`、`*.plt`、`*.nc`）
- **自检**：构建上下文 < 5MB；`git status` 不出现 `.env` 与客户纹样/刀路文件

