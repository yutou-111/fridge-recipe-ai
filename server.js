/* ============================================================
   冰箱盲盒大厨 —— 后端小服务器
   ------------------------------------------------------------
   它干三件事：
     1. 把本程序目录里的网页发给浏览器（相当于开了一个本地网站）
     2. /api/chat   接口：替网页给配置的 AI 服务发文字消息，用来推荐菜谱
     3. /api/vision 接口：替网页把拍到的图片发给配置的 AI 服务，用来识别食材

   为什么要它：API Key 只存在这台电脑上（.env 文件里），
   网页代码里完全没有 Key，别人按 F12 也偷不走。

   怎么用：在本程序目录里执行   node server.js
          然后用浏览器打开          http://localhost:3000

   注意：这个服务器是给“自己本地用”的。如果哪天要放到公网上，
   一定要加上登录验证，否则任何人都能借你的 Key 花钱。
   ============================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------- 配置 ----------
const ROOT = __dirname;                 // 网页文件所在的文件夹（就是本文件所在目录）
const PORT = 3000;                      // 服务器端口，浏览器访问 http://localhost:3000
const DEFAULT_AI_API_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_AI_MODEL = 'deepseek-flash'; // 保留旧项目默认模型；识图能力以服务商支持为准

// 两种请求各自的等待上限。
// 网页那边的等待上限比这里再大一点点，这样“超时”会先由服务器这边发觉，
// 并且能返回一句正经的 JSON 错误给网页，而不是让网页自己瞎猜。
const CHAT_TIMEOUT = 30000;             // 推荐菜谱：30 秒
const VISION_TIMEOUT = 20000;           // 识别图片：20 秒

// 请求体大小上限（识别图片时 Base64 会比较大，80 万像素的 JPEG 一般也就几百 KB）
const MAX_BODY_BYTES = 15 * 1024 * 1024;

// 提示词写在服务器这边，网页负责不了、也改不了
const PROMPT_RECOGNIZE = '识别图片中的食材，只返回JSON数组，不要其他文字';

/* ============================================================
   〇、调用频率限制（防止 Key 被恶意刷量）
   ------------------------------------------------------------
   规则：同一个 IP，1 分钟内最多 10 次接口调用，超了就返回 429。
   只统计 /api/chat 和 /api/vision 这两个要花钱的接口，
   网页、图片这些静态文件不受影响（否则页面都打不开了）。

   注意：你自己在本机测试时，所有请求都来自同一个 IP，
   所以你自己点得太快也会被拦住。嫌紧就把下面两个数字改大。
   ============================================================ */
const RATE_LIMIT_MAX = 10;              // 1 分钟内最多几次
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 时间窗口：1 分钟

// 用一个 Map 记着每个 IP 的“次数”和“从什么时候开始数的”
const rateLimitRecords = new Map();

// 取出访问者的 IP。
// 以后要是部署到公网、前面挂了 Nginx 之类的，真实 IP 会在 x-forwarded-for 里，
// 所以这里优先看它，没有再看直接连上来的地址。
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();   // 可能是一串，取第一个（最初的客户端）
  }
  return req.socket.remoteAddress || 'unknown';
}

// 检查这个 IP 还能不能继续调用。返回 { allowed: true } 或 { allowed: false, retryAfterSec: 30 }
function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimitRecords.get(ip);

  // 第一次来，或者上一次的时间窗口已经过完 → 重新开一个窗口
  if (!record || now - record.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitRecords.set(ip, { count: 1, windowStart: now });
    return { allowed: true };
  }

  // 还在同一个窗口里 → 次数 +1
  record.count += 1;

  if (record.count > RATE_LIMIT_MAX) {
    const elapsed = now - record.windowStart;
    const retryAfterSec = Math.max(1, Math.ceil((RATE_LIMIT_WINDOW_MS - elapsed) / 1000));
    return { allowed: false, retryAfterSec: retryAfterSec };
  }

  return { allowed: true };
}

// 时不时清理一下过期的记录，免得 Map 越攒越大（长期开着也不会吃内存）
function cleanupRateLimitRecords() {
  const now = Date.now();
  for (const [ip, record] of rateLimitRecords) {
    if (now - record.windowStart >= RATE_LIMIT_WINDOW_MS) {
      rateLimitRecords.delete(ip);
    }
  }
}
setInterval(cleanupRateLimitRecords, RATE_LIMIT_WINDOW_MS).unref();

/* ============================================================
   一、读取 .env 文件里的 AI 服务配置
   ------------------------------------------------------------
   .env 就是一个纯文本文件，内容长这样：
       AI_API_URL=https://服务商域名/v1/chat/completions
       AI_API_KEY=自己的密钥
       AI_CHAT_MODEL=文字模型名称
       AI_VISION_MODEL=识图模型名称
   旧的 DEEPSEEK_API_KEY 写法仍然有效；Key 不写在代码里。
   ============================================================ */
function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  const result = {};

  if (!fs.existsSync(envPath)) {
    return result;   // 文件不存在就返回空对象，后面会提示用户去创建
  }

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    // 跳过空行和以 # 开头的注释行
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;   // 没有等号的畸形行，跳过
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // 允许 .env 的值使用成对单引号或双引号包裹。
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

const envFile = loadEnvFile();

// 每项优先用系统环境变量，其次用 .env；空值使用默认设置。
function readAiSetting(name) {
  const value = process.env[name] !== undefined ? process.env[name] : envFile[name];
  return typeof value === 'string' ? value.trim() : '';
}

const AI_API_URL = readAiSetting('AI_API_URL') || DEFAULT_AI_API_URL;
const API_KEY = readAiSetting('AI_API_KEY') || readAiSetting('DEEPSEEK_API_KEY');
const AI_CHAT_MODEL = readAiSetting('AI_CHAT_MODEL') || DEFAULT_AI_MODEL;
const AI_VISION_MODEL = readAiSetting('AI_VISION_MODEL') || AI_CHAT_MODEL;
// auto：只对原有 DeepSeek 默认模型保留禁用思考参数；其他平台不附加专用参数。
const AI_THINKING = readAiSetting('AI_THINKING') || 'auto';

/* ============================================================
   二、把网页文件发给浏览器
   ============================================================ */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStaticFile(req, res) {
  // 去掉问号后面的参数，再把中文等特殊字符还原成正常文件名
  let relativePath = decodeURIComponent(req.url.split('?')[0]);
  // 直接访问根路径时，默认给主页
  if (relativePath === '/') relativePath = '/冰箱盲盒大厨.html';

  // 安全检查 1：点开头的文件一律不给（.env 存着你的 Key，绝不能通过网址被下载走！）
  const segments = relativePath.split(/[\\/]/);
  for (const segment of segments) {
    if (segment.startsWith('.')) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 不允许访问');
      return;
    }
  }

  const filePath = path.join(ROOT, relativePath);

  // 安全检查 2：防止别人用 ../../ 这样的路径读到文件夹外的文件
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 不允许访问');
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 找不到这个文件');
    return;
  }

  res.writeHead(200, {
    'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
  });
  fs.createReadStream(filePath).pipe(res);
}

