import { getKeyAlerts } from '@/lib/db/repos/keyAlertsRepo.js';
export const dynamic = 'force-dynamic';
export async function GET(request) {
  try {
    const query=new URL(request.url).searchParams;
    return Response.json({alerts:await getKeyAlerts({keyId:query.get('keyId') || undefined,limit:query.get('limit') ?? 100})});
  } catch(e) { return Response.json({error:e?.status ? e.message : 'Unable to read alerts'},{status:e?.status || 500}); }
}
