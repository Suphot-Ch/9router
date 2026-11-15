import { acknowledgeKeyAlert } from '@/lib/db/repos/keyAlertsRepo.js';
export async function PATCH(request,{params}) {
  try {
    const {id}=await params, body=await request.json();
    if (!body || body.acknowledged !== true || Object.keys(body).some(k=>k!=='acknowledged')) return Response.json({error:'Expected {acknowledged:true}'},{status:400});
    const alert=await acknowledgeKeyAlert(id);
    return alert ? Response.json({alert}) : Response.json({error:'Alert not found'},{status:404});
  } catch(e) { return Response.json({error:'Unable to acknowledge alert'},{status:e instanceof SyntaxError ? 400 : 500}); }
}
