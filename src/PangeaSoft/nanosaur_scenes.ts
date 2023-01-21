import * as Viewer from '../viewer';
import { DataFetcher } from "../DataFetcher";
import { GfxDevice, GfxFormat, GfxWrapMode } from "../gfx/platform/GfxPlatform";
import { MathConstants } from "../MathHelpers";
import { SceneContext } from "../SceneBase";
import { assert } from "../util";

import { parseAppleDouble } from "./AppleDouble";
import { Assets, Entity, getFriendlyName, LevelObjectDef } from "./entity";
import { entityCreationFunctions, invalidEntityType, ModelSetNames, NanosaurModelFriendlyNames, ObjectType, NanosaurProcessedAssets, SkeletonNames, initNanosaurMeshRenderSettings } from "./nanosaur_entities";
import { NanosaurParseTerrainResult, parseTerrain } from "./nanosaur_terrain";
import { AlphaType, parseQd3DMeshGroup, Qd3DMesh, Qd3DTexture } from "./QuickDraw3D";
import { AnimatedObject, Cache, RenderFlags, SceneRenderer, SceneSettings, StaticObject } from "./renderer";
import { parseSkeleton, SkeletalMesh } from "./skeleton";
import { loadTextureFromTGA } from "./TGA";
import { vec4 } from "gl-matrix";
import { TerrainInfo } from "./terrain";

const pathBase = "nanosaur";



export type NanosaurRawAssets = Assets<Qd3DMesh, SkeletalMesh, Qd3DMesh|undefined>;

export class NanosaurSceneRenderer extends SceneRenderer {

	processedAssets : NanosaurProcessedAssets = {models : {}, skeletons : {}, terrain : undefined, terrainInfo : undefined};

	constructor(device : GfxDevice, context : SceneContext, assets : NanosaurRawAssets, objectList : LevelObjectDef[], sceneSettings : SceneSettings){
		super(device, context, sceneSettings);

		this.createModels(device, this.cache, assets);

		const entities : Entity[] = [];
		if (this.processedAssets.terrain)
			entities.push(new Entity(this.processedAssets.terrain, [0,0,0],0,1,false));

		for (const objectDef of objectList){
			const entity = (entityCreationFunctions[objectDef.type] ?? invalidEntityType)(objectDef, this.processedAssets);
			if (entity){
				if (Array.isArray(entity))
					entities.push(...entity);
				else
					entities.push(entity);
			}
		}

		this.initEntities(entities);
	}
	
	createModels(device : GfxDevice, cache : Cache, rawAssets : NanosaurRawAssets){

		this.processedAssets = {
			models : {},
			skeletons : {},
			terrain : rawAssets.terrain ? new StaticObject(device, cache, rawAssets.terrain, "Terrain") : undefined,
			terrainInfo : rawAssets.terrainInfo,
		}

		for (const modelSetName of Object.keys(rawAssets.models)){
			const modelSet = rawAssets.models[modelSetName];
			this.processedAssets.models[modelSetName] = modelSet.map((meshes, index)=>
				meshes.map((mesh, index2)=>
					new StaticObject(device, cache, mesh, getFriendlyName(NanosaurModelFriendlyNames, modelSetName, index, index2))
				)
			);
		}

		for (const skeletonName of Object.keys(rawAssets.skeletons)){
			const skeleton = rawAssets.skeletons[skeletonName];
			this.processedAssets.skeletons[skeletonName] = new AnimatedObject(device, cache, skeleton, NanosaurModelFriendlyNames, skeletonName);
		}

		initNanosaurMeshRenderSettings(this.processedAssets);
		
		if (cache.onnewtextures)
			cache.onnewtextures();
	}
}



