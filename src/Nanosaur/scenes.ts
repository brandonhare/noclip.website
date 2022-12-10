
import * as Viewer from '../viewer';
import { GfxBuffer, GfxBufferUsage, GfxDevice, GfxFormat, GfxIndexBufferDescriptor, GfxInputLayout, GfxVertexBufferFrequency, GfxInputLayoutBufferDescriptor, GfxInputLayoutDescriptor, GfxInputState, GfxVertexAttributeDescriptor, GfxVertexBufferDescriptor, GfxWrapMode, GfxProgram, GfxProgramDescriptorSimple, GfxColor, GfxBlendFactor, GfxBlendMode, GfxSampler, makeTextureDescriptor2D, GfxTexture, GfxCullMode, GfxTexFilterMode, GfxMipFilterMode } from "../gfx/platform/GfxPlatform";
import { GraphObjBase, SceneContext } from "../SceneBase";
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper';

import { GridPlane } from "../InteractiveExamples/GridPlane";
import { makeBackbufferDescSimple, opaqueBlackFullClearRenderPassDescriptor, pushAntialiasingPostProcessPass, standardFullClearRenderPassDescriptor } from "../gfx/helpers/RenderGraphHelpers";
import { GfxrAttachmentSlot } from "../gfx/render/GfxRenderGraph";
import { GfxRenderInstManager } from "../gfx/render/GfxRenderInstManager";
import { NamedArrayBufferSlice } from "../DataFetcher";
import { assert, readString } from "../util";
import { Endianness } from "../endian";
import { makeStaticDataBuffer } from "../gfx/helpers/BufferHelpers";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";
import { DeviceProgram } from "../Program";
import { mat4, vec3, vec4 } from "gl-matrix";
import { fillColor, fillMatrix4x3, fillMatrix4x4 } from "../gfx/helpers/UniformBufferHelpers";
import { setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers";
import { TextureMapping } from "../TextureHolder";

const pathBase = "nanosaur_raw";

class Program extends DeviceProgram {
	static a_Position = 0;
	static a_UVs = 1;
	static a_Colours = 2;
	static a_Normals = 3;

	constructor(uvs : boolean, normals : boolean, colours : boolean, texture : boolean, textureHasAlpha : boolean){
		super();
		assert(uvs === texture, "uv/texture mismatch!");
		this.setDefineBool("HAS_NORMALS", normals);
		this.setDefineBool("HAS_COLOURS", colours);
		this.setDefineBool("HAS_TEXTURE", texture);
		this.setDefineBool("TEXTURE_HAS_ALPHA", textureHasAlpha);
	}

	override both = 
`layout(std140) uniform ub_Params {
	Mat4x4 u_Projection;
	Mat4x4 u_MV;
	vec4 u_Colour;
};
`;
	override vert = 
`
layout(location = ${Program.a_Position}) in vec3 a_Position;
layout(location = ${Program.a_UVs}) in vec2 a_UV;
layout(location = ${Program.a_Normals}) in vec3 a_Normal;
layout(location = ${Program.a_Colours}) in vec3 a_Colour;

out vec4 v_Colour;
out vec3 v_Normal;
out vec2 v_UV;

void main() {
	v_Colour = vec4(a_Colour, 1.0);
	v_Normal = a_Normal;
	v_UV = a_UV;
    gl_Position = Mul(u_Projection, Mul(u_MV, vec4(a_Position, 1.0)));
}
`;
	override frag = 
`
uniform sampler2D u_Texture;
in vec4 v_Colour;
in vec2 v_UV;
in vec3 v_Normal;

void main(){
	vec4 colour = u_Colour;
	
	#ifdef HAS_COLOURS
		colour *= v_Colour;
	#endif
	
	#ifdef HAS_TEXTURE
		colour *= texture(SAMPLER_2D(u_Texture), v_UV);
		#ifdef TEXTURE_HAS_ALPHA
			if (colour.a < 0.5) { discard; }
		#endif
	#else
		colour.xyz = (v_Normal.xzy + 1.0) * 0.5;
	#endif



	gl_FragColor = colour;
}
`;
};


class Mesh {
	numTriangles : number;
	numVertices : number;
	indices : Uint16Array | Uint32Array;
	vertices : Float32Array;
	UVs?: Float32Array; // uv
	normals?: Float32Array; // xyz
	vertexColours?: Float32Array; // rgb
	texture? : Texture;
	colour : GfxColor = {r:1,g:1,b:1,a:1};
};

class Texture {
	width : number;
	height : number;
	pixelFormat : GfxFormat;
	pixels: Uint16Array | undefined; // todo more
	wrapU : GfxWrapMode;
	wrapV : GfxWrapMode;
	hasAlpha = false;
};

class Cache extends GfxRenderCache {

	textures = new Map<Texture, GfxTexture>();

	createTexture(texture : Texture){
		let result = this.textures.get(texture);
		if (result === undefined){
			result = this.device.createTexture(makeTextureDescriptor2D(texture.pixelFormat, texture.width, texture.height, 1));
			this.textures.set(texture, result);
			this.device.uploadTextureData(result, 0, [texture.pixels!]);

			
		}
		return result;
	}

	createTextureMapping(texture : Texture){
		const mapping = new TextureMapping();
		mapping.gfxTexture = this.createTexture(texture);

		/*
		mapping.gfxSampler = this.createSampler({
			magFilter : GfxTexFilterMode.Point,
			minFilter : GfxTexFilterMode.Point,
			wrapS : texture.wrapU,
			wrapT : texture.wrapV,
			mipFilter : GfxMipFilterMode.Nearest,
		});
		*/
		
		
		return mapping;
	}

	public override destroy(): void {
		this.textures.forEach((tex)=>this.device.destroyTexture(tex));
		super.destroy();
	}

}

class StaticObject implements GraphObjBase {
	gfxProgram : GfxProgram;
	indexCount : number;
	buffers : GfxBuffer[] = [];
	inputLayout : GfxInputLayout;
	inputState : GfxInputState;
	modelMatrix = mat4.create();
	colour : GfxColor;
	texture? : GfxTexture;
	textureMapping : TextureMapping[] = [];

	constructor(device : GfxDevice, cache : Cache, mesh : Mesh){
		this.indexCount = mesh.numTriangles * 3;
		this.colour = mesh.colour;
	
		const vertexBufferDescriptors : GfxVertexBufferDescriptor[] = [];
		const vertexLayoutDescriptors : GfxInputLayoutBufferDescriptor[] = [];
		const vertexAttributeDescriptors : GfxVertexAttributeDescriptor[] = [];

		const allBuffers = this.buffers;

		function pushBuffer(inputBuffer : ArrayBufferLike | undefined, byteStride : number, location:number, format: GfxFormat){
			if (!inputBuffer) return false;

			const buffer = makeStaticDataBuffer(device, GfxBufferUsage.Vertex, inputBuffer);
			vertexBufferDescriptors.push({
				buffer,
				byteOffset : 0
			});
			vertexLayoutDescriptors.push({
				byteStride,
				frequency: GfxVertexBufferFrequency.PerVertex
			});
			vertexAttributeDescriptors.push({
				location,
				format,
				bufferIndex : allBuffers.length,
				bufferByteOffset : 0
			});
			allBuffers.push(buffer);
			return true;
		}
		
		pushBuffer(mesh.vertices.buffer, 12, Program.a_Position, GfxFormat.F32_RGB);
		const hasUvs = pushBuffer(mesh.UVs?.buffer, 8, Program.a_UVs, GfxFormat.F32_RG);
		const hasNormals = pushBuffer(mesh.normals?.buffer, 12, Program.a_Normals, GfxFormat.F32_RGB);
		const hasColours = pushBuffer(mesh.vertexColours?.buffer, 12, Program.a_Colours, GfxFormat.F32_RGB);

		const texture = mesh.texture;
		if (texture){
			this.textureMapping.push(cache.createTextureMapping(texture));
		}

		this.gfxProgram = cache.createProgram(new Program(hasUvs, hasNormals, hasColours, texture != null, !!(texture?.hasAlpha)));

		const indexBuffer = makeStaticDataBuffer(device, GfxBufferUsage.Index, mesh.indices.buffer);
		this.inputLayout = cache.createInputLayout({
			vertexBufferDescriptors: vertexLayoutDescriptors,
			vertexAttributeDescriptors : vertexAttributeDescriptors,
			indexBufferFormat : mesh.indices.BYTES_PER_ELEMENT === 2 ? GfxFormat.U16_R : GfxFormat.U32_R ,
		});

		const indexBufferDescriptor : GfxIndexBufferDescriptor = {
			buffer: indexBuffer,
			byteOffset: 0,
		};
		this.inputState = device.createInputState(this.inputLayout, vertexBufferDescriptors, indexBufferDescriptor);
	}
	prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput): void {
        const renderInst = renderInstManager.newRenderInst();
        renderInst.setBindingLayouts([{
			numUniformBuffers : 1,
			numSamplers : 1,
		}]);
        renderInst.setSamplerBindingsFromTextureMappings(this.textureMapping);
        renderInst.setGfxProgram(this.gfxProgram);
        renderInst.setInputLayoutAndState(this.inputLayout, this.inputState);
        renderInst.setMegaStateFlags({ cullMode: GfxCullMode.Back });
	

		if (this.colour.a < 1.0){
			const megaState = renderInst.setMegaStateFlags({
				depthWrite: true,
			});
			setAttachmentStateSimple(megaState, {
				blendMode: GfxBlendMode.Add,
				blendDstFactor: GfxBlendFactor.OneMinusSrcAlpha,
				blendSrcFactor: GfxBlendFactor.SrcAlpha,
			});
		}
		
		
		
        renderInst.drawIndexes(this.indexCount);

		let uniformOffset = renderInst.allocateUniformBuffer(0, 4*4 + 4*4 + 4);
		const uniformData = renderInst.mapUniformBufferF32(0);
		
		uniformOffset += fillMatrix4x4(uniformData, uniformOffset, viewerInput.camera.projectionMatrix);
		const scratchMatrix = mat4.create();
		mat4.mul(scratchMatrix, viewerInput.camera.viewMatrix, this.modelMatrix);
		uniformOffset += fillMatrix4x4(uniformData, uniformOffset, scratchMatrix);
		uniformOffset += fillColor(uniformData, uniformOffset, this.colour);

        renderInstManager.submitRenderInst(renderInst);
	}
	destroy(device: GfxDevice): void {
		device.destroyInputState(this.inputState);
		for (const buf of this.buffers)
			device.destroyBuffer(buf);
	}
}

