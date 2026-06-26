# 家庭英语单词听写系统 —— 视觉风格规范（style.md）

> 本文件给阶段4「视觉美化」使用。目标是参考用户提供的 "ABC After School Program"
> 风格截图，做出色块分区明确、字体圆润活泼、但整体克制不花哨的视觉效果。
> 这是一个学习工具网站，不是儿童娱乐网站，所以"活泼"要适度，核心还是数据清晰可读。

---

## 1. 参考风格的核心特征（来自截图分析）

截图（ABC After School Program 网站首页）呈现的视觉规律：

- **大色块分区**：每个功能区域用一整块实色背景承载（橙色播报条、黄色卡片、青绿色导航），
  不是靠边框线分隔，是靠颜色色块本身分隔
- **圆润字体**：标题用圆头无衬线字体，数字和大标题有种手写感但不潦草
- **强对比但克制的配色**：主要用 2-3 种饱和度较高的颜色（橙色系、青绿色系、黄色系）
  加大量白色留白，不是五颜六色堆砌
- **重要信息用色块包裹突出**：比如首页大图上的文字说明，直接用一块纯色矩形托底，
  保证文字在任何背景图片上都清晰可读
- **导航条用色块而不是普通菜单样式**：当前选中项用青绿色，其余用橙色，对比鲜明

---

## 2. 应用到听写网站的色板定义

听写网站是工具型网站，每天高频使用，配色要"提神但不刺眼"，建议：

```css
:root {
  /* 主色：青绿色系，用于导航、强调按钮、积极反馈（答对/已学） */
  --color-primary: #3AAFA9;
  --color-primary-dark: #2B7A78;
  --color-primary-light: #DEF2F1;

  /* 强调色：橙色系，用于"今日任务"横幅、行动按钮、需要立刻关注的内容 */
  --color-accent: #F2994A;
  --color-accent-dark: #D9782A;
  --color-accent-light: #FDEBD8;

  /* 警示色：用于错词/危险操作，区别于强调色，避免和"今日任务"混淆 */
  --color-danger: #E0644B;
  --color-danger-light: #FBE5DF;

  /* 成功色：答对、已归档、已认识 */
  --color-success: #4CAF8E;
  --color-success-light: #E3F4ED;

  /* 中性色：背景、文字、边框 */
  --color-bg: #FAFAF8;
  --color-card-bg: #FFFFFF;
  --color-text-primary: #2D3142;
  --color-text-secondary: #6B7280;
  --color-border: #E5E7EB;

  /* 重点/顽固标签专用色（柔和黄，区别于警示红） */
  --color-highlight: #F2C14E;
  --color-highlight-light: #FDF3D9;
}
```

---

## 3. 字体规范

```css
:root {
  --font-family-base: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
                       -apple-system, BlinkMacSystemFont, sans-serif;
  --font-family-display: "PingFang SC", "Microsoft YaHei", sans-serif;
  /* 中文没有完美对应截图里那种圆体英文字体的字号，用加粗+稍大字号模拟"活泼感" */
}
```

- 大数字（今日任务数、当前Day等关键数据）：`font-weight: 700`，字号比普通正文大 2-3 倍
- 标题：`font-weight: 600`
- 正文/标签：`font-weight: 400-500`
- 不引入额外的 Google Fonts 等外部字体依赖，保证国内访问速度，用系统字体加粗模拟风格即可

---

## 4. 圆角与阴影规范

```css
:root {
  --radius-card: 16px;       /* 卡片、色块区域 */
  --radius-button: 10px;     /* 按钮 */
  --radius-badge: 999px;     /* 标签徽章，全圆角 */
  --radius-input: 8px;       /* 输入框 */

  --shadow-card: 0 2px 8px rgba(0, 0, 0, 0.06);
  --shadow-card-hover: 0 4px 16px rgba(0, 0, 0, 0.1);
}
```

- 所有卡片用 `--radius-card`，呼应参考图里圆润但不过度卡通化的边角
- 按钮用 `--radius-button`，不用全圆角药丸形（避免太可爱，工具网站要克制）
- 状态标签（历史错词/重点/顽固等）用 `--radius-badge` 全圆角胶囊形，参考图里类似的小标签也是这种处理

---

## 5. 各类组件的具体应用规则

### 5.1 顶部标题区

