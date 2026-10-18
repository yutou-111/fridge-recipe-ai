# 冰箱盲盒大厨

根据冰箱中的食材推荐家常菜，并提供随机寻味、星级筛选、额外食材解锁、备菜清单和烹饪教程。

## 使用方法

1. 安装 Node.js 18 或更高版本。
2. 复制 `.env.example`，重命名为 `.env`。
3. 打开 `.env`，填写自己的 AI 接口地址、API Key 和模型名称。
4. 双击 `启动冰箱大厨.bat`，或在当前文件夹运行：

```bash
node server.js
```

5. 浏览器打开 `http://localhost:3000`。

不要直接双击 HTML 文件；修改 `.env` 后需要重启服务器。

## `.env` 配置

```env
AI_API_URL=https://服务商域名/v1/chat/completions
AI_API_KEY=填写你自己的API密钥
AI_CHAT_MODEL=填写文字模型名称
AI_VISION_MODEL=填写支持图片的模型名称
AI_THINKING=auto
```

地址、Key 和模型名必须来自同一个服务商或中转站。服务商需要支持兼容 Chat Completions 的接口。`AI_VISION_MODEL` 用于拍照识别；不使用拍照功能时可以留空。DeepSeek 配置可以直接参考 `.env.example`，其他平台请从该平台的接入文档复制地址和模型名。

## 文件说明

- `server.js`：后端服务和 AI 请求代理。
- `冰箱盲盒大厨.html`：前端页面。
- `启动冰箱大厨.bat`：Windows 一键启动脚本。
- `.env.example`：AI 配置模板，复制后改名为 `.env`。
- `package.json`：项目依赖说明，可选上传。

## 安全提示

不要上传真实的 `.env`、API Key 或包含密钥的截图。每位使用者都应填写自己的 API Key，并承担自己的接口调用费用。