class NanosaurSceneRenderer implements Viewer.SceneGfx{
    renderHelper: GfxRenderHelper;
    obj: GraphObjBase[] = [];

	constructor(device : GfxDevice, context : SceneContext, models : Mesh[][]){
		const cache = new Cache(device);
		this.renderHelper = new GfxRenderHelper(device, context, cache);
        this.obj.push(new GridPlane(device, cache));

		const pos : vec3 = [1000,1000, 9000];
		for (const a of models){
			for (const m of a){
				const obj = new StaticObject(device, cache, m)
				if (pos[0] != 1000){ // terrain hack
					mat4.fromTranslation(obj.modelMatrix, pos);
					mat4.scale(obj.modelMatrix, obj.modelMatrix, [-1,1,-1]);
				}
				this.obj.push(obj);
			}
			pos[0] += 200;
			if (pos[0] >= 4000){
				pos[0] = 1000;
				pos[2] += 500;
			}
		}
	}


	prepareToRender(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput){
		this.renderHelper.pushTemplateRenderInst();
        const renderInstManager = this.renderHelper.renderInstManager;
        for (let i = 0; i < this.obj.length; i++)
            this.obj[i].prepareToRender(device, renderInstManager, viewerInput);
        renderInstManager.popTemplateRenderInst();
        this.renderHelper.prepareToRender();
	}

