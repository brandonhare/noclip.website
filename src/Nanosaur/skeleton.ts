import { Qd3DMesh } from "./QuickDraw3D";
import { assert, readString } from "../util";
import { ResourceFork } from "./AppleDouble";
import { mat4, quat, vec3 } from "gl-matrix";
import { Endianness } from "../endian";
import { clamp, invlerp, quatFromEulerRadians } from "../MathHelpers";



export type SkeletalMesh = {
	meshes : Qd3DMesh[];
	animation : AnimationData;
};

export type AnimationData = {
	numBones : number,
	numAnims : number,
	bones : Bone[],
	//relativePointOffsets : Float32Array,
	//decomposedPointList : PointRef[],
	//decomposedNormalList : vec3[],
	anims : Anim[],
};

export enum AnimEventType {
	Stop,
	Loop,
	ZigZag,
	GotoMarker,
	SetMarker,
	PlaySound,
	SetFlag,
	ClearFlag,
};

export type AnimEvent = {
	time : number,
	type : AnimEventType,
	value : number
};

export const enum AccelerationMode {
	Linear,
	EaseInOut,
	EaseIn,
	EaseOut
}
export type AnimKeyframe = {
	tick : number,
	accelerationMode : AccelerationMode,
	coord : vec3,
	rotation: vec3,
	scale : vec3
};
export type Anim = {
	name : string,
	events : AnimEvent[],
	keyframes : AnimKeyframe[][], // [bone][keyframe]
};

type Bone = {
	parent : number,
	//children : number[],
	//name : string,
	pos : vec3,
	//pointList : Uint16Array,
	//normalList : Uint16Array,
};

function readVec3(view : DataView, offset : number) : vec3{
	return [
		view.getFloat32(offset),
		view.getFloat32(offset + 4),
		view.getFloat32(offset + 8)
	];
}

