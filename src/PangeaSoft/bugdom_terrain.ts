import { vec3 } from "gl-matrix";
import ArrayBufferSlice from "../ArrayBufferSlice";
import { Endianness } from "../endian";
import { AABB } from "../Geometry";
import { GfxFormat, GfxTexFilterMode, GfxWrapMode } from "../gfx/platform/GfxPlatform";
import { clamp } from "../MathHelpers";
import { assert, assertExists } from "../util";

import { ResourceFork } from "./AppleDouble";
import { LevelObjectDef } from "./entity";
import { AlphaType, Qd3DMesh, Qd3DTexture, swizzle1555Pixels } from "./QuickDraw3D";
import { convertTilemapId, createIndices, createNormalsFromHeightmap, createTilemapIds, createVerticesFromHeightmap, expandVertexColours, TerrainInfo } from "./terrain";


type SplineDef = {
	numPoints: number;
	points: Float32Array; // x,z
	aabb : AABB;
};
type FenceDef = {
	mesh : Qd3DMesh,
	type: number;
	/*
	numNubs: number;
	nubs: Int32Array;
	aabb : AABB;
	*/
};
type SplineItemDef = LevelObjectDef & {
	placement: number;
	spline : SplineDef;
};

export function getSplinePos(target : vec3, terrain : TerrainInfo, t : number, spline : SplineDef) : vec3{
	const index = clamp(Math.floor(t * spline.numPoints), 0, spline.numPoints - 1);
	let x = spline.points[index * 2];
	let z = spline.points[index * 2 + 1];
	let y = terrain.getHeight(x, z);
	target[0] = x;
	target[1] = y;
	target[2] = z;
	// todo: interpolation?
	return target;
}

type FenceMesh = Qd3DMesh & { type : number };

export type ParsedBugdomTerrain = {
	meshes : Qd3DMesh[],
	items : (LevelObjectDef | SplineItemDef)[],
	infos : TerrainInfo[],

	splines : SplineDef[],
	fences : FenceMesh[],
}

const MAP2UNIT_VALUE = 160/32;

