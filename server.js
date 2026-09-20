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

async function q(text, params = []) {
  return pool.query(text, params);
}

function money(v) {
  return Number(v || 0);
}

const RESOURCE_LABEL = {
  IRON: "Demir",
  WOOD: "Kereste",
  STONE: "Taş",
  ENERGY: "Enerji",
  STEEL: "Çelik",
  MACHINE: "Makine"
};

const BUILDINGS = {
  WAREHOUSE: {
    name: "Depo",
    emoji: "📦",
    land: 1,
    cost: { scoin: 100, wood: 150, stone: 150, iron: 0 }
  },
  MINE: {
    name: "Demir Madeni",
    emoji: "⛏️",
    land: 1,
    cost: { scoin: 100, wood: 100, stone: 100, iron: 0 }
  },
  SAWMILL: {
    name: "Kereste Atölyesi",
    emoji: "🪚",
    land: 1,
    cost: { scoin: 100, wood: 150, stone: 100, iron: 50 }
  },
  QUARRY: {
    name: "Taş Ocağı",
    emoji: "🪨",
    land: 1,
    cost: { scoin: 100, wood: 100, stone: 150, iron: 50 }
  },
  POWER: {
    name: "Enerji Santrali",
    emoji: "⚡",
    land: 1,
    cost: { scoin: 150, wood: 150, stone: 250, iron: 150 }
  },
  STEEL_MILL: {
    name: "Çelik Tesisi",
    emoji: "🏭",
    land: 1,
    cost: { scoin: 250, wood: 200, stone: 300, iron: 500 }
  },
  MACHINE_FACTORY: {
    name: "Makine Fabrikası",
    emoji: "⚙️",
    land: 2,
    cost: { scoin: 500, wood: 400, stone: 300, iron: 500 }
  }
};

