import { mat4, vec3 } from "gl-matrix";
import { MathConstants } from "../MathHelpers";
import { assert, assertExists } from "../util";

import { AnimatedEntity, Assets, Entity, EntityUpdateResult, FriendlyNames, LevelObjectDef } from "./entity";
import { AnimatedObject, RenderFlags, StaticObject } from "./renderer";
import { TerrainInfo } from "./terrain";


export type NanosaurProcessedAssets = Assets<StaticObject, AnimatedObject, StaticObject | undefined >;

export const enum ObjectType {
	Player,
	Powerup,
	Tricer,
	Rex,
	Lava,
	Egg,
	GasVent,
	Ptera,
	Stego,
	TimePortal,
	Tree,
	Boulder,
	Mushroom,
	Bush,
	WaterPatch,
	Crystal,
	Spitter,
	StepStone,
	RollingBoulder,
	SporePod,
	// main menu hack items
	MenuBackground,
	OptionsIcon,
	InfoIcon,
	QuitIcon,
	HighScoresIcon,
	// title hack items,
	TitlePangeaLogo,
	TitleGameName,
	TitleBackground,
	// high score hack items
	Spiral,
	Letter,
}

export const ModelSetNames = [
	"Global_Models", "HighScores", "Level1_Models", "Title", "MenuInterface",
] as const;


export const SkeletonNames = [
	"Ptera", "Rex", "Stego", "Deinon", "Tricer", "Diloph",
] as const;


export const NanosaurModelFriendlyNames : FriendlyNames = {
	Global_Models : ["JetFlame", "Shadow", "Dust", "Smoke", "DinoSpit", "SonicScream", "Blaster", "HeatSeek", "HeatSeekEcho", "Explosion", "TimePortalRing", "HeatSeekPOW", "LaserPOW", "TriBlast", "TriBlastPOW", "HealthPOW", "ShieldPOW", "NukePOW", "Sonic", "Shield", "Nuke"],
	HighScores : ["NameFrame"],
	Level1_Models : ["BonusBox","LavaPatch","WaterPatch","Egg1","Egg2","Egg3","Egg4","Egg5","Boulder","Boulder2",["Mushroom Top", "Mushroom Stem"],"Bush","Crystal1","Crystal2","Crystal3","Nest","Tree1","Tree2","Tree3","Tree4","Tree5","Tree6","GasVent","StepStone","Pod","Spore","Firebal"],
	Title : ["GameName", "PangeaLogo", "Background"],
	MenuInterface : ["Quit","Options","Info","HighScores","Egg","Background"],

	
	Ptera : ["0", "Body"], // todo body items
	Rex : ["0", "Body"],
	Stego : ["Body"],
	Deinon : ["Gun","GunTip","Mouth","Jetpack","Body"],
	Tricer : ["Body"],
	Diloph : ["0", "Body"],
};
for (let i = 1; i <= 43; ++i)
	NanosaurModelFriendlyNames.HighScores.push("Letter");
NanosaurModelFriendlyNames.HighScores.push("Cursor");
NanosaurModelFriendlyNames.HighScores.push(["Spiral", "SpiralBackground"]);


export function initNanosaurMeshRenderSettings(assets : NanosaurProcessedAssets){

	const globalModels = assets.models.Global_Models;
	if (globalModels){
		// shadow
		const shadowModel = globalModels[1][0];
		shadowModel.makeTranslucent(1, false, false);
		shadowModel.renderLayerOffset = -2; // draw shadows below water
		shadowModel.colour.r = shadowModel.colour.b = shadowModel.colour.g = 0; // sprite texture is white, make it black
		// smoke puff
		globalModels[3][0].makeTranslucent(0.5, false, true);
		// time portal ring
		globalModels[10][0].makeTranslucent(1, false, true);
	}

	const level1Models = assets.models.Level1_Models;
	if (level1Models){
		// lava
		level1Models[1][0].makeScrollUVs([0.07, 0.03]);
		// water
		const waterModel = level1Models[2][0];
		waterModel.makeTranslucent(0.8, false, true);
		waterModel.makeScrollUVs([-0.04, 0.08])
		// gas vent
		level1Models[22][0].makeTranslucent(0.7, true, true);	
		// crystals
		for (let i = 12; i <= 14; ++i){
			const crystalModel = level1Models[i][0];
			crystalModel.makeTranslucent(0.7, false, true);
			crystalModel.renderFlags |= RenderFlags.DrawBackfacesSeparately;
		}
	}

	const menuModels = assets.models.MenuInterface;
	if (menuModels){
		// background center thingy
		menuModels[5][0].makeReflective();
	}

	const titleModels = assets.models.Title;
	if (titleModels){
		// game name
		titleModels[0][0].makeReflective();
		// logo
		titleModels[1][0].makeReflective();
	}
}


