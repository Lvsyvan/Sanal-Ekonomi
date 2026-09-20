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

const BUILDINGS = {
  WAREHOUSE: { name:"Depo", emoji:"📦", land:1, cost:{scoin:0,wood:100,stone:100,iron:0} },
  MINE: { name:"Demir Madeni", emoji:"⛏️", land:1, cost:{scoin:0,wood:80,stone:80,iron:0} },
  SAWMILL: { name:"Kereste Atölyesi", emoji:"🪚", land:1, cost:{scoin:0,wood:120,stone:80,iron:40} },
  QUARRY: { name:"Taş Ocağı", emoji:"🪨", land:1, cost:{scoin:0,wood:80,stone:120,iron:40} },
  POWER: { name:"Enerji Santrali", emoji:"⚡", land:1, cost:{scoin:50,wood:120,stone:180,iron:100} },
  STEEL_MILL: { name:"Çelik Tesisi", emoji:"🏭", land:1, cost:{scoin:100,wood:180,stone:250,iron:300} },
  MACHINE_FACTORY: { name:"Makine Fabrikası", emoji:"⚙️", land:2, cost:{scoin:200,wood:300,stone:250,iron:400} }
};

const STARTER = {scoin:5000,iron:300,steel:0,wood:400,stone:400,energy:200,machines:0,land:4,mine_level:1,mines:0};
const MINE_RATE = {1:100,2:250,3:600,4:1500};
const UPGRADE_COST = {1:5000,2:12000,3:30000};

function num(v){ return Number(v || 0); }
function label(k){
  return ({scoin:"SCoin",iron:"Demir",wood:"Kereste",stone:"Taş",energy:"Enerji",steel:"Çelik",machines:"Makine"}[k] || k);
}
async function q(sql, params=[], client=pool){ return client.query(sql, params); }

