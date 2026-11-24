// Previz player — renders a normalized scene with three.js. The look stays deliberately
// flat and vector: MeshBasicMaterial only (no lights, no shadows), filled polygons
// extruded paper-thin, one grid floor — an Another World stage with a real 3D camera.
// The SAME module powers the Director Studio tab and the baked standalone HTML, so a
// preview, a playblast frame and a recovered clip are pixel-identical.
import * as THREE from 'three';
import {sampleAt} from '../../previz-format.mjs';
import {partsFor,partAngle} from '../../previz-shapes.mjs';

const DEG=Math.PI/180;

// Build one actor's part meshes (unit space). Static geometry: per-frame work is only
// group transforms + hinge rotations, so scrubbing thousands of frames stays cheap.
function buildActor(actor){
  const group=new THREE.Group();
  group.scale.set(actor.scale,actor.scale,actor.scale);
  const hinges=[];
  // Small local-z offsets per part keep draw order honest without z-fighting, and the
  // far-side parts read darker through shade — silhouettes separate with no outlines.
  partsFor(actor).forEach((part,index)=>{
    const shape=new THREE.Shape();
    part.poly.forEach(([x,y],i)=>i?shape.lineTo(x,y):shape.moveTo(x,y));
    shape.closePath();
    const mat=new THREE.MeshBasicMaterial({color:new THREE.Color(actor.color).multiplyScalar(part.shade??1),side:THREE.DoubleSide});
    let mesh;
    if(part.hinge){
      // Hinge parts rotate around their anchor: offset the polygon into a child group.
      const holder=new THREE.Group();
      holder.position.set(part.hinge[0],part.hinge[1],index*.003);
      const shifted=new THREE.Shape();
      part.poly.forEach(([x,y],i)=>i?shifted.lineTo(x-part.hinge[0],y-part.hinge[1]):shifted.moveTo(x-part.hinge[0],y-part.hinge[1]));
      shifted.closePath();
      mesh=new THREE.Mesh(new THREE.ExtrudeGeometry(shifted,{depth:.015,bevelEnabled:false}),mat);
      holder.add(mesh);group.add(holder);
      hinges.push({holder,part});
    }else{
      mesh=new THREE.Mesh(new THREE.ExtrudeGeometry(shape,{depth:.015,bevelEnabled:false}),mat);
      mesh.position.z=index*.003;
      group.add(mesh);
    }
  });
  return {group,hinges};
}

// The stage: owns the renderer, camera and actor registry for one canvas.
export function createStage(canvas){
  const renderer=new THREE.WebGLRenderer({canvas,antialias:true});
  renderer.setPixelRatio(1); // deterministic pixels for headless frame capture
  const world=new THREE.Scene();
  const camera=new THREE.PerspectiveCamera(40,16/9,.01,2000);
  let actorsById=new Map(),props3d=[],grid=null,ground=null,scene=null;

  function rebuild(){
    if(grid){world.remove(grid);grid=null;}
    if(ground){world.remove(ground);ground=null;}
    for(const {group} of actorsById.values())world.remove(group);
    for(const mesh of props3d)world.remove(mesh);
    props3d=[];
    actorsById=new Map();
    if(!scene)return;
    world.background=new THREE.Color(scene.palette.sky);
    ground=new THREE.Mesh(new THREE.PlaneGeometry(1000,1000),new THREE.MeshBasicMaterial({color:new THREE.Color(scene.palette.ground)}));
    ground.rotation.x=-Math.PI/2;world.add(ground);
    grid=new THREE.GridHelper(200,200,scene.palette.grid,scene.palette.grid);
    grid.position.y=.002;grid.material.transparent=true;grid.material.opacity=.35;world.add(grid);
    for(const actor of scene.actors){const built=buildActor(actor);actorsById.set(actor.id,built);world.add(built.group);}
    for(const prop of scene.props){const mesh=buildProp(prop);props3d.push(mesh);world.add(mesh);}
  }

  function buildProp(prop){
    if(prop.shape==='poly'&&prop.poly){
      const shape=new THREE.Shape();
      prop.poly.forEach(([x,y],i)=>i?shape.lineTo(x,y):shape.moveTo(x,y));
      shape.closePath();
      const mesh=new THREE.Mesh(new THREE.ExtrudeGeometry(shape,{depth:Math.max(prop.size?.[2]??.5,.01),bevelEnabled:false}),new THREE.MeshBasicMaterial({color:new THREE.Color(prop.color),side:THREE.DoubleSide}));
      mesh.position.set(prop.pos[0],prop.pos[1],prop.pos[2]);
      mesh.rotation.y=prop.rot*DEG;
      return mesh;
    }
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(prop.size[0],prop.size[1],prop.size[2]),new THREE.MeshBasicMaterial({color:new THREE.Color(prop.color)}));
    // Prop pos is the base center — the natural way to author stage geometry on the floor.
    mesh.position.set(prop.pos[0],prop.pos[1]+prop.size[1]/2,prop.pos[2]);
    mesh.rotation.y=prop.rot*DEG;
    return mesh;
  }

  function setT(t){
    if(!scene)return;
    const state=sampleAt(scene,t);
    camera.position.set(...state.camera.pos);
    camera.fov=state.camera.fov??scene.camera.fov;
    camera.updateProjectionMatrix();
    camera.lookAt(state.camera.look[0],state.camera.look[1],state.camera.look[2]);
    for(const actor of state.actors){
      const built=actorsById.get(actor.id);if(!built)continue;
      built.group.position.set(actor.pos[0],actor.pos[1],actor.pos[2]);
      // Billboard: flat silhouettes stay legible from every angle; flip mirrors them.
      const yaw=actor.billboard
        ?Math.atan2(camera.position.x-actor.pos[0],camera.position.z-actor.pos[2])
        :(actor.rot??0)*DEG;
      built.group.rotation.y=yaw;
      built.group.scale.set(actor.flip*actor.scale,actor.scale,actor.scale);
      for(const {holder,part} of built.hinges)holder.rotation.z=partAngle(part,actor.params)*DEG;
    }
    renderer.render(world,camera);
  }

  function resize(width,height){
    renderer.setSize(width,height,false);
    camera.aspect=width/height;
    camera.updateProjectionMatrix();
  }
  function setScene(next){scene=next;rebuild();}
  function dispose(){renderer.dispose();}
  return {setScene,setT,resize,dispose,renderer,get scene(){return scene;}};
}
