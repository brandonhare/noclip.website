import { mat4, vec3 } from "gl-matrix";
import ArrayBufferSlice from "../ArrayBufferSlice";
import { Endianness } from "../endian";
import { AABB } from "../Geometry";
import { GfxWrapMode } from "../gfx/platform/GfxPlatform";
import { GfxFormat } from "../gfx/platform/GfxPlatformFormat";
import { MathConstants } from "../MathHelpers";
import { assert } from "../util";
import { Qd3DMesh, swizzle1555Pixels, Qd3DTexture } from "./QuickDraw3D";

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
}

export type LevelObjectDef = {
	x : number,
	y : number, // terrain height
	z : number,
	type : ObjectType,
	param0 : number,
	//param1 : number, // unused
	//param2 : number, // unused
	param3 : number,
	//flags : number,  // unused

	// main menu hack
	rot? : number,
	scale? : number,
};

export function createMenuObjectList() : LevelObjectDef[] {
	
	const result : LevelObjectDef[] = [
		{
			type : ObjectType.MenuBackground,
			x : 0,
			y : 0,
			z : 0,
			param0:0,
			param3:0,
		}
	];
	for (let i = 0; i < 4; ++i){
		const angle = MathConstants.TAU * 5 / i;
		result.push({
			type : ObjectType.MenuBackground + i,
			x : Math.sin(angle) * 310,
			y : 0,
			z : Math.cos(angle) * 310 - 5,
			param0:0,
			param3:0,
			rot : angle,
		});
	}
	result[1].type = ObjectType.Player;
	result[1].scale = 0.8;
	return result;
}

