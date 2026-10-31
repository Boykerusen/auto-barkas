
const ALLOWED_ORIGIN = "https://auto-barkas.pages.dev";
const PLANS = { "7": { amount: 2000, days: 7 }, "30": { amount: 5000, days: 30 }, "60": { amount: 9000, days: 60 }, featured: { amount: 10000, days: 30 } };
function b64url(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,""); }
async function sha1hex(value) { const digest=await crypto.subtle.digest("SHA-1",new TextEncoder().encode(value)); return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,"0")).join(""); }
function bytesToBase64(bytes) { let out=""; for(let i=0;i<bytes.length;i+=0x8000) out+=String.fromCharCode(...bytes.subarray(i,i+0x8000)); return btoa(out); }
function fromB64url(s) { s=s.replace(/-/g,"+").replace(/_/g,"/"); return Uint8Array.from(atob(s + "=".repeat((4-s.length%4)%4)), c=>c.charCodeAt(0)); }
async function sign(value, secret) { const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]); return b64url(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(value))); }
async function tokenValid(request, env) { const h=request.headers.get("Authorization")||""; const token=h.startsWith("Bearer ")?h.slice(7):""; const [body,sig]=token.split("."); if(!body||!sig||!env.ADMIN_TOKEN_SECRET)return false; try { const expected=await sign(body,env.ADMIN_TOKEN_SECRET); if(expected!==sig)return false; const data=JSON.parse(new TextDecoder().decode(fromB64url(body))); return data.exp>Date.now() && data.role==="admin"; } catch { return false; } }
export default {
 async fetch(request, env) {
  const cors={"Access-Control-Allow-Origin":ALLOWED_ORIGIN,"Access-Control-Allow-Methods":"GET, POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type, Accept, Authorization","Content-Type":"application/json; charset=utf-8","Vary":"Origin"};
  const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:cors});
  if(request.method==="OPTIONS") return new Response(null,{status:204,headers:cors});
  const url=new URL(request.url); const path=url.pathname;
  try {
   if(path==="/"||path==="/api") return reply({app:"AUTO BARKAS API",status:"online",version:"1.9.2"});
   if(path==="/api/listings"&&request.method==="GET") {
    const category=url.searchParams.get("category");
    let sql=`SELECT id,title,description,category,subcategory,price,condition,province,regency,district,village,seller_name,created_at,expires_at,views FROM listings WHERE status='active' AND (expires_at IS NULL OR expires_at>CURRENT_TIMESTAMP)`;
    const stmt=category?env.DB.prepare(sql+" AND category = ?").bind(category):env.DB.prepare(sql);
    const result=await stmt.all(); const listings=result.results; for (const item of listings) { const photos=await env.DB.prepare(`SELECT photo_url FROM listing_photos WHERE listing_id=? ORDER BY sort_order,id LIMIT 5`).bind(item.id).all(); item.photos=photos.results.map(x=>x.photo_url); } return reply({success:true,listings});
   }
   if(path==="/api/listings"&&request.method==="POST") {
    if(request.headers.get("Origin")!==ALLOWED_ORIGIN) return reply({success:false,error:"Asal permintaan tidak diizinkan."},403);
    if(!(request.headers.get("Content-Type")||"").includes("application/json")) return reply({success:false,error:"Gunakan format JSON."},415);
    const data=await request.json(); const clean=(v,max)=>typeof v==="string"?v.trim().slice(0,max):"";
    const title=clean(data.title,120),category=clean(data.category,60),description=clean(data.description,2000),condition=clean(data.condition,10),province=clean(data.province,80),regency=clean(data.regency,100),district=clean(data.district,100),village=clean(data.village,100),sellerName=clean(data.seller_name,100),sellerContact=clean(data.seller_contact,30),price=Number(data.price),plan=String(data.plan||"30");
    if(!title||!category||!description||!["baru","bekas"].includes(condition)||!province||!regency||!sellerName||!sellerContact||!Number.isSafeInteger(price)||price<0||price>1e12||!PLANS[plan]||!/^[+0-9 ()-]{8,30}$/.test(sellerContact)) return reply({success:false,error:"Data belum lengkap atau formatnya tidak valid."},400);
    const id=crypto.randomUUID(),paymentId=crypto.randomUUID(),amount=PLANS[plan].amount;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO listings (id,title,description,category,price,condition,province,regency,district,village,seller_name,seller_contact,status,expires_at,plan,duration_days) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending',NULL,?,?)`).bind(id,title,description,category,price,condition,province,regency,district,village,sellerName,sellerContact,plan,PLANS[plan].days),
      env.DB.prepare(`INSERT INTO payments (id,listing_id,amount,payment_method,status) VALUES (?,?,?,'QRIS','pending')`).bind(paymentId,id,amount)
    ]);
    return reply({success:true,listing_id:id,payment_id:paymentId,amount,plan,duration_days:PLANS[plan].days,status:"pending",message:"Pengajuan diterima dan menunggu verifikasi admin."},201);
   }
   if(path==="/api/uploads/sign"&&request.method==="POST") {
    if(request.headers.get("Origin")!==ALLOWED_ORIGIN) return reply({success:false,error:"Asal permintaan tidak diizinkan."},403);
    if(!env.CLOUDINARY_API_SECRET||!env.CLOUDINARY_API_KEY||!env.CLOUDINARY_CLOUD_NAME) return reply({success:false,error:"Konfigurasi Cloudinary belum lengkap di Worker."},503);
    const body=await request.json(); const listingId=String(body.listing_id||"");
    if(!/^[a-f0-9-]{36}$/i.test(listingId)) return reply({success:false,error:"Nomor iklan tidak valid."},400);
    const listing=await env.DB.prepare(`SELECT id,status FROM listings WHERE id=?`).bind(listingId).first();
    if(!listing||listing.status!=="pending") return reply({success:false,error:"Iklan tidak ditemukan atau tidak menunggu verifikasi."},404);
    const count=await env.DB.prepare(`SELECT COUNT(*) AS total FROM listing_photos WHERE listing_id=?`).bind(listingId).first();
    if(Number(count?.total||0)>=5) return reply({success:false,error:"Maksimal 5 foto untuk satu iklan."},400);
    const timestamp=Math.floor(Date.now()/1000); const folder=`auto-barkas/${listingId}`; const upload_preset="auto_barkas";
    const params=`folder=${folder}&timestamp=${timestamp}&upload_preset=${upload_preset}`;
    const signature=await sha1hex(params+env.CLOUDINARY_API_SECRET);
    return reply({success:true,cloud_name:env.CLOUDINARY_CLOUD_NAME,api_key:env.CLOUDINARY_API_KEY,timestamp,folder,upload_preset,signature});
   }
   const photoRoute=path.match(/^\/api\/listings\/([a-f0-9-]+)\/photos$/i);
   if(photoRoute&&request.method==="POST") {
    if(request.headers.get("Origin")!==ALLOWED_ORIGIN) return reply({success:false,error:"Asal permintaan tidak diizinkan."},403);
    const listingId=photoRoute[1]; const listing=await env.DB.prepare(`SELECT id,status FROM listings WHERE id=?`).bind(listingId).first();
    if(!listing||listing.status!=="pending") return reply({success:false,error:"Iklan tidak ditemukan."},404);
    const body=await request.json(); const photos=Array.isArray(body.photos)?body.photos:[];
    if(!photos.length||photos.length>5) return reply({success:false,error:"Pilih 1 sampai 5 foto."},400);
    const existing=await env.DB.prepare(`SELECT COUNT(*) AS total FROM listing_photos WHERE listing_id=?`).bind(listingId).first();
    if(Number(existing?.total||0)+photos.length>5) return reply({success:false,error:"Maksimal 5 foto untuk satu iklan."},400);
    const statements=[];
    for(let i=0;i<photos.length;i++) { const value=String(photos[i]||""); const expected=`https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/image/upload/`; if(!value.startsWith(expected)||value.length>2000||/[\s<>]/.test(value)) return reply({success:false,error:"URL foto tidak valid."},400); statements.push(env.DB.prepare(`INSERT INTO listing_photos (listing_id,photo_url,sort_order) VALUES (?,?,?)`).bind(listingId,value,Number(existing?.total||0)+i)); }
    await env.DB.batch(statements); return reply({success:true,saved:photos.length});
   }
   if(path==="/api/admin/login"&&request.method==="POST") {
    if(request.headers.get("Origin")!==ALLOWED_ORIGIN) return reply({success:false,error:"Asal permintaan tidak diizinkan."},403);
    if(!env.ADMIN_PASSWORD||!env.ADMIN_TOKEN_SECRET) return reply({success:false,error:"Rahasia admin belum diatur di Worker."},503);
    const body=await request.json(); const password=typeof body.password==="string"?body.password:"";
    if(password.length>256||password!==env.ADMIN_PASSWORD) { await new Promise(r=>setTimeout(r,700)); return reply({success:false,error:"Kata sandi tidak cocok."},401); }
    const payload=b64url(new TextEncoder().encode(JSON.stringify({role:"admin",exp:Date.now()+4*60*60*1000,nonce:crypto.randomUUID()})));
    return reply({success:true,token:payload+"."+await sign(payload,env.ADMIN_TOKEN_SECRET),expires_in:14400});
   }
   if(path.startsWith("/api/admin/")) {
    if(!(await tokenValid(request,env))) return reply({success:false,error:"Sesi admin tidak valid atau kedaluwarsa. Silakan login kembali."},401);
    if(path==="/api/admin/payments"&&request.method==="GET") {
      const rows=await env.DB.prepare(`SELECT p.id AS payment_id,p.listing_id,p.amount,p.payment_method,p.status AS payment_status,l.title,l.category,l.price,l.seller_name,l.seller_contact,l.regency,l.plan,l.duration_days,l.created_at FROM payments p JOIN listings l ON l.id=p.listing_id WHERE p.status='pending' ORDER BY l.created_at ASC LIMIT 100`).all();
      const payments=rows.results;
      for (const item of payments) {
        const photoRows=await env.DB.prepare(`SELECT photo_url FROM listing_photos WHERE listing_id=? ORDER BY sort_order,id LIMIT 5`).bind(item.listing_id).all();
        item.photos=photoRows.results.map(row=>row.photo_url);
      }
      return reply({success:true,payments});
    }
    const action=path.match(/^\/api\/admin\/payments\/([a-f0-9-]+)\/(approve|reject)$/i);
    if(action&&request.method==="POST") {
      const paymentId=action[1],decision=action[2]; const row=await env.DB.prepare(`SELECT p.id AS payment_id,p.listing_id,p.status,l.plan,l.duration_days FROM payments p JOIN listings l ON l.id=p.listing_id WHERE p.id=?`).bind(paymentId).first();
      if(!row||row.status!=="pending") return reply({success:false,error:"Pembayaran tidak ditemukan atau sudah diproses."},404);
      if(decision==="approve") {const days=Number(row.duration_days)||PLANS[String(row.plan)||"30"]?.days||30;const start=new Date();const end=new Date(start.getTime()+days*86400000).toISOString();await env.DB.prepare(`UPDATE payments SET status='verified',verified_at=CURRENT_TIMESTAMP WHERE id=?`).bind(paymentId).run();await env.DB.prepare(`UPDATE listings SET status='active',starts_at=CURRENT_TIMESTAMP,expires_at=? WHERE id=?`).bind(end,row.listing_id).run();}
      else {await env.DB.prepare(`UPDATE payments SET status='rejected',verified_at=CURRENT_TIMESTAMP WHERE id=?`).bind(paymentId).run();await env.DB.prepare(`UPDATE listings SET status='rejected',rejected_at=CURRENT_TIMESTAMP WHERE id=?`).bind(row.listing_id).run();}
      return reply({success:true,status:decision==="approve"?"active":"rejected",message:decision==="approve"?"Pembayaran disetujui, iklan aktif.":"Pengajuan ditolak. Data tetap tersimpan untuk riwayat."});
    }
   }
   return reply({success:false,error:"Endpoint tidak ditemukan."},404);
  } catch(error) { return reply({success:false,error:"Terjadi kesalahan pada API. Periksa migrasi database."},500); }
 },
 async scheduled(event, env, ctx) {
   // Retain historical listing/payment/photo records. No scheduled destructive cleanup.
   // Expired/rejected records remain in D1 for audit and possible admin review.
 }
};

