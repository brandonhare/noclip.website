import { mat4 } from "gl-matrix";
import ArrayBufferSlice from "../ArrayBufferSlice";
import { Endianness } from "../endian";
import { AABB } from "../Geometry";
import { GfxWrapMode } from "../gfx/platform/GfxPlatform";
import { GfxFormat } from "../gfx/platform/GfxPlatformFormat";
import { assert } from "../util";

import { LevelObjectDef } from "./entity";
import { AlphaType, Qd3DMesh, Qd3DTexture, swizzle1555Pixels } from "./QuickDraw3D";
import { convertTilemapFlips, createIndices, createNormalsFromHeightmap, createTilemapIds, createVerticesFromHeightmap, TerrainInfo } from "./terrain";

function createHeightmap(heightmapIndices : Uint16Array, heightmapTiles : Uint8Array, tileSize : number, width : number, height : number) : Uint8Array {
	const heightmap = new Uint8Array((width + 1) * (height + 1));

	const stride = width + 1;

	for (let row = 0; row < height; ++row){
		for (let col = 0; col < width; ++col){
			const tile = heightmapIndices[row * width + col];
			const tileIndex = tile & 0xFFF;
			const x = (tile & (1 << 15)) ? tileSize - 1 : 0; // flip x
			const y = (tile & (1 << 14)) ? tileSize - 1 : 0; // flip y
			const height = heightmapTiles[tileIndex * tileSize * tileSize + y * tileSize + x];
			assert(height !== undefined, "missing heightmap tile!");
			heightmap[row * stride + col] = height;
		}
	}

	return heightmap;
}