export function parseTerrain(terrainBuffer: ArrayBufferSlice, pixelBuffer: ArrayBufferSlice): [Qd3DMesh, LevelObjectDef[]] {

	const SUPERTILE_SIZE = 5; // tiles per supertile axis
	const TERRAIN_POLYGON_SIZE = 140; // world units of terrain polygon
	const OREOMAP_TILE_SIZE = 32; // pixels w/h of texture tile
	const TERRAIN_HMTILE_SIZE = 32; // pixel w/h of heightmap
	const MAP_TO_UNIT_VALUE = TERRAIN_POLYGON_SIZE / OREOMAP_TILE_SIZE;
	const TERRAIN_SUPERTILE_UNIT_SIZE = SUPERTILE_SIZE * TERRAIN_POLYGON_SIZE; // world unit size of a supertile
	const HEIGHT_SCALE = 4;

	const view = terrainBuffer.createDataView();

	const textureLayerOffset = view.getUint32(0);
	const heightmapLayerOffset = view.getUint32(4);
	const pathLayerOffset = view.getUint32(8);
	const objectListOffset = view.getUint32(12);
	const heightmapTilesOffset = view.getUint32(20);
	const terrainWidth = view.getUint16(28); // in tiles
	const terrainDepth = view.getUint16(30); // in tiles
	const textureAttributesOffset = view.getUint32(32);
	const tileAnimDataOffset = view.getUint32(36);

	// gTerrainTextureLayer
	const textureLayerData = terrainBuffer.createTypedArray(Uint16Array, textureLayerOffset, terrainWidth * terrainDepth, Endianness.BIG_ENDIAN);
	assert(heightmapLayerOffset > 0, "no heightmap data!");
	// gTerrainHeightmapLayer
	const heightmapLayerData = terrainBuffer.createTypedArray(Uint16Array, heightmapLayerOffset, terrainWidth * terrainDepth, Endianness.BIG_ENDIAN);
	assert(pathLayerOffset > 0, "no path data!");
	// gTerrainPathLayer
	const pathLayerData = terrainBuffer.createTypedArray(Uint16Array, pathLayerOffset, terrainWidth * terrainDepth, Endianness.BIG_ENDIAN);

	// texture attributes
	const numTextureAttributes = (tileAnimDataOffset - textureAttributesOffset) / 8; // hack from source port
	type TileAttribute = {
		bits: number;
		param0: number;
		param1: number;
		param2: number;
	};
	// gTileAttributes
	const tileAttributes: TileAttribute[] = [];
	for (let i = 0; i < numTextureAttributes; ++i) {
		tileAttributes.push({
			bits: view.getUint16(textureAttributesOffset + i * 8 + 0),
			param0: view.getInt16(textureAttributesOffset + i * 8 + 2),
			param1: view.getUint8(textureAttributesOffset + i * 8 + 4),
			param2: view.getUint8(textureAttributesOffset + i * 8 + 5),
		});
	}


	assert(heightmapTilesOffset > 0, "no heightmap tile data!");
	const numHeightmapTiles = ((textureAttributesOffset - heightmapTilesOffset) / (32 * 32)) & 0x0FFF;
	// gTerrainHeightMapPtrs
	const heightmapTiles = terrainBuffer.createTypedArray(Uint8Array, heightmapTilesOffset, numHeightmapTiles * 32 * 32);


	function getTerrainHeightAtRowCol(row: number, col: number): number {
		if (row < 0 || col < 0 || row >= terrainDepth || col >= terrainWidth)
			return 0;

		const tile = heightmapLayerData[row * terrainWidth + col];
		assert(tile != undefined, "missing heightmap layer tile");
		const tileNum = tile & 0x0FFF;
		const flipX = tile & (1 << 15);
		const flipY = tile & (1 << 14);

		const x = flipX ? TERRAIN_HMTILE_SIZE - 1 : 0;
		const y = flipY ? TERRAIN_HMTILE_SIZE - 1 : 0;

		const height = heightmapTiles[tileNum * TERRAIN_HMTILE_SIZE * TERRAIN_HMTILE_SIZE + y * TERRAIN_HMTILE_SIZE + x];
		assert(height != undefined, "missing heightmap tile");
		return height; //* HEIGHT_SCALE; // extrude factor
	}



	// create verts
	const numVertices = (terrainWidth + 1) * (terrainDepth + 1);
	const vertices = new Uint16Array(numVertices * 3);
	const stride = (terrainWidth + 1) * 3;

	function vertIndex(row: number, col: number) {
		return row * stride + col * 3;
	}

	let maxHeight = 0;
	for (let row = 0; row <= terrainDepth; row++) {
		const z = row; //* TERRAIN_POLYGON_SIZE;
		for (let col = 0; col <= terrainWidth; ++col) {
			const x = col; //* TERRAIN_POLYGON_SIZE;
			const y = getTerrainHeightAtRowCol(row, col);
			let index = vertIndex(row, col);
			vertices[index++] = x;
			vertices[index++] = y;
			vertices[index++] = z;
			if (y > maxHeight) maxHeight = y;
		}
	}

	const normals = new Float32Array(numVertices * 3);
	let vec: vec3 = [0, 0, 0];
	for (let row = 0; row <= terrainDepth; row++) {
		for (let col = 0; col <= terrainWidth; ++col) {
			const index = vertIndex(row, col);
			//const centerHeight = verts[index + 1];
			const leftHeight = col === 0 ? 0 : vertices[index - 2];
			const rightHeight = col === terrainWidth ? 0 : vertices[index + 4];
			const backHeight = row === 0 ? 0 : vertices[index - stride + 1];
			const frontHeight = row === terrainDepth ? 0 : vertices[index + stride + 1];

			vec3.normalize(vec, [(leftHeight - rightHeight) * 0.1 * HEIGHT_SCALE, 1, (backHeight - frontHeight) * 0.1 * HEIGHT_SCALE]);
			normals.set(vec, index);
		}
	}


	const stride2 = terrainWidth + 1;

	// textures
	const tilemapIds = new Uint16Array(numVertices);
	let maxTextureIndex = 0;
	for (let row = 0; row <= terrainDepth; row++) {
		for (let col = 0; col <= terrainWidth; ++col) {
			const terrainId = textureLayerData[row * terrainWidth + col] ?? 0;
			maxTextureIndex = Math.max(maxTextureIndex, terrainId & 0xFFF);
			tilemapIds[row * stride2 + col] = terrainId;
		}
	}


	function getSlope(baseIndex: number) {
		const h1 = vertices[baseIndex * 3 + 1];
		const h2 = vertices[(baseIndex + 1) * 3 + 1];
		const h3 = vertices[(baseIndex + stride2 + 1) * 3 + 1];
		const h4 = vertices[(baseIndex + stride2) * 3 + 1];

		return Math.abs(h1 - h3) - Math.abs(h2 - h4);
	}
	function needsFlip(row: number, col: number) {
		if (row === terrainDepth || col === terrainWidth)
			return true;
		return getSlope(row * stride2 + col) > 0;
	}

	function getExactHeight(x : number, z : number): number {
		const row = Math.floor(z);
		const col = Math.floor(x);
		x %= 1;
		z %= 1;
		const baseIndex = row * stride2 + col;
		
		// (col, row)
		let h1 = vertices[baseIndex * 3 + 1];
		// (col+1, row)
		let h2 = vertices[(baseIndex + 1) * 3 + 1];
		// (col+1, row+1)
		let h3 = vertices[(baseIndex + stride2 + 1) * 3 + 1];
		// (col, row+1)
		let h4 = vertices[(baseIndex + stride2) * 3 + 1];

		const needsFlip = Math.abs(h1 - h3) - Math.abs(h2 - h4) > 0;
		if (!needsFlip){
			x = 1 - x;
			let temp = h1;
			h1 = h2;
			h2 = temp;
			temp = h4;
			h4 = h3;
			h3 = temp;
		}

		if (x + z > 1){
			// reflect
			h1 = h3;
			let temp = x;
			x = 1 - z;
			z = 1 - temp;
		}

		// barycentric between h1,h2,h4
		return h1 * (1 - x - z) + h2 * x + h4 * z;
	}


	// load objects
	const numObjects = view.getUint32(objectListOffset);
	const objects: LevelObjectDef[] = [];
	for (let offset = objectListOffset + 4; offset < objectListOffset + 4 + 20 * numObjects; offset += 20) {
		const x = view.getUint16(offset);
		const z = view.getUint16(offset + 2);
		const type = view.getUint16(offset + 4);
		const param0 = view.getUint8(offset + 6);
		const param1 = view.getUint8(offset + 7);
		const param2 = view.getUint8(offset + 8);
		const param3 = view.getUint8(offset + 9);
		const flags = view.getUint16(offset + 10);
		//const nextId = view.getUint16(offset + 12);
		//const prevId = view.getUint16(offset + 16);
		const y = getExactHeight(x / OREOMAP_TILE_SIZE, z / OREOMAP_TILE_SIZE) * HEIGHT_SCALE;
		objects.push({ x: x * MAP_TO_UNIT_VALUE, y, z: z * MAP_TO_UNIT_VALUE, type, param0, /*param1,param2,flags,*/ param3 });
	}


	const numTriangles = terrainWidth * terrainDepth * 2;
	const indices = new Uint32Array(numTriangles * 3);
	let index = 0;

	const needsTextureReplacement = new Map<number, number>();
	const needsNewVert = new Map<number, number>();
	const flipped = new Set<number>();

	/*
	for (let row = 0; row <= terrainDepth; ++row)
		flipped.add(row * stride2 + terrainWidth);
	for (let col = 0; col <= terrainWidth; ++col)
		flipped.add(terrainDepth * stride2 + col);
	*/
	for (let row = 0; row < terrainDepth; row++) {
		for (let col = 0; col < terrainWidth; ++col) {
			const baseIndex = row * stride2 + col;

			const textureData = tilemapIds[baseIndex];

			if (needsFlip(row, col)) {

				flipped.add(baseIndex);

				if (needsFlip(row, col + 1) && (needsTextureReplacement.get(baseIndex + 1) ?? textureData) === textureData) {
					indices[index++] = baseIndex;
					indices[index++] = baseIndex + stride2;
					indices[index++] = baseIndex + 1;

					indices[index++] = baseIndex + stride2;
					indices[index++] = baseIndex + stride2 + 1;
					indices[index++] = baseIndex + 1;
					needsTextureReplacement.set(baseIndex + 1, textureData);
				} else if (needsFlip(row + 1, col) && (needsTextureReplacement.get(baseIndex + stride2) ?? textureData) === textureData) {
					indices[index++] = baseIndex + 1;
					indices[index++] = baseIndex;
					indices[index++] = baseIndex + stride2;

					indices[index++] = baseIndex + stride2 + 1;
					indices[index++] = baseIndex + 1;
					indices[index++] = baseIndex + stride2;
					needsTextureReplacement.set(baseIndex + stride2, textureData);
				} else {
					// special
					needsNewVert.set(baseIndex, textureData);
				}
			} else { // normal

				indices[index++] = baseIndex + stride2;
				indices[index++] = baseIndex + stride2 + 1;
				indices[index++] = baseIndex;

				indices[index++] = baseIndex + stride2 + 1;
				indices[index++] = baseIndex + 1;
				indices[index++] = baseIndex;

			}
		}
	}

	needsTextureReplacement.forEach((texture, baseIndex) => {
		//assert(flipped.has(baseIndex), `${Math.floor(baseIndex / stride2)} ${baseIndex % stride2}`);
		tilemapIds[baseIndex] = texture;
	});

	const newVerts: number[] = [];
	const newVertTextures: number[] = [];
	let newVertIndex = numVertices;

	while (needsNewVert.size > 0) {
		needsNewVert.forEach((texture, baseIndex) => {
			const downLeftBaseIndex = baseIndex + stride2 - 1;
			const upRightBaseIndex = baseIndex - stride2 + 1;
			const downLeftTexShared = needsNewVert.get(downLeftBaseIndex) == texture;
			const upRightTexShared = needsNewVert.get(upRightBaseIndex) == texture;
			if (downLeftTexShared && upRightTexShared) {
				return;
			}

			if (downLeftTexShared) {
				newVerts.push(baseIndex + stride2);
				indices[index++] = baseIndex + 1;
				indices[index++] = baseIndex;
				//indices[index++] = baseIndex + stride2;
				indices[index++] = newVertIndex;

				indices[index++] = baseIndex + stride2 + 1;
				indices[index++] = baseIndex + 1;
				//indices[index++] = baseIndex + stride2;
				indices[index++] = newVertIndex;

				// other vert
				indices[index++] = downLeftBaseIndex;
				indices[index++] = downLeftBaseIndex + stride2;
				//indices[index++] = downLeftBaseIndex + 1;
				indices[index++] = newVertIndex;

				indices[index++] = downLeftBaseIndex + stride2;
				indices[index++] = downLeftBaseIndex + stride2 + 1;
				//indices[index++] = downLeftBaseIndex + 1;
				indices[index++] = newVertIndex;
				needsNewVert.delete(downLeftBaseIndex);
			} else {
				newVerts.push(baseIndex + 1);

				indices[index++] = baseIndex;
				indices[index++] = baseIndex + stride2;
				//indices[index++] = baseIndex + 1;
				indices[index++] = newVertIndex;

				indices[index++] = baseIndex + stride2;
				indices[index++] = baseIndex + stride2 + 1;
				//indices[index++] = baseIndex + 1;
				indices[index++] = newVertIndex;

				if (upRightTexShared) {
					// other vert
					indices[index++] = upRightBaseIndex + 1;
					indices[index++] = upRightBaseIndex;
					//indices[index++] = baseIndex + stride2;
					indices[index++] = newVertIndex;

					indices[index++] = upRightBaseIndex + stride2 + 1;
					indices[index++] = upRightBaseIndex + 1;
					//indices[index++] = baseIndex + stride2;
					indices[index++] = newVertIndex;
					needsNewVert.delete(upRightBaseIndex);
				}
			}
			newVertIndex++;
			newVertTextures.push(texture);
			needsNewVert.delete(baseIndex);
		});
		break;
	}


	// add new verts
	const oldNumVerts = numVertices;
	const newNumVertices = numVertices + newVerts.length;
	const newVertices = new Uint16Array(newNumVertices * 3);
	const newNormals = new Float32Array(newNumVertices * 3);
	const newTilemapIds = new Uint16Array(newNumVertices);
	for (let i = 0; i < oldNumVerts; ++i) {
		for (let j = i * 3; j < (i + 1) * 3; ++j) {
			newVertices[j] = vertices[j];
			newNormals[j] = normals[j];
		}
		newTilemapIds[i] = tilemapIds[i];
	}
	for (let i = 0; i < newVerts.length; ++i) {
		const newVertBaseIndex = newVerts[i];
		const newVertTexture = newVertTextures[i];
		for (let j = 0; j < 3; ++j) {
			newVertices[oldNumVerts * 3 + i * 3 + j] = vertices[newVertBaseIndex * 3 + j];
			newNormals[oldNumVerts * 3 + i * 3 + j] = normals[newVertBaseIndex * 3 + j];
		}
		newTilemapIds[oldNumVerts + i] = newVertTexture;
	}


	// todo: optimize mesh to get vertex indices back to a u16?
	// todo: don't duplicate all the vertex arrays
	// todo: move the new verts to be inline with the face's other verts instead of at the end
	// debug: create heightmap textures
	/*
	const heightmapTextures : Qd3DTexture[] = [];
	for (let i = 0; i < numHeightmapTiles; ++i){
		const texture = new Texture();
		texture.pixels = heightmapTiles.slice(i *32*32, (i+1)* 32*32);
		for (let j = 0; j < texture.pixels.length; ++j)
			texture.pixels[j] |= 1;
		texture.pixelFormat = GfxFormat.U8_R_NORM,
		texture.hasAlpha = false;
		texture.height = 32;
		texture.width = 32;
		texture.name = `Heightmap Tile ${i}`
		heightmapTextures.push(texture);
	}
	*/
	const numTexturesInFile = pixelBuffer.createDataView().getUint32(0);
	assert(numTexturesInFile >= maxTextureIndex);
	const numTextures = maxTextureIndex + 1;
	const terrainPixels = pixelBuffer.createTypedArray(Uint16Array, 4, 32 * 32 * numTextures, Endianness.BIG_ENDIAN);
	swizzle1555Pixels(terrainPixels, false);

	const texture: Qd3DTexture = {
		width: 32,
		height: 32,
		numTextures,
		pixelFormat: GfxFormat.U16_RGBA_5551,
		hasAlpha: false,
		wrapU: GfxWrapMode.Mirror,
		wrapV: GfxWrapMode.Mirror,
		pixels: terrainPixels,
	};

	const result: Qd3DMesh = {
		numTriangles,
		numVertices,
		aabb : new AABB(0, 0, 0, terrainWidth * TERRAIN_POLYGON_SIZE, maxHeight * HEIGHT_SCALE, terrainDepth * TERRAIN_POLYGON_SIZE),
		colour: { r: 1, g: 1, b: 1, a: 1 },
		texture,
		baseTransform: mat4.fromScaling(mat4.create(), [TERRAIN_POLYGON_SIZE, HEIGHT_SCALE, TERRAIN_POLYGON_SIZE]),
		indices,
		vertices: newVertices,
		normals: newNormals,
		tilemapIds: newTilemapIds,
	};

	return [result, objects];
}