/* ============================================================
   三、读取浏览器发来的请求体
   ============================================================ */
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let finished = false;   // 防止 reject 之后又 resolve，或者反过来

    req.on('data', (chunk) => {
      if (finished) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finished = true;
        reject(new Error('请求内容太大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (finished) return;
      finished = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', (err) => {
      if (finished) return;
      finished = true;
      reject(err);
    });
  });
}

// 统一的 JSON 回复。
// 这里做了两层保护，因为这个函数是“服务器崩溃”最常见的出事地点：
// 网页等不及先断开连接之后，再往一个已经关掉的连接里写东西，会抛异常。
function sendJson(res, statusCode, payload) {
  // 保护 1：连接已经断了就别写了，直接放弃这次回复
  if (res.writableEnded || res.destroyed) {
    return;
  }

  const body = JSON.stringify(payload);

  // 保护 2：万一还是抛了（例如刚判断完连接就断了），也不能让整个服务器倒下
  try {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  } catch (err) {
    console.warn('[回复失败] 连接可能已经断开：' + err.message);
  }
}

/* ============================================================
   四、公共函数：请求兼容 Chat Completions 的 AI 服务
   ------------------------------------------------------------
   两种接口（文字 / 图片）都用它，只是等待上限不同。
   成功时返回模型回复的文字；失败时抛出异常，由调用方决定怎么回话。
   ============================================================ */
// 保留原函数名和前两个参数，避免影响现有业务调用。
async function callDeepSeek(messages, timeoutMs, mode = 'chat') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const endpoint = new URL(AI_API_URL);
    if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
      throw new Error('AI_API_URL 必须是完整的 http 或 https 接口地址');
    }
    const model = mode === 'vision' ? AI_VISION_MODEL : AI_CHAT_MODEL;
    const payload = { model: model, messages: messages };
    if (AI_THINKING === 'enabled' || AI_THINKING === 'disabled') {
      payload.thinking = { type: AI_THINKING };
    } else if (AI_THINKING === 'auto') {
      if (endpoint.hostname === 'api.deepseek.com' && model === DEFAULT_AI_MODEL) {
        payload.thinking = { type: 'disabled' };
      }
    } else if (AI_THINKING !== 'omit') {
      throw new Error('AI_THINKING 只能是 auto、omit、enabled 或 disabled');
    }

    const upstream = await fetch(AI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // ★ 关键：Key 只在这里出现，永远不会发给浏览器 ★
        'Authorization': 'Bearer ' + API_KEY,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      console.warn('[AI 服务返回错误] ' + upstream.status + ' ' + errText.slice(0, 200));
      // 401 是 Key 不对，429 是服务商限流了，其余归为接口异常
      if (upstream.status === 401) {
        throw new Error('API Key 无效，请检查 .env 文件');
      }
      throw new Error('AI 接口返回 ' + upstream.status);
    }

    const data = await upstream.json();
    const content =
      data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : null;

    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error('AI 服务没有返回有效内容');
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/* ============================================================
   五、/api/chat —— 推荐菜谱（文字）
   ------------------------------------------------------------
   三种用法，靠请求体里的字段来区分：

   A. 普通推荐：浏览器发来 { "messages": [ ... ] }，服务器原样转发。
      （这是第 3 步就有的老用法，保留不动）

   B. 解锁更多：浏览器发来
        { "action": "unlock",
          "ingredients": ["西红柿","鸡蛋"],   // 用户已有的食材
          "extraCount": 2,                    // 用户想额外买几道食材
          "excludeRecipes": ["西红柿炒蛋"] }   // 已经推荐过的菜名，别再重复
      提示词由服务器这边拼 —— 提示词属于业务规则，放服务端便于以后统一调整，
      网页那边也就改不了它。

   C. 随机寻味：浏览器发来
        { "isMysteryMode": true,
          "ingredients": ["土豆"],            // 可以是空数组，表示什么食材都没有
          "hasSeasonings": true }             // 可选，勾了「我家有基础调料」就传 true
      提示词同样由服务器拼。前端那边拼好的那份 messages 会被整个丢掉不用。

   三种情况都返回 { "content": "模型回复的文字" }，前端解析方式完全一样。
   ============================================================ */

// 随机寻味最多要几道。
// 要 15 道而不是 5 道，是因为一页只显示 5 道：
// 池子小了【🔄 换一批】就没得换，第一次展示完按钮就灰了。
// 15 道刚好能换两轮（5 + 5 + 5）。
// 注意：这只是「最多」，模型凑不出这么多就照实返回几道，
//       前端也照实显示，绝不补假菜 —— 这一点在下面提示词里也写明了。
const MYSTERY_MAX_RECIPES = 15;

// 把数组整理成「A、B、C」这种中文顿号列表，并且去掉空项
function joinChineseList(list) {
  if (!Array.isArray(list)) return '';
  return list
    .map((item) => String(item == null ? '' : item).trim())
    .filter((item) => item !== '')
    .join('、');
}

/* 把「最低星级」翻译成模型能照着做的具体指标。
   ------------------------------------------------------------
   为什么要翻译：星级不是模型自己算的，是网页那边按这个公式算出来的 ——

       分数 = 用料种数得分 × 20% + 上手程度 × 40% + 步骤数得分 × 40%
       星级 = 6 - round(分数)          （星级越高 = 越难做）

   其中「用料种数」就是 ingredients 有几项，「步骤数」就是 steps 有几项，
   上手程度则跟步骤里有没有「焯水、腌制、收汁」这类麻烦工序、以及
   单步写得多长有关。也就是说，星级几乎完全由这三个可数的东西决定。

   所以这里不跟模型说「请给 3 星的菜」（它根本没法算分），
   而是直接告诉它「用料大约几种、步骤大约几步」——
   这才是它真正能照着做的指标，也才真的能把星级凑到目标区间。

   星级区间对应关系（按上面的公式反推）：
     1 星 → 用料 ≤2、步骤 ≤3、没有麻烦工序        （最好做）
     2 星 → 用料 2~3、步骤 3~4
     3 星 → 用料 3~4、步骤 5~6，带一两道额外工序
     4 星 → 用料 5~7、步骤 7~8，带两三道额外工序
     5 星 → 用料 8+、步骤 9+，带三道以上额外工序 （最难做） */
