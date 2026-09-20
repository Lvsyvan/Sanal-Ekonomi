const Fastify = require("fastify");
const cors = require("@fastify/cors");
const jwt = require("@fastify/jwt");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const app = Fastify({ logger: true });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  max: 10
});

async function q(text, params = []) {
  return pool.query(text, params);
}

async function initDb() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      scoin NUMERIC(20,2) NOT NULL DEFAULT 10000,
      iron NUMERIC(20,2) NOT NULL DEFAULT 0,
      land INTEGER NOT NULL DEFAULT 0,
      mines INTEGER NOT NULL DEFAULT 0,
      production_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS listings (
      id BIGSERIAL PRIMARY KEY,
      seller_id BIGINT NOT NULL REFERENCES users(id),
      qty NUMERIC(20,2) NOT NULL CHECK (qty > 0),
      price NUMERIC(20,2) NOT NULL CHECK (price > 0),
      status TEXT NOT NULL DEFAULT 'OPEN',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sold_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      amount NUMERIC(20,2) NOT NULL,
      description TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_listings_open ON listings(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, created_at DESC);
  `);
}

function money(v) {
  return Number(v || 0);
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    username: row.username,
    scoin: money(row.scoin),
    iron: money(row.iron),
    land: Number(row.land),
    mines: Number(row.mines)
  };
}

async function getUser(id, client = pool) {
  const r = await client.query(
    `SELECT id, username, scoin, iron, land, mines, production_updated_at
     FROM users WHERE id = $1`, [id]
  );
  return r.rows[0] || null;
}

/* Passive production:
   Lv1 mine = 100 iron/hour.
   Every additional mine adds another 100 iron/hour.
   Production accrues from production_updated_at to now, capped at 24h
   so a dormant account cannot generate unbounded resources in one request.
*/
async function accrueProduction(id, client = pool) {
  await client.query(`
    UPDATE users
    SET iron = iron + (
      mines * 100
      * LEAST(
          24,
          GREATEST(
            0,
            EXTRACT(EPOCH FROM (NOW() - production_updated_at)) / 3600
          )
        )
    ),
    production_updated_at = NOW()
    WHERE id = $1 AND mines > 0
  `, [id]);
}

async function auth(req, reply) {
  try {
    const decoded = await app.jwt.verify(
      (req.headers.authorization || "").replace(/^Bearer\s+/i, "")
    );
    req.user = decoded;
  } catch {
    return reply.code(401).send({ error: "Oturum gerekli." });
  }
}

app.register(cors, { origin: true });
app.register(jwt, {
  secret: process.env.JWT_SECRET || "CHANGE_THIS_SECRET"
});

app.get("/health", async () => ({
  ok: true,
  service: "sanal-ekonomi",
  version: "9.0.0",
  currency: "SCoin"
}));

app.post("/register", async (req, reply) => {
  const { username, password } = req.body || {};
  const clean = typeof username === "string" ? username.trim() : "";

  if (clean.length < 3 || clean.length > 30 || typeof password !== "string" || password.length < 6) {
    return reply.code(400).send({
      error: "Kullanıcı adı 3-30 karakter, şifre en az 6 karakter olmalı."
    });
  }

  try {
    const hash = await bcrypt.hash(password, 12);
    const r = await q(`
      INSERT INTO users(username, password_hash)
      VALUES($1, $2)
      RETURNING id, username, scoin, iron, land, mines
    `, [clean, hash]);

    const id = Number(r.rows[0].id);
    return {
      token: app.jwt.sign({ id }),
      user: publicUser(r.rows[0])
    };
  } catch (e) {
    if (e.code === "23505") {
      return reply.code(409).send({ error: "Kullanıcı adı zaten kullanılıyor." });
    }
    throw e;
  }
});

app.post("/login", async (req, reply) => {
  const { username, password } = req.body || {};
  const r = await q(`SELECT * FROM users WHERE LOWER(username)=LOWER($1)`, [String(username || "").trim()]);
  const u = r.rows[0];

  if (!u || !(await bcrypt.compare(password || "", u.password_hash))) {
    return reply.code(401).send({ error: "Kullanıcı adı veya şifre hatalı." });
  }

  await accrueProduction(u.id);
  return {
    token: app.jwt.sign({ id: Number(u.id) }),
    user: publicUser(await getUser(u.id))
  };
});

app.get("/me", { preHandler: auth }, async (req, reply) => {
  await accrueProduction(req.user.id);
  const u = await getUser(req.user.id);
  if (!u) return reply.code(404).send({ error: "Kullanıcı bulunamadı." });
  return publicUser(u);
});

app.post("/land", { preHandler: auth }, async (req, reply) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await accrueProduction(req.user.id, client);

    const u = await getUser(req.user.id, client);
    if (!u) throw new Error("Kullanıcı bulunamadı.");
    if (money(u.scoin) < 1000) {
      await client.query("ROLLBACK");
      return reply.code(400).send({ error: "Yetersiz SCoin." });
    }

    await client.query(
      `UPDATE users SET scoin=scoin-1000, land=land+1 WHERE id=$1`,
      [req.user.id]
    );
    await client.query(
      `INSERT INTO transactions(user_id,type,amount,description) VALUES($1,'LAND',-1000,'Arazi satın alındı')`,
      [req.user.id]
    );

    await client.query("COMMIT");
    return publicUser(await getUser(req.user.id));
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

app.post("/mine", { preHandler: auth }, async (req, reply) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await accrueProduction(req.user.id, client);
    const u = await getUser(req.user.id, client);

    if (!u) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "Kullanıcı bulunamadı." });
    }
    if (Number(u.land) <= Number(u.mines)) {
      await client.query("ROLLBACK");
      return reply.code(400).send({ error: "Maden için boş arazi gerekli." });
    }
    if (money(u.scoin) < 2500) {
      await client.query("ROLLBACK");
      return reply.code(400).send({ error: "Yetersiz SCoin." });
    }

    await client.query(
      `UPDATE users SET scoin=scoin-2500, mines=mines+1 WHERE id=$1`,
      [req.user.id]
    );
    await client.query(
      `INSERT INTO transactions(user_id,type,amount,description) VALUES($1,'MINE',-2500,'Maden kuruldu')`,
      [req.user.id]
    );

    await client.query("COMMIT");
    return publicUser(await getUser(req.user.id));
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

app.post("/produce", { preHandler: auth }, async (req, reply) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await accrueProduction(req.user.id, client);
    const u = await getUser(req.user.id, client);

    if (!u) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "Kullanıcı bulunamadı." });
    }
    if (Number(u.mines) < 1) {
      await client.query("ROLLBACK");
      return reply.code(400).send({ error: "Önce maden kurmalısın." });
    }
    if (money(u.scoin) < 50) {
      await client.query("ROLLBACK");
      return reply.code(400).send({ error: "Üretim için 50 SCoin gerekli." });
    }

    const produced = Number(u.mines) * 100;
    await client.query(
      `UPDATE users SET scoin=scoin-50, iron=iron+$1 WHERE id=$2`,
      [produced, req.user.id]
    );
    await client.query(
      `INSERT INTO transactions(user_id,type,amount,description) VALUES($1,'PRODUCE',-50,$2)`,
      [req.user.id, `${produced} demir üretildi; 50 SCoin enerji maliyeti`]
    );

    await client.query("COMMIT");
    return publicUser(await getUser(req.user.id));
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

app.get("/market", async () => {
  const r = await q(`
    SELECT l.id, l.qty, l.price, l.created_at, u.username
    FROM listings l JOIN users u ON u.id=l.seller_id
    WHERE l.status='OPEN'
    ORDER BY l.id DESC
  `);
  return r.rows.map(x => ({
    id: Number(x.id),
    qty: money(x.qty),
    price: money(x.price),
    username: x.username,
    unitPrice: Number(x.price) / Number(x.qty)
  }));
});

app.post("/market/list", { preHandler: auth }, async (req, reply) => {
  const qty = Number(req.body?.qty);
  const price = Number(req.body?.price);

  if (!Number.isInteger(qty) || qty <= 0) return reply.code(400).send({ error: "Geçersiz demir miktarı." });
  if (!Number.isInteger(price) || price <= 0) return reply.code(400).send({ error: "Geçersiz fiyat." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await accrueProduction(req.user.id, client);
    const u = await getUser(req.user.id, client);

    if (!u) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "Kullanıcı bulunamadı." });
    }
    if (money(u.iron) < qty) {
      await client.query("ROLLBACK");
      return reply.code(400).send({ error: "Yetersiz demir." });
    }

    await client.query(`UPDATE users SET iron=iron-$1 WHERE id=$2`, [qty, req.user.id]);
    await client.query(
      `INSERT INTO listings(seller_id,qty,price) VALUES($1,$2,$3)`,
      [req.user.id, qty, price]
    );
    await client.query(
      `INSERT INTO transactions(user_id,type,amount,description) VALUES($1,'LIST',0,$2)`,
      [req.user.id, `${qty} demir satış ilanı açıldı`]
    );

    await client.query("COMMIT");
    return publicUser(await getUser(req.user.id));
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

app.post("/market/buy/:id", { preHandler: auth }, async (req, reply) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await accrueProduction(req.user.id, client);

    const lr = await client.query(
      `SELECT * FROM listings WHERE id=$1 AND status='OPEN' FOR UPDATE`,
      [Number(req.params.id)]
    );
    const listing = lr.rows[0];

    if (!listing || Number(listing.seller_id) === Number(req.user.id)) {
      await client.query("ROLLBACK");
      return reply.code(400).send({ error: "İlan bulunamadı." });
    }

    const buyer = await getUser(req.user.id, client);
    const seller = await getUser(Number(listing.seller_id), client);

    if (!buyer || !seller) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "Kullanıcı bulunamadı." });
    }

    if (money(buyer.scoin) < money(listing.price)) {
      await client.query("ROLLBACK");
      return reply.code(400).send({ error: "Yetersiz SCoin." });
    }

    const fee = Math.floor(money(listing.price) * 0.03);
    const sellerNet = money(listing.price) - fee;

    await client.query(
      `UPDATE users SET scoin=scoin-$1, iron=iron+$2 WHERE id=$3`,
      [money(listing.price), money(listing.qty), buyer.id]
    );

    await client.query(
      `UPDATE users SET scoin=scoin+$1 WHERE id=$2`,
      [sellerNet, seller.id]
    );

    await client.query(
      `UPDATE listings SET status='SOLD', sold_at=NOW() WHERE id=$1`,
      [listing.id]
    );

    await client.query(
      `INSERT INTO transactions(user_id,type,amount,description) VALUES($1,'BUY',$2,$3)`,
      [buyer.id, -money(listing.price), `${listing.qty} demir satın alındı`]
    );

    await client.query(
      `INSERT INTO transactions(user_id,type,amount,description) VALUES($1,'SALE',$2,$3)`,
      [seller.id, sellerNet, `${listing.qty} demir satıldı; %3 platform komisyonu: ${fee} SCoin`]
    );

    await client.query("COMMIT");
    return publicUser(await getUser(req.user.id));
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

app.get("/transactions", { preHandler: auth }, async req => {
  await accrueProduction(req.user.id);
  const r = await q(
    `SELECT id,type,amount,description,created_at
     FROM transactions WHERE user_id=$1 ORDER BY id DESC LIMIT 50`,
    [req.user.id]
  );
  return r.rows;
});

app.get("/admin/stats", async () => {
  const r = await q(`
    SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COALESCE(SUM(scoin),0) FROM users) AS circulating_scoin,
      (SELECT COALESCE(SUM(iron),0) FROM users) AS iron,
      (SELECT COUNT(*) FROM listings WHERE status='OPEN') AS open_listings,
      (SELECT COALESCE(SUM(ABS(amount)),0) FROM transactions WHERE type='BUY') AS market_volume
  `);
  const x = r.rows[0];
  return {
    users: Number(x.users),
    circulatingScoin: money(x.circulating_scoin),
    iron: money(x.iron),
    openListings: Number(x.open_listings),
    marketVolume: money(x.market_volume)
  };
});

app.get("/", async (_, reply) => {
  reply.type("text/html; charset=utf-8").send(html);
});

const html = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>Sanal Ekonomi</title>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f3f5f7;color:#17212b;margin:0}
header{background:#101820;color:#fff;padding:18px}
.wrap{max-width:1050px;margin:auto;padding:18px}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.card{background:#fff;padding:16px;border-radius:15px;margin-bottom:12px;box-shadow:0 2px 10px #0001}
.stat{font-size:26px;font-weight:700}
input{width:100%;padding:12px;margin:4px 0;border:1px solid #ccd3da;border-radius:10px;font-size:16px}
button{background:#1769e0;color:#fff;border:0;border-radius:10px;padding:11px 14px;margin:4px;cursor:pointer}
button.secondary{background:#66727d}
table{width:100%;border-collapse:collapse}
td,th{padding:9px;border-bottom:1px solid #e5e8eb;text-align:left}
.badge{display:inline-block;padding:4px 9px;border-radius:999px;background:#e7efff;color:#1559b6}
.muted{color:#68737d;font-size:13px}
@media(min-width:760px){.grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
</style>
</head>
<body>
<header>🌍 <b>SANAL EKONOMİ</b> <span class="badge">SCoin</span></header>
<div class="wrap">
<div id="auth" class="card">
<h2>Giriş / Kayıt</h2>
<input id="un" placeholder="Kullanıcı adı" autocomplete="username">
<input id="pw" type="password" placeholder="Şifre" autocomplete="current-password">
<button onclick="registerUser()">Kayıt Ol</button>
<button onclick="loginUser()">Giriş Yap</button>
<p id="msg"></p>
</div>

<div id="game" style="display:none">
<div class="grid">
<div class="card"><span class="muted">SCoin</span><div id="x" class="stat">0</div></div>
<div class="card"><span class="muted">Arazi</span><div id="l" class="stat">0</div></div>
<div class="card"><span class="muted">Maden</span><div id="m" class="stat">0</div></div>
<div class="card"><span class="muted">Demir</span><div id="i" class="stat">0</div></div>
</div>

<div class="grid">
<div class="card"><h3>🏞️ Arazi</h3><p>1.000 SCoin</p><button onclick="action('/land')">Arazi Al</button></div>
<div class="card"><h3>⛏️ Maden</h3><p>2.500 SCoin</p><button onclick="action('/mine')">Maden Kur</button></div>
<div class="card"><h3>⚙️ Üretim</h3><p>50 SCoin manuel üretim</p><button onclick="action('/produce')">Üret</button><p class="muted">Madenler ayrıca pasif olarak saatte 100 demir üretir.</p></div>
<div class="card"><h3>📱 iPhone</h3><p>Safari → Paylaş → Ana Ekrana Ekle</p></div>
</div>

<div class="card">
<h2>🛒 Marketplace</h2>
<input id="q" type="number" placeholder="Satılacak demir">
<input id="pr" type="number" placeholder="Toplam SCoin">
<button onclick="sell()">İlan Aç</button>
<hr>
<table><thead><tr><th>Satıcı</th><th>Miktar</th><th>Toplam</th><th>Birim</th><th></th></tr></thead>
<tbody id="mk"></tbody></table>
</div>

<div class="card"><h2>📜 Son İşlemler</h2>
<table><thead><tr><th>İşlem</th><th>Tutar</th></tr></thead><tbody id="tx"></tbody></table>
</div>
</div>
</div>

<script>
let token="";
const moneyFmt = n => Number(n||0).toLocaleString('tr-TR',{maximumFractionDigits:2});
async function api(path,opt={}){
  opt.headers={...(opt.headers||{}),...(token?{Authorization:'Bearer '+token}:{})};
  if(opt.body!==undefined) opt.headers['Content-Type']='application/json';
  const r=await fetch(path,opt);
  let d={}; try{d=await r.json()}catch{}
  if(!r.ok) throw Error(d.error||('HTTP '+r.status));
  return d;
}
async function registerUser(){
  try{
    const d=await api('/register',{method:'POST',body:JSON.stringify({username:un.value,password:pw.value})});
    token=d.token; openGame();
  }catch(e){msg.textContent=e.message}
}
async function loginUser(){
  try{
    const d=await api('/login',{method:'POST',body:JSON.stringify({username:un.value,password:pw.value})});
    token=d.token; openGame();
  }catch(e){msg.textContent=e.message}
}
function openGame(){auth.style.display='none';game.style.display='block';refresh()}
async function refresh(){
  const u=await api('/me');
  x.textContent=moneyFmt(u.scoin); l.textContent=u.land; m.textContent=u.mines; i.textContent=moneyFmt(u.iron);
  const rows=await api('/market');
  mk.innerHTML=rows.map(v=>'<tr><td>'+v.username+'</td><td>'+moneyFmt(v.qty)+'</td><td>'+moneyFmt(v.price)+' SCoin</td><td>'+moneyFmt(v.unitPrice)+'</td><td><button onclick="buy('+v.id+')">Al</button></td></tr>').join('');
  const t=await api('/transactions');
  tx.innerHTML=t.map(v=>'<tr><td>'+v.description+'</td><td>'+moneyFmt(v.amount)+' SCoin</td></tr>').join('');
}
async function action(p){try{await api(p,{method:'POST',body:JSON.stringify({})});refresh()}catch(e){alert(e.message)}}
async function sell(){try{await api('/market/list',{method:'POST',body:JSON.stringify({qty:+q.value,price:+pr.value})});q.value='';pr.value='';refresh()}catch(e){alert(e.message)}}
async function buy(id){try{await api('/market/buy/'+id,{method:'POST',body:JSON.stringify({})});refresh()}catch(e){alert(e.message)}}
</script>
</body>
</html>`;

const port = Number(process.env.PORT || 3000);

async function start() {
  await initDb();
  await app.listen({ port, host: "0.0.0.0" });
}

start().catch(err => {
  app.log.error(err);
  process.exit(1);
});