export type NanosaurParseTerrainResult = [Qd3DMesh, TerrainInfo, LevelObjectDef[]];
export function parseTerrain(terrainBuffer: ArrayBufferSlice, pixelBuffer: ArrayBufferSlice): [Qd3DMesh, TerrainInfo, LevelObjectDef[]] {

	const TERRAIN_POLYGON_SIZE = 140; // world units of terrain polygon
	const OREOMAP_TILE_SIZE = 32; // pixels w/h of texture tile
	const TERRAIN_HMTILE_SIZE = 32; // pixel w/h of heightmap
	const MAP_TO_UNIT_VALUE = TERRAIN_POLYGON_SIZE / OREOMAP_TILE_SIZE;
	//const SUPERTILE_SIZE = 5; // tiles per supertile axis
	//const TERRAIN_SUPERTILE_UNIT_SIZE = SUPERTILE_SIZE * TERRAIN_POLYGON_SIZE; // world unit size of a supertile
	const HEIGHT_SCALE = 4;

	const view = terrainBuffer.createDataView();

	const textureLayerOffset = view.getUint32(0);
	const heightmapLayerOffset = view.getUint32(4);
	//const pathLayerOffset = view.getUint32(8);
	const objectListOffset = view.getUint32(12);
	const heightmapTilesOffset = view.getUint32(20);
	const terrainWidth = view.getUint16(28); // in tiles
	const terrainDepth = view.getUint16(30); // in tiles
	const textureAttributesOffset = view.getUint32(32);
	//const tileAnimDataOffset = view.getUint32(36);

	const textureLayerData = terrainBuffer.createTypedArray(Uint16Array, textureLayerOffset, terrainWidth * terrainDepth, Endianness.BIG_ENDIAN);
	assert(heightmapLayerOffset > 0, "no heightmap data!");
	const heightmapLayerData = terrainBuffer.createTypedArray(Uint16Array, heightmapLayerOffset, terrainWidth * terrainDepth, Endianness.BIG_ENDIAN);
	

	assert(heightmapTilesOffset > 0, "no heightmap tile data!");
	const heightmapTileBytes = (textureAttributesOffset - heightmapTilesOffset);
	const heightmapTiles = terrainBuffer.createTypedArray(Uint8Array, heightmapTilesOffset, heightmapTileBytes);


	convertTilemapFlips(textureLayerData);

	const heightmap = createHeightmap(heightmapLayerData, heightmapTiles, TERRAIN_HMTILE_SIZE, terrainWidth, terrainDepth);
	let minY = Infinity;
	let maxY = -Infinity;
	for (const height of heightmap){
		if (height < minY) minY = height;
		if (height > maxY) maxY = height;
	}

	const terrainInfo = new TerrainInfo(terrainWidth, terrainDepth, heightmap, TERRAIN_POLYGON_SIZE, HEIGHT_SCALE);


	// textures
	const numVerticesBase = (terrainWidth + 1) * (terrainDepth + 1);

	const replacedTextures = new Map<number, number>(); // filled by createIndices
	const duplicatedVerts : number[] = []; // filled by createIndices
	const indices = createIndices(heightmap, textureLayerData, terrainWidth, terrainDepth, false, replacedTextures, duplicatedVerts);

	const numVerts = (terrainWidth + 1) * (terrainDepth + 1) + duplicatedVerts.length;
	
	// fill vertex buffers
	const vertices = new Uint16Array(numVerts * 3); // filled by createVerticesFromHeightmap
	createVerticesFromHeightmap(vertices, heightmap, terrainWidth, terrainDepth);
	const tilemapIds = new Uint16Array(numVerts); // filled by createTilemapIds
	const maxTextureIndex = createTilemapIds(tilemapIds, textureLayerData, terrainWidth, terrainDepth);
	const normals = new Float32Array(numVerts * 3); // filled by createNormalsFromHeightmap
	createNormalsFromHeightmap(normals, heightmap, terrainWidth, terrainDepth, false, TERRAIN_POLYGON_SIZE, HEIGHT_SCALE); // todo check scales
	
	// copy duplicated verts over
	for (let i = 0; i < duplicatedVerts.length; ++i){
		const srcIndex = duplicatedVerts[i];
		const destIndex = numVerticesBase + i;
		const srcIndex3 = srcIndex * 3;
		const destIndex3 = destIndex * 3;

		tilemapIds[destIndex] = tilemapIds[srcIndex];
		for (let j = 0; j < 3; ++j){
			vertices[destIndex3 + j] = vertices[srcIndex3 + j];
			normals[destIndex3 + j] = normals[srcIndex3 + j];
		}
	}

	// replace textures
	replacedTextures.forEach((newTile, vertexIndex)=>{
		tilemapIds[vertexIndex] = newTile;
	});


	
	// load textures
	const numTexturesInFile = pixelBuffer.createDataView().getUint32(0);
	assert(numTexturesInFile >= maxTextureIndex);
	const numTextures = Math.max(maxTextureIndex + 1, 256); // include the last 2 extra ones for fun
	const terrainPixels = pixelBuffer.createTypedArray(Uint16Array, 4, 32 * 32 * numTextures, Endianness.BIG_ENDIAN);
	swizzle1555Pixels(terrainPixels, false);
	const texture: Qd3DTexture = {
		width: 32,
		height: 32,
		numTextures,
		pixelFormat: GfxFormat.U16_RGBA_5551,
		alpha: AlphaType.Opaque,
		wrapU: GfxWrapMode.Mirror,
		wrapV: GfxWrapMode.Mirror,
		pixels: terrainPixels,
	};


	// load objects
	const numObjects = view.getUint32(objectListOffset);
	const objects: LevelObjectDef[] = [];
	for (let offset = objectListOffset + 4; offset < objectListOffset + 4 + 20 * numObjects; offset += 20) {
		const x = view.getUint16(offset) * MAP_TO_UNIT_VALUE;
		const z = view.getUint16(offset + 2) * MAP_TO_UNIT_VALUE;
		const y = terrainInfo.getHeight(x, z);
		const type = view.getUint16(offset + 4);
		const param0 = view.getUint8(offset + 6);
		const param1 = view.getUint8(offset + 7);
		const param2 = view.getUint8(offset + 8);
		const param3 = view.getUint8(offset + 9);
		const flags = view.getUint16(offset + 10);
		//const nextId = view.getUint16(offset + 12);
		//const prevId = view.getUint16(offset + 16);
		objects.push({ x, y, z: z, type, param0, param1, param2, param3, flags });
	}


	const terrainMesh: Qd3DMesh = {
		numTriangles : terrainWidth * terrainDepth * 2,
		numVertices: numVerts,
		aabb : new AABB(0, minY * HEIGHT_SCALE, 0, terrainWidth * TERRAIN_POLYGON_SIZE, maxY * HEIGHT_SCALE, terrainDepth * TERRAIN_POLYGON_SIZE),
		colour: { r: 1, g: 1, b: 1, a: 1 },
		texture,
		baseTransform: mat4.fromScaling(mat4.create(), [TERRAIN_POLYGON_SIZE, HEIGHT_SCALE, TERRAIN_POLYGON_SIZE]),
		indices,
		vertices: vertices,
		normals: normals,
		tilemapIds: tilemapIds,
	};
	return [terrainMesh, terrainInfo, objects];
}
