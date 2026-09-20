
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
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false,
  max: 10
});

const RESOURCE_LABEL = {
  IRON: "Demir",
  WOOD: "Kereste",
  STONE: "Taş",
  ENERGY: "Enerji",
  STEEL: "Çelik",
  MACHINE: "Makine"
};

const BUILDINGS = {
  WAREHOUSE: { name: "Depo", emoji: "📦", land: 1, cost: { scoin: 0, wood: 100, stone: 100, iron: 0 } },
  MINE: { name: "Demir Madeni", emoji: "⛏️", land: 1, cost: { scoin: 0, wood: 80, stone: 80, iron: 0 } },
  SAWMILL: { name: "Kereste Atölyesi", emoji: "🪚", land: 1, cost: { scoin: 0, wood: 120, stone: 80, iron: 40 } },
  QUARRY: { name: "Taş Ocağı", emoji: "🪨", land: 1, cost: { scoin: 0, wood: 80, stone: 120, iron: 40 } },
  POWER: { name: "Enerji Santrali", emoji: "⚡", land: 1, cost: { scoin: 50, wood: 120, stone: 180, iron: 100 } },
  STEEL_MILL: { name: "Çelik Tesisi", emoji: "🏭", land: 1, cost: { scoin: 100, wood: 180, stone: 250, iron: 300 } },
  MACHINE_FACTORY: { name: "Makine Fabrikası", emoji: "⚙️", land: 2, cost: { scoin: 200, wood: 300, stone: 250, iron: 400 } }
};

const appConfig = {
  starter: {
    scoin: 5000,
    iron: 300,
    wood: 400,
    stone: 400,
    energy: 200,
    land: 4
  }
};

const MINE_RATE = { 1: 100, 2: 250, 3: 600, 4: 1500 };
const UPGRADE_COST = { 1: 5000, 2: 12000, 3: 30000 };

function money(value) {
  return Number(value || 0);
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    username: row.username,
    scoin: money(row.scoin),
    iron: money(row.iron),
    steel: money(row.steel),
    wood: money(row.wood),
    stone: money(row.stone),
    energy: money(row.energy),
    machines: money(row.machines),
    land: Number(row.land || 0),
    mineLevel: Number(row.mine_level || 0)
  };
}

async function q(sql, params = [], client = pool) {
  return client.query(sql, params);
}

async function initDb() {
  // Keep authentication independent from game-specific tables.
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
      mines INTEGER NOT NULL DEFAULT 0,
      production_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Safely add columns needed by newer game versions.
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS scoin NUMERIC(20,2) NOT NULL DEFAULT 5000`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS iron NUMERIC(20,2) NOT NULL DEFAULT 300`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS steel NUMERIC(20,2) NOT NULL DEFAULT 0`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS wood NUMERIC(20,2) NOT NULL DEFAULT 400`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stone NUMERIC(20,2) NOT NULL DEFAULT 400`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS energy NUMERIC(20,2) NOT NULL DEFAULT 200`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS machines NUMERIC(20,2) NOT NULL DEFAULT 0`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS land INTEGER NOT NULL DEFAULT 4`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mine_level INTEGER NOT NULL DEFAULT 1`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mines INTEGER NOT NULL DEFAULT 0`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS production_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);

  await q(`
    CREATE TABLE IF NOT EXISTS buildings (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      level INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS listings (
      id BIGSERIAL PRIMARY KEY,
      seller_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      resource TEXT NOT NULL DEFAULT 'IRON',
      qty NUMERIC(20,2) NOT NULL CHECK(qty > 0),
      price NUMERIC(20,2) NOT NULL CHECK(price > 0),
      status TEXT NOT NULL DEFAULT 'OPEN',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sold_at TIMESTAMPTZ
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS transactions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      amount NUMERIC(20,2) NOT NULL DEFAULT 0,
      description TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await q(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS resource TEXT NOT NULL DEFAULT 'IRON'`);
  await q(`CREATE INDEX IF NOT EXISTS idx_buildings_user ON buildings(user_id, type)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_listings_open ON listings(status, created_at DESC)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id, created_at DESC)`);

  // One-time compatibility migration for accounts created before V11.
  const oldUsers = await q(`
    SELECT id, mines, mine_level
    FROM users u
    WHERE COALESCE(mines,0) > 0
      AND NOT EXISTS (SELECT 1 FROM buildings b WHERE b.user_id=u.id)
  `);

  for (const row of oldUsers.rows) {
    const count = Math.max(0, Number(row.mines || 0));
    const level = Math.max(1, Math.min(4, Number(row.mine_level || 1)));
    for (let i = 0; i < count; i++) {
      await q(`INSERT INTO buildings(user_id,type,level) VALUES($1,'MINE',$2)`, [row.id, level]);
    }
    await q(`
      INSERT INTO transactions(user_id,type,amount,description)
      VALUES($1,'MIGRATION',0,'Eski maden verileri yeni yapı sistemine aktarıldı')
    `, [row.id]);
  }
}