export function parseSkeleton(modelGroup : Qd3DMesh[][], skeletonData : ResourceFork) : SkeletalMesh {

	assert(modelGroup.every((a)=>a.length === 1));
	const models = modelGroup.flat();
	
	for (const model of models){
		model.boneIds = new Uint8Array(model.numVertices);
	}

	const header = skeletonData.get("Hedr")?.get(1000);
	assert(header !== undefined);
	let data = header.createDataView();
	assert(data.getUint16(0) === 0x0110, "invalid skeleton version number");
	const numAnims = data.getUint16(2);
	const numJoints = data.getUint16(4);
	//const num3DMFLimbs = data.getUint16(6);


	function close(x : number, y : number, delta : number){
		return Math.abs(x - y) < delta;
	}

	// decompose trimesh
	type PointRef = {
		x : number,
		y : number,
		z : number,
		meshRefs : number[],
		pointRefs : number[],
		//normalRefs : number[],
	};
	const decomposedPointList : PointRef[] = [];
	//const decomposedNormalList : vec3[] = [];
	for (let meshIndex = 0; meshIndex < models.length; ++meshIndex){
		const model = models[meshIndex];
		assert(model.normals !== undefined);
		for (let pointIndex = 0; pointIndex < model.numVertices; ++pointIndex){
			const x = model.vertices[pointIndex * 3];
			const y = model.vertices[pointIndex * 3 + 1];
			const z = model.vertices[pointIndex * 3 + 2];
			// check if this point has been seen
			let ref : PointRef | undefined = undefined;
			for (const existingRef of decomposedPointList){
				if (close(x, existingRef.x, 0.001) && close(y, existingRef.y, 0.001) && close(z, existingRef.z, 0.001)){
					ref = existingRef;
					ref.meshRefs.push(meshIndex);
					ref.pointRefs.push(pointIndex);
					break;
				}
			}
			if (ref === undefined){
				ref = {
					x,y,z,
					meshRefs:[meshIndex],
					pointRefs:[pointIndex],
					//normalRefs:[],
				};
				decomposedPointList.push(ref);
			}

			/*
			// check normals
			const nx = model.normals[pointIndex * 3];
			const ny = model.normals[pointIndex * 3 + 1];
			const nz = model.normals[pointIndex * 3 + 2];
			let seenNormal = false;
			for (let decomposedNormalIndex = 0; decomposedNormalIndex < decomposedNormalList.length; ++decomposedNormalIndex){
				const dNormal = decomposedNormalList[decomposedNormalIndex];
				if (close(nx, dNormal[0], 0.02) && close(ny, dNormal[1], 0.02) && close(nz, dNormal[2], 0.02)){
					seenNormal = true;
					ref.normalRefs.push(decomposedNormalIndex);
					break;
				}
			}
			if (!seenNormal){
				ref.normalRefs.push(decomposedNormalList.length);
				decomposedNormalList.push([nx,ny,nz]);
			}
			*/
		}
	}
	const numDecomposedPoints = decomposedPointList.length;
	//const numDecomposedNormals = decomposedNormalList.length;
	
	const relativePointOffsets = skeletonData.get("RelP")?.get(1000)?.createTypedArray(Float32Array, 0, undefined, Endianness.BIG_ENDIAN);
	assert(relativePointOffsets !== undefined);
	assert(relativePointOffsets.length === numDecomposedPoints * 3);

	const bones : Bone[] = new Array(numJoints);
	for (let boneIndex = 0; boneIndex < numJoints; ++boneIndex){
		const bone = skeletonData.get("Bone")?.get(1000 + boneIndex);
		assert(bone !== undefined);
		const data = bone.createDataView();
		
		const parent = data.getInt32(0);
		//const nameLength = data.getUint8(4);
		//const name = readString(bone, 5, Math.min(32, nameLength), false);
		const pos = readVec3(data, 36);
		const numPointsAttachedToBone = data.getInt16(48);
		//const numNormalsAttachedToBone = data.getInt16(50);

		const pointList = skeletonData.get("BonP")?.get(1000 + boneIndex)?.createTypedArray(Uint16Array, 0, numPointsAttachedToBone, Endianness.BIG_ENDIAN);
		//const normalList = skeletonData.get("BonN")?.get(1000 + i)?.createTypedArray(Uint16Array, 0, numNormalsAttachedToBone, Endianness.BIG_ENDIAN);
		assert(pointList !== undefined);
		//assert(normalList !== undefined);

		/*
		if (parent >= 0 && parent < boneIndex){
			bones[parent].children.push(boneIndex);
		} else assert(parent === -1);
		*/

		bones[boneIndex] = {
			parent,
			//children : [],
			//name,
			pos,
			//pointList,
			//normalList,
		};

		// update mesh offsets and fill out bone attribute array
		for (const pointId of pointList){
			const point = decomposedPointList[pointId];
			const numRefs = point.pointRefs.length;
			assert(point.meshRefs.length === numRefs);
			//assert(point.normalRefs.length === numRefs);
			for (let refIndex = 0; refIndex < numRefs; ++refIndex){
				const mesh = models[point.meshRefs[refIndex]];
				const pointIndex = point.pointRefs[refIndex];
				//const normalIndex = point.normalRefs[i];

				mesh.boneIds![pointIndex] = boneIndex;
				
				mesh.vertices[pointIndex * 3] = relativePointOffsets[pointId * 3];
				mesh.vertices[pointIndex * 3 + 1] = relativePointOffsets[pointId * 3 + 1];
				mesh.vertices[pointIndex * 3 + 2] = relativePointOffsets[pointId * 3 + 2];
			}
		}
	}

	const anims = new Array<Anim>(numAnims);

	for (let i = 0; i < numAnims; ++i){
		const animHeader = skeletonData.get("AnHd")?.get(1000+i);
		assert(animHeader !== undefined);
		const headerData = animHeader.createDataView();

		const animName = readString(animHeader, 1, Math.min(32, headerData.getUint8(0)), false);
		const numEvents = headerData.getUint16(34);

		const eventArray = new Array<AnimEvent>(numEvents);

		const keyframeArray : AnimKeyframe[][] = new Array(numJoints);

		const anim = {
			name : animName,
			events : eventArray,
			keyframes : keyframeArray,
		};
		anims[i] = anim;

		// get events
		const events = skeletonData.get("Evnt")?.get(1000 + i)?.createDataView();
		assert(events !== undefined);
		for (let j = 0; j < numEvents; ++j){
			const time = events.getUint16(j * 4);
			const type = events.getUint8(j * 4 + 2);
			const value = events.getUint8(j * 4 + 3);
			eventArray[j] = {time, type, value};
		}


		// get keyframes
		const keyframeCountData = skeletonData.get("NumK")?.get(1000+i)?.createDataView();
		assert(keyframeCountData !== undefined);
		for (let boneIndex = 0; boneIndex < numJoints; ++boneIndex){
			const numKeyframes = keyframeCountData.getUint8(boneIndex);
			const keyframes = new Array<AnimKeyframe>(numKeyframes);
			keyframeArray[boneIndex] = keyframes;

			const keyframeData = skeletonData.get("KeyF")?.get(1000 + (i * 100) + boneIndex)?.createDataView();
			assert(keyframeData !== undefined);
			for (let keyframeIndex = 0; keyframeIndex < numKeyframes; ++keyframeIndex){
				keyframes[keyframeIndex] = {
					tick : keyframeData.getInt32(keyframeIndex * 44 + 0),
					accelerationMode : keyframeData.getInt32(keyframeIndex * 44 + 4),
					coord : readVec3(keyframeData, keyframeIndex * 44 + 8),
					rotation : readVec3(keyframeData, keyframeIndex * 44 + 20),
					scale : readVec3(keyframeData, keyframeIndex * 44 + 32),
				};
			}
		}
		
	}

	return {
		meshes : models,
		animation : {
			numBones : numJoints,
			numAnims,
			bones,
			//relativePointOffsets,
			//decomposedPointList,
			//decomposedNormalList,
			anims,
		},
	};
}



export class AnimationController {
	animation : AnimationData;
	boneTransforms : mat4[];