class SpinningEntity extends Entity {
	spinSpeed = 1;

	override update(dt : number) {
		this.rotation = (this.rotation + this.spinSpeed * dt) % MathConstants.TAU;
		this.updateMatrix();
	}
}
class UndulateEntity extends Entity {
	t = Math.random() * MathConstants.TAU;
	baseScale = 1;
	period = 1;
	amplitude = 1;

	override update(dt: number): void {
		this.t = (this.t + dt * this.period) % MathConstants.TAU;
		this.scale[1] = this.baseScale + Math.sin(this.t) * this.amplitude;
		this.updateMatrix();
	}
}

class ShadowEntity extends Entity {
	constructor(terrainInfo : TerrainInfo | undefined, mesh : StaticObject | StaticObject[], parent : Entity, terrainY : number, scaleX : number, scaleZ : number){
		assert(terrainInfo !== undefined, "spawned a shadow with no terrain info!");

		super(mesh, vec3.clone(parent.position), parent.rotation, 1, false);

		this.scale[0] = scaleX;
		this.scale[2] = scaleZ;
		this.position[1] = terrainY + 3;
		this.updateShadow(terrainInfo, parent.position[1]);
	}

	updateShadow(terrainInfo : TerrainInfo, parentY : number){

		const [x,y,z] = this.position;
	
		const dist = 1 - Math.min(0.5, (parentY - y) / 400);
		const sideScale = this.scale[0] * dist;
		const forwardScale = this.scale[2] * dist;

		const sideOffset = sideScale * 25;
		//const forwardOffset = forwardScale * 25;
		const forwardOffset = sideOffset; // the original game uses the width for both directions


		function getAxisDy(dx : number, dz : number){
			const h1 = terrainInfo.getHeight(x + dx, z + dz);
			const h2 = terrainInfo.getHeight(x - dx, z - dz);
			return (h1 - h2) * 0.5;
		}

		const cosRot = Math.cos(this.rotation);
		const sinRot = Math.sin(this.rotation);

		const sideDx = -cosRot * sideOffset;
		const sideDz =  sinRot * sideOffset;
		const sideDy = getAxisDy(sideDx, sideDz);

		const forwardDx = -sinRot * forwardOffset;
		const forwardDz = -cosRot * forwardOffset;
		const forwardDy = getAxisDy(forwardDx, forwardDz);

		// cross product of above
		const upDx = sideDy * forwardOffset * cosRot + forwardDy * sideOffset * sinRot;
		const upDy = forwardOffset * sideOffset;
		const upDz = forwardDy * sideOffset * cosRot - sideDy * forwardOffset * sinRot;
		
		// normalize and apply scale values
		const xScale = sideScale / Math.hypot(sideOffset, sideDy);
		const yScale = this.scale[1] / Math.hypot(upDx, upDy, upDz);
		const zScale = forwardScale / Math.hypot(forwardOffset, forwardDy); 

		mat4.set(this.modelMatrix,
			sideDx * xScale, sideDy * xScale, sideDz * xScale, 0,
			upDx * yScale, upDy * yScale, upDz * yScale, 0,
			forwardDx * zScale, forwardDy * zScale, forwardDz * zScale, 0,
			x, y, z, 1);

		this.aabb.transform(this.meshes[0].aabb, this.modelMatrix);
	}
}


