import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import Database from 'better-sqlite3';
import Stripe from 'stripe';

const app = express();
app.use(cors());
app.use(express.json({limit:'1mb'}));

const PORT = process.env.PORT || 8787;
const DB_PATH = process.env.DB_PATH || './jane.sqlite';
const PROVIDER_API_KEY = process.env.PROVIDER_API_KEY || '';
const PROVIDER_BASE_URL = process.env.PROVIDER_BASE_URL || 'https://api.openai.com/v1';
const PROVIDER_MODEL = process.env.PROVIDER_MODEL || 'gpt-4o-mini';

const db = new Database(DB_PATH);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY||'', { apiVersion: '2024-06-20' });
db.pragma('journal_mode = WAL');

db.prepare(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, created_at INTEGER)`).run();
db.prepare(`CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, created_at INTEGER)`).run();
db.prepare(`CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conv_id TEXT, role TEXT, content TEXT, created_at INTEGER)`).run();
db.prepare(`CREATE TABLE IF NOT EXISTS licenses (user_id TEXT PRIMARY KEY, status TEXT, current_period_end INTEGER, product TEXT, updated_at INTEGER)`).run();

const packs = {
  standard: "You are Jane, an empathetic ADHD-friendly assistant. Be concise, stepwise, and strengths-based. Offer CBT/DBT micro-skills. Never diagnose. Redirect crisis language to appropriate supports (Canada 9-8-8; First Nations & Inuit Hope for Wellness 1-855-242-3310).",
  firstNations_traumaInformed: "You are Jane, trauma-informed and culturally respectful. Acknowledge historical context, avoid pathologizing, invite consent/choice, offer CBT/DBT micro-skills, and suggest community/kinship supports if invited. Never diagnose. Redirect crisis language to supports (Canada 9-8-8; Hope for Wellness 1-855-242-3310)."
};

const crisisRegex = /(suicide|kill myself|kill (him|her|them)|end my life|self[- ]?harm|overdose|can't go on|i want to die)/i;
const piiScrub = s => s.replace(/\b[\w.-]+@[\w.-]+\.\w+\b/g,"[email]").replace(/\b\+?\d[\d\s().-]{7,}\b/g,"[phone]");
const uid = () => Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);

const client = new OpenAI({ apiKey: PROVIDER_API_KEY, baseURL: PROVIDER_BASE_URL });

app.get('/health', (req,res)=> res.json({ok:true, time: Date.now()}));
app.get('/packs', (req,res)=> res.json({packs: Object.keys(packs)}));
app.get('/history', (req,res)=>{
  const userId = (req.query.userId||'').trim();
  if(!userId) return res.status(400).json({error:'userId required'});
  const conv = db.prepare('SELECT * FROM conversations WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(userId);
  if(!conv) return res.json({messages:[]});
  const msgs = db.prepare('SELECT role,content,created_at FROM messages WHERE conv_id=? ORDER BY created_at ASC').all(conv.id);
  res.json({convId: conv.id, messages: msgs});
});

app.post('/chat', async (req, res)=>{
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const { userId='local-user', pack='standard', messages=[] } = req.body||{};
  const now = Date.now();
  const conv = db.prepare('SELECT id FROM conversations WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(userId);
  const convId = conv?.id || uid();
  if(!conv){ db.prepare('INSERT INTO conversations(id,user_id,title,created_at) VALUES(?,?,?,?)').run(convId, userId, 'General', now); }
  const sanitized = messages.map(m=> ({ role: m.role, content: piiScrub(m.content||'') }));
  const risk = sanitized.some(m=> crisisRegex.test(m.content||''));

  if(risk){
    const safe = "I’m really glad you told me. I can’t provide emergency care, but you deserve support. In Canada, call or text 9‑8‑8. First Nations & Inuit Hope for Wellness: 1‑855‑242‑3310 (24/7). If you’re in immediate danger, call 911.";
    db.prepare('INSERT INTO messages(id,conv_id,role,content,created_at) VALUES(?,?,?,?,?)').run(uid(), convId, 'assistant', safe, now+1);
    res.write(`data: ${JSON.stringify({delta:safe})}\n\n`);
    return res.end("data: [DONE]\n\n");
  }

  if(messages.length){
    const last = messages[messages.length-1];
    db.prepare('INSERT INTO messages(id,conv_id,role,content,created_at) VALUES(?,?,?,?,?)').run(uid(), convId, last.role, last.content, now);
  }

  try{
    const stream = await client.chat.completions.create({
      model: PROVIDER_MODEL,
      stream: true,
      messages: [{role:'system', content: packs[pack]||packs.standard}, ...sanitized]
    });
    let full="";
    for await(const part of stream){
      const delta = part.choices?.[0]?.delta?.content || "";
      if(delta){ full+=delta; res.write(`data: ${JSON.stringify({delta})}\n\n`); }
    }
    db.prepare('INSERT INTO messages(id,conv_id,role,content,created_at) VALUES(?,?,?,?,?)').run(uid(), convId, 'assistant', full, now+2);
    res.end("data: [DONE]\n\n");
  }catch(e){
    res.write(`data: ${JSON.stringify({delta:'I’m having trouble connecting right now. Let’s pick one small next step together.'})}\n\n`);
    res.end("data: [DONE]\n\n");
  }
});

app.listen(PORT, ()=> console.log('Jane proxy listening on', PORT));

function upsertLicense(userId, status, current_period_end, product){
  db.prepare('INSERT INTO licenses(user_id,status,current_period_end,product,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET status=excluded.status,current_period_end=excluded.current_period_end,product=excluded.product,updated_at=excluded.updated_at')
    .run(userId, status, current_period_end||0, product||'', Date.now());
}

app.get('/license', (req,res)=>{
  const userId = (req.query.userId||'').trim();
  if(!userId) return res.status(400).json({error:'userId required'});
  const row = db.prepare('SELECT status,current_period_end,product FROM licenses WHERE user_id=?').get(userId);
  res.json({ userId, active: row? row.status==='active' : false, status: row?.status||'none', current_period_end: row?.current_period_end||0, product: row?.product||null });
});

app.post('/stripe/create-checkout-session', async (req,res)=>{
  try{
    const { userId, priceId, successUrl, cancelUrl } = req.body||{};
    if(!userId || !priceId) return res.status(400).json({error:'userId and priceId required'});
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      success_url: successUrl || 'http://localhost:8787/success',
      cancel_url: cancelUrl || 'http://localhost:8787/cancel',
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { userId }
    });
    res.json({ url: session.url });
  }catch(e){ res.status(500).json({error:'stripe_error'}); }
});

app.post('/stripe/webhook', express.raw({type:'application/json'}), async (req,res)=>{
  const sig = req.headers['stripe-signature']; let event;
  try{
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET||'');
  }catch(e){ return res.status(400).send(`Webhook Error: ${e.message}`); }
  try{
    if(event.type==='checkout.session.completed'){
      const s = event.data.object;
      const subId = s.subscription;
      const userId = s.metadata?.userId || 'unknown';
      if(subId){
        const sub = await stripe.subscriptions.retrieve(subId);
        upsertLicense(userId, sub.status, sub.current_period_end*1000, sub.items?.data?.[0]?.price?.id || '');
      }
    }else if(event.type==='customer.subscription.updated' || event.type==='customer.subscription.deleted'){
      const sub = event.data.object;
      const userId = sub.metadata?.userId || 'unknown';
      upsertLicense(userId, sub.status, sub.current_period_end*1000, sub.items?.data?.[0]?.price?.id || '');
    }
  }catch(e){ /* no-op */ }
  res.json({received:true});
});


// ---- Stripe Customer Portal ----
app.post('/stripe/create-portal-session', async (req, res)=>{
  try{
    const { customerId, returnUrl } = req.body||{};
    if(!customerId) return res.status(400).json({error:'customerId required'});
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl || (process.env.CLIENT_URL || 'http://localhost:5173')
    });
    res.json({ url: session.url });
  }catch(e){ res.status(500).json({error:'portal_error'}); }
});


// ---- Optional web enrichment (RAG-lite) ----
const ENABLE_WEB_RAG = (process.env.ENABLE_WEB_RAG||'false').toLowerCase()==='true';
const RAG_WHITELIST = (process.env.RAG_WHITELIST||'').split(',').map(s=>s.trim()).filter(Boolean);
async function fetchSafe(url){
  try{
    const u = new URL(url);
    if(!RAG_WHITELIST.some(dom => u.origin.startsWith(dom))) return null;
    const res = await fetch(url, { headers: { 'Accept': 'text/html,application/xhtml+xml' }});
    const txt = await res.text();
    return txt.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').slice(0,4000);
  }catch{ return null; }
}
async function ragAugment(userMsg){
  if(!ENABLE_WEB_RAG) return { text:'', sources: [] };
  const seeds = [
    'https://en.wikipedia.org/wiki/Cognitive_behavioral_therapy',
    'https://en.wikipedia.org/wiki/Dialectical_behavior_therapy',
    'https://cmha.ca/find-info/mental-health/',
    'https://www.nimh.nih.gov/health/topics/attention-deficit-hyperactivity-disorder-adhd',
    'https://www.hopeforwellness.ca'
  ];
  const chunks = []; const used = [];
  for(const url of seeds){
    const t = await fetchSafe(url); if(t){ chunks.push(`SOURCE ${url}:\n${t}\n`); used.push(url); }
    if(chunks.length>=3) break;
  }
  return { text: chunks.join('\n---\n').slice(0,9000), sources: used };
}
