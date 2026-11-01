# 山野来信 · Letters from the Wild

一个关于山林、海岸与旷野的旅行灵感网站。使用纯 HTML、CSS、JavaScript 与本地原创 SVG 插画，无框架、构建步骤或第三方运行依赖。

## 本地预览

在仓库根目录执行：

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

在浏览器访问本机的 8000 端口即可。支持目的地筛选、收藏、行程详情、旅行准备清单；收藏和清单使用浏览器 localStorage 保存。旅行行程仅供灵感参考，出发前需确认实际情况。

## GitHub Pages

文件可以由 GitHub Pages 直接提供，无需安装依赖。在仓库的 **Settings → Pages → Build and deployment** 中选择 **Deploy from a branch**，分支选择 **main**，目录选择 **/ (root)**，保存后等待部署完成。

仓库名为 `huaizhouh.github.io`，启用 Pages 后的默认站点地址为 `https://huaizhouh.github.io/`。提交文件并不代表 Pages 已启用或部署成功，请以 Pages 设置页面的状态为准。

## 文件

- `index.html`：页面结构与内容
- `style.css`：响应式样式，含减少动态效果偏好支持
- `app.js`：筛选、详情弹窗和本地持久化
- `assets/`：本地 SVG 插画和站点图标

本项目没有分析追踪、第三方字体或远程图片请求。插画为本项目绘制，支持离线加载已下载的静态文件。