	public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
        const renderInstManager = this.renderHelper.renderInstManager;

        const mainColorDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, standardFullClearRenderPassDescriptor);
        const mainDepthDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.DepthStencil, viewerInput, standardFullClearRenderPassDescriptor);

        const builder = this.renderHelper.renderGraph.newGraphBuilder();

        const mainColorTargetID = builder.createRenderTargetID(mainColorDesc, 'Main Color');
        const mainDepthTargetID = builder.createRenderTargetID(mainDepthDesc, 'Main Depth');
        builder.pushPass((pass) => {
            pass.setDebugName('Main');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);
            pass.exec((passRenderer) => {
                renderInstManager.drawOnPassRenderer(passRenderer);
            });
        });
        pushAntialiasingPostProcessPass(builder, this.renderHelper, viewerInput, mainColorTargetID);
        builder.resolveRenderTargetToExternalTexture(mainColorTargetID, viewerInput.onscreenTexture);

        this.prepareToRender(device, viewerInput);
        this.renderHelper.renderGraph.execute(builder);
        renderInstManager.resetRenderInsts();
	}

	public destroy(device: GfxDevice) {
		this.obj.forEach((obj)=>obj.destroy(device));
		this.renderHelper.getCache().destroy();
		this.renderHelper.destroy();
	}

}

