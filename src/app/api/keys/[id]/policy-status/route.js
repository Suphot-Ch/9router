import { getApiKeyById } from '@/lib/db/repos/apiKeysRepo.js';
import { withKeyPolicyStatus } from '@/lib/db/repos/keyPolicyStatus.js';
export const dynamic = 'force-dynamic';
export async function GET(request,{params}) {
  try {
    const {id}=await params, key=await getApiKeyById(id);
    if (!key) return Response.json({error:'Key not found'},{status:404});
    const {key:secret,machineId,...safe}=await withKeyPolicyStatus(key);
    return Response.json({...safe,keyId:key.id});
  } catch(e) { return Response.json({error:'Unable to read key policy status'},{status:500}); }
}