function convertGreyscaleTextureToAlphaMap(texture : Qd3DTexture) : Qd3DTexture {
	assert(texture.pixelFormat === GfxFormat.U8_R_NORM, "unsupported pixel format");
	texture.alpha = AlphaType.Translucent;
	texture.pixelFormat = GfxFormat.U8_RGBA_NORM;
	const numPixels = texture.width * texture.height;
	const numBytes = numPixels * 4;
	const src = texture.pixels;
	const dst = new Uint8Array(numBytes);
	for (let i = 0; i < numPixels; ++i){
		const v = src[i];
		dst[i * 4    ] = v;
		dst[i * 4 + 1] = v;
		dst[i * 4 + 2] = v;
		dst[i * 4 + 3] = v;
	}
	texture.pixels = dst;
	return texture;
}
async function loadAlphaTexture(dataFetcher : DataFetcher, url : string){
	const data = await dataFetcher.fetchData(pathBase + url);
	const tga = loadTextureFromTGA(data);

	let alpha = AlphaType.Opaque;
	switch(tga.pixelFormat){
		case GfxFormat.U16_RGBA_5551: alpha = AlphaType.OneBitAlpha; break;
		case GfxFormat.U8_RGBA_NORM: alpha = AlphaType.Translucent; break;
	}

	const texture : Qd3DTexture = {
		 ...tga,
		 alpha,
		 numTextures : 1,
		 wrapU : GfxWrapMode.Repeat,
		 wrapV : GfxWrapMode.Repeat,
	};
	return convertGreyscaleTextureToAlphaMap(texture);
}




type SceneSetupDef = {
	id : string,
	name : string,
	settings : SceneSettings,
	models : readonly(typeof ModelSetNames[number])[],
	skeletons? : readonly (typeof SkeletonNames[number])[],
	terrain? : string,
	objects? : LevelObjectDef[] | (()=>LevelObjectDef[]),
};


class NanosaurSceneDesc implements Viewer.SceneDesc {
	id : string;
	name : string;
	def : SceneSetupDef;

	constructor(def : SceneSetupDef){
		this.id = def.id;
		this.name = def.name;
		this.def = def;
	}

	public async createScene(device: GfxDevice, context: SceneContext): Promise<NanosaurSceneRenderer> {
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

			const terrainPromise 
			: Promise<NanosaurParseTerrainResult> | [undefined, undefined, LevelObjectDef[]]
				= this.def.terrain 
				? Promise.all([
						context.dataFetcher.fetchData(`${pathBase}/terrain/${this.def.terrain}.ter`),
						context.dataFetcher.fetchData(pathBase + "/terrain/Level1.trt"),
					]).then(([terrainData, terrainTexture]) => parseTerrain(terrainData, terrainTexture))
				: [undefined, undefined, []];

		let shadowTexturePromise : Promise<Qd3DTexture> | undefined;
		if (this.def.models.includes("Global_Models"))
			shadowTexturePromise = loadAlphaTexture(context.dataFetcher, "/Images/Shadow.tga");

		const models = await modelPromises;
		const skeletons = await skeletonPromises;
		let [terrainModel, terrainInfo, objects] = await terrainPromise;

		if (this.def.objects){
			let objArray;
			if (Array.isArray(this.def.objects))
				objArray = this.def.objects;
			else
				objArray = this.def.objects();
			objects = [...objects, ...objArray];
		}

		const rawAssets : NanosaurRawAssets = {
			models : {},
			skeletons : {},
			terrain : terrainModel,
			terrainInfo,
		};
		for (let i = 0; i < (this.def.models?.length ?? 0); ++i){
			const name = this.def.models![i];
			rawAssets.models[name] = models[i];
		}
		for (let i = 0; i < (this.def.skeletons?.length ?? 0); ++i){
			const name = this.def.skeletons![i];
			rawAssets.skeletons[name] = skeletons[i];
		}

		if (shadowTexturePromise)
			rawAssets.models.Global_Models[1][0].texture = await shadowTexturePromise;

		return new NanosaurSceneRenderer(device, context, rawAssets, objects, this.def.settings);
	}
}