function describeStarTarget(minStars) {
  switch (minStars) {
    case 1:
      return { ingRange: '1~2 种', stepRange: '2~3 步', trouble: '' };
    case 2:
      return { ingRange: '2~3 种', stepRange: '3~4 步', trouble: '' };
    case 3:
      return {
        ingRange: '3~4 种',
        stepRange: '5~6 步',
        trouble: '步骤里要有 1~2 道稍微费事的工序（例如焯水、煸炒出汁、收汁）',
      };
    case 4:
      return {
        ingRange: '5~7 种',
        stepRange: '7~8 步',
        trouble: '步骤里要有 2~3 道费事的工序（例如焯水、腌制、翻炒上色、收汁、勾芡）',
      };
    default:   // 5 星及以上
      return {
        ingRange: '8 种以上',
        stepRange: '9 步以上',
        trouble: '步骤里要有 3 道以上费事的工序（例如腌制、焯水、炖煮、收汁、勾芡）',
      };
  }
}

// 拼「随机寻味」用的提示词。
//   ingredients  ：用户已添加的食材，可以是空数组（表示什么食材都没有）
//   hasSeasonings：勾了「我家有基础调料」就传 true
//   minStars     ：生效中的最低星级，0 表示用户没设星级
function buildMysteryPrompt(ingredients, hasSeasonings, minStars) {
  const ownedList = joinChineseList(ingredients);
  const hasIngredients = ownedList !== '';
  const wantStars = Number(minStars) || 0;   // 0 或非法值都当成「没设星级」

  let prompt = '';

  /* ---------- 第一段：交代背景 ---------- */
  if (hasIngredients) {
    // 有食材：既要围绕这些食材，又要满足星级
    prompt +=
      '用户不知道想吃什么，但冰箱里有这些食材：' + ownedList + '。\n';
    if (wantStars > 0) {
      /* 用户同时给了食材和星级 —— 按用户的要求，星级是「先决条件」，
         食材是「在这些菜里再挑」。
         为什么要写清楚这个先后顺序：如果反过来（先按食材挑、再看星级），
         很容易挑出一堆简单快手菜，全都够不上星级，最后一轮过滤下来一道不剩。 */
      prompt +=
        '用户还希望菜谱的难度不低于 ' + wantStars + ' 星（星级越高越难做）。\n' +
        '请这样来做：先在常见的家常菜里找出所有达到 ' + wantStars +
        ' 星难度的菜，再从这些菜里挑出能用上上面那些食材的。\n' +
        '难度优先于食材：宁可只用到其中一两样食材，也不要为了把食材都用上而降低难度。\n';
    }
  } else {
    // 没食材：纯随机
    prompt += '用户不知道想吃什么，也没有提供任何食材。\n';
    if (wantStars > 0) {
      prompt +=
        '用户希望菜谱的难度不低于 ' + wantStars + ' 星（星级越高越难做）。' +
        '请直接在常见的家常菜里挑出所有达到 ' + wantStars + ' 星难度的菜。\n';
    }
  }

  /* ---------- 第二段：数量要求 ---------- */
  prompt += wantStars > 0
    ? '用户不知道吃什么，但要求做【' + wantStars + '星】及以上的菜。请根据【' + wantStars + '星】标准，推荐最多5道家常菜。\n'
    : '请推荐最多 ' + MYSTERY_MAX_RECIPES + ' 道菜。\n';

  /* ---------- 第三段：星级对应的具体指标 ---------- */
  if (wantStars > 0) {
    const target = describeStarTarget(wantStars);
    prompt +=
      '关于难度，请严格按下面的指标来写（这是判断星级的标准）：\n' +
      '· 用料控制在 ' + target.ingRange + '（不含盐、油、酱油这类基础调料）；\n' +
      '· 步骤控制在 ' + target.stepRange + '；\n';
    if (target.trouble !== '') {
      prompt += '· ' + target.trouble + '；\n';
    }
    prompt +=
      '· 不要给出难度明显低于上面指标的菜，那样的菜会被过滤掉。\n' +
      '· 网站会自行计算星级，不采信你声明的星级；输出前请按以下公式自检，确保每道菜的计算结果至少为 ' + wantStars + ' 星。\n' +
      '用料得分：ingredients 项数≤2为5分，3~4为4分，5~6为3分，7~8为2分，≥9为1分；按实际返回数组的全部项数计算。\n' +
      '步骤得分：steps 项数≤3为5分，4~5为4分，6~7为3分，8~9为2分，≥10为1分。\n' +
      '上手得分=max(1,5-费事工序步骤数-长步骤数)；每步含腌制、发酵、焯水、过油、油炸、翻面、勾芡、上浆、收汁、熬、焖、炖、烤、打发、揉面、醒面、隔水、水浴、裱花、拉丝、复炸任一词就计一次费事工序；每步去掉空白后至少30个字符计一次长步骤，同一步可分别计数。\n' +
      '总分=用料得分×0.2+上手得分×0.4+步骤得分×0.4，保留两位小数；星级=6-总分四舍五入到整数，限制在1~5星。选择本身满足难度的真实家常菜，不得堆砌食材、拆分步骤或加入无关工序凑星数。\n';
  } else {
    // 没设星级：照旧，优先好做的
    prompt +=
      '难度上请优先推荐简单好做的家常菜，步骤控制在 3~6 步，做法别太复杂。\n';
  }

  /* ---------- 第四段：通用要求 ---------- */
  prompt +=
    '其他要求：\n' +
    '1. 尽量多给几道，能想出几道就给几道；想不出那么多就照实少给，' +
    '但不要重复、不要硬凑，也不要编造不存在的菜。\n' +
    '【重要】必须确保推荐的菜品名字唯一且没有逻辑重复。绝对不允许同时推荐"A炒B"和"B炒A"这种顺序相反但实质相同的菜品。如果食材组合只有一种做法，请只推荐一次。\n' +
    '【重要】如果用户输入的食材包含不可食用的物品、恶心词汇或非食材，请直接返回空数组[]，绝对不要生成任何关于这些垃圾物品的菜谱。\n' +
    '【食材分类与甜品隔离 - 绝对铁律】\n' +
    '第一步：强制进行食材分类。在生成菜谱前，先判断用户输入的食材属于"甜点/烘焙类"（如蛋糕、布丁、奶油、草莓、巧克力、面粉、糖、饼干）还是"日常炒菜类"（如肉、蛋、蔬菜、米饭）。\n' +
    '第二步：甜品专属逻辑。如果用户输入的是"蛋糕"、"布丁"、"甜品"、"草莓"、"奶油"等甜品食材，请只能推荐甜品或烘焙类食品。绝对禁止将甜品食材与鸡蛋、肉类、蔬菜、米饭组合做成炒菜、炒蛋或粥（例如绝对不能出现"蛋糕炒蛋"、"蛋糕粥"、"布丁炒肉"、"草莓炒肉"这种荒谬菜品）。\n' +
    '第三步：对于"蛋糕"的特殊处理。蛋糕本身是成品。如果用户输入"蛋糕"，请推荐"奶油蛋糕"、"微波蛋糕"、"蒸蛋糕"、"海绵蛋糕"等合理做法，或者提示"可以直接食用，也可以搭配水果或奶油装饰"。绝对不要出现炒、炖、煮的咸味做法。\n' +
    '第四步：对于"甜品"大类的处理。如果用户输入的是"甜品"这种大类，请推荐各种具体的甜品，比如"焦糖布丁"、"双皮奶"、"小圆子"、"糖水"、"芋圆"、"红豆沙"等，并且生成的用料要非常细腻、真实（比如需要牛奶、糖、吉利丁片、红豆等）。\n' +
    '第五步：绝对禁止强行组合不合理食材。如果某两种食材放在一起不符合常理（比如草莓和猪肉，蛋糕和酱油，布丁和青椒），请拒绝生成，或者只生成符合常理的做法。\n';

  if (hasIngredients && wantStars === 0) {
    prompt +=
      '2. 主要食材请围绕上面列出的这些来用，' +
      '调味的盐、油、酱油、葱、姜、蒜可以自由使用，不必额外说明。\n';
  } else if (hasIngredients) {
    prompt +=
      '2. 盐、油、酱油、葱、姜、蒜这类基础调料可以自由使用，不必额外说明。\n';
  }

  if (hasSeasonings) {
    prompt += '用户已拥有盐、油、酱油等基础调料，不需要额外购买，也不要把它们列为缺少的主食材。\n';
  }

  prompt += '返回纯JSON格式，必须包含 recipe_name, ingredients, steps, hint 四个字段。\n' +
    '【重要】hint 字段是必填项，绝对不能省略：\n' +
    '· 如果菜名比较笼统（比如"辣椒炒肉"、"炒青菜"、"炖肉"、"辣子鸡"），必须在 hint 字段里给出具体的食材建议，比如"建议用青椒或小米椒，肉选用猪肉或牛肉"。\n' +
    '· 如果菜名已经很具体（比如"西红柿炒鸡蛋"、"奶油蛋糕"、"青椒肉丝"），hint 填空字符串 ""。\n' +
    '· 示例：{"recipe_name":"辣椒炒肉","hint":"建议用青椒或小米椒，肉选用猪肉片或牛肉片","ingredients":[...],"steps":[...]}';

  return prompt;
}