async function getUser(id, client = pool) {
  const r = await q(`
    SELECT id,username,scoin,iron,steel,wood,stone,energy,machines,land,mines,mine_level,production_updated_at
    FROM users WHERE id=$1
  `, [id], client);
  return r.rows[0] || null;
}

async function accrueProduction(id, client = pool) {
  // Never make authentication depend on this calculation.
  // It is called only after the user has already authenticated.
  await q(`
    WITH rates AS (
      SELECT
        user_id,
        COALESCE(SUM(
          CASE WHEN type='MINE' THEN
            CASE level
              WHEN 1 THEN 100
              WHEN 2 THEN 250
              WHEN 3 THEN 600
              WHEN 4 THEN 1500
              ELSE 100
            END
          ELSE 0 END
        ),0) AS iron_rate,
        COALESCE(SUM(CASE WHEN type='SAWMILL' THEN 80 ELSE 0 END),0) AS wood_rate,
        COALESCE(SUM(CASE WHEN type='QUARRY' THEN 80 ELSE 0 END),0) AS stone_rate,
        COALESCE(SUM(CASE WHEN type='POWER' THEN 120 ELSE 0 END),0) AS energy_rate
      FROM buildings
      WHERE user_id=$1
      GROUP BY user_id
    )
    UPDATE users u
    SET
      iron = u.iron + COALESCE(r.iron_rate,0) *
        LEAST(24,GREATEST(0,EXTRACT(EPOCH FROM (NOW()-u.production_updated_at))/3600)),
      wood = u.wood + COALESCE(r.wood_rate,0) *
        LEAST(24,GREATEST(0,EXTRACT(EPOCH FROM (NOW()-u.production_updated_at))/3600)),
      stone = u.stone + COALESCE(r.stone_rate,0) *
        LEAST(24,GREATEST(0,EXTRACT(EPOCH FROM (NOW()-u.production_updated_at))/3600)),
      energy = u.energy + COALESCE(r.energy_rate,0) *
        LEAST(24,GREATEST(0,EXTRACT(EPOCH FROM (NOW()-u.production_updated_at))/3600)),
      production_updated_at=NOW()
    FROM rates r
    WHERE u.id=r.user_id
  `, [id], client);
}

async function getBuildingCounts(id, client = pool) {
  const r = await q(`
    SELECT type, COUNT(*)::int AS count,
           COALESCE(SUM(level),0)::int AS levels
    FROM buildings
    WHERE user_id=$1
    GROUP BY type
  `, [id], client);

  const out = {};
  for (const row of r.rows) {
    out[row.type] = { count:Number(row.count), levels:Number(row.levels) };
  }
  return out;
}

async function fullState(id, client = pool) {
  await accrueProduction(id, client);
  const u = await getUser(id, client);
  if (!u) return null;

  const buildings = await getBuildingCounts(id, client);

  let usedLand = 0;
  let ironRate = 0;
  let woodRate = 0;
  let stoneRate = 0;
  let energyRate = 0;

  for (const [type, info] of Object.entries(buildings)) {
    const def = BUILDINGS[type];
    if (!def) continue;

    usedLand += def.land * info.count;

    if (type === "SAWMILL") woodRate += info.count * 80;
    if (type === "QUARRY") stoneRate += info.count * 80;
    if (type === "POWER") energyRate += info.count * 120;
  }

  const mineRows = await q(
    `SELECT level FROM buildings WHERE user_id=$1 AND type='MINE' ORDER BY id`,
    [id],
    client
  );

  for (const row of mineRows.rows) {
    ironRate += MINE_RATE[Number(row.level)] || 100;
  }

  return {
    ...publicUser(u),
    usedLand,
    freeLand: Math.max(0, Number(u.land) - usedLand),
    mineLevels: mineRows.rows.map(r => Number(r.level)),
    buildings,
    production: {
      iron: ironRate,
      wood: woodRate,
      stone: stoneRate,
      energy: energyRate
    }
  };
}

async function auth(req, reply) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    return reply.code(401).send({ error: "Oturum gerekli." });
  }

  try {
    req.user = await app.jwt.verify(header.slice(7));
  } catch {
    return reply.code(401).send({ error: "Oturum geçersiz veya süresi dolmuş." });
  }
}

app.register(cors, { origin: true });
app.register(jwt, {
  secret: process.env.JWT_SECRET || "CHANGE_ME_IN_RENDER"
});

app.get("/health", async () => ({
  ok: true,
  service: "sanal-ekonomi",
  version: "13.0.0",
  currency: "SCoin"
}));

