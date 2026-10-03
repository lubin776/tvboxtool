# TVBox 接口抓取工具

一个部署在 Cloudflare Pages 上的 TVBox 接口抓取工具，支持模拟 TVBox 访问环境、多种 UA 指纹切换、自动解密和格式化输出。

## ✨ 功能特性

- **模拟 TVBox 访问环境**：内置多种 TVBox 特征 UA，逐个尝试获取数据
- **UA 指纹可选**：前端可选择全选/部分选/剔除，浏览器标识自动置后
- **流式响应**：实时推送每个 UA 的尝试进度
- **自动解密**：支持 Base64、Gzip、AES-128-CBC、2423/2324 等多种解密方式
- **格式化输出**：自动清理注释、压缩空白、补全路径、格式化 JSON

## 📁 项目结构

```
tvbox-tool/
├── functions/                  # Cloudflare Pages Functions (后端)
│   ├── api/
│   │   ├── fetch.js           # 🔑 核心 API：模拟 TVBox 访问 + 流式返回
│   │   └── uas.js             # 📋 UA 列表接口
│   └── lib/
│       └── decrypt.js         # 🔓 解密工具库
├── static/                    # 🎨 前端页面
│   ├── index.html             # 主页面
│   ├── style.css              # 深色主题样式
│   ├── app.js                 # 前端交互逻辑
│   └── 404.html               # 404 页面
├── scripts/
│   └── test-decrypt.js        # 🧪 本地测试脚本
├── wrangler.toml              # ⚙️ Cloudflare 配置
├── package.json               # 📦 项目配置
├── .gitignore                 # 🚫 Git 忽略
└── README.md                  # 📖 本文件
```

## 🚀 部署流程（纯网页操作，无需命令行）

### 第一步：GitHub 建仓

1. 打开 https://github.com/new
2. Repository name: `tvbox-tool`
3. 选择 Public 或 Private
4. **不要**勾选任何初始化选项
5. 点击 Create repository

### 第二步：在 GitHub 网页端创建文件

点击 "Add file" → "Create new file"，按以下路径逐个创建：

| 文件路径 | 说明 |
|---------|------|
| `functions/api/fetch.js` | 后端核心 API |
| `functions/api/uas.js` | UA 列表接口 |
| `functions/lib/decrypt.js` | 解密逻辑库 |
| `static/index.html` | 前端页面 |
| `static/style.css` | 前端样式 |
| `static/app.js` | 前端逻辑 |
| `static/404.html` | 404 页面 |
| `wrangler.toml` | CF 配置 |
| `package.json` | 项目配置 |
| `.gitignore` | Git 忽略 |
| `scripts/test-decrypt.js` | 测试脚本 |

每个文件：输入完整路径 → 粘贴代码 → 底部点击 "Commit changes"

### 第三步：Cloudflare Pages 关联

1. 打开 https://dash.cloudflare.com/
2. Compute (Workers) → Pages → Create a project
3. Connect to Git → 授权 → 选择 `tvbox-tool` 仓库
4. 构建设置：
   - **Framework preset**: `None`
   - **Build command**: 留空
   - **Build output directory**: `static`
   - **Functions directory**: `functions`（⚠️ 点 Advanced settings 展开）
5. 点击 **Save and Deploy**

### 第四步：验证

浏览器访问 `https://tvbox-tool.pages.dev`，输入 TVBox 接口 URL，点击抓取即可。

## 🧪 本地开发

```bash
# 安装依赖（仅 Node.js 22+）
npm install -g wrangler

# 本地启动开发服务器
npx wrangler pages dev static --compatibility-date=2024-01-01

# 测试解密逻辑
node scripts/test-decrypt.js
```

## 📝 License

MIT
