import * as Viewer from '../viewer';

import { mat4, vec3 } from "gl-matrix";
import { AABB, Frustum } from "../Geometry";
import { GfxColor, GfxDevice } from "../gfx/platform/GfxPlatform";
import { GfxRenderInstManager } from "../gfx/render/GfxRenderInstManager";
import { computeModelMatrixSRT, MathConstants } from "../MathHelpers";
import { assert } from "../util";

import { AnimatedObject, Cache, StaticObject } from "./renderer";
import { AnimationController, calculateSingleAnimationTransform } from "./skeleton";
import { TerrainInfo } from "./terrain";


export type Assets<MeshType, SkeletonType, TerrainType, TerrainInfoType=TerrainInfo> = {
	models : {
		[name : string] : MeshType[][]
	}
	skeletons : {
		[name : string] : SkeletonType
	}
	terrain : TerrainType
	terrainInfo? : TerrainInfoType
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

// nothing | delete this | spawn new entity
export type EntityUpdateResult = void | false | Entity;

export class Entity {
	meshes : StaticObject[];
	position: vec3;
	rotX = 0;
	rotation: number;
	rotZ = 0;
	scale: vec3;
	modelMatrix : mat4 = mat4.create();
	baseAABB : AABB = new AABB(); // before modelMatrix transform
	aabb : AABB = new AABB(); // after modelMatrix transform
	opacity = 1;
	alwaysUpdate = false;
	isDynamic = false;
	
	viewDistance = 0; // set by the renderer each frame

	constructor(meshes : StaticObject | StaticObject[], position : vec3, rotation : number | null, scale : number, pushUp : boolean = false){
		if (!Array.isArray(meshes)){
			assert(meshes != undefined, "invalid mesh for entity");
			meshes = [meshes];
		}
		this.meshes = meshes;

		for (const mesh of this.meshes)
			this.baseAABB.union(this.baseAABB, mesh.aabb);

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

		this.aabb.transform(this.baseAABB, this.modelMatrix);
	}
	
	update?(dt : number) : EntityUpdateResult;
}


export class AnimatedEntity extends Entity{
	animationController : AnimationController;
	animatedObject : AnimatedObject;

	constructor(anim : AnimatedObject, position : vec3, rotation : number | null, scale : number, startAnim : number, pushUp : boolean = false){
		super(anim.meshes, position, rotation, scale, pushUp);

		this.animatedObject = anim;
		this.animationController = new AnimationController(anim.animationData);
		this.setAnimation(startAnim, 1);
		this.animationController.setRandomTime();
	}

	override update(dt : number) : void {
		this.animationController.updateTime(dt);
	}

	setAnimation(animationIndex : number, animationSpeed : number){
		this.animationController.setAnimation(animationIndex, animationSpeed);

		// todo: may not exist if the animation hasn't been set up yet
		this.baseAABB = this.animationController.animation.anims[animationIndex].aabb;
		this.aabb.transform(this.baseAABB, this.modelMatrix);
	}

	static scratchTransform  = mat4.create();
	getBoneTransform(boneIndex : number) : mat4{
		return calculateSingleAnimationTransform(AnimatedEntity.scratchTransform, this.animationController.animation, this.animationController.currentAnimationIndex, boneIndex, this.animationController.t);
	}
}
