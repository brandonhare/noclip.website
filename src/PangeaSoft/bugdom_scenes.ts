import * as Viewer from '../viewer';

import { vec4 } from "gl-matrix";
import { colorScale } from "../Color";
import { GfxDevice, GfxFormat, GfxFrontFaceMode, GfxWrapMode } from "../gfx/platform/GfxPlatform";
import { SceneContext } from "../SceneBase";

import { parseAppleDouble } from "./AppleDouble";
import { BugdomLevelType, BugdomModelFriendlyNames, BugdomProcessedAssets, ModelSetNames, SkeletonNames, spawnBugdomEntity } from "./bugdom_entities";
import { parseBugdomTerrain, ParsedBugdomTerrain } from "./bugdom_terrain";
import { Assets, Entity, getFriendlyName, LevelObjectDef } from "./entity";
import { AlphaType, parseQd3DMeshGroup, Qd3DMesh, Qd3DTexture } from "./QuickDraw3D";
import { AnimatedObject, Cache, RenderFlags, SceneRenderer, SceneSettings, StaticObject } from "./renderer";
import { parseSkeleton, SkeletalMesh } from "./skeleton";
import { loadTextureFromTGA, TGATexture } from "./TGA";
import { assert, assertExists } from "../util";
import ArrayBufferSlice from "../ArrayBufferSlice";

const pathBase = "bugdom";



export type BugdomRawAssets = Assets<Qd3DMesh, SkeletalMesh, ParsedBugdomTerrain|undefined>;

export class BugdomSceneRenderer extends SceneRenderer {

	processedAssets : BugdomProcessedAssets = {models : {}, skeletons : {}, terrain : [], levelType : BugdomLevelType.Lawn };

	constructor(device : GfxDevice, context : SceneContext, assets : BugdomRawAssets, objectList : LevelObjectDef[], sceneSettings : SceneSettings, levelType : BugdomLevelType){
		super(device, context, sceneSettings);

		this.createModels(device, this.cache, assets);
		this.processedAssets.levelType = levelType;

		const entities : Entity[] = [];

		// create terrain entities
		for (let i = 0; i < this.processedAssets.terrain.length; ++i){
			const terrainMesh = this.processedAssets.terrain[i];
			const terrainInfo = this.processedAssets.terrainInfo![i];
			const terrainEntity = new Entity([terrainMesh], [0,0,0],0,1,false);
			terrainEntity.scale[0] = terrainInfo.xzScale;
			terrainEntity.scale[1] = terrainInfo.yScale;
			terrainEntity.scale[2] = terrainInfo.xzScale;
			terrainEntity.updateMatrix();
			entities.push(terrainEntity);
		}
		// create fences
		const fences = assets.terrain?.fences;
		if (fences){
			for (let i = 0; i < fences.length; ++i){
				const fenceEntity = new Entity(this.processedAssets.models.fences[i], [0,0,0], 0, 1, false);
				entities.push(fenceEntity);
			}
		}

		// create entities
		for (const objectDef of objectList){
			const entity = spawnBugdomEntity(objectDef, this.processedAssets);
			if (entity){
				if (Array.isArray(entity))
					entities.push(...entity);
				else
					entities.push(entity);
			}
		}

		// finish up
		this.initEntities(device, entities);
	}
	
	createModels(device : GfxDevice, cache : Cache, rawAssets : BugdomRawAssets){

		this.processedAssets = {
			models : {},
			skeletons : {},
			terrain : [],
			levelType : BugdomLevelType.Lawn,
			terrainInfo : rawAssets.terrain?.infos ?? [],
		}

		if (rawAssets.terrain){
			this.processedAssets.terrain = rawAssets.terrain.meshes.map((mesh)=>
				new StaticObject(device, cache, mesh, "Terrain")
			);
			// create fences
			this.processedAssets.models.fences = rawAssets.terrain.fences.map((fence)=>{
				const fenceMesh = new StaticObject(device, cache, fence, "Fence");
				fenceMesh.renderFlags |= RenderFlags.KeepBackfaces;
				return [fenceMesh];
			});
		}
		
		for (const modelSetName of Object.keys(rawAssets.models)){
			const modelSet = rawAssets.models[modelSetName];
			this.processedAssets.models[modelSetName] = modelSet.map((meshes, index)=>
				meshes.map((mesh, index2)=>
					new StaticObject(device, cache, mesh, getFriendlyName(BugdomModelFriendlyNames, modelSetName, index, index2))
				)
			);
		}
		for (const skeletonName of Object.keys(rawAssets.skeletons)){
			const skeleton = rawAssets.skeletons[skeletonName];
			this.processedAssets.skeletons[skeletonName] = new AnimatedObject(device, cache, skeleton, BugdomModelFriendlyNames, skeletonName);
		}


		if (cache.onnewtextures)
			cache.onnewtextures();
	}
}