// 拼「解锁更多菜谱」用的提示词
function buildUnlockPrompt(ingredients, extraCount, excludeRecipes, excludeIngredients, allIngredients) {
  const ownedList = joinChineseList(ingredients);
  const excluded = joinChineseList(excludeRecipes);
  const excludedIngredientsList = joinChineseList(
    Array.isArray(excludeIngredients) && excludeIngredients.length > 0
      ? excludeIngredients
      : ingredients
  );
  // 兼容旧前端：完整已有上下文至少包含原始食材和历史解锁食材。
  const availableIngredients = Array.from(new Set(
    ingredients.concat(
      Array.isArray(excludeIngredients) ? excludeIngredients : [],
      Array.isArray(allIngredients) ? allIngredients : []
    ).filter(function (name) { return typeof name === 'string' && name.trim(); })
      .map(function (name) { return name.trim(); })
  ));
  const availableIngredientsList = joinChineseList(availableIngredients);

  let prompt =
    '用户当前已有食材为【' + availableIngredientsList + '】；用户最初选择的食材为【' + ownedList + '】。\n' +
    '重复购买排除清单为【' + excludedIngredientsList + '】。排除清单仅限制 extra_ingredients 新增购买食材，绝不禁止菜谱使用这些已有食材。\n' +
    '请生成【' + extraCount + '】种全新的、与排除清单完全不重复的常见家常配菜食材（如蔬菜、肉类、豆制品）。\n' +
    '必须不多不少，正好' + extraCount + '个不重复食材，并将它们放入 extra_ingredients 数组。\n' +
    '绝对禁止推荐大米、米饭、面条、馒头、包子、饺子、粥、米粉等主食！\n' +
    '绝对禁止推荐盐、油、酱油、醋、糖、葱、姜、蒜等基础调料！\n' +
    'extra_ingredients 中的每个食材必须是常见、可单独购买的配菜食材，不能带重复名称、不能与排除清单同义重复。\n' +
    '先确定本次 extra_ingredients，再在同一次生成中将已有 allIngredients【' + availableIngredientsList + '】与本次 extra_ingredients 合并去重，得到用户现在的总食材数组。\n' +
    '请结合这个总食材数组，推荐最多5道新菜谱，要尽量用到现有的食材组合；菜名必须唯一。\n' +
    '每道新菜必须同时使用至少一种用户最初选择的食材和至少一种本次新增食材；不能整批只围绕新增食材做菜而忽略原始食材。整批尽量覆盖所有原始食材和历史新增食材，但不要为了全用完而强行混搭不合理的食材。\n' +
    '例如原有西红柿、鸡蛋，本次新增猪肉、土豆时，总食材就是[西红柿, 鸡蛋, 猪肉, 土豆]，可组合西红柿炒肉、土豆炒鸡蛋；示例只说明搭配原则，必须以本次实际食材和排除菜名为准。\n' +
    '菜谱用料只能来自已有 allIngredients、本次 extra_ingredients 和默认基础调料，不能暗中引入其他待购买食材；所有菜谱合计必须用到本次全部 ' + extraCount + ' 种新增食材。\n' +
    '食材名只写具体名称，不能把“青椒或红椒”“猪肉/牛肉”等多个食材合并成一项；番茄与西红柿、土豆与马铃薯、猪肉与猪肉丝等同义名称算同一种食材。\n' +
    /* 这三条是「额外食材」这个功能的命门：模型一旦推荐九层塔、迷迭香这种
       超市里买不到、或者用户其实已经有的东西，「需要额外购买」就变成了笑话。
       所以下面三句写得比别处都重，用「绝对禁止」这种说法。 */
    '请优先推荐常见的家常食材（如土豆、青椒、火腿、西红柿等）。\n' +
    '绝对禁止推荐小众食材（如九层塔、迷迭香、欧芹等）。\n' +
    '绝对禁止将基础调料和调味菜（如盐、油、酱油、葱、姜、蒜）列入需要额外购买的食材列表中，' +
    '默认用户已拥有这些调味品。\n' +
    '严格检查，额外食材绝对不能和用户已经拥有的食材（' + ownedList + '）或历史排除清单（' + excludedIngredientsList + '）重合，否则返回结果无效。\n' +
    '另外，用户已经看过这些菜，请不要重复推荐：' + (excluded || '（暂无）') + '。\n' +
    '【重要】必须确保推荐的菜品名字唯一且没有逻辑重复。绝对不允许同时推荐"A炒B"和"B炒A"这种顺序相反但实质相同的菜品。如果食材组合只有一种做法，请只推荐一次。\n' +
    '【重要】如果用户输入的食材包含不可食用的物品、恶心词汇或非食材，请直接返回空数组[]，绝对不要生成任何关于这些垃圾物品的菜谱。\n' +
    '【食材分类与甜品隔离 - 绝对铁律】\n' +
    '第一步：强制进行食材分类。在生成菜谱前，先判断用户输入的食材属于"甜点/烘焙类"（如蛋糕、布丁、奶油、草莓、巧克力、面粉、糖、饼干）还是"日常炒菜类"（如肉、蛋、蔬菜、米饭）。\n' +
    '第二步：甜品专属逻辑。如果用户输入的是"蛋糕"、"布丁"、"甜品"、"草莓"、"奶油"等甜品食材，请只能推荐甜品或烘焙类食品。绝对禁止将甜品食材与鸡蛋、肉类、蔬菜、米饭组合做成炒菜、炒蛋或粥（例如绝对不能出现"蛋糕炒蛋"、"蛋糕粥"、"布丁炒肉"、"草莓炒肉"这种荒谬菜品）。\n' +
    '第三步：对于"蛋糕"的特殊处理。蛋糕本身是成品。如果用户输入"蛋糕"，请推荐"奶油蛋糕"、"微波蛋糕"、"蒸蛋糕"、"海绵蛋糕"等合理做法，或者提示"可以直接食用，也可以搭配水果或奶油装饰"。绝对不要出现炒、炖、煮的咸味做法。\n' +
    '第四步：对于"甜品"大类的处理。如果用户输入的是"甜品"这种大类，请推荐各种具体的甜品，比如"焦糖布丁"、"双皮奶"、"小圆子"、"糖水"、"芋圆"、"红豆沙"等，并且生成的用料要非常细腻、真实（比如需要牛奶、糖、吉利丁片、红豆等）。\n' +
    '第五步：绝对禁止强行组合不合理食材。如果某两种食材放在一起不符合常理（比如草莓和猪肉，蛋糕和酱油，布丁和青椒），请拒绝生成，或者只生成符合常理的做法。\n' +
    '返回纯JSON格式，必须是一个对象，包含 extra_ingredients, recipes 两个字段；extra_ingredients 必须正好有 ' + extraCount + ' 个不含数量或备注的食材名字符串，recipes 必须是菜谱对象数组。每个菜谱对象包含 recipe_name, ingredients, steps, hint。\n' +
    '格式示例（仅假设原有食材为西红柿、鸡蛋，新增数量为2；必须以本次实际上下文为准）：{"extra_ingredients":["猪肉","土豆"],"recipes":[{"recipe_name":"西红柿炒肉","ingredients":["西红柿","猪肉","盐","食用油"],"steps":["..."],"hint":""},{"recipe_name":"土豆炒鸡蛋","ingredients":["土豆","鸡蛋","盐","食用油"],"steps":["..."],"hint":""}]}。不能只返回菜谱数组。\n' +
    'hint 字段说明：如果菜名比较笼统（比如"辣椒炒肉"、"炒青菜"、"炖肉"），请在 hint 字段里给出具体的食材建议，比如"辣椒选用青椒，肉选用猪肉或牛肉"。如果菜名已经很具体（比如"西红柿炒鸡蛋"、"奶油蛋糕"），hint 可以直接是空字符串。';

  return prompt;
}