// AUTH: no building, production or marketplace logic here.
app.post("/register", async (req, reply) => {
  try {
    const { username, password } = req.body || {};
    const clean = typeof username === "string" ? username.trim() : "";

    if (clean.length < 3 || clean.length > 30) {
      return reply.code(400).send({ error: "Kullanıcı adı 3-30 karakter olmalı." });
    }
    if (typeof password !== "string" || password.length < 6) {
      return reply.code(400).send({ error: "Şifre en az 6 karakter olmalı." });
    }

    const exists = await q(
      `SELECT id FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1`,
      [clean]
    );

    if (exists.rows.length) {
      return reply.code(409).send({ error: "Kullanıcı adı zaten kullanılıyor." });
    }

    const hash = await bcrypt.hash(password, 12);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const created = await client.query(`
        INSERT INTO users(
          username,password_hash,scoin,iron,steel,wood,stone,energy,machines,land,mine_level,mines
        )
        VALUES($1,$2,$3,$4,0,$5,$6,$7,0,$8,1,0)
        RETURNING id,username,scoin,iron,steel,wood,stone,energy,machines,land,mine_level
      `, [
        clean,
        hash,
        appConfig.starter.scoin,
        appConfig.starter.iron,
        appConfig.starter.wood,
        appConfig.starter.stone,
        appConfig.starter.energy,
        appConfig.starter.land
      ]);

      const id = Number(created.rows[0].id);

      // Starter buildings are created in the same DB transaction.
      for (const type of ["WAREHOUSE","MINE","SAWMILL","QUARRY"]) {
        await client.query(
          `INSERT INTO buildings(user_id,type,level) VALUES($1,$2,1)`,
          [id, type]
        );
      }

      await client.query(`
        INSERT INTO transactions(user_id,type,amount,description)
        VALUES($1,'STARTER',0,'Başlangıç paketi oluşturuldu')
      `, [id]);

      await client.query("COMMIT");

      // IMPORTANT: token is issued from the simple auth record only.
      return reply.code(201).send({
        token: app.jwt.sign({ id }),
        user: publicUser(created.rows[0])
      });
    } catch (e) {
      await client.query("ROLLBACK");
      if (e.code === "23505") {
        return reply.code(409).send({ error: "Kullanıcı adı zaten kullanılıyor." });
      }
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    app.log.error(e, "REGISTER_ERROR");
    return reply.code(500).send({ error: "Kayıt sırasında sunucu hatası oluştu." });
  }
});

app.post("/login", async (req, reply) => {
  try {
    const { username, password } = req.body || {};
    const clean = typeof username === "string" ? username.trim() : "";

    if (!clean || typeof password !== "string") {
      return reply.code(400).send({ error: "Kullanıcı adı ve şifre gerekli." });
    }

    const r = await q(
      `SELECT id,username,password_hash,scoin,iron,steel,wood,stone,energy,machines,land,mine_level
       FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1`,
      [clean]
    );

    const u = r.rows[0];

    if (!u || !(await bcrypt.compare(password, u.password_hash))) {
      return reply.code(401).send({ error: "Kullanıcı adı veya şifre hatalı." });
    }

    // DO NOT run production/building logic during authentication.
    return reply.code(200).send({
      token: app.jwt.sign({ id: Number(u.id) }),
      user: publicUser(u)
    });
  } catch (e) {
    app.log.error(e, "LOGIN_ERROR");
    return reply.code(500).send({ error: "Giriş sırasında sunucu hatası oluştu." });
  }
});

app.get("/me", { preHandler: auth }, async (req, reply) => {
  try {
    const state = await fullState(req.user.id);
    if (!state) return reply.code(404).send({ error: "Kullanıcı bulunamadı." });
    return state;
  } catch (e) {
    app.log.error(e, "ME_ERROR");
    return reply.code(500).send({ error: "Hesap bilgileri alınamadı." });
  }
});

app.get("/buildings", async () =>
  Object.entries(BUILDINGS).map(([type, def]) => ({ type, ...def }))
);

app.post("/build", { preHandler: auth }, async (req, reply) => {
  const type = String(req.body?.type || "").toUpperCase();
  const def = BUILDINGS[type];

  if (!def) return reply.code(400).send({ error: "Geçersiz yapı." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const state = await fullState(req.user.id, client);
    const u = await getUser(req.user.id, client);

    if (!u) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "Kullanıcı bulunamadı." });
    }

    if (state.freeLand < def.land) {
      await client.query("ROLLBACK");
      return reply.code(400).send({ error: `${def.land} boş arazi gerekli.` });
    }

    const label = {scoin:"SCoin",wood:"Kereste",stone:"Taş",iron:"Demir"};
    for (const [resource, cost] of Object.entries(def.cost)) {
      if (money(u[resource]) < cost) {
        await client.query("ROLLBACK");
        return reply.code(400).send({
          error: `Yetersiz ${label[resource] || resource}. Gerekli: ${cost}`
        });
      }
    }

    await client.query(`
      UPDATE users
      SET scoin=scoin-$1,wood=wood-$2,stone=stone-$3,iron=iron-$4
      WHERE id=$5
    `, [
      def.cost.scoin || 0,
      def.cost.wood || 0,
      def.cost.stone || 0,
      def.cost.iron || 0,
      req.user.id
    ]);

    await client.query(
      `INSERT INTO buildings(user_id,type,level) VALUES($1,$2,1)`,
      [req.user.id, type]
    );

    await client.query(
      `INSERT INTO transactions(user_id,type,amount,description)
       VALUES($1,'BUILD',$2,$3)`,
      [req.user.id, -(def.cost.scoin || 0), `${def.name} kuruldu`]
    );

    await client.query("COMMIT");
    return fullState(req.user.id);
  } catch (e) {
    await client.query("ROLLBACK");
    app.log.error(e, "BUILD_ERROR");
    return reply.code(500).send({ error: "Yapı kurulurken sunucu hatası oluştu." });
  } finally {
    client.release();
  }
});