async function columnExists(name){
  const r=await q(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name=$1 LIMIT 1`,[name]);
  return r.rows.length>0;
}

async function initDb(){
  await q(`
    CREATE TABLE IF NOT EXISTS users(
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT,
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
    )
  `);

  const cols = [
    ["password_hash","TEXT"],
    ["scoin","NUMERIC(20,2) DEFAULT 5000"],
    ["iron","NUMERIC(20,2) DEFAULT 300"],
    ["steel","NUMERIC(20,2) DEFAULT 0"],
    ["wood","NUMERIC(20,2) DEFAULT 400"],
    ["stone","NUMERIC(20,2) DEFAULT 400"],
    ["energy","NUMERIC(20,2) DEFAULT 200"],
    ["machines","NUMERIC(20,2) DEFAULT 0"],
    ["land","INTEGER DEFAULT 4"],
    ["mine_level","INTEGER DEFAULT 1"],
    ["mines","INTEGER DEFAULT 0"],
    ["production_updated_at","TIMESTAMPTZ DEFAULT NOW()"]
  ];
  for(const [name,type] of cols) await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${name} ${type}`);

  if(await columnExists("password")){
    await q(`ALTER TABLE users ALTER COLUMN password DROP NOT NULL`);
    await q(`UPDATE users SET password_hash=password WHERE COALESCE(password_hash,'')='' AND password IS NOT NULL`);
  }
  await q(`ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL`);

  await q(`
    CREATE TABLE IF NOT EXISTS buildings(
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      level INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await q(`
    CREATE TABLE IF NOT EXISTS listings(
      id BIGSERIAL PRIMARY KEY,
      seller_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      resource TEXT NOT NULL DEFAULT 'IRON',
      qty NUMERIC(20,2) NOT NULL,
      price NUMERIC(20,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sold_at TIMESTAMPTZ
    )
  `);
  await q(`
    CREATE TABLE IF NOT EXISTS transactions(
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      amount NUMERIC(20,2) NOT NULL DEFAULT 0,
      description TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await q(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS resource TEXT NOT NULL DEFAULT 'IRON'`);
  await q(`CREATE INDEX IF NOT EXISTS idx_buildings_user ON buildings(user_id,type)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_listings_open ON listings(status,created_at DESC)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id,created_at DESC)`);

  // Migrate old mine counters into building rows once.
  const old = await q(`
    SELECT id,COALESCE(mines,0) mines,COALESCE(mine_level,1) mine_level
    FROM users u
    WHERE COALESCE(mines,0)>0
      AND NOT EXISTS(SELECT 1 FROM buildings b WHERE b.user_id=u.id)
  `);
  for(const row of old.rows){
    const count=Math.max(0,Math.floor(num(row.mines)));
    const lvl=Math.max(1,Math.min(4,Math.floor(num(row.mine_level))));
    for(let i=0;i<count;i++) await q(`INSERT INTO buildings(user_id,type,level) VALUES($1,'MINE',$2)`,[row.id,lvl]);
  }

  // Repair accounts created by the broken transition versions.
  // A player with no buildings and an empty economy is a fresh/broken account;
  // restore the complete starter package without deleting any real game data.
  const broken=await q(`
    SELECT u.id
    FROM users u
    WHERE NOT EXISTS(SELECT 1 FROM buildings b WHERE b.user_id=u.id)
      AND COALESCE(u.scoin,0)=0
      AND COALESCE(u.iron,0)=0
      AND COALESCE(u.wood,0)=0
      AND COALESCE(u.stone,0)=0
      AND COALESCE(u.energy,0)=0
      AND COALESCE(u.steel,0)=0
      AND COALESCE(u.machines,0)=0
  `);
  for(const row of broken.rows){
    await q(`
      UPDATE users SET scoin=$1,iron=$2,steel=$3,wood=$4,stone=$5,energy=$6,machines=$7,land=$8,mine_level=$9,mines=0,production_updated_at=NOW()
      WHERE id=$10
    `,[STARTER.scoin,STARTER.iron,STARTER.steel,STARTER.wood,STARTER.stone,STARTER.energy,STARTER.machines,STARTER.land,STARTER.mine_level,row.id]);
    for(const type of ['WAREHOUSE','MINE','SAWMILL','QUARRY']){
      await q(`INSERT INTO buildings(user_id,type,level) VALUES($1,$2,1)`,[row.id,type]);
    }
    await q(`INSERT INTO transactions(user_id,type,amount,description) VALUES($1,'REPAIR',0,'Başlangıç paketi otomatik olarak geri yüklendi')`,[row.id]);
  }
}

async function createUserCompat(client, username, hash){
  const result = await q(`
    SELECT column_name,is_nullable,column_default,data_type
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='users'
    ORDER BY ordinal_position
  `,[],client);

  const mapping = {
    username,
    password_hash:hash,
    password:hash,
    scoin:STARTER.scoin,
    iron:STARTER.iron,
    steel:STARTER.steel,
    wood:STARTER.wood,
    stone:STARTER.stone,
    energy:STARTER.energy,
    machines:STARTER.machines,
    land:STARTER.land,
    mine_level:STARTER.mine_level,
    mines:STARTER.mines,
    production_updated_at:new Date()
  };
  // Common fields from older versions, when present.
  Object.assign(mapping,{
    xcoin:STARTER.scoin, balance:STARTER.scoin, coins:STARTER.scoin,
    currency:STARTER.scoin, created:new Date()
  });

  const names=[], values=[], params=[];
  for(const c of result.rows){
    if(c.column_name==="id" || c.column_name==="created_at") continue;
    if(Object.prototype.hasOwnProperty.call(mapping,c.column_name)){
      names.push(c.column_name);
      values.push(`$${params.length+1}`);
      params.push(mapping[c.column_name]);
      continue;
    }
    if(c.is_nullable==="NO" && !c.column_default){
      names.push(c.column_name);
      values.push(`$${params.length+1}`);
      if(["integer","bigint","smallint","numeric","decimal","real","double precision"].includes(c.data_type)) params.push(0);
      else if(c.data_type==="boolean") params.push(false);
      else if(c.data_type.includes("timestamp") || c.data_type==="date") params.push(new Date());
      else params.push("");
    }
  }
  const sql=`INSERT INTO users(${names.join(",")}) VALUES(${values.join(",")}) RETURNING id,username,scoin,iron,steel,wood,stone,energy,machines,land,mine_level`;
  return q(sql,params,client);
}

async function getUser(id,client=pool){
  const r=await q(`SELECT id,username,scoin,iron,steel,wood,stone,energy,machines,land,mine_level,mines,production_updated_at FROM users WHERE id=$1`,[id],client);
  return r.rows[0]||null;
}

async function accrue(id,client=pool){
  await q(`
    UPDATE users u SET
      iron=u.iron+COALESCE((SELECT SUM(CASE level WHEN 1 THEN 100 WHEN 2 THEN 250 WHEN 3 THEN 600 WHEN 4 THEN 1500 ELSE 100 END) FROM buildings WHERE user_id=u.id AND type='MINE'),0)*LEAST(24,GREATEST(0,EXTRACT(EPOCH FROM(NOW()-u.production_updated_at))/3600)),
      wood=u.wood+COALESCE((SELECT COUNT(*)*80 FROM buildings WHERE user_id=u.id AND type='SAWMILL'),0)*LEAST(24,GREATEST(0,EXTRACT(EPOCH FROM(NOW()-u.production_updated_at))/3600)),
      stone=u.stone+COALESCE((SELECT COUNT(*)*80 FROM buildings WHERE user_id=u.id AND type='QUARRY'),0)*LEAST(24,GREATEST(0,EXTRACT(EPOCH FROM(NOW()-u.production_updated_at))/3600)),
      energy=u.energy+COALESCE((SELECT COUNT(*)*120 FROM buildings WHERE user_id=u.id AND type='POWER'),0)*LEAST(24,GREATEST(0,EXTRACT(EPOCH FROM(NOW()-u.production_updated_at))/3600)),
      production_updated_at=NOW()
    WHERE u.id=$1
  `,[id],client);
}

async function gameState(id,client=pool){
  await accrue(id,client);
  const u=await getUser(id,client);
  if(!u) return null;
  const bs=(await q(`SELECT type,COUNT(*)::int count FROM buildings WHERE user_id=$1 GROUP BY type`,[id],client)).rows;
  const mines=(await q(`SELECT level FROM buildings WHERE user_id=$1 AND type='MINE' ORDER BY id`,[id],client)).rows;
  const buildings={}; let usedLand=0,ironRate=0,woodRate=0,stoneRate=0,energyRate=0;
  for(const row of bs){
    buildings[row.type]={count:Number(row.count)};
    const d=BUILDINGS[row.type];
    if(d) usedLand+=d.land*Number(row.count);
    if(row.type==="SAWMILL") woodRate=Number(row.count)*80;
    if(row.type==="QUARRY") stoneRate=Number(row.count)*80;
    if(row.type==="POWER") energyRate=Number(row.count)*120;
  }
  ironRate=mines.reduce((a,r)=>a+(MINE_RATE[Number(r.level)]||100),0);
  return {
    id:Number(u.id),username:u.username,scoin:num(u.scoin),iron:num(u.iron),steel:num(u.steel),
    wood:num(u.wood),stone:num(u.stone),energy:num(u.energy),machines:num(u.machines),
    land:Number(u.land),freeLand:Math.max(0,Number(u.land)-usedLand),
    buildings,mineLevels:mines.map(r=>Number(r.level)),
    production:{iron:ironRate,wood:woodRate,stone:stoneRate,energy:energyRate}
  };
}

function auth(req,reply){
  const h=req.headers.authorization||"";
  if(!h.startsWith("Bearer ")) return reply.code(401).send({error:"Oturum gerekli."});
  try{ req.user=app.jwt.verify(h.slice(7)); }
  catch{ return reply.code(401).send({error:"Oturum geçersiz veya süresi dolmuş."}); }
}

app.register(cors,{origin:true});
app.register(jwt,{secret:process.env.JWT_SECRET||"CHANGE_ME"});

app.get("/health",async()=>({ok:true,service:"sanal-ekonomi",version:"16.0.0",currency:"SCoin"}));

app.post("/register",async(req,reply)=>{
  try{
    const username=String(req.body?.username||"").trim();
    const password=String(req.body?.password||"");
    if(username.length<3||username.length>30) return reply.code(400).send({error:"Kullanıcı adı 3-30 karakter olmalı."});
    if(password.length<6) return reply.code(400).send({error:"Şifre en az 6 karakter olmalı."});

    const exists=await q(`SELECT id FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1`,[username]);
    if(exists.rows.length) return reply.code(409).send({error:"Kullanıcı adı zaten kullanılıyor."});

    const hash=await bcrypt.hash(password,12);
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      const created=await createUserCompat(client,username,hash);
      const id=Number(created.rows[0].id);

      // Starter buildings are the only game records created here.
      for(const type of ["WAREHOUSE","MINE","SAWMILL","QUARRY"])
        await client.query(`INSERT INTO buildings(user_id,type,level) VALUES($1,$2,1)`,[id,type]);

      await client.query(`INSERT INTO transactions(user_id,type,amount,description) VALUES($1,'STARTER',0,'Başlangıç paketi oluşturuldu')`,[id]);

      await client.query("COMMIT");

      // IMPORTANT: authentication response does NOT call gameState().
      return reply.code(201).send({
        token:app.jwt.sign({id}),
        user:{
          id,username,
          scoin:STARTER.scoin,iron:STARTER.iron,steel:STARTER.steel,
          wood:STARTER.wood,stone:STARTER.stone,energy:STARTER.energy,
          machines:STARTER.machines,land:STARTER.land
        }
      });
    }catch(e){
      await client.query("ROLLBACK");
      if(e.code==="23505") return reply.code(409).send({error:"Kullanıcı adı zaten kullanılıyor."});
      throw e;
    }finally{client.release();}
  }catch(e){
    app.log.error(e,"REGISTER_ERROR");
    return reply.code(500).send({error:"Kayıt sırasında sunucu hatası: "+(e.message||"Bilinmeyen DB hatası.")});
  }
});

app.post("/login",async(req,reply)=>{
  try{
    const username=String(req.body?.username||"").trim();
    const password=String(req.body?.password||"");
    const hasPassword=await columnExists("password");

    const sql=hasPassword
      ? `SELECT id,username,password_hash,password FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1`
      : `SELECT id,username,password_hash FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1`;

    const r=await q(sql,[username]);
    const u=r.rows[0];
    const hash=u && (u.password_hash || (hasPassword ? u.password : null));

    if(!u || !hash || !(await bcrypt.compare(password,hash)))
      return reply.code(401).send({error:"Kullanıcı adı veya şifre hatalı."});

    // Authentication is independent from production/buildings/marketplace.
    return {
      token:app.jwt.sign({id:Number(u.id)}),
      user:{id:Number(u.id),username:u.username}
    };
  }catch(e){
    app.log.error(e,"LOGIN_ERROR");
    return reply.code(500).send({error:"Giriş sırasında sunucu hatası: "+(e.message||"Bilinmeyen DB hatası.")});
  }
});

app.get("/me",{preHandler:auth},async(req,reply)=>{
  try{
    const s=await gameState(req.user.id);
    if(!s) return reply.code(404).send({error:"Kullanıcı bulunamadı."});
    return s;
  }catch(e){
    app.log.error(e,"ME_ERROR");
    return reply.code(500).send({error:"Oyun verileri yüklenemedi: "+(e.message||"Bilinmeyen DB hatası.")});
  }
});

app.get("/buildings",async()=>Object.entries(BUILDINGS).map(([type,d])=>({type,...d})));

app.post("/build",{preHandler:auth},async(req,reply)=>{
  const type=String(req.body?.type||"").toUpperCase(), d=BUILDINGS[type];
  if(!d) return reply.code(400).send({error:"Geçersiz yapı."});
  const c=await pool.connect();
  try{
    await c.query("BEGIN");
    await accrue(req.user.id,c);
    const s=await gameState(req.user.id,c);
    const u=await getUser(req.user.id,c);
    if(!u){await c.query("ROLLBACK");return reply.code(404).send({error:"Kullanıcı bulunamadı."});}
    if(s.freeLand<d.land){await c.query("ROLLBACK");return reply.code(400).send({error:"Boş arazi yetersiz."});}
    for(const [k,v] of Object.entries(d.cost)){
      if(num(u[k])<v){await c.query("ROLLBACK");return reply.code(400).send({error:`Yetersiz ${label(k)}. Gerekli: ${v}`});}
    }
    await c.query(`UPDATE users SET scoin=scoin-$1,wood=wood-$2,stone=stone-$3,iron=iron-$4 WHERE id=$5`,[d.cost.scoin||0,d.cost.wood||0,d.cost.stone||0,d.cost.iron||0,req.user.id]);
    await c.query(`INSERT INTO buildings(user_id,type,level) VALUES($1,$2,1)`,[req.user.id,type]);
    await c.query(`INSERT INTO transactions(user_id,type,amount,description) VALUES($1,'BUILD',$2,$3)`,[req.user.id,-(d.cost.scoin||0),`${d.name} kuruldu`]);
    await c.query("COMMIT");
    return gameState(req.user.id);
  }catch(e){
    await c.query("ROLLBACK");
    app.log.error(e,"BUILD_ERROR");
    return reply.code(500).send({error:"Yapı kurulamadı: "+(e.message||"")});
  }finally{c.release();}
});

app.post("/land/expand",{preHandler:auth},async(req,reply)=>{
  const c=await pool.connect();
  try{
    await c.query("BEGIN"); await accrue(req.user.id,c);
    const u=await getUser(req.user.id,c);
    if(!u){await c.query("ROLLBACK");return reply.code(404).send({error:"Kullanıcı bulunamadı."});}
    if(num(u.scoin)<250||num(u.wood)<300||num(u.stone)<300){
      await c.query("ROLLBACK");return reply.code(400).send({error:"250 SCoin + 300 Kereste + 300 Taş gerekli."});
    }
    await c.query(`UPDATE users SET scoin=scoin-250,wood=wood-300,stone=stone-300,land=land+1 WHERE id=$1`,[req.user.id]);
    await c.query(`INSERT INTO transactions(user_id,type,amount,description) VALUES($1,'LAND',-250,'1 arazi genişletildi')`,[req.user.id]);
    await c.query("COMMIT"); return gameState(req.user.id);
  }catch(e){await c.query("ROLLBACK");return reply.code(500).send({error:"Arazi genişletilemedi: "+(e.message||"")});}
  finally{c.release();}
});

app.post("/mine/upgrade",{preHandler:auth},async(req,reply)=>{
  const c=await pool.connect();
  try{
    await c.query("BEGIN");
    const u=await getUser(req.user.id,c);
    const rows=(await q(`SELECT id,level FROM buildings WHERE user_id=$1 AND type='MINE' ORDER BY id`,[req.user.id],c)).rows;
    if(!rows.length){await c.query("ROLLBACK");return reply.code(400).send({error:"Önce maden kurmalısın."});}
    const current=Math.min(...rows.map(x=>Number(x.level)));
    if(current>=4){await c.query("ROLLBACK");return reply.code(400).send({error:"Madenler maksimum seviyede."});}
    const total=(UPGRADE_COST[current]||0)*rows.length;
    if(num(u.scoin)<total){await c.query("ROLLBACK");return reply.code(400).send({error:`${total.toLocaleString("tr-TR")} SCoin gerekli.`});}
    await c.query(`UPDATE buildings SET level=level+1 WHERE user_id=$1 AND type='MINE' AND level=$2`,[req.user.id,current]);
    await c.query(`UPDATE users SET scoin=scoin-$1 WHERE id=$2`,[total,req.user.id]);
    await c.query(`INSERT INTO transactions(user_id,type,amount,description) VALUES($1,'UPGRADE',$2,$3)`,[req.user.id,-total,`Madenler Lv${current+1} seviyesine yükseltildi`]);
    await c.query("COMMIT"); return gameState(req.user.id);
  }catch(e){await c.query("ROLLBACK");return reply.code(500).send({error:"Maden yükseltilemedi: "+(e.message||"")});}
  finally{c.release();}
});

app.post("/produce/steel",{preHandler:auth},async(req,reply)=>{
  const c=await pool.connect();
  try{
    await c.query("BEGIN"); const u=await getUser(req.user.id,c);
    const n=Number((await q(`SELECT COUNT(*)::int n FROM buildings WHERE user_id=$1 AND type='STEEL_MILL'`,[req.user.id],c)).rows[0].n);
    if(!n){await c.query("ROLLBACK");return reply.code(400).send({error:"Önce Çelik Tesisi kurmalısın."});}
    const batches=Math.min(n,Math.floor(Math.min(num(u.iron)/10,num(u.energy)/10)));
    if(batches<1){await c.query("ROLLBACK");return reply.code(400).send({error:"Çelik için 10 Demir + 10 Enerji gerekli."});}
    await c.query(`UPDATE users SET iron=iron-$1,energy=energy-$2,steel=steel+$3 WHERE id=$4`,[batches*10,batches*10,batches,req.user.id]);
    await c.query(`INSERT INTO transactions(user_id,type,amount,description) VALUES($1,'STEEL',0,$2)`,[req.user.id,`${batches} Çelik üretildi`]);
    await c.query("COMMIT"); return gameState(req.user.id);
  }catch(e){await c.query("ROLLBACK");return reply.code(500).send({error:"Çelik üretimi başarısız: "+(e.message||"")});}
  finally{c.release();}
});

app.post("/produce/machine",{preHandler:auth},async(req,reply)=>{
  const c=await pool.connect();
  try{
    await c.query("BEGIN"); const u=await getUser(req.user.id,c);
    const n=Number((await q(`SELECT COUNT(*)::int n FROM buildings WHERE user_id=$1 AND type='MACHINE_FACTORY'`,[req.user.id],c)).rows[0].n);
    if(!n){await c.query("ROLLBACK");return reply.code(400).send({error:"Önce Makine Fabrikası kurmalısın."});}
    const batches=Math.min(n,Math.floor(Math.min(num(u.steel)/5,num(u.iron)/20,num(u.wood)/10,num(u.energy)/20)));
    if(batches<1){await c.query("ROLLBACK");return reply.code(400).send({error:"Makine için Çelik, Demir, Kereste ve Enerji yetersiz."});}
    await c.query(`UPDATE users SET steel=steel-$1,iron=iron-$2,wood=wood-$3,energy=energy-$4,machines=machines+$5 WHERE id=$6`,[batches*5,batches*20,batches*10,batches*20,batches,req.user.id]);
    await c.query(`INSERT INTO transactions(user_id,type,amount,description) VALUES($1,'MACHINE',0,$2)`,[req.user.id,`${batches} Makine üretildi`]);
    await c.query("COMMIT"); return gameState(req.user.id);
  }catch(e){await c.query("ROLLBACK");return reply.code(500).send({error:"Makine üretimi başarısız: "+(e.message||"")});}
  finally{c.release();}
});

app.get("/market",async()=>{
  const r=await q(`SELECT l.id,l.resource,l.qty,l.price,u.username FROM listings l JOIN users u ON u.id=l.seller_id WHERE l.status='OPEN' ORDER BY l.id DESC`);
  return r.rows.map(x=>({id:Number(x.id),resource:x.resource,qty:num(x.qty),price:num(x.price),username:x.username,unitPrice:num(x.price)/num(x.qty)}));
});

app.post("/market/list",{preHandler:auth},async(req,reply)=>{
  const resource=String(req.body?.resource||"IRON").toUpperCase();
  const col={IRON:"iron",STEEL:"steel",WOOD:"wood",STONE:"stone",ENERGY:"energy",MACHINE:"machines"}[resource];
  const qty=Number(req.body?.qty),price=Number(req.body?.price);
  if(!col||!Number.isInteger(qty)||qty<=0||!Number.isInteger(price)||price<=0) return reply.code(400).send({error:"Geçersiz ilan."});
  const c=await pool.connect();
  try{
    await c.query("BEGIN"); await accrue(req.user.id,c); const u=await getUser(req.user.id,c);
    if(num(u[col])<qty){await c.query("ROLLBACK");return reply.code(400).send({error:`Yetersiz ${label(col)}.`});}
    await c.query(`UPDATE users SET ${col}=${col}-$1 WHERE id=$2`,[qty,req.user.id]);
    await c.query(`INSERT INTO listings(seller_id,resource,qty,price) VALUES($1,$2,$3,$4)`,[req.user.id,resource,qty,price]);
    await c.query(`INSERT INTO transactions(user_id,type,amount,description) VALUES($1,'LIST',0,$2)`,[req.user.id,`${qty} ${label(col)} satış ilanı açıldı`]);
    await c.query("COMMIT");return gameState(req.user.id);
  }catch(e){await c.query("ROLLBACK");return reply.code(500).send({error:"İlan açılamadı: "+(e.message||"")});}
  finally{c.release();}
});

app.post("/market/buy/:id",{preHandler:auth},async(req,reply)=>{
  const c=await pool.connect();
  try{
    await c.query("BEGIN");
    const listing=(await q(`SELECT * FROM listings WHERE id=$1 AND status='OPEN' FOR UPDATE`,[Number(req.params.id)],c)).rows[0];
    if(!listing){await c.query("ROLLBACK");return reply.code(404).send({error:"İlan bulunamadı."});}
    if(Number(listing.seller_id)===Number(req.user.id)){await c.query("ROLLBACK");return reply.code(400).send({error:"Kendi ilanını alamazsın."});}
    const buyer=await getUser(req.user.id,c),seller=await getUser(Number(listing.seller_id),c);
    const col={IRON:"iron",STEEL:"steel",WOOD:"wood",STONE:"stone",ENERGY:"energy",MACHINE:"machines"}[listing.resource];
    if(!col){await c.query("ROLLBACK");return reply.code(400).send({error:"Geçersiz kaynak."});}
    if(num(buyer.scoin)<num(listing.price)){await c.query("ROLLBACK");return reply.code(400).send({error:"Yetersiz SCoin."});}
    const fee=Math.floor(num(listing.price)*0.03),net=num(listing.price)-fee;
    await c.query(`UPDATE users SET scoin=scoin-$1,${col}=${col}+$2 WHERE id=$3`,[num(listing.price),num(listing.qty),buyer.id]);
    await c.query(`UPDATE users SET scoin=scoin+$1 WHERE id=$2`,[net,seller.id]);
    await c.query(`UPDATE listings SET status='SOLD',sold_at=NOW() WHERE id=$1`,[listing.id]);
    await c.query(`INSERT INTO transactions(user_id,type,amount,description) VALUES($1,'BUY',$2,$3)`,[buyer.id,-num(listing.price),`${listing.qty} ${label(col)} satın alındı`]);
    await c.query(`INSERT INTO transactions(user_id,type,amount,description) VALUES($1,'SALE',$2,$3)`,[seller.id,net,`${listing.qty} ${label(col)} satıldı; %3 komisyon`]);
    await c.query("COMMIT");return gameState(buyer.id);
  }catch(e){await c.query("ROLLBACK");return reply.code(500).send({error:"Satın alma başarısız: "+(e.message||"")});}
  finally{c.release();}
});

app.get("/transactions",{preHandler:auth},async(req)=>(
  await q(`SELECT id,type,amount,description,created_at FROM transactions WHERE user_id=$1 ORDER BY id DESC LIMIT 50`,[req.user.id])
).rows);

const HTML = `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sanal Ekonomi</title>
<style>
*{box-sizing:border-box}body{font-family:Arial,sans-serif;background:#eef2f5;color:#17212b;margin:0}
header{background:#101820;color:#fff;padding:18px;font-size:20px}.wrap{max-width:1120px;margin:auto;padding:16px}
.card{background:#fff;border-radius:14px;padding:16px;margin-bottom:12px;box-shadow:0 2px 9px #0001}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.stat{font-size:25px;font-weight:700}
input,select{width:100%;padding:12px;border:1px solid #ccd3da;border-radius:9px;margin:4px 0;font-size:16px}
button{background:#1769e0;color:#fff;border:0;border-radius:9px;padding:11px 14px;margin:3px;font-weight:700;cursor:pointer}button:disabled{opacity:.55;cursor:wait}
.small{font-size:12px;color:#68737d}.danger{color:#b42318;font-weight:700}.ok{color:#1769e0;font-weight:700}
.buildgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.build{border:1px solid #e0e5e9;border-radius:10px;padding:11px}
table{width:100%;border-collapse:collapse}td,th{padding:8px;border-bottom:1px solid #e5e8eb;text-align:left;white-space:nowrap}
@media(min-width:760px){.grid{grid-template-columns:repeat(4,minmax(0,1fr))}.buildgrid{grid-template-columns:repeat(4,minmax(0,1fr))}}
</style></head><body><header>🌍 <b>SANAL EKONOMİ</b> <span class="small" style="color:#dce8ff">SCoin + Kaynak Ekonomisi</span></header>
<div class="wrap">
<div id="auth" class="card"><h2>Giriş / Kayıt</h2><input id="username" placeholder="Kullanıcı adı" autocomplete="username"><input id="password" type="password" placeholder="Şifre" autocomplete="current-password"><button id="register">Kayıt Ol</button><button id="login">Giriş Yap</button><div id="message"></div></div>
<div id="game" style="display:none">
<div class="grid">
<div class="card">SCoin<div id="sc" class="stat">0</div></div><div class="card">Demir<div id="iron" class="stat">0</div></div><div class="card">Kereste<div id="wood" class="stat">0</div></div><div class="card">Taş<div id="stone" class="stat">0</div></div>
<div class="card">Enerji<div id="energy" class="stat">0</div></div><div class="card">Çelik<div id="steel" class="stat">0</div></div><div class="card">Makine<div id="machines" class="stat">0</div></div><div class="card">Arazi<div id="land" class="stat">0</div><div id="freeLand" class="small"></div></div>
</div>
<div class="grid">
<div class="card">Demir / saat<div id="ironRate" class="stat">0</div></div><div class="card">Kereste / saat<div id="woodRate" class="stat">0</div></div><div class="card">Taş / saat<div id="stoneRate" class="stat">0</div></div><div class="card">Enerji / saat<div id="energyRate" class="stat">0</div></div>
</div>
<div class="card"><h2>🏗️ Yapılar</h2><div id="buildingList" class="buildgrid"></div><button id="expand">Arazi Genişlet</button><button id="upgrade">Madenleri Geliştir</button><button id="steelProduce">Çelik Üret</button><button id="machineProduce">Makine Üret</button></div>
<div class="card"><h2>🛒 Marketplace</h2><div class="grid"><select id="resource"><option value="IRON">Demir</option><option value="STEEL">Çelik</option><option value="WOOD">Kereste</option><option value="STONE">Taş</option><option value="ENERGY">Enerji</option><option value="MACHINE">Makine</option></select><input id="qty" type="number" min="1" placeholder="Miktar"><input id="price" type="number" min="1" placeholder="Toplam SCoin"><button id="sell">İlan Aç</button></div><div style="overflow:auto"><table><thead><tr><th>Satıcı</th><th>Kaynak</th><th>Miktar</th><th>Fiyat</th><th></th></tr></thead><tbody id="market"></tbody></table></div></div>
<div class="card"><h2>📜 İşlemler</h2><div style="overflow:auto"><table><tbody id="tx"></tbody></table></div><p>Oyuncu: <b id="player"></b></p><button id="logout">Çıkış</button></div>
</div></div>
<script>
"use strict";
let token = "";
const $ = id => document.getElementById(id);
const labels = {IRON:"Demir",STEEL:"Çelik",WOOD:"Kereste",STONE:"Taş",ENERGY:"Enerji",MACHINE:"Makine"};
const fmt = n => Number(n||0).toLocaleString("tr-TR",{maximumFractionDigits:2});
function message(text,error=false){ $("message").textContent=text||""; $("message").className=error?"danger":"ok"; }
async function api(path,options={}){
  const opts={...options,headers:{...(options.headers||{})}};
  if(token) opts.headers.Authorization="Bearer "+token;
  if(opts.body!==undefined) opts.headers["Content-Type"]="application/json";
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),20000);
  opts.signal=controller.signal;
  try{
    const res=await fetch(path,opts);
    let data={}; try{data=await res.json()}catch(_){}
    if(!res.ok) throw new Error(data.error||("HTTP "+res.status));
    return data;
  }catch(e){
    if(e.name==="AbortError") throw new Error("Sunucu 20 saniye içinde yanıt vermedi.");
    throw e;
  }finally{ clearTimeout(timeout); }
}
async function registerUser(){
  const b=$("register"); b.disabled=true; message("Kayıt oluşturuluyor...");
  try{
    const d=await api("/register",{method:"POST",body:JSON.stringify({username:$("username").value.trim(),password:$("password").value})});
    token=d.token; message("Kayıt başarılı. Oyun açılıyor..."); await openGame();
  }catch(e){message("Kayıt hatası: "+e.message,true)}
  finally{b.disabled=false}
}
async function loginUser(){
  const b=$("login"); b.disabled=true; message("Giriş yapılıyor...");
  try{
    const d=await api("/login",{method:"POST",body:JSON.stringify({username:$("username").value.trim(),password:$("password").value})});
    token=d.token; message("Giriş başarılı. Oyun açılıyor..."); await openGame();
  }catch(e){message("Giriş hatası: "+e.message,true)}
  finally{b.disabled=false}
}
async function openGame(){
  $("auth").style.display="none"; $("game").style.display="block";
  try{await refresh()}catch(e){logout();message("Oyun verileri yüklenemedi: "+e.message,true)}
}
function logout(){token="";$("game").style.display="none";$("auth").style.display="block";$("password").value=""}
async function refresh(){
  const s=await api("/me");
  $("sc").textContent=fmt(s.scoin);$("iron").textContent=fmt(s.iron);$("wood").textContent=fmt(s.wood);$("stone").textContent=fmt(s.stone);
  $("energy").textContent=fmt(s.energy);$("steel").textContent=fmt(s.steel);$("machines").textContent=fmt(s.machines);$("land").textContent=s.land;$("freeLand").textContent="Boş arazi: "+s.freeLand;
  $("ironRate").textContent=fmt(s.production.iron);$("woodRate").textContent=fmt(s.production.wood);$("stoneRate").textContent=fmt(s.production.stone);$("energyRate").textContent=fmt(s.production.energy);$("player").textContent=s.username;
  const buildings=await api("/buildings"),counts=s.buildings||{};
  $("buildingList").innerHTML=buildings.map(b=>{
    const c=counts[b.type]?.count||0;
    const cost=Object.entries(b.cost).filter(([,v])=>Number(v)>0).map(([k,v])=>fmt(v)+" "+(k==="scoin"?"SCoin":(labels[k.toUpperCase()]||k))).join(" + ");
    return '<div class="build"><b>'+b.emoji+" "+b.name+'</b><br><span class="small">Kurulu: '+c+" | Arazi: "+b.land+'</span><br>'+cost+'<br><button type="button" data-build="'+b.type+'">Kur</button></div>';
  }).join("");
  $("buildingList").querySelectorAll("[data-build]").forEach(btn=>btn.addEventListener("click",async()=>{
    try{await api("/build",{method:"POST",body:JSON.stringify({type:btn.dataset.build})});await refresh()}catch(e){alert(e.message)}
  }));
  const market=await api("/market");
  $("market").innerHTML=market.map(v=>'<tr><td>'+v.username+'</td><td>'+labels[v.resource]+'</td><td>'+fmt(v.qty)+'</td><td>'+fmt(v.price)+' SCoin</td><td><button type="button" data-buy="'+v.id+'">Al</button></td></tr>').join("");
  $("market").querySelectorAll("[data-buy]").forEach(btn=>btn.addEventListener("click",async()=>{
    try{await api("/market/buy/"+btn.dataset.buy,{method:"POST",body:"{}"});await refresh()}catch(e){alert(e.message)}
  }));
  const tx=await api("/transactions"); $("tx").innerHTML=tx.map(v=>'<tr><td>'+v.description+'</td><td>'+fmt(v.amount)+' SCoin</td></tr>').join("");
}
async function action(path){
  try{await api(path,{method:"POST",body:"{}"});await refresh()}catch(e){alert(e.message)}
}
async function sell(){
  try{await api("/market/list",{method:"POST",body:JSON.stringify({resource:$("resource").value,qty:Number($("qty").value),price:Number($("price").value)})});$("qty").value="";$("price").value="";await refresh()}catch(e){alert(e.message)}
}
$("register").addEventListener("click",registerUser);$("login").addEventListener("click",loginUser);$("logout").addEventListener("click",logout);
$("expand").addEventListener("click",()=>action("/land/expand"));$("upgrade").addEventListener("click",()=>action("/mine/upgrade"));$("steelProduce").addEventListener("click",()=>action("/produce/steel"));$("machineProduce").addEventListener("click",()=>action("/produce/machine"));$("sell").addEventListener("click",sell);
$("password").addEventListener("keydown",e=>{if(e.key==="Enter")loginUser()});
setInterval(()=>{if(token)refresh().catch(()=>{})},30000);
</script></body></html>`;

app.get("/",async(_,reply)=>reply.type("text/html; charset=utf-8").send(HTML));

const port=Number(process.env.PORT||3000);
initDb().then(()=>app.listen({host:"0.0.0.0",port})).catch(err=>{app.log.error(err);process.exit(1)});
