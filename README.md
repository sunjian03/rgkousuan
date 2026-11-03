# 口算天天练

小学 1~3 年级儿童口算练习 H5 网页版 · 软件工程课程项目

小组成员：孙健 谢瑞男 王茹涵 许家诚

## 产品简介

- 覆盖小学 1~3 年级全部 6 个学期的口算知识点（加减乘除、表内乘法等 25 个知识点）
- 核心功能：一键出题、自动判分、错题本（连对 3 次自动巩固）、学习报告（趋势图与掌握度）、打印题纸（A4 PDF）、打卡日历与勋章、家长中心（多孩子档案、护眼时长限制、数据导出/导入）
- 纯前端实现：数据全部存于浏览器 localStorage，免安装、免注册、零后端，手机/平板/电脑浏览器打开即用

## 技术栈

- 页面层：Vue 3（`<script setup>`）+ vue-router（hash 模式）+ Vite + Tailwind CSS v4
- 图表：ECharts 6（按需引入）；打印：jsPDF 4（中文经 canvas 位图方案）
- 核心层（core/）：纯 JavaScript，不依赖 Vue 与浏览器 API，可直接在 Node 下运行单元测试（node --test，零依赖）

## 目录结构

```
rgkousuan/
├── src/
│   ├── core/              # 核心服务层（纯 JS，项目的核心资产）
│   │   ├── knowledge_points.json   # 知识点库配置（6 学期 25 个知识点）
│   │   ├── generator.js   # 出题引擎（R1~R6：随机生成、防重复、难度梯度、填空呈现）
│   │   ├── parser.js      # 递归下降表达式解析器（生成即复算校验，R5）
│   │   ├── judge.js       # 判题 Judger + 练习会话 PracticeSession
│   │   ├── wrongbook.js   # 错题本（状态机，连续答对 3 次巩固）
│   │   ├── stats.js       # 统计服务（日/周/月报告、知识点掌握度）
│   │   ├── achievement.js # 激励服务（打卡、连击、勋章）
│   │   ├── printer.js     # 打印服务（jsPDF A4 题纸排版）
│   │   └── repository.js  # 数据仓库（localStorage 门面，键前缀 ksl_，JSON 备份）
│   ├── pages/             # 页面层（9 个页面，对应 docs/ 原型与任务 D2~D10）
│   ├── store.js           # 页面层全局状态与适配（学期格式互转、可见知识点过滤等）
│   ├── router.js          # 路由（hash 模式）
│   └── style.css          # Tailwind 入口与全局样式
├── test/                  # 测试（node --test 收编 *.test.js 单元测试 + smoke-*.mjs 页面链路冒烟）
├── docs/                  # 高保真 HTML 原型（P1~P9 + 首页）
└── pages/                 # npm run build 产物（gh-pages 发布源，随提交入库）
```

## 快速开始

```bash
npm install        # 安装依赖（需 Node.js 18+）
npm run dev        # 开发模式，浏览器打开 http://localhost:5173
npm test           # 运行全部测试（90 项）
npm run build      # 构建产物输出到 pages/
npm run deploy     # 构建并发布到 GitHub Pages（gh-pages 分支）
```

## 架构约定

- 分层：页面层（pages + store + router）→ 核心服务层（core）→ 数据仓库（repository.js 封装 localStorage）
- 页面层只通过 core 的公开接口访问数据，**不直接操作 localStorage**；所有读写键统一加 `ksl_` 前缀
- core 为纯 JS 模块，依赖（存储、时钟）均注入（如 `new Repository(new MemoryStorage())`），因此可在 Node 下直接测试
- 页面层响应式约定：store.js 将 Repository 实例包为 reactive，computed 中 touch `repo.version` 以在数据写入后失效重算
- 数据结构以设计报告 3.2 为准：档案 `semester` 存短值「上/下」（3.2.1(1)）；出题接口 `semester` 参数用 6 学期全称「一上」等（3.2.1(5)），由 store.js 的 `semShort`/`termOf` 互转
- 产品决策偏差（如隐藏单位换算、面积周长知识点）统一在 store.js 的 `HIDDEN_KP_IDS` 一处维护并写注释说明

## 编码规范

1. **命名**：变量与函数 camelCase；类名 PascalCase（如 `Repository`、`StatsService`）；常量 UPPER_SNAKE_CASE（如 `HIDDEN_KP_IDS`）；文件名 kebab-case
2. **注释**：每个函数上方一行注释说明用途；core 关键模块注释详细，并标注对应设计报告章节（如 generator.js 对应 3.3.1/3.3.2、judge.js 对应 3.3.3/2.4 M2）——报告第 4 章「关键函数说明」与附录代码从注释提取
3. **Vue 页面**：统一 `<script setup>`；文件头注释块写明页面职责、对应原型文件（docs/*.html）与任务编号（D2~D10）
4. **文案**：界面中文文案统一使用全角标点

## 提交规范

- 提交信息格式：`feat: 功能描述` / `fix: 修复描述` / `docs: 文档` / `test: 测试` / `build: 构建与发布`；核心模块可用 `feat(core):` 注明范围

## 测试

- `npm test`（node --test）统一收编 `test/*.test.js`（单元测试）与 `test/smoke-*.mjs`（页面链路冒烟测试）
- 覆盖范围：出题规则 R1~R6、判分正确性（算式式/填空式）、错题状态机、知识点过滤、数据仓库响应式链路、防沉迷边界（FR-11）等，共 90 项
- 修改 core 后先跑 `npm test` 再提交

## 发布

- 发布流程：`npm run deploy`（vite build → `git subtree push --prefix pages github gh-pages`），GitHub Pages 选择 gh-pages 分支后自动更新
- Gitee（origin）与 GitHub（github）双远程同步推送 master
- 线上地址：https://sunjian03.github.io/rgkousuan/

## 参与贡献

1. Fork 本仓库
2. 新建 `feat/xxx` 分支
3. 提交代码（遵循上述编码与提交规范）
4. 新建 Pull Request（合并请求）