app.post("/land/expand", { preHandler: auth }, async (req, reply) => {
  const cost = { scoin:250, wood:300, stone:300 };
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const u = await getUser(req.user.id, client);
    if (!u) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "Kullanıcı bulunamadı." });
    }

    for (const [key, value] of Object.entries(cost)) {
      if (money(u[key]) < value) {
        await client.query("ROLLBACK");
        return reply.code(400).send({
          error: `Yetersiz ${key === "scoin" ? "SCoin" : RESOURCE_LABEL[key.toUpperCase()]}. Gerekli: ${value}`
        });
      }
    }

    await client.query(`
      UPDATE users SET scoin=scoin-$1,wood=wood-$2,stone=stone-$3,land=land+1
      WHERE id=$4
    `, [cost.scoin,cost.wood,cost.stone,req.user.id]);

    await client.query(`
      INSERT INTO transactions(user_id,type,amount,description)
      VALUES($1,'LAND',-$2,'1 arazi genişletildi')
    `, [req.user.id,cost.scoin]);

    await client.query("COMMIT");
    return fullState(req.user.id);
  } catch(e) {
    await client.query("ROLLBACK");
    app.log.error(e, "LAND_ERROR");
    return reply.code(500).send({error:"Arazi işlemi sırasında sunucu hatası oluştu."});
  } finally {
    client.release();
  }
});

app.post("/mine/upgrade", { preHandler: auth }, async (req, reply) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const u = await getUser(req.user.id, client);
    const mines = await q(
      `SELECT id,level FROM buildings WHERE user_id=$1 AND type='MINE' ORDER BY id`,
      [req.user.id],
      client
    );

    if (!u || !mines.rows.length) {
      await client.query("ROLLBACK");
      return reply.code(400).send({error:"Önce maden kurmalısın."});
    }

    const levels = mines.rows.map(r => Number(r.level));
    const current = Math.min(...levels);

    if (current >= 4) {
      await client.query("ROLLBACK");
      return reply.code(400).send({error:"Madenler maksimum seviye olan 4'e ulaştı."});
    }

    const totalCost = (UPGRADE_COST[current] || 0) * mines.rows.length;
    if (money(u.scoin) < totalCost) {
      await client.query("ROLLBACK");
      return reply.code(400).send({
        error:`Tüm madenleri Lv${current+1}'e yükseltmek için ${totalCost.toLocaleString("tr-TR")} SCoin gerekli.`
      });
    }

    await client.query(
      `UPDATE buildings SET level=level+1
       WHERE user_id=$1 AND type='MINE' AND level=$2`,
      [req.user.id,current]
    );

    await client.query(`UPDATE users SET scoin=scoin-$1 WHERE id=$2`,[totalCost,req.user.id]);

    await client.query(`
      INSERT INTO transactions(user_id,type,amount,description)
      VALUES($1,'UPGRADE',$2,$3)
    `,[req.user.id,-totalCost,`Madenler Lv${current} → Lv${current+1}`]);

    await client.query("COMMIT");
    return fullState(req.user.id);
  } catch(e) {
    await client.query("ROLLBACK");
    app.log.error(e, "UPGRADE_ERROR");
    return reply.code(500).send({error:"Maden yükseltme sırasında sunucu hatası oluştu."});
  } finally {
    client.release();
  }
});

app.post("/produce/steel",{preHandler:auth},async(req,reply)=>{
  const client=await pool.connect();

  try{
    await client.query("BEGIN");
    const u=await getUser(req.user.id,client);
    const mills=Number((await q(
      `SELECT COUNT(*)::int c FROM buildings WHERE user_id=$1 AND type='STEEL_MILL'`,
      [req.user.id],client
    )).rows[0].c);

    if(!mills){await client.query("ROLLBACK");return reply.code(400).send({error:"Önce Çelik Tesisi kurmalısın."});}

    const batches=Math.min(mills,Math.floor(Math.min(money(u.iron)/10,money(u.energy)/10)));
    if(batches<1){await client.query("ROLLBACK");return reply.code(400).send({error:"Çelik için en az 10 demir ve 10 enerji gerekli."});}

    await client.query(
      `UPDATE users SET iron=iron-$1,energy=energy-$2,steel=steel+$3 WHERE id=$4`,
      [batches*10,batches*10,batches,req.user.id]
    );
    await client.query(
      `INSERT INTO transactions(user_id,type,amount,description) VALUES($1,'STEEL',0,$2)`,
      [req.user.id,`${batches} Çelik üretildi`]
    );

    await client.query("COMMIT");
    return fullState(req.user.id);
  }catch(e){
    await client.query("ROLLBACK");
    return reply.code(500).send({error:"Çelik üretiminde sunucu hatası oluştu."});
  }finally{client.release();}
});