function createMenuObjectList() : LevelObjectDef[] {
	
	const result : LevelObjectDef[] = [
		{
			type : ObjectType.MenuBackground,
			x : 0,
			y : 0,
			z : 0,
			param0:0,
			param1:0,
			param2:0,
			param3:0,
			scale : 5,
		}
	];
	for (let i = 0; i < 5; ++i){
		const angle = MathConstants.TAU * i / 5;
		result.push({
			type : ObjectType.MenuBackground + i,
			x : Math.sin(angle) * 310,
			y : 0,
			z : Math.cos(angle) * 310 - 5,
			param0:0,
			param1:0,
			param2:0,
			param3:0,
			rot : angle,
		});
	}
	result[1].type = ObjectType.Player;
	result[1].scale = 0.8;
	result[1].rot! += Math.PI / 2;
	result[1].param0 = 1; // animation hack
	return result;
}
function createLogoObjectList() : LevelObjectDef[] {
	return [
		{ // logo
			x : 0,
			y : 0,
			z : -300,
			type : ObjectType.TitlePangeaLogo,
			param0 : 0,
			param1:0,
			param2:0,
			param3 : 0,
			rot : 0,
			scale : 0.2,
		},
	]
}
function createTitleObjectList() : LevelObjectDef[]{
	const result : LevelObjectDef[] = [
		{ // rex
			x : 10,
			y : 0,
			z : 70,
			type : ObjectType.Rex,
			param0 : 1, // hack anim type
			param1:0,
			param2:0,
			param3 : 0,
			rot : Math.PI * -0.5,
			scale : 0.5,
		},{ // title text
			x : 60,
			y : 15,
			z : 100,
			type : ObjectType.TitleGameName,
			param0 : 0,
			param1:0,
			param2:0,
			param3 : 0,
			rot : 0.9,
			scale : 0.4,
		},
	];
	for (let i = 0; i < 3; ++i){
		result.push({ // background
			x : -600 * 2.6 + i * 300*2.6,
			y : 0,
			z : -40,
			type : ObjectType.TitleBackground,
			param0 : 0,
			param1:0,
			param2:0,
			param3 : 0,
			scale : 2.6,
		});
	}
	return result;
}
function createHighScoresObjectList() : LevelObjectDef[]{
	const scores = [
		"cool", 100,
		"brandonhare", 50,
	];
	const result : LevelObjectDef[] = [
		{
			x : 0,
			y : 0,
			z : 0,
			type : ObjectType.Spiral,
			param0 : 0,
			param1:0,
			param2:0,
			param3 : 0,
			rot : 0,
			scale : 4
		}
	];

	const numScores = Math.max(scores.length, 16);
	for (let i = 0; i < numScores; i += 2){
		const name = scores[i] as string ?? "";
		let score = scores[i + 1] as number ?? 0;
		let x = 18 * (11+3) * i + 200;

		// print name
		for (let j = 0; j < name.length; ++j){
			const code = name.charCodeAt(j);
			let meshId : number;
			if (code >= 48 && code <= 57) // 0-9
				meshId = 1 + code - 48;
			else if (code >= 65 && code <= 90) // A-Z
				meshId = 11 + code - 65;
			else if (code >= 97 && code <= 122) // a-z
				meshId = 11 + code - 97;
			else switch(code){
				case 35: meshId = 38; break; // #
				case 33: meshId = 40; break; // !
				case 63: meshId = 39; break; // ?
				case 39: meshId = 42; break; // '
				case 46: meshId = 37; break; // .
				case 58: meshId = 43; break; // :
				case 45: meshId = 41; break; // -
				default: continue; // space or unknown char
			}

			result.push({
				x : x + j * 18,
				y : 0,
				z : 0,
				type : ObjectType.Letter,
				param0 : meshId,
				param1:0,
				param2:0,
				param3 : 0,
			});
		}

		x += 75;
		// print score
		let place = 0;
		while (score > 0 || place < 4) {
			const digit = score % 10;
			score = Math.floor(score / 10);
			const meshId = 1 + digit;
			result.push({
				x : x - (place * 18),
				y : -25,
				z : 0,
				type : ObjectType.Letter,
				param0 : meshId,
				param1:0,
				param2:0,
				param3 : 0,
			});
			place += 1;
		}
	}

	return result;
}


