
import ArrayBufferSlice from "../../ArrayBufferSlice";
import { GfxFormat } from "../platform/GfxPlatform";

function setImageDataS8(dst: ImageData, src: Int8Array): void {
    for (let i = 0; i < src.length; i++)
        dst.data[i] = src[i] + 128;
}

function setImageDataU16_5551(dst: ImageData, src: Uint16Array): void{
    for (let i = 0; i < src.length; i++){
        const pixel = src[i];
        dst.data[i * 4    ] = ((pixel >> 11) & 0b11111) * 255 / 0b11111; // r
        dst.data[i * 4 + 1] = ((pixel >>  6) & 0b11111) * 255 / 0b11111; // g
        dst.data[i * 4 + 2] = ((pixel >>  1) & 0b11111) * 255 / 0b11111; // b
        dst.data[i * 4 + 3] = (pixel & 1) * 255; // a
    }
}

function convertToImageData(dst: ImageData, buffer: ArrayBufferSlice, format: GfxFormat): void {
    if (format === GfxFormat.U8_RGBA_NORM)
        dst.data.set(buffer.createTypedArray(Uint8Array));
    else if (format === GfxFormat.S8_RGBA_NORM)
        setImageDataS8(dst, buffer.createTypedArray(Int8Array));
    else if (format === GfxFormat.U16_RGBA_5551)
        setImageDataU16_5551(dst, buffer.createTypedArray(Uint16Array));
    else
        throw "whoops";
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