app.post("/produce/machine",{preHandler:auth},async(req,reply)=>{
  const client=await pool.connect();

  try{
    await client.query("BEGIN");
    const u=await getUser(req.user.id,client);
    const factories=Number((await q(
      `SELECT COUNT(*)::int c FROM buildings WHERE user_id=$1 AND type='MACHINE_FACTORY'`,
      [req.user.id],client
    )).rows[0].c);

    if(!factories){await client.query("ROLLBACK");return reply.code(400).send({error:"Önce Makine Fabrikası kurmalısın."});}

    const batches=Math.min(factories,Math.floor(Math.min(
      money(u.steel)/5,money(u.iron)/20,money(u.wood)/10,money(u.energy)/20
    )));

    if(batches<1){await client.query("ROLLBACK");return reply.code(400).send({error:"Makine için Çelik, Demir, Kereste ve Enerji yetersiz."});}

    await client.query(`
      UPDATE users SET steel=steel-$1,iron=iron-$2,wood=wood-$3,energy=energy-$4,machines=machines+$5
      WHERE id=$6
    `,[batches*5,batches*20,batches*10,batches*20,batches,req.user.id]);

    await client.query(
      `INSERT INTO transactions(user_id,type,amount,description) VALUES($1,'MACHINE',0,$2)`,
      [req.user.id,`${batches} Makine üretildi`]
    );

    await client.query("COMMIT");
    return fullState(req.user.id);
  }catch(e){
    await client.query("ROLLBACK");
    return reply.code(500).send({error:"Makine üretiminde sunucu hatası oluştu."});
  }finally{client.release();}
});

app.get("/market",async()=>{
  const r=await q(`
    SELECT l.id,l.resource,l.qty,l.price,u.username
    FROM listings l
    JOIN users u ON u.id=l.seller_id
    WHERE l.status='OPEN'
    ORDER BY l.id DESC
  `);

  return r.rows.map(x=>({
    id:Number(x.id),
    resource:x.resource,
    qty:money(x.qty),
    price:money(x.price),
    username:x.username,
    unitPrice:Number(x.price)/Number(x.qty)
  }));
});

app.post("/market/list",{preHandler:auth},async(req,reply)=>{
  const resource=String(req.body?.resource||"IRON").toUpperCase();
  const qty=Number(req.body?.qty);
  const price=Number(req.body?.price);

  const column={
    IRON:"iron",STEEL:"steel",WOOD:"wood",STONE:"stone",
    ENERGY:"energy",MACHINE:"machines"
  }[resource];

  if(!column)return reply.code(400).send({error:"Geçersiz kaynak."});
  if(!Number.isInteger(qty)||qty<=0)return reply.code(400).send({error:"Miktar pozitif bir tam sayı olmalı."});
  if(!Number.isInteger(price)||price<=0)return reply.code(400).send({error:"Fiyat pozitif bir tam sayı olmalı."});

  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await accrueProduction(req.user.id,client);
    const u=await getUser(req.user.id,client);

    if(money(u[column])<qty){
      await client.query("ROLLBACK");
      return reply.code(400).send({error:`Yetersiz ${RESOURCE_LABEL[resource]}.`});
    }

    await client.query(`UPDATE users SET ${column}=${column}-$1 WHERE id=$2`,[qty,req.user.id]);
    await client.query(
      `INSERT INTO listings(seller_id,resource,qty,price) VALUES($1,$2,$3,$4)`,
      [req.user.id,resource,qty,price]
    );

    await client.query(
      `INSERT INTO transactions(user_id,type,amount,description) VALUES($1,'LIST',0,$2)`,
      [req.user.id,`${qty} ${RESOURCE_LABEL[resource]} satış ilanı açıldı`]
    );

    await client.query("COMMIT");
    return fullState(req.user.id);
  }catch(e){
    await client.query("ROLLBACK");
    return reply.code(500).send({error:"İlan oluşturulurken sunucu hatası oluştu."});
  }finally{client.release();}
});