// 「现在去做菜」的确定性份量计算：模型负责教学文字，克数先由服务端算好。
const RICE_MALE_GRAMS = 100;
const RICE_FEMALE_GRAMS = 80;
const DISH_FOOD_PER_PERSON_GRAMS = 260;
const SEASONING_WORDS = ['油', '盐', '糖', '醋', '酱油', '生抽', '老抽', '料酒', '蚝油', '淀粉', '胡椒', '鸡精', '味精', '孜然', '辣椒粉', '清水', '水', '姜', '蒜', '葱'];
const PROTEIN_WORDS = ['猪肉', '牛肉', '羊肉', '鸡肉', '鸭肉', '鱼', '虾', '蟹', '鸡蛋', '蛋', '豆腐', '培根', '火腿', '腊肉', '香肠'];

function ingredientText(item) {
  if (item && typeof item === 'object') return String(item.name || item.ingredient || item.label || '');
  return String(item == null ? '' : item);
}

function cleanIngredientName(value) {
  const cleaned = ingredientText(value).replace(/[（(].*?[）)]/g, '').replace(/\d+(?:\.\d+)?\s*(?:克|g|G)?/g, '').replace(/\s+/g, '').trim();
  const aliases = { 番茄: '西红柿', 西红柿: '西红柿', 青葱: '葱' };
  return aliases[cleaned] || cleaned;
}

function containsWord(name, words) {
  return words.some(function (word) { return name.indexOf(word) !== -1; });
}

function parseRecipeIngredientNames(recipe) {
  const raw = Array.isArray(recipe && recipe.ingredients) ? recipe.ingredients : [];
  const names = [];
  for (let i = 0; i < raw.length; i++) {
    const name = cleanIngredientName(raw[i]);
    if (name && names.indexOf(name) === -1) names.push(name);
  }
  return names.length > 0 ? names : ['主要食材'];
}

function parseGoldenRatio(recipe, names) {
  const source = [recipe && recipe.recipe_name, recipe && recipe.hint].concat(Array.isArray(recipe && recipe.ingredients) ? recipe.ingredients.map(ingredientText) : []).filter(Boolean).join(' ');
  const recipeName = String(recipe && recipe.recipe_name || '');
  const knownRatios = [
    { match: /青椒.*炒.*肉|青椒肉丝/, left: '青椒', right: '肉', weights: [5, 4] },
    { match: /西红柿.*炒.*鸡蛋|番茄.*炒.*鸡蛋/, left: '鸡蛋', right: '西红柿', weights: [4, 5] }
  ];
  for (let knownIndex = 0; knownIndex < knownRatios.length; knownIndex++) {
    const known = knownRatios[knownIndex];
    if (known.match.test(recipeName)) {
      const knownLeft = names.find(function (name) { return name.indexOf(known.left) !== -1; });
      const knownRight = names.find(function (name) { return name.indexOf(known.right) !== -1; });
      if (knownLeft && knownRight && knownLeft !== knownRight) {
        return { names: [knownLeft, knownRight], weights: known.weights, note: knownLeft + '与' + knownRight + '按接近' + known.weights[0] + ':' + known.weights[1] + '分配，允许少量误差' };
      }
    }
  }
  const ratioMatch = source.match(/([\u4e00-\u9fa5A-Za-z]{1,8})\s*(\d+(?:\.\d+)?)\s*[:：/]\s*(\d+(?:\.\d+)?)\s*([\u4e00-\u9fa5A-Za-z]{1,8})/);
  if (ratioMatch) {
    const left = names.find(function (name) { return name.indexOf(ratioMatch[1]) !== -1; });
    const right = names.find(function (name) { return name.indexOf(ratioMatch[4]) !== -1; });
    if (left && right && left !== right) {
      return { names: [left, right], weights: [Number(ratioMatch[2]), Number(ratioMatch[3])], note: left + '与' + right + '按接近' + ratioMatch[2] + ':' + ratioMatch[3] + '分配，允许少量误差' };
    }
  }
  const ratioOnly = source.match(/(\d+(?:\.\d+)?)\s*[:：/]\s*(\d+(?:\.\d+)?)/);
  const mainNames = names.filter(function (name) { return !containsWord(name, SEASONING_WORDS); });
  if (ratioOnly && mainNames.length >= 2) {
    return { names: mainNames.slice(0, 2), weights: [Number(ratioOnly[1]), Number(ratioOnly[2])], note: mainNames[0] + '与' + mainNames[1] + '按接近' + ratioOnly[1] + ':' + ratioOnly[2] + '分配，允许少量误差' };
  }
  return null;
}

