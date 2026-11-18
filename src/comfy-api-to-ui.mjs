// API-format ComfyUI prompt (the graph embedded by SaveImage/SaveVideo on API-submitted renders)
// → UI (editor) format, using the TARGET host's own /object_info so node inputs/widgets/outputs
// match that server exactly. The frontend converts API graphs itself on File→Open, but the
// clipboard paste path only accepts UI format — hence this converter. Faithful for every node
// class the server registers; unknown classes get a best-effort node from the prompt alone.
const WIDGET_TYPE_DEFAULT=(type)=>{const t=String(type);if(/INT|FLOAT|NUMBER|seed|noise/i.test(t))return 0;if(t==='BOOLEAN')return false;return '';};
function topo(prompt){
  // Depth-first layering so producers sit left of consumers; cycles fall back to insertion order.
  const ids=Object.keys(prompt);
  const deps=new Map();
  for(const id of ids){const fed=[];for(const v of Object.values(prompt[id].inputs??{}))if(Array.isArray(v)&&typeof v[0]==='string')fed.push(v[0]);deps.set(id,fed.filter(d=>prompt[d]));}
  const layer=new Map();const visiting=new Set();
  const depth=(id)=>{if(layer.has(id))return layer.get(id);if(visiting.has(id))return 0;visiting.add(id);
    let d=0;for(const dep of deps.get(id)??[])d=Math.max(d,depth(dep)+1);visiting.delete(id);layer.set(id,d);return d;};
  for(const id of ids)depth(id);
  return ids.sort((a,b)=>(layer.get(a)-layer.get(b))||Number(a)-Number(b)).map(id=>({id,layer:layer.get(id)}));
}
export function apiToUi(prompt,objectInfo){
  if(!prompt||typeof prompt!=='object'||!objectInfo||typeof objectInfo!=='object')return null;
  const order=topo(prompt);
  const uiId=new Map();order.forEach((entry,index)=>uiId.set(entry.id,index+1));
  const nodes=[],links=[];let linkId=1;
  const columnY=new Map();
  for(const {id,layer} of order){
    const api=prompt[id];const spec=objectInfo[api.class_type];
    const required=spec?.input?.required??{},optional=spec?.input?.optional??{},hidden=new Set(Object.keys(spec?.input?.hidden??{}));
    const declared=[...Object.entries(required),...Object.entries(optional)].filter(([name])=>!hidden.has(name));
    const inputs=[],widgets=[];
    for(const [name,entry] of declared){
      const value=api.inputs?.[name];
      if(Array.isArray(value)&&typeof value[0]==='string'&&prompt[value[0]]){
        inputs.push({name,type:typeof entry[0]==='string'?entry[0]:'*',link:null});
        continue;
      }
      inputs.push({name,type:typeof entry[0]==='string'?entry[0]:'*',link:null});
      const options=Array.isArray(entry)?(entry[1]??{}):{};
      widgets.push(value!==undefined?value:(options.default!==undefined?options.default:WIDGET_TYPE_DEFAULT(entry[0])));
    }
    // Inputs the prompt feeds that the schema does not declare (wildcard/custom frontends) still need sockets.
    const declaredNames=new Set(declared.map(([name])=>name));
    for(const [name,value] of Object.entries(api.inputs??{}))if(Array.isArray(value)&&typeof value[0]==='string'&&prompt[value[0]]&&!declaredNames.has(name))inputs.push({name,type:'*',link:null});
    for(const [name,value] of Object.entries(api.inputs??{}))if(!(Array.isArray(value)&&typeof value[0]==='string')&&!declaredNames.has(name))widgets.push(value);// prompt constants the schema does not declare (older/renamed widgets) ride along rather than vanish

    const outNames=Array.isArray(spec?.output_name)?spec.output_name:[];
    const outputs=(Array.isArray(spec?.output)?spec.output:(spec?.output??[])).map((type,i)=>({name:outNames[i]??`output ${i}`,type,links:[]}));
    const size=[Math.max(280,Math.min(460,200+Math.max(...widgets.map((w)=>String(w).length),12)*4)),60+widgets.length*26+Math.max(inputs.length,outputs.length,1)*24];
    const x=40+layer*520;const y=columnY.get(layer)??100;columnY.set(layer,y+size[1]+40);
    nodes.push({id:uiId.get(id),type:api.class_type,pos:[x,y],size,flags:{},order:0,mode:0,inputs,outputs,properties:{NodePage:{NodePage:{size:[320,160],pos:[x,y]}}},widgets_values:widgets,title:api._meta?.title||api.class_type});
  }
  for(const {id} of order){
    const ui=nodes.find((node)=>node.id===uiId.get(id));
    for(const [name,value] of Object.entries(prompt[id].inputs??{})){
      if(!(Array.isArray(value)&&typeof value[0]==='string'&&prompt[value[0]]))continue;
      const src=uiId.get(value[0]);const srcNode=nodes.find((node)=>node.id===src);
      const slot=Number(value[1])||0;const srcOut=srcNode?.outputs?.[slot]??null;
      const dst=ui.inputs.find((input)=>input.name===name);if(!dst)continue;
      dst.link=linkId;links.push([linkId,src,slot,ui.id,name,srcOut?.type??'*']);linkId++;
    }
  }
  for(const link of links)for(const node of nodes)for(const out of node.outputs)if(node.id===link[1]&&out.links!==undefined)if(link[2]===(node.outputs.indexOf(out)))out.links.push(link[0]);
  return {last_node_id:nodes.length,last_link_id:linkId-1,nodes,links,groups:[],config:{},extra:{dsdConvertedFromApi:true},version:0.4};
}
