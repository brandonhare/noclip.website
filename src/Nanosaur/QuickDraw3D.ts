// http://justsolve.archiveteam.org/wiki/3DMF

import { mat3, mat4, ReadonlyMat4, vec3 } from "gl-matrix";
import ArrayBufferSlice from "../ArrayBufferSlice";
import { Endianness } from "../endian";
import { AABB } from "../Geometry";
import { GfxColor, GfxWrapMode } from "../gfx/platform/GfxPlatform";
import { GfxFormat } from "../gfx/platform/GfxPlatformFormat";
import { assert, readString } from "../util";

export type Qd3DMesh = {
	numTriangles : number;
	numVertices : number;
	aabb : AABB, // baseTransform is already taken into account
	colour : GfxColor;
	texture? : Qd3DTexture;
	baseTransform? : ReadonlyMat4;

	indices : Uint16Array | Uint32Array;
	vertices : Float32Array | Uint16Array;
	UVs?: Float32Array; // uv
	normals?: Float32Array; // xyz
	vertexColours?: Float32Array; // rgb
	tilemapIds? : Uint16Array;
	boneIds? : Uint8Array,
};

export enum AlphaType {
	Opaque,
	OneBitAlpha,
	Translucent
}
export type Qd3DTexture = {
	width : number;
	height : number;
	numTextures : number; // > 1 for array textures
	pixelFormat : GfxFormat; // commonly GfxFormat.U16_RGBA_5551;
	alpha : AlphaType;
	wrapU : GfxWrapMode;
	wrapV : GfxWrapMode;
	pixels: Uint16Array | Uint8Array;
};