function allocateRecipeIngredients(recipe, targetGrams) {
  const names = parseRecipeIngredientNames(recipe);
  const ratio = parseGoldenRatio(recipe, names);
  const weights = {};
  let fixedGrams = 0;
  const variableNames = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (containsWord(name, SEASONING_WORDS)) {
      const fixed = name.indexOf('油') !== -1 ? 20 : (name.indexOf('水') !== -1 ? 20 : 2);
      weights[name] = fixed;
      fixedGrams += fixed;
    } else {
      variableNames.push(name);
    }
  }

  const remaining = Math.max(variableNames.length, targetGrams - fixedGrams);
  if (ratio) {
    for (let i = 0; i < variableNames.length; i++) {
      const name = variableNames[i];
      const ratioIndex = ratio.names.indexOf(name);
      weights[name] = ratioIndex === -1 ? 1 : ratio.weights[ratioIndex];
    }
  } else {
    for (let i = 0; i < variableNames.length; i++) {
      weights[variableNames[i]] = containsWord(variableNames[i], PROTEIN_WORDS) ? 1.05 : 1;
    }
  }
  const variableTotal = variableNames.reduce(function (sum, name) { return sum + weights[name]; }, 0) || 1;
  const result = [];
  let allocated = 0;
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const grams = containsWord(name, SEASONING_WORDS) ? weights[name] : Math.max(1, Math.round(remaining * weights[name] / variableTotal));
    result.push({ name: name, grams: grams });
    allocated += grams;
  }
  const difference = Math.round(targetGrams - allocated);
  const adjustable = result.find(function (item) { return !containsWord(item.name, SEASONING_WORDS); }) || result[0];
  if (adjustable) adjustable.grams = Math.max(1, adjustable.grams + difference);
  return { ingredients: result, golden_ratio_note: ratio ? ratio.note : '按本道菜食材平均分配，兼顾主要食材比例，允许少量误差' };
}

function buildCookPlan(recipes, maleCount, femaleCount) {
  const safeMale = Math.max(0, Math.floor(Number(maleCount) || 0));
  const safeFemale = Math.max(0, Math.floor(Number(femaleCount) || 0));
  const totalPeople = safeMale + safeFemale;
  const dishCount = recipes.length;
  const riceGrams = safeMale * RICE_MALE_GRAMS + safeFemale * RICE_FEMALE_GRAMS;
  const peopleForPlan = Math.max(1, totalPeople);
  const dishTotalGrams = peopleForPlan * DISH_FOOD_PER_PERSON_GRAMS;
  const baseDishGrams = Math.max(1, Math.round(dishTotalGrams / dishCount));
  const plannedRecipes = [];
  const totalMap = {};
  let assignedDishTotal = 0;
  for (let i = 0; i < recipes.length; i++) {
    const recipe = recipes[i] || {};
    const targetGrams = i === recipes.length - 1 ? Math.max(1, dishTotalGrams - assignedDishTotal) : baseDishGrams;
    assignedDishTotal += targetGrams;
    const allocation = allocateRecipeIngredients(recipe, targetGrams);
    const planned = { recipe_name: String(recipe.recipe_name || ('第' + (i + 1) + '道菜')), target_grams: targetGrams, ingredients: allocation.ingredients, golden_ratio_note: allocation.golden_ratio_note };
    plannedRecipes.push(planned);
    for (let j = 0; j < planned.ingredients.length; j++) {
      const item = planned.ingredients[j];
      totalMap[item.name] = (totalMap[item.name] || 0) + item.grams;
    }
  }
  return {
    rice_grams: riceGrams,
    rice_male_grams: RICE_MALE_GRAMS,
    rice_female_grams: RICE_FEMALE_GRAMS,
    male_count: safeMale,
    female_count: safeFemale,
    total_people: totalPeople,
    dish_count: dishCount,
    target_satiety: '八分饱',
    dish_total_grams: dishTotalGrams,
    meal_target_grams: riceGrams + dishTotalGrams,
    meal_range_grams: [Math.round((riceGrams + dishTotalGrams) * 0.875), Math.round((riceGrams + dishTotalGrams) * 1.125)],
    recipes: plannedRecipes,
    total_ingredients: Object.keys(totalMap).map(function (name) { return { name: name, grams: totalMap[name] }; })
  };
}

function formatCookPlanForPrompt(plan) {
  let text = '后端本次请求已经计算好的份量（必须原样执行，不能重新估算）：\n';
  text += '米饭' + plan.rice_grams + '克（男生' + plan.rice_male_grams + '克/人，女生' + plan.rice_female_grams + '克/人）\n';
  text += '所有菜食材合计' + plan.dish_total_grams + '克；整餐目标' + plan.meal_target_grams + '克，允许范围' + plan.meal_range_grams[0] + '-' + plan.meal_range_grams[1] + '克。\n';
  for (let i = 0; i < plan.recipes.length; i++) {
    const recipe = plan.recipes[i];
    text += (i + 1) + '. ' + recipe.recipe_name + '（本道菜目标' + recipe.target_grams + '克；' + recipe.golden_ratio_note + '）：';
    text += recipe.ingredients.map(function (item) { return item.name + item.grams + '克'; }).join('、') + '\n';
  }
  return text;
}

