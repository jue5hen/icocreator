# IcoCreator

把一张图片转换成多尺寸 Windows ICO 图标，支持裁剪、预览和批量导出。

## 功能

- 导入 PNG / JPEG / WebP / GIF / BMP / TIFF，按文件内容识别格式
- 一次生成 16×16 到 256×256 的多个尺寸，可自由勾选
- 宽图居中裁方、旋转、撤销（10 步）
- 预览各尺寸效果，导出 ICO 或单张 PNG
- 批量导出遇同名文件自动加 `-2`、`-3` 后缀，不覆盖已有文件
- 单实例运行，设置自动保存

## 下载

安装包见 [Releases](https://github.com/jue5hen/icocreator/releases/latest)：

- `IcoCreator_1.0.0_x64-setup.exe` — 按当前用户安装，默认不需要管理员权限

系统要求：Windows 10/11 x64，Microsoft Edge WebView2 Runtime（Windows 11 已内置）。

## 从源码构建

前置：Node.js 20+、Rust stable、Windows 上可用的 MSVC 或 GNU 工具链、WebView2 Runtime。

```powershell
npm ci
npm run tauri build
```

产物在 `src-tauri/target/release/bundle/nsis/`。

## 许可证

[MIT](LICENSE)