export function parseBugdomTerrain(terrainData: ResourceFork, hasCeiling : boolean): ParsedBugdomTerrain {

	function get(resourceName: string, id: number, debugName: string) {
		return assertExists(terrainData.get(resourceName)?.get(id), debugName);
	}
	function getData(resourceName: string, id: number, debugName: string) {
		return get(resourceName, id, debugName).createDataView();
	}

	const TERRAIN_POLYGON_SIZE = 160;

	// read header
	const header = getData("Hedr", 1000, "header");
	assert(header.getUint32(0) === 0x7000000, "unknown terrain version number");
	const numItems = header.getUint32(4);
	const mapWidth = header.getUint32(8);
	const mapHeight = header.getUint32(12);
	//const numTilePages = header.getUint32(16);
	const numTilesInList = header.getUint32(20);
	const tileSize = header.getFloat32(24);
	//const heightMinY = header.getFloat32(28);
	//const heightMaxY = header.getFloat32(32);
	const numSplines = header.getUint32(36);
	const numFences = header.getUint32(40);

	// read tile image stuff
	const textureTileSize = 32;
	const tileImageData = get("Timg", 1000, "tile image data").createTypedArray(Uint16Array, 0, numTilesInList * textureTileSize * textureTileSize, Endianness.BIG_ENDIAN);

	swizzle1555Pixels(tileImageData, false);
	// create texture
	const texture : Qd3DTexture = {
		width : textureTileSize,
		height : textureTileSize,
		numTextures : numTilesInList,
		pixelFormat : GfxFormat.U16_RGBA_5551,
		filterMode : GfxTexFilterMode.Point,
		alpha : AlphaType.Opaque,
		wrapU: GfxWrapMode.Clamp,
		wrapV: GfxWrapMode.Clamp,
		pixels : tileImageData,
	};

	const tileImageTranslationTableBase = get("Xlat", 1000, "tile->image translation table");
	const tileImageTranslationTable = tileImageTranslationTableBase.createTypedArray(Uint16Array, 0, Math.min(0xFFF, tileImageTranslationTableBase.byteLength / 2), Endianness.BIG_ENDIAN);
	
	const numLayers = hasCeiling ? 2 : 1;

	// read tiles
	function loadTiles(buffer: ArrayBufferSlice) {
		const data = buffer.createTypedArray(Uint16Array, 0, mapWidth * mapHeight, Endianness.BIG_ENDIAN);
		for (let i = 0; i < data.length; ++i) {
			let tile = data[i];
			tile = (tile & ~0xFFF) | assertExists(tileImageTranslationTable[tile & 0xFFF], "tileTranslation");
			data[i] = convertTilemapId(tile);
		}
		return data;
	}

	const yScale = TERRAIN_POLYGON_SIZE / tileSize;
	const numVertsBase = (mapWidth + 1) * (mapHeight + 1);

	
	// load layer geometry
	const meshes : Qd3DMesh[] = new Array(numLayers);
	const infos : TerrainInfo[] = new Array(numLayers);
	for (let layer = 0; layer < numLayers; ++layer){
		const isCeiling = layer === 1;
		
		const tilesSource = loadTiles(get("Layr", 1000 + layer, "tiles"));

		const heightmap =  get("YCrd", 1000 + layer, "heightmap").createTypedArray(Float32Array, 0, numVertsBase, Endianness.BIG_ENDIAN);

		let minY = Infinity;
		let maxY = -Infinity;
		for (const height of heightmap){
			if (height < minY) minY = height;
			if (height > maxY) maxY = height;
		}

		const terrainInfo = new TerrainInfo(mapWidth, mapHeight, heightmap, TERRAIN_POLYGON_SIZE, yScale);
		infos[layer] = terrainInfo;


		const replacedTextures = new Map<number, number>();
		const duplicatedVerts : number[] = [];
		const indices = createIndices(heightmap, tilesSource, mapWidth, mapHeight, isCeiling, replacedTextures, duplicatedVerts);

		const numVertices = numVertsBase + duplicatedVerts.length;
		const vertices = new Float32Array(numVertices * 3);
		createVerticesFromHeightmap(vertices, heightmap, mapWidth, mapHeight);

		const tilemapIds = new Uint16Array(numVertices);
		createTilemapIds(tilemapIds, tilesSource, mapWidth, mapHeight);

		const vertexColoursSource = get("Vcol", 1000 + layer, "vertex colours").createTypedArray(Uint16Array, 0, numVertsBase, Endianness.BIG_ENDIAN);
		const vertexColours = new Uint8Array(numVertices * 3);
		expandVertexColours(vertexColours, vertexColoursSource);

		const normals = new Float32Array(numVertices * 3);
		createNormalsFromHeightmap(normals, heightmap, mapWidth, mapHeight, isCeiling,  TERRAIN_POLYGON_SIZE, yScale);
		
		// copy duplicated verts
		for (let i = 0; i < duplicatedVerts.length; ++i){
			const srcIndex = duplicatedVerts[i];
			const destIndex = numVertsBase + i;
			const srcIndex3 = srcIndex * 3;
			const destIndex3 = destIndex * 3;
			
			tilemapIds[destIndex] = tilemapIds[srcIndex];
			for (let j = 0; j < 3; ++j){
				vertices[destIndex3 + j] = vertices[srcIndex3 + j];
				normals[destIndex3 + j] = normals[srcIndex3 + j];
				vertexColours[destIndex3 + j] = vertexColours[srcIndex3 + j];
			}
		}

		const aabb = new AABB(0, minY * yScale, 0, mapWidth * TERRAIN_POLYGON_SIZE, maxY * yScale, mapHeight * TERRAIN_POLYGON_SIZE);

		const mesh : Qd3DMesh = {
			numTriangles : mapWidth * mapHeight * 2,
			numVertices,
			aabb,
			colour : { r : 1, g : 1, b : 1, a : 1 },
			texture,
		
			indices,
			vertices,
			normals,
			vertexColours,
			tilemapIds,
		};

		meshes[layer] = mesh;
	}


	// read items
	const itemData = getData("Itms", 1000, "items");
	const items: LevelObjectDef[] = new Array(numItems);
	for (let i = 0; i < numItems; ++i) {
		const x = itemData.getUint16(i * 12 + 0) * MAP2UNIT_VALUE;
		const z = itemData.getUint16(i * 12 + 2) * MAP2UNIT_VALUE;
		const y = infos[0].getHeight(x, z);
		items[i] = {
			x,y,z,
			type: itemData.getUint16(i * 12 + 4),
			param0: itemData.getUint8(i * 12 + 6),
			param1: itemData.getUint8(i * 12 + 7),
			param2: itemData.getUint8(i * 12 + 8),
			param3: itemData.getUint8(i * 12 + 9),
			flags: itemData.getUint16(i * 12 + 10)
		};
	}

	const scratchVec : vec3 = [0,0,0];
	const groundTerrainInfo = assertExists(infos[0], "no terrain info!");
	// read splines
	const splines: SplineDef[] = new Array(numSplines);
	if (numSplines > 0) {
		const splineDefData = getData("Spln", 1000, "spline defs");
		for (let i = 0; i < numSplines; ++i) {
			// read def
			const numNubs = splineDefData.getUint16(i * 32);
			const numPoints = splineDefData.getUint32(i * 32 + 8);
			const numItems = splineDefData.getUint16(i * 32 + 16);
			const top = splineDefData.getInt16(i * 32 + 24) * MAP2UNIT_VALUE;
			const left = splineDefData.getInt16(i * 32 + 26) * MAP2UNIT_VALUE;
			const bottom = splineDefData.getInt16(i * 32 + 28) * MAP2UNIT_VALUE;
			const right = splineDefData.getInt16(i * 32 + 30) * MAP2UNIT_VALUE;
			let minY = 0; // todo
			let maxY = 0;

			// read points
			const points = numPoints > 0
				? get("SpPt", 1000 + i, "spline points").createTypedArray(Float32Array, undefined, undefined, Endianness.BIG_ENDIAN)
				: new Float32Array(0);

			// adjust points
			for (let i = 0; i < points.length; ++i)
				points[i] *= MAP2UNIT_VALUE;


			const spline : SplineDef = {
				numPoints,
				points,
				aabb : new AABB(left, minY, bottom, right, maxY, top),
			};
			splines[i] = spline;

			// read items
			const itemData = getData("SpIt", 1000 + i, "spline items");
			for (let j = 0; j < numItems; ++j) {
				const placement = itemData.getFloat32(12 * j);
				getSplinePos(scratchVec, groundTerrainInfo, placement, spline);
				const item : SplineItemDef = {
					x:scratchVec[0], y:scratchVec[1], z:scratchVec[2],
					placement,
					type: itemData.getUint16(12 * j + 4),
					spline,
					param0: itemData.getUint8(12 * j + 6),
					param1: itemData.getUint8(12 * j + 7),
					param2: itemData.getUint8(12 * j + 8),
					param3: itemData.getUint8(12 * j + 9),
					flags: itemData.getUint16(12 * j + 10)
				};
				items.push(item);
			}
		}
	}

	// read fences

	const fences: FenceMesh[] = new Array(numFences);
	if (numFences > 0) {
		const fenceData = getData("Fenc", 1000, "fences");
		for (let i = 0; i < numFences; ++i) {
			// read fence def
			const type = fenceData.getUint16(i * 16);
			const numNubs = fenceData.getInt16(i * 16 + 2);
			const top = fenceData.getInt16(i * 16 + 8) * MAP2UNIT_VALUE;
			const left = fenceData.getInt16(i * 16 + 10) * MAP2UNIT_VALUE;
			const bottom = fenceData.getInt16(i * 16 + 12) * MAP2UNIT_VALUE;
			const right = fenceData.getInt16(i * 16 + 14) * MAP2UNIT_VALUE;

			const aabb = new AABB(left, Infinity, bottom, right, -Infinity, top);

			// read fence nubs
			const nubs = get("FnNb", 1000 + i, "fence nubs").createTypedArray(Int32Array, undefined, 2 * numNubs, Endianness.BIG_ENDIAN);

			// create fence
			fences[i] = createFence(infos, type, numNubs, nubs, aabb);
		}
	}


	return {
		meshes,
		items,
		splines,
		fences,
		infos,
	};
}

