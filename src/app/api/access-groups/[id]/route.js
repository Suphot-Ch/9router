import { getAccessGroupById, updateAccessGroup, deleteAccessGroup } from '@/lib/db/repos/accessGroupsRepo.js';
const fail = e => Response.json({error:e?.status ? e.message : 'Access group operation failed'}, {status:e?.status || (e instanceof SyntaxError ? 400 : 500)});
export async function GET(request,{params}) {
  try { const {id}=await params, group=await getAccessGroupById(id); return group ? Response.json({group}) : Response.json({error:'Group not found'},{status:404}); } catch(e) { return fail(e); }
}
export async function PUT(request,{params}) {
  try { const {id}=await params, group=await updateAccessGroup(id,await request.json()); return group ? Response.json({group}) : Response.json({error:'Group not found'},{status:404}); } catch(e) { return fail(e); }
}
export const PATCH = PUT;
export async function DELETE(request,{params}) {
  try { const {id}=await params; return await deleteAccessGroup(id) ? Response.json({success:true}) : Response.json({error:'Group not found'},{status:404}); } catch(e) { return fail(e); }
}
