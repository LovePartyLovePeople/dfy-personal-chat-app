/** 压缩图片：长边限制 + 质量，返回 dataURL。transparent=true 时保留 PNG 透明通道（挂饰/头像框要用） */
export async function compressImage(file: File, maxSide = 1280, quality = 0.85, transparent = false): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return transparent ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", quality);
}

export function pickImage(accept = "image/*"): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

/** 多选图片（表情包批量导入用） */
export function pickImages(accept = "image/*"): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = true;
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.click();
  });
}