function createFenceTexture(data : ArrayBufferSlice) : Qd3DTexture{
	const tex = loadTextureFromTGA(data);
	if (tex.pixelFormat === GfxFormat.U16_RGB_565){
		const count = tex.width * tex.height;
		for (let i = 0; i < count; ++i){
			let pixel = tex.pixels[i];

			// drop the lsb of the green channel and shift blue over
			let destPixel = (pixel & 0xFFC0) | ((pixel << 1) & 0x3E);
			// set alpha
			if (destPixel) destPixel |= 1;

			destPixel = pixel;

			tex.pixels[i] = destPixel;
		}
		// todo: dont drop green bit
	} else {
		assert(false, "Invalid pixel format");
	}
	/*
	const packed = tex.pixelFormat === GfxFormat.U16_RGB_565;
	assert(packed || tex.pixelFormat === GfxFormat.U8_RGB_NORM, "Invalid input format " + GfxFormat[tex.pixelFormat]);
	const pixels = new Uint8Array(tex.width * tex.height * 4);
	const destStride = tex.width * 4;
	// make black pixels transparent
	if (packed){
		const srcStride = tex.width;
		for (let row = 0; row < tex.height; ++row){
			for (let col = 0; col < tex.width; ++col){
				const value = tex.pixels[row * srcStride + col];

			}
		}
		console.log(tex);
	} else {
		const srcStride = tex.width * 3;
		for (let row = 0; row < tex.height; ++row){
			for (let col = 0; col < tex.width; ++col){
				let sum = 0;
				for (let k = 0; k < 3; ++k){
					const value = tex.pixels[row * srcStride + col * 3 + k];
					sum += value;
					pixels[row * destStride + col * 4 + k] = value;
				}
				pixels[row * destStride + col * 4 + 3] = sum ? 255 : 0;
			}
		}
	}*/
	const result : Qd3DTexture = {
		...tex,
		pixelFormat : GfxFormat.U16_RGBA_5551,
		alpha : AlphaType.OneBitAlpha,
		numTextures : 1,
		wrapU : GfxWrapMode.Repeat,
		wrapV : GfxWrapMode.Clamp,
	};
	return result
}

class BugdomSceneDesc implements Viewer.SceneDesc {
	id : string;
	name : string;
	def : BugdomLevelTypeDef;
	sceneIndex : number;

	constructor(def : BugdomLevelTypeDef, sceneIndex : number){
		const {id, name} = def.scenes[sceneIndex];
		this.id = id;
		this.name = name;
		this.def = def;
		this.sceneIndex = sceneIndex;
	}