// 拼「现在去做菜」用的提示词（BMI食材计算）
function buildCookPrompt(recipes, maleCount, femaleCount, cookPlan) {
  const totalPeople = maleCount + femaleCount;

  let prompt = '你是一位耐心的大厨，正在手把手教一个完全不会做菜的零基础小白。\n\n';
  prompt += '我准备做以下 ' + recipes.length + ' 道菜：\n\n';

  for (let i = 0; i < recipes.length; i++) {
    const recipe = recipes[i];
    const name = recipe.recipe_name || ('第' + (i + 1) + '道菜');
    prompt += (i + 1) + '. ' + name + '\n';
  }

  prompt += '\n就餐人数：男生 ' + maleCount + ' 人，女生 ' + femaleCount + ' 人（共 ' + totalPeople + ' 人）。\n\n';

  prompt += '【份量计算】根据本次请求中的男生人数、女生人数、菜品数量和每道菜原始 ingredients，按中国BMI八分饱的保守估算执行以下后端结果：' + formatCookPlanForPrompt(cookPlan) + '男生每人100克主食，女生每人80克主食；菜品之间不分主次，按菜品数量平均分配每道菜的食材总量；黄金比例只做接近调整，允许少量误差，但整餐必须保持在7分饱到9分饱，目标为八分饱。\n';
  prompt += '【硬性格式】所有食材都必须带克数；每道菜先输出一行“菜名：食材1 100克、食材2 50克……”，随后输出按顺序编号的步骤。每个步骤中涉及的食材都必须写明确克数，不能写“适量”“少许”“若干”“看个人口味”“加一点”或“适当增加”。\n';
  prompt += '【时间硬性规则】所有时间只能写成精确的整数秒，例如“搅拌60秒”“小火煎120秒”“焯水30秒”“焖煮180秒”；禁止使用“1-2分钟”“半分钟”“几分钟”“片刻”“一会儿”“差不多”、分钟、时间区间或任何模糊时长。\n';
  prompt += '【火候硬性规则】只能使用“大火”“中火”“小火”“关火余温”四种说法，禁止使用“中小火”“中大火”“7分火”“5成火”“小火偏中”“大火转中小火”或其他火候词。\n';
  prompt += '【输出格式】只输出教程纯文本，不要输出JSON或Markdown代码围栏。每道菜严格按以下结构输出：\n菜名：食材1 100克、食材2 50克\n【备菜环节】\n1. ...\n【烹饪环节】\n1. ...\n';
  prompt += '【教学要求】每一步都要适合零基础小白，并交代动作、明确克数、精确整数秒和允许的火候；备菜要写清楚数量、清洗、去蒂、切法、容器、搅拌和摆放；烹饪要写清楚锅是否烧干、火候、油量、等待秒数、食材状态、何时关火和装盘。不要输出营养分析、热量或与烹饪无关的内容。\n\n';

  prompt += '现在请为以下每道菜生成详细教程：\n\n';

  return prompt;
}

async function handleChat(req, res) {
  // --- 先检查 Key 有没有配好 ---
  if (API_KEY.trim() === '') {
    console.warn('[提醒] 没有找到 API Key：请在 .env 中填写 AI_API_KEY（兼容旧的 DEEPSEEK_API_KEY）');
    sendJson(res, 500, { error: '服务器还没有配置 API Key，请检查 .env 文件' });
    return;
  }

  // --- 读取并解析浏览器发来的内容 ---
  let parsed;
  try {
    const raw = await readRequestBody(req);
    parsed = JSON.parse(raw);
  } catch (err) {
    sendJson(res, 400, { error: '请求内容不是合法的 JSON' });
    return;
  }

  let messages;
  let cookPlan = null;

  if (parsed && parsed.action === 'cook') {
    // --- 用法 D：现在去做菜，BMI食材计算 ---
    const recipes = parsed.recipes;
    const maleCount = Number(parsed.maleCount) || 0;
    const femaleCount = Number(parsed.femaleCount) || 0;

    if (!Array.isArray(recipes) || recipes.length === 0) {
      sendJson(res, 400, { error: '缺少 recipes 字段或备菜清单为空' });
      return;
    }

    cookPlan = buildCookPlan(recipes, maleCount, femaleCount);
    messages = [{
      role: 'user',
      content: buildCookPrompt(recipes, maleCount, femaleCount, cookPlan),
    }];
    console.log('[现在去做菜] 备菜清单 ' + recipes.length + ' 道，男 ' + maleCount + ' 人，女 ' + femaleCount + ' 人');
  } else if (parsed && parsed.action === 'unlock') {
    // --- 用法 B：解锁更多菜谱，提示词在这里拼 ---
    const ingredients = parsed.ingredients;
    const extraCount = Number(parsed.extraCount);
    const excludeRecipes = parsed.excludeRecipes;
    const excludeIngredients = parsed.excludeIngredients;
    const allIngredients = parsed.allIngredients;

    if (!Array.isArray(ingredients) || ingredients.length === 0) {
      sendJson(res, 400, { error: '缺少 ingredients 字段' });
      return;
    }
    // 只接受 1~5。就算网页那边已经校验过，服务端也要自己再挡一次 ——
    // 这是唯一的可信边界，不能只依赖前端。
    if (!Number.isInteger(extraCount) || extraCount < 1 || extraCount > 5) {
      sendJson(res, 400, { error: 'extraCount 必须是 1 到 5 之间的整数' });
      return;
    }

    messages = [{
      role: 'user',
      content: buildUnlockPrompt(ingredients, extraCount, excludeRecipes, excludeIngredients, allIngredients),
    }];
    console.log('[解锁更多] 已有 ' + ingredients.length + ' 种食材，想额外买 ' + extraCount + ' 道');
  } else if (parsed && parsed.isMysteryMode === true) {
    /* --- 用法 C：随机寻味，提示词也在这里拼 ---
       这一支要放在「普通推荐」前面，否则前端拼的那份普通提示词会先把它顶掉。
       注意空食材是合法的：什么食材都没有也照样能随机推荐，所以这里不做非空校验。 */
    const ingredients = Array.isArray(parsed.ingredients) ? parsed.ingredients : [];
    const hasSeasonings = parsed.hasSeasonings === true;
    // 最低星级，0 或没传都表示「用户没设星级」
    const minStars = Number(parsed.minStars) || 0;

    messages = [{
      role: 'user',
      content: buildMysteryPrompt(ingredients, hasSeasonings, minStars),
    }];
    console.log('[随机寻味] 食材 ' + ingredients.length + ' 种' +
      (ingredients.length > 0 ? '（' + joinChineseList(ingredients) + '）' : '（无）') +
      '，最低星级 ' + (minStars > 0 ? minStars + ' 星' : '未设置'));
  } else {
    // --- 用法 A：普通推荐，前端把整段 messages 发过来，原样转发 ---
    messages = parsed && parsed.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      sendJson(res, 400, { error: '缺少 messages 字段' });
      return;
    }
  }

  // --- 交给配置的 AI 服务 ---
  try {
    const content = await callDeepSeek(messages, CHAT_TIMEOUT);
    console.log('[推荐菜谱] 成功，返回 ' + content.length + ' 个字');
    if (cookPlan) {
      sendJson(res, 200, { content: content, cookPlan: cookPlan });
    } else {
      sendJson(res, 200, { content: content });
    }
  } catch (err) {
    // 不管是断网、超时还是接口报错，一律回一句正经的 JSON，
    // 绝不让异常跑出去把服务器弄崩
    console.warn('[推荐菜谱] 失败：' + describeError(err));
    sendJson(res, 502, { error: '网络异常' });
  }
}

