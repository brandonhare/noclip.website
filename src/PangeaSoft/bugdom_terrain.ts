import { mat4 } from "gl-matrix";
import ArrayBufferSlice from "../ArrayBufferSlice";
import { Endianness } from "../endian";
import { AABB } from "../Geometry";
import { GfxFormat, GfxWrapMode } from "../gfx/platform/GfxPlatform";
import { assert, assertExists } from "../util";

import { ResourceFork } from "./AppleDouble";
import { LevelObjectDef } from "./entity";
import { AlphaType, Qd3DMesh, Qd3DTexture, swizzle1555Pixels } from "./QuickDraw3D";
import { convertTilemapId, createIndices, createNormalsFromHeightmap, createTilemapIds, createVerticesFromHeightmap, expandVertexColours, TerrainInfo } from "./terrain";


type SplineDef = {
	numPoints: number;
	points: Float32Array;
	items: SplineItemDef[];
	top: number;
	left: number;
	bottom: number;
	right: number;
};
type FenceDef = {
	type: number;
	numNubs: number;
	nubs: Int32Array;
	top: number;
	left: number;
	bottom: number;
	right: number;
};
type SplineItemDef = {
	placement: number;
	type: number;
	param0: number;
	param1: number;
	param2: number;
	param3: number;
	flags: number;
};


export type ParsedBugdomTerrain = {
	meshes : Qd3DMesh[],
	items : LevelObjectDef[],

	splines : SplineDef[],
	fences : FenceDef[],
}

export function parseBugdomTerrain(terrainData: ResourceFork, hasCeiling : boolean): ParsedBugdomTerrain {

	const MAP2UNIT_VALUE = 160/32;

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
		alpha : AlphaType.Opaque,
		wrapU: GfxWrapMode.Mirror,
		wrapV: GfxWrapMode.Mirror,
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
		const indices = createIndices(heightmap, tilesSource, mapWidth, mapHeight, replacedTextures, duplicatedVerts);

		const numVertices = numVertsBase + duplicatedVerts.length;
		const vertices = new Float32Array(numVertices * 3);
		createVerticesFromHeightmap(vertices, heightmap, mapWidth, mapHeight);

		const tilemapIds = new Uint16Array(numVertices);
		createTilemapIds(tilemapIds, tilesSource, mapWidth, mapHeight);

		const vertexColoursSource = get("Vcol", 1000 + layer, "vertex colours").createTypedArray(Uint16Array, 0, numVertsBase, Endianness.BIG_ENDIAN);
		const vertexColours = new Uint8Array(numVertices * 3);
		expandVertexColours(vertexColours, vertexColoursSource);

		const normals = new Float32Array(numVertices * 3);
		createNormalsFromHeightmap(normals, heightmap, mapWidth, mapHeight, TERRAIN_POLYGON_SIZE, yScale);
		
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

		const baseTransform = mat4.fromScaling(mat4.create(), [TERRAIN_POLYGON_SIZE, yScale, TERRAIN_POLYGON_SIZE]);

		const mesh : Qd3DMesh = {
			numTriangles : mapWidth * mapHeight * 2,
			numVertices,
			aabb,
			colour : { r : 1, g : 1, b : 1, a : 1 },
			texture,
			baseTransform,
		
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


	// read splines
	const splines: SplineDef[] = new Array(numSplines);
	if (numSplines > 0) {
		const splineDefData = getData("Spln", 1000, "spline defs");
		for (let i = 0; i < numSplines; ++i) {
			// read def
			const numNubs = splineDefData.getUint16(i * 32);
			const numPoints = splineDefData.getUint32(i * 32 + 8);
			const numItems = splineDefData.getUint16(i * 32 + 16);
			const top = splineDefData.getInt16(i * 32 + 24);
			const left = splineDefData.getInt16(i * 32 + 26);
			const bottom = splineDefData.getInt16(i * 32 + 28);
			const right = splineDefData.getInt16(i * 32 + 30);

			// read points
			const points = numPoints > 0
				? get("SpPt", 1000 + i, "spline points").createTypedArray(Float32Array, undefined, undefined, Endianness.BIG_ENDIAN)
				: new Float32Array(0);

			// read items
			const items: SplineItemDef[] = new Array(numItems);
			const itemData = getData("SpIt", 1000 + i, "spline items");
			for (let j = 0; j < numItems; ++j) {
				items[j] = {
					placement: itemData.getFloat32(12 * j),
					type: itemData.getUint16(12 * j + 4),
					param0: itemData.getUint8(12 * j + 6),
					param1: itemData.getUint8(12 * j + 7),
					param2: itemData.getUint8(12 * j + 8),
					param3: itemData.getUint8(12 * j + 9),
					flags: itemData.getUint16(12 * j + 10)
				};
			}

			splines[i] = {
				numPoints,
				points,
				items,
				top, left, bottom, right
			};
		}
	}

	// read fences

	const fences: FenceDef[] = new Array(numFences);
	if (numFences > 0) {
		const fenceData = getData("Fenc", 1000, "fences");
		for (let i = 0; i < numFences; ++i) {
			// read fence def
			const type = fenceData.getUint16(i * 16);
			const numNubs = fenceData.getInt16(i * 16 + 2);
			const top = fenceData.getInt16(i * 16 + 8);
			const left = fenceData.getInt16(i * 16 + 10);
			const bottom = fenceData.getInt16(i * 16 + 12);
			const right = fenceData.getInt16(i * 16 + 14);

			// read fence nubs
			const nubs = get("FnNb", 1000 + i, "fence nubs").createTypedArray(Int32Array, undefined, 2 * numNubs, Endianness.BIG_ENDIAN);
			fences[i] = {
				type,
				numNubs,
				nubs,
				top,
				left,
				bottom,
				right
			};
		}
	}


	return {
		meshes,
		items,
		splines,
		fences,
	};
}
