import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';

const listings = [
  {id:'MC-001',locality:'Whitefield',bhk:2,rent:32000,deposit:150000,furnishing:'semi-furnished',pets:true,parking:true,features:'Near metro; covered parking'},
  {id:'MC-002',locality:'Whitefield',bhk:2,rent:35000,deposit:180000,furnishing:'furnished',pets:false,parking:true,features:'Balcony; gym'},
  {id:'MC-003',locality:'Brookefield',bhk:2,rent:29000,deposit:120000,furnishing:'semi-furnished',pets:true,parking:false,features:'Balcony; no parking'},
  {id:'MC-004',locality:'Indiranagar',bhk:1,rent:28000,deposit:140000,furnishing:'furnished',pets:false,parking:false,features:'Near metro'},
  {id:'MC-005',locality:'Sarjapur Road',bhk:3,rent:48000,deposit:240000,furnishing:'semi-furnished',pets:true,parking:true,features:'Pool; parking'},
  {id:'MC-006',locality:'Bellandur',bhk:2,rent:39000,deposit:200000,furnishing:'unfurnished',pets:true,parking:true,features:'Lift; parking'},
  {id:'MC-007',locality:'HSR Layout',bhk:1,rent:25000,deposit:100000,furnishing:'semi-furnished',pets:true,parking:false,features:'Balcony'},
  {id:'MC-008',locality:'Marathahalli',bhk:2,rent:31000,deposit:150000,furnishing:'semi-furnished',pets:false,parking:true,features:'Lift; parking'},
].map(x => ({...x,source:'mock',status:'fictional_not_bookable'}));
const reply = value => ({content:[{type:'text',text:JSON.stringify(value)}]});
function makeServer(env) {
  const server = new McpServer({name:'MergeConflicts Rentals',version:'0.1.0'});
  server.registerTool('search_demo_listings', {description:'Search fictional Bengaluru rentals; these are not real or bookable.',inputSchema:z.object({locality:z.string().max(100).optional(),bhk:z.number().int().min(1).max(10).optional(),max_rent:z.number().int().positive().optional(),pets_required:z.boolean().optional(),parking_required:z.boolean().optional()})}, async a => reply({notice:'Fictional demo data; not real or bookable.',results:listings.filter(x => (!a.locality || x.locality.toLowerCase().includes(a.locality.toLowerCase())) && (!a.bhk || x.bhk===a.bhk) && (!a.max_rent || x.rent<=a.max_rent) && (!a.pets_required || x.pets) && (!a.parking_required || x.parking)).sort((a,b)=>a.rent-b.rent)}));
  server.registerTool('get_demo_listing',{description:'Retrieve one fictional listing.',inputSchema:z.object({listing_id:z.string().max(30)})},async ({listing_id})=>reply({notice:'Fictional demo data.',listing:listings.find(x=>x.id===listing_id)??null}));
  server.registerTool('save_demo_search',{description:'Store fictional search preferences; no alert is sent or activated.',inputSchema:z.object({locality:z.string().min(1).max(100),bhk:z.number().int().min(1).max(10),max_rent:z.number().int().positive(),pets_required:z.boolean().default(false),alerts_consent:z.boolean().default(false)})},async a=>{
    const result=await env.DB.prepare('INSERT INTO demo_searches(locality,bhk,max_rent,pets_required,alerts_consent) VALUES(?,?,?,?,?)').bind(a.locality,a.bhk,a.max_rent,Number(a.pets_required),Number(a.alerts_consent)).run();
    return reply({search_id:result.meta.last_row_id,alerts_active:false,notice:'Demo only; no notifications configured.'});
  });
  server.registerTool('request_demo_viewing',{description:'Record a fictional request only; does not book or contact anyone.',inputSchema:z.object({listing_id:z.string().max(30),requested_time:z.string().min(1).max(100)})},async a=>{
    if(!listings.some(x=>x.id===a.listing_id)) return {isError:true,...reply({error:'Unknown demo listing.'})};
    const result=await env.DB.prepare('INSERT INTO demo_viewings(listing_id,requested_time) VALUES(?,?)').bind(a.listing_id,a.requested_time).run();
    return reply({request_id:result.meta.last_row_id,status:'demo_request_not_confirmed',notice:'No owner contacted; no visit booked.'});
  });
  server.registerTool('discover_public_listings',{description:'Search Parallel for candidate listings. Results may be stale and availability is unverified. Uses API credits.',inputSchema:z.object({objective:z.string().min(1).max(500)})},async ({objective})=>{
    if (!env.PARALLEL_API_KEY) return {isError:true,...reply({error:'Parallel is not configured.'})};
    try {
      const res=await fetch('https://api.parallel.ai/v1/search',{method:'POST',headers:{'x-api-key':env.PARALLEL_API_KEY,'content-type':'application/json'},body:JSON.stringify({objective,search_queries:[objective],mode:'fast'})});
      if(!res.ok) return {isError:true,...reply({error:'Search provider request failed.',status:res.status})};
      const data=await res.json(); return reply({notice:'Unverified web candidates; availability and details may be stale.',results:data.results,warnings:data.warnings});
    } catch { return {isError:true,...reply({error:'Search provider unavailable.'})}; }
  });
  return server;
}
export default {
  async fetch(request,env,ctx) {
    if (!env.MCP_BEARER_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.MCP_BEARER_TOKEN}`) return new Response('Unauthorized',{status:401,headers:{'Cache-Control':'no-store'}});
    if (new URL(request.url).pathname !== '/mcp') return new Response('Not found',{status:404});
    return createMcpHandler(()=>makeServer(env))(request,env,ctx);
  }
};