- 背景白色或极浅的 `--color-bg`
- 网站标题用 `--color-text-primary` 加粗
- 副标题（如"长期可复用，多词库，本地保存"）用 `--color-text-secondary`
- 当前词库切换器：用 `--color-primary-light` 背景的圆角下拉框，不要让它孤立悬浮，
  放在标题区右侧并保持垂直居中对齐

### 5.2 导航栏

- 参考截图风格：用实色块做导航，不用普通的下划线菜单
- 当前选中的 tab：`--color-primary` 背景，白色文字
- 未选中的 tab：浅色背景（`--color-bg` 或白色），`--color-text-secondary` 文字，
  hover 时轻微变色提示可点击
- 整体导航条用 `--radius-button` 圆角包裹每个 tab，tab 之间留白间隔，不要无缝拼接
  （截图里是无缝拼接色块，但对工具网站来说留白分隔更清晰好点击，做适度调整）

### 5.3 今日任务横幅（今日听写页核心区块）

这是这次改版的视觉重点，参考截图里橙色播报条的处理方式：

- 用整块 `--color-accent` 或 `--color-accent-light` 背景承载
- 横幅内最大字号展示"今日总词数"，旁边用稍小字号展示新词/复习/到期复查的分项数字
- 文字颜色：如果背景是深橙 `--color-accent`，文字用白色；如果背景是浅橙
  `--color-accent-light`，文字用 `--color-accent-dark`
- 这个横幅应该是整个今日听写页里视觉最强的区域，第一眼就要看到"今天要做什么"

### 5.4 次要进度信息（当前Day/已学总数/当前错词池）

- 不要和上面的横幅用同样强度的颜色，用白色卡片 + `--color-border` 细边框，
  或者 `--color-primary-light` 浅色背景，数字字号比横幅里的小
- 这一组数据传达的是"长期进度"，重要但不是"今天要做的事"，视觉上要降一级

### 5.5 状态标签（错词本里的徽章）

统一用 `--radius-badge` 胶囊形状，配色规则：

| 标签 | 背景色 | 文字色 |
|---|---|---|
| 当前错词池 | `--color-danger-light` | `--color-danger` |
| 历史错词 | `--color-border`（灰底） | `--color-text-secondary` |
| 重点 | `--color-highlight-light` | `--color-highlight` 加深版（可用 `#B8860B` 类似深黄） |
| 顽固 | `--color-danger-light` | `--color-danger-dark`（如果需要可定义这个变量，比 danger 更深） |
| 未错 | `--color-success-light` | `--color-success` |

### 5.6 按钮分级

- **主要行动按钮**（继续今日听写、保存等）：`--color-primary` 实色背景，白字
- **次要按钮**（重新生成、导出等）：白色背景 + `--color-primary` 描边和文字
- **危险按钮**（删除词库、撤销记录等）：`--color-danger` 描边或实色背景（取决于
  危险程度，"删除词库"这种不可逆操作建议实色背景更醒目警示）

### 5.7 工具页分区（对应阶段3的结构调整）

按阶段3定的顺序：云端同步 → 数据备份 → 手动校准 → 危险操作

- 云端同步、数据备份：用 `--color-primary-light` 或白色卡片，正常视觉权重
- 手动校准：用中性白色卡片
- 危险操作：整个区块用 `--color-danger-light` 浅红背景包裹，标题文字用
  `--color-danger`，和上面区域有明显间距（建议 32px 以上的留白间隔）+ 一条分隔线

---

## 6. 移动端适配要点

因为会在 iPad/手机上使用：

- 导航 tab 在窄屏下允许横向滚动，不要挤压变形
- 今日任务横幅在窄屏下数字依然要保持可读大小，不要为了塞进一行而过度缩小字号，
  可以改为换行堆叠显示
- 听写交互区的按钮（播放/再听一遍/上一个/下一个）在窄屏下要保证够大的点击区域
  （至少 44px 高度，方便手指点击）

---

## 7. 不应该做的事（避免过度设计）

- 不引入卡通插画、表情贴纸（截图参考的是色块和排版逻辑，不是要做成幼儿园风格的网站）
- 不用渐变色背景，统一用纯色块，更干净也更符合工具网站调性
- 不堆砌阴影和动画效果，听写是每天的高频工具，视觉上要"看一眼就懂"，
  不要因为美化牺牲信息获取速度
- 错词标签的颜色不要超过表格5.5里定义的5种，避免颜色种类过多造成新的混乱
