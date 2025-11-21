# VSCode扩展发布指南

## 📋 发布前检查清单

- [ ] 确保所有功能正常工作
- [ ] 更新 `package.json` 中的 `publisher` 字段（改为你的VSCode Marketplace发布者ID）
- [ ] 更新 `repository.url`（如果有Git仓库）
- [ ] 准备图标文件 `icon.png`（建议尺寸：128x128像素）
- [ ] 更新 `README.md` 添加功能截图
- [ ] 更新版本号（如果需要）

## 🚀 打包步骤

### 1. 安装依赖并编译

```bash
# 安装所有依赖
npm install

# 编译TypeScript代码
npm run compile
```

### 2. 安装vsce工具

```bash
# 全局安装vsce（VSCode扩展打包工具）
npm install -g @vscode/vsce
```

### 3. 打包扩展

```bash
# 生成 .vsix 文件
vsce package
```

这会在项目根目录生成一个 `big-log-viewer-1.0.0.vsix` 文件。

## 📦 本地安装测试

打包后，先在本地安装测试：

1. 打开VSCode
2. 按 `Ctrl+Shift+P`（Mac: `Cmd+Shift+P`）
3. 输入 `Extensions: Install from VSIX...`
4. 选择刚才生成的 `.vsix` 文件
5. 重启VSCode
6. 测试所有功能

## 🌐 发布到VSCode Marketplace

### 方式一：使用vsce命令行发布

1. **创建发布者账号**
   - 访问 https://marketplace.visualstudio.com/manage
   - 使用Microsoft账号登录
   - 创建发布者（Publisher）

2. **获取Personal Access Token (PAT)**
   - 访问 https://dev.azure.com
   - 进入 User Settings → Personal Access Tokens
   - 创建新Token，权限选择 `Marketplace` → `Manage`
   - 保存Token（只显示一次！）

3. **登录vsce**
   ```bash
   vsce login <your-publisher-name>
   # 输入刚才获取的PAT
   ```

4. **发布扩展**
   ```bash
   vsce publish
   ```

### 方式二：手动上传

1. 访问 https://marketplace.visualstudio.com/manage
2. 点击 `New Extension` → `Visual Studio Code`
3. 上传 `.vsix` 文件
4. 填写扩展信息
5. 提交审核

## 📝 更新版本

### 1. 更新版本号

编辑 `package.json`：

```json
{
  "version": "1.0.1"  // 修改这里
}
```

或使用命令：

```bash
# 补丁版本（1.0.0 → 1.0.1）
vsce publish patch

# 次要版本（1.0.0 → 1.1.0）
vsce publish minor

# 主要版本（1.0.0 → 2.0.0）
vsce publish major
```

### 2. 更新说明

在 `CHANGELOG.md` 中记录更新内容。

## 🔍 发布后验证

1. 在VSCode中搜索你的扩展
2. 检查扩展页面信息是否正确
3. 安装并测试功能
4. 查看用户反馈

## ⚠️ 注意事项

1. **扩展名称（name）必须唯一**
   - 如果 `big-log-viewer` 已被占用，需要改名
   - 可以在 https://marketplace.visualstudio.com 搜索检查

2. **发布者名称（publisher）**
   - 必须先在Marketplace创建
   - 只能包含字母、数字和连字符

3. **图标要求**
   - 格式：PNG
   - 尺寸：至少128x128像素
   - 建议：256x256像素，背景透明

4. **README.md**
   - 必须包含清晰的功能说明
   - 建议添加截图或GIF演示
   - 写明使用方法

5. **许可证**
   - 建议添加 LICENSE 文件
   - 推荐使用 MIT License

## 📊 仅分享给团队（不公开发布）

如果不想公开发布，只想分享给团队：

1. **通过.vsix文件分享**
   ```bash
   vsce package
   ```
   将生成的 `.vsix` 文件发给团队成员，让他们手动安装。

2. **通过Git仓库**
   - 团队成员clone仓库
   - 执行 `npm install && npm run compile`
   - 按F5在开发模式下使用

## 🛠️ 常见问题

### Q: 打包时报错 "no README"
A: 确保项目根目录有 `README.md` 文件

### Q: 打包时报错 "no LICENSE"
A: 在 `package.json` 添加 `"license": "MIT"` 或创建 LICENSE 文件

### Q: 图标不显示
A: 检查 `package.json` 中的 `icon` 路径是否正确

### Q: 扩展安装后无法激活
A: 检查 `activationEvents` 配置是否正确

## 📚 相关链接

- VSCode扩展开发文档: https://code.visualstudio.com/api
- VSCode Marketplace: https://marketplace.visualstudio.com
- vsce工具文档: https://github.com/microsoft/vscode-vsce
- 扩展发布指南: https://code.visualstudio.com/api/working-with-extensions/publishing-extension
