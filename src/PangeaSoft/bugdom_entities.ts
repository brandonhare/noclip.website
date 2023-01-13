import { mat4, quat, vec3 } from "gl-matrix";
import { lerp, MathConstants } from "../MathHelpers";
import { assert } from "../util";

import { AnimatedEntity, Assets, Entity, EntityUpdateResult, FriendlyNames, LevelObjectDef, ShadowEntity } from "./entity";
import { AnimatedObject, RenderFlags, StaticObject } from "./renderer";

export type BugdomProcessedAssets = Assets<StaticObject, AnimatedObject, StaticObject[]>
	& { levelType : BugdomLevelType };

export const ModelSetNames = [
	"AntHill_Models",
	"BeeHive_Models",
	"BonusScreen",
	"Forest_Models",
	"Global_Models1",
	"Global_Models2",
	"HighScores",
	"Lawn_Models1",
	"Lawn_Models2",
	"LevelIntro",
	"MainMenu",
	"Night_Models",
	"Pangea",
	"Pond_Models",
	"Title",
	"WinLose",
] as const;

export const SkeletonNames = [
	"Ant",
	"AntKing",
	"Bat",
	"BoxerFly",
	"Buddy",
	"Caterpillar",
	"DoodleBug",
	"DragonFly",
	"FireFly",
	"FlyingBee",
	"Foot",
	"LadyBug",
	"Larva",
	"Mosquito",
	"PondFish",
	"QueenBee",
	"Roach",
	"RootSwing",
	"Skippy",
	"Slug",
	"Spider",
	"WaterBug",
	"WingedFireAnt",
	"WorkerBee",
] as const;

export const BugdomModelFriendlyNames : FriendlyNames = {
	AntHill_Models : [],
	BeeHive_Models : [],
	BonusScreen : [],
	Forest_Models : [],
	Global_Models1 : [],
	Global_Models2 : [],
	HighScores : [],
	Lawn_Models1 : [],
	Lawn_Models2 : [],
	LevelIntro : [],
	MainMenu : [],
	Night_Models : [],
	Pangea : [],
	Pond_Models : [],
	Title : [],
	WinLose : [],
};


export const enum BugdomLevelType {
	Lawn,
	Pond,
	Forest,
	Hive,
	Night,
	Anthill
}

type BugdomNumberFunc = ((def : LevelObjectDef, assets : BugdomProcessedAssets)=>number);
type BugdomEntityDefBase = {
	scale? : number | [number, number] | BugdomNumberFunc,
	shadow? : boolean,
	offset? : vec3,
	randomRot? : boolean,
	rot? : number | BugdomNumberFunc,
};
type BugdomStaticEntityDef = BugdomEntityDefBase & {
	meshGroup : typeof ModelSetNames[number] | 0 | 1,
	meshId : number | BugdomNumberFunc,
}
type BugdomAnimatedEntityDef = BugdomEntityDefBase & {
	meshGroup : typeof SkeletonNames[number],
	meshId : "skel",
	anim : number,
	animSpeed? : number,
}
type BugdomEntityDef = BugdomStaticEntityDef | BugdomAnimatedEntityDef | ((def : LevelObjectDef, assets : BugdomProcessedAssets)=>Entity|Entity[]|void);

function spawnLadybug(def : LevelObjectDef, assets : BugdomProcessedAssets){
	const results : Entity[] = [
		// bug
		new AnimatedEntity(assets.skeletons.LadyBug, [def.x, def.y + 100, def.z], 0, 0.9, 2),
		// cage
		new Entity(assets.models.Global_Models1[9], [def.x, def.y, def.z], 0, 0.3),
	];

	// todo: cage backfaces

	const postPositions = [
		-430 * 0.3, -430 * 0.3,
		-430 * 0.3,  430 * 0.3,
		 430 * 0.3,  430 * 0.3,
		 430 * 0.3, -430 * 0.3,
	];

	// spawn posts
	for (let i = 0; i < 4; ++i){
		results.push(new Entity(assets.models.Global_Models1[10], [def.x + postPositions[i*2], def.y + 10, def.z + postPositions[i*2+1]], -Math.PI / 2 + (Math.PI / 2 * i), 0.3));
	}

	return results;
}