app.post("/market/buy/:id",{preHandler:auth},async(req,reply)=>{
  const client=await pool.connect();

  try{
    await client.query("BEGIN");
    const lr=await q(
      `SELECT * FROM listings WHERE id=$1 AND status='OPEN' FOR UPDATE`,
      [Number(req.params.id)],client
    );
    const listing=lr.rows[0];

    if(!listing||Number(listing.seller_id)===Number(req.user.id)){
      await client.query("ROLLBACK");
      return reply.code(400).send({error:"İlan bulunamadı."});
    }

    const buyer=await getUser(req.user.id,client);
    const seller=await getUser(Number(listing.seller_id),client);

    const column={
      IRON:"iron",STEEL:"steel",WOOD:"wood",STONE:"stone",
      ENERGY:"energy",MACHINE:"machines"
    }[listing.resource];

    if(money(buyer.scoin)<money(listing.price)){
      await client.query("ROLLBACK");
      return reply.code(400).send({error:"Yetersiz SCoin."});
    }

    const fee=Math.floor(money(listing.price)*0.03);
    const net=money(listing.price)-fee;

    await client.query(
      `UPDATE users SET scoin=scoin-$1,${column}=${column}+$2 WHERE id=$3`,
      [money(listing.price),money(listing.qty),buyer.id]
    );
    await client.query(
      `UPDATE users SET scoin=scoin+$1 WHERE id=$2`,
      [net,seller.id]
    );
    await client.query(
      `UPDATE listings SET status='SOLD',sold_at=NOW() WHERE id=$1`,
      [listing.id]
    );

    await client.query(
      `INSERT INTO transactions(user_id,type,amount,description) VALUES($1,'BUY',$2,$3)`,
      [buyer.id,-money(listing.price),`${listing.qty} ${RESOURCE_LABEL[listing.resource]} satın alındı`]
    );
    await client.query(
      `INSERT INTO transactions(user_id,type,amount,description) VALUES($1,'SALE',$2,$3)`,
      [seller.id,net,`${listing.qty} ${RESOURCE_LABEL[listing.resource]} satıldı; %3 komisyon: ${fee} SCoin`]
    );

    await client.query("COMMIT");
    return fullState(buyer.id);
  }catch(e){
    await client.query("ROLLBACK");
    return reply.code(500).send({error:"Marketplace işleminde sunucu hatası oluştu."});
  }finally{client.release();}
});

app.get("/transactions",{preHandler:auth},async(req,reply)=>{
  try{
    const r=await q(`
      SELECT id,type,amount,description,created_at
      FROM transactions WHERE user_id=$1
      ORDER BY id DESC LIMIT 50
    `,[req.user.id]);
    return r.rows;
  }catch{
    return reply.code(500).send({error:"İşlem geçmişi alınamadı."});
  }
});

