// http://justsolve.archiveteam.org/wiki/3DMF

import { mat3, mat4, ReadonlyMat4, vec3 } from "gl-matrix";
import ArrayBufferSlice from "../ArrayBufferSlice";
import { Endianness } from "../endian";
import { GfxColor, GfxWrapMode } from "../gfx/platform/GfxPlatform";
import { GfxFormat } from "../gfx/platform/GfxPlatformFormat";
import { assert, readString } from "../util";

export type Qd3DMesh = {
	numTriangles : number;
	numVertices : number;
	colour : GfxColor;
	texture? : Qd3DTexture;
	baseTransform? : ReadonlyMat4;

	indices : Uint16Array | Uint32Array;
	vertices : Float32Array | Uint16Array;
	UVs?: Float32Array; // uv
	normals?: Float32Array; // xyz
	vertexColours?: Float32Array; // rgb
	tilemapIds? : Uint16Array;
	
	// todo bounding box
};

export type Qd3DSkeleton = Qd3DMesh;

export type Qd3DTexture = {
	width : number;
	height : number;
	numTextures : number; // > 1 for array textures
	pixelFormat : GfxFormat; // commonly GfxFormat.U16_RGBA_5551;
	hasAlpha : boolean;
	wrapU : GfxWrapMode;
	wrapV : GfxWrapMode;
	pixels: Uint16Array | Uint8Array;
};


export type Qd3DObjectDef = {
	x : number,
	y : number, // terrain height
	z : number,
	type : number,
	param0 : number,
	param1 : number,
	param2 : number,
	param3 : number,
	flags : number,
};

// converts U16_RGBA_1555 pixels to U16_RGBA_5551
function swizzle1555Pixels(pixels : Uint16Array, preserveAlpha = true){
	for (let i = 0; i < pixels.length; ++i){
		let pixel = pixels[i];
		pixels[i] = ((pixel & 0x7FFF) << 1) | ((pixel >> 15) & 1);
		
		if (!preserveAlpha)
			pixels[i] |= 1; // force opaque
	}
}
// duplicate pixel colours into adjacent transparent pixels to improve bilinear filtering clipping artifacts
function addEdgePadding(pixels : Uint16Array, width : number, height : number){
	// left-right
	for (let row = 0; row < height; ++row){
		for (let col = 0; col < width; ++col){
			const index = row * width + col;
			if (pixels[index] === 0){
				if (col < width - 1 && pixels[index + 1] & 1)
					pixels[index] = pixels[index + 1] & ~1;
				else if (col > 0 && pixels[index - 1] & 1)
					pixels[index] = pixels[index - 1] & ~1;
			}
		}
	}
	// up-down
	for (let col = 0; col < width; ++col){
		for (let row = 0; row < height; ++row){
			const index = row * width + col;
			if (pixels[index] === 0){
				if (row < height - 1 && pixels[index + width] & 1)
					pixels[index] = pixels[index + width] & ~1;
				else if (row > 0 && pixels[index - width] & 1)
					pixels[index] = pixels[index - width] & ~1;
			}
		}
	}
}