function spawnRock(def : LevelObjectDef, assets : BugdomProcessedAssets){
	let mesh;
	let scale;
	switch(assets.levelType){
		case BugdomLevelType.Night:
			mesh = assets.models.Night_Models[2 + def.param0];
			scale = 0.6;
			break;
		case BugdomLevelType.Lawn:
			mesh = assets.models.Lawn_Models2[8 + def.param0];
			scale = 4;
			break;
		case BugdomLevelType.Forest:
			mesh = assets.models.Forest_Models[10 + def.param0];
			scale = 0.9;
			break;
		default:
			return;
	}
	return new Entity(mesh, [def.x, def.y, def.z], Math.sin(def.x) * MathConstants.TAU, scale);
}
function spawnGrass(def : LevelObjectDef, assets : BugdomProcessedAssets){
	let mesh;
	let scale;
	switch(assets.levelType){
		case BugdomLevelType.Lawn:
			mesh = assets.models.Lawn_Models2[0 + def.param0];
			break;
		case BugdomLevelType.Forest:
			mesh = assets.models.Forest_Models[2 + def.param0];
			break;
		case BugdomLevelType.Night:
			mesh = assets.models.Night_Models[9 + def.param0];
			break;
		default:
			return;
	}
	// todo sink a little in slopes
	return new Entity(mesh, [def.x, def.y, def.z], null, 0.15);
}

class AntEntity extends AnimatedEntity {
	spear? : Entity = undefined;
	override update(dt: number): void {
		super.update(dt);
		if (this.spear){
			mat4.identity(this.spear.modelMatrix);
			mat4.mul(this.spear.modelMatrix, this.spear.modelMatrix, this.modelMatrix);
			mat4.mul(this.spear.modelMatrix, this.spear.modelMatrix, this.animationController.boneTransforms[4]);
			mat4.translate(this.spear.modelMatrix, this.spear.modelMatrix, [21, -80, -33]);
			mat4.scale(this.spear.modelMatrix, this.spear.modelMatrix, this.spear.scale);
		}
	}
}

function spawnAnt(def : LevelObjectDef, assets : BugdomProcessedAssets){
	const rockThrower = def.param0 === 1;
	// todo shadow
	const ant = new AntEntity(assets.skeletons.Ant, [def.x, def.y + 150, def.z], 0, 1.4, 0);
	if (rockThrower)
		return ant;
	// spear
	const spear = new Entity(assets.models.Global_Models1[5], [def.x, def.y, def.z], 0, 1);
	ant.spear = spear;
	return [ant, spear];
}
function spawnDetonator(def : LevelObjectDef, assets : BugdomProcessedAssets) {
	const meshGroup = getMeshGroupFromNumber(0, assets);
	return [
		new Entity(assets.models[meshGroup][4 + def.param1], [def.x, def.y, def.z], 0, 1.1), // box
		new Entity(assets.models[meshGroup][9], [def.x, def.y - 10, def.z], 0, 1.1), // plunger
	];
}
function spawnSpider(def : LevelObjectDef, assets : BugdomProcessedAssets){
	const spider = new AnimatedEntity(assets.skeletons.Spider, [def.x, def.y, def.z], 0, 0.9, 0);
	const threadType = (assets.levelType === BugdomLevelType.Forest) ? 3 : (assets.levelType === BugdomLevelType.Night ? 4 : 0)
	const thread = new Entity(assets.models[getMeshGroupFromNumber(0, assets)][threadType], [def.x, def.y + 100, def.z], 0, 0.9);
	return [spider, thread];
}
function spawnWaterValve(def : LevelObjectDef, assets : BugdomProcessedAssets){
	return [
		new Entity(assets.models.AntHill_Models[0], [def.x, def.y, def.z], 0, 0.25), // valve box
		new Entity(assets.models.AntHill_Models[1], [def.x, def.y + 100, def.z], 0, 0.25), // handle
	];
}
function spawnStump(def : LevelObjectDef, assets : BugdomProcessedAssets){
	return [
		new Entity(assets.models.Forest_Models[6], [def.x, def.y, def.z], 0, 25), // stump
		new Entity(assets.models.Forest_Models[7], [def.x + 130*25, def.y + 150*25, def.z], 0, 17) // hive
	]
}

