import { mat4, vec3 } from "gl-matrix";
import ArrayBufferSlice from "../ArrayBufferSlice";
import { Endianness } from "../endian";
import { AABB } from "../Geometry";
import { GfxWrapMode } from "../gfx/platform/GfxPlatform";
import { GfxFormat } from "../gfx/platform/GfxPlatformFormat";
import { assert } from "../util";

import { LevelObjectDef } from "./entity";
import { AlphaType, Qd3DMesh, Qd3DTexture, swizzle1555Pixels } from "./QuickDraw3D";
import { createNormalsFromHeightmap, createVerticesFromHeightmap, TerrainInfo, createIndices, createTilemapIds } from "./terrain";

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



	const heightmap = createHeightmap(heightmapLayerData, heightmapTiles, TERRAIN_HMTILE_SIZE, terrainWidth, terrainDepth);

	const terrainInfo = new TerrainInfo(terrainWidth, terrainDepth, heightmap, TERRAIN_POLYGON_SIZE, HEIGHT_SCALE);


	const seen = new Map<number, number>();

	// textures
	const numVerticesBase = (terrainWidth + 1) * (terrainDepth + 1);
	const stride = terrainWidth + 1;
	const vec3Stride = stride * 3;

	const numTriangles = terrainWidth * terrainDepth * 2;

	const replacedTextures : number[] = [];
	const duplicatedVerts : number[] = [];
	const indices = createIndices(heightmap, textureLayerData, terrainWidth, terrainDepth, replacedTextures, duplicatedVerts);

	const numVerts = (terrainWidth + 1) * (terrainDepth + 1) + duplicatedVerts.length;
	const vertices = new Uint16Array(numVerts * 3);
	const tilemapIds = new Uint16Array(numVerts);
	const normals = new Float32Array(numVerts * 3);

	// fill vertex buffers
	const maxTextureIndex = createTilemapIds(tilemapIds, textureLayerData, terrainWidth, terrainDepth);
	const maxHeight = createVerticesFromHeightmap(vertices, heightmap, terrainWidth, terrainDepth);
	createNormalsFromHeightmap(normals, heightmap, terrainWidth, terrainDepth, HEIGHT_SCALE);
	
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


	function oldTris(){


	// create verts
	const vertices = new Uint16Array(numVerticesBase * 3);

	function vertIndex(row: number, col: number) {
		return row * vec3Stride + col * 3;
	}

	let maxHeight = -Infinity;
	for (let row = 0; row <= terrainDepth; row++) {
		for (let col = 0; col <= terrainWidth; ++col) {
			let index = row * vec3Stride + col * 3;
			const height = heightmap[row * stride + col];
			vertices[index++] = col;
			vertices[index++] = height;
			vertices[index++] = row;
			if (height > maxHeight)
				maxHeight = height;
		}
	}

	const normals = new Float32Array(numVerticesBase * 3);
	let vec: vec3 = [0, 0, 0];
	for (let row = 0; row <= terrainDepth; row++) {
		for (let col = 0; col <= terrainWidth; ++col) {
			const index = vertIndex(row, col);
			//const centerHeight = verts[index + 1];
			const leftHeight = col === 0 ? 0 : vertices[index - 2];
			const rightHeight = col === terrainWidth ? 0 : vertices[index + 4];
			const backHeight = row === 0 ? 0 : vertices[index - vec3Stride + 1];
			const frontHeight = row === terrainDepth ? 0 : vertices[index + vec3Stride + 1];

			vec3.normalize(vec, [(leftHeight - rightHeight) * 0.1 * HEIGHT_SCALE, 1, (backHeight - frontHeight) * 0.1 * HEIGHT_SCALE]);
			normals.set(vec, index);
		}
	}





	function getSlope(baseIndex: number) {
		const h1 = vertices[baseIndex * 3 + 1];
		const h2 = vertices[(baseIndex + 1) * 3 + 1];
		const h3 = vertices[(baseIndex + stride + 1) * 3 + 1];
		const h4 = vertices[(baseIndex + stride) * 3 + 1];

		return Math.abs(h1 - h3) - Math.abs(h2 - h4);
	}
	function needsFlip(row: number, col: number) {
		if (row === terrainDepth || col === terrainWidth)
			return true;
		return getSlope(row * stride + col) > 0;
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
			const baseIndex = row * stride + col;

			const textureData = tilemapIds[baseIndex];

			if (needsFlip(row, col)) {

				flipped.add(baseIndex);

				if (needsFlip(row, col + 1) && (needsTextureReplacement.get(baseIndex + 1) ?? textureData) === textureData) {
					indices[index++] = baseIndex;
					indices[index++] = baseIndex + stride;
					indices[index++] = baseIndex + 1;

					indices[index++] = baseIndex + stride;
					indices[index++] = baseIndex + stride + 1;
					indices[index++] = baseIndex + 1;
					needsTextureReplacement.set(baseIndex + 1, textureData);
				} else if (needsFlip(row + 1, col) && (needsTextureReplacement.get(baseIndex + stride) ?? textureData) === textureData) {
					indices[index++] = baseIndex + 1;
					indices[index++] = baseIndex;
					indices[index++] = baseIndex + stride;

					indices[index++] = baseIndex + stride + 1;
					indices[index++] = baseIndex + 1;
					indices[index++] = baseIndex + stride;
					needsTextureReplacement.set(baseIndex + stride, textureData);
				} else {
					// special
					needsNewVert.set(baseIndex, textureData);
				}
			} else { // normal

				indices[index++] = baseIndex + stride;
				indices[index++] = baseIndex + stride + 1;
				indices[index++] = baseIndex;

				indices[index++] = baseIndex + stride + 1;
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
	let newVertIndex = numVerticesBase;

	while (needsNewVert.size > 0) {
		needsNewVert.forEach((texture, baseIndex) => {
			const downLeftBaseIndex = baseIndex + stride - 1;
			const upRightBaseIndex = baseIndex - stride + 1;
			const downLeftTexShared = needsNewVert.get(downLeftBaseIndex) == texture;
			const upRightTexShared = needsNewVert.get(upRightBaseIndex) == texture;
			if (downLeftTexShared && upRightTexShared) {
				return;
			}

			if (downLeftTexShared) {
				newVerts.push(baseIndex + stride);
				indices[index++] = baseIndex + 1;
				indices[index++] = baseIndex;
				//indices[index++] = baseIndex + stride2;
				indices[index++] = newVertIndex;

				indices[index++] = baseIndex + stride + 1;
				indices[index++] = baseIndex + 1;
				//indices[index++] = baseIndex + stride2;
				indices[index++] = newVertIndex;

				// other vert
				indices[index++] = downLeftBaseIndex;
				indices[index++] = downLeftBaseIndex + stride;
				//indices[index++] = downLeftBaseIndex + 1;
				indices[index++] = newVertIndex;

				indices[index++] = downLeftBaseIndex + stride;
				indices[index++] = downLeftBaseIndex + stride + 1;
				//indices[index++] = downLeftBaseIndex + 1;
				indices[index++] = newVertIndex;
				needsNewVert.delete(downLeftBaseIndex);
			} else {
				newVerts.push(baseIndex + 1);

				indices[index++] = baseIndex;
				indices[index++] = baseIndex + stride;
				//indices[index++] = baseIndex + 1;
				indices[index++] = newVertIndex;

				indices[index++] = baseIndex + stride;
				indices[index++] = baseIndex + stride + 1;
				//indices[index++] = baseIndex + 1;
				indices[index++] = newVertIndex;

				if (upRightTexShared) {
					// other vert
					indices[index++] = upRightBaseIndex + 1;
					indices[index++] = upRightBaseIndex;
					//indices[index++] = baseIndex + stride2;
					indices[index++] = newVertIndex;

					indices[index++] = upRightBaseIndex + stride + 1;
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
	const oldNumVerts = numVerticesBase;
	const newNumVertices = numVerticesBase + newVerts.length;
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

	}
	
	// load objects
	const numObjects = view.getUint32(objectListOffset) * 0;
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

	// load textures
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
		alpha: AlphaType.Opaque,
		wrapU: GfxWrapMode.Mirror,
		wrapV: GfxWrapMode.Mirror,
		pixels: terrainPixels,
	};

	const terrainMesh: Qd3DMesh = {
		numTriangles,
		numVertices: numVerticesBase,
		aabb : new AABB(0, 0, 0, terrainWidth * TERRAIN_POLYGON_SIZE, maxHeight * HEIGHT_SCALE, terrainDepth * TERRAIN_POLYGON_SIZE),
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