export function parseQd3DMeshGroup(buffer : ArrayBufferSlice) : Qd3DMesh[][]{
	const data = buffer.createDataView();
	assert(readString(buffer, 0, 4) === "3DMF", "Not a 3DMF file");
	assert(data.getUint32(4) === 16, "Bad header length");
	const versionMajor = data.getUint16(8);
	const versionMinor = data.getUint16(10);
	assert(versionMajor === 1 && (versionMinor === 5 || versionMinor === 6), "Unsupported 3DMF version");
	const flags = data.getUint32(12);
	assert(flags === 0, "Database or Stream aren't supported");
	const tocOffset = data.getUint32(20).valueOf();
	
	type TocId = number;
	type TocRef = {
		offset : number,
		chunkType: number
	};
	const tocReferences = new Map<TocId, TocRef>();

	if (tocOffset != 0){
		assert(readString(buffer, tocOffset, 4) === "toc ", "Expected toc magic here");
		const entryType = data.getUint32(tocOffset + 24);
		const entrySize = data.getUint32(tocOffset + 28);
		const numEntries = data.getUint32(tocOffset + 32);
		
		assert(entryType === 1);
		assert(entrySize === 16);

		for (let i = 0; i < numEntries; ++i){
			const id = data.getUint32(tocOffset + i * 16 + 36);
			const location = data.getUint32(tocOffset + i * 16 + 44);
			const type = data.getUint32(tocOffset + i * 16 + 48);
			tocReferences.set(id, {offset:location, chunkType:type});
		}
	}

	const enum AttributeType {
		SURFACE_UV = 1,
		SHADING_UV = 2,
		NORMAL = 3,
		DIFFUSE_COLOR = 5,
	};


	// parse chunks
	const meshGroups : Qd3DMesh[][] = [];
	let currentMesh : Qd3DMesh | undefined;
	const textures : Qd3DTexture[] = [];
	let currentTexture : Qd3DTexture | undefined;
	const seenTextureOffsets = new Map<number, Qd3DTexture>();

	let offset = 24;

	function parseChunk(depth : number){
		const chunkType = readString(buffer, offset, 4);
		const chunkSize = data.getUint32(offset + 4);
		//console.log(offset, `${"--".repeat(depth)}${chunkType}:`, chunkSize);
		offset += 8;
		switch (chunkType) {
			case "cntr":{
				if (depth === 1)
					meshGroups.push([]);
				
				const limit = offset + chunkSize;
				while (offset < limit) {
					parseChunk(depth + 1);
				}
				currentMesh = undefined;
				break;
			}
			case "bgng":{
				if (depth === 1)
					meshGroups.push([]);

				offset += chunkSize;
				while (parseChunk(depth + 1) != "endg")
				{}
				currentMesh = undefined;
				break;
			}
			case "endg":{
				assert(chunkSize === 0, "illegal endg size");
				break;
			}
			case "tmsh":{ // TriMesh
				assert(currentMesh == undefined, "nested meshes are not supported");
				assert(chunkSize >= 52, "Illegal tmsh size");
				const numTriangles = data.getUint32(offset);
				const numEdges = data.getUint32(offset + 8);
				assert(numEdges === 0, "edges are not supported");
				const numEdgeAttributes = data.getUint32(offset + 12);
				assert(numEdgeAttributes === 0, "edges are not supported");
				const numVertices = data.getUint32(offset + 16);
				offset += 24;

				if (meshGroups.length === 0)
					meshGroups.push([]);

				numTriangles;
				numVertices;
				let indices : Uint16Array | Uint32Array;

				// Triangles
				if (numVertices <= 0xFF){
					indices = new Uint16Array(buffer.createTypedArray(Uint8Array, offset, numTriangles * 3)); // convert u8 to u16s
					offset += numTriangles * 3;
				} else if (numVertices <= 0xFFFF){
					indices = buffer.createTypedArray(Uint16Array, offset, numTriangles * 3, Endianness.BIG_ENDIAN);
					offset += numTriangles * 6;
				} else if (numVertices <= 0xFFFFFFFF){ // probably won't ever encounter one of these
					indices = buffer.createTypedArray(Uint32Array, offset, numTriangles * 3, Endianness.BIG_ENDIAN);
					offset += numTriangles * 12;
				} else {
					assert(false, "Meshes exceeding 65535 vertices are not supported");
				}

				assert(indices.every((index)=>index < numVertices), "triangle index out of range");

				const vertices = buffer.createTypedArray(Float32Array, offset, numVertices * 3, Endianness.BIG_ENDIAN);
				offset += numVertices * 12;

				currentMesh = {
					vertices,
					numTriangles,
					numVertices,
					indices,
					colour: {r:1, g:1, b:1, a:1}
				};
				meshGroups[meshGroups.length - 1].push(currentMesh);

				// todo bounding box
				offset += 7*4;

				break;
			}
			case "atar":{ // mesh attributes
				assert(chunkSize >= 20, "Illegal atar size");
				assert(currentMesh != undefined, "no current mesh");
				const attributeType = data.getUint32(offset);
				assert(data.getUint32(offset + 4) === 0, "expected 0");
				const posOfArray = data.getUint32(offset + 8);
				const posInArray = data.getUint32(offset + 12);
				const useFlag = data.getUint32(offset + 16);
				offset += 20;
				assert(posOfArray <= 2, "illegal position of array");
				assert(useFlag <= 1, "recognized use flag");

				const isTriangleAttribute = posOfArray === 0;
				const isVertexAttribute = posOfArray === 2;
				assert(isTriangleAttribute || isVertexAttribute, "only face or vertex attributes are supported");
				
				if (isVertexAttribute){
					switch (attributeType){
						case AttributeType.SHADING_UV:
						case AttributeType.SURFACE_UV:
							
							assert(currentMesh.UVs == undefined, "current mesh already has UVs");
							currentMesh.UVs = buffer.createTypedArray(Float32Array, offset, currentMesh.numVertices * 2, Endianness.BIG_ENDIAN);
							offset += currentMesh.numVertices * 8;
							// flip y
							for (let i = 1; i < currentMesh.UVs.length; i += 2){
								currentMesh.UVs[i] = 1 - currentMesh.UVs[i];
							}
							break;
						case AttributeType.NORMAL:
							assert(posInArray === 0, "PIA must be 0 for normals");
							assert(currentMesh.normals == undefined, "current mesh already has normals");
							currentMesh.normals = buffer.createTypedArray(Float32Array, offset, currentMesh.numVertices * 3, Endianness.BIG_ENDIAN);
							offset += currentMesh.numVertices * 12;
							break;
						case AttributeType.DIFFUSE_COLOR:
							assert(currentMesh.vertexColours == undefined, "current mesh already has vertex colours");
							currentMesh.vertexColours = buffer.createTypedArray(Float32Array, offset, currentMesh.numVertices * 3, Endianness.BIG_ENDIAN);
							offset += currentMesh.numVertices * 12;
							break;
						default:
							assert(false, "invalid vertex attribute type");
							break;
					}
				} else { // triangle attribute
					assert(attributeType === AttributeType.NORMAL, "invalid triangle attribute type");
					offset += currentMesh.numTriangles * 12;
				}
				break;
			}
			case "txsu":{ // texture
				assert(chunkSize === 0, "illegal txsu size");
				let texture = seenTextureOffsets.get(offset);
				if (texture === undefined){
					texture = {
						numTextures : 1,
						pixelFormat : GfxFormat.U16_RGBA_5551,
						pixels : undefined!,
						width : 0,
						height : 0,
						hasAlpha : false,
						wrapU : GfxWrapMode.Repeat,
						wrapV : GfxWrapMode.Repeat,
					};
					textures.push(texture);
					seenTextureOffsets.set(offset, texture);
					currentTexture = texture;
				} // else seen before, this is a rfrn

				if (currentMesh != undefined){
					assert(currentMesh.texture == undefined, "mesh already has a texture");
					currentMesh.texture = texture;
				}

				break;
			}
			case "txmm":
			case "txpm": // texture data
			{
				assert(currentTexture != undefined, "no texture bound");
				if (currentTexture.pixels != undefined){
					// already read
					offset += chunkSize;
					break;
				}

				let width : number;
				let height : number;
				let rowBytes : number;
				let pixelType : PixelType;
				let bitOrder : number;
				let byteOrder : number;

				if (chunkType === "txmm"){
					assert(chunkSize >= 32, "incorrect chunk size");
					const useMipmapping = data.getUint32(offset);
					pixelType = data.getUint32(offset + 4);
					bitOrder = data.getUint32(offset + 8);
					byteOrder = data.getUint32(offset + 12);
					width = data.getUint32(offset + 16);
					height = data.getUint32(offset + 20);
					rowBytes = data.getUint32(offset + 24);
					const offset2 = data.getUint32(offset + 28);
					offset += 32;
					
					assert(!useMipmapping, "mipmapping not supported");
					assert(offset2 === 0, "unsupported texture offset");
					
				} else { // txpm
					assert(chunkSize >= 28, "incorrect chunk size");
					width = data.getUint32(offset);
					height = data.getUint32(offset + 4);
					rowBytes = data.getUint32(offset + 8);

					pixelType = data.getUint32(offset + 16);
					bitOrder = data.getUint32(offset + 20);
					byteOrder = data.getUint32(offset + 24);
					offset += 28;
				}

				let imageSize = rowBytes * height;
				if ((imageSize & 3) !== 0) {
					imageSize = (imageSize & 0xFFFFFFFC) + 4;
				}
				assert(bitOrder === 0 && byteOrder === 0, "big endian only");
				
				const enum PixelType {
					RGB32 = 0,
					ARGB32 = 1,
					RGB16 = 2,
					ARGB16 = 3,
					RGB16_565 = 4,
					RGB24 = 5
				}

				assert(pixelType === PixelType.RGB16 || pixelType === PixelType.ARGB16, "todo: unsupported texture pixel format");
				const bytesPerPixel = 2;

				currentTexture.hasAlpha = pixelType === PixelType.ARGB16;
				
				let pixels : Uint16Array;

				const trimmedRowBytes = bytesPerPixel * width;
				if (rowBytes === trimmedRowBytes){
					pixels = buffer.createTypedArray(Uint16Array, offset, width * height * bytesPerPixel / 2, Endianness.BIG_ENDIAN);
				} else {
					// trim padding
					pixels = new Uint16Array(width * height * bytesPerPixel);
					for (let y = 0; y < height; ++y){
						const row = buffer.createTypedArray(Uint16Array, offset + y * rowBytes, width * bytesPerPixel / 2, Endianness.BIG_ENDIAN);
						pixels.set(row, y * trimmedRowBytes / 2);
					}
				}

				
				swizzle1555Pixels(pixels, currentTexture.hasAlpha);
				if (currentTexture.hasAlpha)
					addEdgePadding(pixels, width, height);

				currentTexture.width = width;
				currentTexture.height = height;
				currentTexture.pixels = pixels
				currentTexture.pixelFormat = GfxFormat.U16_RGBA_5551;

				
				offset += imageSize;
				break;
			}
			case "shdr":{ // texture wrap mode
				assert(chunkSize === 8, "illegal shdr size");
				assert(currentTexture != undefined, "no texture bound");
				const wrapU = data.getUint32(offset); // 0 = wrap, 1 = clamp
				const wrapV = data.getUint32(offset + 4);
				assert(wrapU <= 1 && wrapV <= 1, "invalid wrap modes");
				currentTexture.wrapU = wrapU == 0 ? GfxWrapMode.Repeat : GfxWrapMode.Clamp;
				currentTexture.wrapV = wrapV == 0 ? GfxWrapMode.Repeat : GfxWrapMode.Clamp;
				offset += 8;
				break;
			}				
			case "attr":{ // AttributeSet
				assert(chunkSize === 0, "illegal attr size");
				break;
			}
			case "kdif": { // Difuse Color
				assert(chunkSize === 12, "illegal kdif size");
				assert(currentMesh != undefined, "stray kdif");
				currentMesh.colour.r = data.getFloat32(offset);
				currentMesh.colour.g = data.getFloat32(offset + 4);
				currentMesh.colour.b = data.getFloat32(offset + 8);
				offset += 12;
				break;
			}
			case "kxpr": { // Transparency Color
				assert(chunkSize === 12, "illegal kxpr size");
				assert(currentMesh != undefined, "stray kxpr");
				const r = data.getFloat32(offset);
				const g = data.getFloat32(offset + 4);
				const b = data.getFloat32(offset + 8);
				offset += 12;
				assert(r === g && g === b, "kxpr: expecing all components to be equal");
				currentMesh.colour.r = currentMesh.colour.g = currentMesh.colour.b = currentMesh.colour.a = r;
				break;
			}
			case "rfrn":{ // Refrence (into TOC)
				assert(chunkSize === 4, "illegal rfrn size");
				const refId = data.getUint32(offset);
				const currentPos = offset + 4;
				const ref = tocReferences.get(refId);
				assert(ref != undefined, "unknown reference");
				offset = ref!.offset;
				parseChunk(depth);
				offset = currentPos;
				break;
			}
			case "toc ":
				offset += chunkSize; // already read TOC at beginning
				break;
			default:
				offset += chunkSize;
				break;
		}

		return chunkType;
	}

	while (offset < data.byteLength){
		parseChunk(0);
	}

	assert(textures.every((tex)=>tex.pixels != undefined));

	return meshGroups;
}