const fenceHeights = [600, 1000, 1000, 500, 1000, 2000, -200, 6000, 1200];
const fenceTextureWidths = [1/600, 1/500, 1/500, 1/500, 1/500, 1/500, 1/500, 1/1000, 1/1200];

function createFence(terrainInfos : TerrainInfo[], type : number, numNubs : number, nubs : Int32Array, aabb : AABB) : FenceMesh{

	const numTriangles = numNubs * 2 - 2;
	const numVertices = numNubs * 2;
	const numIndices = numTriangles * 3;

	const hasNormals = type === 6;

	const indices = (numVertices <= 0x10000) ? new Uint16Array(numIndices)
		: new Uint32Array(numIndices);
	const vertices = new Float32Array(numVertices * 3);
	const UVs = new Float32Array(numVertices * 2);
	const normals = hasNormals ? new Float32Array(numVertices * 3) : undefined;

	const floorInfo = terrainInfos[0];
	const ceilingInfo = terrainInfos[1];

	const height = fenceHeights[type];
	const textureWidth = fenceTextureWidths[type];

	const fenceSink = 40;

	let u = 0;

	for (let i = 0; i < numNubs; ++i){
		// indices
		indices[i * 6 + 0] = i*2 + 1;
		indices[i * 6 + 1] = i*2 + 0;
		indices[i * 6 + 2] = i*2 + 3;
		indices[i * 6 + 3] = i*2 + 3;
		indices[i * 6 + 4] = i*2 + 0;
		indices[i * 6 + 5] = i*2 + 2;

		// vertices
		const x = nubs[i * 2    ] * MAP2UNIT_VALUE;
		const z = nubs[i * 2 + 1] * MAP2UNIT_VALUE;
		let y = 0;
		let y2 = 0;
		switch(type){
			case 6: // moss
				y = ceilingInfo.getHeight(x, z) + fenceSink;
				y2 = y + height;
				break;
			case 7: // wood
				y = -400;
				y2 = y + height;
				break;
			case 8: // hive
				y = floorInfo.getHeight(x,z) - fenceSink;
				y2 = ceilingInfo.getHeight(x,z) + fenceSink;
				break;
			default:
				y = floorInfo.getHeight(x, z) - fenceSink;
				y2 = y + height;
				break;
		}
		vertices[i * 3    ] = x;
		vertices[i * 3 + 1] = y;
		vertices[i * 3 + 2] = z;
		vertices[i * 3 + 3] = x;
		vertices[i * 3 + 4] = y2;
		vertices[i * 3 + 5] = z;

		// aabb
		if (y < aabb.minY) aabb.minY = y;
		if (y2 > aabb.maxY) aabb.maxY = y2;

		// uvs
		if (i > 0){
			u += Math.hypot(x - vertices[i*3-6], y - vertices[i*3-5], z - vertices[i*3-4]) * textureWidth;
		}
		UVs[i*4 + 0] = u;
		UVs[i*4 + 1] = 1;
		UVs[i*4 + 2] = u;
		UVs[i*4 + 3] = 0;

		if (hasNormals && i < numNubs - 1){
			// negated/flipped
			const dz = x - nubs[i*2+2] * MAP2UNIT_VALUE;
			const dx = z - nubs[i*2+3] * MAP2UNIT_VALUE;
			// add to bottom 2 verts of this face
			normals![i*6+0] += dx;
			normals![i*6+2] += dz;
			normals![i*6+6] += dx;
			normals![i*6+8] += dz;
		}
	}

	if (hasNormals){
		// normalize normal sums
		for (let i = 0; i < numVertices; i += 2){
			const scale = 1 / Math.hypot(normals![i*3], normals![i*3+2]);
			normals![i*3] *= scale;
			normals![i*3+2] *= scale;
			// copy to above two verts
			normals![i*3+3] = normals![i*3];
			normals![i*3+5] = normals![i*3+2];
		}
	}


 	return {
		numTriangles,
		numVertices,
		aabb,
		colour : {r:1,g:1,b:1,a:1},
		texture : undefined, // set by calling code
		type,
	
		indices,
		vertices,
		UVs,
		normals,
	};
}