	public async createScene(device: GfxDevice, context: SceneContext): Promise<BugdomSceneRenderer> {
		const scene = this.def.scenes[this.sceneIndex];

		const modelPromises = Promise.all(this.def.models.map((modelName)=>
			context.dataFetcher.fetchData(`${pathBase}/Models/${modelName}.3dmf`)
				.then(parseQd3DMeshGroup)
		));
		const skeletonPromises = Promise.all(this.def.skeletons?.map((skeletonName)=>
			Promise.all([
				context.dataFetcher.fetchData(`${pathBase}/Skeletons/${skeletonName}.3dmf`)
					.then(parseQd3DMeshGroup),
				context.dataFetcher.fetchData(`${pathBase}/Skeletons/${skeletonName}.skeleton.rsrc`)
					.then(parseAppleDouble),
			]).then(([model, skeletonData])=>parseSkeleton(model, skeletonData))
		) ?? []);

		const fenceTexturesTypeArray = new Array<number|undefined>(9);
		for (const type of this.def.fenceTextureIds)
			fenceTexturesTypeArray[type] = type;

		const fenceTexturePromises = Promise.all(fenceTexturesTypeArray.map((type)=>
			(type !== undefined) ? context.dataFetcher.fetchData(`${pathBase}/Images/Textures/${type+2000}.tga`)
					.then(createFenceTexture)
				: undefined
		));

		const terrainPromise = scene.terrain
			? context.dataFetcher.fetchData(`${pathBase}/Terrain/${scene.terrain}.ter.rsrc`)
				.then((data)=>parseBugdomTerrain(parseAppleDouble(data), this.def.hasCeiling))
			: {items:[], meshes:[], splines:[], fences:[], infos:[]};

		const models = await modelPromises;
		const skeletons = await skeletonPromises;
		const terrain : ParsedBugdomTerrain = await terrainPromise;
		
		const fenceTextures = await fenceTexturePromises;
		// fixup terrain fence textures
		for (const fence of terrain.fences){
			fence.texture = assertExists(fenceTextures[fence.type], "missing fence texture " + fence.type);
		}

		let objects : LevelObjectDef[] = terrain.items;

		if (scene.objects){
			let objArray;
			if (Array.isArray(scene.objects))
				objArray = scene.objects;
			else
				objArray = scene.objects();
			objects = [...objects, ...objArray];
		}

		const rawAssets : BugdomRawAssets = {
			models : {},
			skeletons : {},
			terrain,
		};
		for (let i = 0; i < (this.def.models?.length ?? 0); ++i){
			const name = this.def.models![i];
			rawAssets.models[name] = models[i];
		}
		for (let i = 0; i < (this.def.skeletons?.length ?? 0); ++i){
			const name = this.def.skeletons![i];
			rawAssets.skeletons[name] = skeletons[i];
		}

		return new BugdomSceneRenderer(device, context, rawAssets, objects, this.def.settings, this.def.type);
	}
}


type BugdomSceneDef = {
	id : string,
	name : string,
	terrain? : string,
	objects? : LevelObjectDef[] | (()=>LevelObjectDef[]),
};

