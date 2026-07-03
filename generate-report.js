// AI日报自动生成脚本 - 独立运行，无需 Claude Code
// 用法: node generate-report.js
// 如果带 --now 参数则立即生成，否则等待到 8:30

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ========== 配置 ==========
const CONFIG = {
  apiBase: 'api.deepseek.com',
  apiPath: '/anthropic/v1/messages',
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN || '',
  model: 'deepseek-v4-pro',
  outputDir: __dirname,
  maxTokens: 32000,
  targetHour: 8,
  targetMinute: 30,
};

// ========== 工具函数 ==========
function getDateInfo() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return {
    y, m, day,
    filename: `${y}${m}${day}`,
    display: `${y}年${m}月${day}日`,
    weekday: ['日', '一', '二', '三', '四', '五', '六'][d.getDay()],
  };
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
  });
}

function extractRssItems(xml) {
  const items = [];
  // 简单解析 RSS/Atom - 匹配 <item> 或 <entry>
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  const titleRegex = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i;
  const linkRegex = /<link(?:[^>]*)?>([\s\S]*?)<\/link>/i;
  const linkHrefRegex = /<link[^>]*href="([^"]*)"/i;
  const descRegex = /<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i;

  const regex = xml.includes('<entry>') ? entryRegex : itemRegex;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const block = match[1];
    let title = (block.match(titleRegex) || [])[1] || '';
    let link = (block.match(linkRegex) || [])[1] || (block.match(linkHrefRegex) || [])[1] || '';
    let desc = (block.match(descRegex) || [])[1] || '';
    // 清理 HTML 标签
    title = title.replace(/<[^>]*>/g, '').trim();
    desc = desc.replace(/<[^>]*>/g, '').trim().substring(0, 300);
    if (title) items.push({ title, link, desc });
  }
  return items;
}

async function fetchAINews() {
  const feeds = [
    { name: 'Hacker News AI', url: 'https://hnrss.org/frontpage?count=10&q=ai+OR+llm+OR+openai+OR+anthropic+OR+model+OR+gpt+OR+claude' },
    { name: 'Hacker News Show', url: 'https://hnrss.org/frontpage?count=5' },
    { name: 'TechCrunch AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
    { name: 'The Verge AI', url: 'https://www.theverge.com/ai-artificial-intelligence/rss/index.xml' },
  ];

  const allItems = [];
  for (const feed of feeds) {
    try {
      const xml = await httpGet(feed.url);
      const items = extractRssItems(xml);
      items.forEach(item => {
        item.source = feed.name;
        allItems.push(item);
      });
    } catch (e) {
      console.log(`  ⚠ 未能获取 ${feed.name}: ${e.message}`);
    }
  }

  // 去重（基于 title 相似度）
  const unique = [];
  const seen = new Set();
  for (const item of allItems) {
    const key = item.title.substring(0, 80);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }

  console.log(`  获取到 ${unique.length} 条新闻（${allItems.length} 条原始）`);
  return unique;
}

function callLLM(systemPrompt, userPrompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: CONFIG.model,
      max_tokens: CONFIG.maxTokens,
      system: [{ type: 'text', text: systemPrompt }],
      messages: [{ role: 'user', content: userPrompt }],
    });

    const req = https.request({
      hostname: CONFIG.apiBase,
      path: CONFIG.apiPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.apiKey}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'messages-2023-12-15',
      },
      timeout: 300000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 300)}`));
          return;
        }
        try {
          const content = JSON.parse(data).content || [];
          const textBlock = content.find(c => c.type === 'text');
          resolve(textBlock?.text || '');
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() { this.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

// ========== 主逻辑 ==========
async function generateReport() {
  const { filename, display, weekday } = getDateInfo();
  const outputFile = path.join(CONFIG.outputDir, `${filename}-AI日报.md`);

  if (fs.existsSync(outputFile)) {
    console.log(`今日日报已存在: ${outputFile}`);
    return;
  }

  console.log(`\n🌅 开始生成 ${display}（星期${weekday}）AI日报...\n`);
  console.log('📡 正在抓取 AI 新闻...');
  const newsItems = await fetchAINews();

  // 构建新闻摘要供 LLM 使用
  const newsDigest = newsItems.slice(0, 30).map((item, i) =>
    `${i + 1}. [${item.source}] ${item.title}\n   ${item.link}\n   ${item.desc}`
  ).join('\n\n');

  const systemPrompt = `你是一个专业的AI日报编辑。你需要根据用户提供的当日AI新闻素材，筛选重要内容并生成一份高质量的AI日报。

