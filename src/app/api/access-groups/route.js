import { getAccessGroups, createAccessGroup } from '@/lib/db/repos/accessGroupsRepo.js';
export const dynamic = 'force-dynamic';
const fail = e => Response.json({error:e?.status ? e.message : 'Access group operation failed'}, {status:e?.status || (e instanceof SyntaxError ? 400 : 500)});
export async function GET() {
  try { return Response.json({groups:await getAccessGroups()}); } catch(e) { return fail(e); }
}
export async function POST(request) {
  try { return Response.json({group:await createAccessGroup(await request.json())},{status:201}); } catch(e) { return fail(e); }
}