const entityDefs : (BugdomEntityDef | null)[] = [
	{ meshGroup : "DoodleBug", meshId : "skel", scale : 1.7, anim : 0, }, // 0: player
	spawnLadybug, // 1: ladybug bonus
	{ meshGroup : "Global_Models1", meshId : 2, scale : 1.7, shadow : true }, // 2: nut
	{ meshGroup : "BoxerFly", meshId : "skel", scale : 0.9, offset: [0, 110, 0], shadow : true, anim : 0}, // 3: boxerfly
	spawnRock, // 4: rock
	{ meshGroup : "Lawn_Models2", meshId : (({param0})=>param0 + 6), randomRot : true, scale : [0.15, 0.25]}, // 5: clover // todo: sink into floor, unlit, autofade
	spawnGrass, // 6: grass
	{ meshGroup : "Lawn_Models2", meshId : (({param0})=>param0 + 2), randomRot : true, scale : 0.2}, // 7: weed
	null, // 8: slug
	spawnAnt, // 9: ant
	{ meshGroup : "Lawn_Models2", meshId : 5, randomRot : true, scale : 0.15 }, // 10: sunflower
	{ meshGroup : "Lawn_Models2", meshId : 3, randomRot : true, scale : [0.4, 0.45] }, // 11: cosmo // todo unlit
	{ meshGroup : "Lawn_Models2", meshId : 4, randomRot : true, scale : [0.4, 0.45] }, // 12: poppy
	{ meshGroup : "Global_Models1", meshId: 4, offset:[0,-30,0], scale : ((def, {levelType})=>levelType === BugdomLevelType.Pond ? 1.5 : 0.7) }, // 13: wall end
	null, // 14: water patch
	{ meshGroup : "WingedFireAnt", meshId : "skel", anim : 0, offset : [0, 130, 0] }, // 15: fire ant // todo shadow
	{ meshGroup : "WaterBug", meshId : "skel", rot : (({param0})=>param0 * Math.PI / 8), scale : 1.4, anim : 0 }, // 16: water bug // todo water y
	{ meshGroup : "Forest_Models", meshId : 1, scale : 20 }, // 17: tree
	{ meshGroup : "DragonFly", meshId : "skel", offset : [0, 80, 0], anim : 1, rot : (({param0})=>param0 * Math.PI / 8), scale : 2}, // 18: dragonfly // todo shadow
	{ meshGroup : "Pond_Models", meshId : 0, randomRot : true, scale : [0.15, 0.25] }, // 19: cattail
	{ meshGroup : "Pond_Models", meshId : 1, randomRot : true, scale : [0.15, 0.25] } , // 20: duck weed
	{ meshGroup : "Pond_Models", meshId : 2, randomRot : true, scale : [3, 3.5] }, // 21: lily flower
	{ meshGroup : "Pond_Models", meshId : 3, randomRot : true, scale : 2.5 }, // 22: lily pad // todo set water y
	{ meshGroup : "Pond_Models", meshId : (({param0})=>param0 + 4), randomRot : true, scale : [0.25, 0.35] }, // 23: pond grass
	{ meshGroup : "Pond_Models", meshId : (({param0})=>param0 + 7), randomRot : true, scale : 0.4 }, // 24: reed
	{ meshGroup : "PondFish", meshId : "skel", anim : 0, scale : [2, 2.3] }, // 25: pond fish enemy // todo y
	{ meshGroup : "BeeHive_Models", meshId : (({param0})=>param0 & 1), scale : (({param3})=>(param3&2) ? 1.3 : 2) }, // 26: honeycomb platform // todo y
	null, // 27: honey patch
	{ meshGroup : 0, meshId : (({param0}, {levelType})=>levelType === BugdomLevelType.Night ? 7 + param0 : 3), scale : ((def, {levelType})=>levelType === BugdomLevelType.Night ? 0.6 : 0.3) }, // 28: firecracker
	spawnDetonator , // 29: detonator
	{ meshGroup : "BeeHive_Models", meshId : (({param2})=>10 + param2), rot : (({param1})=>param1 * Math.PI / 2), scale : 7 } , // 30: hive door
	{ meshGroup : "Mosquito", meshId : "skel", anim : 0, offset : [0, 350, 0],  scale : 0.8 }, // 31: mosquito enemy // todo wobble
	{ meshGroup : "Global_Models1", meshId : 7, scale : 1.5 }, // 32: checkpoint // todo droplet
	{ meshGroup : 0, meshId : ((def, assets)=>(assets.levelType === BugdomLevelType.Lawn ? 1 : 13) + def.param0), rot : ((def)=>(def.param1) * Math.PI / 2), scale : 0.6 }, // 33: lawn door
	{ meshGroup : "Pond_Models", meshId : 10, rot : (({param0})=>param0 * Math.PI / 2) }, // 34: dock // todo y
	null, // 35: foot
	{ meshGroup : "Spider", meshId : "skel", scale : 0.9, offset : [0, 1000, 0], anim : 0}, // 36: enemy spider
	null, // 37: enemy caterpiller
	{ meshGroup : "FireFly", meshId : "skel", scale : 0.6, anim : 0, offset : [0, 400, 0] }, // 38: firefly // todo glow shadow
	{ meshGroup : "Global_Models2", meshId : 1, rot : ((def)=>def.param0 * Math.PI / 2), scale : 6 }, // 39: exit log
	{ meshGroup : "RootSwing", meshId : "skel", anim : 0, scale : (({param2})=>1.4+param2 * 0.3), rot : (({param0})=>param0 * Math.PI / 4) }, // 40: root swing // todo ceiling, animate
	{ meshGroup : "Forest_Models", meshId : (({param0})=>8 + param0), rot : ((def)=>((def.param3 & 1) ? Math.floor(Math.random() * 4) : def.param1) * Math.PI / 8), scale : 2.2 }, // 41: thorn bush
	null, // 42: firefly target
	null, // 43: fire wall
	spawnWaterValve, // 44: water valve
	{ meshGroup : 0, meshId : (({param0})=>20 + param0 + (param0 === 1 ? 1 : 0)), rot : (({param1})=>param1 * Math.PI / 2), scale : (({param2})=>(param2 * 0.5 + 1) * 3) }, // 45: honey tube
	{ meshGroup : "Larva", meshId : "skel", scale : 0.5, anim : 0,  } , // 46: larva
	{ meshGroup : "FlyingBee", meshId : "skel", scale : 0.8, anim : 0,  }, // 47: flying bee enemy // todo shadow, y offset
	{ meshGroup : "WorkerBee", meshId : "skel", anim : 0, scale : 1.5 } , // 48: worker bee // todo shadow // todo stinger
	{ meshGroup : "QueenBee", meshId : "skel", anim : 0, scale : 1.5, offset : [0, 90, 0] } , // 49: queen bee // todo shadow, only one
	null, // 50: rock ledge
	spawnStump,
	{ meshGroup : "Global_Models1", meshId : 6, offset : [0, 30*3, 0], randomRot : true, scale : 3 }, // 52: rolling boulder
	{ meshGroup : "Roach", meshId : "skel", anim : 0, scale : 1.7 }, // 53: roach enemy //todo shadow
	{ meshGroup : "Skippy", meshId : "skel", anim : 0, scale : 0.7 }, // 54: ??
	null, // 55: slime patch
	null, // 56: lava patch
	{ meshGroup : 0, meshId : 3, rot : (({param0})=>param0 * Math.PI / 2) }, // 57: bent ant paipe
	null, // 58: horizontal ant pipe
	{ meshGroup : "AntKing", meshId : "skel", scale : 1.5, anim : 0 }, // 59: ant king // todo staff, shadow
	{ meshGroup : 0, meshId : 11, rot : ((def)=>def.param0 * Math.PI / 2) }, // 60: water faucet
	{ meshGroup : 0, meshId : 12, offset : [0, -30, 0], scale : 10 }, // 61: ??
	{ meshGroup : 0, meshId : 25, offset : [0, -5, 0] }, // 62: floor spike
	{ meshGroup : 0, meshId : 5, scale : 4 }, // 63: king water pipe
];