export function parseTerrain(terrainBuffer : ArrayBufferSlice, pixelBuffer : ArrayBufferSlice) : [Qd3DMesh, Qd3DObjectDef[]] {
	
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
	const textureLayerData = terrainBuffer.createTypedArray(Uint16Array, textureLayerOffset, terrainWidth * terrainDepth,  Endianness.BIG_ENDIAN);
	assert(heightmapLayerOffset > 0, "no heightmap data!");
	// gTerrainHeightmapLayer
	const heightmapLayerData = terrainBuffer.createTypedArray(Uint16Array, heightmapLayerOffset, terrainWidth * terrainDepth, Endianness.BIG_ENDIAN);
	assert(pathLayerOffset > 0, "no path data!");
	// gTerrainPathLayer
	const pathLayerData = terrainBuffer.createTypedArray(Uint16Array, pathLayerOffset, terrainWidth * terrainDepth, Endianness.BIG_ENDIAN);

	// texture attributes
	const numTextureAttributes = (tileAnimDataOffset - textureAttributesOffset) / 8; // hack from source port
	type TileAttribute = {
		bits : number,
		param0 : number,
		param1 : number,
		param2 : number
	};
	// gTileAttributes
	const tileAttributes : TileAttribute[] = [];
	for (let i = 0; i < numTextureAttributes; ++i){
		tileAttributes.push({
			bits : view.getUint16(textureAttributesOffset + i * 8 + 0),
			param0 : view.getInt16(textureAttributesOffset + i * 8 + 2),
			param1 : view.getUint8(textureAttributesOffset + i * 8 + 4),
			param2 : view.getUint8(textureAttributesOffset + i * 8 + 5),
		});
	}

	
	assert(heightmapTilesOffset > 0, "no heightmap tile data!");
	const numHeightmapTiles = ((textureAttributesOffset - heightmapTilesOffset) / (32*32)) & 0x0FFF;
	// gTerrainHeightMapPtrs
	const heightmapTiles = terrainBuffer.createTypedArray(Uint8Array, heightmapTilesOffset, numHeightmapTiles * 32 * 32);



	// load objects
	const numObjects = view.getUint32(objectListOffset);
	const objects : Qd3DObjectDef[] = [];
	for (let offset = objectListOffset + 4; offset < objectListOffset + 4 + 20 * numObjects; offset += 20){
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

		// todo: get actual height
		const y = getTerrainHeightAtRowCol(Math.floor(z / TERRAIN_POLYGON_SIZE), Math.floor(x / TERRAIN_POLYGON_SIZE));
		objects.push({x : x * MAP_TO_UNIT_VALUE, y, z : z * MAP_TO_UNIT_VALUE, type, param0, param1, param2, param3, flags});
	}

	function getTerrainHeightAtRowCol(row : number, col : number) : number {
		if (row < 0 || col < 0 || row >= terrainDepth || col >= terrainWidth)
			return 0;

		const tile = heightmapLayerData[row * terrainWidth + col];
		assert(tile != undefined, "missing heightmap layer tile");
		const tileNum = tile & 0x0FFF;
		const flipX = tile & (1<<15);
		const flipY = tile & (1<<14);

		const x = flipX ? TERRAIN_HMTILE_SIZE - 1 : 0;
		const y = flipY ? TERRAIN_HMTILE_SIZE - 1 : 0;

		const height = heightmapTiles[tileNum * TERRAIN_HMTILE_SIZE * TERRAIN_HMTILE_SIZE + y * TERRAIN_HMTILE_SIZE + x];
		assert(height != undefined, "missing heightmap tile");
		return height;//* HEIGHT_SCALE; // extrude factor
	}



	// create verts
	const numVertices = (terrainWidth + 1) * (terrainDepth + 1);
	const vertices = new Uint16Array(numVertices * 3);
	const stride = (terrainWidth + 1) * 3;
	
	function vertIndex(row : number, col : number){
		return row * stride + col * 3;
	}

	for (let row = 0; row <= terrainDepth; row++){
		const z = row ;//* TERRAIN_POLYGON_SIZE;
		for (let col = 0; col <= terrainWidth; ++col){
			const x = col ;//* TERRAIN_POLYGON_SIZE;
			const y = getTerrainHeightAtRowCol(row, col);
			let index = vertIndex(row, col);
			vertices[index++] = x;
			vertices[index++] = y;
			vertices[index++] = z;
		}
	}

	const normals = new Float32Array(numVertices * 3);
	let vec : vec3 = [0,0,0];
	for (let row = 0; row <= terrainDepth; row++){
		for (let col = 0; col <= terrainWidth; ++col){
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
	for (let row = 0; row <= terrainDepth; row++){
		for (let col = 0; col <= terrainWidth; ++col){
			const terrainId = textureLayerData[row * terrainWidth + col] ?? 0;
			maxTextureIndex = Math.max(maxTextureIndex, terrainId & 0xFFF);
			tilemapIds[row * stride2 + col] = terrainId;
		}
	}


	function getSlope(baseIndex : number) {
		const h1 = vertices[baseIndex * 3 + 1];
		const h2 = vertices[(baseIndex + 1) * 3 + 1];
		const h3 = vertices[(baseIndex + stride2 + 1) * 3 + 1];
		const h4 = vertices[(baseIndex + stride2) * 3 + 1];

		return Math.abs(h1 - h3) - Math.abs(h2 - h4);
	}
	function needsFlip(row : number, col : number){
		if (row === terrainDepth || col === terrainWidth)
			return true;
		return getSlope(row * stride2 + col) > 0;
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

	for (let row = 0; row < terrainDepth; row++){
		for (let col = 0; col < terrainWidth ; ++col){
			const baseIndex = row * stride2 + col;

			const textureData = tilemapIds[baseIndex];

			if (needsFlip(row, col)) {

				flipped.add(baseIndex);

				if (needsFlip(row, col + 1) && (needsTextureReplacement.get(baseIndex + 1) ?? textureData) === textureData) {
					indices[index++] = baseIndex
					indices[index++] = baseIndex + stride2;
					indices[index++] = baseIndex + 1;
					
					indices[index++] = baseIndex + stride2;
					indices[index++] = baseIndex + stride2 + 1;
					indices[index++] = baseIndex + 1;
					needsTextureReplacement.set(baseIndex + 1, textureData);
				} else if (needsFlip(row + 1, col) && (needsTextureReplacement.get(baseIndex + stride2) ?? textureData) === textureData) {
					indices[index++] = baseIndex + 1;
					indices[index++] = baseIndex
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
				indices[index++] = baseIndex

				indices[index++] = baseIndex + stride2 + 1;
				indices[index++] = baseIndex + 1
				indices[index++] = baseIndex;
				
			}
		}
	}

	needsTextureReplacement.forEach((texture, baseIndex)=>{
		//assert(flipped.has(baseIndex), `${Math.floor(baseIndex / stride2)} ${baseIndex % stride2}`);
		tilemapIds[baseIndex] = texture;
	});

	const newVerts : number[] = [];
	const newVertTextures : number[] = [];
	let newVertIndex = numVertices;

	while (needsNewVert.size > 0) {
		needsNewVert.forEach((texture, baseIndex)=>{
			const downLeftBaseIndex = baseIndex + stride2 - 1;
			const upRightBaseIndex = baseIndex - stride2 + 1;
			const downLeftTexShared = needsNewVert.get(downLeftBaseIndex) == texture;
			const upRightTexShared = needsNewVert.get(upRightBaseIndex) == texture;
			if (downLeftTexShared && upRightTexShared){
				return;
			}

			if (downLeftTexShared){
				newVerts.push(baseIndex + stride2);
				indices[index++] = baseIndex + 1;
				indices[index++] = baseIndex
				//indices[index++] = baseIndex + stride2;
				indices[index++] = newVertIndex;
				
				indices[index++] = baseIndex + stride2 + 1;
				indices[index++] = baseIndex + 1;
				//indices[index++] = baseIndex + stride2;
				indices[index++] = newVertIndex;

				// other vert
				
				indices[index++] = downLeftBaseIndex
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

				indices[index++] = baseIndex
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
					indices[index++] = upRightBaseIndex
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
	for (let i = 0; i < oldNumVerts; ++i){
		for (let j = i * 3; j < (i+1)*3; ++j){
			newVertices[j] = vertices[j];
			newNormals[j] = normals[j];
		}
		newTilemapIds[i] = tilemapIds[i];
	}
	for (let i = 0; i < newVerts.length; ++i){
		const newVertBaseIndex = newVerts[i];
		const newVertTexture = newVertTextures[i];
		for (let j = 0; j < 3; ++j){
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
	const terrainPixels = pixelBuffer.createTypedArray(Uint16Array, 4, 32*32*numTextures, Endianness.BIG_ENDIAN);
	swizzle1555Pixels(terrainPixels, false);

	const texture : Qd3DTexture = {
		width : 32,
		height : 32,
		numTextures,
		pixelFormat : GfxFormat.U16_RGBA_5551,
		hasAlpha : false,
		wrapU : GfxWrapMode.Mirror, // makes bilinear look better
		wrapV : GfxWrapMode.Mirror,
		pixels : terrainPixels,
	}

	const result : Qd3DMesh = {
		numTriangles,
		numVertices,
		colour : {r:1, g:1, b:1, a:1},
		baseTransform : mat4.fromScaling(mat4.create(), [TERRAIN_POLYGON_SIZE,HEIGHT_SCALE,TERRAIN_POLYGON_SIZE]),
		texture,
		indices,
		vertices : newVertices,
		normals : newNormals,
		tilemapIds : newTilemapIds,
	};

	return [result, objects];
}
