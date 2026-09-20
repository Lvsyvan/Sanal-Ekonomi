const Fastify = require("fastify");
const cors = require("@fastify/cors");
const jwt = require("@fastify/jwt");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const app = Fastify({ logger: true });
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL environment variable is required.");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  max: 10
});

async function q(text, params = []) { return pool.query(text, params); }

const BUILDINGS = {
  WAREHOUSE: {
    name: "Depo", emoji: "📦", land: 1,
    cost: { scoin: 100, wood: 150, stone: 150, iron: 0 },
    production: null
  },
  MINE: {
    name: "Demir Madeni", emoji: "⛏️", land: 1,
    cost: { scoin: 100, wood: 100, stone: 100, iron: 0 },
    production: "iron"
  },
  SAWMILL: {
    name: "Kereste Atölyesi", emoji: "🪚", land: 1,
    cost: { scoin: 100, wood: 150, stone: 100, iron: 50 },
    production: "wood"
  },
  QUARRY: {
    name: "Taş Ocağı", emoji: "🪨", land: 1,
    cost: { scoin: 100, wood: 100, stone: 150, iron: 50 },
    production: "stone"
  },
  POWER: {
    name: "Enerji Santrali", emoji: "⚡", land: 1,
    cost: { scoin: 150, wood: 150, stone: 250, iron: 150 },
    production: "energy"
  },
  STEEL_MILL: {
    name: "Çelik Tesisi", emoji: "🏭", land: 1,
    cost: { scoin: 250, wood: 200, stone: 300, iron: 500 },
    production: null
  },
  MACHINE_FACTORY: {
    name: "Makine Fabrikası", emoji: "⚙️", land: 2,
    cost: { scoin: 500, wood: 400, stone: 300, iron: 500 },
    production: null
  }
};

const RATE_BY_LEVEL = { 1: 100, 2: 250, 3: 600, 4: 1500 };
const UPGRADE_COST = { 1: 5000, 2: 12000, 3: 30000 };
const RESOURCE_LABEL = {
  IRON: "Demir", WOOD: "Kereste", STONE: "Taş", ENERGY: "Enerji",
  STEEL: "Çelik", MACHINE: "Makine"
};

