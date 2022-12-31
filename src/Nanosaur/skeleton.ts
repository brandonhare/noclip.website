import { Qd3DMesh } from "./QuickDraw3D";
import { assert, readString } from "../util";
import { ResourceFork } from "./AppleDouble";
import { vec3 } from "gl-matrix";
import { Endianness } from "../endian";


export type AnimationData = {
};

export class AnimationController {
	constructor(private animation : AnimationData){
	}

	update(dt : number){
	}
}

export type SkeletalMesh = {
	meshes : Qd3DMesh[];
	animation : AnimationData;
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

	const header = skeletonData.get("Hedr")?.get(1000);
	assert(header !== undefined);
	let data = header.createDataView();
	assert(data.getUint16(0) === 0x0110, "invalid skeleton version number");
	const numAnims = data.getUint16(2);
	const numJoints = data.getUint16(4);
	//const num3DMFLimbs = data.getUint16(6);

	type PointRef = {
		x : number,
		y : number,
		z : number,
		meshRefs : number[],
		pointRefs : number[],
		normalRefs : number[],
	};

	function close(x : number, y : number, delta : number){
		return Math.abs(x - y) < delta;
	}

	// decompose trimesh
	const decomposedPointList : PointRef[] = [];
	const decomposedNormalList : vec3[] = [];
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
					normalRefs:[],
				};
				decomposedPointList.push(ref);
			}

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
		}
	}
	const numDecomposedPoints = decomposedPointList.length;
	const numDecomposedNormals = decomposedNormalList.length;
	

	type Bone = {
		//parent : number,
		children : number[],
		name : string,
		pos : vec3,
		pointList : Uint16Array,
		normalList : Uint16Array,
		keyframes : any[],
	};

	const bones : Bone[] = new Array(numJoints);
	for (let i = 0; i < numJoints; ++i){
		const bone = skeletonData.get("Bone")?.get(1000 + i);
		assert(bone !== undefined);
		const data = bone.createDataView();
		
		const parent = data.getInt32(0);
		const nameLength = data.getUint8(4);
		const name = readString(bone, 5, Math.min(32, nameLength), false);
		const pos = readVec3(data, 36);
		const numPointsAttachedToBone = data.getInt16(48);
		const numNormalsAttachedToBone = data.getInt16(50);

		const pointList = skeletonData.get("BonP")?.get(1000 + i)?.createTypedArray(Uint16Array, 0, numPointsAttachedToBone, Endianness.BIG_ENDIAN);
		const normalList = skeletonData.get("BonN")?.get(1000 + i)?.createTypedArray(Uint16Array, 0, numNormalsAttachedToBone, Endianness.BIG_ENDIAN);
		assert(pointList !== undefined && normalList !== undefined);

		if (parent >= 0 && parent < i){
			bones[parent].children.push(i);
		} else assert(parent === -1);

		bones[i] = {
			//parent,
			children : [],
			name,
			pos,
			pointList,
			normalList,
			keyframes : new Array(numAnims),
		};
	}


	const relativePointOffsets = skeletonData.get("RelP")?.get(1000)?.createTypedArray(Float32Array, 0, undefined, Endianness.BIG_ENDIAN);
	assert(relativePointOffsets !== undefined);
	assert(relativePointOffsets.length === numDecomposedPoints * 3, `${relativePointOffsets.length} ${numDecomposedPoints*3} ${
		models.reduce((sum,model)=>sum+model.numVertices,0)*3
	} ${models.reduce((sum,model)=>sum+model.vertices.length,0)}`);

	type AnimEvent = { time : number, type : number, value : number};
	type Anim = {
		name : string,
		events : AnimEvent[],
	};
	const anims = new Array<Anim>(numAnims);

	for (let i = 0; i < numAnims; ++i){
		const animHeader = skeletonData.get("AnHd")?.get(1000+i);
		assert(animHeader !== undefined);
		const headerData = animHeader.createDataView();

		const animName = readString(animHeader, 1, Math.min(32, headerData.getUint8(0)), false);
		const numEvents = headerData.getUint16(34);

		const eventArray = new Array<AnimEvent>(numEvents);

		const anim = {
			name : animName,
			events : eventArray
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
		for (let j = 0; j < numJoints; ++j){
			const numKeyframes = keyframeCountData.getUint8(j);
			const keyframes = new Array(numKeyframes);
			bones[j].keyframes[i] = keyframes;

			const keyframeData = skeletonData.get("KeyF")?.get(1000 + (i * 100) + j)?.createDataView();
			assert(keyframeData !== undefined);
			for (let k = 0; k < numKeyframes; ++k){
				keyframes[k] = {
					tick : keyframeData.getInt32(k * 44 + 0),
					accelerationMode : keyframeData.getInt32(k * 44 + 4),
					coord : readVec3(keyframeData, k * 44 + 8),
					rotation : readVec3(keyframeData, k * 44 + 20),
					scale : readVec3(keyframeData, k * 44 + 32),
				};
			}
		}
		
	}

	// todo: process data to create mesh weights buffer

	return {
		meshes : models,
		animation : {
			bones,
			relativePointOffsets,
			decomposedPointList,
			decomposedNormalList,
			anims,
		},
	};
}