function spawnTriceratops(def : LevelObjectDef, assets : NanosaurProcessedAssets){ // 2
	const result = new AnimatedEntity(assets.skeletons.Tricer!, [def.x, def.y, def.z], null, 2.2, 1, false);
	return [result, new ShadowEntity(assets.terrainInfo, assets.models.Global_Models[1], result, def.y, 2.7, 2.7*1.5)];
};
export const entityCreationFunctions : ((def:LevelObjectDef, assets : NanosaurProcessedAssets)=>Entity|Entity[]|void)[] = [
	function spawnPlayer(def, assets){ // 0
		const mainMenu = def.param0; // main menu hack
		const player = new AnimatedEntity(assets.skeletons.Deinon!, [def.x, def.y, def.z], def.rot ?? 0, def.scale ?? 1, mainMenu, !mainMenu);
		if (mainMenu){
			player.animationController.t = 0;
			return player;
		} else {
			return [player, new ShadowEntity(assets.terrainInfo, assets.models.Global_Models[1], player, def.y, 0.9, 0.9*2.5)];
		}
	},
	function spawnPowerup(def, assets){ // 1
		const meshIndices = [11, 12, 14, 15, 16, 17, 18];
		const type = def.param0;
		assert(type >= 0 && type <= 6, "powerup type out of range");
		// todo: y pos quick
		// todo darken shadow?
		return new SpinningEntity(assets.models.Global_Models[meshIndices[type]], [def.x, def.y + 0.5, def.z], null, 1, false);
	},
	spawnTriceratops, // 2
	function spawnRex(def, assets){ // 3
		const title = def.param0 === 1; // title hack
		const rex = new AnimatedEntity(assets.skeletons.Rex!, [def.x, def.y, def.z], def.rot ?? null, def.scale ?? 1.2, title ? 1 : 0, false);

		if (title) {
			rex.animationController.t = 0;
			rex.animationController.animSpeed = 0.8;
			return rex;
		} else {
			return [rex, new ShadowEntity(assets.terrainInfo, assets.models.Global_Models[1], rex, def.y, 2.6, 2.6*2.5)];
		}
	},
	function spawnLava(def, assets){ // 4

		const fireballMesh = assets.models.Level1_Models[26];
		const smokeMesh = assets.models.Global_Models[3];

		class SmokePuffEntity extends Entity {
			t = 0.5;
			decayRate = Math.random() * 0.3 + 0.9;

			override alwaysUpdate = true;

			override update(dt : number) : void | false {
				this.t -= dt * this.decayRate;
				if (this.t < 0)
					return false;

				this.opacity = Math.min(1, 3 * this.t);

				for (let i = 0; i < 3; ++i){
					this.scale[i] += dt * 0.5;
				}
				this.rotX += dt * Math.PI;

				this.updateMatrix();
			}
		}

		class FireballEntity extends Entity {

			velocity : vec3 = [(Math.random() - 0.5) * 300,300 + Math.random() * 400,(Math.random() - 0.5) * 300]
			puffTimer = 0;
			terrainInfo : TerrainInfo = undefined!;

			override alwaysUpdate = true;

			override update(dt : number) : void | SmokePuffEntity | false {
				this.velocity[1] -= 560 * dt;
				for (let i = 0; i < 3; ++i)
					this.position[i] += this.velocity[i] * dt;

				if (this.position[1] <= this.terrainInfo.getHeight(this.position[0], this.position[2])){
					// hit the ground, get destroyed
					return false;
				}

				this.rotX += dt * 3 * Math.PI;
				this.rotZ -= dt * MathConstants.TAU;

				this.updateMatrix();

				this.puffTimer += dt;
				if (this.puffTimer > 0.06){
					this.puffTimer %= 0.06;
					return new SmokePuffEntity(smokeMesh, [...this.position] as vec3, null, Math.random() * 0.1 + 0.4, false);
				}
			}
		}

		class LavaEntity extends UndulateEntity {
			fireballTimer = Math.random() * 0.4;
			terrainInfo : TerrainInfo = undefined!;

			override update(dt : number) : FireballEntity | void {
				super.update(dt);

				if (this.viewDistance > 10000)
					return;
				this.fireballTimer += dt;
				if (this.fireballTimer > 0.4){
					this.fireballTimer %= 0.4;

					const pos : vec3 = [
						this.position[0] + (Math.random() - 0.5) * 700,
						this.position[1] - 20,
						this.position[2] + (Math.random() - 0.5) * 700
					];

					if (this.terrainInfo.getHeight(pos[0], pos[2]) >= pos[1])
						return;

					const fireball = new FireballEntity(fireballMesh, pos, 0, 0.3, false);
					fireball.terrainInfo = this.terrainInfo;
					return fireball;
				}
			}
		}
		

		const x = Math.floor(def.x / 140) * 140 + 140/2
		const z = Math.floor(def.z / 140) * 140 + 140/2
		const y = (def.param3 & 1) ? def.y + 50 : 305;
		const scale = (def.param3 & (1<<2)) ? 1 : 2;
		const shootFireballs = (def.param3 & (1<<1)) !== 0;
		let result : UndulateEntity;
		if (shootFireballs){
			const lava = new LavaEntity(assets.models.Level1_Models[1], [x,y,z], 0, scale, false);
			lava.terrainInfo = assets.terrainInfo!;
			result = lava;
		} else
			result = new UndulateEntity(assets.models.Level1_Models[1], [x,y,z], 0, scale, false);
		result.baseScale = 0.501;
		result.amplitude = 0.5;
		result.period = 2.0;
		return result;
	},
	function spawnEgg(def, assets){ // 5
		const eggType = def.param0;
		assert(eggType < 5, "egg type out of range");
		const egg = new Entity(assets.models.Level1_Models[3 + eggType], [def.x, def.y, def.z], null, 0.6, true);
		if (def.param3 & 1){
			// make nest
			const nest = new Entity(assets.models.Level1_Models[15], [def.x, def.y, def.z], 0, 1, false);
			return [egg, nest];
		}
		return egg;
	},
	function spawnGasVent(def, assets){ // 6
	
		class GasVentEntity extends Entity {
			override update(dt : number){
				// todo: cap to 60fps
				this.scale[1] = Math.random() * 0.3 + 0.5;
				this.updateMatrix();
			}
		};

		return new GasVentEntity(assets.models.Level1_Models[22], [def.x, def.y, def.z], 0, 0.5, false);
	},
	function spawnPteranodon(def, assets){ // 7

		class PteranodonEntity extends AnimatedEntity {
			rock? : Entity = undefined;
			startY = this.position[1];
			t = Math.random() * MathConstants.TAU;
			shadow : ShadowEntity;
			terrainInfo : TerrainInfo;
		
			override update(dt : number) {
		
				this.t = (this.t + dt * 2) % MathConstants.TAU;
				const y = this.startY + (this.rock ? 300 : 200) + Math.cos(this.t) * 150;
				this.position[1] = y;
				this.updateMatrix();
				this.shadow.updateShadow(this.terrainInfo, y);
		
				super.update(dt);
		
				if (this.rock){
					vec3.set(this.rock.position, 10, -10, 80);
					vec3.transformMat4(this.rock.position, this.rock.position, this.getBoneTransform(3));
					vec3.transformMat4(this.rock.position, this.rock.position, this.modelMatrix);
					this.rock.updateMatrix();
				}
			}
		};
		

		const hasRock = (def.param3 & (1<<1)) !== 0;
		const ptera = new PteranodonEntity(assets.skeletons.Ptera!, [def.x, def.y, def.z], null, 1, hasRock ? 2 : 0, false);
		ptera.terrainInfo = assertExists(assets.terrainInfo, "terrainInfo missing!");
		ptera.startY = def.y;
		ptera.animationController.animSpeed = Math.random() * 0.5 + 1;
		const shadow = new ShadowEntity(assets.terrainInfo, assets.models.Global_Models[1], ptera, def.y, 4, 4.5);
		shadow.isDynamic = true;
		ptera.shadow = shadow;
		const results : Entity[] = [ptera, shadow];
		if (hasRock) {
			const rock = new Entity(assets.models.Level1_Models[9], [def.x, def.y, def.z], 0, 0.4, false);
			rock.isDynamic = true;
			ptera.rock = rock;
			results.push(rock);
		}
		return results;
	},
	function spawnStegosaurus(def, assets){ // 8
		const stego = new AnimatedEntity(assets.skeletons.Stego!, [def.x, def.y, def.z], null, 1.4, 1, true);
		return [stego, new ShadowEntity(assets.terrainInfo, assets.models.Global_Models[1], stego, def.y, 5, 5*2)];
	},
	function spawnTimePortal(def, assets){ // 9

		class TimePortalRingEntity extends Entity {
			startY = this.position[1];
			t = 0;
			override alwaysUpdate = true;
			override update(dt : number){
				this.t = (this.t + dt) % 2.7;
				if (this.t <= 0.8){
					const scale = 5 - this.t * 5;
					this.scale.fill(scale);
					this.position[1] = this.startY + this.t * 20;
					this.opacity = (5 - scale) / 4;
				} else {
					const t = this.t - 0.8;
					this.scale.fill(1);
					// dy += 250dt
					// y += dy
					this.position[1] = this.startY + t * t * 125 + t * 50 + 16;
					this.opacity = Math.max(0, 1 - t * 0.6);
				}
				this.updateMatrix();
			}
		};

		const results : Entity[] = [];
		for (let i = 0; i < 9; ++i){
			const ring = new TimePortalRingEntity(assets.models.Global_Models[10], [def.x, def.y + 15, def.z], 0, 5, false);
			ring.startY = ring.position[1];
			ring.t = i * 0.3;
			results.push(ring);
		}
		return results;
	},
	function spawnTree(def, assets){ // 10
		const treeScales = [
			1,   // fern
			1.1, // stickpalm
			1.0, // bamboo
			4.0, // cypress,
			1.2, // main palm
			1.3, // pine palm
		] as const;
		const treeIndex = def.param0;
		assert(treeIndex >=0 && treeIndex <= 5, "tree type out of range");
		return new Entity(assets.models.Level1_Models[16 + treeIndex], [def.x, def.y, def.z], null, treeScales[treeIndex] + Math.random() * 0.5, true);
	},
	function spawnBoulder(def, assets){ // 11
		return new Entity(assets.models.Level1_Models[8], [def.x, def.y - 10, def.z], null, 1 + Math.random(), true);
	},
	function spawnMushroom(def, assets){ //12
		return new Entity(assets.models.Level1_Models[10], [def.x, def.y, def.z], null, 1 + Math.random(), false);
	},
	function spawnBush(def, assets){ // 13
		const bush = new Entity(assets.models.Level1_Models[11], [def.x, def.y, def.z], null, 4.2, true);
		if (def.param3 & 1){
			const results : Entity[] = spawnTriceratops(def, assets);
			results.push(bush);
			return results;
		}
		return bush;
	},
	function spawnWater(def, assets){ // 14
		// todo translucency and stuff
		const x = Math.floor(def.x / 140) * 140 + 140/2
		const z = Math.floor(def.z / 140) * 140 + 140/2
		const y = (def.param3 & 1) ? def.y + 50 : 210;

		const result = new UndulateEntity(assets.models.Level1_Models[2], [x,y,z], 0, 2, false);
		//result.t = 1;
		result.period = 3;
		result.amplitude = 0.5;
		result.baseScale = 0.501;
		return result;
	},
	function spawnCrystal(def, assets){ // 15
		const crystalMeshIndices = [12, 13, 14];
		const type = def.param0;
		assert(type >= 0 && type <= 2, "crystal type out of range");
		// todo: y coord quick
		return new Entity(assets.models.Level1_Models[crystalMeshIndices[type]], [def.x, def.y, def.z], 0, 1.5 + Math.random(), false);
	},
	function spawnSpitter(def, assets){ // 16
		const spitter = new AnimatedEntity(assets.skeletons.Diloph!, [def.x, def.y, def.z], null, 0.8, 0, false);
		return [spitter, new ShadowEntity(assets.terrainInfo, assets.models.Global_Models[1], spitter, def.y, 1.6, 1.6*2.5)];
	},
	function spawnStepStone(def, assets){ // 17
		// todo: quick y
		const LAVA_Y_OFFSET = 50 / 2;
		return new Entity(assets.models.Level1_Models[23], [def.x, def.y + LAVA_Y_OFFSET, def.z], 0, 1, false);
	},
	function spawnRollingBoulder(def, assets){ // 18
		const scale = 3;
		// todo: roll
		return new Entity(assets.models.Level1_Models[9], [def.x, def.y + 30 * scale, def.z], null, scale, false);
	},
	function spawnSporePod(def, assets){ // 19
		const result = new UndulateEntity(assets.models.Level1_Models[24], [def.x, def.y, def.z], 0, 0.5, false);
		result.baseScale = result.scale[1];
		result.amplitude = 0.1;
		result.period = 2.5;
		return result;
	},
	// main menu stuff
	function spawnMenuBackground(def, assets){ // 20

		const eggModel = assets.models.MenuInterface[4];

		class EggEntity extends Entity {
			override alwaysUpdate = true;
			override update(dt : number) : false | void {
				this.rotX += dt;
				this.rotation += dt;
				this.rotZ += dt;
				this.position[1] -= dt * 70;
				if (this.position[1] < -250)
					return false;
				this.updateMatrix();
			}
		}

		class EggSpawnerEntity extends Entity{
			t = 0;
			override alwaysUpdate = true;

			override update(dt : number) : EggEntity | void{

				this.rotation = (this.rotation + dt) % MathConstants.TAU;
				this.updateMatrix();

				this.t += dt;
				if (this.t > 0.2){
					this.t %= 0.2;

					const pos : vec3 = [
						(Math.random() - 0.5) * 700,
						400,
						(Math.random() - 0.5) * 700 + 150
					];
					const egg = new EggEntity(eggModel, pos, null, 1, false);
					egg.rotX = Math.random() * Math.PI;
					egg.rotZ = Math.random() * Math.PI;
					return egg;
				}
			}
		};

		const result = new EggSpawnerEntity(assets.models.MenuInterface[5], [def.x, def.y, def.z], def.rot ?? 0, def.scale ?? 1, false);
		result.scale[1] *= 0.5;
		return result;
	},
	function spawnOptionsIcon(def, assets){ // 21
		return new Entity(assets.models.MenuInterface[1], [def.x, def.y, def.z], def.rot ?? 0, def.scale ?? 1, false);
	},
	function spawnInfoIcon(def, assets){ // 22
		return new Entity(assets.models.MenuInterface[2], [def.x, def.y, def.z], def.rot ?? 0, def.scale ?? 1, false);
	},
	function spawnQuitIcon(def, assets){ // 23
		return new Entity(assets.models.MenuInterface[0], [def.x, def.y, def.z], def.rot ?? 0, def.scale ?? 1, false);
	},
	function spawnHighScoresIcon(def, assets){ // 24
		return new Entity(assets.models.MenuInterface[3], [def.x, def.y, def.z], def.rot ?? 0, def.scale ?? 1, false);
	},
	// title stuff
	function spawnPangeaLogo(def, assets){ // 25
		class LogoEntity extends Entity {
			t = 0;
			startZ = this.position[2];
			override alwaysUpdate = true;
			override update(dt: number): EntityUpdateResult {
				this.t = (this.t + dt) % 10;
				this.position[2] = this.startZ + this.t * 45;
				this.rotation = Math.PI * -0.5 + this.t * Math.PI / 9;
				this.rotX = Math.sin(this.t * 1.5) * 0.3;
				this.updateMatrix();
			}
		}
		return new LogoEntity(assets.models.Title[1], [def.x, def.y, def.z], 0, def.scale ?? 0.2, false);
	},
	function spawnGameName(def, assets){ // 26
		class WobbleEntity extends Entity{
			t = 0;
			override rotX = -0.3;
			override update(dt : number){
				this.t = (this.t + dt * 1.8) % MathConstants.TAU;
				this.rotation = 0.3 + Math.sin(this.t) * 0.3;
				this.updateMatrix();
			}
		}
		return new WobbleEntity(assets.models.Title[0], [def.x, def.y, def.z], 0, def.scale ?? 1, false);
	},
	function spawnTitleBackround(def, assets){ //27
		class TitleBackgroundEntity extends Entity {
			override alwaysUpdate = true;
			override update(dt : number){
				this.position[0] -= dt * 65;
				while (this.position[0] < -600*2.6){
					this.position[0] += 300*2.6*3
				}
				this.updateMatrix();
			}
		}
		return new TitleBackgroundEntity(assets.models.Title[2], [def.x, def.y, def.z], def.rot ?? 0, def.scale ?? 1, false);
	},
	// high scores stuff
	function spawnSpiral(def, assets) { // 28
		class SpiralEntity extends Entity {
			override update(dt: number): EntityUpdateResult {
				this.rotX += dt * 1.5;
				this.updateMatrix();
			}
		}
		return new SpiralEntity(assets.models.HighScores[45], [def.x, def.y, def.z], def.rot ?? 0, def.scale ?? 1, false);
	},
	function spawnLetter(def, assets) { //29 
		return new Entity(assets.models.HighScores[def.param0], [def.x, def.y, def.z], 0, 1, false);
	},
];
export function invalidEntityType(def : LevelObjectDef, assets : NanosaurProcessedAssets) {
	console.log("invalid object type", def);
}
