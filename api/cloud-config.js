// Supabase's public/publishable client key is safe to send to browsers.
// Never send SUPABASE_SERVICE_ROLE_KEY or a database password to the client.
export default function handler(req,res){
  res.setHeader('Cache-Control','private, no-store, max-age=0');
  const url=process.env.SUPABASE_URL||'';
  const anonKey=process.env.SUPABASE_PUBLISHABLE_KEY||process.env.SUPABASE_ANON_KEY||'';
  if(req.method!=='GET'){res.status(405).json({error:'GET only'});return;}
  if(!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(url)||!anonKey){res.status(503).json({error:'Supabase is not configured'});return;}
  res.status(200).json({url,anonKey});
}