const MINE_RATE = { 1: 100, 2: 250, 3: 600, 4: 1500 };
const UPGRADE_COST = { 1: 5000, 2: 12000, 3: 30000 };

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
      mines INTEGER NOT NULL DEFAULT 0,
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

    -- Compatibility migrations for V9/V10/V11 databases.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS steel NUMERIC(20,2) NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS wood NUMERIC(20,2) NOT NULL DEFAULT 400;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS stone NUMERIC(20,2) NOT NULL DEFAULT 400;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS energy NUMERIC(20,2) NOT NULL DEFAULT 200;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS machines NUMERIC(20,2) NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS land INTEGER NOT NULL DEFAULT 4;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS mine_level INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS mines INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS production_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

    ALTER TABLE listings ADD COLUMN IF NOT EXISTS resource TEXT NOT NULL DEFAULT 'IRON';

    CREATE INDEX IF NOT EXISTS idx_buildings_user
      ON buildings(user_id, type);

    CREATE INDEX IF NOT EXISTS idx_listings_open
      ON listings(status, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_transactions_user
      ON transactions(user_id, created_at DESC);
  `);

  // One-time migration: if an older database has a "mines" counter
  // but no building records yet, materialize those mines into the new
  // building system. This fixes the V11 schema transition.
  const oldUsers = await q(`
    SELECT id, mines, mine_level
    FROM users
    WHERE COALESCE(mines, 0) > 0
      AND NOT EXISTS (
        SELECT 1 FROM buildings b
        WHERE b.user_id = users.id
      )
  `);

  for (const row of oldUsers.rows) {
    const count = Number(row.mines || 0);
    const level = Math.max(1, Math.min(4, Number(row.mine_level || 1)));

    for (let i = 0; i < count; i++) {
      await q(
        `INSERT INTO buildings(user_id, type, level)
         VALUES($1, 'MINE', $2)`,
        [row.id, level]
      );
    }

    await q(
      `INSERT INTO transactions(user_id, type, amount, description)
       VALUES($1, 'MIGRATION', 0, 'Eski maden verileri yeni yapı sistemine aktarıldı')`,
      [row.id]
    );
  }
}

async function getUser(id, client = pool) {
  const r = await client.query(`
    SELECT id, username, scoin, iron, steel, wood, stone, energy,
           machines, land, mines, mine_level, production_updated_at
    FROM users
    WHERE id = $1
  `, [id]);
  return r.rows[0] || null;
}

async function accrueProduction(id, client = pool) {
  // Maximum passive-production catch-up: 24 hours.
  await client.query(`
    WITH rates AS (
      SELECT
        user_id,
        COALESCE(SUM(
          CASE
            WHEN type='MINE'
              THEN CASE level
                WHEN 1 THEN 100
                WHEN 2 THEN 250
                WHEN 3 THEN 600
                WHEN 4 THEN 1500
                ELSE 100
              END
            ELSE 0
          END
        ), 0) AS iron_rate,
        COALESCE(SUM(CASE WHEN type='SAWMILL' THEN 80 ELSE 0 END), 0) AS wood_rate,
        COALESCE(SUM(CASE WHEN type='QUARRY' THEN 80 ELSE 0 END), 0) AS stone_rate,
        COALESCE(SUM(CASE WHEN type='POWER' THEN 120 ELSE 0 END), 0) AS energy_rate
      FROM buildings
      WHERE user_id = $1
      GROUP BY user_id
    )
    UPDATE users u
    SET
      iron = u.iron + COALESCE(r.iron_rate,0) *
        LEAST(24, GREATEST(0, EXTRACT(EPOCH FROM (NOW() - u.production_updated_at))/3600)),
      wood = u.wood + COALESCE(r.wood_rate,0) *
        LEAST(24, GREATEST(0, EXTRACT(EPOCH FROM (NOW() - u.production_updated_at))/3600)),
      stone = u.stone + COALESCE(r.stone_rate,0) *
        LEAST(24, GREATEST(0, EXTRACT(EPOCH FROM (NOW() - u.production_updated_at))/3600)),
      energy = u.energy + COALESCE(r.energy_rate,0) *
        LEAST(24, GREATEST(0, EXTRACT(EPOCH FROM (NOW() - u.production_updated_at))/3600)),
      production_updated_at = NOW()
    FROM rates r
    WHERE u.id = r.user_id
  `, [id]);

  await client.query(`
    UPDATE users
    SET production_updated_at = NOW()
    WHERE id = $1
      AND NOT EXISTS (
        SELECT 1 FROM buildings WHERE user_id = $1
      )
  `, [id]);
}

async function buildingCounts(id, client = pool) {
  const r = await client.query(`
    SELECT
      type,
      COUNT(*)::int AS count,
      COALESCE(SUM(level),0)::int AS levels,
      COALESCE(AVG(level),1)::numeric AS avg_level
    FROM buildings
    WHERE user_id = $1
    GROUP BY type
  `, [id]);

  const out = {};
  for (const row of r.rows) {
    out[row.type] = {
      count: Number(row.count),
      levels: Number(row.levels),
      avgLevel: Number(row.avg_level)
    };
  }
  return out;
}

async function publicState(id, client = pool) {
  await accrueProduction(id, client);

  const u = await getUser(id, client);
  if (!u) return null;

  const buildings = await buildingCounts(id, client);

  let usedLand = 0;
  let ironRate = 0;
  let woodRate = 0;
  let stoneRate = 0;
  let energyRate = 0;

  for (const [type, info] of Object.entries(buildings)) {
    const definition = BUILDINGS[type];
    if (!definition) continue;

    usedLand += definition.land * info.count;

    if (type === "MINE") {
      const rows = await client.query(
        `SELECT level FROM buildings WHERE user_id=$1 AND type='MINE'`,
        [id]
      );
      ironRate = rows.rows.reduce(
        (sum, row) => sum + (MINE_RATE[Number(row.level)] || 100),
        0
      );
    }

    if (type === "SAWMILL") woodRate += info.count * 80;
    if (type === "QUARRY") stoneRate += info.count * 80;
    if (type === "POWER") energyRate += info.count * 120;
  }

  const mineLevels = await client.query(
    `SELECT level FROM buildings WHERE user_id=$1 AND type='MINE' ORDER BY id`,
    [id]
  );

  const mineLevelList = mineLevels.rows.map(r => Number(r.level));
  const displayedMineLevel =
    mineLevelList.length === 0
      ? 0
      : mineLevelList.every(v => v === mineLevelList[0])
        ? mineLevelList[0]
        : 0;

  return {
    id: Number(u.id),
    username: u.username,
    scoin: money(u.scoin),
    iron: money(u.iron),
    steel: money(u.steel),
    wood: money(u.wood),
    stone: money(u.stone),
    energy: money(u.energy),
    machines: money(u.machines),
    land: Number(u.land),
    usedLand,
    freeLand: Number(u.land) - usedLand,
    mineLevel: displayedMineLevel,
    mineLevels: mineLevelList,
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
  try {
    req.user = await app.jwt.verify(
      (req.headers.authorization || "").replace(/^Bearer\s+/i, "")
    );
  } catch {
    return reply.code(401).send({ error: "Oturum gerekli." });
  }
}

app.register(cors, { origin: true });
app.register(jwt, {
  secret: process.env.JWT_SECRET || "CHANGE_ME_IN_RENDER"
});

app.get("/health", async () => ({
  ok: true,
  service: "sanal-ekonomi",
  version: "12.0.0",
  currency: "SCoin"
}));

app.post("/register", async (req, reply) => {
  const { username, password } = req.body || {};
  const clean = typeof username === "string" ? username.trim() : "";

  if (
    clean.length < 3 ||
    clean.length > 30 ||
    typeof password !== "string" ||
    password.length < 6
  ) {
    return reply.code(400).send({
      error: "Kullanıcı adı 3-30 karakter, şifre en az 6 karakter olmalı."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (
      (
        await client.query(
          `SELECT 1 FROM users WHERE LOWER(username)=LOWER($1)`,
          [clean]
        )
      ).rows.length
    ) {
      await client.query("ROLLBACK");
      return reply.code(409).send({
        error: "Kullanıcı adı zaten kullanılıyor."
      });
    }

    const hash = await bcrypt.hash(password, 12);

    const r = await client.query(`
      INSERT INTO users(username,password_hash)
      VALUES($1,$2)
      RETURNING id
    `, [clean, hash]);

    const id = Number(r.rows[0].id);

    // Easy-start starter economy.
    for (const type of ["WAREHOUSE", "MINE", "SAWMILL", "QUARRY"]) {
      await client.query(
        `INSERT INTO buildings(user_id,type,level)
         VALUES($1,$2,1)`,
        [id, type]
      );
    }

    await client.query(`
      INSERT INTO transactions(user_id,type,amount,description)
      VALUES($1,'STARTER',0,
        'Başlangıç paketi: Depo + Maden + Kereste Atölyesi + Taş Ocağı')
    `, [id]);

    await client.query("COMMIT");

    return {
      token: app.jwt.sign({ id }),
      user: await publicState(id)
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

app.post("/login", async (req, reply) => {
  const { username, password } = req.body || {};
  const r = await q(
    `SELECT * FROM users WHERE LOWER(username)=LOWER($1)`,
    [String(username || "").trim()]
  );
  const u = r.rows[0];

  if (!u || !(await bcrypt.compare(password || "", u.password_hash))) {
    return reply.code(401).send({
      error: "Kullanıcı adı veya şifre hatalı."
    });
  }

  return {
    token: app.jwt.sign({ id: Number(u.id) }),
    user: await publicState(Number(u.id))
  };
});

app.get("/me", { preHandler: auth }, async (req, reply) => {
  const state = await publicState(req.user.id);
  if (!state) return reply.code(404).send({ error: "Kullanıcı bulunamadı." });
  return state;
});

app.get("/buildings", async () =>
  Object.entries(BUILDINGS).map(([type, b]) => ({
    type,
    ...b
  }))
);

app.post("/build", { preHandler: auth }, async (req, reply) => {
  const type = String(req.body?.type || "").toUpperCase();
  const b = BUILDINGS[type];

  if (!b) {
    return reply.code(400).send({ error: "Geçersiz yapı." });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await accrueProduction(req.user.id, client);

    const u = await getUser(req.user.id, client);
    if (!u) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "Kullanıcı bulunamadı." });
    }

    const state = await publicState(req.user.id, client);

    if (state.freeLand < b.land) {
      await client.query("ROLLBACK");
      return reply.code(400).send({
        error: `${b.land} boş arazi gerekli.`
      });
    }

    const costMap = {
      scoin: "SCoin",
      wood: "Kereste",
      stone: "Taş",
      iron: "Demir"
    };

    for (const [resource, cost] of Object.entries(b.cost)) {
      if (money(u[resource]) < cost) {
        await client.query("ROLLBACK");
        return reply.code(400).send({
          error: `Yetersiz ${costMap[resource] || resource}. Gerekli: ${cost}`
        });
      }
    }

    await client.query(`
      UPDATE users
      SET scoin=scoin-$1,
          wood=wood-$2,
          stone=stone-$3,
          iron=iron-$4
      WHERE id=$5
    `, [
      b.cost.scoin || 0,
      b.cost.wood || 0,
      b.cost.stone || 0,
      b.cost.iron || 0,
      req.user.id
    ]);

    await client.query(
      `INSERT INTO buildings(user_id,type,level)
       VALUES($1,$2,1)`,
      [req.user.id, type]
    );

    await client.query(`
      INSERT INTO transactions(user_id,type,amount,description)
      VALUES($1,'BUILD',$2,$3)
    `, [
      req.user.id,
      -(b.cost.scoin || 0),
      `${b.name} kuruldu`
    ]);

    await client.query("COMMIT");
    return publicState(req.user.id);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

app.post("/land/expand", { preHandler: auth }, async (req, reply) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await accrueProduction(req.user.id, client);

    const u = await getUser(req.user.id, client);
    if (!u) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "Kullanıcı bulunamadı." });
    }

    const cost = { scoin: 250, wood: 300, stone: 300 };

    for (const [key, value] of Object.entries(cost)) {
      if (money(u[key]) < value) {
        await client.query("ROLLBACK");
        return reply.code(400).send({
          error: `Arazi genişletme için ${
            key === "scoin" ? "SCoin" : RESOURCE_LABEL[key.toUpperCase()]
          } ${value} gerekli.`
        });
      }
    }

    await client.query(`
      UPDATE users
      SET scoin=scoin-$1,
          wood=wood-$2,
          stone=stone-$3,
          land=land+1
      WHERE id=$4
    `, [cost.scoin, cost.wood, cost.stone, req.user.id]);

    await client.query(`
      INSERT INTO transactions(user_id,type,amount,description)
      VALUES($1,'LAND',-$2,'1 arazi genişletildi')
    `, [req.user.id, cost.scoin]);

    await client.query("COMMIT");
    return publicState(req.user.id);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

app.post("/mine/upgrade", { preHandler: auth }, async (req, reply) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await accrueProduction(req.user.id, client);

    const u = await getUser(req.user.id, client);
    if (!u) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "Kullanıcı bulunamadı." });
    }

    const mines = await client.query(
      `SELECT id,level FROM buildings
       WHERE user_id=$1 AND type='MINE'
       ORDER BY id`,
      [req.user.id]
    );

    if (!mines.rows.length) {
      await client.query("ROLLBACK");
      return reply.code(400).send({
        error: "Önce bir maden kurmalısın."
      });
    }

    const levels = mines.rows.map(r => Number(r.level));
    const current = Math.min(...levels);

    if (current >= 4) {
      await client.query("ROLLBACK");
      return reply.code(400).send({
        error: "Madenler zaten maksimum seviye olan 4'e ulaştı."
      });
    }

    const costPerMine = UPGRADE_COST[current];
    const totalCost = costPerMine * mines.rows.length;

    if (money(u.scoin) < totalCost) {
      await client.query("ROLLBACK");
      return reply.code(400).send({
        error: `Tüm madenleri Lv${current + 1}'e yükseltmek için ${totalCost.toLocaleString("tr-TR")} SCoin gerekli.`
      });
    }

    await client.query(
      `UPDATE buildings
       SET level=level+1
       WHERE user_id=$1 AND type='MINE' AND level=$2`,
      [req.user.id, current]
    );

    await client.query(
      `UPDATE users SET scoin=scoin-$1 WHERE id=$2`,
      [totalCost, req.user.id]
    );

    await client.query(`
      INSERT INTO transactions(user_id,type,amount,description)
      VALUES($1,'UPGRADE',$2,$3)
    `, [
      req.user.id,
      -totalCost,
      `Madenler Lv${current} → Lv${current + 1}`
    ]);

    await client.query("COMMIT");
    return publicState(req.user.id);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