async function initDb() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      scoin NUMERIC(20,2) NOT NULL DEFAULT 5000,
      iron NUMERIC(20,2) NOT NULL DEFAULT 300,
      steel NUMERIC(20,2) NOT NULL DEFAULT 0,
      wood NUMERIC(20,2) NOT NULL DEFAULT 400,
      stone NUMERIC(20,2) NOT NULL DEFAULT 400,
      energy NUMERIC(20,2) NOT NULL DEFAULT 200,
      machines NUMERIC(20,2) NOT NULL DEFAULT 0,
      land INTEGER NOT NULL DEFAULT 4,
      mine_level INTEGER NOT NULL DEFAULT 1,
      production_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS buildings (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      level INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS listings (
      id BIGSERIAL PRIMARY KEY,
      seller_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      resource TEXT NOT NULL,
      qty NUMERIC(20,2) NOT NULL CHECK (qty > 0),
      price NUMERIC(20,2) NOT NULL CHECK (price > 0),
      status TEXT NOT NULL DEFAULT 'OPEN',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sold_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      amount NUMERIC(20,2) NOT NULL DEFAULT 0,
      description TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS steel NUMERIC(20,2) NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS wood NUMERIC(20,2) NOT NULL DEFAULT 400;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS stone NUMERIC(20,2) NOT NULL DEFAULT 400;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS energy NUMERIC(20,2) NOT NULL DEFAULT 200;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS machines NUMERIC(20,2) NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS land INTEGER NOT NULL DEFAULT 4;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS mine_level INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS production_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

    CREATE INDEX IF NOT EXISTS idx_buildings_user ON buildings(user_id, type);
    CREATE INDEX IF NOT EXISTS idx_listings_open ON listings(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id, created_at DESC);
  `);

  // Migration for V10 players: create building records from their existing mine count
  // only once. We keep existing balances; new accounts receive the easier starter setup.
  const oldMineUsers = await q(`
    SELECT u.id, u.mines, u.mine_level
    FROM users u
    WHERE u.mines IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM buildings b WHERE b.user_id=u.id)
      AND u.mines > 0
  `);

  for (const row of oldMineUsers.rows) {
    const count = Number(row.mines);
    const level = Number(row.mine_level || 1);
    for (let i = 0; i < count; i++) {
      await q(`INSERT INTO buildings(user_id,type,level) VALUES($1,'MINE',$2)`, [row.id, level]);
    }
    await q(`INSERT INTO transactions(user_id,type,amount,description)
             VALUES($1,'MIGRATION',0,'V10 madenleri V11 yapı sistemine aktarıldı')`, [row.id]);
  }
}

function money(v) { return Number(v || 0); }

async function getUser(id, client = pool) {
  const r = await client.query(`
    SELECT id,username,scoin,iron,steel,wood,stone,energy,machines,land,mine_level,production_updated_at
    FROM users WHERE id=$1
  `, [id]);
  return r.rows[0] || null;
}

async function accrueProduction(id, client = pool) {
  // Production rate comes from each building and its level.
  // Max catch-up: 24 hours so a very old account cannot accumulate indefinitely.
  await client.query(`
    WITH rates AS (
      SELECT
        user_id,
        COALESCE(SUM(
          CASE
            WHEN type='MINE' THEN 100 * CASE level WHEN 1 THEN 1 WHEN 2 THEN 2.5 WHEN 3 THEN 6 WHEN 4 THEN 15 ELSE 1 END
            ELSE 0
          END
        ),0) AS iron_rate,
        COALESCE(SUM(CASE WHEN type='SAWMILL' THEN 80 ELSE 0 END),0) AS wood_rate,
        COALESCE(SUM(CASE WHEN type='QUARRY' THEN 80 ELSE 0 END),0) AS stone_rate,
        COALESCE(SUM(CASE WHEN type='POWER' THEN 120 ELSE 0 END),0) AS energy_rate
      FROM buildings WHERE user_id=$1 GROUP BY user_id
    )
    UPDATE users u
    SET
      iron = u.iron + COALESCE(r.iron_rate,0) * LEAST(24,GREATEST(0,EXTRACT(EPOCH FROM(NOW()-u.production_updated_at))/3600)),
      wood = u.wood + COALESCE(r.wood_rate,0) * LEAST(24,GREATEST(0,EXTRACT(EPOCH FROM(NOW()-u.production_updated_at))/3600)),
      stone = u.stone + COALESCE(r.stone_rate,0) * LEAST(24,GREATEST(0,EXTRACT(EPOCH FROM(NOW()-u.production_updated_at))/3600)),
      energy = u.energy + COALESCE(r.energy_rate,0) * LEAST(24,GREATEST(0,EXTRACT(EPOCH FROM(NOW()-u.production_updated_at))/3600)),
      production_updated_at=NOW()
    FROM rates r
    WHERE u.id=r.user_id
  `, [id]);

  await client.query(`
    UPDATE users SET production_updated_at=NOW()
    WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM buildings WHERE user_id=$1)
  `, [id]);
}

async function auth(req, reply) {
  try {
    req.user = await app.jwt.verify(
      (req.headers.authorization || "").replace(/^Bearer\s+/i, "")
    );
  } catch {
    return reply.code(401).send({ error: "Oturum gerekli." });
  }
}

async function buildingCounts(id, client = pool) {
  const r = await client.query(`
    SELECT type, COUNT(*)::int AS count,
           COALESCE(SUM(level),0)::int AS levels
    FROM buildings WHERE user_id=$1 GROUP BY type
  `, [id]);
  const out = {};
  for (const x of r.rows) out[x.type] = { count: Number(x.count), levels: Number(x.levels) };
  return out;
}

async function publicState(id, client = pool) {
  await accrueProduction(id, client);
  const u = await getUser(id, client);
  if (!u) return null;
  const buildings = await buildingCounts(id, client);
  const production = {
    iron: (buildings.MINE?.count || 0) * 100,
    wood: (buildings.SAWMILL?.count || 0) * 80,
    stone: (buildings.QUARRY?.count || 0) * 80,
    energy: (buildings.POWER?.count || 0) * 120
  };
  return {
    id: Number(u.id), username: u.username,
    scoin: money(u.scoin), iron: money(u.iron), steel: money(u.steel),
    wood: money(u.wood), stone: money(u.stone), energy: money(u.energy),
    machines: money(u.machines), land: Number(u.land),
    usedLand: Object.entries(buildings).reduce((sum,[type,v]) => sum + (BUILDINGS[type]?.land || 1) * v.count, 0),
    freeLand: Number(u.land) - Object.entries(buildings).reduce((sum,[type,v]) => sum + (BUILDINGS[type]?.land || 1) * v.count, 0),
    buildings, production
  };
}

app.register(cors,{origin:true});
app.register(jwt,{secret:process.env.JWT_SECRET || "CHANGE_ME_IN_RENDER"});

app.get("/health",async()=>({ok:true,service:"sanal-ekonomi",version:"11.0.0",currency:"SCoin"}));

app.post("/register",async(req,reply)=>{
  const {username,password}=req.body||{};
  const clean=typeof username==="string"?username.trim():"";
  if(clean.length<3||clean.length>30||typeof password!=="string"||password.length<6)
    return reply.code(400).send({error:"Kullanıcı adı 3-30 karakter, şifre en az 6 karakter olmalı."});
  try{
    const hash=await bcrypt.hash(password,12);
    const r=await q(`
      INSERT INTO users(username,password_hash) VALUES($1,$2)
      RETURNING id,username,scoin,iron,steel,wood,stone,energy,machines,land
    `,[clean,hash]);
    const id=Number(r.rows[0].id);

    // Easy-start package: player begins with functioning economy instead of a blank slate.
    for(const type of ["WAREHOUSE","MINE","SAWMILL","QUARRY"])
      await q(`INSERT INTO buildings(user_id,type,level) VALUES($1,$2,1)`,[id,type]);

    await q(`
      INSERT INTO transactions(user_id,type,amount,description)
      VALUES($1,'STARTER',0,'Başlangıç paketi: Depo + Maden + Kereste Atölyesi + Taş Ocağı')
    `,[id]);

    return {token:app.jwt.sign({id}),user:await publicState(id)};
  }catch(e){
    if(e.code==="23505") return reply.code(409).send({error:"Kullanıcı adı zaten kullanılıyor."});
    throw e;
  }
});

app.post("/login",async(req,reply)=>{
  const {username,password}=req.body||{};
  const r=await q(`SELECT * FROM users WHERE LOWER(username)=LOWER($1)`,[String(username||"").trim()]);
  const u=r.rows[0];
  if(!u||!(await bcrypt.compare(password||"",u.password_hash)))
    return reply.code(401).send({error:"Kullanıcı adı veya şifre hatalı."});
  return {token:app.jwt.sign({id:Number(u.id)}),user:await publicState(Number(u.id))};
});

app.get("/me",{preHandler:auth},async req=>publicState(req.user.id));

app.get("/buildings",async()=>Object.entries(BUILDINGS).map(([type,b])=>({
  type,...b,cost:b.cost
})));

app.post("/build",{preHandler:auth},async(req,reply)=>{
  const type=String(req.body?.type||"").toUpperCase();
  const b=BUILDINGS[type];
  if(!b)return reply.code(400).send({error:"Geçersiz yapı."});

  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const state=await publicState(req.user.id,client);
    const u=await getUser(req.user.id,client);
    if(!u) { await client.query("ROLLBACK"); return reply.code(404).send({error:"Kullanıcı bulunamadı."}); }

    if(state.freeLand<b.land){
      await client.query("ROLLBACK");
      return reply.code(400).send({error:`Bu yapı için ${b.land} boş arazi gerekli.`});
    }

    for(const [resource,cost] of Object.entries(b.cost)){
      if(money(u[resource])<cost){
        await client.query("ROLLBACK");
        const label=resource==="scoin"?"SCoin":RESOURCE_LABEL[resource.toUpperCase()]||resource;
        return reply.code(400).send({error:`Yetersiz ${label}. Gerekli: ${cost}`});
      }
    }

    await client.query(`
      UPDATE users SET
        scoin=scoin-$1,wood=wood-$2,stone=stone-$3,iron=iron-$4
      WHERE id=$5
    `,[b.cost.scoin||0,b.cost.wood||0,b.cost.stone||0,b.cost.iron||0,req.user.id]);

    await client.query(`INSERT INTO buildings(user_id,type,level) VALUES($1,$2,1)`,[req.user.id,type]);
    await client.query(`
      INSERT INTO transactions(user_id,type,amount,description)
      VALUES($1,'BUILD',-$2,$3)
    `,[req.user.id,b.cost.scoin||0,`${b.name} kuruldu`]);

    await client.query("COMMIT");
    return publicState(req.user.id);
  }catch(e){
    await client.query("ROLLBACK"); throw e;
  }finally{client.release();}
});

app.post("/land/expand",{preHandler:auth},async(req,reply)=>{
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await accrueProduction(req.user.id,client);
    const u=await getUser(req.user.id,client);
    const expansion={scoin:250,wood:300,stone:300};
    if(!u){await client.query("ROLLBACK");return reply.code(404).send({error:"Kullanıcı bulunamadı."});}
    for(const [k,v] of Object.entries(expansion)){
      if(money(u[k])<v){await client.query("ROLLBACK");return reply.code(400).send({error:`Arazi genişletme için ${k==="scoin"?"SCoin":RESOURCE_LABEL[k.toUpperCase()]} ${v} gerekli.`});}
    }
    await client.query(`UPDATE users SET scoin=scoin-$1,wood=wood-$2,stone=stone-$3,land=land+1 WHERE id=$4`,
      [expansion.scoin,expansion.wood,expansion.stone,req.user.id]);
    await client.query(`INSERT INTO transactions(user_id,type,amount,description) VALUES($1,'LAND',-$2,'1 arazi genişletildi')`,
      [req.user.id,expansion.scoin]);
    await client.query("COMMIT");
    return publicState(req.user.id);
  }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
});

app.post("/mine/upgrade",{preHandler:auth},async(req,reply)=>{
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await accrueProduction(req.user.id,client);
    const u=await getUser(req.user.id,client);
    const current=(await client.query(`SELECT COALESCE(MAX(level),1) AS lvl FROM buildings WHERE user_id=$1 AND type='MINE'`,[req.user.id])).rows[0].lvl;
    const level=Number(current);
    if(!u){await client.query("ROLLBACK");return reply.code(404).send({error:"Kullanıcı bulunamadı."});}
    if(level>=4){await client.query("ROLLBACK");return reply.code(400).send({error:"Maden seviyesi zaten 4."});}
    const mine=(await client.query(`SELECT id FROM buildings WHERE user_id=$1 AND type='MINE' ORDER BY id LIMIT 1`,[req.user.id])).rows[0];
    if(!mine){await client.query("ROLLBACK");return reply.code(400).send({error:"Önce maden kur."});}
    const cost=UPGRADE_COST[level];
    if(money(u.scoin)<cost){await client.query("ROLLBACK");return reply.code(400).send({error:`Yükseltme için ${cost} SCoin gerekli.`});}
    await client.query(`UPDATE users SET scoin=scoin-$1 WHERE id=$2`,[cost,req.user.id]);
    await client.query(`UPDATE buildings SET level=$1 WHERE id=$2`,[level+1,mine.id]);
    await client.query(`INSERT INTO transactions(user_id,type,amount,description) VALUES($1,'UPGRADE',$2,$3)`,
      [req.user.id,-cost,`Maden Lv${level} → Lv${level+1}`]);
    await client.query("COMMIT");
    return publicState(req.user.id);
  }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
});

// 10 iron + 10 energy -> 1 steel
app.post("/produce/steel",{preHandler:auth},async(req,reply)=>{
  const client=await pool.connect();
  try{
    await client.query("BEGIN"); await accrueProduction(req.user.id,client);
    const u=await getUser(req.user.id,client);
    const mills=Number((await client.query(`SELECT COUNT(*)::int c FROM buildings WHERE user_id=$1 AND type='STEEL_MILL'`,[req.user.id])).rows[0].c);
    if(!mills){await client.query("ROLLBACK");return reply.code(400).send({error:"Önce Çelik Tesisi kurmalısın."});}
    const batches=Math.max(1,Math.min(mills,Math.floor(Math.min(money(u.iron)/10,money(u.energy)/10))));
    const ironCost=batches*10, energyCost=batches*10;
    await client.query(`UPDATE users SET iron=iron-$1,energy=energy-$2,steel=steel+$3 WHERE id=$4`,
      [ironCost,energyCost,batches,req.user.id]);
    await client.query(`INSERT INTO transactions(user_id,type,amount,description) VALUES($1,'STEEL',0,$2)`,
      [req.user.id,`${batches} Çelik üretildi; ${ironCost} demir + ${energyCost} enerji kullanıldı`]);
    await client.query("COMMIT"); return publicState(req.user.id);
  }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
});

// 5 steel + 20 iron + 10 wood + 20 energy -> 1 machine
app.post("/produce/machine",{preHandler:auth},async(req,reply)=>{
  const client=await pool.connect();
  try{
    await client.query("BEGIN"); await accrueProduction(req.user.id,client);
    const u=await getUser(req.user.id,client);
    const factories=Number((await client.query(`SELECT COUNT(*)::int c FROM buildings WHERE user_id=$1 AND type='MACHINE_FACTORY'`,[req.user.id])).rows[0].c);
    if(!factories){await client.query("ROLLBACK");return reply.code(400).send({error:"Önce Makine Fabrikası kurmalısın."});}
    const batches=Math.max(1,Math.min(factories,
      Math.floor(Math.min(money(u.steel)/5,money(u.iron)/20,money(u.wood)/10,money(u.energy)/20))));
    if(!batches){await client.query("ROLLBACK");return reply.code(400).send({error:"Makine üretmek için Çelik, Demir, Kereste ve Enerji yetersiz."});}
    await client.query(`
      UPDATE users SET steel=steel-$1,iron=iron-$2,wood=wood-$3,energy=energy-$4,machines=machines+$5
      WHERE id=$6
    `,[batches*5,batches*20,batches*10,batches*20,batches,req.user.id]);
    await client.query(`INSERT INTO transactions(user_id,type,amount,description) VALUES($1,'MACHINE',0,$2)`,
      [req.user.id,`${batches} Makine üretildi`]);
    await client.query("COMMIT"); return publicState(req.user.id);
  }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
});

app.get("/market",async()=>{
  const r=await q(`
    SELECT l.id,l.resource,l.qty,l.price,l.created_at,u.username
    FROM listings l JOIN users u ON u.id=l.seller_id
    WHERE l.status='OPEN' ORDER BY l.id DESC
  `);
  return r.rows.map(x=>({id:Number(x.id),resource:x.resource,qty:money(x.qty),price:money(x.price),
    unitPrice:Number(x.price)/Number(x.qty),username:x.username}));
});

app.post("/market/list",{preHandler:auth},async(req,reply)=>{
  const resource=String(req.body?.resource||"IRON").toUpperCase();
  const qty=Number(req.body?.qty),price=Number(req.body?.price);
  const resourceColumn={IRON:"iron",STEEL:"steel",WOOD:"wood",STONE:"stone",ENERGY:"energy",MACHINE:"machines"}[resource];
  if(!resourceColumn)return reply.code(400).send({error:"Geçersiz kaynak."});
  if(!Number.isInteger(qty)||qty<=0||!Number.isInteger(price)||price<=0)return reply.code(400).send({error:"Miktar ve fiyat pozitif tam sayı olmalı."});
  const client=await pool.connect();
  try{
    await client.query("BEGIN"); await accrueProduction(req.user.id,client);
    const u=await getUser(req.user.id,client);
    if(!u){await client.query("ROLLBACK");return reply.code(404).send({error:"Kullanıcı bulunamadı."});}
    if(money(u[resourceColumn])<qty){await client.query("ROLLBACK");return reply.code(400).send({error:`Yetersiz ${RESOURCE_LABEL[resource]}.`});}
    await client.query(`UPDATE users SET ${resourceColumn}=${resourceColumn}-$1 WHERE id=$2`,[qty,req.user.id]);
    await client.query(`INSERT INTO listings(seller_id,resource,qty,price) VALUES($1,$2,$3,$4)`,
      [req.user.id,resource,qty,price]);
    await client.query(`INSERT INTO transactions(user_id,type,amount,description) VALUES($1,'LIST',0,$2)`,
      [req.user.id,`${qty} ${RESOURCE_LABEL[resource]} satış ilanı açıldı`]);
    await client.query("COMMIT"); return publicState(req.user.id);
  }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
});

app.post("/market/buy/:id",{preHandler:auth},async(req,reply)=>{
  const client=await pool.connect();
  try{
    await client.query("BEGIN"); await accrueProduction(req.user.id,client);
    const lr=await client.query(`SELECT * FROM listings WHERE id=$1 AND status='OPEN' FOR UPDATE`,[Number(req.params.id)]);
    const listing=lr.rows[0];
    if(!listing||Number(listing.seller_id)===Number(req.user.id)){await client.query("ROLLBACK");return reply.code(400).send({error:"İlan bulunamadı."});}
    const column={IRON:"iron",STEEL:"steel",WOOD:"wood",STONE:"stone",ENERGY:"energy",MACHINE:"machines"}[listing.resource];
    const buyer=await getUser(req.user.id,client),seller=await getUser(Number(listing.seller_id),client);
    if(!buyer||!seller){await client.query("ROLLBACK");return reply.code(404).send({error:"Kullanıcı bulunamadı."});}
    if(money(buyer.scoin)<money(listing.price)){await client.query("ROLLBACK");return reply.code(400).send({error:"Yetersiz SCoin."});}
    const fee=Math.floor(money(listing.price)*0.03),net=money(listing.price)-fee;
    await client.query(`UPDATE users SET scoin=scoin-$1, ${column}=${column}+$2 WHERE id=$3`,
      [money(listing.price),money(listing.qty),buyer.id]);
    await client.query(`UPDATE users SET scoin=scoin+$1 WHERE id=$2`,[net,seller.id]);
    await client.query(`UPDATE listings SET status='SOLD',sold_at=NOW() WHERE id=$1`,[listing.id]);
    await client.query(`INSERT INTO transactions(user_id,type,amount,description) VALUES($1,'BUY',$2,$3)`,
      [buyer.id,-money(listing.price),`${listing.qty} ${RESOURCE_LABEL[listing.resource]} satın alındı`]);
    await client.query(`INSERT INTO transactions(user_id,type,amount,description) VALUES($1,'SALE',$2,$3)`,
      [seller.id,net,`${listing.qty} ${RESOURCE_LABEL[listing.resource]} satıldı; komisyon ${fee} SCoin`]);
    await client.query("COMMIT"); return publicState(buyer.id);
  }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
});

app.get("/transactions",{preHandler:auth},async(req)=>{
  await accrueProduction(req.user.id);
  const r=await q(`SELECT id,type,amount,description,created_at FROM transactions WHERE user_id=$1 ORDER BY id DESC LIMIT 50`,[req.user.id]);
  return r.rows;
});

app.get("/admin/stats",async()=>{
  const r=await q(`
    SELECT
      (SELECT COUNT(*) FROM users) users,
      (SELECT COALESCE(SUM(scoin),0) FROM users) scoin,
      (SELECT COALESCE(SUM(iron),0) FROM users) iron,
      (SELECT COALESCE(SUM(steel),0) FROM users) steel,
      (SELECT COALESCE(SUM(wood),0) FROM users) wood,
      (SELECT COALESCE(SUM(stone),0) FROM users) stone,
      (SELECT COUNT(*) FROM listings WHERE status='OPEN') open_listings,
      (SELECT COALESCE(SUM(ABS(amount)),0) FROM transactions WHERE type='BUY') market_volume
  `);
  const x=r.rows[0];
  return {users:Number(x.users),scoin:money(x.scoin),iron:money(x.iron),steel:money(x.steel),
    wood:money(x.wood),stone:money(x.stone),openListings:Number(x.open_listings),marketVolume:money(x.market_volume)};
});

const html=`<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><title>Sanal Ekonomi</title>
<style>
*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#eef2f5;color:#17212b;margin:0}
header{background:#101820;color:#fff;padding:17px 20px;position:sticky;top:0;z-index:5}.wrap{max-width:1150px;margin:auto;padding:16px}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.card{background:#fff;padding:15px;border-radius:15px;margin-bottom:10px;box-shadow:0 2px 9px #0001}
.stat{font-size:24px;font-weight:750}.small{color:#6a7480;font-size:12px}.section{margin-top:16px}
button{background:#1769e0;color:white;border:0;border-radius:9px;padding:10px 12px;margin:3px;font-weight:600;cursor:pointer}
button.alt{background:#5b6672}input,select{width:100%;padding:10px;border:1px solid #ccd3da;border-radius:9px;margin:3px 0;font-size:16px}
.tablewrap{overflow:auto}table{width:100%;border-collapse:collapse}td,th{padding:8px;border-bottom:1px solid #e5e8eb;text-align:left;white-space:nowrap}
.badge{background:#e8f0ff;color:#1559b6;border-radius:99px;padding:4px 8px;font-size:12px}
.resourcegrid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.buildinggrid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.build{border:1px solid #e5e8eb;border-radius:12px;padding:11px}.build h3{margin:0 0 5px}
@media(min-width:780px){.grid{grid-template-columns:repeat(4,minmax(0,1fr))}.buildinggrid{grid-template-columns:repeat(4,1fr)}.resourcegrid{grid-template-columns:repeat(6,1fr)}}
</style></head><body>
<header>🌍 <b>SANAL EKONOMİ</b> <span class=badge>SCoin + Gerçek Kaynak Ekonomisi</span></header>
<div class=wrap>
<div id=auth class=card><h2>Giriş / Kayıt</h2><input id=un placeholder="Kullanıcı adı"><input id=pw type=password placeholder="Şifre"><button onclick=reg()>Kayıt Ol</button><button onclick=login()>Giriş</button><p id=msg></p></div>

<div id=game style="display:none">
<div class=resourcegrid>
<div class=card><span class=small>SCoin</span><div id=x class=stat>0</div></div>
<div class=card><span class=small>Demir</span><div id=i class=stat>0</div></div>
<div class=card><span class=small>Kereste</span><div id=w class=stat>0</div></div>
<div class=card><span class=small>Taş</span><div id=st class=stat>0</div></div>
<div class=card><span class=small>Enerji</span><div id=e class=stat>0</div></div>
<div class=card><span class=small>Çelik / Makine</span><div id=sm class=stat>0 / 0</div></div>
</div>

<div class=grid>
<div class=card><span class=small>Arazi</span><div id=land class=stat>0</div><div class=small id=freeLand></div></div>
<div class=card><span class=small>Demir üretimi</span><div id=ri class=stat>0</div><div class=small>/ saat</div></div>
<div class=card><span class=small>Kereste üretimi</span><div id=rw class=stat>0</div><div class=small>/ saat</div></div>
<div class=card><span class=small>Enerji üretimi</span><div id=re class=stat>0</div><div class=small>/ saat</div></div>
</div>

<div class=section><h2>🏗️ İnşaat</h2>
<div class=buildinggrid id=buildings></div>
<div class=card><h3>🏞️ Arazi Genişlet</h3><p>+1 arazi = <b>250 SCoin + 300 kereste + 300 taş</b></p><button onclick=action('/land/expand')>Arazi Genişlet</button></div>
</div>

<div class=section><h2>🏭 Üretim</h2>
<div class=grid>
<div class=card><h3>Demir Madenleri</h3><p>Madenler otomatik üretir. İlk maden başlangıç paketinde ücretsiz gelir.</p><button onclick=action('/mine/upgrade')>Maden Seviyesi Yükselt</button><p class=small id=upgradeInfo></p></div>
<div class=card><h3>Çelik Tesisi</h3><p>10 demir + 10 enerji → 1 çelik</p><button onclick=action('/produce/steel')>Çelik Üret</button></div>
<div class=card><h3>Makine Fabrikası</h3><p>5 çelik + 20 demir + 10 kereste + 20 enerji → 1 makine</p><button onclick=action('/produce/machine')>Makine Üret</button></div>
<div class=card><h3>Başlangıç Ekonomisi</h3><p>Boş bir harita yerine başlangıçta Depo + Maden + Kereste Atölyesi + Taş Ocağı kuruludur.</p></div>
</div></div>

<div class=section><h2>🛒 Marketplace</h2><div class=card>
<div class=grid><select id=res><option value=IRON>Demir</option><option value=WOOD>Kereste</option><option value=STONE>Taş</option><option value=ENERGY>Enerji</option><option value=STEEL>Çelik</option><option value=MACHINE>Makine</option></select>
<input id=q type=number min=1 placeholder=Miktar><input id=pr type=number min=1 placeholder="Toplam SCoin"><button onclick=sell>İlan Aç</button></div>
<hr><div class=tablewrap><table><thead><tr><th>Satıcı</th><th>Kaynak</th><th>Miktar</th><th>Toplam</th><th>Birim</th><th></th></tr></thead><tbody id=mk></tbody></table></div></div></div>

<div class=section><h2>📜 Son İşlemler</h2><div class=card><div class=tablewrap><table><tbody id=tx></tbody></table></div></div></div>
</div></div>
<script>
let token="";
const fmt=n=>Number(n||0).toLocaleString('tr-TR',{maximumFractionDigits:2});
const labels={IRON:'Demir',WOOD:'Kereste',STONE:'Taş',ENERGY:'Enerji',STEEL:'Çelik',MACHINE:'Makine'};
const api=async(path,opt={})=>{opt.headers={...(opt.headers||{}),...(token?{Authorization:'Bearer '+token}:{})};if(opt.body!==undefined)opt.headers['Content-Type']='application/json';const r=await fetch(path,opt);let d={};try{d=await r.json()}catch{}if(!r.ok)throw Error(d.error||('HTTP '+r.status));return d};
async function reg(){try{let d=await api('/register',{method:'POST',body:JSON.stringify({username:un.value,password:pw.value})});token=d.token;open()}catch(e){msg.textContent=e.message}}
async function login(){try{let d=await api('/login',{method:'POST',body:JSON.stringify({username:un.value,password:pw.value})});token=d.token;open()}catch(e){msg.textContent=e.message}}
function open(){auth.style.display='none';game.style.display='block';refresh()}
async function refresh(){
  const u=await api('/me');
  x.textContent=fmt(u.scoin);i.textContent=fmt(u.iron);w.textContent=fmt(u.wood);st.textContent=fmt(u.stone);e.textContent=fmt(u.energy);sm.textContent=fmt(u.steel)+' / '+fmt(u.machines);
  land.textContent=u.land;freeLand.textContent='Boş arazi: '+u.freeLand;
  ri.textContent=fmt(u.production.iron);rw.textContent=fmt(u.production.wood);re.textContent=fmt(u.production.energy);
  const next={1:5000,2:12000,3:30000}; upgradeInfo.textContent='Seviye 1→2: 5.000 SCoin | 2→3: 12.000 | 3→4: 30.000';
  const bs=await api('/buildings');
  const counts=u.buildings||{};
  buildings.innerHTML=bs.map(b=>{const c=counts[b.type]?.count||0;const cost=Object.entries(b.cost).filter(([,v])=>v).map(([k,v])=>(k==='scoin'?v+' SCoin':v+' '+(labels[k.toUpperCase()]||k))).join(' + ');
    return '<div class=build><h3>'+b.emoji+' '+b.name+'</h3><p class=small>Kurulu: '+c+' | Arazi: '+b.land+'</p><p>'+cost+'</p><button onclick="build(\''+b.type+'\')">Kur</button></div>'}).join('');
  const rows=await api('/market');
  mk.innerHTML=rows.map(v=>'<tr><td>'+v.username+'</td><td>'+labels[v.resource]+'</td><td>'+fmt(v.qty)+'</td><td>'+fmt(v.price)+' SCoin</td><td>'+fmt(v.unitPrice)+'</td><td><button onclick="buy('+v.id+')">Al</button></td></tr>').join('');
  const t=await api('/transactions');tx.innerHTML=t.map(v=>'<tr><td>'+v.description+'</td><td>'+fmt(v.amount)+' SCoin</td></tr>').join('');
}
async function action(p){try{await api(p,{method:'POST',body:JSON.stringify({})});refresh()}catch(e){alert(e.message)}}
async function build(type){try{await api('/build',{method:'POST',body:JSON.stringify({type})});refresh()}catch(e){alert(e.message)}}
async function sell(){try{await api('/market/list',{method:'POST',body:JSON.stringify({resource:res.value,qty:+q.value,price:+pr.value})});q.value='';pr.value='';refresh()}catch(e){alert(e.message)}}
async function buy(id){try{await api('/market/buy/'+id,{method:'POST',body:JSON.stringify({})});refresh()}catch(e){alert(e.message)}}
setInterval(()=>{if(token)refresh().catch(()=>{})},30000);
</script></body></html>`;

app.get("/",async(_,reply)=>reply.type("text/html; charset=utf-8").send(html));

const port=Number(process.env.PORT||3000);
async function start(){await initDb();await app.listen({port,host:"0.0.0.0"});}
start().catch(err=>{app.log.error(err);process.exit(1)});