const nanosaurSceneDefs : SceneSetupDef[] = [
	{
		id : "logo",
		name : "Logo",
		models : ["Title"],
		settings : {
			clearColour : {r:0, g:0, b:0, a:1},
			ambientColour : {r:0.25, g:0.25, b:0.25, a:1.0},
			lightDirs : [[1, -0.7, -1, 0]],
			lightColours : [{r:1.3,g:1.3,b:1.3,a:1}],
			cameraPos : [0, 0, 70],
		},
		objects : createLogoObjectList,
	},
	{
		id : "title",
		name : "Title",
		models : ["Title"],
		skeletons : ["Rex"],
		settings : {
			clearColour : {r:1, g:1, b:1, a:1},
			ambientColour : {r:0.25, g:0.25, b:0.25, a:1.0},
			lightDirs : [[1, -0.7, -1, 0]],
			lightColours : [{r:1.3,g:1.3,b:1.3,a:1}],
			cameraPos : [110, 90, 190],
		},
		objects : createTitleObjectList,
	},
	{
		id : "mainmenu",
		name : "Main Menu",
		models: ["MenuInterface"],
		skeletons : ["Deinon"],
		settings : {
			clearColour : {r:0, g:0, b:0, a:1},
			ambientColour : {r:0.25, g:0.25, b:0.25, a:1.0},
			lightDirs : [[1, -0.7, -1, 0]],
			lightColours : [{r:1.3,g:1.3,b:1.3,a:1}],
			cameraPos : [0, 0, 600],
		},
		objects : createMenuObjectList,
	},
	{
		id : "level1",
		name : "Level 1",
		models : ["Global_Models", "Level1_Models"],
		skeletons : SkeletonNames,
		terrain : "Level1",
		settings : {
			clearColour : {r:0.95, g:0.95, b:0.75, a:1.0},
			ambientColour: {r:0.2, g:0.2, b:0.2, a:1.0},
			lightDirs : [[1, -0.7, -1, 0]],
			lightColours : [{r:1.2, g:1.2, b:1.2, a:1}],
			cameraPos : [4795, 493, 15280],
			cameraTarget : [4795, 406, 14980],
		},
	},
	{
		id : "level1extreme",
		name : "Level 1 (Extreme)",
		models : ["Global_Models", "Level1_Models"],
		skeletons : SkeletonNames,
		terrain : "Level1Pro",
		settings : {
			clearColour : {r:0.95, g:0.95, b:0.75, a:1.0},
			ambientColour: {r:0.2, g:0.2, b:0.2, a:1.0},
			lightDirs : [[1, -0.7, -1, 0]],
			lightColours : [{r:1.2, g:1.2, b:1.2, a:1}],
			cameraPos : [4795, 493, 15280],
			cameraTarget : [4795, 406, 14980],
		},
	},
	{
		id : "highscores",
		name : "High Scores",
		models : ["HighScores"],
		settings : {
			clearColour : {r:0, g:0, b:0, a:1},
			ambientColour : {r:0.2, g:0.2, b:0.2, a:1.0},
			lightDirs : [[0.7, -0.1, -0.3, 0], [-1, -0.3, -0.4, 0]],
			lightColours : [{r:1,g:1,b:1,a:1}, {r:0.4,g:0.4,b:0.4,a:1}],
			cameraPos : [-110, -30, 90],
		},
		objects : createHighScoresObjectList
	},
];

for (const def of nanosaurSceneDefs){
	for (const dir of def.settings.lightDirs){
		vec4.negate(dir, dir);
		vec4.normalize(dir, dir);
	}
}

const sceneDescs = nanosaurSceneDefs.map((def) => new NanosaurSceneDesc(def));
export const sceneGroup: Viewer.SceneGroup = { id : "nanosaur", name : "Nanosaur", sceneDescs };
