import {beforeEach,describe,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({connections:vi.fn(),budget:vi.fn()}));
vi.mock('@/lib/localDb',()=>({getProviderConnections:m.connections,getSettings:vi.fn(async()=>({})),getProxyPools:vi.fn(),validateApiKey:vi.fn(),updateProviderConnection:vi.fn()}));
vi.mock('@/lib/db/repos/connectionTokenBudgetsRepo.js',()=>({applyConnectionTokenBudget:m.budget}));
vi.mock('@/lib/network/connectionProxy',()=>({resolveConnectionProxyConfig:vi.fn(async()=>({})),pickProxyPoolId:vi.fn()}));
vi.mock('@/shared/constants/providers.js',()=>({FREE_PROVIDERS:{},resolveProviderId:p=>p}));
vi.mock('@/sse/utils/logger.js',()=>({debug:vi.fn(),info:vi.fn(),warn:vi.fn()}));
const {getProviderCredentials}=await import('@/sse/services/auth.js');
beforeEach(()=>{vi.clearAllMocks();m.connections.mockResolvedValue([{id:'a',isActive:true,tokenBudget:{tokenLimit:10}},{id:'b',isActive:true}]);m.budget.mockResolvedValue({tokenLimit:10,usedTokens:10,atLimit:true,nextResetAt:null});});
describe('account budget credential gate',()=>{
 it('skips exhausted account without toggling active and selects next',async()=>{expect(await getProviderCredentials('deepseek')).toMatchObject({connectionId:'b'});expect(m.budget).toHaveBeenCalledWith('a');});
 it('returns budget denial when all active accounts exhausted',async()=>{m.connections.mockResolvedValue([{id:'a',isActive:true,tokenBudget:{tokenLimit:10}}]);expect(await getProviderCredentials('deepseek')).toMatchObject({allRateLimited:true,lastErrorCode:429});});
 it('allows due-reset account back into rotation',async()=>{m.budget.mockResolvedValue({tokenLimit:10,usedTokens:0,atLimit:false});expect(await getProviderCredentials('deepseek')).toMatchObject({connectionId:'a'});});
 it('fails closed for a budget whose storage fails',async()=>{m.budget.mockRejectedValue(new Error('busy'));expect(await getProviderCredentials('deepseek')).toMatchObject({connectionId:'b'});});
 it('polls the pinned active account after token exhaustion',async()=>{expect(await getProviderCredentials('deepseek',null,null,{preferredConnectionId:'a',purpose:'video-status'})).toMatchObject({connectionId:'a'});expect(m.budget).not.toHaveBeenCalled();});
 it('does not rotate to another account for a pinned video status lookup',async()=>{expect(await getProviderCredentials('deepseek',null,null,{preferredConnectionId:'not-active',purpose:'video-status'})).toBeNull();});
 it('preserves excluded accounts independently of budgets',async()=>{expect(await getProviderCredentials('deepseek',new Set(['b']))).toMatchObject({allRateLimited:true});});
});