export function spawnBugdomEntity(def : LevelObjectDef, assets : BugdomProcessedAssets):Entity|Entity[]|void{
	const entityDef = entityDefs[def.type];
	if (!entityDef) {
		console.log("unknown entity", def.type);
		return;
	}

	if (typeof(entityDef) === "function")
		return entityDef(def, assets);

	const pos : vec3 = [def.x, def.y, def.z];
	if (entityDef.offset)
		vec3.add(pos, pos, entityDef.offset);

	let rot = def.rot ?? entityDef.rot ?? (entityDef.randomRot ? Math.random() * MathConstants.TAU : 0);
	if (typeof(rot) === "function")
		rot = rot(def, assets);

	let scale = def.scale ?? entityDef.scale ?? 1;
	if (Array.isArray(scale))
		scale = lerp(scale[0], scale[1], Math.random());
	else if (typeof(scale) === "function")
		scale = scale(def, assets);


	// todo shadow

	if (entityDef.meshId === "skel"){
		const result = new AnimatedEntity(assets.skeletons[entityDef.meshGroup], pos, rot, scale, entityDef.anim);
		if (entityDef.animSpeed != undefined)
			result.animationController.animSpeed = entityDef.animSpeed;
		return result;
	} else {
		let meshGroup = entityDef.meshGroup;
		if (typeof(meshGroup) === "number"){
			meshGroup = getMeshGroupFromNumber(meshGroup, assets);
		}

		let meshId = entityDef.meshId;
		if (typeof(meshId) === "function")
			meshId = meshId(def, assets);

		return new Entity(assets.models[meshGroup][meshId], pos, rot, scale);
	}
}

function getMeshGroupFromNumber(num : number, assets : BugdomProcessedAssets){
	assert(num === 0 || (num === 1 && assets.levelType === BugdomLevelType.Lawn), "level mesh group out of range");
	switch(assets.levelType){
		case BugdomLevelType.Anthill:
			return "AntHill_Models";
		case BugdomLevelType.Forest:
			return "Forest_Models";
		case BugdomLevelType.Hive:
			return "BeeHive_Models";
		case BugdomLevelType.Lawn:
			if (num === 0)
				return "Lawn_Models1";
			else
				return "Lawn_Models2"
		case BugdomLevelType.Night:
			return "Night_Models";
		case BugdomLevelType.Pond:
			return "Pond_Models";
	}
}