// converts U16_RGBA_1555 pixels to U16_RGBA_5551
export function swizzle1555Pixels(pixels : Uint16Array, preserveAlpha = true){
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

// todo: find a better file for this
export function loadTextureFromTGA(buffer : ArrayBufferSlice) : Qd3DTexture {

	const footerMagic = readString(buffer, buffer.byteLength - 18, 18, false);
	assert(footerMagic === "TRUEVISION-XFILE.\0", "not a TGA file!");

	const data = buffer.createDataView();

	// read file header
	const idLength = data.getUint8(0);
	const colourMapType = data.getUint8(1);
	const imageType = data.getUint8(2);
	// read colour map spec
	const colourMapFirstEntryIndex = data.getUint16(3, true);
	const colourMapNumEntries = data.getUint16(5, true);
	const colourMapEntrySizeBits = data.getUint8(7)
	// read image spec
	//const xOrigin = data.getUint16(8, true);
	//const yOrigin = data.getUint16(10, true);
	const width = data.getUint16(12, true);
	const height = data.getUint16(14, true);
	const pixelIndexDepth = data.getUint8(16);
	const imageDescriptor = data.getUint8(17);


	const alphaChannelDepth = imageDescriptor & 0xF;
	const rightToLeft = (imageDescriptor & 0x10) !== 0;
	const topToBottom = (imageDescriptor & 0x20) !== 0;

	const imageFormat = imageType & 0x7;
	const usesRLE = (imageType & 0x08) !== 0;
	const usesColourMap = imageFormat === 1;
	const greyscale = imageFormat === 3;

	const colourMapEntrySize = Math.ceil(colourMapEntrySizeBits / 8);
	const bytesPerPixelIndex = Math.ceil(pixelIndexDepth / 8);
	const bytesPerPixel = usesColourMap ? colourMapEntrySize : bytesPerPixelIndex;

	assert(colourMapType <= 1, "Unsupported TGA colour map type");
	assert(!usesColourMap || (colourMapType === 1), "TGA missing required colour map");
	assert(imageType !== 0, "TGA has no image data");
	assert(imageType <= 3 || (imageType >= 9 && imageType <= 11), "Unsupported TGA image type");
	assert((imageDescriptor & 0xC0) === 0, "Unsupported TGA image settings");
	if (usesColourMap){
		assert(bytesPerPixelIndex >= 1 && bytesPerPixelIndex <= 4 && bytesPerPixelIndex !== 3, "Unsupported TGA pixel index size");
		assert(colourMapEntrySize > 0 && (greyscale || colourMapEntrySize !== 1) && colourMapEntrySize <= 4, "Unsupported TGA colour map entry size");
	}

	// todo: flip
	assert(!rightToLeft && topToBottom, "Flipped TGA images not implemented!");

	let alpha : AlphaType;
	switch(alphaChannelDepth){
		case 0: alpha = AlphaType.Opaque; break;
		case 1: alpha = AlphaType.OneBitAlpha; break;
		case 8: alpha = AlphaType.Translucent; break;
		default: assert(false, "Unsupported TGA alpha bit-depth");
	}

	function choosePixelFormat(greyscale : boolean, alpha : AlphaType, bytesPerPixel : number) : GfxFormat | false {
		if (greyscale){
			if (alpha === AlphaType.Opaque){
				switch(bytesPerPixel){
					case 1: return GfxFormat.U8_R_NORM; // probably the only correct one
					case 2: return GfxFormat.U16_R_NORM;
					case 4: return GfxFormat.U32_R;
					default: return false;
				}
			} else {
				// todo: expand to rbga ourselves?
				return -1;
			}
		} else { // colour
			switch(alpha){
				case AlphaType.Opaque: {
					switch(bytesPerPixel){
						case 2: return GfxFormat.U16_RGB_565; // probably incorrect
						case 3: return GfxFormat.U8_RGB_NORM;
						default: return false;
					}
				}
				case AlphaType.OneBitAlpha: {
					if (bytesPerPixel === 2)
						return GfxFormat.U16_RGBA_5551;
					else
						return false;
				}
				case AlphaType.Translucent: {
					if (bytesPerPixel === 4)
						return GfxFormat.U8_RGBA_NORM;
					else
						return false;
				}
			}
		}
	}

	const pixelFormat = choosePixelFormat(greyscale, alpha, bytesPerPixel);
	assert(pixelFormat !== false, "Unsupported TGA pixel format");

	const colourMapDataStart = 18 + idLength;
	const colourMapSizeBytes = colourMapNumEntries * colourMapEntrySize;
	const colourMap = usesColourMap ? buffer.createTypedArray(Uint8Array, colourMapDataStart, colourMapSizeBytes) : undefined;
	const imageDataStart = colourMapDataStart + colourMapSizeBytes;


	function getMapIndex(offset : number){
		let index : number;
		switch(bytesPerPixelIndex){
			case 1: index = data.getUint8(offset); break;
			case 2: index = data.getUint16(offset, true); break;
			case 4: index = data.getUint32(offset, true); break;
		}
		return (index! - colourMapFirstEntryIndex) * colourMapEntrySize;
	}

	// read pixels
	const numPixels = width * height;
	const numPixelBytes = numPixels * bytesPerPixel;
	let pixels : Uint8Array;
	let offset = imageDataStart;
	if (!usesRLE){
		if (!usesColourMap){
			pixels = buffer.createTypedArray(Uint8Array, imageDataStart, numPixelBytes);
		} else { // colour map with no RLE
			pixels = new Uint8Array(numPixelBytes);
			for (let pixelIndex = 0; pixelIndex < numPixels; ++pixelIndex){
				const mapIndex = getMapIndex(offset);
				offset += bytesPerPixelIndex;
				for (let j = 0; j < bytesPerPixel; ++j){
					pixels[pixelIndex * bytesPerPixel + j] = colourMap![mapIndex + j];
				}
			}
		}
	} else { // uses RLE
		pixels = new Uint8Array(numPixelBytes);
		let pixelIndex = 0;
		const templatePixel = [0,0,0,0];

		if (usesColourMap){
			while (pixelIndex < numPixels){
				const packetHeader = data.getUint8(offset);
				offset++;
				const packetLength = (packetHeader & 0x7F) + 1; // how many pixels this packet represents
				if (packetHeader & 0x80){ // RLE
					const mapIndex = getMapIndex(offset);
					offset += bytesPerPixelIndex;

					for (let i = 0; i < packetLength; ++i){
						for (let j = 0; j < bytesPerPixel; ++j){
							pixels[(pixelIndex + i) * bytesPerPixel + j] = colourMap![mapIndex + j]
						}
					}
					pixelIndex += packetLength;
				} else { // raw
					for (let i = 0; i < packetLength; ++i){
						const mapIndex = getMapIndex(offset);
						offset += bytesPerPixelIndex;
						for (let j = 0; j < bytesPerPixel; ++j){
							pixels[(pixelIndex + i) * bytesPerPixel + j] = colourMap![mapIndex + j];
						}
					}
					pixelIndex += packetLength;
				}
			}
		} else { // no colour map
			while (pixelIndex < numPixels){
				const packetHeader = data.getUint8(offset);
				offset++;
				const packetLength = (packetHeader & 0x7F) + 1; // how many pixels this packet represents
				const packetByteLength = packetLength * bytesPerPixel;
				if (packetHeader & 0x80){ // RLE
					for (let i = 0; i < bytesPerPixel; ++i)
						templatePixel[i] = data.getUint8(offset++);

					for (let i = 0; i < packetLength; ++i){
						for (let j = 0; j < bytesPerPixel; ++j){
							pixels[(pixelIndex + i) * bytesPerPixel + j] = templatePixel[j];
						}
					}
					pixelIndex += packetLength;
				} else { // raw
					for (let i = 0; i < packetByteLength; ++i){
						pixels[pixelIndex * bytesPerPixel + i] = data.getUint8(offset + i);
					}
					offset += packetByteLength;
					pixelIndex += packetLength;
				}
			}
		}
	}

	// swizzle
	if (bytesPerPixel === 2){ 
		for (let i = 0; i < numPixelBytes; i += 2){
			const value = pixels[i];
			pixels[i] = pixels[i+1];
			pixels[i+1] = value;
		}
	} else if (bytesPerPixel === 3 || bytesPerPixel === 4) {
		// BGR or BGRA
		for (let i = 0; i < numPixelBytes; i += bytesPerPixel){
			const b = pixels[i];
			pixels[i] = pixels[i+2];
			pixels[i+2] = b;
		}
	}

	return {
		width,
		height,
		pixels,
		numTextures : 1,
		wrapU : GfxWrapMode.Repeat,
		wrapV : GfxWrapMode.Repeat,
		alpha,
		pixelFormat
	}
}

export function convertGreyscaleTextureToAlphaMap(texture : Qd3DTexture) : Qd3DTexture {
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

				const aabb = new AABB(
					data.getFloat32(offset + 0), // xmin
					data.getFloat32(offset + 4), // ymin
					data.getFloat32(offset + 8), // zmin
					data.getFloat32(offset + 12), // xmax
					data.getFloat32(offset + 16), // ymax
					data.getFloat32(offset + 20), // zmax
				);
				//const empty = data.getUint32(offset + 24);
				offset += 7*4;

				currentMesh = {
					numTriangles,
					numVertices,
					aabb,
					colour: {r:1, g:1, b:1, a:1},
					indices,
					vertices,
				};
				meshGroups[meshGroups.length - 1].push(currentMesh);

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
							// normalize
							for (let i = 0; i < currentMesh.numVertices * 3; i += 3){
								const x = currentMesh.normals[i];
								const y = currentMesh.normals[i+1];
								const z = currentMesh.normals[i+2];
								const length = Math.hypot(x, y, z);
								currentMesh.normals[i]   = x / length;
								currentMesh.normals[i+1] = y / length;
								currentMesh.normals[i+2] = z / length;
							}
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
						alpha : AlphaType.Opaque,
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
				let pixelType : QD3DPixelType;
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
				
				const enum QD3DPixelType {
					RGB32 = 0,
					ARGB32 = 1,
					RGB16 = 2,
					ARGB16 = 3,
					RGB16_565 = 4,
					RGB24 = 5
				}

				
				let bytesPerPixel : number;
				switch(pixelType){
					case QD3DPixelType.ARGB32:
						bytesPerPixel = 4;
						currentTexture.alpha = AlphaType.Translucent;
						currentTexture.pixelFormat = GfxFormat.U8_RGBA_NORM;
						break;
					case QD3DPixelType.RGB16:
						bytesPerPixel = 2;
						currentTexture.alpha = AlphaType.Opaque;
						currentTexture.pixelFormat = GfxFormat.U16_RGBA_5551;
						break;
					case QD3DPixelType.ARGB16:
						bytesPerPixel = 2;
						currentTexture.alpha = AlphaType.OneBitAlpha;
						currentTexture.pixelFormat = GfxFormat.U16_RGBA_5551;
						break;
					default:
						assert(false, "Pixel type not implemented!");
				}
				
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

				
				swizzle1555Pixels(pixels, currentTexture.alpha !== AlphaType.Opaque);
				if (currentTexture.alpha === AlphaType.OneBitAlpha)
					addEdgePadding(pixels, width, height);

				currentTexture.width = width;
				currentTexture.height = height;
				currentTexture.pixels = pixels
				
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

	while (meshGroups.length > 0 && meshGroups[meshGroups.length - 1].length === 0)
		meshGroups.pop();

	assert(textures.every((tex)=>tex.pixels != undefined));

	return meshGroups;
}