const html=`<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>Sanal Ekonomi</title>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#eef2f5;color:#17212b;margin:0}
header{background:#101820;color:white;padding:18px;position:sticky;top:0;z-index:5}
.wrap{max-width:1120px;margin:auto;padding:16px}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.card{background:white;padding:15px;border-radius:15px;margin-bottom:10px;box-shadow:0 2px 9px #0001}
.stat{font-size:24px;font-weight:750}
.small{font-size:12px;color:#68737d}
button{background:#1769e0;color:#fff;border:0;border-radius:9px;padding:11px 13px;margin:3px;font-weight:650;cursor:pointer}
input,select{width:100%;padding:12px;border:1px solid #ccd3da;border-radius:9px;margin:4px 0;font-size:16px}
table{width:100%;border-collapse:collapse}td,th{padding:8px;border-bottom:1px solid #e5e8eb;text-align:left;white-space:nowrap}
.badge{background:#e7efff;color:#1559b6;border-radius:99px;padding:4px 8px;font-size:12px}
.buildinggrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.build{border:1px solid #e3e7eb;border-radius:12px;padding:11px}
@media(min-width:760px){.grid{grid-template-columns:repeat(4,minmax(0,1fr))}.buildinggrid{grid-template-columns:repeat(4,minmax(0,1fr))}}
</style>
</head>
<body>
<header>🌍 <b>SANAL EKONOMİ</b> <span class="badge">SCoin + Kaynak Ekonomisi</span></header>
<div class="wrap">

<div id="auth" class="card">
<h2>Giriş / Kayıt</h2>
<input id="loginUser" placeholder="Kullanıcı adı" autocomplete="username">
<input id="loginPass" type="password" placeholder="Şifre" autocomplete="current-password">
<button id="registerBtn">Kayıt Ol</button>
<button id="loginBtn">Giriş Yap</button>
<p id="authMsg"></p>
</div>

<div id="game" style="display:none">
<div class="grid">
<div class="card"><span class="small">SCoin</span><div id="sc" class="stat">0</div></div>
<div class="card"><span class="small">Demir</span><div id="iron" class="stat">0</div></div>
<div class="card"><span class="small">Kereste</span><div id="wood" class="stat">0</div></div>
<div class="card"><span class="small">Taş</span><div id="stone" class="stat">0</div></div>
</div>
<div class="grid">
<div class="card"><span class="small">Enerji</span><div id="energy" class="stat">0</div></div>
<div class="card"><span class="small">Çelik</span><div id="steel" class="stat">0</div></div>
<div class="card"><span class="small">Makine</span><div id="machines" class="stat">0</div></div>
<div class="card"><span class="small">Arazi</span><div id="land" class="stat">0</div><div id="freeLand" class="small"></div></div>
</div>

<div class="grid">
<div class="card"><span class="small">Demir üretimi</span><div id="ironRate" class="stat">0</div><div class="small">/ saat</div></div>
<div class="card"><span class="small">Kereste üretimi</span><div id="woodRate" class="stat">0</div><div class="small">/ saat</div></div>
<div class="card"><span class="small">Taş üretimi</span><div id="stoneRate" class="stat">0</div><div class="small">/ saat</div></div>
<div class="card"><span class="small">Enerji üretimi</span><div id="energyRate" class="stat">0</div><div class="small">/ saat</div></div>
</div>

<div class="card">
<h2>🏗️ Yapılar</h2>
<div id="buildingList" class="buildinggrid"></div>
<div class="card" style="margin-top:10px"><b>Arazi Genişlet</b><p>+1 arazi = 250 SCoin + 300 Kereste + 300 Taş</p><button data-action="/land/expand">Genişlet</button></div>
</div>

<div class="grid">
<div class="card"><h3>⛏️ Maden Geliştirme</h3><p class="small" id="upgradeInfo"></p><button data-action="/mine/upgrade">Madenleri Geliştir</button></div>
<div class="card"><h3>🏭 Çelik</h3><p>10 Demir + 10 Enerji → 1 Çelik</p><button data-action="/produce/steel">Üret</button></div>
<div class="card"><h3>⚙️ Makine</h3><p>5 Çelik + 20 Demir + 10 Kereste + 20 Enerji → 1 Makine</p><button data-action="/produce/machine">Üret</button></div>
<div class="card"><h3>👤 Hesap</h3><p>Oyuncu: <b id="playerName"></b></p><button id="logoutBtn">Çıkış</button></div>
</div>

<div class="card">
<h2>🛒 Marketplace</h2>
<div class="grid">
<select id="marketResource">
<option value="IRON">Demir</option><option value="WOOD">Kereste</option><option value="STONE">Taş</option>
<option value="ENERGY">Enerji</option><option value="STEEL">Çelik</option><option value="MACHINE">Makine</option>
</select>
<input id="marketQty" type="number" min="1" placeholder="Miktar">
<input id="marketPrice" type="number" min="1" placeholder="Toplam SCoin">
<button id="sellBtn">İlan Aç</button>
</div>
<hr>
<div style="overflow:auto"><table><thead><tr><th>Satıcı</th><th>Kaynak</th><th>Miktar</th><th>Toplam</th><th>Birim</th><th></th></tr></thead><tbody id="marketBody"></tbody></table></div>
</div>

<div class="card">
<h2>📜 Son İşlemler</h2>
<div style="overflow:auto"><table><tbody id="txBody"></tbody></table></div>
</div>
</div>
</div>

<script>
let token = "";
const labels = {IRON:"Demir",WOOD:"Kereste",STONE:"Taş",ENERGY:"Enerji",STEEL:"Çelik",MACHINE:"Makine"};

function fmt(n){
  return Number(n||0).toLocaleString("tr-TR",{maximumFractionDigits:2});
}

async function api(path, options={}){
  const opts={...options,headers:{...(options.headers||{})}};
  if(token) opts.headers.Authorization="Bearer "+token;
  if(opts.body!==undefined) opts.headers["Content-Type"]="application/json";

  const res=await fetch(path,opts);
  let data={};
  try{data=await res.json()}catch{}
  if(!res.ok) throw new Error(data.error||("HTTP "+res.status));
  return data;
}

async function doRegister(){
  const username=document.getElementById("loginUser").value.trim();
  const password=document.getElementById("loginPass").value;

  if(username.length<3){authMsg.textContent="Kullanıcı adı en az 3 karakter olmalı.";return}
  if(password.length<6){authMsg.textContent="Şifre en az 6 karakter olmalı.";return}

  try{
    const d=await api("/register",{method:"POST",body:JSON.stringify({username,password})});
    token=d.token;
    openGame();
  }catch(e){authMsg.textContent=e.message}
}

async function doLogin(){
  const username=document.getElementById("loginUser").value.trim();
  const password=document.getElementById("loginPass").value;

  try{
    const d=await api("/login",{method:"POST",body:JSON.stringify({username,password})});
    token=d.token;
    openGame();
  }catch(e){authMsg.textContent=e.message}
}

function openGame(){
  document.getElementById("auth").style.display="none";
  document.getElementById("game").style.display="block";
  refreshAll();
}

function logout(){
  token="";
  document.getElementById("game").style.display="none";
  document.getElementById("auth").style.display="block";
  document.getElementById("loginPass").value="";
  document.getElementById("authMsg").textContent="";
}

async function refreshAll(){
  const u=await api("/me");

  document.getElementById("sc").textContent=fmt(u.scoin);
  document.getElementById("iron").textContent=fmt(u.iron);
  document.getElementById("wood").textContent=fmt(u.wood);
  document.getElementById("stone").textContent=fmt(u.stone);
  document.getElementById("energy").textContent=fmt(u.energy);
  document.getElementById("steel").textContent=fmt(u.steel);
  document.getElementById("machines").textContent=fmt(u.machines);
  document.getElementById("land").textContent=u.land;
  document.getElementById("freeLand").textContent="Boş arazi: "+u.freeLand;
  document.getElementById("ironRate").textContent=fmt(u.production.iron);
  document.getElementById("woodRate").textContent=fmt(u.production.wood);
  document.getElementById("stoneRate").textContent=fmt(u.production.stone);
  document.getElementById("energyRate").textContent=fmt(u.production.energy);
  document.getElementById("playerName").textContent=u.username;

  if(u.mineLevels.length===0){
    document.getElementById("upgradeInfo").textContent="Henüz maden yok.";
  }else if(u.mineLevels.every(v=>v===4)){
    document.getElementById("upgradeInfo").textContent="Madenler Lv4 (maksimum).";
  }else{
    const min=Math.min(...u.mineLevels);
    const costs={1:5000,2:12000,3:30000};
    document.getElementById("upgradeInfo").textContent="Mevcut en düşük seviye: Lv"+min+" | Sonraki yükseltme: "+fmt(costs[min])+" SCoin / maden";
  }

  const buildings=await api("/buildings");
  const counts=u.buildings||{};
  document.getElementById("buildingList").innerHTML=buildings.map(b=>{
    const c=counts[b.type]?.count||0;
    const cost=Object.entries(b.cost).filter(([,v])=>Number(v)>0).map(([k,v])=>
      k==="scoin"?fmt(v)+" SCoin":fmt(v)+" "+(labels[k.toUpperCase()]||k)
    ).join(" + ");

    return '<div class="build"><h3>'+b.emoji+' '+b.name+'</h3>'+
      '<p class="small">Kurulu: '+c+' | Arazi: '+b.land+'</p>'+
      '<p>'+(cost||"Kaynak maliyeti yok")+'</p>'+
      '<button onclick="build(\''+b.type+'\')">Kur</button></div>';
  }).join("");

  await refreshMarket();
  await refreshTransactions();
}

async function action(path){
  try{await api(path,{method:"POST",body:JSON.stringify({})});await refreshAll()}
  catch(e){alert(e.message)}
}

async function build(type){
  try{await api("/build",{method:"POST",body:JSON.stringify({type})});await refreshAll()}
  catch(e){alert(e.message)}
}

async function refreshMarket(){
  const rows=await api("/market");
  document.getElementById("marketBody").innerHTML=rows.map(v=>
    '<tr><td>'+v.username+'</td><td>'+labels[v.resource]+'</td><td>'+fmt(v.qty)+'</td>'+
    '<td>'+fmt(v.price)+' SCoin</td><td>'+fmt(v.unitPrice)+'</td>'+
    '<td><button onclick="buy('+v.id+')">Al</button></td></tr>'
  ).join("");
}

async function refreshTransactions(){
  const rows=await api("/transactions");
  document.getElementById("txBody").innerHTML=rows.map(v=>
    '<tr><td>'+v.description+'</td><td>'+fmt(v.amount)+' SCoin</td></tr>'
  ).join("");
}

async function sell(){
  try{
    await api("/market/list",{method:"POST",body:JSON.stringify({
      resource:document.getElementById("marketResource").value,
      qty:Number(document.getElementById("marketQty").value),
      price:Number(document.getElementById("marketPrice").value)
    })});
    document.getElementById("marketQty").value="";
    document.getElementById("marketPrice").value="";
    await refreshAll();
  }catch(e){alert(e.message)}
}

async function buy(id){
  try{await api("/market/buy/"+id,{method:"POST",body:JSON.stringify({})});await refreshAll()}
  catch(e){alert(e.message)}
}

document.getElementById("registerBtn").addEventListener("click",doRegister);
document.getElementById("loginBtn").addEventListener("click",doLogin);
document.getElementById("logoutBtn").addEventListener("click",logout);
document.querySelectorAll("[data-action]").forEach(btn=>{
  btn.addEventListener("click",()=>action(btn.dataset.action));
});
document.getElementById("sellBtn").addEventListener("click",sell);

document.getElementById("loginPass").addEventListener("keydown",e=>{
  if(e.key==="Enter") doLogin();
});

setInterval(()=>{
  if(token) refreshAll().catch(()=>{});
},30000);
</script>
</body>
</html>`;

app.get("/", async (_, reply) => {
  return reply.type("text/html; charset=utf-8").send(html);
});

const port = Number(process.env.PORT || 3000);

async function start() {
  await initDb();
  await app.listen({ port, host: "0.0.0.0" });
}

start().catch(err => {
  app.log.error(err);
  process.exit(1);
});