	currentAnimation = 0;
	t = 0;
	animSpeed = 1;
	loopbackTime = 0;
	animDirection = 1; // 1 or -1
	zigzag = false;
	running = true;

	constructor(animation : AnimationData){
		this.animation = animation;
		this.boneTransforms = new Array(animation.numBones);
		for (let i = 0; i < animation.numBones; ++i){
			this.boneTransforms[i] = mat4.fromTranslation(mat4.create(), animation.bones[i].pos);
		}
	}

	setAnimation(index : number, speed : number){
		assert(index < this.animation.numAnims, "animation out of range");
		this.currentAnimation = index;
		this.t = 0;
		this.animSpeed = speed;
		this.loopbackTime = 0;
		this.animDirection = 1;
		this.zigzag = false;
		this.running = true;
	}

	setRandomTime(){
		for (const event of this.animation.anims[this.currentAnimation].events){
			if (event.type === AnimEventType.Loop || event.type === AnimEventType.ZigZag){
				this.t = Math.random() * event.time;
				if (event.type === AnimEventType.ZigZag && Math.random() >= 0.5){
					this.animDirection = -1;
					this.zigzag = true;
				}
				return;
			}
		}
	}

	update(dt : number){
		if (!this.running){
			return;
		}

		const prevT = this.t;
		this.t += dt * 30 * this.animSpeed * this.animDirection;
		const anim = this.animation.anims[this.currentAnimation];

		if (this.animDirection < 0 && this.t < this.loopbackTime){
			this.t = 2 * this.loopbackTime - this.t;
			if (this.zigzag){
				this.animDirection = 1;
			} else {
				this.running = false;
				// fall through to animate this frame
			}
		}

		// process animation events
		// todo: breaks on high dt
		for (const event of anim.events){
			if (event.time > this.t)
				break;
			if (prevT > event.time)
				continue;
			switch(event.type){
				case AnimEventType.Stop:
					this.running = false;
					break;
				case AnimEventType.SetMarker:
					this.loopbackTime = event.time;
					break;
				case AnimEventType.Loop:
					if (this.loopbackTime !== 0){
						this.t += this.loopbackTime - event.time;
					} else {
						if (this.t !== 0){
							this.t -= event.time;
						} else {
							this.running = false;
						}
					}
					break;
				case AnimEventType.ZigZag:
					this.animDirection = -1;
					this.t -= event.time - this.t;
					this.zigzag = true;
					break;
			}
		}

		// apply keyframes
		const rot : quat = [0,0,0,0];
		for (let boneIndex = 0; boneIndex < this.animation.numBones; ++boneIndex){
			const myKeyframes = anim.keyframes[boneIndex];
			const myBoneMatrix = this.boneTransforms[boneIndex];
			if (myKeyframes.length === 0){
				mat4.fromTranslation(myBoneMatrix, this.animation.bones[boneIndex].pos);
				continue;
			}


			let currentKeyframe = myKeyframes[myKeyframes.length - 1];
			for (let i = 0; i < myKeyframes.length; ++i){
				const keyframe = myKeyframes[i];
				if (keyframe.tick >= this.t){
					if (i > 0)
						currentKeyframe = interpolateKeyframe(keyframe, myKeyframes[i-1], this.t);
					else
						currentKeyframe = keyframe;
					break;
				}
			}

			quatFromEulerRadians(rot, currentKeyframe.rotation[0], currentKeyframe.rotation[1], currentKeyframe.rotation[2]);
			mat4.fromRotationTranslationScale(
				myBoneMatrix,
				rot,
				currentKeyframe.coord,
				currentKeyframe.scale
			);
		
			const parentIndex = this.animation.bones[boneIndex].parent;
			if (parentIndex >= 0)
				mat4.mul(myBoneMatrix, this.boneTransforms[parentIndex], myBoneMatrix);

		}
	}
}


function accelerationCurve(t : number) : number{
	return t * t * (3 - 2 * t);
}
const dummyKeyframe : AnimKeyframe = {
	tick : 0, // unused
	accelerationMode : AccelerationMode.Linear, // unused
	coord : [0,0,0],
	rotation : [0,0,0],
	scale : [0,0,0],
};
function interpolateKeyframe(from : AnimKeyframe, to : AnimKeyframe, t : number) : AnimKeyframe{
	let t1 = clamp(invlerp(from.tick, to.tick, t), 0, 1);

	switch(from.accelerationMode){
		case AccelerationMode.EaseInOut:
			t1 = accelerationCurve(t1);
			break;
		case AccelerationMode.EaseIn:
			t1 = 2 * accelerationCurve(t1 * 0.5);
			break;
		case AccelerationMode.EaseOut:
			t1 = 1 - 2 * accelerationCurve((1 - t1) * 0.5);
			break;
	}

	vec3.lerp(dummyKeyframe.coord, from.coord, to.coord, t1);
	vec3.lerp(dummyKeyframe.rotation, from.rotation, to.rotation, t1);
	vec3.lerp(dummyKeyframe.scale, from.scale, to.scale, t1);
	
	return dummyKeyframe;
}
