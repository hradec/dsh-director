// Previz shape kit — parametric flat silhouettes in the Another World idiom: a handful
// of filled polygons, no outlines, readable at thumbnail size. Units: x forward (+x),
// y up, feet at y=0, full height about 1; actor.scale maps that into world meters.
// Parts render in list order (far side first), each optionally hinged:
//   mode 'direct': angle = params[param]*mult (degrees)         — wings, head, tail
//   mode 'osc'   : angle = amp*sin(2π*params[param] + phase)    — walking legs
// Any actor may instead carry its own `poly` (silhouette or single custom shape).

export const SHAPE_KIT={
  // Winged wyvern, side profile, head to +x. Wing membranes are scalloped polygons;
  // far parts get shade<1 so wings and legs separate without outlines.
  wyvern:{parts:[
    // far hind wing: same membrane, hinged together, darker
    {shade:.65,hinge:[.02,.58],param:'wing',mult:1,offset:-14,poly:[
      [0,0],[-.28,.3],[-.46,.58],[-.26,.58],[-.1,.4],[.14,.3],[.1,.1]]},
    // far legs
    {shade:.7,hinge:[.2,.34],param:'legs',mode:'osc',amp:22,phase:Math.PI,poly:[[.05,.04],[-.06,.02],[-.05,-.2],[-.09,-.36],[.02,-.38],[.08,-.2],[.07,-.02]]},
    {shade:.7,hinge:[-.26,.34],param:'legs',mode:'osc',amp:22,phase:0,poly:[[.05,.04],[-.06,.02],[-.05,-.2],[-.09,-.36],[.02,-.38],[.08,-.2],[.07,-.02]]},
    // tail: long tapering curve, slow sway via direct degrees
    {hinge:[-.42,.42],param:'tail',mult:1,poly:[[-.02,.06],[-.3,.14],[-.62,.26],[-.9,.42],[-.94,.32],[-.66,.12],[-.34,.0],[-.02,-.08]]},
    // body core
    {poly:[[-.46,.44],[-.3,.6],[-.02,.66],[.24,.64],[.42,.52],[.44,.34],[.2,.28],[-.2,.28],[-.42,.34]]},
    // neck + horned head, hinged at the shoulder — reads clear of the body mass
    {hinge:[.3,.5],param:'head',mult:1,poly:[[-.06,.02],[.06,.24],[.2,.4],[.42,.5],[.6,.58],[.74,.44],[.6,.36],[.36,.26],[.16,.04],[0,-.08]]},
    // near hind wing: brighter
    {shade:1,hinge:[.02,.58],param:'wing',mult:1,poly:[
      [0,0],[-.28,.3],[-.46,.58],[-.26,.58],[-.1,.4],[.14,.3],[.1,.1]]},
    // near legs
    {hinge:[.2,.34],param:'legs',mode:'osc',amp:22,phase:0,poly:[[.05,.04],[-.06,.02],[-.05,-.2],[-.09,-.36],[.02,-.38],[.08,-.2],[.07,-.02]]},
    {hinge:[-.26,.34],param:'legs',mode:'osc',amp:22,phase:Math.PI,poly:[[.05,.04],[-.06,.02],[-.05,-.2],[-.09,-.36],[.02,-.38],[.08,-.2],[.07,-.02]]},
  ]},
  // Biped, side profile: head block, torso, one swinging arm, two oscillating legs.
  biped:{parts:[
    {shade:.7,hinge:[0,.46],param:'legs',mode:'osc',amp:26,phase:Math.PI,poly:[[.05,0],[-.05,0],[-.04,-.22],[-.02,-.46],[.05,-.46],[.07,-.2]]},
    {poly:[[-.1,.46],[.12,.46],[.16,.68],[.1,.82],[-.08,.82],[-.14,.66]]},          // torso
    {poly:[[-.05,.84],[.08,.86],[.1,.96],[.02,1.02],[-.08,.98]]},                   // head
    {hinge:[.0,.74],param:'arm',mode:'osc',amp:24,phase:0,poly:[[.04,0],[-.04,0],[-.06,-.2],[-.03,-.4],[.04,-.4],[.06,-.18]]},
    {hinge:[0,.46],param:'legs',mode:'osc',amp:26,phase:0,poly:[[.05,0],[-.05,0],[-.04,-.22],[-.02,-.46],[.05,-.46],[.07,-.2]]},
  ]},
  // Generic four-legged beast (horse/dog blocking proxy).
  quadruped:{parts:[
    {shade:.7,hinge:[.3,.42],param:'legs',mode:'osc',amp:20,phase:Math.PI,poly:[[.04,0],[-.04,0],[-.03,-.2],[-.02,-.42],[.04,-.42],[.05,-.2]]},
    {shade:.7,hinge:[-.3,.42],param:'legs',mode:'osc',amp:20,phase:0,poly:[[.04,0],[-.04,0],[-.03,-.2],[-.02,-.42],[.04,-.42],[.05,-.2]]},
    {poly:[[-.42,.46],[.42,.5],[.46,.78],[-.4,.8],[-.46,.62]]},                     // body
    {hinge:[.4,.72],param:'head',mult:1,poly:[[0,0],[.1,.16],[.34,.22],[.4,.14],[.2,.1],[.12,-.04]]},
    {poly:[[.42,.8],[.5,.98],[.44,1],[.36,.86]]},                                    // mane/ears
    {hinge:[-.4,.5],param:'tail',mult:1,poly:[[0,.06],[-.26,.14],[-.4,.28],[-.3,.12],[-.04,0]]},
    {hinge:[-.3,.42],param:'legs',mode:'osc',amp:20,phase:Math.PI,poly:[[.04,0],[-.04,0],[-.03,-.2],[-.02,-.42],[.04,-.42],[.05,-.2]]},
    {hinge:[.3,.42],param:'legs',mode:'osc',amp:20,phase:0,poly:[[.04,0],[-.04,0],[-.03,-.2],[-.02,-.42],[.04,-.42],[.05,-.2]]},
  ]},
};

// Resolve the part list for an actor: built-in kit, or one custom polygon.
export function partsFor(actor){
  if(actor.shape==='poly'&&actor.poly)return [{poly:actor.poly}];
  const kit=SHAPE_KIT[actor.shape];
  if(kit)return kit.parts.filter((p)=>p.poly&&p.poly.length);
  return [{poly:[[-.3,0],[.3,0],[.3,1],[-.3,1]]}]; // unknown shape: honest rectangle proxy
}

// Hinge angle (degrees) for one part given the sampled params object.
export function partAngle(part,params){
  const v=Number(params?.[part.param]??0);
  if(part.mode==='osc')return (part.amp??0)*Math.sin(2*Math.PI*v+(part.phase??0));
  return v*(part.mult??1)+(part.offset??0);
}