格式要求（严格按以下结构输出 Markdown）：
# 🌅 AI 日报 — ${display}（星期${weekday}）
> **Enjoy the News itself. Leave others to Horizon.**
---
## 📊 今日速览
## 🔥 今日头条
（筛选2-3条最重要的新闻深入报道，每条带⭐ 0-10评分、来源标注）
## 🧪 模型与技术
## 💾 硬件与基础设施
## 📋 政策与监管
## 🔓 开源与工具
## 📈 今日评分排行
（表格：排名 | 新闻 | 评分 | 领域）
## 🔍 今日关键词
（\`关键词\` 形式）
## 💬 社区热议
（基于新闻内容模拟社区评论，标注平台如 HN/Reddit/Twitter）
## 📌 趋势观察
（3-5条趋势分析）
---
> 📅 生成时间：${display} | 🤖 自动生成
> ⚠️ 声明：本日报由 AI 自动聚合生成，评分为主观参考，不构成投资建议。

重要规则：
1. 筛选最有价值的新闻（目标10-15条），不要逐条罗列所有素材
2. 每条新闻给出合理的 0-10 评分
3. 突出 AI 行业趋势和影响
4. 全部中文输出，不要英文
5. 直接输出完整 Markdown，不要加"以下是日报"之类的废话`;

  const userPrompt = `以下是今日（${display}）全球AI领域的新闻素材，请筛选、整理并生成完整的AI日报。

注意：
- 这些素材来自英文 RSS 源，请翻译为中文
- 如果素材不足或时效性不好，请运用你对AI行业的了解补充合理的内容
- 确保最终日报不少于10条新闻

=== 新闻素材 ===

${newsDigest}

=== 结束 ===

请直接输出完整日报。`;

  console.log('🤖 正在用 AI 生成日报...');
  const content = await callLLM(systemPrompt, userPrompt);

  if (!content) {
    console.error('❌ API 返回空内容');
    return;
  }

  fs.writeFileSync(outputFile, content.trim() + '\n', 'utf-8');
  console.log(`\n✅ 日报生成成功: ${outputFile}`);
  console.log(`   大小: ${(fs.statSync(outputFile).size / 1024).toFixed(1)} KB\n`);
}

// ========== 调度逻辑 ==========
function msUntil(hour, minute) {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target - now;
}

// ========== 入口 ==========
const args = process.argv.slice(2);

if (args.includes('--now') || args.includes('-n')) {
  // 立即生成
  generateReport().catch(err => {
    console.error(`❌ 生成失败: ${err.message}`);
    process.exit(1);
  });
} else if (args.includes('--schedule') || args.includes('-s')) {
  // 常驻模式：等到 8:30 生成，然后退出
  const wait = msUntil(CONFIG.targetHour, CONFIG.targetMinute);
  const targetTime = new Date(Date.now() + wait);
  console.log(`⏰ 将在 ${targetTime.toLocaleString('zh-CN')} 自动生成 AI 日报（等待 ${Math.round(wait / 60000)} 分钟）...`);
  console.log('   （保持此窗口打开，到时间会自动执行）\n');

  setTimeout(() => {
    generateReport().catch(err => {
      console.error(`❌ 生成失败: ${err.message}`);
    }).finally(() => {
      console.log('任务完成，窗口即将关闭。');
      process.exit(0);
    });
  }, wait);
} else {
  // 默认：显示帮助
  console.log(`
🌅 AI日报自动生成工具
━━━━━━━━━━━━━━━━━━━━━━━━━━━
用法:
  node generate-report.js --now      立即生成今天的日报
  node generate-report.js --schedule 等到 8:30 自动生成

输出目录: ${CONFIG.outputDir}
文件格式: YYYYMMDD-AI日报.md
`);
}