// 10 Demir + 10 Enerji -> 1 Çelik
app.post("/produce/steel", { preHandler: auth }, async (req, reply) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await accrueProduction(req.user.id, client);

    const u = await getUser(req.user.id, client);
    const mills = Number((
      await client.query(
        `SELECT COUNT(*)::int AS c FROM buildings
         WHERE user_id=$1 AND type='STEEL_MILL'`,
        [req.user.id]
      )
    ).rows[0].c);

    if (!mills) {
      await client.query("ROLLBACK");
      return reply.code(400).send({
        error: "Önce Çelik Tesisi kurmalısın."
      });
    }

    const batches = Math.min(
      mills,
      Math.floor(Math.min(money(u.iron) / 10, money(u.energy) / 10))
    );

    if (batches < 1) {
      await client.query("ROLLBACK");
      return reply.code(400).send({
        error: "Çelik için en az 10 demir ve 10 enerji gerekli."
      });
    }

    await client.query(`
      UPDATE users
      SET iron=iron-$1,
          energy=energy-$2,
          steel=steel+$3
      WHERE id=$4
    `, [batches * 10, batches * 10, batches, req.user.id]);

    await client.query(`
      INSERT INTO transactions(user_id,type,amount,description)
      VALUES($1,'STEEL',0,$2)
    `, [
      req.user.id,
      `${batches} Çelik üretildi`
    ]);

    await client.query("COMMIT");
    return publicState(req.user.id);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

// 5 Çelik + 20 Demir + 10 Kereste + 20 Enerji -> 1 Makine
app.post("/produce/machine", { preHandler: auth }, async (req, reply) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await accrueProduction(req.user.id, client);

    const u = await getUser(req.user.id, client);
    const factories = Number((
      await client.query(
        `SELECT COUNT(*)::int AS c FROM buildings
         WHERE user_id=$1 AND type='MACHINE_FACTORY'`,
        [req.user.id]
      )
    ).rows[0].c);

    if (!factories) {
      await client.query("ROLLBACK");
      return reply.code(400).send({
        error: "Önce Makine Fabrikası kurmalısın."
      });
    }

    const batches = Math.min(
      factories,
      Math.floor(
        Math.min(
          money(u.steel) / 5,
          money(u.iron) / 20,
          money(u.wood) / 10,
          money(u.energy) / 20
        )
      )
    );

    if (batches < 1) {
      await client.query("ROLLBACK");
      return reply.code(400).send({
        error: "Makine için Çelik, Demir, Kereste ve Enerji yetersiz."
      });
    }

    await client.query(`
      UPDATE users
      SET steel=steel-$1,
          iron=iron-$2,
          wood=wood-$3,
          energy=energy-$4,
          machines=machines+$5
      WHERE id=$6
    `, [
      batches * 5,
      batches * 20,
      batches * 10,
      batches * 20,
      batches,
      req.user.id
    ]);

    await client.query(`
      INSERT INTO transactions(user_id,type,amount,description)
      VALUES($1,'MACHINE',0,$2)
    `, [
      req.user.id,
      `${batches} Makine üretildi`
    ]);

    await client.query("COMMIT");
    return publicState(req.user.id);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

app.get("/market", async () => {
  const r = await q(`
    SELECT l.id,l.resource,l.qty,l.price,l.created_at,u.username
    FROM listings l
    JOIN users u ON u.id=l.seller_id
    WHERE l.status='OPEN'
    ORDER BY l.id DESC
  `);

  return r.rows.map(x => ({
    id: Number(x.id),
    resource: x.resource,
    qty: money(x.qty),
    price: money(x.price),
    unitPrice: Number(x.price) / Number(x.qty),
    username: x.username
  }));
});

app.post("/market/list", { preHandler: auth }, async (req, reply) => {
  const resource = String(req.body?.resource || "IRON").toUpperCase();
  const qty = Number(req.body?.qty);
  const price = Number(req.body?.price);

  const resourceColumn = {
    IRON: "iron",
    STEEL: "steel",
    WOOD: "wood",
    STONE: "stone",
    ENERGY: "energy",
    MACHINE: "machines"
  }[resource];

  if (!resourceColumn) {
    return reply.code(400).send({ error: "Geçersiz kaynak." });
  }
  if (!Number.isInteger(qty) || qty <= 0) {
    return reply.code(400).send({
      error: "Miktar pozitif bir tam sayı olmalı."
    });
  }
  if (!Number.isInteger(price) || price <= 0) {
    return reply.code(400).send({
      error: "Fiyat pozitif bir tam sayı olmalı."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await accrueProduction(req.user.id, client);

    const u = await getUser(req.user.id, client);

    if (!u) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "Kullanıcı bulunamadı." });
    }

    if (money(u[resourceColumn]) < qty) {
      await client.query("ROLLBACK");
      return reply.code(400).send({
        error: `Yetersiz ${RESOURCE_LABEL[resource]}.`
      });
    }

    await client.query(
      `UPDATE users
       SET ${resourceColumn}=${resourceColumn}-$1
       WHERE id=$2`,
      [qty, req.user.id]
    );

    await client.query(
      `INSERT INTO listings(seller_id,resource,qty,price)
       VALUES($1,$2,$3,$4)`,
      [req.user.id, resource, qty, price]
    );

    await client.query(
      `INSERT INTO transactions(user_id,type,amount,description)
       VALUES($1,'LIST',0,$2)`,
      [req.user.id, `${qty} ${RESOURCE_LABEL[resource]} satış ilanı açıldı`]
    );

    await client.query("COMMIT");
    return publicState(req.user.id);
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
      `SELECT * FROM listings
       WHERE id=$1 AND status='OPEN'
       FOR UPDATE`,
      [Number(req.params.id)]
    );
    const listing = lr.rows[0];

    if (!listing || Number(listing.seller_id) === Number(req.user.id)) {
      await client.query("ROLLBACK");
      return reply.code(400).send({
        error: "İlan bulunamadı."
      });
    }

    const column = {
      IRON: "iron",
      STEEL: "steel",
      WOOD: "wood",
      STONE: "stone",
      ENERGY: "energy",
      MACHINE: "machines"
    }[listing.resource];

    const buyer = await getUser(req.user.id, client);
    const seller = await getUser(Number(listing.seller_id), client);

    if (!buyer || !seller) {
      await client.query("ROLLBACK");
      return reply.code(404).send({
        error: "Kullanıcı bulunamadı."
      });
    }

    if (money(buyer.scoin) < money(listing.price)) {
      await client.query("ROLLBACK");
      return reply.code(400).send({
        error: "Yetersiz SCoin."
      });
    }

    const fee = Math.floor(money(listing.price) * 0.03);
    const sellerNet = money(listing.price) - fee;

    await client.query(
      `UPDATE users
       SET scoin=scoin-$1,
           ${column}=${column}+$2
       WHERE id=$3`,
      [money(listing.price), money(listing.qty), buyer.id]
    );

    await client.query(
      `UPDATE users SET scoin=scoin+$1 WHERE id=$2`,
      [sellerNet, seller.id]
    );

    await client.query(
      `UPDATE listings
       SET status='SOLD', sold_at=NOW()
       WHERE id=$1`,
      [listing.id]
    );

    await client.query(
      `INSERT INTO transactions(user_id,type,amount,description)
       VALUES($1,'BUY',$2,$3)`,
      [
        buyer.id,
        -money(listing.price),
        `${listing.qty} ${RESOURCE_LABEL[listing.resource]} satın alındı`
      ]
    );

    await client.query(
      `INSERT INTO transactions(user_id,type,amount,description)
       VALUES($1,'SALE',$2,$3)`,
      [
        seller.id,
        sellerNet,
        `${listing.qty} ${RESOURCE_LABEL[listing.resource]} satıldı; %3 komisyon: ${fee} SCoin`
      ]
    );

    await client.query("COMMIT");
    return publicState(buyer.id);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

app.get("/transactions", { preHandler: auth }, async req => {
  await accrueProduction(req.user.id);

  const r = await q(`
    SELECT id,type,amount,description,created_at
    FROM transactions
    WHERE user_id=$1
    ORDER BY id DESC
    LIMIT 50
  `, [req.user.id]);

  return r.rows;
});

const html = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>Sanal Ekonomi</title>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#eef2f5;color:#17212b;margin:0}
header{background:#101820;color:#fff;padding:17px 20px;position:sticky;top:0;z-index:5}
.wrap{max-width:1150px;margin:auto;padding:16px}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.card{background:#fff;padding:15px;border-radius:15px;margin-bottom:10px;box-shadow:0 2px 9px #0001}
.stat{font-size:24px;font-weight:750}
.small{color:#6a7480;font-size:12px}
.section{margin-top:16px}
button{background:#1769e0;color:white;border:0;border-radius:9px;padding:10px 12px;margin:3px;font-weight:600;cursor:pointer}
input,select{width:100%;padding:10px;border:1px solid #ccd3da;border-radius:9px;margin:3px 0;font-size:16px}
.tablewrap{overflow:auto}
table{width:100%;border-collapse:collapse}
td,th{padding:8px;border-bottom:1px solid #e5e8eb;text-align:left;white-space:nowrap}
.badge{background:#e8f0ff;color:#1559b6;border-radius:99px;padding:4px 8px;font-size:12px}
.resourcegrid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.buildinggrid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.build{border:1px solid #e5e8eb;border-radius:12px;padding:11px}
.build h3{margin:0 0 5px}
@media(min-width:780px){
  .grid{grid-template-columns:repeat(4,minmax(0,1fr))}
  .buildinggrid{grid-template-columns:repeat(4,1fr)}
  .resourcegrid{grid-template-columns:repeat(6,1fr)}
}
</style>
</head>
<body>
<header>🌍 <b>SANAL EKONOMİ</b> <span class=badge>SCoin + Kaynak Ekonomisi</span></header>
<div class=wrap>
<div id=auth class=card>
<h2>Giriş / Kayıt</h2>
<input id=un placeholder="Kullanıcı adı" autocomplete="username">
<input id=pw type=password placeholder="Şifre" autocomplete="current-password">
<button onclick=reg()>Kayıt Ol</button>
<button onclick=login()>Giriş</button>
<p id=msg></p>
</div>

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

<div class=section>
<h2>🏗️ İnşaat</h2>
<div class=buildinggrid id=buildings></div>
<div class=card>
<h3>🏞️ Arazi Genişlet</h3>
<p>+1 arazi = <b>250 SCoin + 300 kereste + 300 taş</b></p>
<button onclick=action('/land/expand')>Arazi Genişlet</button>
</div>
</div>

<div class=section>
<h2>🏭 Üretim</h2>
<div class=grid>
<div class=card>
<h3>⛏️ Demir Madenleri</h3>
<p>Madenler otomatik çalışır.</p>
<button onclick=action('/mine/upgrade')>Madenleri Geliştir</button>
<p class=small id=upgradeInfo>Lv1→2: 5.000 SCoin | Lv2→3: 12.000 | Lv3→4: 30.000</p>
</div>
<div class=card>
<h3>🏭 Çelik</h3>
<p>10 Demir + 10 Enerji → 1 Çelik</p>
<button onclick=action('/produce/steel')>Çelik Üret</button>
</div>
<div class=card>
<h3>⚙️ Makine</h3>
<p>5 Çelik + 20 Demir + 10 Kereste + 20 Enerji → 1 Makine</p>
<button onclick=action('/produce/machine')>Makine Üret</button>
</div>
<div class=card>
<h3>🚀 Başlangıç</h3>
<p>Yeni oyuncu hazır üretim altyapısıyla başlar. Oyuncu ilk dakikadan ekonomiye girebilir.</p>
</div>
</div>
</div>

<div class=section>
<h2>🛒 Marketplace</h2>
<div class=card>
<div class=grid>
<select id=res>
<option value=IRON>Demir</option>
<option value=WOOD>Kereste</option>
<option value=STONE>Taş</option>
<option value=ENERGY>Enerji</option>
<option value=STEEL>Çelik</option>
<option value=MACHINE>Makine</option>
</select>
<input id=q type=number min=1 placeholder=Miktar>
<input id=pr type=number min=1 placeholder="Toplam SCoin">
<button onclick=sell>İlan Aç</button>
</div>
<hr>
<div class=tablewrap>
<table>
<thead><tr><th>Satıcı</th><th>Kaynak</th><th>Miktar</th><th>Toplam</th><th>Birim</th><th></th></tr></thead>
<tbody id=mk></tbody>
</table>
</div>
</div>
</div>

<div class=section>
<h2>📜 Son İşlemler</h2>
<div class=card>
<div class=tablewrap><table><tbody id=tx></tbody></table></div>
</div>
</div>
</div>
</div>

<script>
let token="";
const fmt=n=>Number(n||0).toLocaleString('tr-TR',{maximumFractionDigits:2});
const labels={IRON:'Demir',WOOD:'Kereste',STONE:'Taş',ENERGY:'Enerji',STEEL:'Çelik',MACHINE:'Makine'};

async function api(path,opt={}){
  opt.headers={...(opt.headers||{}),...(token?{Authorization:'Bearer '+token}:{})};
  if(opt.body!==undefined) opt.headers['Content-Type']='application/json';
  const r=await fetch(path,opt);
  let d={}; try{d=await r.json()}catch{}
  if(!r.ok) throw Error(d.error||('HTTP '+r.status));
  return d;
}

async function reg(){
  try{
    const d=await api('/register',{method:'POST',body:JSON.stringify({username:un.value,password:pw.value})});
    token=d.token; openGame();
  }catch(e){msg.textContent=e.message}
}

async function login(){
  try{
    const d=await api('/login',{method:'POST',body:JSON.stringify({username:un.value,password:pw.value})});
    token=d.token; openGame();
  }catch(e){msg.textContent=e.message}
}

function openGame(){
  auth.style.display='none';
  game.style.display='block';
  refresh();
}

async function refresh(){
  const u=await api('/me');
  x.textContent=fmt(u.scoin);
  i.textContent=fmt(u.iron);
  w.textContent=fmt(u.wood);
  st.textContent=fmt(u.stone);
  e.textContent=fmt(u.energy);
  sm.textContent=fmt(u.steel)+' / '+fmt(u.machines);
  land.textContent=u.land;
  freeLand.textContent='Boş arazi: '+u.freeLand;
  ri.textContent=fmt(u.production.iron);
  rw.textContent=fmt(u.production.wood);
  re.textContent=fmt(u.production.energy);

  upgradeInfo.textContent =
    u.mineLevel===0 ? 'Henüz maden yok.' :
    u.mineLevel===4 ? 'Maden seviyesi maksimum: Lv4.' :
    'Maden seviyesi: Lv'+u.mineLevel+
    ' | Sonraki seviye: '+
    ({1:'5.000 SCoin',2:'12.000 SCoin',3:'30.000 SCoin'}[u.mineLevel]||'');

  const bs=await api('/buildings');
  const counts=u.buildings||{};
  buildings.innerHTML=bs.map(b=>{
    const c=counts[b.type]?.count||0;
    const cost=Object.entries(b.cost).filter(([,v])=>v)
      .map(([k,v])=>k==='scoin'?v+' SCoin':v+' '+(labels[k.toUpperCase()]||k)).join(' + ');
    return '<div class=build><h3>'+b.emoji+' '+b.name+
      '</h3><p class=small>Kurulu: '+c+' | Arazi: '+b.land+
      '</p><p>'+cost+'</p><button onclick="build(\''+b.type+'\')">Kur</button></div>';
  }).join('');

  const rows=await api('/market');
  mk.innerHTML=rows.map(v=>
    '<tr><td>'+v.username+'</td><td>'+labels[v.resource]+'</td><td>'+
    fmt(v.qty)+'</td><td>'+fmt(v.price)+' SCoin</td><td>'+
    fmt(v.unitPrice)+'</td><td><button onclick="buy('+v.id+')">Al</button></td></tr>'
  ).join('');

  const t=await api('/transactions');
  tx.innerHTML=t.map(v=>
    '<tr><td>'+v.description+'</td><td>'+fmt(v.amount)+' SCoin</td></tr>'
  ).join('');
}

async function action(p){
  try{await api(p,{method:'POST',body:JSON.stringify({})});refresh()}
  catch(e){alert(e.message)}
}

async function build(type){
  try{await api('/build',{method:'POST',body:JSON.stringify({type})});refresh()}
  catch(e){alert(e.message)}
}

async function sell(){
  try{
    await api('/market/list',{method:'POST',
      body:JSON.stringify({resource:res.value,qty:+q.value,price:+pr.value})});
    q.value='';pr.value='';refresh();
  }catch(e){alert(e.message)}
}

async function buy(id){
  try{await api('/market/buy/'+id,{method:'POST',body:JSON.stringify({})});refresh()}
  catch(e){alert(e.message)}
}

setInterval(()=>{if(token)refresh().catch(()=>{})},30000);
</script>
</body></html>`;

app.get("/", async (_, reply) =>
  reply.type("text/html; charset=utf-8").send(html)
);

const port = Number(process.env.PORT || 3000);

async function start() {
  await initDb();
  await app.listen({ port, host: "0.0.0.0" });
}

start().catch(err => {
  app.log.error(err);
  process.exit(1);
});