type BugdomLevelTypeDef = {
	type : BugdomLevelType,
	hasCeiling : boolean,
	fenceTextureIds : number[],
	models : (typeof ModelSetNames[number])[],
	skeletons : (typeof SkeletonNames[number])[],
	scenes : BugdomSceneDef[],
	settings : SceneSettings,
};
const bugdomSceneDefs : BugdomLevelTypeDef[] = [
	{ // lawn
		type : BugdomLevelType.Lawn,
		hasCeiling : false,
		fenceTextureIds : [0,2],
		models : ["Lawn_Models1", "Lawn_Models2"],
		skeletons : ["BoxerFly", "Slug", "Ant"],
		scenes : [
			{ id : "training", name : "Training", terrain : "Training" },
			{ id : "lawn", name : "Lawn", terrain : "Lawn" }
		],
		settings : {
			ambientColour : { r : 1, g : 1, b : 0.9, a : 1},
			lightColours : [{ r : 1, g : 1, b : 0.6, a : 1}, {r : 1, g : 1, b : 1, a : 1}],
			lightDirs : [[0.4, -0.35, 1, 0], [-0.2, -0.7, -0.1, 0]],
			clearColour : {r : 0.352, g : 0.380, b : 1, a: 1},
			fogColour : { r : 0.05, g : 0.25, b : 0.05, a : 1},
			showFog : false, // todo
		}
	}, { // pond
		type : BugdomLevelType.Pond,
		hasCeiling : false,
		fenceTextureIds : [2,5],
		models : ["Pond_Models"],
		skeletons : ["Mosquito", "WaterBug", "PondFish", "Skippy", "Slug"],
		scenes : [{ id : "pond", name : "Pond", terrain : "Pond" }],
		settings : {
			ambientColour : { r : 1, g : 1, b : 0.9, a : 1},
			lightColours : [{ r : 1, g : 1, b : 0.6, a : 1}, {r : 1, g : 1, b : 1, a : 1}],
			lightDirs : [[0.4, -0.45, 1, 0], [-0.2, -0.7, -0.1, 0]],
			clearColour : { r : 0.9, g : 0.9, b : 0.85, a : 1},
			fogColour : { r : 0.9, g : 0.9, b : 0.85, a : 1},
			showFog : false, // todo
		}
	}, { // forest
		type : BugdomLevelType.Forest,
		hasCeiling : false,
		fenceTextureIds : [1,3,7],
		models : ["Forest_Models"],
		skeletons : ["DragonFly", "Foot", "Spider", "Caterpillar", "Bat", "FlyingBee", "Ant"],
		scenes : [
			{ id : "beach", name : "Beach", terrain : "Beach" },
			{ id : "flight", name : "Flight", terrain : "Flight" },
		],
		settings : {
			ambientColour : { r : 1, g : 0.6, b : 0.3, a : 1},
			lightColours : [{ r : 1, g : 0.8, b : 0.3, a : 1}, {r : 1, g : 0.9, b : 0.3, a : 1}],
			lightDirs : [[0.4, -0.15, 1, 0], [-0.2, -0.7, -0.1, 0]],
			clearColour : { r : 1, g : 0.29, b : 0.063, a : 1},
			fogColour : { r : 1, g : 0.29, b : 0.063, a : 1},
			showFog : false, // todo
		}
	}, { // hive
		type : BugdomLevelType.Hive,
		hasCeiling : true,
		fenceTextureIds : [8],
		models : ["BeeHive_Models"],
		skeletons : ["Larva", "FlyingBee", "WorkerBee", "QueenBee"],
		scenes : [
			{ id : "beehive", name : "Beehive", terrain : "BeeHive" },
			{ id : "queenbee", name : "Queen Bee", terrain : "QueenBee" },
		],
		settings : {
			ambientColour : { r : 1, g : 1, b : 0.8, a : 1},
			lightColours : [{ r : 1, g : 1, b : 0.7, a : 1}, {r : 1, g : 1, b : 0.9, a : 1}],
			lightDirs : [[0.4, -0.35, 1, 0], [-0.8, 1, -0.2, 0]],
			clearColour : { r : 0.7, g : 0.6, b : 0.4, a : 1},
			fogColour : { r : 0.7, g : 0.6, b : 0.4, a : 1},
			showFog : false, // todo
		}
	}, { // night
		type : BugdomLevelType.Night,
		hasCeiling : false,
		fenceTextureIds : [4],
		models : ["Night_Models"],
		skeletons : ["WingedFireAnt", "FireFly", "Caterpillar", "Slug", "Roach", "Ant"],
		scenes : [{ id : "night", name : "Night", terrain : "Night" }],
		settings : {
			ambientColour : { r : 0.5, g : 0.5, b : 0.5, a : 1},
			lightColours : [{ r : 0.8, g : 1, b : 0.8, a : 1}, {r : 0.6, g : 0.8, b : 0.7, a : 1}],
			lightDirs : [[0.4, -0.35, 1, 0], [-0.2, -0.7, -0.1, 0]],
			clearColour : { r : 0.02, g : 0.02, b : 0.08, a : 1},
			fogColour : { r : 0.02, g : 0.02, b : 0.08, a : 1},
			showFog : false, // todo
		}
	}, { // anthill
		type : BugdomLevelType.Anthill,
		hasCeiling : true,
		fenceTextureIds : [6],
		models : ["AntHill_Models"],
		skeletons : ["AntKing", "Slug", "Ant", "WingedFireAnt", "RootSwing", "Roach"],
		scenes : [
			{ id : "anthill", name : "Anthill", terrain : "AntHill" },
			{ id : "antking", name : "Ant King", terrain : "AntKing" },
		],
		settings : {
			ambientColour : { r : 0.5, g : 0.5, b : 0.6, a : 1},
			lightColours : [{ r : 0.7, g : 0.7, b : 0.8, a : 1}, {r : 1, g : 1, b : 1, a : 1}],
			lightDirs : [[0.4, -0.35, 1, 0], [-0.8, 1, -0.2, 0]],
			clearColour : { r : 0.15, g : 0.07, b : 0.15, a : 1},
			fogColour : { r : 0.15, g : 0.07, b : 0.15, a : 1},
			showFog : false, // todo
		}
	}
]
for (const def of bugdomSceneDefs){
	def.models.push("Global_Models1", "Global_Models2");
	def.skeletons.push("DoodleBug", "LadyBug");
	for (const dir of def.settings.lightDirs){
		vec4.negate(dir, dir);
		vec4.normalize(dir, dir);
	}
	
	colorScale(def.settings.ambientColour, def.settings.ambientColour,0.2);
	colorScale(def.settings.lightColours[0], def.settings.lightColours[0], 1.1);
	colorScale(def.settings.lightColours[1], def.settings.lightColours[1], 0.5);
}


const sceneDescs = bugdomSceneDefs.flatMap((def) => def.scenes.map((scene, index)=>new BugdomSceneDesc(def, index)));
export const sceneGroup: Viewer.SceneGroup = { id : "bugdom", name : "Bugdom", sceneDescs };