function fixPixels(pixels : Uint16Array){
	// fix bit format (move top alpha bit to bottom)
	for (let i = 0; i < pixels.length; ++i){
		let pixel = pixels[i];
		pixels[i] = ((pixel & 0x7FFF) << 1) | ((pixel >> 15) & 1);
	}
}

function parseModels(buffer : NamedArrayBufferSlice) : [Mesh[][], Texture[]]{
	const view = buffer.createDataView();
	assert(readString(buffer, 0, 4) === "3DMF", "Not a 3DMF file");
	assert(view.getUint32(4) === 16, "Bad header length");
	const versionMajor = view.getUint16(8);
	const versionMinor = view.getUint16(10);
	assert(versionMajor === 1 && (versionMinor === 5 || versionMinor === 6), "Unsupported 3DMF version");
	const flags = view.getUint32(12);
	assert(flags === 0, "Database or Stream aren't supported");
	const tocOffset = view.getUint32(20).valueOf();
	
	type TocId = number;
	type TocRef = {
		offset : number,
		chunkType: number
	};
	const tocReferences = new Map<TocId, TocRef>();

	if (tocOffset != 0){
		assert(readString(buffer, tocOffset, 4) === "toc ", "Expected toc magic here");
		const entryType = view.getUint32(tocOffset + 24);
		const entrySize = view.getUint32(tocOffset + 28);
		const numEntries = view.getUint32(tocOffset + 32);
		
		assert(entryType === 1);
		assert(entrySize === 16);

		for (let i = 0; i < numEntries; ++i){
			const id = view.getUint32(tocOffset + i * 16 + 36);
			const location = view.getUint32(tocOffset + i * 16 + 44);
			const type = view.getUint32(tocOffset + i * 16 + 48);
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
	const meshGroups : Mesh[][] = [];
	let currentMesh : Mesh | undefined;
	const textures : Texture[] = [];
	let currentTexture : Texture | undefined;
	let seenTextureOffsets = new Map<number, Texture>();

	let offset = 24;

	function parseChunk(depth : number){
		const chunkType = readString(buffer, offset, 4);
		const chunkSize = view.getUint32(offset + 4);
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
				const numTriangles = view.getUint32(offset);
				const numEdges = view.getUint32(offset + 8);
				assert(numEdges === 0, "edges are not supported");
				const numEdgeAttributes = view.getUint32(offset + 12);
				assert(numEdgeAttributes === 0, "edges are not supported");
				const numVertices = view.getUint32(offset + 16);
				offset += 24;

				if (meshGroups.length === 0)
					meshGroups.push([]);

				currentMesh = new Mesh();
				currentMesh.numTriangles = numTriangles;
				currentMesh.numVertices = numVertices;
				meshGroups[meshGroups.length - 1].push(currentMesh);

				// Triangles
				if (numVertices <= 0xFF){
					currentMesh.indices = new Uint16Array(buffer.createTypedArray(Uint8Array, offset, numTriangles * 3));
					offset += numTriangles * 3;
				} else if (numVertices <= 0xFFFF){
					currentMesh.indices = buffer.createTypedArray(Uint16Array, offset, numTriangles * 3, Endianness.BIG_ENDIAN);
					offset += numTriangles * 6;
				} else {
					assert(false, "Meshes exceeding 65535 vertices are not supported");
				}

				assert(currentMesh.indices.every((index)=>index < numVertices), "triangle index out of range");

				currentMesh.vertices = buffer.createTypedArray(Float32Array, offset, numVertices * 3, Endianness.BIG_ENDIAN);
				offset += numVertices * 12;

				// todo bounding box
				offset += 7*4;

				break;
			}
			case "atar":{ // mesh attributes
				assert(chunkSize >= 20, "Illegal atar size");
				assert(currentMesh != undefined, "no current mesh");
				const attributeType = view.getUint32(offset);
				assert(view.getUint32(offset + 4) === 0, "expected 0");
				const posOfArray = view.getUint32(offset + 8);
				const posInArray = view.getUint32(offset + 12);
				const useFlag = view.getUint32(offset + 16);
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
					texture = new Texture();
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
					const useMipmapping = view.getUint32(offset);
					pixelType = view.getUint32(offset + 4);
					bitOrder = view.getUint32(offset + 8);
					byteOrder = view.getUint32(offset + 12);
					width = view.getUint32(offset + 16);
					height = view.getUint32(offset + 20);
					rowBytes = view.getUint32(offset + 24);
					const offset2 = view.getUint32(offset + 28);
					offset += 32;
					
					assert(!useMipmapping, "mipmapping not supported");
					assert(offset2 === 0, "unsupported texture offset");
					
				} else { // txpm
					assert(chunkSize >= 28, "incorrect chunk size");
					width = view.getUint32(offset);
					height = view.getUint32(offset + 4);
					rowBytes = view.getUint32(offset + 8);

					pixelType = view.getUint32(offset + 16);
					bitOrder = view.getUint32(offset + 20);
					byteOrder = view.getUint32(offset + 24);
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

				
				fixPixels(pixels);

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
				currentTexture.wrapU = 1 - view.getUint32(offset);
				currentTexture.wrapV = 1 - view.getUint32(offset + 4);
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
				currentMesh.colour.r = view.getFloat32(offset);
				currentMesh.colour.g = view.getFloat32(offset + 4);
				currentMesh.colour.b = view.getFloat32(offset + 8);
				offset += 12;
				break;
			}
			case "kxpr": { // Transparency Color
				assert(chunkSize === 12, "illegal kxpr size");
				assert(currentMesh != undefined, "stray kxpr");
				const r = view.getFloat32(offset);
				const g = view.getFloat32(offset + 4);
				const b = view.getFloat32(offset + 8);
				offset += 12;
				assert(r === g && g === b, "kxpr: expecing all components to be equal");
				currentMesh.colour.r = currentMesh.colour.g = currentMesh.colour.b = currentMesh.colour.a = r;
				break;
			}
			case "rfrn":{ // Refrence (into TOC)
				assert(chunkSize === 4, "illegal rfrn size");
				const refId = view.getUint32(offset);
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
				console.log(buffer.name, offset, `${"--".repeat(depth)}${chunkType}:`, chunkSize);
				offset += chunkSize;
				break;
		}

		return chunkType;
	}

	while (offset < view.byteLength){
		parseChunk(0);
	}

	return [meshGroups, textures];
}

function parseTerrainTileset(buffer : NamedArrayBufferSlice) : Uint16Array{
	const view = buffer.createDataView();
	const numTextureTiles = view.getUint32(0);
	const numTexels = numTextureTiles * 32 * 32;
	assert(numTexels * 2 == buffer.byteLength - 4);
	const pixels = buffer.createTypedArray(Uint16Array, 4, undefined, Endianness.BIG_ENDIAN);
	fixPixels(pixels);
	return pixels;
}


function parseTerrain(terrainBuffer : NamedArrayBufferSlice, tileset : Uint16Array) : Mesh{

	const SUPERTILE_SIZE = 5; // tiles per supertile axis
	const TERRAIN_POLYGON_SIZE = 140; // world units of terrain polygon
	const OREOMAP_TILE_SIZE = 32; // pixels w/h of texture tile
	const TERRAIN_HMTILE_SIZE = 32; // pixel w/h of heightmap
	const MAP_TO_UNIT_VALUE = TERRAIN_POLYGON_SIZE / OREOMAP_TILE_SIZE;
	const TERRAIN_SUPERTILE_UNIT_SIZE = SUPERTILE_SIZE * TERRAIN_POLYGON_SIZE; // world unit size of a supertile

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
	const numHeightmapTiles = (textureAttributesOffset - heightmapTilesOffset) / (32*32);
	// gTerrainHeightMapPtrs
	const heightmapTiles = terrainBuffer.createTypedArray(Uint8Array, heightmapTilesOffset, numHeightmapTiles * 32 * 32);

	type Item = {
		x : number,
		y : number,
		type : number,
		param0 : number,
		param1 : number,
		param2 : number,
		param3 : number,
		flags : number,
	};

	// load items
	const numItems = view.getUint32(objectListOffset);
	const items : Item[] = [];
	let startCoordX = 0;
	let startCoordY = 0;
	let startCoordAim = 0;
	for (let offset = objectListOffset + 4; offset < objectListOffset + 4 + 20 * numItems; offset += 20){
		const x = view.getUint16(offset);
		const y = view.getUint16(offset + 2);
		const type = view.getUint16(offset + 4);
		const param0 = view.getUint8(offset + 6);
		const param1 = view.getUint8(offset + 7);
		const param2 = view.getUint8(offset + 8);
		const param3 = view.getUint8(offset + 9);
		const flags = view.getUint16(offset + 10);
		//const nextId = view.getUint16(offset + 12);
		//const prevId = view.getUint16(offset + 16);
		items.push({x, y, type, param0, param1, param2, param3, flags});

		if (type === 0){ // start position
			startCoordX = x * MAP_TO_UNIT_VALUE; // map to world unit
			startCoordY = y * MAP_TO_UNIT_VALUE; 
			startCoordAim = param0;
		}
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
		return height * 4; // extrude factor
	}



	// create model
	const result = new Mesh();

	// create verts
	result.numVertices = (terrainWidth + 1) * (terrainDepth + 1);
	const verts = new Float32Array(result.numVertices * 3);
	result.vertices = verts;
	const stride = (terrainWidth + 1) * 3;
	
	function vertIndex(row : number, col : number){
		return row * stride + col * 3;
	}

	for (let row = 0; row <= terrainDepth; row++){
		const z = row * TERRAIN_POLYGON_SIZE;
		for (let col = 0; col <= terrainWidth; ++col){
			const x = col * TERRAIN_POLYGON_SIZE;
			const y = getTerrainHeightAtRowCol(row, col);
			let index = vertIndex(row, col);
			verts[index++] = x;
			verts[index++] = y;
			verts[index++] = z;
		}
	}

	const normals = new Float32Array(result.numVertices * 3);
	result.normals = normals;
	let vec : vec3 = [0,0,0];
	for (let row = 0; row <= terrainDepth; row++){
		for (let col = 0; col <= terrainWidth; ++col){
			const index = vertIndex(row, col);
			//const centerHeight = verts[index + 1];
			const leftHeight = col === 0 ? 0 : verts[index - 2];
			const rightHeight = col === terrainWidth ? 0 : verts[index + 4];
			const backHeight = row === 0 ? 0 : verts[index - stride + 1];
			const frontHeight = row === terrainDepth ? 0 : verts[index + stride + 1];

			vec3.normalize(vec, [(leftHeight - rightHeight) * 0.1, 1, (backHeight - frontHeight) * 0.1]);
			normals.set(vec, index);
		}
	}

	result.numTriangles = terrainWidth * terrainDepth * 2;
	const indices = new Uint32Array(result.numTriangles * 3);
	result.indices = indices;
	const stride2 = terrainWidth + 1;
	let index = 0;
	for (let row = 0; row < terrainDepth; row++){
		for (let col = 0; col < terrainWidth ; ++col){
			const baseIndex = row * stride2 + col;
			indices[index++] = baseIndex
			indices[index++] = baseIndex + stride2;
			indices[index++] = baseIndex + 1;

			indices[index++] = baseIndex + stride2;
			indices[index++] = baseIndex + 1 + stride2;
			indices[index++] = baseIndex + 1;
		}
	}

	// todo: optimize mesh to get vertex indices back to a u16
	// todo: rotate triangles to align with slopes
	// todo: UVs
	// todo: texture

	return result;
}


class NanosaurSceneDesc implements Viewer.SceneDesc {
	constructor(public id : string, public name : string){}

	public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
		const terrainTileset = await context.dataFetcher.fetchData(pathBase + "/terrain/Level1.trt").then(parseTerrainTileset);
		const terrain = await context.dataFetcher.fetchData(pathBase + "/terrain/Level1.ter");
		const terrainModel = parseTerrain(terrain, terrainTileset);

		//return new NanosaurSceneRenderer(device, context, [[terrainModel]]);
		
		const models = await Promise.all([
				//"/Models/Global_Models2.3dmf",
				//"/Models/HighScores.3dmf",
				//"/Models/Infobar_Models.3dmf",
				"/Models/Level1_Models.3dmf",
				//"/Models/MenuInterface.3dmf",
				//"/Models/Title.3dmf",
				"/Skeletons/Deinon.3dmf",
				//"/Skeletons/Diloph.3dmf" // weird
				"/Skeletons/Ptera.3dmf",
				"/Skeletons/Rex.3dmf",
				"/Skeletons/Stego.3dmf",
				"/Skeletons/Tricer.3dmf",
			].map((path)=>
				context.dataFetcher.fetchData(pathBase + path)
					.then(parseModels)
			)
		);
		models.unshift([[[terrainModel]], []]);

		return new NanosaurSceneRenderer(device, context, models.map(([m])=>m).flat());
		
	}
	
}

const id = "nanosaur";
const name = "Nanosaur";
const sceneDescs = [
	new NanosaurSceneDesc("level1", "Level 1"),
];


export const sceneGroup: Viewer.SceneGroup = { id, name, sceneDescs };
