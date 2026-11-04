const express = require('express');
const Parser = require('rss-parser');
const Database = require('better-sqlite3');
const crypto = require('node:crypto');
const path = require('node:path');

const app = express();
const port = Number(process.env.PORT || 3000);
const db = new Database(process.env.DB_PATH || path.join(__dirname, 'daily-rss.sqlite'));
const parser = new Parser({ timeout: 15000, headers: { 'User-Agent': 'DailyRSS/1.0 (+RSS reader)' } });
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS feeds (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, url TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL DEFAULT '综合', enabled INTEGER NOT NULL DEFAULT 1,
    last_fetched_at TEXT, last_error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS articles (
    id TEXT PRIMARY KEY, feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
    title TEXT NOT NULL, url TEXT NOT NULL, author TEXT, summary TEXT, content TEXT,
    published_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(feed_id, url)
  );
  CREATE TABLE IF NOT EXISTS article_state (
    article_id TEXT PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
    is_read INTEGER NOT NULL DEFAULT 0, is_favorite INTEGER NOT NULL DEFAULT 0,
    ai_summary TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS articles_published_idx ON articles(published_at DESC);
`);

const defaults = [
  ['Andrej Karpathy 精选', 'https://youmind.com/rss/pack/andrej-karpathy-curated-rss', 'AI'],
  ['TLDR AI', 'https://tldr.tech/api/rss/ai', 'AI'],
  ['The Rundown AI', 'https://rss.beehiiv.com/feeds/2R3C6Bt5wj.xml', 'AI'],
  ['Hacker News', 'https://hnrss.org/frontpage', '开发'],
  ['GitHub Trending', 'https://github-trends-atom.vercel.app/trending', '开源'],
  ['MIT Technology Review AI', 'https://www.technologyreview.com/topic/artificial-intelligence/feed/', '行业'],
  ['WIRED AI', 'https://www.wired.com/feed/tag/ai/latest/rss', '行业'],
  ['Ars Technica AI', 'https://arstechnica.com/ai/feed/', '行业'],
  ['TechCrunch AI', 'https://techcrunch.com/category/artificial-intelligence/feed/', '行业'],
  ['Hugging Face Blog', 'https://huggingface.co/blog/feed.xml', '研究'],
  ['InfoQ AI/ML', 'https://feed.infoq.com/ai-ml-data-eng/', '开发'],
  ['Ahead of AI', 'https://magazine.sebastianraschka.com/feed', '研究']
];
const insertFeed = db.prepare('INSERT OR IGNORE INTO feeds(title,url,category) VALUES(?,?,?)');
for (const feed of defaults) insertFeed.run(...feed);

const cleanHtml = (value = '') => String(value).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonicalUrl = (value) => {
  try { const u = new URL(value); u.hash = ''; ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','fbclid','gclid'].forEach(k => u.searchParams.delete(k)); return u.toString(); }
  catch { return value; }
};

async function refreshFeed(feed) {
  try {
    const parsed = await parser.parseURL(feed.url);
    const insert = db.prepare(`INSERT OR IGNORE INTO articles(id,feed_id,title,url,author,summary,content,published_at) VALUES(?,?,?,?,?,?,?,?)`);
    const tx = db.transaction(items => {
      for (const item of items) {
        const url = canonicalUrl(item.link || item.guid || '');
        if (!url) continue;
        const text = cleanHtml(item.contentSnippet || item.summary || item.content || item['content:encoded'] || '');
        insert.run(hash(url), feed.id, cleanHtml(item.title || '无标题').slice(0, 500), url,
          cleanHtml(item.creator || item.author || ''), text.slice(0, 12000), text.slice(0, 30000), item.isoDate || item.pubDate || null);
      }
    });
    tx(parsed.items || []);
    db.prepare('UPDATE feeds SET title=CASE WHEN title=? THEN COALESCE(?,title) ELSE title END,last_fetched_at=?,last_error=NULL WHERE id=?')
      .run(feed.url, cleanHtml(parsed.title || '') || null, new Date().toISOString(), feed.id);
    return { id: feed.id, ok: true, count: (parsed.items || []).length };
  } catch (error) {
    db.prepare('UPDATE feeds SET last_fetched_at=?,last_error=? WHERE id=?').run(new Date().toISOString(), String(error.message).slice(0, 300), feed.id);
    return { id: feed.id, ok: false, error: String(error.message).slice(0, 200) };
  }
}
async function refreshAll() { return Promise.all(db.prepare('SELECT * FROM feeds WHERE enabled=1').all().map(refreshFeed)); }

function aiConfigured() { return Boolean(process.env.AI_API_KEY); }
async function askAI(prompt) {
  if (!aiConfigured()) throw new Error('尚未配置 AI_API_KEY。请在服务端配置 OpenAI 兼容 API 密钥。');
  const base = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const response = await fetch(`${base}/chat/completions`, { method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.AI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.AI_MODEL || 'gpt-4o-mini', messages: [
      { role: 'system', content: '你是专业的中文科技资讯编辑。仅根据提供的文章内容总结，不要编造事实，表达简洁。' },
      { role: 'user', content: prompt }
    ], temperature: 0.3 })
  });
  if (!response.ok) throw new Error(`AI 服务返回 HTTP ${response.status}`);
  return (await response.json()).choices?.[0]?.message?.content?.trim() || '暂时无法生成摘要。';
}

app.get('/api/health', (_req, res) => res.json({ ok: true, aiConfigured: aiConfigured() }));
app.get('/api/feeds', (_req, res) => res.json(db.prepare('SELECT f.*,COUNT(a.id) AS article_count FROM feeds f LEFT JOIN articles a ON a.feed_id=f.id GROUP BY f.id ORDER BY f.category,f.title').all()));
app.post('/api/feeds', (req, res) => {
  const { title, url, category = '综合' } = req.body || {};
  try {
    if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: '请输入有效的 http(s) RSS 地址。' });
    const result = db.prepare('INSERT INTO feeds(title,url,category) VALUES(?,?,?)').run(String(title || url).slice(0,200), url, String(category).slice(0,60));
    res.status(201).json(db.prepare('SELECT * FROM feeds WHERE id=?').get(result.lastInsertRowid));
  } catch (error) { res.status(409).json({ error: error.message.includes('UNIQUE') ? '这个 RSS 地址已经添加。' : error.message }); }
});
app.delete('/api/feeds/:id', (req, res) => { const r=db.prepare('DELETE FROM feeds WHERE id=?').run(Number(req.params.id)); res.status(r.changes?204:404).end(); });
app.post('/api/feeds/:id/refresh', async (req, res) => {
  const feed=db.prepare('SELECT * FROM feeds WHERE id=?').get(Number(req.params.id));
  if(!feed)return res.status(404).json({error:'未找到来源。'}); res.json(await refreshFeed(feed));
});
app.post('/api/refresh', async (_req,res)=>res.json({results:await refreshAll()}));
app.get('/api/articles', (req,res)=>{
  const clauses=[],args=[];
  if(req.query.from){clauses.push('COALESCE(a.published_at,a.created_at)>=?');args.push(String(req.query.from));}
  if(req.query.to){clauses.push('COALESCE(a.published_at,a.created_at)<=?');args.push(`${req.query.to}T23:59:59.999Z`);}
  if(req.query.feed){clauses.push('a.feed_id=?');args.push(Number(req.query.feed));}
  if(req.query.favorite==='1')clauses.push('COALESCE(s.is_favorite,0)=1');
  if(req.query.unread==='1')clauses.push('COALESCE(s.is_read,0)=0');
  if(req.query.q){clauses.push('(a.title LIKE ? OR a.summary LIKE ? OR f.title LIKE ?)');const q=`%${String(req.query.q).slice(0,100)}%`;args.push(q,q,q);}
  const where=clauses.length?`WHERE ${clauses.join(' AND ')}`:'';
  const limit=Math.min(100,Math.max(1,Number(req.query.limit)||50)),offset=Math.max(0,Number(req.query.offset)||0);
  res.json(db.prepare(`SELECT a.id,a.feed_id,a.title,a.url,a.author,a.summary,a.published_at,f.title AS feed_title,f.category,COALESCE(s.is_read,0) AS is_read,COALESCE(s.is_favorite,0) AS is_favorite,s.ai_summary FROM articles a JOIN feeds f ON f.id=a.feed_id LEFT JOIN article_state s ON s.article_id=a.id ${where} ORDER BY COALESCE(a.published_at,a.created_at) DESC LIMIT ? OFFSET ?`).all(...args,limit,offset));
});
app.patch('/api/articles/:id/state',(req,res)=>{
  const article=db.prepare('SELECT id FROM articles WHERE id=?').get(req.params.id);if(!article)return res.status(404).json({error:'未找到文章。'});
  const {is_read,is_favorite}=req.body||{};
  db.prepare(`INSERT INTO article_state(article_id,is_read,is_favorite) VALUES(?,?,?) ON CONFLICT(article_id) DO UPDATE SET is_read=COALESCE(?,is_read),is_favorite=COALESCE(?,is_favorite),updated_at=CURRENT_TIMESTAMP`)
    .run(article.id,Number(Boolean(is_read)),Number(Boolean(is_favorite)),is_read==null?null:Number(Boolean(is_read)),is_favorite==null?null:Number(Boolean(is_favorite)));
  res.json(db.prepare('SELECT * FROM article_state WHERE article_id=?').get(article.id));
});
app.post('/api/articles/:id/summarize',async(req,res)=>{
  const article=db.prepare('SELECT * FROM articles WHERE id=?').get(req.params.id);if(!article)return res.status(404).json({error:'未找到文章。'});
  try{const summary=await askAI(`请用中文为这篇文章写 2-3 句摘要，并列出一个值得关注的要点。\n标题：${article.title}\n正文摘要：${article.content||article.summary||'无'}`);
    db.prepare('INSERT INTO article_state(article_id,ai_summary) VALUES(?,?) ON CONFLICT(article_id) DO UPDATE SET ai_summary=excluded.ai_summary,updated_at=CURRENT_TIMESTAMP').run(article.id,summary);res.json({summary});
  }catch(error){res.status(503).json({error:error.message});}
});
app.post('/api/briefing',async(_req,res)=>{
  const articles=db.prepare(`SELECT a.title,a.url,a.summary,f.title AS source FROM articles a JOIN feeds f ON f.id=a.feed_id WHERE COALESCE(a.published_at,a.created_at)>=datetime('now','-1 day') ORDER BY COALESCE(a.published_at,a.created_at) DESC LIMIT 35`).all();
  if(!articles.length)return res.status(404).json({error:'最近 24 小时还没有文章，请先刷新 RSS 来源。'});
  try{const digest=articles.map((a,i)=>`${i+1}. ${a.title}（${a.source}）\n${a.summary}\n链接：${a.url}`).join('\n\n');
    const briefing=await askAI(`根据以下最近 24 小时的资讯，生成中文每日简报。按主题归纳 3-6 个要点，指出趋势，末尾列出 5 条值得优先阅读的原文链接。不要添加材料中没有的事实。\n\n${digest}`);
    res.json({briefing,generatedAt:new Date().toISOString(),articleCount:articles.length});
  }catch(error){res.status(503).json({error:error.message});}
});
app.get('*',(_req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(port,()=>{console.log(`Daily RSS listening on http://localhost:${port}`);if(process.env.AUTO_REFRESH!=='false')refreshAll().catch(console.error);setInterval(()=>refreshAll().catch(console.error),Number(process.env.REFRESH_INTERVAL_MS||15*60*1000));});
