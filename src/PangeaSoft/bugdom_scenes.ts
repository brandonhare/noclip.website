import { vec3, vec4 } from "gl-matrix";
import { colorMult, colorScale } from "../Color";
import { GfxDevice } from "../gfx/platform/GfxPlatform";
import { SceneContext } from "../SceneBase";
import * as Viewer from '../viewer';

import { parseAppleDouble } from "./AppleDouble";
import { BugdomLevelType, ModelSetNames, ProcessedAssets, SkeletonNames, spawnBugdomEntity } from "./bugdom_entities";
import { parseBugdomTerrain, ParsedBugdomTerrain } from "./bugdom_terrain";
import { Assets, Entity, LevelObjectDef } from "./entity";
import { parseQd3DMeshGroup, Qd3DMesh } from "./QuickDraw3D";
import { AnimatedObject, Cache, RenderFlags, SceneRenderer, SceneSettings, StaticObject } from "./renderer";
import { parseSkeleton, SkeletalMesh } from "./skeleton";

const pathBase = "bugdom";



export type RawAssets = Assets<Qd3DMesh, SkeletalMesh, ParsedBugdomTerrain>;

export class BugdomSceneRenderer extends SceneRenderer {

	processedAssets : ProcessedAssets = {models : {}, skeletons : {}, terrain : undefined, levelType : BugdomLevelType.Lawn };

	constructor(device : GfxDevice, context : SceneContext, assets : RawAssets, objectList : LevelObjectDef[], sceneSettings : SceneSettings, levelType : BugdomLevelType){
		super(device, context, sceneSettings);

		this.createModels(device, this.cache, assets);
		this.processedAssets.levelType = levelType;

		if (this.processedAssets.terrain)
			this.entities.push(new Entity(this.processedAssets.terrain, [0,0,0],0,1,false));

		// todo terrain objects

		for (const objectDef of objectList){
			const entity = spawnBugdomEntity(objectDef, this.processedAssets);
			if (entity){
				if (Array.isArray(entity))
					this.entities.push(...entity);
				else
					this.entities.push(entity);
			}
		}
	}
	
	createModels(device : GfxDevice, cache : Cache, rawAssets : RawAssets){

		this.processedAssets = {
			models : {},
			skeletons : {},
			levelType : BugdomLevelType.Lawn
		}
		
		for (const modelSetName of Object.keys(rawAssets.models)){
			const modelSet = rawAssets.models[modelSetName];
			this.processedAssets.models[modelSetName] = modelSet.map((meshes)=>
				meshes.map((mesh)=>
					new StaticObject(device, cache, mesh)
				)
			);
		}
		for (const skeletonName of Object.keys(rawAssets.skeletons)){
			const skeleton = rawAssets.skeletons[skeletonName];
			this.processedAssets.skeletons[skeletonName] = new AnimatedObject(device, cache, skeleton);
		}
	}
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

		const terrainPromise = scene.terrain
			? context.dataFetcher.fetchData(`${pathBase}/Terrain/${scene.terrain}.ter.rsrc`)
				.then((data)=>parseBugdomTerrain(parseAppleDouble(data), this.def.hasCeiling))
			: {items:[]};

		const models = await modelPromises;
		const skeletons = await skeletonPromises;
		const terrain = await terrainPromise;

		let objects : LevelObjectDef[] = terrain.items;

		if (scene.objects){
			let objArray;
			if (Array.isArray(scene.objects))
				objArray = scene.objects;
			else
				objArray = scene.objects();
			objects = [...objects, ...objArray];
		}

		const rawAssets : RawAssets = {
			models : {},
			skeletons : {},
			terrain
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
	models : (typeof ModelSetNames[number])[],
	skeletons : (typeof SkeletonNames[number])[],
	scenes : BugdomSceneDef[],
	settings : SceneSettings,
};
const bugdomSceneDefs : BugdomLevelTypeDef[] = [
	{ // lawn
		type : BugdomLevelType.Lawn,
		hasCeiling : false,
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
		}
	}, { // pond
		type : BugdomLevelType.Pond,
		hasCeiling : false,
		models : ["Pond_Models"],
		skeletons : ["Mosquito", "WaterBug", "PondFish", "Skippy", "Slug"],
		scenes : [{ id : "pond", name : "Pond", terrain : "Pond" }],
		settings : {
			ambientColour : { r : 1, g : 1, b : 0.9, a : 1},
			lightColours : [{ r : 1, g : 1, b : 0.6, a : 1}, {r : 1, g : 1, b : 1, a : 1}],
			lightDirs : [[0.4, -0.45, 1, 0], [-0.2, -0.7, -0.1, 0]],
			clearColour : { r : 0.9, g : 0.9, b : 0.85, a : 1},
			fogColour : { r : 0.9, g : 0.9, b : 0.85, a : 1},
		}
	}, { // forest
		type : BugdomLevelType.Forest,
		hasCeiling : false,
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
		}
	}, { // hive
		type : BugdomLevelType.Hive,
		hasCeiling : true,
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
		}
	}, { // night
		type : BugdomLevelType.Night,
		hasCeiling : false,
		models : ["Night_Models"],
		skeletons : ["WingedFireAnt", "FireFly", "Caterpillar", "Slug", "Roach", "Ant"],
		scenes : [{ id : "night", name : "Night", terrain : "Night" }],
		settings : {
			ambientColour : { r : 0.5, g : 0.5, b : 0.5, a : 1},
			lightColours : [{ r : 0.8, g : 1, b : 0.8, a : 1}, {r : 0.6, g : 0.8, b : 0.7, a : 1}],
			lightDirs : [[0.4, -0.35, 1, 0], [-0.2, -0.7, -0.1, 0]],
			clearColour : { r : 0.02, g : 0.02, b : 0.08, a : 1},
			fogColour : { r : 0.02, g : 0.02, b : 0.08, a : 1},
		}
	}, { // anthill
		type : BugdomLevelType.Anthill,
		hasCeiling : true,
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