/* ============================================================
   六、/api/vision —— 识别图片里的食材
   ------------------------------------------------------------
   浏览器发来： { "image": "data:image/jpeg;base64,xxxx" }
   服务器返回： { "ingredients": ["西红柿", "鸡蛋"] }
   出问题时返回：{ "error": "原因" }
   ============================================================ */
async function handleVision(req, res) {
  if (API_KEY.trim() === '') {
    console.warn('[提醒] 没有找到 API Key：请在 .env 中填写 AI_API_KEY（兼容旧的 DEEPSEEK_API_KEY）');
    sendJson(res, 500, { error: '服务器还没有配置 API Key，请检查 .env 文件' });
    return;
  }

  // --- 读取并解析浏览器发来的内容 ---
  let image;
  try {
    const raw = await readRequestBody(req);
    const parsed = JSON.parse(raw);
    image = parsed && parsed.image;
  } catch (err) {
    sendJson(res, 400, { error: '请求内容不是合法的 JSON' });
    return;
  }

  if (typeof image !== 'string' || image.trim() === '') {
    sendJson(res, 400, { error: '缺少 image 字段' });
    return;
  }

  // --- 组装兼容接口的“图片 + 文字”格式 ---
  const messages = [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: image } },
      { type: 'text', text: PROMPT_RECOGNIZE },
    ],
  }];

  try {
    const content = await callDeepSeek(messages, VISION_TIMEOUT, 'vision');

    // 模型可能把 JSON 包在 ```json 里，也可能前后加一句客套话，所以洗一洗
    const ingredients = parseIngredientArray(content);

    if (ingredients.length === 0) {
      console.warn('[识别食材] 没能从回复里解析出食材：' + content.slice(0, 200));
      sendJson(res, 502, { error: '识别失败' });
      return;
    }

    console.log('[识别食材] 成功，识别到：' + ingredients.join('、'));
    sendJson(res, 200, { ingredients: ingredients });
  } catch (err) {
    console.warn('[识别食材] 失败：' + describeError(err));
    sendJson(res, 502, { error: '网络异常' });
  }
}

/* ============================================================
   七、小工具
   ============================================================ */

// 把错误整理成一句能看懂的话，方便看日志
function describeError(err) {
  if (!err) return '未知错误';
  if (err.name === 'AbortError') return '等待 AI 服务超时';
  if (err.message === 'fetch failed') {
    // Node 的网络错误详情藏在 err.cause 里，打出来才知道是 DNS 挂了还是断网了
    const cause = err.cause ? ('（' + (err.cause.code || err.cause.message) + '）') : '';
    return '连不上 AI 服务' + cause;
  }
  return err.message;
}

// 从模型回复里抠出食材数组。
// 兜底原因：模型很可能返回 ```json [...] ```，也可能带一句“好的，识别结果：”
function parseIngredientArray(text) {
  if (typeof text !== 'string') return [];

  // 1. 去掉 ``` 和 ```json 这类围栏
  const cleaned = text.replace(/```[a-zA-Z]*/g, '').trim();

  // 2. 先赌它本身就是干净的数组
  let json = tryParse(cleaned);

  // 3. 不行就截取最外层的 [ ... ]
  if (!Array.isArray(json)) {
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start !== -1 && end > start) {
      json = tryParse(cleaned.slice(start, end + 1));
    }
  }

  if (!Array.isArray(json)) return [];

  // 4. 逐个清洗成不重复的字符串
  const result = [];
  for (const item of json) {
    let name = typeof item === 'string'
      ? item
      : (item && item.name ? String(item.name) : '');   // 万一返回 {name:"西红柿"} 也认
    name = name.trim();
    if (name !== '' && result.indexOf(name) === -1) {
      result.push(name);
    }
  }
  return result;
}

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    return undefined;
  }
}

/* ============================================================
   八、启动服务器
   ============================================================ */

// 兜底保护：就算真的还有漏网的异常，也只打印出来，不让整个进程退出。
// （正常情况根本走不到这里，前面每处都已经 try/catch 过了）
process.on('unhandledRejection', (reason) => {
  console.warn('[未处理的异步异常，已忽略] ' + describeError(reason));
});
process.on('uncaughtException', (err) => {
  console.warn('[未捕获的异常，已忽略] ' + describeError(err));
});

const server = http.createServer((req, res) => {
  // 网页提前断开连接时（比如网页那边等超时了），连接会报 ECONNRESET。
  // 不接住这个错，Node 会把它当成未捕获异常，整个服务器就退出了 ——
  // 这正是「点了没反应」的根源之一，所以必须监听。
  req.on('error', (err) => {
    console.warn('[连接中断] ' + describeError(err));
  });
  res.on('error', (err) => {
    console.warn('[回复中断] ' + describeError(err));
  });

  const pathname = req.url.split('?')[0];

  // --- 两个要花钱的接口，先过一遍频率限制 ---
  if (req.method === 'POST' && (pathname === '/api/chat' || pathname === '/api/vision')) {
    const ip = getClientIp(req);
    const limit = checkRateLimit(ip);

    if (!limit.allowed) {
      console.warn('[限流] ' + ip + ' 一分钟内请求超过 ' + RATE_LIMIT_MAX + ' 次，已拒绝');
      if (!res.headersSent) {
        res.setHeader('Retry-After', String(limit.retryAfterSec));
      }
      sendJson(res, 429, { error: '请求太频繁，请稍后再试', retryAfterSec: limit.retryAfterSec });
      return;
    }

    // 再用一层 try/catch 包住，确保这两个处理函数内部再怎么出意外都只影响这一次请求
    const handler = pathname === '/api/vision' ? handleVision : handleChat;
    handler(req, res).catch((err) => {
      console.warn('[接口异常] ' + describeError(err));
      sendJson(res, 500, { error: '网络异常' });
    });
    return;
  }

  if (req.method === 'GET') {
    serveStaticFile(req, res);
    return;
  }

  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('405 不支持的请求方式');
});

server.listen(PORT, () => {
  console.log('========================================');
  console.log('  冰箱盲盒大厨 后端已启动');
  console.log('  请在浏览器打开： http://localhost:' + PORT);
  console.log('  API Key 状态： ' + (API_KEY.trim() === '' ? '❌ 未配置（请检查 .env）' : '✅ 已读取配置'));
  console.log('  文字模型： ' + AI_CHAT_MODEL + '；识图模型： ' + AI_VISION_MODEL);
  console.log('  接口：/api/chat（推荐菜谱）、/api/vision（识别食材）');
  console.log('  限流：每个 IP 每分钟最多 ' + RATE_LIMIT_MAX + ' 次');
  console.log('  停止服务器：在这个窗口按 Ctrl + C');
  console.log('========================================');
});
