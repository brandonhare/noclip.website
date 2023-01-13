
import ArrayBufferSlice from "../../ArrayBufferSlice";
import { GfxFormat } from "../platform/GfxPlatform";

function setImageDataS8(dst: ImageData, src: Int8Array): void {
    for (let i = 0; i < src.length; i++)
        dst.data[i] = src[i] + 128;
}

function setImageDataU16_5551(dst: ImageData, src: Uint16Array): void{
    for (let i = 0; i < src.length; i++){
        const pixel = src[i];
        dst.data[i * 4    ] = (pixel >> 8) & 0xF8;
        dst.data[i * 4 + 1] = (pixel >> 3) & 0xF8;
        dst.data[i * 4 + 2] = (pixel << 2) & 0xF8;
        dst.data[i * 4 + 3] = (pixel & 1) * 255;
    }
}

function setImageDataU8R(dst : ImageData, src : Uint8Array){
    for (let i = 0; i < src.length; i++){
        const pixel = src[i];
        dst.data[i * 4    ] = pixel;
        dst.data[i * 4 + 1] = pixel;
        dst.data[i * 4 + 2] = pixel;
        dst.data[i * 4 + 3] = 255;
    }
}
function setImageDataU8RGB(dst : ImageData, src : Uint8Array){
    const numPixels = src.length / 3;
    for (let i = 0; i < numPixels; ++i){
        dst.data[i * 4    ] = src[i * 3    ];
        dst.data[i * 4 + 1] = src[i * 3 + 1];
        dst.data[i * 4 + 2] = src[i * 3 + 2];
        dst.data[i * 4 + 3] = 255;
    }
}

function convertToImageData(dst: ImageData, buffer: ArrayBufferSlice, format: GfxFormat): void {
    switch(format){
        case GfxFormat.U8_RGBA_NORM:
            dst.data.set(buffer.createTypedArray(Uint8Array));
            break;
        case GfxFormat.S8_RGBA_NORM:
            setImageDataS8(dst, buffer.createTypedArray(Int8Array));
            break;
        case GfxFormat.U8_RGB_NORM:
            setImageDataU8RGB(dst, buffer.createTypedArray(Uint8Array));
            break;
        case GfxFormat.U8_R_NORM:
            setImageDataU8R(dst, buffer.createTypedArray(Uint8Array));
            break;
        case GfxFormat.U16_RGBA_5551:
            setImageDataU16_5551(dst, buffer.createTypedArray(Uint16Array));
            break;
        default:
            throw "whoops";
    }
}

export function convertToCanvasData(canvas: HTMLCanvasElement, buffer: ArrayBufferSlice, format: GfxFormat = GfxFormat.U8_RGBA_NORM): void {
    const ctx = canvas.getContext("2d")!;
    const imgData = ctx.createImageData(canvas.width, canvas.height);
    convertToImageData(imgData, buffer, format);
    ctx.putImageData(imgData, 0, 0);
}

export function convertToCanvas(buffer: ArrayBufferSlice, width: number, height: number, format: GfxFormat = GfxFormat.U8_RGBA_NORM): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    convertToCanvasData(canvas, buffer, format);
    return canvas;
}
