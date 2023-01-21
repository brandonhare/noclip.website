import * as Viewer from '../viewer';

import { mat4, vec2, vec3 } from "gl-matrix";
import { drawWorldSpaceLine, getDebugOverlayCanvas2D } from "../DebugJunk";
import { AABB, Frustum } from "../Geometry";
import { fillColor, fillMatrix4x3 } from "../gfx/helpers/UniformBufferHelpers";
import { GfxColor, GfxDevice } from "../gfx/platform/GfxPlatform";
import { GfxRenderInstManager } from "../gfx/render/GfxRenderInstManager";
import { computeModelMatrixSRT, MathConstants } from "../MathHelpers";
import { assert } from "../util";

import { AnimatedObject, Cache, Program, RenderFlags, StaticObject } from "./renderer";
import { AnimationController } from "./skeleton";
import { TerrainInfo } from "./terrain";


export type Assets<MeshType, SkeletonType, TerrainType> = {
	models : {
		[name : string] : MeshType[][]
	}
	skeletons : {
		[name : string] : SkeletonType
	}
	terrain : TerrainType
	terrainInfo? : TerrainInfo
};

export type FriendlyNames = {[set:string]:(string | string[])[]};
export function getFriendlyName(friendlyNames : FriendlyNames, modelSet : string, modelIndex : number, meshIndex : number){
	const models = friendlyNames[modelSet];
	let result = `${modelIndex}/${meshIndex}`;
	if (models){
		const model = models[modelIndex];
		if (Array.isArray(model))
			result = model[meshIndex];
		else if (model)
			result = model;
	}
	return `${modelSet}/${result}`;
}

export type LevelObjectDef = {
	x : number,
	y : number, // terrain height
	z : number,
	type : number,
	param0 : number,
	param1 : number, // unused
	param2 : number, // unused
	param3 : number,
	flags? : number,  // unused

	// main menu hack
	rot? : number,
	scale? : number,
};

export class Entity {
	meshes : StaticObject[];
	position: vec3;
	rotX = 0;
	rotation: number;
	rotZ = 0;
	scale: vec3;
	modelMatrix : mat4 = mat4.create();
	aabb : AABB = new AABB();
	colour : GfxColor = {r:1,g:1,b:1,a:1};
	alwaysUpdate = false;
	isDynamic? : boolean; // if this entity will be updated even without its own update() method

	constructor(meshes : StaticObject | StaticObject[], position : vec3, rotation : number | null, scale : number, pushUp : boolean = false){
		if (!Array.isArray(meshes)){
			assert(meshes != undefined, "invalid mesh for entity");
			meshes = [meshes];
		}
		this.meshes = meshes;

		if (rotation === null)
			rotation = Math.random() * MathConstants.TAU;

		if (pushUp){
			let lowestY = Infinity;
			for (const mesh of meshes){
				const y = mesh.aabb.minY;
				if (y < lowestY) lowestY = y;
			}
			position[1] -= lowestY * scale;
		}

		this.position = position;
		this.rotation = rotation;
		this.scale = [scale, scale, scale];

		this.updateMatrix();
	}

	updateMatrix(){
		computeModelMatrixSRT(this.modelMatrix,
			this.scale[0], this.scale[1], this.scale[2],
			this.rotX, this.rotation, this.rotZ,
			this.position[0], this.position[1], this.position[2]);

		this.aabb.reset();
		for (const mesh of this.meshes){
			this.aabb.union(this.aabb, mesh.aabb);
		}
		this.aabb.transform(this.aabb, this.modelMatrix);
	}

	doUpdate(dt : number, frustum : Frustum){
		const visible = frustum.contains(this.aabb);
		if (this.update && (visible || this.alwaysUpdate))
			this.update(dt);
		return visible;
	}
	
	populateInstanceBlock(uniformData : Float32Array, uniformOffset : number){
		uniformOffset += fillMatrix4x3(uniformData, uniformOffset, this.modelMatrix);
		uniformOffset += fillColor(uniformData, uniformOffset, this.colour);
		return 4*3+4;
	}

	update?(dt : number):void;
}


export class AnimatedEntity extends Entity{
	animationController : AnimationController;

	constructor(mesh : AnimatedObject, position : vec3, rotation : number | null, scale : number, startAnim : number, pushUp : boolean = false){
		super(mesh.meshes, position, rotation, scale, pushUp);
		this.animationController = new AnimationController(mesh.animationData);
		this.animationController.currentAnimation = startAnim;
		this.animationController.setRandomTime();
	}

	override update(dt : number) : void {
		this.animationController.update(dt);
		// todo: update bbox?
	}

	setAnimation(animationIndex : number, animationSpeed : number){
		this.animationController.setAnimation(animationIndex, animationSpeed);
	}

	override populateInstanceBlock(uniformData : Float32Array, uniformOffset : number){
		const initialOffset = super.populateInstanceBlock(uniformData, uniformOffset);
		uniformOffset += initialOffset
		const bones = this.animationController.boneTransforms;
		for (let i = 0; i < bones.length; ++i){
			uniformOffset += fillMatrix4x3(uniformData, uniformOffset, bones[i]);
		}
		return initialOffset + bones.length*4*3;
	}

	debugDrawSkeleton(clipFromWorldMatrix : mat4){
		
		const boneParentIDs = this.animationController.animation.boneParentIDs;
		const transforms = this.animationController.boneTransforms;
		const c = getDebugOverlayCanvas2D();
		const p1 : vec3 = [0,0,0];
		const p2 : vec3 = [0,0,0];

		for (let i = 0; i < boneParentIDs.length; ++i){
			const parentIndex = boneParentIDs[i];
			if (parentIndex < 0)
				continue;
			
			mat4.getTranslation(p1, transforms[i]);
			vec3.transformMat4(p1, p1, this.modelMatrix);

			mat4.getTranslation(p2, transforms[parentIndex]);
			vec3.transformMat4(p2, p2, this.modelMatrix);

			drawWorldSpaceLine(c, clipFromWorldMatrix, p1, p2);
		}
	}
}
