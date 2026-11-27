# AzurLane Live2D Viewer

一个以 TypeScript 编写的个人项目，用于下载并解码部分碧蓝航线资源，并在本地网页预览 Live2D 模型。项目仍在完善中，格式支持和导出结果可能不完整。

## Functions

- 从游戏资源索引按需下载舰船皮肤信息和 Live2D 资源。
- 解码 UAB、UnityFS 资源；处理项目遇到的定制 LuaJIT 字节码，并反编译部分 Lua 脚本。

- 在网页中选择皮肤、切换动作、设置循环播放，并拖动、缩放和调整视线跟随。

## Features
- 直接从官网爬取数据，无需提取移动端游戏文件
- 将`jspzyhl`大佬的 `uabDec` 与 `bcDec` 项目使用ts代码实现（AI翻译），处理碧蓝航线对资源文件的特殊混淆
- 基于 `unityfs-js` 解析 `UnityFS` 容器，提取 `.moc3` 数据。
- 使用 `node-luajit-decompiler-v2` 将 `LuaJit` 字节码还原为 `.lua` 文件
- 导出 Live2D 模型及相关文件到 `models/<皮肤ID>/`，并在文本资源中替换已识别的 `{namecode:数字}`。
- 在网页中选择皮肤、切换动作、设置循环播放，并拖动、缩放和调整视线跟随。

## Run

需要安装 Node.js，并能够访问游戏资源服务器。

```bash
npm install
npm start
```

- 启动后打开 [http://localhost:3000](http://localhost:3000)。选择皮肤并点击“下载并加载皮肤”；也可以填写已有模型的 `.model3.json` 地址后加载。
- 首次启动会联网获取资源版本信息及皮肤、名称数据；相关缓存写入 `shipList.json`、`namecode.json`。资源配置位于 `config.json`。
- 解码后的模型保存在 `models/`，可供后续本地预览。

## Credits

- [AzurLane5.0-uabDec](https://github.com/jspzyhl/AzurLane5.0-uabDec)
- [AzurLane5.1-bcDec](https://github.com/jspzyhl/AzurLane5.1-bcDec)
- [unityfs-js](https://github.com/bainiao404/unityfs-js)
- [碧蓝航线Live2D的提取](https://zhouxuebin.club/blog/posts/azurlane-live2d/1a99be85/)
- [Lua代码的提取](https://www.h8t.top/hugo/2022-06-15/51831f8fea33/) 
- [数据爬取工作](https://blog.axix.top/index.php/2023/12/15/14/)
