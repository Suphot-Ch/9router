import { NextResponse } from 'next/server';
import { deleteApiKey, getApiKeyById, updateApiKey, resetApiKeyUsage } from '@/lib/localDb';
import { keyEditFields, withKeyPolicyStatus } from '@/lib/db/repos/keyPolicyStatus.js';

const failure = error => NextResponse.json({ error: error?.status === 400 || error instanceof SyntaxError ? error.message : 'Failed to update key' }, {status: error?.status === 400 || error instanceof SyntaxError ? 400 : 500});
export async function GET(request, {params}) {
  try {
    const {id}=await params, key=await getApiKeyById(id);
    if (!key) return NextResponse.json({error:'Key not found'},{status:404});
    return NextResponse.json({key:await withKeyPolicyStatus(key)});
  } catch(error) { return failure(error); }
}
// Both legacy methods accept the complete policy, preserving old payloads.
export async function PATCH(request, {params}) {
  try {
    const {id}=await params, body=await request.json();
    const existing=await getApiKeyById(id);
    if (!existing) return NextResponse.json({error:'Key not found'},{status:404});
    const fields=keyEditFields(body);
    let key=Object.keys(fields).length ? await updateApiKey(id,fields) : existing;
    if (body.resetUsage === true) key=await resetApiKeyUsage(id);
    return NextResponse.json({key:await withKeyPolicyStatus(key)});
  } catch(error) { return failure(error); }
}
export const PUT = PATCH;
export async function DELETE(request, {params}) {
  try {
    const {id}=await params;
    if (!await deleteApiKey(id)) return NextResponse.json({error:'Key not found'},{status:404});
    return NextResponse.json({message:'Key deleted successfully'});
  } catch(error) { return failure(error); }
}
